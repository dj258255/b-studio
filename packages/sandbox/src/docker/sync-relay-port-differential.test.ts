import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LoadedProject } from '@b-studio/spec';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { isDockerUnreachable, SandboxError } from '../errors';
import { Redactor } from '../secrets';
import { runCommand } from '../stream-exec';
import type { FileChange } from '../types';
import { composeEnvironment } from './compose-env';
import { describeDockerFailure, LocalDockerProvider } from './compose-provider';
import { EDGE_SERVICE, EGRESS_NETWORK, SANDBOX_NETWORK } from './format';
import type { MaskVolume } from './git-mask';
import { PORT_RETRY_ATTEMPTS, relayThroughContainers, syncFiles, upWithPortRetry } from './sync-relay';
import { composeUpWithPortRetryLegacy, relayChangesLegacy, syncLegacy, type LegacyRetryContext } from './sync-relay-legacy';
import { overrideInputJson, writeComposeOverride } from './up-loop';

/**
 * 파일 반영 확인·변경 알림·포트 충돌 재시도(ADR-195 4f A4c-2)의 차등 시험: 옛 TS(`sync-relay-legacy.ts`)와 지금(Rust 함수 + TS 껍데기)이 같은 가짜 docker에
 * 같은 결과(반환값 또는 같은 글·detail·platform의 오류), 같은 docker 호출 순서, 같은 override 내용(YAML로 읽은 값)·마지막 마스크를 내는지 본다.
 * 진짜 docker는 쓰지 않는다 — 가짜 docker는 준비한 출력을 호출 순서대로 내놓는 셸 스크립트다.
 * 옛 쪽과 다른 점은 모두 "더 막는 쪽"이고 아래 `HARDENED`·`의도한 차이` 표시가 붙은 입력에서만 나온다(그 밖의 입력은 한 글자도 다르지 않아야 한다).
 */

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Step {
  code?: number;
  out?: string;
  err?: string;
  /** 이 호출이 끝나기 전에 기다릴 초(취소 시험) */
  sleep?: number;
}
type Script = Record<string, Step | Step[]>;

interface Env {
  dir: string;
  root: string;
  scriptDir: string;
}

async function environment(): Promise<Env> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'sync-diff-')));
  roots.push(dir);
  const root = path.join(dir, 'proj');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, '.git', 'b-studio'), { recursive: true });
  await writeFile(path.join(root, '.git', 'config'), '[core]\n\tbare = false\n[b-studio]\n\tstart = abc\n');
  const scriptDir = path.join(dir, 'script');
  await mkdir(scriptDir);
  return { dir, root, scriptDir };
}

/** 실행 한 번(옛 쪽, 새 쪽)마다 상태 폴더를 따로 두는 가짜 docker. 상태·대본 폴더의 경로는 스크립트에 박아 넣는다(docker에 넘기는 환경은 허용 목록뿐이다) */
async function fakeDocker(env: Env, kind: string): Promise<{ bin: string; state: string; runDir: string }> {
  const runDir = path.join(env.dir, kind);
  const state = path.join(runDir, 'state');
  await mkdir(state, { recursive: true });
  const bin = path.join(runDir, 'docker');
  await writeFile(
    bin,
    `#!/bin/sh
S='${state}'
D='${env.scriptDir}'
printf '%s\\n' "$*" >> "$S/calls"
key=other
case "$1" in
  run) key=run ;;
  inspect) key=inspect; [ "$2" = --format ] && key=state ;;
  volume) key=volume ;;
  rm) key=rm ;;
  start) key=startid ;;
  compose) for a in "$@"; do case "$a" in config) key=config ;; up) key=up ;; ps) key=ps ;; down) key=down ;; start) key=start ;; rm) key=composerm ;; exec) key=exec ;; esac; done ;;
esac
n=$(cat "$S/n.$key" 2>/dev/null || echo 0)
n=$((n + 1))
ov=""
for a in "$@"; do case "$a" in *compose.override.yaml) ov="$a" ;; esac; done
if [ "$key" = up ] || [ "$key" = start ] || [ "$key" = composerm ]; then [ -f "$ov" ] && cp "$ov" "$S/ov.$key.$n"; fi
echo "$n" > "$S/n.$key"
pick() { if [ -f "$D/$key.$n.$1" ]; then cat "$D/$key.$n.$1"; elif [ -f "$D/$key.$1" ]; then cat "$D/$key.$1"; fi; }
s=$(pick sleep)
[ -n "$s" ] && sleep "$s"
pick out
pick err >&2
code=$(pick code)
exit \${code:-0}
`,
  );
  await chmod(bin, 0o755);
  return { bin, state, runDir };
}

async function install(env: Env, script: Script): Promise<void> {
  for (const [key, value] of Object.entries(script)) {
    const steps = Array.isArray(value) ? value : [value];
    const write = async (prefix: string, step: Step) => {
      await writeFile(path.join(env.scriptDir, `${prefix}.out`), step.out ?? '');
      await writeFile(path.join(env.scriptDir, `${prefix}.err`), step.err ?? '');
      await writeFile(path.join(env.scriptDir, `${prefix}.code`), String(step.code ?? 0));
      if (step.sleep !== undefined) await writeFile(path.join(env.scriptDir, `${prefix}.sleep`), String(step.sleep));
    };
    for (const [index, step] of steps.entries()) await write(`${key}.${index + 1}`, step);
    // 호출 수가 목록보다 많으면 마지막 것을 되풀이한다
    await write(key, steps[steps.length - 1]!);
  }
}

const json = (value: unknown) => JSON.stringify(value);
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

type Outcome<T> = { ok: true; value: T } | { ok: false; name: string; message: string; detail: string | undefined; platform: boolean };

