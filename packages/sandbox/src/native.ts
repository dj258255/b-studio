import { createRequire } from 'node:module';
import type { ExecResult } from './types';

export interface BytesResult {
  exitCode?: number | null;
  stdout: Buffer;
  stderr: Buffer;
  aborted: boolean;
  overflowed: boolean;
  spawnError?: string | null;
}

export interface ArchiveExtractResult {
  gitCode?: number | null;
  tarCode?: number | null;
  stderr: Buffer;
  spawnError?: string | null;
}

/**
 * Rust로 옮긴 막는 검사 판정(crates/bstudio-node, ADR-191). 저장소 루트의 `pnpm install`·`pnpm build:native`가 만든다.
 *
 * 불러오지 못하면 던진다. TS로 대신 판정하는 길을 두지 않는다 — 두 구현이 함께 있으면 같은 입력을 다르게 읽는 자리가 생긴다
 */
interface NativeGuard {
  assertReadonlyDockerArgs(args: string[]): string | null | undefined;
  readonlyDockerSubcommands(): string[];
  findPolicyViolations(containerJson: string, projectName: string, sandboxNetwork: string, egressNetwork: string, edgeService: string, studioCaller: string): string[];
  isSensitiveHostPath(source: string): boolean;
  parseDotenv(text: string): string[][];
  NativeRedactor: new (names: string[], values: string[]) => NativeRedactor;
  planGitMask(mountsJson: string, entriesJson: string, cwd: string): string;
  planEvaluationAssetMask(mountsJson: string, projectRoot: string, assetsJson: string, cwd: string): string;
  nestedAssetMountError(composeMountsJson: string, mountsJson: string, projectRoot: string, assetsJson: string, cwd: string): string | null | undefined;
  collectHostMounts(configJson: string, cwd: string): string;
  composeMountSpecs(configJson: string, cwd: string): string;
  boundDevice(volumeJson: string): string | null | undefined;
  mergeMasks(plansJson: string): string;
  dockerDesktopHostPath(source: string): string | null | undefined;
  isInsideHostPath(cwd: string, parent: string, target: string): boolean;
  isInsidePosix(parent: string, target: string): boolean;
  // ── 출력 해석 함수(2단계 2b-1). 큰 구조는 JSON 문자열. NaN·Infinity는 표시 객체로 오간다(encodeNative·decodeNative)
  parseDockerBytes(text: string): number | null | undefined;
  parseStatsOutput(stdout: string): string;
  parseInspectOutput(stdout: string): string;
  mergeUsage(inspectedJson: string, statsJson: string, managedNames: string[], edgeService: string): string;
  bootNetworkFromUsage(usageJson: string, exclude: string): string;
  // ── 파일 변경 알림 계획(2단계 2b-2b 첫 묶음). 객체는 Object.entries로 순서를 정해 넘긴다
  bindMounts(servicesJson: string, managed: string[], servicePathsJson: string, cwd: string): string;
  planRelay(projectRoot: string, changesJson: string, mountsJson: string, cwd: string): string;
  // ── 서비스 준비 판정(2단계 2b-2b)
  decideReadiness(historyJson: string, policyJson: string, elapsedMs: number): string;
  isTransientBootError(lines: string[]): boolean;
  shouldRetryTransientCrash(attempt: number, excerpt: string[]): boolean;
  crashLogExcerpt(lines: string[], max: number): string[];
  formatBytes(bytes: number | undefined): string;
  describeUsage(usageJson: string): string;
  classifyOwnership(labelKeys: string[]): string;
  parseHostContainers(stdout: string): string;
  matchesProjectRoot(workingDir: string | undefined, projectRoot: string, cwd: string): boolean;
  discoverUserContainers(containersJson: string, projectRoot: string, cwd: string): string;
  mergeHostContainerStats(namesJson: string, statsStdout: string): string;
  isForwarderProcess(command: string): boolean;
  parseLsofListening(output: string): string;
  parseSsListening(output: string): string;
  matchDeclaredPorts(pids: number[], commands: string[], ports: number[], declaredPorts: number[], excludePids: number[]): number[];
  parsePsRow(output: string): string | null | undefined;
  classifyActuatorProbe(healthOk: boolean, logfileStatus: number | undefined): string;
  snapshotName(project: string, service: string, volume: string, paths: string[], present: boolean[], contents: Buffer[]): string;
  snapshotSlot(project: string, service: string, volume: string): string;
  composeVolumeName(composeProject: string, volume: string): string;
  snapshotsToPrune(inspectOutput: string, keep: number, parseDate: (text: string) => number): string[];
  describeSnapshotEvent(eventJson: string): string | null | undefined;
  parseProcessScan(stdout: string): string;
  foreignProcesses(nowPids: number[], nowStarts: string[], baselinePids: number[], baselineStarts: string[]): number[];
  parseEgressDenial(text: string): string | null | undefined;
  egressAuditExcerpt(lines: string[], max: number): string[];
  parseRuntimes(stdout: string): string[];
  parseHostPort(stdout: string): number;
  parseContainerStates(stdout: string): string[][];
  parseContainerState(stdout: string): string;
  parseSyncOutput(stdout: string): string[][];
  parseLogLine(raw: string): string | null | undefined;
  NativeSyncObservations: new () => NativeSyncObservations;
  NativeDumpNormalizer: new () => NativeDumpNormalizer;
  // ── compose override와 edge 설정(2단계 2b-2a). 입력·출력은 JSON 문자열. 모양이 어긋난 입력은 던진다
  edgeConstants(): string;
  edgePortFor(managedNames: string[], service: string): number;
  directHosts(services: string[], externals: string[]): string[];
  proxyEnvironment(direct: string[]): string;
  edgeEnvironment(inputJson: string): string;
  buildOverride(inputJson: string): string;
  composeUpArgs(explicit: string[] | undefined, edgeService: string): string[];
  resolvePublicUrlPlaceholders(value: string, hostPortsJson: string): string;
  // ── 무중단 배포 계획(2단계 2b-2b 셋째 묶음, #1036). 입력·출력은 JSON 문자열. 모양이 어긋난 입력은 던진다
  emptyDeployState(project: string): string;
  deployBaseName(project: string): string;
  deployReleaseName(project: string, id: string): string;
  deployProxyName(project: string): string;
  deployImageName(project: string, service: string, id: string): string;
  deployContainerName(composeProject: string, service: string): string;
  newReleaseId(nowMs: number): string;
  proxyListenPort(index: number): number;
  planBaseCompose(configJson: string, projectJson: string): string;
  planReleaseCompose(configJson: string, projectJson: string, releaseId: string, imagesJson: string): string;
  buildArgsFor(dockerfile: string, buildJson: string, environmentJson: string): string;
  summarizeBuildOutput(output: string, maxLines: number): string;
  buildCaddyfile(routesJson: string): string;
  releasesToRetire(statusesJson: string, keepPrevious: number): number[];
  trimRecords(idsJson: string, active: string | undefined): number[];
  // ── I/O 조율: stream-exec(2단계 2c-1, #1041). 자식 프로세스 출력을 파일로 흘리거나 파일을 입력으로 넣는다.
  // env를 주면 상속 없이 통째로 바꾼다(Node spawn과 같음). signal로 취소하면 자식을 죽인다
  runCommandToFile(bin: string, args: string[], outputFile: string, env: Record<string, string> | undefined | null, signal: AbortSignal | undefined | null): Promise<ExecResult>;
  runCommandFromFile(bin: string, args: string[], inputFile: string, env: Record<string, string> | undefined | null, signal: AbortSignal | undefined | null): Promise<ExecResult>;
  // ── I/O 조율: #docker 일반 실행(2단계 2c-2, #1043). docker/docker compose를 한 번 돌려 stdout·stderr를 모은다.
  // 던지지 않는다 — 비0 종료·취소·spawn 실패·maxBuffer 초과 모두 결과로 돌려준다(execFileAsync + isExecFailure와 같음).
  // signal로 취소하면 거절하지 않고 그때까지의 부분 출력과 exitCode 1을 돌려준다(stats의 timeout-cutoff 보존)
  runCommand(bin: string, args: string[], input: string | undefined | null, env: Record<string, string> | undefined | null, cwd: string | undefined | null, maxBuffer: number | undefined | null, signal: AbortSignal | undefined | null): Promise<ExecResult>;
  // ── 샌드박스 조율의 순수 도우미(ADR-195 4f A4a). 큰 구조는 JSON 문자열(encodeNative·decodeNative). 수는 f64
  parseDependsOn(configJson: string): string;
  startWaves(services: string[], dependsOnJson: string): string[][];
  awaitedCondition(service: string, later: string[], dependsOnJson: string): string | null | undefined;
  /** 이름과 값은 같은 자리끼리 짝. 허용 목록을 거른 뒤 시크릿을 얹은 [이름, 값] 목록 */
  composeEnvironment(secretNames: string[], secretValues: string[], envNames: string[], envValues: string[]): string[][];
  externalCallScript(edgeScript: string, requestJson: string): string;
  loadThreads(concurrent: number, daemonCpus: number | undefined | null): number;
  loadRunArgs(name: string, network: string, sandboxId: string, threads: number, runtime: string | undefined | null, image: string): string[];
  loadConfig(requestJson: string, port: number, threads: number): string;
  loadScript(runner: string, configJson: string): string;
  parseLoadOutput(stdout: string, requests: number, concurrent: number): string | null | undefined;
  isPortBindConflict(stderr: string): boolean;
  dockerOutOfSpace(): string;
  dockerOutOfSpaceNote(text: string): string | null | undefined;
  splitUpArgs(args: string[]): { create: string[]; services: string[]; byId: boolean };
  runtimeFromEnv(value: string | undefined | null): string | null | undefined;
  sandboxBuildNoCache(value: string | undefined | null): boolean;
  findFreeHostPort(): Promise<number>;
  // ── 체크포인트 실행(ADR-195 4f A1). 바이트 그대로 돌려주는 실행과 `git archive | tar -x`. 던지지 않는다.
  // exitCode는 신호로 죽으면 null, 띄우기 실패는 spawnError. 취소·상한 넘김은 SIGTERM으로 멈춘다
  /** 체크포인트 원격 경로(ADR-195 4f A2). op별 JSON 입력·출력. `hook`은 요청(JSON)을 받아 응답(JSON)을 돌려준다. 던지지 않고 결과의 `ok`로 돌려준다 */
  checkpointRemote(op: string, input: string, hook: (request: string) => Promise<string>): Promise<string>;
  /** 게이트 검증의 조율(ADR-195 4f A5a). op: verifyChanges·restartServicesFor·findSecretLeaks·captureBaselines. `hook`은 요청(JSON)을 받아 응답(JSON)을 돌려준다. 던지지 않고 결과의 `ok`·`kind`로 돌려준다 */
  verifyRun(op: string, input: string, hook: (request: string) => Promise<string>): Promise<string>;
  /** 게이트 check의 상태 기계(ADR-195 4f A5b-1). `input`·결과는 JSON. `hook`은 요청(JSON)을 받아 응답(JSON)을 돌려준다. 던지지 않고 결과의 `ok`·`kind`로 돌려준다 */
  gateCheckRun(input: string, hook: (request: string) => Promise<string>): Promise<string>;
  /**
   * 루프백 서버의 전송(ADR-201, 4f A7a). Rust가 127.0.0.1의 임의 포트를 열고 Host·토큰·메서드·라우트·본문 상한(4MiB)을 확인한 뒤, 라우트에 맞은 요청의
   * 원래 바이트를 `handler`에 넘긴다. `routes`는 요청 대상 원문(쿼리 포함)이고 `handler`가 받는 `route`는 그 번호다. 토큰·허용 이름·라우트는 `encodeLoneSurrogates`한 꼴로 넘긴다.
   * 서버가 열려 있는 동안 Node 프로세스는 끝나지 않는다(`closeLoopbackServer`를 불러야 끝난다). `handler`가 던지면 그 요청은 500이다
   */
  startLoopbackServer(
    token: string,
    allowedHosts: string[],
    routes: string[],
    handler: (request: NativeLoopbackRequest) => Promise<NativeLoopbackResponse>,
  ): Promise<{ id: number; port: number }>;
  /**
   * MCP 도구 서버(ADR-201, 4f A7b). Rust가 127.0.0.1의 임의 포트를 열고 Host·토큰 확인, streamable HTTP(stateless) 처리, JSON-RPC 해석·분배, 도구 인자 검사, SSE 쓰기를 한다.
   * `handler`는 두 일을 `kind`로 받는다: `list`(도구 목록 JSON `[{name, description?, input_schema}]`을 `specs`로, 못 얻으면 `error`로 돌려준다)와
   * `call`(검사를 통과한 인자를 받아 도구를 실행하고 `ok`·`content`·`images`를 돌려준다). 이름·결과의 글자는 `encodeLoneSurrogates`한 꼴이고 `args`는 `decodeNative`로 읽는다.
   * 닫는 것은 `closeLoopbackServer`다. 서버가 열려 있는 동안 Node 프로세스는 끝나지 않는다
   */
  startMcpServer(
    token: string,
    allowedHosts: string[],
    name: string,
    honorRequired: boolean,
    handler: (call: NativeMcpCall) => Promise<NativeMcpAnswer>,
    /** 도구 순서 장부(ADR-202). 있으면 `tools/call`이 `handler`를 부르기 전에 장부를 지난다: 도착 순서대로 하나씩, 그 도구의 `tool_use`를 본 뒤에, 닫혔거나 취소됐으면 `handler`를 부르지 않고 isError 결과로 거절한다 */
    ledger?: NativeToolLedger | null,
  ): Promise<{ id: number; port: number }>;
  /** 새 연결을 받지 않고 열린 연결(처리 중인 것 포함)을 끊고, 끝나면 resolve한다. 모르는 id·이미 닫은 id는 아무 일도 하지 않는다 */
  closeLoopbackServer(id: number): Promise<void>;
  runCommandBytes(bin: string, args: string[], input: Buffer | undefined | null, env: Record<string, string> | undefined | null, cwd: string | undefined | null, maxBuffer: number, signal: AbortSignal | undefined | null): Promise<BytesResult>;
  runArchiveExtract(gitBin: string, gitArgs: string[], gitEnv: Record<string, string> | undefined | null, dest: string): Promise<ArchiveExtractResult>;
  // ── I/O: 링크 안전 파일 시스템 준비(2단계 2c-1b). 아무것도 재귀로 따라가며 지우지 않는다(링크는 링크만).
  // 오류는 메시지를 담은 Error로 거절된다. 이름을 받는 곳은 한 이름이 아니면(`..`·구분자·NUL·빈 이름) 거부한다
  prepareEvaluationAssetSlot(source: string, kind: 'file' | 'directory', parent: string): Promise<void>;
  removeSandboxDirectory(dir: string): Promise<void>;
  // ── I/O 조율: 줄 단위 역류 실행(2단계 2c-3a, #1045). deploy의 #docker가 쓴다. 출력을 줄마다 onLine에 흘리고 뒤쪽 200K를 모은다.
  // onLine은 ThreadsafeFunction으로 Rust 작업 스레드에서 (line) 한 인자로 불린다. cwd를 받는다. 던지지 않는다(취소 시 부분 결과)
  runCommandStreaming(bin: string, args: string[], input: string | undefined | null, env: Record<string, string> | undefined | null, cwd: string | undefined | null, onLine: (line: string) => void, signal: AbortSignal | undefined | null): Promise<ExecResult>;
  // ── I/O 조율: 로그 스트림(2단계 2c-3b, #1047). compose-provider의 logs()가 쓴다. docker compose logs의 stdout을
  // 줄 단위로 당겨 주는 AsyncIterator. 당기기(pull) 모델이라 소비가 느리면 docker 읽기가 막힌다(백프레셔).
  // raw 줄만 흘린다 — parseLogLine·redact·Date 변환은 TS가 한다. signal이 깨거나 소비자가 그만두면 자식을 kill한다.
  LogStream: new (
    bin: string,
    args: string[],
    env: Record<string, string> | undefined | null,
    cwd: string | undefined | null,
    signal: AbortSignal | undefined | null,
  ) => AsyncIterableIterator<string>;
  // ── I/O 조율: git-mask의 파일 시스템 I/O(2단계 2c-6). 판정은 위의 planGitMask 등이 하고 여기는 사실을 읽고 가림 자리를 준비한다.
  // realPath는 링크를 풀고 못 풀면 path.resolve와 같다. prepareStateMasks는 던지지 않고 failure로 돌려준다
  realPath(target: string, cwd: string): Promise<string>;
  detectGitEntries(projectRoot: string, mountSources: string[], cwd: string): Promise<NativeGitEntry[]>;
  prepareStateMasks(entries: NativeGitEntry[]): Promise<{ entries: NativeGitEntry[]; failure?: { state: string; detail: string } | null }>;
  // 컨테이너 사후 확인과 확인한 컨테이너 시작(ADR-195 4f A4b). verifyContainers는 던지지 않고 결과로 돌려준다
  verifyContainers(input: NativeVerifyInput): Promise<NativeVerifyResult>;
  startVerifiedContainers(input: NativeStartInput, signal: AbortSignal | undefined | null): Promise<NativeStartResult>;
  selectEvaluationAssetVolumes(volumesJson: string, assetsJson: string, cwd: string): Promise<string>;
  findMissingMasks(projectRoot: string, mountsJson: string, volumeOptionsJson: string, plannedJson: string, tmpfs: string[], cwd: string): Promise<string[]>;
  // 컨테이너 만들기 반복과 .git 마스크 계산·override 쓰기(ADR-195 4f A4c-1). 모두 던지지 않고 결과(`kind`)로 돌려준다
  upWithGitMask(input: NativeUpInput, signal: AbortSignal | undefined | null): Promise<NativeUpResult>;
  loadGitMask(compose: NativeComposeRef, assetsJson: string, cwd: string): Promise<NativeUpResult>;
  computeGitMask(projectRoot: string, configJson: string, assetsJson: string, cwd: string): Promise<NativeUpResult>;
  writeComposeOverride(path: string, inputJson: string, maskJson: string): Promise<NativeUpResult>;
  // ── 파일 반영 확인·변경 알림·포트 충돌 재시도(ADR-195 4f A4c-2). 던지지 않고 결과(`kind`)로 돌려준다
  syncFiles(input: NativeSyncInput, signal: AbortSignal | undefined | null): Promise<NativeSyncResult>;
  relayChanges(input: NativeRelayInput, signal: AbortSignal | undefined | null): Promise<NativeRelayResult>;
  upWithPortRetry(input: NativePortRetryInput, signal: AbortSignal | undefined | null): Promise<NativePortRetryResult>;
  // ── 준비 확인·모르는 프로세스 검사·인프라 확인(ADR-195 4f A4c-3a). 던지지 않고 결과(`kind`)로 돌려준다.
  // awaitReadyOnce의 onProbe는 확인이 끝날 때마다 `ProbeResult`의 JSON을 받고, 계속하면 true를 돌려준다(Rust는 처리가 끝나길 기다린다)
  awaitReadyOnce(input: NativeAwaitReadyInput, onProbe: (probe: string) => boolean, signal: AbortSignal | undefined | null): Promise<NativeAwaitReadyResult>;
  scanServiceProcesses(input: NativeScanInput, service: string, signal: AbortSignal | undefined | null): Promise<NativeScanResult>;
  strayProcesses(input: NativeScanInput, services: string[], baselineJson: string, signal: AbortSignal | undefined | null): Promise<NativeStrayResult>;
  missingServices(compose: NativeComposeRef, overridePath: string, names: string[], signal: AbortSignal | undefined | null): Promise<string[]>;
  // ── 의존성 스냅샷·공유 볼륨·stats(ADR-195 4f A4c-3b). 던지지 않고 결과(`kind`)로 돌려준다. `up`은 부르지 않고 이벤트도 알리지 않는다(TS가 한다).
  // prune의 parseDates는 만든 시각 글의 JSON 배열을 받아 같은 길이의 숫자 JSON 배열(읽을 수 없으면 null)을 돌려준다(JS `Date.parse`)
  planSnapshots(scope: NativeSnapshotScope, root: string, volumes: NativePlanVolume[]): Promise<NativeSnapshotPlan[]>;
  seedSnapshot(compose: NativeComposeRef, scope: NativeSnapshotScope, plan: NativeSnapshotPlan, image: string, signal: AbortSignal | undefined | null): Promise<NativeSeedResult>;
  captureSnapshot(compose: NativeComposeRef, scope: NativeSnapshotScope, plan: NativeSnapshotPlan, image: string): Promise<NativeCaptureResult>;
  pruneSnapshots(compose: NativeComposeRef, scope: NativeSnapshotScope, plan: NativeSnapshotPlan, parseDates: (texts: string) => string): Promise<NativePruneResult>;
  ensureSharedVolumes(dockerBin: string, names: string[]): Promise<NativeSharedVolumesResult>;
  readStats(input: NativeStatsInput): Promise<NativeStatsResult>;
  // ── 샌드박스 끝맺음·부하 러너·사내 API 호출·만들기 준비(ADR-195 4f A4c-3c). 던지지 않고 결과(`kind`)로 돌려준다(makeWorkDir만 던진다). `up`은 부르지 않는다
  removeSandboxImages(dockerBin: string, sandboxId: string, cwd: string | undefined | null): Promise<NativeCheckedResult>;
  cleanupSandbox(dockerBin: string, sandboxId: string, assetRoot: string, cwd: string | undefined | null): Promise<NativeCleanupResult>;
  destroySandbox(input: NativeDestroyInput): Promise<NativeDestroyResult>;
  assertRuntime(dockerBin: string, runtime: string): Promise<NativeRuntimeCheck>;
  makeWorkDir(): Promise<string>;
  abortCreate(workDir: string, assetRoot: string, sandboxId: string): Promise<string[]>;
  callExternal(input: NativeExternalInput, signal: AbortSignal | undefined | null): Promise<NativeExternalResult>;
  runLoad(input: NativeLoadInput, signal: AbortSignal | undefined | null): Promise<NativeLoadResult>;
  // ── 화면 확인 러너(ADR-199, 4f A6a). 던지지 않고 결과(`kind`)로 돌려준다
  runBrowserCheck(input: NativeBrowserRunInput, signal: AbortSignal | undefined | null): Promise<NativeBrowserRunResult>;
  browserIsAllowedUrl(url: string, allowedOrigins: string[]): boolean;
  // ── I/O 조율: 호스트 PTY(2단계 2c-4a, #1049). host-terminal의 node-pty를 portable-pty로 대체한다.
  // 양방향: write/resize/kill은 동기, onData(출력 Buffer)·onExit(종료 코드)는 Rust 스레드에서 역류한다(ThreadsafeFunction).
  // env는 상속 없이 통째 치환한다(node-pty와 같다). 출력은 raw bytes다(UTF-8 경계가 조각에서 잘릴 수 있어 터미널이 재조립).
  HostPty: new (
    file: string,
    args: string[],
    name: string,
    cols: number,
    rows: number,
    cwd: string,
    env: Record<string, string>,
    onData: (data: Buffer) => void,
    onExit: (code: number) => void,
  ) => NativeHostPty;
  // ── I/O 조율: 양방향 exec 세션(2단계 2c-4b). agent-terminal의 `docker exec -i`가 쓴다. 출력·종료는 하나의 onEvent로
  // 순서대로 밀려 온다(data: stdout·stderr 바이트. exited면 code가 종료 코드이고 시그널로 죽었으면 null/undefined).
  // 띄우기 실패는 exited, code -2. write·end·terminate는 동기다. 닫힌 뒤의 write는 버리고 false
  ExecSession: new (
    bin: string,
    args: string[],
    env: Record<string, string> | undefined | null,
    cwd: string | undefined | null,
    onEvent: (event: NativeExecEvent) => void,
  ) => NativeExecSession;
  // ── CLI 프로세스 층(ADR-195 4f A8a). `claude` CLI 자식의 입출력: 띄우기·표준 입력 줄 쓰기·닫기·표준 출력의 줄 나누기(Node readline과 같게)·표준 오류 끝 2,000자(UTF-16 단위)·
  // 닫기 단계(graceful: 입력 닫기 → termAfterMs 뒤 SIGTERM → killAfterMs 뒤 SIGKILL, now: 입력 닫기 + 바로 SIGTERM)·끝 상태. 줄과 끝은 하나의 onEvent로 순서대로 밀려 온다(끝이 마지막).
  // env는 자식의 환경 전부다(비운 뒤 이것만 준다). JSON 해석은 TS가 한다
  CliProcess: new (
    bin: string,
    args: string[],
    env: Record<string, string>,
    cwd: string,
    termAfterMs: number,
    killAfterMs: number,
    onEvent: (event: NativeCliEvent) => void,
  ) => NativeCliProcess;
  // ── 지원 러너의 메시지 루프·실행 상태(ADR-202, 4f A8b) ──
  /**
   * 도구 순서 장부: 같은 실행의 러너 코어와 MCP 서버가 나눠 쥐는 객체. `prefix`는 MCP 요청의 도구 이름 앞에 붙는 말(`mcp__<서버>__`), `waitMs`는 도구 요청이
   * 그 호출이 든 assistant 메시지를 기다리는 상한. 이름·이유의 글자는 `encodeLoneSurrogates`한 꼴이다
   */
  ToolLedger: new (prefix: string, waitMs: number) => NativeToolLedger;
  /** 지원 러너의 코어. `claude` CLI 프로세스를 직접 쥐고 메시지 루프·실행 상태를 돈다. 게이트·결과 조립·도구 실행·인자 만들기·지시·이벤트는 `run`의 `hook`으로 TS를 부른다 */
  RunnerCore: new (ledger: NativeToolLedger) => NativeRunnerCore;
  /** 세션 하나의 이벤트 기록(ADR-203, 4f B1a). `logs`가 거짓이면 보관 세션의 기록(logs 없음) */
  SessionRecord: new (logs: boolean) => NativeSessionRecord;
  /**
   * 세션 하나의 저장(ADR-203, 4f B1b): 500ms 모으기와 쓰기를 차례로 잇는 줄. `record`는 저장할 history를 가진 그 세션의 기록이다.
   * `state`는 쓰기를 시작할 때 메인 스레드에서 불리고(던지면 그 쓰기는 하지 않고 이유를 알린다) 인자는 쓰지 않는다. `onError`는 예약한 쓰기의 실패를 알린다.
   * 두 콜백은 약한 참조라 이 객체가 Node 프로세스를 붙잡지 않는다. `delayMs`는 시험용이다(없으면 500)
   */
  Persister: new (record: NativeSessionRecord, state: (unused: number) => NativePersistState, onError: (message: string) => void, delayMs?: number) => NativePersister;
  /** 세션 폴더들에서 저장된 세션을 읽는다(옛 `readSessions`). 폴더가 아닌 항목·읽을 수 없는 파일·JSON이 아니거나 형식이 다른 파일은 건너뛴다 */
  readSessions(root: string): Promise<NativeStoredSession[]>;
  /** 세션을 지우기 전의 판정(ADR-204, 4f B2a). 디스크를 바꾸지 않는다. 거절하면 이유를, 통과하면 null을 돌려준다 */
  deleteSessionCheck(input: NativeDeleteCheckInput): NativeLifecycleFail | null;
  /** 세션 폴더를 지운다(JS 스레드 밖에서). 지우기 직전에 `root` 바로 아래의 `<프로젝트>-<sessionId>` 폴더인지·링크가 아닌지·`userDir`이 그 안이 아닌지 다시 확인하고, 하나라도 확인하지 못하면 지우지 않고 이유를 돌려준다. 지웠거나 이미 없으면 null */
  removeSessionHome(root: string, home: string, sessionId: string, userDir?: string | null): Promise<NativeLifecycleFail | null>;
  /** 이어받기 전의 판정: 저장 파일이 가리키는 폴더가 세션을 읽어 온 폴더(`home`)여야 한다. 거절하면 이유를, 통과하면 null을 돌려준다 */
  resumeSessionCheck(home: string, workspace: string | null | undefined, workDir: string, stateDir?: string | null): NativeLifecycleFail | null;
  /** 복구할 때 세션 하나를 어떻게 할지. `ownerAlive`는 `isProcessAlive(owner.pid)`의 결과다 */
  recoverSessionPlan(status: string, ownerPid: number, selfPid: number, ownerAlive: boolean, sandboxId: string): NativeRecoverPlan;
  /** 저장된 샌드박스 id가 b-studio가 만든 id의 꼴인가(`SANDBOX_ID`) */
  isSandboxId(id: string): boolean;
  // ── 세션 상태 전이·멈추기·이어받기 판정·폴더 점유(ADR-205, 4f B2b) ──
  /** 세션 하나의 상태(`idle`·`starting`·`ready`·`failed`·`stopped`)와 멈추는 중 여부·켜기 세대. `initial`은 `idle` 또는 `starting`이다(아니면 던진다) */
  SessionState: new (initial: string) => NativeSessionState;
  /** 세션 맵 수준의 상태: 실행 중인 세션의 상태, 이어받는 중인 세션, 내 폴더 세션의 폴더 점유 */
  SessionRegistry: new () => NativeSessionRegistry;
  /** 멈추기의 단계 목록(순서대로). 마지막이 `flush_persist`다 */
  sessionStopSteps(): NativeStopStep[];
  // ── 세션 만들기의 순서와 치우기(ADR-206, 4f B2c) ──
  /** 만들기의 단계 목록(순서대로)과 단계마다의 치우기 콜백 이름 */
  sessionCreateSteps(): NativeCreateStep[];
  /**
   * 세션을 만든다. 단계마다 `hook(단계 이름)`을, 실패하면 끝낸 단계의 치우기를 거꾸로 `hook(치우기 이름)`으로 부른다. 세션 폴더(`make_home`)는 코어가 배타적으로 만들고
   * 실패하면 B2a의 `removeSessionHome` 규칙으로 지운다(이 호출이 만든 폴더만). hook은 성공하면 null, 실패하면 이유를 돌려준다(던지지 않는다)
   */
  createSessionRun(input: NativeCreateRunInput, hook: (name: string) => Promise<string | null>): Promise<NativeCreateResult>;
  /** 요청 실행의 단계 이름(순서대로, ADR-208) */
  runOutcomeSteps(): string[];
  /** 터미널 실행을 통과하지 못한 채 닫을 때의 판정(ADR-210). 시험·진단용: 실행은 `terminalCloseBegin`이 코어 안에서 같은 판정을 쓴다 */
  terminalDecideClose(input: NativeTerminalCloseInput): NativeTerminalCloseDecision;
  /** 닫기의 단계 이름(순서대로) */
  terminalCloseSteps(): string[];
  /** 터미널의 요청 시작 판정(ADR-211). 순수 판정이다 */
  terminalDecidePrompt(facts: NativeTerminalPromptFacts): NativeTerminalPromptDecision;
  /** 터미널의 쓰기 직전·MCP 판정(ADR-211). 기다림 앞과 뒤에서 그 순간의 사실로 부르고 뒤의 답이 최종이다 */
  terminalDecidePreTool(facts: NativeTerminalPreToolFacts): NativeTerminalPreToolDecision;
  /** 다음 요청에 켜 둔 확인 선언 변경 허용을 이 실행이 가져가는가(ADR-164, ADR-211) */
  terminalTakesCheckChanges(openedByPrompt: boolean, readOnly: boolean, allowedNext: boolean): boolean;
  /** 요청 글의 분류(ADR-215): 읽기만(감싸개를 끝까지 벗기며 하나라도 표시로 시작하면 참)·`/` 명령·감싸개를 한 번 벗기고 자른 글. 순수 함수다 */
  terminalClassifyPrompt(text: string): NativeTerminalPromptClass;
  /** 읽기 도구인가(ADR-215): Claude Code와 Codex의 표에 정확히 일치하는 이름만 참이다 */
  terminalIsReadTool(name: string): boolean;
  /** 읽기만이 앞선 변경이 있는 실행에 이어 켜질 때 턴 끝에 표시하는가(ADR-215). `changedBefore`: 0 없음, 1 있음, 그 밖은 읽지 못함(있는 것으로 본다) */
  terminalReadOnlyAfterWork(alreadyReadOnly: boolean, verificationStarted: boolean, changedBefore: number): boolean;
  /** 터미널의 턴 끝 게이트 앞 판정(ADR-212). 읽지 않은 사실(`unread`)이 필요한 칸에 닿으면 `need_*`를 돌려준다 */
  terminalDecideTurnEnd(facts: NativeTerminalTurnEndFacts): NativeTerminalTurnEndStep;
  /** 터미널의 게이트 뒤 판정(ADR-212): 취소 → 턴 상한 → 통과면 위반 → 재시도·소진 */
  terminalDecideGateOutcome(facts: NativeTerminalGateFacts): NativeTerminalGateStep;
  /** 체크포인트를 남긴 직후 판정(ADR-212): `settle`·`fail_violation` */
  terminalDecideAfterCheckpoint(violation: boolean): string;
  /** 저장이 남긴 체크포인트를 알아본다(ADR-217). `headRead`: `empty`·`sha`(`head`가 지금 HEAD)·그 밖은 읽지 못함. 결과 `yes`·`no`·`unknown` */
  terminalLandedState(committed: string | null | undefined, headRead: string, head: string | null | undefined): string;
  /** 턴 끝이 던졌을 때 무엇으로 닫을지(ADR-217): 멈춤 → 남은 체크포인트 → 취소 → 시간 상한 → 플랫폼 실패 → 오류 */
  terminalDecideTurnEndError(facts: NativeTerminalErrorFacts): NativeTerminalErrorClose;
  /** 체크포인트를 남기는 중인 실행을 위반을 적을 실행으로 받아들이는가(ADR-217) */
  terminalSavingAccepts(hasSaving: boolean, attachedAsSessionRun: boolean, closed: boolean): boolean;
  /** 저장 중이던 실행을 다시 여는가(ADR-217) */
  terminalShouldReattach(sessionHasRun: boolean, closed: boolean): boolean;
  /** 체크포인트 저장이 던진 오류의 갈 곳(ADR-217): `reconcile_then_rethrow`·`retry_moved`·`rethrow` */
  terminalDecideSaveFailure(kind: string): string;
  /** 게이트 단계 판정(ADR-217): 시간 상한 → 멈추지 못함 → 거절된 경로 → 게이트 → 통과 뒤 바뀜 → 완료 검사 */
  terminalDecideGateStage(facts: NativeTerminalGateStageFacts): NativeTerminalGateStageStep;
  /** 게이트 시간 상한(ms)(ADR-217): Stop 훅 상한(초)보다 여유만큼 앞이다 */
  terminalGateDeadlineMs(hookSeconds: number): number;
  /** 터미널의 사용량 귀속 판정(ADR-213): 셀지, 붙일 실행, 턴을 셀지, 한도를 볼지 */
  terminalDecideUsage(facts: NativeTerminalUsageFacts): NativeTerminalUsageStep;
  /** 텔레메트리 본문(JSON 글)에서 모델 호출을 꺼낸다(ADR-216). 모양이 틀린 `api_request`도 한 호출로 센다. `now`는 받은 시각(ms) */
  terminalParseTelemetry(body: string, now: number): NativeTerminalTelemetry;
  /** 사용량이 더해진 뒤 한도를 볼 때의 전이(ADR-216): 턴 상한을 본 사유와 토큰 한도를 이어서 볼지 */
  terminalDecideLimit(facts: NativeTerminalLimitFacts): NativeTerminalLimitStep;
  /** 쓰기 직전 훅이 이 실행의 사용량을 확인할 수 없는가(ADR-216) */
  terminalUsageUnverifiable(silent: boolean, incomplete: boolean, tokenLimited: boolean): boolean;
  terminalEarlyUsageMs(): number;
  terminalLateUsageMs(): number;
  /** 터미널의 정체 감시 한 회차(ADR-213): `stop`·`nothing`·`notify` */
  terminalDecideStall(facts: NativeTerminalStallFacts): string;
  /** 정체 감시 주기(ms) */
  terminalStallIntervalMs(stallMs: number): number;
  /** 사용량 소식이 끊겼는가(ADR-213): `fine`·`silent` */
  terminalDecideSilence(facts: NativeTerminalSilenceFacts): string;
  runOutcomeDecideNormal(facts: NativeRunNormalFacts, pending: boolean): NativeRunOutcome;
  runOutcomeNeedsProbeNormal(facts: NativeRunNormalFacts): boolean;
  runOutcomeDecideException(facts: NativeRunExceptionFacts, pending: boolean): NativeRunOutcome;
  runOutcomeNeedsProbeException(facts: NativeRunExceptionFacts): boolean;
  /** 기록으로 세션 파일 한 번 쓰기(줄·예약 없이). `fullHistory`가 거짓이면 저장용 history, 참이면 기록 전체. `head`·`tail`이 객체 글자가 아니면 던진다 */
  writeSessionRecord(record: NativeSessionRecord, file: string, head: string, tail: string, fullHistory: boolean): Promise<void>;
  /** `writeSessionRecord`의 동기 판: 종료 신호 처리처럼 기다릴 수 없는 곳에서 이 스레드에서 쓴다(임시 파일 `<file>.<pid>.exit.tmp`). 던질 수 있다 */
  writeSessionRecordSync(record: NativeSessionRecord, file: string, head: string, tail: string, fullHistory: boolean): void;
  /** 사이드카 파일을 원자적으로 쓴다: 폴더 만들기 → 호출마다 다른 임시 파일 → rename. `mode`는 새 파일의 권한(예: 0o600) */
  writeFileAtomic(file: string, text: string, mode?: number): Promise<void>;
  // ── 토큰 한도 판정과 사람별 사용량 파일(ADR-209, 4f B3c) ──
  /**
   * 토큰 한도 판정. 요청 시작·대화 실행 중·터미널 실행 중이 이 함수 하나를 부른다. 사람 몫 = `fileTotal - saved + accum`.
   * `userLimit`이 없으면 사람 몫은 보지 않는다. 수가 아니거나 음수·무한인 입력은 한도에 닿은 것으로 판정한다
   */
  judgeTokenLimit(sessionTotal: number, sessionLimit: number | undefined, userLimit: number | undefined, fileTotal: number, saved: number, accum: number): 'ok' | 'session' | 'user';
  /** 사람별 사용량 파일에서 그 기간·사람의 합계. 쓴 사람이 없으면 null, 파일을 읽을 수 없으면 던진다 */
  usageUserUsage(dir: string, period: string, user: string): NativeUsage | null;
  /** 사람별 사용량 파일 전체를 `{"version":1,"periods":{...}}` 글자로. 없으면 빈 기록, 읽을 수 없으면 던진다 */
  usageReadJson(dir: string): string;
  /** 더하고 더한 뒤의 합계를 돌려준다(이 스레드에서 끝난다). 잠금을 얻지 못했거나 읽을 수 없거나 쓰지 못하면 쓰지 않고 던진다 */
  usageAdd(dir: string, period: string, user: string, inputTokens: number, outputTokens: number, cacheReadTokens: number, cacheWriteTokens: number, lockWaitMs?: number): NativeUsage;
  /** 차등 시험용: 줄 하나를 러너가 읽는 규칙으로 읽어 꼬리표 붙은 JSON(`["num", "-0", true]` 같은 꼴)으로 돌려준다. JSON이 아니면 null, 너무 깊으면 `"deep"` */
  runnerParseLine(line: string): string | null | undefined;
  /** 차등 시험용: 덩어리 목록을 Node `StringDecoder`+`readline`(crlfDelay: Infinity)과 같은 규칙으로 줄로 나눈다 */
  cliSplitLines(chunks: Buffer[]): string[];
  /** 차등 시험용: 덩어리 목록의 표준 오류 끝부분(UTF-16 단위, 입력 끝에 디코더를 비운다) */
  cliStderrTailOf(chunks: Buffer[]): Uint16Array;
  // ── I/O 조율: 배포 개별 I/O(2단계 2c-5). deploy.ts가 쓴다. 모두 JS 스레드 밖(spawn_blocking)에서 돈다.
  freePort(): Promise<number>;
  // 잠금을 잡으면 0, 살아 있는 프로세스가 쥐고 있으면 그 pid. 그 밖의 I/O 오류는 거절한다. 죽은 프로세스의 잠금은 지우고 한 번 다시 시도한다
  acquireDeployLock(lock: string): Promise<number>;
  releaseDeployLock(lock: string): Promise<void>;
  // 없거나 읽지 못하면 null
  readTextFile(path: string): Promise<string | null>;
  // 부모 폴더를 만들고 쓴다. atomic은 임시 파일에 쓴 뒤 rename한다
  writeTextFile(path: string, content: string): Promise<void>;
  writeTextFileAtomic(path: string, content: string): Promise<void>;
  // 127.0.0.1에 GET 한 번(리다이렉트 안 따름). 던지지 않고 { status } 또는 { error }
  probeHttpStatus(port: number, path: string, timeoutMs: number): Promise<{ status?: number | null; error?: string | null }>;
  // ── agent: test-discovery(3단계 3a). 결과 객체는 JSON 문자열(옛 TS의 JSON.stringify와 같은 글자). 모양이 어긋난 평탄화 입력은 던진다.
  // framework가 undefined·null이면 내용으로 짐작한다
  extractRequirementIds(text: string): string[];
  extractRequirementIdsWithSuites(suitePath: string[] | undefined | null, title: string): string[];
  discoverJunitFile(filePath: string, content: string): string;
  detectJsFramework(content: string): string;
  discoverJsFile(filePath: string, content: string, framework: string | undefined | null): string;
  discoverPytestFile(filePath: string, content: string): string;
  isTestFilePath(filePath: string): boolean;
  discoverTestsInFile(filePath: string, content: string): string | null | undefined;
  flattenDiscoveredFile(fileJson: string): string;
  // ── agent: requirement-issues(3단계 3c). 객체는 JSON 문자열(encodeNative·decodeNative). 모양이 어긋난 입력은 던진다
  reqIssueLabel(): string;
  reqIssueContentHash(text: string): string;
  reqIssueBuildRegionContent(requirementJson: string): string;
  reqIssueRequirementContentHash(requirementJson: string): string;
  reqIssueBuildManagedRegion(requirementJson: string, rev: number): string;
  reqIssueParseManagedRegion(body: string): string | null | undefined;
  reqIssueSubIssueTitle(requirementJson: string): string;
  reqIssueIdFromTitle(title: string): string | null | undefined;
  reqIssueTrackingTitle(project: string): string;
  reqIssueFindTrackingIssue(issuesJson: string, projectName: string): string | null | undefined;
  reqIssueLabelSet(requirementJson: string, status: string): string[];
  reqIssueBuildTrackingBody(projectName: string, rowsJson: string, updatedAt?: string | null): string;
  reqIssueFindExistingRemote(requirementJson: string, remoteJson: string): number;
  reqIssuePlan(inputsJson: string, remoteJson: string): string;
  reqIssueSummarizePlan(entriesJson: string): string;
  reqIssueBuildStatusComment(requirementId: string, status: string, rowsJson: string): string;
  reqIssueIsStatusComment(body: string, requirementId?: string | null): boolean;
  reqIssueFindPinnedStatusComment(bodies: string[], requirementId: string): number;
  reqIssueImplementsTrailer(refJson: string): string;
  reqIssueExtractMentions(texts: string[]): string[];
  reqIssueBuildAddendum(refsJson: string, includeCloses: boolean): string;
  reqIssueBuildReviewContext(entriesJson: string): string;
  reqIssueFormYaml(): string;
  reqIssueParseIssueForm(title: string, body: string): string | null | undefined;
  reqIssueDraftFromIssue(title: string, body: string): string;
  reqIssueDraftManaged(title: string, body: string): string | null | undefined;
  reqIssueExtractTrackingNumbers(body: string): string;
  reqIssueManagedToRequirement(draftJson: string): string;
  reqIssueIsAllowedEndpoint(pathname: string): boolean;
  // ── agent: import-graph(3단계 3b). 별칭 설정은 `{ baseUrl?, paths: [{ pattern, targets }] }` JSON, 역방향 그래프는 `[[파일, [import하는 파일…]], …]` JSON
  importGraphIsPageFile(relative: string): boolean;
  importGraphRouteWrapperFolder(relative: string): string | null | undefined;
  importGraphIsSourceFile(relative: string): boolean;
  importGraphTokenize(source: string): string;
  importGraphExtractSpecifiers(source: string): string[];
  importGraphNormalizePath(value: string): string | null | undefined;
  importGraphDirOf(file: string): string;
  importGraphStripJsonc(text: string): string;
  importGraphExtendsPath(text: string, configDir: string): string | null | undefined;
  importGraphParseAliasConfig(text: string, configDir: string, baseJson: string | null | undefined): string;
  importGraphResolveImport(specifier: string, fromFile: string, files: string[], aliasJson: string): string | null | undefined;
  importGraphBuildReverse(sourceFiles: string[], sourceTexts: string[], files: string[], aliasJson: string): string;
  importGraphTracePages(changed: string[], reverseJson: string, files: string[], maxDepth: number): string;
  // ── agent: test-run·test-results(3단계 3d). 결과 객체는 JSON 문자열(NaN·Infinity가 나올 수 있는 보고서 해석은 encodeNative·decodeNative 표시 객체).
  // 알 수 없는 실행기·범위 밖 엔티티·모양이 어긋난 입력은 던진다. attachResults는 행마다 짝지은 케이스의 위치(없으면 -1)를 돌려준다
  testRunConstants(): string;
  buildTestRunPlan(runner: string, file: string | undefined | null, className: string | undefined | null, testName: string | undefined | null, wrapper: boolean | undefined | null, extraReportRoots: string[]): string;
  clearTestReportsCommand(extraReportRoots: string[]): string[];
  reportRootsForIncludes(includes: string[], root: string): string[];
  splitCollectedReports(stdout: string, singleFileLabel: string): string;
  detectRunner(template: string, hasPomXml: boolean | undefined | null, packageJson: string | undefined | null): string | null | undefined;
  runnerLabel(runner: string): string;
  parseJUnitXml(xml: string): string;
  parseJestLikeJson(json: string): string;
  attachResults(rowsJson: string, casesJson: string, ids: number[]): number[];
  countByStatus(statusesJson: string): string;
  buildFixTestPrefill(rowJson: string): string;
  buildAddTestPrefill(requirementJson: string): string;
  // ── agent: 게이트 리뷰 판정(3단계 3e). 입력·출력은 JSON 문자열(encodeNative·decodeNative). 판정 입력은 짝 없는 서로게이트가 있거나 모양이 어긋나면 던진다
  diffDeclaredChecks(startedJson: string, latestJson: string): string;
  weakenedDeclarations(startedJson: string, latestJson: string): string[];
  hasDeclaredCheckChange(added: string[], removed: string[], changed: string[]): boolean;
  describeDeclaredCheckChange(added: string[], removed: string[], changed: string[]): string;
  withDeclaredChecks(startedJson: string, latestJson: string): string | null | undefined;
  loadRequestFor(checkJson: string): string;
  describeLoadExpect(expectJson: string): string;
  judgeLoad(checkJson: string, resultJson: string): string;
  finishEvidence(lines: string[], redact: (text: string) => string): string[];
  browserPageEvidence(pageJson: string, resultJson: string, contextJson: string, redact: (text: string) => string): string[];
  httpPageEvidence(pageJson: string, responseJson: string, contextJson: string, redact: (text: string) => string): string[];
  testEvidence(service: string, command: string[], elapsedMs: number): string[];
  diffContracts(beforeJson: string, afterJson: string): string;
  summarizeContract(documentJson: string): string;
  formatContractChanges(changesJson: string): string;
  // ── agent: 토큰 예산·모델 선택(3단계 3f). 큰 구조는 JSON 문자열(encodeNative·decodeNative)
  clipCommandOutput(text: string, budget: number): string;
  clipText(text: string, budget: number, hint?: string | null): string;
  visibleHtml(html: string): string;
  isHtmlContent(contentType: string | null | undefined, text: string): boolean;
  repeatNotePrefix(): string;
  repeatNote(call: number): string;
  isRepeatNote(text: string): boolean;
  clearedToolResultPrefix(): string;
  clearedToolResultNote(chars: number): string;
  isClearedToolResult(text: string): boolean;
  planClearOldToolResults(messagesJson: string, keepRecent: number, clearAtLeastChars: number): string;
  isContextClearingOn(value: string | null | undefined): boolean;
  estimateTokens(text: string): number;
  classifyComplexity(prompt: string, inputTokens: number): string;
  classifyRisk(prompt: string): string;
  classifyTask(prompt: string): string;
  estimateCost(pricingJson: string, usageJson: string): number | null | undefined;
  routeModel(profilesJson: string, requestJson: string, statsJson: string): string;
  aggregateModelStats(observationsJson: string): string;
  validateModelProfiles(inputJson: string, urlFactsJson: string): string;
  cliTiers(): string[];
  tierLabel(tier: string): string | null | undefined;
  nextCliTier(tier: string): string | null | undefined;
  higherCliTier(a: string | null | undefined, b: string): string;
  routeCliTier(prompt: string, intent: string, stickyTier?: string | null): string;
  // ── agent: coordination·escalation(3단계 3i). 객체는 JSON 문자열(encodeNative·decodeNative). 선언한 모양이 어긋난 입력은 던진다
  coordNormalizeMessage(text: string): string;
  coordSignatureKey(signatureJson: string): string;
  coordSignaturesFromReport(reportJson: string): string;
  coordSignatureFromCheck(checkJson: string): string;
  coordFailureNotesFromReport(reportJson: string, checksJson: string): string;
  coordFailureNotesFromEvents(eventsJson: string): string;
  coordNoteBytes(body: string): number;
  coordCanRead(topology: string, readerLane: string, readerGroup: string | undefined | null, noteBy: string, noteLane: string, noteGroup: string | undefined | null, hub: string): boolean;
  // reportJson이 undefined면 보고서 없이 확인 목록만 본다. 기본값(sameSignatureTimes·retryBudget)은 호출하는 TS가 정해 넘긴다
  escalationSignatureSetKey(reportJson: string | undefined | null, checksJson: string): string;
  escalationShouldEscalate(history: string[], times: number): boolean;
  escalationShouldPromote(sameSignatureTimes: number | undefined | null, defaultTimes: number, afterFailures: number | undefined | null, history: string[]): boolean;
  escalationRetryBudgetFor(retryBudget: number | undefined | null, defaultBudget: number): number;
  escalationPrompt(summary: string, lastFeedback: string | undefined | null): string;
  // ── agent: commit-message·pr-review(3단계 3g). 지적·입력 객체는 encodeNative한 JSON 문자열, 결과 객체는 JSON 문자열. 어긋난 입력은 던진다
  // files·kinds는 PendingChange의 file·change를 같은 순서로 나눈 배열이다. maxChars·round는 아무 수나 받는다
  classifyCommit(request: string, files: string[], kinds: string[]): string;
  generateCommitSubject(request: string, files: string[], kinds: string[], agentSummary: string | undefined | null, requestIsAnswer: boolean): string;
  summarizeCommitText(text: string, maxChars: number): string;
  toCommitMood(text: string): string;
  prReviewFixMarker(): string;
  isBlockingSeverity(severity: string): boolean;
  hasBlockingFindings(severities: string[]): boolean;
  prReviewSeverityCounts(severities: string[]): number[];
  nextPrReviewStep(severities: string[], round: number, maxRounds: number): string;
  truncateDiff(diff: string, maxChars: number): string;
  diffFilePaths(diff: string): string[];
  extractDiffReferencedNames(diff: string): string[];
  buildPrReviewExternalContext(paths: string[], excerpts: string[], maxChars: number): string;
  buildPrReviewUserPrompt(inputJson: string): string;
  prReviewMarker(round: number): string;
  buildPrReviewComment(inputJson: string): string;
  buildPrReviewResolvedContext(resolvedJson: string): string;
  buildReviewResolutionComment(inputJson: string): string;
  buildPrReviewFixRequest(findingsJson: string): string;
  extractPrReviewFixTitles(request: string): string[] | null | undefined;
  // ── agent: next-routes·project-status·stuck-loading(3단계 3h). 객체는 JSON 문자열(encodeNative·decodeNative). maxPages는 NaN·Infinity도 그대로 받는다. 모양이 어긋난 입력은 던진다
  nextRoutesIsIdLikeSegment(name: string): boolean;
  nextRoutesFromChangedFiles(files: string[], servicePath: string, sampleParamsJson: string, maxPages: number, maxPagesCap: number, fallbackValue?: string | null): string;
  nextRoutesFromCandidates(candidatesJson: string, servicePath: string, sampleParamsJson: string, maxPages: number, maxPagesCap: number, fallbackValue?: string | null): string;
  projectStatusBuild(inputJson: string): string;
  stuckLoadingDetect(text: string, evidenceJson?: string | null): string | null | undefined;
  // ── agent: 서비스 소유 판정·CLI 실패 설명(3단계 3l). servicesForFiles는 서비스·파일을 입력 배열의 위치로 돌려준다(JSON `{services:number[],unmatched:number[]}`). 모양이 어긋난 입력은 던진다
  servicesForFiles(inputJson: string): string;
  ownsFile(path: string, includes: string[], file: string): boolean;
  isComposeFile(root: string, composePath: string, cwd: string, file: string): boolean;
  describeCliText(raw: string): string;
  cliFailureReason(summary: string, detail: string): string;
  // ── agent: requirements(3단계 3j). 객체는 JSON 문자열(encodeNative·decodeNative). 모양이 어긋난 입력은 던진다. 인덱스를 돌려주는 함수는 껍데기가 원래 객체를 골라 담는다
  reqCoreRequirementsFile(): string;
  reqCoreMergeThresholds(): number[];
  reqCoreWeakWordsKo(): string[];
  reqCoreWeakWordsEn(): string[];
  reqCoreFindMentionedIds(text: string): string[];
  reqCoreMentionsRequirementId(text: string, id: string): boolean;
  reqCoreImplementsTrailers(text: string): string;
  reqCoreCheckpointMentionIndexes(messages: string[], id: string): number[];
  reqCoreGateCheckMentionIndexes(names: string[], id: string): number[];
  reqCoreIsLikelyTestFile(path: string): boolean;
  reqCoreAlignedScenarioIds(requirementId: string, scenarioIds: string[]): string[] | null | undefined;
  reqCoreRequirementHash(requirementJson: string): string;
  reqCoreContentDrifted(requirementJson: string): boolean;
  reqCoreRevise(requirementJson: string, now: string): string | null | undefined;
  reqCoreCarryForward(nextJson: string, previousJson: string): string;
  reqCoreDiscardRevision(requirementJson: string): string;
  reqCoreStatus(evidenceJson: string, requirementJson?: string | null): string;
  reqCoreVerificationSource(evidenceJson: string, requirementJson?: string | null): string;
  reqCoreVerificationBadge(status: string, evidenceJson: string, requirementJson?: string | null): string;
  reqCoreConfidence(status: string): string;
  reqCoreSummarizeCoverage(requirementsJson: string, statusJson: string): string;
  reqCoreLintRequirement(requirementJson: string): string;
  reqCoreRequirementIsReady(requirementJson: string): boolean;
  reqCoreReadyBadge(requirementsJson: string): boolean;
  reqCoreIsManualStepText(text: string): boolean;
  reqCorePartitionManualSteps(requirementsJson: string, manualSteps: string[]): string;
  reqCoreExtractHeuristically(specText: string): string;
  reqCoreExtractPathReferences(specText: string): string[];
  reqCoreMissingReferenceQuestion(path: string): string;
  reqCoreReferencedFilesContext(filesJson: string, maxChars: number): string;
  reqCoreVerifySpecQuote(specQuote: string, specText: string): boolean;
  reqCoreExtractionUserPrompt(specText: string, referencedFilesContext?: string | null): string;
  reqCoreRecommendationUserPrompt(questions: string[], specText: string, stackSummary?: string | null): string;
  reqCoreExtractionRetryNote(reason: string): string;
  reqCoreSummarizeRequirementsForGuide(requirementsJson: string, maxChars: number): string;
  reqCoreSummarizeManualStepsForGuide(manualSteps: string[], maxChars: number): string;
  reqCoreWorkPrefill(requirementJson: string): string;
  reqCoreAllMustPrefill(requirementsJson: string): string;
  reqCoreTextSimilarity(a: string, b: string): number;
  reqCoreApiSignature(title: string): string | null | undefined;
  reqCoreRequirementSimilarity(aJson: string, bJson: string): number;
  reqCoreMerge(incomingJson: string, existingJson: string, now: string): string;
  reqCoreUnexecutedTests(requirementId: string, rowsJson: string): string;
  reqCoreMatrixCsv(matrixJson: string): string;
  docLintText(text: string): string;
  // ── agent: "문서" 탭(3단계 3k). 색인 요약 목록은 JSON 문자열(encodeNative), 모양이 어긋나면 던진다. 기록 종류는 껍데기가 고정된 글자만 넘긴다(알 수 없으면 던진다)
  docsSlugifyTitle(title: string): string;
  docsNextDesignDocNumber(existing: string[]): number;
  docsNextAdrNumber(existing: string[]): number;
  docsDesignDocFilePath(number: number, title: string): string;
  docsAdrFilePath(number: number, title: string): string;
  docsBuildDesignDocTemplate(number: number, title: string): string;
  docsBuildAdrTemplate(number: number, title: string, date: string, related: string[]): string;
  docsBuildEntry(kind: string, title: string, fields: string[]): string;
  docsAppendEntry(kind: string, existing: string | null | undefined, entry: string): string;
  docsBuildRoadmapTemplate(): string;
  docsRegenerateRoadmapStatus(
    existing: string | null | undefined,
    statuses: string[],
    counts: number[],
    mustTotal: number,
    mustDone: number,
    shouldTotal: number,
    shouldDone: number,
  ): string;
  docsExtractDocSummary(markdown: string): string;
  docsBuildDocSummary(path: string, markdown: string): string;
  docsRegenerateDocsReadme(existing: string | null | undefined, docsJson: string): string;
  // ── agent: 계획 요약·레인 계약(3단계 3m). project는 { name, managed: [[이름, { template, path }]] }, lanes는 [{ id, paths, tasks: [{ id, title, request }] }]를 encodeNative한 JSON 문자열.
  // short·long·maxChars·maxContracts는 TS가 가진 상수를 그대로 넘긴다. 모양이 어긋난 입력은 던진다
  shouldPlanBrief(request: string): boolean;
  planWordLimit(request: string, short: number, long: number): number;
  buildPlanBriefSystem(projectJson: string, request: string, short: number, long: number): string;
  appendPlanToRequest(request: string, plan: string, maxChars: number): string;
  buildContractSystem(projectJson: string, maxContracts: number): string;
  buildContractUser(request: string, lanesJson: string): string;
  // ── agent: 설계 파이프라인(3단계 3o). 묶음 목록·결과는 JSON 문자열(decodeNative). 승인 확인은 막는 기록의 순번을 돌려주고(껍데기가 원래 객체를 골라 담는다), 모양이 어긋난 기록은 던진다
  designPipelineNextDocNumber(existing: string[]): number;
  designPipelineDocPath(number: number, title: string): string;
  designPipelineSidecarPath(docPath: string): string;
  designPipelineIsDocPath(file: string): boolean;
  designPipelineParseBundlesTable(markdown: string): string;
  designPipelineBuildRequestPrompt(title: string, requirementIds: string[], detail?: string | null): string;
  designPipelineBuildDocTemplate(number: number, title: string, requirementIds: string[]): string;
  designPipelineCheckApproval(requirementIds: string[], docsJson: string): number[];
  designPipelineReviewIndependence(implementer: string, reviewer: string): string;
  designPipelineDeriveResult(
    designStatus: string,
    checkpointExists: boolean,
    hasReview: boolean,
    reviewRan: boolean,
    reviewPassed: boolean,
    independence: string,
    hasVerification: boolean,
    verificationRan: boolean,
    verificationOk: boolean,
    testsRerun: boolean,
  ): string;
  // ── agent: 탐색 QA의 판정·변환·프롬프트(3단계 3p). 구조가 있는 입력은 encodeNative한 JSON 문자열이고 모양이 어긋나면 던진다.
  // judge 입력: { confirmText?, confirmKey?(확인 문구를 encodeLoneSurrogates한 글자), consoleErrors, pageErrors, failedRequests, accessibilityViolations(건수), horizontalOverflowPx, review?: { findings: [{ severity, summary }], declared?, stoppedBy, expectedRejections?, unmetRejections? } }.
  // toPageCheckSteps 입력: [{ index, tool, ok, stableSelector?, text?, key?, forText? }], 결과는 decodeNative로 읽는다
  exploreQaDiagnosticsCount(consoleErrors: number, pageErrors: number, failedRequests: number, accessibilityViolations: number, horizontalOverflowPx: number): number;
  exploreQaMatchScore(name: string, text: string, role: string, testId: string | undefined, tag: string, needle: string): number;
  exploreQaDescribeScrollPosition(y: number, max: number, atBottom: boolean, atTop: boolean): string;
  exploreQaFormatElement(elementJson: string): string;
  exploreQaFormatSnapshot(resultJson: string, maxElements: number): string;
  exploreQaNormalizeRef(value: string): string | null | undefined;
  exploreQaIsInspectionGoal(goalText: string): boolean;
  exploreQaBuildSystemPrompt(goalText: string | undefined): string;
  exploreQaBuildUserPrompt(goalJson: string): string;
  exploreQaBuildWrapUpPrompt(reason: string): string;
  // pageText도 encodeLoneSurrogates한 글자를 보낸다(짝 없는 서로게이트가 경계에서 U+FFFD가 되어 다른 글자가 같아지는 것을 막는다)
  exploreQaJudge(inputJson: string, pageText: string): string;
  exploreQaToPageCheckSteps(actionsJson: string): string;
  // ── agent: repository(3단계 3n). 객체는 JSON 문자열. repoParseRemote는 스킴 꼴이면 new URL의 조각을 모두 받고(없으면 scp·로컬 경로), 모양이 어긋난 repoBuildPullRequest 입력은 던진다
  repoRemoteNeedsUrl(trimmed: string): boolean;
  repoParseRemote(url: string, protocol: string | null | undefined, host: string | null | undefined, hostname: string | null | undefined, pathname: string | null | undefined, provider: string | null | undefined): string;
  repoCompareUrl(kind: string, webUrl: string | null | undefined, base: string, branch: string): string | null | undefined;
  repoCanCreatePullRequest(kind: string, token: string | null | undefined, envToken: string | null | undefined): boolean;
  repoParsePullRequestNumber(url: string): number | null | undefined;
  repoParseTaskList(body: string | null | undefined): string;
  repoParseClosingReferences(text: string | null | undefined): number[];
  repoMapReviewState(raw: string): string;
  repoCapPatch(patch: string | null | undefined, runningTotal: number): string;
  repoCombineCheckStatus(completed: boolean[], conclusions: Array<string | null>): string;
  repoMergeManagedPullRequestBody(existingBody: string | null | undefined, managedBody: string): string;
  repoManagedBodySqueezedOut(body: string, managedBody: string): boolean;
  repoCapBody(body: string): string;
  repoBuildPullRequest(inputJson: string): string;
  // ── agent: 경로 이름·도구 정책(3단계 3q). 막는 검사다. backslashSep은 `path.sep === '\\'`(껍데기가 넘긴다). 꼴을 맞출 수 없으면 null.
  // checkToolPolicy: file은 입력의 path(문자열이 아니면 빈 글자), scopeFile은 그 path를 encodeLoneSurrogates한 글자(쓰기 범위 비교용, writablePaths도 같은 인코딩), command는 입력의 command(문자열 배열이 아니면 빈 배열), policyJson은 정책 필드 다섯 개의 JSON 또는 'null',
  // defaultDenied는 TS가 정한 기본 금지 명령. 결과는 `{"decision","reason"?}` JSON. 정책의 모양이 어긋나면 던진다(부르는 쪽이 거절로 처리한다)
  normalizeProjectPath(file: string, lenient: boolean, backslashSep: boolean): string | null;
  foldName(segment: string): string;
  canonicalProjectPath(file: string, lenient: boolean, backslashSep: boolean): string | null;
  isProtectedPath(file: string, candidate: string, backslashSep: boolean): boolean;
  isWithinScope(file: string, scope: string, backslashSep: boolean): boolean;
  isToolAllowed(tool: string, allowedTools: string[]): boolean;
  hasApprovalToken(token: string | null | undefined): boolean;
  checkToolPolicy(
    tool: string,
    file: string,
    scopeFile: string,
    command: string[],
    policyJson: string,
    approvalToken: string | null | undefined,
    defaultDenied: string[],
    backslashSep: boolean,
  ): string;
  // ── agent: checkpoint git 출력 판정(3단계 3s). git 출력은 문자열 그대로 보낸다. 기대 쪽 경로·값과 비교할 이메일은 encodeLoneSurrogates한 글자를 보내고
  // (짝 없는 서로게이트가 경계에서 U+FFFD로 합쳐져 다른 경로가 같아지는 것을 막는다), 결과의 경로는 같은 인코딩이라 TS가 되돌린다. 형식을 읽지 못한 설정은 null
  checkpointSplitNul(output: string): string[];
  checkpointDangerousLocalConfig(output: string, separateGitDir: boolean): string[] | null | undefined;
  checkpointInfoAttributes(text: string): string[];
  checkpointStagedMismatch(lsFiles: string, stagedNames: string, subdir: string, expectedKeys: string[], expectedValues: string[]): string[];
  checkpointPendingFiles(output: string, subdir: string): string[];
  checkpointPendingChanges(output: string, subdir: string): string[][];
  checkpointCommitStat(output: string): number[];
  checkpointRemoteCommits(output: string): string[][];
  checkpointAuthorIsOurs(gitEmail: string, ourEmail: string): boolean;
  checkpointSessionRecords(output: string, ourEmail: string): string;
  checkpointShowRecord(output: string, ourEmail: string): string;
  checkpointCommitMessage(subject: string, body: string | null | undefined, trailers: string[]): string;
  checkpointStripSpace(text: string): string;
  checkpointOneLine(message: string): string;
  checkpointCapText(text: string, max: number): string;
  checkpointSubcommand(args: string[]): string | null | undefined;
  checkpointRedactCredentials(text: string): string;
  checkpointIsIndexLockFailure(stderr: string): boolean;
  checkpointWithObjectParticle(word: string): string;
  checkpointIsDotGit(name: string): boolean;
  checkpointIsSha(text: string): boolean;
  checkpointIsBackupId(text: string): boolean;
  checkpointPullRequestTarget(listed: string, baseRef: string, infoBase: string): string;
  checkpointGitEnvKeep(keys: string[]): boolean[];
  // ── agent: 연결·인증·조율 판정(3단계 3t). 호스트·토큰·출처·허용 목록은 견주는 두 글자 모두 encodeLoneSurrogates해서 보낸다(짝 없는 서로게이트가 경계에서 U+FFFD가 되어 서로 다른 값이 같아지면 인증·허용이 열린다).
  // 구조가 있는 입력은 encodeNative한 JSON 문자열. connAuthorize는 통과하면 null, 막으면 `{status,message}` JSON
  connAuthorize(host: string | undefined | null, authorization: string | undefined | null, token: string, allowedHosts: string[]): string | null | undefined;
  connHostAllowed(host: string | undefined | null, allowedHosts: string[]): boolean;
  connHostnameOf(host: string | undefined | null): string;
  connTokenMatches(authorization: string | undefined | null, token: string): boolean;
  connIsAllowedRequest(protocol: string, origin: string, allowedOrigins: string[]): boolean;
  connIsAutomaticFaviconPath(pathname: string): boolean;
  connDescribeStep(click: string | undefined | null, fillSelector: string | undefined | null, press: string | undefined | null, waitFor: string | undefined | null): string;
  connRejectedChangeFeedback(rejected: string[]): string;
  coordBoardValidate(modelWrites: boolean, by: string, kind: string, body: string, refsLen: number, noteBytesLimit: number): string | null | undefined;
  // 입력 [{ priority, at, id, bytes }](읽을 수 있는 메모, 들어온 순서), 결과 { selected: [위치(정렬 순서)], truncated, bytes }
  coordBoardPickNotes(notesJson: string, readLimit: number, budget: number): string;
  coordMcpPostInputError(argsJson: string): string | null | undefined;
  coordMcpReadInputError(argsJson: string): string | null | undefined;
  coordFormatNote(kind: string, priority: number, lane: string, body: string, refs: string[]): string;
  // ── agent: 검증 통과 판정·도구 입력 검사(3단계 3u). 막는 검사이고 서비스 허용 목록·origin은 여는 쪽이라 비교하는 두 글자를 encodeLoneSurrogates로 바꿔 보낸다.
  // verifyFormatReport는 던지지 않는다(읽을 수 없는 보고서는 "검증 실패" 글). toolInputError는 맞으면 null, 아니면 던질 글이고 valueJson은 encodeNative한 값(없으면 undefined)
  verifyOk(restartedReady: boolean[], contractErrored: boolean[], changeBreaking: boolean[], allowBreaking: boolean, secretLeaks: number, specError: boolean): boolean;
  verifyPlatformFailure(syncError: string | null | undefined, syncPlatform: boolean, services: string[], ready: boolean[], platform: boolean[], errors: string[]): string | null | undefined;
  verifyMentionsDeletedFile(logTail: string[], deleted: string[]): boolean;
  verifyFormatReport(reportJson: string, allowBreaking: boolean, specFile: string): string;
  toolInputError(kind: string, key: string, valueJson: string | null | undefined): string | null | undefined;
  toolClamp(value: number, min: number, max: number): number;
  toolComposeServiceNames(compose: string[] | null | undefined, managed: string[]): string[];
  toolServiceAllowed(name: string, managed: string[]): boolean;
  toolServiceOrAddonAllowed(name: string, compose: string[] | null | undefined, managed: string[]): boolean;
  toolSummarizeApproval(name: string, inputJson: string | null | undefined): string;
  toolMismatchAddable(max: number, seenRequests: string[], seenChecks: string[], seenFollowed: string[], request: string, check: string, followed: string): boolean;
  toolHttpPathOk(path: string): boolean;
  toolSameOrigin(requestOrigin: string, serviceOrigin: string): boolean;
  // ── agent: 게이트의 순수 보조 판정(3단계 3r). 구조가 있는 입력은 encodeNative한 JSON 문자열이고 모양이 어긋나면 던진다(gateViewportProblemText·gateViewportProblems는 옛 타입 밖의 문제 종류도 던진다).
  // 통과로 이어지는 같음·포함 두 자리는 견줄 두 글자를 encodeLoneSurrogates해서 보낸다: gateContainsApiText(text, value), gateViewportProblems의 expected·findings의 key.
  // sampleParams·inRunKeys 같은 사용자 키 맵은 [[키, 값], ...] 쌍으로 보낸다(encodeNative가 NUL로 시작하는 키를 던지지 않게)
  gateNextErrorMarker(text: string, expectStatus: number): string | null | undefined;
  gateAutoPageCheck(configJson: string, routePath: string): string;
  gateContainsApiText(text: string, value: string): boolean;
  gateContainsApiNumber(text: string, value: number): boolean;
  gateMissingApiValue(service: string, jsonPath: string, valueText: string | null | undefined, valueNumber: number | null | undefined, pagePath: string): string;
  gateViewportProblemText(findingJson: string, width: number, height: number): string;
  gateViewportProblems(inputJson: string): string[];
  gateMissingAllText(values: string[]): string;
  gateMissingAnyText(values: string[]): string;
  gateDynamicProbeDataHint(probedId: string): string;
  gateDynamicSegments(pageFile: string): number[];
  gateAcceptedNotes(specFile: string, inRunKeys: string[], sampleParams: string[][], inRunSampleIdFrom: boolean, fromService: string | null | undefined, fromPath: string | null | undefined): string[];
  gateUsesInRunValue(pageFile: string, inRunKeys: string[], inRunSampleIdFrom: boolean, usedFallbackCount: number): boolean;
  gateSampledValues(pageFile: string, sampleParams: string[][]): string | null | undefined;
  gateStripHtml(html: string): string;
  gateFormatFailedChecks(checksJson: string): string;
  gateCompareDetail(ratio: number, max: number, width: number, height: number): string;
  gateDescribeConcurrencyExpect(expectJson: string): string;
  /** `readJsonPath`(ADR-195 4f A5b-2). 세 인자는 `encodeLoneSurrogates`한 글자(`equalsJson`은 JSON). `{ shown, equal }` 또는 `{ tooDeep: true }`의 JSON */
  gateReadJsonPath(text: string, jsonPath: string, equalsJson: string): string;
  // ── agent: 작업 공간의 막는 검사(3단계 3w). workspaceIsDenied·workspaceIsSecretFile은 거부 목록이라 짝 없는 서로게이트가 U+FFFD로 합쳐져도 더 막을 뿐이다.
  // workspaceIsInside는 path.relative(root, target)의 결과를 encodeLoneSurrogates한 글자로 받는 허용 목록(통과가 곧 안쪽).
  // workspaceInputProblem은 0 없음·1 절대 경로·2 쓸 수 없는 글자(NUL, POSIX의 역슬래시). external이면 2를 보지 않는다
  workspaceIsDenied(segment: string): boolean;
  workspaceIsSecretFile(file: string): boolean;
  workspaceIsInside(relative: string, backslashSep: boolean): boolean;
  workspaceInputProblem(file: string, backslashSep: boolean, external: boolean): number;

