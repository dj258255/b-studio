import type { ServiceUsage } from '@b-studio/sandbox';
import type { LogEntry } from './session-view';

/** 샌드박스 패키지는 서버 전용 모듈을 불러오므로 화면용 표기를 따로 둔다 */
export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined) return '-';
  if (bytes >= 1_024 ** 3) return `${(bytes / 1_024 ** 3).toFixed(2)}GiB`;
  if (bytes >= 1_024 ** 2) return `${Math.round(bytes / 1_024 ** 2)}MiB`;
  return `${Math.round(bytes / 1_024)}KiB`;
}

/** 한도 대비 사용률 (0~1). 한도가 없으면 undefined */
export function memoryRatio(usage: ServiceUsage): number | undefined {
  if (!usage.memoryBytes || !usage.memoryLimitBytes) return undefined;
  return Math.min(1, usage.memoryBytes / usage.memoryLimitBytes);
}

export function endedReason(usage: ServiceUsage): string | undefined {
  if (usage.exitCode === undefined) return undefined;
  if (usage.oomKilled) return `메모리 한도를 넘어 종료 (종료 코드 ${usage.exitCode})`;
  if (usage.exitCode === 137) return '강제 종료 (종료 코드 137, 메모리 부족일 수 있음)';
  return `종료 코드 ${usage.exitCode}`;
}

/** 로그 한 줄이 알려 주는 단계. 나중에 나온 줄이 지금 단계다 */
const PHASES: Array<[RegExp, (match: RegExpExecArray) => string]> = [
  [/BUILD FAILED/, () => '빌드 실패'],
  [/Started \w+ in [\d.]+ seconds/, () => '앱 기동 완료'],
  [/> Task :(\S+)/, (match) => `Gradle ${match[1]}`],
  [/single-use Daemon process will be forked|Starting a Gradle Daemon/, () => 'Gradle 시작'],
  [/Done in [\d.]+m?s using pnpm/, () => '의존성 설치 완료'],
  [/Progress: resolved|Packages: [+-]|Lockfile is up to date/, () => '의존성 설치 중'],
  [/Compiling/, () => '컴파일 중'],
  [/Ready in [\d.]+m?s/, () => '개발 서버 준비'],
  [/database system is ready to accept connections/, () => 'DB 연결 받는 중'],
];

export function currentPhase(logs: readonly LogEntry[], service: string, lookback = 300): string | undefined {
  let checked = 0;
  for (let index = logs.length - 1; index >= 0 && checked < lookback; index--) {
    const entry = logs[index]!;
    if (entry.service !== service) continue;
    checked++;
    for (const [pattern, label] of PHASES) {
      const match = pattern.exec(entry.text);
      if (match) return label(match);
    }
  }
  return undefined;
}
