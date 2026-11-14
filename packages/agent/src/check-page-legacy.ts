/**
 * 게이트의 화면 확인 판정을 Rust로 옮기기 전(ADR-195 4f A5c-1) `gate.ts`의 `VerificationGate.#checkPage`·`#checkFallbackProbe`·`#apiValue`를 그대로 둔 것이다.
 * 차등 시험(`check-page-differential.test.ts`)이 같은 시나리오를 이 옛 구현과 지금 구현에 넣어 견준다. 제품 코드는 이 파일을 쓰지 않는다. 지우지 않는다(4g에서 함께 지운다).
 *
 * 옛 코드가 `this.#options`·`this.#saveSteps` 같은 비공개 값으로 하던 일은 `DeclaredHost.page`(`PageOps`)로, 이름별 부산물 맵은 `DeclaredHost.pageMaps`로 한다.
 * 순서와 분기는 옛 코드의 한 줄도 바꾸지 않았다. 판정 조각(`nextErrorMarker`·`containsApiValue`·`viewportProblems`·`missing*Text`·근거 등)은 옛 코드가 부르던 그 함수(이미 네이티브인 것: `gate.ts`·`check-evidence.ts`의
 * 껍데기)를 그대로 부른다 — 이 조각이 옮긴 것은 그 조각들을 잇는 순서·판정·글 조립이다.
 */
import type { WorkflowPageCheck } from '@b-studio/spec';
import { BrowserUnavailableError, StepFailedError, type BrowserFrame, type BrowserPageResult } from './browser-check';
import type { DeclaredHost } from './gate-check';
import {
  containsApiValue,
  dynamicProbeDataHint,
  evidenceOrNone,
  missingAllText,
  missingAnyText,
  missingApiValue,
  nextErrorMarker,
  readJsonPath,
  stripHtml,
  viewportProblems,
  type ApiValue,
  type PageFetcher,
} from './gate';
import { browserPageEvidence, finishEvidence, httpPageEvidence, type PageEvidenceContext } from './check-evidence';
import { detectStuckLoading } from './stuck-loading';
import { serviceUrl } from './verify';

function sampledValueHint(sampled: string): string {
  return `이 화면은 studio.yaml의 autoPageChecks.sampleParams로 알려 준 값(${sampled})으로 열었습니다 — 그 값의 데이터가 실제로 없으면 같은 실패가 납니다. 앱이 실제로 가진 값으로 sampleParams를 고치세요(이 값은 같은 실행에서 바로 반영됩니다)`;
}

function dynamicProbeStatusProblem(probedId: string, status: number | null): string {
  return `동적 경로를 추정한 id(${probedId})로 열었더니 HTTP ${status}을 돌려줬습니다 — id가 실제로 없을 수 있습니다. autoPageChecks.sampleParams나 sampleIdFrom으로 실제 값을 알려주면 더 정확히 확인합니다`;
}

