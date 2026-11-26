import type Anthropic from '@anthropic-ai/sdk';
import { encodeLoneSurrogates, native } from '@b-studio/sandbox';
import { decodeLoneSurrogates } from './lone-surrogates';
import { clearOldToolResults, resolveContextClearing } from './context-clearing';
import { recheckGateOnMaxTurns, VerificationGate } from './gate';
import { DEFAULT_SAME_SIGNATURE_TIMES, escalationPrompt, retryBudgetFor, shouldPromote, signatureSetKey } from './escalation';
import { buildAskRequest, buildSystemPrompt, projectGuideSection } from './prompts';
import type { AgentResult, AgentUsage, RunAgentOptions, RunMetrics, Steering } from './agent-types';
import { loadProjectGuide } from './project-guide';
import { createToolResultCache } from './tool-output';
import { buildTools, createMismatchLog, executeTool, SANDBOX_TOOLS, WRITE_TOOLS, type AskUserQuestion } from './tools';
import { fetchContract } from './verify';
import { syncExternalChanges, Workspace } from './workspace';
import { executionPolicyFor, workflowContext } from './workflow';

export type {
  AgentEvent,
  AgentRequest,
  AgentResult,
  AgentUsage,
  ModelClient,
  ModelClientInfo,
  ModelPreflight,
  RunAgentOptions,
  RunMetrics,
  Steering,
} from './agent-types';

type BetaMessage = Anthropic.Beta.BetaMessage;
type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
type BetaToolUseBlock = Anthropic.Beta.BetaToolUseBlock;
type BetaToolResultBlockParam = Anthropic.Beta.BetaToolResultBlockParam;

/** 진행 중 지시를 대화에 넣을 때 붙이는 표시 */
export const STEERING_MARKER = '[진행 중 지시]';

/** 지시 여러 개를 한 사용자 메시지로 만든다. 여러 개면 줄바꿈으로 잇는다 */
export function formatSteering(texts: readonly string[]): string {
  return decodeLoneSurrogates(native.agentFormatSteering(texts.map((text) => encodeLoneSurrogates(String(text ?? '')))));
}

/** 지시 큐에서 꺼낸다. 큐 구현이 던져도 실행을 멈추지 않는다 */
export function takeSteering(steering: Steering | undefined): string[] {
  try {
    return steering?.take() ?? [];
  } catch {
    return [];
  }
}

/**
 * 사용자 메시지를 대화에 넣는다. API는 user/assistant가 번갈아야 하므로,
 * 마지막 메시지가 이미 사용자면 거기에 이어 붙이고(도구 결과 배열이면 텍스트 블록을 더한다),
 * 아니면 새 사용자 메시지를 넣는다.
 */
export function appendUserText(messages: BetaMessageParam[], text: string): void {
  const last = messages.at(-1);
  // 어떻게 넣을지는 Rust가 정하고(crates/bstudio-guard/src/steering.rs, ADR-191 3단계 3af), 메시지 배열을 바꾸는 일은 여기서 한다
  const kind = typeof last?.content === 'string' ? 'string' : Array.isArray(last?.content) ? 'array' : 'other';
  const plan = native.agentAppendUserPlan(last?.role, kind);
  if (last && plan === 'concat') {
    last.content = `${last.content as string}\n\n${text}`;
  } else if (last && plan === 'push') {
    (last.content as Exclude<typeof last.content, string>).push({ type: 'text', text });
  } else {
    messages.push({ role: 'user', content: text });
  }
}

export function emptyUsage(): AgentUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/**
 * Plan → Code → Run → Verify 루프.
 * 모델은 도구로 탐색·수정·실행하고, 턴을 끝내면 스튜디오가 검증 게이트를 돌린다.
 * 게이트가 실패하면 결과를 돌려주고 루프를 이어 가며, 통과해야만 완료로 본다.
 */
export async function runAgent(options: RunAgentOptions): Promise<AgentResult> {
  const messages = options.conversation ?? [];
  const startLength = messages.length;
  try {
    return await run(options, messages);
  } catch (error) {
    // 도구 호출 뒤 결과를 붙이기 전에 끊기면 대화가 API 규칙을 어기므로 이번 실행분을 버린다
    messages.splice(startLength);
    throw error;
  }
}

