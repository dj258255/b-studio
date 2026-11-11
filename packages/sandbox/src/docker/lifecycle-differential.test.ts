import { execFileSync } from 'node:child_process';
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { SandboxError, isDockerUnreachable } from '../errors';
import { ExecCheckedError } from '../exec-checked';
import { Redactor } from '../secrets';
import { runCommand } from '../stream-exec';
import type { ExecResult, ExternalCallRequest, LoadRequest } from '../types';
import { composeEnvironment } from './compose-env';
import { describeDockerFailure } from './compose-provider';
import {
  assertRuntimeLegacy,
  callExternalLegacy,
  cleanupLegacy,
  destroyLegacy,
  removeSandboxImagesLegacy,
  runLoadLegacy,
  type LegacyLifecycleContext,
} from './lifecycle-legacy';
import {
  assertRuntime,
  callExternalApi,
  cleanupSandbox,
  destroySandbox,
  removeSandboxImages,
  runLoadTest,
  type DestroyContext,
  type ExternalContext,
  type LoadCache,
  type LoadContext,
} from './lifecycle-run';

/**
 * 끝맺음·부하 러너·사내 API 호출·런타임 확인(ADR-195 4f A4c-3c)의 차등 시험: 옛 TS(`lifecycle-legacy.ts`)와 지금(Rust 함수 + TS 껍데기)이 **같은 가짜 docker**에
 * 같은 결과(반환값 또는 같은 글·종류의 오류), 같은 docker 호출(인자 하나하나와 실행 폴더, 표준 입력), 같은 파일 시스템 결과(지운 것과 남은 것)를 내는지 본다.
 * 진짜 docker는 쓰지 않는다 — 가짜 docker는 셸 스크립트이고, **응답은 호출 순서가 아니라 명령(`image ls`·`image rm`·`info`·`run`·`rm`·compose의 `down`·`ps`·`exec`)으로 고른다**.
 * 한 쪽(옛, 새)이 자기 폴더에서 돈다(지우는 시험이 서로의 대상을 지우지 않게). 컨테이너 이름의 무작위 8자와 폴더 경로는 지우고 견준다.
 * 옛 쪽과 다른 점은 모두 "더 막는 쪽"이고, 아래 `HARDENED`가 붙은 입력에서만 나온다(그 밖의 입력은 한 글자도 다르지 않아야 한다).
 */

// 전체 시험을 돌 때는 새로 만든 가짜 docker의 첫 실행이 느려질 수 있다(macOS의 실행 파일 검사). 시험마다 두 쪽을 돌리므로 여유를 둔다
vi.setConfig({ testTimeout: 60_000 });

const roots: string[] = [];
/** 읽기 전용으로 만든 폴더(지우기 전에 되돌린다) */
const locked: string[] = [];
afterAll(async () => {
  await Promise.all(locked.map((dir) => chmod(dir, 0o700).catch(() => undefined)));
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
});

const ID = 'studio-shop-a1b2c3';
const OTHER = 'studio-keep-aaaaaa';
const WORK = 'b-studio-abc123';
const IMAGE = 'busybox:1.37';

// ── 가짜 docker ──────────────────────────────────────────────────────────

interface Step {
  code?: number;
  out?: string;
  err?: string;
  /** 초. 응답하기 전에 쉰다 */
  sleep?: number;
}
type Script = Record<string, Step | Step[]>;

interface Layout {
  /** 한 쪽의 루트 */
  root: string;
  bin: string;
  state: string;
  proj: string;
  composePath: string;
  overridePath: string;
  tmp: string;
  workDir: string;
  assets: string;
  outside: string;
}

/**
 * 응답을 고르는 키: `image ls` → `imagels`, `image rm` → `imagerm`, `info` → `info`, `run` → `run`, `rm` → `rm`, compose의 `down`·`ps`·`exec`.
 * 호출 기록은 인자 하나가 \037, 호출 하나가 \036으로 끝난다. 실행 폴더(`$PWD`)와 `run`·`exec`의 표준 입력도 남긴다
 */
async function layoutFor(kind: string): Promise<Layout> {
  const root = path.join(await realpath(await mkdtemp(path.join(tmpdir(), 'lifecycle-diff-'))), kind);
  roots.push(path.dirname(root));
  const layout: Layout = {
    root,
    bin: path.join(root, 'bin', 'docker'),
    state: path.join(root, 'state'),
    proj: path.join(root, 'proj'),
    composePath: path.join(root, 'proj', 'compose.yaml'),
    overridePath: path.join(root, 'w', 'compose.override.yaml'),
    tmp: path.join(root, 'tmp'),
    workDir: path.join(root, 'tmp', WORK),
    assets: path.join(root, 'assets'),
    outside: path.join(root, 'outside'),
  };
  for (const dir of [path.dirname(layout.bin), layout.state, path.join(root, 'script'), layout.proj, path.dirname(layout.overridePath), layout.tmp, layout.assets, layout.outside]) await mkdir(dir, { recursive: true });
  return layout;
}

