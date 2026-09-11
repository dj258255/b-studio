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
import { assertSandboxId } from '../sandbox-id';
import { Redactor } from '../secrets';
import { withRemovedDirectories } from '../sync-paths';
import type {
  CleanupCommand,
  ContainerState,
  CreateSandboxOptions,
  EgressDenial,
  ExecResult,
  ExternalCallRequest,
  ExternalCallResult,
  FileChange,
  LogLine,
  LogOptions,
  RelayedPath,
  Sandbox,
  SandboxProvider,
  ServiceEndpoint,
  ServiceUsage,
  StartOptions,
  SyncOptions,
  SyncResult,
} from '../types';
import {
  buildOverride,
  EDGE_SERVICE,
  edgePortFor,
  parseContainerState,
  parseEgressDenial,
  parseHostPort,
  parseLogLine,
  parseRuntimes,
  SYNC_SCRIPT,
  parseSyncOutput,
} from './format';
import { externalCallScript } from './external-call';
import { bindMounts, planRelay, RELAY_SCRIPT } from './relay';
import { mergeUsage, parseInspectOutput, parseStatsOutput } from './usage';
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

/** 샌드박스 출입구 스크립트. 원격 Docker 호스트에서도 돌도록 파일을 마운트하지 않고 내용을 compose 설정에 넣는다 */
const EDGE_SCRIPT = new URL('../../edge/edge.mjs', import.meta.url);

/** 파일 반영 확인에 쓰는 작은 이미지. 서비스 컨테이너가 죽어 있어도 확인할 수 있도록 별도 컨테이너로 돌린다 */
const SYNC_HELPER_IMAGE = 'busybox:1.37';

/**
 * 파일 경로는 셸 문자열에 끼워 넣지 않고 위치 인자로 넘긴다.
 * 디렉터리 목록(readdir)에 이름이 보이는지와 내용 해시를 함께 확인한다.
 * 빌드 도구는 목록과 속성으로 변경을 감지하므로 경로로 직접 여는 것만으로는 부족하다.
 */
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
  /** 샌드박스 컨테이너에 쓸 Docker 런타임 (예: gVisor의 runsc). 비우면 데몬 기본값(runc) */
  runtime?: string;
}

/**
 * 로컬 Docker(compose)로 샌드박스를 만든다.
 * 개발 환경과 사내 서버 한 대 운영용 구현이다. 컨테이너 격리만으로 부족하면
 * gVisor/Kata 기반 제공자로 교체한다.
 */
export class LocalDockerProvider implements SandboxProvider {
  readonly name = 'local-docker';
  readonly #options: LocalDockerProviderOptions;

  readonly isolation: string | undefined;

  constructor(options: LocalDockerProviderOptions = {}) {
    this.#options = options;
    this.isolation = options.runtime;
  }

