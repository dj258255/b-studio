import { native } from '@b-studio/sandbox';
import type { ApiRequestUsage } from './terminal-telemetry';

/**
 * 세션 터미널의 텔레메트리 본문 해석과 턴 상한 전이(ADR-216, 4f B5b). 판정은 Rust `crates/bstudio-session`의
 * `terminal::telemetry`·`terminal::limit`가 한다(순수 함수). 여기는 본문과 사실을 코어에 넘기고 결과를 TS 값으로 돌려주는 껍데기다.
 * 옛 판정(`session-terminal-telemetry-legacy.ts`)은 #1347에서 지웠다.
 * 서브에이전트 신호(`agentSignalsFromOtlp`)는 화면의 에이전트 내역에만 쓰고 한도에 닿지 않아 `terminal-telemetry.ts`에 남긴다.
 *
 * 막는 검사의 입력이다. 덜 세는 쪽이 여는 쪽이라, 코어가 알아보지 못한 값은 센다/확인할 수 없음으로 읽는다.
 * 부르는 자리마다 막는 쪽인지 여는 쪽인지:
 * - `modelCallsFromOtlp`: 모델 호출 수(턴 상한)와 토큰(토큰 한도)의 입력이다. 덜 세는 것이 여는 쪽이다. 읽지 못한 호출은 세고(`tokensComplete: false`),
 *   건너뛴 자리는 `defects`로 센다. 본문을 코어에 넘기지 못하면(직렬화 실패) 읽지 못한 것으로 센다
 * - `decideTurnLimit`: 사유가 풀리거나 turn을 건너뛰는 것이 여는 쪽이다. 알아보지 못한 사유는 턴 상한으로 읽는다
 * - `usageUnverifiable`: 확인하지 못한다고 답하는 것은 막는 쪽이다. 알아보지 못한 답은 없다(참/거짓뿐)
 */

/** 모델 호출 하나. `at`은 받은 시각을 기준으로 믿을 수 있는 값이다(엉뚱한 시각은 받은 시각으로 바뀌어 있다) */
export interface ModelCall extends ApiRequestUsage {
  /** 네 토큰 수를 모두 읽었다. 아니면 읽은 것만 더해졌고 나머지는 0이다 */
  tokensComplete: boolean;
  /** 시각을 어디서 얻었나: cli·observed·received·received_off_clock */
  timeSource: string;
}

export interface ModelCalls {
  calls: ModelCall[];
  /** 읽지 못하고 건너뛴 자리의 수(그 안의 모델 호출은 알 수 없다) */
  defects: number;
}

/** 본문에서 모델 호출을 꺼낸다. `now`는 받은 시각(ms)이다 */
export function modelCallsFromOtlp(body: unknown, now: number = Date.now()): ModelCalls {
  let text: string | undefined;
  try {
    text = JSON.stringify(body);
  } catch {
    text = undefined;
  }
  // 직렬화하지 못한 본문은 그 안에 모델 호출이 있었는지 알 수 없다: 읽지 못한 것으로 센다
  if (text === undefined) return { calls: [], defects: 1 };
  const parsed = native.terminalParseTelemetry(text, now);
  return {
    defects: parsed.defects,
    calls: parsed.calls.map((call) => ({
      at: call.at,
      model: call.model,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      cacheReadTokens: call.cacheReadTokens,
      cacheWriteTokens: call.cacheWriteTokens,
      tokensComplete: call.tokensComplete,
      timeSource: call.timeSource,
      ...(call.requestId ? { requestId: call.requestId } : {}),
      ...(call.promptId ? { promptId: call.promptId } : {}),
      ...(call.sessionId ? { sessionId: call.sessionId } : {}),
      ...(call.costUsd != null ? { costUsd: call.costUsd } : {}),
      ...(call.durationMs != null ? { durationMs: call.durationMs } : {}),
      ...(call.agent ? { agent: call.agent } : {}),
      ...(call.conversationId ? { conversationId: call.conversationId } : {}),
    })),
  };
}

export type TerminalLimitReason = 'max_turns' | 'budget';

export interface TurnLimitFacts {
  /** 지금까지 선 사유 */
  reason: TerminalLimitReason | undefined;
  /** 턴 상한(`workflow.maxTurns`). 없으면 턴을 보지 않는다 */
  maxTurns: number | undefined;
  /** 이 실행에 붙은 모델 호출 수 */
  modelCalls: number;
  /** 실행이 이미 멈추는 중이다 */
  aborted: boolean;
}

/** 사용량이 더해진 뒤의 한도 전이: 턴 상한을 본 사유와 토큰 한도를 이어서 볼지 */
export function decideTurnLimit(facts: TurnLimitFacts): { reason: TerminalLimitReason | undefined; checkBudget: boolean } {
  const step = native.terminalDecideLimit({
    reason: facts.reason ?? 'none',
    ...(facts.maxTurns !== undefined ? { maxTurns: facts.maxTurns } : {}),
    modelCalls: Math.max(0, Math.min(Math.trunc(facts.modelCalls), 0xffff_ffff)),
    aborted: facts.aborted,
  });
  const reason = step.reason === 'none' ? undefined : step.reason === 'budget' ? 'budget' : 'max_turns';
  return { reason, checkBudget: step.checkBudget };
}

/** 쓰기 직전 훅이 이 실행의 사용량을 확인할 수 없는가: 소식이 끊겼거나, 읽지 못한 호출이 있고 토큰 한도가 있다 */
export function usageUnverifiable(silent: boolean, incomplete: boolean, tokenLimited: boolean): boolean {
  return native.terminalUsageUnverifiable(silent, incomplete, tokenLimited);
}