async function installFakeDocker(layout: Layout, script: Script): Promise<void> {
  const scripts = path.join(layout.root, 'script');
  await writeFile(
    layout.bin,
    `#!/bin/sh
S='${layout.state}'
D='${scripts}'
US=$(printf '\\037')
RS=$(printf '\\036')
line=""
for a in "$@"; do line="$line$a$US"; done
printf '%s%s' "$line" "$RS" >> "$S/calls"
printf '%s%s' "$PWD" "$RS" >> "$S/cwds"
key=other
case "$1" in
  image) key=imagels; [ "$2" = rm ] && key=imagerm ;;
  info) key=info ;;
  run) key=run ;;
  rm) key=rm ;;
  compose) for a in "$@"; do case "$a" in down) key=down ;; ps) key=ps ;; exec) key=exec ;; esac; done ;;
esac
n=$(cat "$S/n.$key" 2>/dev/null || echo 0)
n=$((n + 1))
echo "$n" > "$S/n.$key"
case "$key" in run|exec) cat > "$S/stdin.$key.$n" ;; esac
pick() { if [ -f "$D/$key.$n.$1" ]; then cat "$D/$key.$n.$1"; elif [ -f "$D/$key.$1" ]; then cat "$D/$key.$1"; fi; }
s=$(pick sleep)
[ -n "$s" ] && sleep "$s"
pick out
pick err >&2
code=$(pick code)
exit \${code:-0}
`,
  );
  await chmod(layout.bin, 0o755);
  // macOS는 새로 만든 실행 파일의 첫 실행을 검사하느라 수백 ms 걸릴 때가 있다. 시간 상한을 재는 시험이 그 시간에 걸리지 않도록 먼저 한 번 돌리고 흔적을 지운다
  execFileSync(layout.bin, ['__warm-up__']);
  await rm(layout.state, { recursive: true, force: true });
  await mkdir(layout.state, { recursive: true });
  for (const [key, value] of Object.entries(script)) {
    const steps = Array.isArray(value) ? value : [value];
    const write = async (prefix: string, step: Step) => {
      await writeFile(path.join(scripts, `${prefix}.out`), step.out ?? '');
      await writeFile(path.join(scripts, `${prefix}.err`), step.err ?? '');
      await writeFile(path.join(scripts, `${prefix}.code`), String(step.code ?? 0));
      if (step.sleep !== undefined) await writeFile(path.join(scripts, `${prefix}.sleep`), String(step.sleep));
    };
    for (const [index, step] of steps.entries()) await write(`${key}.${index + 1}`, step);
    await write(key, steps[steps.length - 1]!);
  }
}

const readState = (layout: Layout, file: string): string => {
  try {
    return readFileSync(path.join(layout.state, file), 'utf8');
  } catch {
    return '';
  }
};

const callsOf = (layout: Layout): string[][] =>
  readState(layout, 'calls').split('\x1e').filter(Boolean).map((call) => call.split('\x1f').filter((_, index, all) => index < all.length - 1 || all[index] !== ''));

/** 호출마다 표준 입력(`run`·`exec`) */
const stdinsOf = (layout: Layout): Record<string, string> => {
  const found: Record<string, string> = {};
  for (const file of existsSyncList(layout.state)) if (file.startsWith('stdin.')) found[file] = readState(layout, file);
  return found;
};
const existsSyncList = (dir: string): string[] => {
  try {
    return execFileSync('ls', [dir], { encoding: 'utf8' }).split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

// ── 맥락 ─────────────────────────────────────────────────────────────────

interface Setup {
  secrets?: Record<string, string>;
  /** 옛·새 쪽 모두에 같은 모양으로 폴더를 채운다 */
  prepare?: (layout: Layout) => Promise<void>;
  external?: string[];
  runtime?: string;
  loadLimitMs?: number;
}

const composeFailureOf = (id: string, redact: (text: string) => string) => (command: string, result: ExecResult) =>
  new SandboxError(`docker compose ${command} 실패 (${id})`, describeDockerFailure(redact(result.stderr)), { platform: isDockerUnreachable(result.stderr) });

const RUNNER = '// load runner\nexport const x = 1;\n';
const EDGE = '// edge script\n';

interface Api {
  removeImages(id?: string): Promise<void>;
  cleanup(id?: string): Promise<void>;
  destroy(): Promise<void>;
  external(name: string, request: ExternalCallRequest, options?: { signal?: AbortSignal }): Promise<unknown>;
  load(request: LoadRequest, options?: { signal?: AbortSignal }): Promise<unknown>;
  runtime(runtime: string): Promise<void>;
}

function apiFor(kind: 'legacy' | 'now', layout: Layout, setup: Setup, id = ID): Api {
  const secrets = setup.secrets ?? {};
  const dockerEnv = composeEnvironment(secrets);
  const redactor = new Redactor(secrets);
  const redact = (text: string) => redactor.redact(text);
  const composeFailure = composeFailureOf(id, redact);
  const external = (setup.external ?? ['billing']).map((name) => [name, {}] as const);
  const managedPort = (name: string): number => {
    if (name !== 'api') throw new SandboxError(`'${name}'은(는) 이 프로젝트의 managed 서비스가 아닙니다`);
    return 8080;
  };
  const limitMs = setup.loadLimitMs ?? 100_000;
  const composeArgs = (args: string[]) => ['compose', '--project-name', id, '--project-directory', layout.proj, '--file', layout.composePath, '--file', layout.overridePath, ...args];
  const loadCache: LoadCache = {};
  const runnerPath = path.join(layout.root, 'runner.mjs');
  if (kind === 'legacy') {
    const ctx: LegacyLifecycleContext = {
      id,
      dockerBin: layout.bin,
      docker: (args, signal, input) => runCommand(layout.bin, args, { signal, env: dockerEnv, input }),
      composeArgs,
      composeFailure,
      redact,
      workDir: layout.workDir,
      evaluationAssetRoot: layout.assets,
      edgeScript: EDGE,
      edgeService: 'edge',
      external,
      managedPort,
      ...(setup.runtime ? { runtime: setup.runtime } : {}),
      sandboxNetwork: 'sandbox',
      runnerScriptPath: runnerPath,
      loadCache: {},
      loadLimitMs: limitMs,
    };
    return {
      removeImages: (target = id) => removeSandboxImagesLegacy(layout.bin, target),
      cleanup: (target = id) => cleanupLegacy({ dockerBin: layout.bin, evaluationAssetRoot: layout.assets }, target),
      destroy: () => destroyLegacy(ctx),
      external: (name, request, options) => callExternalLegacy(ctx, name, request, { via: 'agent', ...options }),
      load: (request, options) => runLoadLegacy(ctx, request, options),
      runtime: (runtime) => assertRuntimeLegacy(layout.bin, runtime),
    };
  }
  const base = { id, dockerBin: layout.bin, env: dockerEnv, project: { root: layout.proj, composePath: layout.composePath }, overridePath: layout.overridePath, redact, composeFailure };
  const destroyCtx: DestroyContext = { ...base, workDir: layout.workDir, evaluationAssetRoot: layout.assets };
  const externalCtx: ExternalContext = { ...base, edgeScript: EDGE, edgeService: 'edge', external };
  const loadCtx: LoadContext = { ...base, managedPort, sandboxNetwork: 'sandbox', runtime: setup.runtime, readRunner: () => readFile(runnerPath, 'utf8'), cache: loadCache, limitMs };
  return {
    removeImages: (target = id) => removeSandboxImages(layout.bin, target),
    cleanup: (target = id) => cleanupSandbox({ dockerBin: layout.bin, evaluationAssetRoot: layout.assets }, target),
    destroy: () => destroySandbox(destroyCtx),
    external: (name, request, options) => callExternalApi(externalCtx, name, request, { via: 'agent', ...options }),
    load: (request, options) => runLoadTest(loadCtx, request, options ?? {}),
    runtime: (runtime) => assertRuntime(layout.bin, runtime),
  };
}

// ── 관찰 ─────────────────────────────────────────────────────────────────

interface Failure {
  constructorName: string;
  name: string;
  message: string;
  detail?: string | undefined;
  platform?: boolean | undefined;
  code?: unknown;
  stdout?: string;
  stderr?: string;
}

interface Observed {
  outcome: { ok: true; value: unknown } | { ok: false; error: Failure };
  calls: string[][];
  cwds: string[];
  stdins: Record<string, string>;
  /** 한 쪽의 임시 폴더·복사본 루트·바깥 폴더에 남은 것(`d` 폴더, `f` 파일, `l` 링크) */
  files: string[];
}

let realTmp = '';
let realCwd = '';

function scrubber(layout: Layout) {
  return (text: string) => text.split(layout.root).join('<SIDE>').replace(/-load-[0-9a-f]{8}/g, '-load-<R>');
}

function describeError(error: unknown, scrub: (text: string) => string): Failure {
  if (error instanceof ExecCheckedError) return { constructorName: error.constructor.name, name: error.name, message: scrub(error.message), code: error.code, stdout: error.stdout, stderr: scrub(error.stderr) };
  if (error instanceof SandboxError) return { constructorName: error.constructor.name, name: error.name, message: scrub(error.message), detail: error.detail === undefined ? undefined : scrub(error.detail), platform: error.platform };
  if (error instanceof Error) return { constructorName: error.constructor.name, name: error.name, message: scrub(error.message) };
  throw error;
}

async function walk(dir: string, prefix: string): Promise<string[]> {
  const found: string[] = [];
  let names: string[];
  try {
    names = (await readdir(dir)).sort();
  } catch {
    return found;
  }
  for (const name of names) {
    const full = path.join(dir, name);
    const info = await lstat(full);
    const type = info.isSymbolicLink() ? 'l' : info.isDirectory() ? 'd' : 'f';
    found.push(`${type} ${prefix}/${name}`);
    if (type === 'd') found.push(...(await walk(full, `${prefix}/${name}`)));
  }
  return found;
}

async function observe(kind: 'legacy' | 'now', setup: Setup, script: Script, run: (api: Api, layout: Layout) => Promise<unknown>): Promise<Observed> {
  if (!realTmp) {
    realTmp = await realpath(tmpdir());
    realCwd = await realpath(process.cwd());
  }
  const layout = await layoutFor(kind);
  await mkdir(path.join(layout.workDir, 'sub'), { recursive: true });
  await writeFile(path.join(layout.workDir, 'compose.override.yaml'), 'x');
  await writeFile(path.join(layout.workDir, 'sub', 'deep'), 'y');
  await mkdir(path.join(layout.assets, ID, 'deep'), { recursive: true });
  await writeFile(path.join(layout.assets, ID, 'deep', 'file'), 'z');
  await mkdir(path.join(layout.assets, OTHER), { recursive: true });
  await writeFile(path.join(layout.assets, OTHER, 'keep'), 'k');
  await writeFile(path.join(layout.outside, 'precious'), 'p');
  await writeFile(path.join(layout.root, 'runner.mjs'), RUNNER);
  await setup.prepare?.(layout);
  await installFakeDocker(layout, script);
  const scrub = scrubber(layout);
  const api = apiFor(kind, layout, setup);
  const outcome: Observed['outcome'] = await run(api, layout).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error: describeError(error, scrub) }),
  );
  const cwds = readState(layout, 'cwds').split('\x1e').filter(Boolean).map((cwd) => (cwd === realTmp ? '<TMP>' : cwd === realCwd ? '<CWD>' : scrub(cwd)));
  const stdins: Record<string, string> = {};
  for (const [key, value] of Object.entries(stdinsOf(layout))) stdins[key] = value;
  const files = [...(await walk(layout.tmp, 'tmp')), ...(await walk(layout.assets, 'assets')), ...(await walk(layout.outside, 'outside'))];
  return { outcome, calls: callsOf(layout).map((call) => call.map(scrub)), cwds, stdins, files };
}

