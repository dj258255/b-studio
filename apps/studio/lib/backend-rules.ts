/**
 * 내가 정한 규칙으로 AI(백엔드)를 고른다(#822). 형식 검사와 매칭은 여기(순수 함수), 저장과 로그인 확인은 lib/server/backend-rules.ts가 한다.
 *
 * 규칙은 위에서부터 본다. 조건(`when`)을 모두 만족하는 규칙이 후보가 되고, 맨 끝에 기본값(`fallback`)이 붙는다.
 * 조건을 비워 두면 모든 요청에 맞는다. 고르는 데 기록의 통과율을 쓰지 않는다(기록이 적을 때 틀린다, E10).
 */
import type { TaskKind } from './routing-types';

export type RuleIntent = 'build' | 'ask';

export interface RuleWhen {
  intent?: RuleIntent;
  /** 이 중 하나면 맞는다 */
  complexity?: TaskKind['complexity'][];
  risk?: TaskKind['risk'];
  /** 요청 글에 이 중 하나라도 들어 있으면 맞는다(대소문자 무시) */
  keywords?: string[];
}

export interface BackendTarget {
  backend: string;
  /** 비우면 그 백엔드에서 이 프로젝트에 마지막으로 고른 모델(없으면 CLI 기본값) */
  model?: string;
  /** 그 CLI의 어느 계정으로 띄울지(#885, 계정 목록의 id). 비우면 기본 계정 */
  accountId?: string;
}

export interface BackendRule extends BackendTarget {
  when: RuleWhen;
}

export interface BackendRules {
  rules: BackendRule[];
  /** 맞는 규칙이 없을 때. 없으면 서버의 기본 백엔드다 */
  fallback?: BackendTarget;
}

export interface RuleCandidate extends BackendTarget {
  /** 규칙의 순서(0부터), 또는 기본값 */
  rule: number | 'fallback';
}

export const MAX_RULES = 50;
const COMPLEXITIES: readonly TaskKind['complexity'][] = ['simple', 'normal', 'complex'];
const COMPLEXITY_LABEL: Record<TaskKind['complexity'], string> = { simple: '단순', normal: '보통', complex: '복잡' };
const MAX_KEYWORDS = 20;
const MAX_TEXT = 100;
/** 계정 id의 꼴(lib/server/ai-accounts.ts와 같다) */
const ACCOUNT_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, name: string, where: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.length > MAX_TEXT) throw new Error(`${where}: ${name}은 ${MAX_TEXT}자 이하의 글이어야 합니다`);
  return value.trim() || undefined;
}

function parseTarget(value: Record<string, unknown>, allowed: readonly string[], where: string): BackendTarget {
  const backend = text(value.backend, 'backend', where);
  if (!backend) throw new Error(`${where}: backend가 필요합니다`);
  if (!allowed.includes(backend)) throw new Error(`${where}: 이 스튜디오가 허용하지 않는 백엔드입니다: ${backend}`);
  const model = text(value.model, 'model', where);
  const accountId = text(value.accountId, 'accountId', where);
  if (accountId !== undefined && !ACCOUNT_ID.test(accountId)) throw new Error(`${where}: accountId는 계정 목록의 id여야 합니다`);
  return { backend, ...(model ? { model } : {}), ...(accountId ? { accountId } : {}) };
}

function parseWhen(value: unknown, where: string): RuleWhen {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`${where}: when은 객체여야 합니다`);
  const when: RuleWhen = {};
  if (value.intent !== undefined) {
    if (value.intent !== 'build' && value.intent !== 'ask') throw new Error(`${where}: intent는 build나 ask여야 합니다`);
    when.intent = value.intent;
  }
  if (value.complexity !== undefined) {
    if (!Array.isArray(value.complexity) || value.complexity.some((item) => !COMPLEXITIES.includes(item as TaskKind['complexity']))) {
      throw new Error(`${where}: complexity는 ${COMPLEXITIES.join(', ')} 중에서 고릅니다`);
    }
    const picked = COMPLEXITIES.filter((item) => (value.complexity as unknown[]).includes(item));
    if (picked.length > 0) when.complexity = picked;
  }
  if (value.risk !== undefined) {
    if (value.risk !== 'high' && value.risk !== 'normal') throw new Error(`${where}: risk는 high나 normal이어야 합니다`);
    when.risk = value.risk;
  }
  if (value.keywords !== undefined) {
    if (!Array.isArray(value.keywords) || value.keywords.length > MAX_KEYWORDS) throw new Error(`${where}: keywords는 ${MAX_KEYWORDS}개 이하의 글 목록이어야 합니다`);
    const keywords = value.keywords.map((item) => text(item, 'keywords', where)).filter((item): item is string => item !== undefined);
    if (keywords.length > 0) when.keywords = keywords;
  }
  return when;
}

