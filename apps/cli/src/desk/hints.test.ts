import { describe, expect, it } from 'vitest';
import { fitHint } from './hints';
import { stringWidth } from './screen';

describe('키 안내 한 줄 맞추기(#935)', () => {
  it('맞으면 그대로 두고 남는 폭은 빈칸으로 채운다', () => {
    const line = fitHint(' 카드 화면 · Enter 열기 · Esc 닫기', 40);
    expect(line.trimEnd()).toBe(' 카드 화면 · Enter 열기 · Esc 닫기');
    expect(stringWidth(line)).toBe(40);
  });

  it('폭이 모자라면 뒤 항목부터 통째로 빼고, 첫 항목과 Esc·? 항목은 남긴다(잘린 글자가 없다)', () => {
    const text = ' 카드 화면 · ←→ 고르기 · Enter 칸에 열기 · i 자세히 · d 지금 변경 · Esc 칸 화면 · ? 모든 키';
    const line = fitHint(text, 50);
    expect(stringWidth(line)).toBe(50);
    expect(line).not.toContain('…');
    expect(line).toContain('카드 화면');
    expect(line).toContain('←→ 고르기');
    expect(line).toContain('Esc 칸 화면');
    expect(line).toContain('? 모든 키');
    expect(line).not.toContain('d 지금 변경');
    // 남은 항목은 원래 차례 그대로다
    expect(line.indexOf('←→')).toBeLessThan(line.indexOf('Esc'));
  });

  it('묻는 줄은 "다른 키 그만두기"부터 빼고 y 항목은 남긴다', () => {
    const line = fitHint(' ‹아주 긴 세션 이름› 세션을 멈출까요? · y 멈추기 · 다른 키 그만두기', 50);
    expect(line).toContain('y 멈추기');
    expect(line).not.toContain('그만두기');
    expect(line).not.toContain('…');
  });

  it('남길 항목만으로도 넘치면 그때만 끝을 줄인다', () => {
    const line = fitHint(' 아주아주 긴 안내 한 줄입니다 · Esc 닫기', 12);
    expect(stringWidth(line)).toBe(12);
    expect(line).toContain('…');
  });
});
