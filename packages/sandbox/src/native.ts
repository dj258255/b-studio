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
  // ── agent: 작업 공간의 막는 검사(3단계 3w). workspaceIsDenied·workspaceIsSecretFile은 거부 목록이라 짝 없는 서로게이트가 U+FFFD로 합쳐져도 더 막을 뿐이다.
  // workspaceIsInside는 path.relative(root, target)의 결과를 encodeLoneSurrogates한 글자로 받는 허용 목록(통과가 곧 안쪽).
  // workspaceInputProblem은 0 없음·1 절대 경로·2 쓸 수 없는 글자(NUL, POSIX의 역슬래시). external이면 2를 보지 않는다
  workspaceIsDenied(segment: string): boolean;
  workspaceIsSecretFile(file: string): boolean;
  workspaceIsInside(relative: string, backslashSep: boolean): boolean;
  workspaceInputProblem(file: string, backslashSep: boolean, external: boolean): number;
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
