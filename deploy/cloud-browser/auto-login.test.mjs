import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,mkdir,writeFile,chmod,symlink,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createCloudLogin,readLoginCredential,validateCredentialMetadata } from './auto-login.mjs';

const pin='a'.repeat(64);
const start=1_800_000_000_000;
const good=(observedAt=start)=>({status:'ok',scope:{tenantHash:pin,company:'do not return company',observedAt}});
function fixture({scopes=[{status:'needs_login'},good(),good()],account=false,challenge,afterChallenge=false,reject=false,consent=false,wrongOrigin=false,advanceDuringFill=false,casLeaves=false,stats={status:'ok'}}={}){
  let clock=start,submitted=false,loads=0;
  const clicks=[],fills=[],navigations=[],scopeReadNavigationCounts=[];
  const credential={username:'synthetic-account',password:'synthetic-password'};
  const selectors=selector=>{
    if(selector==='li#toNormalLogin')return {visible:true,class:account?'normal active':'normal',click:()=>{account=true;}};
    if(['#fm1 #username','#fm1 #password','#fm1 #submit_btn_login'].includes(selector))return {
      visible:account,click:()=>{submitted=true;},fill:()=>{if(advanceDuringFill&&selector.endsWith('#password'))clock+=30_001;},
    };
    if(selector==='#captcha-box')return {visible:challenge===true||(submitted&&afterChallenge)};
    if(selector==='#pwdErrorMsg')return {visible:submitted&&reject,text:'wrong synthetic-password'};
    if(selector==='#fm1 input[type="checkbox"]:not(#warn)')return {visible:consent,checked:false};
    return null;
  };
  function locator(selector){
    const item=selectors(selector);
    const value={count:async()=>item?1:0,nth:()=>value,isVisible:async()=>!!item?.visible,
      isEnabled:async()=>true,isChecked:async()=>item?.checked===true,textContent:async()=>item?.text??'',
      getAttribute:async()=>item?.class??'',
      click:async()=>{clicks.push(selector);item?.click?.();},
      fill:async value=>{fills.push({selector,value});item?.fill?.();},
    };return value;
  }
  const frame={url:()=>wrongOrigin?'https://untrusted.invalid/cas/login':casLeaves&&submitted?'https://c3.yonyoucloud.com/login_light':'https://euc.yonyoucloud.com/cas/login?service=known',locator};
  const outer={url:()=>navigations.at(-1)??'https://c3.yonyoucloud.com/',locator:()=>({count:async()=>0})};
  const page={frames:()=>[outer,frame],goto:async url=>{navigations.push(url);}};
  const context={pages:()=>[page]};
  const ensure=createCloudLogin({
    now:()=>clock,sleep:async ms=>{clock+=ms;},
    readCredential:async()=>{loads++;return credential;},
    readScope:async()=>{scopeReadNavigationCounts.push(navigations.length);const value=scopes.length?scopes.shift():{status:'needs_login'};if(value instanceof Error)throw value;return value;},
    readStats:async()=>stats,
  });
  return {ensure,context,clicks,fills,navigations,scopeReadNavigationCounts,credential,get loads(){return loads;},run:options=>ensure(context,{expectedTenantHash:pin,...options})};
}

test('existing authenticated scope returns without loading credentials or clicking anything',async()=>{
  const f=fixture({scopes:[good()]});
  assert.deepEqual(await f.run(),{status:'ok',authenticated:false,observedAt:start});
  assert.equal(f.loads,0);assert.equal(f.clicks.length,0);assert.equal(f.navigations.length,0);
});

test('one account login uses observed CAS fields, then verifies pin and lightweight page',async()=>{
  const f=fixture();
  const result=await f.run();
  assert.deepEqual(result,{status:'ok',authenticated:true,observedAt:start});
  assert.deepEqual(f.clicks,['li#toNormalLogin','#fm1 #submit_btn_login']);
  assert.deepEqual(f.fills.map(entry=>entry.selector),['#fm1 #username','#fm1 #password']);
  assert.equal(f.navigations[0],'https://c3.yonyoucloud.com/');
  assert.equal(f.navigations[1],'https://c3.yonyoucloud.com/iuap-apcom-workbench/manager/license/getTenantLicenseInfo?labelDomain=MM&status=VALID');
  assert.deepEqual(f.credential,{username:'',password:''});
  assert.equal(JSON.stringify(result).includes('synthetic'),false);assert.equal(JSON.stringify(result).includes('company'),false);
});

