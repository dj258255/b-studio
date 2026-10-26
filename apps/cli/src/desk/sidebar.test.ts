import { describe, expect, it } from 'vitest';
import { stringWidth, stripAnsi } from './screen';
import { agentStatus, byUrgency, compactTokens, deskSessions, deskSpaces, detailLines, gateStatus, keepOrder, sessionTag, shortElapsed, sidebarRows, urgencyRank } from './sidebar';
import type { DeskItem } from './types';

const base: DeskItem = { kind: 'session', id: 's1', title: '주문 목록', projectName: 'shop', state: 'idle', backend: 'claude-code', lastActivityAt: '2026-10-22T00:00:00Z' };

describe('사이드바 상태', () => {
  it('권한을 묻는 터미널은 작업 중보다 먼저 "권한 대기"로 보인다', () => {
    expect(agentStatus({ ...base, state: 'working', terminal: { cli: 'up', waiting: 'permission' } })).toEqual({ label: '권한 대기', tone: 'warn' });
  });

  it('작업 중, 답 기다림, CLI 대기, 쉼, 오류를 가른다', () => {
    expect(agentStatus({ ...base, state: 'working' }).label).toBe('작업 중');
    expect(agentStatus({ ...base, attention: 'question' }).label).toBe('답 기다림');
    expect(agentStatus({ ...base, terminal: { cli: 'up' } }).label).toBe('CLI 대기');
    expect(agentStatus({ ...base, terminal: { cli: 'down' } }).label).toBe('쉼');
    expect(agentStatus({ ...base, state: 'error' })).toEqual({ label: '오류', tone: 'fail' });
    // 계획이 끝나 자원을 돌려준 레인은 멈춤이 아니라 끝남이다(#868)
    expect(agentStatus({ ...base, state: 'done' })).toEqual({ label: '끝남', tone: 'ok' });
  });

  it('기다리는 종류마다 다른 글과 색: 권한은 노랑, 답은 보라, 입력 필요는 청록. 쉬며 기다리면 CLI 대기(#921)', () => {
    expect(agentStatus({ ...base, terminal: { cli: 'up', waiting: 'question' } })).toEqual({ label: '답 기다림', tone: 'warn', color: 'purple' });
    expect(agentStatus({ ...base, terminal: { cli: 'up', waiting: 'input' } })).toEqual({ label: '입력 필요', tone: 'warn', color: 'teal' });
    expect(agentStatus({ ...base, state: 'working', terminal: { cli: 'up', waiting: 'idle' } }).label).toBe('작업 중');
    expect(agentStatus({ ...base, terminal: { cli: 'up', waiting: 'idle' } })).toEqual({ label: 'CLI 대기', tone: 'muted' });
  });

  it('게이트 상태를 싣는 서버면 그것을, 아니면 개입 사유로 실패만 보인다', () => {
    expect(gateStatus({ ...base, gate: { state: 'verifying', checkpoints: 2 } })).toEqual({ label: '검증 중', tone: 'busy' });
    expect(gateStatus({ ...base, gate: { state: 'passed', checkpoints: 2 } })).toEqual({ label: '통과', tone: 'ok' });
    expect(gateStatus({ ...base, gate: { state: 'failed', checkpoints: 0 } })).toEqual({ label: '실패', tone: 'fail' });
    expect(gateStatus({ ...base, gate: { state: 'none', checkpoints: 0 } })).toBeUndefined();
    expect(gateStatus({ ...base, attention: 'gate_failed' })).toEqual({ label: '실패', tone: 'fail' });
    expect(gateStatus(base)).toBeUndefined();
  });

  it('통과했어도 확인 필요로 표시된 실행은 "확인 필요"가 이긴다', () => {
    expect(gateStatus({ ...base, attention: 'needs_review', gate: { state: 'passed', checkpoints: 1 } })).toEqual({ label: '확인 필요', tone: 'warn' });
  });
});

