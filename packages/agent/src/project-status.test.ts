import { describe, expect, it } from 'vitest';
import { buildProjectStatus, type ProjectStatusInput } from './project-status';

/** 공통 고정값: 링크·체크포인트는 대부분의 테스트에서 신경 쓰지 않는 필드라 베이스로 묶어 둔다 */
const baseInput: ProjectStatusInput = {
  projectName: '주문 서비스',
  running: false,
  requirements: [],
  manualSteps: [],
  checkpoints: [],
  failedServices: [],
  links: { roadmap: 'docs/ROADMAP.md', changelog: 'CHANGELOG.md', docsIndex: 'docs/README.md' },
};

describe('buildProjectStatus — 지금 하는 일', () => {
  it('요청을 처리 중이면 그 설명을 보여준다', () => {
    const status = buildProjectStatus({ ...baseInput, running: true, currentRequestSummary: '결제 API 추가' });
    expect(status.currentWork.summary).toBe('결제 API 추가');
  });

  it('처리 중인 요청이 없고 레인도 없으면 "없음"으로 보여준다', () => {
    const status = buildProjectStatus(baseInput);
    expect(status.currentWork.summary).toBe('지금 처리 중인 요청이 없습니다');
    expect(status.currentWork.items).toEqual([]);
  });

  it('작업 분해 레인이 있으면 레인별 상태를 나열한다', () => {
    const status = buildProjectStatus({
      ...baseInput,
      lanes: [
        { id: 'a1', label: '백엔드', status: 'running' },
        { id: 'a2', label: '프론트', status: 'done' },
      ],
    });
    expect(status.currentWork.summary).toBe('작업 분해 레인이 진행 중입니다');
    expect(status.currentWork.items).toEqual(['레인 a1(백엔드): running', '레인 a2(프론트): done']);
  });
});

describe('buildProjectStatus — 목적', () => {
  it('must·should 요구사항만 목적으로 담고, could는 뺀다', () => {
    const status = buildProjectStatus({
      ...baseInput,
      requirements: [
        { id: 'R1', title: '주문 생성', priority: 'must', status: '검증됨', issue: 12 },
        { id: 'R2', title: '주문 취소', priority: 'should', status: '작업 중' },
        { id: 'R3', title: '다크 모드', priority: 'could', status: '미착수' },
      ],
    });
    expect(status.purpose.items).toEqual([
      { id: 'R1', title: '주문 생성', issue: 12 },
      { id: 'R2', title: '주문 취소' },
    ]);
  });
});

describe('buildProjectStatus — 예상 완료', () => {
  it('예상 시간 입력이 없으면 "추정 없음"이라고 말한다(지어내지 않는다)', () => {
    const status = buildProjectStatus(baseInput);
    expect(status.eta.hasEstimate).toBe(false);
    expect(status.eta.summary).toContain('추정 없음');
  });

  it('예상 시간이 있으면 합계를 보여준다', () => {
    const status = buildProjectStatus({
      ...baseInput,
      estimates: [
        { id: 't1', label: '백엔드 작업', estimateMinutes: 60 },
        { id: 't2', label: '프론트 작업', estimateMinutes: 90 },
      ],
    });
    expect(status.eta.hasEstimate).toBe(true);
    expect(status.eta.summary).toContain('150분');
  });
});

describe('buildProjectStatus — 결과물', () => {
  it('체크포인트와 PR 주소를 그대로 담는다', () => {
    const status = buildProjectStatus({
      ...baseInput,
      checkpoints: [{ shortSha: 'abc123', message: 'feat: 주문 생성', createdAt: '2026-10-01T00:00:00Z' }],
      pullRequestUrl: 'https://github.com/dj258255/test/pull/1',
    });
    expect(status.deliverables.checkpoints).toHaveLength(1);
    expect(status.deliverables.pullRequestUrl).toBe('https://github.com/dj258255/test/pull/1');
  });
});

describe('buildProjectStatus — 위험·불확실성', () => {
  it('되묻는 질문·재확인 필요·사람이 할 일·실패 서비스·멈춘 리뷰를 모두 모은다', () => {
    const status = buildProjectStatus({
      ...baseInput,
      openQuestion: '결제 수단은 카드만 지원하나요?',
      requirements: [
        { id: 'R1', title: '주문 생성', priority: 'must', status: '재확인 필요' },
        { id: 'R2', title: '결제 연동', priority: 'must', status: '실패' },
      ],
      manualSteps: ['저장소 webhook 설정'],
      failedServices: ['api'],
      reviewState: { state: 'stopped', rounds: 2 },
    });
    expect(status.risks.items).toEqual([
      '되묻는 질문이 멈춰 있습니다: 결제 수단은 카드만 지원하나요?',
      '재확인 필요 1개: [R1] 주문 생성',
      '실패 1개: [R2] 결제 연동',
      '사람이 할 일이 1개 남아 있습니다(에이전트가 하지 않습니다)',
      '서비스 실패: api',
      'PR 자동 리뷰가 멈췄습니다 — 확인이 필요합니다',
    ]);
  });

  it('문제가 없으면 빈 목록이다', () => {
    const status = buildProjectStatus(baseInput);
    expect(status.risks.items).toEqual([]);
  });
});

describe('buildProjectStatus — 검증 기록', () => {
  it('요구사항이 없으면 집계할 수 없다고 말한다', () => {
    const status = buildProjectStatus(baseInput);
    expect(status.verification.summary).toContain('없어');
    expect(status.verification.byStatus).toEqual({});
  });

  it('상태별 개수를 집계한다', () => {
    const status = buildProjectStatus({
      ...baseInput,
      requirements: [
        { id: 'R1', title: 'a', priority: 'must', status: '검증됨' },
        { id: 'R2', title: 'b', priority: 'must', status: '검증됨' },
        { id: 'R3', title: 'c', priority: 'should', status: '미착수' },
      ],
    });
    expect(status.verification.summary).toBe('3개 중 2개 검증됨');
    expect(status.verification.byStatus).toEqual({ 검증됨: 2, 미착수: 1 });
  });
});

describe('buildProjectStatus — 예상 vs 실제', () => {
  it('예상·실제 둘 다 있으면 차이를 계산하고, 하나만 있으면 있는 값만 담는다', () => {
    const status = buildProjectStatus({
      ...baseInput,
      estimates: [
        { id: 't1', label: '백엔드 작업', estimateMinutes: 60, actualMinutes: 90, note: '마이그레이션이 더 걸림' },
        { id: 't2', label: '문서만', actualMinutes: 10 },
        { id: 't3', label: '예상만', estimateMinutes: 30 },
      ],
    });
    expect(status.estimateVsActual).toEqual([
      { id: 't1', label: '백엔드 작업', estimateMinutes: 60, actualMinutes: 90, deltaMinutes: 30, note: '마이그레이션이 더 걸림' },
      { id: 't2', label: '문서만', actualMinutes: 10 },
      { id: 't3', label: '예상만', estimateMinutes: 30 },
    ]);
  });
});

describe('buildProjectStatus — 링크', () => {
  it('ROADMAP·CHANGELOG·문서 색인 경로를 그대로 전달한다', () => {
    const status = buildProjectStatus(baseInput);
    expect(status.links).toEqual({ roadmap: 'docs/ROADMAP.md', changelog: 'CHANGELOG.md', docsIndex: 'docs/README.md' });
  });
});
