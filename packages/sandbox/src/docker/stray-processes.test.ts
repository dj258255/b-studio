import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ExecResult } from '../types';
import { foreignProcesses, parseProcessScan, scanProcesses, PROCESS_SCAN_SCRIPT } from './stray-processes';

// 이 스크립트를 호스트의 진짜 /proc에 돌리지 않는다(찾기만 하지만 남의 프로세스 목록이 나온다). 호스트에서는 가짜 /proc(SCAN_PROC)만 쓴다
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** 가짜 /proc. stat은 "pid (이름) 상태 ppid pgrp session ... starttime(22번째)" 꼴이다 */
async function fakeProc(processes: Array<{ pid: number; sid: number; start?: number; state?: string; name?: string; cmdline?: string[] }>): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'scan-proc-'));
  roots.push(root);
  for (const p of processes) {
    await mkdir(path.join(root, String(p.pid)));
    // 4번째 뒤로 starttime(22번째 필드)까지 채운다. 이름에 괄호·빈칸이 있어도 마지막 ") " 뒤를 읽어야 한다
    const rest = [p.state ?? 'S', 1, p.sid, p.sid, 0, -1, 4194560, 0, 0, 0, 0, 0, 0, 0, 0, 20, 0, 1, 0, p.start ?? 1000, 1000, 100];
    await writeFile(path.join(root, String(p.pid), 'stat'), `${p.pid} (${p.name ?? 'sh'}) ${rest.join(' ')}\n`);
    await writeFile(path.join(root, String(p.pid), 'cmdline'), (p.cmdline ?? ['sh']).map((part) => `${part}\0`).join(''));
  }
  return root;
}

function scan(proc: string, self: number): string {
  return execFileSync('sh', ['-c', PROCESS_SCAN_SCRIPT], { encoding: 'utf8', env: { ...process.env, SCAN_PROC: proc, SCAN_SELF: String(self) } });
}

describe('PID 1과 세션이 다른 프로세스 찾기(#765)', () => {
  it('docker exec로 들어와 PID 1 밑으로 옮겨진 백그라운드 프로세스와 그 시작 시각을 찾는다', async () => {
    const proc = await fakeProc([
      { pid: 1, sid: 1, cmdline: ['/sbin/docker-init', '--', 'pnpm', 'dev'] },
      { pid: 7, sid: 1, cmdline: ['node', 'next', 'dev'] },
      { pid: 15, sid: 9, start: 5000, cmdline: ['sh', '-c', 'while true; do cp b a; sleep 1; cp a0 a; done'] },
      { pid: 26, sid: 9, start: 5100, name: 'sleep', cmdline: ['sleep', '1'] },
    ]);
    expect(parseProcessScan(scan(proc, 40))).toEqual([
      { pid: 15, start: '5000', command: 'sh -c while true; do cp b a; sleep 1; cp a0 a; done' },
      { pid: 26, start: '5100', command: 'sleep 1' },
    ]);
  });

  it('자기 세션(찾는 스크립트)과 좀비, PID 1의 세션은 빼고, 이름에 괄호와 빈칸이 있어도 세션을 바로 읽는다', async () => {
    const proc = await fakeProc([
      { pid: 1, sid: 1 },
      { pid: 7, sid: 1, name: 'java (main) x', cmdline: ['java', '-jar', 'app.jar'] },
      { pid: 40, sid: 40, cmdline: ['sh', '-c', 'scan'] },
      { pid: 41, sid: 40, cmdline: ['sed'] },
      { pid: 50, sid: 50, state: 'Z' },
    ]);
    expect(parseProcessScan(scan(proc, 40))).toEqual([]);
  });

  it('PID 1을 읽지 못하면 실패로 끝난다(찾은 것이 없다고 하지 않는다)', async () => {
    const proc = await fakeProc([{ pid: 15, sid: 9 }]);
    const result = spawnSync('sh', ['-c', PROCESS_SCAN_SCRIPT], { encoding: 'utf8', env: { ...process.env, SCAN_PROC: proc, SCAN_SELF: '40' } });
    expect(result.status).not.toBe(0);
  });
});

