import { closeSync } from 'node:fs';
import { chmod, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HEALTH_PATH, isBStudio, isBStudioHealth, LAUNCH_MODES, launchArgs, launchResultJson, MODE_ENV, openLaunchLog, runLaunch, studioOrigin, studioUrl, type ExecResult, type LaunchDeps, type ProbeResult } from './launch';

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
  killed: Array<{ pid: number; signal: NodeJS.Signals }>;
  markerWrites: string[];
}

function harness(
  options: {
    probe?: ProbeResult[];
    exec?: ExecResult[];
    platform?: NodeJS.Platform;
    alivePids?: number[];
    /** 지금 pnpm-lock.yaml 해시. 생략하면 undefined(실제 저장소가 아닌 테스트에서는 의존성 확인을 건너뛴다) */
    lockHash?: string;
    /** 마지막 설치 표지에 적혀 있던 해시 */
    installMarker?: string;
    /** 로컬 토큰 파일에 적혀 있다고 볼 값. 생략하면 undefined(옛 서버) */
    localToken?: string;
  } = {},
): Harness {
  const probes: string[] = [];
  const execs: Harness['execs'] = [];
  const spawns: Harness['spawns'] = [];
  const opens: string[] = [];
  const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
  const markerWrites: string[] = [];
  const alive = new Set(options.alivePids ?? []);
  const probeQueue = [...(options.probe ?? [])];
  const execQueue = [...(options.exec ?? [])];
  const deps: LaunchDeps = {
    platform: options.platform ?? 'darwin',
    env: { PATH: '/usr/bin:/bin', HOME: dir, B_STUDIO_BACKENDS: 'kept' },
    repoRoot: '/repo',
    paths: { log: path.join(dir, 'studio.log'), pid: path.join(dir, 'studio.pid') },
    probe: async (url) => {
      probes.push(url);
      return probeQueue.shift() ?? { reachable: false, status: 0, body: '' };
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
    readLocalToken: async () => options.localToken,
    isAlive: (pid) => alive.has(pid),
    killGroup: (pid, signal) => {
      alive.delete(pid);
      killed.push({ pid, signal });
    },
    lockfileHash: async () => options.lockHash,
    readInstallMarker: async () => options.installMarker,
    writeInstallMarker: async (hash) => {
      markerWrites.push(hash);
    },
    readyTimeoutMs: 3,
    readyIntervalMs: 1,
  };
  return { deps, probes, execs, spawns, opens, killed, markerWrites };
}

const OK: ExecResult = { code: 0, stdout: '', stderr: '' };
const FAIL: ExecResult = { code: 1, stdout: '', stderr: 'fail' };
const up: ProbeResult = { reachable: true, status: 200, body: '<title>b-studio</title>' };
/** 새 서버의 /api/health: b-studio 표지를 싣는다 */
const health: ProbeResult = { reachable: true, status: 200, body: '{"status":"ok","app":"b-studio","terminal":true}' };
/** 옛 서버의 /api/health: 표지가 없다 */
const oldHealth: ProbeResult = { reachable: true, status: 200, body: '{"status":"ok"}' };
const upOther: ProbeResult = { reachable: true, status: 200, body: '<title>something else</title>' };
/** 최상위 라우트는 응답하지만(reachable) 중첩 라우트 표가 스테일해 404를 돌려주는 상태 */
const stale: ProbeResult = { reachable: true, status: 404, body: '<!doctype html>Not Found' };
const nestedOk: ProbeResult = { reachable: true, status: 200, body: '{"ok":true}' };
const down: ProbeResult = { reachable: false, status: 0, body: '' };

describe('launch 유틸', () => {
  it('모드와 인자를 만든다', () => {
    expect(LAUNCH_MODES).toEqual(['local', 'demo', 'commandcode', 'codex']);
    expect(MODE_ENV).toEqual({ local: 'claude-code', demo: 'demo', commandcode: 'commandcode', codex: 'codex' });
    expect(studioUrl(3123)).toBe('http://127.0.0.1:3123/');
    expect(studioOrigin(3123)).toBe('http://127.0.0.1:3123');
    expect(launchArgs(3000)).toEqual(['--filter', '@b-studio/studio', 'exec', 'next', 'dev', '--hostname', '127.0.0.1', '-p', '3000']);
    expect(isBStudio('<title>b-studio</title>')).toBe(true);
    expect(isBStudio('<title>다른 앱</title>')).toBe(false);
    expect(HEALTH_PATH).toBe('/api/health');
    expect(isBStudioHealth('{"status":"ok","app":"b-studio"}')).toBe(true);
    expect(isBStudioHealth('{"status":"ok"}')).toBe(false);
    expect(isBStudioHealth('<title>b-studio</title>')).toBe(false);
    expect(isBStudioHealth('')).toBe(false);
  });

  it('launch JSON 한 줄의 모양을 고정한다 (Electron 앱이 기대는 계약)', () => {
    expect(launchResultJson({ url: 'http://127.0.0.1:3000', openUrl: 'http://127.0.0.1:3000/local-auth#abc', port: 3000, mode: 'claude-code', pid: 12345, started: true })).toBe(
      '{"url":"http://127.0.0.1:3000","openUrl":"http://127.0.0.1:3000/local-auth#abc","port":3000,"mode":"claude-code","pid":12345,"started":true}',
    );
  });

  it('로그 파일은 이 사용자만 읽게(0600) 만들고, 이미 있으면 열 때 권한을 조인다', async () => {
    // 이미 넓은 권한으로 만들어진 파일(옛 방식)
    const existing = path.join(dir, 'studio.log');
    await writeFile(existing, '이전 내용\n');
    await chmod(existing, 0o644);
    closeSync(openLaunchLog(existing));
    expect((await stat(existing)).mode & 0o777).toBe(0o600);

    // 새로 만드는 파일
    const fresh = path.join(dir, 'fresh.log');
    closeSync(openLaunchLog(fresh));
    expect((await stat(fresh)).mode & 0o777).toBe(0o600);
  });
});

describe('runLaunch --json', () => {
  it('새로 띄우면 브라우저를 열지 않고 stdout에 한 줄 JSON만, 진행 안내는 stderr로', async () => {
    const h = harness({ probe: [down, health], exec: [OK] });
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await runLaunch({ mode: 'local', port: 3000, open: true, json: true }, h.deps)).toBe(0);
    expect(h.opens).toEqual([]);
    expect(out.mock.calls).toHaveLength(1);
    expect(JSON.parse(out.mock.calls[0]![0] as string)).toEqual({ url: 'http://127.0.0.1:3000', openUrl: 'http://127.0.0.1:3000/', port: 3000, mode: 'claude-code', pid: 4242, started: true });
    // 진행 안내(시작·종료 안내)는 stderr로 간다
    expect(err.mock.calls.length).toBeGreaterThan(0);
  });

  it('이미 떠 있으면 started=false와 PID 파일의 pid·모드를 쓴다', async () => {
    await writeFile(path.join(dir, 'studio.pid'), JSON.stringify({ pid: 999, port: 3000, mode: 'demo' }));
    const h = harness({ probe: [health, nestedOk] });
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await runLaunch({ mode: 'local', port: 3000, open: true, json: true }, h.deps)).toBe(0);
    expect(h.spawns).toEqual([]);
    expect(h.opens).toEqual([]);
    expect(JSON.parse(out.mock.calls[0]![0] as string)).toEqual({ url: 'http://127.0.0.1:3000', openUrl: 'http://127.0.0.1:3000/', port: 3000, mode: 'demo', pid: 999, started: false });
  });

  it('토큰 파일이 있으면 openUrl이 교환 페이지 주소(토큰은 # 뒤)이고, 브라우저를 그 주소로 연다', async () => {
    const token = 'c'.repeat(64);
    const expected = `http://127.0.0.1:3000/local-auth#${token}`;
    const h = harness({ probe: [health, nestedOk], localToken: token });
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await runLaunch({ mode: 'local', port: 3000, open: true, json: true }, h.deps)).toBe(0);
    const openUrl = JSON.parse(out.mock.calls[0]![0] as string).openUrl as string;
    expect(openUrl).toBe(expected);
    // 토큰을 쿼리에 싣지 않는다(개발 서버 로그에 남는다). # 뒤에만 싣는다
    expect(openUrl).toContain('#');
    expect(openUrl).not.toContain('?token=');

    const human = harness({ probe: [health, nestedOk], localToken: token });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runLaunch({ mode: 'local', port: 3000, open: true }, human.deps)).toBe(0);
    expect(human.opens).toEqual([expected]);
  });

  it('토큰 파일이 없으면(옛 서버) 토큰 없는 주소를 열고, 다시 띄우라고 알린다', async () => {
    const h = harness({ probe: [health, nestedOk] });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await runLaunch({ mode: 'local', port: 3000, open: true }, h.deps)).toBe(0);
    expect(h.opens).toEqual(['http://127.0.0.1:3000/']);
    expect(log.mock.calls.flat().join('\n')).toContain('터미널을 쓰려면 스튜디오를 다시 띄우세요');
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
    const h = harness({ probe: [health, nestedOk] });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await runLaunch({ mode: 'local', port: 3000, open: true }, h.deps)).toBe(0);
    expect(h.spawns).toEqual([]);
    expect(h.opens).toEqual(['http://127.0.0.1:3000/']);
    expect(log.mock.calls.flat().join('\n')).toContain('이미 스튜디오가');
  });

  it('다른 프로그램이 그 포트에 있으면 다른 포트를 안내하고 종료 코드 1', async () => {
    const h = harness({ probe: [upOther, upOther] });
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
    const h = harness({ probe: [down, health], exec: [FAIL, OK, { code: 0, stdout: 'colima started', stderr: '' }] });
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
    const h = harness({ probe: [down, health], exec: [OK] });
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

describe('runLaunch: 의존성(pnpm-lock.yaml이 바뀌면 띄우기 전에 pnpm install)', () => {
  it('지금 해시가 마지막 설치 표지와 다르면 pnpm install을 먼저 하고 표지를 갱신한다', async () => {
    const h = harness({ probe: [down, health], exec: [OK, { code: 0, stdout: 'installed', stderr: '' }], lockHash: 'abc', installMarker: 'old' });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await runLaunch({ mode: 'local', port: 3000, open: false }, h.deps)).toBe(0);
    expect(h.execs.map((entry) => `${entry.command} ${entry.args.join(' ')}`)).toEqual(['docker info', 'pnpm install --frozen-lockfile --prefer-offline']);
    expect(h.markerWrites).toEqual(['abc']);
    expect(h.spawns).toHaveLength(1);
  });

  it('표지에 적힌 적이 없어도(첫 설치) pnpm install을 한다', async () => {
    const h = harness({ probe: [down, health], exec: [OK, OK], lockHash: 'abc' });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await runLaunch({ mode: 'local', port: 3000, open: false }, h.deps)).toBe(0);
    expect(h.execs.map((entry) => entry.command)).toEqual(['docker', 'pnpm']);
    expect(h.markerWrites).toEqual(['abc']);
  });

  it('지금 해시가 표지와 같으면 설치를 건너뛴다', async () => {
    const h = harness({ probe: [down, health], exec: [OK], lockHash: 'abc', installMarker: 'abc' });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await runLaunch({ mode: 'local', port: 3000, open: false }, h.deps)).toBe(0);
    expect(h.execs.map((entry) => entry.command)).toEqual(['docker']);
    expect(h.markerWrites).toEqual([]);
    expect(h.spawns).toHaveLength(1);
  });

  it('pnpm-lock.yaml 해시를 읽지 못하면(테스트의 가짜 저장소 등) 의존성 확인을 건너뛴다', async () => {
    const h = harness({ probe: [down, health], exec: [OK] });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await runLaunch({ mode: 'local', port: 3000, open: false }, h.deps)).toBe(0);
    expect(h.execs.map((entry) => entry.command)).toEqual(['docker']);
    expect(h.markerWrites).toEqual([]);
  });

  it('pnpm install이 실패하면 서버를 띄우지 않고 종료 코드 1', async () => {
    const h = harness({ probe: [down], exec: [OK, { code: 1, stdout: '', stderr: 'network error' }], lockHash: 'abc', installMarker: 'old' });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await runLaunch({ mode: 'local', port: 3000, open: false }, h.deps)).toBe(1);
    expect(h.spawns).toEqual([]);
    expect(h.markerWrites).toEqual([]);
    expect(error.mock.calls.flat().join('\n')).toContain('pnpm install이 실패했습니다');
  });
});

