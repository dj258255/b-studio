import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProject, parseSpec, SpecError } from './load';

const ORDERS_SPEC = `
version: 1
name: orders
services:
  web:
    source: managed
    template: nextjs
    path: web
    port: 3000
    preview: browser
    ready: { path: / }
  api:
    source: managed
    template: spring-boot
    path: api
    port: 8080
    preview: openapi
    ready: { path: /actuator/health, timeoutSeconds: 600 }
    contract: { extract: /v3/api-docs }
  legacy-users:
    source: external
    baseUrl: https://users.internal.example.com
`;

describe('parseSpec', () => {
  it('managed와 external 서비스를 함께 읽고 기본값을 채운다', () => {
    const spec = parseSpec(ORDERS_SPEC);

    expect(spec.compose).toBe('compose.yaml');
    expect(spec.services.web).toMatchObject({ source: 'managed', port: 3000 });
    expect(spec.services.api).toMatchObject({ ready: { expectStatus: 200, timeoutSeconds: 600 } });
    expect(spec.services['legacy-users']).toMatchObject({ source: 'external', preview: 'openapi' });
    expect(spec.repository).toBeUndefined();
  });

  it('배포 설정은 Dockerfile 기본값을 채우고, 포트는 1024 이상만 받는다', () => {
    expect(parseSpec(`${ORDERS_SPEC}deploy:\n  services:\n    web: { port: 8300 }\n`).deploy).toEqual({ services: { web: { dockerfile: 'Dockerfile', port: 8300 } } });
    expect(() => parseSpec(`${ORDERS_SPEC}deploy:\n  services:\n    web: { port: 80 }\n`)).toThrow(SpecError);
    expect(() => parseSpec(`${ORDERS_SPEC}deploy:\n  services:\n    web: { dockerfile: ../Dockerfile }\n`)).toThrow(SpecError);
  });

  it('모노레포 하위 폴더 연동은 명시해야 켜지고, main 따라잡기(autoCatchUp)는 기본으로 켜진다', () => {
    expect(parseSpec(`${ORDERS_SPEC}repository: {}\n`).repository).toEqual({ monorepo: false, autoCatchUp: true });
    expect(parseSpec(`${ORDERS_SPEC}repository:\n  monorepo: true\n`).repository).toEqual({ monorepo: true, autoCatchUp: true });
    expect(parseSpec(`${ORDERS_SPEC}repository:\n  autoCatchUp: false\n`).repository).toEqual({ monorepo: false, autoCatchUp: false });
    expect(() => parseSpec(`${ORDERS_SPEC}repository:\n  monorepo: "yes"\n`)).toThrow(SpecError);
  });

  it('PR 자동 리뷰 설정은 절이 없어도 기본값(켬·2라운드)이 채워지고, 범위를 벗어나면 거부한다', () => {
    expect(parseSpec(ORDERS_SPEC).review).toEqual({ auto: true, maxRounds: 2 });
    expect(parseSpec(`${ORDERS_SPEC}review: {}\n`).review).toEqual({ auto: true, maxRounds: 2 });
    expect(parseSpec(`${ORDERS_SPEC}review:\n  auto: false\n  maxRounds: 1\n`).review).toEqual({ auto: false, maxRounds: 1 });
    expect(parseSpec(`${ORDERS_SPEC}review:\n  maxRounds: 3\n`).review).toEqual({ auto: true, maxRounds: 3 });
    expect(() => parseSpec(`${ORDERS_SPEC}review:\n  maxRounds: 0\n`)).toThrow(SpecError);
    expect(() => parseSpec(`${ORDERS_SPEC}review:\n  maxRounds: 4\n`)).toThrow(SpecError);
  });

  it('계획-실행 분리 모델 설정은 절이 없으면 undefined이고, 있으면 plan·execute를 그대로 읽는다', () => {
    expect(parseSpec(ORDERS_SPEC).models).toBeUndefined();
    expect(parseSpec(`${ORDERS_SPEC}models:\n  plan: opus\n  execute: sonnet\n`).models).toEqual({ plan: 'opus', execute: 'sonnet' });
    expect(parseSpec(`${ORDERS_SPEC}models:\n  plan: opus\n`).models).toEqual({ plan: 'opus' });
    expect(() => parseSpec(`${ORDERS_SPEC}models:\n  plan: ""\n`)).toThrow(SpecError);
  });

  it('디자인 설정은 Figma URL의 파일 키를 뽑고, 형식이 틀리면 거부한다', () => {
    expect(parseSpec(`${ORDERS_SPEC}design:\n  figma:\n    fileUrl: "https://www.figma.com/design/abc123XYZ/Orders?node-id=1-2"\n`).design?.figma).toEqual({
      fileUrl: 'https://www.figma.com/design/abc123XYZ/Orders?node-id=1-2',
      fileKey: 'abc123XYZ',
    });
    // 옛 /file/ 경로와 www 없는 호스트도 받는다
    expect(parseSpec(`${ORDERS_SPEC}design:\n  figma:\n    fileUrl: "https://figma.com/file/KEY9/legacy"\n`).design?.figma?.fileKey).toBe('KEY9');
    expect(parseSpec(`${ORDERS_SPEC}`).design).toBeUndefined();

    const bad = captureError(() => parseSpec(`${ORDERS_SPEC}design:\n  figma:\n    fileUrl: "https://example.com/design/x"\n`));
    expect(bad.issues.some((issue) => issue.startsWith('design.figma.fileUrl'))).toBe(true);
  });

  it('워크플로 정책의 단계와 보호 경로를 읽고 잘못된 단계를 거부한다', () => {
    const spec = parseSpec(`${ORDERS_SPEC}workflow:
  required: [plan, implement, run, test, checkpoint]
  tests:
    - { name: unit, service: api, command: [./gradlew, test] }
  allowedTools: [read_file, edit_file]
  protectedPaths: [.env, infra]
  releaseRequires: [checkpoint]
`);
    expect(spec.workflow).toMatchObject({
      required: ['plan', 'implement', 'run', 'test', 'checkpoint'],
      tests: [{ name: 'unit', service: 'api', command: ['./gradlew', 'test'], maxAttempts: 1 }],
      allowedTools: ['read_file', 'edit_file'],
      protectedPaths: ['.env', 'infra'],
      // zod는 모르는 키를 조용히 버린다. 선언한 필드가 실제로 남는지 확인한다
      releaseRequires: ['checkpoint'],
    });
    expect(() => parseSpec(`${ORDERS_SPEC}workflow:
  required: [plan, deploy]
`)).toThrow(SpecError);
  });

  it('실행할 수단이 없는 test·browser_check를 필수 단계로 두면 거부한다', () => {
    const noTests = captureError(() => parseSpec(`${ORDERS_SPEC}workflow:\n  required: [plan, test, checkpoint]\n`));
    expect(noTests.issues).toEqual(['workflow.tests: required에 test가 있으면 실행할 tests가 최소 1개 필요합니다']);
    const noPages = captureError(() => parseSpec(`${ORDERS_SPEC}workflow:\n  required: [browser_check]\n`));
    expect(noPages.issues).toEqual(['workflow.pageChecks: required에 browser_check가 있으면 확인할 pageChecks가 최소 1개 필요합니다']);
    const duplicate = captureError(() =>
      parseSpec(`${ORDERS_SPEC}workflow:\n  tests:\n    - { name: unit, service: api, command: [a] }\n    - { name: unit, service: web, command: [b] }\n`),
    );
    expect(duplicate.issues).toEqual(["workflow.tests.1.name: 테스트 이름 'unit'이 중복됩니다"]);
    const httpOnly = captureError(() =>
      parseSpec(`${ORDERS_SPEC}workflow:\n  pageChecks:\n    - { service: web, path: /, viewport: { width: 390, height: 844 }, noHorizontalScroll: true }\n`),
    );
    expect(httpOnly.issues).toEqual([
      'workflow.pageChecks.0.viewport: viewport는 mode: browser에서만 쓸 수 있습니다',
      'workflow.pageChecks.0.noHorizontalScroll: noHorizontalScroll은 mode: browser에서만 쓸 수 있습니다',
    ]);
    expect(
      parseSpec(`${ORDERS_SPEC}workflow:\n  pageChecks:\n    - { service: web, path: /, mode: browser, viewport: { width: 390, height: 844 }, noHorizontalScroll: true }\n`).workflow
        ?.pageChecks?.[0],
    ).toMatchObject({ mode: 'browser', viewport: { width: 390, height: 844 }, noHorizontalScroll: true, allowConsoleErrors: false });
    // //host 경로는 URL 해석에서 다른 호스트를 가리키므로 ready.path와 같은 규칙으로 막는다
    expect(() => parseSpec(`${ORDERS_SPEC}workflow:\n  pageChecks:\n    - { service: web, path: //evil.example.com }\n`)).toThrow(SpecError);
    expect(parseSpec(`${ORDERS_SPEC}workflow:\n  pageChecks:\n    - { service: web, path: /orders }\n`).workflow?.pageChecks).toEqual([
      { service: 'web', path: '/orders', mode: 'http', expectStatus: 200, allowConsoleErrors: false, noHorizontalScroll: false },
    ]);
  });

  it('autoPageChecks는 서비스·모드·상한·동적 값 규칙을 검사하고 기본값을 채운다', () => {
    // 기본값: http, 200, 5개
    const parsed = parseSpec(`${ORDERS_SPEC}workflow:\n  autoPageChecks: { service: web }\n`).workflow?.autoPageChecks;
    expect(parsed).toEqual({ service: 'web', mode: 'http', expectStatus: 200, maxPages: 5 });

    const full = parseSpec(
      `${ORDERS_SPEC}workflow:\n  autoPageChecks: { service: web, mode: browser, expectStatus: 201, maxPages: 10, sampleParams: { id: "1", slug: "a-b_c" }, viewport: { width: 390, height: 844 } }\n`,
    ).workflow?.autoPageChecks;
    expect(full).toMatchObject({ mode: 'browser', expectStatus: 201, maxPages: 10, sampleParams: { id: '1', slug: 'a-b_c' }, viewport: { width: 390, height: 844 } });

    // 상한 범위(1~10)를 벗어나면 거부한다
    expect(captureError(() => parseSpec(`${ORDERS_SPEC}workflow:\n  autoPageChecks: { service: web, maxPages: 0 }\n`)).issues).toEqual([
      'workflow.autoPageChecks.maxPages: Too small: expected number to be >=1',
    ]);
    expect(captureError(() => parseSpec(`${ORDERS_SPEC}workflow:\n  autoPageChecks: { service: web, maxPages: 11 }\n`)).issues).toEqual([
      'workflow.autoPageChecks.maxPages: maxPages는 최대 10개까지 쓸 수 있습니다',
    ]);
    // 값은 경로 조각으로 안전한 문자만 받는다(여기에 이상한 값이 들어가면 URL이 깨진다)
    expect(captureError(() => parseSpec(`${ORDERS_SPEC}workflow:\n  autoPageChecks: { service: web, sampleParams: { id: "../etc/passwd" } }\n`)).issues).toEqual([
      'workflow.autoPageChecks.sampleParams.id: 경로 조각으로 안전한 문자(영문·숫자·_·-)만 쓸 수 있습니다',
    ]);
    expect(captureError(() => parseSpec(`${ORDERS_SPEC}workflow:\n  autoPageChecks: { service: web, sampleParams: { "a/b": "1" } }\n`)).issues).toEqual([
      'workflow.autoPageChecks.sampleParams.a/b: 세그먼트 이름은 영문·숫자·_·-만 쓸 수 있습니다',
    ]);
    // http 모드에서 viewport를 받으면 검사한 것처럼 보이기만 한다
    expect(captureError(() => parseSpec(`${ORDERS_SPEC}workflow:\n  autoPageChecks: { service: web, viewport: { width: 390, height: 844 } }\n`)).issues).toEqual([
      'workflow.autoPageChecks.viewport: viewport는 mode: browser에서만 쓸 수 있습니다',
    ]);
  });

  it('browser 모드의 상호작용 단계를 읽고, http 모드나 잘못된 단계를 거부한다', () => {
    const spec = parseSpec(`${ORDERS_SPEC}workflow:
  pageChecks:
    - service: web
      path: /orders
      mode: browser
      steps:
        - { click: "[data-testid=refresh]" }
        - { fill: { selector: "#q", text: "김토스" } }
        - { press: Enter }
        - { waitFor: "text=김토스" }
      expectText: 김토스
`);
    const page = spec.workflow?.pageChecks?.[0];
    expect(page).toMatchObject({ mode: 'browser', expectText: '김토스' });
    expect(page?.steps).toEqual([
      { click: '[data-testid=refresh]' },
      { fill: { selector: '#q', text: '김토스' } },
      { press: 'Enter' },
      { waitFor: 'text=김토스' },
    ]);

    const httpSteps = captureError(() =>
      parseSpec(`${ORDERS_SPEC}workflow:\n  pageChecks:\n    - { service: web, path: /, steps: [{ click: "#a" }] }\n`),
    );
    expect(httpSteps.issues).toEqual(['workflow.pageChecks.0.steps: steps는 mode: browser에서만 쓸 수 있습니다']);

    const both = captureError(() =>
      parseSpec(`${ORDERS_SPEC}workflow:\n  pageChecks:\n    - { service: web, path: /, mode: browser, steps: [{ click: "#a", fill: { selector: "#q", text: x } }] }\n`),
    );
    expect(both.issues).toEqual(['workflow.pageChecks.0.steps.0: 단계에는 click, fill, press, waitFor 중 정확히 하나를 적어야 합니다']);

    const empty = captureError(() => parseSpec(`${ORDERS_SPEC}workflow:\n  pageChecks:\n    - { service: web, path: /, mode: browser, steps: [{}] }\n`));
    expect(empty.issues).toEqual(['workflow.pageChecks.0.steps.0: 단계에는 click, fill, press, waitFor 중 정확히 하나를 적어야 합니다']);
  });

  it('동시 요청 확인은 범위·경로·헤더 비밀 금지를 검사하고, expect에 조건이 필요하다', () => {
    const spec = parseSpec(`${ORDERS_SPEC}workflow:
  concurrencyChecks:
    - name: stock
      service: api
      method: POST
      path: /api/products/1/orders
      body: '{"qty":1}'
      headers: { content-type: application/json }
      concurrent: 10
      expect:
        successCount: { exactly: 1 }
        then: { method: GET, path: /api/products/1, jsonPath: "$.stock", equals: 0 }
`);
    expect(spec.workflow?.concurrencyChecks?.[0]).toMatchObject({
      name: 'stock',
      service: 'api',
      method: 'POST',
      path: '/api/products/1/orders',
      body: '{"qty":1}',
      headers: { 'content-type': 'application/json' },
      concurrent: 10,
      expect: { successCount: { exactly: 1 }, then: { method: 'GET', path: '/api/products/1', jsonPath: '$.stock', equals: 0 } },
    });

    const oneLiner = (line: string) => captureError(() => parseSpec(`${ORDERS_SPEC}workflow:\n  concurrencyChecks:\n    - ${line}\n`));
    // concurrent는 2~20만 받는다
    expect(oneLiner('{ name: a, service: api, method: GET, path: /, concurrent: 1, expect: { allStatusIn: [200] } }').issues).toEqual(expect.arrayContaining([expect.stringContaining('concurrent')]));
    expect(oneLiner('{ name: a, service: api, method: GET, path: /, concurrent: 21, expect: { allStatusIn: [200] } }').issues).toEqual(expect.arrayContaining([expect.stringContaining('concurrent')]));
    // //host 경로는 다른 호스트를 가리키므로 거부
    expect(oneLiner('{ name: a, service: api, method: GET, path: //evil.example.com, concurrent: 2, expect: { allStatusIn: [200] } }').issues.some((issue) => issue.startsWith('workflow.concurrencyChecks.0.path'))).toBe(true);
    // 비밀 값을 담는 인증 헤더는 거부
    expect(oneLiner('{ name: a, service: api, method: GET, path: /, headers: { Authorization: "Bearer x" }, concurrent: 2, expect: { allStatusIn: [200] } }').issues).toEqual([
      'workflow.concurrencyChecks.0.headers: 비밀 값을 담는 인증 헤더는 쓸 수 없습니다. 인증이 필요하면 서비스가 secrets의 환경 변수를 읽게 하세요',
    ]);
    // 헤더는 5개까지
    expect(oneLiner('{ name: a, service: api, method: GET, path: /, headers: { a: "1", b: "2", c: "3", d: "4", e: "5", f: "6" }, concurrent: 2, expect: { allStatusIn: [200] } }').issues.some((issue) => issue.startsWith('workflow.concurrencyChecks.0.headers'))).toBe(true);
    // expect에는 조건이 최소 하나 필요하다
    expect(oneLiner('{ name: a, service: api, method: GET, path: /, concurrent: 2, expect: {} }').issues).toEqual(expect.arrayContaining([expect.stringContaining('expect에는')]));
    // successCount에는 exactly나 atMost가 필요하다
    expect(oneLiner('{ name: a, service: api, method: GET, path: /, concurrent: 2, expect: { successCount: {} } }').issues).toEqual(expect.arrayContaining([expect.stringContaining('successCount에는')]));

    // required에 concurrency_check가 있으면 최소 하나 필요
    expect(captureError(() => parseSpec(`${ORDERS_SPEC}workflow:\n  required: [concurrency_check]\n`)).issues).toEqual([
      'workflow.concurrencyChecks: required에 concurrency_check가 있으면 실행할 concurrencyChecks가 최소 1개 필요합니다',
    ]);
    // 이름 중복
    const duplicate = captureError(() =>
      parseSpec(
        `${ORDERS_SPEC}workflow:\n  concurrencyChecks:\n    - { name: same, service: api, method: GET, path: /, concurrent: 2, expect: { allStatusIn: [200] } }\n    - { name: same, service: web, method: GET, path: /, concurrent: 2, expect: { allStatusIn: [200] } }\n`,
      ),
    );
    expect(duplicate.issues).toEqual(["workflow.concurrencyChecks.1.name: 동시 요청 확인 이름 'same'이 중복됩니다"]);
  });

  it('maxLoadMs는 browser 모드에서만 받는다', () => {
    expect(parseSpec(`${ORDERS_SPEC}workflow:\n  pageChecks:\n    - { service: web, path: /, mode: browser, maxLoadMs: 2000 }\n`).workflow?.pageChecks?.[0]).toMatchObject({
      maxLoadMs: 2000,
    });
    const http = captureError(() => parseSpec(`${ORDERS_SPEC}workflow:\n  pageChecks:\n    - { service: web, path: /, maxLoadMs: 2000 }\n`));
    expect(http.issues).toEqual(['workflow.pageChecks.0.maxLoadMs: maxLoadMs는 mode: browser에서만 쓸 수 있습니다']);
  });

  it('expectFromApi는 api 서비스·경로·jsonPath를 받고, 경로와 jsonPath를 좁게 검사한다', () => {
    const spec = parseSpec(`${ORDERS_SPEC}workflow:
  pageChecks:
    - service: web
      path: /orders
      expectText: 주문 목록
      expectFromApi: { service: api, path: /api/orders, jsonPath: "$[0].customerName" }
`);
    expect(spec.workflow?.pageChecks?.[0]).toMatchObject({
      service: 'web',
      path: '/orders',
      mode: 'http',
      expectStatus: 200,
      expectText: '주문 목록',
      expectFromApi: { service: 'api', path: '/api/orders', jsonPath: '$[0].customerName' },
    });

    // api 경로도 페이지 경로와 같은 규칙으로 //host를 거부한다
    expect(() =>
      parseSpec(`${ORDERS_SPEC}workflow:\n  pageChecks:\n    - { service: web, path: /, expectFromApi: { service: api, path: //evil.example/x, jsonPath: "$.a" } }\n`),
    ).toThrow(SpecError);
    // jsonPath는 비어 있을 수 없다
    const empty = captureError(() => parseSpec(`${ORDERS_SPEC}workflow:\n  pageChecks:\n    - { service: web, path: /, expectFromApi: { service: api, path: /api, jsonPath: "" } }\n`));
    expect(empty.issues.some((issue) => issue.startsWith('workflow.pageChecks.0.expectFromApi.jsonPath'))).toBe(true);
  });

  it('expectAnyText는 1~5개의 문구를 받고, expectText와 함께 쓸 수 있다', () => {
    const spec = parseSpec(`${ORDERS_SPEC}workflow:
  pageChecks:
    - { service: web, path: /dashboard, expectStatus: 200, expectText: 주문, expectAnyText: ["45000", "45,000"] }
`);
    expect(spec.workflow?.pageChecks?.[0]).toMatchObject({
      service: 'web',
      path: '/dashboard',
      mode: 'http',
      expectStatus: 200,
      expectText: '주문',
      expectAnyText: ['45000', '45,000'],
    });

    // 빈 목록은 거부한다
    const empty = captureError(() => parseSpec(`${ORDERS_SPEC}workflow:\n  pageChecks:\n    - { service: web, path: /, expectAnyText: [] }\n`));
    expect(empty.issues.some((issue) => issue.startsWith('workflow.pageChecks.0.expectAnyText'))).toBe(true);
    // 5개까지 받는다
    const tooMany = captureError(() => parseSpec(`${ORDERS_SPEC}workflow:\n  pageChecks:\n    - { service: web, path: /, expectAnyText: [a, b, c, d, e, f] }\n`));
    expect(tooMany.issues).toEqual(['workflow.pageChecks.0.expectAnyText: expectAnyText는 최대 5개까지 쓸 수 있습니다']);
  });

  it('expectAllText는 1~5개의 문구를 받는다', () => {
    const spec = parseSpec(`${ORDERS_SPEC}workflow:\n  pageChecks:\n    - { service: web, path: /orders, expectAllText: [김민수, 이영희] }\n`);
    expect(spec.workflow?.pageChecks?.[0]).toMatchObject({ path: '/orders', expectAllText: ['김민수', '이영희'] });
    const empty = captureError(() => parseSpec(`${ORDERS_SPEC}workflow:\n  pageChecks:\n    - { service: web, path: /, expectAllText: [] }\n`));
    expect(empty.issues.some((issue) => issue.startsWith('workflow.pageChecks.0.expectAllText'))).toBe(true);
    const tooMany = captureError(() => parseSpec(`${ORDERS_SPEC}workflow:\n  pageChecks:\n    - { service: web, path: /, expectAllText: [a, b, c, d, e, f] }\n`));
    expect(tooMany.issues).toEqual(['workflow.pageChecks.0.expectAllText: expectAllText는 최대 5개까지 쓸 수 있습니다']);
  });

  it('디자인 비교는 프로젝트 안 .png와 허용 비율을 받고, http 모드나 프로젝트 밖 경로는 거부한다', () => {
    const compareOf = (line: string) =>
      parseSpec(`${ORDERS_SPEC}workflow:\n  pageChecks:\n    - ${line}\n`).workflow?.pageChecks?.[0]?.compare;

    expect(
      compareOf(`{ service: web, path: /, mode: browser, viewport: mobile, compare: { reference: design/list.png, maxDiffRatio: 0.15, masks: [{ x: 0, y: 0, width: 10, height: 10 }] } }`),
    ).toEqual({ reference: 'design/list.png', maxDiffRatio: 0.15, masks: [{ x: 0, y: 0, width: 10, height: 10 }], threshold: 0.1 });
    // threshold를 적으면 그 값을, 생략하면 0.1을 쓴다
    expect(compareOf(`{ service: web, path: /, mode: browser, compare: { reference: a.png, maxDiffRatio: 0, threshold: 0.4 } }`)).toEqual({
      reference: 'a.png',
      maxDiffRatio: 0,
      threshold: 0.4,
    });

    // .png가 아니면 거부
    const notPng = captureError(() => parseSpec(`${ORDERS_SPEC}workflow:\n  pageChecks:\n    - { service: web, path: /, mode: browser, compare: { reference: design/list.jpg, maxDiffRatio: 0.1 } }\n`));
    expect(notPng.issues.some((issue) => issue.startsWith('workflow.pageChecks.0.compare.reference'))).toBe(true);
    // 프로젝트 밖 경로는 거부
    const outside = captureError(() => parseSpec(`${ORDERS_SPEC}workflow:\n  pageChecks:\n    - { service: web, path: /, mode: browser, compare: { reference: ../secret.png, maxDiffRatio: 0.1 } }\n`));
    expect(outside.issues.some((issue) => issue.startsWith('workflow.pageChecks.0.compare.reference'))).toBe(true);
    // masks는 최대 20개
    const masks = Array.from({ length: 21 }, () => '{ x: 0, y: 0, width: 1, height: 1 }').join(', ');
    const tooMany = captureError(() => parseSpec(`${ORDERS_SPEC}workflow:\n  pageChecks:\n    - { service: web, path: /, mode: browser, compare: { reference: a.png, maxDiffRatio: 0.1, masks: [${masks}] } }\n`));
    expect(tooMany.issues.some((issue) => issue.startsWith('workflow.pageChecks.0.compare.masks'))).toBe(true);
    // http 모드에서는 쓸 수 없다
    const http = captureError(() => parseSpec(`${ORDERS_SPEC}workflow:\n  pageChecks:\n    - { service: web, path: /, compare: { reference: a.png, maxDiffRatio: 0.1 } }\n`));
    expect(http.issues).toEqual(['workflow.pageChecks.0.compare: compare는 mode: browser에서만 쓸 수 있습니다']);
  });

  it('뷰포트는 크기 객체나 mobile·tablet·desktop 이름으로 적고 파싱 뒤에는 항상 크기 객체로 맞춘다', () => {
    const viewport = (value: string) =>
      parseSpec(`${ORDERS_SPEC}workflow:\n  pageChecks:\n    - { service: web, path: /, mode: browser, viewport: ${value} }\n`).workflow?.pageChecks?.[0]
        ?.viewport;
    expect(viewport('mobile')).toEqual({ width: 375, height: 812 });
    expect(viewport('tablet')).toEqual({ width: 768, height: 1024 });
    expect(viewport('desktop')).toEqual({ width: 1280, height: 800 });
    // 크기 객체는 그대로 남는다
    expect(viewport('{ width: 390, height: 844 }')).toEqual({ width: 390, height: 844 });
    expect(() => parseSpec(`${ORDERS_SPEC}workflow:\n  pageChecks:\n    - { service: web, path: /, mode: browser, viewport: phone }\n`)).toThrow(SpecError);
    // http 모드에서는 이름이든 객체든 쓸 수 없다
    const http = captureError(() => parseSpec(`${ORDERS_SPEC}workflow:\n  pageChecks:\n    - { service: web, path: /, viewport: mobile }\n`));
    expect(http.issues).toEqual(['workflow.pageChecks.0.viewport: viewport는 mode: browser에서만 쓸 수 있습니다']);
  });

  it('network.egress는 호스트 문자열과 평문 HTTP 경로·메서드 규칙을 함께 받는다', () => {
    const spec = parseSpec(`${ORDERS_SPEC}network:
  egress:
    - api.slack.com
    - host: audit.example.com
      methods: [POST]
      paths: ["/events/*"]
    - host: readonly.example.com
`);
    expect(spec.network?.egress).toEqual([
      'api.slack.com',
      { host: 'audit.example.com', methods: ['POST'], paths: ['/events/*'] },
      { host: 'readonly.example.com', methods: ['GET', 'HEAD'], paths: ['/**'] },
    ]);

    expect(() => parseSpec(`${ORDERS_SPEC}network:\n  egress: [127.0.0.1]\n`)).toThrow(SpecError);
    expect(() => parseSpec(`${ORDERS_SPEC}network:\n  egress:\n    - { host: api.example.com, paths: [users] }\n`)).toThrow(SpecError);
  });

  it('external 서비스에는 browser 미리보기를 쓸 수 없다', () => {
    const source = `
version: 1
name: x
services:
  users: { source: external, baseUrl: https://a.example.com, preview: browser }
`;
    expect(() => parseSpec(source)).toThrow(SpecError);
  });

  it('다른 호스트를 가리킬 수 있는 "//" 경로를 거부한다', () => {
    const source = `
version: 1
name: x
services:
  api: { source: managed, template: fastapi, path: api, port: 8000, preview: openapi, contract: { extract: //evil.example/openapi.json } }
`;
    const error = captureError(() => parseSpec(source));
    expect(error.issues.some((issue) => issue.startsWith('services.api.contract.extract'))).toBe(true);
  });

  it('문제가 있는 필드 경로를 알려준다', () => {
    const source = `
version: 1
name: x
services:
  web: { source: managed, template: nextjs, path: web, preview: browser }
`;
    const error = captureError(() => parseSpec(source));
    expect(error.issues.some((issue) => issue.startsWith('services.web.port'))).toBe(true);
  });
});

