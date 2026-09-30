/**
 * 한 프로젝트의 모든 세션 기록에서 "얼마나 썼고, b-studio가 얼마나 줄였는가"를 모은다.
 *
 * 읽는 쪽은 얇게 둔다: 프로젝트의 세션 목록(listSessions)과 세션 기록(sessionHistory)만 읽고,
 * 계산은 순수 함수(`buildProjectTokenReport`)가 한다. 레인·통합·플릿 멤버도 같은 projectId의 세션이라 함께 모인다.
 *
 * 두 가지를 분명히 나눈다.
 *  - **측정값**: 기록에 남은 사실(토큰, 환산 비용, 잘라낸 글자, 비운 글자, 반복 대체 횟수).
 *  - **추정**: 잘린 결과가 남은 호출마다 다시 읽혔을 양. 글자 수를 4로 나눈 근사라서 화면·마크다운에서 따로 표시한다.
 */
import type { AgentUsage, Effort } from '@b-studio/agent';
import {
  MAX_REQUEST_ROWS,
  PRICE_DISCLAIMER,
  PROJECT_KIND_ORDER,
  REQUEST_RESULT_LABEL,
  SESSION_KIND_LABEL,
  TRIM_ESTIMATE_METHOD,
  UNKNOWN_MODEL,
  formatCost,
  formatRatio,
  formatTokens,
  formatUtcStamp,
  priceSourceLabel,
  rangeText,
  totalTokens,
  type ProjectKindTotals,
  type ProjectRequestResult,
  type ProjectRequestRow,
  type ProjectSessionKind,
  type ProjectTokenReport,
} from '../project-token-types';
import type { StudioEvent } from '../studio-events';
import { estimateCostUsd, matchTokenPrices, type TokenPrices } from '../token-types';
import { StudioError } from './errors';
import { listFleets } from './fleets';
import { findProject } from './projects';
import { listSessions, sessionHistory } from './sessions';
import { listTaskPlans } from './task-plans';
import { buildTokenReports, tokenPricing, type TokenPricing } from './token-report';

export { SESSION_KIND_LABEL, REQUEST_RESULT_LABEL, UNKNOWN_MODEL, PRICE_DISCLAIMER, TRIM_ESTIMATE_METHOD, rangeText } from '../project-token-types';
export type {
  ProjectKindTotals,
  ProjectRequestResult,
  ProjectRequestRow,
  ProjectSavedTotals,
  ProjectSessionKind,
  ProjectTokenReport,
} from '../project-token-types';

export interface ProjectSessionEvents {
  sessionId: string;
  kind: ProjectSessionKind;
  events: readonly StudioEvent[];
}

function emptyUsage(): AgentUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function addUsage(target: AgentUsage, usage: AgentUsage): void {
  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.cacheReadTokens += usage.cacheReadTokens;
  target.cacheWriteTokens += usage.cacheWriteTokens;
}

function hasTokens(usage: AgentUsage): boolean {
  return totalTokens(usage) > 0;
}

/** 실행의 시작 시각. run_started에 시각이 있으면 그 값을, 없는 옛 기록은 실행 안에서 처음 만난 시각을 쓴다 */
export function runTimestamps(events: readonly StudioEvent[]): Map<string, string> {
  const times = new Map<string, string>();
  let current: string | undefined;
  for (const event of events) {
    if (event.type === 'run_started') {
      current = event.runId;
      if (event.at) times.set(current, event.at);
      continue;
    }
    if (event.type === 'run_finished') {
      if (current === event.runId) current = undefined;
      continue;
    }
    if (!current || times.has(current)) continue;
    const at = timestampOf(event);
    if (at) times.set(current, at);
  }
  return times;
}

function timestampOf(event: StudioEvent): string | undefined {
  switch (event.type) {
    case 'log':
      return event.at;
    case 'usage':
      return event.at;
    case 'checkpoint':
      return event.checkpoint.createdAt;
    case 'local_edits_saved':
      return event.checkpoint.createdAt;
    default:
      return undefined;
  }
}

/**
 * 기간 필터를 ISO 문자열 경계로 바꾼다. `to`가 날짜만(`YYYY-MM-DD`)이면 그날 끝까지 포함한다.
 * 형식이 이상하면 400으로 알린다.
 */
