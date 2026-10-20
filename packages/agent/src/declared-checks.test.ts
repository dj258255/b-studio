import type { WorkflowSpec } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import { describeDeclaredCheckChange, diffDeclaredChecks, hasDeclaredCheckChange, weakenedDeclarations, withDeclaredChecks } from './declared-checks';

const unit = { name: 'unit', service: 'api', command: ['./gradlew', 'test'], maxAttempts: 1 };
const page = { service: 'web', path: '/cart', mode: 'http' as const, expectStatus: 200, allowConsoleErrors: false, noHorizontalScroll: false };
const load = { name: 'orders-p95', service: 'api', method: 'GET' as const, path: '/orders', concurrent: 100, warmup: 0, expect: { p95Ms: 200 } };

describe('diffDeclaredChecks', () => {
  it('더한 것·지운 것·바뀐 것을 선언의 이름으로 알린다', () => {
    const started = { tests: [unit], pageChecks: [page], loadChecks: [load] } as WorkflowSpec;
    const latest = { tests: [{ ...unit, command: ['true'] }], loadChecks: [load, { ...load, name: 'detail-p95' }], required: ['run', 'review'] } as WorkflowSpec;
    const change = diffDeclaredChecks(started, latest);
    expect(change).toEqual({ added: ['부하 detail-p95', '필수 단계'], removed: ['화면 web /cart'], changed: ['테스트 unit'] });
    expect(hasDeclaredCheckChange(change)).toBe(true);
    expect(describeDeclaredCheckChange(change)).toBe('추가: 부하 detail-p95, 필수 단계 · 삭제: 화면 web /cart · 변경: 테스트 unit');
  });

  it('같으면 변경이 없다. workflow가 없던 것과 빈 것도 같다', () => {
    expect(hasDeclaredCheckChange(diffDeclaredChecks({ tests: [unit] } as WorkflowSpec, { tests: [unit] } as WorkflowSpec))).toBe(false);
    expect(hasDeclaredCheckChange(diffDeclaredChecks(undefined, {} as WorkflowSpec))).toBe(false);
  });

  it('실행 정책만 바뀐 것은 선언의 변경이 아니다', () => {
    const change = diffDeclaredChecks({ tests: [unit], protectedPaths: ['.env'] } as WorkflowSpec, { tests: [unit], protectedPaths: [], allowedTools: ['read_file'], maxChangedFiles: 99 } as WorkflowSpec);
    expect(hasDeclaredCheckChange(change)).toBe(false);
  });

  it('같은 화면을 두 번 확인하면 둘째부터 번호로 구별한다', () => {
    const second = { ...page, expectText: '주문하기' };
    const change = diffDeclaredChecks({ pageChecks: [page, second] } as WorkflowSpec, { pageChecks: [page] } as WorkflowSpec);
    expect(change.removed).toEqual(['화면 web /cart #2']);
  });

  it('자동 화면 확인의 sample 값만 바뀐 것은 세지 않는다(허용 없이도 받아들이는 값이다)', () => {
    const auto = { service: 'web', mode: 'http' as const, maxPages: 5, expectStatus: 200 };
    const started = { autoPageChecks: auto } as unknown as WorkflowSpec;
    expect(hasDeclaredCheckChange(diffDeclaredChecks(started, { autoPageChecks: { ...auto, sampleParams: { id: '7' } } } as unknown as WorkflowSpec))).toBe(false);
    expect(diffDeclaredChecks(started, { autoPageChecks: { ...auto, maxPages: 1 } } as unknown as WorkflowSpec).changed).toEqual(['바뀐 페이지 자동 확인']);
  });
});

