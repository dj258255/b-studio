import type { AgentUsage } from '@b-studio/agent';
import type { ServiceUsage } from '@b-studio/sandbox';
import type { LogEntry } from './session-view';

const TOKEN_FORMAT = new Intl.NumberFormat('ko-KR', { notation: 'compact', maximumFractionDigits: 1 });

export function addTokens(base: AgentUsage | undefined, usage: AgentUsage): AgentUsage {
  return {
    inputTokens: (base?.inputTokens ?? 0) + usage.inputTokens,
    outputTokens: (base?.outputTokens ?? 0) + usage.outputTokens,
    cacheReadTokens: (base?.cacheReadTokens ?? 0) + usage.cacheReadTokens,
    cacheWriteTokens: (base?.cacheWriteTokens ?? 0) + usage.cacheWriteTokens,
  };
}

/**
 * 두 합계의 차이. 토큰 이벤트는 실행 누적값을 주므로, 사람 몫에는 지난번에 더한 뒤 늘어난 만큼만 더한다.
 * 모델이 보낸 누적값이 줄어드는 경우(재시도로 세션이 새로 시작되는 등)에는 음수를 더하지 않도록 0으로 둔다
 */
export function subtractTokens(usage: AgentUsage, charged: AgentUsage | undefined): AgentUsage {
  return {
    inputTokens: Math.max(0, usage.inputTokens - (charged?.inputTokens ?? 0)),
    outputTokens: Math.max(0, usage.outputTokens - (charged?.outputTokens ?? 0)),
    cacheReadTokens: Math.max(0, usage.cacheReadTokens - (charged?.cacheReadTokens ?? 0)),
    cacheWriteTokens: Math.max(0, usage.cacheWriteTokens - (charged?.cacheWriteTokens ?? 0)),
  };
}

/** 스크립트 모델(데모 모드)은 토큰을 쓰지 않는다 */
export function hasTokens(usage: AgentUsage | undefined): usage is AgentUsage {
  return Boolean(usage && usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens > 0);
}

/** 화면에 보이는 네 값의 합. 세션 토큰 한도는 이 값으로 잰다 */
export function totalTokens(usage: AgentUsage | undefined): number {
  return usage ? usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens : 0;
}

/** B_STUDIO_SESSION_TOKEN_LIMIT 값. 비우면 한도가 없고, 오타가 조용히 "한도 없음"이 되지 않도록 양의 정수가 아니면 던진다 */
export function parseTokenLimit(value: string | undefined): number | undefined {
  return parsePositiveInteger(value, 'B_STUDIO_SESSION_TOKEN_LIMIT');
}

/** B_STUDIO_USER_TOKEN_LIMIT 값. 세션이 아니라 사람 한 명이 한 기간에 쓸 수 있는 양이다 */
export function parseUserTokenLimit(value: string | undefined): number | undefined {
  return parsePositiveInteger(value, 'B_STUDIO_USER_TOKEN_LIMIT');
}

function parsePositiveInteger(value: string | undefined, name: string): number | undefined {
  const text = value?.trim().replaceAll('_', '');
  if (!text) return undefined;
  if (!/^\d+$/.test(text) || Number(text) <= 0) throw new Error(`${name}는 양의 정수여야 합니다 (지금 값: ${value})`);
  return Number(text);
}

/** 사람별 한도를 다시 세는 주기 */
export type UsageWindow = 'day' | 'month';

/** B_STUDIO_USER_TOKEN_WINDOW 값. 비우면 하루 단위로 다시 센다 */
export function parseUsageWindow(value: string | undefined): UsageWindow {
  const text = value?.trim().toLowerCase();
  if (!text) return 'day';
  if (text !== 'day' && text !== 'month') throw new Error(`B_STUDIO_USER_TOKEN_WINDOW는 day 또는 month여야 합니다 (지금 값: ${value})`);
  return text;
}

/**
 * 사용량을 모아 두는 기간의 이름. 서버가 있는 곳의 날짜로 끊어, 운영자가 화면에서 보는 날짜와 같게 한다.
 * day는 2026-09-12, month는 2026-09
 */
export function periodKey(window: UsageWindow, at: Date = new Date()): string {
  const year = at.getFullYear();
  const month = String(at.getMonth() + 1).padStart(2, '0');
  return window === 'month' ? `${year}-${month}` : `${year}-${month}-${String(at.getDate()).padStart(2, '0')}`;
}

/** 사람별 한도를 알릴 때 쓰는 기간 이름 */
export function describeWindow(window: UsageWindow): string {
  return window === 'month' ? '이번 달' : '오늘';
}

export function formatTokenCount(count: number): string {
  return TOKEN_FORMAT.format(count);
}

/** 캐시는 쓴 경우에만 붙인다 */
export function describeTokens(usage: AgentUsage): string {
  const parts = [`입력 ${TOKEN_FORMAT.format(usage.inputTokens)}`, `출력 ${TOKEN_FORMAT.format(usage.outputTokens)}`];
  if (usage.cacheReadTokens > 0) parts.push(`캐시 읽기 ${TOKEN_FORMAT.format(usage.cacheReadTokens)}`);
  if (usage.cacheWriteTokens > 0) parts.push(`캐시 쓰기 ${TOKEN_FORMAT.format(usage.cacheWriteTokens)}`);
  return `${parts.join(', ')} 토큰`;
}

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
