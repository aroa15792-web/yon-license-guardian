import path from 'node:path';
import { constants } from 'node:fs';
import { lstat,open,readFile } from 'node:fs/promises';
import { buildTenantScopeEvaluation,sanitizeTenantScope } from './tenant-scope.mjs';

// Use the target cluster's native shell so CAS constructs its service callback
// for c3/login_light rather than the anonymous www shell's default c2 cluster.
const HOME_URL='https://c3.yonyoucloud.com/';
const SUMMARY_URL='https://c3.yonyoucloud.com/iuap-apcom-workbench/manager/license/getTenantLicenseInfo?labelDomain=MM&status=VALID';
const SCOPE_SCRIPT=buildTenantScopeEvaluation();
const MAX_CREDENTIAL_BYTES=8192;
const SYSTEMD_CREDENTIAL_DIRECTORIES=new Set([
  '/run/credentials/yon-license-monitor.service',
  '/run/credentials/yon-license-test.service',
  '/run/credentials/yon-license-auth-check.service',
]);
const safeCodes=new Set(['credential_unavailable','unsafe_credential','invalid_credential','wrong_tenant',
  'invalid_response','transport_error','timeout','unsupported_login_form','challenge','login_rejected','login_unverified']);
class LoginError extends Error{constructor(code){super(code);this.code=code;}}

export function validateCredentialMetadata({directoryPath,directory,file,uid=process.getuid()}){
  if(!directory?.isDirectory()||directory.isSymbolicLink()||!file?.isFile()||file.isSymbolicLink()||
      file.nlink!==1||file.size<2||file.size>MAX_CREDENTIAL_BYTES)throw new LoginError('unsafe_credential');
  if(SYSTEMD_CREDENTIAL_DIRECTORIES.has(directoryPath)){
    // systemd's observed LoadCredential mount grants this service access with
    // ACLs, while retaining root:root ownership and no permissions for others.
    // This exception is limited to the exact service credential paths above.
    if(directory.uid!==0||directory.gid!==0||(directory.mode&0o7777)!==0o550||
        file.uid!==0||file.gid!==0||(file.mode&0o7777)!==0o440)throw new LoginError('unsafe_credential');
  }else if(directory.uid!==uid||(directory.mode&0o7777)!==0o700||file.uid!==uid||
      ![0o400,0o600].includes(file.mode&0o7777))throw new LoginError('unsafe_credential');
}

// Load only this service's systemd credential, read-only. Never inspect browser
// cookies, other environment secrets, arbitrary files, or caller-supplied names.
export async function readLoginCredential(directory=process.env.CREDENTIALS_DIRECTORY){
  if(typeof directory!=='string'||!path.isAbsolute(directory)||directory.includes('\0')||
      directory.split(path.sep).includes('..'))throw new LoginError('credential_unavailable');
  let handle;
  let buffer;
  try{
    const dir=await lstat(directory);
    if(!dir.isDirectory()||dir.isSymbolicLink())throw new LoginError('unsafe_credential');
    const filename=path.join(directory,'yon-login');
    const before=await lstat(filename);
    const check=metadata=>validateCredentialMetadata({directoryPath:directory,directory:dir,file:metadata});
    check(before);
    handle=await open(filename,constants.O_RDONLY|constants.O_NOFOLLOW);
    const actual=await handle.stat();check(actual);
    if(actual.ino!==before.ino||actual.dev!==before.dev)throw new LoginError('unsafe_credential');
    buffer=await handle.readFile();
    if(buffer.length>MAX_CREDENTIAL_BYTES)throw new LoginError('unsafe_credential');
    let value;
    try{value=JSON.parse(buffer.toString('utf8'));}catch{throw new LoginError('invalid_credential');}
    if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='password,username'||
        typeof value.username!=='string'||!value.username.trim()||value.username.length>256||/[\0\r\n]/.test(value.username)||
        typeof value.password!=='string'||!value.password||value.password.length>4096||value.password.includes('\0'))throw new LoginError('invalid_credential');
    return {username:value.username,password:value.password};
  }catch(error){throw error instanceof LoginError?error:new LoginError('credential_unavailable');}
  finally{buffer?.fill(0);await handle?.close();}
}

