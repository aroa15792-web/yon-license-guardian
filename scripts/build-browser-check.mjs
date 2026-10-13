import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

// Build diagnostic source only. Nothing here opens or executes in a browser.
const sourceUrl = new URL('../src/license-summary.mjs', import.meta.url);
const outputDir = new URL('../runtime/', import.meta.url);
const outputUrl = new URL('browser-summary-check.js', outputDir);
const source = await readFile(sourceUrl, 'utf8');
const inlineSource = source.replace(/^export (?=(?:const|class|function)\b)/gm, '');
if (/^\s*(?:import|export)\b/m.test(inlineSource)) {
  throw new Error('统计模块包含无法内联的模块声明，停止生成');
}
const hash = createHash('sha256').update(source).digest('hex');
const diagnostic = `// Generated from src/license-summary.mjs; sha256=${hash}
// One authenticated, same-origin, read-only diagnostic. No scheduled execution.
(async () => {
  if (location.origin !== 'https://c3.yonyoucloud.com') {
    console.log('YON_LICENSE_READCHECK ' + JSON.stringify({ status: 'error', code: 'wrong_origin' }));
    return;
  }

${inlineSource}

  try {
    const client = createLicenseSummaryClient({
      transport: (url, options) => fetch(url, {
        ...options,
        credentials: 'same-origin',
        headers: { Accept: 'application/json', isAjax: '1' },
      }),
    });
    const summary = await client.read();
    console.log('YON_LICENSE_READCHECK ' + JSON.stringify(summary));
  } catch (error) {
    const code = error instanceof LicenseSummaryError ? error.code : 'diagnostic_error';
    console.log('YON_LICENSE_READCHECK ' + JSON.stringify({ status: 'error', code }));
  }
})();
`;

await mkdir(outputDir, { recursive: true, mode: 0o700 });
await writeFile(outputUrl, diagnostic, { mode: 0o600 });
console.log(fileURLToPath(outputUrl));
