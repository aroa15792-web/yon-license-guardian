import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHash, webcrypto, randomUUID } from 'node:crypto';
import { buildReadSnapshotEvaluation, sanitizeReadSnapshot, LIST_URL, SNAPSHOT_REGISTRY_SYMBOL } from './license-adapter.mjs';

const summarySource = await readFile(new URL('../../src/license-summary.mjs',import.meta.url),'utf8');
const tenantId = 'tenant-synthetic';
const expectedTenantHash = createHash('sha256').update(tenantId).digest('hex');
const now = 1_800_000_000_000;
const summary = used => ({status:1,data:[{
  code:'BIP0002YB',name:'专业应用用户数',type:'SHAREUSER',amount:10,usedAmount:used,
  controlPoints:[{code:'BIPSCM0201',labelDomain:'MM',status:'VALID',relyUserMaterial:'BIP0002YB',name:'供应链云-采购供应-采购管理'}],
}]});
const response = (url,body,overrides={}) => ({
  status:200,url,redirected:false,type:'basic',headers:{get:()=>'application/json; charset=utf-8'},json:async()=>body,...overrides,
});

function browser({used=6,adjust,clock=()=>now,timer=setTimeout,untimer=clearTimeout}={}) {
  const requests=[];
  let summaryReads=0;
  let scopeReads=0;
  const context=vm.createContext({
    location:{origin:'https://c3.yonyoucloud.com'},crypto:{subtle:webcrypto.subtle,randomUUID},
    TextEncoder,AbortController,setTimeout:timer,clearTimeout:untimer,Date:{now:clock},
    fetch:async(url,options)=>{
      requests.push({url,options});
      let body;
      if(url.endsWith('/me?onlyShayat=false')) {scopeReads++;body={status:1,data:{tenantid:tenantId}};}
      else if(url.endsWith('/user/getUserInfo?userId=')) body={status:1,data:{currentTeamConfig:{tenantId}}};
      else if(url.includes('/getTenantLicenseInfo?')) {summaryReads++;body=summary(used);}
      else if(url===LIST_URL){
        const query=JSON.parse(options.body);
        const index=query.page.pageIndex;
        body={code:200,data:{pageIndex:index,pageSize:20,recordCount:used,pageCount:Math.ceil(used/20),
          recordList:Array.from({length:Math.max(0,Math.min(20,used-(index-1)*20))},(_,offset)=>({
            id:`unrelated-mdf-${index}-${offset}`,userId:`user-private-${(index-1)*20+offset}`,name:'private name',phone:'private phone',
          })),
        }};
      } else throw new Error('Unexpected request');
      const result=response(url,body);
      return adjust?.({url,options,body,result,summaryReads,scopeReads})??result;
    },
  });
  return {context,requests,run:()=>vm.runInContext(buildReadSnapshotEvaluation({expectedTenantHash,summarySource}),context),
    registry:()=>vm.runInContext(`globalThis[Symbol.for(${JSON.stringify(SNAPSHOT_REGISTRY_SYMBOL)})]`,context)};
}

test('full read derives observed scope and returns only hashed records plus private token',async()=>{
  const b=browser();
  const result=await b.run();
  assert.equal(result.status,'ok');
  assert.equal(result.snapshot.used,6);
  assert.equal(result.snapshot.capacity,10);
  assert.equal(result.snapshot.domain,'供应链云');
  assert.equal(result.snapshot.licenseCode,'BIP0002YB');
  assert.equal(result.snapshot.records.length,6);
  for(const row of result.snapshot.records)assert.match(row.id,/^[a-f0-9]{64}$/);
  const serialized=JSON.stringify(result);
  for(const secret of ['user-private-','unrelated-mdf-','private name','private phone',tenantId])assert.equal(serialized.includes(secret),false);
  assert.equal(sanitizeReadSnapshot(result,{expectedTenantHash,now}).status,'ok');
  const stored=b.registry().get(result.token);
  assert.equal(stored.expiresAt,now+30000);
  assert.equal(stored.tenantKey,expectedTenantHash);
  assert.equal(stored.idsByHash.get(result.snapshot.records[0].id),'user-private-0');
  assert.equal(b.requests.length,9);
  const list=b.requests.find(item=>item.url===LIST_URL);
  assert.equal(list.options.method,'POST');
  assert.equal(list.options.headers['Content-Type'],'application/json');
  assert.deepEqual(JSON.parse(list.options.body),{
    billnum:'sys_user_licenselist',ownDomain:'u8c-auth',serviceCode:'GZTSYS035',appCode:'BIP0002YB',page:{pageIndex:1,pageSize:20},
    condition:{bInit:true,commonVOs:[{itemName:'schemeName',value1:'默认方案'},{itemName:'isDefault',value1:true}]},bEmptyWithoutFilterTree:true,
  });
  for(const item of b.requests){assert.equal(item.options.redirect,'error');assert.equal(item.options.credentials,'same-origin');assert.equal(item.url.includes('/remove'),false);}
});

