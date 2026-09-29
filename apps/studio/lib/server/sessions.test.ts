import { describe, expect, it } from 'vitest';
import { StudioError } from './errors';
import { buildExportChecks, parseIssueInput, parseIssueList } from './sessions';

describe('parseIssueInput', () => {
  it('생략은 undefined, 1~10,000,000 정수만 받고 나머지는 400으로 거부한다', () => {
    expect(parseIssueInput(undefined)).toBeUndefined();
    expect(parseIssueInput(null)).toBeUndefined();
    expect(parseIssueInput('')).toBeUndefined();
    expect(parseIssueInput(57)).toBe(57);
    expect(parseIssueInput(10_000_000)).toBe(10_000_000);

    for (const bad of [0, -1, 1.5, 10_000_001, Number.NaN, Infinity, '57', true]) {
      expect(() => parseIssueInput(bad)).toThrow(StudioError);
    }
  });
});

describe('parseIssueList', () => {
  it('단수 issue와 배열 issues를 합치고 중복을 없앤다', () => {
    expect(parseIssueList({ issue: 57 })).toEqual([57]);
    expect(parseIssueList({ issues: [57, 58, 57] })).toEqual([57, 58]);
    expect(parseIssueList({ issue: 57, issues: [58, 57] })).toEqual([57, 58]);
    expect(parseIssueList({ issues: [] })).toEqual([]);
    // 입력이 아예 없으면 undefined라 부르는 쪽이 기본값을 쓸지 정한다
    expect(parseIssueList({})).toBeUndefined();
  });

  it('잘못된 값은 400으로 거부한다', () => {
    expect(() => parseIssueList({ issues: '57' })).toThrow('issues는 이슈 번호 배열이어야 합니다');
    for (const bad of [{ issues: [0] }, { issues: [1.5] }, { issues: ['57'] }, { issue: 0 }]) {
      expect(() => parseIssueList(bad)).toThrow(StudioError);
    }
  });
});

describe('buildExportChecks', () => {
  it('이슈 연결·원격 이슈 상태·누락 단계·체크포인트 밖 변경·진행 상태를 확인 목록으로 만든다', () => {
    const checks = buildExportChecks({
      issues: [57],
      issueLookups: [{ issue: 57, lookup: { ok: true, state: 'open', title: 'PR 미리보기' } }],
      missing: [{ shortSha: 'aaaaaaa', subject: '배송 메모 추가', stages: ['test', 'review'] }],
      uncheckpointed: 2,
      running: false,
    });

    expect(checks.map((check) => [check.id, check.ok])).toEqual([
      ['issue_linked', true],
      ['issue_open', true],
      ['stages_passed', false],
      ['uncheckpointed_changes', false],
      ['running', true],
    ]);
    expect(checks.find((check) => check.id === 'issue_open')?.detail).toContain('PR 미리보기');
    expect(checks.find((check) => check.id === 'stages_passed')?.detail).toBe('필수 단계 기록이 없는 커밋 1개가 있습니다');
  });

  it('여러 이슈를 이어 붙여 보여 준다', () => {
    const checks = buildExportChecks({
      issues: [57, 58],
      issueLookups: [
        { issue: 57, lookup: { ok: true, state: 'open', title: '미리보기' } },
        { issue: 58, lookup: { ok: true, state: 'closed', title: '작업 분해' } },
      ],
      missing: [],
      uncheckpointed: 0,
      running: false,
    });

    expect(checks.find((check) => check.id === 'issue_linked')?.detail).toBe('#57, #58 이슈를 PR에 연결합니다');
    // 하나라도 닫혀 있으면 false
    expect(checks.find((check) => check.id === 'issue_open')?.ok).toBe(false);
    expect(checks.find((check) => check.id === 'issue_open')?.detail).toContain('#57 미리보기 (열림)');
    expect(checks.find((check) => check.id === 'issue_open')?.detail).toContain('#58 작업 분해 (닫힘)');
  });

  it('원격 이슈 조회에 실패하면 unknown과 이유로 두고 막지 않는다', () => {
    const checks = buildExportChecks({
      issues: [57],
      issueLookups: [{ issue: 57, lookup: { ok: false, error: 'B_STUDIO_GITHUB_TOKEN 토큰이 없어 이슈를 확인할 수 없습니다' } }],
      missing: [],
      uncheckpointed: 0,
      running: true,
    });

    const open = checks.find((check) => check.id === 'issue_open')!;
    expect(open.ok).toBe('unknown');
    expect(open.detail).toContain('B_STUDIO_GITHUB_TOKEN');
    expect(checks.find((check) => check.id === 'stages_passed')?.ok).toBe(true);
    expect(checks.find((check) => check.id === 'running')?.ok).toBe(false);
  });

  it('이슈 번호가 없으면 확인할 이슈가 없다고 알린다', () => {
    const checks = buildExportChecks({ issues: [], missing: [], uncheckpointed: 0, running: false });

    expect(checks.find((check) => check.id === 'issue_linked')).toMatchObject({ ok: false });
    expect(checks.find((check) => check.id === 'issue_open')).toMatchObject({ ok: 'unknown' });
  });
});
