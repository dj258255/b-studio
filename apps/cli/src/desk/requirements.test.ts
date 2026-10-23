/**
 * 요구사항·문서 화면(#894): 상태와 키로 다음 상태·할 일을 내는 순수 함수, 마크다운 그리기, 화면 폭
 */
import { describe, expect, it } from 'vitest';
import {
  markdownLines,
  openRequirements,
  renderRequirements,
  REQUIREMENTS_FILE,
  REQUIREMENTS_TEMPLATE,
  requirementsHint,
  requirementsKey,
  requirementsPaste,
  type RequirementsEffect,
  type RequirementsState,
} from './requirements';
import { stringWidth, stripAnsi } from './screen';
import { DEFAULT_THEME } from './theme';
import type { DeskRequirement, DeskRequirements, DeskTests } from './types';

const theme = DEFAULT_THEME;

const requirement = (id: string, patch: Partial<DeskRequirement> = {}): DeskRequirement => ({
  id,
  title: `요구사항 ${id}`,
  kind: 'api',
  priority: 'must',
  acceptance: [`${id}을 부르면 200으로 답한다`],
  status: '미착수',
  workPrefill: `[${id}] 작업해 줘`,
  ...patch,
});

const spec: DeskRequirements = {
  exists: true,
  requirements: [requirement('R1', { status: '검증됨', verifiedBy: 'test' }), requirement('R2', { status: '작업 중', manualVerification: { by: '범수', at: '2026-10-23', sha: 'c57d72f', note: '손으로 확인' } })],
  coverage: { text: '2개 중 1개 검증됨', mustGapText: '필수(must) 요구사항 1개 미검증' },
  allMustHavesPrefill: '필수 요구사항 전체 계획을 세워 줘',
  assumptions: ['하루 1만 건'],
  manualSteps: [],
};

const tests: DeskTests = {
  services: [
    {
      service: 'api',
      running: false,
      supported: true,
      runner: 'Vitest',
      counts: { pass: 1, fail: 1, skip: 0, notRun: 0 },
      rows: [
        { file: 'a.test.ts', name: 'passes', displayName: '통과하는 테스트', line: 3, requirementIds: ['R1'], status: 'pass' },
        { file: 'a.test.ts', name: 'fails', displayName: '실패하는 테스트', line: 9, requirementIds: ['R2'], status: 'fail', failureMessage: 'expected 200', fixPrefill: '이 테스트 고쳐 줘' },
      ],
    },
  ],
  requirementsWithoutTests: [{ id: 'R3', title: '테스트 없는 것', prefill: 'R3 테스트 더해 줘' }],
};

function opened(patch: Partial<RequirementsState> = {}): RequirementsState {
  return { ...openRequirements({ sessionId: 's1', title: '주문 모듈' }).state, spec, ...patch };
}

function press(state: RequirementsState, ...keys: string[]): { state: RequirementsState | undefined; effects: RequirementsEffect[] } {
  let current: RequirementsState | undefined = state;
  const effects: RequirementsEffect[] = [];
  for (const key of keys) {
    if (!current) break;
    const result = requirementsKey(current, key);
    current = result.state;
    effects.push(...result.effects);
  }
  return { state: current, effects };
}

describe('열기와 탭', () => {
  it('열면 명세 탭이고 요구사항을 읽으라고 한다', () => {
    const { state, effects } = openRequirements({ sessionId: 's1', title: '주문 모듈' });
    expect(state.tab).toBe('spec');
    expect(effects).toEqual([{ type: 'load', tab: 'spec' }]);
  });

  it('Tab으로 탭을 돌고, 아직 받지 않은 탭만 한 번 읽는다', () => {
    const first = press(opened(), '\t');
    expect(first.state?.tab).toBe('tests');
    expect(first.effects).toEqual([{ type: 'load', tab: 'tests' }]);
    // 읽는 중이면 다시 읽으라고 하지 않는다
    const again = press({ ...first.state!, tab: 'spec' }, '\t');
    expect(again.effects).toEqual([]);
    const back = press(opened(), '\x1b[Z');
    expect(back.state?.tab).toBe('status');
    const numbered = press(opened(), '3');
    expect(numbered.state?.tab).toBe('docs');
    expect(numbered.effects).toEqual([{ type: 'load', tab: 'docs' }]);
  });

  it('r은 지금 탭을 다시 읽고, Esc·q는 닫는다', () => {
    expect(press(opened(), 'r').effects).toEqual([{ type: 'load', tab: 'spec' }]);
    expect(press(opened(), '\x1b').state).toBeUndefined();
    expect(press(opened(), 'q').state).toBeUndefined();
  });
});

