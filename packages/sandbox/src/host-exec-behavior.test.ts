import { chmod, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LoadedProject } from '@b-studio/spec';
import { loadDependsOn } from './docker/compose-deps';
import { LocalDockerProvider } from './docker/compose-provider';
import { pruneSandboxLeftovers } from './docker/prune';
import { removeAgentContainer, pauseAgentContainer, ensureAgentContainer, openAgentTerminal } from './docker/agent-terminal';
import { SandboxError } from './errors';
import { listProcesses, probeHostGateway } from './host-terminal';

/**
 * 호스트 프로세스를 부르는 자리(ADR-193 2c-7)의 실패 동작을 고정한다. Node `execFile`에서 Rust `runCommand`로 옮겨도
 * 던지던 자리는 던지고 삼키던 자리는 삼켜야 한다. 가짜 실행 파일은 부른 인자와 작업 폴더를 파일에 남긴다.
 */
async function fakeBin(script: string): Promise<{ dir: string; bin: string; calls: () => Promise<string[]>; cwds: () => Promise<string[]> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'fake-exec-'));
  const bin = path.join(dir, 'docker');
  const log = path.join(dir, 'calls.log');
  const cwdLog = path.join(dir, 'cwd.log');
  await writeFile(bin, `#!/bin/sh\necho "$*" >> "${log}"\npwd -P >> "${cwdLog}"\n${script}\n`);
  await chmod(bin, 0o755);
  const lines = async (file: string) => (await readFile(file, 'utf8').catch(() => '')).split('\n').filter(Boolean);
  return { dir, bin, calls: () => lines(log), cwds: () => lines(cwdLog) };
}

const RM = /^(rm |image rm |volume rm |network rm )/;

describe('지우기 전의 목록 조회가 실패하면 빈 목록으로 읽지 않는다', () => {
  // 어느 목록이 실패해도 던지고, 아무것도 지우지 않는다(실패한 조회를 "쓰는 것이 없다"로 읽어 지우면 안 된다)
  const lists: Array<{ name: string; failWhen: string }> = [
    { name: '실행 중인 프로젝트(ps)', failWhen: '[ "$1" = ps ] && [ "$2" = --format ]' },
    { name: '컨테이너 목록(ps -a)', failWhen: '[ "$1" = ps ] && [ "$2" = -a ]' },
    { name: '이미지 목록', failWhen: '[ "$1" = image ] && [ "$2" = ls ]' },
    { name: '볼륨 목록', failWhen: '[ "$1" = volume ] && [ "$2" = ls ]' },
    { name: '네트워크 목록', failWhen: '[ "$1" = network ] && [ "$2" = ls ]' },
  ];
  it.each(lists.map(({ name, failWhen }) => [name, failWhen] as const))('%s이 실패하면 던지고 rm을 한 번도 부르지 않는다', async (_name, failWhen) => {
    const docker = await fakeBin(`
if ${failWhen}; then echo "Cannot connect to the Docker daemon" >&2; exit 1; fi
case "$1 $2" in
  "ps -a") echo "studio-orders-1a2b3c-api-1	studio-orders-1a2b3c" ;;
  "image ls") echo "studio-orders-1a2b3c-api:latest" ;;
  "volume ls") echo "studio-orders-1a2b3c_db	studio-orders-1a2b3c	" ;;
  "network ls") echo "studio-orders-1a2b3c_default	studio-orders-1a2b3c" ;;
esac
exit 0`);
    await expect(pruneSandboxLeftovers({ dockerBin: docker.bin })).rejects.toThrow();
    expect((await docker.calls()).filter((call) => RM.test(call))).toEqual([]);
  });

  it('이 샌드박스의 이미지 목록을 읽지 못하면 cleanup이 던지고 image rm을 부르지 않는다', async () => {
    const docker = await fakeBin('if [ "$1" = image ] && [ "$2" = ls ]; then echo "daemon down" >&2; exit 1; fi\nexit 0');
    await expect(new LocalDockerProvider({ dockerBin: docker.bin }).cleanup('studio-orders-1a2b3c')).rejects.toThrow(SandboxError);
    expect((await docker.calls()).some((call) => call.startsWith('image rm'))).toBe(false);
  });

  it('compose down이 실패하면 cleanup이 던지고 이미지 목록을 묻지 않는다', async () => {
    const docker = await fakeBin('if [ "$1" = compose ]; then echo "down failed" >&2; exit 1; fi\nexit 0');
    await expect(new LocalDockerProvider({ dockerBin: docker.bin }).cleanup('studio-orders-1a2b3c')).rejects.toThrow('정리하지 못했습니다');
    expect((await docker.calls()).some((call) => call.startsWith('image '))).toBe(false);
  });

  it('이미지를 지우다 실패하면 cleanup이 던진다', async () => {
    const docker = await fakeBin('if [ "$1" = image ] && [ "$2" = rm ]; then echo "in use" >&2; exit 1; fi\nif [ "$1" = image ]; then echo "studio-orders-1a2b3c-api:latest"; fi\nexit 0');
    await expect(new LocalDockerProvider({ dockerBin: docker.bin }).cleanup('studio-orders-1a2b3c')).rejects.toThrow('정리하지 못했습니다');
  });
});

