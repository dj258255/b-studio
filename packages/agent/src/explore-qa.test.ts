import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildQaTools,
  executeQaTool,
  judge,
  QaBrowser,
  QaOriginError,
  runExploreQa,
  toPageCheckSteps,
  type QaActionRecord,
} from './explore-qa';
import { ScriptedModelClient } from './scripted-client';

// 실제 헤드리스 Chromium을 띄운다(browser-check.test.ts와 같은 방침). 건너뛰면 "검사 안 함"이 통과처럼 보인다
const PAGES: Record<string, string> = {
  '/start': `<html><body>
    <label for="q">검색어</label><input id="q">
    <button id="go" onclick="document.getElementById('out').textContent = document.getElementById('q').value">검색</button>
    <p id="out"></p>
    <a id="to-b" href="/b">상세로</a>
  </body></html>`,
  '/b': `<html><body><h1 id="title">상세 화면</h1></body></html>`,
  '/ambiguous': `<html><body><button>자세히</button><button>자세히</button></body></html>`,
  '/diagnostics': `<html><head></head><body style="margin:0">
    <div style="width:900px">넓은 표</div>
    <img src="/pixel.png">
    <button></button>
    <input name="nickname">
    <script>console.error('문제 발생')</script>
    <script src="/missing.js"></script>
  </body></html>`,
};

let server: Server;
let base = '';
let otherBase = '';

