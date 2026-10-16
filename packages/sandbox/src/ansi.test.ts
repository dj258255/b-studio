import { describe, expect, it } from 'vitest';
import { stripAnsi } from './ansi';

describe('stripAnsi', () => {
  it('CLI 오류에 붙은 색 코드를 지운다(계정 연결 화면에 [31m이 그대로 나오던 문제)', () => {
    expect(stripAnsi('- Checking authentication status...\n\u001b[31m✖\u001b[39m Not authenticated')).toBe('- Checking authentication status...\n✖ Not authenticated');
  });

  it('줄 지우기·커서 이동·256색·OSC 링크 같은 다른 제어 코드도 지운다', () => {
    expect(stripAnsi('\u001b[2K\u001b[1Gdone')).toBe('done');
    expect(stripAnsi('\u001b[38;5;196mred\u001b[0m')).toBe('red');
    expect(stripAnsi('\u001b]8;;https://example.com\u0007link\u001b]8;;\u0007')).toBe('link');
    expect(stripAnsi('\u001b[?25lhidden cursor\u001b[?25h')).toBe('hidden cursor');
    expect(stripAnsi('\u009b31mC1 CSI\u009b0m')).toBe('C1 CSI');
  });

  it('제어 코드가 없으면 그대로 돌려준다', () => {
    expect(stripAnsi('Command failed: codex login status')).toBe('Command failed: codex login status');
    expect(stripAnsi('')).toBe('');
  });
});