describe('weakenedDeclarations', () => {
  it('같으면 빈 목록이다', () => {
    expect(weakenedDeclarations({ tests: [unit], protectedPaths: ['.env'], maxChangedFiles: 3 } as WorkflowSpec, { tests: [unit], protectedPaths: ['.env'], maxChangedFiles: 3 } as WorkflowSpec)).toEqual([]);
    expect(weakenedDeclarations(undefined, {} as WorkflowSpec)).toEqual([]);
  });

  it('확인 선언의 삭제·변경은 약하게 바꾼 것이고 추가는 아니다', () => {
    const latest = { tests: [{ ...unit, command: ['true'] }], loadChecks: [load] } as WorkflowSpec;
    expect(weakenedDeclarations({ tests: [unit], pageChecks: [page] } as WorkflowSpec, latest)).toEqual(['삭제: 화면 web /cart', '변경: 테스트 unit']);
    // 더하기만 한 것은 약해진 것이 아니다
    expect(weakenedDeclarations({ tests: [unit] } as WorkflowSpec, { tests: [unit], loadChecks: [load] } as WorkflowSpec)).toEqual([]);
  });

  it('보호·실행 정책 목록에서 빠진 항목을 센다', () => {
    const started = { protectedPaths: ['api/src', '.env'], evaluationAssets: ['tests/acceptance'], deniedCommands: ['git push'], requireApprovalFor: ['write_file'], releaseRequires: ['test', 'checkpoint'] } as WorkflowSpec;
    const latest = { protectedPaths: ['.env'], evaluationAssets: [], deniedCommands: [], requireApprovalFor: ['write_file', 'run'], releaseRequires: ['checkpoint'] } as WorkflowSpec;
    expect(weakenedDeclarations(started, latest)).toEqual(['삭제: 보호 경로 api/src', '삭제: 평가 자산 tests/acceptance', '삭제: 금지 명령 git push', '삭제: 배포 조건 단계 test']);
    // 더한 것은 약해진 것이 아니다
    expect(weakenedDeclarations({ protectedPaths: ['.env'] } as WorkflowSpec, { protectedPaths: ['.env', 'api/src'] } as WorkflowSpec)).toEqual([]);
  });

  it('허용 도구 목록이 없어지거나 도구가 더해지면 약해진 것이다', () => {
    expect(weakenedDeclarations({ allowedTools: ['read_file'] } as WorkflowSpec, {} as WorkflowSpec)).toEqual(['삭제: 허용 도구(모든 도구 허용)']);
    expect(weakenedDeclarations({ allowedTools: ['read_file'] } as WorkflowSpec, { allowedTools: ['read_file', 'write_file'] } as WorkflowSpec)).toEqual(['추가: 허용 도구 write_file']);
    expect(weakenedDeclarations({ allowedTools: ['read_file', 'write_file'] } as WorkflowSpec, { allowedTools: ['read_file'] } as WorkflowSpec)).toEqual([]);
    // 시작할 때 목록이 없었으면(모든 도구 허용) 지금 목록을 보지 않는다
    expect(weakenedDeclarations({ } as WorkflowSpec, { allowedTools: ['read_file'] } as WorkflowSpec)).toEqual([]);
  });

  it('변경 파일 수 상한이 없어지거나 커지면 약해진 것이다', () => {
    expect(weakenedDeclarations({ maxChangedFiles: 3 } as WorkflowSpec, {} as WorkflowSpec)).toEqual(['삭제: 변경 파일 수 상한']);
    expect(weakenedDeclarations({ maxChangedFiles: 3 } as WorkflowSpec, { maxChangedFiles: 100 } as WorkflowSpec)).toEqual(['변경: 변경 파일 수 상한 3 → 100']);
    expect(weakenedDeclarations({ maxChangedFiles: 3 } as WorkflowSpec, { maxChangedFiles: 1 } as WorkflowSpec)).toEqual([]);
    expect(weakenedDeclarations({} as WorkflowSpec, { maxChangedFiles: 1 } as WorkflowSpec)).toEqual([]);
  });

  it('maxTurns는 보호가 아니므로 보지 않는다', () => {
    expect(weakenedDeclarations({ maxTurns: 20 } as WorkflowSpec, { maxTurns: 300 } as WorkflowSpec)).toEqual([]);
    expect(weakenedDeclarations({ maxTurns: 20 } as WorkflowSpec, {} as WorkflowSpec)).toEqual([]);
  });
});

describe('withDeclaredChecks', () => {
  it('확인 선언만 지금 것으로 바꾸고 실행 정책은 시작할 때의 것을 둔다', () => {
    const started = { tests: [unit], pageChecks: [page], protectedPaths: ['.env'], deniedCommands: ['git push'], maxChangedFiles: 3, releaseRequires: ['test', 'checkpoint'] } as WorkflowSpec;
    const latest = { tests: [], loadChecks: [load], protectedPaths: [], deniedCommands: [], maxChangedFiles: 100, releaseRequires: ['checkpoint'], allowedTools: ['write_file'] } as unknown as WorkflowSpec;
    expect(withDeclaredChecks(started, latest)).toEqual({ tests: [], loadChecks: [load], protectedPaths: ['.env'], deniedCommands: ['git push'], maxChangedFiles: 3, releaseRequires: ['test', 'checkpoint'] });
  });

  it('지금 파일에 workflow가 없으면 확인 선언이 모두 빠지고 정책만 남는다', () => {
    expect(withDeclaredChecks({ tests: [unit], protectedPaths: ['.env'] } as WorkflowSpec, undefined)).toEqual({ protectedPaths: ['.env'] });
    expect(withDeclaredChecks({ tests: [unit] } as WorkflowSpec, undefined)).toBeUndefined();
  });
});