/** 옛 `#checkPage` */
export async function legacyCheckPage(host: DeclaredHost, page: WorkflowPageCheck, name: string, signal: AbortSignal, options: { auto?: boolean; probedId?: string; sampled?: string } = {}): Promise<string[]> {
  const ops = host.page;
  const { sandbox, pageFetcher, browserRunner, saveArtifact, onBrowserFrame } = ops;
  const { pageMaps } = host;
  // 자동으로 연 페이지의 실패는 경로를 앞에 붙여, 실패 서명에서 선언한 pageChecks의 실패와 구분되게 한다
  const fail = (message: string) => new Error(sandbox.redact(options.auto ? `자동 페이지 ${page.path}: ${message}` : message));
  // ① api를 불러 값을 꺼내 둔다. 여기서 실패하면 화면을 열지 않고 멈춘다(렌더링을 낭비하지 않는다)
  const api = await legacyApiValue(host, page, pageFetcher, signal);
  const endpoint = await sandbox.endpoint(page.service);
  const url = new URL(page.path, endpoint.url);
  if (url.origin !== new URL(endpoint.url).origin) throw new Error('path must stay on the service host');
  const redact = (line: string) => sandbox.redact(line);
  const evidenceContext: PageEvidenceContext = { redact, ...(options.auto ? { auto: true } : {}), ...(options.probedId !== undefined ? { probedId: options.probedId } : {}), ...(api ? { api } : {}) };
  if (page.mode === 'browser') {
    let result: BrowserPageResult;
    try {
      result = await browserRunner(url.href, {
        viewport: page.viewport,
        ...(page.expectInViewport ? { viewportTexts: page.expectInViewport } : {}),
        steps: page.steps,
        signal,
        measureLoad: page.maxLoadMs !== undefined,
        capture: saveArtifact !== undefined || page.compare !== undefined,
        allowedOrigins: await ops.serviceOrigins(),
        ...(onBrowserFrame ? { onFrame: (frame: BrowserFrame) => onBrowserFrame({ check: name, frame }) } : {}),
      });
    } catch (error) {
      // 헤드리스 브라우저를 못 띄우면(ADR-050은 원래 그대로 실패시킨다) fallbackProbe가 있는 확인만 대신 HTTP로 확인한다
      if (error instanceof BrowserUnavailableError && page.fallbackProbe) {
        return legacyFallbackProbe(host, page.fallbackProbe, page, name, signal, fail, error);
      }
      // 실패한 단계의 스크린샷도 결과에 남긴다
      if (error instanceof StepFailedError) pageMaps.steps.set(name, await ops.saveSteps(name, error.steps));
      throw error;
    }
    if (saveArtifact) pageMaps.steps.set(name, await ops.saveSteps(name, result.steps));
    if (result.blockedRequests.length > 0) pageMaps.blocked.set(name, result.blockedRequests);
    const problems: string[] = [];
    if (options.probedId !== undefined) {
      if (result.status === 404 || (result.status !== null && result.status >= 500)) problems.push(dynamicProbeStatusProblem(options.probedId, result.status));
    } else if (result.status !== page.expectStatus) {
      problems.push(`HTTP ${result.status ?? '응답 없음'} (기대 ${page.expectStatus})`);
    }
    if (page.expectText && !result.text.includes(page.expectText)) problems.push(`렌더링된 화면에 '${page.expectText}'가 없습니다`);
    if (page.expectAnyText && !page.expectAnyText.some((candidate) => result.text.includes(candidate))) problems.push(missingAnyText(page.expectAnyText));
    const missingAllRendered = page.expectAllText?.filter((candidate) => !result.text.includes(candidate)) ?? [];
    if (missingAllRendered.length > 0) problems.push(missingAllText(missingAllRendered));
    if (page.expectInViewport) problems.push(...viewportProblems(page.expectInViewport, result.viewportTexts));
    if (api && !containsApiValue(result.text, api.value)) problems.push(missingApiValue(api, page.path));
    if (result.pageErrors.length > 0) problems.push(`스크립트 예외: ${result.pageErrors.slice(0, 3).join(' | ')}`);
    if (!page.allowConsoleErrors && result.consoleErrors.length > 0) problems.push(`console.error: ${result.consoleErrors.slice(0, 3).join(' | ')}`);
    if (!page.allowConsoleErrors && result.failedRequests.length > 0) problems.push(`실패한 요청: ${result.failedRequests.slice(0, 3).join(' | ')}`);
    if (!page.allowConsoleErrors && result.mediaErrors.length > 0) problems.push(`미디어 오류: ${result.mediaErrors.slice(0, 3).join(' | ')}`);
    if (!page.allowLoadingPlaceholder) {
      const stuck = detectStuckLoading(result.text, {
        failedRequests: result.failedRequests.length,
        consoleErrors: result.consoleErrors.length,
        pageErrors: result.pageErrors.length,
      });
      if (stuck) problems.push(stuck);
    }
    if (page.noHorizontalScroll && result.horizontalOverflowPx > 1) problems.push(`가로로 ${result.horizontalOverflowPx}px 넘칩니다`);
    if (result.loadMs !== undefined) pageMaps.loadMs.set(name, result.loadMs);
    if (page.maxLoadMs !== undefined) {
      // 예산을 적었는데 재지 못했으면 "검사 안 함"이 통과로 보이지 않도록 실패로 본다
      if (result.loadMs === undefined) problems.push(`로드 시간을 재지 못했습니다 (예산 ${page.maxLoadMs.toLocaleString('ko-KR')}ms)`);
      else if (result.loadMs > page.maxLoadMs) {
        problems.push(`로드 ${result.loadMs.toLocaleString('ko-KR')}ms (예산 ${page.maxLoadMs.toLocaleString('ko-KR')}ms)`);
      }
    }
    if (options.auto) {
      const marker = nextErrorMarker(result.text, page.expectStatus);
      if (marker) problems.push(`Next.js 오류 화면: '${marker}'`);
    }
    if (problems.length > 0 && options.probedId !== undefined && !problems.some((problem) => problem.includes('추정한 id('))) {
      problems.push(dynamicProbeDataHint(options.probedId));
    }
    if (problems.length > 0 && options.sampled !== undefined) problems.push(sampledValueHint(options.sampled));
    if (problems.length > 0) throw fail(problems.join('\n'));
    if (page.compare) await ops.compareDesign(page.compare, name, result, sandbox);
    return evidenceOrNone(() => finishEvidence(browserPageEvidence(page, result, evidenceContext), redact));
  }
  const { status, text } = await pageFetcher(url.href, signal);
  if (options.probedId !== undefined) {
    if (status === 404 || status >= 500) throw fail(dynamicProbeStatusProblem(options.probedId, status));
  } else if (status !== page.expectStatus) {
    throw fail(`HTTP ${status} (기대 ${page.expectStatus})${options.sampled !== undefined ? `\n${sampledValueHint(options.sampled)}` : ''}`);
  }
  if (options.auto) {
    const marker = nextErrorMarker(text, page.expectStatus);
    if (marker) throw fail(`Next.js 오류 화면: '${marker}'`);
    // HTTP 확인은 자바스크립트를 실행하지 않아 클라이언트 fetch가 실패했는지 확정할 수 없다. 보수적으로 경고만 남긴다(ADR-078)
    const stuck = detectStuckLoading(stripHtml(text));
    if (stuck) ops.addWarning(name, `[참고] ${stuck} — HTTP 확인은 자바스크립트를 실행하지 않아 확정할 수 없습니다. 확실히 판정하려면 autoPageChecks.mode: browser를 쓰세요`);
  }
  if (page.expectText && !text.includes(page.expectText)) throw fail(`응답 본문에 '${page.expectText}'가 없습니다`);
  if (page.expectAnyText && !page.expectAnyText.some((candidate) => text.includes(candidate))) throw fail(missingAnyText(page.expectAnyText));
  const missingAll = page.expectAllText?.filter((candidate) => !text.includes(candidate)) ?? [];
  if (missingAll.length > 0) throw fail(missingAllText(missingAll));
  if (api && !containsApiValue(text, api.value)) throw fail(missingApiValue(api, page.path));
  return evidenceOrNone(() => finishEvidence(httpPageEvidence(page, { status, text }, evidenceContext), redact));
}

