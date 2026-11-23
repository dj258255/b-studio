import { describe, expect, it } from 'vitest';
import { matcherMatches, aggregateAnswers } from './hooks';
import { parseArgs } from './settings';

describe('parseArgs', () => {
  it('서버가 주는 꼴(--mcp-config M --settings S [--model] 요청)에서 설정·모델·첫 요청을 읽는다', () => {
    expect(parseArgs(['--mcp-config', 'm.json', '--settings', 's.json', '--model=m-1', '요청: 고쳐 주세요'])).toEqual({ settingsFile: 's.json', model: 'm-1', firstRequest: '요청: 고쳐 주세요' });
    expect(parseArgs(['--model', 'm-2', '--settings', 's.json'])).toEqual({ settingsFile: 's.json', model: 'm-2', firstRequest: undefined });
  });

  it('--mcp-config는 값을 여러 개 받는다: 다음 옵션까지 모두 값이고 요청 글로 읽지 않는다', () => {
    expect(parseArgs(['--mcp-config', 'a.json', 'b.json', '--settings', 's.json', '요청']).firstRequest).toBe('요청');
    expect(parseArgs(['--mcp-config', 'a.json', 'b.json', '--settings', 's.json']).firstRequest).toBeUndefined();
    expect(parseArgs(['--mcp-config=a.json', '요청']).firstRequest).toBe('요청');
  });
});

describe('훅 matcher·답 모으기', () => {
  it('matcher가 없거나 빈 값이나 *면 모든 도구, 아니면 이름 전체에 맞는 정규식', () => {
    expect(matcherMatches(undefined, 'Write')).toBe(true);
    expect(matcherMatches('', 'Write')).toBe(true);
    expect(matcherMatches('*', 'Write')).toBe(true);
    expect(matcherMatches('Writ', 'Write')).toBe(false);
    expect(matcherMatches('Write|Edit', 'Edit')).toBe(true);
    expect(matcherMatches('^(?!(?:Read|Glob)$).+', 'Read')).toBe(false);
    expect(matcherMatches('(', 'Write')).toBe(false);
  });

  it('첫 거절·막음, 없으면 첫 비어 있지 않은 답, 없으면 빈 객체', () => {
    expect(aggregateAnswers([{}, { a: 1 }, { decision: 'block' }])).toEqual({ decision: 'block' });
    expect(aggregateAnswers([{}, { a: 1 }, { b: 2 }])).toEqual({ a: 1 });
    expect(aggregateAnswers([{}, {}])).toEqual({});
  });
});
