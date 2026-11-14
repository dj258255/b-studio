import { readFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import { encodeLoneSurrogates, native, type Sandbox } from '@b-studio/sandbox';
import type { LoadedProject, WorkflowPageCheck, WorkflowSpec } from '@b-studio/spec';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { BrowserUnavailableError, StepFailedError, type BrowserFrame, type BrowserPageResult, type BrowserPageStep, type BrowserRunner } from './browser-check';
import { Gen } from './differential-kit';
import { VerificationGate, type PageFetcher } from './gate';
import { legacyCheck } from './gate-legacy';
import type { AgentEvent } from './loop';
import { createOrdersProject, fakeSandbox, ORDERS_CONTRACT } from './test-helpers';
import { Workspace } from './workspace';

/**
 * 게이트의 화면 확인 판정(`#checkPage`·`#apiValue`·`#checkFallbackProbe`)을 Rust로 옮기면서(ADR-195 4f A5c-1) 옛 구현(`check-page-legacy.ts`를 부르는 `gate-legacy.ts`)과
 * 지금 구현(`VerificationGate.check`)에 **같은 시나리오**를 넣어 견준다. 시나리오마다 임시 폴더에 프로젝트를 새로 만들고(도커·네트워크·실제 브라우저 없음, 가짜 sandbox·가짜 러너·가짜 fetcher)
 * 옛 쪽과 지금 쪽이 각자의 세계에서 돈다. 견주는 것: ① check 결과(`GateOutcome` 또는 던진 오류의 종류·글) ② 이벤트 전체 ③ 게이트의 공개 상태(`checks`: 근거·단계·비교·로드 시간·막은 요청·경고 포함)
 * ④ sandbox·페이지 요청·러너·저장 호출 기록(순서와 인자). 시나리오는 대부분 화면 확인 하나라 호출 순서까지 같아야 한다.
 */

const roots: string[] = [];

type Mode = 'legacy' | 'current';
type RunnerOptions = Parameters<BrowserRunner>[1];

interface Setup {
  workflow: Partial<WorkflowSpec>;
  /** 'web'(nextjs) 서비스를 더한다. 자동 화면 확인용 */
  nextjs?: boolean;
  /** 게이트를 만들기 전에 프로젝트에 둔 파일 */
  files?: Record<string, string | Buffer>;
  /** 게이트를 만든 뒤 작업 공간으로 쓴 파일(바뀐 파일로 잡혀 자동 화면 확인의 대상이 된다) */
  changes?: Record<string, string>;
  page?: PageFetcher;
  browser?: (url: string, options: RunnerOptions) => BrowserPageResult | Promise<BrowserPageResult>;
  redact?: (text: string) => string;
  endpoint?: (service: string) => string | Promise<string>;
  /** 'none'이면 saveArtifact를 넘기지 않는다. 함수면 그것이 저장한다 */
  save?: 'none' | ((name: string) => string | Promise<string>);
  /** 러너가 부르는 프레임 전달을 받을 처리기를 넘긴다 */
  frames?: boolean;
  signal?: AbortSignal;
}

interface Trace {
  result: { outcome: unknown } | { threw: { name: string; message: string } };
  events: string[];
  state: unknown;
  text: string;
}

const rendered = { status: 200, text: '주문 목록', pageErrors: [], consoleErrors: [], failedRequests: [], mediaErrors: [], blockedRequests: [], horizontalOverflowPx: 0, steps: [] } as unknown as BrowserPageResult;
const view = (over: Partial<BrowserPageResult> = {}): BrowserPageResult => ({ ...rendered, ...over }) as BrowserPageResult;

const png = (width: number, height: number, paint: (x: number, y: number) => [number, number, number] = () => [255, 255, 255]): Buffer => {
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (width * y + x) << 2;
      const [r, g, b] = paint(x, y);
      image.data[index] = r;
      image.data[index + 1] = g;
      image.data[index + 2] = b;
      image.data[index + 3] = 255;
    }
  }
  return PNG.sync.write(image);
};

async function runWorld(mode: Mode, setup: Setup): Promise<{ trace: Trace; calls: string[] }> {
  const base = await createOrdersProject('check-page-diff-');
  roots.push(base.root);
  const { root } = base;
  await writeFile(path.join(root, 'compose.yaml'), 'services:\n  api: { build: ./api }\n  web: { build: ./web }\n');
  let project = { ...base, spec: { ...base.spec, workflow: setup.workflow } } as LoadedProject;
  if (setup.nextjs) {
    project = { ...project, managed: [...project.managed, ['web', { source: 'managed', template: 'nextjs', path: 'web', port: 3000, preview: 'browser' }]] } as unknown as LoadedProject;
  }
  for (const [file, content] of Object.entries(setup.files ?? {})) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }

  const calls: string[] = [];
  const sandbox: Sandbox = fakeSandbox(project, []);
  sandbox.endpoint = async (service: string) => {
    calls.push(`endpoint:${service}`);
    return { service, containerPort: 8080, url: setup.endpoint ? await setup.endpoint(service) : 'http://127.0.0.1:1' };
  };
  const baseRedact = setup.redact;
  sandbox.redact = (text: string) => {
    calls.push(`redact:${JSON.stringify(text)}`);
    return baseRedact ? baseRedact(text) : text;
  };
  const warn = vi.spyOn(console, 'warn').mockImplementation((message: unknown) => {
    calls.push(`warn:${String(message)}`);
  });

  const workspace = new Workspace(root);
  const events: string[] = [];
  let saved = 0;
  const gate = await VerificationGate.create({
    project,
    sandbox,
    workspace,
    allowBreaking: false,
    maxVerifyAttempts: 3,
    platformRetryDelayMs: 1,
    ...(setup.signal ? { signal: setup.signal } : {}),
    fetcher: async () => ORDERS_CONTRACT,
    pageFetcher: async (url, signal) => {
      calls.push(`page:${url}:${signal instanceof AbortSignal}`);
      return setup.page ? setup.page(url, signal) : { status: 200, text: '<h1>주문 목록</h1>' };
    },
    browserRunner: async (url, options) => {
      const { signal, onFrame, ...rest } = options;
      calls.push(`browser:${url}:${JSON.stringify(rest)}:signal=${signal instanceof AbortSignal}:frame=${onFrame !== undefined}`);
      onFrame?.({ kind: 'test' } as unknown as BrowserFrame);
      return setup.browser ? setup.browser(url, options) : rendered;
    },
    ...(setup.save === 'none'
      ? {}
      : {
          saveArtifact: async ({ name, data, contentType }) => {
            calls.push(`save:${name}:${data.length}:${contentType}`);
            return typeof setup.save === 'function' ? setup.save(name) : `art-${(saved += 1)}`;
          },
        }),
    ...(setup.frames ? { onBrowserFrame: ({ check }: { check: string }) => void calls.push(`frame:${check}`) } : {}),
    onEvent: (event: AgentEvent) => void events.push(JSON.stringify(event)),
  });
  await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');
  for (const [file, content] of Object.entries(setup.changes ?? {})) await workspace.write(file, content);

  let result: Trace['result'];
  try {
    const outcome = mode === 'legacy' ? await legacyCheck(gate) : await gate.check();
    result = { outcome };
  } catch (error) {
    result = { threw: { name: error instanceof Error ? error.name : typeof error, message: error instanceof Error ? error.message : String(error) } };
  }
  warn.mockRestore();
  const state = { attempts: gate.attempts, checks: gate.checks, passedStages: [...gate.passedStages].sort(), verified: gate.verified, platformFailure: gate.platformFailure, lastOutcome: gate.lastOutcome };
  const text = JSON.stringify({ result, events, state }).replaceAll(root, '<R>');
  return { trace: { ...(JSON.parse(text) as Omit<Trace, 'text'>), text }, calls: calls.map((call) => call.replaceAll(root, '<R>')) };
}

/** 같은 시나리오를 옛 구현과 지금 구현에 넣어 견주고, 옛 구현의 결과를 돌려준다. 화면 확인이 둘 이상이면 동시에 도는 호출은 끼어드는 순서가 달라 정렬해 견준다 */
async function compare(make: () => Setup, options: { interleaved?: true } = {}) {
  const legacy = await runWorld('legacy', make());
  const current = await runWorld('current', make());
  expect(current.trace.text).toEqual(legacy.trace.text);
  if (options.interleaved) expect([...current.calls].sort()).toEqual([...legacy.calls].sort());
  else expect(current.calls).toEqual(legacy.calls);
  return legacy;
}

const checksOf = (trace: Trace) => (trace.state as { checks: Array<Record<string, unknown>> }).checks;
const pageCheck = (trace: Trace) => checksOf(trace).find((check) => check.stage === 'browser_check')!;
const detail = (trace: Trace): string => String(pageCheck(trace).detail ?? '');
const thrownOf = (trace: Trace) => (trace.result as { threw: { name: string; message: string } }).threw;

const page = (over: Partial<WorkflowPageCheck> = {}): WorkflowPageCheck =>
  ({ service: 'api', path: '/orders', mode: 'http', expectStatus: 200, expectText: '주문 목록', allowConsoleErrors: false, noHorizontalScroll: false, ...over }) as WorkflowPageCheck;
const bpage = (over: Partial<WorkflowPageCheck> = {}): WorkflowPageCheck => page({ mode: 'browser', ...over });
const one = (over: Partial<WorkflowPageCheck>, rest: Omit<Setup, 'workflow'> = {}): Setup => ({ workflow: { pageChecks: [page(over)] }, ...rest });
const oneB = (over: Partial<WorkflowPageCheck>, rest: Omit<Setup, 'workflow'> = {}): Setup => ({ workflow: { pageChecks: [bpage(over)] }, ...rest });

afterAll(() => {
  roots.length = 0;
});

