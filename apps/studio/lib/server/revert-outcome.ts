/**
 * 되돌린 결과를 사람이 읽을 글로 만든다(이슈 #992).
 * 실패한 실행을 되돌릴 때 문서(docs 등)는 먼저 체크포인트로 남기고(ADR-099) 나머지를 되돌린다. 되돌린 파일(reverted)만 세면
 * 문서만 바뀐 실행이 "바뀐 파일은 없었습니다"로 적힌다 — 파일은 체크포인트에 그대로 남아 있는데도 그렇게 읽혔다.
 * 그래서 문서로 남긴 파일(keptDocs)을 따로 알린다
 */
const SHOWN_DOCS = 5;

function keptSentence(keptDocs: readonly string[]): string {
  const shown = keptDocs.slice(0, SHOWN_DOCS).join(', ');
  return `문서 ${keptDocs.length}개(${shown}${keptDocs.length > SHOWN_DOCS ? ` 외 ${keptDocs.length - SHOWN_DOCS}개` : ''})는 되돌리지 않고 체크포인트로 남겼습니다`;
}

/**
 * - 되돌린 것도 남긴 것도 없다: `바뀐 파일은 없었습니다`
 * - 되돌린 것이 있다: `바뀐 파일 N개를 되돌렸습니다`(restorable이면 되살릴 수 있다는 말을 붙인다) — 남긴 문서가 있으면 뒤에 덧붙인다
 * - 되돌린 것은 없고 남긴 문서만 있다: `되돌릴 변경은 없었고 문서 M개(…)는 되돌리지 않고 체크포인트로 남겼습니다`
 */
export function revertedText(reverted: readonly string[], keptDocs: readonly string[], { restorable = false }: { restorable?: boolean } = {}): string {
  if (reverted.length === 0) return keptDocs.length === 0 ? '바뀐 파일은 없었습니다' : `되돌릴 변경은 없었고 ${keptSentence(keptDocs)}`;
  const main = `바뀐 파일 ${reverted.length}개를 되돌렸습니다${restorable ? '(대화 탭에서 되살릴 수 있습니다)' : ''}`;
  return keptDocs.length === 0 ? main : `${main}. ${keptSentence(keptDocs)}`;
}
