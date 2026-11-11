import { chmod, mkdir, mkdtemp, realpath, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SandboxError } from '../errors';
import type { ExecResult } from '../types';
import type { MaskVolume } from './git-mask';
import { EDGE_SERVICE, EGRESS_NETWORK, SANDBOX_NETWORK } from './format';
import { startVerifiedContainers, verifyContainers } from './verify-containers';
import { startVerifiedLegacy, verifyMasksLegacy, type LegacyContext } from './verify-containers-legacy';

/**
 * 컨테이너 사후 확인(ADR-195 4f A4b)의 차등 시험: 옛 TS(`verify-containers-legacy.ts`)와 지금(Rust 함수 하나 + TS 껍데기)이
 * 같은 가짜 docker 출력에 같은 결과(확인한 컨테이너 또는 같은 글·detail·platform의 오류, 지운 id)를 내는지 본다.
 * 진짜 docker는 쓰지 않는다 — 가짜 docker는 준비한 출력을 그대로 내놓는 셸 스크립트이고, 옛 쪽은 같은 출력을 함수로 돌려준다.
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
}
interface Script {
  list: Step;
  inspect?: Step;
  volume?: Step;
  rm?: Step;
}

interface Env {
  dir: string;
  root: string;
  copy: string;
  bin: string;
  calls: () => Promise<string[]>;
}

const TARGET = '/app/tests/acceptance';

async function environment(): Promise<Env> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'verify-diff-')));
  roots.push(dir);
  const root = path.join(dir, 'proj');
  await mkdir(path.join(root, '.git', 'b-studio'), { recursive: true });
  await mkdir(path.join(root, 'tests'), { recursive: true });
  await writeFile(path.join(root, 'tests', 'acceptance'), 'x');
  const copy = path.join(dir, 'copy');
  await writeFile(copy, 'x');
  const bin = path.join(dir, 'docker');
  await writeFile(
    bin,
    `#!/bin/sh
D='${dir}'
printf '%s\\n' "$*" >> "$D/calls"
key=$1
[ "$1" = volume ] && key=volume
[ "$1" = compose ] && key=list
[ -f "$D/$key.out" ] && cat "$D/$key.out"
[ -f "$D/$key.err" ] && cat "$D/$key.err" >&2
code=0
[ -f "$D/$key.code" ] && code=$(cat "$D/$key.code")
exit $code
`,
  );
  await chmod(bin, 0o755);
  return { dir, root, copy, bin, calls: async () => (await readFile(path.join(dir, 'calls'), 'utf8').catch(() => '')).split('\n').filter(Boolean) };
}

async function install(env: Env, script: Script): Promise<void> {
  for (const [key, step] of Object.entries(script) as Array<[string, Step | undefined]>) {
    if (!step) continue;
    await writeFile(path.join(env.dir, `${key}.out`), step.out ?? '');
    await writeFile(path.join(env.dir, `${key}.err`), step.err ?? '');
    await writeFile(path.join(env.dir, `${key}.code`), String(step.code ?? 0));
  }
}

function legacyDocker(script: Script, calls: string[]): LegacyContext['docker'] {
  return async (args) => {
    calls.push(args.join(' '));
    const step = args[0] === 'compose' ? script.list : args[0] === 'inspect' ? script.inspect : args[0] === 'volume' ? script.volume : args[0] === 'rm' ? script.rm : undefined;
    if (!step) return { exitCode: 0, stdout: '', stderr: '' };
    return { exitCode: step.code ?? 0, stdout: step.out ?? '', stderr: step.err ?? '' };
  };
}

type Outcome = { ok: true; containers: Array<{ id: string; service: string | undefined }> } | { ok: false; message: string; detail: string | undefined; platform: boolean };

function outcomeOf(error: unknown): Outcome {
  if (!(error instanceof SandboxError)) throw error;
  return { ok: false, message: error.message, detail: error.detail, platform: error.platform };
}

interface Scenario {
  name: string;
  script: (env: Env) => Script;
  assets?: boolean;
  /** 옛 쪽보다 더 막는 의도한 차이가 있는 입력 */
  hardened?: boolean;
}

const mask = (source: string, target: string): MaskVolume => ({ type: 'bind', source, target, read_only: true, bind: { create_host_path: false } });

