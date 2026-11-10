// 차등 시험의 기준: ADR-191 3단계 3ad에서 Rust로 옮기기 전의 TS 구현을 그대로 복사한 것이다
// (requirements.ts의 repairExtractionReply·enforceSpecQuoteEvidence·firstLinesPreview·addUsage·REFERENCE_FILE_TOO_BIG·JSON 파일 이름 판정, task-plan.ts의 parsePlannerReply,
// 시나리오 id 맞추기와 인용 확인은 3j 때 복사한 requirements-legacy.ts의 순수 TS 판). 고치지 않는다. 시험(requirements-replies-differential.test.ts, requirements-replies-vectors.test.ts)만 불러 쓴다.
import { jsonrepair } from 'jsonrepair';
import type { AgentUsage } from './loop';

export const MAX_REQUIREMENTS = 60;
export const MAX_CLARIFYING_QUESTIONS = 5;
export const MAX_OUT_OF_SCOPE = 20;
export const MAX_ASSUMPTIONS = 10;
export const MAX_MANUAL_STEPS = 20;

class TaskPlanError extends Error {}

export interface Recommendation {
  basis: 'spec' | 'practice';
  specQuote?: string;
  [key: string]: unknown;
}

export function alignScenarioIds<T extends { id: string; scenarios?: ReadonlyArray<{ id: string }> }>(requirement: T): T {
  if (!requirement.scenarios || requirement.scenarios.length === 0) return requirement;
  const prefix = `${requirement.id}.`;
  if (requirement.scenarios.every((scenario) => scenario.id.startsWith(prefix))) return requirement;
  const used = new Set<number>();
  const scenarios = requirement.scenarios.map((scenario) => {
    const suffix = Number(/\.(\d+)$/.exec(scenario.id)?.[1] ?? NaN);
    let number = Number.isInteger(suffix) && suffix > 0 && !used.has(suffix) ? suffix : 1;
    while (used.has(number)) number += 1;
    used.add(number);
    return { ...scenario, id: `${requirement.id}.${number}` };
  });
  return { ...requirement, scenarios };
}

export function repairExtractionReplyLegacy(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object') return raw;
  const reply = { ...(raw as Record<string, unknown>) };
  // 최상위 목록도 null이면 빈 목록으로 본다(기본값이 있는 항목들)
  for (const key of ['questions', 'outOfScope', 'assumptions', 'manualSteps']) {
    if (reply[key] === null) reply[key] = [];
  }
  const cap = (key: string, max: number) => {
    if (Array.isArray(reply[key]) && (reply[key] as unknown[]).length > max) reply[key] = (reply[key] as unknown[]).slice(0, max);
  };
  cap('requirements', MAX_REQUIREMENTS);
  cap('questions', MAX_CLARIFYING_QUESTIONS);
  cap('outOfScope', MAX_OUT_OF_SCOPE);
  cap('assumptions', MAX_ASSUMPTIONS);
  cap('manualSteps', MAX_MANUAL_STEPS);
  if (Array.isArray(reply.requirements)) {
    reply.requirements = (reply.requirements as unknown[]).map((requirement) => {
      if (!requirement || typeof requirement !== 'object') return requirement;
      const candidate = { ...(requirement as Record<string, unknown>) };
      // 모델은 해당 사항이 없는 선택 항목을 빼지 않고 null로 채우곤 한다("nfr": null). 스키마는 "없음"만 받으므로 지운다
      for (const key of ['ears', 'scenarios', 'nfr', 'trace', 'rev', 'hash', 'revisedAt']) {
        if (candidate[key] === null) delete candidate[key];
      }
      // 문자열 안에 JSON 예시({"items": …})가 이스케이프 없이 들어가면 jsonrepair가 그 부분을 배열 원소(객체)로 떼어 낸다.
      // 인수 조건 목록에 문자열이 아닌 원소가 섞이면, 떨어진 조각을 원래 문장 하나로 다시 붙인다
      if (Array.isArray(candidate.acceptance) && candidate.acceptance.some((item) => typeof item !== 'string')) {
        candidate.acceptance = [candidate.acceptance.map((item) => (typeof item === 'string' ? item : JSON.stringify(item))).join(' ')];
      }
      if (Array.isArray(candidate.scenarios)) {
        if (candidate.scenarios.length > 20) candidate.scenarios = candidate.scenarios.slice(0, 20);
        const scenarios = candidate.scenarios as unknown[];
        const wellFormed = scenarios.every((scenario) => scenario && typeof scenario === 'object' && typeof (scenario as { id?: unknown }).id === 'string');
        if (typeof candidate.id === 'string' && wellFormed) {
          return alignScenarioIds(candidate as { id: string; scenarios: Array<{ id: string }> });
        }
      }
      return candidate;
    });
  }
  return reply;
}

