import { parse } from 'yaml';
import { describe, expect, it } from 'vitest';
import { appendPageCheckToYaml, buildPageCheckFromExploreQa } from './explore-qa-save';
import type { QaActionRecord } from './explore-qa';

function action(overrides: Partial<QaActionRecord>): QaActionRecord {
  return { index: 1, tool: 'qa_click', input: {}, ok: true, newDiagnosticsCount: 0, url: 'http://x/', at: 0, ...overrides };
}

describe('buildPageCheckFromExploreQa', () => {
  it('확인 문구가 있으면 expectText로, steps는 변환 가능한 행동만 담아 만든다', () => {
    const { check, skipped } = buildPageCheckFromExploreQa({
      service: 'web',
      goal: { goal: '검색한다', startPath: '/search', confirmText: '검색 결과' },
      actions: [
        action({ tool: 'qa_fill', input: { text: '김토스' }, stableSelector: 'role=textbox[name="검색어"]' }),
        action({ tool: 'qa_click', stableSelector: 'role=button[name="검색"]' }),
        action({ tool: 'qa_snapshot' }),
      ],
    });
    expect(check).toMatchObject({
      service: 'web',
      path: '/search',
      mode: 'browser',
      expectText: '검색 결과',
      steps: [{ fill: { selector: 'role=textbox[name="검색어"]', text: '김토스' } }, { click: 'role=button[name="검색"]' }],
      allowConsoleErrors: false,
      noHorizontalScroll: true,
    });
    expect(skipped).toEqual([{ index: 1, tool: 'qa_snapshot', reason: expect.any(String) }]);
  });

  it('steps 상한(10개)을 넘으면 zod 오류를 그대로 던진다', () => {
    const actions = Array.from({ length: 11 }, (_, index) => action({ index, tool: 'qa_press', input: { key: 'Enter' } }));
    expect(() => buildPageCheckFromExploreQa({ service: 'web', goal: { goal: 'x', startPath: '/x' }, actions })).toThrow();
  });
});

describe('appendPageCheckToYaml', () => {
  it('workflow.pageChecks가 없는 문서에 처음 하나를 만든다', () => {
    const original = `name: demo\nservices: {}\n`;
    const next = appendPageCheckToYaml(original, { service: 'web', path: '/search', mode: 'browser', expectStatus: 200, allowConsoleErrors: false, noHorizontalScroll: true });
    const parsed = parse(next) as { workflow: { pageChecks: unknown[] } };
    expect(parsed.workflow.pageChecks).toHaveLength(1);
    expect(parsed.workflow.pageChecks[0]).toMatchObject({ service: 'web', path: '/search' });
    // 원래 있던 내용은 그대로 남는다
    expect(next).toContain('name: demo');
  });

  it('이미 있는 pageChecks 뒤에 덧붙이고 기존 항목은 그대로 둔다', () => {
    const original = `workflow:\n  pageChecks:\n    - service: web\n      path: /\n      mode: http\n`;
    const next = appendPageCheckToYaml(original, { service: 'web', path: '/cart', mode: 'browser', expectStatus: 200, allowConsoleErrors: false, noHorizontalScroll: true });
    const parsed = parse(next) as { workflow: { pageChecks: Array<{ path: string }> } };
    expect(parsed.workflow.pageChecks.map((check) => check.path)).toEqual(['/', '/cart']);
  });
});