describe('명세 탭', () => {
  it('Enter는 고른 요구사항의 작업 글을, a는 필수 전체 계획 글을 CLI에 넣게 한다', () => {
    expect(press(opened(), 'j', '\r').effects).toEqual([{ type: 'work', text: '[R2] 작업해 줘' }]);
    expect(press(opened(), 'a').effects).toEqual([{ type: 'work', text: '필수 요구사항 전체 계획을 세워 줘' }]);
    const none = press(opened({ spec: { ...spec, allMustHavesPrefill: undefined } }), 'a');
    expect(none.effects).toEqual([]);
    expect(none.state?.note).toContain('필수');
  });

  it('↑↓는 목록 끝에서 멈춘다', () => {
    expect(press(opened(), 'j', 'j', 'j').state?.row).toBe(1);
    expect(press(opened(), 'k').state?.row).toBe(0);
  });

  it('e는 docs/requirements.md를 편집기로 연다', () => {
    expect(press(opened(), 'e').effects).toEqual([{ type: 'edit', path: REQUIREMENTS_FILE }]);
    expect(REQUIREMENTS_TEMPLATE).toMatch(/^## R1\. /m);
    expect(REQUIREMENTS_TEMPLATE).toMatch(/^- 종류: \S+ · 우선순위: must$/m);
  });

  it('v로 사람 확인 메모를 쓰고 Enter로 남긴다. 빈 메모는 보내지 않는다', () => {
    let result = press(opened(), 'v');
    expect(result.state?.verify).toEqual({ requirementId: 'R1', text: '' });
    result = press(result.state!, '\r');
    expect(result.effects).toEqual([]);
    expect(result.state?.verify?.error).toContain('무엇을');
    result = press(result.state!, '손', '으', '로', ' ', '눌', '러', ' ', '봄', '\x7f', '봤', '음');
    expect(result.state?.verify?.text).toBe('손으로 눌러 봤음');
    const pasted = requirementsPaste(result.state!, '\n줄\r\n바꿈');
    expect(pasted.verify?.text).toBe('손으로 눌러 봤음 줄 바꿈');
    const sent = press(pasted, '\r');
    expect(sent.effects).toEqual([{ type: 'verify', requirementId: 'R1', note: '손으로 눌러 봤음 줄 바꿈' }]);
    expect(sent.state?.verify).toBeUndefined();
    // Esc는 메모만 그만둔다
    expect(press(opened(), 'v', 'x', '\x1b').state).toMatchObject({ verify: undefined, tab: 'spec' });
  });

  it('V는 사람 확인이 있는 요구사항에서만 한 번 물은 뒤 지운다', () => {
    expect(press(opened(), 'V').state?.confirm).toBeUndefined();
    const asked = press(opened(), 'j', 'V');
    expect(asked.state?.confirm).toEqual({ kind: 'unverify', requirementId: 'R2' });
    expect(press(asked.state!, 'n').effects).toEqual([]);
    expect(press(asked.state!, 'y').effects).toEqual([{ type: 'unverify', requirementId: 'R2' }]);
  });

  it('추출 결과가 있으면 d로 보고 s로 물은 뒤 저장한다', () => {
    const withDraft = opened({ spec: { ...spec, draft: { requirements: [{ id: 'R1', title: '새 요구사항', kind: 'api', priority: 'must', acceptance: ['된다'] }], assumptions: [], manualSteps: [] } } });
    expect(press(opened(), 'd').state?.draft).toBeFalsy();
    const viewing = press(withDraft, 'd');
    expect(viewing.state?.draft).toBe(true);
    const asked = press(viewing.state!, 's');
    expect(asked.state?.confirm).toEqual({ kind: 'apply-draft' });
    expect(press(asked.state!, 'y').effects).toEqual([{ type: 'apply-draft' }]);
    expect(press(viewing.state!, '\x1b').state?.draft).toBe(false);
  });
});

describe('테스트 탭', () => {
  it('실패한 테스트에서 Enter는 고치기 글을, 테스트 없는 요구사항에서는 테스트 더하기 글을 넣게 한다', () => {
    const state = opened({ tab: 'tests', tests });
    // 실패가 먼저 온다
    expect(press(state, '\r').effects).toEqual([{ type: 'work', text: '이 테스트 고쳐 줘' }]);
    const passing = press(state, 'j', '\r');
    expect(passing.effects).toEqual([]);
    expect(press(state, 'j', 'j', '\r').effects).toEqual([{ type: 'work', text: 'R3 테스트 더해 줘' }]);
  });
});

describe('문서 탭과 읽기', () => {
  const docs = [
    { path: 'README.md', title: '쇼핑몰' },
    { path: 'docs/requirements.md', title: '요구사항' },
  ];

  it('Enter는 문서를 열고, e는 고른 문서를 편집기로 연다', () => {
    const state = opened({ tab: 'docs', docs });
    const open = press(state, 'j', '\r');
    expect(open.effects).toEqual([{ type: 'doc', path: 'docs/requirements.md' }]);
    expect(open.state?.reader).toMatchObject({ path: 'docs/requirements.md', scroll: 0 });
    expect(press(state, 'e').effects).toEqual([{ type: 'edit', path: 'README.md' }]);
    expect(press(open.state!, 'e').effects).toEqual([{ type: 'edit', path: 'docs/requirements.md' }]);
  });

  it('읽는 중에는 ↑↓ PgDn g G로 내리고 Esc로 목록에 돌아간다', () => {
    const content = Array.from({ length: 100 }, (_, index) => `줄 ${index}`).join('\n');
    const reading = opened({ tab: 'docs', docs, reader: { path: 'README.md', content, scroll: 0 } });
    expect(press(reading, 'j', 'j').state?.reader?.scroll).toBe(2);
    expect(press(reading, 'k').state?.reader?.scroll).toBe(0);
    expect(press(reading, '\x1b[6~').state?.reader?.scroll).toBeGreaterThan(5);
    expect(press(reading, 'G').state?.reader?.scroll).toBeGreaterThan(50);
    expect(press(reading, 'G', 'g').state?.reader?.scroll).toBe(0);
    const back = press(reading, '\x1b');
    expect(back.state?.reader).toBeUndefined();
    expect(back.state?.tab).toBe('docs');
  });
});

describe('마크다운', () => {
  it('제목·목록·인용·굵게·코드·링크를 터미널 글로 바꾼다', () => {
    const text = ['# 쇼핑몰', '', '- **주문**을 받는다', '1. `npm test`를 돌린다', '> 메모', '[문서](https://example.com)', '```ts', '  const a = 1;', '```'].join('\n');
    const lines = markdownLines(text, 40, theme).map((line) => stripAnsi(line).trimEnd());
    expect(lines[0]).toBe('쇼핑몰');
    expect(lines).toContain('• 주문을 받는다');
    expect(lines).toContain('1. npm test를 돌린다');
    expect(lines).toContain('│ 메모');
    expect(lines).toContain('문서 (https://example.com)');
    // 코드 블록은 들여쓰기를 그대로 둔다
    expect(lines.some((line) => line.includes('  const a = 1;'))).toBe(true);
    expect(lines.some((line) => line.includes('```'))).toBe(false);
  });

  it('표는 구분 줄을 빼고 칸을 맞춘다', () => {
    const lines = markdownLines(['| 이름 | 값 |', '|---|---|', '| 주문 | 12 |'].join('\n'), 40, theme).map((line) => stripAnsi(line).trimEnd());
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^이름\s+값$/);
    expect(lines[1]).toMatch(/^주문\s+12$/);
    expect(lines[0]!.indexOf('값')).toBe(lines[1]!.indexOf('12'));
  });

  it('긴 줄은 넓은 글자를 세어 폭 안에서 접는다', () => {
    const lines = markdownLines('가나다라마바사아자차카타파하 '.repeat(5), 20, theme);
    expect(lines.length).toBeGreaterThan(3);
    for (const line of lines) expect(stringWidth(stripAnsi(line))).toBeLessThanOrEqual(20);
  });
});