function normalizeForQuoteMatch(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** specQuote가 실제로 specText 안에 있는 문장인지(공백 정규화 후 부분 문자열로) 확인한다 — 지어낸 인용을 막는다 */
export function verifySpecQuote(specQuote: string, specText: string): boolean {
  const normalizedQuote = normalizeForQuoteMatch(specQuote);
  if (!normalizedQuote) return false;
  return normalizeForQuoteMatch(specText).includes(normalizedQuote);
}

export function enforceSpecQuoteEvidenceLegacy(recommendations: readonly Recommendation[], specText: string): Recommendation[] {
  return recommendations.map((recommendation) => {
    if (recommendation.basis !== 'spec') return recommendation;
    if (recommendation.specQuote && verifySpecQuote(recommendation.specQuote, specText)) return recommendation;
    const { specQuote: _drop, ...rest } = recommendation;
    return { ...rest, basis: 'practice' as const };
  });
}

export function firstLinesPreviewLegacy(content: string, maxLines = 5, maxChars = 300): string {
  const joined = content
    .split(/\r?\n/)
    .slice(0, maxLines)
    .join('\n')
    .trim();
  return joined.length > maxChars ? `${joined.slice(0, maxChars)}…` : joined;
}

export function addUsageLegacy(a: AgentUsage, b: AgentUsage): AgentUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
    cacheWriteTokens: a.cacheWriteTokens + b.cacheWriteTokens,
  };
}

export const REFERENCE_FILE_TOO_BIG = /너무 큽니다 \((\d+) bytes\)/;

export const isJsonPathLegacy = (path: string): boolean => /\.json$/i.test(path);

export function parsePlannerReplyLegacy(text: string): unknown {
  // 코드 펜스는 마지막 펜스까지 잡는다 — 답 안의 문자열에 또 다른 펜스(```)가 있으면 처음 만나는 펜스에서 끊겨
  // JSON이 중간에 잘렸다(요구사항 추출처럼 긴 답에서 실제로 일어났다)
  const fenced = /```(?:json)?\s*([\s\S]*)```/.exec(text)?.[1];
  const source = fenced && fenced.includes('{') ? fenced : text;
  const start = source.indexOf('{');
  const end = source.lastIndexOf('}');
  if (start === -1) throw new TaskPlanError('모델 응답에서 JSON을 찾지 못했습니다');
  const candidate = end > start ? source.slice(start, end + 1) : source.slice(start);
  try {
    return JSON.parse(candidate);
  } catch (error) {
    // 모델이 자주 내는 깨진 JSON(문자열 안의 이스케이프 안 된 큰따옴표, 잘린 끝, 끝 쉼표 등)은 한 번 고쳐서 읽는다.
    // 고친 결과는 이어지는 스키마 검사를 그대로 거치므로, 모양이 틀리면 거기서 걸러진다
    try {
      return JSON.parse(jsonrepair(end > start ? source.slice(start) : candidate));
    } catch {
      throw new TaskPlanError(`모델 응답 JSON을 읽지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