describe('HTTP 모드', () => {
  const cases: Array<[string, () => Setup, string[]]> = [
    ['통과: 근거를 붙인다', () => one({}), ['pass']],
    ['상태 코드가 다르면 실패', () => one({}, { page: async () => ({ status: 404, text: '주문 목록' }) }), ['HTTP 404 (기대 200)']],
    ['기대 상태가 404이고 응답도 404면 통과', () => one({ expectStatus: 404 }, { page: async () => ({ status: 404, text: '주문 목록' }) }), ['pass']],
    ['expectText가 없으면 실패', () => one({ expectText: '없는 글자' }), ["응답 본문에 '없는 글자'가 없습니다"]],
    ['expectText가 빈 글자면 건너뛴다', () => one({ expectText: '' }, { page: async () => ({ status: 200, text: 'x' }) }), ['pass']],
    ['expectAnyText: 하나라도 있으면 통과', () => one({ expectText: undefined, expectAnyText: ['없음', '주문'] }), ['pass']],
    ['expectAnyText: 어느 것도 없으면 실패', () => one({ expectText: undefined, expectAnyText: ['없음', '또 없음'] }), ["'없음', '또 없음' 중 어느 것도 없습니다"]],
    ['expectAnyText가 빈 배열이면 실패(하나도 없다)', () => one({ expectText: undefined, expectAnyText: [] }), ['중 어느 것도 없습니다']],
    ['expectAllText: 모두 있으면 통과', () => one({ expectText: undefined, expectAllText: ['주문', '목록'] }), ['pass']],
    ['expectAllText: 빠진 것만 알린다', () => one({ expectText: undefined, expectAllText: ['주문', '없음1', '없음2'] }), ["'없음1', '없음2'가 없습니다"]],
    ['expectAllText가 빈 배열이면 통과', () => one({ expectText: undefined, expectAllText: [] }), ['pass']],
    ['expectText와 expectAnyText가 둘 다 어긋나면 첫 실패에서 멈춘다', () => one({ expectText: '없음', expectAnyText: ['없음2'] }), ["'없음'가 없습니다"]],
    ['짝 없는 서로게이트: 본문에 쌍이 있고 기대가 그 반쪽이면 JS는 찾았다고 읽는다', () => one({ expectText: '\ud83d' }, { page: async () => ({ status: 200, text: '😀' }) }), ['pass']],
    ['짝 없는 서로게이트: 본문의 반쪽 둘이 기대와 다르면 U+FFFD로 합쳐 찾았다고 읽지 않는다', () => one({ expectText: '\ud83d' }, { page: async () => ({ status: 200, text: '\udc00 \ude00' }) }), ['없습니다']],
    ['짝 없는 서로게이트: expectAnyText', () => one({ expectText: undefined, expectAnyText: ['\ud800', '\ude00'] }, { page: async () => ({ status: 200, text: 'a\ud801b\udc00' }) }), ['어느 것도 없습니다']],
    ['짝 없는 서로게이트: expectAllText 빠진 글자', () => one({ expectText: undefined, expectAllText: ['\ud800', '\ud801'] }, { page: async () => ({ status: 200, text: 'a\ud801b' }) }), ['가 없습니다']],
    ['짝 없는 서로게이트: 같은 글자는 찾는다', () => one({ expectText: '\ud801' }, { page: async () => ({ status: 200, text: 'a\ud801b' }) }), ['pass']],
    ['예약 글자(U+E010)가 본문에 그대로 있어도 짝 없는 서로게이트로 읽지 않는다', () => one({ expectText: '' }, { page: async () => ({ status: 200, text: 'a\ud801b' }) }), ['없습니다']],
    ['예약 글자가 본문에 그대로 있고 기대도 같으면 찾는다', () => one({ expectText: '' }, { page: async () => ({ status: 200, text: 'xy' }) }), ['pass']],
    ['본문이 빈 글자', () => one({ expectText: undefined }, { page: async () => ({ status: 200, text: '' }) }), ['pass']],
    ['sandbox.redact가 값을 가린다', () => one({ expectText: '비밀' }, { redact: (text) => text.replaceAll('비밀', '***'), page: async () => ({ status: 200, text: '없음' }) }), ["'***'가 없습니다"]],
  ];
  it.each(cases)('%s', async (_title, make, expected) => {
    const legacy = await compare(make);
    if (expected[0] === 'pass') expect(pageCheck(legacy.trace)).toMatchObject({ ok: true });
    else for (const part of expected) expect(detail(legacy.trace) + JSON.stringify(legacy.trace.result), part).toContain(part);
  });

  it('통과하면 근거에 HTTP 확인임을 적는다', async () => {
    const legacy = await compare(() => one({}));
    expect(pageCheck(legacy.trace).evidence).toEqual(expect.arrayContaining([expect.stringContaining('HTTP 확인이라 자바스크립트를 실행하지 않았습니다')]));
  });

  it('요청이 실패하면(연결 거부) 그 오류 글로 실패한다', async () => {
    const legacy = await compare(() =>
      one({}, {
        page: async () => {
          throw new Error('fetch failed');
        },
      }),
    );
    expect(detail(legacy.trace)).toBe('fetch failed');
  });

  it('요청이 던진 값이 Error가 아니면 글자로 바꿔 남긴다', async () => {
    const legacy = await compare(() =>
      one({}, {
        page: async () => {
          throw 'boom-string';
        },
      }),
    );
    expect(detail(legacy.trace)).toBe('boom-string');
  });

  it('endpoint가 던지면 그 오류 글로 실패한다', async () => {
    const legacy = await compare(() =>
      one({ service: 'web' }, {
        endpoint: (service) => {
          if (service === 'web') throw new Error('서비스가 없습니다');
          return 'http://127.0.0.1:1';
        },
      }),
    );
    expect(detail(legacy.trace)).toBe('서비스가 없습니다');
  });

  const outside = ['//evil.example/x', 'http://evil.example/x', '\\\\evil.example\\x', '/\\evil.example/x', '\t//evil.example', 'http://127.0.0.1:2/x'];
  it.each(outside)('서비스 출처 밖 경로(%j)는 요청하지 않고 실패한다', async (pathText) => {
    const legacy = await compare(() => one({ path: pathText }));
    expect(legacy.calls.some((call) => call.startsWith('page:'))).toBe(false);
  });

  it('출처 밖 경로의 글은 path must stay on the service host다', async () => {
    const legacy = await compare(() => one({ path: '//evil.example/x' }));
    expect(detail(legacy.trace)).toBe('path must stay on the service host');
  });

  it('사설 URL이 풀리지 않으면(잘못된 endpoint) 그 오류로 실패한다', async () => {
    const legacy = await compare(() => one({ service: 'web' }, { endpoint: (service) => (service === 'web' ? 'not a url' : 'http://127.0.0.1:1') }));
    expect(detail(legacy.trace)).toContain('Invalid URL');
  });
});

