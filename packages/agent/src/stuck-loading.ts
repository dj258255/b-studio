/**
 * 화면 확인(browser_check)이 "데이터를 못 받아 로딩 상태에서 멈춘 화면"을 잡는 순수 판정 함수(ADR-078).
 *
 * 왜 필요한가: E8에서 Haiku 단독 실행 2건이 게이트를 통과했지만, `/dashboard`가 클라이언트에서 부른 fetch가 끝나지
 * 않아 "Loading..." 문구만 보여 준 채 멈춰 있었다(인수 확인에서만 잡힘). 게이트의 화면 확인은 렌더링된 글자에서
 * expectText가 있는지만 보고, "로딩 문구뿐이다"라는 것 자체는 보지 않았다.
 *
 * 판정 방식(오탐을 줄이려고 두 단계로 나눈다):
 *  1. 렌더링된 글자를 줄 단위로 나눠, **모든 줄이 로딩 문구뿐**이면 멈춘 화면으로 본다. "Loading Dock 안내"처럼
 *     문장 일부에 로딩이라는 낱말이 들어간 줄은 패턴 전체와 맞지 않아 걸리지 않는다(각주에 실패 예시 있음).
 *  2. 글자가 아예 없으면(스켈레톤·스피너만 있는 화면) 로딩 문구 매칭이 불가능하므로, 실패한 요청·콘솔 오류·스크립트
 *     예외 중 하나라도 있을 때만("증거") 멈춘 화면으로 본다. 증거 없이 빈 화면만으로는 판정하지 않는다 — 의도적으로
 *     빈 화면을 보여주는 페이지(스플래시 등)를 오탐하지 않기 위해서다.
 */

/** 한 줄이 "로딩 문구뿐"인지 보는 패턴. 줄 전체가 맞아야 하므로 ^...$ 로 감싼다(부분 일치는 걸지 않는다) */
const LOADING_LINE_PATTERNS: readonly RegExp[] = [
  /^loading(\s*data)?\.{0,3}$/i,
  /^please\s+wait\.{0,3}$/i,
  /^one\s+moment(\s+please)?\.{0,3}$/i,
  /^fetching(\s*data)?\.{0,3}$/i,
  /^(데이터를?\s*)?불러오는\s*중(입니다)?\.{0,3}$/,
  /^로딩\s*중(입니다)?\.{0,3}$/,
  /^로딩\.{0,3}$/,
  /^잠시만\s*기다려\s*주세요\.{0,3}$/,
  /^잠시만\s*기다려\s*주십시오\.{0,3}$/,
];

/** 줄이 로딩 문구뿐인지. 앞뒤 공백·스피너 기호(•…) 정도는 지우고 비교한다 */
function isLoadingLine(line: string): boolean {
  const trimmed = line.replace(/^[•·\s]+|[•·\s]+$/g, '').trim();
  if (trimmed.length === 0) return false;
  return LOADING_LINE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

/** 화면 확인이 함께 본 증거. 하나라도 있으면 "빈 화면"을 데이터 실패의 결과로 본다 */
export interface StuckLoadingEvidence {
  failedRequests: number;
  consoleErrors: number;
  pageErrors: number;
}

/**
 * 렌더링된(또는 SSR) 본문 글자가 로딩 상태에서 멈춘 것으로 보이면 사람이 읽을 한국어 사유를 돌려주고, 아니면 undefined.
 * `evidence`를 생략하면(HTTP 모드처럼 실패한 요청을 모를 때) 빈 화면 판정은 하지 않는다(보수적으로 본다).
 */
export function detectStuckLoading(text: string, evidence?: StuckLoadingEvidence): string | undefined {
  const normalized = text.replace(/\r\n/g, '\n').trim();
  const lines = normalized
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length === 0) {
    const hasSupportingEvidence = evidence !== undefined && evidence.failedRequests + evidence.consoleErrors + evidence.pageErrors > 0;
    if (!hasSupportingEvidence) return undefined;
    return '화면에 표시된 내용이 없습니다(스켈레톤이거나 데이터를 못 받아 빈 상태로 멈췄을 수 있습니다) — 실패한 요청·콘솔 오류·스크립트 예외를 함께 보세요';
  }

  if (lines.every((line) => isLoadingLine(line))) {
    const shown = normalized.length > 60 ? `${normalized.slice(0, 60)}…` : normalized;
    return `화면이 로딩 문구만 보여 준 채 멈췄습니다: "${shown}"`;
  }
  return undefined;
}
