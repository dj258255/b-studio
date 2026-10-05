import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runStop, type StopDeps } from './stop';

let dir: string;
let pidPath: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'stop-'));
  pidPath = path.join(dir, 'studio.pid');
});

function harness(over: Partial<StopDeps> = {}) {
  const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const deps: StopDeps = {
    platform: 'darwin',
    paths: { pid: pidPath },
    isAlive: () => true,
    killGroup: (pid, signal) => {
      killed.push({ pid, signal });
    },
    commandLine: async () => '',
    probe: async () => ({ reachable: false }),
    ...over,
  };
  return { deps, killed };
}

describe('runStop', () => {
  it('PID 파일이 없으면 떠 있는 스튜디오가 없다고 알린다', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { deps, killed } = harness();

    expect(await runStop(deps)).toBe(0);
    expect(killed).toEqual([]);
    expect(log.mock.calls.flat().join('\n')).toContain('떠 있는 스튜디오가 없습니다');
  });

  it('PID가 이미 죽었으면 파일만 지운다', async () => {
    await writeFile(pidPath, JSON.stringify({ pid: 111, port: 3000, mode: 'local' }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { deps, killed } = harness({ isAlive: () => false });

    expect(await runStop(deps)).toBe(0);
    expect(killed).toEqual([]);
    await expect(readFile(pidPath, 'utf8')).rejects.toThrow();
  });

  it('포트가 응답하면 프로세스 그룹을 SIGTERM으로 멈추고 파일을 지운다', async () => {
    await writeFile(pidPath, JSON.stringify({ pid: 222, port: 3123, mode: 'local' }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { deps, killed } = harness({ probe: async () => ({ reachable: true }) });

    expect(await runStop(deps)).toBe(0);
    expect(killed).toEqual([{ pid: 222, signal: 'SIGTERM' }]);
    await expect(readFile(pidPath, 'utf8')).rejects.toThrow();
  });

  it('포트가 응답하지 않아도 명령줄에 next가 있으면 멈춘다', async () => {
    await writeFile(pidPath, JSON.stringify({ pid: 333, port: 3000, mode: 'demo' }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { deps, killed } = harness({ commandLine: async () => 'node /repo/node_modules/.bin/next dev -p 3000' });

    expect(await runStop(deps)).toBe(0);
    expect(killed).toEqual([{ pid: 333, signal: 'SIGTERM' }]);
  });

  it('스튜디오가 아닌 것 같으면 죽이지 않고 파일만 지운다', async () => {
    await writeFile(pidPath, JSON.stringify({ pid: 444, port: 3000, mode: 'local' }));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { deps, killed } = harness({ commandLine: async () => 'python -m http.server' });

    expect(await runStop(deps)).toBe(0);
    expect(killed).toEqual([]);
    await expect(readFile(pidPath, 'utf8')).rejects.toThrow();
  });

  it('프로세스를 멈추지 못하면 종료 코드 1이고 파일을 남긴다', async () => {
    await writeFile(pidPath, JSON.stringify({ pid: 555, port: 3000, mode: 'local' }));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps } = harness({
      probe: async () => ({ reachable: true }),
      killGroup: () => {
        throw new Error('권한 없음');
      },
    });

    expect(await runStop(deps)).toBe(1);
    expect(await readFile(pidPath, 'utf8')).toContain('555');
  });

  it('PID 파일이 깨졌으면 지우고 끝낸다', async () => {
    await writeFile(pidPath, 'not json');
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { deps, killed } = harness();

    expect(await runStop(deps)).toBe(0);
    expect(killed).toEqual([]);
    await expect(readFile(pidPath, 'utf8')).rejects.toThrow();
  });
});

describe('runStop --json', () => {
  it('멈췄으면 stdout에 {"stopped":true} 한 줄만 쓰고 안내는 stderr로', async () => {
    await writeFile(pidPath, JSON.stringify({ pid: 222, port: 3123, mode: 'local' }));
    const { deps, killed } = harness({ probe: async () => ({ reachable: true }) });
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await runStop(deps, { json: true })).toBe(0);
    expect(killed).toEqual([{ pid: 222, signal: 'SIGTERM' }]);
    expect(out.mock.calls).toEqual([['{"stopped":true}']]);
    expect(err.mock.calls.flat().join('\n')).toContain('멈췄습니다');
  });

  it('멈출 게 없으면 {"stopped":false}', async () => {
    const { deps } = harness();
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await runStop(deps, { json: true })).toBe(0);
    expect(out.mock.calls).toEqual([['{"stopped":false}']]);
  });

  it('멈추지 못하면 {"stopped":false}를 쓰고 종료 코드 1', async () => {
    await writeFile(pidPath, JSON.stringify({ pid: 333, port: 3123, mode: 'local' }));
    const { deps } = harness({
      probe: async () => ({ reachable: true }),
      killGroup: () => {
        throw new Error('권한 없음');
      },
    });
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await runStop(deps, { json: true })).toBe(1);
    expect(out.mock.calls).toEqual([['{"stopped":false}']]);
  });
});