function outcomeOf(error: unknown): Outcome<never> {
  if (error instanceof SandboxError) return { ok: false, name: error.name, message: error.message, detail: error.detail, platform: error.platform };
  if (error instanceof Error) return { ok: false, name: error.name, message: error.message, detail: undefined, platform: false };
  throw error;
}

const normalizeCalls = (calls: string, env: Env, runDir: string) =>
  calls
    .split('\n')
    .filter(Boolean)
    .map((line) => line.split(runDir).join('<RUN>').split(env.dir).join('<ENV>'));

const readCalls = async (state: string) => readFile(path.join(state, 'calls'), 'utf8').catch(() => '');

const project = (env: Env, extra: Partial<LoadedProject> = {}): LoadedProject =>
  ({
    spec: { name: 'p' },
    root: env.root,
    composePath: path.join(env.root, 'compose.yaml'),
    managed: [['api', { template: 'node', path: '.', port: 3000 }]],
    composeServices: ['api'],
    sharedVolumes: [],
    external: [],
    ...extra,
  }) as unknown as LoadedProject;

const dockerEnv = () => composeEnvironment({});

// ── sync ────────────────────────────────────────────────────────────────

interface SyncScenario {
  name: string;
  files: string[];
  setup?: (env: Env) => Promise<void>;
  script: (env: Env) => Script;
  timeoutMs?: number;
  /** 기다리는 횟수가 시간에 달려 있다 */
  timing?: boolean;
  abort?: 'during-sleep';
}

interface SyncObserved {
  outcome: Outcome<{ checks: number }>;
  calls: string[];
}

async function observeSync(kind: 'legacy' | 'now', scenario: SyncScenario, env: Env): Promise<SyncObserved> {
  const { bin, state, runDir } = await fakeDocker(env, kind);
  const proj = project(env);
  const controller = new AbortController();
  if (scenario.abort === 'during-sleep') {
    // 가짜 docker가 첫 확인을 시작한 뒤(상태 폴더에 호출 횟수 파일이 생긴다) 100ms 뒤, 즉 250ms 쉬는 중에 취소한다
    const timer = setInterval(() => {
      readFile(path.join(state, 'n.run'), 'utf8').then(
        () => {
          clearInterval(timer);
          setTimeout(() => controller.abort(), 100);
        },
        () => {},
      );
    }, 5);
    setTimeout(() => clearInterval(timer), 20_000).unref();
  }
  const options = { signal: controller.signal, timeoutMs: scenario.timeoutMs ?? 60_000 };
  const run =
    kind === 'legacy'
      ? syncLegacy({ project: proj, docker: (args, signal) => runCommand(bin, args, { signal, env: dockerEnv() }) }, scenario.files, options)
      : syncFiles({ project: proj, dockerBin: bin, env: dockerEnv(), files: scenario.files, ...options });
  const outcome = await run.then(
    (result) => ({ ok: true as const, value: { checks: result.checks } }),
    (error: unknown) => outcomeOf(error),
  );
  return { outcome, calls: normalizeCalls(await readCalls(state), env, runDir) };
}

async function bothSync(scenario: SyncScenario) {
  const env = await environment();
  await writeFile(path.join(env.root, 'a.txt'), 'new content');
  await scenario.setup?.(env);
  await install(env, scenario.script(env));
  const legacy = await observeSync('legacy', scenario, env);
  const now = await observeSync('now', scenario, env);
  return { legacy, now, env };
}

const OLD = sha('old content');
const NEW = sha('new content');
const A = (hash: string) => `${hash} a.txt\n`;

const syncScenarios: SyncScenario[] = [
  { name: '정상: 처음 확인에서 같다', files: ['a.txt'], script: () => ({ run: { out: A(NEW) } }) },
  { name: '정상: 늦게 반영된다(이전 내용 → 안 보임 → 같음)', files: ['a.txt'], script: () => ({ run: [{ out: A(OLD) }, { out: 'MISSING a.txt\n' }, { out: A(NEW) }] }) },
  { name: '정상: 지운 파일과 함께 사라진 폴더도 MISSING이어야 한다', files: ['gone/deep/b.ts'], script: () => ({ run: { out: 'MISSING gone/deep/b.ts\nMISSING gone/deep\nMISSING gone\n' } }) },
  { name: '정상: 파일 둘(공백이 든 이름 포함)', files: ['a.txt', 'dir/b c.txt'], setup: async (env) => { await mkdir(path.join(env.root, 'dir')); await writeFile(path.join(env.root, 'dir', 'b c.txt'), 'x'); }, script: () => ({ run: { out: `${NEW} a.txt\n${sha('x')} dir/b c.txt\n` } }) },
  { name: '정상: 목록이 비어 있다', files: [], script: () => ({}) },
  { name: '정상: 호스트의 링크는 따라간 내용의 해시를 견준다', files: ['alias.txt'], setup: async (env) => { await symlink(path.join(env.root, 'a.txt'), path.join(env.root, 'alias.txt')); }, script: () => ({ run: { out: `${NEW} alias.txt\n` } }) },
  { name: '정상: 같은 폴더에서 `..`이 든 경로를 접어 읽는다', files: ['src/../a.txt'], script: () => ({ run: { out: `${NEW} src/../a.txt\n` } }) },
  { name: '시간 초과: 이전 내용 그대로', files: ['a.txt'], timeoutMs: 0, script: () => ({ run: { out: A(OLD) } }) },
  { name: '시간 초과: 컨테이너에서 보이지 않는다', files: ['a.txt'], timeoutMs: 0, script: () => ({ run: { out: 'MISSING a.txt\n' } }) },
  { name: '시간 초과: 컨테이너가 그 파일의 줄을 주지 않는다', files: ['a.txt'], timeoutMs: 0, script: () => ({ run: { out: '' } }) },
  { name: '시간 초과: 지운 파일이 컨테이너에 남아 있다', files: ['gone.txt'], timeoutMs: 0, script: () => ({ run: { out: `${NEW} gone.txt\n` } }) },
  { name: '시간 초과: 컨테이너가 읽지 못했다(UNREADABLE)', files: ['a.txt'], timeoutMs: 0, script: () => ({ run: { out: 'UNREADABLE a.txt\n' } }) },
  { name: '시간 초과: 반영되는 중(값이 바뀐다)', files: ['a.txt'], timeoutMs: 150, timing: true, script: () => ({ run: [{ out: A(OLD) }, { out: A(sha('mid')) }] }) },
  { name: '시간 초과: 파일 둘 중 하나만 늦다', files: ['a.txt', 'src/z.txt'], setup: async (env) => { await writeFile(path.join(env.root, 'src', 'z.txt'), 'z'); }, timeoutMs: 0, script: () => ({ run: { out: `${NEW} a.txt\n${sha('stale')} src/z.txt\n` } }) },
  { name: '대소문자: 호스트 이름과 컨테이너 출력의 글자가 다르면 줄이 없는 것이다', files: ['README.md'], setup: async (env) => { await writeFile(path.join(env.root, 'README.md'), 'r'); }, timeoutMs: 0, script: () => ({ run: { out: `${sha('r')} readme.md\n` } }) },
  { name: '유니코드 정규화: NFC로 적은 이름을 컨테이너가 NFD로 알리면 줄이 없는 것이다', files: ['caf\u00e9.txt'], setup: async (env) => { await writeFile(path.join(env.root, 'caf\u00e9.txt'), 'c'); }, timeoutMs: 0, script: () => ({ run: { out: `${sha('c')} cafe\u0301.txt\n` } }) },
  { name: 'docker가 비0 종료(이미지를 받지 못함)', files: ['a.txt'], script: () => ({ run: { code: 125, err: 'Unable to find image' } }) },
  { name: 'docker가 비0 종료(stderr 없음)', files: ['a.txt'], script: () => ({ run: { code: 1 } }) },
  { name: '기다리는 중에 취소하면 AbortError다', files: ['a.txt'], abort: 'during-sleep', script: () => ({ run: { out: A(OLD) } }) },
];