/**
 * HARDENED(트러블슈팅 194): 새 쪽의 이미지 목록은 compose 프로젝트 라벨 필터를 하나 더 건다. 옛 쪽의 `image ls` 호출에
 * 같은 필터를 끼워 넣은 뒤에 견준다. 이 하나만 고치고 나머지 호출은 한 글자도 바꾸지 않는다
 */
function withProjectLabel(call: string[]): string[] {
  if (call[0] !== 'image' || call[1] !== 'ls' || call[2] !== '--filter' || !call[3]?.startsWith('reference=') || !call[3].endsWith('-*')) return call;
  const id = call[3].slice('reference='.length, -'-*'.length);
  return [...call.slice(0, 4), '--filter', `label=com.docker.compose.project=${id}`, ...call.slice(4)];
}

async function both(script: Script, run: (api: Api, layout: Layout) => Promise<unknown>, setup: Setup = {}) {
  const legacy = await observe('legacy', setup, script, run);
  const now = await observe('now', setup, script, run);
  // 실패 글에는 명령 전체가 들어간다(`Command failed: <bin> image ls …`). 같은 필터를 글에도 끼워 넣는다
  const outcome = JSON.parse(JSON.stringify(legacy.outcome).replace(/image ls --filter reference=(studio-[a-z0-9-]+)-\* --format/g, 'image ls --filter reference=$1-* --filter label=com.docker.compose.project=$1 --format')) as Observed['outcome'];
  return { legacy: { ...legacy, outcome, calls: legacy.calls.map(withProjectLabel) }, now };
}

