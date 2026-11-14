import { setTimeout as sleep } from 'node:timers/promises';
import { decodeNative, encodeLoneSurrogates, encodeNative, formatBytes, native, SandboxError, type Sandbox, type StartOptions } from '@b-studio/sandbox';
import { loadProject, SpecError, SPEC_FILE, type LoadedProject } from '@b-studio/spec';
import { diffContracts, formatContractChanges, type ContractChange, type OpenApiDocument } from './contract-diff';
import { decodeLoneSurrogates } from './lone-surrogates';
import { isComposeFile, servicesForFiles } from './services';
import { syncSystemPackages } from './system-packages-sync';

export type ContractFetcher = (url: string) => Promise<OpenApiDocument>;

export const fetchContract: ContractFetcher = async (url) => {
  // 서비스가 3xx로 다른 호스트를 가리키면 따라가지 않는다(#1187). 게이트의 다른 요청과 같다
  const response = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(15_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return (await response.json()) as OpenApiDocument;
};

export interface ServiceCheck {
  service: string;
  ready: boolean;
  error?: string;
  /** 실패했을 때만 채운다. 에이전트가 원인을 읽을 수 있게 마지막 로그를 담는다 */
  logTail?: string[];
  /** 지운 파일을 빌드 도구가 읽다 실패해 한 번 더 재시작했는지 */
  retried?: boolean;
  /** 메모리 한도를 넘어 커널이 종료시켰는지. 코드 문제가 아니라는 신호다 */
  oomKilled?: boolean;
  /** 재시작하는 동안 샌드박스 밖으로 나가려다 막힌 요청. 의존성 다운로드가 막혔다면 코드 문제가 아니다 */
  blockedEgress?: string[];
  /** 샌드박스·도커 쪽 문제로 재시작하지 못했다(SandboxError.platform). 코드를 고쳐서 풀 수 없다 */
  platform?: true;
}

export interface ContractCheck {
  service: string;
  changes: ContractChange[];
  error?: string;
}

export interface VerificationReport {
  ok: boolean;
  /** 재시작 전에 샌드박스가 바뀐 파일을 보게 될 때까지 기다린 결과. platform이면 샌드박스 쪽 문제로 반영을 확인하지 못했다 */
  sync: { elapsedMs: number } | { error: string; platform?: true };
  restarted: ServiceCheck[];
  /**
   * 샌드박스·도커 쪽 문제로 검증을 끝내지 못했을 때의 사유(첫 줄). 있으면 ok는 false다.
   * 에이전트가 바꾼 코드가 원인이 아니므로 게이트는 재시도 횟수로 세지 않고, 호출자는 변경을 되돌리지 않는다(트러블슈팅 117)
   */
  platformFailure?: string;
  contracts: ContractCheck[];
  /** 서비스에 속하지 않아 재시작으로 확인할 수 없는 파일 */
  unverifiedFiles: string[];
  /** 시크릿 값이 들어간 바뀐 파일. 체크포인트로 커밋되지 않게 게이트를 실패시킨다 */
  secretLeaks: SecretLeak[];
  /**
   * 사용자가 서비스 선택(ADR-083)에서 꺼 둬 재시작·계약 확인을 건너뛴 managed 서비스.
   * "검증됨"이 실제보다 부풀려 보이지 않도록 남긴다 — 실패로 세지는 않는다
   */
  skippedOff: string[];
  /**
   * 이번 실행이 바꾼 studio.yaml이 스키마에 맞지 않을 때의 오류(도그푸딩 마찰 131). 전에는 조용히 옛 설정으로
   * 넘어갔지만(loadProject(...).catch(() => project)), 그러면 에이전트가 같은 실행에서 고칠 기회를 놓치고
   * 잘못된 studio.yaml이 체크포인트로 남는다. 있으면 ok는 항상 false다
   */
  specError?: string;
  /**
   * compose 파일이 바뀐 재시작에서, 이 세션이 시작할 때는 없던(그래서 꺼 둘 기회조차 없던) 새 부가 서비스 중
   * 이 세션의 compose 프로젝트 안에 새로 올린 이름(도그푸딩 마찰 138, ADR-146). depends_on 여부는 보지 않는다
   * — 에이전트나 사람이 나중에 compose에 더한 부가 서비스는 쓰려고 일부러 넣은 것으로 본다(실측: BE-commerce의
   * mediamtx는 어느 managed 서비스도 depends_on으로 기대지 않는다). 사람이 꺼 둔 서비스(offServices)는
   * 올리지 않는다. 비었으면(기본) compose가 바뀌지 않았거나 올릴 새 서비스가 없었다
   */
  addedAddons?: string[];
  /** 위 부가 서비스를 올리려 했지만 실패했을 때의 이유. 실패해도 ok는 이 때문에 false가 되지 않는다(관리형 서비스와 별개다) */
  addonError?: string;
}

export interface SecretLeak {
  file: string;
  /** 값이 들어 있는 시크릿 이름 */
  secrets: string[];
}

export interface VerifyOptions {
  sandbox: Sandbox;
  project: LoadedProject;
  changedFiles: readonly string[];
  /** 세션 시작 시점의 계약. 서비스 이름 → 문서 */
  baselines: ReadonlyMap<string, OpenApiDocument>;
  /** 요청 자체가 삭제·변경을 원할 때만 true */
  allowBreaking: boolean;
  fetcher?: ContractFetcher;
  start?: StartOptions;
  /** 바뀐 파일과 무관하게 함께 다시 띄울 서비스(#765, 게이트가 검사 전에 모르는 프로세스를 찾은 서비스) */
  alsoRestart?: readonly string[];
}

/**
 * 에이전트가 작업을 끝냈다고 할 때 스튜디오가 직접 수행하는 검증.
 * 모델에게 "검증하라"고 부탁하는 대신 플랫폼이 강제한다.
 *  1. 바뀐 파일이 속한 서비스를 다시 띄우고 준비 판정을 통과하는지
 *  2. 계약을 다시 추출해 세션 시작 시점과 비교했을 때 호환을 깨지 않는지
 */
export async function verifyChanges(options: VerifyOptions): Promise<VerificationReport> {
  const { start } = options;
  // 순서(Rust, crates/bstudio-io/src/verify_io.rs): findSecretLeaks → restartServicesFor → platformFailureOf → (sync 실패면 조기 반환) → 준비된 서비스만 계약 추출(병렬) → 판정(verify_judge.rs).
  // 샌드박스·프로젝트·계약 가져오기는 TS가 들고 콜백으로 불린다. 계약 주소는 `serviceUrl`(WHATWG `new URL`로 출처를 비교한다)이라 Rust로 옮기지 않았다
  // (확인하는 쪽과 요청하는 쪽이 같은 입력을 다르게 읽지 않게)
  const { input, handlers } = verifyChangesSetup(options);
  return runVerify<VerificationReport>('verifyChanges', input, handlers, start?.signal);
}

/**
 * `verifyChanges`가 Rust에 넘기는 입력과 콜백 처리기. 게이트 check(`gate-check.ts`)가 `verifyChanges`를 Rust 안에서 바로 부를 때도 같은 것을 쓴다.
 * 재시작이 다시 읽은 선언을 든 처리기(`declared`)는 부를 때마다 새로 만든다(옛 코드가 `verifyChanges`를 부를 때마다 새로 만들던 것과 같다)
 */
export function verifyChangesSetup(options: VerifyOptions): { input: Record<string, unknown>; handlers: Record<string, HookHandler> } {
  const { sandbox, project, changedFiles, baselines, allowBreaking, fetcher = fetchContract, start, alsoRestart } = options;
  const restart = restartHooks(sandbox, project, changedFiles, start);
  return {
    input: { ...verifyInput(sandbox, project, changedFiles), ...(alsoRestart ? { alsoRestart } : {}), allowBreaking },
    handlers: {
      ...restart.handlers,
      ...secretHandlers(sandbox),
      contract: ({ service }) =>
        attempt(async () => {
          const spec = project.managed.find(([name]) => name === service)?.[1];
          const endpoint = await sandbox.endpoint(String(service));
          const current = await fetcher(serviceUrl(spec!.contract!.extract, endpoint.url));
          return { changes: diffContracts(baselines.get(String(service)), current) };
        }),
    },
  };
}

/**
 * 반영 확인이나 재시작이 샌드박스·도커 쪽 문제로 실패했으면 그 사유의 첫 줄을 돌려준다. 판정은 Rust(verify_judge.rs, 3단계 3u).
 * 이 값이 있으면 게이트가 재시도로 세지 않는다(열린 쪽)이라 모르는 입력은 없음으로 본다
 */
export function platformFailureOf(sync: VerificationReport['sync'], restarted: readonly ServiceCheck[]): string | undefined {
  return (
    native.verifyPlatformFailure(
      'error' in sync ? sync.error : undefined,
      'error' in sync && sync.platform === true,
      restarted.map((check) => check.service),
      restarted.map((check) => check.ready === true),
      restarted.map((check) => check.platform === true),
      restarted.map((check) => check.error ?? ''),
    ) ?? undefined
  );
}

/**
 * 바뀐 파일에 시크릿 값이 들어갔는지. 에이전트는 값을 볼 수 없지만,
 * 명령으로 환경 변수를 파일에 쓰는 것처럼 출력 가림을 거치지 않는 경로가 있다.
 * 파일을 읽는 순서는 Rust(verify_io.rs)가 하고, 값이 들어 있는지는 `sandbox.findSecrets`(콜백)가 본다
 */
export async function findSecretLeaks(sandbox: Sandbox, root: string, files: readonly string[]): Promise<SecretLeak[]> {
  return runVerify<SecretLeak[]>('findSecretLeaks', { root, files, offServices: null, managed: [], specFile: SPEC_FILE, composeChanged: false, hasEnsureInfra: false }, secretHandlers(sandbox));
}

export interface RestartReport {
  sync: VerificationReport['sync'];
  restarted: ServiceCheck[];
  /** 서비스에 속하지 않아 재시작으로 확인할 수 없는 파일 */
  unverifiedFiles: string[];
  /** 사용자가 꺼 둬(ADR-083) 재시작을 건너뛴 managed 서비스. 실패로 세지 않는다 */
  skippedOff: string[];
  /** 이번에 바뀐 studio.yaml이 스키마에 맞지 않을 때의 오류. VerificationReport.specError와 같다 */
  specError?: string;
  /** compose가 바뀐 재시작에서 이 세션 시작 뒤 새로 생겨 올린 부가 서비스. VerificationReport.addedAddons와 같다 */
  addedAddons?: string[];
  /** 위 부가 서비스를 올리려 했지만 실패한 이유. VerificationReport.addonError와 같다 */
  addonError?: string;
}

/**
 * 바뀐 파일이 샌드박스에 반영됐는지 확인한 뒤, 그 파일이 속한 서비스를 다시 띄운다.
 * 검증 게이트, 실패한 변경 되돌리기, 체크포인트 복원이 같은 절차를 쓴다.
 */
export interface RestartOptions {
  /** 파일과 무관하게 함께 재시작할 서비스 (예: 되돌린 데이터베이스에 기대는 서비스) */
  alsoRestart?: readonly string[];
  /** 지운 파일 때문에 실패했을 때 다시 시도하기 전 기다리는 시간 */
  deletedFileRetryDelayMs?: number;
}

export async function restartServicesFor(
  sandbox: Sandbox,
  project: LoadedProject,
  files: readonly string[],
  start?: StartOptions,
  { alsoRestart = [], deletedFileRetryDelayMs = 3_000 }: RestartOptions = {},
): Promise<RestartReport> {
  // 순서(Rust, verify_io.rs): studio.yaml·compose가 바뀌면 선언을 다시 읽고(실패는 specError, 옛 project로 계속) → 소유 서비스 − 꺼 둔 서비스 → 지운 파일 → systemPackages 동기화
  // → 반영 확인(실패면 조기 반환) → compose가 바뀌면 새 부가 서비스 → 서비스별 재시작(병렬, 지운 파일 때문에 실패하면 한 번 더)
  return runVerify<RestartReport>(
    'restartServicesFor',
    { ...verifyInput(sandbox, project, files), alsoRestart, retryDelayMs: deletedFileRetryDelayMs },
    restartHooks(sandbox, project, files, start).handlers,
    start?.signal,
  );
}

// ── Rust 조율과의 경계 ──
// Rust가 콜백으로 부르는 것: Sandbox 메서드(sync·restart·stats·logs·egressDenials·ensureInfra·endpoint·findSecrets), loadProject, syncSystemPackages,
// servicesForFiles(`process.cwd()`를 읽는다), 계약 가져오기(endpoint → serviceUrl → fetcher → diffContracts), sleep(취소 신호를 지킨다).
// 응답은 `{ ok: true, ... }`, 옛 코드가 `catch`로 값으로 읽던 실패 `{ ok: false, error: { message, platform?, aborted? } }`, 옛 코드에서 그대로 던지던 실패(콜백 오류를 저장하고 `{ fatal: true }`)다.

export type HookRequest = Record<string, unknown>;
export type HookHandler = (request: HookRequest) => Promise<Record<string, unknown>> | Record<string, unknown>;

/** 글자를 Rust 경계의 꼴(`encodeLoneSurrogates`)로 바꾼다. 키는 바꾸지 않는다 */
export function encodeStrings(value: unknown): unknown {
  if (typeof value === 'string') return encodeLoneSurrogates(value);
  if (Array.isArray(value)) return value.map(encodeStrings);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeStrings(item)]));
  return value;
}