describe('sync가 옛 sync와 같다', () => {
  it.each(syncScenarios.map((scenario) => [scenario.name, scenario] as const))('%s', async (_name, scenario) => {
    const { legacy, now } = await bothSync(scenario);
    if (scenario.abort) {
      expect(legacy.outcome).toMatchObject({ ok: false, name: 'AbortError' });
    }
    expect(now.outcome).toEqual(legacy.outcome);
    const collapse = (calls: string[]) => calls.filter((call, index) => calls[index - 1] !== call);
    expect(scenario.timing ? collapse(now.calls) : now.calls).toEqual(scenario.timing ? collapse(legacy.calls) : legacy.calls);
  }, 60_000);

  it('시나리오 수', () => {
    expect(syncScenarios.length).toBeGreaterThanOrEqual(19);
  });
});

describe('sync HARDENED: 옛 쪽보다 더 막는 의도한 차이', () => {
  it('같은 파일의 줄이 둘이면 뒤의 줄이 맞아도 통과하지 못한다(옛 쪽은 나중 줄이 이겨 통과했다)', async () => {
    const { legacy, now } = await bothSync({ name: 'x', files: ['a.txt'], timeoutMs: 0, script: () => ({ run: { out: `${OLD} a.txt\n${NEW} a.txt\n` } }) });
    expect(legacy.outcome.ok).toBe(true);
    expect(now.outcome).toMatchObject({ ok: false, name: 'SandboxError', platform: true });
    if (!now.outcome.ok) expect(now.outcome.message).toContain('0초 안에 샌드박스에 파일 변경이 반영되지 않았습니다: a.txt');
  });

  it('값이 같은 중복 줄도 통과하지 못한다', async () => {
    const { legacy, now } = await bothSync({ name: 'x', files: ['a.txt'], timeoutMs: 0, script: () => ({ run: { out: `${NEW} a.txt\n${NEW} a.txt\n` } }) });
    expect(legacy.outcome.ok).toBe(true);
    expect(now.outcome.ok).toBe(false);
  });

  it.each(['garbage', ' leading', 'nospace'])('모양을 모르는 줄(%s)이 하나라도 있으면 맞는 줄이 있어도 통과하지 못한다', async (noise) => {
    const { legacy, now } = await bothSync({ name: 'x', files: ['a.txt'], timeoutMs: 0, script: () => ({ run: { out: `${NEW} a.txt\n${noise}\n` } }) });
    expect(legacy.outcome.ok).toBe(true);
    expect(now.outcome.ok).toBe(false);
  });

  it('호스트 파일을 읽지 못하면(폴더) docker를 부르지 않고 SandboxError다(옛 쪽은 fs 원시 오류)', async () => {
    const { legacy, now } = await bothSync({ name: 'x', files: ['src'], script: () => ({ run: { out: '' } }) });
    expect(legacy.outcome).toMatchObject({ ok: false, message: expect.stringContaining('EISDIR') });
    expect(now.outcome).toMatchObject({ ok: false, name: 'SandboxError', platform: false });
    if (!now.outcome.ok) expect(now.outcome.message).toContain('src');
    expect(now.calls).toEqual([]);
    expect(legacy.calls).toEqual([]);
  });

  it('이미 취소된 신호는 아무것도 읽거나 부르지 않고 AbortError다(옛 쪽은 해시를 읽고 docker를 부른 뒤 실패로 읽었다)', async () => {
    const env = await environment();
    await writeFile(path.join(env.root, 'a.txt'), 'new content');
    await install(env, { run: { out: A(NEW) } });
    const { bin, state } = await fakeDocker(env, 'now');
    const controller = new AbortController();
    controller.abort();
    await expect(syncFiles({ project: project(env), dockerBin: bin, env: dockerEnv(), files: ['a.txt'], signal: controller.signal, timeoutMs: 1000 })).rejects.toMatchObject({ name: 'AbortError' });
    expect(await readCalls(state)).toBe('');
  });
});