/** 옛 쪽과 새 쪽이 한 글자도 다르지 않다 */
async function same(script: Script, run: (api: Api, layout: Layout) => Promise<unknown>, setup: Setup = {}) {
  const { legacy, now } = await both(script, run, setup);
  expect(now.outcome).toEqual(legacy.outcome);
  expect(now.calls).toEqual(legacy.calls);
  expect(now.cwds).toEqual(legacy.cwds);
  expect(now.stdins).toEqual(legacy.stdins);
  expect(now.files).toEqual(legacy.files);
  return { legacy, now };
}

const rmCalls = (calls: string[][]) => calls.filter((call) => call[0] === 'image' && call[1] === 'rm' || call[0] === 'rm');

// ── 이미지 지우기 ─────────────────────────────────────────────────────────

describe('removeSandboxImages', () => {
  it('목록의 이름 가운데 id 접두사가 맞는 것만 force 없이 지운다', async () => {
    const out = `${ID}-web:latest\n${ID}-api:latest\nother:latest\n${ID}x-web:latest\n<none>:<none>\n  ${ID}-db:1\r\n`;
    const { now } = await same({ imagels: { out } }, (api) => api.removeImages());
    expect(now.calls).toEqual([
      ['image', 'ls', '--filter', `reference=${ID}-*`, '--filter', `label=com.docker.compose.project=${ID}`, '--format', '{{.Repository}}:{{.Tag}}'],
      ['image', 'rm', `${ID}-web:latest`, `${ID}-api:latest`, `${ID}-db:1`],
    ]);
    expect(now.cwds).toEqual(['<TMP>', '<TMP>']);
  });

  it('지울 이미지가 없으면 rm을 부르지 않는다', async () => {
    const { now } = await same({ imagels: { out: 'unrelated:latest\n' } }, (api) => api.removeImages());
    expect(now.calls).toHaveLength(1);
  });

  it('빈 출력', async () => {
    await same({}, (api) => api.removeImages());
  });

  it('목록이 실패하면 옛 execChecked처럼 던진다', async () => {
    const { now } = await same({ imagels: { code: 1, err: 'daemon error' } }, (api) => api.removeImages());
    expect(now.outcome).toMatchObject({ ok: false, error: { constructorName: 'ExecCheckedError', code: 1, stderr: 'daemon error' } });
  });

  it('지우기가 실패하면 던진다(쓰는 컨테이너가 있는 이미지)', async () => {
    await same({ imagels: { out: `${ID}-web:latest\n` }, imagerm: { code: 1, err: 'conflict: image is being used' } }, (api) => api.removeImages());
  });

  it('id의 꼴이 아니면 docker를 부르지 않고 같은 오류를 던진다', async () => {
    for (const bad of ['studio-x', '../x', '*', '', 'studio-shop-a1b2c3\n']) {
      const { now } = await same({}, (api) => api.removeImages(bad));
      expect(now.calls).toEqual([]);
      expect(now.outcome).toMatchObject({ ok: false, error: { constructorName: 'SandboxError' } });
    }
  });

  it('spawn에 실패해도 같다', async () => {
    await same({}, async (api, layout) => {
      await rm(layout.bin);
      return api.removeImages();
    });
  });

  it('HARDENED: 이 id를 접두사로 가진 다른 샌드박스의 이미지는 프로젝트 라벨 필터로 거른다(트러블슈팅 194)', async () => {
    // 프로젝트 이름이 다른 샌드박스의 id 앞부분과 같으면 `studio-shop-a1b2c3-...`가 두 샌드박스에 겹친다.
    // 거르는 것은 도커 데몬(서로 다른 필터는 AND)이라 가짜 docker로는 인자만 본다. 실제 docker에서 겹치는 접두사가 라벨 필터로 빠지는 것은 실측 기록에 있다
    const raw = await observe('legacy', {}, {}, (api) => api.removeImages());
    expect(raw.calls[0]).toEqual(['image', 'ls', '--filter', `reference=${ID}-*`, '--format', '{{.Repository}}:{{.Tag}}']);
    const { now } = await same({}, (api) => api.removeImages());
    expect(now.calls[0]).toEqual(['image', 'ls', '--filter', `reference=${ID}-*`, '--filter', `label=com.docker.compose.project=${ID}`, '--format', '{{.Repository}}:{{.Tag}}']);
  });
});

// ── cleanup ──────────────────────────────────────────────────────────────

describe('cleanup', () => {
  it('compose 파일 없이 프로젝트 이름으로 down → 이미지 → 평가 자산', async () => {
    const { now } = await same({ imagels: { out: `${ID}-web:latest\n` } }, (api) => api.cleanup());
    expect(now.calls).toEqual([
      ['compose', '--project-name', ID, 'down', '--volumes', '--remove-orphans', '--rmi', 'local'],
      ['image', 'ls', '--filter', `reference=${ID}-*`, '--filter', `label=com.docker.compose.project=${ID}`, '--format', '{{.Repository}}:{{.Tag}}'],
      ['image', 'rm', `${ID}-web:latest`],
    ]);
    expect(now.cwds).toEqual(['<TMP>', '<TMP>', '<TMP>']);
    expect(now.files).not.toContain(`d assets/${ID}`);
    expect(now.files).toContain(`d assets/${OTHER}`);
  });

  it('down이 실패하면 이미지를 건너뛰고 평가 자산은 지우고 모아 던진다', async () => {
    const { now } = await same({ down: { code: 1, err: 'Cannot connect to the Docker daemon' } }, (api) => api.cleanup());
    expect(now.calls).toHaveLength(1);
    expect(now.files).not.toContain(`d assets/${ID}`);
    expect(now.outcome).toMatchObject({ ok: false, error: { constructorName: 'SandboxError', message: expect.stringContaining('정리하지 못했습니다') as unknown } });
  });

  it('이미지 지우기가 실패해도 평가 자산은 지운다', async () => {
    const { now } = await same({ imagels: { code: 2, err: 'bad' } }, (api) => api.cleanup());
    expect(now.files).not.toContain(`d assets/${ID}`);
  });

  it('평가 자산 폴더가 링크여도 링크 너머를 지우지 않는다', async () => {
    const prepare = async (layout: Layout) => {
      await rm(path.join(layout.assets, ID), { recursive: true, force: true });
      await symlink(layout.outside, path.join(layout.assets, ID));
    };
    const { now } = await same({}, (api) => api.cleanup(), { prepare });
    expect(now.files).toContain('f outside/precious');
    expect(now.files).not.toContain(`l assets/${ID}`);
  });

  it('id의 꼴이 아니면 아무것도 하지 않고 같은 오류를 던진다', async () => {
    const { now } = await same({}, (api) => api.cleanup('studio-x'));
    expect(now.calls).toEqual([]);
    expect(now.files).toContain(`d assets/${ID}`);
  });
});