async function run(options: RunAgentOptions, messages: BetaMessageParam[]): Promise<AgentResult> {
  const {
    request,
    project,
    sandbox,
    client,
    allowBreaking = false,
    maxTurns = 60,
    maxVerifyAttempts = 3,
    signal,
    onEvent = () => {},
    onServiceStatus,
    fetcher = fetchContract,
    pageFetcher,
    browserRunner,
    saveArtifact,
    interactive = false,
    intent = 'build',
    research = false,
  } = options;
  const ask = intent === 'ask';

  if (client.info) onEvent({ type: 'session', backend: client.info.backend, model: client.info.model, auth: client.info.auth, effort: client.info.effort });

  const workspace = new Workspace(project.root);
  // 요구사항 문서의 기준을 고정한다(게이트가 사람 확인 기록 위조를 견주는 기준, ADR-157). 호출자가 마지막 체크포인트의
  // 문서를 넘겼으면 그것을, 아니면 지금 디스크의 문서를 쓴다
  workspace.beginRun(options.requirementsBaseline);
  // 이번 실행 전부터 작업 트리에 있던 변경(보관본 되살리기 등)을 먼저 알려, 에이전트가 이번 실행에서 파일을
  // 하나도 건드리지 않아도 게이트가 "검증할 변경 없음"으로 건너뛰지 않게 한다(ADR-131)
  if (options.externalChanges?.length) syncExternalChanges(workspace, options.externalChanges);
  // 질문 모드는 파일을 바꾸지 않으므로 계약 기준을 잡거나 게이트를 돌리지 않는다.
  // 지연 기동 세션(ensureSandbox)은 게이트를 여기서 만들지 않고, 첫 파일 변경·샌드박스 도구 때 샌드박스를 켠 뒤에 만든다.
  // 계약 기준은 샌드박스가 켜진 뒤, 아직 바뀌지 않은 코드에서 잡아야 하기 때문이다
  let gate: VerificationGate | undefined;
  let gatePromise: Promise<VerificationGate> | undefined;
  const gateFor = (): Promise<VerificationGate> =>
    (gatePromise ??= VerificationGate.create({
      project,
      sandbox,
      workspace,
      allowBreaking,
      maxVerifyAttempts,
      verify: options.verify,
      allowCheckChanges: options.allowCheckChanges,
      outsideChanges: options.outsideChanges,
      fetcher,
      pageFetcher,
      browserRunner,
      saveArtifact,
      signal,
      onServiceStatus,
      onEvent,
    }));
  if (!ask && !options.ensureSandbox) gate = await gateFor();
  // 프로젝트 루트(세션 작업 복사본)의 AGENTS.md를 매 실행 시작마다 새로 읽는다(ADR-077) — 이전 실행이나
  // 사람이 방금 고친 내용을 이번 실행부터 반영하기 위해서다. 파일이 없거나 꺼져 있으면 빈 문자열이라 고정 문맥이 늘지 않는다
  const guide = await loadProjectGuide(project);
  const system = buildSystemPrompt(project, { selfCheck: options.selfCheck }) + workflowContext(project) + projectGuideSection(guide);
  const policy = options.policy ?? executionPolicyFor(project);
  const tools = buildTools(project, {
    ...(options.board ? { board: options.board } : {}),
    // 허용 도구 목록은 조율 도구와 어긋남 보고 도구를 넣을지 정할 때만 쓴다
    ...(policy?.allowedTools ? { allowedTools: policy.allowedTools } : {}),
    interactive,
    mismatch: !ask,
  });
  let stage: import('@b-studio/spec').WorkflowStage = 'plan';
  onEvent({ type: 'stage', stage, source: 'platform' });
  messages.push({ role: 'user', content: ask ? buildAskRequest(request, research ? { research: { webToolsAvailable: false } } : {}) : request });
  const usage = emptyUsage();
  const metrics = emptyMetrics();
  // 모델 id별 사용량. 승격으로 클라이언트가 바뀌면 승격 전후가 다른 키로 쌓인다
  const usageByModel: Record<string, AgentUsage> = {};
  metrics.usageByModel = usageByModel;
  if (guide) metrics.guideChars = guide.charsUsed;
  // 이번 턴에 ask_user가 남긴 질문. 있으면 도구 결과를 넣은 뒤 실행을 끝내고 사용자 답을 기다린다
  let asked: AskUserQuestion | undefined;
  // report_mismatch가 남긴 어긋남. 결과에 실어 호출자가 "확인 필요"로 보인다
  const mismatches = createMismatchLog();
  // 실행 단위 도구 결과 캐시. 한 실행 안에서 같은 도구·같은 입력의 결과가 반복되면 본문 대신 참조를 넣는다
  const toolCache = createToolResultCache();
  // 기본은 끔 — 효과를 재기 전이다. B_STUDIO_CONTEXT_CLEARING=on이면 기본 정책으로 켠다
  const contextClearing = resolveContextClearing(options.contextClearing, process.env);
  // 직전 턴이 모델에 보낸 입력 크기. 이 값이 임계치를 넘으면 다음 호출 전에 오래된 도구 결과를 묶어서 비운다
  let previousContextTokens = 0;
  // 승격은 게이트의 실패 서명이 정한다. 게이트 실패마다 서명 집합을 쌓고, 같은 집합이 연속되면 모델을 바꾼다
  const escalation = options.escalation;
  const escalationHistory: string[] = [];
  let escalated = false;
  let activeClient = client;
  /** 마지막으로 모델에게 보낸 게이트 실패 안내. 상한이 소진된 뒤 승격하면 같은 안내를 다시 보낸다 */
  let lastFeedback: string | undefined;

  const finish = (status: AgentResult['status'], summary: string, turns: number, question?: AskUserQuestion, failureReason?: AgentResult['failureReason']): AgentResult => {
    const result: AgentResult = {
      status,
      summary,
      changedFiles: workspace.changedFiles(),
      ...(question ? { question } : {}),
      report: gate?.report,
      checks: gate?.checks,
      ...(gate?.lastOutcome ? { gateOutcome: gate.lastOutcome } : {}),
      passedStages: gate ? [...gate.passedStages] : undefined,
      ...(options.verify === 'light' ? { verify: 'light' as const } : {}),
      ...(status === 'done' && gate?.passedAtTurnLimit ? { incomplete: 'max_turns' as const } : {}),
      ...(gate && gate.skippedStages.length > 0 ? { skippedStages: [...gate.skippedStages] } : {}),
      ...((status === 'done' || status === 'awaiting_input') && gate?.lastOutcome === 'pass' && gate.verifiedFingerprints
        ? { verifiedFingerprints: Object.fromEntries(gate.verifiedFingerprints) }
        : {}),
      verifyAttempts: gate?.attempts ?? 0,
      turns,
      usage,
      metrics: { ...metrics },
      ...(failureReason ? { failureReason } : {}),
      ...(mismatches.list.length > 0 ? { mismatches: [...mismatches.list] } : {}),
    };
    onEvent(status === 'failed' ? { type: 'failed', result } : { type: 'done', result });
    return result;
  };

  for (let turn = 1; turn <= maxTurns; turn++) {
    signal?.throwIfAborted();
    onEvent({ type: 'turn', turn });

    // 오래된 도구 결과를 **한 번에 묶어서** 비운다. 매 턴 조금씩 지우면 그때마다 그 지점부터 프롬프트 캐시가 깨진다
    if (contextClearing && previousContextTokens >= contextClearing.triggerTokens) {
      const cleared = clearOldToolResults(messages, contextClearing);
      if (cleared.clearedCount > 0) {
        // 대화 배열은 호출자가 쥐고 있으므로 같은 배열을 그대로 채운다(참조를 바꾸지 않는다)
        messages.splice(0, messages.length, ...cleared.messages);
        onEvent({ type: 'context_cleared', turn, clearedCount: cleared.clearedCount, clearedChars: cleared.clearedChars });
      }
    }

    // 진행 중 지시는 다음 모델 호출 직전에만 넣는다. 도구 결과가 들어간 뒤라 도구 호출 도중에 끼어들지 않는다
    const steering = takeSteering(options.steering);
    if (steering.length > 0) {
      appendUserText(messages, formatSteering(steering));
      onEvent({ type: 'steer_applied', count: steering.length });
    }

    const modelStarted = performance.now();
    const message = await activeClient.createMessage({ system, tools, messages }, signal);
    metrics.modelMs = (metrics.modelMs ?? 0) + Math.round(performance.now() - modelStarted);
    metrics.modelCalls += 1;
    const turnContext = contextTokens(message.usage);
    metrics.maxContextTokens = Math.max(metrics.maxContextTokens, turnContext);
    addUsage(usage, message.usage);
    // 모델별 사용량. 클라이언트가 모델 id를 알려 주면 그 이름으로, 아니면 '알 수 없음'으로 묶는다
    addUsage((usageByModel[activeClient.info?.model ?? '알 수 없음'] ??= emptyUsage()), message.usage);
    // 요청이 취소되거나 오류로 끝나도 그때까지 쓴 양을 알 수 있게 응답마다 알린다
    onEvent({ type: 'tokens', usage: { ...usage } });
    // 그 턴 한 번의 사용량. 실행 누적값(tokens)과 달리 턴별 컨텍스트 증가를 볼 수 있다
    onEvent({
      type: 'turn_usage',
      turn,
      inputTokens: message.usage.input_tokens ?? 0,
      outputTokens: message.usage.output_tokens ?? 0,
      cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
      cacheWriteTokens: message.usage.cache_creation_input_tokens ?? 0,
      contextTokens: turnContext,
    });
    // 다음 턴은 이 크기를 보고 오래된 도구 결과를 비울지 정한다
    previousContextTokens = turnContext;
    // thinking·fallback 블록까지 응답 전체를 그대로 이어 붙여야 다음 요청이 올바르게 이어진다
    messages.push({ role: 'assistant', content: message.content });

    const text = message.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n')
      .trim();
    if (text) onEvent({ type: 'text', text });

    if (message.stop_reason === 'refusal') {
      return finish('failed', `모델이 요청을 거절했습니다 (${message.stop_details?.category ?? 'category 없음'})`, turn);
    }
    if (message.stop_reason === 'model_context_window_exceeded') {
      return finish('failed', '대화가 모델의 컨텍스트 한도를 넘었습니다', turn);
    }

    const toolUses = message.content.filter((block): block is BetaToolUseBlock => block.type === 'tool_use');
    if (toolUses.length > 0) {
      // 쓰기 도구가 섞일 수 있으므로 모델이 낸 순서대로 실행하고, 결과는 한 메시지로 모아 돌려준다
      const results: BetaToolResultBlockParam[] = [];
      for (const call of toolUses) {
        onEvent({ type: 'tool_call', name: call.name, input: call.input });
        // 지연 기동 세션: 첫 파일 변경·샌드박스 도구일 때 샌드박스를 켠다. 게이트(계약 기준)는 그 뒤에 만들어진다
        if (options.ensureSandbox && (SANDBOX_TOOLS.has(call.name) || WRITE_TOOLS.has(call.name))) {
          await options.ensureSandbox();
          gate ??= await gateFor();
        }
        const toolStarted = performance.now();
        const outcome = await executeTool(call.name, call.input, {
          project,
          workspace,
          sandbox,
          selfCheck: options.selfCheck,
          fetcher,
          signal,
          onServiceStatus,
          readOnly: ask,
          onQuestion: (question) => {
            asked = question;
            onEvent({ type: 'question', ...question });
          },
          onMismatch: (mismatch) => {
            if (mismatches.add(mismatch)) onEvent({ type: 'mismatch', ...mismatch });
          },
          policy,
          approvalToken: options.approvalToken,
          requestApproval: options.requestApproval,
          board: options.board,
          onPolicyDecision: (decision) => onEvent({ type: 'policy', ...decision }),
          toolResults: toolCache,
        });
        metrics.toolMs += Math.round(performance.now() - toolStarted);
        if (outcome.ok && (call.name === 'write_file' || call.name === 'edit_file') && stage === 'plan') {
          stage = 'implement';
          onEvent({ type: 'stage', stage, source: 'platform' });
        } else if (outcome.ok && (call.name === 'run_in_service' || call.name === 'restart_service') && stage !== 'run') {
          stage = 'run';
          onEvent({ type: 'stage', stage, source: 'platform' });
        }
        onEvent({ type: 'tool_result', name: call.name, ok: outcome.ok, content: outcome.content, chars: outcome.content.length, rawChars: outcome.rawChars ?? outcome.content.length });
        results.push({ type: 'tool_result', tool_use_id: call.id, content: outcome.content, is_error: !outcome.ok });
      }
      messages.push({ role: 'user', content: results });
      // 되묻고 멈추기: 질문이 나오면 실행을 끝내고 사용자 답을 다음 요청으로 받는다.
      // 도구 결과를 먼저 대화에 넣어 두어 이어받는 러너가 맥락을 그대로 잇는다.
      // 질문 전에 파일을 바꿨다면 그 변경도 게이트를 돌린다(변경이 없으면 돌리지 않는다)
      if (asked) {
        if (gate && workspace.changedFiles().length > 0) {
          const gateStarted = performance.now();
          await gate.check();
          metrics.gateMs += Math.round(performance.now() - gateStarted);
        }
        return finish('awaiting_input', asked.question, turn, asked);
      }
      continue;
    }

    if (message.stop_reason === 'pause_turn') continue;
    if (message.stop_reason === 'max_tokens') {
      messages.push({ role: 'user', content: '응답이 max_tokens에서 잘렸습니다. 이어서 진행하세요.' });
      continue;
    }

    // 모델이 턴을 끝냈다 → 질문이면 답이 곧 결과이고, 만들기면 검증 게이트
    if (!gate) return finish('done', text, turn);
    // 단계 이벤트(실행·계약·화면·테스트·리뷰)는 게이트가 직접 알린다. 로컬 Claude Code 러너도 같은 게이트를 쓴다
    const gateStarted = performance.now();
    const outcome = await gate.check();
    metrics.gateMs += Math.round(performance.now() - gateStarted);
    if (outcome.kind === 'pass') {
      // 바뀐 파일이 없어 검증 없이 끝났다면 체크포인트할 것도 없다
      if (gate.verified) onEvent({ type: 'stage', stage: 'checkpoint', source: 'platform' });
      return finish('done', text, turn);
    }
    // 승격: 게이트 실패가 계기가 된다(같은 서명이 반복되거나, 설정이 있으면 실패 N번). 한 실행에 한 번만 올린다
    if (escalation && !escalated) {
      const key = signatureSetKey(gate.report, gate.checks);
      escalationHistory.push(key);
      if (shouldPromote(escalation, escalationHistory)) {
        // 올라간 모델에게는 게이트 재시도를 새로 준다(기존 남은 횟수 대신)
        const extended = gate.grantRetryBudget(retryBudgetFor(escalation));
        // 상한이 이미 소진됐는데 예산도 못 받았으면 올려도 시도할 기회가 없다 — 지금처럼 실패로 끝낸다
        if (outcome.kind === 'exhausted' && !extended) return finish('failed', outcome.summary, turn);
        escalated = true;
        metrics.escalatedAt = gate.attempts;
        onEvent({
          type: 'model_escalated',
          from: client.info?.model ?? '알 수 없음',
          to: escalation.to,
          attempt: gate.attempts,
          signature: key,
          sameSignatureTimes: escalation.sameSignatureTimes ?? DEFAULT_SAME_SIGNATURE_TIMES,
        });
        activeClient = escalation.client;
        if (outcome.kind === 'exhausted') {
          // 상한을 새로 받았으면 마지막 실패 안내를 다시 보내고 이어 간다
          messages.push({ role: 'user', content: escalationPrompt(outcome.summary, lastFeedback) });
          continue;
        }
      }
    }
    if (outcome.kind === 'exhausted') return finish('failed', outcome.summary, turn);
    lastFeedback = outcome.feedback;
    messages.push({ role: 'user', content: outcome.feedback });
  }

  // 턴 상한에 걸렸다. 바로 실패로 끝내지 않고 지금까지의 변경이 게이트를 통과하는지 한 번 더 본다(ADR-131)
  const gateStarted = performance.now();
  const recheck = await recheckGateOnMaxTurns(gate, maxTurns, onEvent);
  metrics.gateMs += Math.round(performance.now() - gateStarted);
  if (recheck.pass) return finish('done', recheck.summary, maxTurns);
  return finish('failed', recheck.summary, maxTurns, undefined, 'max_turns');
}

function addUsage(total: AgentUsage, usage: BetaMessage['usage']): void {
  total.inputTokens += usage.input_tokens ?? 0;
  total.outputTokens += usage.output_tokens ?? 0;
  total.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
  total.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
}

function emptyMetrics(): RunMetrics {
  return { modelCalls: 0, maxContextTokens: 0, modelMs: 0, toolMs: 0, gateMs: 0 };
}

/**
 * 모델이 실제로 받은 입력 크기. Anthropic 응답의 input_tokens는 캐시 분을 빼고 세므로
 * cache_read·cache_creation을 더해야 한 호출의 입력 크기가 된다.
 */
function contextTokens(usage: BetaMessage['usage']): number {
  return (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
}
