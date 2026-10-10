import { execFile, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import type { LoadedProject, ManagedServiceSpec } from '@b-studio/spec';
import { stringify } from 'yaml';
import { isDockerUnreachable, SandboxError } from '../errors';
import { crashLogExcerpt, DEFAULT_READINESS, ReadinessError, shouldRetryTransientCrash, waitForReady, type ReadinessPolicy } from '../readiness';
import { assertSandboxId } from '../sandbox-id';
import { Redactor } from '../secrets';
import { withRemovedDirectories } from '../sync-paths';
import type {
  BootNetwork,
  CleanupCommand,
  ContainerState,
  CreateSandboxOptions,
  EgressDenial,
  ExecResult,
  ExternalCallRequest,
  ExternalCallResult,
  FileChange,
  InfraCheckResult,
  LoadRequest,
  LoadResult,
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
import { runCommandFromFile, runCommandToFile } from '../stream-exec';
import { findFreeHostPort } from './free-port';
import {
  buildOverride,
  composeUpArgs,
  EDGE_SERVICE,
  edgePortFor,
  egressAuditExcerpt,
  parseContainerState,
  parseContainerStates,
  parseEgressDenial,
  parseHostPort,
  parseLogLine,
  parseRuntimes,
  SYNC_SCRIPT,
  parseSyncOutput, SyncObservations,
  SANDBOX_NETWORK,
} from './format';
import { externalCallScript } from './external-call';
import { awaitedCondition, loadDependsOn, startWaves } from './compose-deps';
import { LOAD_DEADLINE_MS, LOAD_REQUEST_TIMEOUT_MS, loadConfig, loadRunArgs, loadScript, loadThreads, parseLoadOutput } from './load-runner';
import { findMissingMasks, loadGitMask, type InspectedMount, type MaskVolume } from './git-mask';
import { bindMounts, planRelay, RELAY_SCRIPT } from './relay';
import { bootNetworkFromUsage, mergeUsage, parseInspectOutput, parseStatsOutput } from './usage';
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

/** compose 파일이 up과 겹쳐 계속 바뀔 때 .git 마스크를 맞춰 다시 올리는 최대 횟수 */
const GIT_MASK_ATTEMPTS = 3;
/** 사용량 조회(ps·inspect·stats) 전체의 상한. 평소에는 2~3초 걸린다 */
const STATS_TIMEOUT_MS = 15_000;
/** 의존 서비스가 준비될 때까지 기다리는 상한. compose는 healthcheck가 실패로 끝날 때까지 기다리지만, 끝나지 않는 대기는 두지 않는다 */
const DEPENDENCY_WAIT_MS = 300_000;
const DEPENDENCY_POLL_MS = 500;

/**
 * compose가 샌드박스용으로 빌드한 이미지(<샌드박스 id>-<서비스>)를 지운다.
 * 이름에 세션 id가 들어가 다른 세션이 다시 쓰지 않으므로 남기면 세션마다 수백 MB씩 쌓여 Docker 디스크를 채운다.
 * 빌드 캐시는 지우지 않으므로 다음 세션의 빌드 속도는 그대로다
 */
async function removeSandboxImages(dockerBin: string, sandboxId: string): Promise<void> {
  assertSandboxId(sandboxId);
  const { stdout } = await execFileAsync(dockerBin, ['image', 'ls', '--filter', `reference=${sandboxId}-*`, '--format', '{{.Repository}}:{{.Tag}}'], { cwd: tmpdir() });
  const images = stdout.split('\n').map((line) => line.trim()).filter((line) => line.startsWith(`${sandboxId}-`));
  if (images.length > 0) await execFileAsync(dockerBin, ['image', 'rm', ...images], { cwd: tmpdir() });
}

/** Docker VM 디스크가 가득 찼을 때 원인과 다음 행동을 알려 주는 문구 */
export const DOCKER_OUT_OF_SPACE = "Docker 디스크가 가득 찼습니다. 'studio sandbox prune --dry-run' 으로 남은 샌드박스 자원을 확인하고 정리하거나 Docker VM 디스크를 늘리세요.";

/** 호스트에서 미리 고른 포트를 colima VM 안의 다른 컨테이너가 이미 쓰고 있을 때 compose up이 남기는 stderr 패턴들 */
const PORT_BIND_CONFLICT = /failed to bind port .*address already in use|error starting userland proxy|address already in use|port is already allocated/i;

/** compose up 실패가 호스트↔VM 포트 가시성 차이로 인한 바인드 충돌인지 본다(findFreeHostPort가 미리 고른 포트를
 *  VM 안의 다른 컨테이너가 이미 쓰고 있는 경우) — 다른 실패(디스크 부족, 이미지 빌드 실패 등)는 재시도하지 않는다 */
export function isPortBindConflict(stderr: string): boolean {
  return PORT_BIND_CONFLICT.test(stderr);
}

/** compose up 포트 충돌 재시도 한도(최초 시도 포함) */
const PORT_RETRY_ATTEMPTS = 3;

/**
 * docker 명령이 디스크 부족으로 실패했는지 보고, 그렇다면 안내 문구를 덧붙인다.
 * 그 밖의 오류는 원문을 그대로 돌려준다. 오류를 삼키지 않도록 항상 원래 메시지를 포함한다
 */
export function describeDockerFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.includes('no space left on device') ? `${text}\n${DOCKER_OUT_OF_SPACE}` : text;
}

/** 샌드박스 출입구 스크립트. 원격 Docker 호스트에서도 돌도록 파일을 마운트하지 않고 내용을 compose 설정에 넣는다 */
const EDGE_SCRIPT = new URL('../../edge/edge.mjs', import.meta.url);

/** 부하 확인 러너. edge와 같은 까닭으로 파일을 마운트하지 않고 내용을 표준 입력으로 넘긴다 */
const LOAD_RUNNER_SCRIPT = new URL('../../load/runner.mjs', import.meta.url);
/** 러너가 스스로 끝내는 상한(요청 제한 시간 포함) 뒤에도 돌아오지 않으면 도커 쪽이 멈춘 것으로 본다 */
const LOAD_RUN_GRACE_MS = 30_000;

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
  /** 사용량 조회(ps·inspect·stats) 전체의 상한(ms). 기본 15초. 테스트에서 짧게 준다 */
  statsTimeoutMs?: number;
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

  /**
   * compose 파일 없이도 프로젝트 이름(라벨)으로 컨테이너, 볼륨, 네트워크, 이 샌드박스가 빌드한 이미지를 지운다. external 공유 캐시는 지우지 않는다.
   * 스튜디오가 강제 종료되기 전에 따로 띄우는 명령이라 한 번에 끝나야 한다. 컨테이너가 남아 있을 때는 --rmi local이 라벨로 이미지를 찾는다
   */
  cleanupCommand(sandboxId: string): CleanupCommand {
    assertSandboxId(sandboxId);
    return {
      command: this.#options.dockerBin ?? 'docker',
      args: ['compose', '--project-name', sandboxId, 'down', '--volumes', '--remove-orphans', '--rmi', 'local'],
    };
  }

  async cleanup(sandboxId: string): Promise<void> {
    const { command, args } = this.cleanupCommand(sandboxId);
    // 작업 디렉터리의 compose 파일을 읽지 않도록 임시 디렉터리에서 실행한다
    try {
      await execFileAsync(command, args, { cwd: tmpdir() });
      // 컨테이너가 이미 없으면 --rmi local이 이미지를 찾지 못한다. 이름으로 한 번 더 지운다
      await removeSandboxImages(command, sandboxId);
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
    const hostPorts = await preallocatePublicUrlPorts(project);
    const gitMask = await loadGitMask(project, { dockerBin: this.#options.dockerBin, env: { ...process.env, ...secrets }, projectName: id, redact: (text) => new Redactor(secrets).redact(text) });
    await writeFile(overridePath, stringify(buildOverride(project, id, { edgeScript, runtime: this.#options.runtime, hostPorts, gitMask })));
    return new LocalDockerSandbox(id, project, workDir, overridePath, this.#options, secrets, edgeScript, gitMask, hostPorts);
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
  /** 컨테이너를 만드는 up 직전마다 compose 파일에서 다시 계산한다(#refreshGitMask) */
  #gitMask: Record<string, MaskVolume[]>;
  readonly #statsTimeoutMs: number;
  /** up을 한 번에 하나씩 돌리는 줄. 만들기 → 확인 → 시작 사이에 다른 up이 끼어들지 못하게 한다 */
  #upQueue: Promise<unknown> = Promise.resolve();
  #loadRunner: Promise<string> | undefined;
  #daemonCpus: Promise<number | undefined> | undefined;
  #hostPorts: Record<string, number>;
  readonly #runtime: string | undefined;
  #composeConfig: Promise<{ services: Record<string, { volumes?: Array<{ type: string; source?: string; target: string }> }> }> | undefined;

  constructor(
    id: string,
    project: LoadedProject,
    workDir: string,
    overridePath: string,
    options: LocalDockerProviderOptions,
    secrets: Record<string, string>,
    edgeScript: string,
    gitMask: Record<string, MaskVolume[]>,
    hostPorts: Record<string, number>,
  ) {
    this.#edgeScript = edgeScript;
    this.#gitMask = gitMask;
    this.#hostPorts = hostPorts;
    this.id = id;
    this.project = project;
    this.#workDir = workDir;
    this.#overridePath = overridePath;
    this.#dockerBin = options.dockerBin ?? 'docker';
    this.#readiness = options.readiness ?? {};
    this.#runtime = options.runtime;
    this.#statsTimeoutMs = options.statsTimeoutMs ?? STATS_TIMEOUT_MS;
    this.#secrets = secrets;
    this.#redactor = new Redactor(secrets);
  }

  async start(options: StartOptions = {}): Promise<ServiceEndpoint[]> {
    // 서비스 선택(ADR-083): services를 주면 그 서비스만 띄우고, 나머지 managed 서비스는 'off'로 알린다(실패가 아니다).
    // 주지 않으면 옛 동작대로 모든 서비스를 띄운다(다른 제공자 호출부·고정 픽스처와 호환)
    const selected = options.services ? new Set(options.services) : undefined;
    const isSelected = (name: string) => !selected || selected.has(name);
    const startingManaged = this.project.managed.filter(([name]) => isSelected(name));
    for (const [name] of this.project.managed) options.onStatus?.(isSelected(name) ? { service: name, phase: 'starting' } : { service: name, phase: 'off' });
    await this.#ensureSharedVolumes();

    // B_STUDIO_SANDBOX_BUILD_NO_CACHE=1이면 이 샌드박스 프로젝트의 이미지만 레이어 캐시 없이 빌드하고,
    // 스냅샷 볼륨도 쓰지 않는다(다른 프로젝트의 빌드 캐시는 건드리지 않는다). 스냅샷 볼륨을 지우지는 않는다.
    const noCache = sandboxBuildNoCache();
    // 스냅샷 복사가 compose up을 늦추지 않도록 이미지 빌드와 동시에 한다. 꺼 둔 서비스는 스냅샷도 건드리지 않는다
    const plans = (await this.#planSnapshots()).filter((plan) => isSelected(plan.service));
    // 선택이 있는데 띄울 게 없으면(전부 꺼 둠) build를 부르지 않는다 — 인자 없는 build는 "전부 빌드"라는 뜻이라서다
    const buildBase = noCache ? ['build', '--no-cache'] : ['build'];
    const buildArgs = !selected ? buildBase : selected.size === 0 ? undefined : [...buildBase, ...selected];
    const [seeded] = await Promise.all([
      noCache ? Promise.resolve(plans.map(() => false)) : Promise.all(plans.map((plan) => this.#seedSnapshot(plan, options))),
      buildArgs ? this.#composeOrThrow(buildArgs, options.signal) : Promise.resolve(),
    ]);

    await this.#composeUpWithPortRetry(composeUpArgs(options.services, EDGE_SERVICE), options.signal);

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
      startingManaged.map(([name]) =>
        this.#awaitReady(name, { ...options, signal, onStatus }).catch((error: unknown) => {
          failedFirst ??= name;
          giveUp.abort(error);
          throw error;
        }),
      ),
    );

    // 서비스가 모두 준비된 직후 한 번 stats를 읽어 기동 중 받은 바이트를 알린다
    await this.#reportBootNetwork(options);

    // 설치 단계만 끝나고 에이전트가 아직 도구를 쓰지 않은 시점의 볼륨을 다음 기동용으로 남긴다
    await Promise.all(plans.filter((_, index) => !seeded[index]).map((plan) => this.#captureSnapshot(plan, options)));
    return endpoints;
  }

  /**
   * 서비스 하나를 켜거나 끈다(ADR-083). 켤 때는 이미지를 다시 빌드해 최신 코드로 컨테이너를 만들고,
   * 다른 서비스는 따라 띄우지 않는다(--no-deps). 끌 때는 컨테이너를 멈추기만 한다(볼륨은 남는다, restart()의 force-recreate와 다르다).
   * 준비 판정은 하지 않는다 — 호출자가 managed 서비스를 켰다면 restart()나 endpoint()로 상태를 반영한다
   */
  async setServiceRunning(name: string, running: boolean, { signal }: { signal?: AbortSignal } = {}): Promise<void> {
    if (!this.project.composeServices.includes(name)) throw new SandboxError(`'${name}'은(는) 이 프로젝트의 compose 서비스가 아닙니다 (${this.id})`);
    await this.#composeOrThrow(running ? ['up', '--detach', '--build', '--no-deps', name] : ['stop', name], signal);
  }

  /**
   * 부가 서비스를 다시 만들어 띄운다(도그푸딩 마찰 143). managed 서비스의 restart()와 같은 플래그
   * (--build --force-recreate)를 쓰지만, 포트·엔드포인트 개념이 없는 부가 서비스라 준비 판정 없이 바로 끝난다.
   * 호출자(executeTool)는 이 메서드를 부르기 전에 데이터베이스·꺼 둔 서비스를 걸러낸다
   */
  async restartAddon(name: string, { signal }: { signal?: AbortSignal } = {}): Promise<void> {
    if (!this.project.composeServices.includes(name)) throw new SandboxError(`'${name}'은(는) 이 프로젝트의 compose 서비스가 아닙니다 (${this.id})`);
    await this.#composeOrThrow(['up', '--detach', '--build', '--no-deps', '--force-recreate', name], signal);
  }

  /**
   * edge 프록시 + 넘긴 서비스가 실제로 running인지 보고, 없으면 이 샌드박스의 compose 프로젝트 안에서만
   * 다시 올린다(트러블슈팅 86, ADR-143). 코드가 바뀐 게 아니라 컨테이너가 사라진 것뿐이므로 이미지는
   * 다시 빌드하지 않는다(restart()의 --build --force-recreate와 다르다). --no-deps로 넘긴 서비스만 건드린다
   */
  async ensureInfra(services: readonly string[], { signal }: { signal?: AbortSignal } = {}): Promise<InfraCheckResult> {
    const expected = [...new Set([EDGE_SERVICE, ...services])].sort();
    const missing = await this.#missingServices(expected, signal);
    if (missing.length === 0) return { ok: true, recovered: [] };

    const result = await this.#compose(['up', '--detach', '--no-deps', ...missing], signal);
    if (result.exitCode !== 0) {
      return { ok: false, recovered: [], missing, reason: describeDockerFailure(this.redact(result.stderr)) };
    }

    const stillMissing = await this.#missingServices(missing, signal);
    if (stillMissing.length > 0) {
      return {
        ok: false,
        recovered: missing.filter((name) => !stillMissing.includes(name)),
        missing: stillMissing,
        reason: `다시 올렸지만 ${stillMissing.join(', ')} 컨테이너가 여전히 running 상태가 아닙니다`,
      };
    }
    return { ok: true, recovered: missing };
  }

  /** 넘긴 서비스 이름 중 컨테이너가 running이 아닌(혹은 아예 없는) 것만 돌려준다 */
  async #missingServices(names: readonly string[], signal?: AbortSignal): Promise<string[]> {
    if (names.length === 0) return [];
    const { stdout } = await this.#compose(['ps', '--all', '--format', 'json', ...names], signal);
    const states = parseContainerStates(stdout);
    return names.filter((name) => states.get(name) !== 'running');
  }

  /**
   * 서비스가 준비된 직후 한 번 stats를 읽어 컨테이너별 수신/송신 바이트를 알린다.
   * 값은 컨테이너 수명 누계라 기동 직후에 읽으면 "기동 중 받은 양"으로 본다.
   *
   * 한계: 이미지 빌드 단계에서 받은 것(docker build가 받는 의존성)은 컨테이너 NetIO에 잡히지 않는다.
   * edge 프록시 컨테이너는 서비스 트래픽이 지나가므로 더하면 이중 계산이라 뺀다.
   */
  async #reportBootNetwork({ onBootNetwork }: StartOptions): Promise<void> {
    if (!onBootNetwork) return;
    try {
      const network: BootNetwork = bootNetworkFromUsage(await this.stats(), EDGE_SERVICE);
      onBootNetwork(network);
    } catch {
      // 수신 바이트를 못 읽어도 기동은 계속한다. 기동 지표는 부가 정보다
    }
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
    const observations = new SyncObservations();

    for (let checks = 1; ; checks++) {
      const result = await this.#docker(
        ['run', '--rm', '--network', 'none', '--volume', `${this.project.root}:/project:ro`, SYNC_HELPER_IMAGE, 'sh', '-c', SYNC_SCRIPT, 'sh', ...targets],
        signal,
      );
      if (result.exitCode !== 0) throw new SandboxError('샌드박스 파일 반영 확인에 실패했습니다', result.stderr, { platform: true });

      const seen = parseSyncOutput(result.stdout);
      const pending = targets.filter((file) => seen.get(file) !== expected.get(file));
      if (pending.length === 0) return { elapsedMs: Date.now() - started, checks };
      for (const file of pending) observations.record(file, seen.get(file));

      if (Date.now() - started >= timeoutMs) {
        // 반영이 끝나지 않은 것은 호스트와 컨테이너 사이의 파일 공유 문제다. 코드를 고쳐서 풀 수 없다
        throw new SandboxError(observations.describeTimeout(pending, expected, timeoutMs), undefined, { platform: true });
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
    // 끊긴 소켓에 건 호출은 끝나지 않을 수 있다. 몇 초마다 재는 쪽이 앞선 측정을 기다리다 영영 멈추지 않게 상한을 둔다(트러블슈팅 123)
    const signal = AbortSignal.timeout(this.#statsTimeoutMs);
    const unanswered = `도커가 ${this.#statsTimeoutMs / 1000}초 안에 응답하지 않았습니다`;
    const listed = await this.#docker(this.#composeArgs(['ps', '--all', '--quiet']), signal);
    // 목록을 읽지 못한 것을 "컨테이너 없음"으로 돌려주면 도커에 닿지 않는 것과 컨테이너가 없는 것을 구분할 수 없다
    if (listed.exitCode !== 0) throw new SandboxError(`컨테이너 목록을 읽지 못했습니다 (${this.id})`, signal.aborted ? unanswered : this.redact(listed.stderr), { platform: true });
    const ids = listed.stdout.split('\n').filter(Boolean);
    if (ids.length === 0) return [];
    const inspected = await this.#docker(['inspect', ...ids], signal);
    if (inspected.exitCode !== 0) throw new SandboxError(`컨테이너 상태를 읽지 못했습니다 (${this.id})`, signal.aborted ? unanswered : inspected.stderr, { platform: true });
    const rows = parseInspectOutput(inspected.stdout);

    // docker stats는 CPU 사용률을 재느라 1초 남짓 걸리므로 실행 중인 컨테이너만 묻는다
    const running = rows.filter((row) => row.state === 'running').map((row) => row.name);
    const stats = running.length > 0 ? await this.#docker(['stats', '--no-stream', '--format', '{{json .}}', ...running], signal) : undefined;
    if (signal.aborted) throw new SandboxError(`컨테이너 사용량을 읽지 못했습니다 (${this.id})`, unanswered, { platform: true });
    const managedNames = new Set(this.project.managed.map(([name]) => name));
    return mergeUsage(rows, stats?.exitCode === 0 ? parseStatsOutput(stats.stdout) : [], managedNames);
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

  async execToFile(name: string, command: string[], outputFile: string, { signal, raw = false }: { signal?: AbortSignal; raw?: boolean } = {}): Promise<ExecResult> {
    const result = await runCommandToFile(this.#dockerBin, this.#composeArgs(['exec', '-T', name, ...command]), outputFile, { signal, env: this.#environment() });
    return raw ? result : { ...result, stderr: this.redact(result.stderr) };
  }

  async execFromFile(name: string, command: string[], inputFile: string, { signal, raw = false }: { signal?: AbortSignal; raw?: boolean } = {}): Promise<ExecResult> {
    const result = await runCommandFromFile(this.#dockerBin, this.#composeArgs(['exec', '-T', name, ...command]), inputFile, { signal, env: this.#environment() });
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
    // ADR-088: managed 서비스가 전부 프로젝트 루트를 통째로 마운트하므로, 서비스 폴더(subroot)로 한 번 더 좁혀야
    // 같은 루트를 마운트한 다른 서비스로 잘못 알리지 않는다
    const servicePaths = Object.fromEntries(this.project.managed.map(([name, spec]) => [name, spec.path]));
    const relayed: RelayedPath[] = [];
    for (const [service, targets] of planRelay(this.project.root, changes, bindMounts(config.services, managed, servicePaths))) {
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

  async runLoad(request: LoadRequest, { signal }: { signal?: AbortSignal } = {}): Promise<LoadResult> {
    const service = this.#managed(request.service);
    // 꺼 뒀거나 죽은 서비스에 보내면 전부 연결 실패로만 나온다. 보내기 전에 까닭을 알린다
    const state = await this.state(request.service);
    if (state !== 'running') throw new SandboxError(`'${request.service}' 서비스가 실행 중이 아니어서 부하 확인을 돌릴 수 없습니다 (상태: ${state})`);

    this.#loadRunner ??= readFile(LOAD_RUNNER_SCRIPT, 'utf8');
    this.#daemonCpus ??= this.#docker(['info', '--format', '{{.NCPU}}']).then((info) => (info.exitCode === 0 ? Number.parseInt(info.stdout.trim(), 10) || undefined : undefined));
    const threads = loadThreads(request.concurrent, await this.#daemonCpus);
    const name = `${this.id}-load-${randomBytes(4).toString('hex')}`;
    const script = loadScript(await this.#loadRunner, loadConfig(request, { port: service.port, threads }));
    const limit = AbortSignal.timeout(LOAD_DEADLINE_MS + LOAD_REQUEST_TIMEOUT_MS + LOAD_RUN_GRACE_MS);
    const args = loadRunArgs({ name, network: `${this.id}_${SANDBOX_NETWORK}`, sandboxId: this.id, threads, ...(this.#runtime ? { runtime: this.#runtime } : {}) });
    const result = await this.#docker(args, signal ? AbortSignal.any([signal, limit]) : limit, script);

    if (signal?.aborted || limit.aborted) {
      // 중단하면 docker 클라이언트만 끝나고 컨테이너는 남는다. 이 실행이 만든 이름으로만 지운다
      await this.#docker(['rm', '--force', name]).catch(() => undefined);
      signal?.throwIfAborted();
      throw new SandboxError('부하 러너가 제한 시간 안에 끝나지 않았습니다', undefined, { platform: true });
    }
    if (result.exitCode !== 0) {
      const reason = result.exitCode === 137 ? '러너가 메모리 한도(512MB)를 넘어 종료됐습니다' : this.redact(result.stderr.trim().split('\n').slice(-5).join('\n'));
      throw new SandboxError(`부하 러너를 실행하지 못했습니다 (종료 코드 ${result.exitCode})`, reason, { platform: true });
    }
    const parsed = parseLoadOutput(result.stdout, request);
    if (!parsed) throw new SandboxError('부하 러너의 결과를 읽지 못했습니다', this.redact(result.stdout.trim().split('\n').slice(-3).join('\n')), { platform: true });
    return parsed;
  }

  async destroy(): Promise<void> {
    try {
      await this.#composeOrThrow(['down', '--volumes', '--remove-orphans', '--rmi', 'local']);
      await removeSandboxImages(this.#dockerBin, this.id);
    } finally {
      await rm(this.#workDir, { recursive: true, force: true });
    }
  }

  async #awaitReady(name: string, { signal, onStatus, onTransientRetry }: StartOptions, attempt = 1): Promise<ServiceEndpoint> {
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
        let reason = error instanceof Error ? error.message : String(error);
        // 컨테이너가 죽었으면 앱 로그의 마지막 오류 줄을 이유에 붙인다. 로그를 못 읽어도 원래 이유는 그대로 둔다
        const crashed = error instanceof ReadinessError && ['exited', 'dead'].includes(error.history.at(-1)?.containerState ?? '');
        if (crashed) {
          const lines: string[] = [];
          try {
            for await (const line of this.logs({ services: [name], tail: 60, follow: false })) lines.push(line.text);
          } catch {
            // 로그를 못 읽어도 실패 이유는 남긴다
          }
          const excerpt = crashLogExcerpt(lines);

          // 트러블슈팅 #90: 설치 스크립트가 막 쓴 실행 파일을 실행하다 생기는 일시 오류(ETXTBSY 등)로 죽었으면
          // 같은 컨테이너를 한 번만 다시 띄워 본다(무한 재시도 금지 — attempt가 1일 때만 재시도한다). 세션
          // c55417ad에서는 바로 다시 기동하면 정상으로 떴다 — 파일이 이미 끝까지 쓰인 뒤라 같은 경합이 되풀이되지 않는다
          if (shouldRetryTransientCrash(attempt, excerpt)) {
            onTransientRetry?.({ service: name, reason: excerpt.join(' / ') || reason });
            onStatus?.({ service: name, phase: 'starting' });
            await this.#composeOrThrow(['up', '--detach', '--build', '--no-deps', '--force-recreate', name], signal);
            return this.#awaitReady(name, { signal, onStatus, onTransientRetry }, attempt + 1);
          }

          if (excerpt.length > 0) reason = `${reason}\n앱 로그 마지막 줄:\n${excerpt.join('\n')}`;

          // edge의 egress 감사 로그도 같이 본다(#411, 실험 E10). 레인이 "허용 목록에 없음"이 아니라
          // "이름을 풀지 못함"(DNS·네트워크 장애) 때문에 기동에 실패했는지는 edge 컨테이너 로그에만 남고,
          // 실행이 끝나 컨테이너가 지워지면 사라진다 — 실패 바로 그 순간에 덧붙여야 결과 파일·UI에 남는다
          const egressLines: string[] = [];
          try {
            for await (const line of this.logs({ services: [EDGE_SERVICE], tail: 200, follow: false })) egressLines.push(line.text);
          } catch {
            // 로그를 못 읽어도 실패 이유는 남긴다
          }
          const egressExcerpt = egressAuditExcerpt(egressLines);
          if (egressExcerpt.length > 0) reason = `${reason}\negress 최근 기록:\n${egressExcerpt.join('\n')}`;

          if (error instanceof Error) error.message = reason;
        }
        onStatus?.({ service: name, phase: 'failed', reason });
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

  async #compose(args: string[], signal?: AbortSignal): Promise<ExecResult> {
    if (args[0] === 'up') return this.#upWithGitMask(args, signal);
    return this.#docker(this.#composeArgs(args), signal);
  }

  /**
   * 컨테이너는 up이 만들 때 마운트가 정해진다. compose 파일은 에이전트가 세션 중에 고칠 수 있으므로(ADR-158)
   *  1. up 직전에 마운트를 다시 읽어 .git 마스크를 맞추고,
   *  2. up이 끝난 뒤 한 번 더 읽어 그 사이에 파일이 바뀌었으면(마스크 없는 마운트로 만들어졌을 수 있다) override를 새로 쓰고 다시 up하며,
   *     GIT_MASK_ATTEMPTS번 안에 안정되지 않으면 스택을 내리고 던진다,
   *  3. 설정이 아니라 결과를 확인한다: 실제 컨테이너의 마운트에서 `.git` 자리의 읽기 전용 마운트가 빠졌으면 던진다.
   *
   * 확인은 **시작하기 전에** 한다(트러블슈팅 121). 예전에는 시작한 뒤에 확인해서, 보호가 빠진 컨테이너가 멈추기 전까지 실행됐다.
   *  - 만들기: `up --no-start`. 빌드와 다시 만들기는 여기서 한다.
   *  - 확인: 만들어진 컨테이너의 마운트를 본다. 하나도 보이지 않으면 통과가 아니라 실패다.
   *  - 시작: **확인한 컨테이너만** 시작한다. 시작 단계가 컨테이너를 만들 수 있으면 확인하지 않은 것이 시작되므로
   *    (`up --no-recreate`는 없는 컨테이너를 만든다) 만들지 못하는 명령만 쓴다 — 이름을 준 up은 확인한 컨테이너의 id로
   *    `docker start`, 전체 up은 `compose start`(의존 순서·헬스체크 대기는 `up`과 같고 컨테이너를 만들지 않는다).
   *  - 시작한 뒤에도 한 번 더 확인한다(바깥에서 컨테이너를 바꿔 넣은 경우).
   * 한 샌드박스의 up은 한 번에 하나만 돈다. 확인과 시작 사이에 다른 up이 컨테이너를 다시 만들어 끼워 넣지 못하게 한다
   */
  async #upWithGitMask(args: string[], signal?: AbortSignal): Promise<ExecResult> {
    const run = this.#upQueue.then(() => this.#upOnce(args, signal));
    this.#upQueue = run.catch(() => undefined);
    return run;
  }

  async #upOnce(args: string[], signal?: AbortSignal): Promise<ExecResult> {
    const { create, services, byId } = splitUpArgs(args);
    for (let attempt = 1; attempt <= GIT_MASK_ATTEMPTS; attempt++) {
      signal?.throwIfAborted();
      await this.#refreshGitMask();
      // 빌드 실패는 여기서 난다(`--build`는 만들기 단계에만 준다)
      const created = await this.#docker(this.#composeArgs(create), signal);
      if (created.exitCode !== 0) return created;
      const before = JSON.stringify(this.#gitMask);
      await this.#refreshGitMask();
      if (JSON.stringify(this.#gitMask) !== before) continue;
      const verified = await this.#verifyMasks('created');
      // 포트 바인드 충돌은 여기서 난다(바인드는 시작할 때 일어난다)
      const started = byId ? await this.#startVerified(verified, services, signal) : await this.#docker(this.#composeArgs(['start', ...services]), signal);
      if (started.exitCode !== 0) return started;
      await this.#verifyMasks('started');
      return started;
    }
    await this.#docker(this.#composeArgs(['down', '--remove-orphans']), signal);
    throw new SandboxError(`compose 파일이 계속 바뀌어 .git 보호를 확정하지 못했습니다. 서비스를 내렸습니다 (${this.id})`);
  }

  /**
   * 확인한 컨테이너를 id로 시작한다. 서비스가 여럿이면 `up --no-deps a b`가 하던 대로 **목록 안의 의존 순서**를 지키고,
   * `service_healthy`·`service_completed_successfully` 조건은 그 상태가 될 때까지 기다린 뒤 다음 묶음을 시작한다.
   * 목록에 없는 의존 서비스는 건드리지 않는다. 실패는 compose의 실패처럼 종료 코드와 stderr로 돌려준다
   */
  async #startVerified(verified: ReadonlyArray<{ id: string; service: string | undefined }>, services: readonly string[], signal?: AbortSignal): Promise<ExecResult> {
    const idsOf = (names: readonly string[]) => verified.filter((container) => container.service !== undefined && names.includes(container.service)).map((container) => container.id);
    const missing = services.filter((service) => idsOf([service]).length === 0);
    if (missing.length > 0) throw new SandboxError(`만든 컨테이너를 찾지 못해 시작하지 않았습니다 (${this.id})`, missing.join(', '), { platform: true });
    if (services.length === 1) return this.#docker(['start', ...idsOf(services)], signal);

    const dependsOn = await loadDependsOn(this.project, { dockerBin: this.#dockerBin, env: this.#environment(), projectName: this.id, redact: (text) => this.redact(text) });
    const waves = startWaves(services, dependsOn);
    let last: ExecResult = { exitCode: 0, stdout: '', stderr: '' };
    for (const [index, wave] of waves.entries()) {
      last = await this.#docker(['start', ...idsOf(wave)], signal);
      if (last.exitCode !== 0) return last;
      const later = waves.slice(index + 1).flat();
      for (const service of wave) {
        const condition = awaitedCondition(service, later, dependsOn);
        if (!condition) continue;
        const problem = await this.#waitForDependency(idsOf([service]), service, condition, signal);
        if (problem) return { exitCode: 1, stdout: '', stderr: problem };
      }
    }
    return last;
  }

  /** 의존 서비스가 조건을 채울 때까지 기다린다. 채우지 못하면 사유를 돌려준다(compose의 "dependency failed to start"와 같은 자리) */
  async #waitForDependency(ids: readonly string[], service: string, condition: 'service_healthy' | 'service_completed_successfully', signal?: AbortSignal): Promise<string | undefined> {
    const deadline = Date.now() + DEPENDENCY_WAIT_MS;
    for (;;) {
      signal?.throwIfAborted();
      const inspected = await this.#docker(['inspect', '--format', '{{json .State}}', ...ids]);
      if (inspected.exitCode !== 0) return `dependency failed to start: ${service}의 상태를 읽지 못했습니다`;
      let states: Array<{ Status?: string; ExitCode?: number; Health?: { Status?: string } | null }>;
      try {
        states = inspected.stdout.split('\n').filter((line) => line.trim()).map((line) => JSON.parse(line));
      } catch {
        return `dependency failed to start: ${service}의 상태를 해석하지 못했습니다`;
      }
      if (states.length === 0) return `dependency failed to start: ${service}의 상태를 읽지 못했습니다`;
      if (condition === 'service_healthy') {
        // compose와 같다: healthcheck가 없는 서비스에 service_healthy를 걸면 기다릴 수 없어 실패한다
        if (states.some((state) => !state.Health)) return `dependency failed to start: container ${service} has no healthcheck configured`;
        if (states.every((state) => state.Health?.Status === 'healthy')) return undefined;
        if (states.some((state) => state.Health?.Status === 'unhealthy')) return `dependency failed to start: container ${service} is unhealthy`;
        if (states.some((state) => state.Status === 'exited' || state.Status === 'dead')) return `dependency failed to start: container ${service} exited`;
      } else {
        if (states.every((state) => state.Status === 'exited' && state.ExitCode === 0)) return undefined;
        const failed = states.find((state) => state.Status === 'exited' && state.ExitCode !== 0);
        if (failed) return `service "${service}" didn't complete successfully: exit ${failed.ExitCode}`;
      }
      if (Date.now() > deadline) return `dependency failed to start: ${service}이(가) ${Math.round(DEPENDENCY_WAIT_MS / 1000)}초 안에 준비되지 않았습니다`;
      await sleep(DEPENDENCY_POLL_MS, undefined, { signal });
    }
  }

  /**
   * 이 샌드박스의 실제 컨테이너 마운트를 보고, 확인한 컨테이너(id와 서비스 이름)를 돌려준다.
   * `.git` 보호가 빠진 컨테이너가 있으면 지우고 던진다 — 시작하기 전이면 한 번도 시작되지 않고, 시작한 뒤면 바로 죽인다
   * (`docker stop`은 종료를 10초까지 기다려 그동안 보호 없이 돈다). 목록·마운트·볼륨 정보를 읽지 못했거나
   * 컨테이너가 하나도 보이지 않으면 확인하지 못한 것이므로 던진다
   */
  async #verifyMasks(phase: 'created' | 'started'): Promise<Array<{ id: string; service: string | undefined }>> {
    const listed = await this.#docker(this.#composeArgs(['ps', '--all', '--quiet', '--no-trunc']));
    // 목록을 읽지 못한 것을 "컨테이너 없음"으로 보면 확인을 건너뛴 채 시작하게 된다
    if (listed.exitCode !== 0) throw new SandboxError(`컨테이너 목록을 확인하지 못했습니다 (${this.id})`, this.redact(listed.stderr), { platform: true });
    const ids = listed.stdout.split('\n').map((id) => id.trim()).filter(Boolean);
    // 만들기가 성공했는데 컨테이너가 보이지 않는다. 볼 것이 없다는 것은 확인했다는 뜻이 아니다
    if (ids.length === 0) throw new SandboxError(`컨테이너가 보이지 않아 .git 보호를 확인하지 못했습니다 (${this.id})`, undefined, { platform: true });
    const inspected = await this.#docker(['inspect', ...ids]);
    if (inspected.exitCode !== 0) throw new SandboxError(`컨테이너 마운트를 확인하지 못했습니다 (${this.id})`, this.redact(inspected.stderr), { platform: true });
    let containers: Array<{ Id: string; Name?: string; Mounts?: InspectedMount[]; Config?: { Labels?: Record<string, string> } }>;
    try {
      containers = JSON.parse(inspected.stdout);
    } catch {
      throw new SandboxError(`컨테이너 마운트(docker inspect)를 해석하지 못했습니다 (${this.id})`, undefined, { platform: true });
    }
    // 목록의 컨테이너를 빠짐없이 봤는지 맞춰 본다. 일부만 돌아오면 나머지는 확인하지 않은 채 지나간다
    const seen = new Set(Array.isArray(containers) ? containers.map((container) => container?.Id) : []);
    if (!Array.isArray(containers) || ids.some((id) => !seen.has(id))) {
      throw new SandboxError(`컨테이너 마운트를 일부만 확인했습니다 (${this.id})`, undefined, { platform: true });
    }
    const names = [...new Set(containers.flatMap((container) => (container.Mounts ?? []).filter((mount) => mount.Type === 'volume' && mount.Name).map((mount) => mount.Name!)))];
    const volumeOptions: Record<string, { driver?: string; driver_opts?: Record<string, string> }> = {};
    if (names.length > 0) {
      const volumes = await this.#docker(['volume', 'inspect', ...names]);
      // 볼륨 정보를 읽지 못하면 호스트 폴더에 묶인 이름 있는 볼륨을 알아볼 수 없어, 그 마운트의 보호가 빠져도 지나치게 된다
      if (volumes.exitCode !== 0) throw new SandboxError(`볼륨 정보를 확인하지 못했습니다 (${this.id})`, this.redact(volumes.stderr), { platform: true });
      try {
        for (const volume of JSON.parse(volumes.stdout) as Array<{ Name: string; Driver?: string; Options?: Record<string, string> | null }>) {
          volumeOptions[volume.Name] = { ...(volume.Driver ? { driver: volume.Driver } : {}), driver_opts: volume.Options ?? {} };
        }
      } catch {
        throw new SandboxError(`볼륨 정보(docker volume inspect)를 해석하지 못했습니다 (${this.id})`, undefined, { platform: true });
      }
      // 물어본 볼륨이 답에 없으면 그 마운트가 호스트 폴더에 묶였는지 알 수 없다
      const unknown = names.filter((name) => volumeOptions[name] === undefined);
      if (unknown.length > 0) throw new SandboxError(`볼륨 정보를 일부만 확인했습니다 (${this.id})`, unknown.join(', '), { platform: true });
    }
    const failures: string[] = [];
    const remove: string[] = [];
    for (const container of containers) {
      const missing = await findMissingMasks(this.project.root, container.Mounts ?? [], volumeOptions);
      if (missing.length === 0) continue;
      remove.push(container.Id);
      failures.push(`${container.Config?.Labels?.[COMPOSE_SERVICE_LABEL] ?? container.Name ?? container.Id}: ${missing.join(', ')}`);
    }
    if (failures.length === 0) return containers.map((container) => ({ id: container.Id, service: container.Config?.Labels?.[COMPOSE_SERVICE_LABEL] }));
    // 지워 두면 다음 up이 새로 만들고 다시 확인한다. 남겨 두면 만들어진 채로 있어 다른 경로로 시작될 여지가 생긴다
    const removed = await this.#docker(['rm', '--force', ...remove]);
    const left = removed.exitCode === 0 ? '' : ' 그 컨테이너를 지우지 못했습니다 — 아직 돌고 있을 수 있습니다';
    throw new SandboxError(
      phase === 'created'
        ? `컨테이너에 .git 읽기 전용 마운트가 빠져 시작하지 않았습니다 (${this.id})${left}`
        : `컨테이너에 .git 읽기 전용 마운트가 빠져 내렸습니다 (${this.id})${left}`,
      failures.join('\n'),
      { platform: true },
    );
  }

  async #docker(args: string[], signal?: AbortSignal, input?: string): Promise<ExecResult> {
    try {
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
    if (result.exitCode !== 0) {
      // 디스크 부족이면 원본 stderr는 그대로 두고 다음에 할 일만 덧붙인다
      // 빌드 실패처럼 코드가 원인일 수 있는 실패가 섞여 있으므로, 도커에 닿지 못한 것이 분명할 때만 플랫폼 쪽으로 표시한다
      throw new SandboxError(`docker compose ${args[0]} 실패 (${this.id})`, describeDockerFailure(this.redact(result.stderr)), { platform: isDockerUnreachable(result.stderr) });
    }
    return result;
  }

  /**
   * compose up을 돌리되, 호스트↔VM 포트 가시성 차이로 인한 바인드 충돌(PORT_BIND_CONFLICT)이면 재시도한다.
   * findFreeHostPort는 macOS 호스트에서 포트가 비었는지 확인하지만, 실제 바인드는 colima VM 안에서 일어나므로
   * VM 안의 다른 컨테이너가 이미 그 포트를 쓰고 있으면 호스트 확인을 통과했어도 compose up이 실패한다.
   * 충돌난 포트 하나만 바꾸지 않는다 — 같은 대역에서 함께 고른 다른 미리 정한 포트도 막혀 있을 수 있어서,
   * 이 샌드박스가 미리 고른 포트를 전부 다시 뽑고 override를 다시 쓴다. 재시도 전에는 일부만 뜬 스택을 내려
   * 다음 up이 깨끗한 상태에서 시작하게 한다. 포트 충돌이 아닌 실패(디스크 부족, 빌드 실패 등)는 바로 던진다
   */
  async #composeUpWithPortRetry(upArgs: string[], signal?: AbortSignal): Promise<void> {
    for (let attempt = 1; attempt <= PORT_RETRY_ATTEMPTS; attempt++) {
      try {
        await this.#composeOrThrow(['up', '--detach', '--remove-orphans', ...upArgs], signal);
        return;
      } catch (error) {
        const detail = error instanceof SandboxError ? (error.detail ?? '') : '';
        const isLastAttempt = attempt === PORT_RETRY_ATTEMPTS;
        if (!isPortBindConflict(detail)) throw error;
        if (isLastAttempt) {
          const message = error instanceof Error ? error.message : String(error);
          throw new SandboxError(`${message}\n포트 충돌이 반복돼 ${PORT_RETRY_ATTEMPTS}회 재시도 후 포기했습니다`, undefined, { platform: true });
        }
        await this.#regeneratePorts();
        // 일부만 뜬 컨테이너를 정리한다. down이 실패해도(예: 이미 아무것도 안 떠 있음) 다음 up은 --remove-orphans로 이어간다
        await this.#compose(['down', '--volumes', '--remove-orphans'], signal);
      }
    }
  }

  /**
   * 미리 고른 호스트 포트를 전부 다시 뽑아 override 파일을 다시 쓴다. preallocatePublicUrlPorts가 대상 서비스
   * 집합을 project에서 다시 읽어 매번 새 포트를 배정하므로, 충돌난 포트 하나만이 아니라 세트 전체가 바뀐다
   */
  async #regeneratePorts(): Promise<void> {
    this.#hostPorts = await preallocatePublicUrlPorts(this.project);
    await this.#writeOverride();
  }

  /** compose 파일의 마운트를 다시 읽어 마스크가 달라졌으면 override를 새로 쓴다. 읽지 못하면 보호 없이 띄우지 않고 던진다 */
  async #refreshGitMask(): Promise<void> {
    const mask = await loadGitMask(this.project, { dockerBin: this.#dockerBin, env: this.#environment(), projectName: this.id, redact: (text) => this.redact(text) });
    if (JSON.stringify(mask) === JSON.stringify(this.#gitMask)) return;
    this.#gitMask = mask;
    await this.#writeOverride();
  }

  /** 다른 compose 호출이 반쯤 쓰인 파일을 읽지 않도록 임시 파일에 쓴 뒤 바꿔 넣는다 */
  async #writeOverride(): Promise<void> {
    const yaml = stringify(buildOverride(this.project, this.id, { edgeScript: this.#edgeScript, runtime: this.#runtime, hostPorts: this.#hostPorts, gitMask: this.#gitMask }));
    const temporary = `${this.#overridePath}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temporary, yaml);
    await rename(temporary, this.#overridePath);
  }

  /** compose가 override의 빈 시크릿 자리를 이 환경에서 채운다 */
  #environment(): NodeJS.ProcessEnv {
    return { ...process.env, ...this.#secrets };
  }
}

const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service';

/**
 * `compose up` 인자에서 만들기 단계의 인자와 시작할 대상을 뽑는다(트러블슈팅 121).
 *  - create: 컨테이너를 만들기만 한다(`--no-start`). 빌드와 다시 만들기(`--build`, `--force-recreate`)는 이 단계에서 한다
 *  - services: 이름을 준 서비스. 비어 있으면 compose 파일의 모든 서비스다
 *  - byId: 이름을 주고 `--no-deps`를 붙인 up이면 true. 의존 서비스를 따라 띄우지 않으므로 확인한 컨테이너의 id로 바로 시작한다
 */
export function splitUpArgs(args: readonly string[]): { create: string[]; services: string[]; byId: boolean } {
  const [command = 'up', ...rest] = args;
  const services = rest.filter((arg) => !arg.startsWith('-'));
  return {
    create: [command, '--no-start', ...rest.filter((arg) => arg !== '--detach')],
    services,
    byId: services.length > 0 && rest.includes('--no-deps'),
  };
}

/**
 * 런타임 공개 URL 주입(fix/frontend-backend-url): project.publicUrlRefs가 가리키는 서비스(보통 백엔드)마다
 * 호스트 포트를 하나씩 미리 정한다(`docker compose up` 전에 알아야 환경 변수에 실제 주소를 넣을 수 있다).
 * 참조가 없으면(대부분의 프로젝트) 빈 객체를 돌려줘 포트 자동 배정이라는 기존 동작을 그대로 둔다
 */
export async function preallocatePublicUrlPorts(project: LoadedProject): Promise<Record<string, number>> {
  const targets = [...new Set((project.publicUrlRefs ?? []).map((ref) => ref.targetService))];
  if (targets.length === 0) return {};
  const ports = await Promise.all(targets.map(() => findFreeHostPort()));
  return Object.fromEntries(targets.map((name, index) => [name, ports[index]!]));
}

/** 스튜디오 서버·CLI 환경 변수 B_STUDIO_CONTAINER_RUNTIME. 격리 수준은 프로젝트가 아니라 운영자가 정한다 */
export function runtimeFromEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.B_STUDIO_CONTAINER_RUNTIME?.trim() || undefined;
}

/**
 * `B_STUDIO_SANDBOX_BUILD_NO_CACHE=1`이면 이 샌드박스 프로젝트의 이미지를 레이어 캐시 없이 빌드하고 스냅샷도 쓰지 않는다.
 * `docker builder prune`처럼 다른 프로젝트의 빌드 캐시까지 지우지 않는다 — 이 샌드박스에만 적용된다.
 */
export function sandboxBuildNoCache(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.B_STUDIO_SANDBOX_BUILD_NO_CACHE?.trim().toLowerCase();
  return value === '1' || value === 'true';
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
