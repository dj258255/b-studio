import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { SandboxError } from '../errors';
import { ExecCheckedError } from '../exec-checked';
import { Redactor } from '../secrets';
import { runCommand } from '../stream-exec';
import type { ServiceUsage, SnapshotEvent } from '../types';
import { EDGE_SERVICE } from '../edge-config';
import { composeEnvironment } from './compose-env';
import { snapshotName } from './snapshots';
import { captureSnapshot, ensureSharedVolumes, planSnapshots, pruneSnapshots, readStats, seedSnapshot, type SnapshotContext } from './snapshot-run';
import {
  captureSnapshotLegacy,
  ensureSharedVolumesLegacy,
  planSnapshotsLegacy,
  seedSnapshotLegacy,
  statsLegacy,
  type LegacySnapshotContext,
  type LegacySnapshotPlan,
} from './snapshot-legacy';

/**
 * 의존성 스냅샷·공유 볼륨·stats(ADR-195 4f A4c-3b)의 차등 시험: 옛 TS(`snapshot-legacy.ts`)와 지금(Rust 함수 + TS 껍데기)이 **같은 가짜 docker**에
 * 같은 결과(반환값 또는 같은 글·종류의 오류), 같은 이벤트(`onSnapshot`의 action·stage·reason. `elapsedMs`는 지우고 숫자인지만 본다),
 * 같은 docker 호출 순서(와 이벤트가 그 호출들 사이의 어디에서 났는지)를 내는지 본다.
 * 진짜 docker는 쓰지 않는다 — 가짜 docker는 셸 스크립트이고, **응답은 호출 순서가 아니라 볼륨·서비스 이름으로 고른다**(동시에 부르는 호출은 순서가 정해지지 않는다).
 * 응답은 진짜 docker의 출력 모양(줄바꿈으로 끝나는 이름, `{{.Name}} {{.CreatedAt}}` 줄, 컨테이너 JSON, stats의 JSON 줄)으로 적었다.
 * 옛 쪽과 다른 점은 모두 "더 막는 쪽"이고, 아래 `HARDENED`가 붙은 입력에서만 나온다(그 밖의 입력은 한 글자도 다르지 않아야 한다).
 */

// 전체 시험을 돌 때는 새로 만든 가짜 docker의 첫 실행이 느려질 수 있다(macOS의 실행 파일 검사). 시험마다 두 쪽을 돌리므로 여유를 둔다
vi.setConfig({ testTimeout: 60_000 });

const roots: string[] = [];
afterAll(async () => {
  await Promise.all(roots.map((dir) => rm(dir, { recursive: true, force: true })));
});

// ── 가짜 docker ──────────────────────────────────────────────────────────

interface Step {
  code?: number;
  out?: string;
  err?: string;
  /** 초. 응답하기 전에 쉰다 */
  sleep?: number;
}
type Script = Record<string, Step | Step[]>;

interface Side {
  dir: string;
  bin: string;
  state: string;
}

interface Env {
  dir: string;
  root: string;
  composePath: string;
  overridePath: string;
}

async function environment(): Promise<Env> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'snapshot-diff-')));
  roots.push(dir);
  const root = path.join(dir, 'proj');
  await mkdir(path.join(root, 'api'), { recursive: true });
  await mkdir(path.join(root, 'web'), { recursive: true });
  return { dir, root, composePath: path.join(root, 'compose.yaml'), overridePath: path.join(dir, 'compose.override.yaml') };
}

/**
 * 응답을 고르는 키(대본 키):
 *  - `volume inspect <이름>` → `vinspect@<이름>`, `volume inspect --format …` → `vinspectfmt`
 *  - `volume create … <이름>` → `vcreate@<이름>`, `volume rm [--force] <이름>` → `vrm@<이름>`, `volume ls` → `vls`
 *  - `run … --volume <이름>:… ` → `run@<첫 --volume의 이름>` (seed는 스냅샷, capture는 샌드박스 볼륨)
 *  - `inspect <컨테이너…>` → `inspect`, `stats …` → `stats`, `compose … ps …` → `ps`
 * 호출 기록은 인자 하나가 \037, 호출 하나가 \036으로 끝난다(`run`의 셸 스크립트 인자에 줄바꿈이 있다)
 */
