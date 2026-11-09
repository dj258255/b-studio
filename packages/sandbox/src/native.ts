import { createRequire } from 'node:module';
import type { ExecResult } from './types';

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
  runCommand(bin: string, args: string[], input: string | undefined | null, env: Record<string, string> | undefined | null, signal: AbortSignal | undefined | null): Promise<ExecResult>;
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

export interface NativeExecSession {
  write(data: Buffer): boolean;
  end(): void;
  terminate(): void;
}

export interface NativeGitEntry {
  dir: string;
  kind: 'directory' | 'file';
  hasState: boolean;
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

/** Rust가 보낸 JSON. 표시 객체를 `NaN`·`Infinity`·`-0`으로 되돌린다 */
export function decodeNative<T>(text: string): T {
  return JSON.parse(text, (_key, item: unknown) => {
    if (item !== null && typeof item === 'object' && !Array.isArray(item) && NONFINITE_KEY in item) return Number((item as Record<string, string>)[NONFINITE_KEY]);
    return item;
  }) as T;
}
