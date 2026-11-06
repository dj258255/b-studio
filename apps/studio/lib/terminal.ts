/**
 * 읽기만 요청의 표시. 요청 글이 이것으로 시작하면 플랫폼이 그 실행에서 파일을 바꾸거나 명령을 돌리는 도구를 모두 거절한다.
 * 문장으로 부탁하는 것이 아니라 훅이 막는다. 표시를 알아보는 규칙은 서버 쪽 한 곳에만 있다(@b-studio/sandbox의 isReadOnlyPrompt) —
 * 화면은 글 앞에 이 표시를 붙이기만 한다. 값은 그쪽의 AGENT_READ_ONLY_MARK와 같아야 한다(테스트가 묶어 둔다)
 */
export const TERMINAL_READ_ONLY_MARK = '[읽기만]';

/** 붙여 넣는 글의 길이 상한. 터미널에 한꺼번에 밀어 넣는 양을 묶는다 */
export const TERMINAL_PASTE_LIMIT = 8_000;

/**
 * 제어 문자와 방향 제어 문자. 터미널에 붙여 넣는 것은 글이 아니라 키 입력이다 — 남이 쓴 글(이슈 본문, 리뷰 지적, 미리보기의 HTML)에
 * ESC나 붙여 넣기 끝 표시가 들어 있으면 붙여 넣기 구간을 빠져나와 Enter까지 누를 수 있다. xterm의 paste는 걸러 주지 않는다(6.0.0에서 확인).
 * 줄바꿈과 탭만 남기고 C0·DEL·C1을 지운다. 방향 제어 문자(U+202A~202E, U+2066~2069)는 사람이 보는 글과 실제 글을 다르게 만들 수 있어 함께 지운다
 */
const UNSAFE_PASTE_CHARS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

/**
 * 다른 패널이 "입력창에 채우기"로 넘긴 글을 터미널의 입력 줄에 붙여 넣을 꼴로 다듬는다(이슈 #689).
 * - 제어 문자를 지운다(위)
 * - multiline이 거짓이면(CLI가 붙여 넣기 모드를 켜 두지 않았다 — 셸 프롬프트일 수 있다) 줄바꿈을 빈칸으로 바꾼다.
 *   그 상태에서 줄바꿈은 Enter로 들어가, 글의 줄마다 명령으로 실행된다
 * - 입력 줄의 첫 글자로 CLI의 다른 모드를 여는 글자("!" 셸, "/" 명령)로 시작하면 앞에 말을 붙여 보통 요청으로 만든다
 * - 읽기만이면 표시를 앞에 붙인다. 플랫폼이 그 표시를 보고 쓰기 도구를 막는다
 */
export function terminalPasteText(text: string, { readOnly = false, multiline = true }: { readOnly?: boolean; multiline?: boolean } = {}): string {
  // 줄·문단 구분자(U+2028·U+2029)도 줄바꿈으로 본다. 아래에서 줄바꿈을 빈칸으로 바꿀 때 함께 바뀌어야 한다
  let body = text.replace(/\r\n?|[\u2028\u2029]/g, '\n').replace(/\t/g, '  ').replace(UNSAFE_PASTE_CHARS, '').trim();
  if (body === '') return '';
  if (!multiline) body = body.replace(/\s*\n\s*/g, ' ');
  if (body.length > TERMINAL_PASTE_LIMIT) body = `${body.slice(0, TERMINAL_PASTE_LIMIT)}…(잘림)`;
  if (readOnly) return `${TERMINAL_READ_ONLY_MARK} ${body}`;
  return /^[!/]/.test(body) ? `요청: ${body}` : body;
}