  // ── agent: 워크플로 판정(3단계 3v). 트레일러 값은 ASCII 상수와만 견주므로 그대로 보낸다. 통과로 이어지는 같음 비교(배포 막음·빠진 검증 단계·시험이 다루는 서비스·선언한 화면 경로)는
  // encodeLoneSurrogates한 글자를 보내고 위치로 돌려받는다. 보호 경로는 원래 글자를 보낸다(거부 목록은 U+FFFD 꼴로 견준다)
  workflowFormatPassedTrailer(stages: string[]): string;
  workflowFormatVerifyTrailer(mode: string): string;
  workflowFormatIncompleteTrailer(reason: string): string;
  workflowParsePassedTrailer(values: string[]): string[] | null | undefined;
  workflowParseVerifyTrailer(values: string[]): string | null | undefined;
  workflowParseIncompleteTrailer(values: string[]): string | null | undefined;
  workflowIsDocCheckpointPath(file: string): boolean;
  workflowHasEmptyPassedTrailer(trailers: string[]): boolean;
  workflowHasDocsVerifyTrailer(trailers: string[]): boolean;
  workflowStages(required: string[] | undefined, pageChecks: number, tests: number, concurrencyChecks: number, loadChecks: number): string[];
  workflowReleaseRequirements(releaseRequires: string[] | undefined): string[];
  /** 요구 목록에서 빠진 단계의 위치. -1은 checkpoint(게이트를 거치지 않은 직접 수정 체크포인트) */
  workflowReleaseBlockers(requires: string[] | undefined, declared: boolean, passed: string[] | undefined, verify: string | undefined): number[];
  workflowMissingVerificationStages(stages: string[], passed: string[]): number[];
  workflowProtectedPaths(protectedPaths: string[] | undefined, evaluationAssets: string[] | undefined): string[];
  workflowMaxTurns(json: string): string;
  workflowReviewChanges(json: string): string;
  workflowUncoveredChangeWarnings(json: string): string;
  workflowFormatCheckedCoverage(json: string, declaredCheckName: string): string;
  // ── agent: 작업 계획·요구사항 검증 기록 무결성(3단계 3x). 막는 판정이다. 글자는 모두 encodeLoneSurrogates해서 보내고 결과의 글자는 decodeLoneSurrogates로 푼다(짝 없는 서로게이트가 경계에서 U+FFFD로 합쳐져 다른 글자가 같아지는 것을 막는다).
  // taskPlanLanes의 tasksJson은 [{ id, dependsOn, backend?, model?, paths }](zod가 읽은 값), 결과는 { error } | { lanes: [{ id, tasks: 입력 순번 목록, paths }] }. 모양이 어긋나면 던진다.
  // req*: before·after는 문서 글자(없으면 null), *Effective는 그 문서에서 사람 확인이 있는 요구사항 id(읽은 순서), afterIds는 지금 문서의 모든 요구사항 id(둘 다 TS가 parseRequirementsMarkdown으로 읽는다).
  // reqIntegrityRestore는 { unchanged: true } | { needsIds: 글 }(그 글의 요구사항 id를 textIds로 주고 다시 부른다) | { text }
  taskPlanLimits(maxLanes: string | null | undefined, maxTasks: string | null | undefined): string;
  taskPlanLanes(tasksJson: string, maxTasks: number, maxLanes: number, backslashSep: boolean): string;
  taskPlanIsInScope(file: string, paths: string[], backslashSep: boolean): boolean;
  reqIntegrityDiff(before: string | null | undefined, after: string | null | undefined, beforeEffective: string[], afterEffective: string[], afterIds: string[]): string;
  reqIntegrityHasTamper(diffJson: string): boolean;
  reqIntegrityDescribeTamper(diffJson: string): string[];
  reqIntegrityDescribeRemoved(diffJson: string): string[];
  reqIntegrityTamperedIds(diffJson: string): string[];
  reqIntegrityRestore(
    before: string | null | undefined,
    after: string,
    beforeEffective: string[],
    afterEffective: string[],
    afterIds: string[],
    textIds: string[] | null | undefined,
  ): string;
  reqIntegrityReview(before: string | null | undefined, after: string | null | undefined, beforeEffective: string[], afterEffective: string[], afterIds: string[]): string;
  // ── agent: 요구사항 추적표와 시험 파일 훑기(3단계 3z). 추적표는 검증 상태를 올리는 여는 쪽이라 모양이 어긋난 입력은 던진다.
  // 시험 이름·파일 경로는 껍데기가 encodeLoneSurrogates해서 보내고 결과에서 되돌린다(짝 없는 서로게이트가 U+FFFD로 합쳐져 서로 다른 시험이 같아지지 않게).
  // reqTraceFileIndex는 시험 파일 하나에서 뽑은 색인(JSON), 시험 파일이 아니면 null. 훑기는 색인 배열(JSON, 시험 파일이 아닌 자리는 null)을 받아 [[파일 자리, 이름]]을 돌려준다
  reqTraceFileIndex(path: string, content: string): string | null | undefined;
  reqTraceScanRequirement(indexesJson: string, id: string): string;
  reqTraceScanScenario(indexesJson: string, scenarioId: string): string;
  reqTraceScanOrphans(indexesJson: string): string;
  reqTraceScenarioEvidence(paramsJson: string): string;
  reqTraceUnverifiedScenarioIds(paramsJson: string): string;
  reqTraceMatrix(inputJson: string): string;
  // ── agent: 고정 경로와 겹치는지(3단계 3aa). 막는 판정이고(겹침·모름은 값을 받지 않는다) 이름 견주기는 거부 목록이라 글자는 파일 시스템 꼴(toWellFormed)로 보낸다.
  // 폴더 읽기는 껍데기가 한다: input은 { servicePath, pageFile, values(자기 속성만), check, maxFolders } JSON, known은 지금까지 읽은 { lstat: { 경로: 'missing'|'error'|'link'|'dir'|'other' }, readdir: { 폴더: null | [[이름, 'l'|'d'|'f']] } } JSON(경로는 프로젝트 루트 기준 상대 경로).
  // 결과: { need: { kind: 'lstat'|'readdir', path } }(읽고 known에 더해 다시 부른다) | { shadows: [{ name, where }] } | { unknown: 메시지 }. 모양이 어긋난 입력은 던진다
  staticShadowStep(inputJson: string, knownJson: string): string;
  // ── agent: 로컬 CLI 러너의 실행 파일 고르기·판정·사용량(3단계 3ac). cliResolveCommand는 막는 쪽이다: PATH·프로젝트 루트의 파일 상태를 Rust가 읽고 `{ path }`(그 글자를 그대로 spawn에 쓴다)나 `{ reason }`을 돌려준다(JSON).
  // 경로·PATH는 글자 그대로 보낸다: 짝 없는 서로게이트는 Node가 fs·spawn에 줄 때도 같은 UTF-8(U+FFFD)이 되므로 확인한 경로와 띄우는 경로의 바이트가 같다.
  // 판정 입력은 encodeNative한 JSON이다. runnerDescribeResultFailure는 `{subtype,is_error,result,stop_reason,errors}`, runnerMcpSetupFailure는 `{mcp_servers,mcp_server_errors}`. 실패가 아니면(연결됐으면) null.
  cliResolveCommand(command: string, pathValue: string | undefined | null, forbiddenRoot: string | undefined | null): string;
  cliChildPath(value: string, forbiddenRoot: string | undefined | null): string;
  // `{ window: number | null, ignored?: string }`
  runnerResolveCompactWindow(raw: string | undefined | null): string;
  runnerIsTransientNetworkFailure(message: string): boolean;
  runnerDescribeResultFailure(messageJson: string): string | null | undefined;
  runnerMcpSetupFailure(messageJson: string, server: string): string | null | undefined;
  runnerNoResultMessage(hasExit: boolean, errorMessage: string | undefined | null, signal: string | undefined | null, code: number | undefined | null, stderr: string): string;
  // 입력은 result의 modelUsage(없으면 'null'). `{ total, byModel }` JSON. null 항목이 있으면 던진다(옛 TS도 던졌다)
  runnerUsageOf(modelUsageJson: string): string;
  runnerMergeUsageByModel(baseJson: string, queryJson: string): string;
  runnerAddUsage(targetJson: string, sourceJson: string): string;
  runnerApiDurationOf(valueJson: string): number | null | undefined;
  // ── agent: 요구사항 문서 읽기·쓰기(3단계 3ab). 글자는 모두 encodeLoneSurrogates한 것이고 결과도 같은 인코딩이다(decodeLoneSurrogates로 푼다). 객체는 encodeNative한 JSON, 결과는 decodeNative로 읽는다.
  // reqMdParseBody는 던지지 않고 `{drafts, jsonBlock, assumptions, manualSteps}`를 돌려준다(zod 검증 앞의 초안과 첫 JSON 블록의 글자). reqMdMerge(몸통 요구사항, 블록 요구사항)는 합친 목록,
  // reqMdSerialize `{requirements, statusById, assumptions, manualSteps}`는 마크다운(모양이 어긋나면 던진다)
  reqMdParseBody(raw: string): string;
  reqMdMerge(requirementsJson: string, storedJson: string): string;
  reqMdSerialize(inputJson: string): string;
  // ── agent: 작은 판정 모음(3단계 3af). 이름·글은 껍데기가 encodeLoneSurrogates해서 보내고 결과 글에서 decodeLoneSurrogates로 되돌린다.
  // 덤프 정규화기는 바이트 조각을 먹이면 해시에 넣을 바이트를 낸다(바뀌지 않음을 정하는 판정이라 줄 끝 글자·잘못된 바이트도 해시에 넣는다).
  // agentTempDumpPids는 지우는 코드가 쓴다: 우리가 쓰는 이름 꼴이 아니거나 pid가 양의 i32 정수가 아니면 null(지우지 않는다).
  // agentTaskGraphError는 [{ id, dependsOn }]를 받아 실행할 수 없는 꼴이면 메시지(없으면 null), 모양이 어긋난 입력은 던진다.
  // agentSummarizeJsonContent는 JSON이 아니거나 너무 깊으면 null(호출하는 쪽이 첫 줄 미리보기로 대신한다)
  agentRestoreDatabaseName(encodedName: string): string;
  agentTempDumpPids(names: string[]): Array<number | null>;
  agentTaskGraphError(nodesJson: string): string | null;
  agentFormatSteering(texts: string[]): string;
  agentAppendUserPlan(role: string | null | undefined, contentKind: string): 'concat' | 'push' | 'new';
  agentSummarizeJsonContent(content: string): string | null;
  // ── agent: 요구사항 모델 답 읽기(3단계 3ad). 글자는 encodeLoneSurrogates해서 보내고 결과 글자는 decodeLoneSurrogates로 푼다.
  // reqReplyExtractJson은 [JSON.parse에 건넬 글자, jsonrepair에 건넬 글자]이고 `{`가 없으면 빈 배열. reqReplyRepairExtraction은 글자를 인코딩한 값의 encodeNative JSON이고 시나리오 id 번호를 매길 수 없으면 던진다.
  // reqReplyEnforceSpecQuote는 강등할 추천의 자리(basis가 'spec'인데 인용이 없거나 명세에서 확인되지 않음). 인용과 명세는 둘 다 encodeLoneSurrogates해서 보낸다
  reqReplyExtractJson(text: string): string[];
  reqReplyRepairExtraction(rawJson: string): string;
  reqReplyEnforceSpecQuote(bases: string[], quotes: Array<string | null>, specText: string): number[];
  reqReplyFirstLinesPreview(content: string, maxLines: number, maxChars: number): string;
  reqReplyIsJsonPath(path: string): boolean;
  reqReplyTooBigBytes(message: string): number | null | undefined;
  reqReplyAddUsage(a: number[], b: number[]): number[];
  // ── agent: 디자인 비교(3단계 3ae). 게이트는 비율이 허용치를 넘으면 실패시키므로 비율이 작아지는 쪽이 여는 쪽이고, 끝까지 가지 못한 입력(읽지 못한 PNG·너비 불일치·너무 큼·픽셀 0·범위 밖 threshold)은 모두 errorKind로 돌려준다.
  // masks는 [x, y, width, height, ...]를 이어 붙인 숫자(소수·음수·NaN 그대로: 옛 JS 반복문과 같게 칠한다). errorKind는 'compare'(옛 VisualCompareError)·'decode'(PNG를 읽지 못함)
  visualCompare(actual: Buffer, reference: Buffer, masks: number[], threshold: number): NativeVisualCompare;
  // ── agent: 작업 공간의 파일 시스템 I/O(ADR-195 4f A3). 경로의 어느 조각도 링크를 따라가지 않고 연 서술자로 읽고 쓰고 지운다(bstudio-io::workspace_io).
  // 비동기 함수의 실패는 거절된 Error의 message로 온다: LINK·OUTSIDE·DENIED·MISSING·NOT_REGULAR·TOO_LARGE:<크기>·OS:<오류 이름>·OTHER:<글>. 숨긴 이름은 여기서도 다시 막는다
  workspaceReadRegularFile(absolute: string, maxBytes: number): NativeWorkspaceFileRead;
  workspaceReadProjectFile(root: string, relative: string, maxBytes: number): NativeWorkspaceFileRead;
  workspaceResolve(root: string, relative: string, mustExist: boolean): Promise<string>;
  workspaceReadDir(root: string, relative: string): Promise<Array<{ name: string; kind: 'file' | 'dir' | 'link' | 'other' }>>;
  workspaceLstat(root: string, relative: string): Promise<{ kind: 'file' | 'dir' | 'link' | 'other'; size: number }>;
  workspaceReadFile(root: string, relative: string, maxBytes?: number | null): Promise<Buffer>;
  workspaceWriteFile(root: string, relative: string, data: Buffer, makeDirs: boolean): Promise<void>;
  workspaceRemoveFile(root: string, relative: string): Promise<void>;
  workspaceFingerprints(root: string, files: string[]): Promise<string[]>;
  WorkspacePinStore: new () => NativeWorkspacePinStore;
}

