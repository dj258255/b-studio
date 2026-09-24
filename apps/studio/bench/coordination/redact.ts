/** 비밀 값 가리기. 결과 JSONL 한 줄과 요약을 쓰기 직전에 적용한다 */
export function redact(value: string, secrets: string[]): string {
  let result = value;
  for (const secret of secrets) {
    if (secret.length < 8) continue;
    result = result.split(secret).join('***');
  }
  return result;
}
