import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LoadedProject } from '@b-studio/spec';
import { afterEach, describe, expect, it } from 'vitest';
import { SandboxError } from '../errors';
import type { LoadRequest } from '../types';
import { LocalDockerProvider } from './compose-provider';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const project = {
  spec: { name: 'shop' },
  root: '/tmp/shop',
  composePath: '/tmp/shop/compose.yaml',
  managed: [['api', { port: 8080 }]],
  composeServices: ['api'],
  sharedVolumes: [],
  external: [],
  publicUrlRefs: [],
} as unknown as LoadedProject;

const request: LoadRequest = { service: 'api', method: 'POST', path: '/orders/{{seq}}', body: '{"n":1}', concurrent: 1000, requests: 1000, latencyOf: [409] };

const OUTPUT = JSON.stringify({
  requests: 1000,
  concurrent: 1000,
  threads: 4,
  completed: 1000,
  elapsedMs: 120.5,
  statuses: { '201': 50, '409': 950 },
  errors: {},
  latency: { count: 950, p50: 10, p95: 30, p99: 32, max: 33 },
  connect: { count: 1000, p50: 60, p95: 70, p99: 72, max: 75, errors: 0 },
  loopDelay: { p99: 5, max: 9 },
  warmup: { requests: 0, errors: 0 },
});

/**
 * 호출 인자를 기록하고, `run`에는 넘긴 셸 조각대로 답하는 가짜 docker. `run`이 받은 표준 입력은 stdin.txt에 남긴다.
 * 서비스 상태(ps)와 CPU 수(info)는 인자로 정한다
 */
async function fakeDocker(run: string, { state = 'running', cpus = '12' } = {}): Promise<{ bin: string; calls: () => Promise<string[]>; stdin: () => Promise<string> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'load-provider-'));
  dirs.push(dir);
  const bin = path.join(dir, 'docker');
  await writeFile(
    bin,
    `#!/bin/sh
printf '%s\\n' "$*" >> "${dir}/calls.log"
case "$1" in
  info) echo "${cpus}"; exit 0 ;;
  run) cat > "${dir}/stdin.txt"; ${run} ;;
  rm) exit 0 ;;
esac
for a in "$@"; do
  case "$a" in
    config) echo '{"services":{}}'; exit 0 ;;
    ps) echo '{"Service":"api","State":"${state}"}'; exit 0 ;;
  esac
done
exit 0
`,
  );
  await chmod(bin, 0o755);
  return {
    bin,
    calls: async () => (await readFile(path.join(dir, 'calls.log'), 'utf8')).trim().split('\n'),
    stdin: () => readFile(path.join(dir, 'stdin.txt'), 'utf8'),
  };
}

const caught = (promise: Promise<unknown>) => promise.then(() => undefined, (error: unknown) => error as SandboxError);