async function run(scenario: Scenario, phase: 'created' | 'started'): Promise<{ legacy: Outcome; now: Outcome; legacyCalls: string[]; nowCalls: string[] }> {
  const env = await environment();
  const script = scenario.script(env);
  await install(env, script);
  const volumes = scenario.assets ? [mask(env.copy, TARGET)] : [];
  const gitMask: Record<string, MaskVolume[]> = { api: [mask(path.join(env.root, '.git'), '/app/.git'), ...volumes] };
  const evaluationAssets = scenario.assets ? [{ path: 'tests/acceptance', source: env.copy }] : [];

  const legacyCalls: string[] = [];
  const context: LegacyContext = {
    id: 'studio-p',
    projectRoot: env.root,
    docker: legacyDocker(script, legacyCalls),
    composeArgs: (args) => ['compose', ...args],
    redact: (text) => text.replace('SECRET', '***'),
    gitMask,
    evaluationAssets,
    dependencyPollMs: 1,
    dependencyWaitMs: 50,
    dependsOn: {},
  };
  const legacy: Outcome = await verifyMasksLegacy(context, phase).then(
    (containers) => ({ ok: true as const, containers }),
    (error: unknown) => outcomeOf(error),
  );
  const now: Outcome = await verifyContainers({
    id: 'studio-p',
    dockerBin: env.bin,
    env: { PATH: process.env.PATH },
    listArgs: ['compose', 'ps', '--all', '--quiet', '--no-trunc'],
    projectRoot: env.root,
    gitMask,
    evaluationAssets,
    sandboxNetwork: SANDBOX_NETWORK,
    egressNetwork: EGRESS_NETWORK,
    edgeService: EDGE_SERVICE,
    serviceLabel: 'com.docker.compose.service',
    phase,
    redact: (text) => text.replace('SECRET', '***'),
  }).then(
    (containers) => ({ ok: true as const, containers }),
    (error: unknown) => outcomeOf(error),
  );
  return { legacy, now, legacyCalls, nowCalls: await env.calls() };
}

const labels = { 'com.docker.compose.service': 'api' };
function container(env: Env, id: string, mounts: object[], extra: Record<string, unknown> = {}) {
  return { Id: id, Name: `/${id}`, Config: { Labels: labels }, HostConfig: { NetworkMode: 'studio-p_b-studio-sandbox' }, NetworkSettings: { Networks: { 'studio-p_b-studio-sandbox': {} } }, Mounts: mounts, ...extra };
}
const baseMounts = (env: Env) => [
  { Type: 'bind', Source: env.root, Destination: '/app', RW: true },
  { Type: 'bind', Source: path.join(env.root, '.git'), Destination: '/app/.git', RW: false },
  { Type: 'bind', Source: path.join(env.root, '.git', 'b-studio-empty'), Destination: '/app/.git/b-studio', RW: false },
];
const json = (value: unknown) => JSON.stringify(value);
const one = (env: Env, mounts: object[], extra: Record<string, unknown> = {}): Script => ({ list: { out: 'c1\n' }, inspect: { out: json([container(env, 'c1', mounts, extra)]) } });
const assetMount = (env: Env, over: Record<string, unknown> = {}) => ({ Type: 'bind', Source: env.copy, Destination: TARGET, RW: false, ...over });

