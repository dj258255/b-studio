import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LoadedProject } from '@b-studio/spec';
import { afterAll, describe, expect, it } from 'vitest';
import { parse, stringify } from 'yaml';
import { SandboxError } from '../errors';
import { composeEnvironment } from './compose-env';
import { EDGE_SERVICE, EGRESS_NETWORK, SANDBOX_NETWORK, buildOverride } from './format';
import type { MaskVolume } from './git-mask';
import { computeGitMask, loadGitMask } from './git-mask';
import { computeGitMaskLegacy, loadGitMaskLegacy } from './git-mask-legacy';
import { overrideInputJson, upWithGitMask, writeComposeOverride } from './up-loop';
import { upOnceLegacy } from './up-loop-legacy';

/**
 * 컨테이너 만들기 반복(ADR-195 4f A4c-1)의 차등 시험: 옛 TS(`up-loop-legacy.ts`: `#upOnce`·`#refreshGitMask`·`#writeOverride`)와 지금(Rust 함수 하나 +
 * TS 껍데기)이 같은 가짜 docker에 같은 결과(반환값 또는 같은 글·detail·platform의 오류), 같은 docker 호출 순서, 같은 마지막 마스크,
 * 같은 override 내용(YAML로 읽은 값)을 내는지 본다. 진짜 docker는 쓰지 않는다 — 가짜 docker는 준비한 출력을 호출 순서대로 내놓는 셸 스크립트다.
 * 옛 쪽과 다른 점은 모두 "더 막는 쪽"이고 아래 `HARDENED` 표시가 붙은 입력에서만 나온다(그 밖의 입력은 한 글자도 다르지 않아야 한다).
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
  copy: string;
  bin: string;
  scriptDir: string;
}

const TARGET = '/app/tests/acceptance';
const SERVICE_LABEL = 'com.docker.compose.service';

async function environment(): Promise<Env> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'up-diff-')));
  roots.push(dir);
  const root = path.join(dir, 'proj');
  await mkdir(path.join(root, '.git', 'b-studio'), { recursive: true });
  await writeFile(path.join(root, '.git', 'config'), '[core]\n\tbare = false\n[b-studio]\n\tstart = abc\n');
  await mkdir(path.join(root, 'tests'), { recursive: true });
  await writeFile(path.join(root, 'tests', 'acceptance'), 'x');
  const copy = path.join(dir, 'copy');
  await writeFile(copy, 'x');
  const scriptDir = path.join(dir, 'script');
  await mkdir(scriptDir);
  const bin = path.join(dir, 'docker');
  await writeFile(
    bin,
    `#!/bin/sh
S="$FAKE_STATE"
D="$FAKE_SCRIPT"
printf '%s\\n' "$*" >> "$S/calls"
key=other
case "$1" in
  inspect) key=inspect; [ "$2" = --format ] && key=state ;;
  volume) key=volume ;;
  rm) key=rm ;;
  start) key=startid ;;
  compose) for a in "$@"; do case "$a" in config) key=config ;; up) key=up ;; ps) key=ps ;; down) key=down ;; start) key=start ;; esac; done ;;
esac
n=$(cat "$S/n.$key" 2>/dev/null || echo 0)
n=$((n + 1))
ov=""
for a in "$@"; do case "$a" in *compose.override.yaml) ov="$a" ;; esac; done
if [ "$key" = up ] || [ "$key" = start ]; then [ -f "$ov" ] && cp "$ov" "$S/ov.$key.$n"; fi
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
  return { dir, root, copy, bin, scriptDir };
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

const mask = (source: string, target: string): MaskVolume => ({ type: 'bind', source, target, read_only: true, bind: { create_host_path: false } });
const json = (value: unknown) => JSON.stringify(value);

const composeConfig = (env: Env, extra: Record<string, unknown> = {}, services: string[] = ['api']) => ({
  services: Object.fromEntries(
    services.map((name, index) => [name, { volumes: [{ type: 'bind', source: env.root, target: '/app' }], ...(index > 0 ? { depends_on: { [services[0]!]: { condition: 'service_started' } } } : {}) }]),
  ),
  ...extra,
});
/** 프로젝트를 `/app`이 아닌 자리에 마운트한 설정(마운트가 바뀌었다는 것을 마스크의 target 변화로 보인다) */
const movedConfig = (env: Env, target: string) => ({ services: { api: { volumes: [{ type: 'bind', source: env.root, target }] } } });

