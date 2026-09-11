import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { LoadedProject, ManagedServiceSpec } from '@b-studio/spec';
import { stringify } from 'yaml';
import { SandboxError } from '../errors';
import { DEFAULT_READINESS, waitForReady, type ReadinessPolicy } from '../readiness';
import type {
  ContainerState,
  ExecResult,
  LogLine,
  LogOptions,
  Sandbox,
  SandboxProvider,
  ServiceEndpoint,
  StartOptions,
  SyncOptions,
  SyncResult,
} from '../types';
import { buildOverride, parseContainerState, parseHostPort, parseLogLine, parseSyncOutput } from './format';
import {
  composeVolumeName,
  SNAPSHOT_LABEL,
  SNAPSHOT_MARKER,
  snapshotName,
  SNAPSHOTS_TO_KEEP,
  snapshotSlot,
  snapshotsToPrune,
} from './snapshots';

const execFileAsync = promisify(execFile);

/** 파일 반영 확인에 쓰는 작은 이미지. 서비스 컨테이너가 죽어 있어도 확인할 수 있도록 별도 컨테이너로 돌린다 */
const SYNC_HELPER_IMAGE = 'busybox:1.37';

/**
 * 파일 경로는 셸 문자열에 끼워 넣지 않고 위치 인자로 넘긴다.
 * 디렉터리 목록(readdir)에 이름이 보이는지와 내용 해시를 함께 확인한다.
 * 빌드 도구는 목록과 속성으로 변경을 감지하므로 경로로 직접 여는 것만으로는 부족하다.
 */
const SYNC_SCRIPT = [
  'cd /project || exit 2',
  'for f in "$@"; do',
  '  if ls -1a "$(dirname "$f")" 2>/dev/null | grep -Fxq -- "$(basename "$f")"; then',
  '    h=$(sha256sum "$f" 2>/dev/null | cut -d " " -f 1)',
  '    echo "${h:-UNREADABLE} $f"',
  '  else',
  '    echo "MISSING $f"',
  '  fi',
  'done',
].join('\n');

/** 끝까지 복사된 스냅샷만 쓴다. 표시 파일이 없으면 3으로 끝내 깨진 스냅샷을 지우게 한다 */
const SEED_SCRIPT = `[ -f /from/${SNAPSHOT_MARKER} ] || exit 3\ncp -a /from/. /to/ && rm -f /to/${SNAPSHOT_MARKER}`;
/** 표시 파일은 복사가 끝난 뒤에만 남긴다 */
const CAPTURE_SCRIPT = `cp -a /from/. /to/ && touch /to/${SNAPSHOT_MARKER}`;

/** 같은 스튜디오 서버에서 두 세션이 같은 스냅샷을 동시에 만들지 않게 한다 */
const capturing = new Set<string>();

interface SnapshotPlan {
  service: string;
  volume: string;
  snapshot: string;
  slot: string;
  /** compose가 이 샌드박스에 만들 볼륨 이름 */
  sandboxVolume: string;
}

export interface LocalDockerProviderOptions {
  /** docker 실행 파일 경로 (기본: PATH의 docker) */
  dockerBin?: string;
  /** 모든 서비스에 적용할 준비 정책. studio.yaml의 ready.timeoutSeconds가 우선한다 */
  readiness?: Partial<ReadinessPolicy>;
}

/**
 * 로컬 Docker(compose)로 샌드박스를 만든다.
 * 개발 환경과 사내 서버 한 대 운영용 구현이다. 컨테이너 격리만으로 부족하면
 * gVisor/Kata 기반 제공자로 교체한다.
 */
export class LocalDockerProvider implements SandboxProvider {
  readonly name = 'local-docker';
  readonly #options: LocalDockerProviderOptions;

  constructor(options: LocalDockerProviderOptions = {}) {
    this.#options = options;
  }

  async create(project: LoadedProject): Promise<Sandbox> {
    const id = `studio-${project.spec.name}-${randomBytes(3).toString('hex')}`;
    const workDir = await mkdtemp(path.join(tmpdir(), 'b-studio-'));
    const overridePath = path.join(workDir, 'compose.override.yaml');
    await writeFile(overridePath, stringify(buildOverride(project, id)));
    return new LocalDockerSandbox(id, project, workDir, overridePath, this.#options);
  }
}

class LocalDockerSandbox implements Sandbox {
  readonly id: string;
  readonly project: LoadedProject;
  readonly #workDir: string;
  readonly #overridePath: string;
  readonly #dockerBin: string;
  readonly #readiness: Partial<ReadinessPolicy>;