const scenarios: Scenario[] = [
  { name: '정상: 마운트가 모두 있다', script: (env) => one(env, baseMounts(env)) },
  { name: '정상: 평가 자산 자리가 계획한 복사본이다', assets: true, script: (env) => one(env, [...baseMounts(env), assetMount(env)]) },
  { name: '목록이 비0 종료(시크릿은 가린다)', script: () => ({ list: { code: 1, err: 'Cannot connect SECRET' } }) },
  { name: '컨테이너 0개', script: () => ({ list: { out: '\n' } }) },
  { name: 'inspect 비0 종료', script: () => ({ list: { out: 'c1\n' }, inspect: { code: 1, err: 'boom SECRET' } }) },
  { name: 'inspect 해석 실패', script: () => ({ list: { out: 'c1\n' }, inspect: { out: 'not json' } }) },
  { name: 'inspect가 배열이 아님', script: () => ({ list: { out: 'c1\n' }, inspect: { out: '{"Id":"c1"}' } }) },
  { name: '목록의 id 일부가 빠짐', script: (env) => ({ list: { out: 'c1\nc2\n' }, inspect: { out: json([container(env, 'c1', baseMounts(env))]) } }) },
  { name: 'inspect가 빈 배열', script: () => ({ list: { out: 'c1\n' }, inspect: { out: '[]' } }) },
  {
    name: '볼륨 inspect 비0 종료',
    script: (env) => ({ ...one(env, [...baseMounts(env), { Type: 'volume', Name: 'db', Destination: '/data', RW: true }]), volume: { code: 1, err: 'vol SECRET' } }),
  },
  { name: '볼륨 inspect 해석 실패', script: (env) => ({ ...one(env, [...baseMounts(env), { Type: 'volume', Name: 'db', Destination: '/data', RW: true }]), volume: { out: 'x' } }) },
  { name: '볼륨 inspect가 일부만 돌아옴', script: (env) => ({ ...one(env, [...baseMounts(env), { Type: 'volume', Name: 'db', Destination: '/data', RW: true }, { Type: 'volume', Name: 'cache', Destination: '/c', RW: true }]), volume: { out: json([{ Name: 'db' }]) } }) },
  { name: '볼륨 정보가 있으면 통과', script: (env) => ({ ...one(env, [...baseMounts(env), { Type: 'volume', Name: 'db', Destination: '/data', RW: true }]), volume: { out: json([{ Name: 'db', Driver: 'local', Options: null }]) } }) },
  {
    name: '호스트 폴더에 묶인 이름 있는 볼륨이 프로젝트를 덮으면 .git 자리를 요구한다',
    script: (env) => ({
      ...one(env, [{ Type: 'volume', Name: 'host', Destination: '/app', RW: true }]),
      volume: { out: json([{ Name: 'host', Driver: 'local', Options: { type: 'none', o: 'bind', device: env.root } }]) },
    }),
  },
  { name: '.git 자리 마운트가 없다', script: (env) => one(env, [baseMounts(env)[0]!]) },
  { name: '.git 자리가 RW true', script: (env) => one(env, [baseMounts(env)[0]!, { ...baseMounts(env)[1]!, RW: true }, baseMounts(env)[2]!]) },
  { name: '.git 자리의 RW 정보가 없다', script: (env) => one(env, [baseMounts(env)[0]!, { Type: 'bind', Source: path.join(env.root, '.git'), Destination: '/app/.git' }, baseMounts(env)[2]!]) },
  { name: '상태 폴더 자리만 빠졌다', script: (env) => one(env, baseMounts(env).slice(0, 2)) },
  { name: '프로젝트와 무관한 마운트만 있다', script: () => one({} as Env, [{ Type: 'bind', Source: '/somewhere/else', Destination: '/x', RW: true }]) },
  { name: '권한 상승(privileged)은 정책 위반이다(플랫폼 실패가 아니다)', script: (env) => one(env, baseMounts(env), { HostConfig: { Privileged: true, NetworkMode: 'studio-p_b-studio-sandbox' } }) },
  { name: '정책 위반과 가림 빠짐이 함께 있다', script: (env) => one(env, [baseMounts(env)[0]!], { HostConfig: { Privileged: true } }) },
  { name: '지우기가 비0 종료(정책 위반)', script: (env) => ({ ...one(env, baseMounts(env), { HostConfig: { Privileged: true } }), rm: { code: 1, err: 'denied' } }) },
  { name: '지우기가 비0 종료(가림 빠짐)', script: (env) => ({ ...one(env, [baseMounts(env)[0]!]), rm: { code: 1, err: 'denied' } }) },
  { name: '컨테이너 둘 중 하나만 위반이면 그것만 지운다', script: (env) => ({ list: { out: 'c1\nc2\n' }, inspect: { out: json([container(env, 'c1', baseMounts(env)), container(env, 'c2', [baseMounts(env)[0]!])]) } }) },
  { name: '컨테이너 둘 다 위반이면 둘 다 지운다', script: (env) => ({ list: { out: 'c1\nc2\n' }, inspect: { out: json([container(env, 'c1', [baseMounts(env)[0]!]), container(env, 'c2', [], { HostConfig: { Privileged: true } })]) } }) },
  { name: '라벨이 없는 컨테이너는 이름으로 부른다', script: (env) => ({ list: { out: 'c1\n' }, inspect: { out: json([{ ...container(env, 'c1', [baseMounts(env)[0]!]), Config: { Labels: {} } }]) } }) },
  // 평가 자산 자리
  { name: '평가 자산: 마운트가 없다', assets: true, script: (env) => one(env, baseMounts(env)) },
  { name: '평가 자산: RW가 true', assets: true, script: (env) => one(env, [...baseMounts(env), assetMount(env, { RW: true })]) },
  { name: '평가 자산: 원본이 계획한 복사본이 아니다', assets: true, script: (env) => one(env, [...baseMounts(env), assetMount(env, { Source: path.join(env.root, 'tests', 'acceptance') })]) },
  { name: '평가 자산: 자리 안쪽에 다른 마운트', assets: true, script: (env) => one(env, [...baseMounts(env), assetMount(env), { Type: 'bind', Source: '/other', Destination: `${TARGET}/inner`, RW: false }]) },
  { name: '평가 자산: tmpfs가 그 자리를 덮는다', assets: true, script: (env) => one(env, [...baseMounts(env), assetMount(env)], { HostConfig: { NetworkMode: 'studio-p_b-studio-sandbox', Tmpfs: { [TARGET]: '' } } }) },
  { name: '평가 자산: tmpfs가 안쪽을 덮는다', assets: true, script: (env) => one(env, [...baseMounts(env), assetMount(env)], { HostConfig: { NetworkMode: 'studio-p_b-studio-sandbox', Tmpfs: { [`${TARGET}/x`]: 'size=1m' } } }) },
  { name: '평가 자산: 무관한 tmpfs는 괜찮다', assets: true, script: (env) => one(env, [...baseMounts(env), assetMount(env)], { HostConfig: { NetworkMode: 'studio-p_b-studio-sandbox', Tmpfs: { '/tmp': '' } } }) },
  { name: '평가 자산: 같은 자리 마운트 여럿', assets: true, script: (env) => one(env, [...baseMounts(env), assetMount(env), assetMount(env)]) },
  { name: '평가 자산: 이름 있는 볼륨이 복사본에 묶였다', assets: true, script: (env) => ({ ...one(env, [...baseMounts(env), { Type: 'volume', Name: 'a', Destination: TARGET, RW: false }]), volume: { out: json([{ Name: 'a', Driver: 'local', Options: { type: 'none', o: 'bind', device: env.copy } }]) } }) },
  { name: '평가 자산: 일반 이름 있는 볼륨이 그 자리를 덮는다', assets: true, script: (env) => ({ ...one(env, [...baseMounts(env), { Type: 'volume', Name: 'a', Destination: TARGET, RW: false }]), volume: { out: json([{ Name: 'a', Driver: 'local', Options: null }]) } }) },
  { name: '평가 자산: Docker Desktop 접두어가 붙은 복사본 원본', assets: true, script: (env) => one(env, [...baseMounts(env), assetMount(env, { Source: `/host_mnt${env.copy}` })]) },
  { name: '평가 자산: 접두어 뒤 `..`', assets: true, script: (env) => one(env, [...baseMounts(env), assetMount(env, { Source: '/host_mnt/../etc' })]) },
  { name: '평가 자산: 접두어만 닮은 경로', assets: true, script: (env) => one(env, [...baseMounts(env), assetMount(env, { Source: `/host_mntx${env.copy}` })]) },
  // 옛 쪽보다 더 막는 의도한 차이
  { name: 'HARDENED: .git 자리에 마운트가 여럿', hardened: true, script: (env) => one(env, [...baseMounts(env), { Type: 'bind', Source: '/else', Destination: '/app/.git', RW: true }]) },
  { name: 'HARDENED: 프로젝트 마운트가 Docker Desktop 접두어를 달고 .git 자리가 없다', hardened: true, script: (env) => one(env, [{ Type: 'bind', Source: `/host_mnt${env.root}`, Destination: '/app', RW: true }]) },
];

