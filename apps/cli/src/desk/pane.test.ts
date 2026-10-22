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

  it('처음부터 다시 받으면(reset) 앞 내용이 남지 않는다', async () => {
    const pane = new PaneTerminal(10, 2);
    await pane.write('old');
    pane.reset();
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
});