beforeAll(async () => {
  server = createServer((request, response) => {
    const path = request.url ?? '';
    if (path === '/pixel.png') {
      response.writeHead(200, { 'content-type': 'image/png' });
      response.end(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'));
      return;
    }
    const body = PAGES[path];
    response.writeHead(body ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    response.end(body ?? 'not found');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  otherBase = 'http://127.0.0.1:1';
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe('QaBrowser', { timeout: 60_000 }, () => {
  it('snapshot은 인터랙티브 요소에 ref를 부여하고, 고유한 role+name/텍스트가 있으면 안정적 선택자를 고른다', async () => {
    const browser = await QaBrowser.open(`${base}/start`, { allowedOrigins: [base] });
    try {
      const result = await browser.snapshot();
      const input = result.elements.find((element) => element.tag === 'input');
      const button = result.elements.find((element) => element.tag === 'button');
      const link = result.elements.find((element) => element.tag === 'a');
      expect(input?.role).toBe('textbox');
      expect(input?.name).toBe('검색어');
      expect(input?.stableSelector).toContain('role=textbox');
      expect(button?.stableSelector).toContain('role=button');
      expect(button?.name).toBe('검색');
      expect(link?.role).toBe('link');
    } finally {
      await browser.close();
    }
  });

  it('find는 질의와 느슨하게 맞는 요소를 찾는다', async () => {
    const browser = await QaBrowser.open(`${base}/start`, { allowedOrigins: [base] });
    try {
      const found = await browser.find('검색');
      expect(found.length).toBeGreaterThan(0);
      expect(found.some((element) => element.name.includes('검색'))).toBe(true);
    } finally {
      await browser.close();
    }
  });

  it('역할+이름도 텍스트도 고유하지 않으면 안정적 선택자를 주지 않는다(저장 불가로 표시할 근거)', async () => {
    const browser = await QaBrowser.open(`${base}/ambiguous`, { allowedOrigins: [base] });
    try {
      const result = await browser.snapshot();
      expect(result.elements).toHaveLength(2);
      for (const element of result.elements) expect(element.stableSelector).toBeUndefined();
    } finally {
      await browser.close();
    }
  });

  it('ref로 입력칸을 채우고 버튼을 눌러 화면이 바뀐다', async () => {
    const browser = await QaBrowser.open(`${base}/start`, { allowedOrigins: [base] });
    try {
      expect(await browser.pageText()).not.toContain('주문 목록');
      const snapshot = await browser.snapshot();
      const input = snapshot.elements.find((element) => element.tag === 'input')!;
      const button = snapshot.elements.find((element) => element.tag === 'button')!;
      await browser.fill(input.ref, '주문 목록');
      await browser.click({ ref: button.ref });
      expect(await browser.pageText()).toContain('주문 목록');
    } finally {
      await browser.close();
    }
  });

  it('같은 출처 경로로는 이동하고, 다른 출처로는 막는다', async () => {
    const browser = await QaBrowser.open(`${base}/start`, { allowedOrigins: [base] });
    try {
      await browser.navigate('/b');
      expect(browser.url).toBe(`${base}/b`);
      await expect(browser.navigate(otherBase)).rejects.toThrow(QaOriginError);
    } finally {
      await browser.close();
    }
  });

  it('콘솔 오류·실패한 요청·가로 넘침·기본 접근성 위반을 모은다', async () => {
    const browser = await QaBrowser.open(`${base}/diagnostics`, { allowedOrigins: [base], viewport: { width: 390, height: 600 } });
    try {
      const diagnostics = await browser.currentDiagnostics();
      expect(diagnostics.consoleErrors).toContain('문제 발생');
      expect(diagnostics.failedRequests.join()).toMatch(/missing\.js/);
      expect(diagnostics.horizontalOverflowPx).toBe(900 - 390);
      expect(diagnostics.accessibilityViolations.some((v) => v.includes('alt'))).toBe(true);
      expect(diagnostics.accessibilityViolations.some((v) => v.includes('button'))).toBe(true);
      expect(diagnostics.accessibilityViolations.some((v) => v.includes('라벨'))).toBe(true);
    } finally {
      await browser.close();
    }
  });

  it('allowedOrigins 밖 요청은 blockedRequests로 남고 실패로 세지 않는다', async () => {
    const mixed = `${otherBase.replace('1', '2')}`;
    const page = `/mixed-${Math.random()}`;
    const server2 = createServer((request, response) => {
      if (request.url === page) {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(`<html><body><img src="${mixed}/pixel.png"></body></html>`);
        return;
      }
      response.writeHead(404);
      response.end();
    });
    await new Promise<void>((resolve) => server2.listen(0, '127.0.0.1', resolve));
    const myBase = `http://127.0.0.1:${(server2.address() as AddressInfo).port}`;
    try {
      const browser = await QaBrowser.open(`${myBase}${page}`, { allowedOrigins: [myBase] });
      try {
        const diagnostics = await browser.currentDiagnostics();
        expect(diagnostics.blockedRequests.length).toBeGreaterThan(0);
        expect(diagnostics.failedRequests).toEqual([]);
      } finally {
        await browser.close();
      }
    } finally {
      await new Promise<void>((resolve) => server2.close(() => resolve()));
    }
  });

  it('screenSignature는 같은 화면이면 같고, 다른 화면으로 가면 바뀐다', async () => {
    const browser = await QaBrowser.open(`${base}/start`, { allowedOrigins: [base] });
    try {
      const a = await browser.screenSignature();
      const b = await browser.screenSignature();
      expect(a).toBe(b);
      await browser.navigate('/b');
      const c = await browser.screenSignature();
      expect(c).not.toBe(a);
    } finally {
      await browser.close();
    }
  });
});

describe('executeQaTool', { timeout: 60_000 }, () => {
  it('ref가 없으면 명확한 오류를 돌려준다(화면이 바뀌었을 수 있다는 안내)', async () => {
    const browser = await QaBrowser.open(`${base}/start`, { allowedOrigins: [base] });
    try {
      const outcome = await executeQaTool('qa_click', { ref: 'e999' }, browser);
      expect(outcome.ok).toBe(false);
      expect(outcome.text).toContain('ref');
    } finally {
      await browser.close();
    }
  });

  it('qa_screenshot은 이미지 데이터를 함께 돌려준다', async () => {
    const browser = await QaBrowser.open(`${base}/start`, { allowedOrigins: [base] });
    try {
      const outcome = await executeQaTool('qa_screenshot', {}, browser);
      expect(outcome.ok).toBe(true);
      expect(outcome.image?.mediaType).toBe('image/jpeg');
      expect(outcome.image?.data.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    } finally {
      await browser.close();
    }
  });
});

describe('buildQaTools', () => {
  it('qa_finish를 포함해 도구 이름이 중복 없이 있다', () => {
    const names = buildQaTools().map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain('qa_finish');
    expect(names).toContain('qa_snapshot');
  });
});

describe('judge', () => {
  it('진단 신호가 없고 확인 문구가 있으면 통과시킨다', () => {
    const result = judge({ confirmText: '완료' }, { consoleErrors: [], pageErrors: [], failedRequests: [], blockedRequests: [], horizontalOverflowPx: 0, accessibilityViolations: [] }, '작업이 완료됐습니다');
    expect(result.status).toBe('pass');
  });

  it('확인 문구가 없으면 모델이 완료를 선언했어도 실패시킨다(목표 완료 선언만으로 통과시키지 않는다)', () => {
    const result = judge({ confirmText: '완료' }, { consoleErrors: [], pageErrors: [], failedRequests: [], blockedRequests: [], horizontalOverflowPx: 0, accessibilityViolations: [] }, '아직입니다');
    expect(result.status).toBe('fail');
    expect(result.reason).toContain('완료');
  });

  it('진단 신호가 하나라도 있으면 확인 문구가 있어도 실패시킨다', () => {
    const result = judge({}, { consoleErrors: ['오류'], pageErrors: [], failedRequests: [], blockedRequests: [], horizontalOverflowPx: 0, accessibilityViolations: [] }, '아무 글자');
    expect(result.status).toBe('fail');
    expect(result.reason).toContain('console.error');
  });
});

describe('toPageCheckSteps', () => {
  const baseRecord = (overrides: Partial<QaActionRecord>): QaActionRecord => ({
    index: 1,
    tool: 'qa_click',
    input: {},
    ok: true,
    newDiagnosticsCount: 0,
    url: 'http://x/',
    at: 0,
    ...overrides,
  });

  it('안정적 선택자가 있는 click/fill/press/wait(forText)는 steps로 바꾼다', () => {
    const actions: QaActionRecord[] = [
      baseRecord({ tool: 'qa_click', stableSelector: 'role=button[name="검색"]' }),
      baseRecord({ tool: 'qa_fill', input: { text: '김토스' }, stableSelector: '[data-testid="q"]' }),
      baseRecord({ tool: 'qa_press', input: { key: 'Enter' } }),
      baseRecord({ tool: 'qa_wait', input: { forText: '결과' } }),
    ];
    const { steps, skipped } = toPageCheckSteps(actions);
    expect(steps).toEqual([
      { click: 'role=button[name="검색"]' },
      { fill: { selector: '[data-testid="q"]', text: '김토스' } },
      { press: 'Enter' },
      { waitFor: 'text=결과' },
    ]);
    expect(skipped).toEqual([]);
  });

  it('안정적 선택자가 없는 행동, 관찰 도구, 실패한 행동, ms만 기다린 행동은 저장하지 않고 이유를 남긴다', () => {
    const actions: QaActionRecord[] = [
      baseRecord({ tool: 'qa_click', stableSelector: undefined }),
      baseRecord({ tool: 'qa_snapshot' }),
      baseRecord({ tool: 'qa_click', ok: false, detail: '실패' }),
      baseRecord({ tool: 'qa_wait', input: { ms: 1000 } }),
    ];
    const { steps, skipped } = toPageCheckSteps(actions);
    expect(steps).toEqual([]);
    expect(skipped).toHaveLength(4);
    expect(skipped.every((entry) => entry.reason.length > 0)).toBe(true);
  });
});

describe('runExploreQa', { timeout: 60_000 }, () => {
  it('스크립트 모델로 끝까지 돈다: 관찰 → 채우기 → 확인 → 완료 선언, 진단 신호 없음 → 통과', async () => {
    const client = new ScriptedModelClient([
      { toolCalls: [{ name: 'qa_snapshot', input: {} }] },
      { toolCalls: [{ name: 'qa_fill', input: { ref: 'e1', text: '주문 목록' } }] },
      { toolCalls: [{ name: 'qa_click', input: { ref: 'e2' } }] },
      { toolCalls: [{ name: 'qa_wait', input: { forText: '주문 목록' } }] },
      { toolCalls: [{ name: 'qa_finish', input: { success: true, summary: '검색어를 채우고 버튼을 눌러 화면에 문구가 나타난 것을 확인했습니다' } }] },
    ]);
    const frames: unknown[] = [];
    const actions: QaActionRecord[] = [];
    const result = await runExploreQa({
      client,
      goal: { goal: '검색어 입력칸에 값을 채운다', startPath: '/start', confirmText: '주문 목록' },
      startUrl: `${base}/start`,
      allowedOrigins: [base],
      onFrame: (frame) => frames.push(frame),
      onEvent: (event) => {
        if (event.type === 'action') actions.push(event.record);
      },
    });

    expect(result.status).toBe('pass');
    expect(result.stoppedBy).toBe('finish');
    expect(result.modelDeclared).toMatchObject({ success: true });
    expect(result.diagnostics.consoleErrors).toEqual([]);
    expect(actions.map((action) => action.tool)).toEqual(['qa_snapshot', 'qa_fill', 'qa_click', 'qa_wait']);

    const { steps, skipped } = toPageCheckSteps(result.actions);
    expect(steps).toEqual([
      { fill: { selector: 'role=textbox[name="검색어"]', text: '주문 목록' } },
      { click: 'role=button[name="검색"]' },
      { waitFor: 'text=주문 목록' },
    ]);
    expect(skipped).toEqual([{ index: 1, tool: 'qa_snapshot', reason: expect.any(String) }]);
  });

  it('목표 완료 선언만으로 통과시키지 않는다: 확인 문구가 화면에 없으면 success 선언에도 실패로 판정한다', async () => {
    const client = new ScriptedModelClient([{ toolCalls: [{ name: 'qa_finish', input: { success: true, summary: '다 했다고 주장' } }] }]);
    const result = await runExploreQa({
      client,
      goal: { goal: '아무 목표', startPath: '/start', confirmText: '절대 나오지 않는 문구' },
      startUrl: `${base}/start`,
      allowedOrigins: [base],
    });
    expect(result.modelDeclared?.success).toBe(true);
    expect(result.status).toBe('fail');
    expect(result.reason).toContain('절대 나오지 않는 문구');
  });

  it('최대 행동 수에 도달하면 멈춘다', async () => {
    const client = new ScriptedModelClient(Array.from({ length: 5 }, () => ({ toolCalls: [{ name: 'qa_snapshot', input: {} }] })));
    const result = await runExploreQa({
      client,
      goal: { goal: '계속 관찰만 한다', startPath: '/start', maxActions: 3 },
      startUrl: `${base}/start`,
      allowedOrigins: [base],
    });
    expect(result.stoppedBy).toBe('max_actions');
    expect(result.actions).toHaveLength(3);
  });

  it('같은 화면이 반복되면(관찰만 반복) 멈춘다', async () => {
    const client = new ScriptedModelClient(Array.from({ length: 10 }, () => ({ toolCalls: [{ name: 'qa_snapshot', input: {} }] })));
    const result = await runExploreQa({
      client,
      goal: { goal: '계속 관찰만 한다', startPath: '/start', maxActions: 30, repeatLimit: 3 },
      startUrl: `${base}/start`,
      allowedOrigins: [base],
    });
    expect(result.stoppedBy).toBe('repeated_screen');
    expect(result.actions).toHaveLength(3);
  });

  it('모델이 도구를 부르지 않고 텍스트만 내면 멈춘다', async () => {
    const client = new ScriptedModelClient([{ text: '그냥 생각만 합니다' }]);
    const result = await runExploreQa({ client, goal: { goal: '아무 목표', startPath: '/start' }, startUrl: `${base}/start`, allowedOrigins: [base] });
    expect(result.stoppedBy).toBe('no_tool_call');
  });

  it('saveArtifact를 주면 행동마다 썸네일을 저장하고, 주지 않으면 전혀 찍지 않는다(토큰 비용과 무관한 관측용)', async () => {
    const saved: string[] = [];
    const client = new ScriptedModelClient([{ toolCalls: [{ name: 'qa_snapshot', input: {} }] }, { toolCalls: [{ name: 'qa_finish', input: { success: true, summary: '끝' } }] }]);
    await runExploreQa({
      client,
      goal: { goal: '관찰만 한다', startPath: '/start' },
      startUrl: `${base}/start`,
      allowedOrigins: [base],
      saveArtifact: async ({ name }) => {
        saved.push(name);
        return `artifact:${name}`;
      },
    });
    expect(saved).toEqual(['탐색 1단계']);

    const withoutSave = await runExploreQa({
      client: new ScriptedModelClient([{ toolCalls: [{ name: 'qa_snapshot', input: {} }] }, { toolCalls: [{ name: 'qa_finish', input: { success: true, summary: '끝' } }] }]),
      goal: { goal: '관찰만 한다', startPath: '/start' },
      startUrl: `${base}/start`,
      allowedOrigins: [base],
    });
    expect(withoutSave.actions.every((action) => action.artifact === undefined)).toBe(true);
  });
});