describe('작업 폴더', () => {
  it('prune·agent 명령은 임시 폴더에서 돈다(작업 폴더의 compose 파일을 읽지 않게)', async () => {
    const docker = await fakeBin('exit 0');
    await pruneSandboxLeftovers({ dockerBin: docker.bin });
    await removeAgentContainer('sb', { dockerBin: docker.bin });
    const expected = await realpath(tmpdir());
    const cwds = await docker.cwds();
    expect(cwds.length).toBeGreaterThan(4);
    expect(new Set(cwds)).toEqual(new Set([expected]));
  });
});

describe('agent-terminal의 호스트 쪽 docker', () => {
  it('removeAgentContainer는 실패해도 삼킨다', async () => {
    const docker = await fakeBin('echo "no such container" >&2; exit 1');
    await expect(removeAgentContainer('sb', { dockerBin: docker.bin })).resolves.toBeUndefined();
    await expect(removeAgentContainer('sb', { dockerBin: path.join(docker.dir, 'no-such-docker') })).resolves.toBeUndefined();
  });

  it('pause는 실패 이유(stderr 끝 3줄)를 담아 던진다', async () => {
    const docker = await fakeBin('echo "a" >&2; echo "b" >&2; echo "c" >&2; echo "d" >&2; exit 1');
    const error = await pauseAgentContainer('sb', { dockerBin: docker.bin }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SandboxError);
    expect((error as SandboxError).message).toContain('멈추지 못했습니다');
    expect(JSON.stringify(error)).not.toContain('"a"');
  });

  it('resize는 실패해도 삼킨다', async () => {
    const docker = await fakeBin('exit 1');
    const child = Object.assign(new (await import('node:events')).EventEmitter(), {
      stdin: Object.assign(new (await import('node:events')).EventEmitter(), { writable: true, write() {}, end() {} }),
      stdout: new (await import('node:events')).EventEmitter(),
      stderr: new (await import('node:events')).EventEmitter(),
      kill() {},
    });
    const terminal = openAgentTerminal('sb-agent', { id: 't1', size: { cols: 80, rows: 24 }, dockerBin: docker.bin, spawnProcess: () => child as never });
    await expect(terminal.resize({ cols: 100, rows: 30 })).resolves.toBeUndefined();
    expect((await docker.calls()).some((call) => call.startsWith('exec'))).toBe(true);
  });

  it('inspect가 실패하면 컨테이너가 없는 것으로 보고 새로 띄운다(run도 실패하면 던진다)', async () => {
    const docker = await fakeBin('echo "boom" >&2; exit 1');
    const root = await mkdtemp(path.join(tmpdir(), 'agent-root-'));
    await expect(ensureAgentContainer('sb', root, { projectId: 'p', dockerBin: docker.bin })).rejects.toThrow('에이전트 컨테이너를 띄우지 못했습니다');
    const calls = await docker.calls();
    expect(calls[0]).toMatch(/^inspect /);
    expect(calls.some((call) => call.startsWith('run '))).toBe(true);
  });
});