// ── destroy ──────────────────────────────────────────────────────────────

const DOWN = ['down', '--volumes', '--remove-orphans', '--rmi', 'local'];

describe('destroy', () => {
  it('down → 이미지 → 작업 폴더 → 평가 자산 순서로 옛 인자 그대로 지운다', async () => {
    const { now } = await same({ imagels: { out: `${ID}-web:latest\n` } }, (api) => api.destroy());
    expect(now.calls).toHaveLength(3);
    expect(now.calls[0]!.slice(0, 9)).toEqual(['compose', '--project-name', ID, '--project-directory', '<SIDE>/proj', '--file', '<SIDE>/proj/compose.yaml', '--file', '<SIDE>/w/compose.override.yaml']);
    expect(now.calls[0]!.slice(9)).toEqual(DOWN);
    expect(now.calls[1]).toEqual(['image', 'ls', '--filter', `reference=${ID}-*`, '--filter', `label=com.docker.compose.project=${ID}`, '--format', '{{.Repository}}:{{.Tag}}']);
    expect(now.calls[2]).toEqual(['image', 'rm', `${ID}-web:latest`]);
    expect(now.cwds).toEqual(['<CWD>', '<TMP>', '<TMP>']);
    expect(now.files).not.toContain(`d tmp/${WORK}`);
    expect(now.files).not.toContain(`d assets/${ID}`);
    expect(now.files).toContain(`d assets/${OTHER}`);
  });

  it('down이 실패하면 이미지는 건너뛰고 작업 폴더와 평가 자산은 지우고 down 오류를 던진다', async () => {
    const { now } = await same({ down: { code: 1, err: 'Cannot connect to the Docker daemon at unix:///x.sock' } }, (api) => api.destroy());
    expect(now.calls).toHaveLength(1);
    expect(now.outcome).toMatchObject({ ok: false, error: { constructorName: 'SandboxError', message: `docker compose down 실패 (${ID})\nCannot connect to the Docker daemon at unix:///x.sock`, platform: true } });
    expect(now.files).not.toContain(`d tmp/${WORK}`);
    expect(now.files).not.toContain(`d assets/${ID}`);
  });

  it('down 오류의 시크릿을 가린다', async () => {
    const secrets = { TOKEN: 'sk-live-abcdef123456' };
    const { now } = await same({ down: { code: 1, err: 'failed with sk-live-abcdef123456' } }, (api) => api.destroy(), { secrets });
    expect(JSON.stringify(now.outcome)).not.toContain('sk-live-abcdef123456');
  });

  it('이미지 지우기가 실패하면 그 오류를 던지되 작업 폴더·평가 자산은 지운다', async () => {
    const { now } = await same({ imagels: { out: `${ID}-web:latest\n` }, imagerm: { code: 1, err: 'conflict' } }, (api) => api.destroy());
    expect(now.outcome).toMatchObject({ ok: false, error: { constructorName: 'ExecCheckedError' } });
    expect(now.files).not.toContain(`d tmp/${WORK}`);
  });

  it('작업 폴더가 이미 없어도 지운다', async () => {
    await same({}, (api) => api.destroy(), { prepare: (layout) => rm(layout.workDir, { recursive: true, force: true }) });
  });

  it('작업 폴더가 링크면 링크만 지우고 너머는 지우지 않는다', async () => {
    const prepare = async (layout: Layout) => {
      await rm(layout.workDir, { recursive: true, force: true });
      await symlink(layout.outside, layout.workDir);
    };
    const { now } = await same({}, (api) => api.destroy(), { prepare });
    expect(now.files).toContain('f outside/precious');
    expect(now.files).not.toContain(`l tmp/${WORK}`);
  });

  it('작업 폴더 안의 링크는 따라가지 않는다', async () => {
    const prepare = async (layout: Layout) => {
      await symlink(layout.outside, path.join(layout.workDir, 'sub', 'link'));
    };
    const { now } = await same({}, (api) => api.destroy(), { prepare });
    expect(now.files).toContain('f outside/precious');
  });

  it('작업 폴더가 파일이면 그 파일만 지운다', async () => {
    const prepare = async (layout: Layout) => {
      await rm(layout.workDir, { recursive: true, force: true });
      await writeFile(layout.workDir, 'file');
    };
    const { now } = await same({}, (api) => api.destroy(), { prepare });
    expect(now.files).not.toContain(`f tmp/${WORK}`);
  });

  it('평가 자산 폴더가 링크면 링크만 지운다', async () => {
    const prepare = async (layout: Layout) => {
      await rm(path.join(layout.assets, ID), { recursive: true, force: true });
      await symlink(layout.outside, path.join(layout.assets, ID));
    };
    const { now } = await same({}, (api) => api.destroy(), { prepare });
    expect(now.files).toContain('f outside/precious');
  });

  it('지우지 못하는 작업 폴더가 있어도 평가 자산은 지우고 오류를 던진다', async () => {
    // 읽기 전용 폴더 안의 파일은 지울 수 없다. 오류 글은 Node와 Rust가 다르므로 견주지 않고 "던진다"와 "평가 자산이 지워진다"만 본다
    const prepare = async (layout: Layout) => {
      await mkdir(path.join(layout.workDir, 'locked'), { recursive: true });
      await writeFile(path.join(layout.workDir, 'locked', 'f'), 'x');
      await chmod(path.join(layout.workDir, 'locked'), 0o500);
      locked.push(path.join(layout.workDir, 'locked'));
    };
    const { legacy, now } = await both({}, (api) => api.destroy(), { prepare });
    for (const side of [legacy, now]) {
      expect(side.outcome.ok).toBe(false);
      expect(side.files).not.toContain(`d assets/${ID}`);
    }
    expect(now.calls).toEqual(legacy.calls);
  });

  it('HARDENED: id의 꼴이 아니면 docker를 부르지 않고 아무것도 지우지 않는다', async () => {
    // 옛 쪽은 down까지 부른 뒤 이미지 단계의 id 확인에서 던졌다. 이 시험은 새 쪽만 본다(정상 입력은 위에서 같다)
    const bad = 'studio-x';
    const layout = await layoutFor('hardened-id');
    await installFakeDocker(layout, {});
    await mkdir(layout.workDir, { recursive: true });
    const secrets = {};
    const redact = (text: string) => text;
    const ctx: DestroyContext = {
      id: bad,
      dockerBin: layout.bin,
      env: composeEnvironment(secrets),
      project: { root: layout.proj, composePath: layout.composePath },
      overridePath: layout.overridePath,
      redact,
      composeFailure: composeFailureOf(bad, redact),
      workDir: layout.workDir,
      evaluationAssetRoot: layout.assets,
    };
    await expect(destroySandbox(ctx)).rejects.toThrow('b-studio가 만든 샌드박스 id가 아닙니다: studio-x');
    expect(callsOf(layout)).toEqual([]);
    expect(existsSync(layout.workDir)).toBe(true);
  });

  it('HARDENED: 이름이 b-studio-<6자>가 아닌 작업 폴더는 지우지 않는다', async () => {
    const layout = await layoutFor('hardened-work');
    await installFakeDocker(layout, {});
    const precious = path.join(layout.tmp, 'projects');
    await mkdir(precious, { recursive: true });
    await writeFile(path.join(precious, 'keep'), 'k');
    const redact = (text: string) => text;
    const ctx: DestroyContext = {
      id: ID,
      dockerBin: layout.bin,
      env: composeEnvironment({}),
      project: { root: layout.proj, composePath: layout.composePath },
      overridePath: layout.overridePath,
      redact,
      composeFailure: composeFailureOf(ID, redact),
      workDir: precious,
      evaluationAssetRoot: layout.assets,
    };
    await expect(destroySandbox(ctx)).rejects.toThrow('작업 폴더 이름이 맞지 않아');
    expect(existsSync(path.join(precious, 'keep'))).toBe(true);
    // 그래도 평가 자산 폴더는 지운다(옛 finally와 같다)
    expect(existsSync(path.join(layout.assets, ID))).toBe(false);
  });
});