describe('verifyContainers가 옛 #verifyMasks와 같은 결과를 낸다', () => {
  it.each(scenarios.map((scenario) => [scenario.name, scenario] as const))('%s', async (_name, scenario) => {
    for (const phase of ['created', 'started'] as const) {
      const { legacy, now, legacyCalls, nowCalls } = await run(scenario, phase);
      const rm = (calls: string[]) => calls.filter((call) => call.startsWith('rm '));
      if (scenario.hardened) {
        // 옛 쪽이 통과시킨 것을 막는 쪽으로만 다르다
        expect(legacy.ok).toBe(true);
        expect(now.ok).toBe(false);
        expect(rm(nowCalls)).toEqual(['rm --force c1']);
        continue;
      }
      expect(now).toEqual(legacy);
      expect(rm(nowCalls)).toEqual(rm(legacyCalls));
      // docker 호출 순서도 같다(첫 호출 이름만 견준다: 가짜 docker는 compose 인자 앞에 붙는 파일 인자를 모른다)
      expect(nowCalls.map((call) => call.split(' ')[0])).toEqual(legacyCalls.map((call) => call.split(' ')[0]));
    }
  });

  it('통과한 결과에는 컨테이너 id와 서비스 이름이 있다', async () => {
    const { now } = await run(scenarios[0]!, 'created');
    expect(now).toEqual({ ok: true, containers: [{ id: 'c1', service: 'api' }] });
  });

  it('오류의 구분이 옛 TS와 같다: 정책 위반은 platform이 아니고 가림 빠짐은 platform이다', async () => {
    const policy = await run(scenarios.find((s) => s.name.startsWith('권한 상승'))!, 'created');
    const missing = await run(scenarios.find((s) => s.name === '.git 자리 마운트가 없다')!, 'created');
    expect(policy.now).toMatchObject({ ok: false, platform: false });
    expect(missing.now).toMatchObject({ ok: false, platform: true });
    expect(policy.now.ok === false && policy.now.message).toContain('시작하지 않았습니다');
    const started = await run(scenarios.find((s) => s.name.startsWith('권한 상승'))!, 'started');
    expect(started.now.ok === false && started.now.message).toContain('내렸습니다');
  });

  it('지우지 못하면 글에 그 사실을 적는다', async () => {
    const { now } = await run(scenarios.find((s) => s.name === '지우기가 비0 종료(가림 빠짐)')!, 'created');
    expect(now.ok === false && now.message).toContain('지우지 못했습니다');
  });

  it('위반이 있으면 확인 결과를 돌려주지 않는다(시작 단계로 가지 않는다)', async () => {
    for (const scenario of scenarios.filter((s) => /위반|빠|없다|RW/.test(s.name))) {
      const { now } = await run(scenario, 'created');
      expect(now.ok, scenario.name).toBe(false);
    }
  });
});

