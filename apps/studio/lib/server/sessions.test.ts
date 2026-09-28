import { describe, expect, it } from 'vitest';
import { StudioError } from './errors';
import { buildExportChecks, parseIssueInput } from './sessions';

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

describe('buildExportChecks', () => {
  it('이슈 연결·원격 이슈 상태·누락 단계·체크포인트 밖 변경·진행 상태를 확인 목록으로 만든다', () => {
    const checks = buildExportChecks({
      issue: 57,
      issueLookup: { ok: true, state: 'open', title: 'PR 미리보기' },
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

  it('원격 이슈 조회에 실패하면 unknown과 이유로 두고 막지 않는다', () => {
    const checks = buildExportChecks({
      issue: 57,
      issueLookup: { ok: false, error: 'B_STUDIO_GITHUB_TOKEN 토큰이 없어 이슈를 확인할 수 없습니다' },
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
    const checks = buildExportChecks({ missing: [], uncheckpointed: 0, running: false });

    expect(checks.find((check) => check.id === 'issue_linked')).toMatchObject({ ok: false });
    expect(checks.find((check) => check.id === 'issue_open')).toMatchObject({ ok: 'unknown' });
  });
});
