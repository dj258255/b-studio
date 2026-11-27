/**
 * 리뷰 평가 세트의 타입.
 *
 * 평가 세트는 결함을 심은 작은 diff 여러 개와 결함 없는 diff 몇 개다. 항목마다 "이 파일의 이 줄 범위에 이 종류의 결함이 있다"는
 * 기대 지적을 적고, 채점기(score.ts)가 리뷰 응답의 지적과 파일·줄 범위로 기계로 맞춘다. 모델은 채점에 쓰지 않는다.
 */
export const DEFECT_TAGS = [
  'off-by-one',
  'null-handling',
  'sql-injection',
  'command-injection',
  'swallowed-error',
  'boundary',
  'race-condition',
  'missing-authz',
] as const;
export type DefectTag = (typeof DEFECT_TAGS)[number];

export const EVAL_LANGUAGES = ['typescript', 'python'] as const;
export type EvalLanguage = (typeof EVAL_LANGUAGES)[number];

/** 새 파일 기준의 줄 번호(1부터, 양 끝 포함) */
export interface ExpectedFinding {
  file: string;
  startLine: number;
  endLine: number;
  tag: DefectTag;
}

export interface EvalCase {
  id: string;
  language: EvalLanguage;
  /** 리뷰어에게 주는 "사용자의 원래 요청" 한 줄 */
  request: string;
  diff: string;
  /** 비어 있으면 결함 없는 diff(오탐 측정용) */
  expected: ExpectedFinding[];
}
