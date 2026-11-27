import { describe, expect, it } from 'vitest';
import { qrLines, qrMatrix, qrWidth } from './qr';

// eslint-disable-next-line no-control-regex
const strip = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, '');

describe('QR 그리기', () => {
  const payload = JSON.stringify({ t: 'b-studio-pair', v: 1, k: 'A'.repeat(44), c: 'ABCDEFGHJK', a: ['192.168.0.5:38917', '10.0.0.7:38917'], n: '범수의 맥' });

  it('격자는 정사각형이고 세 모서리에 찾기 무늬(7칸 검은 테두리)가 있다', () => {
    const matrix = qrMatrix(payload);
    const size = matrix.length;
    expect(matrix.every((row) => row.length === size)).toBe(true);
    for (const [r, c] of [[0, 0], [0, size - 7], [size - 7, 0]] as const) {
      for (let i = 0; i < 7; i++) {
        expect(matrix[r]![c + i]).toBe(true);
        expect(matrix[r + 6]![c + i]).toBe(true);
        expect(matrix[r + i]![c]).toBe(true);
        expect(matrix[r + i]![c + 6]).toBe(true);
      }
      expect(matrix[r + 3]![c + 3]).toBe(true);
      expect(matrix[r + 1]![c + 1]).toBe(false);
    }
  });

  it('줄은 모듈 두 줄에 한 줄이고 폭은 모듈 수에 여백을 더한 값이다. 글자는 ▀뿐이다', () => {
    const lines = qrLines(payload);
    const width = qrWidth(payload);
    expect(lines.length).toBe(Math.ceil(width / 2));
    for (const line of lines) {
      expect(strip(line)).toMatch(new RegExp(`^▀{${width}}$`));
      expect(line.endsWith('\x1b[0m')).toBe(true);
    }
  });

  it('위·아래 여백은 흰색이다(첫 줄은 모두 흰색)', () => {
    const first = qrLines(payload)[0]!;
    expect(first).not.toContain('\x1b[30m');
    expect(first).not.toContain('\x1b[40m');
  });

  it('한글이 든 내용도 만들 수 있고, 너무 길면 던진다(조용히 잘리지 않는다)', () => {
    expect(() => qrLines('가'.repeat(100))).not.toThrow();
    expect(() => qrLines('x'.repeat(5000))).toThrow();
  });

  it('짝짓기 내용은 휴대폰 화면에 들어가는 크기다(터미널 폭 80칸 안)', () => {
    expect(qrWidth(payload)).toBeLessThanOrEqual(60);
  });
});