function isOrigin(frame,origin){try{return new URL(frame.url()).origin===origin;}catch{return false;}}
function c3Frame(context){
  for(const page of context.pages())for(const frame of page.frames())if(isOrigin(frame,'https://c3.yonyoucloud.com'))return frame;
  return null;
}
function casFrame(page){
  for(const frame of page.frames()){
    try{const url=new URL(frame.url());if(url.origin==='https://euc.yonyoucloud.com'&&url.pathname==='/cas/login')return frame;}catch{}
  }
  return null;
}
function isScopeTransition(error){
  // Examine only an exception from a read in the post-submit verification loop.
  // Never forward the message; ordinary network/auth errors do not match.
  return typeof error?.message==='string'&&
    /Execution context was destroyed|frame (?:was|has been|is) detached|detached frame/i.test(error.message);
}
async function visible(frame,selector){
  const locator=frame.locator(selector);
  const count=await locator.count();
  for(let i=0;i<count;i++)if(await locator.nth(i).isVisible())return locator.nth(i);
  return null;
}
// Selectors verified against the deployed official CAS HTML and unified58 JS.
// All checks use visibility: the challenge containers also exist while hidden.
async function loginObstacle(frame){
  for(const selector of ['#captcha-box','#tfaNormalDiv','#tfaValidateCodeInput','#tfaMfaDiv','#mfaCodeInput',
    '#tfaFaceDiv','#fm2','#modify_password','#modify_newpass']){
    if(await visible(frame,selector))return 'challenge';
  }
  for(const selector of ['#usernameErrorMsg','#pwdErrorMsg','#imgErrorMsg','#codeErrorMsg','#mfaCodeErrorMsg','#msg.errors']){
    const error=await visible(frame,selector);
    if(error&&(await error.textContent())?.trim())return 'login_rejected';
  }
  // #warn is only "remember username". Leave it unchanged. Unknown visible
  // consent checkboxes are a manual decision, never something to auto-accept.
  const checkboxes=frame.locator('#fm1 input[type="checkbox"]:not(#warn)');
  for(let i=0;i<await checkboxes.count();i++){
    const checkbox=checkboxes.nth(i);
    if(await checkbox.isVisible()&&!await checkbox.isChecked())return 'challenge';
  }
  return null;
}
async function dismissNonbindingCookieNotices(page,remaining){
  for(const frame of page.frames()){
    if(!['https://www.yonyoucloud.com','https://c3.yonyoucloud.com','https://c2.yonyoucloud.com'].some(origin=>isOrigin(frame,origin)))continue;
    const refuse=await visible(frame,'.workbench-overlay button.button_f:not(.button_accept)');
    if(refuse)await refuse.click({timeout:remaining(),noWaitAfter:true});
    const close=await visible(frame,'.cookie-modal-close[aria-label="close"]');
    if(close)await close.click({timeout:remaining(),noWaitAfter:true});
  }
}

let summarySourcePromise;
async function readFinalStats(context,{timeoutMs}){
  const frame=c3Frame(context);
  if(!frame)return {status:'needs_login'};
  summarySourcePromise??=readFile(new URL('../../src/license-summary.mjs',import.meta.url),'utf8');
  const source=(await summarySourcePromise).replace(/^export (?=(?:const|class|function)\b)/gm,'');
  if(/^\s*(?:import|export)\b/m.test(source))throw new LoginError('invalid_response');
  const bounded=Math.max(1,Math.min(10_000,Math.floor(timeoutMs)));
  return frame.evaluate(`(async()=>{
    if(location.origin!=='https://c3.yonyoucloud.com')return {status:'needs_login'};
    ${source}
    let auth;
    try{
      const client=createLicenseSummaryClient({timeoutMs:${bounded},transport:async(url,options)=>{
        const response=await fetch(url,{...options,credentials:'same-origin',headers:{Accept:'application/json',isAjax:'1'}});
        if(response.status===401)auth='needs_login';
        if(response.status===403)auth='access_denied';
        return {status:response.status,url:response.url,redirected:response.redirected,type:response.type,headers:response.headers,
          json:async()=>{const body=await response.json();if(body?.needrelogin===true||body?.errorCode==='000001')auth='needs_login';return body;}};
      }});
      await client.read();
      return auth?{status:auth}:{status:'ok'};
    }catch(error){return auth?{status:auth}:{status:'error',code:error instanceof LicenseSummaryError?error.code:'transport_error'};}
  })()`);
}