describe('api 값(expectFromApi)', () => {
  const from = (over: Record<string, unknown> = {}) => ({ service: 'api', path: '/api/orders/1', jsonPath: '$.total', ...over }) as WorkflowPageCheck['expectFromApi'];
  const api = (body: unknown, status = 200): PageFetcher => async (url) => (url.includes('/api/') ? { status, text: typeof body === 'string' ? body : JSON.stringify(body) } : { status: 200, text: '<p>주문 목록 12,000 ABC</p>' });
  const cases: Array<[string, () => Setup, string]> = [
    ['숫자: 원문이 화면에 있으면 통과', () => one({ expectFromApi: from() }, { page: async (url) => (url.includes('/api/') ? { status: 200, text: '{"total":120}' } : { status: 200, text: '주문 목록 120' }) }), 'pass'],
    ['숫자: 천 단위 쉼표로도 찾는다', () => one({ expectFromApi: from() }, { page: api({ total: 12000 }) }), 'pass'],
    ['숫자: 화면에 없으면 실패', () => one({ expectFromApi: from() }, { page: api({ total: 777 }) }), "api의 $.total 값 '777'이 /orders 화면에 없습니다"],
    ['숫자: 소수 셋째 자리 반올림 표기', () => one({ expectFromApi: from() }, { page: async (url) => (url.includes('/api/') ? { status: 200, text: '{"total":1234.5678}' } : { status: 200, text: '주문 목록 1,234.568' }) }), 'pass'],
    ['숫자: 음수·0', () => one({ expectFromApi: from() }, { page: async (url) => (url.includes('/api/') ? { status: 200, text: '{"total":-0}' } : { status: 200, text: '주문 목록 0' }) }), 'pass'],
    ['숫자: 큰 수', () => one({ expectFromApi: from() }, { page: async (url) => (url.includes('/api/') ? { status: 200, text: '{"total":1e21}' } : { status: 200, text: '주문 목록 1e+21' }) }), 'pass'],
    ['글자: 있으면 통과', () => one({ expectFromApi: from({ jsonPath: '$.name' }) }, { page: api({ name: 'ABC' }) }), 'pass'],
    ['글자: 없으면 실패', () => one({ expectFromApi: from({ jsonPath: '$.name' }) }, { page: api({ name: 'ZZZ' }) }), "api의 $.name 값 'ZZZ'이 /orders 화면에 없습니다"],
    ['글자: 짝 없는 서로게이트가 화면의 다른 반쪽과 합쳐지지 않는다', () => one({ expectFromApi: from({ jsonPath: '$.name' }) }, { page: async (url) => (url.includes('/api/') ? { status: 200, text: '{"name":"\\ud800"}' } : { status: 200, text: '주문 목록 \udc00' }) }), '없습니다'],
    ['글자: 같은 짝 없는 서로게이트는 찾는다', () => one({ expectFromApi: from({ jsonPath: '$.name' }) }, { page: async (url) => (url.includes('/api/') ? { status: 200, text: '{"name":"\\ud800"}' } : { status: 200, text: '주문 목록 \ud800' }) }), 'pass'],
    ['값이 없음(undefined): 응답 앞부분을 적는다', () => one({ expectFromApi: from({ jsonPath: '$.none' }) }, { page: api({ total: 1 }) }), '응답에 $.none이 없습니다. 응답 앞부분: {"total":1}'],
    ['값이 null', () => one({ expectFromApi: from() }, { page: api({ total: null }) }), '응답에 $.total이 없습니다'],
    ['JSON이 아님', () => one({ expectFromApi: from() }, { page: api('not json') }), '응답 앞부분: not json'],
    ['응답 앞부분 200자 자르기', () => one({ expectFromApi: from({ jsonPath: '$.none' }) }, { page: api(`{"pad":"${'가'.repeat(300)}"}`) }), '응답 앞부분:'],
    ['응답 앞부분 200자 경계가 서로게이트 쌍의 가운데', () => one({ expectFromApi: from({ jsonPath: '$.none' }) }, { page: api(`${'a'.repeat(199)}😀tail`) }), '응답 앞부분:'],
    ['응답 앞부분에 짝 없는 서로게이트', () => one({ expectFromApi: from({ jsonPath: '$.none' }) }, { page: api(`${'a'.repeat(10)}\ud800${'b'.repeat(300)}`) }), '응답 앞부분:'],
    ['가린 뒤에 자른다(시크릿이 경계에 걸림)', () => one({ expectFromApi: from({ jsonPath: '$.none' }) }, { redact: (text) => text.replaceAll('SECRETVALUE', '***'), page: api(`${'a'.repeat(195)}SECRETVALUE${'b'.repeat(50)}`) }), '응답 앞부분:'],
    ['객체', () => one({ expectFromApi: from({ jsonPath: '$' }) }, { page: api({ total: 1 }) }), '$는 객체입니다'],
    ['배열', () => one({ expectFromApi: from({ jsonPath: '$.list' }) }, { page: api({ list: [1] }) }), '$.list는 배열입니다'],
    ['불리언', () => one({ expectFromApi: from({ jsonPath: '$.on' }) }, { page: api({ on: true }) }), '$.on는 boolean입니다'],
    ['빈 글자', () => one({ expectFromApi: from({ jsonPath: '$.name' }) }, { page: api({ name: '  ' }) }), '값이 빈 문자열입니다'],
    ['공백 글자(\\u00a0·BOM)도 빈 글자로 본다', () => one({ expectFromApi: from({ jsonPath: '$.name' }) }, { page: api({ name: ' ﻿' }) }), '값이 빈 문자열입니다'],
    ['상속한 키(__proto__)는 객체', () => one({ expectFromApi: from({ jsonPath: '$.__proto__' }) }, { page: api({ a: 1 }) }), '는 객체입니다'],
    ['배열의 __proto__는 배열', () => one({ expectFromApi: from({ jsonPath: '$.a.__proto__' }) }, { page: api({ a: [] }) }), '는 배열입니다'],
    ['배열 length는 숫자', () => one({ expectFromApi: from({ jsonPath: '$.a.length' }) }, { page: async (url) => (url.includes('/api/') ? { status: 200, text: '{"a":[1,2,3]}' } : { status: 200, text: '주문 목록 3' }) }), 'pass'],
    ['api가 HTTP 오류', () => one({ expectFromApi: from() }, { page: api({ total: 1 }, 500) }), 'api GET /api/orders/1가 HTTP 500을 돌려줬습니다'],
    ['api가 3xx', () => one({ expectFromApi: from() }, { page: api({ total: 1 }, 302) }), 'HTTP 302'],
    ['api 경로가 서비스 출처 밖', () => one({ expectFromApi: from({ path: '//evil.example/x' }) }), 'path must stay on the service host'],
    ['api 요청이 실패', () => one({ expectFromApi: from() }, { page: async () => Promise.reject(new Error('연결 거부')) }), '연결 거부'],
    ['api가 다른 서비스(본문에 값이 있어야 통과)', () => one({ expectFromApi: from({ service: 'web' }) }, { page: async (url) => (url.includes('/api/') ? { status: 200, text: '{"total":7}' } : { status: 200, text: '주문 목록 7' }) }), 'pass'],
    ['userinfo가 있는 같은 출처 경로는 요청한다', () => one({ path: 'http://user@127.0.0.1:1/x' }), 'pass'],
    ['api 값이 실패하면 화면은 열지 않는다', () => oneB({ expectFromApi: from({ jsonPath: '$.none' }) }, { page: api({ total: 1 }) }), '응답에 $.none이 없습니다'],
    ['가림 함수가 던지면 그 오류로 실패한다', () => one({ expectFromApi: from({ jsonPath: '$.none' }) }, { redact: () => { throw new Error('redact 실패'); }, page: api({ total: 1 }) }), 'redact 실패'],
  ];
  it.each(cases)('%s', async (_title, make, expected) => {
    const legacy = await compare(make);
    if (expected === 'pass') expect(pageCheck(legacy.trace)).toMatchObject({ ok: true });
    else expect(detail(legacy.trace), expected).toContain(expected);
  });

  it('browser 모드: 화면 글자에서 찾고, 없으면 problems에 넣는다', async () => {
    const pass = await compare(() => oneB({ expectText: undefined, expectFromApi: from() }, { page: api({ total: 12000 }), browser: () => view({ text: '합계 12,000' }) }));
    expect(pageCheck(pass.trace)).toMatchObject({ ok: true });
    expect(pageCheck(pass.trace).evidence).toEqual(expect.arrayContaining([expect.stringContaining('api의 $.total 값 \'12000\' 화면에 있음')]));
    const fail = await compare(() => oneB({ expectText: undefined, expectFromApi: from() }, { page: api({ total: 12000 }), browser: () => view({ text: '합계 0' }) }));
    expect(detail(fail.trace)).toContain("api의 $.total 값 '12000'이 /orders 화면에 없습니다");
  });

  it('http 모드: 근거에 api 값이 응답 본문에 있었다고 적는다', async () => {
    const legacy = await compare(() => one({ expectFromApi: from() }, { page: api({ total: 12000 }) }));
    expect(pageCheck(legacy.trace).evidence).toEqual(expect.arrayContaining([expect.stringContaining('응답 본문에 있음')]));
  });
});

