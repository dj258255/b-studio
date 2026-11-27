/**
 * 평가 세트를 한 번 돌려 결과(EvalResult)를 만든다. 모델 호출은 주입받은 `ModelAsk`가 한다(시험은 가짜 응답을 넣는다).
 *
 * 리뷰어에게 보내는 프롬프트는 제품이 쓰는 함수(buildPrReviewSystemPrompt·buildPrReviewUserPrompt)로 만든다 — 잰 것이 제품 동작이어야 한다.
 * 호출이 실패하면 그 항목은 "응답 못 읽음"으로 남기고 다음 항목으로 간다(통과로 세지 않는다).
 */
import { createHash } from 'node:crypto';
import { buildPrReviewSystemPrompt, buildPrReviewUserPrompt, type ModelAsk } from '@b-studio/agent';
import { EVAL_CASES, EVAL_SET_VERSION, evalSetHash } from './cases';
import { scoreCase, summarize, type CaseResult, type Totals } from './score';
import type { EvalCase } from './types';

export const RESULT_SCHEMA_VERSION = 1;

export interface EvalItemResult extends CaseResult {
  /** 모델 호출이 실패했으면 그 이유(이 항목은 응답 못 읽음이다) */
  askError?: string;
  /** 모델이 돌려준 원문. 채점이 의심스러울 때 사람이 읽는다 */
  reply?: string;
  durationMs: number;
}

export interface EvalResult {
  schemaVersion: number;
  evalSetVersion: number;
  evalSetHash: string;
  promptHash: string;
  /** 어떤 호출 방식으로 돌렸나(claude-code | fake) */
  ask: string;
  /** --model 값. 안 줬으면 null(로그인 계정의 기본 모델) */
  model: string | null;
  startedAt: string;
  items: EvalItemResult[];
  totals: Totals;
}

export function userPromptFor(c: EvalCase): string {
  return buildPrReviewUserPrompt({ diff: c.diff, requests: [c.request], round: 1 });
}

/** 시스템 프롬프트와 모든 항목의 사용자 프롬프트를 이은 글의 해시. 프롬프트·프롬프트 조립 코드가 바뀌면 달라진다 */
export function promptHash(cases: readonly EvalCase[] = EVAL_CASES): string {
  const hash = createHash('sha256').update(buildPrReviewSystemPrompt());
  for (const c of cases) hash.update('\n--- ').update(c.id).update('\n').update(userPromptFor(c));
  return hash.digest('hex').slice(0, 16);
}

export async function runEval({
  ask,
  askName,
  model,
  cases = EVAL_CASES,
  now = () => new Date(),
  onItem,
}: {
  ask: ModelAsk;
  askName: string;
  model?: string;
  cases?: readonly EvalCase[];
  now?: () => Date;
  onItem?: (item: EvalItemResult) => void;
}): Promise<EvalResult> {
  const startedAt = now().toISOString();
  const system = buildPrReviewSystemPrompt();
  const items: EvalItemResult[] = [];
  for (const c of cases) {
    const began = Date.now();
    let reply: string | undefined;
    let askError: string | undefined;
    try {
      reply = (await ask({ system, user: userPromptFor(c) })).text;
    } catch (error) {
      askError = error instanceof Error ? error.message : String(error);
    }
    const scored = scoreCase(c, reply);
    const item: EvalItemResult = {
      ...scored,
      ...(askError !== undefined ? { askError, parseError: `모델 호출 실패: ${askError}` } : {}),
      ...(reply !== undefined ? { reply } : {}),
      durationMs: Date.now() - began,
    };
    items.push(item);
    onItem?.(item);
  }
  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    evalSetVersion: EVAL_SET_VERSION,
    evalSetHash: evalSetHash(cases),
    promptHash: promptHash(cases),
    ask: askName,
    model: model ?? null,
    startedAt,
    items,
    totals: summarize(items),
  };
}

/** `--ask fake`용: 항목의 기대 지적을 그대로 돌려주는 가짜 리뷰어(결함 없는 항목에는 빈 지적). 배선 확인용이며 모델 성능이 아니다 */
export function oracleAsk(cases: readonly EvalCase[] = EVAL_CASES): ModelAsk {
  return async ({ user }) => {
    const c = cases.find((candidate) => userPromptFor(candidate) === user);
    if (!c) throw new Error('알 수 없는 항목의 프롬프트입니다');
    const findings = c.expected.map((e) => ({ severity: 'major', file: e.file, line: e.startLine, title: e.tag, detail: `${e.tag} 결함` }));
    return { text: JSON.stringify({ findings }), usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  };
}
