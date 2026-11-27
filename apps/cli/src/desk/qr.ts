import qrcode from 'qrcode-generator';

/**
 * 짝짓기 QR을 터미널에 그린다. 가로로 모듈 하나가 칸 하나, 세로로 모듈 둘이 칸 하나(윗반칸 ▀ 글자의 앞·뒷색)다.
 * 터미널 팔레트가 어떻든 읽히도록 검정·흰색을 직접 지정한다(어두운 터미널에서 테마색에 맡기면 반전돼 스캔이 안 된다).
 * 둘레의 흰 여백(quiet zone)은 2칸이다 — 규격은 4칸이지만 화면이 좁고, 휴대폰 카메라는 2칸으로도 읽는다
 */
const QUIET = 2;
const BLACK = '\x1b[30m';
const WHITE = '\x1b[97m';
const BLACK_BG = '\x1b[40m';
const WHITE_BG = '\x1b[107m';
const RESET = '\x1b[0m';

/** 글을 모듈 격자로(true가 검은 모듈). 한글이 있어도 UTF-8로 넣는다 */
export function qrMatrix(text: string): boolean[][] {
  // 라이브러리의 기본 인코더는 한 글자를 한 바이트로 자른다. 한글이 깨지지 않게 UTF-8로 바꾼다
  qrcode.stringToBytes = (value: string) => [...new TextEncoder().encode(value)];
  const qr = qrcode(0, 'L');
  qr.addData(text, 'Byte');
  qr.make();
  const size = qr.getModuleCount();
  return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, col) => qr.isDark(row, col)));
}

/** 격자 둘레에 흰 여백을 더한다 */
function padded(matrix: boolean[][]): boolean[][] {
  const size = matrix.length + QUIET * 2;
  return Array.from({ length: size }, (_, row) => Array.from({ length: size }, (_, col) => matrix[row - QUIET]?.[col - QUIET] ?? false));
}

/** QR을 줄 목록으로. 각 줄은 색을 직접 지정하고 줄 끝에서 색을 되돌린다 */
export function qrLines(text: string): string[] {
  const grid = padded(qrMatrix(text));
  const lines: string[] = [];
  for (let row = 0; row < grid.length; row += 2) {
    let line = '';
    for (let col = 0; col < grid.length; col++) {
      const top = grid[row]![col]!;
      // 홀수 줄이면 마지막 줄의 아래는 여백(흰색)이다
      const bottom = grid[row + 1]?.[col] ?? false;
      line += `${top ? BLACK : WHITE}${bottom ? BLACK_BG : WHITE_BG}▀`;
    }
    lines.push(line + RESET);
  }
  return lines;
}

/** 줄 목록의 칸 너비(여백 포함). 화면에 들어가는지 볼 때 쓴다 */
export function qrWidth(text: string): number {
  return qrMatrix(text).length + QUIET * 2;
}
