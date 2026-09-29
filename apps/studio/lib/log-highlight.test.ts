import { describe, expect, it } from 'vitest';
import { classifyLine, highlightLogLine, stripAnsi } from './log-highlight';

const ESC = '\x1b';

describe('classifyLine', () => {
  it('b-studio 플랫폼 줄을 가장 먼저 알아본다', () => {
    expect(classifyLine('[b-studio] 샌드박스를 켭니다')).toBe('platform');
  });

  it('스택 트레이스(at 로 시작)와 에러 낱말을 fail로 본다', () => {
    expect(classifyLine('at Object.<anonymous> (index.js:1:1)')).toBe('fail');
    expect(classifyLine('\tat Object.<anonymous> (index.js:1:1)')).toBe('fail');
    expect(classifyLine('Error: 알 수 없는 오류')).toBe('fail');
    expect(classifyLine('Unhandled Exception in worker')).toBe('fail');
    expect(classifyLine('build FAILED')).toBe('fail');
  });

  it('경고는 줄 전체가 wait. INFO·DEBUG 줄은 줄 전체를 흐리게 하지 않고 그 단어만 흐리게 한다', () => {
    expect(classifyLine('WARN deprecated option used')).toBe('wait');
    expect(classifyLine('INFO server started')).toBeUndefined();
    expect(classifyLine('DEBUG cache miss')).toBeUndefined();
    expect(highlightLogLine('INFO server started')).toEqual([{ content: 'INFO', tone: 'muted' }, { content: ' server started' }]);
  });

  it('들여쓴 스택 트레이스와 Caused by 줄도 fail로 본다(Java·Node)', () => {
    expect(classifyLine('    at com.example.api.OrderController.get(OrderController.java:42)')).toBe('fail');
    expect(classifyLine('Caused by: java.lang.IllegalStateException: boom')).toBe('fail');
    expect(classifyLine('\t... 12 more')).toBe('fail');
  });

  it('아무 것도 아니면 undefined', () => {
    expect(classifyLine('그냥 평범한 한 줄')).toBeUndefined();
  });
});

describe('stripAnsi', () => {
  it('색 이스케이프 코드를 지운다', () => {
    expect(stripAnsi(`${ESC}[31mred${ESC}[0m plain`)).toBe('red plain');
  });

  it('이스케이프가 없으면 그대로 돌려준다', () => {
    expect(stripAnsi('plain text')).toBe('plain text');
  });
});

describe('highlightLogLine', () => {
  it('타임스탬프를 muted로, 나머지는 줄 톤 없이 나눈다', () => {
    const tokens = highlightLogLine('2024-01-01T12:00:00.123Z server ready');
    expect(tokens[0]).toEqual({ content: '2024-01-01T12:00:00.123Z', tone: 'muted' });
    expect(tokens[1]).toEqual({ content: ' server ready' });
    expect(tokens.map((token) => token.content).join('')).toBe('2024-01-01T12:00:00.123Z server ready');
  });

  it('2xx는 pass, 4xx/5xx는 fail로 상태 코드를 강조한다', () => {
    const ok = highlightLogLine('GET /api/health 200 12ms');
    expect(ok.find((token) => token.content === '200')).toEqual({ content: '200', tone: 'pass' });

    const notFound = highlightLogLine('GET /missing 404 3ms');
    expect(notFound.find((token) => token.content === '404')).toEqual({ content: '404', tone: 'fail' });

    const serverError = highlightLogLine('POST /webhook 502 9ms');
    expect(serverError.find((token) => token.content === '502')).toEqual({ content: '502', tone: 'fail' });
  });

  it('에러 줄은 전체가 fail 톤이고, 그 안의 상태 코드는 여전히 정확한 톤을 유지한다', () => {
    const tokens = highlightLogLine('Error: request to /x failed with 500');
    expect(tokens.every((token) => token.tone === 'fail')).toBe(true);
  });

  it('b-studio 플랫폼 줄은 platform 톤', () => {
    const tokens = highlightLogLine('[b-studio] 체크포인트를 만들었습니다');
    expect(tokens[0]!.tone).toBe('platform');
  });

  it('ANSI 색은 줄 톤이 없을 때만 바탕으로 쓰인다', () => {
    const tokens = highlightLogLine(`${ESC}[31mplain red text${ESC}[0m`);
    expect(tokens).toEqual([{ content: 'plain red text', tone: 'fail' }]);
  });

  it('빈 줄은 빈 조각 하나를 돌려준다', () => {
    expect(highlightLogLine('')).toEqual([{ content: '' }]);
  });

  it('1,000줄을 빠르게 처리한다', () => {
    const lines = Array.from({ length: 1000 }, (_, index) => `2024-01-01T00:00:00.000Z INFO request ${index} finished with 200 in 12ms`);
    const start = performance.now();
    for (const line of lines) highlightLogLine(line);
    expect(performance.now() - start).toBeLessThan(200);
  });
});