export interface NativeWorkspaceFileRead {
  kind: 'missing' | 'bytes' | 'irregular';
  content?: Buffer | null;
  complete?: boolean | null;
  reason?: string | null;
}

export interface NativeWorkspacePinStore {
  contains(relative: string): boolean;
  pin(root: string, relative: string): void;
  pinUnpinned(relative: string, reason: string): void;
  restored(root: string, files: string[]): string[];
}

export interface NativeVisualCompare {
  errorKind?: 'compare' | 'decode' | null;
  message?: string | null;
  diffPixels: number;
  comparedPixels: number;
  width: number;
  height: number;
  diff?: Buffer | null;
}

/** 루프백 서버가 콜백에 넘기는 요청. `body`는 받은 그대로의 바이트다(해석하지 않는다) */
export interface NativeLoopbackRequest {
  route: number;
  body: Buffer;
}

export interface NativeLoopbackResponse {
  status: number;
  body: Buffer;
}

/** MCP 서버가 콜백에 넘기는 일. `list`는 도구 목록, `call`은 도구 실행(`name`은 도구 이름, `args`는 검사를 통과한 인자의 JSON) */
export interface NativeMcpCall {
  kind: 'list' | 'call';
  name: string;
  args: string;
}

export interface NativeMcpAnswer {
  specs?: string;
  error?: string;
  ok: boolean;
  content: string;
  images: Array<{ data: string; mimeType: string }>;
}

