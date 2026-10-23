/**
 * 사람이 세션에 붙이는 이름(#864, #875). 서버(setSessionLabel)와 화면이 같은 규칙으로 다듬고 길이를 잰다.
 * 이름은 터미널 사이드바(studio desk)에도 그대로 그려지므로 제어 글자를 뺀다
 */

/** 세션 이름의 최대 길이(글자 수, 이모지도 한 글자) */
export const SESSION_LABEL_MAX = 60;

/** 제어 글자를 빼고 앞뒤 빈칸을 뗀다. 빈 문자열이면 이름을 지운다는 뜻이다 */
export function cleanSessionLabel(label: string): string {
  return label.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim();
}

/** 다듬은 이름이 너무 길면 고칠 것을 알린다 */
export function sessionLabelProblem(label: string): string | undefined {
  return [...cleanSessionLabel(label)].length > SESSION_LABEL_MAX ? `세션 이름은 ${SESSION_LABEL_MAX}자까지입니다` : undefined;
}

/** 목록·칸 머리에 쓰는 이름: 붙인 이름이 있으면 그것, 없으면 프로젝트 이름 */
export function sessionDisplayName(session: { projectName: string; label?: string }): string {
  return session.label?.trim() || session.projectName;
}