describe('runLaunch: 스테일한 중첩 라우트(데스크톱 셸이 오래된 라우트 표를 잡아내는 확인)', () => {
  it('최상위 라우트는 응답하지만 중첩 라우트가 스테일하면 기존 서버를 죽이고 새로 띄운다', async () => {
    await writeFile(path.join(dir, 'studio.pid'), JSON.stringify({ pid: 555, port: 3000, mode: 'demo' }));
    const h = harness({ probe: [health, stale, health], exec: [OK], alivePids: [555] });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await runLaunch({ mode: 'local', port: 3000, open: false }, h.deps)).toBe(0);
    // 헬스(/api/health)와 중첩 라우트(/api/health/routes)를 둘 다 확인한다
    expect(h.probes[0]).toBe('http://127.0.0.1:3000/api/health');
    expect(h.probes[1]).toBe('http://127.0.0.1:3000/api/health/routes');
    // 스테일한 기존 프로세스(PID 555)에 SIGTERM을 보내고
    expect(h.killed).toEqual([{ pid: 555, signal: 'SIGTERM' }]);
    // 새로 띄운다(재사용하지 않는다)
    expect(h.spawns).toHaveLength(1);
    expect(log.mock.calls.flat().join('\n')).toContain('라우트 표가 오래된 것 같아');
    expect(JSON.parse(await readFile(path.join(dir, 'studio.pid'), 'utf8'))).toEqual({ pid: 4242, port: 3000, mode: 'local' });
  });

  it('스테일한 서버가 이미 죽어 있으면 죽이지 않고 바로 새로 띄운다', async () => {
    await writeFile(path.join(dir, 'studio.pid'), JSON.stringify({ pid: 555, port: 3000, mode: 'demo' }));
    // alivePids를 주지 않으면 isAlive(555)는 항상 false다
    const h = harness({ probe: [health, stale, health], exec: [OK] });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await runLaunch({ mode: 'local', port: 3000, open: false }, h.deps)).toBe(0);
    expect(h.killed).toEqual([]);
    expect(h.spawns).toHaveLength(1);
  });
});

