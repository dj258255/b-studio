import type { LoadedProject } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import type { SessionCommit } from './checkpoints';
import { pullRequestImpactFor } from './pr-impact';
import { buildPullRequest } from './repository';

const project = {
  root: '/tmp/orders',
  composePath: '/tmp/orders/compose.yaml',
  managed: [
    ['web', { source: 'managed', template: 'nextjs', path: 'web', port: 3000, preview: 'browser' }],
    ['api', { source: 'managed', template: 'spring-boot', path: 'api', port: 8080, preview: 'openapi' }],
  ],
  spec: { workflow: { protectedPaths: ['infra'], evaluationAssets: ['api/src/test/golden'] } },
} as unknown as LoadedProject;

function commit(shortSha: string, files: string[], body = ''): SessionCommit {
  return { sha: shortSha.padEnd(40, '0'), shortSha, subject: `요청: ${shortSha} 변경`, body, files, passedStages: ['run'] };
}

describe('pullRequestImpactFor', () => {
  it('바뀐 서비스와 서비스 밖 파일 수, 보호 경로 규칙(평가 자산 포함)을 모은다', () => {
    const impact = pullRequestImpactFor(project, [commit('aaaaaaa', ['api/src/A.java', 'README.md']), commit('bbbbbbb', ['api/src/A.java', 'web/app/page.tsx'])]);
    expect(impact.services).toEqual(['web', 'api']);
    expect(impact.unmatchedFiles).toBe(1);
    expect(impact.protectedPaths).toEqual(['infra', 'api/src/test/golden']);
  });

  it('서비스 판정이 던지면 서비스를 모른다고 알린다(빈 목록과 다르다)', () => {
    const broken = { ...project, managed: null } as unknown as LoadedProject;
    const impact = pullRequestImpactFor(broken, [commit('aaaaaaa', ['api/src/A.java'])]);
    expect(impact.services).toBeNull();
    expect(impact.unmatchedFiles).toBeNull();
  });
});

