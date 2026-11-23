import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LoadedProject } from '@b-studio/spec';
import { afterAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { isDockerUnreachable, SandboxError } from '../errors';
import { Redactor } from '../secrets';
import { composeEnvironment } from './compose-env';
import { describeDockerFailure, LocalDockerProvider } from './compose-provider';
import { EDGE_SERVICE, EGRESS_NETWORK, SANDBOX_NETWORK } from './format';
import type { MaskVolume } from './git-mask';
import { PORT_RETRY_ATTEMPTS, relayThroughContainers, syncFiles, upWithPortRetry } from './sync-relay';
import { overrideInputJson, writeComposeOverride } from './up-loop';

/**
 * 파일 반영 확인·변경 알림·포트 충돌 재시도(ADR-195 4f A4c-2) 시험: Rust 함수 + TS 껍데기가 가짜 docker에서 결과·호출 순서·override 내용을 내는지 본다.
 * 진짜 docker는 쓰지 않는다 — 가짜 docker는 준비한 출력을 호출 순서대로 내놓는 셸 스크립트다.
 * 옛 TS 사본과 견주던 시험(#1347에서 사본을 지웠다)에서 사본과 무관한 확인만 남겼다. `HARDENED`·`의도한 차이` 표시는 옛 쪽보다 더 막거나 다르게 하는 동작이다.
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

async function observeSync(scenario: SyncScenario, env: Env): Promise<SyncObserved> {
  const { bin, state, runDir } = await fakeDocker(env, 'now');
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
  const run = syncFiles({ project: proj, dockerBin: bin, env: dockerEnv(), files: scenario.files, ...options });
  const outcome = await run.then(
    (result) => ({ ok: true as const, value: { checks: result.checks } }),
    (error: unknown) => outcomeOf(error),
  );
  return { outcome, calls: normalizeCalls(await readCalls(state), env, runDir) };
}

async function runSync(scenario: SyncScenario) {
  const env = await environment();
  await writeFile(path.join(env.root, 'a.txt'), 'new content');
  await scenario.setup?.(env);
  await install(env, scenario.script(env));
  const now = await observeSync(scenario, env);
  return { now, env };
}

const OLD = sha('old content');
const NEW = sha('new content');
const A = (hash: string) => `${hash} a.txt\n`;

describe('sync', () => {
  it('기다리는 중에 취소하면 AbortError다', async () => {
    const { now } = await runSync({ name: 'x', files: ['a.txt'], abort: 'during-sleep', script: () => ({ run: { out: A(OLD) } }) });
    expect(now.outcome).toMatchObject({ ok: false, name: 'AbortError' });
  }, 60_000);
});

describe('sync HARDENED: 더 막는 동작', () => {
  it('같은 파일의 줄이 둘이면 뒤의 줄이 맞아도 통과하지 못한다', async () => {
    const { now } = await runSync({ name: 'x', files: ['a.txt'], timeoutMs: 0, script: () => ({ run: { out: `${OLD} a.txt\n${NEW} a.txt\n` } }) });
    expect(now.outcome).toMatchObject({ ok: false, name: 'SandboxError', platform: true });
    if (!now.outcome.ok) expect(now.outcome.message).toContain('0초 안에 샌드박스에 파일 변경이 반영되지 않았습니다: a.txt');
  });

  it('값이 같은 중복 줄도 통과하지 못한다', async () => {
    const { now } = await runSync({ name: 'x', files: ['a.txt'], timeoutMs: 0, script: () => ({ run: { out: `${NEW} a.txt\n${NEW} a.txt\n` } }) });
    expect(now.outcome.ok).toBe(false);
  });

  it.each(['garbage', ' leading', 'nospace'])('모양을 모르는 줄(%s)이 하나라도 있으면 맞는 줄이 있어도 통과하지 못한다', async (noise) => {
    const { now } = await runSync({ name: 'x', files: ['a.txt'], timeoutMs: 0, script: () => ({ run: { out: `${NEW} a.txt\n${noise}\n` } }) });
    expect(now.outcome.ok).toBe(false);
  });

  it('호스트 파일을 읽지 못하면(폴더) docker를 부르지 않고 SandboxError다', async () => {
    const { now } = await runSync({ name: 'x', files: ['src'], script: () => ({ run: { out: '' } }) });
    expect(now.outcome).toMatchObject({ ok: false, name: 'SandboxError', platform: false });
    if (!now.outcome.ok) expect(now.outcome.message).toContain('src');
    expect(now.calls).toEqual([]);
  });

  it('이미 취소된 신호는 아무것도 읽거나 부르지 않고 AbortError다', async () => {
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

// ── relay ──

const relayConfig = (env: Env) => ({ services: { api: { volumes: [{ type: 'bind', source: env.root, target: '/app' }] }, db: { volumes: [{ type: 'volume', source: 'data', target: '/var/lib/db' }] } } });

describe('relayChanges', () => {
  it.each([['null'], ['{}'], ['{"services":null}']])('compose 설정이 %s이면 던진다(SandboxError). 알리지 않는다', async (text) => {
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

async function observeRetry(scenario: RetryScenario, env: Env): Promise<RetryObserved> {
  const { bin, state, runDir } = await fakeDocker(env, 'now');
  const refs = scenario.refs ? [{ service: 'api', envKey: 'API_URL', template: '${b-studio:services.api.publicUrl}', targetService: 'api' }] : [];
  const proj = project(env, { publicUrlRefs: refs } as Partial<LoadedProject>);
  const overridePath = path.join(runDir, 'compose.override.yaml');
  const edgeScript = '// edge\n';
  const initialPorts: Record<string, number> = scenario.refs ? { api: 40000 } : {};
  await writeComposeOverride(overridePath, overrideInputJson(proj, 'studio-p', { edgeScript, hostPorts: initialPorts }), {});
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
  const outcome = await upWithPortRetry({
    ...common,
    overrideInput: overrideInputJson(proj, 'studio-p', { edgeScript, hostPorts: status.hostPorts }),
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
  }).then(
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

async function runRetry(scenario: RetryScenario) {
  const env = await environment();
  await install(env, scenario.script(env));
  const now = await observeRetry(scenario, env);
  return { now };
}

describe('포트 충돌 재시도', () => {
  it('포기까지 시도 횟수는 3번이고 정리는 시도 사이에 두 번이다', async () => {
    const { now } = await runRetry({ name: 'x', refs: true, script: (env) => ({ ...upBase(env), start: { code: 1, err: CONFLICT } }) });
    expect(PORT_RETRY_ATTEMPTS).toBe(3);
    expect(now.calls.filter((call) => call.includes(' start')).length).toBe(3);
    expect(now.calls.filter((call) => call.endsWith('rm --stop --force --volumes')).length).toBe(2);
  });

  it('다시 쓴 override의 마스크는 직전 시도가 쓴 값이다(정리 직전의 override에 .git 가림이 들어 있다)', async () => {
    const { now } = await runRetry({ name: 'x', refs: true, script: (env) => ({ ...upBase(env), start: [{ code: 1, err: CONFLICT }, {}] }) });
    const snapshot = JSON.parse(now.overrides['ov.composerm.1']!) as { services: Record<string, { volumes?: Array<{ target: string }> }> };
    expect(snapshot.services.api?.volumes?.map((volume) => volume.target)).toEqual(['/app/.git', '/app/.git/b-studio']);
  });

  it('포트를 다시 뽑으면 처음 값(40000)에서 바뀌고 다시 쓴 override에 옛 포트가 남지 않는다', async () => {
    const { now } = await runRetry({ name: 'x', refs: true, script: (env) => ({ ...upBase(env), start: [{ code: 1, err: CONFLICT }, {}] }) });
    expect(now.hostPortsChanged).toBe(true);
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

describe('포트 충돌 재시도: 재시도 전체가 한 칸', () => {
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
