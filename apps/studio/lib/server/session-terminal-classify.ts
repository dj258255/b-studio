import { native } from '@b-studio/sandbox';

/**
 * 세션 터미널의 요청·도구 입력 분류(ADR-215, 4f B5a). 판정은 Rust `crates/bstudio-session`의 `terminal::classify`가 한다(순수 함수).
 * 여기는 글을 코어에 넘기고 결과를 TS 값으로 돌려주는 껍데기다. 옛 판정은 `session-terminal-classify-legacy.ts`에 차등 시험의 기준으로만 남아 있다.
 *
 * 부르는 자리마다 막는 쪽인지 여는 쪽인지:
 * - `readOnly`: 읽기만을 놓치는 것이 여는 쪽이다(읽기만 요청의 쓰기가 허용된다). 코어가 의심스러우면 읽기만으로 읽는다
 * - `slashCommand`: 요청 시작에서 "CLI 안에서 끝나는 명령"을 가른다. 참이면 실행을 열지 않고 토큰 한도 거절도 건너뛴다(그 칸의 값이 `/`로 시작하는 글뿐이다)
 * - `isReadTool`: 쓰기 직전 훅의 앞 칸이다. 참이면 아무것도 기다리지 않고 허용한다(여는 쪽). 정확히 일치하는 이름만 참이고 모르는 이름은 거짓이다
 */

export interface PromptClass {
  /** 읽기만 요청이다 */
  readOnly: boolean;
  /** 감싸개를 한 번 벗기고 자른 글이 `/`로 시작한다 */
  slashCommand: boolean;
  /** 붙여 넣은 요청의 감싸개를 한 번 벗기고 앞뒤 빈칸을 자른 글 */
  unwrapped: string;
}

/**
 * 코어는 Rust 문자열만 받는다. 짝 없는 서로게이트(JS 문자열에는 있다)는 U+FFFD로 바꿔 넘긴다 — 표시와 상관없는 자리라 판정은 같고, 넘기다 던지지 않는다
 */
export function classifyPrompt(text: string): PromptClass {
  return native.terminalClassifyPrompt(text.toWellFormed());
}

/** 읽기만 요청인가 */
export function isReadOnlyPrompt(text: string): boolean {
  return classifyPrompt(text).readOnly;
}

/** 파일을 바꾸지 않는 도구인가(Claude Code와 Codex의 읽기 도구 표) */
export function isReadTool(name: string): boolean {
  return native.terminalIsReadTool(name.toWellFormed());
}

/**
 * 읽기만이 앞선 변경이 있는 실행에 이어 켜질 때 턴 끝이 읽기만 지름길을 타지 않게 표시하는가(S6, ADR-212).
 * `changedBefore`가 `undefined`면 변경 목록을 읽지 못한 것이라 있는 것으로 본다(막는 쪽)
 */
export function readOnlyAfterWork(alreadyReadOnly: boolean, verificationStarted: boolean, changedBefore: boolean | undefined): boolean {
  return native.terminalReadOnlyAfterWork(alreadyReadOnly, verificationStarted, changedBefore === undefined ? 2 : changedBefore ? 1 : 0);
}