export interface NativeHostPty {
  /** 자식 pid. 플랫폼이 못 주면 null */
  readonly pid: number | null;
  write(data: Buffer): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export interface NativeExecEvent {
  data?: Buffer | null;
  exited: boolean;
  code?: number | null;
}

export interface NativeCliEvent {
  /** 표준 출력에서 나온 줄들(`exited`가 false일 때) */
  lines?: string[] | null;
  exited: boolean;
  /** 끝 상태. 신호로 죽었거나 띄우지 못했으면 null */
  code?: number | null;
  /** Node의 신호 이름(`SIGTERM` 등) */
  signal?: string | null;
  /** 띄우지 못했을 때만: Node의 오류 이름(`ENOENT`), 메시지(`spawn <파일> ENOENT`), errno(음수) */
  errorCode?: string | null;
  errorMessage?: string | null;
  errno?: number | null;
}

export interface NativeToolLedger {
  /** 이제부터 오는 도구 호출은 거절한다. 기다리던 요청도 깨운다 */
  close(): void;
  /** 취소했다. `reason`은 거절 글로 쓴다 */
  abort(reason: string): void;
  isClosed(): boolean;
  /** 지금까지 도착한 도구 호출이 모두 끝나기를 기다린다 */
  idle(): Promise<void>;
  /** 시험용: assistant 메시지의 `content`(JSON 배열)에서 `tool_use`를 센다 */
  noteToolUses(contentJson: string): void;
}

/**
 * 세션의 이벤트 기록(crates/bstudio-session). 이벤트는 `JSON.stringify`한 글자로 넘기고(유한하지 않은 수는 `encodeNative`의 표시 객체) 돌려받는 글자는 `decodeNative`로 읽는다.
 * JSON이 아닌 글자를 넘기면 던진다
 */
export interface NativeSessionRecord {
  /** `emit`의 버퍼 처리. 돌려주는 값은 "`updatedAt`을 바꾸고 저장을 예약할 것인가" */
  push(eventJson: string): boolean;
  /** 상한 없이 history 끝에 덧붙인다 */
  append(eventJson: string): void;
  /** history를 통째로 바꾼다. 하나라도 JSON이 아니면 던지고 아무것도 바꾸지 않는다 */
  replaceHistory(eventsJson: string[]): void;
  /** 끝나지 못한 요청·되돌리기·원격 동기화·배포를 닫는 이벤트를 history 끝에 덧붙인다(상한 없이). 덧붙인 개수. 이벤트를 읽지 못하면 던지고 아무것도 덧붙이지 않는다 */
  closeUnfinished(reason: string): number;
  hasLogs(): boolean;
  /** history의 마지막 `run_started` 이벤트(글자 그대로). 없으면 null */
  lastRunStarted(): string | null | undefined;
  /** 끝 n개. JSON 배열 글자 하나(이벤트 글자를 쉼표로 이은 것) */
  tail(n: number): string;
  history(): string;
  logs(): string;
  trimmedHistory(): string;
}

/** `Persister`가 쓰기를 시작할 때 TS가 건네는 상태. Rust가 `head`와 `tail` 사이에 기록의 저장용 history를 끼워 옛 `JSON.stringify(toPersisted(session))`와 같은 글자를 쓴다 */
export interface NativePersistState {
  file: string;
  /** `JSON.stringify({ version, savedAt, owner, snapshot })` */
  head: string;
  /** `JSON.stringify({ conversation, demoIndex, … git })`(옛 `toPersisted`의 `history` 뒤 키들) */
  tail: string;
  /** 상태를 만들지 못한 이유. 있으면 쓰지 않고 이유를 알린다(콜백이 던져도 같지만 Node가 경고한다) */
  error?: string;
}

export interface NativePersister {
  /** 저장을 예약한다(500ms 모으기). 이미 예약돼 있으면 아무것도 하지 않는다 */
  schedule(): void;
  /** 예약을 지운다(쓰지 않는다) */
  cancel(): void;
  /** 예약을 지우고 쓰기를 줄에 잇는다. 약속은 이번 쓰기가 끝날 때 풀리고 실패하면 이유를 담는다(던지지 않는다) */
  flush(): Promise<string | null | undefined>;
  /** 지금까지 줄에 선 쓰기가 모두 끝나면 풀린다 */
  idle(): Promise<void>;
  /** 종료 신호 처리용: 이 스레드에서 동기로 쓴다. 던질 수 있다 */
  flushSync(file: string, head: string, tail: string): void;
}

/** 세션 지우기·이어받기 판정의 거절 이유. `status`는 HTTP 상태 */
export interface NativeLifecycleFail {
  status: number;
  message: string;
}

export interface NativeDeleteCheckInput {
  status: string;
  workspace?: string | null;
  root: string;
  home: string;
  sessionId: string;
  workDir: string;
  stateDir?: string | null;
}

export interface NativeRecoverPlan {
  /** 같은 세션 폴더를 쓰는 다른 스튜디오 프로세스가 실행 중이라 건드리지 않는다 */
  skip: boolean;
  /** 서버가 멈춰 끝나지 못한 세션 */
  interrupted: boolean;
  /** 세션 터미널 찌꺼기를 치운다 */
  cleanupTerminal: boolean;
  /** 저장한 샌드박스 id가 b-studio가 만든 id의 꼴이다 */
  sandboxIdOk: boolean;
}

/** `readSessions`의 한 세션: `history`를 뺀 나머지 JSON 글자와 파일의 history를 올린 기록 */
export interface NativeStoredSession {
  /** 이 세션을 읽어 온 폴더(`<root>/<항목 이름>`). 지우기·이어받기는 저장 파일의 경로 글자가 아니라 이 값으로 폴더를 정한다(ADR-204) */
  home: string;
  rest: string;
  record: NativeSessionRecord;
  /** history를 기록에 올리지 못한 이유. 있으면 기록은 비어 있고 그 세션은 건너뛰어야 한다 */
  historyError?: string | null;
}

export interface NativeCreateStep {
  name: string;
  /** 이 단계를 끝낸 뒤 만들기가 실패하면 부르는 치우기 콜백 이름 */
  undo?: string | null;
  /** 이 단계 자신이 실패해도 치우기를 부른다 */
  undoIfFailed: boolean;
}

export interface NativeCreateRunInput {
  root: string;
  home: string;
  sessionId: string;
  /** 내 폴더 세션의 사용자 폴더(없으면 작업 복사본 세션) */
  userDir?: string;
}

export interface NativeCreateResult {
  ok: boolean;
  /** 실패한 단계 이름 */
  step?: string | null;
  message?: string | null;
  /** 치우다 실패한 것(원래 오류가 아니다) */
  undoErrors: Array<{ name: string; message: string }>;
}

export interface NativeStopStep {
  name: string;
  /** 실패해도 다음 단계로 간다 */
  swallow: boolean;
}

export interface NativeStatusChange {
  /** 거짓이면 늦은 결과라 바뀌지 않았다(`status`·`error`는 지금 값) */
  applied: boolean;
  status: string;
  error?: string | null;
}

export interface NativeBootRequest {
  /** `ready`(이미 켜짐) · `stopped`(중지됨 또는 멈추는 중) · `wait`(켜는 중) · `start`(켜기를 시작한다) */
  action: 'ready' | 'stopped' | 'wait' | 'start';
  /** `start`일 때 이 켜기의 세대 */
  generation: number;
  /** 거짓이면 상태가 바뀌지 않았다(`start`인데 이미 `starting`이었다 포함) */
  changed: boolean;
  status: string;
  error?: string | null;
}

export interface NativeStopResult {
  ok: boolean;
  /** 던진 단계 */
  step?: string | null;
  message?: string | null;
}

/** 사람 한 명의 한 기간 토큰 사용량(`usageUserUsage`·`usageAdd`) */
export interface NativeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface NativeSessionState {
  readonly status: string;
  readonly error: string | null;
  readonly stopping: boolean;
  readonly generation: number;
  /** 켜기 `generation`이 지금도 이 세션의 켜기인가(멈추는 중이거나 세대가 지났거나 멈췄으면 거짓) */
  live(generation: number): boolean;
  requestBoot(): NativeBootRequest;
  bootFinished(generation: number, ok: boolean, error?: string | null): NativeStatusChange;
  /** `stopped`(이미 멈춤) · `joined`(다른 호출이 멈추는 중) · `started`(이 호출이 멈춘다) */
  beginStop(): 'stopped' | 'joined' | 'started';
  /** `started`를 받은 호출이 부른다. 단계마다 `hook(단계 이름)`이 불린다. hook은 성공하면 null, 실패하면 이유를 돌려준다(던지지 않는다) */
  stop(hook: (step: string) => Promise<string | null>): Promise<NativeStopResult>;
  /** `joined`를 받은 호출이 부른다 */
  joinStop(): Promise<NativeStopResult>;