describe('verifyContainers: 무작위 마운트 조합에서 옛 쪽과 같다', () => {
  // 시드가 정해진 난수. 마운트 후보를 섞어 옛·새를 견준다. 옛 쪽과 한 글자도 다르지 않아야 한다(더 막는 입력은 HARDENED 시나리오만 본다)
  function rng(seed: number) {
    return () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed / 4294967296;
    };
  }

  it('60개 조합', async () => {
    const next = rng(20261111);
    for (let index = 0; index < 60; index++) {
      const scenario: Scenario = {
        name: `random-${index}`,
        assets: next() < 0.6,
        script: (env) => {
          // `.git` 자리는 읽기 전용·읽기 쓰기·없음 가운데 하나다(같은 자리에 둘을 두는 조합은 HARDENED 시나리오가 따로 본다)
          const gitVariant = next();
          const pool: object[] = [
            baseMounts(env)[0]!,
            ...(gitVariant < 0.4 ? [baseMounts(env)[1]!] : gitVariant < 0.7 ? [{ ...baseMounts(env)[1]!, RW: true }] : []),
            baseMounts(env)[2]!,
            assetMount(env),
            assetMount(env, { RW: true }),
            assetMount(env, { Source: path.join(env.root, 'tests', 'acceptance') }),
            { Type: 'bind', Source: '/other', Destination: `${TARGET}/inner`, RW: false },
            { Type: 'bind', Source: '/other', Destination: '/data', RW: true },
          ];
          const mounts = pool.filter(() => next() < 0.55);
          const extra: Record<string, unknown> = {};
          const host: Record<string, unknown> = { NetworkMode: 'studio-p_b-studio-sandbox' };
          if (next() < 0.15) host.Tmpfs = { [next() < 0.5 ? TARGET : '/tmp']: '' };
          if (next() < 0.1) host.Privileged = true;
          extra.HostConfig = host;
          return { list: { out: 'c1\n' }, inspect: { out: json([container(env, 'c1', mounts, extra)]) } };
        },
      };
      const { legacy, now, legacyCalls, nowCalls } = await run(scenario, 'created');
      const rm = (calls: string[]) => calls.filter((call) => call.startsWith('rm '));
      if (legacy.ok) {
        // 이 조합에는 옛 쪽보다 더 막는 입력이 없다(`.git` 자리는 하나뿐, Docker Desktop 접두어 없음). 같은 결과여야 한다
        expect(now, scenario.name).toEqual(legacy);
      } else {
        expect(now, scenario.name).toEqual(legacy);
        expect(rm(nowCalls), scenario.name).toEqual(rm(legacyCalls));
      }
    }
  }, 600_000);
});