describe('스페이스로 묶기(#887)', () => {
  it('세션을 스페이스(프로젝트)끼리 모은다. 스페이스 차례는 처음 나온 차례, 안에서는 받은 차례다', () => {
    const items = [
      { ...base, id: 'a', projectName: 'shop' },
      { ...base, id: 'b', projectName: 'blog' },
      { ...base, id: 'c', projectName: 'shop' },
      { ...base, id: 'plan:p', projectName: 'blog', kind: 'lane' as const },
    ];
    expect(deskSessions(items).map((item) => item.id)).toEqual(['a', 'c', 'b']);
  });

  it('스페이스마다 소속 세션 가운데 가장 급한 상태를 고른다(손댈 것 > 오류 > 작업 중 > 괜찮음 > 쉼)', () => {
    const spaces = deskSpaces([
      { ...base, id: 'a', state: 'working' },
      { ...base, id: 'b', terminal: { cli: 'up', waiting: 'permission' } },
      { ...base, id: 'c', projectName: 'blog', state: 'error' },
      { ...base, id: 'd', projectName: 'blog', state: 'working' },
      { ...base, id: 'e', projectName: 'docs', state: 'stopped' },
    ]);
    expect(spaces.map((space) => [space.name, space.sessions, space.status.label])).toEqual([
      ['shop', [0, 1], '권한 대기'],
      ['blog', [2, 3], '오류'],
      ['docs', [4], '멈춤'],
    ]);
  });
});

describe('사이드바 줄', () => {
  const items: DeskItem[] = [
    { ...base, id: 'a', title: '주문 목록', state: 'working' },
    { ...base, id: 'b', title: '결제', backend: 'codex' },
    { ...base, id: 'c', title: '글쓰기', projectName: 'blog' },
  ];

  it('스페이스마다 한 줄이고, 고른 세션이 든 스페이스 아래에만 세션을 한 줄씩 편다', () => {
    const rows = sidebarRows(items, 1, new Map(), 40);
    const texts = rows.map((row) => stripAnsi(row.text));
    expect(texts[0]).toContain('스페이스');
    expect(texts[1]).toMatch(/◐ shop +2 $/);
    expect(rows[1]!.space).toBe('shop');
    expect(texts[2]).toContain('◐ 주문 목록');
    expect(texts[3]).toContain('○ 결제');
    expect(rows[3]!.selected).toBe(true);
    expect(rows.slice(2, 4).map((row) => row.item)).toEqual([0, 1]);
    expect(texts[4]).toMatch(/○ blog +1 $/);
    // 고르지 않은 스페이스의 세션은 펴지 않는다
    expect(rows).toHaveLength(6);
    expect(rows.at(-1)).toMatchObject({ action: 'folder', selected: false });
    for (const text of texts) expect(stringWidth(text)).toBe(40);
  });

  it('다른 스페이스의 세션을 고르면 그 스페이스를 편다', () => {
    const texts = sidebarRows(items, 2, new Map(), 40).map((row) => stripAnsi(row.text));
    // 맨 끝은 "+ 폴더 열기"(#916)
    expect(texts).toHaveLength(5);
    expect(texts[3]).toContain('글쓰기');
    expect(texts[4]).toContain('+ 폴더 열기');
  });

  it('칸에 열린 세션은 칸 번호를, 알린 뒤 아직 보지 않은 세션은 !를 오른쪽에 붙인다', () => {
    const rows = sidebarRows(items, 0, new Map([['a', 2]]), 40, new Set(['b']));
    expect(stripAnsi(rows[2]!.text)).toMatch(/주문 목록 +2 $/);
    expect(stripAnsi(rows[3]!.text)).toMatch(/결제 +! $/);
  });

  it('항목이 없으면 새 요청 안내', () => {
    const rows = sidebarRows([], 0, new Map(), 40);
    expect(rows.map((row) => row.text).join('\n')).toContain('Ctrl-b n');
  });
});

