import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { LoadedProject, ManagedServiceSpec } from '@b-studio/spec';
import { isDockerUnreachable, SandboxError } from '../errors';
import { DEFAULT_READINESS, type ReadinessPolicy } from '../readiness';
import { assertSandboxId } from '../sandbox-id';
import { Redactor } from '../secrets';
import { composeEnvironment } from './compose-env';
import type {
  BootNetwork,
  CleanupCommand,
  ContainerState,
  CreateSandboxOptions,
  EgressDenial,
  EvaluationAssetContent,
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
  StrayProcessReport,
  SyncOptions,
  SyncResult,
} from '../types';
import { runCommand, runCommandFromFile, runCommandLogStream, runCommandToFile } from '../stream-exec';
import { findFreeHostPort } from './free-port';
import {
  composeUpArgs,
  EDGE_SERVICE,
  edgePortFor,
  EGRESS_NETWORK,
  parseContainerState,
  parseEgressDenial,
  parseHostPort,
  parseLogLine,
  SANDBOX_NETWORK,
} from './format';
import { native } from '../native';
import {
  defaultEvaluationAssetRoot,
  evaluationAssetSandboxDir,
  prepareEvaluationAssetCopies,
  syncEvaluationAssetCopies,
  type EvaluationAssetSlot,
} from './evaluation-assets';
import { loadGitMask, type MaskVolume } from './git-mask';
import { overrideInputJson, upWithGitMask, writeComposeOverride } from './up-loop';
import { relayThroughContainers, syncFiles, upWithPortRetry } from './sync-relay';
import { awaitReady, ensureInfra, readProcessBaseline, strayProcessReports, type ReadyContext } from './ready';
import type { ScannedProcess } from './stray-processes';
import { bootNetworkFromUsage } from './usage';
import {
  abortCreate,
  assertRuntime,
  callExternalApi,
  cleanupSandbox,
  createWorkDir,
  destroySandbox,
  LOAD_LIMIT_MS,
  runLoadTest,
  type LoadCache,
} from './lifecycle-run';
import { captureSnapshot, ensureSharedVolumes, planSnapshots, readStats, seedSnapshot, type SnapshotContext } from './snapshot-run';

/** 사용량 조회(ps·inspect·stats) 전체의 상한. 평소에는 2~3초 걸린다 */
const STATS_TIMEOUT_MS = 15_000;
/** 의존 서비스가 준비될 때까지 기다리는 상한. compose는 healthcheck가 실패로 끝날 때까지 기다리지만, 끝나지 않는 대기는 두지 않는다 */
const DEPENDENCY_WAIT_MS = 300_000;
const DEPENDENCY_POLL_MS = 500;

/** Docker VM 디스크가 가득 찼을 때 원인과 다음 행동을 알려 주는 문구 */
export const DOCKER_OUT_OF_SPACE = native.dockerOutOfSpace();

/** compose up 실패가 호스트↔VM 포트 가시성 차이로 인한 바인드 충돌인지 본다(findFreeHostPort가 미리 고른 포트를
 *  VM 안의 다른 컨테이너가 이미 쓰고 있는 경우) — 다른 실패(디스크 부족, 이미지 빌드 실패 등)는 재시도하지 않는다 */
export function isPortBindConflict(stderr: string): boolean {
  // compose up이 남기는 stderr 패턴은 Rust(crates/bstudio-guard/src/compose_helpers.rs)가 정한다
  return native.isPortBindConflict(stderr);
}

/**
 * docker 명령이 디스크 부족으로 실패했는지 보고, 그렇다면 안내 문구를 덧붙인다.
 * 그 밖의 오류는 원문을 그대로 돌려준다. 오류를 삼키지 않도록 항상 원래 메시지를 포함한다
 */
export function describeDockerFailure(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // 판정은 Rust가 한다. 원문은 그대로 들고 있다가 이어 붙인다(짝 없는 서로게이트가 napi 경계에서 바뀌지 않게)
  const note = native.dockerOutOfSpaceNote(text);
  return note ? `${text}\n${note}` : text;
}

