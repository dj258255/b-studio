/**
 * 대화 입력창이 서버로 보내는 본문. 입력은 하나이고, "읽기만" 스위치가 경로를 가른다.
 *
 *  - 스위치 꺼짐(기본): 만들기 경로(intent `build`). 에이전트가 요청을 보고 **답만 하거나 바꾼다**
 *    — 바꾼 것은 검증 게이트를 통과해야 남고, 바뀐 파일이 없으면 게이트는 검증 없이 통과한다
 *  - 스위치 켜짐: 질문 경로(intent `ask`). 실행기가 읽기 전용 도구만 넘겨 파일을 바꾸지 못한다
 *
 * 대화 화면과 나란히 보기 칸이 같은 규칙을 쓰도록 한 곳에 둔다(서버 API의 intent 값은 그대로다).
 */
export type ChatIntent = 'build' | 'ask';

/** 스위치가 정하는 경로 */
export function intentFor(readOnly: boolean): ChatIntent {
  return readOnly ? 'ask' : 'build';
}

export interface ChatRequestBody {
  text: string;
  allowBreaking: boolean;
  intent: ChatIntent;
  /** 가볍게 확인이면 'light'. 전체 검증(full)이면 보내지 않는다 */
  verify?: 'light';
  /** "조사" 모드(읽기만일 때만 뜻이 있다). true면 웹에서 찾아 답하라는 뜻 — claude-code 백엔드만 실제로 연다 */
  research?: boolean;
}

export function chatRequestBody(input: { text: string; intent: ChatIntent; allowBreaking?: boolean; lightVerify?: boolean; research?: boolean }): ChatRequestBody {
  return {
    text: input.text,
    // 질문 경로는 파일을 바꾸지 않으므로 호환성 파괴 허용은 뜻이 없다 — 보내지 않는다
    allowBreaking: input.intent === 'build' && input.allowBreaking === true,
    intent: input.intent,
    // 가볍게 확인은 만들기 경로에만 뜻이 있다(질문은 게이트를 돌리지 않는다)
    ...(input.intent === 'build' && input.lightVerify ? { verify: 'light' as const } : {}),
    // 조사는 질문 경로에만 뜻이 있다(만들기는 애초에 읽기만이 아니다)
    ...(input.intent === 'ask' && input.research ? { research: true as const } : {}),
  };
}
