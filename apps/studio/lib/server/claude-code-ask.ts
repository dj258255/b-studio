/**
 * 로컬 Claude Code 구독으로 **도구 없이 한 번만** 묻는 공용 함수.
 *
 * 계획(작업 분해)과 레인 사이 계약이 이 함수를 함께 쓴다 — 벤치로 잰 것이 제품 동작이어야 한다.
 * Agent SDK는 쓰지 않는다. 지원 러너(claude-code-runner.ts)와 같은 층(`spawnClaudeCli`)으로 공개 CLI 입출력을 쓴다(ADR-194).
 * 옵션을 최소로 두는 이유(SDK 옵션 → CLI 플래그, 근거는 모두 https://code.claude.com/docs/en/cli-reference):
 *   · `--tools ''`·허용 목록 없음 — 답은 JSON 한 덩어리라 파일·명령 접근이 필요 없다(호스트를 건드리지 않는다).
 *     요구사항 "모호한 점"에 추천 답을 물을 때만(`webTools: true`) 파일·명령 도구는 여전히 닫아 둔 채 WebSearch·
 *     WebFetch만 예외로 연다(`--tools`와 `--allowedTools` 둘 다) — 업계 관례에 근거한 답에 실제 출처 링크를 붙이기 위한 이 호출 하나만의 opt-in이다
 *   · `--permission-mode dontAsk` — 허용 목록에 없는 도구는 묻지 않고 거부한다
 *   · `--max-turns 1`(웹 도구를 열면 여유를 둬 더 크게) — 한 번 묻고 답만 받는다
 *   · `--setting-sources ''`·`--strict-mcp-config`(`--mcp-config` 없음) — 프로젝트/사용자 설정·훅·MCP를 싣지 않는다
 *   · `--no-session-persistence` — 이 호출은 대화가 아니라 일회성 질문이라 세션을 남기지 않는다(cli-reference의 같은 이름 행, print 모드 전용)
 *   · 시스템 프롬프트는 우리가 만든 문자열을 0600 파일로 넘긴다(`--system-prompt-file`) — Claude Code 기본 지침(파일 도구용)을 쓰지 않는다
 *   · 질문 글은 인자가 아니라 표준 입력의 사용자 메시지 한 줄로 보낸다(`--`로 시작하면 옵션으로 읽힌다)
 *
 * 실제 모델 호출·Docker 없이 테스트할 수 있게 실행 파일을 주입받는다(`command`·`commandArgs`, 가짜 CLI).
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ClaudeCodeUsageTracker, describeResultFailure, noResultMessage, spawnClaudeCli, type AgentUsage, type CliStopOptions, type Effort, type ModelAsk } from '@b-studio/agent';

export interface ClaudeCodeAskOptions {
  /** CLI를 돌리는 작업 폴더. 도구가 없어 파일을 읽지는 않지만, 호출의 작업 위치를 정해 둔다 */
  cwd: string;
  /** `--model` 값. 없으면 로그인 계정의 기본 모델을 쓴다 */
  model?: string;
  /** 노력(추론 강도) 단계. 없으면 CLI 기본값을 쓴다(세션·계획이 이어받은 값을 그대로 넘긴다) */
  effort?: Effort;
  /**
   * 이 호출 한 번만 WebSearch·WebFetch를 연다(요구사항 "모호한 점"에 업계 관례 추천 답을 물을 때만 켠다).
   * 파일·명령 도구는 절대 열지 않는다 — 웹 검색 한 바퀴(검색 → 결과 읽기 → 답 정리)가 들어갈 수 있게 maxTurns만 늘린다.
   */
  webTools?: boolean;
  /** 실행할 CLI 실행 파일(기본 `claude`). 테스트가 가짜 CLI를 끼우는 자리. 셸을 거치지 않고 인자 배열로 넘긴다 */
  command?: string;
  /** 실행 파일 바로 뒤, 이 함수가 붙이는 인자 앞에 오는 인자(가짜 CLI의 스크립트 경로 등) */
  commandArgs?: readonly string[];
  /** 자식 프로세스를 끝낼 때 기다리는 시간(테스트 전용 주입점) */
  stop?: CliStopOptions;
  /** 환경 변수. 넘기지 않으면 process.env를 쓴다(테스트 전용 주입점) */
  env?: NodeJS.ProcessEnv;
}