// ── 시작 ──

async function startBoth(options: {
  verified: Array<{ id: string; service: string | undefined }>;
  services: string[];
  dependsOn: Record<string, Record<string, { condition?: string }>>;
  state?: Step;
  start?: Step;
  waitMs?: number;
}): Promise<{ legacy: ExecResult | Outcome; now: ExecResult | Outcome; legacyCalls: string[]; nowCalls: string[] }> {
  const env = await environment();
  const script: Script & { state?: Step; start?: Step } = { list: {} };
  if (options.state) await writeFile(path.join(env.dir, 'inspect.out'), options.state.out ?? '');
  if (options.state) await writeFile(path.join(env.dir, 'inspect.code'), String(options.state.code ?? 0));
  if (options.start) {
    await writeFile(path.join(env.dir, 'start.out'), options.start.out ?? '');
    await writeFile(path.join(env.dir, 'start.err'), options.start.err ?? '');
    await writeFile(path.join(env.dir, 'start.code'), String(options.start.code ?? 0));
  }
  void script;
  const legacyCalls: string[] = [];
  const docker: LegacyContext['docker'] = async (args) => {
    legacyCalls.push(args.join(' '));
    if (args[0] === 'inspect') return { exitCode: options.state?.code ?? 0, stdout: options.state?.out ?? '', stderr: '' };
    if (args[0] === 'start') return { exitCode: options.start?.code ?? 0, stdout: options.start?.out ?? '', stderr: options.start?.err ?? '' };
    return { exitCode: 0, stdout: '', stderr: '' };
  };
  const context: LegacyContext = { id: 'studio-p', projectRoot: env.root, docker, composeArgs: (args) => args, redact: (text) => text, gitMask: {}, evaluationAssets: [], dependencyPollMs: 1, dependencyWaitMs: options.waitMs ?? 50, dependsOn: options.dependsOn };
  const legacy = await startVerifiedLegacy(context, options.verified, options.services).catch((error: unknown) => outcomeOf(error));
  const now = await startVerifiedContainers({
    id: 'studio-p',
    dockerBin: env.bin,
    env: { PATH: process.env.PATH },
    verified: options.verified,
    services: options.services,
    dependsOn: options.services.length === 1 ? undefined : options.dependsOn,
    pollMs: 1,
    waitMs: options.waitMs ?? 50,
  }).catch((error: unknown) => outcomeOf(error));
  return { legacy, now, legacyCalls, nowCalls: await env.calls() };
}