const labelOf = (service: string) => ({ [SERVICE_LABEL]: service });
function container(id: string, service: string, mounts: object[], extra: Record<string, unknown> = {}) {
  return { Id: id, Name: `/${id}`, Config: { Labels: labelOf(service) }, HostConfig: { NetworkMode: 'studio-p_b-studio-sandbox' }, NetworkSettings: { Networks: { 'studio-p_b-studio-sandbox': {} } }, Mounts: mounts, ...extra };
}
const baseMounts = (env: Env, target = '/app') => [
  { Type: 'bind', Source: env.root, Destination: target, RW: true },
  { Type: 'bind', Source: path.join(env.root, '.git'), Destination: `${target}/.git`, RW: false },
  { Type: 'bind', Source: path.join(env.root, '.git', 'b-studio-empty'), Destination: `${target}/.git/b-studio`, RW: false },
];
const assetMount = (env: Env) => ({ Type: 'bind', Source: env.copy, Destination: TARGET, RW: false });

/** 기본 스크립트: 서비스 하나(api), 컨테이너 하나(c1), 모두 통과 */
const base = (env: Env): Script => ({
  config: { out: json(composeConfig(env)) },
  up: {},
  ps: { out: 'c1\n' },
  inspect: { out: json([container('c1', 'api', baseMounts(env))]) },
  volume: { out: '[]' },
  startid: {},
  start: {},
  down: {},
});

const two = (env: Env): Script => ({
  ...base(env),
  config: { out: json(composeConfig(env, {}, ['api', 'worker'])) },
  ps: { out: 'c1\nc2\n' },
  inspect: { out: json([container('c1', 'api', baseMounts(env)), container('c2', 'worker', baseMounts(env))]) },
});

interface Scenario {
  name: string;
  script: (env: Env) => Script;
  /** `up` 인자. 기본은 서비스 하나를 이름으로 준 up(확인한 컨테이너의 id로 시작) */
  args?: string[];
  assets?: boolean;
  /** 처음 override 파일에 쓰여 있는 마스크. 기본은 비어 있다 */
  initial?: (env: Env) => Promise<Record<string, MaskVolume[]>>;
  /** 옛 쪽보다 더 막는 의도한 차이가 있는 입력 */
  hardened?: boolean;
  /** 기다리는 횟수가 시간에 달려 있다(연속으로 같은 상태 조회는 한 번으로 본다) */
  timing?: boolean;
  /** 이미 취소된 신호로, 또는 도는 도중에 취소한다 */
  abort?: 'before' | 'during-up';
  /** 준비 단계에서 환경을 더 만진다 */
  prepare?: (env: Env) => Promise<void>;
  /** override를 쓸 수 없게 한다(폴더가 없다) */
  brokenOverrideDir?: boolean;
  hostPorts?: Record<string, number>;
}

type Outcome = { ok: true; exitCode: number; stdout: string; stderr: string } | { ok: false; name: string; message: string; detail: string | undefined; platform: boolean };

function outcomeOf(error: unknown): Outcome {
  if (error instanceof SandboxError) return { ok: false, name: error.name, message: error.message, detail: error.detail, platform: error.platform };
  if (error instanceof Error) return { ok: false, name: error.name, message: error.message, detail: undefined, platform: false };
  throw error;
}

interface Observed {
  outcome: Outcome;
  calls: string[];
  mask: Record<string, MaskVolume[]>;
  /** `up`·`start`을 부른 순간의 override(YAML로 읽은 값) */
  overrides: Record<string, unknown>;
  finalOverride: unknown;
  leftovers: string[];
}

const project = (env: Env): LoadedProject =>
  ({
    spec: { name: 'p' },
    root: env.root,
    composePath: path.join(env.root, 'compose.yaml'),
    managed: [['api', { template: 'node', path: '.', port: 3000 }]],
    composeServices: ['api'],
    sharedVolumes: [],
    external: [],
  }) as unknown as LoadedProject;

const redact = (text: string) => text.replace('SECRET', '***');