describe('LocalDockerSandbox.runLoad (ADR-163)', () => {
  it('샌드박스 네트워크에 붙인 일회용 컨테이너에서 러너를 돌리고 잰 값을 돌려준다', async () => {
    const docker = await fakeDocker(`echo; echo '${OUTPUT}'; exit 0`);
    const sandbox = await new LocalDockerProvider({ dockerBin: docker.bin }).create(project);

    const result = await sandbox.runLoad!(request);
    expect(result).toMatchObject({ completed: 1000, statuses: { '201': 50, '409': 950 }, latency: { count: 950, p95: 30 } });

    const run = (await docker.calls()).find((call) => call.startsWith('run '))!;
    expect(run).toContain(`--network ${sandbox.id}_b-studio-sandbox`);
    expect(run).toContain('--pull never');
    expect(run).toContain(`--label b-studio.sandbox=${sandbox.id}`);
    expect(run).toMatch(new RegExp(`--name ${sandbox.id}-load-[0-9a-f]{8} `));
    // CPU 12개인 도커에서 동시 1,000건이면 스레드 4개, CPU도 4개
    expect(run).toContain('--cpus 4');
    expect(run).not.toMatch(/--volume|--mount| -v | -e |--env|--publish|--privileged/);
    expect(run.endsWith('node:22-bookworm-slim node --input-type=module -')).toBe(true);

    // 설정은 인자가 아니라 표준 입력으로 간다. 대상은 서비스 이름과 컨테이너 포트다
    const stdin = await docker.stdin();
    expect(run).not.toContain('orders');
    const config = JSON.parse(stdin.slice('globalThis.B_STUDIO_LOAD = '.length, stdin.indexOf(';\n'))) as Record<string, unknown>;
    expect(config).toMatchObject({ host: 'api', port: 8080, method: 'POST', path: '/orders/{{seq}}', body: '{"n":1}', concurrent: 1000, requests: 1000, latencyOf: [409], threads: 4 });
    expect(stdin).toContain("import { Worker } from 'node:worker_threads';");
  });

  it('CPU가 적은 도커에서는 스레드와 CPU를 줄인다', async () => {
    const docker = await fakeDocker(`echo '${OUTPUT.replace('"threads":4', '"threads":1')}'; exit 0`, { cpus: '2' });
    const sandbox = await new LocalDockerProvider({ dockerBin: docker.bin }).create(project);
    await sandbox.runLoad!(request);
    expect((await docker.calls()).find((call) => call.startsWith('run '))).toContain('--cpus 1');
  });

  it('서비스가 실행 중이 아니면 러너를 띄우지 않고 까닭을 알린다(플랫폼 문제가 아니다)', async () => {
    const docker = await fakeDocker(`echo '${OUTPUT}'; exit 0`, { state: 'exited' });
    const sandbox = await new LocalDockerProvider({ dockerBin: docker.bin }).create(project);

    const error = await caught(sandbox.runLoad!(request));
    expect(error).toBeInstanceOf(SandboxError);
    expect(error?.message).toContain("'api' 서비스가 실행 중이 아니어서 부하 확인을 돌릴 수 없습니다 (상태: exited)");
    expect(error?.platform).toBe(false);
    expect((await docker.calls()).some((call) => call.startsWith('run '))).toBe(false);
  });

  it('managed 서비스가 아니면 거절한다', async () => {
    const docker = await fakeDocker(`echo '${OUTPUT}'; exit 0`);
    const sandbox = await new LocalDockerProvider({ dockerBin: docker.bin }).create(project);
    const error = await caught(sandbox.runLoad!({ ...request, service: 'db' }));
    expect(error?.message).toContain("'db'은(는) 이 프로젝트의 managed 서비스가 아닙니다");
    expect((await docker.calls()).some((call) => call.startsWith('run '))).toBe(false);
  });

  it('러너가 0이 아닌 코드로 끝나면 플랫폼 쪽 오류로 알린다', async () => {
    const docker = await fakeDocker(`echo "Error response from daemon: network not found" >&2; exit 125`);
    const sandbox = await new LocalDockerProvider({ dockerBin: docker.bin }).create(project);
    const error = await caught(sandbox.runLoad!(request));
    expect(error?.platform).toBe(true);
    expect(error?.message).toContain('부하 러너를 실행하지 못했습니다 (종료 코드 125)');
    expect(error?.detail).toContain('network not found');
  });

  it('메모리 한도를 넘어 죽으면 그 사실을 알린다', async () => {
    const docker = await fakeDocker(`exit 137`);
    const sandbox = await new LocalDockerProvider({ dockerBin: docker.bin }).create(project);
    const error = await caught(sandbox.runLoad!(request));
    expect(error?.platform).toBe(true);
    expect(error?.detail).toBe('러너가 메모리 한도(512MB)를 넘어 종료됐습니다');
  });

  it.each([
    ['결과 줄이 없음', `exit 0`],
    ['결과가 JSON이 아님', `echo "done"; exit 0`],
    ['받은 응답 수가 맞지 않는 결과', `echo '${OUTPUT.replace('"completed":1000', '"completed":900')}'; exit 0`],
    ['요청 수가 요청한 것과 다른 결과', `echo '${OUTPUT.replace('"requests":1000', '"requests":10')}'; exit 0`],
  ])('%s이면 통과시킬 값으로 읽지 않고 플랫폼 쪽 오류로 알린다', async (_label, run) => {
    const docker = await fakeDocker(run);
    const sandbox = await new LocalDockerProvider({ dockerBin: docker.bin }).create(project);
    const error = await caught(sandbox.runLoad!(request));
    expect(error).toBeInstanceOf(SandboxError);
    expect(error?.platform).toBe(true);
    expect(error?.message).toContain('부하 러너의 결과를 읽지 못했습니다');
  });

  it('중단하면 이 실행이 만든 컨테이너를 이름으로 지우고 중단을 그대로 알린다', async () => {
    const docker = await fakeDocker(`sleep 30; exit 0`);
    const sandbox = await new LocalDockerProvider({ dockerBin: docker.bin }).create(project);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('사용자가 멈춤')), 300);

    const started = Date.now();
    const error = (await caught(sandbox.runLoad!(request, { signal: controller.signal }))) as unknown as Error;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(error.message).toBe('사용자가 멈춤');

    const calls = await docker.calls();
    const name = /--name (\S+)/.exec(calls.find((call) => call.startsWith('run '))!)![1];
    expect(calls).toContain(`rm --force ${name}`);
  });
});
