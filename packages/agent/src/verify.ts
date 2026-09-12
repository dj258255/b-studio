import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { formatBytes, type Sandbox, type StartOptions } from '@b-studio/sandbox';
import type { LoadedProject } from '@b-studio/spec';
import { diffContracts, formatContractChanges, type ContractChange, type OpenApiDocument } from './contract-diff';
import { servicesForFiles } from './services';

export type ContractFetcher = (url: string) => Promise<OpenApiDocument>;

export const fetchContract: ContractFetcher = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(15_000) });
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
}

export interface ContractCheck {
  service: string;
  changes: ContractChange[];
  error?: string;
}

export interface VerificationReport {
  ok: boolean;
  /** 재시작 전에 샌드박스가 바뀐 파일을 보게 될 때까지 기다린 결과 */
  sync: { elapsedMs: number } | { error: string };
  restarted: ServiceCheck[];
  contracts: ContractCheck[];
  /** 서비스에 속하지 않아 재시작으로 확인할 수 없는 파일 */
  unverifiedFiles: string[];
  /** 시크릿 값이 들어간 바뀐 파일. 체크포인트로 커밋되지 않게 게이트를 실패시킨다 */
  secretLeaks: SecretLeak[];
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
}

/**
 * 에이전트가 작업을 끝냈다고 할 때 스튜디오가 직접 수행하는 검증.
 * 모델에게 "검증하라"고 부탁하는 대신 플랫폼이 강제한다.
 *  1. 바뀐 파일이 속한 서비스를 다시 띄우고 준비 판정을 통과하는지
 *  2. 계약을 다시 추출해 세션 시작 시점과 비교했을 때 호환을 깨지 않는지
 */
export async function verifyChanges(options: VerifyOptions): Promise<VerificationReport> {
  const { sandbox, project, changedFiles, baselines, allowBreaking, fetcher = fetchContract, start } = options;
  const secretLeaks = await findSecretLeaks(sandbox, project.root, changedFiles);
  const { sync, restarted, unverifiedFiles } = await restartServicesFor(sandbox, project, changedFiles, start);
  if ('error' in sync) return { ok: false, sync, restarted, contracts: [], unverifiedFiles, secretLeaks };

  // 재시작에 실패한 서비스의 계약은 뽑을 수 없으므로 준비된 서비스만 비교한다
  const failed = new Set(restarted.filter((check) => !check.ready).map((check) => check.service));
  const contractServices = project.managed.filter(([name, service]) => service.contract && !failed.has(name));

  const contracts = await Promise.all(
    contractServices.map(async ([name, service]): Promise<ContractCheck> => {
      try {
        const endpoint = await sandbox.endpoint(name);
        const current = await fetcher(new URL(service.contract!.extract, endpoint.url).toString());
        return { service: name, changes: diffContracts(baselines.get(name), current) };
      } catch (error) {
        return { service: name, changes: [], error: describe(error) };
      }
    }),
  );

  const breaking = contracts.some((check) => check.changes.some((change) => change.breaking));
  const ok =
    restarted.every((check) => check.ready) &&
    contracts.every((check) => !check.error) &&
    (allowBreaking || !breaking) &&
    secretLeaks.length === 0;

  return { ok, sync, restarted, contracts, unverifiedFiles, secretLeaks };
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
  const owned = servicesForFiles(project, files);
  const services = [...new Set([...owned.services, ...alsoRestart])];
  const unmatched = owned.unmatched;
  const deleted = await deletedFiles(project.root, files);

  // 파일 공유 캐시 때문에 옛 코드로 재시작하면 틀린 결과를 얻는다. 반영을 먼저 확인한다
  let sync: RestartReport['sync'];
  try {
    sync = { elapsedMs: (await sandbox.sync([...files], { signal: start?.signal })).elapsedMs };
  } catch (error) {
    return { sync: { error: describe(error) }, restarted: [], unverifiedFiles: unmatched };
  }

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

  return { sync, restarted, unverifiedFiles: unmatched };
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
    return { service, ready: false, error: describe(error), logTail, ...extra };
  }
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

/** 로그에 지운 파일이 "없다"는 오류로 나오는지 */
export function mentionsDeletedFile(logTail: readonly string[], deleted: readonly string[]): boolean {
  return deleted.some((file) => {
    const name = path.posix.basename(file);
    return logTail.some((line) => line.includes(name) && /NoSuchFile|No such file/i.test(line));
  });
}

/** 세션 시작 시점의 계약을 저장해 둔다. 실패한 서비스는 비교 기준 없이 진행한다 */
export async function captureBaselines(
  sandbox: Sandbox,
  project: LoadedProject,
  fetcher: ContractFetcher = fetchContract,
): Promise<Map<string, OpenApiDocument>> {
  const baselines = new Map<string, OpenApiDocument>();
  for (const [name, service] of project.managed) {
    if (!service.contract) continue;
    try {
      const endpoint = await sandbox.endpoint(name);
      baselines.set(name, await fetcher(new URL(service.contract.extract, endpoint.url).toString()));
    } catch {
      // 기준이 없으면 모든 계약 항목이 "추가"로 보인다
    }
  }
  return baselines;
}

export function formatVerificationReport(report: VerificationReport, { allowBreaking }: { allowBreaking: boolean }): string {
  const lines: string[] = [report.ok ? '검증 통과' : '검증 실패'];

  if ('error' in report.sync) {
    lines.push(`- 샌드박스 파일 반영 확인 실패: ${report.sync.error}`);
    return lines.join('\n');
  }
  lines.push(`- 샌드박스 파일 반영 확인: ${(report.sync.elapsedMs / 1_000).toFixed(1)}초`);

  if (report.restarted.length === 0) lines.push('- 재시작한 서비스 없음');
  for (const check of report.restarted) {
    const retried = check.retried ? ' (지운 파일 반영을 기다려 한 번 더 재시작)' : '';
    lines.push(check.ready ? `- ${check.service}: 재시작 후 준비 완료${retried}` : `- ${check.service}: 준비 실패${retried} — ${check.error}`);
    if (check.blockedEgress?.length) {
      lines.push(`  막힌 외부 접속 (studio.yaml network.egress에 없는 호스트): ${check.blockedEgress.join(', ')}`);
    }
    if (check.logTail?.length) lines.push('  마지막 로그:', ...check.logTail.map((line) => `    ${line}`));
  }

  for (const check of report.contracts) {
    if (check.error) {
      lines.push(`- ${check.service} 계약 추출 실패: ${check.error}`);
      continue;
    }
    lines.push(`- ${check.service} 계약:`, ...formatContractChanges(check.changes).split('\n').map((line) => `    ${line}`));
    if (!allowBreaking && check.changes.some((change) => change.breaking)) {
      lines.push('    요청에 삭제·변경이 명시되지 않았으므로 호환을 깨는 변경은 허용되지 않습니다.');
    }
  }

  if (report.unverifiedFiles.length > 0) {
    lines.push(`- 재시작으로 확인하지 못한 파일: ${report.unverifiedFiles.join(', ')}`);
  }
  for (const leak of report.secretLeaks) {
    lines.push(`- 시크릿 값이 파일에 들어갔습니다: ${leak.file} (${leak.secrets.join(', ')}). 값은 코드에서 환경 변수로 읽고 파일에 쓰지 마세요`);
  }
  return lines.join('\n');
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
