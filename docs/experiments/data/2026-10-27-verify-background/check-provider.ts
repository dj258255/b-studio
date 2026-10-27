// #765 확인용 기록용 스크립트. packages/agent/e2e/에 두고 npx tsx로 돌렸다. 실제 orders 샌드박스에서 strayProcesses가 기준선·찾기·다시 띄운 뒤를 맞게 내는가
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { LocalDockerProvider } from '@b-studio/sandbox';
import { loadProject } from '@b-studio/spec';

const EXAMPLE = path.resolve(import.meta.dirname, '../../../examples/orders');
const WORK = path.join(homedir(), '.cache/b-studio/e2e', `orders-765c-${Date.now()}`);
const t = () => performance.now();

async function main() {
  await mkdir(WORK, { recursive: true });
  await cp(EXAMPLE, WORK, { recursive: true, filter: (s) => !/[/\\](node_modules|\.next|build|\.gradle)([/\\]|$)/.test(s) });
  const sandbox = await new LocalDockerProvider().create(await loadProject(WORK));
  const rows: unknown[] = [];
  try {
    await sandbox.start();
    for (let round = 1; round <= 3; round++) {
      let s = t(); const idle = await sandbox.strayProcesses!(); const idleMs = Math.round(t() - s);
      await sandbox.exec('api', ['sh', '-c', 'nohup sh -c "while true; do sleep 1; done" >/dev/null 2>&1 &']);
      await sandbox.exec('web', ['sh', '-c', 'setsid sh -c "while true; do sleep 1; done" >/dev/null 2>&1 &']);
      s = t(); const found = await sandbox.strayProcesses!(); const foundMs = Math.round(t() - s);
      s = t(); await Promise.all(found.map((r) => sandbox.restart(r.service))); const restartMs = Math.round(t() - s);
      const after = await sandbox.strayProcesses!();
      const api = await fetch(`${(await sandbox.endpoint('api')).url}/actuator/health/readiness`).then((r) => r.status).catch((e: unknown) => String(e));
      const row = { round, idle, idleMs, found, foundMs, restartMs, after, api };
      rows.push(row); console.log(JSON.stringify(row));
    }
  } finally {
    await sandbox.destroy();
    await rm(WORK, { recursive: true, force: true });
    await writeFile(process.env.OUT!, JSON.stringify(rows, null, 2));
  }
}
main().then(() => process.exit(0), (e: unknown) => { console.error(e); process.exit(1); });