async function fakeDocker(env: Env, kind: string, script: Script): Promise<Side> {
  const dir = path.join(env.dir, kind);
  const state = path.join(dir, 'state');
  const scripts = path.join(dir, 'script');
  await mkdir(state, { recursive: true });
  await mkdir(scripts, { recursive: true });
  const bin = path.join(dir, 'docker');
  await writeFile(
    bin,
    `#!/bin/sh
S='${state}'
D='${scripts}'
US=$(printf '\\037')
RS=$(printf '\\036')
line=""
for a in "$@"; do line="$line$a$US"; done
printf '%s%s' "$line" "$RS" >> "$S/calls"
key=other
case "$1" in
  volume)
    case "$2" in
      inspect) if [ "$3" = --format ]; then key=vinspectfmt; else key="vinspect@$3"; fi ;;
      create) for last in "$@"; do :; done; key="vcreate@$last" ;;
      rm) for last in "$@"; do :; done; key="vrm@$last" ;;
      ls) key=vls ;;
    esac ;;
  run)
    prev=""; first=""
    for a in "$@"; do
      if [ "$prev" = --volume ] && [ -z "$first" ]; then first="\${a%%:*}"; fi
      prev="$a"
    done
    key="run@$first" ;;
  inspect) key=inspect ;;
  stats) key=stats ;;
  compose) for a in "$@"; do case "$a" in ps) key=ps ;; esac; done ;;
esac
n=$(cat "$S/n.$key" 2>/dev/null || echo 0)
n=$((n + 1))
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
  // macOS는 새로 만든 실행 파일의 첫 실행을 검사하느라 수백 ms 걸릴 때가 있다. 시간 상한을 재는 시험이 그 시간에 걸리지 않도록 먼저 한 번 돌리고 흔적을 지운다
  execFileSync(bin, ['__warm-up__']);
  await rm(state, { recursive: true, force: true });
  await mkdir(state, { recursive: true });
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
  return { dir, bin, state };
}

const callsOf = (side: Side): string[][] => {
  let text = '';
  try {
    text = readFileSync(path.join(side.state, 'calls'), 'utf8');
  } catch {
    // 호출이 없었다
  }
  return text.split('\x1e').filter(Boolean).map((call) => call.split('\x1f').filter((_, index, all) => index < all.length - 1 || all[index] !== ''));
};

// ── 프로젝트와 맥락 ───────────────────────────────────────────────────────

const PROJECT_NAME = 'proj';
const SANDBOX_ID = 'studio-p';

interface ServiceSpec {
  service: string;
  path: string;
  snapshots: Array<{ volume: string; key: string[] }>;
}

const API: ServiceSpec = { service: 'api', path: 'api', snapshots: [{ volume: 'nm', key: ['package-lock.json'] }] };

function projectOf(env: Env, services: ServiceSpec[], sharedVolumes: string[] = []) {
  return {
    root: env.root,
    composePath: env.composePath,
    spec: { name: PROJECT_NAME },
    managed: services.map((item) => [item.service, { template: 'node', path: item.path, port: 3000, snapshots: item.snapshots }]),
    sharedVolumes,
  } as never as SnapshotContext['project'];
}

const snapshotOf = (service: string, volume: string, contents: Array<[string, string | undefined]>) =>
  snapshotName({ project: PROJECT_NAME, service, volume, files: contents.map(([file, content]) => ({ path: file, content: content === undefined ? undefined : Buffer.from(content) })) });

/** `api`의 키 파일에 `lock-v1`을 쓴다 */
async function writeKey(env: Env, content = 'lock-v1', service = 'api', file = 'package-lock.json'): Promise<void> {
  await writeFile(path.join(env.root, service, file), content);
}

const SNAP = snapshotOf('api', 'nm', [['package-lock.json', 'lock-v1']]);
const SANDBOX_VOLUME = `${SANDBOX_ID}_nm`;
const SLOT = 'proj/api/nm';

/** 한 쪽(옛 쪽, 새 쪽)이 같은 도구를 같은 모양으로 부르게 하는 껍데기 */
interface Tools {
  plan(): Promise<LegacySnapshotPlan[]>;
  seed(plan: LegacySnapshotPlan, options: { signal?: AbortSignal; onSnapshot: (event: SnapshotEvent) => void }): Promise<boolean>;
  capture(plan: LegacySnapshotPlan, options: { onSnapshot: (event: SnapshotEvent) => void }): Promise<void>;
  prune(plan: LegacySnapshotPlan): Promise<void> | undefined;
  shared(): Promise<void>;
  stats(statsTimeoutMs: number): Promise<ServiceUsage[]>;
}

function toolsFor(kind: 'legacy' | 'now', env: Env, side: Side, services: ServiceSpec[], sharedVolumes: string[], secrets: Record<string, string>): Tools {
  const project = projectOf(env, services, sharedVolumes);
  const dockerEnv = composeEnvironment(secrets);
  const redactor = new Redactor(secrets);
  const redact = (text: string) => redactor.redact(text);
  if (kind === 'legacy') {
    const legacy = (statsTimeoutMs: number): LegacySnapshotContext => ({
      id: SANDBOX_ID,
      project,
      dockerBin: side.bin,
      docker: (args, signal) => runCommand(side.bin, args, { signal, env: dockerEnv }),
      composeArgs: (args) => ['compose', '--project-name', SANDBOX_ID, '--project-directory', env.root, '--file', env.composePath, '--file', env.overridePath, ...args],
      redact,
      statsTimeoutMs,
    });
    return {
      plan: () => planSnapshotsLegacy(legacy(0)),
      seed: (plan, options) => seedSnapshotLegacy(legacy(0), plan, options),
      capture: (plan, options) => captureSnapshotLegacy(legacy(0), plan, options),
      prune: () => undefined,
      shared: () => ensureSharedVolumesLegacy(side.bin, sharedVolumes),
      stats: (ms) => statsLegacy(legacy(ms)),
    };
  }
  const ctx: SnapshotContext & { overridePath: string } = { id: SANDBOX_ID, project, dockerBin: side.bin, env: dockerEnv, overridePath: env.overridePath };
  return {
    plan: () => planSnapshots(ctx),
    seed: (plan, options) => seedSnapshot(ctx, plan, options),
    capture: (plan, options) => captureSnapshot(ctx, plan, options),
    prune: (plan) => pruneSnapshots(ctx, plan),
    shared: () => ensureSharedVolumes(side.bin, sharedVolumes),
    stats: (ms) => readStats(ctx, { statsTimeoutMs: ms, redact }),
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
  /** 이벤트와, 그 이벤트가 나왔을 때까지 부른 docker 호출 수 */
  events: Array<{ event: unknown; afterCalls: number }>;
  calls: string[][];
}

function describeError(error: unknown, side: Side, env: Env): Failure {
  const scrub = (text: string) => text.split(side.dir).join('<RUN>').split(env.dir).join('<ENV>');
  if (error instanceof ExecCheckedError) {
    return { constructorName: error.constructor.name, name: error.name, message: scrub(error.message), code: error.code, stdout: error.stdout, stderr: scrub(error.stderr) };
  }
  if (error instanceof SandboxError) return { constructorName: error.constructor.name, name: error.name, message: scrub(error.message), detail: error.detail, platform: error.platform };
  if (error instanceof Error) return { constructorName: error.constructor.name, name: error.name, message: scrub(error.message) };
  throw error;
}

function scrubCalls(calls: string[][], env: Env): string[][] {
  return calls.map((call) => call.map((arg) => arg.split(env.dir).join('<ENV>')));
}

/** 한 쪽을 처음부터 끝까지 돌린다. `run`은 도구를 불러 반환값을 돌려준다 */
async function observe(
  kind: 'legacy' | 'now',
  env: Env,
  script: Script,
  setup: { services?: ServiceSpec[]; shared?: string[]; secrets?: Record<string, string> },
  run: (tools: Tools, helpers: { onSnapshot: (event: SnapshotEvent) => void; side: Side }) => Promise<unknown>,
): Promise<Observed> {
  const side = await fakeDocker(env, kind, script);
  const tools = toolsFor(kind, env, side, setup.services ?? [API], setup.shared ?? [], setup.secrets ?? {});
  const events: Observed['events'] = [];
  const onSnapshot = (event: SnapshotEvent) => {
    const { elapsedMs, ...rest } = event as SnapshotEvent & { elapsedMs?: number };
    // 시간은 값을 견주지 않고 숫자(0 이상)인지만 본다
    events.push({ event: elapsedMs === undefined ? rest : { ...rest, elapsedMs: typeof elapsedMs === 'number' && elapsedMs >= 0 ? '<ms>' : elapsedMs }, afterCalls: callsOf(side).length });
  };
  const outcome: Observed['outcome'] = await run(tools, { onSnapshot, side }).then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error: describeError(error, side, env) }),
  );
  return { outcome, events, calls: scrubCalls(callsOf(side), env) };
}

async function both(
  setup: { services?: ServiceSpec[]; shared?: string[]; secrets?: Record<string, string>; prepare?: (env: Env) => Promise<void> },
  script: Script,
  run: (tools: Tools, helpers: { onSnapshot: (event: SnapshotEvent) => void; side: Side }) => Promise<unknown>,
) {
  const env = await environment();
  await (setup.prepare ?? ((e) => writeKey(e)))(env);
  const legacy = await observe('legacy', env, script, setup, run);
  const now = await observe('now', env, script, setup, run);
  return { legacy, now };
}

const sorted = (calls: string[][]) => [...calls].map((call) => JSON.stringify(call)).sort();

/** 한 계획으로 seed를 돌린다 */
const seedOnce = (options: { signal?: AbortSignal } = {}) => async (tools: Tools, { onSnapshot }: { onSnapshot: (event: SnapshotEvent) => void }) => {
  const [plan] = await tools.plan();
  return tools.seed(plan!, { ...options, onSnapshot });
};
const captureOnce = async (tools: Tools, { onSnapshot }: { onSnapshot: (event: SnapshotEvent) => void }) => {
  const [plan] = await tools.plan();
  await tools.capture(plan!, { onSnapshot });
  return 'captured-call-returned';
};

const IMAGE = 'busybox:1.37';
const SEED_SCRIPT = '[ -f /from/.b-studio-snapshot-complete ] || exit 3\ncp -a /from/. /to/ && rm -f /to/.b-studio-snapshot-complete';
const CAPTURE_SCRIPT = 'cp -a /from/. /to/ && touch /to/.b-studio-snapshot-complete';
const volumeRms = (calls: string[][]) => calls.filter((call) => call[0] === 'volume' && call[1] === 'rm');

// ── 계획 ─────────────────────────────────────────────────────────────────

describe('스냅샷 계획(#planSnapshots)', () => {
  it('키 파일을 읽어 이름을 만든다(옛 쪽과 같다)', async () => {
    const { legacy, now } = await both({}, {}, (tools) => tools.plan());
    expect(now).toEqual(legacy);
    const plans = (now.outcome as { ok: true; value: LegacySnapshotPlan[] }).value;
    expect(plans).toEqual([{ service: 'api', volume: 'nm', snapshot: SNAP, slot: SLOT, sandboxVolume: SANDBOX_VOLUME }]);
    // 계획은 docker를 부르지 않는다
    expect(now.calls).toEqual([]);
  });

  it('키 파일이 없으면 "없음"으로 이름을 만든다(없는 파일과 빈 파일은 다른 이름이다)', async () => {
    const missing = await both({ prepare: async () => {} }, {}, (tools) => tools.plan());
    expect(missing.now).toEqual(missing.legacy);
    expect((missing.now.outcome as { value: LegacySnapshotPlan[] }).value[0]!.snapshot).toBe(snapshotOf('api', 'nm', [['package-lock.json', undefined]]));
    const empty = await both({ prepare: (env) => writeKey(env, '') }, {}, (tools) => tools.plan());
    expect(empty.now).toEqual(empty.legacy);
    expect((empty.now.outcome as { value: LegacySnapshotPlan[] }).value[0]!.snapshot).not.toBe((missing.now.outcome as { value: LegacySnapshotPlan[] }).value[0]!.snapshot);
  });

  it('키 자리가 폴더이거나 읽을 수 없으면 없는 파일로 본다', async () => {
    const result = await both(
      { prepare: async (env) => void (await mkdir(path.join(env.root, 'api', 'package-lock.json'), { recursive: true })) },
      {},
      (tools) => tools.plan(),
    );
    expect(result.now).toEqual(result.legacy);
    expect((result.now.outcome as { value: LegacySnapshotPlan[] }).value[0]!.snapshot).toBe(snapshotOf('api', 'nm', [['package-lock.json', undefined]]));
  });

  it('여러 서비스·볼륨·키 파일, 접히는 경로(`./`·`..`), 링크, 키 없는 서비스', async () => {
    const services: ServiceSpec[] = [
      { service: 'api', path: 'api', snapshots: [{ volume: 'nm', key: ['package-lock.json', 'package.json', './sub/../.npmrc'] }, { volume: 'cache', key: ['package.json'] }] },
      { service: 'web', path: 'web/../web', snapshots: [{ volume: 'nm', key: ['pnpm-lock.yaml', 'linked.lock'] }] },
    ];
    const result = await both(
      {
        services,
        prepare: async (env) => {
          await writeFile(path.join(env.root, 'api', 'package-lock.json'), 'L');
          await writeFile(path.join(env.root, 'api', 'package.json'), '{}');
          await writeFile(path.join(env.root, 'api', '.npmrc'), 'registry=x');
          await writeFile(path.join(env.root, 'web', 'pnpm-lock.yaml'), 'lockfileVersion: 9');
          await writeFile(path.join(env.root, 'web', 'real.lock'), 'real');
          await symlink('real.lock', path.join(env.root, 'web', 'linked.lock'));
        },
      },
      {},
      (tools) => tools.plan(),
    );
    expect(result.now).toEqual(result.legacy);
    const plans = (result.now.outcome as { value: LegacySnapshotPlan[] }).value;
    expect(plans.map((plan) => `${plan.service}/${plan.volume}`)).toEqual(['api/nm', 'api/cache', 'web/nm']);
  });

  it('스냅샷을 정하지 않은 서비스는 계획이 없다', async () => {
    const result = await both({ services: [{ service: 'api', path: 'api', snapshots: [] }] }, {}, (tools) => tools.plan());
    expect(result.now).toEqual(result.legacy);
    expect((result.now.outcome as { value: unknown[] }).value).toEqual([]);
  });
});

// ── seed ─────────────────────────────────────────────────────────────────

describe('스냅샷으로 채우기(#seedSnapshot)', () => {
  it('스냅샷이 없으면 missing이고 더 부르지 않는다', async () => {
    const { legacy, now } = await both({}, { [`vinspect@${SNAP}`]: { code: 1, err: `Error response from daemon: get ${SNAP}: no such volume\n` } }, seedOnce());
    expect(now).toEqual(legacy);
    expect(now.outcome).toEqual({ ok: true, value: false });
    expect(now.events.map((item) => item.event)).toEqual([{ service: 'api', volume: 'nm', snapshot: SNAP, action: 'missing' }]);
    expect(now.calls).toEqual([['volume', 'inspect', SNAP]]);
  });

  it('seed가 끝나면 seeded다: inspect → create(compose 라벨) → 복사(--network none, 읽기 전용 원본)', async () => {
    const { legacy, now } = await both(
      {},
      {
        [`vinspect@${SNAP}`]: { out: `[\n    {\n        "CreatedAt": "2026-11-12T01:02:03Z",\n        "Driver": "local",\n        "Name": "${SNAP}"\n    }\n]\n` },
        [`vcreate@${SANDBOX_VOLUME}`]: { out: `${SANDBOX_VOLUME}\n` },
      },
      seedOnce(),
    );
    expect(now).toEqual(legacy);
    expect(now.outcome).toEqual({ ok: true, value: true });
    expect(now.events).toEqual([{ event: { service: 'api', volume: 'nm', snapshot: SNAP, action: 'seeded', elapsedMs: '<ms>' }, afterCalls: 3 }]);
    expect(now.calls).toEqual([
      ['volume', 'inspect', SNAP],
      ['volume', 'create', '--label', `com.docker.compose.project=${SANDBOX_ID}`, '--label', 'com.docker.compose.volume=nm', SANDBOX_VOLUME],
      ['run', '--rm', '--network', 'none', '--volume', `${SNAP}:/from:ro`, '--volume', `${SANDBOX_VOLUME}:/to`, IMAGE, 'sh', '-c', SEED_SCRIPT],
    ]);
    // 이 경로는 아무것도 지우지 않는다
    expect(volumeRms(now.calls)).toEqual([]);
  });

  it('volume create가 실패하면 이 샌드박스의 볼륨만 --force로 지우고 스냅샷은 지우지 않는다', async () => {
    const { legacy, now } = await both(
      {},
      { [`vcreate@${SANDBOX_VOLUME}`]: { code: 1, err: 'Error response from daemon: create: permission denied\n' } },
      seedOnce(),
    );
    expect(now).toEqual(legacy);
    expect(now.outcome).toEqual({ ok: true, value: false });
    expect(now.events.map((item) => item.event)).toEqual([{ service: 'api', volume: 'nm', snapshot: SNAP, action: 'failed', stage: 'seed', reason: 'Error response from daemon: create: permission denied' }]);
    expect(volumeRms(now.calls)).toEqual([['volume', 'rm', '--force', SANDBOX_VOLUME]]);
    expect(now.calls.some((call) => call[0] === 'run')).toBe(false);
  });

  it('복사가 종료 코드 3이면(표시 파일 없음) 샌드박스 볼륨은 --force로, 스냅샷은 --force 없이 지우고 이유를 알린다', async () => {
    const { legacy, now } = await both({}, { [`run@${SNAP}`]: { code: 3 } }, seedOnce());
    expect(now).toEqual(legacy);
    expect(now.outcome).toEqual({ ok: true, value: false });
    expect(now.events.map((item) => item.event)).toEqual([{ service: 'api', volume: 'nm', snapshot: SNAP, action: 'failed', stage: 'seed', reason: '스냅샷이 끝까지 저장되지 않았습니다' }]);
    // 지우는 자리는 정확히 둘이다: 이 샌드박스 볼륨(--force)과 그 스냅샷(--force 없음). 순서도 같다
    expect(volumeRms(now.calls)).toEqual([
      ['volume', 'rm', '--force', SANDBOX_VOLUME],
      ['volume', 'rm', SNAP],
    ]);
  });

  it('그 밖의 복사 실패는 샌드박스 볼륨만 지우고 stderr(앞뒤 공백 제거)를 이유로 알린다', async () => {
    const { legacy, now } = await both({}, { [`run@${SNAP}`]: { code: 1, err: 'cp: write error: No space left on device\n' } }, seedOnce());
    expect(now).toEqual(legacy);
    expect(now.events.map((item) => item.event)).toEqual([{ service: 'api', volume: 'nm', snapshot: SNAP, action: 'failed', stage: 'seed', reason: 'cp: write error: No space left on device' }]);
    expect(volumeRms(now.calls)).toEqual([['volume', 'rm', '--force', SANDBOX_VOLUME]]);
  });

  it('복사가 stderr 없이 실패하면 이유는 `exit <코드>`다', async () => {
    const { legacy, now } = await both({}, { [`run@${SNAP}`]: { code: 2 } }, seedOnce());
    expect(now).toEqual(legacy);
    expect((now.events[0]!.event as { reason: string }).reason).toBe('exit 2');
    expect(volumeRms(now.calls)).toEqual([['volume', 'rm', '--force', SANDBOX_VOLUME]]);
  });

  it('복사가 종료 코드 125(docker 자체 오류)여도 스냅샷은 지우지 않는다', async () => {
    const { legacy, now } = await both({}, { [`run@${SNAP}`]: { code: 125, err: 'docker: Error response from daemon: image not found\n' } }, seedOnce());
    expect(now).toEqual(legacy);
    expect(volumeRms(now.calls)).toEqual([['volume', 'rm', '--force', SANDBOX_VOLUME]]);
  });

  it('inspect 중에 취소하면 옛 쪽처럼 missing으로 끝나고 더 부르지 않는다', async () => {
    const run = async (tools: Tools, { onSnapshot }: { onSnapshot: (event: SnapshotEvent) => void }) => {
      const controller = new AbortController();
      const [plan] = await tools.plan();
      setTimeout(() => controller.abort(), 150);
      return tools.seed(plan!, { signal: controller.signal, onSnapshot });
    };
    const { legacy, now } = await both({}, { [`vinspect@${SNAP}`]: { sleep: 5 } }, run);
    expect(now).toEqual(legacy);
    expect(now.outcome).toEqual({ ok: true, value: false });
    expect(now.events.map((item) => (item.event as { action: string }).action)).toEqual(['missing']);
    expect(now.calls).toEqual([['volume', 'inspect', SNAP]]);
  });

  it('HARDENED: volume create가 종료 코드 3으로 끝나도 스냅샷은 지우지 않는다(표시 파일이 없다는 뜻은 복사 단계의 3뿐이다)', async () => {
    const { legacy, now } = await both({}, { [`vcreate@${SANDBOX_VOLUME}`]: { code: 3, err: '' } }, seedOnce());
    // 옛 쪽은 create의 3을 "끝까지 저장되지 않음"으로 읽어 멀쩡한 스냅샷을 지웠다
    expect(volumeRms(legacy.calls)).toEqual([
      ['volume', 'rm', '--force', SANDBOX_VOLUME],
      ['volume', 'rm', SNAP],
    ]);
    expect(volumeRms(now.calls)).toEqual([['volume', 'rm', '--force', SANDBOX_VOLUME]]);
    expect(now.events.map((item) => item.event)).toEqual([{ service: 'api', volume: 'nm', snapshot: SNAP, action: 'failed', stage: 'seed', reason: 'exit 3' }]);
    expect(now.outcome).toEqual(legacy.outcome);
  });

  it('여러 계획을 동시에 seed해도 볼륨마다 같은 호출을 낸다(호출 순서는 정렬해 견준다)', async () => {
    const services: ServiceSpec[] = [API, { service: 'web', path: 'web', snapshots: [{ volume: 'nm', key: ['pnpm-lock.yaml'] }] }];
    const web = snapshotOf('web', 'nm', [['pnpm-lock.yaml', 'web-lock']]);
    const run = async (tools: Tools, { onSnapshot }: { onSnapshot: (event: SnapshotEvent) => void }) => {
      const plans = await tools.plan();
      return Promise.all(plans.map((plan) => tools.seed(plan, { onSnapshot })));
    };
    const { legacy, now } = await both(
      {
        services,
        prepare: async (env) => {
          await writeKey(env);
          await writeFile(path.join(env.root, 'web', 'pnpm-lock.yaml'), 'web-lock');
        },
      },
      { [`vinspect@${SNAP}`]: { code: 1, err: 'no such volume\n' }, [`run@${web}`]: { code: 3 } },
      run,
    );
    expect(now.outcome).toEqual(legacy.outcome);
    expect(now.outcome).toEqual({ ok: true, value: [false, false] });
    expect(sorted(now.calls)).toEqual(sorted(legacy.calls));
    const eventsOf = (observed: typeof now) => observed.events.map((item) => JSON.stringify(item.event)).sort();
    expect(eventsOf(now)).toEqual(eventsOf(legacy));
    // 서비스마다 부른 순서는 같다
    for (const name of [SNAP, web]) {
      const pick = (calls: string[][]) => calls.filter((call) => call.some((arg) => arg.startsWith(name)));
      expect(pick(now.calls)).toEqual(pick(legacy.calls));
    }
    expect(volumeRms(now.calls).map((call) => call.join(' ')).sort()).toEqual([`volume rm ${web}`, `volume rm --force ${SANDBOX_ID}_nm`].sort());
  });
});

// ── capture·prune ────────────────────────────────────────────────────────

/** 같은 자리의 스냅샷 볼륨 목록(`volume ls --quiet`)과 만든 시각(`volume inspect --format '{{.Name}} {{.CreatedAt}}'`) */
const listing = (entries: Array<[string, string]>): Script => ({
  vls: { out: entries.map(([name]) => `${name}\n`).join('') },
  vinspectfmt: { out: entries.map(([name, created]) => `${name} ${created}\n`).join('') },
});

describe('스냅샷 저장(#captureSnapshot)과 정리(#pruneSnapshots)', () => {
  it('저장에 성공하면 captured를 알리고, 같은 자리의 최근 2개만 남긴다(오래된 것은 --force 없이 지운다)', async () => {
    const OLD = 'b-studio-snapshot-aaaaaaaaaaaaaaaaaaaaaaaa';
    const MID = 'b-studio-snapshot-bbbbbbbbbbbbbbbbbbbbbbbb';
    const { legacy, now } = await both(
      {},
      {
        [`vinspect@${SNAP}`]: { code: 1, err: 'no such volume\n' },
        [`vcreate@${SNAP}`]: { out: `${SNAP}\n` },
        ...listing([
          [MID, '2026-11-10T00:00:00Z'],
          [SNAP, '2026-11-12T00:00:00Z'],
          [OLD, '2026-11-01T00:00:00Z'],
        ]),
      },
      captureOnce,
    );
    expect(now).toEqual(legacy);
    expect(now.events).toEqual([{ event: { service: 'api', volume: 'nm', snapshot: SNAP, action: 'captured', elapsedMs: '<ms>' }, afterCalls: 3 }]);
    expect(now.calls).toEqual([
      ['volume', 'inspect', SNAP],
      ['volume', 'create', '--label', 'b-studio.snapshot=true', '--label', `b-studio.snapshot.slot=${SLOT}`, SNAP],
      ['run', '--rm', '--network', 'none', '--volume', `${SANDBOX_VOLUME}:/from:ro`, '--volume', `${SNAP}:/to`, IMAGE, 'sh', '-c', CAPTURE_SCRIPT],
      ['volume', 'ls', '--quiet', '--filter', `label=b-studio.snapshot.slot=${SLOT}`],
      ['volume', 'inspect', '--format', '{{.Name}} {{.CreatedAt}}', MID, SNAP, OLD],
      ['volume', 'rm', OLD],
    ]);
    // 지우는 자리는 정확히 하나다: 라벨 필터 결과 중 오래된 것, --force 없음
    expect(volumeRms(now.calls)).toEqual([['volume', 'rm', OLD]]);
  });

  it('같은 자리에 2개 이하면 inspect도 rm도 부르지 않는다', async () => {
    const { legacy, now } = await both(
      {},
      { [`vinspect@${SNAP}`]: { code: 1 }, ...listing([[SNAP, '2026-11-12T00:00:00Z'], ['b-studio-snapshot-aaaaaaaaaaaaaaaaaaaaaaaa', '2026-11-01T00:00:00Z']]) },
      captureOnce,
    );
    expect(now).toEqual(legacy);
    expect(now.calls.at(-1)).toEqual(['volume', 'ls', '--quiet', '--filter', `label=b-studio.snapshot.slot=${SLOT}`]);
    expect(volumeRms(now.calls)).toEqual([]);
  });

  it('3개를 넘으면 가장 오래된 것부터 지운다(4개면 둘을 순서대로)', async () => {
    const names = ['a', 'b', 'c', 'd'].map((letter) => `b-studio-snapshot-${letter.repeat(24)}`);
    const { legacy, now } = await both(
      {},
      {
        [`vinspect@${SNAP}`]: { code: 1 },
        ...listing([
          [names[2]!, '2026-11-03T00:00:00Z'],
          [names[0]!, '2026-11-01T00:00:00Z'],
          [SNAP, '2026-11-12T00:00:00Z'],
          [names[1]!, '2026-11-02T00:00:00Z'],
        ]),
      },
      captureOnce,
    );
    expect(now).toEqual(legacy);
    expect(volumeRms(now.calls)).toEqual([
      ['volume', 'rm', names[1]!],
      ['volume', 'rm', names[0]!],
    ]);
  });

  it('지우기가 실패해도(다른 샌드박스가 쓰는 중) 다음 것을 계속 지우고 저장은 성공이다', async () => {
    const names = ['a', 'b', 'c'].map((letter) => `b-studio-snapshot-${letter.repeat(24)}`);
    const { legacy, now } = await both(
      {},
      {
        [`vinspect@${SNAP}`]: { code: 1 },
        ...listing([
          [SNAP, '2026-11-12T00:00:00Z'],
          [names[0]!, '2026-11-01T00:00:00Z'],
          [names[1]!, '2026-11-02T00:00:00Z'],
          [names[2]!, '2026-11-03T00:00:00Z'],
        ]),
        [`vrm@${names[1]!}`]: { code: 1, err: `Error response from daemon: remove ${names[1]!}: volume is in use - [abc]\n` },
      },
      captureOnce,
    );
    expect(now).toEqual(legacy);
    expect(volumeRms(now.calls)).toEqual([
      ['volume', 'rm', names[1]!],
      ['volume', 'rm', names[0]!],
    ]);
    expect(now.events.map((item) => (item.event as { action: string }).action)).toEqual(['captured']);
  });

  it('그사이 다른 세션이 이미 만들었으면 그것을 쓴다: 만들지도 알리지도 정리하지도 않는다', async () => {
    const { legacy, now } = await both({}, { [`vinspect@${SNAP}`]: { out: '[]\n' } }, captureOnce);
    expect(now).toEqual(legacy);
    expect(now.events).toEqual([]);
    expect(now.calls).toEqual([['volume', 'inspect', SNAP]]);
  });

  it('스냅샷 볼륨을 만들지 못하면 failed(capture)로 알리고 아무것도 지우지 않는다', async () => {
    const { legacy, now } = await both({}, { [`vinspect@${SNAP}`]: { code: 1 }, [`vcreate@${SNAP}`]: { code: 1, err: 'Error response from daemon: create: no space\n' } }, captureOnce);
    expect(now).toEqual(legacy);
    expect(now.events.map((item) => item.event)).toEqual([
      { service: 'api', volume: 'nm', snapshot: SNAP, action: 'failed', stage: 'capture', reason: '스냅샷 볼륨을 만들지 못했습니다\nError response from daemon: create: no space: Error response from daemon: create: no space' },
    ]);
    expect(volumeRms(now.calls)).toEqual([]);
  });

  it('만들지 못한 이유(stderr)가 비어 있으면 이유는 오류 이름과 글이다', async () => {
    const { legacy, now } = await both({}, { [`vinspect@${SNAP}`]: { code: 1 }, [`vcreate@${SNAP}`]: { code: 1 } }, captureOnce);
    expect(now).toEqual(legacy);
    expect((now.events[0]!.event as { reason: string }).reason).toBe('SandboxError: 스냅샷 볼륨을 만들지 못했습니다');
  });

  it('복사에 실패하면 그 스냅샷만 --force로 지우고 failed(capture)로 알린다(정리하지 않는다)', async () => {
    const { legacy, now } = await both(
      {},
      { [`vinspect@${SNAP}`]: { code: 1 }, [`run@${SANDBOX_VOLUME}`]: { code: 1, err: 'cp: read error: I/O error\n' }, ...listing([[SNAP, '2026-11-12T00:00:00Z']]) },
      captureOnce,
    );
    expect(now).toEqual(legacy);
    expect(volumeRms(now.calls)).toEqual([['volume', 'rm', '--force', SNAP]]);
    expect(now.events.map((item) => item.event)).toEqual([
      { service: 'api', volume: 'nm', snapshot: SNAP, action: 'failed', stage: 'capture', reason: '스냅샷을 복사하지 못했습니다\ncp: read error: I/O error: cp: read error: I/O error' },
    ]);
    expect(now.calls.some((call) => call[1] === 'ls')).toBe(false);
  });

  it('같은 스냅샷을 동시에 두 번 저장하면 두 번째는 아무것도 하지 않는다', async () => {
    const run = async (tools: Tools, { onSnapshot }: { onSnapshot: (event: SnapshotEvent) => void }) => {
      const [plan] = await tools.plan();
      await Promise.all([tools.capture(plan!, { onSnapshot }), tools.capture(plan!, { onSnapshot })]);
      // 끝난 뒤에는 다시 저장할 수 있다
      await tools.capture(plan!, { onSnapshot });
      return 'done';
    };
    const { legacy, now } = await both({}, { [`vinspect@${SNAP}`]: [{ code: 1, sleep: 0.3 }, { code: 0 }], ...listing([[SNAP, '2026-11-12T00:00:00Z']]) }, run);
    expect(now).toEqual(legacy);
    // 첫 저장은 inspect(없음) 뒤 create·run·ls, 둘째 호출은 막혔고, 셋째는 inspect(있음)에서 끝난다
    expect(now.calls.filter((call) => call[1] === 'create')).toHaveLength(1);
    expect(now.calls.filter((call) => call[1] === 'inspect' && call[2] === SNAP)).toHaveLength(2);
  });

  it('목록을 읽지 못하면(비0 종료) 정리하지 않는다', async () => {
    const { legacy, now } = await both({}, { [`vinspect@${SNAP}`]: { code: 1 }, vls: { code: 1, err: 'Cannot connect to the Docker daemon\n' } }, captureOnce);
    expect(now).toEqual(legacy);
    expect(volumeRms(now.calls)).toEqual([]);
    expect(now.calls.some((call) => call[1] === 'inspect' && call[2] === '--format')).toBe(false);
  });

  it('만든 시각을 읽지 못하는 항목(날짜가 아닌 글)은 가장 오래된 것으로 본다', async () => {
    const names = ['a', 'b'].map((letter) => `b-studio-snapshot-${letter.repeat(24)}`);
    const { legacy, now } = await both(
      {},
      { [`vinspect@${SNAP}`]: { code: 1 }, ...listing([[SNAP, '2026-11-12T00:00:00Z'], [names[0]!, 'unknown'], [names[1]!, '2026-11-02T00:00:00Z']]) },
      captureOnce,
    );
    expect(now).toEqual(legacy);
    expect(volumeRms(now.calls)).toEqual([['volume', 'rm', names[0]!]]);
  });

  it('Date.parse가 읽는 다른 시각 모양도 같게 읽는다(옛 쪽과 같은 해석)', async () => {
    const names = ['a', 'b', 'c'].map((letter) => `b-studio-snapshot-${letter.repeat(24)}`);
    const { legacy, now } = await both(
      {},
      {
        [`vinspect@${SNAP}`]: { code: 1 },
        ...listing([
          [SNAP, '2026-11-12T09:00:00+09:00'],
          [names[0]!, '2026-11-11T23:59:59.999Z'],
          [names[1]!, '2026-11-11T23:59:59.5+00:00'],
          [names[2]!, '2026-11-01'],
        ]),
      },
      captureOnce,
    );
    expect(now).toEqual(legacy);
    expect(volumeRms(now.calls)).toEqual([['volume', 'rm', names[1]!], ['volume', 'rm', names[2]!]]);
  });

  it('HARDENED: 정리는 방금 저장한 스냅샷과 라벨 필터에 없는 이름은 지우지 않는다', async () => {
    const OTHER = 'b-studio-snapshot-cccccccccccccccccccccccc';
    const names = ['a', 'b'].map((letter) => `b-studio-snapshot-${letter.repeat(24)}`);
    // 방금 저장한 SNAP의 시각을 읽지 못하는 경우(가장 오래된 것으로 읽힌다)와, inspect 출력에 목록에 없던 이름이 끼어든 경우
    const script: Script = {
      [`vinspect@${SNAP}`]: { code: 1 },
      vls: { out: `${SNAP}\n${names[0]!}\n${names[1]!}\n` },
      vinspectfmt: { out: `${SNAP} not-a-date\n${names[0]!} 2026-11-01T00:00:00Z\n${names[1]!} 2026-11-02T00:00:00Z\n${OTHER} 2026-10-01T00:00:00Z\n` },
    };
    const { legacy, now } = await both({}, script, captureOnce);
    // 옛 쪽은 방금 저장한 것과 목록에 없던 이름까지 지운다
    expect(volumeRms(legacy.calls).map((call) => call[2]).sort()).toEqual([OTHER, SNAP].sort());
    expect(volumeRms(now.calls)).toEqual([]);
    expect(now.events.map((item) => (item.event as { action: string }).action)).toEqual(['captured']);
  });

  it('정리만 따로 불러도 같은 결과다(스냅샷 계획의 자리를 쓴다)', async () => {
    const names = ['a', 'b', 'c'].map((letter) => `b-studio-snapshot-${letter.repeat(24)}`);
    const env = await environment();
    await writeKey(env);
    const script = listing([[SNAP, '2026-11-12T00:00:00Z'], [names[0]!, '2026-11-01T00:00:00Z'], [names[1]!, '2026-11-02T00:00:00Z'], [names[2]!, '2026-11-03T00:00:00Z']]);
    const side = await fakeDocker(env, 'now', script);
    const tools = toolsFor('now', env, side, [API], [], {});
    const [plan] = await tools.plan();
    await tools.prune(plan!);
    expect(volumeRms(callsOf(side))).toEqual([['volume', 'rm', names[1]!], ['volume', 'rm', names[0]!]]);
  });
});

// ── 공유 볼륨 ─────────────────────────────────────────────────────────────

describe('공유 볼륨 만들기(#ensureSharedVolumes)', () => {
  it('external 볼륨마다 캐시 라벨을 붙여 만든다', async () => {
    const { legacy, now } = await both({ shared: ['b-studio-cache-uv', 'shared'] }, { 'vcreate@shared': { out: 'shared\n' } }, (tools) => tools.shared());
    // 동시에 부르므로 호출 순서는 정렬해 견준다
    expect(now.outcome).toEqual(legacy.outcome);
    expect(sorted(now.calls)).toEqual(sorted(legacy.calls));
    expect(now.outcome).toEqual({ ok: true, value: undefined });
    expect(sorted(now.calls)).toEqual(sorted([['volume', 'create', '--label', 'b-studio.cache=true', 'b-studio-cache-uv'], ['volume', 'create', '--label', 'b-studio.cache=true', 'shared']]));
  });

  it('없으면 부르지 않는다', async () => {
    const { legacy, now } = await both({ shared: [] }, {}, (tools) => tools.shared());
    expect(now).toEqual(legacy);
    expect(now.calls).toEqual([]);
  });

  it('만들지 못하면 옛 `execFile`처럼 던진다(글·종류·종료 코드·출력이 같다)', async () => {
    const { legacy, now } = await both({ shared: ['shared'] }, { 'vcreate@shared': { code: 1, out: 'partial\n', err: 'Error response from daemon: volume name is invalid\n' } }, (tools) => tools.shared());
    expect(now).toEqual(legacy);
    expect(now.outcome).toMatchObject({ ok: false, error: { constructorName: 'ExecCheckedError', code: 1, stdout: 'partial\n', stderr: 'Error response from daemon: volume name is invalid\n' } });
    expect((now.outcome as { error: Failure }).error.message).toBe('Command failed: <RUN>/docker volume create --label b-studio.cache=true shared\nError response from daemon: volume name is invalid\n');
  });

  it('종료 코드는 그대로 오류에 담긴다(1이 아닌 코드도)', async () => {
    const { legacy, now } = await both({ shared: ['shared'] }, { 'vcreate@shared': { code: 7, err: 'weird\n' } }, (tools) => tools.shared());
    expect(now).toEqual(legacy);
    expect(now.outcome).toMatchObject({ ok: false, error: { code: 7 } });
  });

  it('여럿 중 하나만 실패해도 던지고, 나머지는 끝까지 만든다', async () => {
    const { legacy, now } = await both({ shared: ['ok-one', 'bad', 'ok-two'] }, { 'vcreate@bad': { code: 1, err: 'nope\n' } }, async (tools, { side }) => {
      try {
        await tools.shared();
        return 'no error';
      } finally {
        // 던진 뒤에도 남은 호출이 끝나길 기다린다(옛 쪽은 던진 뒤에도 돌고 있다)
        await new Promise((resolve) => setTimeout(resolve, 300));
        void side;
      }
    });
    expect(now.outcome).toEqual(legacy.outcome);
    expect(sorted(now.calls)).toEqual(sorted(legacy.calls));
    expect(now.calls).toHaveLength(3);
  });

  it('docker를 띄우지 못하면 `spawn … ENOENT`로 던진다', async () => {
    const env = await environment();
    const bin = path.join(env.dir, 'no-such-docker');
    const caught = async (run: () => Promise<void>) => run().then(() => undefined, (error: unknown) => describeError(error, { dir: env.dir, bin, state: '' }, env));
    const legacy = await caught(() => ensureSharedVolumesLegacy(bin, ['shared']));
    const now = await caught(() => ensureSharedVolumes(bin, ['shared']));
    expect(now).toEqual(legacy);
    expect(now).toMatchObject({ constructorName: 'ExecCheckedError', code: 1 });
    expect(now?.stderr).toContain('ENOENT');
  });
});

// ── stats ────────────────────────────────────────────────────────────────

const container = (id: string, name: string, service: string, status: string, extra: Record<string, unknown> = {}) => ({
  Id: id,
  Name: `/${name}`,
  State: { Status: status, Running: status === 'running', ExitCode: status === 'exited' ? 137 : 0, OOMKilled: false, StartedAt: '2026-11-12T01:00:00.123456789Z', ...(status === 'running' ? { Health: { Status: 'healthy' } } : {}) },
  Config: { Labels: { 'com.docker.compose.service': service, 'com.docker.compose.project': SANDBOX_ID } },
  HostConfig: { Memory: 536870912, NanoCpus: 500000000 },
  RestartCount: 1,
  ...extra,
});
const statsLine = (name: string, cpu: string, mem: string, net: string) =>
  `${JSON.stringify({ BlockIO: '0B / 0B', CPUPerc: cpu, Container: name, ID: name, MemPerc: '4.2%', MemUsage: mem, Name: name, NetIO: net, PIDs: '9' })}\n`;

const STATS_OK: Script = {
  ps: { out: 'aaa111\nbbb222\nccc333\n' },
  inspect: {
    out: `${JSON.stringify([
      container('aaa111', `${SANDBOX_ID}-api-1`, 'api', 'running'),
      container('bbb222', `${SANDBOX_ID}-edge-1`, EDGE_SERVICE, 'running'),
      container('ccc333', `${SANDBOX_ID}-db-1`, 'db', 'exited'),
    ])}\n`,
  },
  stats: { out: statsLine(`${SANDBOX_ID}-api-1`, '12.50%', '43.12MiB / 512MiB', '28.8kB / 23.4kB') + statsLine(`${SANDBOX_ID}-edge-1`, '0.10%', '9.5MiB / 1GiB', '1.2MB / 2kB') },
};

const readStatsFor = (statsTimeoutMs = 5_000) => (tools: Tools) => tools.stats(statsTimeoutMs);

describe('사용량 읽기(stats)', () => {
  it('컨테이너가 없으면 빈 목록이다(stats는 부르지 않는다)', async () => {
    const { legacy, now } = await both({}, { ps: { out: '' } }, readStatsFor());
    expect(now).toEqual(legacy);
    expect(now.outcome).toEqual({ ok: true, value: [] });
    expect(now.calls).toHaveLength(1);
    expect(now.calls[0]!.slice(0, 5)).toEqual(['compose', '--project-name', SANDBOX_ID, '--project-directory', '<ENV>/proj']);
    expect(now.calls[0]!.slice(-3)).toEqual(['ps', '--all', '--quiet']);
  });

  it('실행 중인 컨테이너만 stats를 묻고 서비스 사용량과 합친다', async () => {
    const { legacy, now } = await both({}, STATS_OK, readStatsFor());
    expect(now).toEqual(legacy);
    const usage = (now.outcome as { value: ServiceUsage[] }).value;
    expect(usage.map((row) => [row.service, row.state, row.role])).toEqual([['api', 'running', 'managed'], [EDGE_SERVICE, 'running', 'platform'], ['db', 'exited', 'supporting']]);
    expect(now.calls.map((call) => call[0])).toEqual(['compose', 'inspect', 'stats']);
    expect(now.calls[1]).toEqual(['inspect', 'aaa111', 'bbb222', 'ccc333']);
    expect(now.calls[2]).toEqual(['stats', '--no-stream', '--format', '{{json .}}', `${SANDBOX_ID}-api-1`, `${SANDBOX_ID}-edge-1`]);
  });

  it('실행 중인 컨테이너가 없으면 stats를 부르지 않는다', async () => {
    const script: Script = {
      ...STATS_OK,
      inspect: { out: `${JSON.stringify([container('aaa111', `${SANDBOX_ID}-api-1`, 'api', 'exited'), container('bbb222', `${SANDBOX_ID}-db-1`, 'db', 'exited')])}\n` },
    };
    const { legacy, now } = await both({}, script, readStatsFor());
    expect(now).toEqual(legacy);
    expect(now.calls.map((call) => call[0])).toEqual(['compose', 'inspect']);
    expect((now.outcome as { value: ServiceUsage[] }).value.every((row) => row.cpuPercent === undefined)).toBe(true);
  });

  it('stats가 실패하면 오류가 아니라 사용량 없이 돌려준다', async () => {
    const { legacy, now } = await both({}, { ...STATS_OK, stats: { code: 1, err: 'Error response from daemon: stats unavailable\n' } }, readStatsFor());
    expect(now).toEqual(legacy);
    expect((now.outcome as { value: ServiceUsage[] }).value.find((row) => row.service === 'api')).toMatchObject({ state: 'running' });
    expect((now.outcome as { value: ServiceUsage[] }).value.find((row) => row.service === 'api')?.cpuPercent).toBeUndefined();
  });

  it('stats가 비0으로 끝나면 stdout에 줄이 있어도 사용량으로 쓰지 않는다', async () => {
    const script: Script = { ...STATS_OK, stats: { code: 1, out: statsLine(`${SANDBOX_ID}-api-1`, '12.50%', '43.12MiB / 512MiB', '28.8kB / 23.4kB'), err: 'partial\n' } };
    const { legacy, now } = await both({}, script, readStatsFor());
    expect(now).toEqual(legacy);
    expect((now.outcome as { value: ServiceUsage[] }).value.every((row) => row.cpuPercent === undefined)).toBe(true);
  });

  it('목록을 읽지 못하면 오류다(빈 목록이 아니다). 시크릿은 가린다', async () => {
    const { legacy, now } = await both(
      { secrets: { API_TOKEN: 'sk-live-secret-value' } },
      { ps: { code: 1, err: 'Cannot connect to the Docker daemon at unix:///x.sock (token sk-live-secret-value)\n' } },
      readStatsFor(),
    );
    expect(now).toEqual(legacy);
    expect(now.outcome).toMatchObject({ ok: false, error: { constructorName: 'SandboxError', message: `컨테이너 목록을 읽지 못했습니다 (${SANDBOX_ID})\nCannot connect to the Docker daemon at unix:///x.sock (token [API_TOKEN 가림])`, platform: true } });
    expect(JSON.stringify(now.outcome)).not.toContain('sk-live-secret-value');
  });

  it('목록 조회가 시간 안에 끝나지 않으면 "응답하지 않았습니다" 오류다', async () => {
    const { legacy, now } = await both({}, { ps: { sleep: 5, out: 'aaa111\n' } }, readStatsFor(300));
    expect(now).toEqual(legacy);
    expect(now.outcome).toMatchObject({ ok: false, error: { constructorName: 'SandboxError', detail: '도커가 0.3초 안에 응답하지 않았습니다', platform: true } });
    expect(now.calls).toHaveLength(1);
  });

  it('inspect를 읽지 못하면 오류다', async () => {
    const { legacy, now } = await both({}, { ...STATS_OK, inspect: { code: 1, err: 'Error: No such object: aaa111\n' } }, readStatsFor());
    expect(now).toEqual(legacy);
    expect(now.outcome).toMatchObject({ ok: false, error: { message: `컨테이너 상태를 읽지 못했습니다 (${SANDBOX_ID})\nError: No such object: aaa111`, platform: true } });
  });

  it('inspect가 시간 안에 끝나지 않으면 "응답하지 않았습니다" 오류다', async () => {
    const { legacy, now } = await both({}, { ...STATS_OK, inspect: { sleep: 5 } }, readStatsFor(400));
    expect(now).toEqual(legacy);
    expect(now.outcome).toMatchObject({ ok: false, error: { message: `컨테이너 상태를 읽지 못했습니다 (${SANDBOX_ID})\n도커가 0.4초 안에 응답하지 않았습니다`, platform: true } });
  });

  it('stats가 시간 안에 끝나지 않으면 사용량을 읽지 못했다는 오류다', async () => {
    const { legacy, now } = await both({}, { ...STATS_OK, stats: { sleep: 5 } }, readStatsFor(500));
    expect(now).toEqual(legacy);
    expect(now.outcome).toMatchObject({ ok: false, error: { message: `컨테이너 사용량을 읽지 못했습니다 (${SANDBOX_ID})\n도커가 0.5초 안에 응답하지 않았습니다`, platform: true } });
  });

  it('inspect 출력을 읽지 못하면 그 해석 오류를 그대로 던진다', async () => {
    const { legacy, now } = await both({}, { ...STATS_OK, inspect: { out: 'this is not json\n' } }, readStatsFor());
    expect(now).toEqual(legacy);
    expect(now.outcome).toMatchObject({ ok: false, error: { constructorName: 'Error' } });
  });

  it('stats 출력을 읽지 못하면 그 해석 오류를 그대로 던진다', async () => {
    const { legacy, now } = await both({}, { ...STATS_OK, stats: { out: '{"Name":"x","NetIO":5}\n' } }, readStatsFor());
    expect(now).toEqual(legacy);
    expect(now.outcome).toMatchObject({ ok: false });
  });

  it('HARDENED: inspect 오류 글의 시크릿도 가린다(옛 쪽은 목록 오류만 가렸다)', async () => {
    const script: Script = { ...STATS_OK, inspect: { code: 1, err: 'Error: boom sk-live-secret-value\n' } };
    const { legacy, now } = await both({ secrets: { API_TOKEN: 'sk-live-secret-value' } }, script, readStatsFor());
    expect(JSON.stringify(legacy.outcome)).toContain('sk-live-secret-value');
    expect(JSON.stringify(now.outcome)).not.toContain('sk-live-secret-value');
    expect((now.outcome as { error: Failure }).error.message).toBe(`컨테이너 상태를 읽지 못했습니다 (${SANDBOX_ID})\nError: boom [API_TOKEN 가림]`);
    expect((now.outcome as { error: Failure }).error.platform).toBe(true);
  });
});

// 시험이 쓰는 모듈 값이 맞는지(오타로 둘 다 같은 잘못을 하지 않게)
describe('기준값', () => {
  it('seed·capture 스크립트와 이미지는 진짜 값이다', async () => {
    const source = await readFile(path.join(__dirname, 'snapshot-legacy.ts'), 'utf8');
    expect(source).toContain('SYNC_HELPER_IMAGE');
    expect(IMAGE).toBe('busybox:1.37');
  });
});
