import { createSdkMcpServer, query, tool, type SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import type { BrowserFrame } from './browser-check';
import type { ClaudeCodeQuery, ClaudeCodeSdk } from './claude-code-runner';
import { zodShape } from './claude-code-runner';
import {
  buildQaSystemPrompt,
  buildQaTools,
  buildQaUserPrompt,
  executeQaTool,
  judge,
  QaBrowser,
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

/** 사용자 목표 하나만 보내고 끝까지 열어 두는 스트리밍 입력. interrupt()는 스트리밍 입력에서만 동작해 종료 조건을 강제할 수 있다 */
class SinglePromptQueue implements AsyncIterable<SDKUserMessage> {
  #sent = false;
  #closed = false;
  readonly #waiting: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];

  constructor(private readonly text: string) {}

  close(): void {
    this.#closed = true;
    for (const waiter of this.#waiting.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: (): Promise<IteratorResult<SDKUserMessage>> => {
        if (!this.#sent) {
          this.#sent = true;
          return Promise.resolve({ value: { type: 'user', message: { role: 'user', content: this.text }, parent_tool_use_id: null }, done: false });
        }
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
    const signatures: string[] = [];
    let modelDeclared: { success: boolean; summary: string } | undefined;
    let stoppedBy: ExploreQaStopReason = 'max_actions';
    let actionCount = 0;
    let previousDiagnosticsCount = 0;
    let stopping = false;
    let conversation: ClaudeCodeQuery | undefined;
    const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };

    const requestStop = (reason: ExploreQaStopReason): void => {
      if (stopping) return;
      stopping = true;
      stoppedBy = reason;
      void conversation?.interrupt().catch(() => {});
    };

    const definitions = specs.map((spec) =>
      tool(spec.name, spec.description ?? '', zodShape(spec.input_schema as { properties?: unknown }), async (args: unknown) => {
        const input = (args ?? {}) as Record<string, unknown>;
        if (spec.name === 'qa_finish') {
          modelDeclared = { success: Boolean(input.success), summary: typeof input.summary === 'string' ? input.summary : '' };
          requestStop('finish');
          return { content: [{ type: 'text' as const, text: 'qa_finish를 받았습니다. 실행을 마칩니다.' }] };
        }
        if (stopping) return { content: [{ type: 'text' as const, text: '실행이 이미 끝나는 중입니다.' }], isError: true };

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

        const signature = await browser.screenSignature();
        signatures.push(signature);
        const repeated = signatures.length >= repeatLimit && signatures.slice(-repeatLimit).every((value) => value === signature);
        if (repeated) requestStop('repeated_screen');
        else if (actionCount >= maxActions) requestStop('max_actions');
        else if (Date.now() >= deadline) requestStop('max_time');

        return { content, isError: !outcome.ok };
      }),
    );

    const input = new SinglePromptQueue(buildQaUserPrompt(goal));
    const abort = new AbortController();
    const onAbort = () => abort.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    const deadlineTimer = setTimeout(() => requestStop('max_time'), Math.max(0, deadline - Date.now()));
    deadlineTimer.unref?.();

    try {
      conversation = sdk.query({
        prompt: input,
        options: {
          cwd,
          systemPrompt: buildQaSystemPrompt(),
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

      for await (const message of conversation) {
        if (message.type === 'assistant') {
          const text = message.message.content
            .flatMap((block: { type: string; text?: string }) => (block.type === 'text' && block.text ? [block.text] : []))
            .join('\n')
            .trim();
          if (text) onEvent?.({ type: 'text', text });
        }
        if (message.type === 'result') {
          const models = Object.values((message as { modelUsage?: Record<string, { inputTokens: number; outputTokens: number; cacheReadInputTokens: number; cacheCreationInputTokens: number }> }).modelUsage ?? {});
          usage.inputTokens = models.reduce((sum, value) => sum + value.inputTokens, 0);
          usage.outputTokens = models.reduce((sum, value) => sum + value.outputTokens, 0);
          usage.cacheReadTokens = models.reduce((sum, value) => sum + value.cacheReadInputTokens, 0);
          usage.cacheWriteTokens = models.reduce((sum, value) => sum + value.cacheCreationInputTokens, 0);
          break;
        }
        if (stopping) break;
      }
    } finally {
      clearTimeout(deadlineTimer);
      signal?.removeEventListener('abort', onAbort);
      input.close();
      conversation?.close();
    }

    const diagnostics = await browser.currentDiagnostics();
    const pageText = await browser.pageText();
    const judged = judge(goal, diagnostics, pageText);
    return { status: judged.status, reason: judged.reason, ...(modelDeclared ? { modelDeclared } : {}), stoppedBy, diagnostics, actions, usage };
  } finally {
    await browser.close();
  }
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
