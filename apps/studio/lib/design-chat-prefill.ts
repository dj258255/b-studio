/**
 * 설계 파이프라인(ADR-0XX) → 대화 프리필. "설계 요청"이 채우는 글은 "조사"(읽기만) 모드와 함께 켠다
 * (requirement-chat-prefill.ts의 "대화에서 묻기"와 같은 경계) — 모델은 이 턴에서 파일을 바꾸지 않는다.
 * 사람이 답을 받아 검토한 뒤 "파이프라인" 화면의 "설계 문서 만들기" 양식에 붙여 넣어 저장한다.
 *
 * 순수 함수만 둔다(클라이언트 컴포넌트에서 쓰므로 Node 전용 모듈을 당기는 @b-studio/agent 런타임 코드는 쓰지 않는다 —
 * 패키지의 pure 함수(buildDesignPipelineRequestPrompt)와 같은 문구를 의도적으로 다시 적되, 서버 쪽 사이드카 파싱이
 * 기대하는 "작업 묶음" 표 형식만은 반드시 agent 패키지의 설계와 똑같이 맞춘다).
 */

/** "설계 요청"이 채우는 질문 글. 대상 요구사항·지시를 담고 정해진 절 제목으로 답하게 한다 */
export function buildDesignDraftChatPrefill(input: { title: string; requirementIds: readonly string[]; detail?: string }): string {
  const ids = input.requirementIds.length > 0 ? input.requirementIds.join(', ') : '(해당 없음)';
  const detail = input.detail?.trim() ? `\n\n${input.detail.trim()}` : '';
  return `"${input.title}" 설계 문서를 써 주세요. 대상 요구사항: ${ids}.${detail}

지금은 파일을 바꾸지 말고 읽기만 하세요. 실제 코드를 확인한 사실만 쓰고, 모르면 "불확실"이라고 적으세요.
아래 항목을 마크다운으로, 이 순서대로 답하세요:

## 대상 요구사항
(이 설계가 다루는 요구사항 id와 한 줄 설명)

## 접근
(전체 구현 방향)

## 데이터·API 계약 변경
(바뀌는 스키마·엔드포인트·타입. 없으면 "없음")

## 작업 묶음

| 묶음 | 완료 조건 | 예상 시간(분) | 결과물 | 쓰기 범위 |
| --- | --- | --- | --- | --- |
| B1 (묶음 제목) | (무엇이 되면 끝인지) | 30-60 | (어떤 파일·화면이 나오는지) | (쓸 경로, 쉼표로 구분) |

표 형식을 그대로 지키세요(다른 열을 추가하거나 빼지 마세요) — 플랫폼이 이 표로 예상 시간을 기록합니다.

## 위험·불확실성
(불확실한 점, 검증이 필요한 가정)

## 검증 방법
(각 작업 묶음을 어떻게 확인할지 — 게이트·테스트·화면 확인 등)`;
}
