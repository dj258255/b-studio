/**
 * 로컬 Claude Code 구독으로 **도구 없이 한 번만** 묻는 공용 함수.
 *
 * 계획(작업 분해)과 레인 사이 계약이 이 함수를 함께 쓴다 — 벤치로 잰 것이 제품 동작이어야 한다.
 * 옵션을 최소로 두는 이유:
 *   · `tools: []`·`allowedTools: []` — 답은 JSON 한 덩어리라 파일·명령 접근이 필요 없다(호스트를 건드리지 않는다).
 *     요구사항 "모호한 점"에 추천 답을 물을 때만(`webTools: true`) 파일·명령 도구는 여전히 닫아 둔 채 WebSearch·
 *     WebFetch만 예외로 연다 — 업계 관례에 근거한 답에 실제 출처 링크를 붙이기 위한 이 호출 하나만의 opt-in이다
 *   · `maxTurns: 1`(웹 도구를 열면 여유를 둬 더 크게) — 한 번 묻고 답만 받는다(도구가 없어도 모델이 스스로 더 돌지 않게)
 *   · `settingSources: []`·`mcpServers: {}`·`strictMcpConfig` — 프로젝트/사용자 설정·훅·MCP를 싣지 않는다(웹 도구를
 *     열 때도 마찬가지 — 이 설정들은 프로젝트 커스텀 도구·훅용이라 WebSearch/WebFetch 자체는 켜고 끄지 않는다)
 *   · `persistSession: false` — 이 호출은 대화가 아니라 일회성 질문이라 세션을 남기지 않는다
 *   · `systemPrompt`는 우리가 만든 프롬프트 문자열 — Claude Code 프리셋(파일 도구용 지침)을 쓰지 않는다
 *
 * 실제 모델 호출·Docker 없이 테스트할 수 있게 SDK를 주입받는다(plain-baseline과 같은 방식).
 */
import { query, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { ClaudeCodeUsageTracker, describeResultFailure, type AgentUsage, type Effort, type ModelAsk } from '@b-studio/agent';

/** 실제 SDK와 가짜를 바꿔 끼우는 지점 */
export interface ClaudeCodeAskSdk {
  query(params: { prompt: string; options: Options }): ClaudeCodeAskQuery;
}

export interface ClaudeCodeAskQuery extends AsyncIterable<SDKMessage> {
  close(): void;
}

export const DEFAULT_CLAUDE_CODE_ASK_SDK: ClaudeCodeAskSdk = { query };

export interface ClaudeCodeAskOptions {
  /** SDK를 돌리는 작업 폴더. 도구가 없어 파일을 읽지는 않지만, 호출의 작업 위치를 정해 둔다 */
  cwd: string;
  /** `--model` 값. 없으면 로그인 계정의 기본 모델을 쓴다 */
  model?: string;
  /** 노력(추론 강도) 단계. 없으면 SDK 기본값을 쓴다(세션·계획이 이어받은 값을 그대로 넘긴다) */
  effort?: Effort;
  /**
   * 이 호출 한 번만 WebSearch·WebFetch를 연다(요구사항 "모호한 점"에 업계 관례 추천 답을 물을 때만 켠다).
   * 파일·명령 도구는 절대 열지 않는다 — 웹 검색 한 바퀴(검색 → 결과 읽기 → 답 정리)가 들어갈 수 있게 maxTurns만 늘린다.
   */
  webTools?: boolean;
  sdk?: ClaudeCodeAskSdk;
}

/** 도구 없는 기본 호출의 턴 상한(한 번 묻고 답만 받는다) */
const DEFAULT_MAX_TURNS = 1;
/** webTools를 켰을 때의 턴 상한(검색 호출 몇 번 + 최종 답 정리까지 들어갈 여유) */
const WEB_TOOLS_MAX_TURNS = 6;

/** 한 번의 query로 텍스트 답과 usage를 받는다. 실패 이유는 기존 분류 규칙이 알아볼 수 있게 그대로 담는다 */
export function claudeCodeAsk(options: ClaudeCodeAskOptions): ModelAsk {
  const sdk = options.sdk ?? DEFAULT_CLAUDE_CODE_ASK_SDK;
  return async ({ system, user }, signal) => {
    const tracker = new ClaudeCodeUsageTracker();
    const abort = new AbortController();
    const onAbort = () => abort.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });

    let text = '';
    let failure: string | undefined;
    let conversation: ClaudeCodeAskQuery | undefined;
    try {
      const webTools = options.webTools === true;
      conversation = sdk.query({
        prompt: user,
        options: {
          cwd: options.cwd,
          systemPrompt: system,
          tools: webTools ? ['WebSearch', 'WebFetch'] : [],
          allowedTools: webTools ? ['WebSearch', 'WebFetch'] : [],
          permissionMode: 'dontAsk',
          settingSources: [],
          mcpServers: {},
          strictMcpConfig: true,
          persistSession: false,
          maxTurns: webTools ? WEB_TOOLS_MAX_TURNS : DEFAULT_MAX_TURNS,
          ...(options.model ? { model: options.model } : {}),
          ...(options.effort ? { effort: options.effort } : {}),
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

    // 사용 한도인지는 부르는 쪽이 기존 분류 규칙으로 알아본다. 여기서는 이유를 그대로 알린다
    if (failure) throw new Error(`모델 호출이 실패했습니다: ${failure}`);
    if (!text.trim()) throw new Error('모델이 빈 응답을 돌려줬습니다');
    return { text, usage: { ...tracker.usage } as AgentUsage };
  };
}