/** 샌드박스 출입구 스크립트. 원격 Docker 호스트에서도 돌도록 파일을 마운트하지 않고 내용을 compose 설정에 넣는다 */
const EDGE_SCRIPT = new URL('../../edge/edge.mjs', import.meta.url);

/** 부하 확인 러너. edge와 같은 까닭으로 파일을 마운트하지 않고 내용을 표준 입력으로 넘긴다 */
const LOAD_RUNNER_SCRIPT = new URL('../../load/runner.mjs', import.meta.url);

/**
 * 파일 경로는 셸 문자열에 끼워 넣지 않고 위치 인자로 넘긴다.
 * 디렉터리 목록(readdir)에 이름이 보이는지와 내용 해시를 함께 확인한다.
 * 빌드 도구는 목록과 속성으로 변경을 감지하므로 경로로 직접 여는 것만으로는 부족하다.
 */
export interface LocalDockerProviderOptions {
  /** docker 실행 파일 경로 (기본: PATH의 docker) */
  dockerBin?: string;
  /** 모든 서비스에 적용할 준비 정책. studio.yaml의 ready.timeoutSeconds가 우선한다 */
  readiness?: Partial<ReadinessPolicy>;
  /** 샌드박스 컨테이너에 쓸 Docker 런타임 (예: gVisor의 runsc). 비우면 데몬 기본값(runc) */
  runtime?: string;
  /** 사용량 조회(ps·inspect·stats) 전체의 상한(ms). 기본 15초. 테스트에서 짧게 준다 */
  statsTimeoutMs?: number;
  /** 의존 서비스가 준비됐는지 다시 확인하기까지의 간격(ms). 기본 500ms. 테스트에서 짧게 준다 */
  dependencyPollMs?: number;
  /**
   * 평가 자산 복사본을 두는 호스트 폴더(#745). 기본 ~/.cache/b-studio/evaluation-assets.
   * colima가 기본으로 홈만 VM에 공유하므로 tmpdir가 아니라 홈 아래에 둔다(테스트는 임시 폴더)
   */
  evaluationAssetRoot?: string;
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