/** 파일이나 화면에서 온 규칙을 검사한다. 틀리면 몇 번째 규칙인지 적어 던진다 */
export function parseBackendRules(value: unknown, allowed: readonly string[]): BackendRules {
  if (!isRecord(value)) throw new Error('규칙은 { rules, fallback } 객체여야 합니다');
  const list = value.rules ?? [];
  if (!Array.isArray(list)) throw new Error('rules는 목록이어야 합니다');
  if (list.length > MAX_RULES) throw new Error(`규칙은 ${MAX_RULES}개까지입니다`);
  const rules = list.map((item, index): BackendRule => {
    const where = `규칙 ${index + 1}`;
    if (!isRecord(item)) throw new Error(`${where}: 객체여야 합니다`);
    return { when: parseWhen(item.when, where), ...parseTarget(item, allowed, where) };
  });
  if (value.fallback === undefined || value.fallback === null) return { rules };
  if (!isRecord(value.fallback)) throw new Error('기본값: 객체여야 합니다');
  return { rules, fallback: parseTarget(value.fallback, allowed, '기본값') };
}

function matches(when: RuleWhen, input: { request: string; intent: RuleIntent; kind: TaskKind }): boolean {
  if (when.intent && when.intent !== input.intent) return false;
  if (when.complexity && !when.complexity.includes(input.kind.complexity)) return false;
  if (when.risk && when.risk !== input.kind.risk) return false;
  if (when.keywords) {
    const lower = input.request.toLowerCase();
    if (!when.keywords.some((keyword) => lower.includes(keyword.toLowerCase()))) return false;
  }
  return true;
}

/** 이 요청에 맞는 규칙을 위에서부터, 맨 끝에 기본값을 붙여 돌려준다. 로그인·허용 여부는 보지 않는다 */
export function matchCandidates(rules: BackendRules, input: { request: string; intent: RuleIntent; kind: TaskKind }): RuleCandidate[] {
  const candidates: RuleCandidate[] = [];
  rules.rules.forEach((rule, index) => {
    if (matches(rule.when, input)) candidates.push({ rule: index, backend: rule.backend, ...(rule.model ? { model: rule.model } : {}), ...(rule.accountId ? { accountId: rule.accountId } : {}) });
  });
  if (rules.fallback) candidates.push({ rule: 'fallback', ...rules.fallback });
  return candidates;
}

/** 조건을 사람이 읽는 말로 */
export function describeWhen(when: RuleWhen): string {
  const parts: string[] = [];
  if (when.intent) parts.push(when.intent === 'ask' ? '질문' : '만들기');
  if (when.complexity) parts.push(when.complexity.map((item) => COMPLEXITY_LABEL[item]).join('·'));
  if (when.risk) parts.push(when.risk === 'high' ? '위험' : '위험 아님');
  if (when.keywords) parts.push(`${when.keywords.map((keyword) => `"${keyword}"`).join(', ')} 포함`);
  return parts.length > 0 ? parts.join(' · ') : '모든 요청';
}

/** 규칙 화면이 받는 값(GET /api/routing/rules) */
export interface BackendRulesView {
  rules: BackendRules;
  /** 저장한 규칙을 쓰지 못한 까닭 */
  error?: string;
  allowed: string[];
  defaultBackend: string;
}

/** 규칙 편집기의 한 줄. 빈 글은 "상관없음"이다 */
export interface RuleDraft {
  intent: '' | RuleIntent;
  complexity: TaskKind['complexity'][];
  risk: '' | TaskKind['risk'];
  /** 쉼표로 나눈 낱말 */
  keywords: string;
  backend: string;
  model: string;
  /** 계정 id(#885). 없거나 빈 글이면 기본 계정 */
  accountId?: string;
}

export function ruleToDraft(rule: BackendRule): RuleDraft {
  return {
    intent: rule.when.intent ?? '',
    complexity: rule.when.complexity ?? [],
    risk: rule.when.risk ?? '',
    keywords: (rule.when.keywords ?? []).join(', '),
    backend: rule.backend,
    model: rule.model ?? '',
    accountId: rule.accountId ?? '',
  };
}

/** 편집기의 줄을 저장할 모양으로. 검사는 서버(parseBackendRules)가 한다 */
export function draftToRule(draft: RuleDraft): BackendRule {
  const keywords = draft.keywords
    .split(',')
    .map((keyword) => keyword.trim())
    .filter(Boolean);
  const when: RuleWhen = {
    ...(draft.intent ? { intent: draft.intent } : {}),
    ...(draft.complexity.length > 0 ? { complexity: draft.complexity } : {}),
    ...(draft.risk ? { risk: draft.risk } : {}),
    ...(keywords.length > 0 ? { keywords } : {}),
  };
  return { when, backend: draft.backend, ...(draft.model.trim() ? { model: draft.model.trim() } : {}), ...(draft.accountId?.trim() ? { accountId: draft.accountId.trim() } : {}) };
}