// ── 사내 API 호출 ─────────────────────────────────────────────────────────

const RESULT = { decision: 'allow', status: 200, contentType: 'application/json', body: '{"ok":true}', masked: 0 };
const GET: ExternalCallRequest = { method: 'GET', path: '/v1/ping' };

describe('callExternal', () => {
  it('edge 컨테이너 안에서 node로 돌려 마지막 줄을 읽는다(인자와 표준 입력이 같다)', async () => {
    const { now } = await same({ exec: { out: `noise\n${JSON.stringify(RESULT)}\n` } }, (api) => api.external('billing', GET));
    expect(now.calls).toHaveLength(1);
    expect(now.calls[0]!.slice(9)).toEqual(['exec', '-T', 'edge', 'node', '--input-type=module', '-']);
    const [script] = Object.values(now.stdins);
    expect(script).toContain('// edge script');
    expect(script).toContain('"billing"');
    expect(now.outcome).toEqual({ ok: true, value: RESULT });
  });

  it('응답 본문의 시크릿을 가린다', async () => {
    const secrets = { API_KEY: 'sk-live-abcdef123456' };
    const body = JSON.stringify({ ...RESULT, body: '{"key":"sk-live-abcdef123456"}' });
    const { now } = await same({ exec: { out: `${body}\n` } }, (api) => api.external('billing', GET), { secrets });
    expect(JSON.stringify(now.outcome)).not.toContain('sk-live-abcdef123456');
  });

  it('등록하지 않은 이름은 docker를 부르기 전에 거절한다', async () => {
    const { now } = await same({}, (api) => api.external('payments', GET));
    expect(now.calls).toEqual([]);
    expect(now.outcome).toMatchObject({ ok: false, error: { message: "'payments'은(는) 등록한 사내 API가 아닙니다" } });
  });

  it('경로가 /로 시작하지 않으면 docker를 부르기 전에 거절한다', async () => {
    for (const bad of ['v1/ping', '', 'https://evil.example/x', '\\x']) {
      const { now } = await same({}, (api) => api.external('billing', { method: 'GET', path: bad }));
      expect(now.calls).toEqual([]);
      expect(now.outcome).toMatchObject({ ok: false, error: { message: '경로는 "/"로 시작해야 합니다' } });
    }
  });

  it('등록 이름 검사가 경로 검사보다 먼저다', async () => {
    await same({}, (api) => api.external('payments', { method: 'GET', path: 'x' }));
  });

  it('비0 종료는 오류이고 stderr의 시크릿을 가린다', async () => {
    const secrets = { API_KEY: 'sk-live-abcdef123456' };
    const { now } = await same({ exec: { code: 1, err: 'boom sk-live-abcdef123456' } }, (api) => api.external('billing', GET), { secrets });
    expect(JSON.stringify(now.outcome)).not.toContain('sk-live-abcdef123456');
    expect(now.outcome).toMatchObject({ ok: false, error: { message: expect.stringContaining('사내 API 호출을 실행하지 못했습니다') as unknown } });
  });

  it('출력이 없으면 오류다', async () => {
    await same({ exec: { out: '\n  \n' } }, (api) => api.external('billing', GET));
  });

  it('마지막 줄이 JSON이 아니면 같은 오류다', async () => {
    await same({ exec: { out: 'not json\n' } }, (api) => api.external('billing', GET));
  });

  it('본문이 있는 요청과 짝 없는 서로게이트가 든 경로의 표준 입력이 같다', async () => {
    await same({ exec: { out: `${JSON.stringify(RESULT)}\n` } }, (api) => api.external('billing', { method: 'POST', path: '/v1/x?q=\ud800', body: '{"a":"\udc00"}' }));
  });

  it('중단하면 같은 오류다', async () => {
    const run = async (api: Api) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 300);
      return api.external('billing', GET, { signal: controller.signal });
    };
    await same({ exec: { out: `${JSON.stringify(RESULT)}\n`, sleep: 5 } }, run);
  });
});

// ── 부하 러너 ─────────────────────────────────────────────────────────────

