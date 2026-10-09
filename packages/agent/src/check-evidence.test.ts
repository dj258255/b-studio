import { describe, expect, it } from 'vitest';
import type { WorkflowPageCheck } from '@b-studio/spec';
import type { BrowserPageResult } from './browser-check';
import { browserPageEvidence, finishEvidence, httpPageEvidence, MAX_EVIDENCE_LINES, testEvidence } from './check-evidence';

const page = (extra: Partial<WorkflowPageCheck> = {}): WorkflowPageCheck =>
  ({ service: 'web', path: '/live/1', mode: 'browser', expectStatus: 200, allowConsoleErrors: false, noHorizontalScroll: false, ...extra }) as WorkflowPageCheck;

const rendered = (extra: Partial<BrowserPageResult> = {}): BrowserPageResult => ({
  status: 200,
  text: '바로 주문 12,000원',
  pageErrors: [],
  consoleErrors: [],
  failedRequests: [],
  mediaErrors: [],
  blockedRequests: [],
  horizontalOverflowPx: 0,
  steps: [{ label: 'open /live/1', ok: true }],
  ...extra,
});

describe('통과한 확인의 근거', () => {
  it('판정을 거꾸로 채우지 않는다 — 화면에 실제로 있는 문구와 보인 글자만 적는다', () => {
    const lines = browserPageEvidence(
      page({ expectAnyText: ['12,000원', '12000원'], expectAllText: ['바로 주문', '없는 문구'], expectInViewport: ['바로 주문', '가려진 글자'] }),
      rendered({ viewportTexts: { width: 390, height: 844, findings: [{ text: '바로 주문', visible: true }, { text: '가려진 글자', visible: false, problem: { kind: 'below', px: 4 } }] } }),
    );
    expect(lines).toContain("'12,000원' 화면에 있음 (적은 2개 중 하나면 통과)");
    expect(lines).toContain("'바로 주문' 화면에 있음");
    expect(lines).toContain("첫 화면에 온전히 보임 (창 390x844): '바로 주문'");
    expect(lines.join('\n')).not.toContain('없는 문구');
    expect(lines.join('\n')).not.toContain('가려진 글자');
  });

  it('잰 값이 없으면 그 줄을 만들지 않는다(첫 화면 결과 없음, 로드 시간 없음)', () => {
    const lines = browserPageEvidence(page({ expectInViewport: ['바로 주문'] }), rendered());
    expect(lines.join('\n')).not.toContain('첫 화면');
    expect(lines.join('\n')).not.toContain('로드');
  });

  it('선택한 단언이 잰 값을 적는다: 가로 넘침, 로드 시간과 예산, 단계, api 값, 추정한 id', () => {
    const lines = browserPageEvidence(
      page({ noHorizontalScroll: true, maxLoadMs: 3000, steps: [{ click: '주문' }] as never, allowLoadingPlaceholder: true }),
      rendered({ loadMs: 1234, steps: [{ label: 'open /live/1', ok: true }, { label: "click '주문'", ok: true }] }),
      { auto: true, probedId: '1', api: { service: 'api', jsonPath: '$.price', value: 12000 } },
    );
    expect(lines).toEqual([
      'HTTP 200 — 추정한 id(1)로 열어 404·500만 실패로 봤습니다',
      "api의 $.price 값 '12000' 화면에 있음",
      '스크립트 예외 0건 · console.error 0건 · 실패한 요청 0건 · 미디어 오류 0건',
      '로딩 문구에서 멈췄는지는 보지 않았습니다(allowLoadingPlaceholder)',
      '가로 넘침 0px',
      '로드 1,234ms (예산 3,000ms)',
      "단계 1/1개 실행: click '주문'",
      'Next.js 오류 화면 표지 없음',
    ]);
  });

  it('http 확인은 응답 본문에서 본 것과 보지 않은 것을 적는다', () => {
    const lines = httpPageEvidence(page({ mode: 'http', expectText: '바로 주문' }), { status: 200, text: '<b>바로 주문</b>' });
    expect(lines[1]).toBe("'바로 주문' 응답 본문에 있음");
    expect(lines.at(-1)).toContain('자바스크립트를 실행하지 않았습니다');
  });

  it('줄 수와 길이를 묶고 시크릿 값을 가린다', () => {
    const many = Array.from({ length: 20 }, (_, index) => `줄 ${index} token=s3cret`);
    const lines = finishEvidence(many, (text) => text.replaceAll('s3cret', '***'));
    expect(lines).toHaveLength(MAX_EVIDENCE_LINES);
    expect(lines.at(-1)).toBe('그 밖에 9가지');
    expect(lines.join('\n')).not.toContain('s3cret');
    expect(finishEvidence(['가'.repeat(500)], (text) => text)[0]).toHaveLength(241);
    expect(browserPageEvidence(page({ expectText: '가'.repeat(200) }), rendered({ text: '가'.repeat(200) }))[1]).toBe(`'${'가'.repeat(60)}…' 화면에 있음`);
  });

  it('긴 시크릿 값은 잘리기 전에 가려진다(앞부분이 남지 않는다)', () => {
    const secret = `sk-${'a'.repeat(100)}`;
    const redact = (text: string) => text.replaceAll(secret, '***');
    const context = { api: { service: 'api', jsonPath: '$.token', value: secret }, redact };
    const browser = finishEvidence(browserPageEvidence(page({ expectText: secret }), rendered({ text: secret }), context), redact);
    const http = finishEvidence(httpPageEvidence(page({ mode: 'http', expectAllText: [secret] }), { status: 200, text: secret }, context), redact);
    for (const lines of [browser, http]) {
      expect(lines.join('\n')).not.toContain('sk-aaa');
      expect(lines.join('\n')).toContain("'***'");
    }
  });

  it('테스트 근거는 명령과 걸린 시간이다', () => {
    expect(testEvidence('api', ['./gradlew', 'test', '--tests', 'OrderTest'], 12_345)).toEqual(['api에서 `./gradlew test --tests OrderTest` 종료 코드 0', '걸린 시간 12초']);
    expect(testEvidence('web', ['pnpm', 'test'], 340)).toEqual(['web에서 `pnpm test` 종료 코드 0', '걸린 시간 0.3초']);
  });
});
