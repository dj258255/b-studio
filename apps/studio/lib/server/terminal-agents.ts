/**
 * 터미널 세션의 에이전트 장부(#843). 세션 터미널의 CLI가 보낸 텔레메트리를 메인과 서브에이전트로 갈라 모은다.
 *
 * 무엇으로 가르는가(2026-10-22 실측, ADR-176 덧붙임):
 *  - Claude Code: 서브에이전트의 모델 요청에는 `agent.name`(종류)이 붙는다. 개별 id는 없어 종류 단위로 센다.
 *    끝남은 `subagent_completed`(종류, 도구 횟수)로 안다
 *  - Codex: 하위 에이전트는 자기 대화 id(`conversation.id`)를 갖고, `codex.agent_communication`의 spawn이 부모→자식을 잇는다.
 *    자식으로 알린 대화만 하위 에이전트이고, 나머지 대화는 메인에 합친다
 *
 * 장부는 화면용이다. 세션 합계·실행 귀속·한도는 지금처럼 sessions.ts가 맡고, 장부에는 세션 합계에 더한 것과 같은 요청만 넣는다
 * (그래서 행의 합 = 그동안 받은 터미널 사용량). 세션 기록(session.json)에 함께 저장해, 스튜디오를 다시 띄워도 되살린다(#849).
 * 이 파일은 순수 함수만 둔다.
 */
import type { AgentUsage } from '@b-studio/agent';
import { costForUsageByModel, estimateCostUsd } from '../token-types';
import type { ApiRequestUsage, AgentSignal } from './terminal-telemetry';
import type { TokenPricing } from './token-report';

/** 따로 세는 서브에이전트 수의 상한. 넘는 것은 "그 밖" 한 행에 합친다(합은 그대로) */
export const AGENT_LEDGER_LIMIT = 30;
/** 기억하는 Codex 대화(부모·자식·이름) 수의 상한 */
const CONVERSATION_LIMIT = 200;

export type TerminalAgentState = 'working' | 'done' | 'idle';

/** 화면에 보일 에이전트 한 행 */
export interface TerminalAgentRow {
  id: string;
  name: string;
  kind: 'main' | 'subagent';
  state: TerminalAgentState;
  /** 하는 일 한 줄 */
  activity?: string;
  tokens: AgentUsage;
  /** 추정 비용. 단가도 CLI가 보고한 비용도 없으면 없다 */
  costUsd?: number;
}

interface Bucket {
  usageByModel: Record<string, AgentUsage>;
  /** CLI가 보고한 비용의 합. 하나도 받지 않았으면 없다 */
  cliCostUsd?: number;
  calls: number;
  lastUsageAt: number;
}

interface ClaudeAgent extends Bucket {
  doneAt?: number;
  toolUses?: number;
}

interface CodexChild {
  spawnedAt: number;
  /** 띄운 부모 대화 */
  parent: string;
  name?: string;
  task?: string;
  tool?: { name: string; at: number };
  resultAt?: number;
}

export interface TerminalAgentLedger {
  main: Bucket;
  /** Claude 서브에이전트 종류 → 장부. 넣은 순서가 화면 순서다 */
  claude: Map<string, ClaudeAgent>;
  /** Codex 대화 id → 장부(자식인지는 children이 정한다) */
  conversations: Map<string, Bucket>;
  /** Codex 자식 대화 id → 상태 */
  children: Map<string, CodexChild>;
  /** spawn_agent 결과로 알게 된 이름. 부모 대화마다 들어온 순서대로 다음 spawn에 붙인다 */
  pendingNames: Map<string, string[]>;
  /** 상한을 넘은 서브에이전트 */
  other?: Bucket;
}

export function newAgentLedger(): TerminalAgentLedger {
  return { main: newBucket(), claude: new Map(), conversations: new Map(), children: new Map(), pendingNames: new Map() };
}

function newBucket(): Bucket {
  return { usageByModel: {}, calls: 0, lastUsageAt: 0 };
}

function emptyUsage(): AgentUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