describe('compose 설정 읽기와 docker info', () => {
  const project = { root: '/tmp/orders', composePath: '/tmp/orders/compose.yaml' } as unknown as LoadedProject;

  it('loadDependsOn은 docker가 실패하면 stderr를 가려 SandboxError로 던진다', async () => {
    const docker = await fakeBin('echo "secret-token-123 failed" >&2; exit 1');
    const error = await loadDependsOn(project, { dockerBin: docker.bin, redact: (text) => text.replace('secret-token-123', '***') }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SandboxError);
    expect(JSON.stringify(error)).toContain('***');
    expect(JSON.stringify(error)).not.toContain('secret-token-123');
  });

  it('loadDependsOn은 docker 실행 파일이 없어도 SandboxError로 던진다', async () => {
    const docker = await fakeBin('exit 0');
    await expect(loadDependsOn(project, { dockerBin: path.join(docker.dir, 'no-such-docker') })).rejects.toThrow(SandboxError);
  });

  it('loadDependsOn은 JSON이 아니면 해석 실패로 던지고, 환경 변수를 그대로 넘긴다', async () => {
    const docker = await fakeBin('echo "$BSTUDIO_PROBE_ENV"');
    await expect(loadDependsOn(project, { dockerBin: docker.bin, env: { BSTUDIO_PROBE_ENV: 'x', PATH: process.env.PATH } })).rejects.toThrow('해석하지 못해');
    const ok = await fakeBin('echo \'{"services":{"a":{"depends_on":["b"]}}}\'');
    await expect(loadDependsOn(project, { dockerBin: ok.bin })).resolves.toEqual({ a: { b: { condition: 'service_started' } } });
  });

  it('docker info가 실패하면 샌드박스를 만들기 전에 던진다', async () => {
    const docker = await fakeBin('echo "daemon down" >&2; exit 1');
    const fakeProject = { spec: { name: 'orders' }, root: '/tmp/orders', composePath: '/tmp/orders/compose.yaml', managed: [], composeServices: [] } as unknown as LoadedProject;
    await expect(new LocalDockerProvider({ dockerBin: docker.bin, runtime: 'runsc' }).create(fakeProject)).rejects.toThrow('Docker 데몬 정보를 읽지 못해');
  });
});

describe('호스트 터미널의 호스트 프로세스', () => {
  const original = process.env.PATH;
  afterEach(() => {
    process.env.PATH = original;
  });

  it('listProcesses는 ps가 실패하면 던진다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'fake-ps-'));
    await writeFile(path.join(dir, 'ps'), '#!/bin/sh\necho "ps broken" >&2\nexit 1\n');
    await chmod(path.join(dir, 'ps'), 0o755);
    process.env.PATH = dir;
    await expect(listProcesses()).rejects.toThrow();
  });

  it('probeHostGateway는 스크립트가 0으로 끝나야 참이고, 표준 입력을 닫아 준다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'probe-gw-'));
    await writeFile(path.join(dir, 'b-studio-hook.mjs'), `process.stdin.resume(); process.stdin.on('end', () => process.exit(process.argv[2] === 'ping' ? 0 : 1));\n`);
    expect(await probeHostGateway(dir)).toBe(true);
    await writeFile(path.join(dir, 'b-studio-hook.mjs'), 'process.exit(3);\n');
    expect(await probeHostGateway(dir)).toBe(false);
    expect(await probeHostGateway(dir, '/definitely/not/node')).toBe(false);
  });
});