describe('브라우저 모드', () => {
  const cases: Array<[string, () => Setup, string[]]> = [
    ['통과: 근거를 붙인다', () => oneB({}), ['pass']],
    ['상태 코드 실패', () => oneB({}, { browser: () => view({ status: 500 }) }), ['HTTP 500 (기대 200)']],
    ['상태가 null이면 응답 없음', () => oneB({}, { browser: () => view({ status: null }) }), ['HTTP 응답 없음 (기대 200)']],
    ['기대 상태가 404이고 404면 통과', () => oneB({ expectStatus: 404 }, { browser: () => view({ status: 404 }) }), ['pass']],
    ['expectText 없음', () => oneB({ expectText: '없는 글자' }), ["렌더링된 화면에 '없는 글자'가 없습니다"]],
    ['expectAnyText 통과', () => oneB({ expectText: undefined, expectAnyText: ['x', '주문'] }), ['pass']],
    ['expectAnyText 실패', () => oneB({ expectText: undefined, expectAnyText: ['x', 'y'] }), ["'x', 'y' 중 어느 것도 없습니다"]],
    ['expectAllText 빠진 것만', () => oneB({ expectText: undefined, expectAllText: ['주문', 'x'] }), ["화면에 'x'가 없습니다"]],
    ['expectText·Any·All 모두 어긋나면 모두 나열한다', () => oneB({ expectText: 'a', expectAnyText: ['b'], expectAllText: ['c', 'd'] }), ["'a'가 없습니다", "'b' 중", "'c', 'd'가 없습니다"]],
    ['짝 없는 서로게이트 기대(쌍의 반쪽)는 JS처럼 찾는다', () => oneB({ expectText: '\ud83d' }, { browser: () => view({ text: '😀' }) }), ['pass']],
    ['짝 없는 서로게이트 기대가 다른 반쪽과 U+FFFD로 합쳐지지 않는다', () => oneB({ expectText: '\ud83d' }, { browser: () => view({ text: '\ude00' }) }), ['없습니다']],
    ['스크립트 예외', () => oneB({}, { browser: () => view({ pageErrors: ['boom'] }) }), ['스크립트 예외: boom']],
    ['스크립트 예외 3개까지만', () => oneB({}, { browser: () => view({ pageErrors: ['a', 'b', 'c', 'd', 'e'] }) }), ['스크립트 예외: a | b | c']],
    ['console.error 3개 넘으면 앞 3개', () => oneB({}, { browser: () => view({ consoleErrors: ['1', '2', '3', '4'] }) }), ['console.error: 1 | 2 | 3']],
    ['실패한 요청 3개 넘으면 앞 3개', () => oneB({}, { browser: () => view({ failedRequests: ['GET /a 404', 'GET /b 500', 'GET /c 500', 'GET /d 500'] }) }), ['실패한 요청: GET /a 404 | GET /b 500 | GET /c 500']],
    ['미디어 오류 3개 넘으면 앞 3개', () => oneB({}, { browser: () => view({ mediaErrors: ['v1', 'v2', 'v3', 'v4'] }) }), ['미디어 오류: v1 | v2 | v3']],
    ['allowConsoleErrors면 콘솔·요청·미디어는 실패로 보지 않는다', () => oneB({ allowConsoleErrors: true }, { browser: () => view({ consoleErrors: ['x'], failedRequests: ['y'], mediaErrors: ['z'] }) }), ['pass']],
    ['allowConsoleErrors여도 스크립트 예외는 실패다', () => oneB({ allowConsoleErrors: true }, { browser: () => view({ pageErrors: ['x'] }) }), ['스크립트 예외: x']],
    ['모든 문제를 정해진 순서로 이어 적는다', () => oneB({ expectText: '없음' }, { browser: () => view({ status: 500, pageErrors: ['p'], consoleErrors: ['c'], failedRequests: ['f'], mediaErrors: ['m'], horizontalOverflowPx: 9 }) }), ['HTTP 500', "'없음'", '스크립트 예외', 'console.error', '실패한 요청', '미디어 오류']],
    ['로딩 문구만 보여 주고 멈춤', () => oneB({ expectText: undefined }, { browser: () => view({ text: 'Loading...' }) }), ['화면이 로딩 문구만 보여 준 채 멈췄습니다']],
    ['allowLoadingPlaceholder면 로딩 문구도 통과', () => oneB({ expectText: undefined, allowLoadingPlaceholder: true }, { browser: () => view({ text: 'Loading...' }) }), ['pass']],
    ['빈 화면 + 실패한 요청(증거)', () => oneB({ expectText: undefined }, { browser: () => view({ text: '', failedRequests: ['x'] }) }), ['화면에 표시된 내용이 없습니다']],
    ['빈 화면 + 증거 없음은 통과', () => oneB({ expectText: undefined }, { browser: () => view({ text: '' }) }), ['pass']],
    ['빈 화면 + 콘솔 오류 증거(allowConsoleErrors라도 증거로 셈)', () => oneB({ expectText: undefined, allowConsoleErrors: true }, { browser: () => view({ text: '', consoleErrors: ['x'] }) }), ['화면에 표시된 내용이 없습니다']],
    ['로딩 문구 + 로딩 문구 본문에 짝 없는 서로게이트', () => oneB({ expectText: undefined }, { browser: () => view({ text: 'Loading...\ud800' }) }), ['pass']],
    ['가로 넘침 1은 통과', () => oneB({ noHorizontalScroll: true }, { browser: () => view({ horizontalOverflowPx: 1 }) }), ['pass']],
    ['가로 넘침 1.5는 실패', () => oneB({ noHorizontalScroll: true }, { browser: () => view({ horizontalOverflowPx: 1.5 }) }), ['가로로 1.5px 넘칩니다']],
    ['가로 넘침 100', () => oneB({ noHorizontalScroll: true }, { browser: () => view({ horizontalOverflowPx: 100 }) }), ['가로로 100px 넘칩니다']],
    ['noHorizontalScroll이 꺼져 있으면 넘쳐도 통과', () => oneB({}, { browser: () => view({ horizontalOverflowPx: 100 }) }), ['pass']],
    ['로드 예산: 안 넘으면 통과', () => oneB({ maxLoadMs: 1000 }, { browser: () => view({ loadMs: 999 }) }), ['pass']],
    ['로드 예산: 같으면 통과', () => oneB({ maxLoadMs: 1000 }, { browser: () => view({ loadMs: 1000 }) }), ['pass']],
    ['로드 예산: 넘으면 실패(천 단위 쉼표)', () => oneB({ maxLoadMs: 1000 }, { browser: () => view({ loadMs: 12345 }) }), ['로드 12,345ms (예산 1,000ms)']],
    ['로드 예산: 소수 셋째 자리 반올림', () => oneB({ maxLoadMs: 1000.5 }, { browser: () => view({ loadMs: 1234.56789 }) }), ['로드 1,234.568ms (예산 1,000.5ms)']],
    ['로드 예산: 소수 반올림 경계', () => oneB({ maxLoadMs: 0.0004 }, { browser: () => view({ loadMs: 0.0005 }) }), ['로드']],
    ['로드 예산: 0', () => oneB({ maxLoadMs: 0 }, { browser: () => view({ loadMs: 0.0001 }) }), ['로드 0ms (예산 0ms)']],
    ['로드 예산: 큰 수', () => oneB({ maxLoadMs: 1000 }, { browser: () => view({ loadMs: 123456789012 }) }), ['로드 123,456,789,012ms']],
    ['로드 예산: 재지 못하면 실패', () => oneB({ maxLoadMs: 1000 }, { browser: () => view({}) }), ['로드 시간을 재지 못했습니다 (예산 1,000ms)']],
    ['로드 예산: 재지 못한 것 + 예산 큰 수', () => oneB({ maxLoadMs: 1234567.5 }, { browser: () => view({}) }), ['예산 1,234,567.5ms']],
    ['예산이 없으면 loadMs가 있어도 통과', () => oneB({}, { browser: () => view({ loadMs: 99999 }) }), ['pass']],
    ['첫 화면 글자: 보이면 통과', () => oneB({ expectInViewport: ['주문'] }, { browser: () => view({ viewportTexts: { width: 390, height: 844, findings: [{ text: '주문', visible: true }] } }) }), ['pass']],
    ['첫 화면 글자: 결과가 아예 없으면 실패', () => oneB({ expectInViewport: ['주문', '목록'] }), ["'주문', '목록'가 첫 화면에 보이는지 재지 못했습니다"]],
    ['첫 화면 글자: 일부 결과가 빠지면 실패', () => oneB({ expectInViewport: ['주문', '목록'] }, { browser: () => view({ viewportTexts: { width: 390, height: 844, findings: [{ text: '주문', visible: true }] } }) }), ["'목록'이 첫 화면에 보이는지 재지 못했습니다"]],
    ['첫 화면 글자: 보이지 않는 이유', () => oneB({ expectInViewport: ['주문'] }, { browser: () => view({ viewportTexts: { width: 390, height: 844, findings: [{ text: '주문', visible: false, problem: { kind: 'below', px: 120 } }] } }) }), ["'주문'이 첫 화면에 다 보이지 않습니다 — 창 아래로 120px 넘칩니다(창 390x844)"]],
    ['첫 화면 글자: 이유를 모름', () => oneB({ expectInViewport: ['주문'] }, { browser: () => view({ viewportTexts: { width: 1, height: 2, findings: [{ text: '주문', visible: false }] } }) }), ['보이지 않는 이유를 알 수 없습니다(창 1x2)']],
    ['첫 화면 글자: 짝 없는 서로게이트 두 글자를 섞지 않는다', () => oneB({ expectInViewport: ['\ud800'] }, { browser: () => view({ viewportTexts: { width: 1, height: 2, findings: [{ text: '\ud801', visible: true }] } }) }), ['재지 못했습니다']],
    ['첫 화면 글자: 같은 짝 없는 서로게이트는 짝지어진다', () => oneB({ expectInViewport: ['\ud800'] }, { browser: () => view({ viewportTexts: { width: 1, height: 2, findings: [{ text: '\ud800', visible: true }] } }) }), ['pass']],
    ['첫 화면 글자를 적지 않았으면 결과가 있어도 보지 않는다', () => oneB({}, { browser: () => view({ viewportTexts: { width: 1, height: 2, findings: [{ text: 'x', visible: false }] } }) }), ['pass']],
  ];
  it.each(cases)('%s', async (_title, make, expected) => {
    const legacy = await compare(make);
    if (expected[0] === 'pass') expect(pageCheck(legacy.trace)).toMatchObject({ ok: true });
    else for (const part of expected) expect(detail(legacy.trace) + JSON.stringify(legacy.trace.result), part).toContain(part);
  });

  it('통과하면 근거에 쓴 값을 적는다(단계·로드·창 크기·가로 넘침)', async () => {
    const legacy = await compare(() =>
      oneB(
        { noHorizontalScroll: true, maxLoadMs: 5000, expectInViewport: ['주문'], expectAnyText: ['주문', 'x'], expectAllText: ['주문', '목록'], steps: [{ action: 'click', selector: 'a' }, { action: 'click', selector: 'b' }] as never },
        {
          browser: () =>
            view({
              loadMs: 1234.5,
              viewportTexts: { width: 390, height: 844, findings: [{ text: '주문', visible: true }] },
              steps: [{ label: 'open /orders', ok: true }, { label: 'click a', ok: true }, { label: 'click b', ok: false }] as BrowserPageStep[],
            }),
        },
      ),
    );
    expect(pageCheck(legacy.trace)).toMatchObject({ ok: true });
    expect(pageCheck(legacy.trace).evidence).toEqual(expect.arrayContaining([expect.stringContaining('단계 1/2개 실행: click a → click b'), expect.stringContaining('로드 1,234.5ms (예산 5,000ms)'), expect.stringContaining('창 390x844')]));
  });

  it('러너에 넘기는 옵션(viewport·viewportTexts·steps·measureLoad·capture·allowedOrigins·signal·onFrame)', async () => {
    const legacy = await compare(() =>
      oneB({ viewport: { width: 390, height: 844 }, expectInViewport: ['주문'], maxLoadMs: 100, steps: [{ action: 'click', selector: 'a' }] as never }, { frames: true, browser: () => view({ loadMs: 1, viewportTexts: { width: 1, height: 1, findings: [{ text: '주문', visible: true }] } }) }),
    );
    const call = legacy.calls.find((entry) => entry.startsWith('browser:'))!;
    expect(call).toContain('"measureLoad":true');
    expect(call).toContain('"capture":true');
    expect(call).toContain('"allowedOrigins":["http://127.0.0.1:1"]');
    expect(call).toContain('signal=true:frame=true');
    expect(legacy.calls).toContain('frame:api /orders (browser 390x844, 단계 1개)');
  });

  it('saveArtifact가 없으면 capture는 끄고(비교도 없으면) 단계를 저장하지 않는다', async () => {
    const legacy = await compare(() => oneB({}, { save: 'none', browser: () => view({ steps: [{ label: 'open /orders', ok: true, screenshot: Buffer.from([1]) }] as BrowserPageStep[] }) }));
    expect(legacy.calls.find((entry) => entry.startsWith('browser:'))).toContain('"capture":false');
    expect(pageCheck(legacy.trace).steps).toBeUndefined();
  });

  it('saveArtifact가 있으면 단계 스크린샷을 저장하고 식별자를 붙인다. 저장 실패는 삼킨다', async () => {
    let count = 0;
    const legacy = await compare(() => {
      count = 0;
      return oneB({}, {
        save: (name) => {
          if (++count === 2) throw new Error(`저장 실패 ${name}`);
          return `art-${count}`;
        },
        browser: () => view({ steps: [{ label: 'open /orders', ok: true, screenshot: Buffer.from([1, 2]) }, { label: 'click a', ok: true, detail: 'ok', screenshot: Buffer.from([3]) }, { label: 'noshot', ok: false }] as BrowserPageStep[] }),
      });
    });
    expect(pageCheck(legacy.trace).steps).toEqual([{ label: 'open /orders', ok: true, artifact: 'art-1' }, { label: 'click a', ok: true, detail: 'ok' }, { label: 'noshot', ok: false }]);
    expect(legacy.calls.some((entry) => entry.startsWith('warn:화면 확인 스크린샷을 저장하지 못했습니다'))).toBe(true);
  });

  it('막은 요청은 결과에 기록만 한다(실패로 세지 않는다)', async () => {
    const legacy = await compare(() => oneB({}, { browser: () => view({ blockedRequests: ['http://evil/x'] }) }));
    expect(pageCheck(legacy.trace)).toMatchObject({ ok: true });
    expect(detail(legacy.trace)).toContain('다른 출처 요청 1건을 막았습니다');
  });

  it('로드 시간은 문제가 있어도 결과에 남긴다', async () => {
    const legacy = await compare(() => oneB({ maxLoadMs: 10 }, { browser: () => view({ loadMs: 500 }) }));
    expect(pageCheck(legacy.trace)).toMatchObject({ ok: false, metrics: { loadMs: 500 } });
  });

  it('단계가 실패하면(StepFailedError) 단계 스크린샷을 저장한 뒤 같은 오류로 실패한다', async () => {
    const legacy = await compare(() =>
      oneB({ steps: [{ action: 'click', selector: '#missing' }] as never }, {
        browser: () => {
          throw new StepFailedError('2번째 단계 실패: click #missing', [{ label: 'open /orders', ok: true, screenshot: Buffer.from([1]) }, { label: 'click #missing', ok: false, detail: 'timeout', screenshot: Buffer.from([2]) }] as BrowserPageStep[]);
        },
      }),
    );
    expect(detail(legacy.trace)).toBe('2번째 단계 실패: click #missing');
    expect(pageCheck(legacy.trace).steps).toEqual([{ label: 'open /orders', ok: true, artifact: 'art-1' }, { label: 'click #missing', ok: false, detail: 'timeout', artifact: 'art-2' }]);
  });

  it('StepFailedError인데 saveArtifact가 없으면 단계에 식별자 없이 남긴다', async () => {
    const legacy = await compare(() =>
      oneB({ steps: [{ action: 'click', selector: '#missing' }] as never }, {
        save: 'none',
        browser: () => {
          throw new StepFailedError('단계 실패', [{ label: 'open /orders', ok: false, screenshot: Buffer.from([1]) }] as BrowserPageStep[]);
        },
      }),
    );
    expect(pageCheck(legacy.trace).steps).toEqual([{ label: 'open /orders', ok: false }]);
  });

  it('그 밖의 러너 오류는 그대로 실패다(fallbackProbe가 있어도)', async () => {
    const legacy = await compare(() =>
      oneB({ fallbackProbe: { service: 'api', path: '/health' } }, {
        browser: () => {
          throw new Error('러너가 죽었습니다');
        },
      }),
    );
    expect(detail(legacy.trace)).toBe('러너가 죽었습니다');
    expect(legacy.calls.some((entry) => entry.startsWith('page:'))).toBe(false);
  });

  it('러너가 Error가 아닌 값을 던져도 글자로 남긴다', async () => {
    const legacy = await compare(() =>
      oneB({}, {
        browser: () => {
          throw 'string-thrown';
        },
      }),
    );
    expect(detail(legacy.trace)).toBe('string-thrown');
  });

  it('디자인 비교는 문제가 없을 때만 부른다(문제가 있으면 부르지 않는다)', async () => {
    const shot = png(20, 20);
    const compareSpec = { reference: 'design.png', maxDiffRatio: 0.02, threshold: 0.1 };
    const files = { 'design.png': shot };
    const passing = await compare(() => oneB({ compare: compareSpec as never }, { files, browser: () => view({ steps: [{ label: 'open /orders', ok: true, screenshot: shot }] as BrowserPageStep[] }) }));
    expect(pageCheck(passing.trace)).toMatchObject({ ok: true, compare: { ratio: 0, max: 0.02 } });
    expect(passing.calls.filter((entry) => entry.startsWith('save:')).length).toBe(4);
    const problem = await compare(() => oneB({ expectText: '없음', compare: compareSpec as never }, { files, browser: () => view({ steps: [{ label: 'open /orders', ok: true, screenshot: shot }] as BrowserPageStep[] }) }));
    expect(pageCheck(problem.trace)).toMatchObject({ ok: false });
    expect(pageCheck(problem.trace).compare).toBeUndefined();
    expect(problem.calls.filter((entry) => entry.startsWith('save:')).length).toBe(1);
  });

  it('디자인 비교: 차이가 크면 비교 결과를 남기고 실패한다', async () => {
    const compareSpec = { reference: 'design.png', maxDiffRatio: 0.02, threshold: 0.1 };
    const legacy = await compare(() =>
      oneB({ compare: compareSpec as never }, { files: { 'design.png': png(100, 100) }, browser: () => view({ steps: [{ label: 'open /orders', ok: true, screenshot: png(100, 100, (x, y) => (x < 20 && y < 20 ? [0, 0, 0] : [255, 255, 255])) }] as BrowserPageStep[] }) }),
    );
    expect(detail(legacy.trace)).toContain('디자인 차이 4.0% (허용 2.0%, 비교 100×100)');
    expect(pageCheck(legacy.trace).compare).toBeTruthy();
  });

  it('디자인 비교: 스크린샷이 없으면 실패(찍지 못했습니다)', async () => {
    const legacy = await compare(() => oneB({ compare: { reference: 'design.png', maxDiffRatio: 0.02, threshold: 0.1 } as never }, { files: { 'design.png': png(10, 10) }, browser: () => view({ steps: [{ label: 'open /orders', ok: true }] as BrowserPageStep[] }) }));
    expect(detail(legacy.trace)).toBe('디자인 비교에 쓸 뷰포트 스크린샷을 찍지 못했습니다');
  });

  it('디자인 비교: 단계가 하나도 없으면 실패', async () => {
    const legacy = await compare(() => oneB({ compare: { reference: 'design.png', maxDiffRatio: 0.02, threshold: 0.1 } as never }, { files: { 'design.png': png(10, 10) } }));
    expect(detail(legacy.trace)).toBe('디자인 비교에 쓸 뷰포트 스크린샷을 찍지 못했습니다');
  });

  it('디자인 비교: 기준 이미지가 없으면 실패', async () => {
    const legacy = await compare(() => oneB({ compare: { reference: 'missing.png', maxDiffRatio: 0.02, threshold: 0.1 } as never }, { browser: () => view({ steps: [{ label: 'open /orders', ok: true, screenshot: png(10, 10) }] as BrowserPageStep[] }) }));
    expect(detail(legacy.trace)).toBe('디자인 기준 이미지를 읽지 못했습니다: missing.png');
  });

  it('디자인 비교: 너비가 다르면 실패', async () => {
    const legacy = await compare(() => oneB({ compare: { reference: 'design.png', maxDiffRatio: 0.02, threshold: 0.1 } as never }, { files: { 'design.png': png(100, 100) }, browser: () => view({ steps: [{ label: 'open /orders', ok: true, screenshot: png(120, 100) }] as BrowserPageStep[] }) }));
    expect(detail(legacy.trace)).toContain('이미지 너비가 다릅니다');
  });

  it('디자인 비교의 이미지 저장이 실패해도 비교 결과는 남는다', async () => {
    const shot = png(10, 10);
    let count = 0;
    const legacy = await compare(() => {
      count = 0;
      return oneB({ compare: { reference: 'design.png', maxDiffRatio: 0.02, threshold: 0.1 } as never }, {
        files: { 'design.png': shot },
        save: () => {
          if (++count === 3) throw new Error('저장 실패');
          return `a${count}`;
        },
        browser: () => view({ steps: [{ label: 'open /orders', ok: true, screenshot: shot }] as BrowserPageStep[] }),
      });
    });
    expect(pageCheck(legacy.trace)).toMatchObject({ ok: true });
    expect(legacy.calls.some((entry) => entry.startsWith('warn:디자인 비교 이미지를 저장하지 못했습니다'))).toBe(true);
  });

  it('디자인 비교는 saveArtifact가 없어도 돈다(비교 이미지는 저장하지 않는다)', async () => {
    const shot = png(10, 10);
    const legacy = await compare(() => oneB({ compare: { reference: 'design.png', maxDiffRatio: 0.02, threshold: 0.1 } as never }, { save: 'none', files: { 'design.png': shot }, browser: () => view({ steps: [{ label: 'open /orders', ok: true, screenshot: shot }] as BrowserPageStep[] }) }));
    expect(legacy.calls.find((entry) => entry.startsWith('browser:'))).toContain('"capture":true');
    expect(pageCheck(legacy.trace)).toMatchObject({ ok: true, compare: { ratio: 0, max: 0.02 } });
  });

  it('가림: 실패 글은 가린 뒤에 돌려준다', async () => {
    const legacy = await compare(() => oneB({}, { redact: (text) => text.replaceAll('SECRET', '***'), browser: () => view({ pageErrors: ['토큰 SECRET 노출'] }) }));
    expect(detail(legacy.trace)).toContain('토큰 *** 노출');
  });

  it('근거의 값도 가린 뒤 자른다', async () => {
    const legacy = await compare(() => oneB({ expectText: 'SECRETVALUE' }, { redact: (text) => text.replaceAll('SECRETVALUE', '***'), browser: () => view({ text: `앞 SECRETVALUE 뒤` }) }));
    expect(JSON.stringify(pageCheck(legacy.trace).evidence)).not.toContain('SECRETVALUE');
  });

  it('근거를 만들다 가림 함수가 던지면 근거 없이 통과로 남는다(판정은 이미 났다)', async () => {
    const legacy = await compare(() => oneB({}, { redact: () => { throw new Error('가림 실패'); } }));
    expect(pageCheck(legacy.trace)).toMatchObject({ ok: true });
    expect(pageCheck(legacy.trace).evidence).toBeUndefined();
  });

  it('실패 글을 가리다 던지면 그 오류가 실패 글이 된다', async () => {
    const legacy = await compare(() => oneB({ expectText: '없음' }, { redact: () => { throw new Error('가림 실패'); } }));
    expect(detail(legacy.trace)).toBe('가림 실패');
  });

  it('근거가 12줄을 넘으면 앞 11줄과 그 밖에 N가지', async () => {
    const legacy = await compare(() => oneB({ expectText: '주문', expectAnyText: ['주문'], expectAllText: ['주문'], noHorizontalScroll: true, allowLoadingPlaceholder: true, maxLoadMs: 5 }, { browser: () => view({ loadMs: 1 }) }));
    expect(pageCheck(legacy.trace)).toMatchObject({ ok: true });
  });

  it('근거 한 줄이 240자를 넘으면 자른다(가린 뒤)', async () => {
    const long = '가'.repeat(300);
    const legacy = await compare(() => oneB({ expectText: long }, { browser: () => view({ text: long }) }));
    expect(String(pageCheck(legacy.trace).evidence)).toContain('…');
  });
});

