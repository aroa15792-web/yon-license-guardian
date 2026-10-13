import { readFile } from 'node:fs/promises';
import { plan } from './policy.mjs';

const path = process.argv[2];
if (!path) {
  console.error('用法：npm run check -- <已脱敏的快照.json>\n此命令仅检查快照，不连接或修改用友。');
  process.exitCode = 2;
} else {
  try {
    const proposed = plan(JSON.parse(await readFile(path, 'utf8')));
    // Deliberately exclude record IDs and tenant identity from output.
    console.log(JSON.stringify({ action: proposed.action, used: proposed.used, count: proposed.count }, null, 2));
  } catch (error) {
    console.error(`停止：${error.message}`);
    process.exitCode = 1;
  }
}
