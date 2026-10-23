import { describe, expect, it } from 'vitest';
import { stripAnsi } from './screen';
import { detailKey, openDetail, osc8, parsePatch, sessionDetailLines, type DetailSnapshot, type DetailState } from './session-detail';
import { DEFAULT_THEME } from './theme';
import type { DeskItem } from './types';

/**
 * 세션 자세히(#891): 체크포인트 되돌리기·다시 검증, 게이트 확인 필요와 AI 리뷰 지적, 바뀐 파일 diff, 올리기(PR), 세션 지우기.
 * 되돌리기·지우기·올리기는 묻고 나서만 한다(지우기는 두 번)
 */
const NOW = Date.parse('2026-10-23T12:00:00.000Z');
const item: DeskItem = { kind: 'session', id: 's1', title: '주문 모듈 리팩터링', projectName: 'shop', state: 'idle', backend: 'claude-code', lastActivityAt: '2026-10-23T00:00:00Z', attention: 'needs_review', reason: '요청은 10개, 테스트는 20개를 기대함' };

const snapshot: DetailSnapshot = {
  id: 's1',
  status: 'ready',
  running: false,
  checkpoints: [
    { sha: 'bbbbbbb1', shortSha: 'bbbbbbb', message: '주문 서비스 나누기', createdAt: '2026-10-23T03:04:00.000Z', files: ['a.ts', 'b.ts'], passedStages: ['build', 'test'] },
    { sha: 'aaaaaaa1', shortSha: 'aaaaaaa', message: '세션 시작', createdAt: '2026-10-22T03:04:00.000Z', files: ['a.ts'], verify: 'light' },
  ],
  reverifications: [{ sha: 'bbbbbbb1', shortSha: 'bbbbbbb', ok: false, summary: 'test 실패: order.test.ts', finishedAt: '2026-10-23T04:00:00.000Z' }],
  review: {
    state: 'capped',
    maxRounds: 2,
    rounds: [
      { round: 1, status: 'blocked_continue', findings: [{ severity: 'major', file: 'a.ts', line: 3, title: '널 확인 빠짐', detail: '주문이 없으면 터진다' }], startedAt: '2026-10-23T05:00:00.000Z' },
      {
        round: 2,
        status: 'blocked_capped',
        findings: [
          { severity: 'blocker', file: 'b.ts', title: '트랜잭션 없음', detail: '두 쓰기가 따로 간다' },
          { severity: 'nit', file: 'b.ts', title: '이름', detail: '짧다' },
        ],
        humanResolutions: { 1: { reason: '취향', at: '2026-10-23T06:00:00.000Z' } },
        startedAt: '2026-10-23T05:30:00.000Z',
      },
    ],
  },
  repository: { remote: 'github.com/me/shop', base: 'main', branch: 'b-studio/s1', canCreatePullRequest: true },
};

const PATCH = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1..2 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,3 +1,4 @@',
  ' keep',
  '-old',
  '+new',
  '+more',
  'diff --git a/src/b.ts b/src/b.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/src/b.ts',
  '@@ -0,0 +1 @@',
  '+hello',
].join('\n');

const loaded = (patch: Partial<DetailState> = {}): DetailState => ({ ...openDetail(item), loading: false, snapshot, ...patch });
const text = (state: DetailState, height = 30) =>
  sessionDetailLines(state, { theme: DEFAULT_THEME, width: 100, height, now: NOW })
    .map(stripAnsi)
    .join('\n');

describe('patch 나누기', () => {
  it('파일마다 더한 줄·뺀 줄 수와 그 파일의 줄을 나눈다', () => {
    const files = parsePatch(PATCH);
    expect(files.map(({ path, added, removed }) => ({ path, added, removed }))).toEqual([
      { path: 'src/a.ts', added: 2, removed: 1 },
      { path: 'src/b.ts', added: 1, removed: 0 },
    ]);
    expect(files[0]!.lines[0]).toBe('diff --git a/src/a.ts b/src/a.ts');
    expect(files[1]!.lines.at(-1)).toBe('+hello');
    expect(parsePatch('')).toEqual([]);
  });
});

