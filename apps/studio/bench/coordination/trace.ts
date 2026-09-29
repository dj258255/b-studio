/**
 * 세션 이벤트 기록에서 레인 하나가 "얼마나 탐색했고 무엇이 실패했는지"를 뽑는다(순수 함수).
 *
 * "공유가 실패는 줄이고 탐색은 줄이지 않는가"를 나중에 재려면 E1 기준선부터 같은 값을 남겨야 한다.
 * 운영 코드를 바꾸지 않고 세션 이벤트 기록만으로 계산한다. 실패 서명은 **검증기가 낸 실패만** 쓴다 —
 * 모델 텍스트는 실패의 근거가 아니다(모델은 실패를 다르게 서술할 뿐이다).
 *
 * 서명 정규화와 보고서→서명 변환은 조율 런타임과 같은 규칙을 쓰도록 @b-studio/agent의
 * coordination/signature.ts로 옮겼다. 여기서는 그 함수를 그대로 쓴다(동작 동일).
 */
import { normalizeMessage, signatureKey, signaturesFromReport } from '@b-studio/agent';
import type { FailureSignature } from '@b-studio/agent';
import type { StudioEvent } from '../../lib/studio-events';

export { normalizeMessage, signatureKey };
export type { FailureSignature };

export interface LaneTrace {
  sessionId: string;
  /** 도구 이름별 호출 수 */
  toolCalls: Record<string, number>;
  /** read_file 입력 path, 정규화·중복 제거·정렬 */
  filesRead: string[];
  /** list_files 입력 path(없으면 '.') */
  dirsListed: string[];
  /** 발생 순서대로, 중복 포함 */
  failureSignatures: FailureSignature[];
  /** 같은 서명이 두 번째 이상 나온 횟수 합 */
  repeatedFailures: number;
}

export function traceFromEvents(sessionId: string, events: StudioEvent[]): LaneTrace {
  // 도구 이름이 '__proto__'·'constructor'여도 안전하도록 Map으로 센다
  const toolCalls = new Map<string, number>();
  const filesRead = new Set<string>();
  const dirsListed = new Set<string>();
  const failureSignatures: FailureSignature[] = [];

  for (const event of events) {
    if (event.type !== 'agent') continue;
    const agent = event.event;

    if (agent.type === 'tool_call') {
      toolCalls.set(agent.name, (toolCalls.get(agent.name) ?? 0) + 1);
      const path = inputPath(agent.input);
      if (agent.name === 'read_file' && path !== undefined) filesRead.add(normalizePath(path));
      if (agent.name === 'list_files') dirsListed.add(path === undefined ? '.' : normalizePath(path));
      continue;
    }
    if (agent.type === 'verify_result') {
      failureSignatures.push(...signaturesFromReport(agent.report));
      continue;
    }
    if (agent.type === 'workflow_check' && !agent.check.ok) {
      failureSignatures.push({ stage: agent.check.stage, message: normalizeMessage(agent.check.detail ?? agent.check.name) });
    }
  }

  const counts = new Map<string, number>();
  for (const signature of failureSignatures) {
    const key = signatureKey(signature);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const repeatedFailures = [...counts.values()].reduce((sum, count) => sum + Math.max(0, count - 1), 0);

  return {
    sessionId,
    toolCalls: Object.fromEntries(toolCalls),
    filesRead: [...filesRead].sort(),
    dirsListed: [...dirsListed].sort(),
    failureSignatures,
    repeatedFailures,
  };
}

function inputPath(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const path = (input as { path?: unknown }).path;
  return typeof path === 'string' ? path : undefined;
}

function normalizePath(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').trim();
}