describe('foreignProcesses', () => {
  const gradle = { pid: 38, start: '900', command: 'java -jar app.jar' };
  const loop = { pid: 15, start: '5000', command: 'sh -c loop' };

  it('서비스가 준비될 때 이미 있던 것(Gradle이 다른 세션으로 띄운 서버)은 빼고 그 뒤에 생긴 것만 남긴다', () => {
    expect(foreignProcesses([gradle, loop], [gradle])).toEqual([loop]);
  });

  it('pid가 같아도 시작 시각이 다르면 다른 프로세스다(pid를 다시 쓴 것)', () => {
    expect(foreignProcesses([{ ...gradle, start: '6000' }], [gradle])).toEqual([{ ...gradle, start: '6000' }]);
  });

  it('기준선이 없으면(스튜디오를 다시 띄운 뒤) 모두 남긴다', () => {
    expect(foreignProcesses([gradle], undefined)).toEqual([gradle]);
  });
});

describe('scanProcesses', () => {
  it('셸이 없는 이미지(distroless)에서는 확인하지 못했다는 까닭을 돌려준다', async () => {
    const exec = async (): Promise<ExecResult> => ({ exitCode: 127, stdout: '', stderr: 'OCI runtime exec failed: exec: "sh": executable file not found in $PATH' });
    expect(await scanProcesses(exec)).toEqual({ error: 'sh가 없어 서비스 안의 프로세스를 확인하지 못했습니다' });
  });

  it('다른 까닭으로 실패하면 그 까닭을 돌려준다', async () => {
    const exec = async (): Promise<ExecResult> => ({ exitCode: 1, stdout: '', stderr: 'no /proc/1/stat' });
    expect(await scanProcesses(exec)).toEqual({ error: '서비스 안의 프로세스를 읽지 못했습니다: no /proc/1/stat' });
  });

  it('스크립트를 sh -c로 넘긴다', async () => {
    const calls: string[][] = [];
    const exec = async (command: string[]): Promise<ExecResult> => {
      calls.push(command);
      return { exitCode: 0, stdout: '15 5000 sh -c loop\n', stderr: '' };
    };
    expect(await scanProcesses(exec)).toEqual({ processes: [{ pid: 15, start: '5000', command: 'sh -c loop' }] });
    expect(calls).toEqual([['sh', '-c', PROCESS_SCAN_SCRIPT]]);
  });
});

const docker = spawnSync('docker', ['info'], { stdio: 'ignore', timeout: 10_000 }).status === 0;

describe.skipIf(!docker)('실제 컨테이너에서(busybox:1.37)', () => {
  const name = `b-studio-scan-test-${process.pid}-${Date.now()}`;
  afterEach(() => {
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  });

  const execIn = async (command: string[]): Promise<ExecResult> => {
    const result = spawnSync('docker', ['exec', name, ...command], { encoding: 'utf8' });
    return { exitCode: result.status ?? 1, stdout: result.stdout, stderr: result.stderr };
  };

  it('준비 뒤 exec로 남긴 프로세스(setsid로 세션을 새로 만든 것까지)만 찾고, 서비스가 다른 세션으로 띄운 서버는 기준선으로 뺀다', async () => {
    // Gradle처럼 서비스 본 프로세스가 서버를 새 세션(setsid)으로 띄운다. 이것은 b-studio가 모르는 프로세스가 아니다
    execFileSync('docker', ['run', '-d', '--init', '--name', name, 'busybox:1.37', 'sh', '-c', 'setsid sleep 3601 & sleep 3600 & wait'], { stdio: 'ignore' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const ready = await scanProcesses(execIn);
    expect(ready.processes?.map((p) => p.command)).toEqual(['sleep 3601']);

    // 에이전트가 run_in_service로 남긴 것 흉내: 검사 동안 B로 바꿨다가 A로 되돌린다. setsid로 세션을 새로 만들어도 PID 1의 세션으로 돌아갈 수는 없다
    execFileSync('docker', ['exec', name, 'sh', '-c', 'nohup sh -c "while true; do echo B > /tmp/a; sleep 0.2; echo A > /tmp/a; sleep 0.2; done" >/dev/null 2>&1 &'], { stdio: 'ignore' });
    execFileSync('docker', ['exec', name, 'sh', '-c', 'setsid sh -c "while true; do sleep 0.3; done" >/dev/null 2>&1 &'], { stdio: 'ignore' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const later = await scanProcesses(execIn);
    const foreign = foreignProcesses(later.processes ?? [], ready.processes);
    expect(foreign.map((p) => p.command).filter((command) => command.includes('while true'))).toHaveLength(2);
    expect(foreign.map((p) => p.command)).not.toContain('sleep 3601');
  }, 60_000);
});