describe('브라우저를 못 띄울 때(fallbackProbe)', () => {
  const unavailable = (message = 'chromium 실행 파일이 없습니다') => () => {
    throw new BrowserUnavailableError(message);
  };
  const probe = { service: 'api', path: '/health' };
  it('fallbackProbe가 있으면 HTTP로 확인하고 경고를 남긴다', async () => {
    const legacy = await compare(() => oneB({ fallbackProbe: probe }, { browser: unavailable() }));
    expect(pageCheck(legacy.trace)).toMatchObject({ ok: true });
    expect(detail(legacy.trace)).toContain('[참고] 헤드리스 브라우저를 쓸 수 없어(chromium 실행 파일이 없습니다)');
    expect(pageCheck(legacy.trace).evidence).toEqual([expect.stringContaining('헤드리스 브라우저 없이 api/health의 HTTP 응답(200)만 확인했습니다')]);
  });
  it('응답 상태가 500이어도(응답을 받았으면) 살아 있다고 본다', async () => {
    const legacy = await compare(() => oneB({ fallbackProbe: probe }, { browser: unavailable(), page: async () => ({ status: 500, text: '' }) }));
    expect(pageCheck(legacy.trace)).toMatchObject({ ok: true });
    expect(detail(legacy.trace)).toContain('응답 500');
  });
  it('expectInViewport가 있으면 확인하지 못했다는 경고를 더한다', async () => {
    const legacy = await compare(() => oneB({ fallbackProbe: probe, expectInViewport: ['주문', '목록'] }, { browser: unavailable() }));
    expect(detail(legacy.trace)).toContain("expectInViewport('주문', '목록')가 첫 화면에 보이는지는 확인하지 못했습니다");
  });
  it('fallbackProbe가 없으면 그대로 실패한다', async () => {
    const legacy = await compare(() => oneB({}, { browser: unavailable() }));
    expect(detail(legacy.trace)).toBe('chromium 실행 파일이 없습니다');
    expect(legacy.calls.some((entry) => entry.startsWith('page:'))).toBe(false);
  });
  it('연결하지 못하면 실패한다', async () => {
    const legacy = await compare(() =>
      oneB({ fallbackProbe: probe }, {
        browser: unavailable(),
        page: async () => {
          throw new Error('ECONNREFUSED');
        },
      }),
    );
    expect(detail(legacy.trace)).toContain('대신 확인했는데 연결하지 못했습니다: ECONNREFUSED');
  });
  it('연결 실패가 Error가 아닌 값이어도 글자로 남긴다', async () => {
    const legacy = await compare(() =>
      oneB({ fallbackProbe: probe }, {
        browser: unavailable(),
        page: async () => Promise.reject('refused'),
      }),
    );
    expect(detail(legacy.trace)).toContain('연결하지 못했습니다: refused');
  });
  const outside = ['//evil.example/x', 'http://evil.example/x', '/\\evil.example/x', '\t//evil.example', 'http://127.0.0.1:2/x'];
  it.each(outside)('서비스 밖으로 풀리는 경로(%j)는 요청하지 않고 실패한다', async (pathText) => {
    const legacy = await compare(() => oneB({ fallbackProbe: { service: 'api', path: pathText } }, { browser: unavailable() }));
    expect(legacy.calls.some((entry) => entry.startsWith('page:'))).toBe(false);
    expect(detail(legacy.trace)).toContain('대신 확인하려 했지만');
  });
  it('fallback 서비스의 endpoint가 던지면 그 오류로 실패한다', async () => {
    const legacy = await compare(() =>
      oneB({ fallbackProbe: { service: 'web', path: '/x' } }, {
        browser: unavailable(),
        endpoint: (service) => {
          if (service === 'web') throw new Error('web 없음');
          return 'http://127.0.0.1:1';
        },
      }),
    );
    expect(detail(legacy.trace)).toBe('web 없음');
  });
  it('자동 페이지가 아니어도 실패 글은 가린 뒤 돌려준다', async () => {
    const legacy = await compare(() =>
      oneB({ fallbackProbe: probe }, { browser: unavailable(), redact: (text) => text.replaceAll('ECONN', '***'), page: async () => Promise.reject(new Error('ECONNREFUSED')) }),
    );
    expect(detail(legacy.trace)).toContain('***REFUSED');
  });
  it('fallback 근거의 가림이 던지면 근거 없이 통과로 남는다', async () => {
    let n = 0;
    const legacy = await compare(() => {
      n = 0;
      return oneB({ fallbackProbe: probe }, { browser: unavailable(), redact: (text) => { if (++n > 0) throw new Error('가림 실패'); return text; } });
    });
    expect(pageCheck(legacy.trace)).toMatchObject({ ok: true });
  });
});