export function rangeBounds(range: { from?: string; to?: string } | undefined): { from?: string; to?: string } | undefined {
  if (!range) return undefined;
  const bounds: { from?: string; to?: string } = {};
  const parse = (value: string, name: string, endOfDay: boolean): string => {
    const date = endOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T23:59:59.999Z`) : new Date(value);
    if (Number.isNaN(date.getTime())) throw new StudioError(400, `${name} 시각을 읽지 못했습니다: ${value}`);
    return date.toISOString();
  };
  const from = range.from?.trim();
  const to = range.to?.trim();
  if (from) bounds.from = parse(from, 'from', false);
  if (to) bounds.to = parse(to, 'to', true);
  if (!bounds.from && !bounds.to) return undefined;
  if (bounds.from && bounds.to && bounds.from > bounds.to) throw new StudioError(400, 'from은 to보다 앞이어야 합니다');
  return bounds;
}

/**
 * 프로젝트의 세션 기록을 모아 보고서를 만든다(순수 계산).
 * `generatedAt`은 호출자가 넘긴다(여기서 시계를 읽지 않아 테스트가 같은 값을 본다).
 */
export function buildProjectTokenReport(input: {
  projectId: string;
  projectName: string;
  sessions: readonly ProjectSessionEvents[];
  generatedAt: string;
  pricing?: TokenPricing;
  range?: { from?: string; to?: string };
}): ProjectTokenReport {
  const pricing = input.pricing ?? {};
  const bounds = rangeBounds(input.range);
  const totals = emptyUsage();
  const usageByModel: Record<string, AgentUsage> = {};
  const modelCosts: Record<string, number> = {};
  const requests: ProjectRequestRow[] = [];
  const kindSessions = new Map<ProjectSessionKind, number>();
  const skippedByStage = new Map<string, number>();
  const notes: string[] = [];
  let modelCalls = 0;
  let estimatedCostUsd = 0;
  let pricedRuns = 0;
  let unpricedRuns = 0;
  let singlePriced = false;
  let byModelPriced = false;
  let costNote: string | undefined;
  let trimmedChars = 0;
  let repeatedResults = 0;
  let clearedCount = 0;
  let clearedChars = 0;
  let lightRuns = 0;
  let trimmedTokensEstimated = 0;
  let requestsWithoutTime = 0;

  for (const session of input.sessions) {
    kindSessions.set(session.kind, (kindSessions.get(session.kind) ?? 0) + 1);
    const events = session.events;
    const reports = buildTokenReports(events, pricing);
    const timestamps = runTimestamps(events);
    const light = lightRunsOf(events);
    const changed = changedRunsOf(events);
    const status = runStatus(events);
    const calls = modelCallsOf(events);
    const turns = turnsOf(events);
    const efforts = effortOf(events);

    for (const report of reports) {
      const at = timestamps.get(report.runId);
      // 기간을 주면 시각이 남은 실행만 센다. 시각이 없는 실행을 조용히 빼지 않고 아래에서 몇 개인지 알린다
      if (bounds) {
        if (!at) {
          requestsWithoutTime += 1;
          continue;
        }
        if (bounds.from && at < bounds.from) continue;
        if (bounds.to && at > bounds.to) continue;
      }

      addUsage(totals, report.totals);
      modelCalls += calls.get(report.runId) ?? 0;
      // 모델별 내역이 있으면 그대로, 없으면 "(모름)"으로 묶는다(구독 CLI 러너는 모델별 토큰을 남기지 않는다)
      const byModel = report.usageByModel;
      if (byModel && Object.keys(byModel).length > 0) {
        for (const [model, usage] of Object.entries(byModel)) {
          addUsage((usageByModel[model] ??= emptyUsage()), usage);
          const cost = report.modelCosts?.[model];
          if (cost !== undefined) modelCosts[model] = (modelCosts[model] ?? 0) + cost;
        }
      } else if (hasTokens(report.totals)) {
        addUsage((usageByModel[UNKNOWN_MODEL] ??= emptyUsage()), report.totals);
      }

      // 비용: 단가가 없으면 합계를 비우고 사유를 남긴다(일부 모델만 단가가 없을 때도 합계는 쓰지 않는다 — 실제보다 싸 보이기 때문)
      if (report.estimatedCostUsd !== undefined) {
        estimatedCostUsd += report.estimatedCostUsd;
        pricedRuns += 1;
        if (report.priceSource === 'by-model') byModelPriced = true;
        else if (report.priceSource === 'single') singlePriced = true;
      } else {
        unpricedRuns += 1;
        if (report.priceNote && costNote === undefined) costNote = report.priceNote;
      }

      trimmedChars += report.trimmed.chars;
      repeatedResults += report.trimmed.repeated;
      trimmedTokensEstimated += report.trimmed.estimatedTokens;
      clearedCount += report.cleared.count;
      clearedChars += report.cleared.chars;
      if (light.has(report.runId)) {
        lightRuns += 1;
        for (const stage of light.get(report.runId) ?? []) skippedByStage.set(stage, (skippedByStage.get(stage) ?? 0) + 1);
      }

      const finished = status.get(report.runId);
      const result: ProjectRequestResult =
        finished === undefined
          ? 'running'
          : finished === 'done' || finished === 'awaiting_input'
            ? light.has(report.runId)
              ? 'light'
              : changed.has(report.runId)
                ? 'changed'
                : 'answered'
            : 'failed';

      requests.push({
        sessionId: session.sessionId,
        kind: session.kind,
        request: clip(report.request, 60),
        ...(at ? { at } : {}),
        usage: report.totals,
        ...(report.estimatedCostUsd === undefined ? {} : { costUsd: report.estimatedCostUsd }),
        ...(turns.get(report.runId) === undefined ? {} : { turns: turns.get(report.runId)! }),
        ...(efforts.get(report.runId) === undefined ? {} : { effort: efforts.get(report.runId) as Effort }),
        result,
      });
    }
  }

  // 단일 단가만 있고 모델별 내역이 없는 실행은 모델 표의 비용 칸이 비므로, 그 단가로 채워 준다
  if (pricing.single && usageByModel[UNKNOWN_MODEL] && modelCosts[UNKNOWN_MODEL] === undefined) {
    modelCosts[UNKNOWN_MODEL] = estimateCostUsd(usageByModel[UNKNOWN_MODEL], pricing.single);
  }

  const kinds: ProjectKindTotals[] = PROJECT_KIND_ORDER.filter((kind) => kindSessions.has(kind)).map((kind) => {
    const ofKind = requests.filter((request) => request.kind === kind);
    const usage = emptyUsage();
    for (const request of ofKind) addUsage(usage, request.usage);
    const costs = ofKind.map((request) => request.costUsd);
    return {
      kind,
      sessions: kindSessions.get(kind) ?? 0,
      requests: ofKind.length,
      usage,
      ...(costs.length > 0 && costs.every((cost) => cost !== undefined) ? { costUsd: costs.reduce((sum, cost) => sum + cost!, 0) } : {}),
    };
  });

  if (requestsWithoutTime > 0) notes.push(`시각을 남기지 않은 실행 ${requestsWithoutTime}개는 기간 필터에서 뺐습니다`);
  if (usageByModel[UNKNOWN_MODEL]) notes.push(`모델별 내역을 남기지 않는 러너(구독 CLI 등)의 토큰은 "${UNKNOWN_MODEL}"으로 묶었습니다`);
  if (pricing.error) notes.push(pricing.error);
  if (unpricedRuns > 0) {
    // 일부만 계산한 합계는 실제보다 싸 보이므로 쓰지 않는다(토큰 탭과 같은 규칙). 왜 못 썼는지 여기서 알린다
    notes.push(`단가를 찾지 못한 실행 ${unpricedRuns}개가 있어 합계 환산 비용을 쓰지 않았습니다${costNote && costNote !== '단가 미설정' ? ` (${costNote})` : ''}`);
  }

  const cacheReadPrices = cacheReadPrice(pricing, usageByModel);
  const costAvailable = pricedRuns > 0 && unpricedRuns === 0;
  return {
    projectId: input.projectId,
    projectName: input.projectName,
    generatedAt: input.generatedAt,
    ...(bounds ? { range: bounds } : {}),
    sessions: input.sessions.length,
    requests,
    totals,
    modelCalls,
    usageByModel,
    modelCosts,
    ...(costAvailable ? { estimatedCostUsd } : {}),
    priceSource: byModelPriced ? 'by-model' : singlePriced ? 'single' : 'none',
    ...(costAvailable ? {} : { priceNote: costNote ?? '단가 미설정' }),
    cacheHitRatio: cacheHitRatio(totals),
    kinds,
    saved: {
      trimmedChars,
      repeatedResults,
      clearedCount,
      clearedChars,
      lightRuns,
      lightSkipped: [...skippedByStage.entries()]
        .map(([stage, runs]) => ({ stage, runs }))
        .sort((a, b) => b.runs - a.runs || a.stage.localeCompare(b.stage)),
      trimmedTokensEstimated,
      ...(cacheReadPrices
        ? { trimmedCostUsd: (trimmedTokensEstimated / 1_000_000) * cacheReadPrices.prices.cacheReadPerM, trimmedCostModel: cacheReadPrices.model }
        : {}),
    },
    notes,
  };
}

/**
 * 잘린 결과를 금액으로 환산할 때 쓸 캐시 읽기 단가를 고른다. 어느 모델이 잘린 결과를 읽었는지는 기록에 없으므로
 * 단가 표가 있으면 **가장 많이 쓴 모델**의 단가를, 단일 단가만 있으면 그것을 쓴다.
 */
function cacheReadPrice(pricing: TokenPricing, usageByModel: Record<string, AgentUsage>): { model: string; prices: TokenPrices } | undefined {
  if (pricing.byModel) {
    const ranked = Object.entries(usageByModel)
      .map(([model, usage]) => ({ model, total: totalTokens(usage) }))
      .sort((a, b) => b.total - a.total);
    for (const { model } of ranked) {
      const prices = matchTokenPrices(pricing.byModel, model);
      if (prices) return { model, prices };
    }
  }
  if (pricing.single) return { model: '(단일 단가)', prices: pricing.single };
  return undefined;
}

/** 가볍게 확인으로 끝난 실행과 건너뛴 단계 */
function lightRunsOf(events: readonly StudioEvent[]): Map<string, string[]> {
  const runs = new Map<string, string[]>();
  for (const event of events) {
    if (event.type === 'run_finished' && event.verify === 'light') runs.set(event.runId, event.skippedStages ?? []);
  }
  return runs;
}

/** 파일을 바꾼 실행(게이트를 돌았거나 체크포인트가 남은 실행) */
function changedRunsOf(events: readonly StudioEvent[]): Set<string> {
  const runs = new Set<string>();
  for (const event of events) {
    if (event.type === 'checkpoint') runs.add(event.runId);
    else if (event.type === 'agent' && event.event.type === 'verify_start') runs.add(event.runId);
  }
  return runs;
}

/** 실행이 어떻게 끝났는가. 아직 끝나지 않았으면 없다 */
function runStatus(events: readonly StudioEvent[]): Map<string, string> {
  const runs = new Map<string, string>();
  for (const event of events) if (event.type === 'run_finished') runs.set(event.runId, event.status);
  return runs;
}

/** 실행별 모델 호출 수(run_finished.metrics). 지표를 남기지 않는 러너는 0으로 센다 */
function modelCallsOf(events: readonly StudioEvent[]): Map<string, number> {
  const calls = new Map<string, number>();
  for (const event of events) {
    if (event.type === 'run_finished') calls.set(event.runId, event.metrics?.modelCalls ?? 0);
  }
  return calls;
}

function turnsOf(events: readonly StudioEvent[]): Map<string, number> {
  const turns = new Map<string, number>();
  for (const event of events) {
    if (event.type === 'run_finished' && event.turns !== undefined) turns.set(event.runId, event.turns);
  }
  return turns;
}

/** 실행마다 실제로 쓴 노력 단계. 러너가 실행 환경을 알릴 때(agent 'session' 이벤트) 함께 싣는다(loop.ts·claude-code-runner.ts 등) */
function effortOf(events: readonly StudioEvent[]): Map<string, string> {
  const efforts = new Map<string, string>();
  for (const event of events) {
    if (event.type === 'agent' && event.event.type === 'session' && event.event.effort) efforts.set(event.runId, event.event.effort);
  }
  return efforts;
}

function cacheHitRatio(usage: AgentUsage): number {
  const denominator = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  return denominator === 0 ? 0 : usage.cacheReadTokens / denominator;
}

/** 요청을 한 줄로 줄인다(기본 60자) */
export function clip(text: string, max: number): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max)}…` : one;
}

/**
 * 얇은 읽기: 프로젝트의 모든 세션 기록을 모아 보고서를 만든다.
 * 보기는 로그인한 누구나 할 수 있다(ADR-040). 세션 기록을 바꾸지 않는다.
 */
export async function projectTokenReport(
  projectId: string,
  options: { viewer: string; from?: string; to?: string; now?: string },
): Promise<ProjectTokenReport> {
  const project = await findProject(projectId);
  if (!project) throw new StudioError(404, '프로젝트를 찾을 수 없습니다');
  const sessions = (await listSessions()).filter((session) => session.projectId === projectId);
  const kinds = sessionKinds(projectId, options.viewer);
  const inputs: ProjectSessionEvents[] = sessions.map((session) => ({
    sessionId: session.id,
    kind: kinds.get(session.id) ?? 'normal',
    events: sessionHistory(session.id),
  }));
  return buildProjectTokenReport({
    projectId,
    projectName: project.spec.name,
    sessions: inputs,
    generatedAt: options.now ?? new Date().toISOString(),
    pricing: tokenPricing(process.env),
    range: { from: options.from, to: options.to },
  });
}

/**
 * 레인·통합·플릿 멤버 세션을 찾는다. 계획·플릿 기록은 만든 사람별로 보이므로
 * 로그인한 사람의 기록에서 찾은 것만 표시된다(남의 기록은 '일반'으로 남는다).
 */
function sessionKinds(projectId: string, viewer: string): Map<string, ProjectSessionKind> {
  const kinds = new Map<string, ProjectSessionKind>();
  for (const plan of listTaskPlans(viewer)) {
    if (plan.projectId !== projectId) continue;
    for (const lane of plan.lanes) if (lane.sessionId) kinds.set(lane.sessionId, 'lane');
    if (plan.integration?.sessionId) kinds.set(plan.integration.sessionId, 'integration');
  }
  for (const fleet of listFleets(viewer)) {
    if (fleet.projectId !== projectId) continue;
    for (const member of fleet.members) kinds.set(member.sessionId, 'fleet');
  }
  return kinds;
}

/**
 * 프로젝트 보고서를 마크다운으로 만든다(과제 README·포트폴리오에 붙이는 용도).
 * 요청별 표는 최근 순 최대 50줄이고, 시각은 어디서 읽어도 같은 값이 되도록 UTC로 적는다.
 */
export function projectTokenMarkdown(report: ProjectTokenReport, options: { requestLimit?: number } = {}): string {
  const limit = options.requestLimit ?? MAX_REQUEST_ROWS;
  const lines: string[] = [];
  lines.push(`# b-studio 토큰 사용 보고서 — ${report.projectName}`, '');
  lines.push(`- 프로젝트: \`${report.projectId}\``);
  lines.push(`- 기간: ${rangeText(report.range)}`);
  lines.push(`- 만든 시각: ${formatUtcStamp(report.generatedAt)}`);
  lines.push(`- 세션: ${report.sessions}개 (${report.kinds.map((entry) => `${SESSION_KIND_LABEL[entry.kind]} ${entry.sessions}`).join(' · ') || '없음'})`);
  lines.push('');

  lines.push('## 요약', '');
  lines.push('| 항목 | 값 |', '| --- | --- |');
  lines.push(`| 총 토큰 | ${formatTokens(totalTokens(report.totals))} |`);
  lines.push(`| 입력 | ${formatTokens(report.totals.inputTokens)} |`);
  lines.push(`| 캐시 읽기 | ${formatTokens(report.totals.cacheReadTokens)} |`);
  lines.push(`| 캐시 쓰기 | ${formatTokens(report.totals.cacheWriteTokens)} |`);
  lines.push(`| 출력 | ${formatTokens(report.totals.outputTokens)} |`);
  lines.push(`| 환산 비용 | ${formatCost(report.estimatedCostUsd)}${report.estimatedCostUsd === undefined ? '' : ` (${priceSourceLabel(report.priceSource)})`} |`);
  lines.push(`| 요청 수 | ${formatTokens(report.requests.length)} |`);
  lines.push(`| 모델 호출 수 | ${formatTokens(report.modelCalls)} |`);
  lines.push(`| 캐시 적중률 | ${formatRatio(report.cacheHitRatio)} |`);
  lines.push('');

  const models = Object.entries(report.usageByModel);
  if (models.length > 0) {
    lines.push('## 모델별', '');
    lines.push('| 모델 | 입력 | 캐시 읽기 | 캐시 쓰기 | 출력 | 비용 |', '| --- | --- | --- | --- | --- | --- |');
    for (const [model, usage] of models) {
      const cost = report.modelCosts[model];
      lines.push(
        `| \`${model}\` | ${formatTokens(usage.inputTokens)} | ${formatTokens(usage.cacheReadTokens)} | ${formatTokens(usage.cacheWriteTokens)} | ${formatTokens(usage.outputTokens)} | ${
          cost === undefined ? '단가 없음' : `$${cost.toFixed(4)}`
        } |`,
      );
    }
    lines.push('');
  }

  if (report.kinds.length > 1) {
    lines.push('## 세션 종류별', '');
    lines.push('| 종류 | 세션 | 요청 | 토큰 | 비용 |', '| --- | --- | --- | --- | --- |');
    for (const entry of report.kinds) {
      lines.push(
        `| ${SESSION_KIND_LABEL[entry.kind]} | ${entry.sessions} | ${entry.requests} | ${formatTokens(totalTokens(entry.usage))} | ${
          entry.costUsd === undefined ? '단가 없음' : `$${entry.costUsd.toFixed(4)}`
        } |`,
      );
    }
    lines.push('');
  }

  const saved = report.saved;
  lines.push('## 줄인 양 (측정)', '');
  lines.push('기록에 남은 사실입니다. 아래 추정 절과 섞지 마세요.', '');
  lines.push('| 항목 | 값 |', '| --- | --- |');
  lines.push(`| 도구 결과 예산이 잘라낸 글자 | ${formatTokens(saved.trimmedChars)}자 |`);
  lines.push(`| 앞과 같은 결과를 참조로 대체 | ${formatTokens(saved.repeatedResults)}회 |`);
  lines.push(`| 묶어서 비운 도구 결과 | ${formatTokens(saved.clearedCount)}개 · ${formatTokens(saved.clearedChars)}자 |`);
  lines.push(
    `| 가볍게 확인으로 끝난 실행 | ${formatTokens(saved.lightRuns)}회${
      saved.lightSkipped.length > 0 ? ` (건너뛴 단계: ${saved.lightSkipped.map((entry) => `${entry.stage} ${entry.runs}회`).join(', ')})` : ''
    } |`,
  );
  lines.push('');

  lines.push('## 줄인 토큰 (추정)', '');
  lines.push(`- 잘린 결과가 남은 호출마다 다시 읽혔을 양: **${formatTokens(saved.trimmedTokensEstimated)} 토큰**`);
  lines.push(
    saved.trimmedCostUsd === undefined
      ? '- 환산 금액: 단가 미설정'
      : `- 환산 금액: $${saved.trimmedCostUsd.toFixed(4)} (캐시 읽기 단가 · ${saved.trimmedCostModel ?? ''} 기준)`,
  );
  lines.push(`- 방식: ${TRIM_ESTIMATE_METHOD}`);
  lines.push('- 이 값은 **추정**입니다. 자르지 않았다면 그 글자가 남은 호출마다 다시 실려 갔을 양을 근사한 값이라, 위의 측정값과 다릅니다.');
  lines.push('');

  if (report.requests.length > 0) {
    lines.push(`## 요청별 (최근 순, 최대 ${limit})`, '');
    lines.push('| 시각 (UTC) | 세션 | 요청 | 토큰 | 비용 | 노력 | 결과 |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const request of report.requests.slice(0, limit)) {
      const session = `${SESSION_KIND_LABEL[request.kind]} · ${request.sessionId.slice(0, 8)}`;
      lines.push(
        `| ${request.at ? formatUtcStamp(request.at) : '—'} | ${session} | ${escapeCell(request.request)} | ${formatTokens(totalTokens(request.usage))} | ${
          request.costUsd === undefined ? '단가 없음' : `$${request.costUsd.toFixed(4)}`
        } | ${request.effort ?? '—'} | ${REQUEST_RESULT_LABEL[request.result]} |`,
      );
    }
    if (report.requests.length > limit) lines.push('', `(최근 ${limit}개만 적었습니다. 전체 ${formatTokens(report.requests.length)}개)`);
    lines.push('');
  }

  if (report.notes.length > 0) {
    lines.push('## 알아둘 점', '');
    for (const note of report.notes) lines.push(`- ${note}`);
    lines.push('');
  }

  lines.push(PRICE_DISCLAIMER);
  lines.push('');
  return lines.join('\n');
}

/** 표 칸을 깨뜨리는 파이프·줄바꿈을 바꾼다 */
function escapeCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}
