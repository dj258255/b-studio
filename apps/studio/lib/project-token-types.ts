/**
 * 프로젝트 토큰 보고서의 형태와 표기. 서버(집계·마크다운)와 화면이 함께 쓴다(서버 전용 코드는 담지 않는다).
 *
 * 여기 있는 문구·숫자 표기를 서버와 화면이 같이 쓰는 이유는, 화면과 내려받는 마크다운이 다른 말을 하지 않게 하기 위해서다.
 */
import type { AgentUsage, Effort } from '@b-studio/agent';

/** 이 세션이 무엇으로 만들어졌는가. 레인·통합·플릿 멤버는 계획·플릿 기록에서 찾는다 */
export type ProjectSessionKind = 'normal' | 'lane' | 'integration' | 'fleet';
export const SESSION_KIND_LABEL: Record<ProjectSessionKind, string> = {
  normal: '일반',
  lane: '작업 분해 레인',
  integration: '통합',
  fleet: 'Fleet 멤버',
};
export const PROJECT_KIND_ORDER: ProjectSessionKind[] = ['normal', 'lane', 'integration', 'fleet'];

/** 한 요청이 어떻게 끝났는가 */
export type ProjectRequestResult = 'changed' | 'answered' | 'light' | 'failed' | 'running';
export const REQUEST_RESULT_LABEL: Record<ProjectRequestResult, string> = {
  changed: '바꿈',
  answered: '답만',
  light: '가볍게',
  failed: '실패',
  running: '진행 중',
};

/** 모델별 내역을 남기지 않는 실행(구독 CLI 러너 등)의 토큰을 묶는 이름 */
export const UNKNOWN_MODEL = '(모름)';

/** 마크다운 끝에 붙는 문구. 과제 README에 그대로 붙여도 오해가 없게 한다 */
export const PRICE_DISCLAIMER = '비용은 공식 단가로 환산한 추정치이며 구독 요금과 다릅니다';
/** 줄인 토큰 추정의 방식 문구. 측정값과 섞이지 않게 마크다운과 화면이 같은 문장을 쓴다 */
export const TRIM_ESTIMATE_METHOD = 'Σ (잘라낸 글자 ÷ 4) × (그 결과 뒤의 모델 호출 수 + 1) — 글자 수를 4로 나눠 토큰으로 본 근사입니다';
/** 마크다운과 화면의 요청별 표에 넣는 최대 줄 수 */
export const MAX_REQUEST_ROWS = 50;

/** 요청 한 줄. 최신 실행이 먼저 온다 */
export interface ProjectRequestRow {
  sessionId: string;
  kind: ProjectSessionKind;
  /** 요청 앞 60자 */
  request: string;
  /** 실행의 첫 기록 시각(로그·사용량·체크포인트). 시각을 남기지 않는 기록이면 없다 */
  at?: string;
  usage: AgentUsage;
  /** 이 요청의 환산 비용. 단가가 없으면 없다 */
  costUsd?: number;
  turns?: number;
  result: ProjectRequestResult;
  /** 이 요청이 실제로 쓴 노력 단계(agent 'session' 이벤트에서 읽는다). 러너가 알리지 않았으면(effort를 안 바꿨고 기본값도 안 실었으면) 없다 */
  effort?: Effort;
}

export interface ProjectKindTotals {
  kind: ProjectSessionKind;
  sessions: number;
  requests: number;
  usage: AgentUsage;
  costUsd?: number;
}

/** b-studio가 줄인 양. measured는 기록에 남은 사실, estimate는 근사 추정이다 */
export interface ProjectSavedTotals {
  /** 도구 결과 예산이 잘라낸 글자 합(측정) */
  trimmedChars: number;
  /** 앞과 같은 결과를 참조로 대체한 횟수(측정) */
  repeatedResults: number;
  /** 묶어서 비운 도구 결과(측정) */
  clearedCount: number;
  clearedChars: number;
  /** 가볍게 확인으로 끝난 실행 수와 건너뛴 단계(측정) */
  lightRuns: number;
  lightSkipped: Array<{ stage: string; runs: number }>;
  /** 잘린 결과가 남은 호출마다 다시 읽혔을 토큰(추정). 글자÷4 근사 */
  trimmedTokensEstimated: number;
  /** 그 추정을 캐시 읽기 단가로 환산한 금액(추정). 단가를 못 찾으면 없다 */
  trimmedCostUsd?: number;
  /** 금액을 환산할 때 쓴 모델(그 모델의 캐시 읽기 단가) */
  trimmedCostModel?: string;
}

export interface ProjectTokenReport {
  projectId: string;
  projectName: string;
  generatedAt: string;
  /** 기간 필터(있으면). ISO 시각 */
  range?: { from?: string; to?: string };
  sessions: number;
  requests: ProjectRequestRow[];
  totals: AgentUsage;
  modelCalls: number;
  /** 모델별 합. 모델별 내역이 없는 실행(구독 CLI 러너 등)은 UNKNOWN_MODEL로 묶는다 */
  usageByModel: Record<string, AgentUsage>;
  /** 모델별 환산 비용. 단가를 찾은 모델만 값이 있다 */
  modelCosts: Record<string, number>;
  estimatedCostUsd?: number;
  priceSource: 'by-model' | 'single' | 'none';
  priceNote?: string;
  cacheHitRatio: number;
  kinds: ProjectKindTotals[];
  saved: ProjectSavedTotals;
  /** 값을 만들면서 알아낸 한계·사실(마크다운에도 적는다) */
  notes: string[];
}

export function totalTokens(usage: AgentUsage): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

export function formatTokens(value: number): string {
  return value.toLocaleString('ko-KR');
}

export function formatRatio(ratio: number): string {
  return `${(ratio * 100).toFixed(1)}%`;
}

/** 환산 비용 한 칸. 단가가 없으면 그 사실을 적는다 */
export function formatCost(cost: number | undefined): string {
  return cost === undefined ? '단가 미설정' : `$${cost.toFixed(4)}`;
}

/** 비용 계산 방식 문구 */
export function priceSourceLabel(source: ProjectTokenReport['priceSource']): string {
  return source === 'by-model' ? '모델별 단가' : source === 'single' ? '단일 단가' : '단가 미설정';
}

/** `2026-09-28 12:34 UTC`. 타임존에 기대지 않아 어디서 만들어도 같은 값이 된다 */
export function formatUtcStamp(iso: string): string {
  return `${iso.slice(0, 16).replace('T', ' ')} UTC`;
}

/** 사람이 보는 시각(브라우저·서버의 지역 시간) */
export function formatLocalStamp(iso: string): string {
  return new Intl.DateTimeFormat('ko-KR', { dateStyle: 'short', timeStyle: 'short' }).format(new Date(iso));
}

/** 보고서 머리에 붙는 기간 문구. 기간을 주지 않았으면 "전체 기간" */
export function rangeText(range: { from?: string; to?: string } | undefined): string {
  if (!range) return '전체 기간';
  const day = (value: string) => value.slice(0, 10);
  if (range.from && range.to) return `${day(range.from)} ~ ${day(range.to)}`;
  if (range.from) return `${day(range.from)} 이후`;
  return `${day(range.to!)} 까지`;
}
