import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { BrowserFrame } from './browser-check';
import { spawnClaudeCli, type ClaudeCliProcess, type CliStopOptions } from './claude-cli-process';
import { ClaudeCodeUsageTracker, mcpSetupFailure, noResultMessage } from './claude-code-runner';
import {
  buildExploreQaResult,
  buildQaSystemPrompt,
  buildQaTools,
  buildQaUserPrompt,
  buildWrapUpPrompt,
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
import { startToolServer, type ToolServer } from './mcp-http-server';
import { serialQueue } from './tool-schema';
import type { ToolOutcome } from './tools';

/**
 * 세션 백엔드가 claude-code(로컬 Claude Agent)일 때, 탐색형 QA도 같은 경로 — b-studio 도구를 로컬 MCP 서버(루프백 HTTP)로
 * 노출하고 CLI가 그 도구만 쓰게 하는 방식(claude-code-runner.ts의 설계)을 재사용한다.
 * Agent SDK는 쓰지 않는다. 러너와 같은 층(`spawnClaudeCli`)으로 공개 CLI 입출력만 쓴다(ADR-194): 플래그와 근거는 러너와 같고
 * (https://code.claude.com/docs/en/cli-reference), 새로 쓰는 것은 없다. SDK의 `interrupt()`는 쓰지 않는다(공식 문서에 없다):
 * 끝낼 때는 표준 입력을 닫아 하던 턴을 마치게 하고(그래야 result의 사용량이 온다), 끝나지 않으면 SIGTERM으로 끊는다.
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

const MCP_TOKEN_ENV = 'B_STUDIO_MCP_TOKEN';

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
  /** 실행할 CLI 실행 파일(기본 `claude`). 테스트가 가짜 CLI를 끼우는 자리. 셸을 거치지 않고 인자 배열로 넘긴다 */
  command?: string;
  /** 실행 파일 바로 뒤, 이 함수가 붙이는 인자 앞에 오는 인자(가짜 CLI의 스크립트 경로 등) */
  commandArgs?: readonly string[];
  /** 자식 프로세스를 끝낼 때 기다리는 시간(테스트 전용 주입점) */
  stop?: CliStopOptions;
  /** 환경 변수. 넘기지 않으면 process.env를 쓴다(테스트 전용 주입점) */
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}

export type ClaudeCodeExploreQaResult = ExploreQaResult;

