import { SandboxError } from './errors';
import { native } from './native';
import type { ProbeResult } from './types';

export interface ReadinessPolicy {
  /** 연속으로 몇 번 성공해야 준비됐다고 볼지 */
  successThreshold: number;
  /** 기동 시작부터 이 시간이 지나도 준비되지 않으면 실패 */
  timeoutMs: number;
  /** 확인 간격 */
  intervalMs: number;
}

export const DEFAULT_READINESS: ReadinessPolicy = {
  successThreshold: 2,
  timeoutMs: 180_000,
  intervalMs: 1_000,
};

export type ReadinessDecision = { kind: 'ready' } | { kind: 'waiting' } | { kind: 'failed'; reason: string };

/**
 * 지금까지의 확인 기록을 보고 서비스가 준비됐는지 판단한다.
 *
 * @param history 오래된 것부터 최신 순서의 확인 기록 (최소 1개)
 * @param policy 서비스별 준비 정책
 * @param elapsedMs 기동을 시작한 뒤 지난 시간
 */
/** 확인 기록을 보고 준비 여부를 판단한다. 판정은 Rust(`crates/bstudio-guard/src/readiness.rs`)에 있다 */
export function decideReadiness(history: readonly ProbeResult[], policy: ReadinessPolicy, elapsedMs: number): ReadinessDecision {
  return JSON.parse(native.decideReadiness(JSON.stringify(history), JSON.stringify(policy), elapsedMs)) as ReadinessDecision;
}

export class ReadinessError extends SandboxError {
  readonly history: readonly ProbeResult[];

  constructor(reason: string, history: readonly ProbeResult[]) {
    super(reason);
    this.name = 'ReadinessError';
    this.history = history;
  }
}

/**
 * 죽은 컨테이너의 마지막 로그 줄(보통 {@link crashLogExcerpt}의 결과)에 알려진 일시 오류(ETXTBSY·EBUSY, 트러블슈팅 #90)가
 * 있는지 본다. colima(virtiofs) 공유 폴더에서 설치 직후 바이너리를 바로 실행하다 생기는 일시 오류다 — 판정은 Rust에 있다
 */
export function isTransientBootError(lines: readonly string[]): boolean {
  return native.isTransientBootError([...lines]);
}

/**
 * 이번 기동 시도에서 컨테이너를 한 번 더 띄워 볼지 정한다. attempt는 1부터 시작하고, 1번째 시도가 일시 오류로 죽었을 때만
 * 재시도한다(무한 재시도 금지, 트러블슈팅 #90)
 */
export function shouldRetryTransientCrash(attempt: number, excerpt: readonly string[]): boolean {
  return native.shouldRetryTransientCrash(attempt, [...excerpt]);
}

/**
 * 죽은 컨테이너의 마지막 로그에서 원인을 보여 줄 줄을 고른다(최대 `max`줄, 오래된 것부터). 판정은 Rust에 있다.
 * 오류다운 줄이 없으면 마지막 몇 줄을 그대로 쓴다. "UND_ERR_SOCKET" 같은 연결 오류 대신 앱이 왜 죽었는지 보이려는 것이다
 */
export function crashLogExcerpt(lines: readonly string[], max = 6): string[] {
  return native.crashLogExcerpt([...lines], max);
}
