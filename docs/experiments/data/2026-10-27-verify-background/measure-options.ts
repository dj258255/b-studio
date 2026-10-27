// #765 측정용 기록용 스크립트. packages/agent/e2e/에 두고 npx tsx로 돌렸다. examples/orders 샌드박스에서 검사 시간과 2안·3안의 비용을 잰다
import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { LocalDockerProvider } from '@b-studio/sandbox';
import { loadProject } from '@b-studio/spec';

const EXAMPLE = path.resolve(import.meta.dirname, '../../../examples/orders');
const OUT = process.env.OUT!;
const WORK = path.join(homedir(), '.cache/b-studio/e2e', `orders-765-${Date.now()}`);
const ROUNDS = 3;

// PID 1과 세션이 다른 프로세스(=docker exec로 들어온 것과 그 자손). 자기 자신(이 스크립트의 세션)은 뺀다
const SCAN = `me=$(sed 's/^.*) //' /proc/$$/stat | cut -d' ' -f4); root=$(sed 's/^.*) //' /proc/1/stat | cut -d' ' -f4);
for d in /proc/[0-9]*; do s=$(sed 's/^.*) //' $d/stat 2>/dev/null | cut -d' ' -f4) || continue; [ -z "$s" ] && continue;
[ "$s" = "$root" ] && continue; [ "$s" = "$me" ] && continue; echo "\${d#/proc/} sid=$s $(tr '\\0' ' ' < $d/cmdline 2>/dev/null | cut -c1-120)"; done`;
const ALL = `for d in /proc/[0-9]*; do echo "\${d#/proc/} sid=$(sed 's/^.*) //' $d/stat 2>/dev/null | cut -d' ' -f4) $(tr '\\0' ' ' < $d/cmdline 2>/dev/null | cut -c1-100)"; done`;

const out: Record<string, unknown> = { rounds: [] as unknown[] };
const t = () => performance.now();
const ms = (start: number) => Math.round(t() - start);

async function main() {
  await mkdir(WORK, { recursive: true });
  await cp(EXAMPLE, WORK, { recursive: true, filter: (s) => !/[/\\](node_modules|\.next|build|\.gradle)([/\\]|$)/.test(s) });
  const project = await loadProject(WORK);
  const sandbox = await new LocalDockerProvider().create(project);
  try {
    let s = t();
    await sandbox.start();
    out.bootMs = ms(s);
    console.log('boot', out.bootMs);
    for (const svc of ['web', 'api']) out[`processes-${svc}-after-boot`] = (await sandbox.exec(svc, ['sh', '-c', ALL])).stdout;
    for (let round = 1; round <= ROUNDS; round++) {
      const r: Record<string, unknown> = { round };
      // 지금 게이트의 선언 검사(test 단계)
      s = t();
      const lint = await sandbox.exec('web', ['pnpm', 'lint']);
      r.webLintMs = ms(s);
      r.webLintExit = lint.exitCode;
      s = t();
      const unit = await sandbox.exec('api', ['./gradlew', 'test', '--no-daemon', '--console=plain', '--project-cache-dir', '/tmp/gradle-test-cache']);
      r.apiUnitMs = ms(s);
      r.apiUnitExit = unit.exitCode;
      // 에이전트가 run_in_service로 남긴 백그라운드 프로세스 흉내
      for (const svc of ['web', 'api']) await sandbox.exec(svc, ['sh', '-c', 'nohup sh -c "while true; do sleep 1; done" >/dev/null 2>&1 &']);
      // 3안(세션 기준): 찾기와 끝내기
      for (const svc of ['web', 'api']) {
        s = t();
        const found = await sandbox.exec(svc, ['sh', '-c', SCAN]);
        r[`scan-${svc}-ms`] = ms(s);
        r[`scan-${svc}`] = found.stdout.trim().split('\n').filter(Boolean);
        s = t();
        const pids = (r[`scan-${svc}`] as string[]).map((line) => line.split(' ')[0]).join(' ');
        if (pids) await sandbox.exec(svc, ['sh', '-c', `kill -9 ${pids} 2>/dev/null; true`]);
        r[`kill-${svc}-ms`] = ms(s);
        r[`after-kill-${svc}`] = (await sandbox.exec(svc, ['sh', '-c', SCAN])).stdout.trim().split('\n').filter(Boolean);
      }
      // 서비스가 끝낸 뒤에도 살아 있는지
      for (const svc of ['web', 'api']) {
        const endpoint = await sandbox.endpoint(svc);
        const p = svc === 'web' ? '/' : '/actuator/health/readiness';
        r[`alive-${svc}`] = await fetch(`${endpoint.url}${p}`).then((res) => res.status).catch((e: unknown) => String(e));
      }
      // 2안: 바뀌지 않은 서비스를 다시 만든다(게이트의 재시작과 같은 up --force-recreate --build + 준비 대기)
      for (const svc of ['web', 'api']) {
        s = t();
        await sandbox.restart(svc);
        r[`recreate-${svc}-ms`] = ms(s);
      }
      (out.rounds as unknown[]).push(r);
      console.log(JSON.stringify(r));
      await writeFile(OUT, JSON.stringify(out, null, 2));
    }
  } finally {
    await sandbox.destroy();
    await rm(WORK, { recursive: true, force: true });
  }
  await writeFile(OUT, JSON.stringify(out, null, 2));
}

main().then(() => process.exit(0), (error: unknown) => { console.error(error); process.exit(1); });