function addUsage(base: AgentUsage | undefined, usage: AgentUsage): AgentUsage {
  const from = base ?? emptyUsage();
  return {
    inputTokens: from.inputTokens + usage.inputTokens,
    outputTokens: from.outputTokens + usage.outputTokens,
    cacheReadTokens: from.cacheReadTokens + usage.cacheReadTokens,
    cacheWriteTokens: from.cacheWriteTokens + usage.cacheWriteTokens,
  };
}

function addTo(bucket: Bucket, request: ApiRequestUsage): void {
  const usage: AgentUsage = { inputTokens: request.inputTokens, outputTokens: request.outputTokens, cacheReadTokens: request.cacheReadTokens, cacheWriteTokens: request.cacheWriteTokens };
  bucket.usageByModel[request.model] = addUsage(bucket.usageByModel[request.model], usage);
  if (request.costUsd !== undefined) bucket.cliCostUsd = (bucket.cliCostUsd ?? 0) + request.costUsd;
  bucket.calls += 1;
  bucket.lastUsageAt = Math.max(bucket.lastUsageAt, request.at);
}

/** 서브에이전트(Claude 종류·Codex 자식) 수. 상한 판정에 쓴다 */
function subagentCount(ledger: TerminalAgentLedger): number {
  return ledger.claude.size + ledger.children.size;
}

/** 세션 합계에 더한 요청 하나를 장부에 넣는다 */
export function noteAgentUsage(ledger: TerminalAgentLedger, request: ApiRequestUsage): void {
  if (request.agent) {
    let agent = ledger.claude.get(request.agent);
    if (!agent) {
      if (subagentCount(ledger) >= AGENT_LEDGER_LIMIT) {
        addTo((ledger.other ??= newBucket()), request);
        return;
      }
      agent = newBucket();
      ledger.claude.set(request.agent, agent);
    }
    addTo(agent, request);
    return;
  }
  if (request.conversationId) {
    let bucket = ledger.conversations.get(request.conversationId);
    if (!bucket) {
      // 대화가 너무 많으면 더 기억하지 않고 메인에 합친다(합은 그대로)
      if (ledger.conversations.size >= CONVERSATION_LIMIT) {
        addTo(ledger.main, request);
        return;
      }
      bucket = newBucket();
      ledger.conversations.set(request.conversationId, bucket);
    }
    addTo(bucket, request);
    return;
  }
  addTo(ledger.main, request);
}

/** 서브에이전트 신호 하나를 장부에 넣는다. at은 받은 시각(밀리초) */
export function noteAgentSignal(ledger: TerminalAgentLedger, signal: AgentSignal, at: number): void {
  switch (signal.kind) {
    case 'subagent-done': {
      const agent = ledger.claude.get(signal.agent);
      // 사용량을 보지 못한 종류의 끝남은 무시한다(보일 토큰이 없다)
      if (!agent) return;
      agent.doneAt = at;
      if (signal.toolUses !== undefined) agent.toolUses = signal.toolUses;
      return;
    }
    case 'spawned-name': {
      const queue = ledger.pendingNames.get(signal.parent) ?? [];
      // 이미 spawn을 받은 이름 없는 자식이 있으면 그 자식에 붙인다(신호 순서가 바뀔 수 있다)
      const waiting = [...ledger.children.values()].find((child) => !child.name && child.parent === signal.parent);
      if (waiting) waiting.name = signal.name;
      else if (ledger.pendingNames.size < CONVERSATION_LIMIT) ledger.pendingNames.set(signal.parent, [...queue, signal.name].slice(-AGENT_LEDGER_LIMIT));
      return;
    }
    case 'spawn': {
      if (ledger.children.has(signal.child)) return;
      if (subagentCount(ledger) >= AGENT_LEDGER_LIMIT) return;
      const queue = ledger.pendingNames.get(signal.parent);
      const name = queue?.shift();
      ledger.children.set(signal.child, { spawnedAt: at, parent: signal.parent, ...(name ? { name } : {}), ...(signal.task ? { task: signal.task } : {}) });
      return;
    }
    case 'result': {
      const child = ledger.children.get(signal.child);
      if (child) child.resultAt = at;
      return;
    }
    case 'tool': {
      const child = ledger.children.get(signal.conversation);
      if (child) child.tool = { name: signal.tool, at };
      return;
    }
  }
}