  /** compose 파일 없이도 프로젝트 이름(라벨)으로 컨테이너, 볼륨, 네트워크를 지운다. external 공유 캐시는 지우지 않는다 */
  cleanupCommand(sandboxId: string): CleanupCommand {
    assertSandboxId(sandboxId);
    return { command: this.#options.dockerBin ?? 'docker', args: ['compose', '--project-name', sandboxId, 'down', '--volumes', '--remove-orphans'] };
  }

  async cleanup(sandboxId: string): Promise<void> {
    const { command, args } = this.cleanupCommand(sandboxId);
    // 작업 디렉터리의 compose 파일을 읽지 않도록 임시 디렉터리에서 실행한다
    try {
      await execFileAsync(command, args, { cwd: tmpdir() });
    } catch (error) {
      throw new SandboxError(`샌드박스 ${sandboxId}를 정리하지 못했습니다`, error instanceof Error ? error.message : String(error));
    }
  }

  async create(project: LoadedProject, { secrets = {} }: CreateSandboxOptions = {}): Promise<Sandbox> {
    // 런타임이 없으면 compose up 도중이 아니라 샌드박스를 만들기 전에 알린다
    if (this.#options.runtime) await assertRuntime(this.#options.dockerBin ?? 'docker', this.#options.runtime);
    const id = `studio-${project.spec.name}-${randomBytes(3).toString('hex')}`;
    const workDir = await mkdtemp(path.join(tmpdir(), 'b-studio-'));
    const overridePath = path.join(workDir, 'compose.override.yaml');
    const edgeScript = await readFile(EDGE_SCRIPT, 'utf8');
    await writeFile(overridePath, stringify(buildOverride(project, id, { edgeScript, runtime: this.#options.runtime })));
    return new LocalDockerSandbox(id, project, workDir, overridePath, this.#options, secrets, edgeScript);
  }
}

class LocalDockerSandbox implements Sandbox {
  readonly id: string;
  readonly project: LoadedProject;
  readonly #workDir: string;
  readonly #overridePath: string;
  readonly #dockerBin: string;
  readonly #readiness: Partial<ReadinessPolicy>;
  /** docker 명령의 프로세스 환경으로만 넘긴다. override 파일에는 이름만 있다 */
  readonly #secrets: Record<string, string>;
  readonly #redactor: Redactor;
  readonly #edgeScript: string;
  #composeConfig: Promise<{ services: Record<string, { volumes?: Array<{ type: string; source?: string; target: string }> }> }> | undefined;

  constructor(
    id: string,
    project: LoadedProject,
    workDir: string,
    overridePath: string,
    options: LocalDockerProviderOptions,
    secrets: Record<string, string>,
    edgeScript: string,
  ) {
    this.#edgeScript = edgeScript;
    this.id = id;
    this.project = project;
    this.#workDir = workDir;
    this.#overridePath = overridePath;
    this.#dockerBin = options.dockerBin ?? 'docker';
    this.#readiness = options.readiness ?? {};
    this.#secrets = secrets;
    this.#redactor = new Redactor(secrets);
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

    // 한 서비스가 준비에 실패하면 나머지 서비스의 준비 확인도 멈춘다. 그러지 않으면 실패를 돌려준 뒤에도
    // 다른 서비스가 제한 시간(수 분)까지 확인을 계속하며 프로세스와 샌드박스 정리를 붙잡는다
    const giveUp = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, giveUp.signal]) : giveUp.signal;
    let failedFirst: string | undefined;
    // 멈춘 서비스는 자기 문제로 실패한 것이 아니므로 원인 서비스를 알려 준다
    const onStatus: StartOptions['onStatus'] = options.onStatus
      ? (event) =>
          options.onStatus!(
            event.phase === 'failed' && failedFirst && event.service !== failedFirst && !options.signal?.aborted
              ? { ...event, reason: `${failedFirst} 서비스가 준비에 실패해 확인을 멈췄습니다` }
              : event,
          )
      : undefined;
    const endpoints = await Promise.all(
      this.project.managed.map(([name]) =>
        this.#awaitReady(name, { ...options, signal, onStatus }).catch((error: unknown) => {
          failedFirst ??= name;
          giveUp.abort(error);
          throw error;
        }),
      ),
    );

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

    const targets = await withRemovedDirectories(this.project.root, files);
    const expected = new Map(
      await Promise.all(targets.map(async (file) => [file, await hashOrMissing(path.join(this.project.root, file))] as const)),
    );
    const started = Date.now();

    for (let checks = 1; ; checks++) {
      const result = await this.#docker(
        ['run', '--rm', '--network', 'none', '--volume', `${this.project.root}:/project:ro`, SYNC_HELPER_IMAGE, 'sh', '-c', SYNC_SCRIPT, 'sh', ...targets],
        signal,
      );
      if (result.exitCode !== 0) throw new SandboxError('샌드박스 파일 반영 확인에 실패했습니다', result.stderr);

      const seen = parseSyncOutput(result.stdout);
      const pending = targets.filter((file) => seen.get(file) !== expected.get(file));
      if (pending.length === 0) return { elapsedMs: Date.now() - started, checks };

      if (Date.now() - started >= timeoutMs) {
        throw new SandboxError(`${Math.round(timeoutMs / 1_000)}초 안에 샌드박스에 파일 변경이 반영되지 않았습니다: ${pending.join(', ')}`);
      }
      await sleep(250, undefined, { signal });
    }
  }

  async endpoint(name: string): Promise<ServiceEndpoint> {
    const service = this.#managed(name);
    // 서비스는 internal 네트워크에 있어 포트를 공개할 수 없으므로 edge가 대신 공개한 포트를 쓴다
    const { stdout } = await this.#composeOrThrow(['port', EDGE_SERVICE, String(edgePortFor(this.project, name))]);
    return { service: name, containerPort: service.port, url: `http://127.0.0.1:${parseHostPort(stdout)}` };
  }

  async state(name: string): Promise<ContainerState> {
    const { stdout } = await this.#compose(['ps', '--all', '--format', 'json', name]);
    return parseContainerState(stdout);
  }

  async stats(): Promise<ServiceUsage[]> {
    const ids = (await this.#compose(['ps', '--all', '--quiet'])).stdout.split('\n').filter(Boolean);
    if (ids.length === 0) return [];
    const inspected = await this.#docker(['inspect', ...ids]);
    if (inspected.exitCode !== 0) throw new SandboxError(`컨테이너 상태를 읽지 못했습니다 (${this.id})`, inspected.stderr);
    const rows = parseInspectOutput(inspected.stdout);

    // docker stats는 CPU 사용률을 재느라 1초 남짓 걸리므로 실행 중인 컨테이너만 묻는다
    const running = rows.filter((row) => row.state === 'running').map((row) => row.name);
    const stats = running.length > 0 ? await this.#docker(['stats', '--no-stream', '--format', '{{json .}}', ...running]) : undefined;
    return mergeUsage(rows, stats?.exitCode === 0 ? parseStatsOutput(stats.stdout) : []);
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
    const child = spawn(this.#dockerBin, args, { signal, stdio: ['ignore', 'pipe', 'ignore'], env: this.#environment() });
    // signal로 중단하면 AbortError가 발생하는데, 로그 구독 종료는 정상 흐름이다
    child.on('error', () => {});

    try {
      for await (const raw of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
        const line = parseLogLine(raw);
        if (line) yield { ...line, text: this.#redactor.redact(line.text) };
      }
    } finally {
      child.kill();
    }
  }

  async egressDenials({ since }: { since?: Date } = {}): Promise<EgressDenial[]> {
    const denials: EgressDenial[] = [];
    for await (const line of this.logs({ services: [EDGE_SERVICE], tail: 500, follow: false })) {
      const denial = parseEgressDenial(line.text);
      if (denial && (!since || denial.at >= since)) denials.push(denial);
    }
    return denials;
  }

  async exec(
    name: string,
    command: string[],
    { signal, input, raw = false }: { signal?: AbortSignal; input?: string; raw?: boolean } = {},
  ): Promise<ExecResult> {
    const result = await this.#docker(this.#composeArgs(['exec', '-T', name, ...command]), signal, input);
    return raw ? result : { ...result, stdout: this.redact(result.stdout), stderr: this.redact(result.stderr) };
  }

  async relayChanges(changes: FileChange[], { signal }: { signal?: AbortSignal } = {}): Promise<RelayedPath[]> {
    if (changes.length === 0) return [];
    // 바인드 마운트는 세션 동안 바뀌지 않으므로 compose 해석은 한 번만 한다
    this.#composeConfig ??= this.#compose(['config', '--format', 'json']).then((result) => {
      if (result.exitCode !== 0) throw new SandboxError(`compose 설정을 읽지 못했습니다 (${this.id})`, this.redact(result.stderr));
      return JSON.parse(result.stdout) as { services: Record<string, { volumes?: Array<{ type: string; source?: string; target: string }> }> };
    });
    const config = await this.#composeConfig.catch((error: unknown) => {
      this.#composeConfig = undefined;
      throw error;
    });

    const managed = new Set(this.project.managed.map(([name]) => name));
    const relayed: RelayedPath[] = [];
    for (const [service, targets] of planRelay(this.project.root, changes, bindMounts(config.services, managed))) {
      const args = targets.map((target) => `${target.action === 'move' ? 'm' : 'n'}:${target.containerPath}`);
      const result = await this.#compose(['exec', '-T', service, 'sh', '-c', RELAY_SCRIPT, 'sh', ...args], signal);
      // 컨테이너가 재시작 중이면 알리지 못한 경로가 생긴다. 다시 뜬 서비스는 파일을 처음부터 읽으므로 알린 경로만 돌려준다
      const done = new Set(result.stdout.split('\n').filter(Boolean));
      relayed.push(...targets.filter((_, index) => done.has(args[index]!)).flatMap((target) => target.files.map((file) => ({ service, file }))));
    }
    return relayed;
  }

  redact(text: string): string {
    return this.#redactor.redact(text);
  }

  findSecrets(text: string): string[] {
    return this.#redactor.find(text);
  }

  async callExternal(name: string, request: ExternalCallRequest, { via, signal }: { via: string; signal?: AbortSignal }): Promise<ExternalCallResult> {
    if (!(this.project.external ?? []).some(([external]) => external === name)) throw new SandboxError(`'${name}'은(는) 등록한 사내 API가 아닙니다`);
    if (!request.path.startsWith('/')) throw new SandboxError('경로는 "/"로 시작해야 합니다');

    // edge 컨테이너 안에서 실행해 샌드박스 서비스와 같은 네트워크 위치, 정책, 인증 시크릿으로 부른다.
    // 스튜디오용 포트를 따로 열면 샌드박스 서비스가 그 포트로 studio를 사칭할 수 있어 docker exec를 쓴다
    const script = externalCallScript(this.#edgeScript, { name, via, ...request });
    const result = await this.#docker(this.#composeArgs(['exec', '-T', EDGE_SERVICE, 'node', '--input-type=module', '-']), signal, script);
    const last = result.stdout.trim().split('\n').at(-1);
    if (result.exitCode !== 0 || !last) throw new SandboxError('사내 API 호출을 실행하지 못했습니다', this.redact(result.stderr));
    const parsed = JSON.parse(last) as ExternalCallResult;
    return { ...parsed, body: this.redact(parsed.body) };
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
            ['run', '--rm', '--network', 'none', '--volume', `${plan.snapshot}:/from:ro`, '--volume', `${plan.sandboxVolume}:/to`, SYNC_HELPER_IMAGE, 'sh', '-c', SEED_SCRIPT],
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
        'run', '--rm', '--network', 'none', '--volume', `${plan.sandboxVolume}:/from:ro`, '--volume', `${plan.snapshot}:/to`, SYNC_HELPER_IMAGE, 'sh', '-c', CAPTURE_SCRIPT,
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
      const running = execFileAsync(this.#dockerBin, args, { signal, maxBuffer: 256 * 1024 * 1024, env: this.#environment() });
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
    if (result.exitCode !== 0) throw new SandboxError(`docker compose ${args[0]} 실패 (${this.id})`, this.redact(result.stderr));
    return result;
  }

  /** compose가 override의 빈 시크릿 자리를 이 환경에서 채운다 */
  #environment(): NodeJS.ProcessEnv {
    return { ...process.env, ...this.#secrets };
  }
}

/** 스튜디오 서버·CLI 환경 변수 B_STUDIO_CONTAINER_RUNTIME. 격리 수준은 프로젝트가 아니라 운영자가 정한다 */
export function runtimeFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.B_STUDIO_CONTAINER_RUNTIME?.trim() || undefined;
}

async function assertRuntime(dockerBin: string, runtime: string): Promise<void> {
  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(dockerBin, ['info', '--format', '{{json .Runtimes}}']));
  } catch (error) {
    throw new SandboxError('Docker 데몬 정보를 읽지 못해 컨테이너 런타임을 확인하지 못했습니다', error instanceof Error ? error.message : String(error));
  }
  const available = parseRuntimes(stdout);
  if (!available.includes(runtime)) {
    throw new SandboxError(`컨테이너 런타임 '${runtime}'이 Docker 데몬에 등록되지 않았습니다 (등록된 런타임: ${available.join(', ') || '없음'})`);
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
