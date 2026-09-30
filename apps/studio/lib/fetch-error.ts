/**
 * 실패한 API 요청을 사람이 읽을 메시지로 바꾼다. 호출하는 쪽은 먼저 응답 바디의 `error` 필드를 확인하고,
 * 그게 없을 때만(예: Next 개발 서버가 라우트 표를 못 찾아 HTML 404를 돌려줄 때) 이 함수를 쓴다.
 *
 * fetch 자체가 실패했으면(네트워크 끊김 등) response가 undefined로 넘어오므로 서버가 응답하지 않았다고 알리고,
 * 응답은 왔지만 상태 코드가 실패라면 그 코드를 보여 주고 — 404면 오래된 개발 서버가 원인일 수 있다는 힌트를 더한다.
 */
export function describeFailedResponse(response: Response | undefined, fallback: string): string {
  if (!response) return `${fallback} (서버가 응답하지 않았습니다. 네트워크 연결을 확인해 보세요)`;
  if (response.status === 404) {
    return `${fallback} (서버 응답 ${response.status}). 앱 서버가 오래된 상태일 수 있습니다 — b-studio를 다시 시작해 보세요`;
  }
  return `${fallback} (서버 응답 ${response.status})`;
}