/** 세션 기록에 싣는 장부(#849). Map을 [키, 값] 배열로 바꾼 꼴이다. 상한이 있어 크기가 커지지 않는다 */
export interface PersistedAgentLedger {
  version: 1;
  main: Bucket;
  claude: Array<[string, ClaudeAgent]>;
  conversations: Array<[string, Bucket]>;
  children: Array<[string, CodexChild]>;
  pendingNames: Array<[string, string[]]>;
  other?: Bucket;
}

export function serializeAgentLedger(ledger: TerminalAgentLedger): PersistedAgentLedger {
  return {
    version: 1,
    main: ledger.main,
    claude: [...ledger.claude],
    conversations: [...ledger.conversations],
    children: [...ledger.children],
    pendingNames: [...ledger.pendingNames],
    ...(ledger.other ? { other: ledger.other } : {}),
  };
}

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const optionalText = (value: unknown): value is string | undefined => value === undefined || typeof value === 'string';

function restoreUsage(value: unknown): AgentUsage | undefined {
  if (!isObject(value)) return undefined;
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = value;
  if (!isCount(inputTokens) || !isCount(outputTokens) || !isCount(cacheReadTokens) || !isCount(cacheWriteTokens)) return undefined;
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens };
}

function restoreBucket(value: unknown): Bucket | undefined {
  if (!isObject(value) || !isObject(value.usageByModel) || !isCount(value.calls) || !isCount(value.lastUsageAt)) return undefined;
  if (value.cliCostUsd !== undefined && !isCount(value.cliCostUsd)) return undefined;
  const usageByModel: Record<string, AgentUsage> = {};
  for (const [model, raw] of Object.entries(value.usageByModel)) {
    const usage = restoreUsage(raw);
    if (!usage) return undefined;
    usageByModel[model] = usage;
  }
  return { usageByModel, calls: value.calls, lastUsageAt: value.lastUsageAt, ...(value.cliCostUsd !== undefined ? { cliCostUsd: value.cliCostUsd } : {}) };
}

/** [키, 값] 배열을 상한까지만 되살린다. 한 항목이라도 모양이 틀리면 전체를 버린다 */
function restoreEntries<T>(value: unknown, limit: number, restore: (raw: unknown) => T | undefined): Map<string, T> | undefined {
  if (!Array.isArray(value)) return undefined;
  const map = new Map<string, T>();
  for (const entry of value) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string') return undefined;
    const restored = restore(entry[1]);
    if (restored === undefined) return undefined;
    if (map.size < limit) map.set(entry[0], restored);
  }
  return map;
}

/**
 * 세션 기록에서 장부를 되살린다(#849). 기록은 지난 프로세스가 쓴 파일이라 모양을 다시 확인하고, 틀리면 없는 것으로 둔다
 * (화면용 내역이라 버려도 합계·한도에는 영향이 없다). 상한을 넘는 항목은 버린다
 */
