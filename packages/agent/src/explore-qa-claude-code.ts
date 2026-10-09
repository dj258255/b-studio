import { createSdkMcpServer, query, tool, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { BrowserFrame } from './browser-check';
import type { ClaudeCodeQuery, ClaudeCodeSdk } from './claude-code-runner';
import { ClaudeCodeUsageTracker, zodShape } from './claude-code-runner';
import {
  buildExploreQaResult,
  buildQaSystemPrompt,
  buildQaTools,
  buildQaUserPrompt,
  buildWrapUpPrompt,
  executeQaTool,
  QaBrowser,
  QaReport,
  RepeatTracker,
  saveActionThumbnail,
  type ExploreQaEvent,
  type ExploreQaGoal,
  type ExploreQaResult,
  type ExploreQaStopReason,
  type QaActionRecord,
  type QaDiagnostics,
  type QaViewport,
  type RunExploreQaOptions,
} from './explore-qa';
import type { AgentUsage } from './loop';

/**
 * 세션 백엔드가 claude-code(로컬 Claude Agent)일 때, 탐색형 QA도 같은 경로 — b-studio 도구를 로컬 MCP 서버로
 * 노출하고 CLI가 그 도구만 쓰게 하는 방식(claude-code-runner.ts의 설계)을 재사용한다.
 * 다만 탐색형 QA는 파일을 바꾸지 않고 검증 게이트·승격·진행 중 지시도 쓰지 않으므로, 그 복잡도는 들이지 않고
 * "b-studio 도구만 MCP로 연다 → 모델이 그 도구로 목표를 수행한다 → 결과를 플랫폼이 따로 판정한다"는 뼈대만 가져온다.
 */

const SERVER = 'b-studio-qa';
const DEFAULT_MAX_ACTIONS = 30;
const DEFAULT_MAX_MS = 5 * 60_000;
const DEFAULT_REPEAT_LIMIT = 4;
/** 한도에 걸린 뒤 모델이 마지막 보고를 하도록 기다리는 시간. 지나면 끊고 보고 없음으로 판정한다 */
const WRAP_UP_GRACE_MS = 90_000;
/** 조작이 닫힌 뒤에도 조작 도구를 이만큼 더 부르면 보고할 뜻이 없다고 보고 끊는다 */
const WRAP_UP_REFUSALS = 3;
/** 끊은 뒤 result(사용량)를 기다리는 시간 */
const DRAIN_MS = 15_000;

const DEFAULT_SDK: ClaudeCodeSdk = { query, createSdkMcpServer };

export interface ClaudeCodeExploreQaOptions {
  goal: ExploreQaGoal;
  startUrl: string;
  allowedOrigins: readonly string[];
  viewport?: QaViewport;
  onFrame?: (frame: BrowserFrame) => void;
  onEvent?: (event: ExploreQaEvent) => void;
  /** 주면 행동마다 스크린샷을 찍어 저장하고 QaActionRecord.artifact에 남긴다(단계 타임라인 썸네일용) */
  saveArtifact?: RunExploreQaOptions['saveArtifact'];
  /** 이 PC에 로그인한 Claude Code가 돌 작업 디렉터리(세션 프로젝트 루트) */
  cwd: string;
  model?: string;
  sdk?: ClaudeCodeSdk;
  signal?: AbortSignal;
}

export type ClaudeCodeExploreQaResult = ExploreQaResult;

/** 사용자 글을 입력으로 보내고 끝까지 열어 두는 스트리밍 입력. interrupt()는 스트리밍 입력에서만 동작해 종료 조건을 강제할 수 있다 */
class PromptQueue implements AsyncIterable<SDKUserMessage> {
  #closed = false;
  readonly #pending: SDKUserMessage[] = [];
  readonly #waiting: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];

  constructor(first: string) {
    this.push(first);
  }

  /** 대화에 사용자 글을 더한다(첫 목표, 마지막 보고 요청) */
  push(text: string): void {
    if (this.#closed) return;
    const message: SDKUserMessage = { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null };
    const waiter = this.#waiting.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.#pending.push(message);
  }

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiting.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        const message = this.#pending.shift();
        if (message) return Promise.resolve({ value: message, done: false });
        if (this.#closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => this.#waiting.push(resolve));
      },
      return: (): Promise<IteratorResult<SDKUserMessage>> => {
        this.close();
        return Promise.resolve({ value: undefined, done: true });
      },
    };
  }
}

