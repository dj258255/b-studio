/**
 * "올리기 전 점검" 점수 한 줄. 건너뛴 항목은 분모에서 빠지므로 그 수를 따로 적는다. 그러지 않으면 항목 7개 중
 * "1/6 통과"처럼 항목 하나가 사라진 것으로 보인다(이슈 #720). 저장소 탭과 PR 본문이 같은 함수를 쓴다
 */
export function formatSubmissionScore(report: { items: readonly { status: string }[]; score: { passed: number; total: number } }): string {
  const skipped = report.items.filter((item) => item.status === 'skip').length;
  const base = `${report.score.passed}/${report.score.total} 통과`;
  return skipped > 0 ? `${base} · 건너뜀 ${skipped}` : base;
}