describe('자동 페이지', () => {
  const auto = (over: Record<string, unknown> = {}) => ({ service: 'web', mode: 'http', expectStatus: 200, maxPages: 5, ...over }) as never;
  const pageFile = 'export default function Page() { return null; }\n';
  const nextjs = (over: Record<string, unknown>, rest: Omit<Setup, 'workflow' | 'nextjs'> = {}): Setup => ({ nextjs: true, workflow: { autoPageChecks: auto(over) }, ...rest });
  const withFiles = (files: Record<string, string>): Record<string, string> => files;
  const dyn = withFiles({ 'web/app/orders/[id]/page.tsx': pageFile });
  const simple = withFiles({ 'web/app/dashboard/page.tsx': pageFile });
  const nameOf = (trace: Trace): Record<string, unknown> => checksOf(trace).find((check) => String(check.name).includes('(자동)') || String(check.name).includes('(browser') || check.stage === 'browser_check')!;

  it('HTTP: 오류 표지가 있으면 자동 페이지 앞붙임과 함께 실패한다', async () => {
    const legacy = await compare(() => nextjs({}, { changes: simple, page: async () => ({ status: 200, text: 'Application error: a server-side exception has occurred' }) }));
    expect(detail(legacy.trace)).toBe("자동 페이지 /dashboard: Next.js 오류 화면: 'Application error: a server-side exception has occurred'");
  });
  it('HTTP: Unhandled Runtime Error 표지', async () => {
    const legacy = await compare(() => nextjs({}, { changes: simple, page: async () => ({ status: 200, text: '<h1>Unhandled Runtime Error</h1>' }) }));
    expect(detail(legacy.trace)).toContain("Next.js 오류 화면: 'Unhandled Runtime Error'");
  });
  it('HTTP: 기본 404 화면 표지는 기대가 404가 아니면 실패한다', async () => {
    const legacy = await compare(() => nextjs({}, { changes: simple, page: async () => ({ status: 200, text: 'This page could not be found' }) }));
    expect(detail(legacy.trace)).toContain("Next.js 오류 화면: 'This page could not be found'");
  });
  it('HTTP: 기대가 404면 404 화면 표지는 통과한다', async () => {
    const legacy = await compare(() => nextjs({ expectStatus: 404 }, { changes: simple, page: async () => ({ status: 404, text: 'This page could not be found' }) }));
    expect(nameOf(legacy.trace)).toMatchObject({ ok: true });
  });
  it('HTTP: 상태 코드 실패는 자동 표시를 앞에 붙인다', async () => {
    const legacy = await compare(() => nextjs({}, { changes: simple, page: async () => ({ status: 500, text: '' }) }));
    expect(detail(legacy.trace)).toBe('자동 페이지 /dashboard: HTTP 500 (기대 200)');
  });
  it('HTTP: 로딩 문구만 있으면 경고를 남기고 통과한다', async () => {
    const legacy = await compare(() => nextjs({}, { changes: simple, page: async () => ({ status: 200, text: '<html><body><p>Loading...</p><script>var x</script></body></html>' }) }));
    expect(nameOf(legacy.trace)).toMatchObject({ ok: true });
    expect(detail(legacy.trace)).toContain('[참고] 화면이 로딩 문구만 보여 준 채 멈췄습니다: "Loading..." — HTTP 확인은 자바스크립트를 실행하지 않아');
  });
  it('HTTP: 빈 본문은 증거가 없어 경고도 없다', async () => {
    const legacy = await compare(() => nextjs({}, { changes: simple, page: async () => ({ status: 200, text: '' }) }));
    expect(detail(legacy.trace)).not.toContain('[참고]');
  });
  it('HTTP: 오류 표지가 있으면 로딩 경고는 남기지 않는다(먼저 실패)', async () => {
    const legacy = await compare(() => nextjs({}, { changes: simple, page: async () => ({ status: 200, text: 'Unhandled Runtime Error Loading...' }) }));
    expect(nameOf(legacy.trace)).toMatchObject({ ok: false });
    expect(detail(legacy.trace)).not.toContain('[참고]');
  });
  it('HTTP: 로딩 경고를 남긴 뒤 글자 판정이 실패해도 경고는 남는다', async () => {
    const legacy = await compare(() => nextjs({}, { changes: simple, page: async () => ({ status: 200, text: '<p>Loading</p>' }) }));
    expect(nameOf(legacy.trace)).toMatchObject({ ok: true });
  });
  it('추정한 id: 404는 실패이고 추정 안내가 붙는다', async () => {
    const legacy = await compare(() => nextjs({}, { changes: dyn, page: async () => ({ status: 404, text: '' }) }));
    expect(detail(legacy.trace)).toContain('동적 경로를 추정한 id(1)로 열었더니 HTTP 404을 돌려줬습니다');
    expect(detail(legacy.trace)).not.toContain('이 화면은 추정한 id(1)로 열었습니다');
  });
  it('추정한 id: 500도 실패', async () => {
    const legacy = await compare(() => nextjs({}, { changes: dyn, page: async () => ({ status: 503, text: '' }) }));
    expect(detail(legacy.trace)).toContain('HTTP 503');
  });
  it('추정한 id: 499·200·302는 통과', async () => {
    for (const status of [499, 200, 302, 403]) {
      const legacy = await compare(() => nextjs({}, { changes: dyn, page: async () => ({ status, text: '<p>ok</p>' }) }));
      expect(nameOf(legacy.trace), String(status)).toMatchObject({ ok: true });
    }
  });
  it('추정한 id: 오류 표지가 있으면 추정 안내(dynamicProbeDataHint)는 browser에서만 붙는다', async () => {
    const legacy = await compare(() => nextjs({}, { changes: dyn, page: async () => ({ status: 200, text: 'Unhandled Runtime Error' }) }));
    expect(detail(legacy.trace)).toBe("자동 페이지 /orders/1: Next.js 오류 화면: 'Unhandled Runtime Error'");
  });
  it('sampleParams로 연 화면이 상태 코드로 실패하면 sampled 안내를 붙인다(HTTP)', async () => {
    const legacy = await compare(() => nextjs({ sampleParams: { id: '999001' } }, { changes: dyn, page: async () => ({ status: 404, text: '' }) }));
    expect(detail(legacy.trace)).toContain('HTTP 404 (기대 200)\n이 화면은 studio.yaml의 autoPageChecks.sampleParams로 알려 준 값(id=999001)');
  });
  it('sampleParams로 연 화면: 오류 표지 실패에는 sampled 안내를 붙이지 않는다(HTTP)', async () => {
    const legacy = await compare(() => nextjs({ sampleParams: { id: '7' } }, { changes: dyn, page: async () => ({ status: 200, text: 'Unhandled Runtime Error' }) }));
    expect(detail(legacy.trace)).not.toContain('sampleParams로 알려 준 값');
  });
  it('sampleParams로 연 화면: 통과', async () => {
    const legacy = await compare(() => nextjs({ sampleParams: { id: '7' } }, { changes: dyn, page: async () => ({ status: 200, text: '<p>ok</p>' }) }));
    expect(nameOf(legacy.trace)).toMatchObject({ ok: true });
  });
  it('browser: 자동 페이지 오류 화면(Next.js 표지)', async () => {
    const legacy = await compare(() => nextjs({ mode: 'browser' }, { changes: simple, browser: () => view({ text: 'Application error: a server-side exception has occurred' }) }));
    expect(detail(legacy.trace)).toContain("자동 페이지 /dashboard: Next.js 오류 화면: 'Application error");
  });
  it('browser: 기본 404 화면 표지', async () => {
    const legacy = await compare(() => nextjs({ mode: 'browser' }, { changes: simple, browser: () => view({ text: 'This page could not be found' }) }));
    expect(detail(legacy.trace)).toContain("'This page could not be found'");
  });
  it('browser: 선언한 화면에는 오류 표지를 보지 않는다', async () => {
    const legacy = await compare(() => oneB({ expectText: undefined }, { browser: () => view({ text: 'Application error: a server-side exception has occurred' }) }));
    expect(pageCheck(legacy.trace)).toMatchObject({ ok: true });
  });
  it('browser: 추정한 id의 문제에는 추정 안내가 붙는다', async () => {
    const legacy = await compare(() => nextjs({ mode: 'browser' }, { changes: dyn, browser: () => view({ failedRequests: ['GET /api/orders/1 404'] }) }));
    expect(detail(legacy.trace)).toContain('이 화면은 추정한 id(1)로 열었습니다');
  });
  it('browser: 추정한 id가 상태 코드로 실패하면 안내를 중복해서 붙이지 않는다', async () => {
    const legacy = await compare(() => nextjs({ mode: 'browser' }, { changes: dyn, browser: () => view({ status: 404, failedRequests: ['x'] }) }));
    expect(detail(legacy.trace)).toContain('동적 경로를 추정한 id(1)로 열었더니 HTTP 404을 돌려줬습니다');
    expect(detail(legacy.trace)).not.toContain('이 화면은 추정한 id(1)로 열었습니다');
  });
  it('browser: 추정한 id의 상태가 null이면 "HTTP null"로 적는다', async () => {
    const legacy = await compare(() => nextjs({ mode: 'browser' }, { changes: dyn, browser: () => view({ status: null }) }));
    expect(nameOf(legacy.trace)).toMatchObject({ ok: true });
  });
  it('browser: 추정한 id의 상태가 500이면 실패(HTTP 500)', async () => {
    const legacy = await compare(() => nextjs({ mode: 'browser' }, { changes: dyn, browser: () => view({ status: 500 }) }));
    expect(detail(legacy.trace)).toContain('HTTP 500을 돌려줬습니다');
  });
  it('browser: sampleParams로 연 화면이 실패하면 sampled 안내가 붙는다(추정 안내는 없다)', async () => {
    const legacy = await compare(() => nextjs({ mode: 'browser', sampleParams: { id: '999001' } }, { changes: dyn, browser: () => view({ failedRequests: ['GET /api/orders/999001 404'] }) }));
    expect(detail(legacy.trace)).toContain('sampleParams로 알려 준 값(id=999001)');
    expect(detail(legacy.trace)).not.toContain('이 화면은 추정한 id');
  });
  it('browser: 추정 안내와 sampled 안내가 함께 붙는 경우는 없다(sampled가 있으면 추정하지 않는다)', async () => {
    const legacy = await compare(() => nextjs({ mode: 'browser', sampleParams: { id: '7' } }, { changes: dyn, browser: () => view({ status: 500 }) }));
    expect(detail(legacy.trace)).toContain('HTTP 500 (기대 200)');
  });
  it('browser: 자동 페이지 통과 근거에 오류 화면 표지 없음을 적는다', async () => {
    const legacy = await compare(() => nextjs({ mode: 'browser' }, { changes: simple }));
    expect(pageCheck(legacy.trace).evidence).toEqual(expect.arrayContaining(['Next.js 오류 화면 표지 없음']));
  });
  it('자동 페이지의 실패 글도 가린 뒤 돌려준다', async () => {
    const legacy = await compare(() => nextjs({ mode: 'browser' }, { changes: simple, redact: (text) => text.replaceAll('/dashboard', '/***'), browser: () => view({ pageErrors: ['x'] }) }));
    expect(detail(legacy.trace)).toContain('자동 페이지 /***: 스크립트 예외: x');
  });
  it('선언한 화면과 자동 화면이 같이 돌아도 각자 판정한다', async () => {
    const legacy = await compare(
      () => ({ nextjs: true, workflow: { pageChecks: [page({ service: 'web', path: '/other' })], autoPageChecks: auto() }, changes: simple, page: async (url) => ({ status: url.endsWith('/dashboard') ? 500 : 200, text: '주문 목록' }) }),
      { interleaved: true },
    );
    const checks = checksOf(legacy.trace).filter((check) => check.stage === 'browser_check');
    expect(checks.map((check) => check.ok).sort()).toEqual([false, true]);
  });
});

