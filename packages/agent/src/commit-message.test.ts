import { describe, expect, it } from 'vitest';
import { classifyCommit, generateCommitSubject, toCommitMood } from './commit-message';
import type { PendingChange } from './checkpoints';
import { buildPrReviewFixRequest, type PrReviewFinding } from './pr-review';

function change(file: string, kind: PendingChange['change'] = 'modified'): PendingChange {
  return { file, change: kind };
}

describe('classifyCommit', () => {
  it('바뀐 파일이 전부 테스트 파일이면 test로 본다', () => {
    expect(classifyCommit('주문 서비스 테스트 추가', [change('api/src/test/java/OrderTest.java', 'added')])).toBe('test');
    expect(classifyCommit('프런트 테스트', [change('web/app/orders/page.test.tsx', 'added')])).toBe('test');
    expect(classifyCommit('pytest 추가', [change('api/tests/test_orders.py', 'added')])).toBe('test');
  });

  it('바뀐 파일이 전부 문서 파일이면 docs로 본다', () => {
    expect(classifyCommit('README 정리', [change('README.md')])).toBe('docs');
    expect(classifyCommit('요구사항 문서', [change('docs/requirements.md')])).toBe('docs');
  });

  it('바뀐 파일이 전부 새 파일이면 feat로 본다', () => {
    expect(classifyCommit('주문 취소 API 추가', [change('api/src/main/java/CancelOrder.java', 'added')])).toBe('feat');
  });

  it('테스트·문서·새 파일이 아니면 요청 글의 낱말로 fix·refactor·chore를 고르고, 없으면 feat로 둔다', () => {
    expect(classifyCommit('주문 서비스 구조 정리(리팩터링)', [change('api/src/main/java/Order.java')])).toBe('refactor');
    expect(classifyCommit('의존성 버전 올리기', [change('api/build.gradle')])).toBe('chore');
    expect(classifyCommit('주문에 메모 필드 추가', [change('api/src/main/java/Order.java')])).toBe('feat');
    expect(classifyCommit('대시보드가 로딩에서 멈추는 버그를 고쳐 줘', [change('web/app/dashboard/page.tsx')])).toBe('fix');
  });

  it('바뀐 파일이 섞여 있으면(테스트+일반) test·docs·feat 전용 규칙에 걸리지 않는다', () => {
    expect(classifyCommit('메모 필드 추가', [change('api/src/main/java/Order.java'), change('api/src/test/java/OrderTest.java', 'added')])).toBe('feat');
  });
});

