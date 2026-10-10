import type { WorkflowSpec } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import { describeDeclaredCheckChange, diffDeclaredChecks, hasDeclaredCheckChange, withDeclaredChecks } from './declared-checks';

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