describe('실행 흐름', () => {
  it('취소: 러너가 도는 중 취소되면 그 노드는 실패로 끝나고 다음 반복에서 취소가 던져진다', async () => {
    const controller = new AbortController();
    const legacy = await compare(() => {
      const fresh = new AbortController();
      return oneB({}, {
        signal: fresh.signal,
        browser: () => {
          fresh.abort(new Error('취소됨'));
          throw new Error('aborted');
        },
      });
    });
    void controller;
    expect(thrownOf(legacy.trace).message).toBe('취소됨');
  });
  it('취소: 페이지 요청이 도는 중 취소됨', async () => {
    const legacy = await compare(() => {
      const fresh = new AbortController();
      return one({}, {
        signal: fresh.signal,
        page: async () => {
          fresh.abort(new Error('중단'));
          throw new Error('aborted');
        },
      });
    });
    expect(thrownOf(legacy.trace).message).toBe('중단');
  });
  it('이미 취소돼 있으면 화면을 열지 않는다', async () => {
    const legacy = await compare(() => {
      const fresh = new AbortController();
      fresh.abort(new Error('시작 전 취소'));
      return one({}, { signal: fresh.signal });
    });
    expect(thrownOf(legacy.trace).message).toBe('시작 전 취소');
    expect(legacy.calls.some((entry) => entry.startsWith('page:'))).toBe(false);
  });
  it('화면 확인이 실패하면 재시도 안내를 돌려준다', async () => {
    const legacy = await compare(() => one({ expectText: '없음' }));
    expect((legacy.trace.result as { outcome: { kind: string } }).outcome.kind).toBe('retry');
  });
  it('화면 확인이 둘 이상이면 각자 판정한다', async () => {
    const legacy = await compare(
      () => ({ workflow: { pageChecks: [page(), page({ path: '/b', expectText: '없음' }), bpage({ path: '/c' })] } }),
      { interleaved: true },
    );
    expect(checksOf(legacy.trace).filter((check) => check.stage === 'browser_check').map((check) => check.ok)).toEqual([true, false, true]);
  });
  it('이름이 같은 화면 확인은 번호를 붙여 각자의 부산물을 갖는다', async () => {
    const legacy = await compare(() => ({ workflow: { pageChecks: [bpage({ path: '/x', maxLoadMs: 10 }), bpage({ path: '/x', maxLoadMs: 10 })] }, browser: () => view({ loadMs: 3 }) }), { interleaved: true });
    expect(checksOf(legacy.trace).filter((check) => check.stage === 'browser_check').map((check) => check.name)).toEqual(['api /x (browser)', 'api /x (browser) #2']);
  });
});

