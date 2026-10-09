import { describe, expect, it } from 'vitest';
import { discoverJsFile, flattenDiscoveredFile, type Requirement } from '@b-studio/agent';
import {
  buildMatrixTestRunRows,
  buildRequirementTestRunEvidence,
  evaluateRequirement,
  type TestServiceView,
} from './sessions';

/**
 * 요구사항 "검증됨" 판정 규칙(ADR-155): 시나리오 id만 단 테스트도 부모 요구사항의 근거이고, 시나리오가 있는
 * 요구사항은 시나리오가 전부 확인돼야 테스트 근거만으로 "검증됨"이 된다. 실제 세션 5b640fd3의 R14·R15·R9 꼴을
 * 임시 데이터로 옮겼다. 가짜 객체만 쓴다 — 샌드박스·모델·GitHub·네트워크를 부르지 않는다.
 */
const head = { sha: 'abc123', shortSha: 'abc123' };

function row(name: string, ids: string[], status: 'pass' | 'fail' | 'skip' | 'not-run' = 'pass'): TestServiceView['rows'][number] {
  return {
    file: 'OrderTest.java',
    framework: 'junit' as TestServiceView['rows'][number]['framework'],
    suitePath: [],
    name,
    displayName: name,
    line: 1,
    skipped: false,
    requirementIds: ids,
    status,
  };
}

function service(rows: TestServiceView['rows']): TestServiceView {
  return {
    service: 'api',
    template: 'spring-boot',
    running: false,
    supported: true,
    counts: { pass: 0, fail: 0, skip: 0, notRun: 0 },
    rows,
    lastRunSha: head.sha,
    lastRunAt: '2026-01-01T09:17:00.000Z',
  };
}

function requirement(id: string, scenarioCount: number, extra: Partial<Requirement> = {}): Requirement {
  return {
    id,
    title: `${id} 요구사항`,
    kind: 'api',
    priority: 'must',
    acceptance: ['동작한다'],
    scenarios: Array.from({ length: scenarioCount }, (_, index) => ({ id: `${id}.${index + 1}`, given: 'g', when: 'w', then: 't' })),
    ...extra,
  } as Requirement;
}

function evaluate(target: Requirement, rows: TestServiceView['rows'], gateChecks: Array<{ name: string; ok: boolean }> = []) {
  const services = [service(rows)];
  return evaluateRequirement(
    target,
    [],
    [],
    gateChecks,
    undefined,
    buildRequirementTestRunEvidence(services, target.id, head, 0),
    undefined,
    buildMatrixTestRunRows(services, head, 0),
  );
}

describe('buildRequirementTestRunEvidence — 시나리오 id 테스트는 부모 요구사항의 근거다', () => {
  it('R14.1을 단 통과 행이 R14의 passed에 들어간다', () => {
    const evidence = buildRequirementTestRunEvidence([service([row('R14.1: 마지막 1개', ['R14.1'])])], 'R14', head, 0);
    expect(evidence).toMatchObject({ passed: 1, failed: 0 });
  });

  it('시나리오 id 테스트가 실패하면 부모의 failed에 들어간다', () => {
    const evidence = buildRequirementTestRunEvidence([service([row('R14.1: 마지막 1개', ['R14.1'], 'fail')])], 'R14', head, 0);
    expect(evidence).toMatchObject({ passed: 0, failed: 1 });
  });

  it('R13.1·R14.1을 함께 단 테스트는 각 부모에 한 번씩 센다', () => {
    const services = [service([row('R13.1·R14.1: 함께', ['R13.1', 'R14.1'])])];
    expect(buildRequirementTestRunEvidence(services, 'R13', head, 0)).toMatchObject({ passed: 1 });
    expect(buildRequirementTestRunEvidence(services, 'R14', head, 0)).toMatchObject({ passed: 1 });
  });

  it('한 테스트가 R14와 R14.1을 같이 달아도 R14에는 한 번만 센다', () => {
    const services = [service([row('R14 R14.1: 둘 다', ['R14', 'R14.1'])])];
    expect(buildRequirementTestRunEvidence(services, 'R14', head, 0)).toMatchObject({ passed: 1 });
  });

  it('R1의 근거에 R10.1이나 R11을 섞지 않는다', () => {
    const services = [service([row('R10.1', ['R10.1']), row('R11', ['R11'])])];
    expect(buildRequirementTestRunEvidence(services, 'R1', head, 0)).toBeUndefined();
  });
});

