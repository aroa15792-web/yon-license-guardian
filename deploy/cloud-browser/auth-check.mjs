import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {ensureCloudLogin} from './auto-login.mjs';
import {buildReadSnapshotEvaluation,sanitizeReadSnapshot} from './license-adapter.mjs';

const SUMMARY_URL='https://c3.yonyoucloud.com/iuap-apcom-workbench/manager/license/getTenantLicenseInfo?labelDomain=MM&status=VALID';
const SOURCE_PATH='/opt/yon-license-monitor/src/license-summary.mjs';
const ERROR_CODES=new Set(['auth_check_disabled','credential_unavailable','unsafe_credential','invalid_credential',
  'wrong_tenant','wrong_target','invalid_response','invalid_count','transport_error','timeout','unsupported_login_form',
  'challenge','login_rejected','login_unverified','auth_not_performed','login_in_progress','incomplete_list',
  'snapshot_changed','needs_login','access_denied','interrupted','unknown']);
const AUTH_PHASES=new Set(['initial_scope','navigate_login','find_form','fill_username','fill_password',
  'submit_login','verify_login','navigate_summary','verify_summary']);
const AUTH_STATUSES=new Set(['error','needs_login','access_denied','manual_login_required','login_rejected']);
class AuthCheckError extends Error{constructor(code){super(code);this.code=code;}}

export function requireAuthCheck(env=process.env){
  if(env.YON_AUTH_CHECK_ONLY!=='1'||typeof env.YON_TENANT_HASH!=='string'||!/^[a-f0-9]{64}$/.test(env.YON_TENANT_HASH)){
    throw new AuthCheckError('auth_check_disabled');
  }
  if(typeof env.CREDENTIALS_DIRECTORY!=='string'||!env.CREDENTIALS_DIRECTORY)throw new AuthCheckError('credential_unavailable');
  return {expectedTenantHash:env.YON_TENANT_HASH,credentialDirectory:env.CREDENTIALS_DIRECTORY};
}

// This check always launches a new non-persistent browser and new anonymous
// context. No existing profile path, storage state or journal is accessed.
export async function runAuthCheck({
  env=process.env,chromium,login=ensureCloudLogin,
  loadSummarySource=()=>readFile(SOURCE_PATH,'utf8'),signal,
}={}){
  let browser,context,closing;
  let phase='initial_scope';
  let authenticated=false;
  const assertRunning=()=>{if(signal?.aborted)throw new AuthCheckError('interrupted');};
  const close=()=>{
    closing=(closing??Promise.resolve()).catch(()=>{}).then(async()=>{
      try{if(context)await context.close();}finally{if(browser)await browser.close();}
    });
    return closing;
  };
  const abort=()=>{void close().catch(()=>{});};
  signal?.addEventListener('abort',abort,{once:true});
  try{
    const options=requireAuthCheck(env);
    assertRunning();
    if(!chromium)({chromium}=await import('playwright-core'));
    const source=await loadSummarySource();assertRunning();
    const script=buildReadSnapshotEvaluation({...options,summarySource:source});
    phase='launch_browser';
    browser=await chromium.launch({
      executablePath:'/usr/bin/google-chrome',headless:true,chromiumSandbox:true,timeout:30_000,
      handleSIGTERM:false,handleSIGINT:false,handleSIGHUP:false,
      args:['--window-size=1280,900','--window-position=0,0','--lang=zh-CN','--disable-sync',
        '--disable-background-networking','--disable-component-update','--disable-default-apps',
        '--disable-dev-shm-usage','--no-first-run','--no-default-browser-check'],
    });
    assertRunning();
    context=await browser.newContext({viewport:null});assertRunning();
    const page=await context.newPage();assertRunning();
    phase='navigate_anonymous';
    await page.goto(SUMMARY_URL,{waitUntil:'domcontentloaded',timeout:30_000});assertRunning();
    phase='initial_scope';
    const auth=await login(context,{...options,loginIfNeeded:true});assertRunning();
    if(auth?.status!=='ok')return {
      status:AUTH_STATUSES.has(auth?.status)?auth.status:'error',
      ...(ERROR_CODES.has(auth?.code)?{code:auth.code}:{}),
      phase:AUTH_PHASES.has(auth?.phase)?auth.phase:'initial_scope',authenticated:false,
    };
    if(auth.authenticated!==true)throw new AuthCheckError('auth_not_performed');
    authenticated=true;
    phase='snapshot';
    let timer;
    let raw;
    try{
      raw=await Promise.race([page.evaluate(script),new Promise((_,reject)=>{
        timer=setTimeout(()=>reject(new AuthCheckError('timeout')),35_000);
      })]);
    }finally{clearTimeout(timer);}
    assertRunning();
    const result=sanitizeReadSnapshot(raw,{expectedTenantHash:options.expectedTenantHash});
    if(result.status!=='ok')throw new AuthCheckError(ERROR_CODES.has(result.code)?result.code:
      ERROR_CODES.has(result.status)?result.status:'invalid_response');
    const snapshot=result.snapshot;
    return {status:'ok',authenticated:true,used:snapshot.used,capacity:snapshot.capacity,count:snapshot.records.length};
  }catch(error){
    return {status:'error',code:ERROR_CODES.has(error?.code)?error.code:'transport_error',phase,authenticated};
  }finally{
    signal?.removeEventListener('abort',abort);
    await close();
  }
}

export async function main(){
  process.umask(0o077);
  const abort=new AbortController();
  const stop=()=>abort.abort();
  process.once('SIGTERM',stop);process.once('SIGINT',stop);
  try{
    const result=await runAuthCheck({signal:abort.signal});
    console.log(JSON.stringify(result));
    if(result.status!=='ok')process.exitCode=2;
  }finally{
    process.removeListener('SIGTERM',stop);process.removeListener('SIGINT',stop);
  }
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  main().catch(()=>{
    console.error(JSON.stringify({status:'error',code:'transport_error',phase:'close_browser',authenticated:false}));
    process.exitCode=2;
  });
}