  // ── 세션의 바쁨: 점유와 표(ADR-207). 표는 `token`(0이 아닌 수)이다 ──
  checkRun(): NativeLifecycleFail | null;
  beginRun(runId: string): NativeClaimResult;
  terminalBusy(): string | null;
  beginTerminalRun(runId: string): NativeClaimResult;
  setPhase(token: number, phase: 'running' | 'cancelling' | 'saving'): boolean;
  cancelRun(runId: string): NativeCancelResult;
  steerTarget(): NativeSteerTarget;
  openRun(): string | null;
  checkTask(kind: string): NativeLifecycleFail | null;
  beginTask(kind: string): NativeClaimResult;
  beginCatchUp(): number;
  release(token: number): boolean;
  holds(token: number): boolean;
  readonly busy: boolean;
  rejectBusy(op: string): NativeLifecycleFail | null;
  beginExport(): NativeClaimResult;
  /** 요청 하나를 끝까지 돈다. 단계마다 `hook`을 부르고 순서·끝 결정·점유 단계 바꾸기와 풀기는 코어가 한다(ADR-208) */
  runRequest(ask: boolean, token: number, hook: (call: NativeRunCall) => Promise<NativeRunReply>): Promise<void>;

  // ── 세션 터미널 실행의 닫기·열린 실행·CLI 종료·위반 갈 곳(ADR-210). 표는 `beginTerminalRun`이 준 `token`이다 ──
  /** 지금 열린 터미널 실행인가(점유가 이 표이고 단계가 `진행`이며 닫기를 시작하지 않았다) */
  terminalRunOpen(token: number): boolean;
  /** 닫기를 시작한 실행인가. 모르는 표도 닫힌 것이다 */
  terminalRunClosed(token: number): boolean;
  /** 닫기를 시작한다. 처음 부른 호출에만 할 일을 돌려준다(이미 닫았거나 모르는 표면 null). 이 순간부터 열린 실행이 아니다 */
  terminalCloseBegin(token: number, input: NativeTerminalCloseInput): NativeTerminalCloseDecision | null;
  /** `terminalCloseBegin`이 값을 준 호출이 곧바로 부른다. 단계마다 `hook`이 불리고 hook은 성공하면 null, 실패하면 이유를 돌려준다. 순서와 점유 풀기는 코어가 한다 */
  terminalCloseRun(token: number, hook: (call: NativeRunCall) => Promise<string | null>): Promise<void>;
  /** CLI가 끝났다: `nothing`·`defer`(검사 중이라 미룸)·`failed`·`cancelled`·`error` */
  terminalCliEnded(token: number, checking: boolean, hasFeedback: boolean): string;
  /** 턴이 API 오류로 끝났다(StopFailure): `nothing`·`defer`(검사 중이라 미룸)·`failed` */
  terminalTurnFailed(token: number, checking: boolean): string;
  /** 검사가 재시도로 끝났다: `feedback`·`close_failed` */
  terminalRetry(token: number): string;
  /** 감시가 위반을 찾았다: `ignore`·`close_open_run`·`defer` */
  terminalViolationRoute(token: number, alive: boolean): string;
  releaseExport(token: number): boolean;
  readonly exporting: boolean;
  deleteBusy(): NativeLifecycleFail | null;
  claimView(): NativeClaimView;
}

export interface NativeCancelResult {
  /** `started` 또는 `already`. 거절이면 빈 글 */
  outcome: string;
  fail?: NativeLifecycleFail | null;
}

export interface NativeSteerTarget {
  runId?: string | null;
  fail?: NativeLifecycleFail | null;
}

export interface NativeClaimView {
  kind?: string | null;
  runId?: string | null;
  phase?: string | null;
  terminal: boolean;
  exporting: boolean;
}

export interface NativeRunCall {
  step: string;
  arg: string;
}

/** 요청 실행의 콜백이 돌려주는 사실(ADR-208). 모든 칸이 있어야 한다 */
export interface NativeRunReply {
  ok: boolean;
  localEdits: boolean;
  result?: string | null;
  preflight: boolean;
  questionGatePassed: boolean;
  platformFailure: boolean;
  cancelRequested: boolean;
  cancelAborted: boolean;
  stopAborted: boolean;
  booted: boolean;
  local: boolean;
  pending: boolean;
  mismatch: boolean;
  reverted: boolean;
}

export interface NativeRunNormalFacts {
  ask: boolean;
  result: string;
  questionGatePassed: boolean;
  platformFailure: boolean;
  booted: boolean;
  status: string;
  local: boolean;
  stopped: boolean;
}

export interface NativeRunExceptionFacts {
  ask: boolean;
  cancelled: boolean;
  stopped: boolean;
  booted: boolean;
  status: string;
}

export interface NativeRunOutcome {
  action: string;
  status: string;
  summary: string;
}

/** 터미널 실행을 닫을 때의 입력(ADR-210). `kind`가 `settle`이면 `status`만 본다 */
export interface NativeTerminalCloseInput {
  kind: 'abandon' | 'settle';
  status: string;
  stopping: boolean;
  platformFailure: boolean;
  local: boolean;
  ready: boolean;
  booted: boolean;
  hasReason: boolean;
}

export interface NativeTerminalCloseDecision {
  action: string;
  status: string;
  text: string;
}

/** 요청 글의 분류(ADR-215) */
export interface NativeTerminalPromptClass {
  readOnly: boolean;
  slashCommand: boolean;
  unwrapped: string;
}

export interface NativeTerminalPromptFacts {
  openRun: boolean;
  runReadOnly: boolean;
  promptReadOnly: boolean;
  busy: boolean;
  slash: boolean;
  budget: boolean;
}

export interface NativeTerminalPromptDecision {
  /** `attach`·`block`·`nothing`·`open` */
  kind: string;
  markReadOnly: boolean;
  readOnly: boolean;
  /** `block`일 때 `busy`·`budget` */
  block: string;
}

export interface NativeTerminalPreToolFacts {
  readTool: boolean;
  budget: boolean;
  /** 도구가 속할 실행을 얻었다(거짓이면 바쁨) */
  gotRun: boolean;
  readOnly: boolean;
  /** `none`·`max_turns`·`budget`. 그 밖의 글은 거절한다 */
  limit: string;
  outOfScope: boolean;
  closed: boolean;
}

export interface NativeTerminalUsageFacts {
  hasRequestId: boolean;
  counted: boolean;
  attached: boolean;
  openRun: boolean;
  inOpenWindow: boolean;
  inEarlySlack: boolean;
  openedByTool: boolean;
  inClosedRun: boolean;
  inClosedLate: boolean;
}

export interface NativeTerminalUsageStep {
  count: boolean;
  /** `none`·`open`·`closed` */
  target: string;
  countTurn: boolean;
  checkLimits: boolean;
  /** 이 요청이 붙은 열린 실행에 사용량 소식이 왔다고 표시한다(ADR-216) */
  markSeen: boolean;
}

export interface NativeTerminalModelCall {
  at: number;
  /** `cli`·`observed`·`received`·`received_off_clock` */
  timeSource: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  tokensComplete: boolean;
  requestId?: string | null;
  promptId?: string | null;
  sessionId?: string | null;
  costUsd?: number | null;
  durationMs?: number | null;
  agent?: string | null;
  conversationId?: string | null;
}

export interface NativeTerminalTelemetry {
  calls: NativeTerminalModelCall[];
  defects: number;
}

export interface NativeTerminalLimitFacts {
  reason: string;
  maxTurns?: number;
  modelCalls: number;
  aborted: boolean;
}

export interface NativeTerminalLimitStep {
  reason: string;
  checkBudget: boolean;
}

export interface NativeTerminalStallFacts {
  openRun: boolean;
  notified: boolean;
  idleMs: number;
  stallMs: number;
}

export interface NativeTerminalSilenceFacts {
  cliSendsUsage: boolean;
  telemetrySeen: boolean;
  writeHooks: number;
  elapsedMs: number;
  silentBefore: boolean;
}

export interface NativeTerminalTurnEndFacts {
  closed: boolean;
  pendingViolation: boolean;
  violation: boolean;
  readOnly: boolean;
  readOnlyAfterWork: boolean;
  /** `unread`·`aligned`·`failed` */
  git: string;
  /** `unread`·`same`·`different`·`unknown` */
  fingerprint: string;
  verification: boolean;
  /** `unread`·`yes`·`no`·`unknown` */
  unchanged: string;
  doneTests: boolean;
  hasCard: boolean;
  /** `unread`·`inside`·`outside` */
  card: string;
  unsettledAttempts: number;
  gateAttempts: number;
  maxAttempts: number;
}

export interface NativeTerminalTurnEndStep {
  kind: string;
  allowUnwind: boolean;
  unverified: boolean;
}

export interface NativeTerminalGateFacts {
  /** `gate`·`done_tests` */
  path: string;
  /** `pass`·`retry`·`exhausted` */
  outcome: string;
  cancelled: boolean;
  maxTurnsLimit: boolean;
  violation: boolean;
  unsettledAttempts: number;
  gateAttempts: number;
  maxAttempts: number;
}

export interface NativeTerminalGateStep {
  kind: string;
  maxTurns: boolean;
  attempts: boolean;
}

export interface NativeTerminalErrorFacts {
  stopped: boolean;
  /** `yes`·`no`·`unknown` */
  landed: string;
  runCancelled: boolean;
  deadlineExceeded: boolean;
  bootPlatformFailure: boolean;
}

export interface NativeTerminalErrorClose {
  /** `stopped`·`keep_landed`·`cancelled`·`deadline`·`platform`·`failure` */
  kind: string;
  landedUnknown: boolean;
}

export interface NativeTerminalGateStageFacts {
  deadlineExceeded: boolean;
  pauseFailed: boolean;
  /** `unread`·`clear`·`found` */
  rejected: string;
  /** `unread`·`pass`·`retry`·`exhausted` */
  gate: string;
  moved: string;
  doneTests: string;
}

export interface NativeTerminalGateStageStep {
  kind: string;
  end: string;
  gate: string;
  unsettled: string;
}

export interface NativeTerminalPreToolDecision {
  allow: boolean;
  /** 거절의 까닭 종류. 허용이면 빈 글 */
  deny: string;
}

export interface NativeClaimResult {
  token: number;
  fail?: NativeLifecycleFail | null;
}

export interface NativeSessionRegistry {
  /** 실행 중인 세션(세션 맵에 든 것)을 올린다. 같은 id가 있으면 바꾼다 */
  register(id: string, state: NativeSessionState, local: boolean, workDir: string): void;
  unregister(id: string): void;
  /** 이어받기를 시작한다. 세션이 없으면 404, 멈추지 않았으면 409, 이미 이어받는 중이면 409. 통과하면 null이고 `resuming`에 든다 */
  beginResume(id: string, archived: boolean): NativeLifecycleFail | null;
  endResume(id: string): void;
  resuming(id: string): boolean;
  /** 내 폴더 세션이 쓸 폴더를 잡는다. 글자나 폴더의 정체(장치·inode)가 같은 폴더를 다른 세션이 쓰거나 다른 시작이 잡고 있으면 거절한다 */
  claimFolder(root: string, sessionId?: string | null): NativeClaimResult;
  releaseClaim(token: number): void;
  claimed(): number;
}

export interface NativeRunnerCore {
  /** 취소했다. 도구 장부에 이유를 알리고 떠 있는 프로세스에 입력 닫기 + 바로 SIGTERM을 보낸다 */
  abort(reason: string): void;
  /** `proc`번 프로세스의 표준 입력에 사용자 메시지 한 줄을 보낸다(`text`는 `encodeLoneSurrogates`한 꼴). 그 프로세스가 지금 것이 아니면 버린다 */
  send(proc: number, text: string): void;
  /** 끝까지 돈다. `input`·결과는 JSON. 던지지 않고 결과의 `ok`·`kind`로 돌려준다 */
  run(input: string, hook: (request: string) => Promise<string>): Promise<string>;
}

export interface NativeCliProcess {
  writeLine(line: string): void;
  /** 줄 n개를 소비했다고 알린다. 소비하지 않은 줄이 1,024개에 닿으면 읽기를 멈춰 자식이 쓰기에서 멈춘다(옛 readline 반복자의 상한). 알리지 않으면 멈춘 채 풀리지 않는다 */
  consumed(n: number): void;
  closeInput(): void;
  /** false: graceful, true: now */
  stop(now: boolean): void;
  stderrTail(): Uint16Array;
}

export interface NativeExecSession {
  write(data: Buffer): boolean;
  end(): void;
  terminate(): void;
}

export interface NativeVerifyInput {
  dockerBin: string;
  envVars?: Record<string, string>;
  listArgs: string[];
  projectRoot: string;
  cwd: string;
  projectName: string;
  sandboxNetwork: string;
  egressNetwork: string;
  edgeService: string;
  studioCaller: string;
  serviceLabel: string;
  /** 서비스 → 마운트 계획(`MaskVolume[]`)의 JSON */
  gitMaskJson: string;
  /** 평가 자산 복사본(`{ path, source }[]`)의 JSON */
  assetsJson: string;
}

export interface NativeVerifiedContainer {
  id: string;
  service?: string | null;
}

/** `kind`가 `verified`면 `containers`가 확인한 컨테이너다. 그 밖의 값은 실패다 */
export interface NativeVerifyResult {
  kind: NativeVerifyKind;
  containers: NativeVerifiedContainer[];
  /** 실패한 docker 명령의 stderr 원문(가리기 전) */
  stderr?: string | null;
  detail?: string | null;
  platform: boolean;
  removalFailed: boolean;
}

export type NativeVerifyKind =
  | 'verified'
  | 'list-failed'
  | 'no-containers'
  | 'inspect-failed'
  | 'inspect-unparsed'
  | 'inspect-partial'
  | 'volume-failed'
  | 'volume-unparsed'
  | 'volume-partial'
  | 'policy'
  | 'mask';

export interface NativeStartInput {
  dockerBin: string;
  envVars?: Record<string, string>;
  verified: NativeVerifiedContainer[];
  services: string[];
  dependsOnJson?: string;
  pollMs: number;
  waitMs: number;
}

export interface NativeStartResult {
  missing: string[];
  aborted: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface NativeComposeRef {
  dockerBin: string;
  envVars?: Record<string, string>;
  projectRoot: string;
  composePath: string;
  projectName?: string;
}

export interface NativeUpInput {
  compose: NativeComposeRef;
  cwd: string;
  overridePath: string;
  /** `buildOverride`의 입력(`encodeNative`)에서 `gitMask`만 뺀 것 */
  overrideInputJson: string;
  /** 지금 override 파일에 쓰여 있는 마스크(서비스 → `MaskVolume[]`)의 JSON */
  maskJson: string;
  assetsJson: string;
  args: string[];
  sandboxNetwork: string;
  egressNetwork: string;
  edgeService: string;
  studioCaller: string;
  serviceLabel: string;
  pollMs: number;
  waitMs: number;
}

export type NativeUpKind =
  | 'ok'
  | 'done'
  | 'aborted'
  | 'config-failed'
  | 'config-unparsed'
  | 'mask-error'
  | 'override-build'
  | 'override-write'
  | 'verify'
  | 'missing'
  | 'deps-failed'
  | 'deps-unparsed'
  | 'not-stable';

/** `maskJson`은 마지막에 쓴(또는 계산한) 마스크다. 실패해도 채워진다(load·compute의 실패는 빈 문자열) */
export interface NativeUpResult {
  kind: NativeUpKind;
  maskJson: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  message?: string | null;
  detail?: string | null;
  platform: boolean;
  verifyKind?: NativeVerifyKind | null;
  phase?: 'created' | 'started' | null;
  removalFailed: boolean;
  missing: string[];
}

export interface NativeSyncInput {
  /** `projectRoot`는 컨테이너의 `/project`로 읽기 전용 마운트하는 폴더다 */
  compose: NativeComposeRef;
  files: string[];
  timeoutMs: number;
  script: string;
  image: string;
  pollMs: number;
}

/** `done`(elapsedMs·checks) · `host-read`(file·message) · `docker`(stderr) · `timeout`(message) · `aborted` */
export interface NativeSyncResult {
  kind: 'done' | 'host-read' | 'docker' | 'timeout' | 'aborted';
  elapsedMs: number;
  checks: number;
  file?: string | null;
  message?: string | null;
  stderr: string;
}

export interface NativeRelayInput {
  compose: NativeComposeRef;
  overridePath: string;
  cwd: string;
  /** `compose config --format json`의 stdout 원문 */
  configJson: string;
  managedNames: string[];
  /** `managedNames`와 같은 자리끼리 짝: 프로젝트 루트 기준 서비스 폴더 */
  managedPaths: string[];
  /** `[{ file, kind }]`의 JSON */
  changesJson: string;
  script: string;
}

/** `done`(relayedJson: `[[서비스, 파일]]`) · `problem`(message) */
export interface NativeRelayResult {
  kind: 'done' | 'problem';
  relayedJson: string;
  message?: string | null;
}

export interface NativePortRetryInput {
  /** 첫 시도의 입력. `args`는 `up --detach --remove-orphans …` 전체다 */
  up: NativeUpInput;
  /** 다시 뽑을 호스트 포트의 대상 서비스(중복 없이 처음 나온 순서) */
  publicUrlTargets: string[];
  secretNames: string[];
  secretValues: string[];
  attempts: number;
}

/** `up`(성공이거나 충돌이 아닌 실패) · `exhausted`(마지막 시도까지 충돌) · `port-alloc`(message) · `regenerate`(`up.kind`가 override-build·override-write) */
export interface NativePortRetryResult {
  kind: 'up' | 'exhausted' | 'port-alloc' | 'regenerate';
  up: NativeUpResult;
  message?: string | null;
  /** 포트를 다시 뽑았으면 `{서비스: 포트}`의 JSON, 아니면 빈 문자열 */
  hostPortsJson: string;
}

export interface NativeAwaitReadyInput {
  compose: NativeComposeRef;
  overridePath: string;
  service: string;
  edgeService: string;
  /** edge가 이 서비스를 위해 열어 둔 컨테이너 포트(`String(edgePortFor(...))`) */
  edgePort: string;
  /** false면 엔드포인트만 읽는다(아래 ready* 필드는 쓰지 않는다) */
  hasReady: boolean;
  readyPath: string;
  expectStatus: number;
  successThreshold: number;
  timeoutMs: number;
  intervalMs: number;
  attempt: number;
  secretNames: string[];
  secretValues: string[];
  /** 부르는 시점에 이미 취소돼 있었다 */
  aborted: boolean;
}

/**
 * `ready`(port) · `endpoint-docker`(exitCode·stderr) · `endpoint-unparsed`(reason) · `invalid-port` · `failed`(reason·historyJson) ·
 * `recreate`(reason) · `aborted`(atTop) · `stopped`
 */
export interface NativeAwaitReadyResult {
  kind: 'ready' | 'endpoint-docker' | 'endpoint-unparsed' | 'invalid-port' | 'failed' | 'recreate' | 'aborted' | 'stopped';
  port: number;
  reason?: string | null;
  historyJson: string;
  exitCode: number;
  stderr: string;
  atTop: boolean;
}

export interface NativeScanInput {
  compose: NativeComposeRef;
  overridePath: string;
  /** 컨테이너에서 도는 찾기 스크립트 */
  script: string;
  secretNames: string[];
  secretValues: string[];
}

/** `processes`(processesJson: `[{pid,start,command}]`) · `error`(message) */
export interface NativeScanResult {
  kind: 'processes' | 'error';
  processesJson: string;
  message?: string | null;
}

/** `done`(reportsJson: `[{service, error}|{service, processes:[{pid,command}]}]`) · `error`(message: 컨테이너 상태를 읽지 못했다) */
export interface NativeStrayResult {
  kind: 'done' | 'error';
  reportsJson: string;
  message?: string | null;
}

export interface NativeSnapshotScope {
  /** studio.yaml의 프로젝트 이름(스냅샷 이름·자리에 든다) */
  projectName: string;
  sandboxId: string;
}

export interface NativePlanVolume {
  service: string;
  volume: string;
  /** 프로젝트 루트 기준 서비스 폴더 */
  specPath: string;
  key: string[];
}

export interface NativeSnapshotPlan {
  service: string;
  volume: string;
  snapshot: string;
  slot: string;
  sandboxVolume: string;
}

/** `missing` · `seeded`(elapsedMs) · `failed`(reason) */
export interface NativeSeedResult {
  kind: 'missing' | 'seeded' | 'failed';
  elapsedMs: number;
  reason?: string | null;
}

/** `existing` · `captured`(elapsedMs) · `failed`(message·detail) */
export interface NativeCaptureResult {
  kind: 'existing' | 'captured' | 'failed';
  elapsedMs: number;
  message?: string | null;
  detail?: string | null;
}

/** `done`(removed: `volume rm`을 부른 이름) · `dates-unknown` · `refused` */
export interface NativePruneResult {
  kind: 'done' | 'dates-unknown' | 'refused';
  removed: string[];
}

/** `failed`가 false면 모두 만들었다. 실패는 먼저 끝난 하나의 명령·종료 코드(출력이 상한을 넘으면 `code`가 없다)·출력이다 */
export interface NativeSharedVolumesResult {
  failed: boolean;
  command: string;
  code?: number | null;
  stdout: string;
  stderr: string;
}

export interface NativeStatsInput {
  compose: NativeComposeRef;
  overridePath: string;
  managed: string[];
  edgeService: string;
  timeoutMs: number;
}

/** `done`(json: `ServiceUsage[]`을 `encodeNative`한 글) · `list-failed`·`inspect-failed`(timedOut·stderr) · `timed-out` · `parse`(message) */
export interface NativeStatsResult {
  kind: 'done' | 'list-failed' | 'inspect-failed' | 'timed-out' | 'parse';
  json: string;
  timedOut: boolean;
  stderr: string;
  message?: string | null;
}

export interface NativeGitEntry {
  dir: string;
  kind: 'directory' | 'file';
  hasState: boolean;
  aliases: readonly string[];
}

export interface NativeDumpNormalizer {
  /** 바이트 조각을 먹이면 해시에 넣을 바이트를 돌려준다 */
  feed(chunk: Buffer): Buffer;
  /** 입력이 끝났다. 줄 끝 없이 끝난 마지막 줄을 마무리한다 */
  finish(): Buffer;
}

export interface NativeSyncObservations {
  record(file: string, value: string | undefined): void;
  describeTimeout(pending: string[], expectedMissing: string[], timeoutMs: number): string;
}

export interface NativeRedactor {
  redact(text: string): string;
  find(text: string): string[];
}

function load(): NativeGuard {
  try {
    return createRequire(import.meta.url)('../native/bstudio_node.node') as NativeGuard;
  } catch (error) {
    throw new Error(`b-studio 네이티브 모듈을 불러오지 못했습니다. 저장소 루트에서 pnpm build:native 를 실행하세요: ${(error as Error).message}`);
  }
}

export const native: NativeGuard = load();

/** `NaN`·`Infinity`·`-0`은 JSON으로 쓸 수 없어(`JSON.stringify`는 `null`·`0`으로 바꾼다) NUL로 시작하는 키 하나짜리 객체로 주고받는다(crates/bstudio-guard/src/js_json.rs) */
const NONFINITE_KEY = '\u0000nf';

/**
 * Rust로 보낼 JSON. 유한하지 않은 수와 -0은 표시 객체로 쓴다.
 * 데이터의 객체가 NUL로 시작하는 키를 가지면 던진다. 그대로 보내면 표시 객체를 흉내 내 수로 읽힐 수 있다(#1029)
 */
export function encodeNative(value: unknown): string {
  // replacer가 돌려준 표시 객체에는 replacer가 다시 불리지 않으므로(안의 속성에만 불린다) 아래 확인은 데이터의 객체만 본다
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'number' && (!Number.isFinite(item) || Object.is(item, -0))) return { [NONFINITE_KEY]: Object.is(item, -0) ? '-0' : String(item) };
    if (item !== null && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).some((key) => key.startsWith('\u0000'))) {
      throw new Error('NUL로 시작하는 키는 Rust 판정으로 보낼 수 없습니다');
    }
    return item;
  });
}