  constructor(
    id: string,
    project: LoadedProject,
    workDir: string,
    overridePath: string,
    options: LocalDockerProviderOptions,
  ) {
    this.id = id;
    this.project = project;
    this.#workDir = workDir;
    this.#overridePath = overridePath;
    this.#dockerBin = options.dockerBin ?? 'docker';
    this.#readiness = options.readiness ?? {};
  }

  async start(options: StartOptions = {}): Promise<ServiceEndpoint[]> {
    for (const [name] of this.project.managed) options.onStatus?.({ service: name, phase: 'starting' });
    await this.#ensureSharedVolumes();

    // 스냅샷 복사가 compose up을 늦추지 않도록 이미지 빌드와 동시에 한다
    const plans = await this.#planSnapshots();
    const [seeded] = await Promise.all([
      Promise.all(plans.map((plan) => this.#seedSnapshot(plan, options))),
      this.#composeOrThrow(['build'], options.signal),
    ]);

    await this.#composeOrThrow(['up', '--detach', '--remove-orphans'], options.signal);
    const endpoints = await Promise.all(this.project.managed.map(([name]) => this.#awaitReady(name, options)));

    // 설치 단계만 끝나고 에이전트가 아직 도구를 쓰지 않은 시점의 볼륨을 다음 기동용으로 남긴다
    await Promise.all(plans.filter((_, index) => !seeded[index]).map((plan) => this.#captureSnapshot(plan, options)));
    return endpoints;
  }

  async restart(name: string, options: StartOptions = {}): Promise<ServiceEndpoint> {
    this.#managed(name);
    options.onStatus?.({ service: name, phase: 'starting' });
    // 소스를 마운트하는 개발 이미지는 이미지가 그대로여도 컨테이너를 새로 만들어야 변경이 반영된다
    await this.#composeOrThrow(['up', '--detach', '--build', '--no-deps', '--force-recreate', name], options.signal);
    return this.#awaitReady(name, options);
  }

  async sync(files: string[], { signal, timeoutMs = 60_000 }: SyncOptions = {}): Promise<SyncResult> {
    if (files.length === 0) return { elapsedMs: 0, checks: 0 };

    const expected = new Map(
      await Promise.all(files.map(async (file) => [file, await hashOrMissing(path.join(this.project.root, file))] as const)),
    );
    const started = Date.now();

    for (let checks = 1; ; checks++) {
      const result = await this.#docker(
        ['run', '--rm', '--volume', `${this.project.root}:/project:ro`, SYNC_HELPER_IMAGE, 'sh', '-c', SYNC_SCRIPT, 'sh', ...files],
        signal,
      );
      if (result.exitCode !== 0) throw new SandboxError('샌드박스 파일 반영 확인에 실패했습니다', result.stderr);

      const seen = parseSyncOutput(result.stdout);
      const pending = files.filter((file) => seen.get(file) !== expected.get(file));
      if (pending.length === 0) return { elapsedMs: Date.now() - started, checks };

      if (Date.now() - started >= timeoutMs) {
        throw new SandboxError(`${Math.round(timeoutMs / 1_000)}초 안에 샌드박스에 파일 변경이 반영되지 않았습니다: ${pending.join(', ')}`);
      }
      await sleep(250, undefined, { signal });
    }
  }

  async endpoint(name: string): Promise<ServiceEndpoint> {
    const service = this.#managed(name);
    const { stdout } = await this.#composeOrThrow(['port', name, String(service.port)]);
    return { service: name, containerPort: service.port, url: `http://127.0.0.1:${parseHostPort(stdout)}` };
  }

  async state(name: string): Promise<ContainerState> {
    const { stdout } = await this.#compose(['ps', '--all', '--format', 'json', name]);
    return parseContainerState(stdout);
  }

  async *logs({ services = [], tail = 200, follow = true, signal }: LogOptions = {}): AsyncIterable<LogLine> {
    const args = this.#composeArgs([
      'logs',
      ...(follow ? ['--follow'] : []),
      '--no-color',
      '--timestamps',
      '--tail',
      String(tail),
      ...services,
    ]);
    const child = spawn(this.#dockerBin, args, { signal, stdio: ['ignore', 'pipe', 'ignore'] });
    // signal로 중단하면 AbortError가 발생하는데, 로그 구독 종료는 정상 흐름이다
    child.on('error', () => {});

    try {
      for await (const raw of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
        const line = parseLogLine(raw);
        if (line) yield line;
      }
    } finally {
      child.kill();
    }
  }

  exec(name: string, command: string[], { signal, input }: { signal?: AbortSignal; input?: string } = {}): Promise<ExecResult> {
    return this.#docker(this.#composeArgs(['exec', '-T', name, ...command]), signal, input);
  }

  async destroy(): Promise<void> {
    try {
      await this.#composeOrThrow(['down', '--volumes', '--remove-orphans']);
    } finally {
      await rm(this.#workDir, { recursive: true, force: true });
    }
  }

  async #awaitReady(name: string, { signal, onStatus }: StartOptions): Promise<ServiceEndpoint> {
    const service = this.#managed(name);
    const endpoint = await this.endpoint(name);

    if (service.ready) {
      try {
        await waitForReady({
          url: new URL(service.ready.path, endpoint.url).toString(),
          expectStatus: service.ready.expectStatus,
          policy: this.#policyFor(service),
          getContainerState: () => this.state(name),
          signal,
          onProbe: (probe) => onStatus?.({ service: name, phase: 'probing', probe }),
        });
      } catch (error) {
        onStatus?.({ service: name, phase: 'failed', reason: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    }

    onStatus?.({ service: name, phase: 'ready', endpoint });
    return endpoint;
  }

  async #planSnapshots(): Promise<SnapshotPlan[]> {
    const plans: SnapshotPlan[] = [];
    for (const [service, spec] of this.project.managed) {
      for (const { volume, key } of spec.snapshots ?? []) {
        const files = await Promise.all(
          key.map(async (file) => ({
            path: file,
            content: await readFile(path.join(this.project.root, spec.path, file)).catch(() => undefined),
          })),
        );
        plans.push({
          service,
          volume,
          snapshot: snapshotName({ project: this.project.spec.name, service, volume, files }),
          slot: snapshotSlot(this.project.spec.name, service, volume),
          sandboxVolume: composeVolumeName(this.id, volume),
        });
      }
    }
    return plans;
  }

  /** 스냅샷이 있으면 이 샌드박스의 볼륨을 미리 만들어 채운다. 실패하면 빈 볼륨으로 평소처럼 설치한다 */
  async #seedSnapshot(plan: SnapshotPlan, { signal, onSnapshot }: StartOptions): Promise<boolean> {
    const event = { service: plan.service, volume: plan.volume, snapshot: plan.snapshot };
    if ((await this.#docker(['volume', 'inspect', plan.snapshot], signal)).exitCode !== 0) {
      onSnapshot?.({ ...event, action: 'missing' });
      return false;
    }

    const started = Date.now();
    // compose가 자기 볼륨으로 알아보도록 compose 라벨을 붙인다. 그래야 경고 없이 쓰고 destroy() 때 함께 지운다
    const created = await this.#docker(
      [
        'volume', 'create',
        '--label', `com.docker.compose.project=${this.id}`,
        '--label', `com.docker.compose.volume=${plan.volume}`,
        plan.sandboxVolume,
      ],
      signal,
    );
    const copied =
      created.exitCode === 0
        ? await this.#docker(
            ['run', '--rm', '--volume', `${plan.snapshot}:/from:ro`, '--volume', `${plan.sandboxVolume}:/to`, SYNC_HELPER_IMAGE, 'sh', '-c', SEED_SCRIPT],
            signal,
          )
        : created;

    if (copied.exitCode === 0) {
      onSnapshot?.({ ...event, action: 'seeded', elapsedMs: Date.now() - started });
      return true;
    }

    await this.#docker(['volume', 'rm', '--force', plan.sandboxVolume]);
    // 끝까지 복사되지 않은 스냅샷은 지워서 이번 기동이 새로 만들게 한다 (다른 샌드박스가 쓰는 중이면 지워지지 않는다)
    if (copied.exitCode === 3) await this.#docker(['volume', 'rm', plan.snapshot]);
    onSnapshot?.({
      ...event,
      action: 'failed',
      stage: 'seed',
      reason: copied.exitCode === 3 ? '스냅샷이 끝까지 저장되지 않았습니다' : copied.stderr.trim() || `exit ${copied.exitCode}`,
    });
    return false;
  }

  async #captureSnapshot(plan: SnapshotPlan, { onSnapshot }: StartOptions): Promise<void> {
    if (capturing.has(plan.snapshot)) return;
    capturing.add(plan.snapshot);
    const event = { service: plan.service, volume: plan.volume, snapshot: plan.snapshot };
    const started = Date.now();
    try {
      // 그사이 다른 세션이 만들었으면 그것을 쓴다
      if ((await this.#docker(['volume', 'inspect', plan.snapshot])).exitCode === 0) return;

      const created = await this.#docker(['volume', 'create', '--label', `${SNAPSHOT_LABEL}=true`, '--label', `${SNAPSHOT_LABEL}.slot=${plan.slot}`, plan.snapshot]);
      if (created.exitCode !== 0) throw new SandboxError('스냅샷 볼륨을 만들지 못했습니다', created.stderr);

      const copied = await this.#docker([
        'run', '--rm', '--volume', `${plan.sandboxVolume}:/from:ro`, '--volume', `${plan.snapshot}:/to`, SYNC_HELPER_IMAGE, 'sh', '-c', CAPTURE_SCRIPT,
      ]);
      if (copied.exitCode !== 0) {
        await this.#docker(['volume', 'rm', '--force', plan.snapshot]);
        throw new SandboxError('스냅샷을 복사하지 못했습니다', copied.stderr);
      }

      onSnapshot?.({ ...event, action: 'captured', elapsedMs: Date.now() - started });
      await this.#pruneSnapshots(plan.slot);
    } catch (error) {
      const reason = error instanceof SandboxError && error.detail ? `${error.message}: ${error.detail.trim()}` : String(error);
      onSnapshot?.({ ...event, action: 'failed', stage: 'capture', reason });
    } finally {
      capturing.delete(plan.snapshot);
    }
  }

  /** lockfile이 바뀔 때마다 스냅샷이 쌓이므로 같은 자리에서는 최근 것만 남긴다 */
  async #pruneSnapshots(slot: string): Promise<void> {
    const listed = await this.#docker(['volume', 'ls', '--quiet', '--filter', `label=${SNAPSHOT_LABEL}.slot=${slot}`]);
    const names = listed.stdout.split('\n').filter(Boolean);
    if (names.length <= SNAPSHOTS_TO_KEEP) return;
    const inspected = await this.#docker(['volume', 'inspect', '--format', '{{.Name}} {{.CreatedAt}}', ...names]);
    // 다른 샌드박스가 복사 중인 스냅샷은 지워지지 않고 남는다
    for (const name of snapshotsToPrune(inspected.stdout)) await this.#docker(['volume', 'rm', name]);
  }

  /** compose는 external 볼륨을 만들어 주지 않으므로 먼저 만든다. 이미 있으면 그대로 둔다 */
  async #ensureSharedVolumes(): Promise<void> {
    await Promise.all(
      this.project.sharedVolumes.map((name) =>
        execFileAsync(this.#dockerBin, ['volume', 'create', '--label', 'b-studio.cache=true', name]),
      ),
    );
  }

  #policyFor(service: ManagedServiceSpec): ReadinessPolicy {
    const timeoutSeconds = service.ready?.timeoutSeconds;
    return {
      ...DEFAULT_READINESS,
      ...this.#readiness,
      ...(timeoutSeconds ? { timeoutMs: timeoutSeconds * 1_000 } : {}),
    };
  }

  #managed(name: string): ManagedServiceSpec {
    const entry = this.project.managed.find(([serviceName]) => serviceName === name);
    if (!entry) throw new SandboxError(`'${name}'은(는) 이 프로젝트의 managed 서비스가 아닙니다`);
    return entry[1];
  }

