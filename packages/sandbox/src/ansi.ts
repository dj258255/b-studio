/**
 * 터미널 제어 코드(ANSI 이스케이프)를 지운다. CLI·컨테이너가 색을 붙여 찍은 출력을 화면 문구나 로그 줄로 옮길 때 쓴다.
 *
 * - CSI: `ESC [` 또는 8비트 `\u009b` 뒤 매개변수·중간 바이트·끝 글자(색 `ESC[31m`, 줄 지우기 `ESC[2K`, 커서 `ESC[?25l`)
 * - OSC: `ESC ]` … BEL 또는 `ESC \`(터미널 링크·창 제목)
 * - 그 밖의 두 글자 이스케이프(`ESC 7`, `ESC c` 등)
 */
const ANSI_PATTERN = /(?:\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\))|(?:(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~])|(?:\u001b[@-Z\\-_0-9=>c])/g;

export function stripAnsi(text: string): string {
  if (!text.includes('\u001b') && !text.includes('\u009b')) return text;
  return text.replace(ANSI_PATTERN, '');
}
