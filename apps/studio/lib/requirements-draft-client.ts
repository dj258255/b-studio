/**
 * 요구사항 초안의 자동 저장·버리기 요청. 성공 응답일 때만 참을 돌려준다(#813). 예전에는 화면이 실패 응답과 끊긴 요청을 모두
 * 삼켜, 사용자는 저장·버렸다고 믿지만 편집이 사라지거나 버린 초안이 다시 나타날 수 있었다
 */
type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export async function saveRequirementsDraft(sessionId: string, body: Record<string, unknown>, fetchImpl: FetchLike = fetch): Promise<boolean> {
  const response = await fetchImpl(`/api/sessions/${sessionId}/requirements/draft`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }).catch(() => undefined);
  return response?.ok === true;
}

export async function discardRequirementsDraft(sessionId: string, fetchImpl: FetchLike = fetch): Promise<boolean> {
  const response = await fetchImpl(`/api/sessions/${sessionId}/requirements/draft`, { method: "DELETE" }).catch(() => undefined);
  return response?.ok === true;
}