/** 도구 없는 기본 호출의 턴 상한(한 번 묻고 답만 받는다) */
const DEFAULT_MAX_TURNS = 1;
/** webTools를 켰을 때의 턴 상한(검색 호출 몇 번 + 최종 답 정리까지 들어갈 여유) */
const WEB_TOOLS_MAX_TURNS = 6;
const WEB_TOOLS = ['WebSearch', 'WebFetch'];

/** 한 번의 CLI 실행으로 텍스트 답과 usage를 받는다. 실패 이유는 기존 분류 규칙이 알아볼 수 있게 그대로 담는다 */
export function claudeCodeAsk(options: ClaudeCodeAskOptions): ModelAsk {
  const { command = 'claude', commandArgs = [], env = process.env, stop } = options;
  return async ({ system, user }, signal) => {
    signal?.throwIfAborted();
    const tracker = new ClaudeCodeUsageTracker();
    const webTools = options.webTools === true;
    const dir = await mkdtemp(path.join(tmpdir(), 'b-studio-ask-'));
    try {
      const systemFile = path.join(dir, 'system-prompt.md');
      await writeFile(systemFile, system, { mode: 0o600 });
      signal?.throwIfAborted();
      const proc = spawnClaudeCli({
        command,
        args: [
          ...commandArgs,
          '-p',
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--verbose',
          // 도구를 모두 끄고(웹 도구 opt-in만 예외) 허용 목록에 없는 것은 묻지 않고 거부한다. 읽기 전용이 여는 쪽으로 틀리지 않게 둘 다 건다
          '--tools',
          webTools ? WEB_TOOLS.join(',') : '',
          ...(webTools ? ['--allowedTools', WEB_TOOLS.join(',')] : []),
          '--permission-mode',
          'dontAsk',
          '--setting-sources',
          '',
          '--strict-mcp-config',
          '--no-session-persistence',
          '--system-prompt-file',
          systemFile,
          ...(options.model ? ['--model', options.model] : []),
          ...(options.effort ? ['--effort', options.effort] : []),
          '--max-turns',
          String(webTools ? WEB_TOOLS_MAX_TURNS : DEFAULT_MAX_TURNS),
        ],
        cwd: options.cwd,
        env,
        ...(stop ? { stop } : {}),
      });
      // 취소하면 입력을 닫고 바로 SIGTERM(진행 중인 턴을 끝까지 기다리지 않는다)
      const onAbort = () => proc.stop('now');
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) proc.stop('now');
      proc.send(user);

      let text = '';
      let failure: string | undefined;
      let resultSeen = false;
      try {
        for await (const message of proc.messages()) {
          if (message.type === 'assistant') {
            // 하위 에이전트 메시지는 본 대화로 세지 않는다(도구가 없어 나오지 않지만 러너와 같은 규칙을 쓴다)
            if (message.parent_tool_use_id || !message.message?.id) continue;
            tracker.observeAssistant({ id: message.message.id, usage: message.message.usage });
            const blocks = Array.isArray(message.message.content) ? (message.message.content as Array<{ type?: string; text?: string }>) : [];
            const collected = blocks.flatMap((block) => (block.type === 'text' && typeof block.text === 'string' ? [block.text] : [])).join('\n').trim();
            if (collected) text = collected;
          } else if (message.type === 'result') {
            resultSeen = true;
            tracker.observeResult(message);
            failure = describeResultFailure(message);
            if (!failure && message.subtype === 'success' && message.result) text = message.result;
            break;
          }
        }
      } finally {
        signal?.removeEventListener('abort', onAbort);
        // 어떤 경로로 나왔든 프로세스를 끝내고 끝나기를 기다린다(입력을 닫으면 CLI가 스스로 끝난다)
        proc.stop('graceful');
      }
      const exit = await proc.exited;
      // 취소했으면 결과 없음이 아니라 취소다
      signal?.throwIfAborted();
      // 사용 한도인지는 부르는 쪽이 기존 분류 규칙으로 알아본다. 여기서는 이유를 그대로 알린다
      if (failure) throw new Error(`모델 호출이 실패했습니다: ${failure}`);
      // 결과 없이 끝났으면 받은 글이 있어도 통과시키지 않는다(사용량도 모른다)
      if (!resultSeen) throw new Error(noResultMessage({ ...exit, stderr: proc.stderrTail() }));
      if (!text.trim()) throw new Error('모델이 빈 응답을 돌려줬습니다');
      return { text, usage: { ...tracker.usage } as AgentUsage };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  };
}