export function restoreAgentLedger(value: unknown): TerminalAgentLedger | undefined {
  if (!isObject(value) || value.version !== 1) return undefined;
  const main = restoreBucket(value.main);
  const claude = restoreEntries(value.claude, AGENT_LEDGER_LIMIT, (raw) => {
    const bucket = restoreBucket(raw);
    if (!bucket || !isObject(raw)) return undefined;
    if ((raw.doneAt !== undefined && !isCount(raw.doneAt)) || (raw.toolUses !== undefined && !isCount(raw.toolUses))) return undefined;
    return { ...bucket, ...(raw.doneAt !== undefined ? { doneAt: raw.doneAt as number } : {}), ...(raw.toolUses !== undefined ? { toolUses: raw.toolUses as number } : {}) };
  });
  const conversations = restoreEntries(value.conversations, CONVERSATION_LIMIT, restoreBucket);
  const children = restoreEntries(value.children, AGENT_LEDGER_LIMIT, (raw): CodexChild | undefined => {
    if (!isObject(raw) || !isCount(raw.spawnedAt) || typeof raw.parent !== 'string' || !optionalText(raw.name) || !optionalText(raw.task)) return undefined;
    if (raw.resultAt !== undefined && !isCount(raw.resultAt)) return undefined;
    let tool: CodexChild['tool'];
    if (raw.tool !== undefined) {
      if (!isObject(raw.tool) || typeof raw.tool.name !== 'string' || !isCount(raw.tool.at)) return undefined;
      tool = { name: raw.tool.name, at: raw.tool.at };
    }
    return {
      spawnedAt: raw.spawnedAt,
      parent: raw.parent,
      ...(raw.name !== undefined ? { name: raw.name } : {}),
      ...(raw.task !== undefined ? { task: raw.task } : {}),
      ...(tool ? { tool } : {}),
      ...(raw.resultAt !== undefined ? { resultAt: raw.resultAt as number } : {}),
    };
  });
  const pendingNames = restoreEntries(value.pendingNames, CONVERSATION_LIMIT, (raw) =>
    Array.isArray(raw) && raw.every((name) => typeof name === 'string') ? (raw as string[]).slice(-AGENT_LEDGER_LIMIT) : undefined,
  );
  const other = value.other === undefined ? undefined : restoreBucket(value.other);
  if (!main || !claude || !conversations || !children || !pendingNames || (value.other !== undefined && !other)) return undefined;
  // 서브에이전트(Claude 종류 + Codex 자식) 수의 상한은 둘을 합쳐 본다(noteAgentUsage와 같은 규칙)
  for (const key of [...children.keys()].reverse()) if (claude.size + children.size > AGENT_LEDGER_LIMIT) children.delete(key);
  return { main, claude, conversations, children, pendingNames, ...(other ? { other } : {}) };
}

function totalOf(bucket: Bucket | undefined): AgentUsage {
  let total = emptyUsage();
  for (const usage of Object.values(bucket?.usageByModel ?? {})) total = addUsage(total, usage);
  return total;
}

/** 버킷 하나의 비용. token-report의 resolveCost와 같은 순서: 모델별 단가 → 단일 단가 → CLI가 보고한 비용 */
function costOf(bucket: Bucket, pricing: TokenPricing): number | undefined {
  const used = Object.entries(bucket.usageByModel).filter(([, usage]) => usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens > 0);
  if (pricing.byModel && used.length > 0) return costForUsageByModel(Object.fromEntries(used), pricing.byModel).costUsd;
  if (pricing.single) return estimateCostUsd(totalOf(bucket), pricing.single);
  return bucket.cliCostUsd;
}

function mergeBuckets(buckets: readonly Bucket[]): Bucket {
  const merged = newBucket();
  for (const bucket of buckets) {
    for (const [model, usage] of Object.entries(bucket.usageByModel)) merged.usageByModel[model] = addUsage(merged.usageByModel[model], usage);
    if (bucket.cliCostUsd !== undefined) merged.cliCostUsd = (merged.cliCostUsd ?? 0) + bucket.cliCostUsd;
    merged.calls += bucket.calls;
    merged.lastUsageAt = Math.max(merged.lastUsageAt, bucket.lastUsageAt);
  }
  return merged;
}

function row(id: string, name: string, kind: TerminalAgentRow['kind'], state: TerminalAgentState, bucket: Bucket, pricing: TokenPricing, activity?: string): TerminalAgentRow {
  const costUsd = costOf(bucket, pricing);
  return { id, name, kind, state, ...(activity ? { activity } : {}), tokens: totalOf(bucket), ...(costUsd !== undefined ? { costUsd } : {}) };
}

/**
 * 화면에 보일 행. 메인이 먼저, 서브에이전트는 처음 본 순서다. 받은 것이 없으면 빈 목록.
 * mainState는 세션의 실행 상태(부르는 쪽이 안다). 서브에이전트의 상태는 신호로 정한다
 */
