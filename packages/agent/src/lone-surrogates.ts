/**
 * `@b-studio/sandbox`의 `encodeLoneSurrogates`(단사 변환)를 되돌린다. Rust가 인코딩한 글자로 돌려준 값(경로 목록 등)을 원래 글자로 읽을 때 쓴다.
 * 짝 없는 서로게이트 단위(U+D800..U+DFFF라 맨 앞 니블은 늘 D)는 U+E010 + 아래 니블 셋, 글자 그대로의 예약 글자(U+E000..U+E01F)는 U+E011 + 니블 둘로 쓴 것을 풀어 쓴다.
 * 이스케이프 꼴이 아닌 예약 글자는 그대로 둔다
 */
const ESCAPE = /([-])([-])([-])|([-])([-])/g;
const value = (nibble: string) => nibble.charCodeAt(0) - 0xe000;

export function decodeLoneSurrogates(text: string): string {
  return text.replace(ESCAPE, (_match, a?: string, b?: string, c?: string, d?: string, e?: string) => {
    if (a !== undefined && b !== undefined && c !== undefined) return String.fromCharCode(0xd000 | (value(a) << 8) | (value(b) << 4) | value(c));
    return String.fromCharCode(0xe000 + ((value(d!) << 4) | value(e!)));
  });
}
