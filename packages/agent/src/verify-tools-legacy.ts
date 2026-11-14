// 차등 시험의 기준: ADR-191 3단계 3u에서 Rust로 옮기기 전의 TS 구현을 그대로 복사한 것이다(verify.ts의 ok 계산·platformFailureOf·mentionsDeletedFile·formatVerificationReport,
// tools.ts의 입력 검사·서비스 허용 목록·summarizeApproval·createMismatchLog·httpRequest의 경로·origin 확인).
// 고치지 않는다. 시험(verify-tools-differential.test.ts 등)만 불러 쓰고 제품 코드는 불러 쓰지 않는다.
import path from 'node:path';
import { SPEC_FILE } from '@b-studio/spec';
import { formatContractChanges, type ContractChange } from './contract-diff';

// ════ verify.ts ════

export interface LegacyServiceCheck {
  service: string;
  ready: boolean;
  error?: string;
  logTail?: string[];
  retried?: boolean;
  blockedEgress?: string[];
  platform?: true;
}

export interface LegacyContractCheck {
  service: string;
  changes: ContractChange[];
  error?: string;
}

export type LegacySync = { elapsedMs: number } | { error: string; platform?: true };

export interface LegacyReport {
  ok: boolean;
  sync: LegacySync;
  restarted: LegacyServiceCheck[];
  platformFailure?: string;
  contracts: LegacyContractCheck[];
  unverifiedFiles: string[];
  secretLeaks: Array<{ file: string; secrets: string[] }>;
  skippedOff: string[];
  specError?: string;
  addedAddons?: string[];
  addonError?: string;
}

/** verifyChanges 안의 ok 계산 */
export function legacyVerifyOk(
  restarted: readonly LegacyServiceCheck[],
  contracts: readonly LegacyContractCheck[],
  allowBreaking: boolean,
  secretLeaks: readonly unknown[],
  specError: string | undefined,
): boolean {
  const breaking = contracts.some((check) => check.changes.some((change) => change.breaking));
  return (
    restarted.every((check) => check.ready) &&
    contracts.every((check) => !check.error) &&
    (allowBreaking || !breaking) &&
    secretLeaks.length === 0 &&
    specError === undefined
  );
}

export function legacyPlatformFailureOf(sync: LegacySync, restarted: readonly LegacyServiceCheck[]): string | undefined {
  if ('error' in sync && sync.platform) return sync.error.split('\n')[0];
  const failed = restarted.find((check) => !check.ready && check.platform);
  return failed ? `${failed.service}: ${(failed.error ?? '').split('\n')[0]}` : undefined;
}

export function legacyMentionsDeletedFile(logTail: readonly string[], deleted: readonly string[]): boolean {
  return deleted.some((file) => {
    const name = path.posix.basename(file);
    return logTail.some((line) => line.includes(name) && /NoSuchFile|No such file/i.test(line));
  });
}

export function legacyFormatVerificationReport(report: LegacyReport, { allowBreaking }: { allowBreaking: boolean }): string {
  const lines: string[] = [report.ok ? '검증 통과' : '검증 실패'];
  if (report.platformFailure) {
    lines.push(`- b-studio 쪽(샌드박스·도커) 문제로 검증을 끝내지 못했습니다. 바꾼 코드의 문제가 아니므로 코드를 고쳐서 풀려고 하지 마세요: ${report.platformFailure}`);
  }

  if (report.specError) {
    lines.push(`- ${SPEC_FILE} 형식이 올바르지 않아 이전 설정으로 재시작했습니다:`, ...report.specError.split('\n').map((line) => `    ${line}`));
  }

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
      lines.push('    이 요청은 호환을 깨는 변경을 허용하지 않았습니다(허용은 사람이 요청할 때 켭니다). 의도하지 않은 변경이면 되돌리고, 사람이 요청한 변경이면 되돌리지 말고 그 사실을 알리세요.');
    }
  }

  if (report.unverifiedFiles.length > 0) {
    lines.push(`- 재시작으로 확인하지 못한 파일: ${report.unverifiedFiles.join(', ')}`);
  }
  if (report.skippedOff.length > 0) {
    lines.push(`- 꺼 둔 서비스라 확인을 건너뜀(검증에 포함되지 않음): ${report.skippedOff.join(', ')}`);
  }
  if (report.addedAddons?.length) {
    lines.push(`- compose에 새로 생긴 부가 서비스를 켰습니다(끄려면 서비스 메뉴에서): ${report.addedAddons.join(', ')}`);
  }
  if (report.addonError) {
    lines.push(`- 새로 생긴 부가 서비스를 올리지 못했습니다: ${report.addonError}`);
  }
  for (const leak of report.secretLeaks) {
    lines.push(`- 시크릿 값이 파일에 들어갔습니다: ${leak.file} (${leak.secrets.join(', ')}). 값은 코드에서 환경 변수로 읽고 파일에 쓰지 마세요`);
  }
  return lines.join('\n');
}