describe('runLaunch: 떠 있는지와 준비는 /api/health로 본다', () => {
  it('헬스에 b-studio 표지가 있으면 첫 화면(/)을 부르지 않고 재사용한다', async () => {
    const h = harness({ probe: [health, nestedOk] });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await runLaunch({ mode: 'local', port: 3000, open: false }, h.deps)).toBe(0);
    expect(h.probes).toEqual(['http://127.0.0.1:3000/api/health', 'http://127.0.0.1:3000/api/health/routes']);
    expect(h.spawns).toEqual([]);
  });

  it('옛 서버(헬스에 표지 없음)는 첫 화면의 표지로 알아보고 재사용한다', async () => {
    const h = harness({ probe: [oldHealth, up, nestedOk] });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await runLaunch({ mode: 'local', port: 3000, open: false }, h.deps)).toBe(0);
    expect(h.probes).toEqual(['http://127.0.0.1:3000/api/health', 'http://127.0.0.1:3000/', 'http://127.0.0.1:3000/api/health/routes']);
    expect(h.spawns).toEqual([]);
  });

  it('헬스에도 첫 화면에도 표지가 없으면 다른 프로그램이다', async () => {
    const h = harness({ probe: [{ reachable: true, status: 404, body: 'nope' }, upOther] });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await runLaunch({ mode: 'local', port: 3000, open: false }, h.deps)).toBe(1);
    expect(h.spawns).toEqual([]);
    expect(error.mock.calls.flat().join('\n')).toContain('다른 프로그램');
  });

  it('새로 띄우면 헬스가 200일 때 준비로 본다(응답만 오고 200이 아니면 더 기다린다)', async () => {
    const h = harness({ probe: [down, { reachable: true, status: 500, body: '' }, health], exec: [OK] });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    h.deps.readyTimeoutMs = 10;

    expect(await runLaunch({ mode: 'local', port: 3000, open: false }, h.deps)).toBe(0);
    expect(h.probes.slice(1)).toEqual(['http://127.0.0.1:3000/api/health', 'http://127.0.0.1:3000/api/health']);
  });

  it('기다리는 동안 지난 시간을 알린다', async () => {
    const h = harness({ probe: [down, down, down, health], exec: [OK] });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    h.deps.readyTimeoutMs = 10;
    const waited: number[] = [];

    expect(await runLaunch({ mode: 'local', port: 3000, open: false, onWaiting: (ms) => waited.push(ms) }, h.deps)).toBe(0);
    expect(waited).toEqual([0, 1, 2]);
  });
});