describe('startVerifiedContainers가 옛 #startVerified와 같은 결과를 낸다', () => {
  const healthy = '{"Status":"running","Health":{"Status":"healthy"}}\n';
  const verified = [{ id: 'c1', service: 'api' }, { id: 'c2', service: 'db' }];
  const dep = { api: { db: { condition: 'service_healthy' } } };
  const cases: Array<[string, Parameters<typeof startBoth>[0]]> = [
    ['서비스 하나', { verified, services: ['api'], dependsOn: {} }],
    ['확인한 목록에 없는 서비스', { verified, services: ['api', 'cache'], dependsOn: {} }],
    ['의존 순서와 healthy 기다림', { verified, services: ['api', 'db'], dependsOn: dep, state: { out: healthy } }],
    ['healthcheck가 없는 서비스에 service_healthy', { verified, services: ['api', 'db'], dependsOn: dep, state: { out: '{"Status":"running","Health":null}\n' } }],
    ['unhealthy', { verified, services: ['api', 'db'], dependsOn: dep, state: { out: '{"Status":"running","Health":{"Status":"unhealthy"}}\n' } }],
    ['의존 서비스가 종료', { verified, services: ['api', 'db'], dependsOn: dep, state: { out: '{"Status":"exited","Health":{"Status":"starting"}}\n' } }],
    ['제한 시간 안에 준비되지 않음', { verified, services: ['api', 'db'], dependsOn: dep, state: { out: '{"Status":"running","Health":{"Status":"starting"}}\n' }, waitMs: 30 }],
    ['service_completed_successfully 성공', { verified, services: ['api', 'db'], dependsOn: { api: { db: { condition: 'service_completed_successfully' } } }, state: { out: '{"Status":"exited","ExitCode":0}\n' } }],
    ['service_completed_successfully 실패', { verified, services: ['api', 'db'], dependsOn: { api: { db: { condition: 'service_completed_successfully' } } }, state: { out: '{"Status":"exited","ExitCode":7}\n' } }],
    ['상태 inspect가 비0', { verified, services: ['api', 'db'], dependsOn: dep, state: { code: 1, out: '' } }],
    ['상태 해석 실패', { verified, services: ['api', 'db'], dependsOn: dep, state: { out: 'nope\n' } }],
    ['상태가 비어 있음', { verified, services: ['api', 'db'], dependsOn: dep, state: { out: '' } }],
    ['시작이 비0 종료', { verified, services: ['api', 'db'], dependsOn: dep, start: { code: 1, err: 'port is already allocated' } }],
    ['조건 없는 의존(service_started)은 기다리지 않는다', { verified, services: ['api', 'db'], dependsOn: { api: { db: { condition: 'service_started' } } } }],
  ];
  it.each(cases)('%s', async (_name, options) => {
    const { legacy, now, legacyCalls, nowCalls } = await startBoth(options);
    expect(now).toEqual(legacy);
    // 기다리는 횟수는 시간에 달렸다. 같은 호출이 이어지면 하나로 접어 견준다
    const collapse = (calls: string[]) => calls.filter((call, index) => call !== calls[index - 1]);
    expect(collapse(nowCalls)).toEqual(collapse(legacyCalls));
  });
});

describe('startVerifiedContainers의 취소', () => {
  it('기다리는 중에 취소하면 취소를 그대로 던지고 다음 묶음을 시작하지 않는다(옛 TS도 던진다)', async () => {
    const env = await environment();
    await writeFile(path.join(env.dir, 'inspect.out'), '{"Status":"running","Health":{"Status":"starting"}}\n');
    const verified = [{ id: 'c1', service: 'api' }, { id: 'c2', service: 'db' }];
    const controller = new AbortController();
    // 첫 의존 상태 조회가 시작된 뒤(= 기다리는 중)에 취소한다
    const timer = setInterval(() => {
      void env.calls().then((calls) => {
        if (calls.some((call) => call.startsWith('inspect'))) controller.abort();
      });
    }, 20);
    const outcome = await startVerifiedContainers({
      id: 'studio-p',
      dockerBin: env.bin,
      env: { PATH: process.env.PATH },
      verified,
      services: ['api', 'db'],
      dependsOn: { api: { db: { condition: 'service_healthy' } } },
      pollMs: 5,
      waitMs: 600_000,
      signal: controller.signal,
    }).then(
      () => 'resolved',
      (error: unknown) => (error as Error).name,
    );
    clearInterval(timer);
    expect(outcome).toBe('AbortError');
    expect((await env.calls()).some((call) => call === 'start c1')).toBe(false);
  }, 60_000);

  it('이미 취소된 신호로 부르면 시작하지 않고 던진다', async () => {
    const env = await environment();
    const controller = new AbortController();
    controller.abort();
    const outcome = await startVerifiedContainers({
      id: 'studio-p',
      dockerBin: env.bin,
      env: { PATH: process.env.PATH },
      verified: [{ id: 'c1', service: 'api' }, { id: 'c2', service: 'db' }],
      services: ['api', 'db'],
      dependsOn: { api: { db: { condition: 'service_healthy' } } },
      pollMs: 5,
      waitMs: 1000,
      signal: controller.signal,
    }).then(
      (result) => result,
      (error: unknown) => (error as Error).name,
    );
    // 취소된 docker start는 거절하지 않고 종료 코드 1을 돌려준다(옛 `#docker`와 같다). 어느 쪽이든 다음 묶음은 시작하지 않는다
    expect(outcome === 'AbortError' || (typeof outcome === 'object' && outcome.exitCode === 1)).toBe(true);
    expect((await env.calls()).some((call) => call === 'start c1')).toBe(false);
  }, 60_000);
});