test('multiple pages must be complete, count stable and unique; zeros are explicit empty sets',async()=>{
  const b=browser({used:21});
  const r=await b.run();
  assert.equal(r.status,'ok');assert.equal(r.snapshot.records.length,21);
  assert.deepEqual(b.requests.filter(item=>item.url===LIST_URL).map(item=>JSON.parse(item.options.body).page.pageIndex),[1,2]);
  for(const pageCount of [0,1]){
    const empty=browser({used:0,adjust:({url,body})=>{if(url===LIST_URL)body.data.pageCount=pageCount;}});
    const result=await empty.run();assert.equal(result.status,'ok');assert.equal(result.snapshot.used,0);assert.equal(result.snapshot.records.length,0);
  }
  for(const mutate of [
    p=>{p.data.recordList.pop();},p=>{p.data.pageCount=2;},p=>{p.data.recordCount=5;},
    p=>{p.data.recordList[1].userId=p.data.recordList[0].userId;},p=>{p.data.pageSize=100;},
    p=>{p.data.pageIndex=2;},p=>{p.data.recordCount='6';},
  ]){
    const bad=browser({adjust:({url,body})=>{if(url===LIST_URL)mutate(body);}});
    assert.equal((await bad.run()).status,'error');assert.equal(bad.registry().size,0);
  }
});

test('unsafe user IDs are rejected rather than using MDF row ids',async()=>{
  for(const id of [undefined,null,12,'',',','a,b','a\nb','\t','a'.repeat(129)]){
    const b=browser({adjust:({url,body})=>{if(url===LIST_URL)body.data.recordList[0].userId=id;}});
    const result=await b.run();assert.equal(result.code,'unsafe_user_id');assert.equal(b.registry().size,0);
  }
});

test('actual control point name, enterprise and summary changes cannot be silently replaced with constants',async()=>{
  const cases=[
    ({url,body})=>{if(url.includes('/getTenantLicenseInfo?'))body.data[0].controlPoints[0].name='其他云-采购供应-采购管理';},
    ({url,body})=>{if(url.endsWith('/user/getUserInfo?userId='))body.data.currentTeamConfig.tenantId='other-tenant';},
    ({url,body,scopeReads})=>{if(url.endsWith('/me?onlyShayat=false')&&scopeReads===4)body.data.tenantid='other-tenant';},
    ({url,body,summaryReads})=>{if(url.includes('/getTenantLicenseInfo?')&&summaryReads===2)body.data[0].usedAmount=7;},
  ];
  for(const adjust of cases){const b=browser({adjust});const r=await b.run();assert.equal(r.status,'error');assert.equal(b.registry().size,0);}
});

test('new observation invalidates old tokens including after a failed new read',async()=>{
  let failNext=false;
  const b=browser({adjust:({result})=>failNext?{...result,status:401}:result});
  const first=await b.run();assert.equal(b.registry().has(first.token),true);
  const second=await b.run();assert.equal(b.registry().has(first.token),false);assert.equal(b.registry().has(second.token),true);
  failNext=true;
  assert.equal((await b.run()).status,'needs_login');assert.equal(b.registry().size,0);
});

test('HTTP errors, login redirects and malformed bodies never become empty snapshots',async()=>{
  for(const overrides of [
    {status:401},{status:403},{status:500},{redirected:true},{url:'https://other.invalid/'},
    {headers:{get:()=>'text/html'}},{json:async()=>({needrelogin:true})},{json:async()=>null},
  ]){
    const b=browser({adjust:({result})=>({...result,...overrides})});
    const result=await b.run();assert.notEqual(result.status,'ok');assert.equal(result.snapshot,undefined);assert.equal(b.registry().size,0);
  }
});

test('one 30-second deadline aborts in-flight read and creates no token',async()=>{
  let deadline;
  let activeSignal;
  const b=browser({timer:(fn,ms)=>{assert.equal(ms,30000);deadline=fn;return 1;},untimer:()=>{},
    adjust:({options})=>new Promise((_resolve,reject)=>{activeSignal=options.signal;options.signal.addEventListener('abort',()=>reject(new Error('aborted')));}),
  });
  const resultPromise=b.run();
  while(!activeSignal)await Promise.resolve();
  deadline();
  assert.equal((await resultPromise).code,'timeout');assert.equal(activeSignal.aborted,true);assert.equal(b.registry().size,0);
});

test('sanitizer rejects raw identities, extra fields, wrong tenant or expired snapshots',async()=>{
  const result=JSON.parse(JSON.stringify(await browser().run()));
  for(const mutate of [
    p=>{p.snapshot.records[0].id='real-user-id';},p=>{p.snapshot.records[0].userId='real-user-id';},
    p=>{p.snapshot.company='private';},p=>{p.extra='private';},p=>{p.snapshot.tenantKey='a'.repeat(64);},
    p=>{p.snapshot.observedAt=now-30001;},p=>{p.snapshot.observedAt=now+1;},p=>{p.token='arbitrary';},
  ]){
    const copy=structuredClone(result);mutate(copy);assert.equal(sanitizeReadSnapshot(copy,{expectedTenantHash,now}).status,'error');
  }
  assert.throws(()=>buildReadSnapshotEvaluation({expectedTenantHash:'bad',summarySource}));
  assert.throws(()=>buildReadSnapshotEvaluation({expectedTenantHash,summarySource:'import x from "x";'}));
});
