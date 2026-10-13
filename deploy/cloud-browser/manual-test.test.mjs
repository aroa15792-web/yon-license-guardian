import test from 'node:test';
import assert from 'node:assert/strict';
import { TARGET } from '../../src/policy.mjs';
import { runManualTest,requireManualAuthorization } from './manual-test.mjs';

const time=1_800_000_000_000;
const uuid='12345678-1234-4234-8234-123456789abc';
// Synthetic fixtures only; production fields come from validated live responses.
const snapshot=(used=7,overrides={})=>({
  ...TARGET,status:'ok',tenantKey:'a'.repeat(64),scopeVerified:true,unfiltered:true,complete:true,
  observedAt:time,licenseState:'active',used,
  records:Array.from({length:used},(_,i)=>({id:String(i+1).padStart(64,'0')})),...overrides,
});
function setup(reads,{initial=null,release,write,sleep}={}){
  let data=initial;
  let calls=0;
  let readsCount=0;
  let clock=time;
  const events=[];
  const delays=[];
  const adapter={
    read:async()=>{
      readsCount++;events.push(`read${readsCount}`);
      if(!reads.length)throw new Error('read exhausted');
      const value=reads.shift();if(value instanceof Error)throw value;return value;
    },
    release:async op=>{
      calls++;events.push('release');
      assert.equal(data?.status,'pending');assert.equal(data.operationId,op.operationId);
      return release?release(op):{status:'acknowledged',headerMode:'standard_json'};
    },
  };
  const journal={read:async()=>data,write:async value=>{
    events.push(`journal_${value.status}`);if(write)await write(value);data=structuredClone(value);
  }};
  const run=()=>runManualTest({adapter,journal,now:()=>clock,operationId:()=>uuid,sleep:async ms=>{
    delays.push(ms);if(sleep)clock=await sleep(ms,clock);else clock+=ms;
  }});
  return {run,events,delays,get data(){return data;},get calls(){return calls;},get readsCount(){return readsCount;}};
}

test('explicit manual authorization needs both flag and exact CLI argument with tenant pin',()=>{
  const env={YON_MANUAL_TEST_ONCE:'1',YON_TENANT_HASH:'a'.repeat(64)};
  assert.equal(requireManualAuthorization(env,['--confirm-procurement-release']),'a'.repeat(64));
  for(const [badEnv,args] of [
    [{...env,YON_MANUAL_TEST_ONCE:'0'},['--confirm-procurement-release']],
    [{...env,YON_TENANT_HASH:'bad'},['--confirm-procurement-release']],
    [env,[]],[env,['--confirm-procurement-release','--again']],
  ])assert.throws(()=>requireManualAuthorization(badEnv,args),{code:'manual_test_disabled'});
});

test('7-person manual test performs double read, durable pending, third read and only one release',async()=>{
  const h=setup([snapshot(),snapshot(),snapshot(),snapshot(0)]);
  const result=await h.run();
  assert.deepEqual(h.events,['read1','read2','journal_pending','read3','release','read4','journal_verified']);
  assert.equal(h.calls,1);assert.equal(h.data.status,'verified');
  assert.deepEqual(result,{status:'verified',before:7,after:0,released:7,headerMode:'standard_json',timestamp:time});
  assert.equal(JSON.stringify(result).includes('tenantKey'),false);
  assert.equal(JSON.stringify(result).includes(uuid),false);
});

test('any existing test journal prevents both reads and a second release',async()=>{
  for(const status of ['pending','verified']){
    const h=setup([],{initial:{status}});
    assert.deepEqual(await h.run(),{status:'refused',code:'already_tested',timestamp:time});
    assert.equal(h.calls,0);assert.equal(h.readsCount,0);
  }
  const h=setup([snapshot(),snapshot(),snapshot(),snapshot(0)]);
  await h.run();assert.equal((await h.run()).status,'refused');assert.equal(h.calls,1);
});

test('zero occupants do not create a pending journal or send POST',async()=>{
  const h=setup([snapshot(0)]);
  assert.deepEqual(await h.run(),{status:'empty',before:0,after:0,released:0,timestamp:time});
  assert.equal(h.calls,0);assert.equal(h.data,null);
});

test('selection change before pending blocks; change after pending preserves journal without writing',async()=>{
  const changed=snapshot(7,{records:Array.from({length:7},(_,i)=>({id:String(i+20).padStart(64,'0')}))});
  const first=setup([snapshot(),changed]);
  assert.equal((await first.run()).status,'blocked');assert.equal(first.data,null);assert.equal(first.calls,0);
  const second=setup([snapshot(),snapshot(),changed]);
  const result=await second.run();assert.equal(result.status,'needs_reconciliation');assert.equal(result.code,'snapshot_changed');
  assert.equal(second.data.status,'pending');assert.equal(second.calls,0);
});

test('journal write failure prevents release and never silently starts a second operation',async()=>{
  const h=setup([snapshot(),snapshot()],{write:async()=>{throw new Error('private filesystem detail');}});
  const result=await h.run();assert.equal(h.calls,0);assert.equal(result.status,'needs_reconciliation');
  assert.equal(JSON.stringify(result).includes('filesystem'),false);
});

test('lost/rejected release outcome remains pending and is never retried',async()=>{
  for(const release of [
    async()=>{throw Object.assign(new Error('raw auth detail'),{code:'timeout'});},
    async()=>({status:'error',code:'reconciliation_required',reason:'business_rejected',headerMode:'native_mdf'}),
    async()=>({status:'unexpected',message:'raw secret'}),
  ]){
    const h=setup([snapshot(),snapshot(),snapshot()],{release});
    const result=await h.run();assert.equal(result.status,'needs_reconciliation');assert.equal(h.data.status,'pending');assert.equal(h.calls,1);
    assert.equal(JSON.stringify(result).includes('raw'),false);
    assert.equal((await h.run()).status,'refused');assert.equal(h.calls,1);
  }
});

test('delayed read-only verification succeeds without resending release',async()=>{
  const h=setup([snapshot(),snapshot(),snapshot(),snapshot(),snapshot(2),snapshot(0)]);
  const result=await h.run();assert.equal(result.status,'verified');assert.equal(h.calls,1);
  assert.deepEqual(h.delays,[1000,2000]);assert.equal(h.readsCount,6);
});

test('at most five verification reads and 30 seconds, never another POST',async()=>{
  const same=Array.from({length:8},()=>snapshot());
  const h=setup(same);
  assert.equal((await h.run()).status,'needs_reconciliation');assert.equal(h.calls,1);assert.equal(h.readsCount,8);
  assert.deepEqual(h.delays,[1000,2000,4000,8000]);assert.equal(h.data.status,'pending');
  const timed=setup([snapshot(),snapshot(),snapshot(),snapshot()],{sleep:async(_ms,clock)=>clock+30000});
  assert.equal((await timed.run()).status,'needs_reconciliation');assert.equal(timed.calls,1);assert.equal(timed.readsCount,4);
});

test('wrong tenant, old IDs remaining or invalid observation cannot be reported verified',async()=>{
  const afters=[snapshot(0,{tenantKey:'b'.repeat(64)}),snapshot(2),snapshot(0,{complete:false})];
  for(const after of afters){
    const h=setup([snapshot(),snapshot(),snapshot(),after,...Array.from({length:4},()=>after)]);
    assert.equal((await h.run()).status,'needs_reconciliation');assert.equal(h.data.status,'pending');assert.equal(h.calls,1);
  }
});
