// #765 측정용 기록용 스크립트. packages/agent/e2e/에 두고 npx tsx로 돌렸다. 다시 만든 뒤 첫 화면·계약 조회가 얼마나 느려지는가
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { LocalDockerProvider } from '@b-studio/sandbox';
import { loadProject } from '@b-studio/spec';

const EXAMPLE = path.resolve(import.meta.dirname, '../../../examples/orders');
const WORK = path.join(homedir(), '.cache/b-studio/e2e', `orders-765b-${Date.now()}`);
const t = () => performance.now();
async function timed(url: string) { const s = t(); const res = await fetch(url); await res.text(); return Math.round(t() - s); }

async function main() {
  await mkdir(WORK, { recursive: true });
  await cp(EXAMPLE, WORK, { recursive: true, filter: (s) => !/[/\\](node_modules|\.next|build|\.gradle)([/\\]|$)/.test(s) });
  const sandbox = await new LocalDockerProvider().create(await loadProject(WORK));
  const rows: unknown[] = [];
  try {
    await sandbox.start();
    const web = (await sandbox.endpoint('web')).url;
    const api = (await sandbox.endpoint('api')).url;
    await timed(`${web}/`); await timed(`${api}/v3/api-docs`);
    for (let round = 1; round <= 3; round++) {
      const warmWeb = await timed(`${web}/`);
      const warmApi = await timed(`${api}/v3/api-docs`);
      let s = t(); await sandbox.restart('web'); const recWeb = Math.round(t() - s);
      const coldWeb = await timed(`${(await sandbox.endpoint('web')).url}/`);
      s = t(); await sandbox.restart('api'); const recApi = Math.round(t() - s);
      const coldApi = await timed(`${(await sandbox.endpoint('api')).url}/v3/api-docs`);
      // 둘을 함께(게이트의 Promise.all과 같게)
      s = t(); await Promise.all([sandbox.restart('web'), sandbox.restart('api')]); const recBoth = Math.round(t() - s);
      const row = { round, warmWeb, warmApi, recWeb, coldWeb, recApi, coldApi, recBoth };
      rows.push(row); console.log(JSON.stringify(row));
    }
  } finally {
    await sandbox.destroy();
    await rm(WORK, { recursive: true, force: true });
    await writeFile(process.env.OUT!, JSON.stringify(rows, null, 2));
  }
}
main().then(() => process.exit(0), (e: unknown) => { console.error(e); process.exit(1); });