const LOAD: LoadRequest = { service: 'api', method: 'POST', path: '/orders/{{seq}}', body: '{"n":1}', concurrent: 1000, requests: 1000, latencyOf: [409] };
const SMALL: LoadRequest = { service: 'api', method: 'GET', path: '/', concurrent: 2, requests: 10 };
const OUTPUT = (request: LoadRequest) =>
  JSON.stringify({
    requests: request.requests,
    concurrent: request.concurrent,
    threads: 4,
    completed: request.requests,
    elapsedMs: 120.5,
    statuses: { '200': request.requests },
    errors: {},
    latency: { count: request.requests, p50: 10, p95: 30, p99: 32, max: 33 },
    connect: { count: request.requests, p50: 60, p95: 70, p99: 72, max: 75, errors: 0 },
    loopDelay: { p99: 5, max: 9 },
    warmup: { requests: 0, errors: 0 },
  });
const RUNNING = { out: '{"Service":"api","State":"running"}\n' };

describe('runLoad', () => {
  it('상태 확인 → CPU 수 → run 순서로 돌고 결과를 읽는다(인자·표준 입력이 같다)', async () => {
    const { now } = await same({ ps: RUNNING, info: { out: '12\n' }, run: { out: `${OUTPUT(LOAD)}\n` } }, (api) => api.load(LOAD));
    expect(now.calls.map((call) => call[0] === 'compose' ? 'compose ps' : call[0])).toEqual(['compose ps', 'info', 'run']);
    expect(now.calls[1]).toEqual(['info', '--format', '{{.NCPU}}']);
    expect(now.calls[2]).toContain('--cpus');
    expect(now.calls[2]).toContain(`${ID}_sandbox`);
    expect(now.calls[2]!.some((arg) => /^studio-shop-a1b2c3-load-<R>$/.test(arg))).toBe(true);
    expect(Object.values(now.stdins)[0]).toContain('globalThis.B_STUDIO_LOAD');
    expect(Object.values(now.stdins)[0]).toContain('// load runner');
  });

  it('성공하면 rm을 부르지 않는다', async () => {
    const { now } = await same({ ps: RUNNING, info: { out: '4\n' }, run: { out: `${OUTPUT(SMALL)}\n` } }, (api) => api.load(SMALL));
    expect(rmCalls(now.calls)).toEqual([]);
  });

  it('같은 샌드박스에서 두 번 부르면 CPU 수를 한 번만 읽는다', async () => {
    const { now } = await same({ ps: RUNNING, info: { out: '4\n' }, run: { out: `${OUTPUT(SMALL)}\n` } }, async (api) => {
      await api.load(SMALL);
      return api.load(SMALL);
    });
    expect(now.calls.filter((call) => call[0] === 'info')).toHaveLength(1);
  });

  it('읽지 못한 CPU 수도 한 번만 읽는다(info 실패, 숫자가 아닌 출력, 0)', async () => {
    for (const info of [{ code: 1, err: 'x' }, { out: 'abc\n' }, { out: '0\n' }, { out: '3.7\n' }, { out: '  8 cores\n' }]) {
      const { now } = await same({ ps: RUNNING, info, run: { out: `${OUTPUT(SMALL)}\n` } }, async (api) => {
        await api.load(SMALL);
        return api.load(LOAD);
      });
      expect(now.calls.filter((call) => call[0] === 'info')).toHaveLength(1);
    }
  });

  it('도커 런타임을 주면 러너에도 같은 런타임을 준다', async () => {
    const { now } = await same({ ps: RUNNING, info: { out: '4\n' }, run: { out: `${OUTPUT(SMALL)}\n` } }, (api) => api.load(SMALL), { runtime: 'runsc' });
    expect(now.calls[2]).toContain('--runtime');
  });

  it('서비스가 실행 중이 아니면 러너를 띄우지 않는다', async () => {
    for (const out of ['{"Service":"api","State":"exited"}\n', '', '[]', 'not json']) {
      await same({ ps: { out } }, (api) => api.load(SMALL));
    }
    const { now } = await same({ ps: { out: '{"Service":"api","State":"exited"}\n' } }, (api) => api.load(SMALL));
    expect(now.calls).toHaveLength(1);
  });

  it('managed 서비스가 아니면 docker를 부르기 전에 던진다', async () => {
    const { now } = await same({}, (api) => api.load({ ...SMALL, service: 'db' }));
    expect(now.calls).toEqual([]);
  });

  it('종료 코드 137은 메모리 한도 안내', async () => {
    const { now } = await same({ ps: RUNNING, info: { out: '4\n' }, run: { code: 137, err: 'Killed' } }, (api) => api.load(SMALL));
    expect(now.outcome).toMatchObject({ ok: false, error: { message: expect.stringContaining('종료 코드 137') as unknown, detail: '러너가 메모리 한도(512MB)를 넘어 종료됐습니다', platform: true } });
    expect(rmCalls(now.calls)).toEqual([]);
  });

  it('그 밖의 비0 종료는 stderr의 마지막 5줄(시크릿 가림)', async () => {
    const secrets = { TOKEN: 'sk-live-abcdef123456' };
    const err = Array.from({ length: 8 }, (_, index) => (index === 6 ? 'token sk-live-abcdef123456' : `line ${index + 1}`)).join('\n');
    const { now } = await same({ ps: RUNNING, info: { out: '4\n' }, run: { code: 2, err } }, (api) => api.load(SMALL), { secrets });
    expect(JSON.stringify(now.outcome)).not.toContain('sk-live-abcdef123456');
    expect(JSON.stringify(now.outcome)).not.toContain('line 3');
  });

  it('결과를 읽지 못하면 오류다(꼴이 어긋남·합이 맞지 않음·빈 출력)', async () => {
    const wrongSum = OUTPUT(SMALL).replace('"200":10', '"200":9');
    for (const out of ['not json\n', wrongSum, '', 'a\nb\nc\nd\n']) {
      await same({ ps: RUNNING, info: { out: '4\n' }, run: { out } }, (api) => api.load(SMALL));
    }
  });

  it('시간 초과는 오류이고 이 실행의 이름으로만 rm --force를 부른다', async () => {
    const { now } = await same({ ps: RUNNING, info: { out: '4\n' }, run: { out: `${OUTPUT(SMALL)}\n`, sleep: 5 } }, (api) => api.load(SMALL), { loadLimitMs: 400 });
    expect(rmCalls(now.calls)).toEqual([['rm', '--force', `${ID}-load-<R>`]]);
    expect(now.outcome).toMatchObject({ ok: false, error: { message: '부하 러너가 제한 시간 안에 끝나지 않았습니다', platform: true } });
  });

  it('신호로 중단하면 신호의 이유를 던지고 이 실행의 이름으로만 rm --force를 부른다', async () => {
    const run = async (api: Api) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error('사용자가 멈췄습니다')), 300);
      return api.load(SMALL, { signal: controller.signal });
    };
    const { now } = await same({ ps: RUNNING, info: { out: '4\n' }, run: { out: `${OUTPUT(SMALL)}\n`, sleep: 5 } }, run);
    expect(rmCalls(now.calls)).toEqual([['rm', '--force', `${ID}-load-<R>`]]);
    expect(now.outcome).toMatchObject({ ok: false, error: { message: '사용자가 멈췄습니다' } });
  });

  it('이미 중단된 신호도 실행 뒤에 알아보고 rm을 부른다', async () => {
    const controller = new AbortController();
    controller.abort(new Error('먼저 멈춤'));
    const { now } = await same({ ps: RUNNING, info: { out: '4\n' }, run: { out: `${OUTPUT(SMALL)}\n` } }, (api) => api.load(SMALL, { signal: controller.signal }));
    expect(rmCalls(now.calls)).toHaveLength(1);
  });

  it('러너 컨테이너 이름은 실행마다 다르다', async () => {
    const names = new Set<string>();
    const env = await layoutFor('names');
    await installFakeDocker(env, { ps: RUNNING, info: { out: '4\n' }, run: { out: `${OUTPUT(SMALL)}\n` } });
    await writeFile(path.join(env.root, 'runner.mjs'), RUNNER);
    const api = apiFor('now', env, {});
    for (let index = 0; index < 6; index += 1) await api.load(SMALL);
    for (const call of callsOf(env)) if (call[0] === 'run') names.add(call[call.indexOf('--name') + 1]!);
    expect(names.size).toBe(6);
    for (const name of names) expect(name).toMatch(new RegExp(`^${ID}-load-[0-9a-f]{8}$`));
  });

  it('의도한 차이(A4a부터): 짝 없는 서로게이트가 든 경로·본문은 napi 경계에서 U+FFFD가 된다(옛 순수 TS는 \\udXXX로 썼다)', async () => {
    const { legacy, now } = await both({ ps: RUNNING, info: { out: '4\n' }, run: { out: `${OUTPUT(SMALL)}\n` } }, (api) => api.load({ ...SMALL, path: '/x?q=\ud800', body: '"\udc00"' }));
    expect(now.calls).toEqual(legacy.calls);
    expect(Object.values(legacy.stdins)[0]).toContain('/x?q=\\ud800');
    expect(Object.values(now.stdins)[0]).toContain('/x?q=\ufffd');
    expect(now.outcome).toEqual(legacy.outcome);
  });

  it('헤더·준비 요청·latencyOf', async () => {
    await same({ ps: RUNNING, info: { out: '4\n' }, run: { out: `${OUTPUT(SMALL)}\n` } }, (api) => api.load({ ...SMALL, headers: { 'x-a': 'b' }, warmup: 3, latencyOf: [200, 409] }));
  });

  it('HARDENED: 실패 이유는 시크릿을 가린 뒤에 자른다(여러 줄 시크릿의 뒷줄이 남지 않는다)', async () => {
    const secrets = { PEM: 'AAAAAAAA-first-line\nBBBBBBBB-second-line' };
    const err = 'AAAAAAAA-first-line\nBBBBBBBB-second-line\nl3\nl4\nl5\nl6';
    const { legacy, now } = await both({ ps: RUNNING, info: { out: '4\n' }, run: { code: 2, err } }, (api) => api.load(SMALL), { secrets });
    // 옛 쪽은 마지막 5줄을 자른 뒤 가려서 시크릿의 뒷줄이 그대로 남는다
    expect(JSON.stringify(legacy.outcome)).toContain('BBBBBBBB-second-line');
    expect(JSON.stringify(now.outcome)).not.toContain('BBBBBBBB-second-line');
    expect(now.calls).toEqual(legacy.calls);
  });

  it('HARDENED: 읽지 못한 러너 출력도 가린 뒤에 자른다', async () => {
    const secrets = { PEM: 'AAAAAAAA-first-line\nBBBBBBBB-second-line' };
    const out = 'noise\nAAAAAAAA-first-line\nBBBBBBBB-second-line\nl3\nl4\n';
    const { legacy, now } = await both({ ps: RUNNING, info: { out: '4\n' }, run: { out } }, (api) => api.load(SMALL), { secrets });
    expect(JSON.stringify(legacy.outcome)).toContain('BBBBBBBB-second-line');
    expect(JSON.stringify(now.outcome)).not.toContain('BBBBBBBB-second-line');
  });
});

// ── 런타임 확인 ───────────────────────────────────────────────────────────

describe('assertRuntime', () => {
  const INFO = '{"runc":{"path":"runc"},"runsc":{"path":"runsc"}}\n';
  it('등록돼 있으면 통과한다', async () => {
    const { now } = await same({ info: { out: INFO } }, (api) => api.runtime('runsc'));
    expect(now.calls).toEqual([['info', '--format', '{{json .Runtimes}}']]);
    expect(now.cwds).toEqual(['<CWD>']);
  });
  it('등록돼 있지 않으면 등록된 목록을 알린다', async () => {
    await same({ info: { out: INFO } }, (api) => api.runtime('kata'));
    await same({ info: { out: '{}\n' } }, (api) => api.runtime('kata'));
    await same({ info: { out: 'not json' } }, (api) => api.runtime('kata'));
  });
  it('데몬 정보를 읽지 못하면 옛 execChecked의 글을 상세로 붙인다', async () => {
    const { now } = await same({ info: { code: 1, err: 'Cannot connect' } }, (api) => api.runtime('runsc'));
    expect(now.outcome).toMatchObject({ ok: false, error: { message: expect.stringContaining('Command failed') as unknown } });
  });
});
