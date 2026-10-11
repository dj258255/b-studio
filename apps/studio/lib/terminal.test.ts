import { describe, expect, it } from 'vitest';
import { decodeTerminalData, readAgentSurface, terminalStatusLabel, writeAgentSurface } from './terminal';

describe('세션 터미널 화면의 순수 함수', () => {
  it('base64 출력을 바이트 그대로 되돌린다(제어 문자와 여러 바이트 글자)', () => {
    const bytes = Buffer.concat([Buffer.from([0x1b, 0x5b, 0x33, 0x31, 0x6d]), Buffer.from('한글', 'utf8'), Buffer.from([0xff, 0x00])]);
    expect(Buffer.from(decodeTerminalData(bytes.toString('base64')))).toEqual(bytes);
  });

  it('상태를 한 줄로 알린다. 닫힌 사유와 종료 코드를 숨기지 않는다', () => {
    expect(terminalStatusLabel({ state: 'opening' })).toBe('컨테이너를 준비하는 중');
    expect(terminalStatusLabel({ state: 'open' })).toBe('열림');
    expect(terminalStatusLabel({ state: 'closed', message: '터미널을 열지 못했습니다: 이미지가 없습니다' })).toBe('닫힘 — 터미널을 열지 못했습니다: 이미지가 없습니다');
    expect(terminalStatusLabel({ state: 'exited', code: 0 })).toBe('터미널이 끝났습니다');
    expect(terminalStatusLabel({ state: 'exited', code: 137 })).toBe('터미널이 끝났습니다 (종료 코드 137)');
  });

  it('마지막으로 고른 자리를 기억한다. 저장소를 쓰지 못해도 대화로 열린다', () => {
    const store = new Map<string, string>();
    const storage = { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) };
    expect(readAgentSurface(storage)).toBe('chat');
    writeAgentSurface(storage, 'terminal');
    expect(readAgentSurface(storage)).toBe('terminal');
    store.set('b-studio:agent-surface', '<script>');
    expect(readAgentSurface(storage)).toBe('chat');
    const broken = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(readAgentSurface(broken)).toBe('chat');
    expect(() => writeAgentSurface(broken, 'terminal')).not.toThrow();
    expect(readAgentSurface(undefined)).toBe('chat');
  });
});
