/**
 * 게이트 검증의 조율(순서·재시도·결과 조립)을 Rust로 옮기기 전(ADR-195 4f A5a) `verify.ts`의 `verifyChanges`·`restartServicesFor`·`captureBaselines`·`findSecretLeaks`를 그대로 둔 것이다.
 * 차등 시험(`verify-differential.test.ts`)이 같은 입력을 이 옛 구현과 지금 구현에 넣어 콜백 호출 순서·결과·오류 글을 견준다. 제품 코드는 이 파일을 쓰지 않는다. 지우지 않는다(4g에서 함께 지운다).
 * 바뀌지 않은 보조(`serviceUrl`·`fetchContract`·`platformFailureOf`·`mentionsDeletedFile`·타입)는 `verify.ts`에서 가져온다.
 */
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { formatBytes, native, SandboxError, type InfraCheckResult, type Sandbox, type StartOptions } from '@b-studio/sandbox';
import { loadProject, SpecError, SPEC_FILE, type LoadedProject } from '@b-studio/spec';
import { diffContracts, type OpenApiDocument } from './contract-diff';
import { isComposeFile, servicesForFiles } from './services';
import { syncSystemPackages } from './system-packages-sync';
import { fetchContract, mentionsDeletedFile, platformFailureOf, serviceUrl, type ContractCheck, type ContractFetcher, type RestartOptions, type RestartReport, type SecretLeak, type ServiceCheck, type VerificationReport, type VerifyOptions } from './verify';

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
