/**
 * 벤치가 레인 사이 계약을 부르는 경로(`--contracts model`).
 *
 * 고정 계획(레인·작업)은 그대로 두고 **계약의 출처만** 바꾸기 위한 것이다. E2에서는 계약을 사람이 써 줬고(9/9),
 * 제품에서는 계획 모델이 써야 한다(ADR-059의 가장 큰 한계). 이 벤치가 그 둘을 같은 조건에서 비교한다.
 * 프롬프트와 검증은 제품과 **같은 함수**(`requestLaneContracts`·`buildContractSystem`)를 쓴다.
 *
 * 백엔드별 호출:
 *  - openai: 상류 ModelClient(프록시 경유)를 `contractAskFromClient`로 감싼다 — 실행기와 같은 경로
 *  - claude-code: Claude Agent SDK `query`를 **한 번만** 부른다. 옵션을 최소로 두는 이유:
 *      · `tools: []` — 계약은 응답 JSON 한 덩어리라 파일·명령 접근이 필요 없다(호스트를 건드리지 않는다)
 *      · `maxTurns: 1` — 한 번 묻고 답만 받는다(도구가 없어도 모델이 스스로 더 돌지 않게)
 *      · `settingSources: []`·`mcpServers: {}`·`strictMcpConfig` — 프로젝트/사용자 설정·훅·MCP를 싣지 않는다
 *      · `persistSession: false` — 이 호출은 대화가 아니라 일회성 질문이라 세션을 남기지 않는다
 *      · `systemPrompt`는 계약 프롬프트 문자열 — Claude Code 프리셋을 쓰지 않는다(파일 도구용 지침이 필요 없다)
 *  - codex 등: 시작 전에 거부한다(backends.assertContractsBackend). 한 번 호출 경로를 만들지 않았다.
 *
 * 실제 모델 호출·Docker 없이 테스트할 수 있게 SDK를 주입받는다(`ContractsSdk`) — plain-baseline과 같은 방식이다.
 */
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeCodeUsageTracker, describeResultFailure, type ContractAsk, type AgentUsage } from '@b-studio/agent';

/** 실제 SDK와 가짜를 바꿔 끼우는 지점 */
export interface ContractsSdk {
  query(params: { prompt: string; options: Options }): ContractsQuery;
}

export interface ContractsQuery extends AsyncIterable<SDKMessage> {
  close(): void;
}

export const DEFAULT_CONTRACTS_SDK: ContractsSdk = { query };

export interface ClaudeCodeContractOptions {
  /** SDK를 돌리는 작업 폴더. 도구가 없어 파일을 읽지는 않지만, 세션의 작업 위치를 정해 둔다 */
  cwd: string;
  /** `--model` 값. 없으면 로그인 계정의 기본 모델을 쓴다 */
  model?: string;
  sdk?: ContractsSdk;
}

/** claude-code 백엔드의 계약 호출. 한 번의 query로 계약 JSON 텍스트를 받는다 */
export function claudeCodeContractAsk(options: ClaudeCodeContractOptions): ContractAsk {
  const sdk = options.sdk ?? DEFAULT_CONTRACTS_SDK;
  return async ({ system, user }, signal) => {
    const tracker = new ClaudeCodeUsageTracker();
    const abort = new AbortController();
    const onAbort = () => abort.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });

    let text = '';
    let failure: string | undefined;
    let conversation: ContractsQuery | undefined;
    try {
      conversation = sdk.query({
        prompt: user,
        options: {
          cwd: options.cwd,
          systemPrompt: system,
          tools: [],
          allowedTools: [],
          permissionMode: 'dontAsk',
          settingSources: [],
          mcpServers: {},
          strictMcpConfig: true,
          persistSession: false,
          maxTurns: 1,
          ...(options.model ? { model: options.model } : {}),
          abortController: abort,
        },
      });

      for await (const message of conversation) {
        signal?.throwIfAborted();
        if (message.type === 'assistant') {
          // 하위 에이전트 메시지는 본 대화로 세지 않는다(도구가 없어 나오지 않지만 러너와 같은 규칙을 쓴다)
          if (message.parent_tool_use_id) continue;
          tracker.observeAssistant(message.message);
          const collected = message.message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])).join('\n').trim();
          if (collected) text = collected;
        } else if (message.type === 'result') {
          tracker.observeResult(message);
          const reason = describeResultFailure(message);
          if (reason) {
            failure = reason;
            break;
          }
          if (message.subtype === 'success' && message.result) text = message.result;
        }
      }
    } finally {
      conversation?.close();
      signal?.removeEventListener('abort', onAbort);
    }

    // 사용 한도인지는 부르는 쪽(run.ts)이 기존 분류 규칙으로 알아본다. 여기서는 이유를 그대로 알린다
    if (failure) throw new Error(`계약 호출이 실패했습니다: ${failure}`);
    if (!text.trim()) throw new Error('계약 호출이 빈 응답을 돌려줬습니다');
    return { text, usage: { ...tracker.usage } as AgentUsage };
  };
}