export async function runClaudeCodeExploreQa(options: ClaudeCodeExploreQaOptions): Promise<ClaudeCodeExploreQaResult> {
  const { goal, startUrl, allowedOrigins, viewport, onFrame, onEvent, saveArtifact, cwd, model, sdk = DEFAULT_SDK, signal } = options;
  const maxActions = goal.maxActions ?? DEFAULT_MAX_ACTIONS;
  const maxMs = goal.maxMs ?? DEFAULT_MAX_MS;
  const repeatLimit = goal.repeatLimit ?? DEFAULT_REPEAT_LIMIT;
  const deadline = Date.now() + maxMs;

  const browser = await QaBrowser.open(startUrl, { allowedOrigins, ...(viewport ? { viewport } : {}), ...(onFrame ? { onFrame } : {}) });
  try {
    const specs = buildQaTools();
    const actions: QaActionRecord[] = [];
    const report = new QaReport();
    const repeats = new RepeatTracker(repeatLimit);
    const usageTracker = new ClaudeCodeUsageTracker();
    // result가 오지 못한 채 끊겼을 때를 위한 대비: assistant 메시지별 사용량의 최신값
    const assistantUsage = new Map<string, AgentUsage>();
    let resultSeen = false;
    let stoppedBy: ExploreQaStopReason = 'max_actions';
    let actionCount = 0;
    let previousDiagnosticsCount = 0;
    /** 한도·반복·시간으로 조작을 닫고 마지막 보고만 받는 단계 */
    let wrappingUp = false;
    /** 더는 기다리지 않고 대화를 끝내는 중(qa_finish를 받았거나 보고 유예가 끝남) */
    let stopping = false;
    let refusedDuringWrapUp = 0;
    let followUpSent = false;
    let conversation: ClaudeCodeQuery | undefined;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let wrapUpTimer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();

    const requestStop = (): void => {
      if (stopping) return;
      stopping = true;
      void conversation?.interrupt().catch(() => {});
      // interrupt 뒤에도 result(사용량)가 올 때까지 읽되, 오지 않으면 끊는다
      drainTimer = setTimeout(() => abort.abort(), DRAIN_MS);
      drainTimer.unref?.();
    };

    /** 조작을 닫는다. 모델은 같은 대화 안에서 qa_report_issue·qa_finish만 쓸 수 있고, 유예 안에 보고하지 않으면 끊는다 */
    const beginWrapUp = (reason: ExploreQaStopReason): void => {
      if (wrappingUp || stopping) return;
      wrappingUp = true;
      stoppedBy = reason;
      wrapUpTimer = setTimeout(requestStop, WRAP_UP_GRACE_MS);
      wrapUpTimer.unref?.();
    };

    const definitions = specs.map((spec) =>
      tool(spec.name, spec.description ?? '', zodShape(spec.input_schema as { properties?: unknown; required?: unknown }, { honorRequired: true }), async (args: unknown) => {
        const input = (args ?? {}) as Record<string, unknown>;
        if (spec.name === 'qa_report_issue') {
          const added = report.addFinding(input);
          if (added.finding) onEvent?.({ type: 'finding', finding: added.finding });
          return { content: [{ type: 'text' as const, text: added.text }], ...(added.ok ? {} : { isError: true }) };
        }
        if (spec.name === 'qa_finish') {
          report.declare(input);
          if (!wrappingUp) stoppedBy = 'finish';
          requestStop();
          return { content: [{ type: 'text' as const, text: 'qa_finish를 받았습니다. 실행을 마칩니다.' }] };
        }
        if (wrappingUp || stopping) {
          refusedDuringWrapUp += 1;
          if (refusedDuringWrapUp >= WRAP_UP_REFUSALS) requestStop();
          return { content: [{ type: 'text' as const, text: stopping && !wrappingUp ? '실행이 이미 끝나는 중입니다.' : buildWrapUpPrompt(stoppedBy) }], isError: true };
        }

        actionCount += 1;
        const outcome = await executeQaTool(spec.name, input, browser);
        const diagnostics = await browser.currentDiagnostics();
        const total = countDiagnostics(diagnostics);
        const artifact = await saveActionThumbnail(browser, saveArtifact, actionCount);
        const record: QaActionRecord = {
          index: actionCount,
          tool: spec.name,
          input,
          ok: outcome.ok,
          ...(outcome.ok ? {} : { detail: outcome.text }),
          ...(outcome.resolvedSelector ? { resolvedSelector: outcome.resolvedSelector } : {}),
          ...(outcome.stableSelector ? { stableSelector: outcome.stableSelector } : {}),
          ...(outcome.rect ? { targetRect: outcome.rect } : {}),
          ...(artifact ? { artifact } : {}),
          newDiagnosticsCount: Math.max(0, total - previousDiagnosticsCount),
          url: browser.url,
          at: Date.now(),
        };
        previousDiagnosticsCount = total;
        actions.push(record);
        onEvent?.({ type: 'action', record });

        const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = [{ type: 'text', text: outcome.text }];
        if (outcome.image) content.push({ type: 'image', data: outcome.image.data.toString('base64'), mimeType: outcome.image.mediaType });

        const repeated = await repeats.record(record, () => browser.screenSignature());
        const limit: ExploreQaStopReason | undefined = repeated ? 'repeated_screen' : actionCount >= maxActions ? 'max_actions' : Date.now() >= deadline ? 'max_time' : undefined;
        if (limit) {
          beginWrapUp(limit);
          content.push({ type: 'text', text: buildWrapUpPrompt(limit) });
        }
        return { content, isError: !outcome.ok };
      }),
    );

    const input = new PromptQueue(buildQaUserPrompt(goal));
    const onAbort = () => abort.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    const deadlineTimer = setTimeout(() => beginWrapUp('max_time'), Math.max(0, deadline - Date.now()));
    deadlineTimer.unref?.();

    try {
      conversation = sdk.query({
        prompt: input,
        options: {
          cwd,
          systemPrompt: buildQaSystemPrompt(goal),
          tools: [],
          mcpServers: { [SERVER]: sdk.createSdkMcpServer({ name: SERVER, version: '0.0.0', tools: definitions }) },
          allowedTools: specs.map((spec) => `mcp__${SERVER}__${spec.name}`),
          permissionMode: 'dontAsk',
          strictMcpConfig: true,
          settingSources: [],
          ...(model ? { model } : {}),
          abortController: abort,
          env: { ...process.env, CLAUDE_AGENT_SDK_CLIENT_APP: 'b-studio' },
        },
      });

      try {
        for await (const message of conversation) {
          if (message.type === 'assistant') {
            const id = (message.message as { id?: string }).id;
            const messageUsage = (message.message as { usage?: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } }).usage;
            if (id && messageUsage) {
              assistantUsage.set(id, {
                inputTokens: messageUsage.input_tokens ?? 0,
                outputTokens: messageUsage.output_tokens ?? 0,
                cacheReadTokens: messageUsage.cache_read_input_tokens ?? 0,
                cacheWriteTokens: messageUsage.cache_creation_input_tokens ?? 0,
              });
            }
            const text = message.message.content
              .flatMap((block: { type: string; text?: string }) => (block.type === 'text' && block.text ? [block.text] : []))
              .join('\n')
              .trim();
            if (text) onEvent?.({ type: 'text', text });
          }
          if (message.type === 'result') {
            // modelUsage는 이 query의 누적값이다. claude-code-runner.ts와 같은 규칙으로 읽는다
            usageTracker.observeResult(message);
            resultSeen = true;
            // 모델이 qa_finish 없이 차례를 마쳤다(도구 없이 글만 냄, 또는 한도 뒤에도 보고 안 함). 같은 대화에서 한 번 더 묻는다
            if (!report.declared && !stopping && !followUpSent) {
              followUpSent = true;
              if (!wrappingUp) beginWrapUp('no_tool_call');
              input.push(buildWrapUpPrompt(stoppedBy));
              continue;
            }
            break;
          }
        }
      } catch (error) {
        // 끊으려고 abort한 경우의 오류는 정상 종료다. 그 밖의 오류는 그대로 올린다
        if (!stopping && !abort.signal.aborted) throw error;
        if (signal?.aborted) throw error;
      }
    } finally {
      clearTimeout(deadlineTimer);
      if (drainTimer) clearTimeout(drainTimer);
      if (wrapUpTimer) clearTimeout(wrapUpTimer);
      signal?.removeEventListener('abort', onAbort);
      input.close();
      conversation?.close();
    }

    const usage: AgentUsage = resultSeen ? { ...usageTracker.usage } : sumUsage([...assistantUsage.values()]);
    return await buildExploreQaResult({ goal, browser, report, stoppedBy, actions, usage });
  } finally {
    await browser.close();
  }
}

function sumUsage(entries: AgentUsage[]): AgentUsage {
  return entries.reduce(
    (sum, entry) => ({
      inputTokens: sum.inputTokens + entry.inputTokens,
      outputTokens: sum.outputTokens + entry.outputTokens,
      cacheReadTokens: sum.cacheReadTokens + entry.cacheReadTokens,
      cacheWriteTokens: sum.cacheWriteTokens + entry.cacheWriteTokens,
    }),
    { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
  );
}

function countDiagnostics(diagnostics: QaDiagnostics): number {
  return (
    diagnostics.consoleErrors.length +
    diagnostics.pageErrors.length +
    diagnostics.failedRequests.length +
    diagnostics.accessibilityViolations.length +
    (diagnostics.horizontalOverflowPx > 1 ? 1 : 0)
  );
}
