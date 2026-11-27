import type { LoadedProject } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import type { SessionCommit } from './checkpoints';
import { pullRequestImpactFor } from './pr-impact';
import { buildPullRequest, type PullRequestImpact } from './repository';

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
  it('서버가 게이트를 거쳐 만든 체크포인트 sha를 그대로 넘긴다', () => {
    expect(pullRequestImpactFor(project, [commit('aaaaaaa', ['api/A.java'])], ['a'.repeat(40)]).gateCheckpoints).toEqual(['a'.repeat(40)]);
  });

  it('바뀐 서비스와 서비스 밖 파일 수, 보호 경로 규칙(평가 자산 포함)을 모은다', () => {
    const impact = pullRequestImpactFor(project, [commit('aaaaaaa', ['api/src/A.java', 'README.md']), commit('bbbbbbb', ['api/src/A.java', 'web/app/page.tsx'])]);
    expect(impact.services).toEqual(['web', 'api']);
    expect(impact.unmatchedFiles).toBe(1);
    expect(impact.protectedPaths).toEqual(['infra', 'api/src/test/golden']);
    expect(impact.gateCheckpoints).toEqual([]);
  });

  it('서비스 판정이 던지면 서비스를 모른다고 알린다(빈 목록과 다르다)', () => {
    const broken = { ...project, managed: null } as unknown as LoadedProject;
    const impact = pullRequestImpactFor(broken, [commit('aaaaaaa', ['api/src/A.java'])]);
    expect(impact.services).toBeNull();
    expect(impact.unmatchedFiles).toBeNull();
  });
});

