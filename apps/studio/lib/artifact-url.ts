/** 산출물 식별자(`<runId>/<파일명>`)를 내려받을 URL로 바꾼다. 파일 이름의 공백·한글도 안전하게 인코딩한다 */
export function artifactUrl(sessionId: string, artifact: string): string {
  const segments = artifact
    .split('/')
    .filter(Boolean)
    .map(encodeURIComponent);
  return `/api/sessions/${encodeURIComponent(sessionId)}/artifacts/${segments.join('/')}`;
}