export async function runClaudeCodeExploreQa(options: ClaudeCodeExploreQaOptions): Promise<ClaudeCodeExploreQaResult> {
  const { goal, startUrl, allowedOrigins, viewport, onFrame, onEvent, saveArtifact, cwd, model, command = 'claude', commandArgs = [], stop: stopOptions, env: processEnv = process.env, signal } = options;
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
    let proc: ClaudeCliProcess | undefined;
    /** 대화가 끝났거나 끝내는 중이면 true. 그 뒤에 도착하는 도구 호출은 브라우저를 건드리지 않고 거절한다 */
    let toolsClosed = false;
    let drainTimer: ReturnType<typeof setTimeout> | undefined;
    let wrapUpTimer: ReturnType<typeof setTimeout> | undefined;
    // 모델이 낸 순서대로 하나씩 실행한다(Claude Code는 도구를 동시에 부를 수 있고, 브라우저는 하나다)
    const serial = serialQueue();

    const requestStop = (): void => {
      if (stopping) return;
      stopping = true;
      // 입력을 닫으면 CLI는 하던 턴을 마치고 result(사용량)를 낸 뒤 스스로 끝난다. 오지 않으면 끊는다
      proc?.closeInput();
      drainTimer = setTimeout(() => proc?.stop('now'), DRAIN_MS);
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

    const runTool = async (name: string, args: unknown): Promise<ToolOutcome> => {
      const input = (args ?? {}) as Record<string, unknown>;
      if (toolsClosed) throw new Error('이 실행은 이미 끝나 도구를 쓸 수 없습니다');
      if (name === 'qa_report_issue') {
        const added = report.addFinding(input);
        if (added.finding) onEvent?.({ type: 'finding', finding: added.finding });
        return { ok: added.ok, content: added.text };
      }
      if (name === 'qa_finish') {
        report.declare(input);
        if (!wrappingUp) stoppedBy = 'finish';
        requestStop();
        return { ok: true, content: 'qa_finish를 받았습니다. 실행을 마칩니다.' };
      }
      if (wrappingUp || stopping) {
        refusedDuringWrapUp += 1;
        if (refusedDuringWrapUp >= WRAP_UP_REFUSALS) requestStop();
        return { ok: false, content: stopping && !wrappingUp ? '실행이 이미 끝나는 중입니다.' : buildWrapUpPrompt(stoppedBy) };
      }

      if (name === 'qa_expect_rejection') {
        const declared = report.declareRejection(input);
        return { ok: declared.ok, content: declared.text };
      }

      actionCount += 1;
      const { outcome, rejection } = await report.runAction(name, input, browser, actionCount);
      if (rejection) onEvent?.({ type: 'rejection', rejection });
      const diagnostics = await browser.currentDiagnostics();
      const total = countDiagnostics(diagnostics);
      const artifact = await saveActionThumbnail(browser, saveArtifact, actionCount);
      const record: QaActionRecord = {
        index: actionCount,
        tool: name,
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

      let text = outcome.text;
      const repeated = await repeats.record(record, () => browser.screenSignature());
      const limit: ExploreQaStopReason | undefined = repeated ? 'repeated_screen' : actionCount >= maxActions ? 'max_actions' : Date.now() >= deadline ? 'max_time' : undefined;
      if (limit) {
        beginWrapUp(limit);
        text = `${text}\n\n${buildWrapUpPrompt(limit)}`;
      }
      return { ok: outcome.ok, content: text, ...(outcome.image ? { images: [{ data: outcome.image.data.toString('base64'), mimeType: outcome.image.mediaType }] } : {}) };
    };

    const onAbort = () => proc?.stop('now');
    signal?.addEventListener('abort', onAbort, { once: true });
    const deadlineTimer = setTimeout(() => beginWrapUp('max_time'), Math.max(0, deadline - Date.now()));
    deadlineTimer.unref?.();

    let toolServer: ToolServer | undefined;
    const dir = await mkdtemp(path.join(tmpdir(), 'b-studio-qa-cli-'));
    try {
      signal?.throwIfAborted();
      toolServer = await startToolServer({
        specs,
        name: SERVER,
        // 선택 인자(qa_scroll의 ref 등)를 비워 둘 수 있게 스키마의 required를 따른다
        honorRequired: true,
        run: (name, args) =>
          serial(async () => {
            signal?.throwIfAborted();
            return runTool(name, args);
          }),
      });
      const files = { mcp: path.join(dir, 'mcp.json'), systemPrompt: path.join(dir, 'system-prompt.md') };
      // 토큰은 파일에 쓰지 않고 환경 변수 이름만 적는다(러너와 같다)
      await writeFile(files.mcp, JSON.stringify({ mcpServers: { [SERVER]: { type: 'http', url: toolServer.url, headers: { Authorization: `Bearer \${${MCP_TOKEN_ENV}}` } } } }, null, 2), { mode: 0o600 });
      await writeFile(files.systemPrompt, buildQaSystemPrompt(goal), { mode: 0o600 });
      signal?.throwIfAborted();

      proc = spawnClaudeCli({
        command,
        args: [
          ...commandArgs,
          '-p',
          '--input-format',
          'stream-json',
          '--output-format',
          'stream-json',
          '--verbose',
          '--mcp-config',
          files.mcp,
          '--strict-mcp-config',
          // 기본 도구를 모두 끄고 qa_* 도구만 허용한다. 허용 목록에 없는 도구는 묻지 않고 거부한다
          '--tools',
          '',
          '--allowedTools',
          specs.map((spec) => `mcp__${SERVER}__${spec.name}`).join(','),
          '--permission-mode',
          'dontAsk',
          '--setting-sources',
          '',
          '--system-prompt-file',
          files.systemPrompt,
          ...(model ? ['--model', model] : []),
        ],
        cwd,
        env: { ...processEnv, [MCP_TOKEN_ENV]: toolServer.token },
        ...(stopOptions ? { stop: stopOptions } : {}),
      });
      if (signal?.aborted) proc.stop('now');
      proc.send(buildQaUserPrompt(goal));

      try {
        for await (const message of proc.messages()) {
          if (message.type === 'system' && message.subtype === 'init') {
            // 도구 서버에 붙지 못한 채 돌면 모델이 도구 없이 글만 내고 끝난다. 확인하지 못하면 돌리지 않는다
            const broken = mcpSetupFailure(message, SERVER);
            if (broken) {
              toolsClosed = true;
              proc.stop('now');
              throw new Error(broken);
            }
          }
          if (message.type === 'assistant') {
            // 하위 에이전트 메시지는 본 대화로 세지 않는다
            if (message.parent_tool_use_id) continue;
            const id = message.message?.id;
            const messageUsage = message.message?.usage;
            if (id && messageUsage) {
              assistantUsage.set(id, {
                inputTokens: messageUsage.input_tokens ?? 0,
                outputTokens: messageUsage.output_tokens ?? 0,
                cacheReadTokens: messageUsage.cache_read_input_tokens ?? 0,
                cacheWriteTokens: messageUsage.cache_creation_input_tokens ?? 0,
              });
            }
            const blocks = Array.isArray(message.message?.content) ? (message.message!.content as Array<{ type?: string; text?: string }>) : [];
            const text = blocks
              .flatMap((block) => (block.type === 'text' && block.text ? [block.text] : []))
              .join('\n')
              .trim();
            if (text) onEvent?.({ type: 'text', text });
          }
          if (message.type === 'result') {
            // modelUsage는 이 프로세스의 누적값이다. claude-code-runner.ts와 같은 규칙으로 읽는다
            usageTracker.observeResult(message);
            resultSeen = true;
            // 모델이 qa_finish 없이 차례를 마쳤다(도구 없이 글만 냄, 또는 한도 뒤에도 보고 안 함). 같은 대화에서 한 번 더 묻는다
            if (!report.declared && !stopping && !followUpSent) {
              followUpSent = true;
              if (!wrappingUp) beginWrapUp('no_tool_call');
              proc.send(buildWrapUpPrompt(stoppedBy));
              continue;
            }
            break;
          }
        }
      } finally {
        clearTimeout(deadlineTimer);
        if (drainTimer) clearTimeout(drainTimer);
        if (wrapUpTimer) clearTimeout(wrapUpTimer);
        signal?.removeEventListener('abort', onAbort);
        toolsClosed = true;
        // 어떤 경로로 나왔든 프로세스를 끝내고 끝나기를 기다린다(입력을 닫으면 CLI가 스스로 끝난다)
        proc.stop('graceful');
      }
      const exit = await proc.exited;
      // 취소했으면 결과 없음이 아니라 취소다
      signal?.throwIfAborted();
      // 우리가 끊은 경우(보고를 받았거나 유예가 끝남)가 아닌데 결과 없이 끝났으면 통과시키지 않는다
      if (!resultSeen && !stopping) throw new Error(noResultMessage({ ...exit, stderr: proc.stderrTail() }));
    } finally {
      clearTimeout(deadlineTimer);
      signal?.removeEventListener('abort', onAbort);
      toolsClosed = true;
      proc?.stop('now');
      await toolServer?.close().catch(() => {});
      // 이미 시작한 도구 호출은 이어서 돈다. 브라우저를 닫기 전에 끝나기를 기다린다
      await serial.idle();
      await rm(dir, { recursive: true, force: true }).catch(() => {});
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
