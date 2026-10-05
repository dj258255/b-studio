import type { AgentUsage } from '@b-studio/agent';
import type { ContextGrowthReport } from './context-growth';

export type { ContextGrowthReport, ContextGrowthSource, ContextGrowthSourceKind, ContextGrowthTurn, ContextJump } from './context-growth';

/** 토큰 탭이 주고받는 형태. 서버(token-report)와 화면(token-view)이 함께 쓴다(서버 전용 코드는 담지 않는다) */

/** 100만 토큰당 단가(달러). 네 값이 모두 있어야 비용을 계산한다 */
export interface TokenPrices {
  inputPerM: number;
  outputPerM: number;
  cacheReadPerM: number;
  cacheWritePerM: number;
}

/**
 * 추정 비용(달러). 청구 금액이 아니라 단가를 넣었을 때의 환산값이다.
 * 토큰 탭(서버)과 벤치가 같은 계산을 쓰도록 여기(순수 모듈)에 둔다.
 */
export function estimateCostUsd(usage: AgentUsage, prices: TokenPrices): number {
  return (
    (usage.inputTokens * prices.inputPerM + usage.outputTokens * prices.outputPerM + usage.cacheReadTokens * prices.cacheReadPerM + usage.cacheWriteTokens * prices.cacheWritePerM) /
    1_000_000
  );
}

/**
 * 단가 표에서 모델 이름에 맞는 단가를 찾는다. 키가 모델 이름에 포함되면 매칭하고, 여러 개면 가장 긴 키를 쓴다.
 * 예: `{ "haiku-4-5": ... }`는 `claude-haiku-4-5-20251001`에 맞는다
 */
export function matchTokenPrices(table: Record<string, TokenPrices>, model: string): TokenPrices | undefined {
  let best: { key: string; prices: TokenPrices } | undefined;
  for (const [key, prices] of Object.entries(table)) {
    if (!model.includes(key)) continue;
    if (!best || key.length > best.key.length) best = { key, prices };
  }
  return best?.prices;
}

/** `--prices` 파일 JSON을 검증해 단가 표로 만든다. 값이 하나라도 잘못됐으면 오류를 낸다 */
export function parsePriceTable(input: unknown): Record<string, TokenPrices> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('단가 파일은 { "<모델 이름 일부>": { inputPerM, outputPerM, cacheReadPerM, cacheWritePerM } } 형식이어야 합니다');
  }
  const table: Record<string, TokenPrices> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`단가 항목이 올바르지 않습니다: ${key}`);
    const entry = value as Record<string, unknown>;
    const read = (name: string): number => {
      const number = entry[name];
      if (typeof number !== 'number' || !Number.isFinite(number) || number < 0) throw new Error(`단가 ${key}.${name}은 0 이상의 숫자여야 합니다`);
      return number;
    };
    table[key] = { inputPerM: read('inputPerM'), outputPerM: read('outputPerM'), cacheReadPerM: read('cacheReadPerM'), cacheWritePerM: read('cacheWritePerM') };
  }
  if (Object.keys(table).length === 0) throw new Error('단가 파일에 항목이 없습니다');
  return table;
}

/**
 * 모델별 사용량의 비용을 더한다. 단가가 없는 모델이 하나라도 있으면 비용 대신 사유를 돌려준다
 * (일부만 계산하면 합계가 실제보다 싸 보이므로 아예 쓰지 않는다).
 */
export function costForUsageByModel(usageByModel: Record<string, AgentUsage>, table: Record<string, TokenPrices>): { costUsd?: number; costNote?: string } {
  const models = Object.keys(usageByModel);
  if (models.length === 0) return {};
  let total = 0;
  const missing: string[] = [];
  for (const model of models) {
    const usage = usageByModel[model]!;
    // 토큰을 하나도 쓰지 않은 모델(벤치의 고정 계획용 가짜 클라이언트 'scripted' 등)은 단가가 없어도 비용이 0이다.
    // 이것 때문에 전체 비용을 "단가 없음"으로 버리면 실제 모델의 비용까지 보이지 않는다(E3에서 S0 비용이 전부 빠졌다)
    if (usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens === 0) continue;
    const prices = matchTokenPrices(table, model);
    if (!prices) {
      missing.push(model);
      continue;
    }
    total += estimateCostUsd(usage, prices);
  }
  if (missing.length > 0) return { costNote: `단가 없음: ${missing.join(', ')}` };
  return { costUsd: total };
}