test('captcha, MFA/consent or post-submit challenge require manual action without another click',async()=>{
  for(const options of [{challenge:true},{consent:true},{afterChallenge:true}]){
    const f=fixture(options);const result=await f.run();
    assert.deepEqual(result,{status:'manual_login_required',code:'challenge',phase:options.afterChallenge?'verify_login':'find_form'});
    assert.equal(f.clicks.filter(selector=>selector==='#fm1 #submit_btn_login').length,options.afterChallenge?1:0);
  }
});

test('bad password result is redacted and never automatically resubmitted',async()=>{
  const f=fixture({reject:true});
  const result=await f.run();assert.deepEqual(result,{status:'login_rejected',phase:'verify_login'});
  assert.equal(f.clicks.filter(selector=>selector==='#fm1 #submit_btn_login').length,1);
  assert.equal(JSON.stringify(result).includes('synthetic-password'),false);
});

test('wrong enterprise and permission/network failures do not trigger password login',async()=>{
  for(const initial of [
    {status:'ok',scope:{tenantHash:'b'.repeat(64),observedAt:start}},
    {status:'access_denied'},{status:'error',code:'transport_error'},
  ]){
    const f=fixture({scopes:[initial]});const result=await f.run();
    assert.notEqual(result.status,'ok');assert.equal(f.loads,0);assert.equal(f.clicks.length,0);
  }
  const disabled=fixture();assert.deepEqual(await disabled.run({loginIfNeeded:false}),{status:'needs_login',phase:'initial_scope'});assert.equal(disabled.loads,0);
});

test('clicking login or reaching another enterprise is not successful authentication',async()=>{
  const f=fixture({scopes:[{status:'needs_login'},good(),{status:'ok',scope:{tenantHash:'b'.repeat(64),observedAt:start}}]});
  assert.deepEqual(await f.run(),{status:'error',code:'wrong_tenant',phase:'verify_summary'});
  const unverified=fixture({scopes:[{status:'needs_login'},good(),{status:'needs_login'}]});
  assert.deepEqual(await unverified.run(),{status:'manual_login_required',code:'login_unverified',phase:'verify_summary'});
});

test('30-second total boundary and untrusted iframe prevent late login submission',async()=>{
  const expired=fixture({advanceDuringFill:true});
  assert.deepEqual(await expired.run(),{status:'manual_login_required',code:'timeout',phase:'fill_password'});
  assert.equal(expired.clicks.includes('#fm1 #submit_btn_login'),false);
  const untrusted=fixture({wrongOrigin:true});
  assert.deepEqual(await untrusted.run(),{status:'manual_login_required',code:'timeout',phase:'find_form'});
  assert.equal(untrusted.fills.length,0);assert.equal(untrusted.clicks.length,0);
});

test('concurrent recovery calls cannot perform two login attempts',async()=>{
  let resolveScope;
  const ensure=createCloudLogin({readScope:()=>new Promise(resolve=>{resolveScope=resolve;})});
  const context={};const first=ensure(context,{expectedTenantHash:pin});
  assert.deepEqual(await ensure(context,{expectedTenantHash:pin}),{status:'error',code:'login_in_progress',phase:'initial_scope'});
  resolveScope(good(Date.now()));assert.equal((await first).status,'ok');
});

test('only post-submit frame navigation transitions are retried as reads, never another login',async()=>{
  for(const message of ['Execution context was destroyed, most likely because of a navigation.','Frame was detached']){
    const f=fixture({scopes:[{status:'needs_login'},new Error(message),good(),good()]});
    assert.equal((await f.run()).status,'ok');
    assert.equal(f.clicks.filter(selector=>selector==='#fm1 #submit_btn_login').length,1);
    const initial=fixture({scopes:[new Error(message)]});
    assert.deepEqual(await initial.run(),{status:'error',code:'transport_error',phase:'initial_scope'});
    assert.equal(initial.loads,0);assert.equal(initial.clicks.length,0);
  }
  const network=fixture({scopes:[{status:'needs_login'},new Error('net::ERR_CONNECTION_CLOSED synthetic-password'),good()]});
  const result=await network.run();
  assert.deepEqual(result,{status:'error',code:'transport_error',phase:'verify_login'});
  assert.equal(network.clicks.filter(selector=>selector==='#fm1 #submit_btn_login').length,1);
  assert.equal(JSON.stringify(result).includes('synthetic-password'),false);
});

