import { describe, expect, it } from 'vitest';
import {
  buildDesignPipelineDocTemplate,
  buildDesignPipelineRequestPrompt,
  checkDesignApproval,
  DesignDocRecordSchema,
  deriveDesignPipelineResult,
  designPipelineDocPath,
  designPipelineSidecarPath,
  isDesignPipelineDocPath,
  nextDesignPipelineDocNumber,
  parseDesignBundlesTable,
  reviewIndependence,
  type DesignDocRecord,
} from './design-pipeline';

describe('designPipelineDocPath · nextDesignPipelineDocNumber', () => {
  it('비어 있으면 1번부터 시작한다', () => {
    expect(nextDesignPipelineDocNumber([])).toBe(1);
    expect(designPipelineDocPath(1, '채팅 입력 설계')).toBe('docs/design/01-채팅-입력-설계.md');
  });

  it('기존 설계 파이프라인 문서 중 가장 큰 번호 다음을 고른다', () => {
    const existing = ['docs/design/01-a.md', 'docs/design/03-b.md', 'docs/02-다른-설계노트.md', 'docs/README.md'];
    expect(nextDesignPipelineDocNumber(existing)).toBe(4);
  });

  it('docs/NN-제목.md(기존 설계 노트)는 docs/design/ 패턴과 겹치지 않는다', () => {
    expect(isDesignPipelineDocPath('docs/02-다른-설계노트.md')).toBe(false);
    expect(isDesignPipelineDocPath('docs/design/02-제목.md')).toBe(true);
  });

  it('사이드카 경로는 .meta.json으로 바꾼다', () => {
    expect(designPipelineSidecarPath('docs/design/01-a.md')).toBe('docs/design/01-a.meta.json');
  });
});

describe('buildDesignPipelineRequestPrompt · buildDesignPipelineDocTemplate', () => {
  it('요구사항 id를 프롬프트에 넣는다', () => {
    const prompt = buildDesignPipelineRequestPrompt({ title: '채팅 입력', requirementIds: ['R1', 'R2'] });
    expect(prompt).toContain('R1, R2');
    expect(prompt).toContain('작업 묶음');
    expect(prompt).toContain('지금은 파일을 바꾸지 말고');
  });

  it('요구사항 id가 없으면 "해당 없음"을 쓴다', () => {
    const prompt = buildDesignPipelineRequestPrompt({ title: '채팅 입력', requirementIds: [] });
    expect(prompt).toContain('(해당 없음)');
  });

  it('기본 틀에도 같은 절 제목이 들어간다', () => {
    const template = buildDesignPipelineDocTemplate(2, '채팅 입력', ['R3']);
    expect(template).toContain('# 02. 채팅 입력');
    expect(template).toContain('R3');
    expect(template).toContain('## 작업 묶음');
  });
});

describe('parseDesignBundlesTable', () => {
  const markdown = `# 01. 제목

## 작업 묶음

| 묶음 | 완료 조건 | 예상 시간(분) | 결과물 | 쓰기 범위 |
| --- | --- | --- | --- | --- |
| B1 입력 폼 | 버튼이 눌린다 | 30-60 | 폼 컴포넌트 | apps/studio/components/x.tsx, apps/studio/lib/y.ts |
| B2 저장 API | 저장된다 | 45 | API 라우트 | apps/studio/app/api/z/route.ts |

## 위험·불확실성
`;

  it('표의 각 행을 구조화한다', () => {
    const bundles = parseDesignBundlesTable(markdown);
    expect(bundles).toHaveLength(2);
    expect(bundles[0]).toMatchObject({
      id: 'B1',
      title: '입력 폼',
      doneCondition: '버튼이 눌린다',
      estimateMinMinutes: 30,
      estimateMaxMinutes: 60,
      deliverable: '폼 컴포넌트',
      writableScope: ['apps/studio/components/x.tsx', 'apps/studio/lib/y.ts'],
    });
  });

  it('단일 숫자 예상 시간은 최소·최대가 같다', () => {
    const bundles = parseDesignBundlesTable(markdown);
    expect(bundles[1]).toMatchObject({ id: 'B2', estimateMinMinutes: 45, estimateMaxMinutes: 45 });
  });

  it('표를 찾지 못하면 빈 배열을 돌려준다(차단하지 않는다)', () => {
    expect(parseDesignBundlesTable('본문만 있고 표가 없습니다')).toEqual([]);
  });
});

function design(overrides: Partial<DesignDocRecord> = {}): DesignDocRecord {
  return {
    path: 'docs/design/01-a.md',
    number: 1,
    title: '채팅 입력',
    requirementIds: ['R1', 'R2'],
    bundles: [],
    status: 'draft',
    createdAt: '2026-01-01T00:00:00.000Z',
    createdBy: 'tester',
    ...overrides,
  };
}