// ── relay ───────────────────────────────────────────────────────────────

interface RelayScenario {
  name: string;
  changes: FileChange[];
  config?: (env: Env) => unknown;
  /** config를 읽는 compose config 호출의 대본을 덮는다 */
  script?: (env: Env) => Script;
  project?: (env: Env) => LoadedProject;
}

const relayConfig = (env: Env) => ({ services: { api: { volumes: [{ type: 'bind', source: env.root, target: '/app' }] }, db: { volumes: [{ type: 'volume', source: 'data', target: '/var/lib/db' }] } } });

interface RelayObserved {
  outcome: Outcome<{ service: string; file: string }[]>;
  calls: string[];
}

async function observeRelay(kind: 'legacy' | 'now', scenario: RelayScenario, env: Env): Promise<RelayObserved> {
  const { bin, state, runDir } = await fakeDocker(env, kind);
  const proj = scenario.project ? scenario.project(env) : project(env);
  const overridePath = path.join(runDir, 'compose.override.yaml');
  const composeArgs = (args: string[]) => ['compose', '--project-name', 'studio-p', '--project-directory', proj.root, '--file', proj.composePath, '--file', overridePath, ...args];
  const compose = (args: string[], signal?: AbortSignal) => runCommand(bin, composeArgs(args), { signal, env: dockerEnv() });
  const redact = (text: string) => text;
  let run: Promise<{ service: string; file: string }[]>;
  if (kind === 'legacy') {
    run = relayChangesLegacy({ id: 'studio-p', project: proj, compose, redact, state: { config: undefined } }, scenario.changes);
  } else {
    // 옛 `relayChanges`의 compose config 읽기(캐시는 상태라 TS에 남는다)와 같은 순서로 읽어 Rust 함수에 넘긴다
    run = (scenario.changes.length === 0 ? Promise.resolve(undefined) : compose(['config', '--format', 'json'])).then((result) => {
      if (result === undefined) return [];
      if (result.exitCode !== 0) throw new SandboxError('compose 설정을 읽지 못했습니다 (studio-p)', redact(result.stderr));
      JSON.parse(result.stdout);
      return relayThroughContainers({ id: 'studio-p', project: proj, dockerBin: bin, env: dockerEnv(), overridePath, config: result.stdout, changes: scenario.changes });
    });
  }
  const outcome = await run.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => outcomeOf(error),
  );
  return { outcome, calls: normalizeCalls(await readCalls(state), env, runDir) };
}

async function bothRelay(scenario: RelayScenario) {
  const env = await environment();
  await install(env, { config: { out: json((scenario.config ?? relayConfig)(env)) }, exec: { out: '' }, ...scenario.script?.(env) });
  const legacy = await observeRelay('legacy', scenario, env);
  const now = await observeRelay('now', scenario, env);
  return { legacy, now };
}

const ALL_OUT = 'm:/app/newdir\nn:/app\n';

const relayScenarios: RelayScenario[] = [
  { name: '새 폴더는 옮기고 새 파일은 목록을 다시 읽게 한다(둘 다 알렸다)', changes: [{ file: 'newdir', kind: 'directory' }, { file: 'added.ts', kind: 'file' }], script: () => ({ exec: { out: ALL_OUT } }) },
  { name: '알린 것만 돌려준다(하나만 출력에 찍혔다)', changes: [{ file: 'newdir', kind: 'directory' }, { file: 'added.ts', kind: 'file' }], script: () => ({ exec: { out: 'n:/app\n' } }) },
  { name: '아무것도 알리지 못했다(재시작 중)', changes: [{ file: 'newdir', kind: 'directory' }], script: () => ({ exec: { code: 1, err: 'restarting' } }) },
  { name: '출력의 인자가 글자 하나라도 다르면 알리지 않은 것이다', changes: [{ file: 'newdir', kind: 'directory' }], script: () => ({ exec: { out: 'm:/app/newdir \n' } }) },
  { name: '지운 경로는 부모 목록을 다시 읽게 한다', changes: [{ file: 'src/old.ts', kind: 'deleted' }], script: () => ({ exec: { out: 'n:/app/src\n' } }) },
  { name: '어느 마운트에도 들지 않는 변경은 알리지 않는다', changes: [{ file: 'x', kind: 'file' }], config: () => ({ services: { api: { volumes: [{ type: 'bind', source: '/elsewhere', target: '/app' }] } } }) },
  { name: '변경이 없으면 compose 설정도 읽지 않는다', changes: [] },
  { name: 'compose 설정을 읽지 못함(비0)', changes: [{ file: 'a', kind: 'file' }], script: () => ({ config: { code: 1, err: 'bad' } }) },
  { name: 'compose 설정의 마운트 모양을 모름', changes: [{ file: 'a', kind: 'file' }], config: () => ({ services: { api: { volumes: 'x' } } }) },
  {
    name: '서비스 둘이 같은 루트를 마운트하면 managed·더 좁은 서비스로 알린다',
    changes: [{ file: 'web/newdir', kind: 'directory' }],
    config: (env) => ({ services: { api: { volumes: [{ type: 'bind', source: env.root, target: '/app' }] }, web: { volumes: [{ type: 'bind', source: env.root, target: '/app' }] } } }),
    project: (env) => project(env, { managed: [['api', { template: 'node', path: 'api', port: 3000 }], ['web', { template: 'node', path: 'web', port: 3001 }]] } as Partial<LoadedProject>),
    script: () => ({ exec: { out: 'm:/app/web/newdir\n' } }),
  },
];

