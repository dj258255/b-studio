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

  it('첫 문장이 새로 만들기를 말하면, 본문이 오류 상태 화면을 설명해도 fix가 아니라 feat로 본다(도그푸딩 버그 리포트: "fix: R26의 웹 화면을 만든다")', () => {
    const request = 'R26의 웹 화면을 만들어 주세요.\n- 조회 실패 시 오류 문구와 재시도 버튼을 보여 준다.';
    expect(classifyCommit(request, [change('apps/web/components/ShortsFeed.tsx', 'added'), change('apps/web/lib/api.ts')])).toBe('feat');
  });

  it('첫 문장이 고침을 말하면 그대로 fix로 보고, 첫 문장에 단서가 없으면 본문의 고침 낱말로 fix를 고른다', () => {
    expect(classifyCommit('결제 화면에 버그가 있어요. 새로 고침하면 사라집니다.', [change('web/app/pay/page.tsx')])).toBe('fix');
    expect(classifyCommit('주문 목록을 봐 주세요.\n- 두 번째 페이지가 안 나와요', [change('web/app/orders/page.tsx')])).toBe('fix');
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

  it('긴 파일 경로 때문에 72자를 넘으면 경로를 파일 이름으로 줄여 동사까지 남긴다(도그푸딩 버그 리포트: 경로 한가운데서 잘림)', () => {
    const request = '앞서 샌드박스 문제를 우회하려고 넣은 commerce/src/test/resources/mockito-extensions/org.mockito.plugins.MockMaker 파일을 지워 주세요.';
    const subject = generateCommitSubject(request, [change('commerce/src/test/resources/mockito-extensions/org.mockito.plugins.MockMaker', 'deleted')]);
    expect(subject.slice(subject.indexOf(': ') + 2)).toBe('앞서 샌드박스 문제를 우회하려고 넣은 org.mockito.plugins.MockMaker 파일을 지운다');
    expect(subject.length).toBeLessThanOrEqual(72);
  });

  it('제목이 예산 안이면 짧은 경로는 그대로 둔다', () => {
    expect(generateCommitSubject('apps/web/lib/api.ts에 재시도를 넣어 주세요', [change('apps/web/lib/api.ts')])).toBe('feat: apps/web/lib/api.ts에 재시도를 넣는다');
  });

  it('요청 첫 문장이 문제를 설명하면("…보장이 없습니다.") 제목으로 쓰지 않고, 요약의 머리글·문제 설명 줄도 건너뛴다(도그푸딩 버그 리포트)', () => {
    const request = 'tools/run-bench.sh가 산출물을 확인하지 않아서, 잰 시간이 맞다는 보장이 없습니다. 고쳐 주세요.';
    const summary = '## 완료\n\n**찾은 결함**: `write_master()`가 바깥 스코프 값을 먼저 치환합니다.\n\n**고친 내용**\n- 회차마다 산출물을 확인하고 마스터 재생목록을 만들었습니다.';
    const subject = generateCommitSubject(request, [change('tools/run-bench.sh')], summary);
    expect(subject).not.toContain('보장이 없습니다');
    expect(subject).not.toContain('찾은 결함');
    expect(subject).toBe('fix: 회차마다 산출물을 확인하고 마스터 재생목록을 만들었습니다');
  });

  it('요약 줄이 72자 예산을 넘으면 잘라 쓰지 않고 바뀐 파일로 제목을 만든다', () => {
    const summary = '회차마다 지우기 전에 세 재생목록과 세그먼트가 있는지, 길이 합이 원본과 맞는지, 썸네일이 비어 있지 않은지, 마스터 재생목록이 있는지 확인했습니다.';
    const subject = generateCommitSubject('해 주세요', [change('tools/run-bench.sh')], summary);
    expect(subject).not.toContain('회차마다');
    expect(subject.length).toBeLessThanOrEqual(72);
  });

  it('완료 요약의 과거형 서술("…확장했습니다")은 상태 설명으로 보지 않는다', () => {
    const subject = generateCommitSubject('해 주세요', [change('apps/commerce/src/shorts/link.ts')], '연결 상품 조회를 피드 응답에 넣었습니다.');
    expect(subject).toBe('feat: 연결 상품 조회를 피드 응답에 넣었습니다');
  });

  it('끝에 괄호 꼬리가 붙은 요청("…옮겨 주세요(R32)")도 어미를 바꾸고, 옮기기는 refactor로 본다(도그푸딩 버그 리포트)', () => {
    const request = '숏폼 코드를 저장소 최상위 media/로 옮겨 주세요(R32). 결정: media/는 Gradle 하위 프로젝트입니다.';
    const subject = generateCommitSubject(request, [change('media/src/main/java/Shorts.java', 'added'), change('commerce/build.gradle')]);
    expect(subject).toBe('refactor: 숏폼 코드를 저장소 최상위 media/로 옮긴다(R32)');
  });

  it('흔한 "~어/아 주세요" 동사도 커밋 문체로 바꾼다', () => {
    expect(toCommitMood('업로드와 변환을 나눠 주세요')).toBe('업로드와 변환을 나눈다');
    expect(toCommitMood('테스트 힙을 줄여 주세요.')).toBe('테스트 힙을 줄인다');
    expect(toCommitMood('결정을 ADR로 남겨 주세요(R32)')).toBe('결정을 ADR로 남긴다(R32)');
  });

  it('규칙에 없는 동사("…재 주세요")는 부탁 어미만 떼어 동사 조각을 남기지 않고 다음 대체 경로로 넘긴다(도그푸딩 버그 리포트)', () => {
    const request = 'R24(60초 영상 업로드 완료부터 READY까지 60초 이내)를 실제 경로로 재 주세요. 지금까지는 FFmpeg 변환 시간만 쟀습니다.';
    const summary = '**R24 측정 완료 (실제 경로):**\n\n- 업로드 완료부터 READY까지 실제 경로 측정 스크립트를 더했습니다.';
    const subject = generateCommitSubject(request, [change('tools/run-shorts-upload-to-ready-bench.sh', 'added'), change('docs/performance/shorts-transcode.md')], summary);
    expect(subject).not.toMatch(/재$/);
    expect(subject).toBe('feat: 업로드 완료부터 READY까지 실제 경로 측정 스크립트를 더했습니다');
  });

  it('"~게 해 주세요"는 띄어쓰기를 지켜 "~게 한다"로 바꾼다(도그푸딩 버그 리포트: "재생되게한다")', () => {
    expect(toCommitMood('숏폼 피드에서 변환된 영상이 실제로 재생되게 해 주세요(R26 재생)')).toBe('숏폼 피드에서 변환된 영상이 실제로 재생되게 한다(R26 재생)');
  });

  it('명사 뒤에 띄어 쓴 "해 주세요"는 "…한다"로 바꾸고, 조사로 끝나면 동사로 보지 않는다', () => {
    expect(toCommitMood('로그인 기능 추가 해 주세요')).toBe('로그인 기능 추가한다');
    expect(generateCommitSubject('로그인 기능 추가 해 주세요', [change('web/app/login/page.tsx')])).toBe('feat: 로그인 기능 추가한다');
    expect(generateCommitSubject('R25를 해 주세요', [change('apps/commerce/src/shorts/link.ts')])).not.toBe('feat: R25를한다');
    expect(generateCommitSubject('이걸 해 주세요', [change('apps/commerce/src/shorts/link.ts')])).not.toContain('이걸한다');
  });

  it('요약 첫 줄이 "마무리 확인 결과를 보고합니다." 같은 경과 보고면 제목으로 쓰지 않는다(도그푸딩 버그 리포트)', () => {
    const request = '앞 실행이 네트워크 오류로 끊겨, 그 실행이 고친 apps/web/next.config.ts를 보관본에서 되살려 두었습니다. 이어서 마무리해 주세요.';
    const summary = '마무리 확인 결과를 보고합니다.\n\n**진단**: 이전 실행이 이미 올바르게 분석·수정해 두었습니다.';
    const subject = generateCommitSubject(request, [change('apps/web/next.config.ts')], summary);
    expect(subject).not.toContain('보고합니다');
    expect(subject).not.toContain('앞 실행');
  });

  it('요청 첫 문장이 사람이 이미 한 일의 과거형 서술이면 제목으로 쓰지 않는다(도그푸딩 버그 리포트: "…다시 돌렸습니다(제가 대신 했습니다)")', () => {
    const request = 'MediaMTX를 재시작해 새 설정으로 다시 돌렸습니다(제가 대신 했습니다). 결과와 근거입니다. 이어서 고쳐 주세요.';
    const summary = 'MediaMTX Control API로 송출 상태를 읽도록 바꿨습니다.';
    expect(generateCommitSubject(request, [change('media/src/main/java/MediaMtxPathPoller.java', 'added')], summary)).toBe('feat: MediaMTX Control API로 송출 상태를 읽도록 바꿨습니다');
  });

  it('요청 첫 문장이 "…실패합니다" 같은 현상 설명이면 제목으로 쓰지 않는다(도그푸딩 버그 리포트)', () => {
    const subject = generateCommitSubject('MediaMTX 실제 송출이 실패합니다. 원인을 알려 드리니 고쳐 주세요.', [change('media/mediamtx.yml')]);
    expect(subject).not.toContain('실패합니다');
  });

  it('요약 첫 줄의 "결론:"·"현재 상태:" 머리말 줄은 건너뛴다(도그푸딩 버그 리포트: "fix: 결론: MediaMTX가 …")', () => {
    const summary = '**결론: MediaMTX가 샌드박스에서 죽어 실제 송출 검증을 끝까지 돌리지 못했습니다.**\n\n- MediaMTX 설정의 훅 이름을 runOnReady로 고쳤습니다.';
    const subject = generateCommitSubject('해 주세요', [change('media/mediamtx.yml')], summary);
    expect(subject).not.toContain('결론');
    expect(subject).toBe('feat: MediaMTX 설정의 훅 이름을 runOnReady로 고쳤습니다');
  });

  it('요구사항 id 대체 제목은 시나리오 id를 부모로 접고 이어지는 번호를 범위로 줄인다(도그푸딩 버그 리포트: "[R1, R3, R1.2, R2.1, …]")', () => {
    const request = '라이브 방송 R1~R3의 시나리오 테스트를 채워 주세요. 요구사항 화면에 R1.2, R2.1, R2.2, R3.1, R3.2, R3.3이 "테스트 없음"으로 나옵니다.';
    const changes = [change('media/src/test/java/com/beomsu/becommerce/live/LiveBroadcastServiceTest.java'), change('media/src/test/java/com/beomsu/becommerce/live/LiveBroadcastTest.java')];
    const subject = generateCommitSubject(request, changes);
    expect(subject).toContain('[R1~R3]');
    expect(subject).not.toContain('R1.2');
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

  it('요청 글이 에이전트의 질문에 대한 답이면 첫 문장을 제목으로 쓰지 않고 요약·요구사항 id·바뀐 파일로 넘어간다(도그푸딩 마찰 178: "test: 세 번째로 갑니다")', () => {
    const answer = '세 번째로 갑니다. sampleParams 키는 지원됩니다. R11.2 테스트만 더해 주세요.';
    const changes = [change('apps/web/lib/liveOrder.test.ts', 'modified')];
    // 답이라는 것을 모르면 지금처럼 첫 문장이 제목이 된다
    expect(generateCommitSubject(answer, changes)).toBe('test: 세 번째로 갑니다');
    // 요약이 바뀐 내용을 말하면 그것을 쓴다
    expect(generateCommitSubject(answer, changes, '바로 주문 시나리오(R11.2) 테스트를 더했습니다.\n\n자세한 내용…', { requestIsAnswer: true })).toBe(
      'test: 바로 주문 시나리오(R11.2) 테스트를 더했습니다',
    );
    // 요약이 없으면 요구사항 id·바뀐 파일로 만든다. 답의 첫 문장은 어디에도 나오지 않는다
    const fallback = generateCommitSubject(answer, changes, undefined, { requestIsAnswer: true });
    expect(fallback).not.toContain('세 번째로');
    expect(fallback).toMatch(/^test: /);
    // 답이 아닌 요청은 그대로다
    expect(generateCommitSubject('주문에 메모 필드 추가', [change('api/src/main/java/Order.java')], undefined, { requestIsAnswer: false })).toBe(
      generateCommitSubject('주문에 메모 필드 추가', [change('api/src/main/java/Order.java')]),
    );
  });

  describe('요약의 마무리 인사를 제목으로 쓰지 않는다(도그푸딩 마찰 184: "feat: Everything is consistent and complete")', () => {
    // 요청 첫 문장은 상태 설명이라 제목이 되지 못하고 요약으로 넘어간다
    const request = '방송 시청 화면(/live/[id])을 직접 열어 보니 고칠 곳이 있습니다. 1280x720 창 기준으로 봤습니다.';
    const changes = [change('apps/web/app/globals.css'), change('apps/web/components/LiveViewer.tsx'), change('apps/web/lib/liveLogin.ts', 'added')];
    const preamble = 'Everything is consistent and complete. All changes verified: tests pass (62/62 web), both services restarted and healthy.';

    it('"## 요약" 머리글이 있으면 그 앞의 줄은 보지 않고, 뒤에 절 제목이 둘 이상이면 그것들을 묶는다', () => {
      const summary = [
        preamble,
        '',
        '## 요약',
        '',
        '**레이아웃/시각 수정** (`apps/web/app/live/[id]/page.tsx`, `apps/web/app/globals.css`)',
        '- 숏폼 피드용 `.shorts-scroller`(72vh 내부 스크롤)·`.shorts-frame`(세로 9:16, 폭 300px 고정) 재사용을 그만두고, 라이브 전용 `.live-page`/`.live-frame`/`.live-video`/`.live-empty`/`.live-title`을 새로 만들었습니다.',
        '- **검증 방법**: 브라우저 스크린샷 도구가 없어 요소 높이를 계산했습니다.',
        '',
        '**로그인 UX** (`apps/web/lib/liveLogin.ts` 신규)',
        '- 빈 입력 시 서버 호출 전에 안내합니다.',
        '',
        '**방송 제목 표시**',
        '- 화면 상단에 표시합니다.',
        '',
        '결정하실 사항은 없습니다.',
      ].join('\n');
      expect(generateCommitSubject(request, changes, summary)).toBe('feat: 레이아웃/시각 수정, 로그인 UX, 방송 제목 표시');
    });

    it('머리글이 없어도 요청이 한국어면 한글이 없는 줄은 건너뛰고 다음 줄을 쓴다', () => {
      const summary = `${preamble}\n\n라이브 화면의 로그인 안내 문구를 고쳤습니다.\n\n- 나머지는 그대로입니다.`;
      expect(generateCommitSubject(request, changes, summary)).toBe('feat: 라이브 화면의 로그인 안내 문구를 고쳤습니다');
      // 전에는 영어 첫 문장이 그대로 제목이 됐다
      expect(generateCommitSubject(request, changes, summary)).not.toContain('Everything');
    });

    it('요약이 영어 한 줄뿐이면 바뀐 파일로 만든다. 요청이 영어면 영어 요약 줄을 그대로 쓴다', () => {
      expect(generateCommitSubject(request, changes, preamble)).toBe('feat: globals·LiveViewer 외 1개를 고친다');
      expect(generateCommitSubject('Can you fix it?', changes, 'Add a memo field to orders.')).toContain('Add a memo field to orders');
    });

    it('절 제목이 보고서의 칸 이름뿐이거나 하나뿐이면 묶지 않고 바뀐 파일로 만든다', () => {
      const report = `${preamble}\n\n## 요약\n\n**고친 내용**\n- 아주 긴 설명이 이어집니다 ${'가'.repeat(80)}\n\n**검증 방법**\n- 테스트를 돌렸습니다 ${'나'.repeat(80)}\n\n**남은 한계**\n- 없습니다 ${'다'.repeat(80)}`;
      expect(generateCommitSubject(request, changes, report)).toBe('feat: globals·LiveViewer 외 1개를 고친다');
      const single = `## 요약\n\n**로그인 UX**\n- 아주 긴 설명이 이어집니다 ${'가'.repeat(80)}`;
      expect(generateCommitSubject(request, changes, single)).toBe('feat: globals·LiveViewer 외 1개를 고친다');
    });
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
