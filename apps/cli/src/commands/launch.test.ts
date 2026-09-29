import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isBStudio, LAUNCH_MODES, launchArgs, launchResultJson, MODE_ENV, runLaunch, studioOrigin, studioUrl, type ExecResult, type LaunchDeps, type ProbeResult } from './launch';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'launch-'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

interface Harness {
  deps: LaunchDeps;
  probes: string[];
  execs: Array<{ command: string; args: string[] }>;
  spawns: Array<{ command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; logPath: string }>;
  opens: string[];
}

function harness(options: { probe?: ProbeResult[]; exec?: ExecResult[]; platform?: NodeJS.Platform } = {}): Harness {
  const probes: string[] = [];
  const execs: Harness['execs'] = [];
  const spawns: Harness['spawns'] = [];
  const opens: string[] = [];
  const probeQueue = [...(options.probe ?? [])];
  const execQueue = [...(options.exec ?? [])];
  const deps: LaunchDeps = {
    platform: options.platform ?? 'darwin',
    env: { PATH: '/usr/bin:/bin', HOME: dir, B_STUDIO_BACKENDS: 'kept' },
    repoRoot: '/repo',
    paths: { log: path.join(dir, 'studio.log'), pid: path.join(dir, 'studio.pid') },
    probe: async (url) => {
      probes.push(url);
      return probeQueue.shift() ?? { reachable: false, body: '' };
    },
    sleep: async () => {},
    exec: async (command, args) => {
      execs.push({ command, args: [...args] });
      return execQueue.shift() ?? { code: 0, stdout: '', stderr: '' };
    },
    spawn: (command, args, spawnOptions) => {
      spawns.push({ command, args: [...args], ...spawnOptions });
      return { pid: 4242 };
    },
    open: async (url) => {
      opens.push(url);
    },
    readyTimeoutMs: 3,
    readyIntervalMs: 1,
  };
  return { deps, probes, execs, spawns, opens };
}

const OK: ExecResult = { code: 0, stdout: '', stderr: '' };
const FAIL: ExecResult = { code: 1, stdout: '', stderr: 'fail' };
const up: ProbeResult = { reachable: true, body: '<title>b-studio</title>' };
const down: ProbeResult = { reachable: false, body: '' };

describe('launch 유틸', () => {
  it('모드와 인자를 만든다', () => {
    expect(LAUNCH_MODES).toEqual(['local', 'demo', 'commandcode', 'codex']);
    expect(MODE_ENV).toEqual({ local: 'claude-code', demo: 'demo', commandcode: 'commandcode', codex: 'codex' });
    expect(studioUrl(3123)).toBe('http://127.0.0.1:3123/');
    expect(studioOrigin(3123)).toBe('http://127.0.0.1:3123');
    expect(launchArgs(3000)).toEqual(['--filter', '@b-studio/studio', 'exec', 'next', 'dev', '--hostname', '127.0.0.1', '-p', '3000']);
    expect(isBStudio('<title>b-studio</title>')).toBe(true);
    expect(isBStudio('<title>다른 앱</title>')).toBe(false);
  });

  it('launch JSON 한 줄의 모양을 고정한다 (Electron 앱이 기대는 계약)', () => {
    expect(launchResultJson({ url: 'http://127.0.0.1:3000', port: 3000, mode: 'claude-code', pid: 12345, started: true })).toBe(
      '{"url":"http://127.0.0.1:3000","port":3000,"mode":"claude-code","pid":12345,"started":true}',
    );
  });
});

describe('runLaunch --json', () => {
  it('새로 띄우면 브라우저를 열지 않고 stdout에 한 줄 JSON만, 진행 안내는 stderr로', async () => {
    const h = harness({ probe: [down, up], exec: [OK] });
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await runLaunch({ mode: 'local', port: 3000, open: true, json: true }, h.deps)).toBe(0);
    expect(h.opens).toEqual([]);
    expect(out.mock.calls).toHaveLength(1);
    expect(JSON.parse(out.mock.calls[0]![0] as string)).toEqual({ url: 'http://127.0.0.1:3000', port: 3000, mode: 'claude-code', pid: 4242, started: true });
    // 진행 안내(시작·종료 안내)는 stderr로 간다
    expect(err.mock.calls.length).toBeGreaterThan(0);
  });

  it('이미 떠 있으면 started=false와 PID 파일의 pid·모드를 쓴다', async () => {
    await writeFile(path.join(dir, 'studio.pid'), JSON.stringify({ pid: 999, port: 3000, mode: 'demo' }));
    const h = harness({ probe: [up] });
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await runLaunch({ mode: 'local', port: 3000, open: true, json: true }, h.deps)).toBe(0);
    expect(h.spawns).toEqual([]);
    expect(h.opens).toEqual([]);
    expect(JSON.parse(out.mock.calls[0]![0] as string)).toEqual({ url: 'http://127.0.0.1:3000', port: 3000, mode: 'demo', pid: 999, started: false });
  });

  it('준비되지 않으면 JSON을 쓰지 않고 종료 코드 1', async () => {
    const h = harness({ probe: [down], exec: [OK] });
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await runLaunch({ mode: 'local', port: 3000, open: true, json: true }, h.deps)).toBe(1);
    expect(out.mock.calls).toHaveLength(0);
  });
});