/** 옛 `#checkFallbackProbe` */
async function legacyFallbackProbe(
  host: DeclaredHost,
  probe: { service: string; path: string },
  page: WorkflowPageCheck,
  name: string,
  signal: AbortSignal,
  fail: (message: string) => Error,
  browserError: BrowserUnavailableError,
): Promise<string[]> {
  const { sandbox, pageFetcher } = host.page;
  const endpoint = await sandbox.endpoint(probe.service);
  let url: URL;
  try {
    url = new URL(serviceUrl(probe.path, endpoint.url));
  } catch (error) {
    // 서비스 밖으로 풀리는 경로는 요청하지 않고 실패다(#1187). 바깥 호스트의 응답으로 화면 확인을 통과시키지 않는다
    throw fail(`헤드리스 브라우저를 쓸 수 없어 ${probe.service}${probe.path}로 대신 확인하려 했지만 ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const { status } = await pageFetcher(url.href, signal);
    host.page.addWarning(
      name,
      `[참고] 헤드리스 브라우저를 쓸 수 없어(${browserError.message}) 화면 확인 대신 ${probe.service}${probe.path}로 HTTP 확인만 했습니다(응답 ${status}). 콘솔 오류·실패한 요청·화면에 보이는 오류 문구는 확인하지 못했습니다`,
    );
    if (page.expectInViewport) {
      host.page.addWarning(name, `[참고] expectInViewport(${page.expectInViewport.map((value) => `'${value}'`).join(', ')})가 첫 화면에 보이는지는 확인하지 못했습니다 — 헤드리스 브라우저가 필요합니다`);
    }
    return evidenceOrNone(() => finishEvidence([`헤드리스 브라우저 없이 ${probe.service}${probe.path}의 HTTP 응답(${status})만 확인했습니다 — 화면은 열지 않았습니다`], (line) => sandbox.redact(line)));
  } catch (error) {
    throw fail(
      `헤드리스 브라우저를 쓸 수 없어 ${probe.service}${probe.path}로 대신 확인했는데 연결하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** 옛 `#apiValue` */
async function legacyApiValue(host: DeclaredHost, page: WorkflowPageCheck, fetcher: PageFetcher, signal: AbortSignal): Promise<ApiValue | undefined> {
  const expect = page.expectFromApi;
  if (!expect) return undefined;
  const { sandbox } = host.page;
  const endpoint = await sandbox.endpoint(expect.service);
  const url = new URL(expect.path, endpoint.url);
  if (url.origin !== new URL(endpoint.url).origin) throw new Error('path must stay on the service host');
  const { status, text } = await fetcher(url.href, signal);
  if (status < 200 || status >= 300) throw new Error(sandbox.redact(`${expect.service} GET ${expect.path}가 HTTP ${status}을 돌려줬습니다`));
  const value = readJsonPath(text, expect.jsonPath);
  if (value === undefined || value === null) {
    // 자르기 전에 가린다. 200자 경계에 걸친 시크릿의 앞부분이 남지 않게 한다(#751)
    throw new Error(sandbox.redact(`${expect.service} 응답에 ${expect.jsonPath}이 없습니다. 응답 앞부분: ${sandbox.redact(text).slice(0, 200)}`));
  }
  if (typeof value === 'object') throw new Error(`${expect.jsonPath}는 ${Array.isArray(value) ? '배열' : '객체'}입니다. 화면에 그려질 문자열·숫자 값을 가리키세요`);
  if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`${expect.jsonPath}는 ${typeof value}입니다. 화면에 그려질 문자열·숫자 값을 가리키세요`);
  if (typeof value === 'string' && value.trim() === '') throw new Error(`${expect.jsonPath} 값이 빈 문자열입니다. 화면에 그려질 문자열·숫자 값을 가리키세요`);
  return { service: expect.service, jsonPath: expect.jsonPath, value };
}