describe('evaluateRequirement — 시나리오가 있는 요구사항의 검증됨 판정(ADR-155)', () => {
  it('R14 꼴: 시나리오 id만 단 통과 테스트가 시나리오 전부를 덮으면 부모가 검증됨이다', () => {
    const view = evaluate(requirement('R14', 2), [row('R14.1: 마지막 1개', ['R14.1']), row('R14.2: 매진 상태', ['R14.2'])]);
    expect(view.status).toBe('검증됨');
    expect(view.verifiedBy).toBe('test');
    expect(view.evidence.testRun).toMatchObject({ passed: 2, failed: 0 });
    expect(view.evidence.missingScenarios).toBeUndefined();
  });

  it('R15 꼴: 요구사항 id만 단 통과 테스트가 있어도 시나리오가 미확인이면 작업 중이고 누락 목록이 남는다', () => {
    const view = evaluate(requirement('R15', 1), [row('R12·R15: Redis 선점 실패면 즉시 거절한다', ['R12', 'R15'])]);
    expect(view.status).toBe('작업 중');
    expect(view.verifiedBy).toBe('none');
    expect(view.evidence.testRun).toMatchObject({ passed: 1 });
    expect(view.evidence.missingScenarios).toEqual(['R15.1']);
  });

  it('R9 꼴: 시나리오 일부만 확인되면 작업 중이고 남은 시나리오만 목록에 남는다', () => {
    const view = evaluate(requirement('R9', 3), [row('R9.1', ['R9.1']), row('R9.2', ['R9.2'])]);
    expect(view.status).toBe('작업 중');
    expect(view.evidence.missingScenarios).toEqual(['R9.3']);
  });

  it('시나리오가 없는 요구사항은 요구사항 id 테스트 통과로 검증됨이다(기존과 같다)', () => {
    const view = evaluate(requirement('R1', 0), [row('R1: 주문', ['R1'])]);
    expect(view.status).toBe('검증됨');
    expect(view.verifiedBy).toBe('test');
  });

  it('시나리오 id 테스트가 실패하면 부모가 실패다', () => {
    const view = evaluate(requirement('R14', 2), [row('R14.1', ['R14.1']), row('R14.2', ['R14.2'], 'fail')]);
    expect(view.status).toBe('실패');
  });

  it('요구사항 id 테스트가 실패하면 시나리오가 미확인이어도 실패다(실패가 우선)', () => {
    const view = evaluate(requirement('R15', 1), [row('R15: 실패', ['R15'], 'fail')]);
    expect(view.status).toBe('실패');
  });

  it('사람 확인이 있으면 시나리오 테스트가 없어도 검증됨이고, 출처는 사람 확인이다', () => {
    const manual = requirement('R15', 1, { manualVerification: { by: '범수', at: '2026-10-01', sha: 'a', note: 'k6 p95 직접 측정' } });
    const view = evaluate(manual, []);
    expect(view.status).toBe('검증됨');
    expect(view.verifiedBy).toBe('manual');
  });

  it('일부 시나리오만 테스트로 확인하고 나머지를 사람이 확인했으면 검증됨이고, 출처는 사람 확인이다(자동 근거가 전부를 덮지 못했다)', () => {
    const manual = requirement('R9', 3, { manualVerification: { by: '범수', at: '2026-10-01', sha: 'a', note: '나머지는 직접 확인' } });
    const view = evaluate(manual, [row('R9.1', ['R9.1'])]);
    expect(view.status).toBe('검증됨');
    expect(view.verifiedBy).toBe('manual');
    expect(view.evidence.missingScenarios).toEqual(['R9.2', 'R9.3']);
  });

  it('사람 확인이 있어도 실패한 시나리오 테스트가 있으면 실패다', () => {
    const manual = requirement('R9', 2, { manualVerification: { by: '범수', at: '2026-10-01', sha: 'a', note: 'x' } });
    const view = evaluate(manual, [row('R9.1', ['R9.1'], 'fail')]);
    expect(view.status).toBe('실패');
  });

  it('요구사항 id를 단 게이트 확인이 통과해도 시나리오가 미확인이면 작업 중이다', () => {
    const view = evaluate(requirement('R15', 1), [], [{ name: 'R15 부하 점검', ok: true }]);
    expect(view.status).toBe('작업 중');
  });

  it('시나리오 id를 단 게이트 확인이 시나리오를 전부 덮으면 검증됨이다', () => {
    const view = evaluate(requirement('R15', 1), [], [{ name: 'R15.1 부하 점검', ok: true }]);
    expect(view.status).toBe('검증됨');
    expect(view.verifiedBy).toBe('test');
  });
});