describe('relayChanges가 옛 relayChanges와 같다', () => {
  it.each(relayScenarios.map((scenario) => [scenario.name, scenario] as const))('%s', async (_name, scenario) => {
    const { legacy, now } = await bothRelay(scenario);
    expect(now.outcome).toEqual(legacy.outcome);
    expect(now.calls).toEqual(legacy.calls);
  }, 60_000);
});

describe('relayChanges 의도한 차이', () => {
  it.each([['null'], ['{}'], ['{"services":null}']])('compose 설정이 %s이면 던진다(옛 쪽은 TypeError, 새 쪽은 SandboxError). 알리지 않는다', async (text) => {
    const env = await environment();
    const { bin, state } = await fakeDocker(env, 'now');
    await expect(relayThroughContainers({ id: 'studio-p', project: project(env), dockerBin: bin, env: dockerEnv(), overridePath: path.join(env.dir, 'o.yaml'), config: text, changes: [{ file: 'a', kind: 'file' }] })).rejects.toBeInstanceOf(SandboxError);
    expect(await readCalls(state)).toBe('');
  });
});

describe('LocalDockerProvider.relayChanges: compose 설정은 세션 동안 한 번만 읽고 실패하면 캐시를 비운다', () => {
  async function sandboxFor(env: Env, script: Script) {
    await install(env, script);
    const { bin, state } = await fakeDocker(env, 'provider');
    const sandbox = await new LocalDockerProvider({ dockerBin: bin }).create(project(env));
    return { sandbox, state };
  }

  it('두 번 알려도 compose config는 한 번이다', async () => {
    const env = await environment();
    const { sandbox, state } = await sandboxFor(env, { config: { out: json(relayConfig(env)) }, exec: { out: 'm:/app/newdir\n' } });
    expect(await sandbox.relayChanges!([{ file: 'newdir', kind: 'directory' }])).toEqual([{ service: 'api', file: 'newdir' }]);
    expect(await sandbox.relayChanges!([{ file: 'newdir', kind: 'directory' }])).toEqual([{ service: 'api', file: 'newdir' }]);
    const calls = (await readCalls(state)).split('\n').filter(Boolean);
    expect(calls.filter((call) => call.split(' ').includes('config')).length).toBeGreaterThanOrEqual(1);
    // `create`의 마스크 계산(--profile)은 빼고, 알림이 읽는 compose config만 센다
    expect(calls.filter((call) => call.includes('config --format json') && !call.includes('--profile'))).toHaveLength(1);
  });

  it('읽기에 실패하면 캐시를 비워 다음에 다시 읽는다', async () => {
    const env = await environment();
    const { sandbox, state } = await sandboxFor(env, { config: [{ out: json(relayConfig(env)) }, { code: 1, err: 'down' }, { out: json(relayConfig(env)) }], exec: { out: 'm:/app/newdir\n' } });
    await expect(sandbox.relayChanges!([{ file: 'newdir', kind: 'directory' }])).rejects.toThrow('compose 설정을 읽지 못했습니다');
    expect(await sandbox.relayChanges!([{ file: 'newdir', kind: 'directory' }])).toEqual([{ service: 'api', file: 'newdir' }]);
    const reads = (await readCalls(state)).split('\n').filter((call) => call.includes('config --format json') && !call.includes('--profile'));
    expect(reads).toHaveLength(2);
  });
});

describe('LocalDockerProvider.sync', () => {
  it('호스트 해시와 컨테이너가 같으면 통과하고 같은 파일의 줄이 둘이면 실패한다', async () => {
    const env = await environment();
    await writeFile(path.join(env.root, 'a.txt'), 'new content');
    await install(env, { config: { out: json(composeConfig(env)) }, run: { out: A(NEW) } });
    const { bin } = await fakeDocker(env, 'provider');
    const sandbox = await new LocalDockerProvider({ dockerBin: bin }).create(project(env));
    expect((await sandbox.sync(['a.txt'])).checks).toBe(1);
    await install(env, { run: { out: `${OLD} a.txt\n${NEW} a.txt\n` } });
    await expect(sandbox.sync(['a.txt'], { timeoutMs: 0 })).rejects.toMatchObject({ platform: true });
  });
});

// ── 포트 충돌 재시도 ─────────────────────────────────────────────────────

const SERVICE_LABEL = 'com.docker.compose.service';
const CONFLICT = 'Error response from daemon: driver failed programming external connectivity on endpoint studio-p-api-1: failed to bind port 127.0.0.1:45231: address already in use';

const labelOf = (service: string) => ({ [SERVICE_LABEL]: service });
const container = (id: string, service: string, mounts: object[], extra: Record<string, unknown> = {}) => ({
  Id: id,
  Name: `/${id}`,
  Config: { Labels: labelOf(service) },
  HostConfig: { NetworkMode: 'studio-p_b-studio-sandbox' },
  NetworkSettings: { Networks: { 'studio-p_b-studio-sandbox': {} } },
  Mounts: mounts,
  ...extra,
});
const baseMounts = (env: Env, target = '/app') => [
  { Type: 'bind', Source: env.root, Destination: target, RW: true },
  { Type: 'bind', Source: path.join(env.root, '.git'), Destination: `${target}/.git`, RW: false },
  { Type: 'bind', Source: path.join(env.root, '.git', 'b-studio-empty'), Destination: `${target}/.git/b-studio`, RW: false },
];
const composeConfig = (env: Env) => ({ services: { api: { volumes: [{ type: 'bind', source: env.root, target: '/app' }] } } });