describe('경계: 화면 확인은 Rust가 돈다', () => {
  it('declaredCheckPage 콜백 하나가 아니라 화면 확인의 바깥 동작만 부른다', async () => {
    const seen: string[] = [];
    const original = native.gateCheckRun;
    const spy = vi.spyOn(native, 'gateCheckRun').mockImplementation(async (input: string, hook: (text: string) => Promise<string>) =>
      original.call(native, input, async (text: string) => {
        seen.push((JSON.parse(text) as { op: string }).op);
        return hook(text);
      }),
    );
    try {
      await runWorld('current', oneB({ expectFromApi: { service: 'api', path: '/api/x', jsonPath: '$.a' } as never }, { page: async (url) => (url.includes('/api/') ? { status: 200, text: '{"a":"주문"}' } : { status: 200, text: '' }) }));
    } finally {
      spy.mockRestore();
    }
    expect(seen).not.toContain('declaredCheckPage');
    expect(seen).toContain('declaredBrowserRun');
    expect(seen).toContain('declaredPageFetch');
  });
});

describe('무작위 사례(시드 고정)', () => {
  const gen = new Gen(20261115);
  const words = ['주문', '목록', 'Loading...', 'x', '', 'ABC', '\ud83d', '😀', '\ud800', '12,000', '120'];
  const statuses = [200, 200, 200, 404, 500, 302, 499];
  const lists = (): string[] => gen.list(0, 3, () => gen.pick(words));
  const text = (): string => gen.list(0, 4, () => gen.pick(words)).join(' ');
  const maybe = <T>(p: number, make: () => T): T | undefined => (gen.chance(p) ? make() : undefined);

  it('옛 구현과 같은 결과를 낸다', async () => {
    for (let index = 0; index < 90; index += 1) {
      const mode = gen.pick(['http', 'browser'] as const);
      const expectStatus = gen.pick([200, 200, 404]);
      const pageOver: Partial<WorkflowPageCheck> = {
        mode,
        expectStatus,
        ...(maybe(0.5, () => gen.pick(words)) !== undefined ? { expectText: gen.pick(words) } : { expectText: undefined }),
        ...(gen.chance(0.3) ? { expectAnyText: lists() } : {}),
        ...(gen.chance(0.3) ? { expectAllText: lists() } : {}),
        ...(gen.chance(0.3) ? { allowConsoleErrors: true } : {}),
        ...(gen.chance(0.2) ? { allowLoadingPlaceholder: true } : {}),
        ...(gen.chance(0.3) ? { noHorizontalScroll: true } : {}),
        ...(gen.chance(0.3) ? { maxLoadMs: gen.pick([0, 10, 1000, 1000.5, 12345.678]) } : {}),
        ...(gen.chance(0.3) ? { expectInViewport: lists().length ? lists() : ['주문'] } : {}),
        ...(gen.chance(0.25) ? { expectFromApi: { service: 'api', path: '/api/v', jsonPath: gen.pick(['$.v', '$.n', '$.none', '$.o']) } as never } : {}),
        ...(gen.chance(0.2) ? { fallbackProbe: { service: 'api', path: gen.pick(['/h', '//evil.example/x']) } } : {}),
      };
      const pageBody = text();
      const pageStatus = gen.pick(statuses);
      const apiBody = gen.pick(['{"v":"주문","n":12000,"o":{}}', '{"v":"\\ud800","n":120,"o":[]}', '{"v":"","n":1.5}', 'not json', '{"v":"ABC"}']);
      const apiStatus = gen.pick([200, 200, 200, 500]);
      const browserFlavor = gen.int(6);
      const result = view({
        status: gen.pick([...statuses, null]) as number | null,
        text: pageBody,
        pageErrors: gen.chance(0.2) ? lists() : [],
        consoleErrors: gen.chance(0.2) ? lists() : [],
        failedRequests: gen.chance(0.2) ? lists() : [],
        mediaErrors: gen.chance(0.1) ? lists() : [],
        horizontalOverflowPx: gen.pick([0, 0, 1, 1.5, 40]),
        ...(gen.chance(0.7) ? { loadMs: gen.pick([0, 5, 999, 1000, 1000.5, 12345.678, 123456789]) } : {}),
        ...(gen.chance(0.6) ? { viewportTexts: { width: 390, height: 844, findings: lists().map((word) => ({ text: word, visible: gen.chance(0.6), ...(gen.chance(0.5) ? { problem: gen.pick([{ kind: 'below', px: 3 }, { kind: 'hidden' }, { kind: 'absent' }]) } : {}) })) } } : {}),
        steps: gen.chance(0.3) ? [{ label: 'open /orders', ok: true }, { label: 'click', ok: gen.chance(0.5) }] as BrowserPageStep[] : [],
      } as Partial<BrowserPageResult>);
      const make = (): Setup => ({
        workflow: { pageChecks: [{ ...page(), ...pageOver } as WorkflowPageCheck] },
        redact: gen.chance(0) ? undefined : (value) => value.replaceAll('SECRET', '***'),
        page: async (url) => (url.includes('/api/') ? { status: apiStatus, text: apiBody } : { status: pageStatus, text: pageBody }),
        browser: () => {
          if (browserFlavor === 0) throw new BrowserUnavailableError('브라우저 없음');
          if (browserFlavor === 1) throw new Error('러너 오류');
          return result;
        },
      });
      // 같은 입력으로 두 번 만든다(옛 쪽·지금 쪽). make는 상태 없는 함수라 같은 설정을 낸다
      const legacy = await runWorld('legacy', make());
      const current = await runWorld('current', make());
      const label = `#${index} ${JSON.stringify({ pageOver, pageBody, pageStatus, apiBody, apiStatus, browserFlavor })}`;
      expect(current.trace.text, label).toEqual(legacy.trace.text);
      expect(current.calls, label).toEqual(legacy.calls);
    }
  }, 120_000);
});

// #1207: 이 묶음은 옛 코드와 일부러 다르다(견주지 않고 지금 구현만 돈다). 옛 판정은 HTTP 모드에서 오류 화면 표지를 스크립트까지 포함한 원문에서 찾아,
// Next.js 16이 모든 응답의 RSC 데이터에 싣는 기본 not-found 글자 때문에 정상 화면도 실패시켰다. 응답은 Next.js 16.4.3에서 실제로 받은 것이다(`crates/bstudio-guard/tests/vectors/next16/README.md`)
describe('자동 페이지 HTTP 모드: Next.js 16 실제 응답 (#1207)', () => {
  const vector = (name: string): string => readFileSync(path.join(import.meta.dirname, '../../../crates/bstudio-guard/tests/vectors/next16', `${name}.html`), 'utf8');
  const auto = (over: Record<string, unknown> = {}) => ({ service: 'web', mode: 'http', expectStatus: 200, maxPages: 5, ...over }) as never;
  const pageFile = 'export default function Page() { return null; }\n';
  const simple = { 'web/app/dashboard/page.tsx': pageFile };
  const dyn = { 'web/app/orders/[id]/page.tsx': pageFile };
  const run = (name: string, status = 200, changes: Record<string, string> = simple, over: Record<string, unknown> = {}) =>
    runWorld('current', { nextjs: true, workflow: { autoPageChecks: auto(over) }, changes, page: async () => ({ status, text: vector(name) }) });

  for (const kind of ['dev', 'prod']) {
    for (const name of ['home', 'ok', 'order-1', 'dyn', 'sp', 'cerr', 'rd']) {
      it(`${kind}-${name}: 정상 응답(스크립트 안에만 not-found 글자)은 통과한다`, async () => {
        const { trace } = await run(`${kind}-${name}`);
        expect(pageCheck(trace)).toMatchObject({ ok: true });
      });
    }
    it(`${kind}-errs: 스트리밍 도중 서버 컴포넌트가 던지면(상태 200) 실패한다`, async () => {
      const { trace } = await run(`${kind}-errs`);
      const digest = kind === 'dev' ? '3772761063' : '3873002581';
      expect(pageCheck(trace)).toMatchObject({ ok: false });
      expect(detail(trace)).toBe(`자동 페이지 /dashboard: Next.js 오류 화면: 서버 렌더링이 도중에 실패했습니다(digest '${digest}'). 상태 코드는 200이지만 화면 일부를 서버에서 그리지 못했습니다`);
    });
    it(`${kind}-nfs: 스트리밍 도중 notFound()면(상태 200) 실패한다`, async () => {
      const { trace } = await run(`${kind}-nfs`);
      expect(detail(trace)).toContain("Next.js 오류 화면: 서버 렌더링이 도중에 실패했습니다(digest 'NEXT_HTTP_ERROR_FALLBACK;404')");
    });
    it(`${kind}-nfs: 기대가 404여도 상태 200이면 상태 판정이 먼저 막는다`, async () => {
      const { trace } = await run(`${kind}-nfs`, 200, simple, { expectStatus: 404 });
      expect(detail(trace)).toBe('자동 페이지 /dashboard: HTTP 200 (기대 404)');
    });
    it(`${kind}-nope: 화면에 보이는 기본 404 글자는 그대로 잡는다(상태가 200이라고 해도)`, async () => {
      const { trace } = await run(`${kind}-nope`);
      expect(detail(trace)).toBe("자동 페이지 /dashboard: Next.js 오류 화면: 'This page could not be found'");
    });
    it(`${kind}-nope: 기대가 404면 기본 404 화면은 통과한다`, async () => {
      const { trace } = await run(`${kind}-nope`, 404, simple, { expectStatus: 404 });
      expect(pageCheck(trace)).toMatchObject({ ok: true });
    });
    it(`${kind}-err·nf: 상태 코드가 먼저 막는다`, async () => {
      expect(detail((await run(`${kind}-err`, 500)).trace)).toBe('자동 페이지 /dashboard: HTTP 500 (기대 200)');
      expect(detail((await run(`${kind}-nf`, 404)).trace)).toBe('자동 페이지 /dashboard: HTTP 404 (기대 200)');
    });
  }
  it('추정 id로 연 동적 경로: 정상 응답은 통과하고 스트리밍 오류는 실패한다', async () => {
    expect(pageCheck((await run('dev-order-1', 200, dyn)).trace)).toMatchObject({ ok: true });
    expect(detail((await run('dev-errs', 200, dyn)).trace)).toBe(
      "자동 페이지 /orders/1: Next.js 오류 화면: 서버 렌더링이 도중에 실패했습니다(digest '3772761063'). 상태 코드는 200이지만 화면 일부를 서버에서 그리지 못했습니다",
    );
  });
});

void encodeLoneSurrogates;
