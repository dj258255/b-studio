import { describe, expect, it } from 'vitest';
import { deleteImage, DIACRITICS, graphicsMode, KittyImages, PLACEHOLDER, placeholderLines, transmitImage } from './kitty';
import { fitAnsi, stringWidth, stripAnsi } from './screen';
import { spriteFromRows, type Sprite } from './sprite';

describe('Kitty 그래픽(#902)', () => {
  it('Ghostty·kitty에서만 쓰고, tmux·screen 안이면 쓰지 않는다. 설정이 앞선다', () => {
    expect(graphicsMode({ TERM_PROGRAM: 'ghostty' })).toBe('kitty');
    expect(graphicsMode({ TERM: 'xterm-ghostty' })).toBe('kitty');
    expect(graphicsMode({ TERM: 'xterm-kitty' })).toBe('kitty');
    expect(graphicsMode({ TERM_PROGRAM: 'ghostty', TMUX: '/tmp/tmux-1/default,1,0' })).toBe('blocks');
    expect(graphicsMode({ TERM: 'xterm-kitty', STY: '1.pts' })).toBe('blocks');
    expect(graphicsMode({ TERM_PROGRAM: 'iTerm.app' })).toBe('blocks');
    expect(graphicsMode({ TERM_PROGRAM: 'iTerm.app' }, 'kitty')).toBe('kitty');
    expect(graphicsMode({ TERM_PROGRAM: 'ghostty' }, 'blocks')).toBe('blocks');
  });

  it('그림 보내기는 가상 배치(U=1)로 칸 크기를 주고, 응답을 끄고, 4096바이트씩 나눈다', () => {
    const small = transmitImage(7, Buffer.from('abc'), 14, 7);
    expect(small).toBe(`\x1b_Ga=T,U=1,f=100,i=7,c=14,r=7,q=2,m=0;${Buffer.from('abc').toString('base64')}\x1b\\`);
    const big = transmitImage(8, Buffer.alloc(5000, 1), 2, 1);
    const parts = big.split('\x1b\\').filter(Boolean);
    expect(parts).toHaveLength(2);
    expect(parts[0]).toMatch(/^\x1b_Ga=T,U=1,f=100,i=8,c=2,r=1,q=2,m=1;/);
    expect(parts[1]).toMatch(/^\x1b_Gm=0,q=2;/);
    expect(deleteImage(8)).toBe('\x1b_Ga=d,d=I,i=8,q=2\x1b\\');
  });

  it('placeholder 줄은 이미지 id가 글자색이고, 칸마다 줄·열 결합 문자가 붙으며, 폭은 정확히 칸 수다', () => {
    const lines = placeholderLines(0x010203, 3, 2);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.startsWith('\x1b[38;2;1;2;3m')).toBe(true);
    expect(lines[1]).toContain(PLACEHOLDER + DIACRITICS[1] + DIACRITICS[2]);
    lines.forEach((line, row) => {
      expect(stringWidth(stripAnsi(line))).toBe(3);
      // desk가 줄을 칸에 맞출 때 마지막 칸의 결합 문자를 떼지 않는다
      expect(fitAnsi(line, 3)).toContain(PLACEHOLDER + DIACRITICS[row] + DIACRITICS[2]);
    });
  });

  it('프레임마다 다른 이미지 id를 쓰고, 처음 보일 때만 보내고, 나갈 때 보낸 것을 모두 지운다', () => {
    const pixels = spriteFromRows(['a'], { a: '#ffffff' }).pixels;
    const sprite: Sprite = { width: 1, height: 1, pixels, frames: [{ pixels, delay: 100 }, { pixels, delay: 100 }] };
    const kitty = new KittyImages(100);
    expect(kitty.art(sprite, 0, 4, 2)[0]).toContain('\x1b[38;2;0;0;100m');
    expect(kitty.drain()).toContain('i=100,c=4,r=2');
    expect(kitty.art(sprite, 1, 4, 2)[0]).toContain('\x1b[38;2;0;0;101m');
    expect(kitty.drain()).toContain('i=101,');
    kitty.art(sprite, 0, 4, 2);
    expect(kitty.drain()).toBe('');
    // 크기가 바뀌면 그 크기로 새로 보낸다
    kitty.art(sprite, 0, 6, 3);
    expect(kitty.drain()).toContain('i=102,c=6,r=3');
    expect(kitty.clear()).toBe([100, 101, 102].map(deleteImage).join(''));
    expect(kitty.clear()).toBe('');
  });
});
