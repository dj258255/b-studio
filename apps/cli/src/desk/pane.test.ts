import { describe, expect, it } from 'vitest';
import { PaneTerminal } from './pane';
import { stripAnsi } from './render';
import { stringWidth } from './screen';

describe('칸 터미널 해석', () => {
  it('받은 출력을 화면 줄로 바꾸고, 줄마다 칸 폭과 같다', async () => {
    const pane = new PaneTerminal(20, 4);
    await pane.write('hello\r\n세계 abc');
    const lines = pane.lines();
    expect(lines).toHaveLength(4);
    expect(stripAnsi(lines[0]!).trimEnd()).toBe('hello');
    expect(stripAnsi(lines[1]!).trimEnd()).toBe('세계 abc');
    for (const line of lines) expect(stringWidth(stripAnsi(line))).toBe(20);
    expect(pane.cursor()).toEqual({ x: 8, y: 1 });
    pane.dispose();
  });

  it('커서 이동·지우기 같은 제어 문자를 따라 그린다', async () => {
    const pane = new PaneTerminal(10, 3);
    await pane.write('abcdef\x1b[1;3HXY\x1b[2;1H\x1b[2Kz');
    expect(pane.lines().map((line) => stripAnsi(line).trimEnd())).toEqual(['abXYef', 'z', '']);
    pane.dispose();
  });

  it('색과 굵게를 SGR로 옮기고 줄 끝에서 되돌린다', async () => {
    const pane = new PaneTerminal(10, 1);
    await pane.write('\x1b[1;31mR\x1b[0mn');
    const line = pane.lines()[0]!;
    expect(line).toMatch(/\x1b\[[0-9;]*1[;m]/);
    expect(line).toContain('31');
    expect(line.endsWith('\x1b[0m')).toBe(true);
    pane.dispose();
  });

  it('크기를 바꾸면 줄 수와 폭이 따라간다', async () => {
    const pane = new PaneTerminal(10, 2);
    await pane.write('x');
    pane.resize(6, 3);
    const lines = pane.lines();
    expect(lines).toHaveLength(3);
    for (const line of lines) expect(stringWidth(stripAnsi(line))).toBe(6);
    pane.dispose();
  });

  it('처음부터 다시 받으면(restart) 앞 내용이 남지 않는다', async () => {
    const pane = new PaneTerminal(10, 2);
    await pane.write('old');
    pane.restart();
    await pane.write('new');
    expect(stripAnsi(pane.lines()[0]!).trimEnd()).toBe('new');
    pane.dispose();
  });

  it('프로그램이 묻는 질의(커서 위치)에 대한 응답을 알려 준다', async () => {
    const pane = new PaneTerminal(10, 2);
    const answers: string[] = [];
    pane.onResponse((data) => answers.push(data));
    await pane.write('ab\x1b[6n');
    expect(answers.join('')).toBe('\x1b[1;3R');
    pane.dispose();
  });

  it('이모지는 2칸, 풀어쓴(NFD) 한글은 모아 2칸으로 센다(#860)', async () => {
    const pane = new PaneTerminal(20, 2);
    await pane.write(`a😀b🚀c|\r\n${'한글'.normalize('NFD')}|`);
    const [first, second] = pane.lines().map(stripAnsi);
    expect(first!.trimEnd()).toBe('a😀b🚀c|');
    expect(second!.normalize('NFC').trimEnd()).toBe('한글|');
    expect(pane.cursor()).toEqual({ x: 5, y: 1 });
    pane.dispose();
  });

  it('CLI가 켠 모드(bracketed paste, 응용 커서 키, 커서 숨김)를 알려 준다(#860)', async () => {
    const pane = new PaneTerminal(10, 2);
    expect(pane.modes()).toEqual({ bracketedPaste: false, appCursor: false, cursorHidden: false, mouse: false, mouseMotion: false, sgrMouse: false });
    await pane.write('\x1b[?2004h\x1b[?1h\x1b[?25l');
    expect(pane.modes()).toEqual({ bracketedPaste: true, appCursor: true, cursorHidden: true, mouse: false, mouseMotion: false, sgrMouse: false });
    await pane.write('\x1b[?25h');
    expect(pane.modes().cursorHidden).toBe(false);
    await pane.write('\x1b[?25l');
    pane.restart();
    await pane.write('');
    expect(pane.modes()).toEqual({ bracketedPaste: false, appCursor: false, cursorHidden: false, mouse: false, mouseMotion: false, sgrMouse: false });
    pane.dispose();
  });
});

describe('칸 복사 모드(#863)', () => {
  const numbered = (count: number) => Array.from({ length: count }, (_, index) => `line ${index}`).join('\r\n');

  it('지난 줄을 수천 줄 기억하고, 복사 모드에서 맨 위까지 올려 본다', async () => {
    const pane = new PaneTerminal(20, 4);
    await pane.write(numbered(3000));
    expect(stripAnsi(pane.lines()[3]!).trimEnd()).toBe('line 2999');
    pane.enterCopy();
    pane.copyTop();
    expect(stripAnsi(pane.lines()[0]!).trimEnd()).toBe('line 0');
    expect(pane.copyStatus()).toEqual({ line: 1, total: 3000 });
    pane.dispose();
  });

  it('복사 모드 중에 새 출력이 와도 보던 자리를 지키고, 나가면 맨 아래 지금 화면으로 돌아온다', async () => {
    const pane = new PaneTerminal(20, 3);
    await pane.write(numbered(10));
    pane.enterCopy();
    pane.copyMove(-5);
    const before = pane.lines().map((line) => stripAnsi(line).trimEnd());
    await pane.write('\r\nnew 1\r\nnew 2');
    expect(pane.lines().map((line) => stripAnsi(line).trimEnd())).toEqual(before);
    pane.exitCopy();
    expect(stripAnsi(pane.lines()[2]!).trimEnd()).toBe('new 2');
    pane.dispose();
  });

  it('v로 시작한 자리부터 지금 줄까지를 글로 꺼낸다', async () => {
    const pane = new PaneTerminal(20, 3);
    await pane.write(numbered(10));
    pane.enterCopy();
    pane.copyMove(-1);
    pane.copyMark();
    pane.copyMove(-2);
    expect(pane.copyYank()).toBe('line 6\nline 7\nline 8');
    pane.dispose();
  });

  it('찾을 글이 있는 위쪽 줄로 가고, 없으면 그대로 있다', async () => {
    const pane = new PaneTerminal(20, 3);
    await pane.write(['alpha', 'beta', 'gamma', 'BETA two', 'delta', 'eps'].join('\r\n'));
    pane.enterCopy();
    expect(pane.copySearch('beta')).toBe(true);
    expect(pane.copyStatus().line).toBe(4);
    expect(pane.copySearch()).toBe(true);
    expect(pane.copyStatus().line).toBe(2);
    expect(pane.copySearch('zzz')).toBe(false);
    expect(pane.copyStatus().line).toBe(2);
    pane.dispose();
  });

  it('다시 받기 표지(restart)를 쓰기 줄 순서대로 처리해, 그 앞에 쌓인 옛 출력이 뒤에 섞이지 않는다', async () => {
    const pane = new PaneTerminal(20, 3);
    void pane.write('old output');
    pane.restart();
    await pane.write('fresh');
    expect(pane.lines().map((line) => stripAnsi(line).trimEnd())).toEqual(['fresh', '', '']);
    pane.dispose();
  });
});

describe('256색 터미널(#874)', () => {
  it('24비트 색을 256색 근사로 낮춰 그린다', async () => {
    const pane = new PaneTerminal(10, 1, { truecolor: false });
    await pane.write('\x1b[38;2;255;0;0mR\x1b[48;2;128;128;128mG');
    const line = pane.lines()[0]!;
    expect(line).not.toContain('38;2;');
    expect(line).not.toContain('48;2;');
    expect(line).toContain('38;5;196');
    expect(line).toContain('48;5;244');
    pane.dispose();
  });

  it('기본은 24비트 색을 그대로 옮긴다', async () => {
    const pane = new PaneTerminal(10, 1);
    await pane.write('\x1b[38;2;255;0;0mR');
    expect(pane.lines()[0]).toContain('38;2;255;0;0');
    pane.dispose();
  });

  it('안쪽 CLI가 켠 마우스 모드와 SGR 꼴을 따라간다', async () => {
    const pane = new PaneTerminal(10, 2);
    expect(pane.modes().mouse).toBe(false);
    await pane.write('\x1b[?1000h\x1b[?1006h');
    expect(pane.modes()).toMatchObject({ mouse: true, sgrMouse: true });
    await pane.write('\x1b[?1006l\x1b[?1000l');
    expect(pane.modes()).toMatchObject({ mouse: false, sgrMouse: false });
    pane.dispose();
  });

  it('CLI가 움직임 추적(1002·1003)을 켰을 때만 mouseMotion이 켜진다', async () => {
    const pane = new PaneTerminal(10, 2);
    await pane.write('\x1b[?1000h');
    expect(pane.modes()).toMatchObject({ mouse: true, mouseMotion: false });
    await pane.write('\x1b[?1002h');
    expect(pane.modes()).toMatchObject({ mouse: true, mouseMotion: true });
    await pane.write('\x1b[?1002l\x1b[?1003h');
    expect(pane.modes().mouseMotion).toBe(true);
    await pane.write('\x1b[?1003l');
    expect(pane.modes()).toMatchObject({ mouse: false, mouseMotion: false });
    pane.dispose();
  });
});

describe('칸 안에서 마우스로 글 고르기', () => {
  it('한 줄: 시작과 끝 칸(끝 포함)의 글을 꺼낸다', async () => {
    const pane = new PaneTerminal(20, 3);
    await pane.write('hello world');
    pane.selectBegin(2, 0);
    pane.selectTo(7, 0);
    expect(pane.hasSelection).toBe(true);
    expect(pane.selectedText()).toBe('llo wo');
    // 거꾸로 끌어도 같다
    pane.selectBegin(7, 0);
    pane.selectTo(2, 0);
    expect(pane.selectedText()).toBe('llo wo');
    pane.dispose();
  });

  it('시작과 같은 칸에서 끝나면 고른 것이 없다', async () => {
    const pane = new PaneTerminal(20, 3);
    await pane.write('hello');
    pane.selectBegin(2, 0);
    expect(pane.hasSelection).toBe(false);
    pane.selectTo(2, 0);
    expect(pane.hasSelection).toBe(false);
    expect(pane.selectedText()).toBe('');
    pane.dispose();
  });

  it('여러 줄: 첫 줄은 시작 칸부터, 끝 줄은 끝 칸까지, 줄 끝 빈칸은 뺀다', async () => {
    const pane = new PaneTerminal(20, 4);
    await pane.write('first line   \r\nsecond\r\nthird line');
    pane.selectBegin(6, 0);
    pane.selectTo(4, 2);
    expect(pane.selectedText()).toBe('line\nsecond\nthird');
    pane.dispose();
  });

  it('두 칸 글자(한글·이모지)는 한 번만 꺼낸다', async () => {
    const pane = new PaneTerminal(20, 2);
    await pane.write('가나다 😀 x');
    pane.selectBegin(0, 0);
    pane.selectTo(11, 0);
    expect(pane.selectedText()).toBe('가나다 😀 x');
    // 뒷칸에서 시작해도 앞칸 글자를 포함한다
    pane.selectBegin(1, 0);
    pane.selectTo(3, 0);
    expect(pane.selectedText()).toBe('가나');
    pane.dispose();
  });

  it('줄바꿈으로 이어진 줄(isWrapped)은 줄바꿈 없이 잇는다', async () => {
    const pane = new PaneTerminal(10, 4);
    await pane.write('abcdefghijklmno\r\nxyz');
    pane.selectBegin(0, 0);
    pane.selectTo(2, 2);
    expect(pane.selectedText()).toBe('abcdefghijklmno\nxyz');
    pane.dispose();
  });

  it('고른 범위는 그릴 때 반전으로 보인다', async () => {
    const pane = new PaneTerminal(10, 2);
    await pane.write('abcdef');
    pane.selectBegin(1, 0);
    pane.selectTo(3, 0);
    const line = pane.lines()[0]!;
    expect(line).toContain('\x1b[0;7mbcd');
    expect(stripAnsi(line).trimEnd()).toBe('abcdef');
    pane.clearSelection();
    expect(pane.lines()[0]).not.toContain(';7m');
    expect(pane.hasSelection).toBe(false);
    pane.dispose();
  });

  it('새 출력으로 화면이 밀려도 고른 글은 그대로이고, 반전은 글을 따라간다', async () => {
    const pane = new PaneTerminal(10, 3);
    await pane.write('one\r\ntwo\r\nthree');
    pane.selectBegin(0, 1);
    pane.selectTo(2, 1);
    await pane.write('\r\nfour');
    expect(pane.selectedText()).toBe('two');
    expect(pane.lines().map((line) => stripAnsi(line).trimEnd())).toEqual(['two', 'three', 'four']);
    expect(pane.lines().map((line) => line.includes(';7m'))).toEqual([true, false, false]);
    await pane.write('\r\nfive');
    // 고른 줄이 위로 밀려 보이지 않아도 글은 그대로다
    expect(pane.selectedText()).toBe('two');
    expect(pane.lines().map((line) => line.includes(';7m'))).toEqual([false, false, false]);
    pane.dispose();
  });

  it('단어 고르기: 공백과 구분자로 자르고 경로(/ . - _)는 한 단어다', async () => {
    const pane = new PaneTerminal(40, 2);
    await pane.write('open (apps/cli/src/desk-pane_x.ts), now');
    expect(pane.selectWord(8, 0)).toBe(true);
    expect(pane.selectedText()).toBe('apps/cli/src/desk-pane_x.ts');
    expect(pane.selectWord(1, 0)).toBe(true);
    expect(pane.selectedText()).toBe('open');
    // 공백이나 구분자를 누르면 고르지 않는다
    expect(pane.selectWord(4, 0)).toBe(false);
    expect(pane.selectWord(5, 0)).toBe(false);
    expect(pane.hasSelection).toBe(false);
    pane.dispose();
  });

  it('단어 고르기는 한글 단어도 한 번만 꺼낸다', async () => {
    const pane = new PaneTerminal(20, 2);
    await pane.write('에이전트 출력 확인');
    expect(pane.selectWord(2, 0)).toBe(true);
    expect(pane.selectedText()).toBe('에이전트');
    pane.dispose();
  });

  it('복사 모드에 들어가면 고른 것을 푼다', async () => {
    const pane = new PaneTerminal(10, 2);
    await pane.write('abcdef');
    pane.selectBegin(0, 0);
    pane.selectTo(2, 0);
    pane.enterCopy();
    expect(pane.hasSelection).toBe(false);
    pane.dispose();
  });

  it('대체 화면(마우스를 요청하지 않는 전체 화면 프로그램)에서도 던지지 않고 고르고, 화면이 바뀌면 푼다', async () => {
    const pane = new PaneTerminal(12, 3);
    await pane.write('main line');
    await pane.write('\x1b[?1049h\x1b[Halt one\r\nalt two');
    expect(() => pane.selectBegin(0, 0)).not.toThrow();
    pane.selectTo(6, 1);
    expect(pane.selectedText()).toBe('alt one\nalt two');
    expect(pane.selectWord(1, 1)).toBe(true);
    expect(pane.selectedText()).toBe('alt');
    await pane.write('\x1b[?1049l');
    expect(pane.hasSelection).toBe(false);
    pane.dispose();
  });
});