describe('에이전트 내역과 범위(#843)', () => {
  const usage = (input: number) => ({ inputTokens: input, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  const detailed: DeskItem = {
    ...base,
    state: 'working',
    tokens: usage(12_345),
    agents: [
      { id: 'main', name: '메인', kind: 'main', state: 'working', tokens: usage(10_000) },
      { id: 'claude:Explore', name: 'Explore', kind: 'subagent', state: 'working', activity: '모델 요청 2회', tokens: usage(2_000) },
      { id: 'claude:Plan', name: 'Plan', kind: 'subagent', state: 'done', activity: '끝남 · 도구 3회', tokens: usage(345) },
    ],
    capabilities: { backend: 'claude-code', model: 'opus', tools: 'cli-default', writeScope: '세션 작업 복사본 전체', permission: 'CLI 권한 확인 + 쓰기 직전 관문 + 턴 끝 게이트' },
  };

  it('토큰 합을 짧게 보인다', () => {
    expect(compactTokens(950)).toBe('950');
    expect(compactTokens(12_345)).toBe('1.2만');
    expect(compactTokens(5_100)).toBe('5.1천');
    expect(compactTokens(250_000_000)).toBe('2.5억');
  });

  it('서브에이전트마다 한 줄과 범위 두 줄', () => {
    const texts = detailLines(detailed).map((line) => line.text);
    expect(texts).toEqual([
      '↳ Explore 작업 중 · 토큰 2,000 · 모델 요청 2회',
      '↳ Plan 끝남 · 토큰 345 · 끝남 · 도구 3회',
      '쓸 수 있는 곳 세션 작업 복사본 전체',
      '지키는 것 쓰기 전 검사 · 끝나면 검증',
    ]);
  });

  it('서브에이전트는 여섯까지 보이고 나머지는 "외 N개"', () => {
    const many: DeskItem = {
      ...detailed,
      agents: [detailed.agents![0]!, ...Array.from({ length: 9 }, (_, index) => ({ id: `claude:a${index}`, name: `a${index}`, kind: 'subagent' as const, state: 'done' as const, tokens: usage(1) }))],
      capabilities: undefined,
    };
    const texts = detailLines(many).map((line) => line.text);
    expect(texts.filter((text) => text.includes('↳ a'))).toHaveLength(6);
    expect(texts.at(-1)).toBe('↳ 외 3개');
  });

  it('허용 도구 목록이 있으면 그 목록을 보인다', () => {
    const listed: DeskItem = { ...detailed, agents: undefined, capabilities: { ...detailed.capabilities!, tools: ['Read', 'Edit'] } };
    expect(detailLines(listed)[0]!.text).toContain('도구 Read, Edit');
  });
});

describe('봐야 할 것 먼저(#922)', () => {
  it('끝났지만 아직 안 본 세션은 "끝남", 본 세션은 쉼(흐린 색)이다', () => {
    const settled = { ...base, terminal: { cli: 'up' as const } };
    expect(agentStatus(settled, { unseen: true })).toEqual({ label: '끝남', tone: 'ok' });
    expect(agentStatus(settled)).toEqual({ label: 'CLI 대기', tone: 'muted' });
    // 안 봤어도 작업 중이면 작업 중이다
    expect(agentStatus({ ...base, state: 'working' }, { unseen: true }).label).toBe('작업 중');
  });

  it('주의 종류는 terminal.waiting과 옛 꼴(개입 사유 문자열)을 읽는다', () => {
    expect(agentStatus({ ...base, terminal: { cli: 'up', waiting: 'input' } }).label).toBe('입력 필요');
    expect(agentStatus({ ...base, attention: 'approval' }).label).toBe('승인 대기');
    // 쉬는 중 알림은 손댈 상태가 아니다
    expect(agentStatus({ ...base, terminal: { cli: 'up', waiting: 'idle' } }).tone).toBe('muted');
  });

  it('급한 순서: 권한·질문 > 오류·검증 실패 > 끝남(안 봄) > 작업 중 > 쉼, 같으면 받은 차례', () => {
    const items: DeskItem[] = [
      { ...base, id: 'idle' },
      { ...base, id: 'work', state: 'working' },
      { ...base, id: 'done', terminal: { cli: 'up' } },
      { ...base, id: 'err', state: 'error' },
      { ...base, id: 'ask', terminal: { cli: 'up', waiting: 'permission' } },
      { ...base, id: 'work2', state: 'working' },
      { ...base, id: 'gate', attention: 'gate_failed' },
    ];
    expect(byUrgency(items, new Set(['done'])).map((entry) => entry.id)).toEqual(['ask', 'err', 'gate', 'done', 'work', 'work2', 'idle']);
    expect(urgencyRank(items[0]!, false)).toBe(0);
  });

  it('고르는 동안은 앞 차례를 지키고 새 세션은 끝에 둔다', () => {
    const before: DeskItem[] = [{ ...base, id: 'a' }, { ...base, id: 'b' }];
    const after: DeskItem[] = [{ ...base, id: 'c' }, { ...base, id: 'b', state: 'working' }, { ...base, id: 'a' }];
    const kept = keepOrder(before, after);
    expect(kept.map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
    // 내용은 새 목록 것이다
    expect(kept[1]!.state).toBe('working');
  });

  it('사이드바는 안 본 끝남을 초록 점으로 그린다', () => {
    const rows = sidebarRows([{ ...base, terminal: { cli: 'up' } }], 0, new Map(), 30, new Set(), undefined, new Set(['s1']));
    const session = rows.find((row) => row.item === 0)!;
    expect(stripAnsi(session.text)).toContain('주문 목록');
    const seen = sidebarRows([{ ...base, terminal: { cli: 'up' } }], 0, new Map(), 30, new Set()).find((row) => row.item === 0)!;
    expect(session.text).not.toBe(seen.text);
  });
});

describe('사이드바 세션 줄의 상태 글(#935)', () => {
  const now = Date.parse('2026-10-26T10:00:00Z');
  const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
  const tag = (item: DeskItem, unseen = false) => sessionTag(item, unseen, now)?.text;

  it('사람이 손댈 것은 권한·질문·입력·승인으로 짧게 쓴다', () => {
    expect(tag({ ...base, terminal: { cli: 'up', waiting: 'permission' } })).toBe('권한');
    expect(tag({ ...base, terminal: { cli: 'up', waiting: 'question' } })).toBe('질문');
    expect(tag({ ...base, terminal: { cli: 'up', waiting: 'input' } })).toBe('입력');
    expect(tag({ ...base, attention: 'approval' })).toBe('승인');
  });

  it('오류·검증 실패·확인 필요·끝남(안 봄)을 쓰고, 그냥 쉬면 비운다', () => {
    expect(tag({ ...base, state: 'error' })).toBe('오류');
    expect(tag({ ...base, gate: { state: 'failed', checkpoints: 1 } })).toBe('실패');
    expect(tag({ ...base, attention: 'needs_review' })).toBe('확인');
    expect(tag({ ...base, terminal: { cli: 'up' } }, true)).toBe('끝남');
    expect(tag({ ...base, terminal: { cli: 'up' } })).toBeUndefined();
    expect(tag(base)).toBeUndefined();
  });

  it('작업 중이면 요청을 시작한 뒤 지난 시간을 쓰고, 시작 시각을 모르면 비운다', () => {
    expect(tag({ ...base, state: 'working', workingSince: ago(23) })).toBe('23분');
    expect(tag({ ...base, state: 'working' })).toBeUndefined();
    // 기다림이 작업 중보다 먼저다
    expect(tag({ ...base, state: 'working', workingSince: ago(5), terminal: { cli: 'up', waiting: 'permission' } })).toBe('권한');
  });

  it('지난 시간은 초·분·시간으로 짧게 쓴다', () => {
    expect(shortElapsed(42_000)).toBe('42초');
    expect(shortElapsed(23 * 60_000 + 10_000)).toBe('23분');
    expect(shortElapsed(64 * 60_000)).toBe('1시간4분');
    expect(shortElapsed(120 * 60_000)).toBe('2시간');
    expect(shortElapsed(-5_000)).toBe('0초');
  });

  it('세션 줄 오른쪽에 상태 글과 칸 번호를 둔다', () => {
    const items: DeskItem[] = [
      { ...base, id: 'a', title: '결제 테스트', terminal: { cli: 'up', waiting: 'permission' } },
      { ...base, id: 'b', title: '주문 리팩터링', state: 'working', workingSince: ago(23) },
    ];
    const rows = sidebarRows(items, 0, new Map([['a', 2]]), 36, new Set(), undefined, new Set(), now).map((row) => stripAnsi(row.text));
    expect(rows.find((row) => row.includes('결제 테스트'))).toMatch(/결제 테스트\s+권한 2 $/);
    expect(rows.find((row) => row.includes('주문 리팩터링'))).toMatch(/주문 리팩터링\s+23분 $/);
    for (const row of rows) expect(stringWidth(row)).toBe(36);
  });
});