// ════ tools.ts ════

export class LegacyToolInputError extends Error {}

export function legacyAsRecord(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new LegacyToolInputError('Tool input must be an object');
  return input as Record<string, unknown>;
}

export function legacyString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string') throw new LegacyToolInputError(`"${key}" must be a string`);
  return value;
}

export function legacyInteger(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) throw new LegacyToolInputError(`"${key}" must be an integer`);
  return value;
}

export function legacyBoolean(args: Record<string, unknown>, key: string): boolean {
  const value = args[key];
  if (typeof value !== 'boolean') throw new LegacyToolInputError(`"${key}" must be a boolean`);
  return value;
}

export function legacyStringArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value) || value.length === 0 || !value.every((item) => typeof item === 'string')) {
    throw new LegacyToolInputError(`"${key}" must be a non-empty array of strings`);
  }
  return value;
}

export function legacyOptionalStringArray(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string')) throw new LegacyToolInputError(`"${key}" must be an array of strings`);
  return value;
}

export function legacyClamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

interface LegacyProject {
  managed: ReadonlyArray<readonly [string, unknown]>;
  composeServices?: string[];
}

export function legacyServiceName({ project }: { project: LegacyProject }, args: Record<string, unknown>): string {
  const name = legacyString(args, 'service');
  if (!project.managed.some(([serviceKey]) => serviceKey === name)) throw new LegacyToolInputError(`Unknown service: ${name}`);
  return name;
}

export function legacyComposeServiceNames(project: LegacyProject): string[] {
  return project.composeServices ?? project.managed.map(([name]) => name);
}

export function legacyServiceOrAddonName({ project }: { project: LegacyProject }, args: Record<string, unknown>): string {
  const name = legacyString(args, 'service');
  if (!legacyComposeServiceNames(project).includes(name)) throw new LegacyToolInputError(`Unknown service: ${name}`);
  return name;
}

export function legacySummarizeApproval(name: string, input: unknown): string {
  if (name === 'run_in_service' && typeof input === 'object' && input !== null) {
    const args = input as Record<string, unknown>;
    const service = typeof args.service === 'string' ? args.service : 'unknown service';
    const command = Array.isArray(args.command) ? args.command.filter((value): value is string => typeof value === 'string').join(' ') : '';
    return `run ${command} in ${service}`;
  }
  if ((name === 'write_file' || name === 'edit_file' || name === 'delete_file') && typeof input === 'object' && input !== null) {
    const file = (input as Record<string, unknown>).path;
    return `${name} ${typeof file === 'string' ? file : 'a file'}`;
  }
  return name;
}

export interface LegacyMismatch {
  requestValue: string;
  checkValue: string;
  followed: 'request' | 'check' | 'neither';
  note: string;
}

const MISMATCHES_PER_RUN = 5;

export function legacyCreateMismatchLog(): { list: LegacyMismatch[]; add: (mismatch: LegacyMismatch) => boolean } {
  const list: LegacyMismatch[] = [];
  return {
    list,
    add(mismatch) {
      if (list.length >= MISMATCHES_PER_RUN) return false;
      if (list.some((seen) => seen.requestValue === mismatch.requestValue && seen.checkValue === mismatch.checkValue && seen.followed === mismatch.followed)) return false;
      list.push(mismatch);
      return true;
    },
  };
}

/** httpRequest의 경로 확인: 실패하면 오류 글, 아니면 undefined */
export function legacyHttpPathError(requestPath: string): string | undefined {
  return requestPath.startsWith('/') ? undefined : 'path must start with "/"';
}

/** httpRequest의 origin 확인: 실패하면 오류 글, 아니면 undefined */
export function legacyHttpOriginError(requestPath: string, endpointUrl: string): string | undefined {
  const url = new URL(requestPath, endpointUrl);
  return url.origin !== new URL(endpointUrl).origin ? 'path must stay on the service host' : undefined;
}