export function decodeStrings<T>(value: T): T {
  if (typeof value === 'string') return decodeLoneSurrogates(value) as T;
  if (Array.isArray(value)) return value.map(decodeStrings) as T;
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeStrings(item)])) as T;
  return value;
}

/** 옛 코드가 `catch`로 값으로 읽던 실패를 응답으로 바꾼다(삼킬지 값으로 쓸지는 Rust가 정한다) */
export function failure(error: unknown, extra: Record<string, unknown> = {}, aborted = false): Record<string, unknown> {
  return { ok: false, error: { message: describe(error), ...(isPlatformError(error) ? { platform: true } : {}), ...(aborted ? { aborted: true } : {}) }, ...extra };
}

async function attempt(run: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  try {
    return { ok: true, ...(await run()) };
  } catch (error) {
    return failure(error);
  }
}

async function runVerify<T>(op: string, input: Record<string, unknown>, handlers: Record<string, HookHandler>, signal?: AbortSignal): Promise<T> {
  let thrown: { error: unknown } | undefined;
  const hook = async (text: string): Promise<string> => {
    try {
      const request = decodeStrings(decodeNative<HookRequest>(text));
      const handler = handlers[String(request.op)];
      if (!handler) throw new Error(`알 수 없는 검증 콜백입니다: ${String(request.op)}`);
      return encodeNative(encodeStrings(await handler(request)));
    } catch (error) {
      thrown ??= { error };
      return JSON.stringify({ fatal: true });
    }
  };
  const text = await native.verifyRun(op, encodeNative(encodeStrings(input)), hook);
  const result = decodeStrings(decodeNative<{ ok: boolean; value?: T; kind?: string; message?: string }>(text));
  if (result.ok) return result.value as T;
  if (result.kind === 'aborted') throw signal?.reason;
  if (result.kind === 'hook') throw thrown?.error ?? new Error('검증 콜백이 실패했습니다');
  throw new Error(result.message ?? '검증 입력을 읽지 못했습니다');
}