export interface TokenTurn {
  turn: number;
  contextTokens: number;
  /** 직전 턴 대비 컨텍스트 증가량. 첫 턴은 contextTokens와 같다(줄어들면 음수일 수 있다) */
  delta: number;
  output: number;
  cacheRead: number;
  /** 그 턴에서 모델에 간 결과가 가장 큰 도구 */
  biggestTool?: { name: string; input: string; chars: number };
  /** 그 턴 직전에 오래된 도구 결과를 묶어서 비운 기록. 비우지 않았으면 없다 */
  cleared?: { count: number; chars: number };
}

export interface TokenToolTotal {
  name: string;
  calls: number;
  /** 모델에 간 결과 글자 합 */
  chars: number;
  /** 전체 결과 글자에서 이 도구가 차지하는 비중(0-1) */
  share: number;
}

export interface TokenBigResult {
  name: string;
  input: string;
  chars: number;
  rawChars: number;
  turn?: number;
}

export type TokenWarningKind = 'big_result' | 'repeated_result' | 'node_modules' | 'context_jump' | 'price_table';

export interface TokenWarning {
  kind: TokenWarningKind;
  message: string;
  turn?: number;
  tool?: string;
}

/**
 * 도구 결과 예산이 잘라낸 양(측정)과 그 결과가 남은 호출마다 다시 읽혔을 양(추정).
 *
 * 추정은 **글자 수를 4로 나눠 토큰으로 본 근사**다(`estimatedTokens`). 언어·토크나이저마다 달라 정확하지 않으므로
 * 화면과 마크다운에서 측정값과 분리해 표시한다.
 */
export interface TokenTrimmed {
  /** 잘라낸 글자 합: Σ (rawChars - chars) */
  chars: number;
  /** 앞과 같은 결과를 참조로 대체한 횟수 */
  repeated: number;
  /** 잘린 결과가 그 실행의 남은 모델 호출마다 다시 읽혔을 토큰 추정 = Σ ((rawChars - chars) / 4) × (그 뒤 모델 호출 수 + 1) */
  estimatedTokens: number;
}

export interface TokenReport {
  runId: string;
  request: string;
  turns: TokenTurn[];
  toolTotals: TokenToolTotal[];
  biggest: TokenBigResult[];
  warnings: TokenWarning[];
  totals: AgentUsage;
  /** 모델 이름별 토큰. 한 실행에 모델이 섞일 때(승격 등) 채워진다 */
  usageByModel?: Record<string, AgentUsage>;
  /** 모델별 비용(달러). 단가를 찾은 모델만 값이 있다 */
  modelCosts?: Record<string, number>;
  /** 캐시 읽기 / (입력 + 캐시 읽기 + 캐시 쓰기). 분모가 0이면 0 */
  cacheHitRatio: number;
  /** 실행 중 오래된 도구 결과를 비운 합계(횟수·글자). 비운 적이 없으면 0 */
  cleared: { count: number; chars: number };
  /** 도구 결과 예산이 잘라낸 양과 그 결과가 남은 호출마다 다시 읽혔을 양(추정). 프로젝트 보고서가 합산한다 */
  trimmed: TokenTrimmed;
  estimatedCostUsd?: number;
  /** 비용을 어느 방식으로 계산했는지: 모델별 단가 / 단일 단가 / 단가 없음 */
  priceSource: 'by-model' | 'single' | 'none';
  /** 비용을 계산하지 못한 이유 또는 모델별 단가가 없는 모델 문구 */
  priceNote?: string;
  /** 승격이 있었으면 어느 게이트 실패 뒤에 무엇으로 올렸는지 */
  escalation?: { from: string; to: string; attempt: number };
  /** 프로젝트 지침(AGENTS.md, ADR-077)이 시스템 프롬프트에 더한 글자 수. 파일이 없거나 꺼져 있으면 없다 */
  guideChars?: number;
  /** 턴별 컨텍스트 증가와 급증(jump) 분석. 기존 보고서와 호환하도록 선택 필드로 둔다 */
  contextGrowth?: ContextGrowthReport;
  /** PR 자동 리뷰(ADR-074)의 리뷰어 호출이면 'review'. 없으면 보통의 요청 실행이다 */
  kind?: 'review';
}