describe('generateCommitSubject', () => {
  it('"타입: 요약" 형식으로 만들고 72자를 넘지 않는다', () => {
    const subject = generateCommitSubject('주문에 메모 필드 추가', [change('api/src/main/java/Order.java')]);
    expect(subject).toBe('feat: 주문에 메모 필드 추가');
    expect(subject.length).toBeLessThanOrEqual(72);
  });

  it('긴 요청은 단어 경계에서 잘라 72자를 넘기지 않는다', () => {
    const longRequest = '주문 목록 화면에 필터와 정렬, 페이지네이션과 검색창을 추가하고 모바일 화면 크기에서도 잘 보이도록 반응형으로 손보고 접근성도 함께 개선해 주세요';
    const subject = generateCommitSubject(longRequest, [change('web/app/orders/page.tsx', 'added')]);
    expect(subject.length).toBeLessThanOrEqual(72);
    expect(subject.startsWith('feat: ')).toBe(true);
    expect(longRequest.startsWith(subject.slice('feat: '.length))).toBe(true);
  });

  it('여러 줄 요청은 첫 줄만 쓴다', () => {
    expect(generateCommitSubject('메모 필드 추가\n\n상세 설명은 여기', [change('api/src/main/java/Order.java')])).toBe('feat: 메모 필드 추가');
  });

  it('빈 요청은 "체크포인트"로 대신한다', () => {
    expect(generateCommitSubject('   ', [change('api/src/main/java/Order.java')])).toBe('feat: 체크포인트');
  });

  it('여러 문장으로 된 요청은 첫 문장만 쓰고, 뒷 문장이 제목에 그대로 끌려오지 않는다(도그푸딩 버그 리포트)', () => {
    const request =
      '.env.example 파일을 만들어 주세요. 코드에서 읽는 환경 변수(NEXT_PUBLIC_API_BASE_URL, DATABASE_URL)를 모두 담되 실제 값 대신 예시 값을 넣고, 실제 비밀 값이 든 .env는 커밋하지 마세요.';
    const subject = generateCommitSubject(request, [change('.env.example', 'added')]);
    expect(subject).toBe('feat: .env.example 파일을 만든다');
    expect(subject).not.toContain('코드에서 읽는');
    expect(subject.length).toBeLessThanOrEqual(72);
  });

  it('요청 글이 부탁 어미뿐이라 알맹이가 없으면(해주세요) 에이전트 요약 첫 문장으로 대신한다', () => {
    const subject = generateCommitSubject('해주세요', [change('README.md')], 'README에 설계 결정과 환경 변수 예시 절을 추가했습니다.\n\n세부 설명은 아래에.');
    expect(subject).toBe('docs: README에 설계 결정과 환경 변수 예시 절을 추가했습니다');
  });

  it('요청 글이 분명하면(알맹이가 있으면) 에이전트 요약보다 요청 글을 우선한다(AI 리뷰 고침 요청처럼 사람이 부탁한 맥락을 유지한다)', () => {
    const subject = generateCommitSubject('AI 리뷰 지적을 고쳐 주세요', [change('api/src/main/java/Order.java')], '고쳤습니다.');
    expect(subject).toContain('AI 리뷰');
  });

  it('요청 글도 요약도 분명하지 않으면 바뀐 파일에서 제목을 뽑는다', () => {
    const subject = generateCommitSubject('해주세요', [change('.env.example', 'added')]);
    expect(subject).toBe('feat: 환경 변수 예시를 더한다');
  });

  it('제목에 부탁하는 말투("해 주세요")를 남기지 않는다', () => {
    const request = '대시보드 로딩 버그를 고쳐 주세요. 재현 방법은 콘솔을 열고 새로고침하면 됩니다.';
    const subject = generateCommitSubject(request, [change('web/app/dashboard/page.tsx')]);
    expect(subject).not.toMatch(/해\s*주세요/);
  });

  it('요청 첫 문장이 "앞 실행이 …"처럼 상황 설명이면 제목 후보에서 빼고 에이전트 요약의 "범위:" 줄을 쓴다(실측: 세션 5b640fd3, 체크포인트 57cced6)', () => {
    const request = '앞 실행이 턴 상한에 걸려 변경이 모두 되돌려졌습니다. 범위를 줄여 다시 해 주세요. 이번에는 R22만 합니다.';
    const summary = '작업을 마쳤습니다.\n범위: shorts 숏폼 상태 머신과 V74 마이그레이션, R22 테스트를 추가했습니다.';
    const changes = [
      change('apps/commerce/src/shorts/state-machine.ts'),
      change('apps/commerce/src/shorts/migrations/V74__add_shorts_state.sql', 'added'),
      change('apps/commerce/src/shorts/__tests__/r22.test.ts', 'added'),
    ];
    const subject = generateCommitSubject(request, changes, summary);
    expect(subject).not.toContain('앞 실행');
    expect(subject).not.toContain('턴 상한');
    expect(subject).not.toContain('되돌려');
    expect(subject).toContain('shorts');
  });

  it('상황 설명 첫 문장이고 에이전트 요약도 없으면 요청의 요구사항 id와 바뀐 파일의 공통 모듈로 제목을 만든다', () => {
    const request = '앞 실행이 턴 상한에 걸려 변경이 모두 되돌려졌습니다. 범위를 줄여 다시 해 주세요. 이번에는 R22만 합니다.';
    const changes = [
      change('apps/commerce/src/shorts/state-machine.ts'),
      change('apps/commerce/src/shorts/migrations/V74__add_shorts_state.sql', 'added'),
      change('apps/commerce/src/shorts/__tests__/r22.test.ts', 'added'),
    ];
    const subject = generateCommitSubject(request, changes);
    expect(subject).toBe('feat: [R22] shorts 모듈을 고친다');
  });

  it('네트워크 끊김처럼 다른 상황 설명 낱말도 제목 후보에서 뺀다', () => {
    expect(() => generateCommitSubject('네트워크가 끊겨서 다시 시도합니다.', [change('api/src/main/java/Order.java')])).not.toThrow();
    const subject = generateCommitSubject('네트워크가 끊겨서 다시 시도합니다.', [change('api/src/main/java/Order.java')]);
    expect(subject).not.toContain('네트워크');
  });

  it('완료 요약 첫 줄이 "검토 결과…이미 완성되어 있었습니다"처럼 경과 보고면("범위:" 줄도 없으면) 제목 후보에서 빼고 요구사항 id와 공통 모듈로 제목을 만든다(실측: 세션 5b640fd3, 체크포인트 15ba740)', () => {
    const request = '앞 실행이 턴 상한에 걸려 변경이 모두 되돌려졌습니다. R21 작업을 이어서 해 주세요.';
    const summary = '검토 결과, 이전 턴에서 복구된 9개 파일(R21 구현)은 이미 완성되어 있었습니다 — 추가로 만들 것이 없어 검증만 했습니다.';
    const changes = [
      change('apps/commerce/src/shorts/state-machine.ts'),
      change('apps/commerce/src/shorts/migrations/V74__add_shorts_state.sql'),
      change('apps/commerce/src/shorts/__tests__/r21.test.ts'),
    ];
    const subject = generateCommitSubject(request, changes, summary);
    expect(subject).not.toContain('검토 결과');
    expect(subject).not.toContain('이미');
    expect(subject).not.toContain('추가로');
    expect(subject).toBe('feat: [R21] shorts 모듈을 고친다');
  });

  it('"확인해 보니"·"추가로 …것이 없어"처럼 다른 경과 보고 말투도 제목 후보에서 뺀다', () => {
    // 요청을 물음표로 끝내 1번 규칙(요청 첫 문장)이 바로 걸러지게 하고, 2번 규칙(요약 첫 줄)만 따로 본다
    const summary = '확인해 보니 이미 구현이 끝나 있었고, 추가로 고칠 것이 없어 검증만 진행했습니다.';
    const subject = generateCommitSubject('이어서 진행할까요?', [change('apps/commerce/src/shorts/state-machine.ts')], summary);
    expect(subject).not.toContain('확인해 보니');
    expect(subject).not.toContain('추가로');
  });

  it('요청이 "R25를 해 주세요."처럼 부탁 어미를 떼고 나면 요구사항 id+조사 조각만 남으면 에이전트 요약으로 대신한다(도그푸딩 버그 리포트: 제목이 "feat: R25를"이 됐다)', () => {
    const request = 'R25를 해 주세요.';
    const summary = 'shorts 모듈을 R25(숏폼↔상품 다중 연결)까지 확장했습니다.\n\n세부 설명은 아래에.';
    const subject = generateCommitSubject(request, [change('apps/commerce/src/shorts/link.ts')], summary);
    expect(subject).not.toBe('feat: R25를');
    expect(subject).toBe('feat: shorts 모듈을 R25(숏폼↔상품 다중 연결)까지 확장했습니다');
  });

  it('부탁 어미를 뗀 뒤 "R26의 백엔드 부분을"처럼 목적격 조사로 끝나는 명사구만 남아도 요청 글을 제목으로 쓰지 않는다(도그푸딩 버그 리포트)', () => {
    const request = 'R26의 백엔드 부분을 해 주세요.';
    const summary = '숏폼 피드 API에 커서 기반 페이지네이션과 다음 영상 미리 불러오기 힌트를 더했습니다.';
    const subject = generateCommitSubject(request, [change('apps/commerce/src/shorts/feed.ts')], summary);
    expect(subject).not.toBe('feat: R26의 백엔드 부분을');
    expect(subject).toBe('feat: 숏폼 피드 API에 커서 기반 페이지네이션과 다음 영상 미리 불러오기 힌트를 더했습니다');
  });

  it('동사가 살아 있는 요청("주문 API를 정의해 주세요")은 그대로 커밋 문체로 바꿔 쓴다', () => {
    const subject = generateCommitSubject('주문 API를 정의해 주세요', [change('apps/commerce/src/order/api.ts')]);
    expect(subject).toBe('feat: 주문 API를 정의한다');
  });

  it('부탁 어미를 뗀 뒤 "이걸"처럼 짧은 대명사+조사만 남아도 요청 글을 제목으로 쓰지 않는다', () => {
    const subject = generateCommitSubject('이걸 해 주세요', [change('apps/commerce/src/shorts/link.ts')]);
    expect(subject).not.toBe('feat: 이걸');
  });

  it('AI 리뷰 고침 요청(buildPrReviewFixRequest)이면 요청 글의 공통 문구 대신 지적 제목들로 제목을 만든다(과제 66 버그 리포트)', () => {
    const findings: PrReviewFinding[] = [
      { severity: 'blocker', file: 'api/SeedRunner.java', title: '시드 id 시퀀스 검증', detail: '설명' },
      { severity: 'major', file: 'api/src/test', title: '마이그레이션 테스트', detail: '설명' },
    ];
    const request = buildPrReviewFixRequest(findings);
    const subject = generateCommitSubject(request, [change('api/SeedRunner.java')], '고쳤습니다.');
    expect(subject).toBe('fix: 리뷰 지적 2건 반영 — 시드 id 시퀀스 검증, 마이그레이션 테스트');
    expect(subject).not.toContain('이 PR을 리뷰해');
  });
});

describe('toCommitMood', () => {
  it('부탁하는 말투를 커밋 문체로 바꾸고, 모르는 끝맺음은 그대로 둔다', () => {
    expect(toCommitMood('주문 목록 API와 주문 목록 화면을 만들어 줘.')).toBe('주문 목록 API와 주문 목록 화면을 만든다');
    expect(toCommitMood('대시보드 로딩 버그를 고쳐 주세요')).toBe('대시보드 로딩 버그를 고친다');
    expect(toCommitMood('주문 취소 기능을 추가해 줘')).toBe('주문 취소 기능을 추가한다');
    expect(toCommitMood('README를 써 줘')).toBe('README를 쓴다');
    expect(toCommitMood('[R3] 주문 취소 API')).toBe('[R3] 주문 취소 API');
  });
});
