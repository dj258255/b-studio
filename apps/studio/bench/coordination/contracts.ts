/**
 * 벤치가 레인 사이 계약을 부르는 경로(`--contracts model`).
 *
 * 고정 계획(레인·작업)은 그대로 두고 **계약의 출처만** 바꾸기 위한 것이다. E2에서는 계약을 사람이 써 줬고(9/9),
 * 제품에서는 계획 모델이 써야 한다(ADR-059의 가장 큰 한계). 이 벤치가 그 둘을 같은 조건에서 비교한다.
 * 프롬프트와 검증은 제품과 **같은 함수**(`requestLaneContracts`·`buildContractSystem`)를 쓴다.
 *
 * 백엔드별 호출:
 *  - openai: 상류 ModelClient(프록시 경유)를 `contractAskFromClient`로 감싼다 — 실행기와 같은 경로
 *  - claude-code: 제품의 작업 분해와 **같은 공용 함수**(`lib/server/claude-code-ask.ts`의 `claudeCodeAsk`)로 한 번 부른다.
 *    옵션(도구·설정·MCP·세션 없음)과 실패 처리도 그 함수가 정한다 — 여기서는 이름만 벤치 말로 붙인다
 *  - codex 등: 시작 전에 거부한다(backends.assertContractsBackend). 한 번 호출 경로를 만들지 않았다.
 *
 * 실제 모델 호출·Docker 없이 테스트할 수 있게 SDK를 주입받는다(`ContractsSdk`) — plain-baseline과 같은 방식이다.
 */
import type { ContractAsk } from '@b-studio/agent';
import {
  claudeCodeAsk,
  DEFAULT_CLAUDE_CODE_ASK_SDK,
  type ClaudeCodeAskOptions,
  type ClaudeCodeAskQuery,
  type ClaudeCodeAskSdk,
} from '../../lib/server/claude-code-ask';

/** 실제 SDK와 가짜를 바꿔 끼우는 지점(공용 함수의 SDK 주입 지점과 같다) */
export type ContractsSdk = ClaudeCodeAskSdk;
export type ContractsQuery = ClaudeCodeAskQuery;
export const DEFAULT_CONTRACTS_SDK = DEFAULT_CLAUDE_CODE_ASK_SDK;

export type ClaudeCodeContractOptions = ClaudeCodeAskOptions;

/** claude-code 백엔드의 계약 호출. 제품의 계획 호출과 같은 함수를 쓴다 */
export function claudeCodeContractAsk(options: ClaudeCodeContractOptions): ContractAsk {
  return claudeCodeAsk(options);
}