async function observe(kind: 'legacy' | 'now', scenario: Scenario, env: Env): Promise<Observed> {
  const runDir = path.join(env.dir, kind);
  const state = path.join(runDir, 'state');
  await mkdir(state, { recursive: true });
  const overridePath = scenario.brokenOverrideDir ? path.join(runDir, 'missing', 'compose.override.yaml') : path.join(runDir, 'compose.override.yaml');
  const dockerEnv = { PATH: process.env.PATH, FAKE_STATE: state, FAKE_SCRIPT: env.scriptDir };
  const proj = project(env);
  const edgeScript = '// edge\nconsole.log("x");\n';
  const hostPorts = scenario.hostPorts ?? {};
  const evaluationAssets = scenario.assets ? [{ path: 'tests/acceptance', source: env.copy }] : [];
  const initial = scenario.initial ? await scenario.initial(env) : {};
  // 처음 쓰기(생성 때의 쓰기와 같다). 옛 쪽은 YAML, 새 쪽은 Rust 쓰개(JSON)
  if (!scenario.brokenOverrideDir) {
    if (kind === 'legacy') await writeFile(overridePath, stringify(buildOverride(proj, 'studio-p', { edgeScript, runtime: undefined, hostPorts, gitMask: initial })));
    else await writeComposeOverride(overridePath, overrideInputJson(proj, 'studio-p', { edgeScript, runtime: undefined, hostPorts }), initial);
  }
  const controller = new AbortController();
  if (scenario.abort === 'before') controller.abort();
  if (scenario.abort === 'during-up') {
    // 가짜 docker가 만들기(up)를 시작하면(상태 폴더에 호출 횟수 파일이 생긴다) 취소한다
    const timer = setInterval(() => {
      readFile(path.join(state, 'n.up'), 'utf8').then(
        () => {
          clearInterval(timer);
          controller.abort();
        },
        () => {},
      );
    }, 5);
    setTimeout(() => clearInterval(timer), 20_000).unref();
  }
  const args = scenario.args ?? ['up', '--detach', '--no-deps', 'api'];
  let latest = initial;
  let outcome: Outcome;
  if (kind === 'legacy') {
    const context = {
      id: 'studio-p',
      project: proj,
      dockerBin: env.bin,
      env: dockerEnv,
      overridePath,
      edgeScript,
      runtime: undefined,
      hostPorts,
      evaluationAssets,
      dependencyPollMs: 1,
      dependencyWaitMs: 50,
      redact,
      state: { gitMask: initial },
    };
    outcome = await upOnceLegacy(context, args, controller.signal).then(
      (result) => ({ ok: true as const, ...result }),
      (error: unknown) => outcomeOf(error),
    );
    latest = context.state.gitMask;
  } else {
    outcome = await upWithGitMask({
      id: 'studio-p',
      project: proj,
      dockerBin: env.bin,
      env: dockerEnv,
      overridePath,
      overrideInput: overrideInputJson(proj, 'studio-p', { edgeScript, runtime: undefined, hostPorts }),
      gitMask: initial,
      evaluationAssets,
      args,
      sandboxNetwork: SANDBOX_NETWORK,
      egressNetwork: EGRESS_NETWORK,
      edgeService: EDGE_SERVICE,
      serviceLabel: SERVICE_LABEL,
      pollMs: 1,
      waitMs: 50,
      signal: controller.signal,
      redact,
      onMask: (next) => {
        latest = next;
      },
    }).then(
      (result) => ({ ok: true as const, ...result }),
      (error: unknown) => outcomeOf(error),
    );
  }
  const calls = (await readFile(path.join(state, 'calls'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map((line) => line.split(runDir).join('<RUN>').split(env.dir).join('<ENV>'));
  const overrides: Record<string, unknown> = {};
  for (const name of (await readdir(state)).filter((file) => file.startsWith('ov.')).sort()) overrides[name] = parse(await readFile(path.join(state, name), 'utf8'));
  const finalOverride = scenario.brokenOverrideDir ? undefined : parse(await readFile(overridePath, 'utf8'));
  const leftovers = (await readdir(path.dirname(overridePath)).catch(() => [])).filter((file) => file.endsWith('.tmp'));
  return { outcome, calls, mask: latest, overrides, finalOverride, leftovers };
}

async function both(scenario: Scenario): Promise<{ legacy: Observed; now: Observed; env: Env }> {
  const env = await environment();
  await install(env, scenario.script(env));
  if (scenario.prepare) await scenario.prepare(env);
  const legacy = await observe('legacy', scenario, env);
  const now = await observe('now', scenario, env);
  return { legacy, now, env };
}

const computed = (env: Env) => computeGitMaskLegacy(env.root, composeConfig(env));
const TWO = ['up', '--detach', '--no-deps', 'api', 'worker'];

const scenarios: Scenario[] = [
  { name: '정상: 처음 마스크가 비어 있어 한 번 쓴다', script: base },
  { name: '정상: 처음 마스크가 계산한 값과 같아 쓰지 않는다', script: base, initial: computed },
  { name: '정상: 서비스 둘(의존 순서대로 id로 시작)', script: two, args: TWO },
  { name: '정상: 전체 up은 compose start로 시작한다', script: base, args: ['up', '--detach', '--remove-orphans'] },
  { name: '정상: 만들기 옵션(--build, --force-recreate)은 만들기 단계에만 간다', script: base, args: ['up', '--detach', '--build', '--no-deps', '--force-recreate', 'api'] },
  { name: '정상: 평가 자산이 있고 복사본이 마운트돼 있다', assets: true, script: (env) => ({ ...base(env), inspect: { out: json([container('c1', 'api', [...baseMounts(env), assetMount(env)])]) } }) },
  { name: '정상: 공개 주소용 호스트 포트가 override에 들어간다', script: base, hostPorts: { api: 41234 } },
  // compose config
  { name: 'config 첫 호출이 비0 종료(시크릿은 가린다)', script: (env) => ({ ...base(env), config: { code: 1, err: 'invalid SECRET' } }) },
  { name: 'config 첫 호출의 stderr가 비어 있다', script: (env) => ({ ...base(env), config: { code: 1 } }) },
  { name: 'config 출력을 해석하지 못함', script: (env) => ({ ...base(env), config: { out: 'not json' } }) },
  { name: 'config 출력이 null', script: (env) => ({ ...base(env), config: { out: 'null' } }) },
  { name: 'config 출력이 비어 있다', script: (env) => ({ ...base(env), config: { out: '' } }) },
  { name: 'config의 서비스 volumes 모양을 모름', script: (env) => ({ ...base(env), config: { out: json({ services: { api: { volumes: 'x' } } }) } }) },
  { name: 'config의 volumes_from이 compose 밖 컨테이너를 가리킴', script: (env) => ({ ...base(env), config: { out: json({ services: { api: { volumes_from: ['container:x'] } } }) } }) },
  { name: 'config의 services가 없다(빈 마스크로 계속한다)', script: (env) => ({ ...base(env), config: { out: '{}' }, inspect: { out: json([container('c1', 'api', [])]) } }) },
  { name: 'config의 volumes에 호스트 폴더에 묶인 이름 있는 볼륨', script: (env) => ({ ...base(env), config: { out: json({ services: { api: { volumes: [{ type: 'volume', source: 'host', target: '/app' }] } }, volumes: { host: { driver: 'local', driver_opts: { type: 'none', o: 'bind', device: env.root } } } }) } }) },
  { name: 'config 둘째 호출(만든 뒤)이 비0 종료', script: (env) => ({ ...base(env), config: [{ out: json(composeConfig(env)) }, { code: 1, err: 'later SECRET' }] }) },
  { name: 'config 둘째 호출을 해석하지 못함', script: (env) => ({ ...base(env), config: [{ out: json(composeConfig(env)) }, { out: '{' }] }) },
  // 만들기
  { name: '만들기(up --no-start)가 비0 종료: 그 결과를 돌려준다', script: (env) => ({ ...base(env), up: { code: 1, out: 'o', err: 'build failed' } }) },
  { name: '만들기 뒤 compose 파일이 바뀜: 처음부터 다시 한다', script: (env) => ({ ...base(env), config: [{ out: json(composeConfig(env)) }, { out: json(movedConfig(env, '/work')) }, { out: json(movedConfig(env, '/work')) }], inspect: { out: json([container('c1', 'api', baseMounts(env, '/work'))]) } }) },
  {
    name: '마스크가 시도 안에서 계속 바뀜: 내리고 던진다',
    script: (env) => ({ ...base(env), config: ['/a', '/b', '/c', '/d', '/e', '/f', '/g'].map((target) => ({ out: json(movedConfig(env, target)) })) }),
  },
  { name: '시작 전 확인 뒤에도 안정(두 번째 시도에서 안정)', script: (env) => ({ ...base(env), config: [{ out: json(composeConfig(env)) }, { out: json(movedConfig(env, '/work')) }, { out: json(movedConfig(env, '/work')) }, { out: json(movedConfig(env, '/work')) }], inspect: { out: json([container('c1', 'api', baseMounts(env, '/work'))]) } }) },
  // 마스크 계산
  { name: '평가 자산 자리 위에 tmpfs가 있다', assets: true, script: (env) => ({ ...base(env), config: { out: json({ services: { api: { volumes: [{ type: 'bind', source: env.root, target: '/app' }], tmpfs: [TARGET] } } }) } }) },
  { name: '평가 자산 자리 안쪽에 깊은 마운트가 있다', assets: true, script: (env) => ({ ...base(env), config: { out: json({ services: { api: { volumes: [{ type: 'bind', source: env.root, target: '/app' }, { type: 'bind', source: '/other', target: `${TARGET}/inner` }] } } }) } }) },
  {
    name: '상태 폴더 자리를 비울 수 없다(안에 내용이 있다)',
    script: base,
    prepare: async (env) => {
      await mkdir(path.join(env.root, '.git', 'b-studio-empty'), { recursive: true });
      await writeFile(path.join(env.root, '.git', 'b-studio-empty', 'x'), 'x');
    },
  },
  // 확인
  { name: '만든 컨테이너가 보이지 않는다', script: (env) => ({ ...base(env), ps: { out: '\n' } }) },
  { name: '컨테이너 목록이 비0 종료', script: (env) => ({ ...base(env), ps: { code: 1, err: 'daemon SECRET' } }) },
  { name: 'inspect가 비0 종료', script: (env) => ({ ...base(env), inspect: { code: 1, err: 'boom SECRET' } }) },
  { name: '.git 읽기 전용 마운트가 빠졌다(지운다)', script: (env) => ({ ...base(env), inspect: { out: json([container('c1', 'api', [baseMounts(env)[0]!])]) } }) },
  { name: '권한 상승(privileged)은 정책 위반이다', script: (env) => ({ ...base(env), inspect: { out: json([container('c1', 'api', baseMounts(env), { HostConfig: { Privileged: true, NetworkMode: 'studio-p_b-studio-sandbox' } })]) } }) },
  { name: '지우기가 비0 종료', script: (env) => ({ ...base(env), inspect: { out: json([container('c1', 'api', [baseMounts(env)[0]!])]) }, rm: { code: 1, err: 'denied' } }) },
  { name: '평가 자산 복사본 마운트가 빠졌다', assets: true, script: base },
  {
    name: '시작한 뒤의 확인에서 가림이 빠졌다(내렸습니다)',
    script: (env) => ({ ...base(env), inspect: [{ out: json([container('c1', 'api', baseMounts(env))]) }, { out: json([container('c1', 'api', [baseMounts(env)[0]!])]) }] }),
  },
  { name: '시작한 뒤의 확인에서 컨테이너가 사라졌다', script: (env) => ({ ...base(env), ps: [{ out: 'c1\n' }, { out: '\n' }] }) },
  { name: '볼륨 inspect가 비0 종료', script: (env) => ({ ...base(env), inspect: { out: json([container('c1', 'api', [...baseMounts(env), { Type: 'volume', Name: 'db', Destination: '/data', RW: true }])]) }, volume: { code: 1, err: 'vol SECRET' } }) },
  // 시작
  { name: '시작(docker start)이 비0 종료: 그 결과를 돌려준다', script: (env) => ({ ...base(env), startid: { code: 1, err: 'port is already allocated' } }) },
  { name: '전체 up의 compose start가 비0 종료', script: (env) => ({ ...base(env), start: { code: 1, err: 'bind' } }), args: ['up', '--detach'] },
  { name: '확인한 목록에 없는 서비스는 시작하지 않는다', script: base, args: ['up', '--detach', '--no-deps', 'ghost'] },
  { name: '서비스 둘: 의존 순서를 읽지 못함(config 비0)', script: (env) => ({ ...two(env), config: [{ out: json(composeConfig(env, {}, ['api', 'worker'])) }, { out: json(composeConfig(env, {}, ['api', 'worker'])) }, { code: 1, err: 'deps SECRET' }] }), args: TWO },
  { name: '서비스 둘: 의존 순서를 읽지 못함(config 비0, stderr 없음)', script: (env) => ({ ...two(env), config: [{ out: json(composeConfig(env, {}, ['api', 'worker'])) }, { out: json(composeConfig(env, {}, ['api', 'worker'])) }, { code: 1 }] }), args: TWO },
  { name: '서비스 둘: 의존 순서 출력을 해석하지 못함', script: (env) => ({ ...two(env), config: [{ out: json(composeConfig(env, {}, ['api', 'worker'])) }, { out: json(composeConfig(env, {}, ['api', 'worker'])) }, { out: 'x' }] }), args: TWO },
  {
    name: '서비스 둘: 의존 서비스가 healthy가 될 때까지 기다린다',
    script: (env) => ({
      ...two(env),
      config: { out: json({ services: { api: { volumes: [{ type: 'bind', source: env.root, target: '/app' }] }, worker: { volumes: [{ type: 'bind', source: env.root, target: '/app' }], depends_on: { api: { condition: 'service_healthy' } } } } }) },
      state: [{ out: '{"Status":"running","Health":{"Status":"starting"}}\n' }, { out: '{"Status":"running","Health":{"Status":"healthy"}}\n' }],
    }),
    args: TWO,
  },
  {
    name: '서비스 둘: healthy가 되지 않아 시간이 지난다',
    script: (env) => ({
      ...two(env),
      config: { out: json({ services: { api: { volumes: [{ type: 'bind', source: env.root, target: '/app' }] }, worker: { volumes: [{ type: 'bind', source: env.root, target: '/app' }], depends_on: { api: { condition: 'service_healthy' } } } } }) },
      state: { out: '{"Status":"running","Health":{"Status":"starting"}}\n' },
    }),
    args: TWO,
    timing: true,
  },
  // 취소
  { name: '이미 취소된 신호: 아무것도 부르지 않고 던진다', script: base, abort: 'before' },
  { name: '만드는 도중 취소: compose의 실패처럼 돌려준다', script: (env) => ({ ...base(env), up: { sleep: 2 } }), abort: 'during-up' },
];

const collapse = (calls: string[]) => calls.filter((call, index) => !(call.startsWith('inspect --format') && calls[index - 1] === call));

const same = (legacy: Observed, now: Observed, timing = false) => {
  expect(now.outcome).toEqual(legacy.outcome);
  expect(timing ? collapse(now.calls) : now.calls).toEqual(timing ? collapse(legacy.calls) : legacy.calls);
  expect(now.mask).toEqual(legacy.mask);
  expect(now.overrides).toEqual(legacy.overrides);
  expect(now.finalOverride).toEqual(legacy.finalOverride);
};

/** 마스크에 든 볼륨이 override 파일의 서비스 볼륨과 같다(쓴 것 = 확인한 것) */
function maskInOverride(override: unknown): Record<string, unknown> {
  const services = ((override as { services?: Record<string, { volumes?: unknown[] }> }).services ?? {}) as Record<string, { volumes?: unknown[] }>;
  return Object.fromEntries(Object.entries(services).filter(([, service]) => service.volumes !== undefined).map(([name, service]) => [name, service.volumes]));
}

describe('up_with_git_mask가 옛 #upOnce와 같다', () => {
  it.each(scenarios.map((scenario) => [scenario.name, scenario] as const))('%s', async (_name, scenario) => {
    const { legacy, now } = await both(scenario);
    same(legacy, now, scenario.timing);
    // 쓴 것 = 확인한 것: 돌려준 마스크가 마지막으로 쓴 override의 마스크 볼륨과 같다. 쓴 적이 없으면(초기값) 처음 쓴 값이다
    if (now.finalOverride !== undefined && Object.keys(now.mask).length > 0) expect(maskInOverride(now.finalOverride)).toEqual(now.mask);
    // 임시 파일이 남지 않는다
    expect(now.leftovers).toEqual([]);
  }, 60_000);

  it('시나리오 수', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(45);
  });
});

describe('HARDENED: 옛 쪽보다 더 막는 의도한 차이', () => {
  it('override를 쓰지 못하면 던지고 마스크를 올리지 않는다(옛 쪽은 파일에 쓰지 못한 마스크를 상태에 올렸다)', async () => {
    const { legacy, now } = await both({ name: 'x', script: base, brokenOverrideDir: true });
    expect(legacy.outcome.ok).toBe(false);
    expect(now.outcome.ok).toBe(false);
    // 옛 쪽: 쓰기가 실패했는데 상태는 새 마스크였다 → 다음 up이 같은 마스크를 "이미 쓴 것"으로 보고 옛 파일로 만들 수 있었다
    expect(Object.keys(legacy.mask).length).toBeGreaterThan(0);
    // 새 쪽: 파일에 쓰이지 못했으므로 상태는 처음 그대로다
    expect(now.mask).toEqual({});
    if (!now.outcome.ok) {
      expect(now.outcome.name).toBe('SandboxError');
      expect(now.outcome.message).toContain('compose override 파일을 쓰지 못했습니다');
      expect(now.outcome.platform).toBe(true);
    }
    // 아무것도 만들지 않았다
    expect(now.calls.filter((call) => call.includes(' up '))).toEqual([]);
  });

  it.each(['[]', '5', '"x"', 'true'])('compose config의 최상위가 객체가 아니면(%s) 모른다(옛 쪽은 서비스 없음으로 읽었다)', async (output) => {
    const { legacy, now } = await both({ name: 'x', script: (env) => ({ ...base(env), config: { out: output } }) });
    expect(legacy.outcome.ok).toBe(true);
    expect(now.outcome).toMatchObject({ ok: false, message: 'compose 설정(config --format json)을 해석하지 못해 서비스 컨테이너의 .git 보호를 정할 수 없습니다' });
    expect(now.calls.filter((call) => call.includes(' up '))).toEqual([]);
  });

  it('override를 만들지 못하면(입력의 모양이 어긋남) 옛 buildOverride가 던지던 오류와 같은 글이다', async () => {
    const env = await environment();
    const proj = project(env);
    const bad = { edgeScript: '', runtime: undefined, hostPorts: { api: 'x' as unknown as number } };
    const legacy = (() => {
      try {
        buildOverride(proj, 'studio-p', { ...bad, gitMask: {} });
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    })();
    expect(legacy).toBeDefined();
    const target = path.join(env.dir, 'compose.override.yaml');
    await expect(writeComposeOverride(target, overrideInputJson(proj, 'studio-p', bad), {})).rejects.toThrow(legacy!);
    // 파일을 만들지 않았다
    await expect(readFile(target, 'utf8')).rejects.toThrow();
  });

  it('override는 JSON으로 쓰고 YAML로 읽은 값이 옛 YAML과 같다', async () => {
    const { legacy, now, env } = await both({ name: 'x', script: base });
    const text = await readFile(path.join(env.dir, 'now', 'compose.override.yaml'), 'utf8');
    expect(text.startsWith('{')).toBe(true);
    expect(JSON.parse(text)).toEqual(now.finalOverride);
    expect(now.finalOverride).toEqual(legacy.finalOverride);
  });

  it('YAML이 거부하거나 줄바꿈으로 접는 글자도 같은 값으로 읽힌다', async () => {
    const env = await environment();
    const edgeScript = 'a\u007fb\u0085c\u2028d\u2029e\ufeffz\u009fé\u{1f600}\n\t"q"\\';
    const proj = project(env);
    const target = path.join(env.dir, 'compose.override.yaml');
    await writeComposeOverride(target, overrideInputJson(proj, 'studio-p', { edgeScript, runtime: undefined, hostPorts: {} }), {});
    const text = await readFile(target, 'utf8');
    // YAML 파서(yaml 패키지)가 읽은 값이 옛 YAML 직렬화를 읽은 값과 같다
    const written = parse(text) as { services: Record<string, { command: string[] }> };
    const legacy = parse(stringify(buildOverride(proj, 'studio-p', { edgeScript, runtime: undefined, hostPorts: {}, gitMask: {} }))) as { services: Record<string, { command: string[] }> };
    expect(written).toEqual(legacy);
    // 위험한 글자는 글 그대로 들어 있지 않다
    for (const raw of ['\u007f', '\u0085', '\u2028', '\u2029', '\ufeff', '\u009f']) expect(text).not.toContain(raw);
    for (const escaped of ['\\u007f', '\\u0085', '\\u2028', '\\u2029', '\\ufeff', '\\u009f']) expect(text).toContain(escaped);
  });
});

describe('loadGitMask·computeGitMask 껍데기가 옛 TS와 같다', () => {
  it('compose config를 읽어 같은 마스크를 낸다', async () => {
    const env = await environment();
    await install(env, base(env));
    const state = path.join(env.dir, 'state');
    await mkdir(state);
    const dockerEnv = { PATH: process.env.PATH, FAKE_STATE: state, FAKE_SCRIPT: env.scriptDir };
    const proj = project(env);
    const options = { dockerBin: env.bin, env: dockerEnv, projectName: 'studio-p', evaluationAssets: [{ path: 'tests/acceptance', source: env.copy }], redact };
    expect(await loadGitMask(proj, options)).toEqual(await loadGitMaskLegacy(proj, options));
    expect(await loadGitMask(proj, { ...options, projectName: undefined })).toEqual(await loadGitMaskLegacy(proj, { ...options, projectName: undefined }));
  });

  it('config 실패의 오류 글이 같다', async () => {
    const env = await environment();
    await install(env, { ...base(env), config: { code: 1, err: 'bad SECRET' } });
    const state = path.join(env.dir, 'state');
    await mkdir(state);
    const dockerEnv = { PATH: process.env.PATH, FAKE_STATE: state, FAKE_SCRIPT: env.scriptDir };
    const options = { dockerBin: env.bin, env: dockerEnv, projectName: 'studio-p', redact };
    const legacy = await loadGitMaskLegacy(project(env), options).catch((error: unknown) => outcomeOf(error));
    const now = await loadGitMask(project(env), options).catch((error: unknown) => outcomeOf(error));
    expect(now).toEqual(legacy);
  });

  it('computeGitMask: 같은 입력에 같은 마스크, 같은 오류', async () => {
    const env = await environment();
    const configs = [composeConfig(env), composeConfig(env, {}, ['api', 'worker']), { services: { api: { volumes: 'x' } } }, { services: {} }];
    for (const config of configs) {
      const legacy = await computeGitMaskLegacy(env.root, config as never).catch((error: unknown) => outcomeOf(error));
      const now = await computeGitMask(env.root, config as never).catch((error: unknown) => outcomeOf(error));
      expect(now).toEqual(legacy);
    }
    const assets = [{ path: 'tests/acceptance', source: env.copy }];
    const nested = { services: { api: { volumes: [{ type: 'bind', source: env.root, target: '/app' }], tmpfs: [TARGET] } } };
    for (const config of [composeConfig(env), nested]) {
      const legacy = await computeGitMaskLegacy(env.root, config as never, { evaluationAssets: assets }).catch((error: unknown) => outcomeOf(error));
      const now = await computeGitMask(env.root, config as never, { evaluationAssets: assets }).catch((error: unknown) => outcomeOf(error));
      expect(now).toEqual(legacy);
    }
  });
});

describe('무작위 조합에서 옛 쪽과 같다', () => {
  function rng(seed: number) {
    return () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
  }

  it('40개 조합(config가 바뀜·실패, 만들기·시작 실패, 확인 실패, 서비스 둘)', async () => {
    const next = rng(20261112);
    const pick = <T>(items: T[]): T => items[Math.floor(next() * items.length)]!;
    for (let index = 0; index < 40; index++) {
      const twoServices = next() < 0.3;
      const scenario: Scenario = {
        name: `random-${index}`,
        args: twoServices ? TWO : undefined,
        assets: next() < 0.4,
        initial: next() < 0.3 ? computed : undefined,
        script: (env) => {
          const targets = ['/app', '/work', '/srv'];
          const configs = Array.from({ length: 8 }, () => {
            const roll = next();
            if (roll < 0.1) return { code: 1, err: 'bad SECRET' };
            if (roll < 0.15) return { out: 'garbage' };
            return { out: json(movedConfig(env, next() < 0.7 ? '/app' : pick(targets))) };
          });
          // 서비스 하나일 때 첫 config는 정상 설정이 많아야 시작까지 간다
          configs[0] = next() < 0.8 ? { out: json(movedConfig(env, '/app')) } : configs[0]!;
          const mounts = baseMounts(env, pick(targets));
          const inspectMounts = next() < 0.75 ? mounts : [mounts[0]!];
          const tweak = next();
          const host = { NetworkMode: 'studio-p_b-studio-sandbox', ...(tweak < 0.08 ? { Privileged: true } : {}) };
          const extraMount = [] as object[];
          return {
            ...(twoServices ? two(env) : base(env)),
            config: twoServices ? { out: json(composeConfig(env, {}, ['api', 'worker'])) } : configs,
            up: next() < 0.1 ? { code: 1, err: 'build' } : {},
            ps: { out: twoServices ? 'c1\nc2\n' : 'c1\n' },
            inspect: {
              out: json(twoServices ? [container('c1', 'api', inspectMounts, { HostConfig: host }), container('c2', 'worker', inspectMounts)] : [container('c1', 'api', [...inspectMounts, ...extraMount], { HostConfig: host })]),
            },
            startid: next() < 0.1 ? { code: 1, err: 'port' } : {},
          };
        },
      };
      const { legacy, now } = await both(scenario);
      try {
        same(legacy, now);
      } catch (error) {
        throw new Error(`${scenario.name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }, 600_000);
});