describe('runLaunch: 브라우저는 열라고 할 때만', () => {
  it('open이 false면 브라우저를 열지 않고 토큰 주소도 찍지 않으며, desk와 --web을 안내한다', async () => {
    const token = 'd'.repeat(64);
    const h = harness({ probe: [down, health], exec: [OK], localToken: token });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await runLaunch({ mode: 'local', port: 3000, open: false }, h.deps)).toBe(0);
    expect(h.opens).toEqual([]);
    const text = log.mock.calls.flat().join('\n');
    expect(text).not.toContain(token);
    expect(text).toContain('pnpm studio desk');
    expect(text).toContain('--web');
  });

  it('serverEnv는 사용자가 정하지 않은 환경 변수만 채운다', async () => {
    const h = harness({ probe: [down, health], exec: [OK] });
    vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await runLaunch({ mode: 'local', port: 3000, open: false, serverEnv: { B_STUDIO_EXPERIMENTAL: '1', B_STUDIO_BACKENDS: 'codex' } }, h.deps)).toBe(0);
    expect(h.spawns[0]!.env.B_STUDIO_EXPERIMENTAL).toBe('1');
    // harness의 사용자 환경에 B_STUDIO_BACKENDS=kept가 있다
    expect(h.spawns[0]!.env.B_STUDIO_BACKENDS).toBe('kept');
  });
});
