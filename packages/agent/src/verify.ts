import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { encodeLoneSurrogates, encodeNative, formatBytes, native, SandboxError, type InfraCheckResult, type Sandbox, type StartOptions } from '@b-studio/sandbox';
import { loadProject, SpecError, SPEC_FILE, type LoadedProject } from '@b-studio/spec';
import { diffContracts, formatContractChanges, type ContractChange, type OpenApiDocument } from './contract-diff';
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
  const { sandbox, project, changedFiles, baselines, allowBreaking, fetcher = fetchContract, start, alsoRestart } = options;
  const secretLeaks = await findSecretLeaks(sandbox, project.root, changedFiles);
  const { sync, restarted, unverifiedFiles, skippedOff, specError, addedAddons, addonError } = await restartServicesFor(sandbox, project, changedFiles, start, alsoRestart ? { alsoRestart } : {});
  const platformFailure = platformFailureOf(sync, restarted);
  if ('error' in sync) {
    return { ok: false, sync, restarted, contracts: [], unverifiedFiles, secretLeaks, skippedOff, specError, addedAddons, addonError, ...(platformFailure ? { platformFailure } : {}) };
  }

  // 재시작에 실패했거나(서비스가 준비 안 됨) 꺼 둬 재시작을 건너뛴 서비스의 계약은 뽑을 수 없으므로 준비된 서비스만 비교한다
  const failed = new Set(restarted.filter((check) => !check.ready).map((check) => check.service));
  const off = new Set(skippedOff);
  const contractServices = project.managed.filter(([name, service]) => service.contract && !failed.has(name) && !off.has(name));

  const contracts = await Promise.all(
    contractServices.map(async ([name, service]): Promise<ContractCheck> => {
      try {
        const endpoint = await sandbox.endpoint(name);
        const current = await fetcher(serviceUrl(service.contract!.extract, endpoint.url));
        return { service: name, changes: diffContracts(baselines.get(name), current) };
      } catch (error) {
        return { service: name, changes: [], error: describe(error) };
      }
    }),
  );

  // 통과 판정은 Rust(crates/bstudio-guard/src/verify_judge.rs, ADR-191 3단계 3u)가 한다. 여기는 값을 꺼내 넘기는 형 변환뿐이다.
  // 계약 추출 실패는 이유가 빈 글자여도 실패다(`error !== undefined`, 트러블슈팅 171: 옛 `!check.error`는 빈 글자를 "오류 없음"으로 읽어 통과시켰다)
  const ok = native.verifyOk(
    restarted.map((check) => check.ready === true),
    contracts.map((check) => check.error !== undefined),
    contracts.flatMap((check) => check.changes.map((change) => Boolean(change.breaking))),
    allowBreaking,
    secretLeaks.length,
    specError !== undefined,
  );

  return { ok, sync, restarted, contracts, unverifiedFiles, secretLeaks, skippedOff, specError, addedAddons, addonError, ...(platformFailure ? { platformFailure } : {}) };
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
 * 명령으로 환경 변수를 파일에 쓰는 것처럼 출력 가림을 거치지 않는 경로가 있다
 */
