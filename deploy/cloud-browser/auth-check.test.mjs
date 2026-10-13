import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {TARGET} from '../../src/policy.mjs';
import {runAuthCheck,requireAuthCheck} from './auth-check.mjs';

const env={YON_AUTH_CHECK_ONLY:'1',YON_TENANT_HASH:'a'.repeat(64),CREDENTIALS_DIRECTORY:'/run/credentials/yon-license-auth-check.service'};
const source=await readFile(new URL('../../src/license-summary.mjs',import.meta.url),'utf8');
const good=()=>({status:'ok',token:'12345678-1234-4234-8234-123456789abc',snapshot:{
  ...TARGET,status:'ok',tenantKey:env.YON_TENANT_HASH,scopeVerified:true,unfiltered:true,complete:true,
  licenseState:'active',observedAt:Date.now(),used:7,records:Array.from({length:7},(_,i)=>({id:String(i+1).padStart(64,'0')})),
}});
function setup({auth={status:'ok',authenticated:true},snapshot=good,throwEvaluation=false}={}){
  const events=[];
  const page={goto:async(url,options)=>events.push({kind:'goto',url,options}),evaluate:async()=>{
    events.push({kind:'evaluate'});if(throwEvaluation)throw new Error('private raw error');return snapshot();
  }};
  const context={newPage:async()=>{events.push({kind:'newPage'});return page;},close:async()=>events.push({kind:'closeContext'})};
  const browser={newContext:async options=>{events.push({kind:'newContext',options});return context;},close:async()=>events.push({kind:'closeBrowser'})};
  const chromium={launch:async options=>{events.push({kind:'launch',options});return browser;},launchPersistentContext:()=>{throw new Error('must never access persistent profile');}};
  const login=async(received,options)=>{assert.equal(received,context);assert.deepEqual(options,{expectedTenantHash:env.YON_TENANT_HASH,credentialDirectory:env.CREDENTIALS_DIRECTORY,loginIfNeeded:true});events.push({kind:'login'});return auth;};
  return {events,run:()=>runAuthCheck({env,chromium,login,loadSummarySource:async()=>source})};
}

test('auth check requires explicit read-only flag, pin and service credential provider',()=>{
  assert.deepEqual(requireAuthCheck(env),{expectedTenantHash:env.YON_TENANT_HASH,credentialDirectory:env.CREDENTIALS_DIRECTORY});
  for(const change of [{YON_AUTH_CHECK_ONLY:'0'},{YON_TENANT_HASH:'bad'},{CREDENTIALS_DIRECTORY:''}])assert.throws(()=>requireAuthCheck({...env,...change}));
});

test('fresh anonymous context verifies password authentication and emits counts only',async()=>{
  const h=setup();assert.deepEqual(await h.run(),{status:'ok',authenticated:true,used:7,capacity:10,count:7});
  assert.deepEqual(h.events.map(e=>e.kind),['launch','newContext','newPage','goto','login','evaluate','closeContext','closeBrowser']);
  assert.equal(h.events[0].options.headless,true);assert.equal(h.events[0].options.chromiumSandbox,true);
  assert.equal(JSON.stringify(h.events[0].options).includes('user-data-dir'),false);
  assert.deepEqual(h.events[1].options,{viewport:null});
  assert.equal(h.events[3].url,'https://c3.yonyoucloud.com/iuap-apcom-workbench/manager/license/getTenantLicenseInfo?labelDomain=MM&status=VALID');
});

test('login challenge stops before snapshot and closes temporary browser without leaking details',async()=>{
  const h=setup({auth:{status:'manual_login_required',code:'challenge',phase:'verify_login',password:'raw-secret'}});
  assert.deepEqual(await h.run(),{status:'manual_login_required',code:'challenge',phase:'verify_login',authenticated:false});
  assert.equal(h.events.some(e=>e.kind==='evaluate'),false);
  assert.deepEqual(h.events.slice(-2).map(e=>e.kind),['closeContext','closeBrowser']);
});

test('anonymous check does not report an already-authenticated session as verified password login',async()=>{
  const h=setup({auth:{status:'ok',authenticated:false}});
  assert.deepEqual(await h.run(),{status:'error',code:'auth_not_performed',phase:'initial_scope',authenticated:false});
  assert.equal(h.events.some(e=>e.kind==='evaluate'),false);
});

test('failed read closes both temporary resources and never exposes raw exception or record hashes',async()=>{
  const h=setup({throwEvaluation:true});
  const result=await h.run();
  assert.deepEqual(result,{status:'error',code:'transport_error',phase:'snapshot',authenticated:true});
  assert.equal(JSON.stringify(result).includes('private'),false);
  assert.deepEqual(h.events.slice(-2).map(e=>e.kind),['closeContext','closeBrowser']);
});