test('anonymous login starts on c3 and waits for c3 scope before leaving the CAS callback for statistics',async()=>{
  const f=fixture({casLeaves:true,scopes:[{status:'needs_login'},{status:'needs_login'},new Error('Execution context was destroyed'),good(),good()]});
  assert.deepEqual(await f.run(),{status:'ok',authenticated:true,observedAt:start});
  assert.equal(f.navigations.length,2);
  assert.equal(f.navigations[0],'https://c3.yonyoucloud.com/');
  assert.equal(f.navigations[1],'https://c3.yonyoucloud.com/iuap-apcom-workbench/manager/license/getTenantLicenseInfo?labelDomain=MM&status=VALID');
  assert.deepEqual(f.scopeReadNavigationCounts,[0,1,1,1,2]);
  assert.equal(f.clicks.filter(selector=>selector==='#fm1 #submit_btn_login').length,1);
  const pending=fixture({casLeaves:true,scopes:[{status:'needs_login'},{status:'needs_login'}]});
  assert.deepEqual(await pending.run(),{status:'manual_login_required',code:'timeout',phase:'verify_login'});
  assert.deepEqual(pending.navigations,['https://c3.yonyoucloud.com/']);
  assert.equal(pending.clicks.filter(selector=>selector==='#fm1 #submit_btn_login').length,1);
  for(const options of [
    {scopes:[{status:'needs_login'},good(),{status:'needs_login'}]},
    {scopes:[{status:'needs_login'},good(),good()],stats:{status:'needs_login'}},
  ]){
    const bad=fixture({casLeaves:true,...options});
    assert.deepEqual(await bad.run(),{status:'manual_login_required',code:'login_unverified',phase:'verify_summary'});
    assert.equal(bad.clicks.filter(selector=>selector==='#fm1 #submit_btn_login').length,1);
  }
});

test('CAS frame staying on login with a visible challenge never triggers lightweight navigation',async()=>{
  const f=fixture({afterChallenge:true});
  assert.deepEqual(await f.run(),{status:'manual_login_required',code:'challenge',phase:'verify_login'});
  assert.deepEqual(f.navigations,['https://c3.yonyoucloud.com/']);
});

test('credential loader accepts protected systemd copy and rejects wrong permissions, symlink and schema',async t=>{
  const root=await mkdtemp(`${tmpdir()}/yon-login-test-`);t.after(()=>rm(root,{recursive:true,force:true}));
  await chmod(root,0o700);
  const filename=`${root}/yon-login`;
  const synthetic={username:'synthetic-account',password:'synthetic-password'};
  await writeFile(filename,JSON.stringify(synthetic),{mode:0o400});
  assert.deepEqual(await readLoginCredential(root),synthetic);
  await chmod(filename,0o644);await assert.rejects(readLoginCredential(root),{code:'unsafe_credential'});
  await chmod(filename,0o600);assert.deepEqual(await readLoginCredential(root),synthetic);
  await writeFile(filename,JSON.stringify({...synthetic,extra:'not allowed'}));
  await assert.rejects(readLoginCredential(root),{code:'invalid_credential'});
  const directory=`${root}/other`;await mkdir(directory,{mode:0o700});await symlink(filename,`${directory}/yon-login`);
  await assert.rejects(readLoginCredential(directory),{code:'unsafe_credential'});
  await assert.rejects(readLoginCredential('/tmp/../unrelated'),{code:'credential_unavailable'});
});

test('root ACL credential copies are accepted only at the three exact systemd paths and metadata',()=>{
  const metadata=()=>({
    uid:65262,directoryPath:'/run/credentials/yon-license-monitor.service',
    directory:{uid:0,gid:0,mode:0o550,isDirectory:()=>true,isSymbolicLink:()=>false},
    file:{uid:0,gid:0,mode:0o440,nlink:1,size:100,isFile:()=>true,isSymbolicLink:()=>false},
  });
  for(const directoryPath of ['/run/credentials/yon-license-monitor.service','/run/credentials/yon-license-test.service','/run/credentials/yon-license-auth-check.service']){
    assert.doesNotThrow(()=>validateCredentialMetadata({...metadata(),directoryPath}));
  }
  for(const mutate of [
    p=>{p.directoryPath='/run/credentials/yon-license-credential-check.service';},
    p=>{p.directoryPath='/run/credentials/yon-license-auth-check-other.service';},
    p=>{p.directoryPath='/tmp/yon-license-monitor.service';},
    p=>{p.directoryPath='/run/credentials/yon-license-monitor.service/';},
    p=>{p.directory.uid=65262;},p=>{p.directory.gid=65262;},p=>{p.directory.mode=0o555;},
    p=>{p.directory.mode=0o750;},p=>{p.file.uid=65262;},p=>{p.file.gid=65262;},
    p=>{p.file.mode=0o444;},p=>{p.file.mode=0o640;},p=>{p.file.mode=0o644;},
    p=>{p.file.nlink=2;},p=>{p.file.isSymbolicLink=()=>true;},p=>{p.directory.isSymbolicLink=()=>true;},
  ]){
    const value=metadata();mutate(value);
    assert.throws(()=>validateCredentialMetadata(value),{code:'unsafe_credential'});
  }
});