  #composeArgs(args: string[]): string[] {
    return [
      'compose',
      '--project-name', this.id,
      '--project-directory', this.project.root,
      '--file', this.project.composePath,
      '--file', this.#overridePath,
      ...args,
    ];
  }

  #compose(args: string[], signal?: AbortSignal): Promise<ExecResult> {
    return this.#docker(this.#composeArgs(args), signal);
  }

  async #docker(args: string[], signal?: AbortSignal, input?: string): Promise<ExecResult> {
    try {
      // 개발용 데이터베이스 덤프를 문자열로 주고받으므로 넉넉하게 둔다
      const running = execFileAsync(this.#dockerBin, args, { signal, maxBuffer: 256 * 1024 * 1024 });
      running.child.stdin?.end(input);
      const { stdout, stderr } = await running;
      return { exitCode: 0, stdout, stderr };
    } catch (error) {
      if (!isExecFailure(error)) throw error;
      return {
        exitCode: typeof error.code === 'number' ? error.code : 1,
        stdout: error.stdout ?? '',
        stderr: error.stderr || error.message,
      };
    }
  }

  async #composeOrThrow(args: string[], signal?: AbortSignal): Promise<ExecResult> {
    const result = await this.#compose(args, signal);
    if (result.exitCode !== 0) throw new SandboxError(`docker compose ${args[0]} 실패 (${this.id})`, result.stderr);
    return result;
  }
}

async function hashOrMissing(file: string): Promise<string> {
  try {
    return createHash('sha256').update(await readFile(file)).digest('hex');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'MISSING';
    throw error;
  }
}

function isExecFailure(error: unknown): error is Error & { code?: number | string; stdout?: string; stderr?: string } {
  return error instanceof Error && 'stdout' in error;
}