// Injectable boundaries exist only for deterministic tests. Production defaults
// always use the fixed scope evaluation and read-only systemd credential loader.
export function createCloudLogin({
  readCredential=readLoginCredential,now=Date.now,
  sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms)),
  readScope=async context=>{
    const frame=c3Frame(context);
    return frame?sanitizeTenantScope(await frame.evaluate(SCOPE_SCRIPT)):{status:'needs_login'};
  },
  readStats=readFinalStats,
}={}){
  const inflight=new WeakMap();
  const ensure=async(context,{expectedTenantHash,credentialDirectory=process.env.CREDENTIALS_DIRECTORY,loginIfNeeded=true}={})=>{
    if(typeof expectedTenantHash!=='string'||!/^[a-f0-9]{64}$/.test(expectedTenantHash))return {status:'error',code:'wrong_tenant',phase:'initial_scope'};
    if(inflight.has(context))return {status:'error',code:'login_in_progress',phase:'initial_scope'};
    const work=(async()=>{
      const started=now();let expired=false;let timer;let credential;
      let phase='initial_scope';
      const remaining=()=>{
        const ms=30_000-(now()-started);
        if(expired||ms<=0||now()<started)throw new LoginError('timeout');
        return Math.max(1,Math.floor(ms));
      };
      const scope=async()=>{
        remaining();const result=await readScope(context);remaining();
        if(result.status==='ok'){
          if(result.scope?.tenantHash!==expectedTenantHash)throw new LoginError('wrong_tenant');
          if(!Number.isSafeInteger(result.scope?.observedAt)||result.scope.observedAt>now()||now()-result.scope.observedAt>30_000)throw new LoginError('invalid_response');
          return {status:'ok',observedAt:result.scope.observedAt};
        }
        if(result.status==='needs_login'||result.status==='access_denied')return {status:result.status};
        throw new LoginError(safeCodes.has(result.code)?result.code:'invalid_response');
      };
      const deadline=new Promise((_,reject)=>{timer=setTimeout(()=>{expired=true;reject(new LoginError('timeout'));},30_000);});
      try{
        return await Promise.race([deadline,(async()=>{
          const initial=await scope();
          if(initial.status==='ok')return {status:'ok',authenticated:false,observedAt:initial.observedAt};
          if(initial.status!=='needs_login'||!loginIfNeeded)return {...initial,phase};
          const loaded=await readCredential(credentialDirectory);
          try{remaining();}catch(error){loaded.username='';loaded.password='';throw error;}
          credential=loaded;
          const page=context.pages()[0]??await context.newPage();
          remaining();
          phase='navigate_login';
          await page.goto(HOME_URL,{waitUntil:'domcontentloaded',timeout:remaining()});remaining();
          let form;
          let selectedAccount=false;
          phase='find_form';
          while(!form){
            remaining();await dismissNonbindingCookieNotices(page,remaining);remaining();
            const frame=casFrame(page);
            if(frame){
              const obstacle=await loginObstacle(frame);remaining();
              if(obstacle)throw new LoginError(obstacle);
              if(!selectedAccount){
                const tab=await visible(frame,'li#toNormalLogin');
                if(tab){
                  if(!(await tab.getAttribute('class')??'').split(/\s+/).includes('active')){
                    await tab.click({timeout:remaining(),noWaitAfter:true});remaining();
                  }
                  selectedAccount=true;
                }
              }
              const user=await visible(frame,'#fm1 #username');
              const pass=await visible(frame,'#fm1 #password');
              const submit=await visible(frame,'#fm1 #submit_btn_login');
              if(user&&pass&&submit)form={frame,user,pass,submit};
            }
            if(!form)await sleep(Math.min(200,remaining()));
          }
          remaining();
          if(!await form.submit.isEnabled())throw new LoginError('challenge');
          phase='fill_username';
          await form.user.fill(credential.username,{timeout:remaining()});remaining();
          phase='fill_password';
          await form.pass.fill(credential.password,{timeout:remaining()});remaining();
          const beforeSubmit=await loginObstacle(form.frame);remaining();
          if(beforeSubmit)throw new LoginError(beforeSubmit);
          phase='submit_login';
          await form.submit.click({timeout:remaining(),noWaitAfter:true});remaining();
          // A click is not success. The pin must validate in the authenticated
          // c3 application, and then again on the lightweight statistics page.
          const verifySummary=async()=>{
            phase='navigate_summary';
            await page.goto(SUMMARY_URL,{waitUntil:'domcontentloaded',timeout:remaining()});remaining();
            phase='verify_summary';
            const final=await scope();
            if(final.status!=='ok')throw new LoginError('login_unverified');
            const stats=await readStats(context,{timeoutMs:remaining()});remaining();
            if(stats?.status!=='ok'){
              if(stats?.status==='needs_login')throw new LoginError('login_unverified');
              if(stats?.status==='access_denied')return {status:'access_denied',phase};
              throw new LoginError(safeCodes.has(stats?.code)?stats.code:'invalid_response');
            }
            return {status:'ok',authenticated:true,observedAt:final.observedAt};
          };
          while(true){
            remaining();
            phase='verify_login';
            let result;
            try{
              const loginFrame=casFrame(page);
              if(loginFrame){
                const obstacle=await loginObstacle(loginFrame);remaining();
                if(obstacle)throw new LoginError(obstacle);
              }
              // CAS disappearing is only a navigation transition. Preserve the
              // native login_light callback until c3 scope proves it completed;
              // navigating away before this read succeeds can interrupt login.
              result=await scope();
            }catch(error){
              if(!isScopeTransition(error))throw error;
              remaining();
              await sleep(Math.min(250,remaining()));
              continue;
            }
            if(result.status==='ok'){
              return verifySummary();
            }
            if(result.status==='access_denied')return {...result,phase};
            await sleep(Math.min(250,remaining()));
          }
        })()]);
      }catch(error){
        const code=safeCodes.has(error?.code)?error.code:'transport_error';
        if(code==='login_rejected')return {status:'login_rejected',phase};
        if(['challenge','unsupported_login_form','login_unverified'].includes(code)||code==='timeout')return {status:'manual_login_required',code,phase};
        return {status:'error',code,phase};
      }finally{
        expired=true;clearTimeout(timer);
        if(credential){credential.username='';credential.password='';credential=undefined;}
      }
    })();
    inflight.set(context,work);
    try{return await work;}finally{inflight.delete(context);}
  };
  return ensure;
}

export const ensureCloudLogin=createCloudLogin();