describe('세션 자세히 키', () => {
  it('열면 체크포인트 탭이고 세션을 불러온다. Esc로 닫는다', () => {
    expect(openDetail(item)).toMatchObject({ id: 's1', title: '주문 모듈 리팩터링', tab: 'checkpoints', loading: true, reason: '요청은 10개, 테스트는 20개를 기대함' });
    expect(detailKey(loaded(), '\x1b').detail).toBeUndefined();
    expect(detailKey(loaded(), 'q').detail).toBeUndefined();
  });

  it('Tab으로 체크포인트 → 확인·리뷰 → 올리기를 돌고, 올리기 탭에 처음 오면 올리기 전 점검을 부른다', () => {
    const review = detailKey(loaded(), '\t');
    expect(review.detail?.tab).toBe('review');
    const exporting = detailKey(review.detail!, '\t');
    expect(exporting.detail?.tab).toBe('export');
    expect(exporting.action).toEqual({ kind: 'exportPreview' });
    expect(detailKey(exporting.detail!, '\t').detail?.tab).toBe('checkpoints');
  });

  it('체크포인트에서 Enter는 그 diff를 부르고, 파일을 골라 Enter로 줄을 보고, Esc로 한 단계씩 돌아온다', () => {
    const second = detailKey(loaded(), '\x1b[B').detail!;
    expect(second.selected).toBe(1);
    const opened = detailKey(loaded(), '\r');
    expect(opened.action).toEqual({ kind: 'patch', sha: 'bbbbbbb1' });
    const withFiles: DetailState = { ...opened.detail!, patch: { sha: 'bbbbbbb1', shortSha: 'bbbbbbb', files: parsePatch(PATCH), selected: 0, scroll: 0 } };
    const next = detailKey(withFiles, 'j').detail!;
    expect(next.patch?.selected).toBe(1);
    const file = detailKey(next, '\r').detail!;
    expect(file.patch?.file).toBe(1);
    expect(detailKey(file, '\x1b[6~').detail?.patch?.scroll).toBeGreaterThan(0);
    const backToFiles = detailKey(file, '\x1b').detail!;
    expect(backToFiles.patch?.file).toBeUndefined();
    const backToList = detailKey(backToFiles, '\x1b').detail!;
    expect(backToList.patch).toBeUndefined();
    expect(backToList.tab).toBe('checkpoints');
  });

  it('u는 고른 체크포인트로 되돌릴지 묻고 y일 때만 되돌린다. v는 다시 검증한다', () => {
    const asked = detailKey(loaded(), 'u').detail!;
    expect(asked.confirm).toEqual({ action: 'restore', sha: 'bbbbbbb1', label: 'bbbbbbb' });
    expect(detailKey(asked, 'y').action).toEqual({ kind: 'restore', sha: 'bbbbbbb1' });
    const cancelled = detailKey(asked, 'n');
    expect(cancelled.action).toBeUndefined();
    expect(cancelled.detail?.confirm).toBeUndefined();
    expect(cancelled.detail?.message).toBe('그만두었습니다');
    expect(detailKey(loaded(), 'v').action).toEqual({ kind: 'reverify', sha: 'bbbbbbb1' });
  });

  it('D는 두 번 물은 뒤에만 세션을 지우고, 실행 중이면 먼저 멈추라고 한다', () => {
    const first = detailKey(loaded(), 'D').detail!;
    expect(first.confirm).toEqual({ action: 'delete', step: 1 });
    const second = detailKey(first, 'y');
    expect(second.action).toBeUndefined();
    expect(second.detail?.confirm).toEqual({ action: 'delete', step: 2 });
    expect(detailKey(second.detail!, 'y').action).toEqual({ kind: 'delete' });
    expect(detailKey(second.detail!, 'x').action).toBeUndefined();
    const running = detailKey(loaded({ snapshot: { ...snapshot, running: true, status: 'ready' } }), 'D');
    expect(running.detail?.confirm).toBeUndefined();
    expect(running.detail?.message).toContain('먼저 멈춘');
  });

  it('리뷰 탭에서 x로 막는 지적을 오탐으로 닫을 까닭을 쓰고 Enter로 보낸다. 빈 까닭은 보내지 않는다', () => {
    const review = detailKey(loaded(), '\t').detail!;
    // 새 라운드부터, 닫히지 않은 막는 지적만 고를 수 있다: 2라운드 blocker, 1라운드 major
    const writing = detailKey(review, 'x').detail!;
    expect(writing.resolving).toEqual({ round: 2, findingIndex: 0, text: '' });
    expect(detailKey(writing, '\r').action).toBeUndefined();
    let state = writing;
    for (const char of '테스트가 막음') state = detailKey(state, char).detail!;
    expect(detailKey(state, '\r').action).toEqual({ kind: 'resolve', round: 2, findingIndex: 0, reason: '테스트가 막음' });
    expect(detailKey(state, '\x1b').detail?.resolving).toBeUndefined();
    const below = detailKey(review, '\x1b[B').detail!;
    expect(detailKey(below, 'x').detail?.resolving).toEqual({ round: 1, findingIndex: 0, text: '' });
  });

  it('리뷰 탭의 a는 AI 리뷰를 (다시) 돌릴지 묻는다', () => {
    const review = detailKey(loaded(), '\t').detail!;
    const asked = detailKey(review, 'a').detail!;
    expect(asked.confirm).toEqual({ action: 'review' });
    expect(detailKey(asked, 'y').action).toEqual({ kind: 'review', restart: true });
  });

  it('올리기 탭의 p는 PR까지, b는 브랜치만 올릴지 묻고 y일 때 올린다. 저장소가 없으면 막는다', () => {
    const tab: DetailState = { ...loaded(), tab: 'export' };
    const pr = detailKey(tab, 'p').detail!;
    expect(pr.confirm).toEqual({ action: 'export', pullRequest: true });
    expect(detailKey(pr, 'y').action).toEqual({ kind: 'export', pullRequest: true });
    expect(detailKey(detailKey(tab, 'b').detail!, 'y').action).toEqual({ kind: 'export', pullRequest: false });
    const none = detailKey({ ...tab, snapshot: { ...snapshot, repository: undefined } }, 'p');
    expect(none.detail?.confirm).toBeUndefined();
    expect(none.detail?.message).toContain('Git 저장소가 아니');
  });

  it('일을 보내는 중(busy)에는 다른 동작 키를 받지 않는다', () => {
    const busy = loaded({ busy: '되돌리는 중' });
    expect(detailKey(busy, 'u').detail?.confirm).toBeUndefined();
    expect(detailKey(busy, 'D').detail?.confirm).toBeUndefined();
  });
});