/** `compose up`(전체 up이라 compose start로 시작한다)의 정상 대본 */
const upBase = (env: Env): Script => ({
  config: { out: json(composeConfig(env)) },
  up: {},
  ps: { out: 'c1\n' },
  inspect: { out: json([container('c1', 'api', baseMounts(env))]) },
  volume: { out: '[]' },
  start: {},
  down: {},
  composerm: {},
});

interface RetryScenario {
  name: string;
  script: (env: Env) => Script;
  upArgs?: string[];
  secrets?: Record<string, string>;
  /** 공개 주소 참조가 있어 다시 뽑을 포트가 있다 */
  refs?: boolean;
  abort?: 'before' | 'during-start';
  hardened?: boolean;
}

interface RetryObserved {
  outcome: Outcome<null>;
  calls: string[];
  mask: Record<string, MaskVolume[]>;
  hostPortKeys: string[];
  /** 포트가 다시 뽑혔다면 처음 값과 달라졌다 */
  hostPortsChanged: boolean;
  overrides: Record<string, string>;
  rawOverrides: Record<string, string>;
  finalOverride: string;
}

const PORTS = /127\.0\.0\.1:\d+/g;

async function observeRetry(kind: 'legacy' | 'now', scenario: RetryScenario, env: Env): Promise<RetryObserved> {
  const { bin, state, runDir } = await fakeDocker(env, kind);
  const refs = scenario.refs ? [{ service: 'api', envKey: 'API_URL', template: '${b-studio:services.api.publicUrl}', targetService: 'api' }] : [];
  const proj = project(env, { publicUrlRefs: refs } as Partial<LoadedProject>);
  const overridePath = path.join(runDir, 'compose.override.yaml');
  const edgeScript = '// edge\n';
  const initialPorts: Record<string, number> = scenario.refs ? { api: 40000 } : {};
  await writeComposeOverride(overridePath, overrideInputJson(proj, 'studio-p', { edgeScript, runtime: undefined, hostPorts: initialPorts }), {});
  const secrets = scenario.secrets ?? {};
  const redactor = new Redactor(secrets);
  const redact = (text: string) => redactor.redact(text);
  const status = { gitMask: {} as Record<string, MaskVolume[]>, hostPorts: initialPorts };
  const controller = new AbortController();
  if (scenario.abort === 'before') controller.abort();
  if (scenario.abort === 'during-start') {
    const timer = setInterval(() => {
      readFile(path.join(state, 'n.start'), 'utf8').then(
        () => {
          clearInterval(timer);
          controller.abort();
        },
        () => {},
      );
    }, 5);
    setTimeout(() => clearInterval(timer), 20_000).unref();
  }
  const upArgs = scenario.upArgs ?? [];
  const common = {
    id: 'studio-p',
    project: proj,
    dockerBin: bin,
    env: dockerEnv(),
    overridePath,
    evaluationAssets: [],
    sandboxNetwork: SANDBOX_NETWORK,
    egressNetwork: EGRESS_NETWORK,
    edgeService: EDGE_SERVICE,
    serviceLabel: SERVICE_LABEL,
  };
  let run: Promise<void>;
  if (kind === 'legacy') {
    const ctx: LegacyRetryContext = {
      ...common,
      edgeScript,
      runtime: undefined,
      dependencyPollMs: 1,
      dependencyWaitMs: 50,
      redact,
      docker: (args, signal) => runCommand(bin, args, { signal, env: dockerEnv() }),
      state: status,
    };
    run = composeUpWithPortRetryLegacy(ctx, upArgs, controller.signal);
  } else {
    run = upWithPortRetry({
      ...common,
      overrideInput: overrideInputJson(proj, 'studio-p', { edgeScript, runtime: undefined, hostPorts: status.hostPorts }),
      gitMask: status.gitMask,
      args: ['up', '--detach', '--remove-orphans', ...upArgs],
      pollMs: 1,
      waitMs: 50,
      signal: controller.signal,
      redact,
      onMask: (mask) => {
        status.gitMask = mask;
      },
      publicUrlTargets: [...new Set(refs.map((ref) => ref.targetService))],
      secrets,
      upFailure: (result) => new SandboxError('docker compose up 실패 (studio-p)', describeDockerFailure(redact(result.stderr)), { platform: isDockerUnreachable(result.stderr) }),
      onHostPorts: (ports) => {
        status.hostPorts = ports;
      },
    });
  }
  const outcome = await run.then(
    () => ({ ok: true as const, value: null }),
    (error: unknown) => outcomeOf(error),
  );
  const overrides: Record<string, string> = {};
  const rawOverrides: Record<string, string> = {};
  for (const name of (await readdir(state)).filter((file) => file.startsWith('ov.')).sort()) {
    rawOverrides[name] = JSON.stringify(parse(await readFile(path.join(state, name), 'utf8')));
    overrides[name] = rawOverrides[name]!.replace(PORTS, '127.0.0.1:<PORT>');
  }
  const finalOverride = JSON.stringify(parse(await readFile(overridePath, 'utf8'))) .replace(PORTS, '127.0.0.1:<PORT>');
  return {
    outcome,
    calls: normalizeCalls(await readCalls(state), env, runDir),
    mask: status.gitMask,
    hostPortKeys: Object.keys(status.hostPorts).sort(),
    hostPortsChanged: Object.entries(status.hostPorts).some(([name, port]) => initialPorts[name] !== port),
    overrides,
    rawOverrides,
    finalOverride,
  };
}

async function bothRetry(scenario: RetryScenario) {
  const env = await environment();
  await install(env, scenario.script(env));
  const legacy = await observeRetry('legacy', scenario, env);
  const now = await observeRetry('now', scenario, env);
  return { legacy, now };
}