describe('runLaunch', () => {
  it('이미 스튜디오가 떠 있으면 새로 띄우지 않고 브라우저만 연다', async () => {
    const h = harness({ probe: [up] });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await runLaunch({ mode: 'local', port: 3000, open: true }, h.deps)).toBe(0);
    expect(h.spawns).toEqual([]);
    expect(h.opens).toEqual(['http://127.0.0.1:3000/']);
    expect(log.mock.calls.flat().join('\n')).toContain('이미 스튜디오가');
  });

  it('다른 프로그램이 그 포트에 있으면 다른 포트를 안내하고 종료 코드 1', async () => {
    const h = harness({ probe: [{ reachable: true, body: '<title>something else</title>' }] });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await runLaunch({ mode: 'local', port: 3000, open: true }, h.deps)).toBe(1);
    expect(h.spawns).toEqual([]);
    expect(h.opens).toEqual([]);
  });

  it('Docker가 꺼져 있고 colima도 없으면 켜지 않고 종료 코드 1', async () => {
    const h = harness({ probe: [down], exec: [FAIL, FAIL] });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await runLaunch({ mode: 'local', port: 3000, open: true }, h.deps)).toBe(1);
    expect(h.execs.map((entry) => entry.command)).toEqual(['docker', 'colima']); // colima start는 부르지 않는다
    expect(h.spawns).toEqual([]);
  });

  it('Docker가 꺼져 있고 colima가 있으면 colima start 후 띄우고, 모드·환경 변수를 넘긴다', async () => {
    const h = harness({ probe: [down, up], exec: [FAIL, OK, { code: 0, stdout: 'colima started', stderr: '' }] });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await runLaunch({ mode: 'local', port: 3123, open: true }, h.deps)).toBe(0);
    expect(h.execs.map((entry) => `${entry.command} ${entry.args.join(' ')}`)).toEqual(['docker info', 'colima version', 'colima start']);
    expect(h.spawns).toHaveLength(1);
    const spawn = h.spawns[0]!;
    expect(spawn.command).toBe('pnpm');
    expect(spawn.args).toEqual(launchArgs(3123));
    expect(spawn.cwd).toBe('/repo');
    expect(spawn.logPath).toBe(path.join(dir, 'studio.log'));
    // 모드는 B_STUDIO_MODE로, 사용자 환경 변수는 그대로 넘긴다
    expect(spawn.env.B_STUDIO_MODE).toBe('claude-code');
    expect(spawn.env.B_STUDIO_BACKENDS).toBe('kept');
    expect(h.opens).toEqual(['http://127.0.0.1:3123/']);
    // PID 파일에 pid·포트·모드를 남긴다
    expect(JSON.parse(await readFile(path.join(dir, 'studio.pid'), 'utf8'))).toEqual({ pid: 4242, port: 3123, mode: 'local' });
  });

  it('Docker가 켜져 있으면 colima를 건드리지 않는다', async () => {
    const h = harness({ probe: [down, up], exec: [OK] });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await runLaunch({ mode: 'demo', port: 3000, open: false }, h.deps)).toBe(0);
    expect(h.execs.map((entry) => entry.command)).toEqual(['docker']);
    expect(h.spawns[0]!.env.B_STUDIO_MODE).toBe('demo');
    // --no-open이면 브라우저를 열지 않는다
    expect(h.opens).toEqual([]);
  });

  it('준비되지 않으면 로그 끝을 보여 주고 종료 코드 1', async () => {
    await writeFile(path.join(dir, 'studio.log'), Array.from({ length: 25 }, (_, index) => `line ${index + 1}`).join('\n'));
    const h = harness({ probe: [down], exec: [OK] });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await runLaunch({ mode: 'codex', port: 3000, open: true }, h.deps)).toBe(1);
    const text = error.mock.calls.flat().join('\n');
    // 마지막 20줄만 보여 준다(line 6~25)
    expect(text).toContain('line 25');
    expect(text).not.toContain('line 5');
    expect(h.opens).toEqual([]);
  });
});