function verifyInput(sandbox: Sandbox, project: LoadedProject, files: readonly string[]): Record<string, unknown> {
  return {
    root: project.root,
    files,
    offServices: project.offServices ? [...project.offServices] : null,
    managed: project.managed.map(([name, service]) => ({ name, hasContract: Boolean(service.contract) })),
    specFile: SPEC_FILE,
    // compose 파일 판정은 `process.cwd()`를 읽는 TS 쪽에서 한다
    composeChanged: files.some((file) => isComposeFile(project, file)),
    hasEnsureInfra: Boolean(sandbox.ensureInfra),
  };
}

function secretHandlers(sandbox: Sandbox): Record<string, HookHandler> {
  // `findSecrets`가 던지면 옛 코드도 그대로 던졌다(Promise.all이 거절한다) — 던지게 둔다(runVerify가 fatal로 바꾼다)
  return { findSecrets: ({ content }) => ({ ok: true, secrets: sandbox.findSecrets(String(content)) }) };
}

function restartHooks(sandbox: Sandbox, project: LoadedProject, files: readonly string[], start?: StartOptions): { handlers: Record<string, HookHandler> } {
  // 실행 중 에이전트가 studio.yaml을 바꿨으면(systemPackages·includes 등) 세션이 시작할 때 읽은 project에는 그 선언이 없다 — 다시 읽은 선언은 여기(declared)가 든다
  let declared = project;
  const handlers: Record<string, HookHandler> = {
    loadProject: async () => {
      try {
        declared = await loadProject(project.root);
        return { ok: true };
      } catch (error) {
        return { ok: false, error: { message: error instanceof SpecError ? error.message : describe(error) } };
      }
    },
    servicesForFiles: () => {
      const owned = servicesForFiles(declared, files);
      return { ok: true, services: owned.services, unmatched: owned.unmatched };
    },
    syncSystemPackages: async ({ services }) => {
      await syncSystemPackages(declared, services as string[]);
      return { ok: true };
    },
    sync: () => attempt(async () => ({ elapsedMs: (await sandbox.sync([...files], { signal: start?.signal })).elapsedMs })),
    composeInfo: () => ({ ok: true, composeServices: declared.composeServices, managedNames: declared.managed.map(([name]) => name) }),
    ensureInfra: async ({ addons }) => {
      const result = await sandbox.ensureInfra!(addons as string[], { signal: start?.signal }).catch((error: unknown) => ({ ok: false, recovered: [] as string[], reason: describe(error) }));
      return { ok: true, result };
    },
    restart: async ({ service }) => {
      try {
        await sandbox.restart(String(service), start);
        return { ok: true };
      } catch (error) {
        // 취소로 끊겼는지는 여기서 알리고, 던질지는 Rust가 정한다
        return failure(error, {}, start?.signal?.aborted === true);
      }
    },
    stats: () =>
      attempt(async () => ({
        entries: (await sandbox.stats()).map((usage) => ({
          service: usage.service,
          oomKilled: Boolean(usage.oomKilled),
          limit: usage.memoryLimitBytes ? ` (${formatBytes(usage.memoryLimitBytes)})` : '',
        })),
      })),
    logs: async ({ service }) => {
      const lines: string[] = [];
      try {
        for await (const line of sandbox.logs({ services: [String(service)], tail: 60, follow: false })) lines.push(line.text);
        return { ok: true, lines };
      } catch (error) {
        return failure(error, { lines });
      }
    },
    egressDenials: async ({ sinceMs }) => {
      if (!sandbox.egressDenials) return { ok: true, denials: [] };
      const pending = sandbox.egressDenials({ since: new Date(Number(sinceMs)) });
      try {
        return { ok: true, denials: await pending };
      } catch (error) {
        return failure(error);
      }
    },
    sleep: async ({ ms }) => {
      await sleep(Number(ms), undefined, { signal: start?.signal });
      return { ok: true };
    },
  };
  return { handlers };
}