describe('loadProject', () => {
  it('compose에 없는 managed 서비스와 compose에 있는 external 서비스를 잡아낸다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'spec-test-'));
    await writeFile(path.join(dir, 'studio.yaml'), ORDERS_SPEC);
    await writeFile(
      path.join(dir, 'compose.yaml'),
      'services:\n  web: { build: ./web }\n  legacy-users: { image: nginx }\n',
    );

    const error = await loadProject(dir).then(
      () => expect.unreachable(),
      (e: unknown) => e as SpecError,
    );
    expect(error.issues).toHaveLength(2);
    expect(error.issues[0]).toContain('services.api');
    expect(error.issues[1]).toContain('services.legacy-users');
  });

  it('external 볼륨을 샌드박스 공유 캐시 목록으로 모은다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'spec-test-'));
    await writeFile(
      path.join(dir, 'studio.yaml'),
      'version: 1\nname: x\nservices:\n  api: { source: managed, template: fastapi, path: api, port: 8000, preview: openapi }\n',
    );
    await writeFile(
      path.join(dir, 'compose.yaml'),
      'services:\n  api: { build: ./api }\nvolumes:\n  data:\n  uv-cache: { external: true, name: b-studio-cache-uv }\n  shared: { external: true }\n',
    );

    const project = await loadProject(dir);
    expect(project.sharedVolumes).toEqual(['b-studio-cache-uv', 'shared']);
  });

  it('스냅샷 볼륨은 서비스가 마운트하는 샌드박스 전용 볼륨이어야 한다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'spec-test-'));
    await writeFile(
      path.join(dir, 'studio.yaml'),
      `version: 1
name: x
services:
  web:
    source: managed
    template: nextjs
    path: web
    port: 3000
    preview: browser
    snapshots:
      - { volume: web-node-modules, key: [pnpm-lock.yaml] }
      - { volume: pnpm-store, key: [pnpm-lock.yaml] }
      - { volume: missing, key: [pnpm-lock.yaml] }
      - { volume: web-next, key: [package.json] }
`,
    );
    await writeFile(
      path.join(dir, 'compose.yaml'),
      `services:
  web:
    build: ./web
    volumes:
      - ./web:/app
      - web-node-modules:/app/node_modules
      - { type: volume, source: pnpm-store, target: /cache/pnpm }
volumes:
  web-node-modules:
  web-next:
  pnpm-store: { external: true, name: b-studio-cache-pnpm }
`,
    );

    const error = await loadProject(dir).then(
      () => expect.unreachable(),
      (e: unknown) => e as SpecError,
    );
    expect(error.issues).toEqual([
      "services.web.snapshots.1.volume: 샌드박스끼리 공유하는 external 볼륨은 스냅샷으로 만들 수 없습니다",
      "services.web.snapshots.2.volume: compose.yaml의 volumes에 'missing'이 없습니다",
      "services.web.snapshots.3.volume: compose.yaml의 web 서비스가 'web-next' 볼륨을 마운트하지 않습니다",
    ]);
  });

  it('데이터베이스는 compose의 부가 서비스여야 하고, depends_on으로 기대는 서비스를 찾는다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'spec-test-'));
    await writeFile(
      path.join(dir, 'studio.yaml'),
      `version: 1
name: x
services:
  web: { source: managed, template: nextjs, path: web, port: 3000, preview: browser }
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }
  worker: { source: managed, template: fastapi, path: worker, port: 8000, preview: logs }
databases:
  db: { engine: postgres, database: app, user: app }
`,
    );
    await writeFile(
      path.join(dir, 'compose.yaml'),
      `services:
  web: { build: ./web, depends_on: [api] }
  api: { build: ./api, depends_on: { db: { condition: service_healthy } } }
  worker: { build: ./worker, depends_on: [db] }
  db: { image: postgres:17-alpine }
`,
    );

    const project = await loadProject(dir);
    expect(project.databases).toEqual([['db', { engine: 'postgres', database: 'app', user: 'app', dependents: ['api', 'worker'] }]]);
  });

  it('자원 한도는 compose 서비스에만 걸 수 있고 docker 메모리 표기를 쓴다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'spec-test-'));
    await writeFile(
      path.join(dir, 'studio.yaml'),
      `version: 1
name: x
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }
resources:
  api: { memory: 1536m, cpus: 2 }
  db: { memory: 256m }
  missing: { memory: 1g }
`,
    );
    await writeFile(path.join(dir, 'compose.yaml'), 'services:\n  api: { build: ./api }\n  db: { image: postgres:17-alpine }\n');

    const error = await loadProject(dir).then(
      () => expect.unreachable(),
      (e: unknown) => e as SpecError,
    );
    expect(error.issues).toEqual(['resources.missing: compose.yaml에 같은 이름의 서비스가 없습니다']);

    const bad = captureError(() => parseSpec('version: 1\nname: x\nservices:\n  api: { source: managed, template: t, path: api, port: 1, preview: logs }\nresources:\n  api: { memory: 2GB }\n  db: {}\n'));
    expect(bad.issues.some((issue) => issue.startsWith('resources.api.memory'))).toBe(true);
    expect(bad.issues.some((issue) => issue.startsWith('resources.db'))).toBe(true);
  });

  it('워크플로 테스트와 화면 확인은 관리형 서비스에서만 돌린다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'spec-workflow-'));
    await writeFile(
      path.join(dir, 'studio.yaml'),
      `version: 1
name: x
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }
workflow:
  tests:
    - { name: unit, service: api, command: [./gradlew, test] }
    - { name: db, service: db, command: [pg_isready] }
  pageChecks:
    - { service: web, path: /, expectFromApi: { service: db, path: /api/orders, jsonPath: "$[0].customerName" } }
`,
    );
    await writeFile(path.join(dir, 'compose.yaml'), 'services:\n  api: { build: ./api }\n  db: { image: postgres:17-alpine }\n');

    const error = await loadProject(dir).then(
      () => expect.unreachable(),
      (e: unknown) => e as SpecError,
    );
    expect(error.issues).toEqual([
      "workflow.tests.1.service: 'db'은(는) source: managed 서비스가 아닙니다",
      "workflow.pageChecks.0.service: 'web'은(는) source: managed 서비스가 아닙니다",
      "workflow.pageChecks.0.expectFromApi.service: 'db'은(는) source: managed 서비스가 아닙니다",
    ]);
  });

  it('자동 페이지 확인은 관리형이면서 nextjs인 서비스에서만 켤 수 있다', async () => {
    const write = async (spec: string): Promise<string> => {
      const dir = await mkdtemp(path.join(tmpdir(), 'spec-autopage-'));
      await writeFile(path.join(dir, 'studio.yaml'), spec);
      await writeFile(path.join(dir, 'compose.yaml'), 'services:\n  web: { build: ./web }\n  api: { build: ./api }\n  db: { image: postgres:17-alpine }\n');
      return dir;
    };
    const spec = (service: string) => `version: 1
name: x
services:
  web: { source: managed, template: nextjs, path: web, port: 3000, preview: browser }
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }
workflow:
  autoPageChecks: { service: ${service} }
`;

    // nextjs 서비스면 통과한다
    await expect(loadProject(await write(spec('web')))).resolves.toBeDefined();

    const notNextjs = await loadProject(await write(spec('api'))).then(
      () => expect.unreachable(),
      (e: unknown) => e as SpecError,
    );
    expect(notNextjs.issues).toEqual([
      "workflow.autoPageChecks.service: 'api'의 템플릿이 spring-boot입니다. app 라우터를 쓰는 Next.js(nextjs) 서비스에서만 자동 페이지 확인을 켤 수 있습니다",
    ]);

    const notManaged = await loadProject(await write(spec('db'))).then(
      () => expect.unreachable(),
      (e: unknown) => e as SpecError,
    );
    expect(notManaged.issues).toEqual(["workflow.autoPageChecks.service: 'db'은(는) source: managed 서비스가 아닙니다"]);
  });

  it('시크릿은 환경 변수 이름으로 적고, 받을 서비스는 compose에 있어야 한다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'spec-test-'));
    await writeFile(
      path.join(dir, 'studio.yaml'),
      `version: 1
name: x
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }
secrets:
  PAYMENT_API_KEY: { services: [api], description: 결제 대행사 테스트 키 }
  WEBHOOK_TOKEN: { services: [api, worker] }
`,
    );
    await writeFile(path.join(dir, 'compose.yaml'), 'services:\n  api: { build: ./api }\n');

    const error = await loadProject(dir).then(
      () => expect.unreachable(),
      (e: unknown) => e as SpecError,
    );
    expect(error.issues).toEqual(["secrets.WEBHOOK_TOKEN.services: compose.yaml에 'worker' 서비스가 없습니다"]);

    const bad = captureError(() =>
      parseSpec('version: 1\nname: x\nservices:\n  api: { source: managed, template: t, path: api, port: 1, preview: logs }\nsecrets:\n  payment-key: { services: [api] }\n'),
    );
    expect(bad.issues.some((issue) => issue.startsWith('secrets.payment-key'))).toBe(true);
  });

  it('외부 API 정책의 호출자는 compose 서비스나 studio이고, 인증은 선언한 시크릿을 쓴다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'spec-test-'));
    await writeFile(
      path.join(dir, 'studio.yaml'),
      `version: 1
name: x
services:
  api: { source: managed, template: spring-boot, path: api, port: 8080, preview: openapi }
  legacy-users:
    source: external
    baseUrl: https://users.internal.example.com
    policy:
      allow:
        - { callers: [api, studio], methods: [GET], paths: ["/api/users/*"] }
        - { callers: [worker], methods: [POST] }
      mask: [phone, email]
      auth: { header: Authorization, secret: LEGACY_USERS_TOKEN, prefix: "Bearer " }
  billing:
    source: external
    baseUrl: https://billing.internal.example.com
    policy:
      auth: { header: X-Api-Key, secret: MISSING_TOKEN }
secrets:
  LEGACY_USERS_TOKEN: {}
  UNUSED_TOKEN: {}
`,
    );
    await writeFile(path.join(dir, 'compose.yaml'), 'services:\n  api: { build: ./api }\n');

    const error = await loadProject(dir).then(
      () => expect.unreachable(),
      (e: unknown) => e as SpecError,
    );
    expect(error.issues).toEqual([
      "services.legacy-users.policy.allow.1.callers: 'worker'은(는) compose.yaml의 서비스도 studio도 아닙니다",
      "services.billing.policy.auth.secret: secrets에 'MISSING_TOKEN'이 없습니다",
      'secrets.UNUSED_TOKEN: 받을 서비스(services)나 외부 API 인증(policy.auth)에 쓰이지 않습니다',
    ]);

    expect(parseSpec('version: 1\nname: x\nservices:\n  users: { source: external, baseUrl: "https://users.example.com" }\n').services.users).toMatchObject({
      policy: { mask: [], maskPatterns: [] },
    });
    const ftp = captureError(() => parseSpec('version: 1\nname: x\nservices:\n  users: { source: external, baseUrl: "ftp://users.example.com" }\n'));
    expect(ftp.issues[0]).toMatch(/^services\.users\.baseUrl/);
    const credentials = captureError(() => parseSpec('version: 1\nname: x\nservices:\n  users: { source: external, baseUrl: "https://svc:pw@users.example.com" }\n'));
    expect(credentials.issues).toEqual(['services.users.baseUrl: 주소에 자격 증명을 넣지 말고 policy.auth와 secrets를 쓰세요']);
  });

  it('외부 접속 허용 목록은 호스트 이름만 받는다', () => {
    const spec = parseSpec('version: 1\nname: x\nservices:\n  api: { source: managed, template: t, path: api, port: 1, preview: logs }\nnetwork:\n  egress: [api.slack.com, "*.internal-mirror.example.com"]\n');
    expect(spec.network?.egress).toEqual(['api.slack.com', '*.internal-mirror.example.com']);

    const error = captureError(() =>
      parseSpec('version: 1\nname: x\nservices:\n  api: { source: managed, template: t, path: api, port: 1, preview: logs }\nnetwork:\n  egress: [10.0.0.5, "db.prod:5432"]\n'),
    );
    expect(error.issues.filter((issue) => issue.startsWith('network.egress'))).toHaveLength(2);
  });

  it('SQL에 들어가는 데이터베이스 이름과 사용자는 식별자만 허용한다', () => {
    const source = `
version: 1
name: x
services:
  api: { source: managed, template: fastapi, path: api, port: 8000, preview: openapi }
databases:
  db: { engine: postgres, database: 'app"; DROP DATABASE x; --', user: app }
`;
    const error = captureError(() => parseSpec(source));
    expect(error.issues.some((issue) => issue.startsWith('databases.db.database'))).toBe(true);
  });

  it('스냅샷 키는 서비스 폴더 밖을 가리킬 수 없다', () => {
    const source = `
version: 1
name: x
services:
  web: { source: managed, template: nextjs, path: web, port: 3000, preview: browser, snapshots: [{ volume: nm, key: [../secrets.env, /etc/passwd] }] }
`;
    const error = captureError(() => parseSpec(source));
    expect(error.issues.filter((issue) => issue.startsWith('services.web.snapshots.0.key'))).toHaveLength(2);
  });
});

function captureError(fn: () => unknown): SpecError {
  try {
    fn();
  } catch (error) {
    if (error instanceof SpecError) return error;
    throw error;
  }
  return expect.unreachable('SpecError가 발생해야 합니다');
}