const retryScenarios: RetryScenario[] = [
  { name: '첫 시도에 성공한다', script: upBase },
  { name: '충돌 한 번 뒤 성공(포트를 다시 뽑는다)', refs: true, script: (env) => ({ ...upBase(env), start: [{ code: 1, err: CONFLICT }, {}] }) },
  { name: '충돌 두 번 뒤 성공', refs: true, script: (env) => ({ ...upBase(env), start: [{ code: 1, err: CONFLICT }, { code: 1, err: CONFLICT }, {}] }) },
  { name: '충돌 세 번: 3회 재시도 후 포기', refs: true, script: (env) => ({ ...upBase(env), start: { code: 1, err: CONFLICT } }) },
  { name: '충돌 뒤 성공(다시 뽑을 포트가 없다)', script: (env) => ({ ...upBase(env), start: [{ code: 1, err: CONFLICT }, {}] }) },
  { name: '"port is already allocated" 문구도 충돌이다', refs: true, script: (env) => ({ ...upBase(env), start: [{ code: 1, err: 'Bind for 0.0.0.0:41000 failed: port is already allocated' }, {}] }) },
  { name: '충돌이 아닌 실패(디스크 부족)는 바로 던지고 안내가 붙는다', refs: true, script: (env) => ({ ...upBase(env), start: { code: 1, err: 'write: no space left on device' } }) },
  { name: '충돌이 아닌 실패(이미지가 없음)는 바로 던진다', script: (env) => ({ ...upBase(env), start: { code: 1, err: 'pull access denied for x' } }) },
  { name: '도커 데몬에 닿지 못함은 platform 실패다', script: (env) => ({ ...upBase(env), start: { code: 1, err: 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock' } }) },
  { name: '만들기(up --no-start)가 충돌 문구로 실패해도 충돌이다', refs: true, script: (env) => ({ ...upBase(env), up: [{ code: 1, err: CONFLICT }, {}] }) },
  { name: '시크릿이 충돌 문구를 가리면 충돌로 읽지 않는다', secrets: { T: 'address already in use' }, refs: true, script: (env) => ({ ...upBase(env), start: [{ code: 1, err: CONFLICT }, {}] }) },
  { name: '시크릿이 든 충돌 stderr는 가린 글로 돌아온다(포기)', secrets: { TOKEN: 'SECRETSECRET' }, refs: true, script: (env) => ({ ...upBase(env), start: { code: 1, err: `${CONFLICT} SECRETSECRET` } }) },
  { name: '정리(compose rm)가 실패해도 다음 시도로 이어진다', refs: true, script: (env) => ({ ...upBase(env), start: [{ code: 1, err: CONFLICT }, {}], composerm: { code: 1, err: 'rm failed' } }) },
  { name: '확인 실패(.git 가림이 빠짐)는 충돌이 아니라 바로 던진다', refs: true, script: (env) => ({ ...upBase(env), inspect: { out: json([container('c1', 'api', [baseMounts(env)[0]!])]) } }) },
  { name: 'compose config의 stderr가 충돌 문구를 담으면 옛 오류의 detail 때문에 충돌로 읽는다', refs: true, script: (env) => ({ ...upBase(env), config: { code: 1, err: CONFLICT } }) },
  { name: 'compose config의 실패(충돌 문구 없음)는 바로 던진다', script: (env) => ({ ...upBase(env), config: { code: 1, err: 'bad config' } }) },
  { name: '이미 취소된 신호', abort: 'before', script: upBase },
  { name: '시작하는 도중 취소', abort: 'during-start', script: (env) => ({ ...upBase(env), start: { sleep: 2, code: 1, err: CONFLICT } }) },
  { name: '이름을 준 서비스: compose 대신 docker start로 시작한다', upArgs: ['api'], script: (env) => ({ ...upBase(env), start: {}, startid: [{ code: 1, err: CONFLICT }, {}] }) },
];

describe('포트 충돌 재시도가 옛 #composeUpWithPortRetry와 같다', () => {
  it.each(retryScenarios.map((scenario) => [scenario.name, scenario] as const))('%s', async (_name, scenario) => {
    const { legacy, now } = await bothRetry(scenario);
    expect(now.outcome).toEqual(legacy.outcome);
    expect(now.calls).toEqual(legacy.calls);
    expect(now.mask).toEqual(legacy.mask);
    expect(now.overrides).toEqual(legacy.overrides);
    expect(now.finalOverride).toEqual(legacy.finalOverride);
    expect(now.hostPortKeys).toEqual(legacy.hostPortKeys);
    expect(now.hostPortsChanged).toBe(legacy.hostPortsChanged);
  }, 60_000);

  it('시나리오 수', () => {
    expect(retryScenarios.length).toBeGreaterThanOrEqual(19);
  });

  it('포기까지 시도 횟수는 3번이고 정리는 시도 사이에 두 번이다', async () => {
    const { now } = await bothRetry({ name: 'x', refs: true, script: (env) => ({ ...upBase(env), start: { code: 1, err: CONFLICT } }) });
    expect(PORT_RETRY_ATTEMPTS).toBe(3);
    expect(now.calls.filter((call) => call.includes(' start')).length).toBe(3);
    expect(now.calls.filter((call) => call.endsWith('rm --stop --force --volumes')).length).toBe(2);
  });

  it('다시 쓴 override의 마스크는 직전 시도가 쓴 값이다(정리 직전의 override에 .git 가림이 들어 있다)', async () => {
    const { now } = await bothRetry({ name: 'x', refs: true, script: (env) => ({ ...upBase(env), start: [{ code: 1, err: CONFLICT }, {}] }) });
    const snapshot = JSON.parse(now.overrides['ov.composerm.1']!) as { services: Record<string, { volumes?: Array<{ target: string }> }> };
    expect(snapshot.services.api?.volumes?.map((volume) => volume.target)).toEqual(['/app/.git', '/app/.git/b-studio']);
  });

  it('포트를 다시 뽑으면 처음 값(40000)에서 바뀌고 다시 쓴 override에 옛 포트가 남지 않는다', async () => {
    const { now, legacy } = await bothRetry({ name: 'x', refs: true, script: (env) => ({ ...upBase(env), start: [{ code: 1, err: CONFLICT }, {}] }) });
    expect(now.hostPortsChanged).toBe(true);
    expect(legacy.hostPortsChanged).toBe(true);
    // 첫 시작 때의 override에는 옛 포트가, 정리(rm) 직전에 다시 쓴 override에는 새 포트가 들어 있다
    expect(now.rawOverrides['ov.start.1']).toContain('127.0.0.1:40000');
    expect(now.rawOverrides['ov.composerm.1']).not.toContain('40000');
    expect(now.rawOverrides['ov.composerm.1']).toMatch(/127\.0\.0\.1:(4[0-9]{4}|5[0-9]{4})/);
  });
});

describe('LocalDockerProvider: 포트 충돌 재시도가 공개 주소 대상 포트를 전부 다시 뽑아 override에 쓴다', () => {
  it('충돌로 끝까지 실패해도 다시 쓴 override의 호스트 포트는 처음과 다르고 시크릿 값이 파일에 없다', async () => {
    const env = await environment();
    const minimal = { config: { out: '{"services":{}}' }, ps: { out: 'm1\n' }, inspect: { out: '[{"Id":"m1","Config":{"Labels":{"com.docker.compose.service":"api"}},"Mounts":[]}]' }, volume: { out: '[]' } };
    await install(env, { ...upBase(env), ...minimal, start: { code: 1, err: CONFLICT }, composerm: {} });
    const { bin, state } = await fakeDocker(env, 'provider');
    const withRef = project(env, { publicUrlRefs: [{ service: 'api', envKey: 'API_URL', template: '${b-studio:services.api.publicUrl}', targetService: 'api' }] } as Partial<LoadedProject>);
    const sandbox = await new LocalDockerProvider({ dockerBin: bin, dependencyPollMs: 1 }).create(withRef);
    await expect(sandbox.start()).rejects.toThrow('포트 충돌이 반복돼 3회 재시도 후 포기했습니다');
    const port = async (name: string) => /127\.0\.0\.1:(\d+)/.exec(await readFile(path.join(state, name), 'utf8'))?.[1];
    const first = await port('ov.start.1');
    const afterFirstRetry = await port('ov.composerm.1');
    const afterSecondRetry = await port('ov.composerm.2');
    expect(first).toMatch(/^\d+$/);
    expect(afterFirstRetry).toMatch(/^\d+$/);
    expect(afterSecondRetry).toMatch(/^\d+$/);
    expect(afterFirstRetry).not.toBe(first);
    expect(afterSecondRetry).not.toBe(afterFirstRetry);
  });
});

describe('LocalDockerProvider: 충돌 판정은 시크릿을 가린 글을 본다', () => {
  it('시크릿 값이 충돌 문구와 겹쳐 가려지면 충돌로 읽지 않고 다시 시도하지 않는다', async () => {
    const env = await environment();
    const minimal = { config: { out: '{"services":{}}' }, ps: { out: 'm1\n' }, inspect: { out: '[{"Id":"m1","Config":{"Labels":{"com.docker.compose.service":"api"}},"Mounts":[]}]' }, volume: { out: '[]' } };
    await install(env, { ...upBase(env), ...minimal, start: { code: 1, err: 'Bind for 0.0.0.0:41000 failed: port is already allocated' } });
    const { bin, state } = await fakeDocker(env, 'provider');
    const sandbox = await new LocalDockerProvider({ dockerBin: bin, dependencyPollMs: 1 }).create(project(env, { managed: [] }), { secrets: { TOKEN: 'port is already allocated' } });
    await expect(sandbox.start()).rejects.toThrow('docker compose up 실패');
    const calls = (await readCalls(state)).split('\n').filter(Boolean);
    expect(calls.filter((call) => call.split(' ').includes('rm'))).toEqual([]);
  });
});

describe('포트 충돌 재시도 의도한 차이', () => {
  it('재시도 전체가 #upQueue의 한 칸이다: 둘이 동시에 시작해도 한쪽의 재시도(up → start 실패 → rm → up → start)가 끝난 뒤에야 다른 쪽 up이 시작한다', async () => {
    const env = await environment();
    // 서비스가 없는 compose 설정과 마운트가 없는 컨테이너(기존 포트 충돌 시험과 같은 최소 대본)
    const minimal = { config: { out: '{"services":{}}' }, ps: { out: 'm1\n' }, inspect: { out: '[{"Id":"m1","Config":{"Labels":{"com.docker.compose.service":"api"}},"Mounts":[]}]' }, volume: { out: '[]' } };
    await install(env, { ...upBase(env), ...minimal, start: [{ code: 1, err: CONFLICT }, {}, {}] });
    const { bin, state } = await fakeDocker(env, 'provider');
    const withRef = project(env, { managed: [], publicUrlRefs: [{ service: 'api', envKey: 'API_URL', template: '${b-studio:services.api.publicUrl}', targetService: 'api' }] } as Partial<LoadedProject>);
    const sandbox = await new LocalDockerProvider({ dockerBin: bin, dependencyPollMs: 1 }).create(withRef);
    await Promise.all([sandbox.start(), sandbox.start()]);
    const verbs = (await readCalls(state))
      .split('\n')
      .filter(Boolean)
      .map((call) => call.split(' ').find((word) => ['up', 'start', 'rm'].includes(word)))
      .filter((word): word is string => word !== undefined);
    // 첫 시작: up start(실패) rm up start. 이어서 둘째 시작: up start. 시작 둘이 섞이면 rm 앞뒤의 up이 어긋난다
    expect(verbs.join(' ')).toBe('up start rm up start up start');
  });
});
