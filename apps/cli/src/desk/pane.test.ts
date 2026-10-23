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
    expect(pane.modes()).toEqual({ bracketedPaste: false, appCursor: false, cursorHidden: false });
    await pane.write('\x1b[?2004h\x1b[?1h\x1b[?25l');
    expect(pane.modes()).toEqual({ bracketedPaste: true, appCursor: true, cursorHidden: true });
    await pane.write('\x1b[?25h');
    expect(pane.modes().cursorHidden).toBe(false);
    await pane.write('\x1b[?25l');
    pane.restart();
    await pane.write('');
    expect(pane.modes()).toEqual({ bracketedPaste: false, appCursor: false, cursorHidden: false });
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
