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