export async function findSecretLeaks(sandbox: Sandbox, root: string, files: readonly string[]): Promise<SecretLeak[]> {
  const found = await Promise.all(
    files.map(async (file) => {
      const content = await readFile(path.join(root, file), 'utf8').catch(() => undefined);
      const secrets = content === undefined ? [] : sandbox.findSecrets(content);
      return secrets.length > 0 ? { file, secrets } : undefined;
    }),
  );
  return found.filter((leak): leak is SecretLeak => leak !== undefined);
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
  // 실행 중 에이전트가 studio.yaml을 바꿨으면(systemPackages·includes 등) 세션이 시작할 때 읽은 project에는 그 선언이
  // 없다. studio.yaml이 바뀐 재시작에서는 다시 읽은 선언으로 소유 판정과 Dockerfile 동기화를 한다. 스키마에 맞지 않으면
  // (도그푸딩 마찰 131) 조용히 옛 project로 넘어가지 않고 specError에 남겨 돌려준다 — verifyChanges가 이걸 보고 게이트를
  // 실패시켜야 에이전트가 같은 실행에서 고친다. 재시작 자체는 옛 project로 최대한 계속 시도한다(서비스를 완전히 멈추지 않게)
  // compose 파일이 바뀌면(studio.yaml과 달리) 서비스 목록 자체가 바뀔 수 있어, 새로 생긴 부가 서비스를
  // 올릴지 판단할 때도 다시 읽은 선언이 필요하다(도그푸딩 마찰 138, ADR-146)
  const composeChanged = files.some((file) => isComposeFile(project, file));
  let declared = project;
  let specError: string | undefined;
  if (files.includes(SPEC_FILE) || composeChanged) {
    try {
      declared = await loadProject(project.root);
    } catch (error) {
      specError = error instanceof SpecError ? error.message : describe(error);
    }
  }
  const owned = servicesForFiles(declared, files);
  const wanted = [...new Set([...owned.services, ...alsoRestart])];
  // 사용자가 서비스 선택(ADR-083)에서 꺼 둔 서비스는 재시작하지 않는다(껐는데 다시 켜 버리면 선택을 무시하는 셈이다).
  // 건너뛴 사실은 검증 보고서에 남겨, 확인하지 않은 서비스를 "검증됨"으로 부풀리지 않게 한다
  const off = project.offServices;
  const services = off ? wanted.filter((service) => !off.has(service)) : wanted;
  const skippedOff = off ? wanted.filter((service) => off.has(service)) : [];
  const unmatched = owned.unmatched;
  const deleted = await deletedFiles(project.root, files);

  // 다시 띄울 서비스의 Dockerfile을 지금 studio.yaml의 systemPackages 선언과 맞춘다(도그푸딩 마찰 113, ADR-137).
  // compose build(아래 restart가 돌리는 `--build`)보다 먼저 해야 이번 빌드에 반영된다
  await syncSystemPackages(declared, services);

  // 파일 공유 캐시 때문에 옛 코드로 재시작하면 틀린 결과를 얻는다. 반영을 먼저 확인한다
  let sync: RestartReport['sync'];
  try {
    sync = { elapsedMs: (await sandbox.sync([...files], { signal: start?.signal })).elapsedMs };
  } catch (error) {
    return { sync: { error: describe(error), ...(isPlatformError(error) ? { platform: true as const } : {}) }, restarted: [], unverifiedFiles: unmatched, skippedOff, specError };
  }

  // compose가 바뀐 재시작에서, 이 세션이 시작할 때는 없던 새 부가 서비스를 이 세션의 compose 프로젝트 안에서
  // 올린다. 사람이 꺼 둔 서비스는 그대로 둔다(도그푸딩 마찰 138, ADR-146)
  const addons = composeChanged ? await ensureNewAddons(sandbox, declared, project.offServices, start?.signal) : undefined;

  const restarted = await Promise.all(
    services.map(async (service): Promise<ServiceCheck> => {
      const first = await restartOnce(sandbox, service, start);
      if (first.ready || !mentionsDeletedFile(first.logTail ?? [], deleted)) return first;

      // 반영 확인이 끝났어도 새로 뜬 서비스 컨테이너 안의 디렉터리 목록에 지운 파일이 잠깐 남을 수 있다.
      // 이때 빌드 도구는 "목록에는 있지만 읽을 수 없는 파일"로 실패하므로 잠시 뒤 한 번만 다시 띄운다 (트러블슈팅 13)
      await sleep(deletedFileRetryDelayMs, undefined, { signal: start?.signal });
      return { ...(await restartOnce(sandbox, service, start)), retried: true };
    }),
  );

  return {
    sync,
    restarted,
    unverifiedFiles: unmatched,
    skippedOff,
    specError,
    ...(addons?.added.length ? { addedAddons: addons.added } : {}),
    ...(addons?.error ? { addonError: addons.error } : {}),
  };
}

/**
 * compose 파일이 바뀐 재시작에서, 이 세션이 시작할 때 몰랐던(그래서 `project.offServices`에 들어갈 기회조차
 * 없었던) 부가 서비스를 올린다. managed가 depends_on으로 기대는지는 보지 않는다 — 에이전트나 사람이 나중에
 * compose에 더한 부가 서비스는 쓰려고 일부러 넣은 것으로 본다(실측: BE-commerce의 mediamtx는 MediaMTX가
 * commerce의 훅을 부르는 반대 방향이라 어느 managed 서비스도 depends_on으로 기대지 않는다 — depends_on 기준
 * 첫 구현은 이 실제 사례를 놓쳤다). `project.offServices`는 세션이 시작할 때(또는 마지막으로 선택을 다시
 * 계산했을 때)의 compose 서비스 전체에서 선택되지 않은 것이므로, 그때 없던 서비스는 애초에 off에 들어갈 수
 * 없다 — 그래서 "off에 없다"만으로 "새로 생겼거나 이미 선택돼 있다"를 가린다(ADR-146).
 *
 * ensureInfra는 없는 컨테이너만 올리므로(이미 떠 있으면 손대지 않는다) 매번 다시 불러도 안전하다.
 * ensureInfra가 없는 제공자(쿠버네티스 등)는 건너뛴다(도그푸딩 마찰 138, ADR-146)
 */