const LONE_OR_RESERVED = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]|[\ue000-\ue01f]/g;
const nibble = (n: number) => String.fromCharCode(0xe000 + n);

/**
 * Rust로 보내 부분 문자열을 견줄 글자를 단사로 바꾼다. 짝 없는 서로게이트는 napi·JSON 경계에서 모두 U+FFFD가 되어 서로 다른 두 글자가 같아지므로
 * (확인 문구가 화면 글자에서 "찾았다"로 뒤집힌다), 견줄 두 글자 모두에 이 함수를 적용해서 보낸다.
 * 예약 집합 R = U+E000..U+E01F. 짝 없는 서로게이트 단위 u는 U+E010 + 니블 셋(u>>8·u>>4·u 각 하위 4비트를 U+E000+n으로) 4글자,
 * 글자 그대로의 R 안 글자 r은 U+E011 + 니블 둘(r-0xE000의 상·하위 4비트) 3글자로 쓴다. R의 글자는 이스케이프 안에서만, U+E010·U+E011은 이스케이프 시작에서만
 * 나오므로 인코딩한 두 글자의 부분 문자열 관계는 원래 코드 단위의 부분 문자열 관계와 같다.
 * 예외(닫는 쪽): B에서는 짝 없는 서로게이트인데 A에서는 짝의 일부이면(`'😀'.includes('\ud83d')`) 인코딩한 쪽은 "없다"가 된다
 */