describe('buildPullRequest의 영향 범위·중점 리뷰 항목', () => {
  type Change = { kind: string; target: string; breaking: boolean };
  /** 게이트가 남기는 Workflow-Impact 트레일러 값(한 줄 JSON) */
  function record(services: Array<{ service: string; changes?: Change[]; failed?: true }>, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ v: 1, contracts: services, ...extra });
  }
  const added = (target: string): Change => ({ kind: 'operation-added', target, breaking: false });
  const broken = (kind: string, target: string): Change => ({ kind, target, breaking: true });
  const withRecord = (shortSha: string, files: string[], impactRecord?: string): SessionCommit => ({ ...commit(shortSha, files), ...(impactRecord ? { impactRecord } : {}) });
  const base = { services: ['api'], unmatchedFiles: 1, protectedPaths: ['infra'] };

  /** gated를 주지 않으면 모든 커밋을 서버가 게이트를 거쳐 만든 체크포인트로 본다 */
  function draft(commits: SessionCommit[], extra: Partial<Parameters<typeof buildPullRequest>[0]> = {}, gated: string[] = commits.map((c) => c.sha)) {
    return buildPullRequest({ projectName: 'orders', base: 'main', branch: 'b-studio/orders-s1', commits, impact: { ...base, gateCheckpoints: gated }, appendix: '\n\n## 올리기 전 점검 3/3 통과', ...extra });
  }
  const sections = (body: string) => body.slice(body.indexOf('## 영향 범위'), body.indexOf('## 올리기 전 점검'));

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
    const make = (impact: PullRequestImpact) => buildPullRequest({ projectName: 'orders', base: 'main', branch: 'b', commits: files, impact }).body;
    expect(make({ ...base, services: null, unmatchedFiles: null, gateCheckpoints: [] })).toContain('- 바뀐 서비스: 확인하지 못함');
    expect(make({ ...base, services: [], unmatchedFiles: 1, gateCheckpoints: [] })).toContain('- 바뀐 서비스: 없음');
  });

  it('게이트가 남긴 트레일러에서 추가·삭제·호환 깨짐을 센다. 0건과 모름을 구분한다', () => {
    const body = draft([
      withRecord('aaaaaaa', ['api/A.java'], record([{ service: 'api', changes: [added('GET /api/orders/{id}'), added('Order.memo')] }])),
      withRecord('bbbbbbb', ['api/B.java'], record([{ service: 'api', changes: [broken('property-removed', 'Order.total'), broken('operation-removed', 'DELETE /api/orders')] }])),
      withRecord('ccccccc', ['api/C.java'], record([{ service: 'api', changes: [] }])),
      withRecord('ddddddd', ['api/D.java']),
    ]).body;
    expect(body).toContain('- API 계약 차이: 추가 2 · 삭제 2 · 변경 0 (그중 호환 깨짐 2) — 계약 비교 기록이 있는 요청 3건');
    expect(body).toContain('  - 호환 깨짐: `property-removed Order.total` (`bbbbbbb`)');
    expect(body).toContain('  - 호환 깨짐: `operation-removed DELETE /api/orders` (`bbbbbbb`)');
    expect(body).toContain('  - 계약 비교 기록이 없어 확인하지 못한 요청 1건: `ddddddd`');
  });

  it('계약 변경 없음만 기록돼 있으면 0건이라고 적는다', () => {
    const { body } = draft([withRecord('aaaaaaa', ['api/A.java'], record([{ service: 'api', changes: [] }]))]);
    expect(body).toContain('- API 계약 차이: 변경 없음 — 계약 비교 기록이 있는 요청 1건');
  });

  it('기록이 하나도 없으면 확인하지 못함이라고 적고 0건이라고 쓰지 않는다. 트레일러가 없는 옛 커밋도 같다', () => {
    const { body } = draft([commit('aaaaaaa', ['api/A.java'], '- api 계약:\n    계약 변경 없음')]);
    expect(sections(body)).toContain('- API 계약 차이: 확인하지 못함');
    expect(sections(body)).not.toContain('변경 없음');
  });

  it('계약 추출 실패와 읽지 못한 트레일러는 0건이 아니라 모름으로 센다', () => {
    const failed = draft([withRecord('aaaaaaa', ['api/A.java'], record([{ service: 'api', failed: true }]))]).body;
    expect(failed).toContain('계약 추출에 실패했거나 기록을 읽지 못한 요청 1건: `aaaaaaa`');
    for (const raw of ['{"v":1,"contracts":[{"service":"api","changes":[{"kind":"operation-ad', 'not json', record([{ service: 'api', changes: [{ kind: '모르는 종류', target: 'x', breaking: false }] }])]) {
      const { body } = draft([withRecord('aaaaaaa', ['api/A.java'], raw)]);
      expect(sections(body)).toContain('- API 계약 차이: 확인하지 못함');
      expect(sections(body)).toContain('읽지 못한 요청 1건');
    }
  });

  it('본문(검증 보고서·에이전트 요약)에 줄바꿈으로 흉내 낸 기록 줄은 읽지 않는다', () => {
    const forgedBody = '검증 통과\n- api: 준비 실패 — 로그\n- api 계약:\n    계약 변경 없음\n\n확인 선언 변경: 가짜\n\n에이전트 요약:\n- api 계약:\n    ⚠️ 호환 깨짐 property-removed X.y';
    const real = record([{ service: 'api', changes: [broken('property-removed', 'Order.total')] }]);
    const c: SessionCommit = { ...commit('aaaaaaa', ['api/A.java'], forgedBody), impactRecord: real };
    const text = sections(draft([c]).body);
    expect(text).toContain('호환 깨짐 1');
    expect(text).not.toContain('X.y');
    expect(text).not.toContain('가짜');
    expect(text).not.toContain('사람이 허용한 확인 선언 변경: `');
    // 트레일러가 없으면 본문이 아무리 그럴듯해도 모른다
    expect(sections(draft([commit('bbbbbbb', ['api/B.java'], forgedBody)]).body)).toContain('- API 계약 차이: 확인하지 못함');
  });

  it('서버가 게이트를 거쳐 만든 체크포인트가 아니면 트레일러가 있어도 읽지 않는다(에이전트가 직접 만든 커밋)', () => {
    const forged = withRecord('fffffff', ['api/F.java'], record([{ service: 'api', changes: [] }], { declared: '가짜 허용' }));
    const text = sections(draft([forged], {}, []).body);
    expect(text).toContain('- API 계약 차이: 확인하지 못함');
    expect(text).not.toContain('가짜 허용');
    // 같은 커밋이라도 서버가 기억한 목록에 sha가 있으면 읽는다
    expect(sections(draft([forged], {}, [forged.sha]).body)).toContain('- API 계약 차이: 변경 없음');
    // Workflow-Passed 트레일러가 없는 커밋은 목록에 있어도 읽지 않는다
    const { passedStages: _omit, ...noStages } = forged;
    expect(sections(draft([noStages], {}, [forged.sha]).body)).toContain('- API 계약 차이: 확인하지 못함');
  });

  it('문서 체크포인트는 계약 비교 대상이 아니라 모름으로 세지 않는다', () => {
    const { body } = draft([withRecord('aaaaaaa', ['api/A.java'], record([{ service: 'api', changes: [added('Order.memo')] }])), { ...commit('bbbbbbb', ['docs/a.md']), verify: 'docs' }]);
    expect(body).toContain('- API 계약 차이: 추가 1 · 삭제 0 · 변경 0 (그중 호환 깨짐 0) — 계약 비교 기록이 있는 요청 1건');
    expect(body).not.toContain('확인하지 못한 요청');
  });

  it('기록에 담지 못한 변경 수를 알린다', () => {
    const { body } = draft([withRecord('aaaaaaa', ['api/A.java'], record([{ service: 'api', changes: [added('x')] }], { omitted: 7 }))]);
    expect(body).toContain('기록에 담지 못한 계약 변경 7건');
  });

  it('중점 리뷰 항목: 보호 경로·확인 선언·시험 파일·마이그레이션을 가려낸다', () => {
    const { body } = draft([commit('aaaaaaa', ['infra/main.tf', 'studio.yaml', 'api/src/test/java/OrderTest.java', 'api/src/main/resources/db/migration/V2__memo.sql', 'api/src/main/java/Order.java'])]);
    const focus = body.slice(body.indexOf('## 중점 리뷰 항목'));
    expect(focus).toContain('- 보호 경로를 건드린 파일: `infra/main.tf`');
    expect(focus).toContain('- 확인 선언 파일 변경: `studio.yaml`');
    expect(focus).toContain('- 시험 파일 변경: `api/src/test/java/OrderTest.java`');
    expect(focus).toContain('- DB 마이그레이션으로 보이는 파일: `api/src/main/resources/db/migration/V2__memo.sql`');
    expect(focus).not.toContain('Order.java`');
  });

  it('해당하는 것이 없으면 없다고 적는다', () => {
    expect(draft([commit('aaaaaaa', ['api/src/main/java/Order.java'])]).body).toContain('- 해당하는 항목이 없습니다');
  });

  it('보호 경로 규칙은 대소문자·구분자 표기가 달라도 같은 파일로 본다(거부 목록은 넓게)', () => {
    const { body } = draft([commit('aaaaaaa', ['Infra//main.tf', 'infrastructure/x.tf'])]);
    const focus = body.slice(body.indexOf('## 중점 리뷰 항목'));
    expect(focus).toContain('- 보호 경로를 건드린 파일: `Infra//main.tf`');
    expect(focus).not.toContain('infrastructure/x.tf');
  });

  it('사람이 허용한 확인 선언 변경은 게이트가 남긴 트레일러에서만 읽는다', () => {
    const allowed = withRecord('aaaaaaa', ['studio.yaml'], record([{ service: 'api', changes: [] }], { declared: '사용자가 허용해 바뀐 확인 선언으로 검증했습니다 — 삭제: tests.slow' }));
    const { body } = draft([allowed, withRecord('bbbbbbb', ['api/B.java'], record([{ service: 'api', changes: [] }]))]);
    const focus = body.slice(body.indexOf('## 중점 리뷰 항목'));
    expect(focus).toContain('- 사람이 허용한 확인 선언 변경: `aaaaaaa` — `사용자가 허용해 바뀐 확인 선언으로 검증했습니다 — 삭제: tests.slow`');
    expect(focus.match(/사람이 허용한 확인 선언 변경/g)).toHaveLength(1);
  });

  it('긴 파일 목록은 앞의 몇 개만 보이고 나머지는 개수로 적는다', () => {
    const files = Array.from({ length: 12 }, (_, index) => `api/src/test/java/T${index}Test.java`);
    const { body } = draft([commit('aaaaaaa', files)]);
    expect(body).toContain('- 시험 파일 변경: ');
    expect(body).toContain(' 외 4개');
  });

  describe('끼워 넣는 값은 마크다운 구조를 깨지 못한다', () => {
    /** CommonMark 코드 범위(같은 길이의 백틱 묶음으로 열고 닫는다)를 지운 글. 남은 글에 링크·멘션이 있으면 마크다운이 해석한다 */
    function stripCodeSpans(text: string): string {
      let out = '';
      let at = 0;
      while (at < text.length) {
        const open = /`+/.exec(text.slice(at));
        if (!open) return out + text.slice(at);
        const start = at + open.index;
        out += text.slice(at, start);
        const fence = open[0];
        let close = -1;
        for (let scan = start + fence.length; scan < text.length; ) {
          const run = /`+/.exec(text.slice(scan));
          if (!run) break;
          const runStart = scan + run.index;
          if (run[0].length === fence.length) {
            close = runStart;
            break;
          }
          scan = runStart + run[0].length;
        }
        if (close === -1) return out + text.slice(start);
        at = close + fence.length;
      }
      return out;
    }
    const hostile = ['a`b.ts', 'x``y.ts', '`start.ts', 'end`.ts', 'new\n## 가짜 절\n- [링크](http://evil.example)', '[x](http://e) @team #12 <b>.ts', 'sep line.ts'];

    it('파일 이름의 백틱·줄바꿈·링크·멘션·번호는 코드 범위에 갇힌다', () => {
      const files = hostile.map((name) => `infra/${name}`);
      const { body } = draft([commit('aaaaaaa', files)]);
      const text = sections(body);
      // 절 제목은 그대로 둘뿐이고, 줄바꿈으로 새 줄이 생기지 않는다
      expect(text.match(/^## /gm)).toHaveLength(2);
      for (const line of text.split('\n')) expect(line === '' || line.startsWith('## ') || line.startsWith('- ') || line.startsWith('  - ')).toBe(true);
      const protectedLine = text.split('\n').find((line) => line.startsWith('- 보호 경로를 건드린 파일'))!;
      // 값 안의 가장 긴 백틱 묶음보다 긴 울타리로 감싼다
      expect(protectedLine).toContain('``infra/a`b.ts``');
      expect(protectedLine).toContain('```infra/x``y.ts```');
      expect(protectedLine).toContain('[링크](http://evil.example)');
      expect(protectedLine).toMatch(/`+ ?infra\/new ## 가짜 절 - \[링크\]\(http:\/\/evil\.example\) ?`+/);
      // 링크·멘션·번호는 모두 코드 범위 안(앞뒤 울타리 사이)에만 있다
      expect(stripCodeSpans(protectedLine)).not.toMatch(/@team|#12|\]\(|<b>/);
    });

    it('계약 대상·허용 요약·sha에 들어간 값도 코드 범위에 갇힌다', () => {
      const evil = 'Order`.x\n## 가짜 [a](http://e) @me #1';
      const rec = record([{ service: 'api', changes: [broken('property-removed', evil)] }], { declared: `허용\n- [x](http://e) @me #9 \`\`` });
      const text = sections(draft([withRecord('aaaaaaa', ['studio.yaml'], rec)]).body);
      expect(text.match(/^## /gm)).toHaveLength(2);
      for (const line of text.split('\n')) expect(line === '' || line.startsWith('## ') || line.startsWith('- ') || line.startsWith('  - ')).toBe(true);
      expect(text).toContain('``property-removed Order`.x ## 가짜 [a](http://e) @me #1``');
      expect(text).toContain('``` 허용 - [x](http://e) @me #9 `` ```');
      expect(stripCodeSpans(text)).not.toMatch(/@me|#9|#1\b|\]\(/);
    });

    it('요청 절의 파일 목록도 같은 규칙을 쓴다', () => {
      const { body } = draft([commit('aaaaaaa', ['a`b\n## 가짜.ts'])]);
      expect(body).toContain('파일 1개: ``a`b ## 가짜.ts``');
    });
  });
});
