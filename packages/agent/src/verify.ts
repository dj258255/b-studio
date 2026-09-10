import type { Sandbox, StartOptions } from '@b-studio/sandbox';
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
  const { sync, restarted, unverifiedFiles } = await restartServicesFor(sandbox, project, changedFiles, start);
  if ('error' in sync) return { ok: false, sync, restarted, contracts: [], unverifiedFiles };

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
    (allowBreaking || !breaking);

  return { ok, sync, restarted, contracts, unverifiedFiles };
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
export async function restartServicesFor(
  sandbox: Sandbox,
  project: LoadedProject,
  files: readonly string[],
  start?: StartOptions,
): Promise<RestartReport> {
  const { services, unmatched } = servicesForFiles(project, files);

  // 파일 공유 캐시 때문에 옛 코드로 재시작하면 틀린 결과를 얻는다. 반영을 먼저 확인한다
  let sync: RestartReport['sync'];
  try {
    sync = { elapsedMs: (await sandbox.sync([...files], { signal: start?.signal })).elapsedMs };
  } catch (error) {
    return { sync: { error: describe(error) }, restarted: [], unverifiedFiles: unmatched };
  }

  const restarted = await Promise.all(
    services.map(async (service): Promise<ServiceCheck> => {
      try {
        await sandbox.restart(service, start);
        return { service, ready: true };
      } catch (error) {
        return { service, ready: false, error: describe(error), logTail: await recentLogs(sandbox, service) };
      }
    }),
  );

  return { sync, restarted, unverifiedFiles: unmatched };
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
    lines.push(check.ready ? `- ${check.service}: 재시작 후 준비 완료` : `- ${check.service}: 준비 실패 — ${check.error}`);
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