export function encodeLoneSurrogates(text: string): string {
  return text.replace(LONE_OR_RESERVED, (unit) => {
    const u = unit.charCodeAt(0);
    if (u >= 0xe000 && u <= 0xe01f) return `\ue011${nibble((u - 0xe000) >> 4)}${nibble((u - 0xe000) & 0xf)}`;
    return `\ue010${nibble((u >> 8) & 0xf)}${nibble((u >> 4) & 0xf)}${nibble(u & 0xf)}`;
  });
}

/** Rust가 보낸 JSON. 표시 객체를 `NaN`·`Infinity`·`-0`으로 되돌린다 */
export function decodeNative<T>(text: string): T {
  return JSON.parse(text, (_key, item: unknown) => {
    if (item !== null && typeof item === 'object' && !Array.isArray(item) && NONFINITE_KEY in item) return Number((item as Record<string, string>)[NONFINITE_KEY]);
    return item;
  }) as T;
}

/** `execChecked`가 던지던 것과 같은 정보. `kind`: `ok` · `invalid-id` · `failed`(`code`가 없으면 출력이 상한을 넘었다) */
export interface NativeCheckedResult {
  kind: 'ok' | 'invalid-id' | 'failed';
  message: string;
  code?: number | null;
  stdout: string;
  stderr: string;
}