describe('DesignDocRecordSchema', () => {
  it('유효한 레코드를 받아들인다', () => {
    expect(() => DesignDocRecordSchema.parse(design())).not.toThrow();
  });

  it('status가 draft·approved가 아니면 거부한다', () => {
    expect(() => DesignDocRecordSchema.parse({ ...design(), status: 'done' })).toThrow();
  });
});

describe('checkDesignApproval', () => {
  it('요청에 언급된 요구사항을 다루는 설계가 없으면 막지 않는다(옵트인)', () => {
    const result = checkDesignApproval(['R9'], [design()]);
    expect(result.blocked).toBe(false);
  });

  it('요청 안의 요구사항 id가 승인되지 않은 설계에 걸리면 막는다', () => {
    const result = checkDesignApproval(['R1'], [design({ status: 'draft' })]);
    expect(result.blocked).toBe(true);
    expect(result.blockingDocs).toHaveLength(1);
  });

  it('그 설계가 승인됐으면 막지 않는다', () => {
    const result = checkDesignApproval(['R1'], [design({ status: 'approved', approvedBy: 'owner', approvedAt: '2026-01-02T00:00:00.000Z' })]);
    expect(result.blocked).toBe(false);
  });

  it('요청에 요구사항 id가 전혀 없으면 막지 않는다', () => {
    expect(checkDesignApproval([], [design()]).blocked).toBe(false);
  });
});

describe('reviewIndependence', () => {
  it('같은 계열이면 same-family', () => {
    expect(reviewIndependence('claude', 'claude')).toBe('same-family');
  });
  it('다른 계열이면 independent', () => {
    expect(reviewIndependence('claude', 'openai')).toBe('independent');
  });
  it('어느 한쪽이라도 모르면 unknown', () => {
    expect(reviewIndependence('claude', 'unknown')).toBe('unknown');
    expect(reviewIndependence('unknown', 'openai')).toBe('unknown');
  });
});

describe('deriveDesignPipelineResult', () => {
  const approved = design({ status: 'approved', approvedBy: 'owner', approvedAt: '2026-01-02T00:00:00.000Z' });
  const independentReview = { ran: true, passed: true, independence: 'independent' as const };
  const passingVerification = { ran: true, ok: true, testsRerun: true };

  it('완료는 구현 체크포인트만 본다 — 검토·검증 전에도 true', () => {
    const result = deriveDesignPipelineResult({ design: approved, implementationCheckpointExists: true });
    expect(result.completed).toBe(true);
    expect(result.succeeded).toBe(false);
  });

  it('독립 검토 + 검증 재실행 통과 + 승인 + 완료가 모두 있어야 성공', () => {
    const result = deriveDesignPipelineResult({
      design: approved,
      implementationCheckpointExists: true,
      review: independentReview,
      verification: passingVerification,
    });
    expect(result.succeeded).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it('같은 계열 검토는 성공으로 세지 않고 이유를 남긴다', () => {
    const result = deriveDesignPipelineResult({
      design: approved,
      implementationCheckpointExists: true,
      review: { ran: true, passed: true, independence: 'same-family' },
      verification: passingVerification,
    });
    expect(result.succeeded).toBe(false);
    expect(result.reasons).toContain('같은 계열 검토(독립성 낮음)');
  });

  it('검토를 돌리지 못했으면 침묵 통과하지 않고 "검토 못 함"을 남긴다', () => {
    const result = deriveDesignPipelineResult({
      design: approved,
      implementationCheckpointExists: true,
      review: { ran: false, passed: false, independence: 'unknown' },
      verification: passingVerification,
    });
    expect(result.succeeded).toBe(false);
    expect(result.reasons).toContain('검토 못 함');
  });

  it('검증을 테스트 재실행 없이 통과했으면 성공이 아니다', () => {
    const result = deriveDesignPipelineResult({
      design: approved,
      implementationCheckpointExists: true,
      review: independentReview,
      verification: { ran: true, ok: true, testsRerun: false },
    });
    expect(result.succeeded).toBe(false);
    expect(result.reasons).toContain('테스트를 다시 돌리지 않았습니다');
  });

  it('승인 전이면 성공일 수 없다', () => {
    const result = deriveDesignPipelineResult({
      design: design({ status: 'draft' }),
      implementationCheckpointExists: true,
      review: independentReview,
      verification: passingVerification,
    });
    expect(result.succeeded).toBe(false);
    expect(result.reasons).toContain('설계가 승인되지 않았습니다');
  });
});
