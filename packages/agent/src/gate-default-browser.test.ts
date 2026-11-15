import { createServer, type Server } from 'node:http';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { LoadedProject, WorkflowPageCheck } from '@b-studio/spec';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { VerificationGate } from './gate';
import { createOrdersProject, fakeSandbox, ORDERS_CONTRACT } from './test-helpers';
import { Workspace } from './workspace';

/**
 * 게이트의 기본 화면 확인 러너(ADR-199 A6c-3). `browserRunner`를 넘기지 않은 게이트가 실제 브라우저로 페이지를 열 때 Rust 러너(`runInBrowserNative`)를 쓰는지 본다.
 * 두 러너의 결과가 갈리는 자리(페이지가 전역을 바꿔 화면 글자를 위조하는 경우)로 구분한다: 옛 러너(`runInBrowser`)는 페이지와 같은 실행 환경에서 글자를 읽어 위조된 글자를 믿고,
 * Rust 러너는 격리된 실행 환경에서 읽어 진짜 글자를 잰다(A6b). 그래서 위조된 글자를 기대하는 확인이 통과하면 게이트가 아직 옛 러너를 쓰는 것이다.
 * 실제 브라우저(Playwright가 받은 headless shell 또는 설치된 Chrome)를 띄운다. 도커·네트워크는 쓰지 않는다.
 */

const FORGED = '위조된 글자 주문 완료';
let server: Server;
let base = '';
const roots: string[] = [];

beforeAll(async () => {
  server = createServer((request, response) => {
    if (request.url !== '/orders') {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(
      `<!doctype html><html><head><meta charset="utf-8"></head><body><p>진짜 글자</p>` +
        `<script>Object.defineProperty(HTMLElement.prototype, 'innerText', { get: function () { return '${FORGED}'; }, configurable: true });</script>` +
        `</body></html>`,
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('시험 서버 주소를 얻지 못했습니다');
  base = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  roots.length = 0;
});

async function checkWithDefaultRunner(expectText: string) {
  const created = await createOrdersProject('gate-default-browser-');
  roots.push(created.root);
  await writeFile(path.join(created.root, 'compose.yaml'), 'services:\n  api: { build: ./api }\n');
  const pageCheck = { service: 'api', path: '/orders', mode: 'browser', expectStatus: 200, expectText, allowConsoleErrors: false, noHorizontalScroll: false } as WorkflowPageCheck;
  const project = { ...created, spec: { ...created.spec, workflow: { pageChecks: [pageCheck] } } } as LoadedProject;
  const sandbox = fakeSandbox(project, []);
  sandbox.endpoint = async (service: string) => ({ service, containerPort: 8080, url: base });
  const workspace = new Workspace(project.root);
  // browserRunner를 넘기지 않는다: 게이트의 기본 러너가 돈다
  const gate = await VerificationGate.create({ project, sandbox, workspace, allowBreaking: false, maxVerifyAttempts: 3, platformRetryDelayMs: 1, fetcher: async () => ORDERS_CONTRACT, onEvent: () => {} });
  await workspace.write('api/src/Order.java', 'class Order { String memo; }\n');
  await gate.check();
  const browserCheck = gate.checks.find((check) => check.stage === 'browser_check');
  if (!browserCheck) throw new Error(`화면 확인 결과가 없습니다: ${JSON.stringify(gate.checks)}`);
  return browserCheck;
}

describe('게이트의 기본 화면 확인 러너', () => {
  it('페이지가 화면 글자를 위조해도 기본 러너는 진짜 글자를 잰다 (Rust 러너, 옛 러너는 속는다)', async () => {
    const forged = await checkWithDefaultRunner(FORGED);
    expect(forged.ok, JSON.stringify(forged)).toBe(false);
    const real = await checkWithDefaultRunner('진짜 글자');
    expect(real.ok, JSON.stringify(real)).toBe(true);
  }, 60_000);
});