describe('묶음(describe) 제목의 id가 시나리오 판정에 닿는 방식(ADR-155 개정)', () => {
  const rowsOf = (...lines: string[]) =>
    flattenDiscoveredFile(discoverJsFile('web/src/liveOrder.test.ts', lines.join('\n'), 'vitest')).map((discovered) =>
      row(discovered.name, discovered.requirementIds),
    );

  it('R11.1·R11.2를 describe 제목에만 달아도 통과하면 R11이 검증됨이다', () => {
    const rows = rowsOf(
      "describe('R11.1: 승인', () => {",
      "  it('완료가 된다', () => {});",
      '});',
      "describe('R11.2: 실패', () => {",
      "  it('사유를 담는다', () => {});",
      "  it('기본 문구를 쓴다', () => {});",
      '});',
    );
    const view = evaluate(requirement('R11', 2), rows);
    expect(view.status).toBe('검증됨');
    expect(view.evidence.missingScenarios).toBeUndefined();
    expect(view.evidence.testRun).toMatchObject({ passed: 3, failed: 0 });
  });

  it('describe에 요구사항 id(R11)만 달면 그 안의 모든 테스트가 R11의 근거지만 시나리오가 없으니 여전히 작업 중이다', () => {
    const rows = rowsOf("describe('R11 방송 중 주문', () => {", "  it('완료가 된다', () => {});", "  it('사유를 담는다', () => {});", '});');
    expect(rows.every((candidate) => candidate.requirementIds.join() === 'R11')).toBe(true);
    const view = evaluate(requirement('R11', 2), rows);
    expect(view.status).toBe('작업 중');
    expect(view.verifiedBy).toBe('none');
    expect(view.evidence.testRun).toMatchObject({ passed: 2 });
    expect(view.evidence.missingScenarios).toEqual(['R11.1', 'R11.2']);
  });

  it('묶음에 R11, 안쪽 묶음에 R11.1만 있으면 R11.2는 남는다', () => {
    const rows = rowsOf("describe('R11 방송 중 주문', () => {", "  describe('R11.1: 승인', () => {", "    it('완료가 된다', () => {});", '  });', '});');
    const view = evaluate(requirement('R11', 2), rows);
    expect(view.status).toBe('작업 중');
    expect(view.evidence.missingScenarios).toEqual(['R11.2']);
  });

  it('묶음과 제목에 같은 시나리오 id가 중복돼도 통과 수는 한 번만 센다', () => {
    const rows = rowsOf("describe('R11.1: 승인', () => {", "  it('R11.1 완료가 된다', () => {});", '});');
    expect(rows[0]!.requirementIds).toEqual(['R11.1']);
    expect(buildRequirementTestRunEvidence([service(rows)], 'R11', head, 0)).toMatchObject({ passed: 1 });
  });
});