export function agentRows(ledger: TerminalAgentLedger, pricing: TokenPricing, mainState: TerminalAgentState = 'idle'): TerminalAgentRow[] {
  const childBuckets: Array<[string, CodexChild, Bucket]> = [];
  const mainParts: Bucket[] = [ledger.main];
  for (const [id, bucket] of ledger.conversations) {
    const child = ledger.children.get(id);
    if (child) childBuckets.push([id, child, bucket]);
    else mainParts.push(bucket);
  }
  // 사용량이 오기 전에 spawn만 받은 자식도 보인다(맡은 일을 알 수 있다)
  for (const [id, child] of ledger.children) {
    if (!ledger.conversations.has(id)) childBuckets.push([id, child, newBucket()]);
  }
  const main = mergeBuckets(mainParts);
  const rows: TerminalAgentRow[] = [];
  const hasSubagents = ledger.claude.size > 0 || childBuckets.length > 0 || ledger.other !== undefined;
  if (main.calls > 0 || hasSubagents) rows.push(row('main', '메인', 'main', mainState, main, pricing));

  for (const [name, agent] of ledger.claude) {
    const done = agent.doneAt !== undefined && agent.doneAt >= agent.lastUsageAt;
    const activity = done ? `끝남${agent.toolUses !== undefined ? ` · 도구 ${agent.toolUses}회` : ''}` : `모델 요청 ${agent.calls}회`;
    rows.push(row(`claude:${name}`, name, 'subagent', done ? 'done' : 'working', agent, pricing, activity));
  }
  childBuckets.sort((a, b) => a[1].spawnedAt - b[1].spawnedAt);
  for (const [id, child, bucket] of childBuckets) {
    const done = child.resultAt !== undefined;
    const activity = done ? `끝남${child.task ? ` · ${child.task}` : ''}` : child.tool ? `도구: ${child.tool.name}` : child.task;
    rows.push(row(`codex:${id}`, child.name ?? `하위 에이전트 ${id.slice(-6)}`, 'subagent', done ? 'done' : 'working', bucket, pricing, activity));
  }
  if (ledger.other) rows.push(row('other', '그 밖의 서브에이전트', 'subagent', 'idle', ledger.other, pricing));
  return rows;
}

/**
 * 에이전트가 할 수 있는 범위(#843). 대시보드에 한 줄로 보인다.
 * tools: studio.yaml의 workflow.allowedTools가 있으면 그 목록, 없으면 CLI가 가진 도구 그대로('cli-default')
 */
export interface AgentCapabilities {
  backend: string;
  model?: string;
  tools: string[] | 'cli-default';
  /** 쓸 수 있는 자리 한 줄 */
  writeScope: string;
  /** 권한을 누가 어떻게 확인하는지 한 줄 */
  permission: string;
}

/** 세션의 사실에서 범위를 만든다. 순수 함수라 테스트가 그대로 부른다 */
export function capabilitiesOf(input: {
  backend: string;
  model?: string;
  allowedTools?: readonly string[];
  workspace?: 'copy' | 'local';
  cardScope?: readonly string[];
  terminal: boolean;
}): AgentCapabilities {
  const writeScope = input.cardScope
    ? `카드 범위: ${input.cardScope.length > 0 ? input.cardScope.slice(0, 5).join(', ') + (input.cardScope.length > 5 ? ` 외 ${input.cardScope.length - 5}곳` : '') : '없음(읽기만)'}`
    : input.workspace === 'local'
      ? '프로젝트 폴더 전체'
      : '세션 작업 복사본 전체';
  const permission = input.terminal ? 'CLI 권한 확인 + 쓰기 직전 관문 + 턴 끝 게이트' : 'b-studio 실행 정책 + 게이트';
  return {
    backend: input.backend,
    ...(input.model ? { model: input.model } : {}),
    tools: input.allowedTools && input.allowedTools.length > 0 ? [...input.allowedTools] : 'cli-default',
    writeScope,
    permission,
  };
}