function isPlatformError(error: unknown): boolean {
  return error instanceof SandboxError && error.platform;
}

/**
 * 로그에 지운 파일이 "없다"는 오류로 나오는지. 판정은 Rust(verify_judge.rs, 3단계 3u). 참이면 실패한 서비스를 한 번 더 띄우는 쪽(통과 쪽)으로 열리므로
 * 견주는 두 글자를 encodeLoneSurrogates(단사)로 바꿔 보낸다: 짝 없는 서로게이트가 U+FFFD로 합쳐져 다른 파일 이름이 같아지지 않게
 */
export function mentionsDeletedFile(logTail: readonly string[], deleted: readonly string[]): boolean {
  return native.verifyMentionsDeletedFile(logTail.map(encodeLoneSurrogates), deleted.map(encodeLoneSurrogates));
}

/**
 * 스펙 경로를 서비스 엔드포인트 위의 주소로 만든다. `new URL`은 `\\`를 `/`로 읽고 탭·줄바꿈을 지워 `/\\example.com/`·`/<탭>/example.com/`이
 * 다른 호스트로 풀리므로(#1187, 트러블슈팅 192와 같은 꼴), 출처가 엔드포인트와 다르면 요청하지 않고 던진다
 */
export function serviceUrl(specPath: string, endpointUrl: string): string {
  const url = new URL(specPath, endpointUrl);
  if (url.origin !== new URL(endpointUrl).origin) throw new Error(`경로(${JSON.stringify(specPath)})가 서비스 밖 호스트를 가리켜 요청하지 않았습니다`);
  return url.toString();
}

