/**
 * 터미널 stdin 해석(순수). 글자는 입력 줄에 쌓이고, 붙여 넣기(`ESC[200~ … ESC[201~`)는 그 글이 통째로(줄바꿈 포함) 쌓이며,
 * Enter(`\r`)가 입력 줄을 요청으로 내보낸다. 빈 입력 줄의 Enter는 무시한다.
 * 서버가 터미널에 요청을 붙여 넣는 방식(bracketed paste + Enter)과 같고, 표식이 여러 조각에 나뉘어 와도 맞춘다
 */
export const PASTE_START = '\x1b[200~';
export const PASTE_END = '\x1b[201~';

export class InputParser {
  #buffer = '';
  #line = '';
  #pasted = false;

  /** 조각 하나를 먹고, 그 조각으로 완성된 요청들을 차례로 돌려준다 */
  feed(chunk: string): string[] {
    this.#buffer += chunk;
    const requests: string[] = [];
    for (;;) {
      if (this.#pasted) {
        const end = this.#buffer.indexOf(PASTE_END);
        if (end < 0) {
          // 끝 표식이 잘려 올 수 있어 끝 조각은 남기고 나머지는 붙여 넣은 글로 쌓는다
          const keep = Math.min(this.#buffer.length, PASTE_END.length - 1);
          this.#line += this.#buffer.slice(0, this.#buffer.length - keep);
          this.#buffer = this.#buffer.slice(this.#buffer.length - keep);
          return requests;
        }
        this.#line += this.#buffer.slice(0, end);
        this.#buffer = this.#buffer.slice(end + PASTE_END.length);
        this.#pasted = false;
        continue;
      }
      const start = this.#buffer.indexOf(PASTE_START);
      const enter = this.#buffer.indexOf('\r');
      if (start >= 0 && (enter < 0 || start < enter)) {
        this.#line += this.#buffer.slice(0, start);
        this.#buffer = this.#buffer.slice(start + PASTE_START.length);
        this.#pasted = true;
      } else if (enter >= 0) {
        this.#line += this.#buffer.slice(0, enter);
        this.#buffer = this.#buffer.slice(enter + 1);
        if (this.#line.trim()) requests.push(this.#line);
        this.#line = '';
      } else {
        // 붙여 넣기 시작 표식이 잘려 올 수 있어 표식 길이만큼 끝 조각은 남긴다
        const keep = Math.min(this.#buffer.length, PASTE_START.length - 1);
        this.#line += this.#buffer.slice(0, this.#buffer.length - keep);
        this.#buffer = this.#buffer.slice(this.#buffer.length - keep);
        return requests;
      }
    }
  }
}