export interface NativeCleanupResult {
  kind: 'done' | 'invalid-id';
  failure?: string | null;
}

export interface NativeDestroyInput {
  compose: NativeComposeRef;
  overridePath: string;
  workDir: string;
  assetRoot: string;
  cwd?: string;
}

export interface NativeDestroyResult {
  kind: 'done' | 'invalid-id';
  downFailed: boolean;
  downStderr: string;
  images: NativeCheckedResult;
  workDir?: string | null;
  assets?: string | null;
}

export interface NativeRuntimeCheck {
  kind: 'present' | 'missing' | 'info-failed';
  message: string;
  available: string[];
}

export interface NativeExternalInput {
  compose: NativeComposeRef;
  overridePath: string;
  edgeService: string;
  externals: string[];
  name: string;
  path: string;
  edgeScript: string;
  requestJson: string;
}

export interface NativeExternalResult {
  kind: 'done' | 'failed' | 'not-registered' | 'path-not-absolute';
  last: string;
  stderr: string;
}

export interface NativeBrowserRunInput {
  /** 차례로 시도할 실행 파일. 모두 못 띄우면 `unavailable`이다 */
  executables: string[];
  url: string;
  viewportWidth: number;
  viewportHeight: number;
  /** `VIEWPORT_MEASURE_SCRIPT(texts)`로 만든 식. 글자를 넘기지 않았으면 없다 */
  viewportScript?: string | null;
  /** `viewportScript`에 넣은 글자들 */
  viewportTexts?: string[] | null;
  allowedOrigins?: string[] | null;
  measureLoad: boolean;
  mediaErrorScript: string;
  /** 페이지를 연 뒤 순서대로 실행할 단계 */
  steps: NativeBrowserStepInput[];
  /** 켜면 페이지를 연 직후와 각 단계 뒤에 뷰포트 스크린샷(PNG)을 찍는다 */
  capture: boolean;
  /** 페이지를 연 직후의 단계 이름(`open <경로>`) */
  openLabel: string;
}

/** `kind`가 `none`이면 선언한 네 동작이 없는 단계다. `value`는 선택자(click·fill·waitFor) 또는 키(press), `text`는 fill의 글자 */
export interface NativeBrowserStepInput {
  label: string;
  kind: 'click' | 'fill' | 'press' | 'waitFor' | 'none';
  value: string;
  text?: string | null;
}

export interface NativeBrowserStepResult {
  label: string;
  ok: boolean;
  detail?: string | null;
  screenshot?: Buffer | null;
}

/** `kind`: `done`(나머지 필드) · `unavailable`(message) · `failed`(message) · `stepFailed`(message, steps) · `stepWithoutAction`(message) · `aborted` */
export interface NativeBrowserRunResult {
  kind: 'done' | 'unavailable' | 'failed' | 'stepFailed' | 'stepWithoutAction' | 'aborted';
  message: string;
  status?: number | null;
  text: string;
  pageErrors: string[];
  consoleErrors: string[];
  failedRequests: string[];
  mediaErrors: string[];
  blockedRequests: string[];
  horizontalOverflowPx: number;
  viewportTextsJson?: string | null;
  loadMs?: number | null;
  /** 페이지를 연 직후와 각 단계의 결과(`done`·`stepFailed`일 때) */
  steps: NativeBrowserStepResult[];
}

export interface NativeLoadInput {
  compose: NativeComposeRef;
  overridePath: string;
  service: string;
  port: number;
  sandboxNetwork: string;
  runtime?: string;
  image: string;
  requestJson: string;
  requests: number;
  concurrent: number;
  runnerScript: string;
  cpusKnown: boolean;
  daemonCpus?: number;
  limitMs: number;
  signalAlreadyAborted: boolean;
}

export interface NativeLoadResult {
  kind: 'done' | 'invalid-id' | 'state-unreadable' | 'not-running' | 'config-invalid' | 'aborted' | 'timed-out' | 'runner-failed' | 'unreadable';
  json: string;
  message: string;
  exitCode: number;
  stdout: string;
  stderr: string;
  cpusRead: boolean;
  daemonCpus?: number | null;
}