/** 세션 시작 시점의 계약을 저장해 둔다. 실패한 서비스는 비교 기준 없이 진행한다(순서는 Rust, 가져오기와 저장은 콜백) */
export async function captureBaselines(
  sandbox: Sandbox,
  project: LoadedProject,
  fetcher: ContractFetcher = fetchContract,
): Promise<Map<string, OpenApiDocument>> {
  const baselines = new Map<string, OpenApiDocument>();
  await runVerify<string[]>('captureBaselines', { ...verifyInput(sandbox, project, []), files: [] }, {
    baseline: ({ service }) =>
      attempt(async () => {
        const name = String(service);
        const spec = project.managed.find(([candidate]) => candidate === name)?.[1];
        const endpoint = await sandbox.endpoint(name);
        // 기준이 없으면 모든 계약 항목이 "추가"로 보인다 — 가져오지 못한 서비스는 저장하지 않는다
        baselines.set(name, await fetcher(serviceUrl(spec!.contract!.extract, endpoint.url)));
        return {};
      }),
  });
  return baselines;
}

/**
 * 검증 보고서 글. 판정과 글은 Rust(verify_judge.rs, 3단계 3u)가 만든다. 보고서를 JSON으로 만들 수 없거나 모양이 어긋나면 "검증 실패"로 시작하는 글이다(통과 글이 나오지 않는다)
 */
export function formatVerificationReport(report: VerificationReport, { allowBreaking }: { allowBreaking: boolean }): string {
  let json: string;
  try {
    json = encodeNative(report);
  } catch {
    return '검증 실패\n- 검증 보고서를 글로 만들 수 없습니다';
  }
  return native.verifyFormatReport(json, allowBreaking, SPEC_FILE);
}

export function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