describe('그리기', () => {
  const size = { w: 100, h: 24 };
  const widthOf = (lines: string[]) => lines.map((line) => stringWidth(stripAnsi(line)));

  it('명세 탭은 탭 이름, 검증 요약, 요구사항 상태와 고른 것의 인수 조건을 보인다', () => {
    const { lines } = renderRequirements(opened(), size, theme);
    expect(lines).toHaveLength(size.h);
    expect(new Set(widthOf(lines))).toEqual(new Set([size.w]));
    const text = lines.map(stripAnsi).join('\n');
    for (const label of ['명세', '테스트', '문서', '현황', '주문 모듈', '2개 중 1개 검증됨', 'R1', '검증됨', 'R2', '작업 중', 'R1을 부르면 200으로 답한다']) expect(text).toContain(label);
  });

  it('메모를 쓰는 중에는 입력 칸과 커서를 보인다', () => {
    const { lines, cursor } = renderRequirements(press(opened(), 'v', '확', '인').state!, size, theme);
    expect(lines.map(stripAnsi).join('\n')).toContain('확인');
    expect(cursor).toBeDefined();
  });

  it('테스트·문서 읽기·현황 탭도 폭을 지킨다', () => {
    const states: RequirementsState[] = [
      opened({ tab: 'tests', tests }),
      opened({ tab: 'docs', docs: [{ path: 'README.md', title: '쇼핑몰' }], reader: { path: 'README.md', content: '# 제목\n\n본문 '.repeat(30), scroll: 0 } }),
      opened({
        tab: 'status',
        status: {
          currentWork: { summary: '요청을 처리하는 중입니다', items: [] },
          purpose: { items: [{ id: 'R1', title: '주문' }] },
          eta: { hasEstimate: false, summary: '추정 없음' },
          deliverables: { checkpoints: [{ shortSha: 'abc1234', message: '주문 API', createdAt: '2026-10-23T00:00:00Z' }] },
          risks: { items: ['must 1개 미검증'] },
          verification: { summary: '1개 검증됨', byStatus: { 검증됨: 1 } },
          estimateVsActual: [],
          links: { roadmap: 'docs/ROADMAP.md', changelog: 'CHANGELOG.md', docsIndex: 'docs/README.md' },
        },
      }),
    ];
    for (const state of states) {
      const { lines } = renderRequirements(state, size, theme);
      expect(new Set(widthOf(lines))).toEqual(new Set([size.w]));
    }
    expect(renderRequirements(states[0]!, size, theme).lines.map(stripAnsi).join('\n')).toContain('실패하는 테스트');
    expect(renderRequirements(states[2]!, size, theme).lines.map(stripAnsi).join('\n')).toContain('abc1234');
  });

  it('아래 줄 안내는 탭과 상태에 맞는다', () => {
    expect(requirementsHint(opened())).toContain('Enter 이 요구사항으로 작업');
    expect(requirementsHint(opened({ tab: 'docs', docs: [] }))).toContain('Enter 읽기');
    expect(requirementsHint(press(opened(), 'v').state!)).toContain('Enter 남기기');
  });
});
