import { readFile, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { FileJournal, FileJournalError } from '../../src/file-journal.mjs';
import { fingerprint, validate, ObservationError } from '../../src/policy.mjs';
import { buildReadSnapshotEvaluation, sanitizeReadSnapshot } from './license-adapter.mjs';
import { buildManualTestReleaseEvaluation } from './release-operation.mjs';
import { ensureCloudLogin } from './auto-login.mjs';

const PROFILE_PATH = '/var/lib/yon-license-monitor/chrome-profile';
const SUMMARY_URL = 'https://c3.yonyoucloud.com/iuap-apcom-workbench/manager/license/getTenantLicenseInfo?labelDomain=MM&status=VALID';
const CODES = new Set(['needs_login','access_denied','wrong_tenant','wrong_target','invalid_response',
  'invalid_count','incomplete_list','snapshot_changed','unsafe_user_id','timeout','transport_error',
  'reconciliation_required','verification_required','business_rejected','invalid_headers','http_error',
  'invalid_token','expired_token','fingerprint_mismatch','unknown','journal_error','invalid_observation',
  'manual_login_required','login_rejected','credential_unavailable','unsafe_credential','invalid_credential',
  'unsupported_login_form','challenge','login_unverified','login_in_progress']);
class ManualTestError extends Error {
  constructor(code) { super(code); this.code = code; }
}
const errorCode = error => error instanceof FileJournalError ? 'journal_error' :
  error instanceof ObservationError ? 'invalid_observation' : CODES.has(error?.code) ? error.code : 'unknown';
const headerMode = value => ['standard_json','native_mdf'].includes(value) ? value : undefined;

export function requireManualAuthorization(env = process.env, args = process.argv.slice(2)) {
  if (env.YON_MANUAL_TEST_ONCE !== '1' || args.length !== 1 || args[0] !== '--confirm-procurement-release' ||
      typeof env.YON_TENANT_HASH !== 'string' || !/^[a-f0-9]{64}$/.test(env.YON_TENANT_HASH)) {
    throw new ManualTestError('manual_test_disabled');
  }
  return env.YON_TENANT_HASH;
}

// A separate one-shot journal is intentional: any prior test, even a verified
// one, blocks another mutation. Only opaque hashes reach this controller.
export async function runManualTest({
  adapter, journal, now = Date.now,
  sleep = milliseconds => new Promise(resolve => setTimeout(resolve,milliseconds)),
  operationId = randomUUID,
} = {}) {
  let pendingAttempted = false;
  let before;
  let releaseHeaderMode;
  const report = (status, extra = {}) => ({status,...extra,timestamp:now()});
  try {
    if (await journal.read() !== null) return report('refused',{code:'already_tested'});
    const first = validate(await adapter.read(),now());
    if (first.used === 0) return report('empty',{before:0,after:0,released:0});
    if (first.used > 1000) throw new ManualTestError('invalid_count');
    const expectedFingerprint = fingerprint(first);
    const second = validate(await adapter.read(),now());
    if (fingerprint(second) !== expectedFingerprint) throw new ManualTestError('snapshot_changed');
    before = second.used;
    const op = {ids:first.records.map(row=>row.id),expectedFingerprint,tenantKey:first.tenantKey,operationId:operationId()};
    pendingAttempted = true;
    await journal.write({status:'pending',operationId:op.operationId,at:now(),before,fingerprint:expectedFingerprint});
    const third = validate(await adapter.read(),now());
    if (third.tenantKey !== op.tenantKey || fingerprint(third) !== expectedFingerprint ||
        JSON.stringify(third.records.map(row=>row.id).sort()) !== JSON.stringify([...op.ids].sort())) {
      throw new ManualTestError('snapshot_changed');
    }
    const result = await adapter.release(op);
    releaseHeaderMode = headerMode(result?.headerMode);
    if (result?.status !== 'acknowledged') throw new ManualTestError(
      CODES.has(result?.reason) ? result.reason : CODES.has(result?.code) ? result.code : 'reconciliation_required');
    const oldIds = new Set(op.ids);
    const deadline = now()+30_000;
    let expired = false;
    let timer;
    const checkDeadline = () => { if (expired || now() >= deadline) throw new ManualTestError('reconciliation_required'); };
    const timeout = new Promise((_,reject)=>{
      timer = setTimeout(()=>{expired=true;reject(new ManualTestError('reconciliation_required'));},30_000);
    });
    let after;
    try {
      after = await Promise.race([timeout,(async()=>{
        for (let attempt=0;attempt<5;attempt++) {
          checkDeadline();
          let current;
          try { current=validate(await adapter.read(),now()); }
          catch(error) { checkDeadline(); if(error?.code!=='snapshot_changed')throw error; }
          checkDeadline();
          if(current){
            if(current.tenantKey!==op.tenantKey)throw new ManualTestError('wrong_tenant');
            if(current.used<before&&current.records.every(row=>!oldIds.has(row.id)))return current;
          }
          if(attempt<4)await sleep(Math.min(1000*2**attempt,deadline-now()));
        }
        throw new ManualTestError('reconciliation_required');
      })()]);
    } finally {clearTimeout(timer);}
    await journal.write({status:'verified',operationId:op.operationId,at:now(),before,after:after.used,released:op.ids.length});
    return report('verified',{before,after:after.used,released:op.ids.length,...(releaseHeaderMode?{headerMode:releaseHeaderMode}:{})});
  } catch(error) {
    return report(pendingAttempted?'needs_reconciliation':'blocked',{
      code:errorCode(error),...(before===undefined?{}:{before}),...(releaseHeaderMode?{headerMode:releaseHeaderMode}:{}),
    });
  }
}

async function boundedEvaluation(page,script,timeoutMs) {
  let timer;
  try {
    return await Promise.race([page.evaluate(script),new Promise((_,reject)=>{
      timer=setTimeout(()=>reject(new ManualTestError('timeout')),timeoutMs);
    })]);
  } finally {clearTimeout(timer);}
}

export async function main() {
  const expectedTenantHash=requireManualAuthorization();
  process.umask(0o077);
  const state=await realpath('/var/lib/yon-license-monitor');
  const journal=new FileJournal({directory:`${state}/manual-test`});
  if(await journal.read()!==null){
    console.log(JSON.stringify({status:'refused',code:'already_tested',timestamp:Date.now()}));
    process.exitCode=2;return;
  }
  const summarySource=await readFile('/opt/yon-license-monitor/src/license-summary.mjs','utf8');
  const readScript=buildReadSnapshotEvaluation({expectedTenantHash,summarySource});
  let context;
  let stopped=false;
  let closing;
  const shutdown=()=>{
    stopped=true;
    closing=(closing??Promise.resolve()).catch(()=>{}).then(async()=>{if(context)await context.close();});
    return closing;
  };
  const stop=()=>{void shutdown().catch(()=>{process.exitCode=1;});};
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  try{
    const {chromium}=await import('playwright-core');
    context=await chromium.launchPersistentContext(PROFILE_PATH,{
      executablePath:'/usr/bin/google-chrome',headless:true,chromiumSandbox:true,viewport:null,
      handleSIGTERM:false,handleSIGINT:false,handleSIGHUP:false,
      args:['--window-size=1280,900','--window-position=0,0','--lang=zh-CN','--disable-sync',
        '--disable-background-networking','--disable-component-update','--disable-default-apps',
        '--disable-dev-shm-usage','--no-first-run','--no-default-browser-check'],
    });
    if(stopped)return;
    const page=context.pages()[0]??await context.newPage();
    for(const other of context.pages())if(other!==page)await other.close();
    await page.goto(SUMMARY_URL,{waitUntil:'domcontentloaded',timeout:30_000});
    if (process.env.YON_AUTO_LOGIN === '1') {
      const login = await ensureCloudLogin(context,{expectedTenantHash});
      console.log(JSON.stringify({status:'authentication',result:login.status,
        ...(login.code?{code:login.code}:{}),...(login.phase?{phase:login.phase}:{}),
        ...(login.authenticated===true?{authenticated:true}:{})}));
      if (login.status !== 'ok') throw new ManualTestError(login.code ?? login.status);
    }
    let latest;
    const assertRunning=()=>{if(stopped)throw new ManualTestError('transport_error');};
    const adapter={
      async read(){
        assertRunning();latest=undefined;
        const result=sanitizeReadSnapshot(await boundedEvaluation(page,readScript,35_000),{expectedTenantHash});
        assertRunning();
        if(result.status!=='ok')throw new ManualTestError(result.code??result.status);
        latest=result;return result.snapshot;
      },
      async release(operation){
        assertRunning();
        if(!latest||fingerprint(latest.snapshot)!==operation.expectedFingerprint)throw new ManualTestError('snapshot_changed');
        const token=latest.token;latest=undefined;
        return boundedEvaluation(page,buildManualTestReleaseEvaluation({token,...operation}),20_000);
      },
    };
    const result=await runManualTest({adapter,journal});
    console.log(JSON.stringify(result));
    if(!['verified','empty'].includes(result.status))process.exitCode=2;
  }finally{
    await shutdown();
    process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  main().catch(error=>{
    console.error(JSON.stringify({status:'blocked',code:error?.code==='manual_test_disabled'?'manual_test_disabled':errorCode(error),timestamp:Date.now()}));
    process.exitCode=2;
  });
}
