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
  '/tall': `<html><body style="margin:0"><div style="height:3000px">긴 화면</div><p id="bottom">맨 아래</p></body></html>`,
  '/counter': `<html><body><button id="plus" onclick="const n = document.getElementById('n'); n.textContent = String(Number(n.textContent) + 1)">더하기</button><p id="n">0</p></body></html>`,
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

  it('관찰 동작(snapshot·wait·screenshot·find)이 repeatLimit보다 많이 이어져도 같은 화면 반복으로 끊지 않는다', async () => {
    const observing = [
      { name: 'qa_snapshot', input: {} },
      { name: 'qa_wait', input: { ms: 10 } },
      { name: 'qa_screenshot', input: {} },
      { name: 'qa_find', input: { query: '검색' } },
      { name: 'qa_snapshot', input: {} },
      { name: 'qa_screenshot', input: {} },
    ];
    const client = new ScriptedModelClient([
      ...observing.map((call) => ({ toolCalls: [call] })),
      { toolCalls: [{ name: 'qa_finish', input: { success: true, summary: '관찰만 하고 끝냈습니다' } }] },
    ]);
    const result = await runExploreQa({
      client,
      goal: { goal: '화면을 점검한다', startPath: '/start', maxActions: 30, repeatLimit: 3 },
      startUrl: `${base}/start`,
      allowedOrigins: [base],
    });
    expect(result.stoppedBy).toBe('finish');
    expect(result.actions).toHaveLength(6);
  });

  it('실패한 동작이 이어져도 같은 화면 반복으로 세지 않는다', async () => {
    const client = new ScriptedModelClient([
      ...Array.from({ length: 5 }, () => ({ toolCalls: [{ name: 'qa_click', input: { ref: 'e999' } }] })),
      { toolCalls: [{ name: 'qa_finish', input: { success: true, summary: '끝' } }] },
    ]);
    const result = await runExploreQa({ client, goal: { goal: '실패를 반복한다', startPath: '/start', repeatLimit: 3 }, startUrl: `${base}/start`, allowedOrigins: [base] });
    expect(result.stoppedBy).toBe('finish');
    expect(result.actions.filter((action) => !action.ok)).toHaveLength(5);
  });

  it('같은 화면에서 같은 조작(click)을 되풀이하면 여전히 같은 화면 반복으로 멈춘다', async () => {
    const client = new ScriptedModelClient([
      { toolCalls: [{ name: 'qa_snapshot', input: {} }] },
      ...Array.from({ length: 10 }, () => ({ toolCalls: [{ name: 'qa_click', input: { ref: 'e2' } }] })),
      { text: '보고합니다' },
    ]);
    const result = await runExploreQa({ client, goal: { goal: '같은 버튼만 누른다', startPath: '/start', maxActions: 30, repeatLimit: 3 }, startUrl: `${base}/start`, allowedOrigins: [base] });
    expect(result.stoppedBy).toBe('repeated_screen');
    // snapshot 1번 + click 3번
    expect(result.actions).toHaveLength(4);
  });

  it('조작 사이에 관찰이 끼어도 같은 화면에서 같은 조작이 이어지면 반복으로 센다', async () => {
    const calls = [{ name: 'qa_snapshot', input: {} }, ...Array.from({ length: 5 }, () => [{ name: 'qa_click', input: { ref: 'e2' } }, { name: 'qa_snapshot', input: {} }]).flat()];
    const client = new ScriptedModelClient([...calls.map((call) => ({ toolCalls: [call] })), { text: '보고합니다' }]);
    const result = await runExploreQa({ client, goal: { goal: '누르고 본다', startPath: '/start', maxActions: 30, repeatLimit: 3 }, startUrl: `${base}/start`, allowedOrigins: [base] });
    expect(result.stoppedBy).toBe('repeated_screen');
  });

  it('화면 글자가 같은 길이로 바뀌는 조작은 같은 화면으로 보지 않는다', async () => {
    // 같은 버튼을 눌러도 카운터 숫자가 0→1→2처럼 바뀐다. 글자 수·요소 수는 그대로여도 반복이 아니다
    const client = new ScriptedModelClient([
      { toolCalls: [{ name: 'qa_snapshot', input: {} }] },
      ...Array.from({ length: 4 }, () => ({ toolCalls: [{ name: 'qa_click', input: { ref: 'e1' } }] })),
      { toolCalls: [{ name: 'qa_finish', input: { success: true, summary: '끝' } }] },
    ]);
    const result = await runExploreQa({ client, goal: { goal: '카운터를 올린다', startPath: '/counter', repeatLimit: 3 }, startUrl: `${base}/counter`, allowedOrigins: [base] });
    expect(result.stoppedBy).toBe('finish');
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

describe('발견 보고와 판정', { timeout: 60_000 }, () => {
  it('모델이 blocker·major 발견을 보고하면 결과에 싣고, 진단 신호가 깨끗해도 통과로 두지 않는다', async () => {
    const client = new ScriptedModelClient([
      { toolCalls: [{ name: 'qa_screenshot', input: {} }] },
      {
        toolCalls: [
          { name: 'qa_report_issue', input: { severity: 'major', summary: '아래쪽 로그인 줄이 컨테이너 경계에서 절반 잘렸습니다', where: '로그인 입력 줄', evidence: '캡처 하단' } },
          { name: 'qa_report_issue', input: { severity: 'minor', summary: '영상 영역 오른쪽 여백이 넓습니다' } },
        ],
      },
      { toolCalls: [{ name: 'qa_finish', input: { success: true, summary: '화면을 끝까지 점검했습니다' } }] },
    ]);
    const events: string[] = [];
    const result = await runExploreQa({
      client,
      goal: { goal: '화면을 점검해 문제를 찾는다', startPath: '/start' },
      startUrl: `${base}/start`,
      allowedOrigins: [base],
      onEvent: (event) => {
        if (event.type === 'finding') events.push(event.finding.severity);
      },
    });
    expect(result.diagnostics.consoleErrors).toEqual([]);
    expect(result.findings).toEqual([
      { severity: 'major', summary: '아래쪽 로그인 줄이 컨테이너 경계에서 절반 잘렸습니다', where: '로그인 입력 줄', evidence: '캡처 하단', observedAtAction: 1 },
      { severity: 'minor', summary: '영상 영역 오른쪽 여백이 넓습니다', observedAtAction: 1 },
    ]);
    expect(events).toEqual(['major', 'minor']);
    expect(result.status).toBe('fail');
    expect(result.reason).toContain('잘렸습니다');
    // 발견 보고는 화면 조작이 아니라서 행동 수에 들어가지 않는다
    expect(result.actions.map((action) => action.tool)).toEqual(['qa_screenshot']);
  });

  it('minor 발견만 있으면 통과하되 목록과 사유에 남긴다', async () => {
    const client = new ScriptedModelClient([
      { toolCalls: [{ name: 'qa_report_issue', input: { severity: 'minor', summary: '여백이 조금 넓습니다' } }, { name: 'qa_finish', input: { success: true, summary: '점검 끝' } }] },
    ]);
    const result = await runExploreQa({ client, goal: { goal: '점검', startPath: '/start' }, startUrl: `${base}/start`, allowedOrigins: [base] });
    expect(result.status).toBe('pass');
    expect(result.findings).toHaveLength(1);
    expect(result.reason).toContain('minor 1건');
  });

  it('같은 발견을 되풀이해 보고해도 한 번만 싣고, 잘못된 심각도는 오류로 돌려준다', async () => {
    const client = new ScriptedModelClient([
      {
        toolCalls: [
          { name: 'qa_report_issue', input: { severity: 'minor', summary: '여백' } },
          { name: 'qa_report_issue', input: { severity: 'minor', summary: '여백' } },
          { name: 'qa_report_issue', input: { severity: 'critical', summary: '심각도가 틀렸습니다' } },
          { name: 'qa_finish', input: { success: true, summary: '끝' } },
        ],
      },
    ]);
    const result = await runExploreQa({ client, goal: { goal: '점검', startPath: '/start' }, startUrl: `${base}/start`, allowedOrigins: [base] });
    expect(result.findings).toHaveLength(1);
  });

  it('모델이 성공을 선언해도 진단 신호가 있으면 실패로 판정한다(기존 동작 유지)', async () => {
    const client = new ScriptedModelClient([{ toolCalls: [{ name: 'qa_finish', input: { success: true, summary: '문제 없습니다' } }] }]);
    const result = await runExploreQa({ client, goal: { goal: '점검', startPath: '/diagnostics' }, startUrl: `${base}/diagnostics`, allowedOrigins: [base] });
    expect(result.modelDeclared?.success).toBe(true);
    expect(result.status).toBe('fail');
    expect(result.reason).toContain('console.error');
  });

  it('모델이 목표를 달성하지 못했다고 보고하면 발견이 없어도 통과로 두지 않는다', async () => {
    const client = new ScriptedModelClient([{ toolCalls: [{ name: 'qa_finish', input: { success: false, summary: '버튼을 찾지 못했습니다' } }] }]);
    const result = await runExploreQa({ client, goal: { goal: '버튼을 누른다', startPath: '/start' }, startUrl: `${base}/start`, allowedOrigins: [base] });
    expect(result.status).toBe('fail');
    expect(result.reason).toContain('버튼을 찾지 못했습니다');
  });
});

describe('한도에 걸려 끝날 때 마지막 보고', { timeout: 60_000 }, () => {
  const observe = { toolCalls: [{ name: 'qa_snapshot', input: {} }] };

  it('최대 행동 수에 걸리면 qa_report_issue·qa_finish만 열어 한 번 더 묻고, 보고가 오면 싣는다', async () => {
    const client = new ScriptedModelClient([
      observe,
      observe,
      {
        toolCalls: [
          { name: 'qa_report_issue', input: { severity: 'blocker', summary: '버튼이 화면 밖으로 나갔습니다' } },
          { name: 'qa_finish', input: { success: true, summary: '두 번 관찰한 것으로 보고합니다' } },
        ],
      },
    ]);
    const result = await runExploreQa({ client, goal: { goal: '점검', startPath: '/start', maxActions: 2 }, startUrl: `${base}/start`, allowedOrigins: [base] });
    expect(result.stoppedBy).toBe('max_actions');
    expect(result.actions).toHaveLength(2);
    expect(result.findings.map((finding) => finding.severity)).toEqual(['blocker']);
    expect(result.modelDeclared?.summary).toContain('보고합니다');
    expect(result.status).toBe('fail');
    const wrapUp = client.requests.at(-1)!;
    expect(wrapUp.tools?.map((tool) => tool.name).sort()).toEqual(['qa_finish', 'qa_report_issue']);
    const last = wrapUp.messages.at(-1)!;
    expect(JSON.stringify(last.content)).toContain('마지막');
  });

  it('보고가 오지 않으면 통과로 두지 않고 점검을 마치지 못했다고 드러낸다', async () => {
    const client = new ScriptedModelClient([observe, observe, { text: '글만 쓰고 보고하지 않습니다' }]);
    const result = await runExploreQa({ client, goal: { goal: '점검', startPath: '/start', maxActions: 2 }, startUrl: `${base}/start`, allowedOrigins: [base] });
    expect(result.stoppedBy).toBe('max_actions');
    expect(result.modelDeclared).toBeUndefined();
    expect(result.status).toBe('inconclusive');
    expect(result.reason).toContain('마치지 못했습니다');
  });

  it('보고를 받지 못해도 진단 신호가 있으면 실패다', async () => {
    const client = new ScriptedModelClient([observe, { text: '보고하지 않습니다' }]);
    const result = await runExploreQa({ client, goal: { goal: '점검', startPath: '/diagnostics', maxActions: 1 }, startUrl: `${base}/diagnostics`, allowedOrigins: [base] });
    expect(result.status).toBe('fail');
  });

  it('도구 없이 글만 내고 끝난 경우에도 한 번 더 묻는다', async () => {
    const client = new ScriptedModelClient([
      { text: '문제를 찾았지만 도구는 부르지 않습니다' },
      { toolCalls: [{ name: 'qa_report_issue', input: { severity: 'major', summary: '글자가 흐립니다' } }, { name: 'qa_finish', input: { success: true, summary: '보고' } }] },
    ]);
    const result = await runExploreQa({ client, goal: { goal: '점검', startPath: '/start' }, startUrl: `${base}/start`, allowedOrigins: [base] });
    expect(result.stoppedBy).toBe('no_tool_call');
    expect(result.findings).toHaveLength(1);
    expect(result.status).toBe('fail');
  });

  it('같은 조작 반복으로 끊겨도 마지막 보고를 받는다', async () => {
    const client = new ScriptedModelClient([
      { toolCalls: [{ name: 'qa_snapshot', input: {} }] },
      ...Array.from({ length: 3 }, () => ({ toolCalls: [{ name: 'qa_click', input: { ref: 'e2' } }] })),
      { toolCalls: [{ name: 'qa_finish', input: { success: false, summary: '버튼을 눌러도 변화가 없습니다' } }] },
    ]);
    const result = await runExploreQa({ client, goal: { goal: '버튼을 누른다', startPath: '/start', repeatLimit: 3 }, startUrl: `${base}/start`, allowedOrigins: [base] });
    expect(result.stoppedBy).toBe('repeated_screen');
    expect(result.modelDeclared?.summary).toContain('변화가 없습니다');
    expect(result.status).toBe('fail');
  });
});

describe('qa_scroll', { timeout: 60_000 }, () => {
  it.each([
    ['없음', {}],
    ['빈 문자열', { ref: '' }],
    ['따옴표 두 개', { ref: '""' }],
    ['작은따옴표 두 개', { ref: "''" }],
    ['공백', { ref: '   ' }],
  ])('ref가 %s이면 페이지를 스크롤한다', async (_label, extra) => {
    const browser = await QaBrowser.open(`${base}/tall`, { allowedOrigins: [base] });
    try {
      const outcome = await executeQaTool('qa_scroll', { direction: 'down', amount: 400, ...extra }, browser);
      expect(outcome.ok).toBe(true);
      expect(outcome.text).toContain('스크롤');
      expect(outcome.text).toContain('y=400');
    } finally {
      await browser.close();
    }
  });

  it('스크롤 결과에 위치와 맨 아래 도달 여부를 알려 준다', async () => {
    const browser = await QaBrowser.open(`${base}/tall`, { allowedOrigins: [base] });
    try {
      const first = await executeQaTool('qa_scroll', { direction: 'down', amount: 600 }, browser);
      expect(first.text).toContain('맨 아래가 아닙니다');
      const last = await executeQaTool('qa_scroll', { direction: 'down', amount: 5000 }, browser);
      expect(last.text).toContain('맨 아래에 닿았습니다');
    } finally {
      await browser.close();
    }
  });

  it('따옴표로 감싼 ref도 벗겨서 찾는다', async () => {
    const browser = await QaBrowser.open(`${base}/start`, { allowedOrigins: [base] });
    try {
      await executeQaTool('qa_snapshot', {}, browser);
      const outcome = await executeQaTool('qa_click', { ref: '"e2"' }, browser);
      expect(outcome.ok).toBe(true);
    } finally {
      await browser.close();
    }
  });

  it('필수 ref가 비어 있으면 무엇이 비었는지 알려 준다', async () => {
    const browser = await QaBrowser.open(`${base}/start`, { allowedOrigins: [base] });
    try {
      const outcome = await executeQaTool('qa_fill', { ref: '""', text: 'x' }, browser);
      expect(outcome.ok).toBe(false);
      expect(outcome.text).toContain('ref가 비어 있습니다');
    } finally {
      await browser.close();
    }
  });
});

describe('토큰 사용량', { timeout: 60_000 }, () => {
  it('api 루프는 모델 응답의 usage를 합산한다', async () => {
    const inner = new ScriptedModelClient([{ toolCalls: [{ name: 'qa_snapshot', input: {} }] }, { toolCalls: [{ name: 'qa_finish', input: { success: true, summary: '끝' } }] }]);
    const client = {
      info: inner.info,
      async createMessage(request: Parameters<ScriptedModelClient['createMessage']>[0]) {
        const message = await inner.createMessage(request);
        return { ...message, usage: { ...message.usage, input_tokens: 100, output_tokens: 7, cache_read_input_tokens: 30, cache_creation_input_tokens: 5 } };
      },
    };
    const result = await runExploreQa({ client, goal: { goal: '점검', startPath: '/start' }, startUrl: `${base}/start`, allowedOrigins: [base] });
    expect(result.usage).toEqual({ inputTokens: 200, outputTokens: 14, cacheReadTokens: 60, cacheWriteTokens: 10 });
  });
});