async function ensureNewAddons(
  sandbox: Sandbox,
  declared: LoadedProject,
  off: ReadonlySet<string> | undefined,
  signal?: AbortSignal,
): Promise<{ added: string[]; error?: string }> {
  if (!sandbox.ensureInfra) return { added: [] };
  const managedNames = new Set(declared.managed.map(([name]) => name));
  const addons = declared.composeServices.filter((name) => !managedNames.has(name) && !off?.has(name)).sort();
  if (addons.length === 0) return { added: [] };

  const result = await sandbox.ensureInfra(addons, { signal }).catch((error: unknown): InfraCheckResult => ({ ok: false, recovered: [], reason: describe(error) }));
  return { added: result.recovered, ...(result.ok ? {} : { error: result.reason ?? '알 수 없는 이유' }) };
}

async function restartOnce(sandbox: Sandbox, service: string, start?: StartOptions): Promise<ServiceCheck> {
  const startedAt = new Date();
  try {
    await sandbox.restart(service, start);
    return { service, ready: true };
  } catch (error) {
    // 요청 취소나 세션 중지로 끊긴 재시작은 서비스 실패가 아니다. 로그를 모으지 않고 그대로 던진다
    if (start?.signal?.aborted) throw start.signal.reason;
    // 메모리 부족으로 죽었는지 먼저 알려야 에이전트가 코드를 고치려 들지 않는다
    const usage = (await sandbox.stats().catch(() => [])).find((candidate) => candidate.service === service);
    const logTail = await recentLogs(sandbox, service);
    const blocked = await blockedEgressSince(sandbox, startedAt);
    const extra = blocked.length > 0 ? { blockedEgress: blocked } : {};
    if (usage?.oomKilled) {
      const limit = usage.memoryLimitBytes ? ` (${formatBytes(usage.memoryLimitBytes)})` : '';
      return { service, ready: false, error: `메모리 한도${limit}를 넘어 종료됐습니다. ${describe(error)}`, logTail, oomKilled: true, ...extra };
    }
    return { service, ready: false, error: describe(error), logTail, ...extra, ...(isPlatformError(error) ? { platform: true as const } : {}) };
  }
}

function isPlatformError(error: unknown): boolean {
  return error instanceof SandboxError && error.platform;
}

/** 막힌 외부 접속을 "호스트:포트 (이유)"로 중복 없이 모은다 */
async function blockedEgressSince(sandbox: Sandbox, startedAt: Date): Promise<string[]> {
  // 스튜디오 서버와 Docker VM의 시계가 조금 어긋날 수 있어 여유를 둔다
  const since = new Date(startedAt.getTime() - 5_000);
  const denials = (await sandbox.egressDenials?.({ since }).catch(() => [])) ?? [];
  return [
    ...new Set(
      denials.map((denial) => {
        const target = `${denial.host}${denial.port ? `:${denial.port}` : ''}${denial.path ?? ''}`;
        return `${denial.method ? `${denial.method} ` : ''}${target} (${denial.reason})`;
      }),
    ),
  ];
}

/** 호스트에서 이미 사라진 파일. 되돌리기나 에이전트의 삭제로 생긴다 */
async function deletedFiles(root: string, files: readonly string[]): Promise<string[]> {
  const checks = await Promise.all(
    files.map(async (file) =>
      access(path.join(root, file)).then(
        () => undefined,
        () => file,
      ),
    ),
  );
  return checks.filter((file): file is string => file !== undefined);
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

/** 세션 시작 시점의 계약을 저장해 둔다. 실패한 서비스는 비교 기준 없이 진행한다 */
export async function captureBaselines(
  sandbox: Sandbox,
  project: LoadedProject,
  fetcher: ContractFetcher = fetchContract,
): Promise<Map<string, OpenApiDocument>> {
  const baselines = new Map<string, OpenApiDocument>();
  for (const [name, service] of project.managed) {
    if (!service.contract || project.offServices?.has(name)) continue;
    try {
      const endpoint = await sandbox.endpoint(name);
      baselines.set(name, await fetcher(serviceUrl(service.contract.extract, endpoint.url)));
    } catch {
      // 기준이 없으면 모든 계약 항목이 "추가"로 보인다
    }
  }
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

async function recentLogs(sandbox: Sandbox, service: string): Promise<string[]> {
  const lines: string[] = [];
  try {
    for await (const line of sandbox.logs({ services: [service], tail: 60, follow: false })) lines.push(line.text);
  } catch {
    // 로그를 못 가져와도 검증 결과 자체는 돌려준다
  }
  return lines;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