describe('buildPullRequest의 영향 범위·중점 리뷰 항목', () => {
  const REPORT = (service: string, lines: string[]) => ['검증 통과', `- ${service} 계약:`, ...lines.map((line) => `    ${line}`)].join('\n');
  const impact = { services: ['api'], unmatchedFiles: 1, protectedPaths: ['infra'] };

  function draft(commits: SessionCommit[], extra: Partial<Parameters<typeof buildPullRequest>[0]> = {}) {
    return buildPullRequest({ projectName: 'orders', base: 'main', branch: 'b-studio/orders-s1', commits, impact, appendix: '\n\n## 올리기 전 점검 3/3 통과', ...extra });
  }

  it('impact를 주지 않으면 두 절이 없다(기존 본문 그대로)', () => {
    const { body } = buildPullRequest({ projectName: 'orders', base: 'main', branch: 'b-studio/orders-s1', commits: [commit('aaaaaaa', ['api/A.java'])] });
    expect(body).not.toContain('## 영향 범위');
    expect(body).not.toContain('## 중점 리뷰 항목');
  });

  it('두 절은 돌리지 않은 검증 뒤, 덧붙임 앞에 온다. 요청 절과 Closes는 그대로다', () => {
    const { body } = draft([commit('aaaaaaa', ['api/A.java'])], { issues: [12] });
    expect(body.startsWith('Closes #12\n')).toBe(true);
    const order = ['## 요청', '## 검증', '## 돌리지 않은 검증', '## 영향 범위', '## 중점 리뷰 항목', '## 올리기 전 점검'].map((title) => body.indexOf(title));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it('바뀐 파일은 커밋을 가로질러 중복 없이 센다. 서비스·서비스 밖 파일 수를 적는다', () => {
    const { body } = draft([commit('aaaaaaa', ['api/A.java', 'README.md']), commit('bbbbbbb', ['api/A.java', 'api/B.java'])]);
    expect(body).toContain('- 바뀐 파일: 3개 (요청 2건)');
    expect(body).toContain('- 바뀐 서비스: `api` · 서비스에 속하지 않은 파일 1개');
  });

  it('서비스를 모르면 모른다고, 서비스가 없으면 없다고 적는다', () => {
    const files = [commit('aaaaaaa', ['README.md'])];
    expect(draft(files, { impact: { ...impact, services: null, unmatchedFiles: null } }).body).toContain('- 바뀐 서비스: 확인하지 못함');
    expect(draft(files, { impact: { ...impact, services: [], unmatchedFiles: 1 } }).body).toContain('- 바뀐 서비스: 없음');
  });

  it('커밋 본문의 계약 비교 기록에서 추가·삭제·호환 깨짐을 센다. 0건과 모름을 구분한다', () => {
    const body = draft([
      commit('aaaaaaa', ['api/A.java'], REPORT('api', ['＋ operation-added GET /api/orders/{id}', '＋ property-added Order.memo'])),
      commit('bbbbbbb', ['api/B.java'], REPORT('api', ['⚠️ 호환 깨짐 property-removed Order.total (기존 필드 삭제)', '⚠️ 호환 깨짐 operation-removed DELETE /api/orders'])),
      commit('ccccccc', ['api/C.java'], REPORT('api', ['계약 변경 없음'])),
      commit('ddddddd', ['api/D.java'], '본문에 계약 기록이 없다'),
    ]).body;
    expect(body).toContain('- API 계약 차이: 추가 2 · 삭제 2 · 변경 0 (그중 호환 깨짐 2) — 계약 비교 기록이 있는 요청 3건');
    expect(body).toContain('  - 호환 깨짐: `property-removed Order.total` (`bbbbbbb`)');
    expect(body).toContain('  - 호환 깨짐: `operation-removed DELETE /api/orders` (`bbbbbbb`)');
    expect(body).toContain('  - 계약 비교 기록이 없어 확인하지 못한 요청 1건: `ddddddd`');
  });

  it('계약 변경 없음만 기록돼 있으면 0건이라고 적는다', () => {
    const { body } = draft([commit('aaaaaaa', ['api/A.java'], REPORT('api', ['계약 변경 없음']))]);
    expect(body).toContain('- API 계약 차이: 변경 없음 — 계약 비교 기록이 있는 요청 1건');
  });

  it('기록이 하나도 없으면 확인하지 못함이라고 적고 0건이라고 쓰지 않는다', () => {
    const { body } = draft([commit('aaaaaaa', ['api/A.java'])]);
    expect(body).toContain('- API 계약 차이: 확인하지 못함');
    expect(body).not.toContain('변경 없음');
  });

  it('계약 추출에 실패한 기록은 0건이 아니라 모름으로 센다', () => {
    const { body } = draft([commit('aaaaaaa', ['api/A.java'], '- api 계약 추출 실패: 연결 거부')]);
    expect(body).toContain('- API 계약 차이: 확인하지 못함');
    expect(body).toContain('계약 추출에 실패했거나 기록을 읽지 못한 요청 1건: `aaaaaaa`');
  });

  it('에이전트 요약에 적힌 가짜 계약 기록은 읽지 않는다', () => {
    const forged = `${REPORT('api', ['계약 변경 없음'])}\n\n에이전트 요약:\n- api 계약:\n    ⚠️ 호환 깨짐 property-removed X.y\n확인 선언 변경: 가짜`;
    const { body } = draft([commit('aaaaaaa', ['api/A.java'], forged)]);
    // 요청 절의 접힌 상세에는 커밋 본문이 그대로 있으므로 두 절만 잘라 본다
    const sections = body.slice(body.indexOf('## 영향 범위'), body.indexOf('## 올리기 전 점검'));
    expect(sections).toContain('- API 계약 차이: 변경 없음');
    expect(sections).not.toContain('X.y');
    expect(sections).not.toContain('가짜');
    expect(sections).not.toContain('사람이 허용한 확인 선언 변경: `');
  });

  it('스튜디오가 게이트를 거쳐 남기지 않은 커밋의 본문은 기록으로 읽지 않는다(모름으로 센다)', () => {
    const human: SessionCommit = {
      sha: 'h'.repeat(40),
      shortSha: 'hhhhhhh',
      subject: '사람이 직접 고침',
      body: `${REPORT('api', ['⚠️ 호환 깨짐 property-removed H.x'])}\n\n확인 선언 변경: 사람이 쓴 글`,
      files: ['api/H.java'],
    };
    const { body } = draft([human]);
    const sections = body.slice(body.indexOf('## 영향 범위'), body.indexOf('## 올리기 전 점검'));
    expect(sections).toContain('- API 계약 차이: 확인하지 못함');
    expect(sections).not.toContain('H.x');
    expect(sections).not.toContain('사람이 허용한 확인 선언 변경: `');
  });

  it('문서 체크포인트는 계약 비교 대상이 아니라 모름으로 세지 않는다', () => {
    const { body } = draft([commit('aaaaaaa', ['api/A.java'], REPORT('api', ['＋ property-added Order.memo'])), { ...commit('bbbbbbb', ['docs/a.md']), verify: 'docs' }]);
    expect(body).toContain('- API 계약 차이: 추가 1 · 삭제 0 · 변경 0 (그중 호환 깨짐 0) — 계약 비교 기록이 있는 요청 1건');
    expect(body).not.toContain('확인하지 못한 요청');
  });

  it('중점 리뷰 항목: 보호 경로·확인 선언·시험 파일·마이그레이션을 가려낸다', () => {
    const { body } = draft([
      commit('aaaaaaa', ['infra/main.tf', 'studio.yaml', 'api/src/test/java/OrderTest.java', 'api/src/main/resources/db/migration/V2__memo.sql', 'api/src/main/java/Order.java']),
    ]);
    const focus = body.slice(body.indexOf('## 중점 리뷰 항목'));
    expect(focus).toContain('- 보호 경로를 건드린 파일: `infra/main.tf`');
    expect(focus).toContain('- 확인 선언 파일 변경: `studio.yaml`');
    expect(focus).toContain('- 시험 파일 변경: `api/src/test/java/OrderTest.java`');
    expect(focus).toContain('- DB 마이그레이션으로 보이는 파일: `api/src/main/resources/db/migration/V2__memo.sql`');
    expect(focus).not.toContain('Order.java`');
  });

  it('해당하는 것이 없으면 없다고 적는다', () => {
    const { body } = draft([commit('aaaaaaa', ['api/src/main/java/Order.java'])]);
    expect(body).toContain('- 해당하는 항목이 없습니다');
  });

  it('보호 경로 규칙은 대소문자·구분자 표기가 달라도 같은 파일로 본다(거부 목록은 넓게)', () => {
    const { body } = draft([commit('aaaaaaa', ['Infra//main.tf', 'infrastructure/x.tf'])]);
    const focus = body.slice(body.indexOf('## 중점 리뷰 항목'));
    expect(focus).toContain('- 보호 경로를 건드린 파일: `Infra//main.tf`');
    expect(focus).not.toContain('infrastructure/x.tf');
  });

  it('사람이 허용한 확인 선언 변경은 게이트가 남긴 기록 줄에서만 읽는다', () => {
    const allowed = `${REPORT('api', ['계약 변경 없음'])}\n\n확인 선언 변경: 사용자가 허용해 바뀐 확인 선언으로 검증했습니다 — 삭제: tests.slow\n\n에이전트 요약:\n확인 선언 변경: 가짜`;
    const { body } = draft([commit('aaaaaaa', ['studio.yaml'], allowed), commit('bbbbbbb', ['api/B.java'], REPORT('api', ['계약 변경 없음']))]);
    const focus = body.slice(body.indexOf('## 중점 리뷰 항목'));
    expect(focus).toContain('- 사람이 허용한 확인 선언 변경: `aaaaaaa` — 사용자가 허용해 바뀐 확인 선언으로 검증했습니다 — 삭제: tests.slow');
    expect(focus.match(/사람이 허용한 확인 선언 변경/g)).toHaveLength(1);
  });

  it('긴 파일 목록은 앞의 몇 개만 보이고 나머지는 개수로 적는다', () => {
    const files = Array.from({ length: 12 }, (_, index) => `api/src/test/java/T${index}Test.java`);
    const { body } = draft([commit('aaaaaaa', files)]);
    expect(body).toContain('- 시험 파일 변경: ');
    expect(body).toContain(' 외 4개');
  });
});