  /**
   * `down` → 이 샌드박스가 빌드한 이미지 → 평가 자산 복사본 폴더. 순서와 지우는 대상은 Rust가 정한다(crates/bstudio-io/src/lifecycle_io.rs, ADR-195 4f A4c-3c).
   * 작업 디렉터리의 compose 파일을 읽지 않도록 임시 디렉터리에서 실행하고, 실패는 모아 던진다. 자세한 것은 `lifecycle-run.ts`
   */
  async cleanup(sandboxId: string): Promise<void> {
    await cleanupSandbox({ dockerBin: this.#options.dockerBin ?? 'docker', evaluationAssetRoot: this.#evaluationAssetRoot() }, sandboxId);
  }

  async create(project: LoadedProject, { secrets = {}, evaluationAssets: initialAssets = [] }: CreateSandboxOptions = {}): Promise<Sandbox> {
    // 런타임이 없으면 compose up 도중이 아니라 샌드박스를 만들기 전에 알린다
    if (this.#options.runtime) await assertRuntime(this.#options.dockerBin ?? 'docker', this.#options.runtime);
    const id = `studio-${project.spec.name}-${randomBytes(3).toString('hex')}`;
    const workDir = await createWorkDir();
    const overridePath = path.join(workDir, 'compose.override.yaml');
    const evaluationAssetRoot = this.#evaluationAssetRoot();
    try {
      const edgeScript = await readFile(EDGE_SCRIPT, 'utf8');
      const hostPorts = await preallocatePublicUrlPorts(project);
      // 마운트할 원본은 작업 복사본이 아니라 b-studio가 가진 복사본이다(#745). 자리의 종류와 첫 내용은 넘긴 판(마지막 체크포인트)이
      // 정하고 여기서 채운다 — 컨테이너를 띄우기 전이라 컨테이너가 붙잡는 자리와 b-studio가 쓰는 자리가 처음부터 같다
      const evaluationAssets = await prepareEvaluationAssetCopies(project.spec.workflow?.evaluationAssets ?? [], evaluationAssetRoot, id, initialAssets);
      const gitMask = await loadGitMask(project, {
        dockerBin: this.#options.dockerBin,
        env: composeEnvironment(secrets),
        projectName: id,
        evaluationAssets,
        redact: (text) => new Redactor(secrets).redact(text),
      });
      // override는 Rust가 JSON으로 쓴다(임시 파일 + rename). 샌드박스가 다시 쓸 때(#regeneratePorts, up)도 같은 쓰개를 쓴다
      await writeComposeOverride(overridePath, overrideInputJson(project, id, { edgeScript, runtime: this.#options.runtime, hostPorts }), gitMask);
      return new LocalDockerSandbox(id, project, workDir, overridePath, this.#options, secrets, edgeScript, gitMask, hostPorts, evaluationAssetRoot, evaluationAssets);
    } catch (error) {
      // 샌드박스를 돌려주지 못하면 destroy도 불리지 않는다. 이 create가 만든 작업 폴더와 그 샌드박스 id의 복사본 폴더를 여기서 지운다
      // (예전에는 복사본 폴더만 지우고 작업 폴더는 남았다. 트러블슈팅 194). 지우기 실패가 원래 오류(만들기를 거절한 이유)를 가리지 않게 한다
      await abortCreate(workDir, evaluationAssetRoot, id);
      throw error;
    }
  }

  #evaluationAssetRoot(): string {
    return this.#options.evaluationAssetRoot ?? defaultEvaluationAssetRoot();
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
  /** 의존 서비스 준비 확인 간격. 기다리는 상한(DEPENDENCY_WAIT_MS)과는 별개다 */
  readonly #dependencyPollMs: number;
  /** up을 한 번에 하나씩 돌리는 줄. 만들기 → 확인 → 시작 사이에 다른 up이 끼어들지 못하게 한다 */
  #upQueue: Promise<unknown> = Promise.resolve();
  /** 서비스가 준비됐을 때 PID 1과 세션이 다른 프로세스 목록(#765). 그 뒤에 생긴 것만 모르는 프로세스로 본다. 스튜디오를 다시 띄우면 비어 있다 */
  readonly #processBaseline = new Map<string, ScannedProcess[]>();
  /** 부하 러너 스크립트 원문과 도커 CPU 수(캐시는 상태라 여기 남는다) */
  readonly #loadCache: LoadCache = {};
  #hostPorts: Record<string, number>;
  readonly #runtime: string | undefined;
  /** 평가 자산 복사본을 두는 루트와 이 샌드박스의 자리(#745). 마운트와 sync가 같은 자리를 본다 */
  readonly #evaluationAssetRoot: string;
  readonly #evaluationAssetSandboxDir: string;
  readonly #evaluationAssets: readonly EvaluationAssetSlot[];
  /** 복사본 sync를 한 번에 하나씩 돌린다(실행 시작과 터미널 검증이 겹칠 수 있다) */
  #evaluationSync: Promise<unknown> = Promise.resolve();
  /** `compose config --format json`의 stdout 원문(세션 동안 한 번 읽는다) */
  #composeConfig: Promise<string> | undefined;

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
    evaluationAssetRoot: string,
    evaluationAssets: readonly EvaluationAssetSlot[],
  ) {
    this.#edgeScript = edgeScript;
    this.#gitMask = gitMask;
    this.#hostPorts = hostPorts;
    this.#evaluationAssetRoot = evaluationAssetRoot;
    this.#evaluationAssetSandboxDir = evaluationAssetSandboxDir(evaluationAssetRoot, id);
    this.#evaluationAssets = evaluationAssets;
    this.id = id;
    this.project = project;
    this.#workDir = workDir;
    this.#overridePath = overridePath;
    this.#dockerBin = options.dockerBin ?? 'docker';
    this.#readiness = options.readiness ?? {};
    this.#runtime = options.runtime;
    this.#statsTimeoutMs = options.statsTimeoutMs ?? STATS_TIMEOUT_MS;
    this.#dependencyPollMs = options.dependencyPollMs ?? DEPENDENCY_POLL_MS;
    this.#secrets = secrets;
    this.#redactor = new Redactor(secrets);
  }

  /**
   * 평가 자산 복사본의 내용을 바꾼다(#745). 컨테이너에 붙는 것은 작업 복사본이 아니라 이 복사본이므로, 실행을 시작하기 전에
   * 마지막 체크포인트의 판으로 맞춘다. 폴더 자산은 폴더 자체(inode)를 그대로 두고 안만, 파일 자산은 같은 파일에 덮어쓴다
   */
  async syncEvaluationAssets(assets: readonly EvaluationAssetContent[]): Promise<void> {
    const run = this.#evaluationSync.then(() => syncEvaluationAssetCopies(this.#evaluationAssets, this.#evaluationAssetSandboxDir, assets));
    this.#evaluationSync = run.catch(() => undefined);
    return run;
  }

  async start(options: StartOptions = {}): Promise<ServiceEndpoint[]> {
    // 서비스 선택(ADR-083): services를 주면 그 서비스만 띄우고, 나머지 managed 서비스는 'off'로 알린다(실패가 아니다).
    // 주지 않으면 옛 동작대로 모든 서비스를 띄운다(다른 제공자 호출부·고정 픽스처와 호환)
    const selected = options.services ? new Set(options.services) : undefined;
    const isSelected = (name: string) => !selected || selected.has(name);
    const startingManaged = this.project.managed.filter(([name]) => isSelected(name));
    for (const [name] of this.project.managed) options.onStatus?.(isSelected(name) ? { service: name, phase: 'starting' } : { service: name, phase: 'off' });
    await ensureSharedVolumes(this.#dockerBin, this.project.sharedVolumes);

    // B_STUDIO_SANDBOX_BUILD_NO_CACHE=1이면 이 샌드박스 프로젝트의 이미지만 레이어 캐시 없이 빌드하고,
    // 스냅샷 볼륨도 쓰지 않는다(다른 프로젝트의 빌드 캐시는 건드리지 않는다). 스냅샷 볼륨을 지우지는 않는다.
    const noCache = sandboxBuildNoCache();
    // 스냅샷 복사가 compose up을 늦추지 않도록 이미지 빌드와 동시에 한다. 꺼 둔 서비스는 스냅샷도 건드리지 않는다
    const plans = (await planSnapshots(this.#snapshotContext())).filter((plan) => isSelected(plan.service));
    // 선택이 있는데 띄울 게 없으면(전부 꺼 둠) build를 부르지 않는다 — 인자 없는 build는 "전부 빌드"라는 뜻이라서다
    const buildBase = noCache ? ['build', '--no-cache'] : ['build'];
    const buildArgs = !selected ? buildBase : selected.size === 0 ? undefined : [...buildBase, ...selected];
    const [seeded] = await Promise.all([
      noCache ? Promise.resolve(plans.map(() => false)) : Promise.all(plans.map((plan) => seedSnapshot(this.#snapshotContext(), plan, options))),
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

    // 준비된 서비스마다 그때 떠 있던 프로세스를 기준선으로 남긴다(#765). 검증 게이트는 그 뒤에 생긴 것만 모르는 프로세스로 본다
    await Promise.all(startingManaged.map(([name]) => this.#recordProcessBaseline(name)));

    // 서비스가 모두 준비된 직후 한 번 stats를 읽어 기동 중 받은 바이트를 알린다
    await this.#reportBootNetwork(options);

    // 설치 단계만 끝나고 에이전트가 아직 도구를 쓰지 않은 시점의 볼륨을 다음 기동용으로 남긴다
    await Promise.all(plans.filter((_, index) => !seeded[index]).map((plan) => captureSnapshot(this.#snapshotContext(), plan, options)));
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
    return ensureInfra(
      { ...this.#readyContext(), compose: (args, composeSignal) => this.#compose(args, composeSignal), describeFailure: (stderr) => describeDockerFailure(this.redact(stderr)) },
      services,
      { signal },
    );
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
    const endpoint = await this.#awaitReady(name, options);
    await this.#recordProcessBaseline(name);
    return endpoint;
  }

  /**
   * 서비스마다 running인지 보고, running이면 서비스 안에서 PID 1과 세션이 다른 프로세스를 찾아 기준선에 없던 것만 알린다(#765).
   * "running 확인 → 찾기(exec) → 기준선과 비교"는 Rust 함수 하나가 한다(crates/bstudio-io/src/readiness_io.rs, ADR-195 4f A4c-3a).
   * 기준선 저장소(`#processBaseline`)는 상태라 여기에 남는다. 멈춘 서비스는 건너뛴다(게이트가 켜 버리지 않게)
   */
  async strayProcesses({ signal }: { signal?: AbortSignal } = {}): Promise<StrayProcessReport[]> {
    const off = this.project.offServices;
    const names = this.project.managed.map(([name]) => name).filter((name) => !off?.has(name));
    return strayProcessReports(this.#readyContext(), names, this.#processBaseline, signal);
  }

  /** 준비된 서비스의 프로세스 목록을 기준선으로 남긴다(#765). 읽지 못하면 기준선을 지워, 다음 검사가 그 서비스를 다시 띄우게 한다 */
  async #recordProcessBaseline(name: string): Promise<void> {
    const processes = await readProcessBaseline(this.#readyContext(), name);
    if (processes) this.#processBaseline.set(name, processes);
    else this.#processBaseline.delete(name);
  }

  /**
   * 바뀐 파일(과 함께 사라진 폴더)의 호스트 sha256을 구하고, 컨테이너가 보는 해시가 모두 같아질 때까지 250ms마다 다시 확인한다.
   * 호스트 해시·docker 호출·반복·판정은 Rust 함수 하나가 한다(crates/bstudio-io/src/sync_relay.rs, ADR-195 4f A4c-2). 검증 게이트가 "파일이
   * 컨테이너에 반영됐다"를 믿는 근거라서, 줄이 없거나 같은 파일의 줄이 둘이거나 모양을 모르면 통과가 아니다
   */
  async sync(files: string[], { signal, timeoutMs = 60_000 }: SyncOptions = {}): Promise<SyncResult> {
    return syncFiles({ project: this.project, dockerBin: this.#dockerBin, env: this.#environment(), files, signal, timeoutMs });
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

  /**
   * `compose ps` → `inspect` → 실행 중인 것만 `stats --no-stream`을 상한 시간 안에 읽는다(트러블슈팅 123). 순서·상한·해석·합치기는 Rust 함수 하나가 한다
   * (crates/bstudio-io/src/snapshot_io.rs, ADR-195 4f A4c-3b). 목록·inspect를 읽지 못하면 "컨테이너 없음"이 아니라 오류다
   */
  async stats(): Promise<ServiceUsage[]> {
    return readStats({ ...this.#snapshotContext(), overridePath: this.#overridePath }, { statsTimeoutMs: this.#statsTimeoutMs, redact: (text) => this.redact(text) });
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
    // Rust(LogStream)가 docker를 띄워 stdout을 줄 단위로 당겨 준다(2c-3b, #1047). 당기기 모델이라 소비가 느려도 안 샌다.
    // parseLogLine(시각 분리)·redact(가림)·Date 변환은 여기 남는다 — Rust는 raw 줄만 흘린다.
    // for await가 끝나거나(EOF) 호출부가 break하거나 signal이 깨면 LogStream이 자식을 kill한다(옛 finally의 child.kill()).
    for await (const raw of runCommandLogStream(this.#dockerBin, args, { signal, env: this.#environment() })) {
      const line = parseLogLine(raw);
      if (line) yield { ...line, text: this.#redactor.redact(line.text) };
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
    // 바인드 마운트는 세션 동안 바뀌지 않으므로 compose 해석은 한 번만 한다(캐시는 상태라 여기 남는다). 읽거나 해석하지 못하면 캐시를 비운다
    this.#composeConfig ??= this.#compose(['config', '--format', 'json']).then((result) => {
      if (result.exitCode !== 0) throw new SandboxError(`compose 설정을 읽지 못했습니다 (${this.id})`, this.redact(result.stderr));
      JSON.parse(result.stdout);
      return result.stdout;
    });
    const config = await this.#composeConfig.catch((error: unknown) => {
      this.#composeConfig = undefined;
      throw error;
    });
    // managed 집합·서비스 폴더·바인드 마운트 계획·서비스마다 exec·알린 경로 고르기는 Rust 함수 하나가 한다(ADR-195 4f A4c-2)
    return relayThroughContainers({ id: this.id, project: this.project, dockerBin: this.#dockerBin, env: this.#environment(), overridePath: this.#overridePath, config, changes, signal });
  }

  redact(text: string): string {
    return this.#redactor.redact(text);
  }

  findSecrets(text: string): string[] {
    return this.#redactor.find(text);
  }

  /**
   * 등록한 사내 API인지, 경로가 `/`로 시작하는지 확인한 뒤(docker를 부르기 전) edge 컨테이너 안에서 호출하고 결과 본문을 가린다.
   * 순서는 Rust 함수 하나가 한다(crates/bstudio-io/src/lifecycle_io.rs, ADR-195 4f A4c-3c). 자세한 것은 `lifecycle-run.ts`
   */
  async callExternal(name: string, request: ExternalCallRequest, { via, signal }: { via: string; signal?: AbortSignal }): Promise<ExternalCallResult> {
    return callExternalApi(
      { ...this.#lifecycleContext(), edgeScript: this.#edgeScript, edgeService: EDGE_SERVICE, external: this.project.external ?? [] },
      name,
      request,
      { via, ...(signal ? { signal } : {}) },
    );
  }

  /**
   * 서비스 상태 확인 → 도커 CPU 수 → `docker run` 부하 러너(상한 시간) → 취소·시간 초과면 이 실행이 만든 이름으로만 `rm --force` → 결과 읽기.
   * 순서는 Rust 함수 하나가 한다(crates/bstudio-io/src/lifecycle_io.rs, ADR-195 4f A4c-3c). 러너 스크립트와 CPU 수 캐시는 상태라 여기 남는다
   */
  async runLoad(request: LoadRequest, { signal }: { signal?: AbortSignal } = {}): Promise<LoadResult> {
    return runLoadTest(
      {
        ...this.#lifecycleContext(),
        managedPort: (name) => this.#managed(name).port,
        sandboxNetwork: SANDBOX_NETWORK,
        runtime: this.#runtime,
        readRunner: () => readFile(LOAD_RUNNER_SCRIPT, 'utf8'),
        cache: this.#loadCache,
        limitMs: LOAD_LIMIT_MS,
      },
      request,
      { ...(signal ? { signal } : {}) },
    );
  }

  /**
   * `down` → 이 샌드박스가 빌드한 이미지 → 작업 폴더 → 평가 자산 복사본. 순서와 지우는 대상은 Rust가 정한다(crates/bstudio-io/src/lifecycle_io.rs, ADR-195 4f A4c-3c).
   * `down`은 `#upQueue`를 타지 않는다(옛 `#composeOrThrow`도 `up`만 줄을 세웠다). 자세한 것은 `lifecycle-run.ts`
   */
  async destroy(): Promise<void> {
    await destroySandbox({ ...this.#lifecycleContext(), workDir: this.#workDir, evaluationAssetRoot: this.#evaluationAssetRoot });
  }

  #lifecycleContext() {
    return {
      id: this.id,
      dockerBin: this.#dockerBin,
      env: this.#environment(),
      project: this.project,
      overridePath: this.#overridePath,
      redact: (text: string) => this.redact(text),
      composeFailure: (command: string, result: ExecResult) => this.#composeFailure(command, result),
    };
  }

  /**
   * 준비 확인 한 시도(엔드포인트 읽기 → 확인 반복 → 실패면 이유 만들기)는 Rust 함수 하나가 한다(crates/bstudio-io/src/readiness_io.rs, ADR-195 4f A4c-3a).
   * 일시 오류로 죽어 다시 만들 때의 `up`은 이 클래스의 `#composeOrThrow`를 지난다(`#upQueue`·`#gitMask`). 자세한 것은 `ready.ts`
   */
  async #awaitReady(name: string, { signal, onStatus, onTransientRetry }: StartOptions): Promise<ServiceEndpoint> {
    return awaitReady(this.#readyContext(), name, { signal, onStatus, onTransientRetry });
  }

  #readyContext(): ReadyContext {
    return {
      id: this.id,
      project: this.project,
      dockerBin: this.#dockerBin,
      env: this.#environment(),
      overridePath: this.#overridePath,
      secrets: this.#secrets,
      edgeService: EDGE_SERVICE,
      edgePort: (name) => edgePortFor(this.project, name),
      managed: (name) => this.#managed(name),
      policyFor: (service) => this.#policyFor(service),
      recreate: (name, signal) => this.#composeOrThrow(['up', '--detach', '--build', '--no-deps', '--force-recreate', name], signal),
      composeFailure: (command, result) => this.#composeFailure(command, result),
    };
  }

  /** 스냅샷·공유 볼륨 함수가 쓰는 맥락. 계획·채우기·저장·정리·공유 볼륨 만들기는 Rust가 한다(`snapshot-run.ts`, ADR-195 4f A4c-3b) */
  #snapshotContext(): SnapshotContext {
    return { id: this.id, project: this.project, dockerBin: this.#dockerBin, env: this.#environment() };
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

  /**
   * 시도 반복 전체(마운트 읽기 → override 쓰기 → 만들기 → 다시 읽기 → 확인 → 시작 → 시작 뒤 확인 → 포기 시 내리기)는 Rust 함수 하나가 한다
   * (crates/bstudio-io/src/up_loop.rs, ADR-195 4f A4c-1). 확인한 마스크는 override에 쓴 그 값이다. Rust가 마지막에 쓴 마스크를 돌려주면
   * `#gitMask`를 그 값으로 맞춘다(실패해도). 한 샌드박스의 up은 `#upQueue`가 한 번에 하나만 돌린다
   */
  async #upOnce(args: string[], signal?: AbortSignal): Promise<ExecResult> {
    return upWithGitMask({
      id: this.id,
      project: this.project,
      dockerBin: this.#dockerBin,
      env: this.#environment(),
      overridePath: this.#overridePath,
      overrideInput: this.#overrideInput(),
      gitMask: this.#gitMask,
      evaluationAssets: this.#evaluationAssets,
      args,
      sandboxNetwork: SANDBOX_NETWORK,
      egressNetwork: EGRESS_NETWORK,
      edgeService: EDGE_SERVICE,
      serviceLabel: COMPOSE_SERVICE_LABEL,
      pollMs: this.#dependencyPollMs,
      waitMs: DEPENDENCY_WAIT_MS,
      ...(signal ? { signal } : {}),
      redact: (text) => this.redact(text),
      onMask: (mask) => {
        this.#gitMask = mask;
      },
    });
  }

  /** override의 입력에서 마스크만 뺀 것. 마스크는 쓰는 쪽(Rust)이 얹는다 */
  #overrideInput(): string {
    return overrideInputJson(this.project, this.id, { edgeScript: this.#edgeScript, runtime: this.#runtime, hostPorts: this.#hostPorts });
  }

  // docker/docker compose를 한 번 돌려 stdout·stderr를 모은다. 실행·취소는 Rust(crates/bstudio-io)가 한다(2c-2, #1043).
  // 던지지 않는다 — 비0 종료·취소·spawn 실패·maxBuffer 초과 모두 결과로 돌려준다(옛 execFileAsync + isExecFailure와 같다).
  // 취소하면 거절하지 않고 부분 출력과 exitCode 1을 돌려줘, stats가 signal.aborted로 timeout-cutoff를 판단하는 길을 보존한다.
  async #docker(args: string[], signal?: AbortSignal, input?: string): Promise<ExecResult> {
    return runCommand(this.#dockerBin, args, { signal, env: this.#environment(), input });
  }

  async #composeOrThrow(args: string[], signal?: AbortSignal): Promise<ExecResult> {
    const result = await this.#compose(args, signal);
    if (result.exitCode !== 0) throw this.#composeFailure(args[0]!, result);
    return result;
  }

  /**
   * 디스크 부족이면 원본 stderr는 그대로 두고 다음에 할 일만 덧붙인다
   * 빌드 실패처럼 코드가 원인일 수 있는 실패가 섞여 있으므로, 도커에 닿지 못한 것이 분명할 때만 플랫폼 쪽으로 표시한다
   */
  #composeFailure(command: string, result: ExecResult): SandboxError {
    return new SandboxError(`docker compose ${command} 실패 (${this.id})`, describeDockerFailure(this.redact(result.stderr)), { platform: isDockerUnreachable(result.stderr) });
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
    // 재시도 반복 전체가 `#upQueue`의 한 칸이다(전에는 시도마다 줄을 섰다. 시도 사이에 다른 up이 끼어들지 못한다)
    const run = this.#upQueue.then(() => this.#portRetryOnce(upArgs, signal));
    this.#upQueue = run.catch(() => undefined);
    return run;
  }

  /**
   * 반복 전체(시도 → 충돌이면 포트 전부 다시 뽑기 → override 다시 쓰기 → 일부만 뜬 컨테이너 지우기 → 다시)는 Rust 함수 하나가 한다
   * (crates/bstudio-io/src/port_retry.rs, ADR-195 4f A4c-2). 시도마다 `up_with_git_mask`를 직접 부르고, override를 다시 쓸 때 쓰는 마스크는
   * 직전 시도가 쓴 값이다. Rust가 마지막 마스크와 배정한 포트를 돌려주면 `#gitMask`·`#hostPorts`를 그 값으로 맞춘다(실패해도)
   */
  async #portRetryOnce(upArgs: string[], signal?: AbortSignal): Promise<void> {
    return upWithPortRetry({
      id: this.id,
      project: this.project,
      dockerBin: this.#dockerBin,
      env: this.#environment(),
      overridePath: this.#overridePath,
      overrideInput: this.#overrideInput(),
      gitMask: this.#gitMask,
      evaluationAssets: this.#evaluationAssets,
      args: ['up', '--detach', '--remove-orphans', ...upArgs],
      sandboxNetwork: SANDBOX_NETWORK,
      egressNetwork: EGRESS_NETWORK,
      edgeService: EDGE_SERVICE,
      serviceLabel: COMPOSE_SERVICE_LABEL,
      pollMs: this.#dependencyPollMs,
      waitMs: DEPENDENCY_WAIT_MS,
      ...(signal ? { signal } : {}),
      redact: (text) => this.redact(text),
      onMask: (mask) => {
        this.#gitMask = mask;
      },
      publicUrlTargets: [...new Set((this.project.publicUrlRefs ?? []).map((ref) => ref.targetService))],
      secrets: this.#secrets,
      upFailure: (result) => this.#composeFailure('up', result),
      onHostPorts: (hostPorts) => {
        this.#hostPorts = hostPorts;
      },
    });
  }

  /** compose가 override의 빈 시크릿 자리를 이 환경에서 채운다. studio 자신의 환경 변수는 넘기지 않는다(compose-env.ts) */
  #environment(): NodeJS.ProcessEnv {
    return composeEnvironment(this.#secrets);
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
  return native.splitUpArgs([...args]);
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
  return native.runtimeFromEnv(env.B_STUDIO_CONTAINER_RUNTIME) ?? undefined;
}

/**
 * `B_STUDIO_SANDBOX_BUILD_NO_CACHE=1`이면 이 샌드박스 프로젝트의 이미지를 레이어 캐시 없이 빌드하고 스냅샷도 쓰지 않는다.
 * `docker builder prune`처럼 다른 프로젝트의 빌드 캐시까지 지우지 않는다 — 이 샌드박스에만 적용된다.
 */
export function sandboxBuildNoCache(env: NodeJS.ProcessEnv = process.env): boolean {
  return native.sandboxBuildNoCache(env.B_STUDIO_SANDBOX_BUILD_NO_CACHE);
}
