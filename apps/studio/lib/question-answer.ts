/**
 * 되묻기(ADR-056)에 답할 때 보내는 요청 문장. 대화 패널과 나란히 보기 칸이 같은 형식을 쓴다.
 * 이어받는 러너는 이 문장으로 질문과 답을 함께 보고, 기록에도 요청 줄 하나로 남는다
 */
export function answerRequest(question: string, answer: string): string {
  return `[질문] ${question}\n[답] ${answer}`;
}