describe('세션 자세히 그리기', () => {
  it('체크포인트마다 짧은 sha, 시각, 메시지, 검증, 파일 수를 보이고 다시 검증 결과를 붙인다', () => {
    const out = text(loaded());
    expect(out).toContain('주문 모듈 리팩터링');
    expect(out).toMatch(/bbbbbbb\s+10\/23 \d\d:04\s+주문 서비스 나누기/);
    expect(out).toContain('검증 통과(build·test)');
    expect(out).toContain('가볍게 확인');
    expect(out).toContain('파일 2');
    expect(out).toContain('다시 검증 실패: test 실패: order.test.ts');
    expect(out).toContain('u 되돌리기');
  });

  it('바뀐 파일은 +/- 수로, 고른 파일은 색을 입힌 diff 줄로 보인다', () => {
    const files = parsePatch(PATCH);
    const list = text(loaded({ patch: { sha: 'bbbbbbb1', shortSha: 'bbbbbbb', files, selected: 0, scroll: 0 } }));
    expect(list).toMatch(/src\/a\.ts\s+\+2 -1/);
    expect(list).toMatch(/src\/b\.ts\s+\+1 -0/);
    const raw = sessionDetailLines(loaded({ patch: { sha: 'bbbbbbb1', shortSha: 'bbbbbbb', files, selected: 0, file: 0, scroll: 0 } }), { theme: DEFAULT_THEME, width: 100, height: 30, now: NOW });
    const plus = raw.find((line) => stripAnsi(line).includes('+new'))!;
    expect(plus).not.toBe(stripAnsi(plus));
    expect(raw.map(stripAnsi).join('\n')).toContain('-old');
  });

  it('리뷰 탭은 게이트의 확인 필요 사유와 라운드의 지적(닫은 것 포함)을 보인다', () => {
    const out = text({ ...loaded(), tab: 'review' });
    expect(out).toContain('확인 필요: 요청은 10개, 테스트는 20개를 기대함');
    expect(out).toContain('2라운드');
    expect(out).toMatch(/blocker\s+b\.ts\s+트랜잭션 없음/);
    expect(out).toMatch(/nit\s+b\.ts\s+이름.*오탐으로 닫음: 취향/);
    expect(out).toMatch(/major\s+a\.ts:3\s+널 확인 빠짐/);
  });

  it('올리기 탭은 점검 결과와 이미 열린 PR을, 올린 뒤에는 결과 주소를 링크(OSC 8)로 보인다', () => {
    const preview = { title: '주문 모듈', canCreate: true, issues: [12], checks: [{ id: 'stages_passed', ok: true, detail: '검증 통과' }, { id: 'issue_linked', ok: false, detail: '이슈를 잇지 않았습니다' }] };
    const out = text({ ...loaded(), tab: 'export', preview });
    expect(out).toContain('PR 제목: 주문 모듈');
    expect(out).toContain('✓ 검증 통과');
    expect(out).toContain('✗ 이슈를 잇지 않았습니다');
    const done = sessionDetailLines({ ...loaded(), tab: 'export', preview, result: { text: 'PR을 만들었습니다', url: 'https://example.test/pr/1' } }, { theme: DEFAULT_THEME, width: 100, height: 30, now: NOW });
    expect(done.join('\n')).toContain(osc8('https://example.test/pr/1', 'https://example.test/pr/1'));
  });

  it('묻는 중이면 아래 줄에 무엇을 할지 보이고, 지우기 둘째 물음은 되돌릴 수 없다고 말한다', () => {
    expect(text(loaded({ confirm: { action: 'restore', sha: 'bbbbbbb1', label: 'bbbbbbb' } }))).toContain('bbbbbbb 체크포인트로 되돌릴까요');
    expect(text(loaded({ confirm: { action: 'delete', step: 2 } }))).toContain('되돌릴 수 없습니다');
  });

  it('줄 수는 정확히 height다', () => {
    expect(sessionDetailLines(loaded(), { theme: DEFAULT_THEME, width: 50, height: 9, now: NOW })).toHaveLength(9);
  });
});
