import { describe, expect, it } from 'vitest';
import { CODEX_CONTEXT_LIMIT, codexContextBlock, rememberCodexRun, type CodexRunSummary } from './codex-context';

function entry(n: number, overrides: Partial<CodexRunSummary> = {}): CodexRunSummary {
  return { request: `r${n}`, summary: `s${n}`, status: 'done', ...overrides };
}

describe('codexContextBlock', () => {
  it('기록이 없으면 빈 문자열이라 붙이지 않는다', () => {
    expect(codexContextBlock([])).toBe('');
  });

  it('요청은 앞 200자, 결과는 앞 300자만 넣는다', () => {
    const block = codexContextBlock([entry(1, { request: 'a'.repeat(500), summary: 'b'.repeat(500) })]);
    expect(block).toContain(`- ${'a'.repeat(200)}… → done: ${'b'.repeat(300)}…`);
    expect(block.length).toBeLessThan(600);
  });

  it('최근 3개만 넣는다', () => {
    const block = codexContextBlock([entry(1), entry(2), entry(3), entry(4)]);
    expect(block).not.toContain('r1');
    for (const n of [2, 3, 4]) expect(block).toContain(`r${n}`);
  });

  it('상한을 넘으면 오래된 것부터 뺀다', () => {
    const recent = [entry(1, { summary: 's'.repeat(300) }), entry(2, { summary: 's'.repeat(300) }), entry(3, { summary: 's'.repeat(300) })];
    const block = codexContextBlock(recent, 120);
    expect(block.length).toBeLessThanOrEqual(120);
    // 가장 최근 것이 남고 가장 오래된 것이 빠진다
    expect(block).toContain('r3');
    expect(block).not.toContain('r1');
  });

  it('요청 3개가 최대 길이여도 상한을 넘지 않는다', () => {
    const recent = [1, 2, 3].map((n) => entry(n, { request: 'a'.repeat(500), summary: 'b'.repeat(500) }));
    expect(codexContextBlock(recent).length).toBeLessThanOrEqual(CODEX_CONTEXT_LIMIT);
  });
});

describe('rememberCodexRun', () => {
  it('최근 3개만 남긴다', () => {
    let recent: CodexRunSummary[] = [];
    for (const n of [1, 2, 3, 4, 5]) recent = rememberCodexRun(recent, entry(n));
    expect(recent.map((item) => item.request)).toEqual(['r3', 'r4', 'r5']);
  });

  it('넘겨받은 배열을 바꾸지 않는다', () => {
    const before: CodexRunSummary[] = [entry(1)];
    const after = rememberCodexRun(before, entry(2));
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(2);
  });
});
