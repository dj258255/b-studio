import { setTimeout as sleep } from 'node:timers/promises';
import { SandboxError } from './errors';
import type { ContainerState, ProbeResult } from './types';

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
export function decideReadiness(
  history: readonly ProbeResult[],
  policy: ReadinessPolicy,
  elapsedMs: number,
): ReadinessDecision {
  const latest = history.at(-1);
  if (!latest) return { kind: 'waiting' };

  // 프로세스가 죽었으면 타임아웃까지 기다릴 이유가 없다. 에이전트가 몇 초 만에 에러를 받아 고칠 수 있게 한다
  if (latest.containerState === 'exited' || latest.containerState === 'dead') {
    return { kind: 'failed', reason: `앱이 켜지다가 종료됐습니다 (컨테이너 ${latest.containerState})` };
  }

  // 기동 직후 잠깐 성공했다가 흔들리는 경우를 걸러내기 위해 연속 성공만 센다
  let streak = 0;
  for (let i = history.length - 1; i >= 0 && history[i]?.ok; i--) streak++;
  if (streak >= policy.successThreshold) return { kind: 'ready' };

  // 연결 거부나 503은 기동 중에 흔한 상태라 타임아웃 전까지는 기다린다
  if (elapsedMs >= policy.timeoutMs) {
    const seconds = Math.round(policy.timeoutMs / 1_000);
    return { kind: 'failed', reason: `${seconds}초 안에 준비되지 않았습니다 (마지막 확인: ${describeProbe(latest)})` };
  }

  return { kind: 'waiting' };
}

function describeProbe(probe: ProbeResult): string {
  const http = probe.error ?? `HTTP ${probe.status}`;
  return `${http}, 컨테이너 ${probe.containerState}`;
}

export class ReadinessError extends SandboxError {
  readonly history: readonly ProbeResult[];

  constructor(reason: string, history: readonly ProbeResult[]) {
    super(reason);
    this.name = 'ReadinessError';
    this.history = history;
  }
}

export interface WaitForReadyOptions {
  url: string;
  expectStatus: number;
  policy: ReadinessPolicy;
  getContainerState: () => Promise<ContainerState>;
  signal?: AbortSignal;
  onProbe?: (probe: ProbeResult) => void;
}

export async function waitForReady(options: WaitForReadyOptions): Promise<void> {
  const startedAt = Date.now();
  const history: ProbeResult[] = [];

  for (;;) {
    options.signal?.throwIfAborted();
    const probe = await probeOnce(options);
    history.push(probe);
    options.onProbe?.(probe);

    const decision = decideReadiness(history, options.policy, Date.now() - startedAt);
    if (decision.kind === 'ready') return;
    if (decision.kind === 'failed') throw new ReadinessError(decision.reason, history);

    await sleep(options.policy.intervalMs, undefined, { signal: options.signal });
  }
}

async function probeOnce({ url, expectStatus, policy, getContainerState }: WaitForReadyOptions): Promise<ProbeResult> {
  const [containerState, http] = await Promise.all([
    getContainerState().catch((): ContainerState => 'unknown'),
    fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(Math.max(policy.intervalMs, 2_000)) }).then(
      async (response) => {
        await response.body?.cancel();
        return { status: response.status };
      },
      (error: unknown) => ({ error: describeFetchError(error) }),
    ),
  ]);

  return {
    at: Date.now(),
    ok: 'status' in http && http.status === expectStatus,
    ...http,
    containerState,
  };
}

function describeFetchError(error: unknown): string {
  // AbortSignal.timeout은 DOMException(TimeoutError)으로 끝난다. 첫 요청 컴파일이 느린 Next dev에서 흔하다
  if ((error as { name?: unknown } | null)?.name === 'TimeoutError') return 'TIMEOUT';
  if (!(error instanceof Error)) return String(error);
  const code = (error.cause as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? code : error.message;
}

/** 오류를 알려 주는 줄. 스택 프레임(`at …`)과 평범한 INFO 줄은 빼고 원인이 적힌 줄을 고른다 */
const CRASH_SIGNAL = /exception|error|fail|fatal|denied|forbidden|refused|not found|no such|cannot|unable|panic|traceback|killed|out of memory|\b[45]\d\d\b/i;
const STACK_FRAME = /^\s*(at |\.\.\. \d+ more|File ".*", line \d+)/;

/**
 * 죽은 컨테이너의 마지막 로그에서 원인을 보여 줄 줄을 고른다(최대 `max`줄, 오래된 것부터).
 * 오류다운 줄이 없으면 마지막 몇 줄을 그대로 쓴다. "UND_ERR_SOCKET" 같은 연결 오류 대신 앱이 왜 죽었는지 보이려는 것이다
 * (Gradle 래퍼가 프록시 403으로 죽었는데 화면에는 소켓 오류만 보였다)
 */
export function crashLogExcerpt(lines: readonly string[], max = 6): string[] {
  const cleaned = lines.map((line) => line.replace(/\s+$/, '')).filter((line) => line.trim() !== '');
  const signals = cleaned.filter((line) => !STACK_FRAME.test(line) && CRASH_SIGNAL.test(line));
  const picked = (signals.length > 0 ? signals : cleaned).slice(-max);
  return picked.map((line) => (line.length > 300 ? `${line.slice(0, 300)}…` : line));
}
