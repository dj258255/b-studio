import type Anthropic from '@anthropic-ai/sdk';
import type { WorkflowPageStep } from '@b-studio/spec';
import type { Browser, Page } from 'playwright-core';
import { createScreencast, launchBrowser, restrictPageToOrigins, type BrowserFrame, type OriginBlockEvent } from './browser-check';
import type { AgentUsage, ModelClient } from './loop';

type BetaTool = Anthropic.Beta.BetaTool;
type BetaMessageParam = Anthropic.Beta.BetaMessageParam;
type BetaToolUseBlock = Anthropic.Beta.BetaToolUseBlock;
type BetaToolResultBlockParam = Anthropic.Beta.BetaToolResultBlockParam;
type BetaContentBlockParam = Exclude<BetaToolResultBlockParam['content'], string | undefined>[number];

/**
 * 탐색형 QA — Claude for Chrome처럼 모델이 화면을 보고 스스로 클릭·입력하며 목표를 수행하게 하는 도구 세트와 실행 루프.
 * 기존 browser_check(선언적 steps)와는 다른 길이다: browser_check는 사람이 적어 둔 click/fill/press/waitFor를
 * 순서대로 재생하고, 탐색형 QA는 모델이 그때그때 화면을 보고 다음 행동을 고른다.
 * 샌드박스 앱 하나의 페이지만 다루고(allowedOrigins를 그대로 물려받는다), 임의 JS 실행·파일 업로드 도구는 주지 않는다(§6.6).
 */

export const DEFAULT_EXPLORE_VIEWPORT = { width: 1280, height: 800 } as const;
const NAVIGATION_TIMEOUT_MS = 30_000;
const ACTION_TIMEOUT_MS = 5_000;
const WAIT_TEXT_TIMEOUT_MS = 10_000;
const MAX_WAIT_MS = 5_000;
const MAX_FIND_RESULTS = 20;
const MAX_SNAPSHOT_ELEMENTS = 40;
const MAX_NAME_LENGTH = 80;
const SCROLL_PAGE_PX = 600;
const SCROLL_SETTLE_MS = 150;
/** 예상된 거절을 가를 때, 조작 직후 요청이 나가길 기다리는 시간과 네트워크가 잠잠해지길 기다리는 상한 */
const SETTLE_START_MS = 100;
const SETTLE_NETWORK_MS = 2_000;
/** 스크린샷은 토큰 비용이 크므로(연구 노트 §2.6, §6.7) JPEG로 압축해 보낸다 */
const SCREENSHOT_JPEG_QUALITY = 60;

/** qa_scroll 뒤의 문서 스크롤 위치. max는 더 내려갈 수 있는 총 픽셀(문서 높이 - 화면 높이) */
export interface QaScrollPosition {
  y: number;
  max: number;
  atBottom: boolean;
  atTop: boolean;
}

export interface QaViewport {
  width: number;
  height: number;
}

/** qa_snapshot·qa_find가 돌려주는 요소 하나. ref는 그 관찰 시점에만 유효하다(DOM이 바뀌면 낡은 ref일 수 있다) */
export interface QaElement {
  ref: string;
  role: string;
  name: string;
  tag: string;
  testId?: string;
  /** 지금 실행에 쓰는 선택자(Playwright 선택자 문자열). 항상 있다 */
  selector: string;
  /**
   * pageChecks steps로 저장해도 재현 가능하다고 보는 선택자(role+name, data-testid, 고유 텍스트 중 하나).
   * CSS 구조 선택자로만 가리킬 수 있는 요소는 이 값이 없다 — 저장 시 "못 바꾸는 행동"으로 표시한다(설계안 §6.5)
   */
  stableSelector?: string;
  rect: { x: number; y: number; width: number; height: number };
}

/** browser_check(browser-check.ts)가 모으는 신호와 같은 종류 + 탐색형에서 보강한 기본 접근성 위반(설계안 §6.4) */
export interface QaDiagnostics {
  consoleErrors: string[];
  pageErrors: string[];
  failedRequests: string[];
  blockedRequests: string[];
  horizontalOverflowPx: number;
  accessibilityViolations: string[];
}

function emptyDiagnostics(): QaDiagnostics {
  return { consoleErrors: [], pageErrors: [], failedRequests: [], blockedRequests: [], horizontalOverflowPx: 0, accessibilityViolations: [] };
}

/** 진단 신호 개수의 합(판정에 쓴다). 가로 넘침은 1px이라도 있으면 1건으로 센다 */
function diagnosticsCount(diagnostics: QaDiagnostics): number {
  return (
    diagnostics.consoleErrors.length +
    diagnostics.pageErrors.length +
    diagnostics.failedRequests.length +
    diagnostics.accessibilityViolations.length +
    (diagnostics.horizontalOverflowPx > 1 ? 1 : 0)
  );
}

export class QaOriginError extends Error {}

/** data:, javascript: 등 네트워크로 나가지 않는 스킴은 무시하고, 그 밖은 허용 출처 안인지 확인한다 */
function assertSameOrigin(url: string, allowedOrigins: ReadonlySet<string>): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new QaOriginError(`주소를 해석하지 못했습니다: ${url}`);
  }
  if (!allowedOrigins.has(parsed.origin)) throw new QaOriginError(`허용한 출처 밖으로는 이동할 수 없습니다: ${parsed.origin}`);
}

/**
 * 탐색형 QA 전용 헤드리스 Chromium 한 장. browser_check·원격 브라우저와 별개 인스턴스를 띄우고,
 * 같은 restrictPageToOrigins·createScreencast를 재사용해 보안 경계와 실시간 중계 경로를 그대로 물려받는다(설계안 §6.6).
 */
export class QaBrowser {
  readonly #browser: Browser;
  readonly #page: Page;
  readonly #allowedOrigins: Set<string>;
  readonly #diagnostics: QaDiagnostics = emptyDiagnostics();
  /** #diagnostics.failedRequests와 같은 순서의 상태 코드·주소. 응답이 아니라 네트워크 실패면 status가 없다 */
  readonly #failureMeta: Array<{ status?: number; url: string }> = [];
  /** 예상된 거절을 기다리는 동안 관찰한 4xx 응답(중복 제거 없이). 조작 하나의 구간에서만 켜진다 */
  #rejectionWatch: Array<{ status: number; url: string }> | undefined;
  readonly #refs = new Map<string, { selector: string; stableSelector?: string; rect: QaElement['rect'] }>();
  readonly #screencast: ReturnType<typeof createScreencast> | undefined;
  #refSeq = 0;
  #viewport: QaViewport;

  private constructor(
    browser: Browser,
    page: Page,
    allowedOrigins: Set<string>,
    viewport: QaViewport,
    screencast: ReturnType<typeof createScreencast> | undefined,
  ) {
    this.#browser = browser;
    this.#page = page;
    this.#allowedOrigins = allowedOrigins;
    this.#viewport = viewport;
    this.#screencast = screencast;
  }

  static async open(url: string, options: { allowedOrigins: readonly string[]; viewport?: QaViewport; onFrame?: (frame: BrowserFrame) => void }): Promise<QaBrowser> {
    const viewport = options.viewport ?? DEFAULT_EXPLORE_VIEWPORT;
    const allowedOrigins = new Set(options.allowedOrigins);
    const browser = await launchBrowser();
    try {
      const page = await browser.newPage({ viewport, serviceWorkers: 'block' });
      // CDP 세션은 생성자보다 먼저 받아 둬야 해서(비동기), screencast를 만든 뒤 한 번에 인스턴스를 만든다
      const screencast = options.onFrame ? createScreencast(await page.context().newCDPSession(page), viewport, options.onFrame) : undefined;
      const instance = new QaBrowser(browser, page, allowedOrigins, viewport, screencast);
      const blockedUrls = new Set<string>();
      await restrictPageToOrigins(page, options.allowedOrigins, (event: OriginBlockEvent) => {
        blockedUrls.add(event.url);
        instance.#diagnostics.blockedRequests.push(event.url);
      });
      page.on('pageerror', (error) => instance.#diagnostics.pageErrors.push(error.message));
      page.on('console', (message) => {
        if (message.type() === 'error' && !message.text().startsWith('Failed to load resource')) instance.#diagnostics.consoleErrors.push(message.text());
      });
      const seenFailures = new Set<string>();
      // 허용 출처 밖이라 막은 요청은 앱의 오류가 아니므로 실패로 세지 않는다(browser-check.ts의 recordFailure와 같은 규칙)
      const recordFailure = (requestUrl: string, reason: string, status?: number) => {
        if (new URL(requestUrl).pathname === '/favicon.ico' || blockedUrls.has(requestUrl)) return;
        // 같은 주소의 실패는 진단 신호로 한 번만 세지만, 예상된 거절을 가를 때는 매번 봐야 한다
        if (status !== undefined && status >= 400 && status < 500) instance.#rejectionWatch?.push({ status, url: requestUrl });
        if (seenFailures.has(requestUrl)) return;
        seenFailures.add(requestUrl);
        instance.#diagnostics.failedRequests.push(`${reason} ${requestUrl}`);
        instance.#failureMeta.push({ ...(status !== undefined ? { status } : {}), url: requestUrl });
      };
      page.on('response', (response) => {
        if (response.status() >= 400) recordFailure(response.url(), String(response.status()), response.status());
      });
      page.on('requestfailed', (request) => recordFailure(request.url(), request.failure()?.errorText ?? 'failed'));

      if (screencast) await screencast.start(viewport.width);
      assertSameOrigin(url, allowedOrigins);
      await page.goto(url, { waitUntil: 'load', timeout: NAVIGATION_TIMEOUT_MS });
      return instance;
    } catch (error) {
      await browser.close().catch(() => {});
      throw error;
    }
  }

  get url(): string {
    return this.#page.url();
  }

  /** 지금까지 쌓인 진단 신호(이벤트 기반)에 그 순간의 가로 넘침·기본 접근성 위반을 더한 전체 스냅샷 */
  async currentDiagnostics(): Promise<QaDiagnostics> {
    const { overflow, violations } = await this.#page.evaluate<{ overflow: number; violations: string[] }>(STATIC_DIAGNOSTICS_SCRIPT);
    return {
      consoleErrors: [...this.#diagnostics.consoleErrors],
      pageErrors: [...this.#diagnostics.pageErrors],
      failedRequests: [...this.#diagnostics.failedRequests],
      blockedRequests: [...this.#diagnostics.blockedRequests],
      horizontalOverflowPx: overflow,
      accessibilityViolations: violations,
    };
  }

  /**
   * 조작 하나의 구간을 시작한다. 돌려준 값은 이 시점까지 쌓인 실패한 요청 수(구간의 시작 표시)다.
   * 구간 안에서 본 4xx 응답은 endRejectionWatch가 예상된 거절로 가려낸다
   */
  beginRejectionWatch(): number {
    this.#rejectionWatch = [];
    return this.#diagnostics.failedRequests.length;
  }

  /** 구간을 취소한다(조작이 실패해 선언을 쓰지 않을 때). 이미 쌓인 실패는 그대로 진단 신호로 남는다 */
  cancelRejectionWatch(): void {
    this.#rejectionWatch = undefined;
  }

  /**
   * 구간을 끝낸다. 늦게 끝나는 fetch를 잡으려고 네트워크가 잠잠해질 때까지 잠깐 기다린 뒤,
   * 구간 안에서 새로 생긴 4xx 응답만 진단 신호(failedRequests)에서 빼 예상된 거절로 돌려준다.
   * 5xx·네트워크 실패와 구간 밖의 실패는 진단 신호에 그대로 남는다
   */
  async endRejectionWatch(mark: number): Promise<Array<{ status: number; url: string }>> {
    await this.#page.waitForTimeout(SETTLE_START_MS);
    await this.#page.waitForLoadState('networkidle', { timeout: SETTLE_NETWORK_MS }).catch(() => {});
    const seen = this.#rejectionWatch ?? [];
    this.#rejectionWatch = undefined;
    for (let index = this.#failureMeta.length - 1; index >= mark; index -= 1) {
      const status = this.#failureMeta[index]?.status;
      if (status !== undefined && status >= 400 && status < 500) {
        this.#failureMeta.splice(index, 1);
        this.#diagnostics.failedRequests.splice(index, 1);
      }
    }
    const unique = new Map<string, { status: number; url: string }>();
    for (const entry of seen) unique.set(`${entry.status} ${entry.url}`, entry);
    return [...unique.values()];
  }

  /** 지금 화면의 인터랙티브 요소 목록(접근성 트리 축약) + 새 ref를 부여한다. 최대 MAX_SNAPSHOT_ELEMENTS개까지만 돌려준다 */
  async snapshot(): Promise<{ url: string; title: string; elements: QaElement[]; truncated: boolean }> {
    const raw = await this.#page.evaluate<RawElement[]>(collectElementsScript());
    const elements = raw.slice(0, MAX_SNAPSHOT_ELEMENTS).map((entry) => this.#assignRef(entry));
    return { url: this.#page.url(), title: await this.#page.title(), elements, truncated: raw.length > MAX_SNAPSHOT_ELEMENTS };
  }

  /** 자연어 질의로 요소를 찾는다(텍스트·역할·이름에 느슨하게 맞춘다). 최대 MAX_FIND_RESULTS개 */
  async find(query: string): Promise<QaElement[]> {
    const raw = await this.#page.evaluate<RawElement[]>(collectElementsScript());
    const needle = query.trim().toLowerCase();
    const scored = raw
      .map((entry) => ({ entry, score: matchScore(entry, needle) }))
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_FIND_RESULTS);
    return scored.map(({ entry }) => this.#assignRef(entry));
  }

  #assignRef(entry: RawElement): QaElement {
    const ref = `e${++this.#refSeq}`;
    this.#refs.set(ref, { selector: entry.selector, ...(entry.stableSelector ? { stableSelector: entry.stableSelector } : {}), rect: entry.rect });
    return {
      ref,
      role: entry.role,
      name: entry.name.slice(0, MAX_NAME_LENGTH),
      tag: entry.tag,
      ...(entry.testId ? { testId: entry.testId } : {}),
      selector: entry.selector,
      ...(entry.stableSelector ? { stableSelector: entry.stableSelector } : {}),
      rect: entry.rect,
    };
  }

  #resolve(ref: string): { selector: string; stableSelector?: string; rect: QaElement['rect'] } {
    const found = this.#refs.get(ref);
    if (!found) throw new Error(`ref '${ref}'를 찾을 수 없습니다. 화면이 바뀌었을 수 있습니다 — qa_snapshot이나 qa_find로 다시 찾으세요`);
    return found;
  }

  async click(target: { ref?: string; x?: number; y?: number }): Promise<{ stableSelector?: string; rect?: QaElement['rect'] }> {
    if (target.ref !== undefined) {
      const resolved = this.#resolve(target.ref);
      await this.#page.click(resolved.selector, { timeout: ACTION_TIMEOUT_MS });
      return { ...(resolved.stableSelector ? { stableSelector: resolved.stableSelector } : {}), rect: resolved.rect };
    }
    if (target.x !== undefined && target.y !== undefined) {
      await this.#page.mouse.click(target.x, target.y);
      return { rect: { x: target.x, y: target.y, width: 0, height: 0 } };
    }
    throw new Error('ref나 (x, y) 좌표 중 하나를 지정해야 합니다');
  }

  async fill(ref: string, text: string): Promise<{ stableSelector?: string; rect: QaElement['rect'] }> {
    const resolved = this.#resolve(ref);
    await this.#page.fill(resolved.selector, text, { timeout: ACTION_TIMEOUT_MS });
    return { ...(resolved.stableSelector ? { stableSelector: resolved.stableSelector } : {}), rect: resolved.rect };
  }

  /** fill과 달리 글자를 하나씩 쳐서 keyup 핸들러(자동완성 등)가 걸리게 한다 */
  async type(ref: string, text: string): Promise<{ stableSelector?: string; rect: QaElement['rect'] }> {
    const resolved = this.#resolve(ref);
    await this.#page.focus(resolved.selector, { timeout: ACTION_TIMEOUT_MS });
    await this.#page.keyboard.type(text, { delay: 10 });
    return { ...(resolved.stableSelector ? { stableSelector: resolved.stableSelector } : {}), rect: resolved.rect };
  }

  async press(key: string): Promise<void> {
    await this.#page.keyboard.press(key);
  }

  async hover(ref: string): Promise<{ rect: QaElement['rect'] }> {
    const resolved = this.#resolve(ref);
    await this.#page.hover(resolved.selector, { timeout: ACTION_TIMEOUT_MS });
    return { rect: resolved.rect };
  }

  /**
   * ref가 있으면 그 요소가 보이게, 없으면 화면 가운데에서 휠을 굴려 페이지를 스크롤한다.
   * 스크롤 뒤의 위치와 맨 아래 도달 여부를 돌려줘, 모델이 "아래까지 봤는지"를 스스로 알게 한다
   */
  async scroll(options: { ref?: string; direction?: 'up' | 'down'; amount?: number }): Promise<QaScrollPosition> {
    if (options.ref !== undefined) {
      const resolved = this.#resolve(options.ref);
      await this.#page.locator(resolved.selector).scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
    } else {
      const amount = options.amount ?? SCROLL_PAGE_PX;
      const delta = options.direction === 'up' ? -amount : amount;
      // 휠은 포인터 아래의 스크롤 영역을 움직인다. 포인터가 구석에 있으면 안쪽 스크롤 영역이 안 움직이므로 화면 가운데로 옮긴다
      await this.#page.mouse.move(this.#viewport.width / 2, this.#viewport.height / 2);
      await this.#page.mouse.wheel(0, delta);
      await this.#page.waitForTimeout(SCROLL_SETTLE_MS);
    }
    return this.#page.evaluate<QaScrollPosition>(
      `(() => { const el = document.scrollingElement || document.documentElement; const max = Math.max(0, el.scrollHeight - window.innerHeight); const y = Math.round(window.scrollY); return { y, max: Math.round(max), atBottom: max - y <= 2, atTop: y <= 0 }; })()`,
    );
  }

  /** 같은 출처(allowedOrigins) 안의 경로만 연다(설계안 §6.2·§6.8) */
  async navigate(path: string): Promise<void> {
    const target = new URL(path, this.#page.url());
    assertSameOrigin(target.href, this.#allowedOrigins);
    this.#refs.clear();
    await this.#page.goto(target.href, { waitUntil: 'load', timeout: NAVIGATION_TIMEOUT_MS });
  }

  async waitForText(text: string, timeoutMs = WAIT_TEXT_TIMEOUT_MS): Promise<void> {
    await this.#page.waitForFunction(`(needle) => document.body && document.body.innerText.includes(needle)`, text, { timeout: timeoutMs });
  }

  async wait(ms: number): Promise<void> {
    await this.#page.waitForTimeout(Math.min(ms, MAX_WAIT_MS));
  }

  /** 뷰포트 전체를 JPEG로 찍는다. 토큰 비용이 커서(연구 노트 §2.6) 모델이 자주 부르지 않도록 도구 설명에서 안내한다 */
  async screenshot(): Promise<Buffer> {
    return this.#page.screenshot({ type: 'jpeg', quality: SCREENSHOT_JPEG_QUALITY });
  }

  async pageText(): Promise<string> {
    return this.#page.evaluate<string>(`(document.body ? document.body.innerText : '')`);
  }

  /**
   * 탈출 판정(같은 화면 반복)에 쓰는 값싼 서명. 모델에게 보내지 않아 토큰 비용이 없다.
   * 글자 수만 보면 카운터처럼 같은 길이로 바뀌는 화면(0 → 1 → 2)이 "같은 화면"이 되므로 본문 글자의 해시도 넣는다
   */
  async screenSignature(): Promise<string> {
    return this.#page.evaluate<string>(
      `(() => { const t = document.body ? document.body.innerText : ''; let h = 5381; for (let i = 0; i < t.length; i++) h = ((h * 33) ^ t.charCodeAt(i)) >>> 0; return location.href + '|' + document.title + '|' + document.querySelectorAll('*').length + '|' + t.length + '|' + h; })()`,
    );
  }

  async close(): Promise<void> {
    await this.#screencast?.stop();
    await this.#browser.close().catch(() => {});
  }
}

/** page.evaluate에 그대로 넘기는 요소 묘사. DOM 타입을 쓰지 않으려고 문자열 스크립트가 돌려주는 모양을 여기서 타입으로만 기술한다 */
interface RawElement {
  role: string;
  name: string;
  tag: string;
  text: string;
  testId?: string;
  selector: string;
  stableSelector?: string;
  rect: { x: number; y: number; width: number; height: number };
}

function matchScore(entry: RawElement, needle: string): number {
  if (!needle) return 0;
  const name = entry.name.toLowerCase();
  const text = entry.text.toLowerCase();
  const role = entry.role.toLowerCase();
  const testId = (entry.testId ?? '').toLowerCase();
  if (name === needle || text === needle || testId === needle) return 100;
  if (name.startsWith(needle) || text.startsWith(needle)) return 80;
  if (name.includes(needle) || text.includes(needle) || testId.includes(needle)) return 60;
  if (role.includes(needle) || entry.tag.toLowerCase() === needle) return 20;
  return 0;
}

/** remote-browser.ts의 describeElementSnippet·selectorFor와 같은 생각이되, 인터랙티브 요소 전체를 걷고 role+name/텍스트 고유성까지 본다 */
function collectElementsScript(): string {
  return `(() => {
  const escape = (value) => (window.CSS && window.CSS.escape ? window.CSS.escape(value) : value);
  function visible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== 'hidden' && style.display !== 'none' && style.opacity !== '0';
  }
  function accessibleName(el) {
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && ariaLabel.trim()) return ariaLabel.trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const text = labelledBy.split(/\\s+/).map((id) => (document.getElementById(id) ? document.getElementById(id).textContent : '') || '').join(' ').trim();
      if (text) return text;
    }
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      if (el.id) {
        const label = document.querySelector('label[for="' + escape(el.id) + '"]');
        if (label && label.textContent && label.textContent.trim()) return label.textContent.trim();
      }
      const parentLabel = el.closest('label');
      if (parentLabel && parentLabel.textContent && parentLabel.textContent.trim()) return parentLabel.textContent.trim();
      if (el.placeholder) return el.placeholder.trim();
    }
    const text = (el.textContent || '').trim();
    if (text) return text.slice(0, 120);
    const title = el.getAttribute('title');
    if (title) return title.trim();
    const alt = el.getAttribute('alt');
    if (alt) return alt.trim();
    return '';
  }
  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === 'a' && el.hasAttribute('href')) return 'link';
    if (tag === 'button') return 'button';
    if (tag === 'input') {
      const type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'submit' || type === 'button') return 'button';
      return 'textbox';
    }
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    return tag;
  }
  function isInteractive(el) {
    const tag = el.tagName.toLowerCase();
    if (['a', 'button', 'input', 'textarea', 'select'].includes(tag)) return true;
    const role = el.getAttribute('role');
    if (role && ['button', 'link', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'combobox', 'textbox', 'option'].includes(role)) return true;
    if (el.hasAttribute('onclick')) return true;
    const tabIndex = el.getAttribute('tabindex');
    if (tabIndex !== null && Number(tabIndex) >= 0) return true;
    return false;
  }
  function cssFallback(el) {
    const parts = [];
    let current = el;
    while (current && current.nodeType === 1 && parts.length < 3) {
      let part = current.tagName.toLowerCase();
      const className = typeof current.className === 'string' ? current.className.trim() : '';
      if (className) part += className.split(/\\s+/).slice(0, 2).map((name) => '.' + escape(name)).join('');
      parts.unshift(part);
      current = current.parentElement;
    }
    return parts.join(' > ');
  }
  const all = Array.from(document.querySelectorAll('*'));
  const candidates = all.filter((el) => isInteractive(el) && visible(el) && !el.disabled);
  const infos = candidates.map((el) => ({ el, role: roleOf(el), name: accessibleName(el), text: (el.textContent || '').trim().slice(0, 120) }));
  const roleNameCounts = new Map();
  const textCounts = new Map();
  for (const info of infos) {
    const key = info.role + '\\u0000' + info.name;
    roleNameCounts.set(key, (roleNameCounts.get(key) || 0) + 1);
    if (info.text) textCounts.set(info.text, (textCounts.get(info.text) || 0) + 1);
  }
  return infos.map((info) => {
    const rect = info.el.getBoundingClientRect();
    const testId = info.el.getAttribute('data-testid');
    let selector;
    let stableSelector;
    if (testId) {
      selector = '[data-testid="' + testId + '"]';
      stableSelector = selector;
    } else {
      const key = info.role + '\\u0000' + info.name;
      if (info.name && roleNameCounts.get(key) === 1) {
        stableSelector = 'role=' + info.role + '[name="' + info.name.replace(/"/g, '\\\\"') + '"]';
        selector = stableSelector;
      } else if (info.text && textCounts.get(info.text) === 1) {
        stableSelector = 'text=' + info.text;
        selector = stableSelector;
      } else {
        selector = cssFallback(info.el);
      }
    }
    return {
      role: info.role,
      name: info.name,
      tag: info.el.tagName.toLowerCase(),
      text: info.text,
      ...(testId ? { testId } : {}),
      selector,
      ...(stableSelector ? { stableSelector } : {}),
      rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
    };
  });
})()`;
}

/** 가로 넘침 + 기본 접근성 위반(이미지 alt 없음, 버튼/링크에 접근 가능한 이름 없음, 폼 입력에 라벨 없음)을 현재 화면에서 다시 잰다 */
const STATIC_DIAGNOSTICS_SCRIPT = `(() => {
  const overflow = Math.max(0, document.documentElement.scrollWidth - window.innerWidth);
  const violations = [];
  for (const img of document.querySelectorAll('img')) {
    if (!img.hasAttribute('alt')) violations.push('이미지에 alt 속성이 없습니다: ' + (img.getAttribute('src') || '(src 없음)').slice(0, 80));
  }
  for (const el of document.querySelectorAll('button, a[href]')) {
    const name = (el.getAttribute('aria-label') || el.textContent || '').trim();
    if (!name) violations.push((el.tagName.toLowerCase()) + '에 접근 가능한 이름이 없습니다');
  }
  for (const input of document.querySelectorAll('input, textarea, select')) {
    const type = (input.getAttribute('type') || '').toLowerCase();
    if (['hidden', 'submit', 'button'].includes(type)) continue;
    const hasLabel =
      input.getAttribute('aria-label') ||
      input.getAttribute('aria-labelledby') ||
      input.getAttribute('placeholder') ||
      (input.id && document.querySelector('label[for="' + (window.CSS && window.CSS.escape ? window.CSS.escape(input.id) : input.id) + '"]')) ||
      input.closest('label');
    if (!hasLabel) violations.push('입력칸에 라벨이 없습니다: ' + (input.getAttribute('name') || input.id || '(이름 없음)'));
  }
  return { overflow, violations: violations.slice(0, 20) };
})()`;

// ───────────────────────────── 도구 정의 ─────────────────────────────

export const QA_FINDING_SEVERITIES = ['blocker', 'major', 'minor'] as const;
export type QaFindingSeverity = (typeof QA_FINDING_SEVERITIES)[number];

/** 모델이 화면을 보고 찾아 보고한 문제 하나(qa_report_issue). 플랫폼이 직접 잰 진단 신호와 구분해 결과에 따로 남긴다 */
export interface QaFinding {
  severity: QaFindingSeverity;
  summary: string;
  /** 문제가 보인 요소나 위치 */
  where?: string;
  /** 모델이 적은 근거(어떤 관찰에서 봤는지). 비어 있는 경우가 많다 */
  evidence?: string;
  /** 플랫폼이 붙인다. 보고 시점에 가장 최근 캡처(qa_screenshot)·스냅샷(qa_snapshot)이 몇 번째 동작(QaActionRecord.index)이었는지. 아직 없었으면 빠진다 */
  observedAtAction?: number;
}

/**
 * 모델이 조작 전에 "다음 조작은 서버가 거절(4xx)하는 것이 정상"이라고 선언한 시험(qa_expect_rejection) 하나.
 * requests가 있으면 예상한 거절이 실제로 있었던 것이고, 비어 있으면 거절 응답이 없었던 것이다(unmetRejections)
 */
export interface QaExpectedRejection {
  /** 선언을 쓴 조작의 번호(QaActionRecord.index). 조작 없이 끝난 선언은 없다 */
  actionIndex?: number;
  tool?: string;
  /** 모델이 적은 이유 */
  reason: string;
  /** 그 조작 동안 새로 생긴 4xx 응답 */
  requests: Array<{ status: number; url: string }>;
}

const MAX_FINDINGS = 50;
const MAX_FINDING_SUMMARY = 500;
const MAX_FINDING_DETAIL = 300;

/** 마지막 보고를 받을 때 열어 두는 도구. 화면을 더 조작하지는 못한다 */
export const QA_REPORT_TOOLS: ReadonlySet<string> = new Set(['qa_report_issue', 'qa_finish']);

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[] = Object.keys(properties)): BetaTool {
  return { name, description, input_schema: { type: 'object', properties, required, additionalProperties: false } };
}

/**
 * 탐색형 QA 도구 세트(설계안 §6.2). 관찰은 접근성 트리(qa_snapshot/qa_find) 위주로 두고 스크린샷은 선택적으로만 쓰게 해
 * 토큰 비용을 아낀다(§6.7). 임의 JS 실행·파일 업로드 도구는 주지 않는다(§6.8) — 샌드박스 앱이라도 과한 권한이다.
 */
export function buildQaTools(): BetaTool[] {
  return [
    tool(
      'qa_snapshot',
      '지금 화면의 인터랙티브 요소(버튼·링크·입력칸 등) 목록을 ref와 함께 돌려줍니다. 스크린샷보다 저렴하니 기본 관찰 수단으로 이것부터 쓰세요.',
      {},
    ),
    tool('qa_find', '자연어로 요소를 찾습니다(텍스트·역할·이름에 느슨하게 맞춥니다). 최대 20개의 ref를 돌려줍니다.', {
      query: { type: 'string', description: '찾으려는 요소를 설명하는 문구(예: "장바구니에 담기 버튼")' },
    }),
    tool(
      'qa_screenshot',
      '지금 보이는 화면(뷰포트)의 스크린샷을 이미지로 돌려줍니다. 잘림·겹침·넘침·대비·여백·정렬 같은 시각적 확인은 접근성 트리로 알 수 없으니 이 도구로 직접 보세요. ' +
        '화면보다 긴 페이지는 qa_scroll로 내려가며 위치마다 한 번씩 찍어야 아래쪽까지 볼 수 있습니다. 화면이 바뀌지 않았다면 다시 찍을 필요가 없습니다(토큰 비용이 큽니다).',
      {},
    ),
    tool(
      'qa_click',
      'ref로 가리킨 요소를 클릭합니다. 적절한 ref가 없을 때만(예: 캔버스) x, y 좌표로 클릭하세요.',
      {
        ref: { type: 'string', description: 'qa_snapshot/qa_find가 돌려준 ref' },
        x: { type: 'integer', description: 'ref가 없을 때의 대안: 뷰포트 x 좌표' },
        y: { type: 'integer', description: 'ref가 없을 때의 대안: 뷰포트 y 좌표' },
      },
      [],
    ),
    tool('qa_fill', '입력칸(ref)에 값을 한 번에 채웁니다. 값 변경 이벤트만 필요할 때 쓰세요.', {
      ref: { type: 'string', description: 'qa_snapshot/qa_find가 돌려준 입력칸 ref' },
      text: { type: 'string', description: '채울 값' },
    }),
    tool('qa_type', '입력칸(ref)에 한 글자씩 입력합니다. 자동완성처럼 입력 중 이벤트가 필요한 화면에 쓰세요.', {
      ref: { type: 'string', description: 'qa_snapshot/qa_find가 돌려준 입력칸 ref' },
      text: { type: 'string', description: '입력할 값' },
    }),
    tool('qa_press', '지금 포커스에 키를 누릅니다(예: Enter, Escape, Tab).', { key: { type: 'string', description: 'playwright 키 이름(예: Enter)' } }),
    tool('qa_hover', 'ref로 가리킨 요소 위에 마우스를 올립니다(hover로만 나타나는 메뉴 확인용).', { ref: { type: 'string', description: 'qa_snapshot/qa_find가 돌려준 ref' } }),
    tool(
      'qa_scroll',
      '페이지를 스크롤합니다. 페이지 전체를 내리거나 올릴 때는 ref를 아예 빼고 direction(과 amount)만 주세요 — ref에 빈 문자열을 넣지 마세요. ' +
        '특정 요소를 화면에 보이게 하고 싶을 때만 그 요소의 ref를 줍니다. 결과에 현재 위치와 맨 아래에 닿았는지가 나옵니다.',
      {
        ref: { type: 'string', description: '선택. 화면에 보이게 할 요소의 ref. 페이지를 스크롤할 때는 생략합니다' },
        direction: { type: 'string', enum: ['up', 'down'], description: 'ref를 생략했을 때 스크롤할 방향(기본 down)' },
        amount: { type: 'integer', description: '스크롤할 픽셀 수(기본 600)' },
      },
      [],
    ),
    tool('qa_navigate', '같은 서비스 안의 다른 경로로 이동합니다(허용한 출처 밖으로는 이동할 수 없습니다).', { path: { type: 'string', description: '이동할 경로(예: /cart)' } }),
    tool(
      'qa_wait',
      '화면에 문구가 나타날 때까지(forText) 또는 일정 시간(ms, 최대 5000) 기다립니다.',
      {
        forText: { type: 'string', description: '나타나길 기다릴 문구' },
        ms: { type: 'integer', description: '기다릴 시간(ms). forText와 함께 쓰지 않습니다' },
      },
      [],
    ),
    tool(
      'qa_report_issue',
      '화면에서 직접 본 문제 하나를 보고합니다(여러 개면 여러 번 부릅니다). 추측이 아니라 본 것만 적고, 어느 요소가 어떻게 잘못됐는지 구체적으로 쓰세요. ' +
        '보고한 문제는 결과에 남고 통과로 덮이지 않습니다. 화면을 조작하는 행동이 아니라서 행동 횟수에 들지 않습니다.',
      {
        severity: {
          type: 'string',
          enum: [...QA_FINDING_SEVERITIES],
          description: 'blocker: 목표를 못 하게 막거나 내용을 읽을 수 없음 / major: 눈에 띄게 잘못됨(잘림·겹침·화면 밖·읽기 어려운 대비) / minor: 거슬리지만 쓰는 데 지장은 없음',
        },
        summary: { type: 'string', description: '어느 요소가 어떻게 잘못됐는지 한두 문장' },
        where: { type: 'string', description: '선택. 문제가 보인 요소나 위치(예: "화면 아래 로그인 줄", 스크롤 y=800)' },
        evidence: { type: 'string', description: '선택. 어떤 관찰에서 봤는지(예: "두 번째 스크린샷 하단")' },
      },
      ['severity', 'summary'],
    ),
    tool(
      'qa_expect_rejection',
      '바로 다음 조작 하나는 서버가 거절(4xx)하는 것이 정상이라고 미리 알립니다. 로그인 없이 주문, 빈 값 제출처럼 일부러 거절될 조작을 하기 전에 먼저 부르세요. ' +
        '그 조작 하나에서 생긴 4xx 응답만 "예상된 거절"로 따로 기록하고 실패로 세지 않습니다. 5xx·네트워크 실패와 다른 조작의 실패는 그대로 실패입니다. ' +
        '선언은 다음 조작(클릭·입력·키·이동) 하나에만 쓰이고, 관찰(스냅샷·캡처·스크롤 등)은 선언을 소모하지 않습니다. 선언했는데 거절 응답이 없으면 결과로 알려 드립니다. 행동 횟수에 들지 않습니다.',
      { reason: { type: 'string', description: '왜 거절되는 것이 정상인지 한 문장(예: "로그인하지 않았으니 주문은 401로 거절돼야 한다")' } },
    ),
    tool(
      'qa_finish',
      '점검이나 목표 수행을 마쳤다고 판단하면 이 도구로 실행을 마칩니다. 끝내기 전에 본 문제를 qa_report_issue로 모두 보고하세요. ' +
        'success는 "목표(점검)를 끝까지 수행했는지"이지 "문제가 없는지"가 아닙니다 — 문제를 찾았어도 점검을 끝까지 했다면 success: true이고 문제는 qa_report_issue로 남깁니다. ' +
        '이 선언만으로 통과가 결정되지 않습니다 — 플랫폼이 진단 신호, 확인 문구, 보고된 문제를 따로 확인합니다.',
      {
        success: { type: 'boolean', description: '목표(점검)를 끝까지 수행했는지. 막혀서 못 했으면 false' },
        summary: { type: 'string', description: '무엇을 했고 어떤 결과를 봤는지 한두 문장. 문제가 없으면 없다고 적습니다' },
      },
    ),
  ];
}

// ───────────────────────────── 행동 기록·실행 ─────────────────────────────

/** 실행 한 번(qa_click 등)의 기록. toPageCheckSteps가 이 기록을 WorkflowPageStep으로 바꾼다 */
export interface QaActionRecord {
  index: number;
  tool: string;
  input: Record<string, unknown>;
  ok: boolean;
  detail?: string;
  /** 실제로 쓴 선택자(ref가 가리킨 요소, 있으면) */
  resolvedSelector?: string;
  /** steps로 저장해도 안전하다고 본 선택자. 없으면 저장 시 제외하고 이유를 남긴다 */
  stableSelector?: string;
  /** 이 행동 직후 쌓인 진단 신호 개수(그 전까지 누적과의 차이) */
  newDiagnosticsCount: number;
  /** 행동이 가리킨 요소의 뷰포트 영역(있으면). QA 탭이 지금 누른 위치에 상자를 그리는 데 쓴다 */
  targetRect?: { x: number; y: number; width: number; height: number };
  /** saveArtifact를 넘겼을 때만 채운다. 단계 타임라인의 스크린샷 썸네일 식별자 */
  artifact?: string;
  url: string;
  at: number;
}

/** qa_finish를 뺀 실행 가능한 도구 이름 */
const ACTION_TOOLS = new Set(['qa_snapshot', 'qa_find', 'qa_screenshot', 'qa_click', 'qa_fill', 'qa_type', 'qa_press', 'qa_hover', 'qa_scroll', 'qa_navigate', 'qa_wait']);

export interface QaToolOutcome {
  ok: boolean;
  text: string;
  image?: { data: Buffer; mediaType: 'image/jpeg' };
  stableSelector?: string;
  resolvedSelector?: string;
  rect?: { x: number; y: number; width: number; height: number };
}

/** 도구 이름과 입력을 받아 QaBrowser에서 실제로 실행한다. 루프(runExploreQa)와 claude-code 실행기(explore-qa-claude-code.ts)가 함께 쓴다 */
export async function executeQaTool(name: string, input: Record<string, unknown>, browser: QaBrowser): Promise<QaToolOutcome> {
  try {
    switch (name) {
      case 'qa_snapshot': {
        const result = await browser.snapshot();
        return { ok: true, text: formatSnapshot(result) };
      }
      case 'qa_find': {
        const elements = await browser.find(requireString(input, 'query'));
        return { ok: true, text: elements.length > 0 ? elements.map(formatElement).join('\n') : '(일치하는 요소가 없습니다)' };
      }
      case 'qa_screenshot': {
        const data = await browser.screenshot();
        return { ok: true, text: `스크린샷을 찍었습니다 (${data.length.toLocaleString('ko-KR')} bytes)`, image: { data, mediaType: 'image/jpeg' } };
      }
      case 'qa_click': {
        const ref = optionalRef(input);
        const x = optionalNumber(input, 'x');
        const y = optionalNumber(input, 'y');
        const { stableSelector, rect } = await browser.click({ ...(ref !== undefined ? { ref } : {}), ...(x !== undefined ? { x } : {}), ...(y !== undefined ? { y } : {}) });
        return { ok: true, text: ref ? `${ref}를 클릭했습니다` : `(${x}, ${y})를 클릭했습니다`, ...(stableSelector ? { stableSelector } : {}), ...(rect ? { rect } : {}) };
      }
      case 'qa_fill': {
        const ref = requireRef(input);
        const { stableSelector, rect } = await browser.fill(ref, requireString(input, 'text'));
        return { ok: true, text: `${ref}에 값을 채웠습니다`, ...(stableSelector ? { stableSelector } : {}), rect };
      }
      case 'qa_type': {
        const ref = requireRef(input);
        const { stableSelector, rect } = await browser.type(ref, requireString(input, 'text'));
        return { ok: true, text: `${ref}에 입력했습니다`, ...(stableSelector ? { stableSelector } : {}), rect };
      }
      case 'qa_press': {
        const key = requireString(input, 'key');
        await browser.press(key);
        return { ok: true, text: `${key}를 눌렀습니다` };
      }
      case 'qa_hover': {
        const ref = requireRef(input);
        const { rect } = await browser.hover(ref);
        return { ok: true, text: `${ref} 위에 마우스를 올렸습니다`, rect };
      }
      case 'qa_scroll': {
        const ref = optionalRef(input);
        const rawDirection = optionalString(input, 'direction');
        const direction = rawDirection === 'up' || rawDirection === 'down' ? rawDirection : undefined;
        const amount = optionalNumber(input, 'amount');
        const position = await browser.scroll({ ...(ref !== undefined ? { ref } : {}), ...(direction !== undefined ? { direction } : {}), ...(amount !== undefined ? { amount } : {}) });
        const lead = ref ? `${ref}가 보이게 스크롤했습니다` : `${direction ?? 'down'} 방향으로 ${amount ?? SCROLL_PAGE_PX}px 스크롤했습니다`;
        return { ok: true, text: `${lead}. ${describeScrollPosition(position)}` };
      }
      case 'qa_navigate': {
        const path = requireString(input, 'path');
        await browser.navigate(path);
        return { ok: true, text: `${path}로 이동했습니다` };
      }
      case 'qa_wait': {
        const forText = optionalString(input, 'forText');
        const ms = optionalNumber(input, 'ms');
        if (forText !== undefined) {
          await browser.waitForText(forText);
          return { ok: true, text: `'${forText}'가 화면에 나타났습니다` };
        }
        await browser.wait(ms ?? 1000);
        return { ok: true, text: `${Math.min(ms ?? 1000, MAX_WAIT_MS)}ms 기다렸습니다` };
      }
      default:
        return { ok: false, text: `알 수 없는 도구: ${name}` };
    }
  } catch (error) {
    return { ok: false, text: error instanceof Error ? error.message : String(error) };
  }
}

function describeScrollPosition(position: QaScrollPosition): string {
  if (position.max <= 0) return '문서 자체는 스크롤되지 않습니다(화면 안쪽의 스크롤 영역이 따로 있을 수 있습니다).';
  const where = `현재 y=${position.y} / 최대 ${position.max}`;
  if (position.atBottom) return `${where}, 맨 아래에 닿았습니다.`;
  return `${where}, 맨 아래가 아닙니다${position.atTop ? '(맨 위)' : ''}.`;
}

function formatElement(element: QaElement): string {
  const parts = [element.ref, element.role, element.name || '(이름 없음)'];
  if (element.testId) parts.push(`testid=${element.testId}`);
  return parts.join('\t');
}

function formatSnapshot(result: { url: string; title: string; elements: QaElement[]; truncated: boolean }): string {
  const header = `${result.url} — ${result.title}`;
  const body = result.elements.length > 0 ? result.elements.map(formatElement).join('\n') : '(인터랙티브 요소가 없습니다)';
  const footer = result.truncated ? `\n(요소가 많아 처음 ${MAX_SNAPSHOT_ELEMENTS}개만 보여줍니다. qa_find로 특정 요소를 찾으세요)` : '';
  return `${header}\n${body}${footer}`;
}

/**
 * 모델이 ref 자리에 넣는 "없음" 표현을 모두 생략으로 본다: 인자 없음, 빈 문자열, 공백, 따옴표만 있는 값(빈 따옴표 쌍, 따옴표를 이중으로 감싼 빈 값).
 * 값이 따옴표로 감싸여 오면(예: "e3" 를 따옴표째) 따옴표를 벗겨 쓴다. 로컬 CLI 백엔드에서 실제로 따옴표만 든 ref가 와서 페이지 스크롤이 실패했다
 */
export function normalizeRef(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const ref = value.replace(/^[\s"'`]+|[\s"'`]+$/g, '');
  return ref === '' ? undefined : ref;
}

function optionalRef(input: Record<string, unknown>): string | undefined {
  return normalizeRef(input.ref);
}

function requireRef(input: Record<string, unknown>): string {
  const ref = normalizeRef(input.ref);
  if (ref === undefined) throw new Error('ref가 비어 있습니다 — qa_snapshot이나 qa_find가 돌려준 ref(예: e3)를 넣으세요');
  return ref;
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  if (typeof value !== 'string') throw new Error(`"${key}"는 문자열이어야 합니다`);
  return value;
}

function optionalString(input: Record<string, unknown>, key: string): string | undefined {
  const value = input[key];
  return typeof value === 'string' ? value : undefined;
}

function optionalNumber(input: Record<string, unknown>, key: string): number | undefined {
  const value = input[key];
  return typeof value === 'number' ? value : undefined;
}

// ───────────────────────────── 실행 루프(api 백엔드) ─────────────────────────────

export interface ExploreQaGoal {
  /** 사람이 적은 목표 문장(예: "상품 목록에서 상세로 가서 댓글을 쓰고 지운다") */
  goal: string;
  /** 시작 경로. 세션 서비스 기준 상대 경로(예: /products) */
  startPath: string;
  /** 끝났을 때 화면에 있어야 할 확인 문구. 없으면 진단 신호만으로 판정한다 */
  confirmText?: string;
  /** 기본 30 */
  maxActions?: number;
  /** 기본 5분 */
  maxMs?: number;
  /** 같은 화면이 이 횟수만큼 연속되면 멈춘다(기본 4) */
  repeatLimit?: number;
}

const DEFAULT_MAX_ACTIONS = 30;
const DEFAULT_MAX_MS = 5 * 60_000;
const DEFAULT_REPEAT_LIMIT = 4;

export type ExploreQaStopReason = 'finish' | 'max_actions' | 'max_time' | 'repeated_screen' | 'no_tool_call';

/** pass: 문제 없음(또는 minor만) / fail: 진단 신호·blocker·major 발견·목표 실패 보고 / inconclusive: 점검을 마치지 못했고 모델의 마지막 보고도 없음 */
export type ExploreQaStatus = 'pass' | 'fail' | 'inconclusive';

export interface ExploreQaResult {
  /** 플랫폼이 내린 최종 판정. 모델의 qa_finish 선언을 그대로 따르지 않는다(설계안 §6.3·§6.8) */
  status: ExploreQaStatus;
  reason: string;
  modelDeclared?: { success: boolean; summary: string };
  /** 모델이 화면을 보고 보고한 문제(qa_report_issue). 판정이 통과여도 minor는 여기에 남는다 */
  findings: QaFinding[];
  /** 모델이 미리 선언해 서버가 거절한 시험(조작과 4xx 응답). 진단 신호로 세지 않고 여기에 남긴다 */
  expectedRejections: QaExpectedRejection[];
  /** 거절될 것으로 선언했지만 거절 응답이 없던 조작. 진짜 문제일 수 있어 남기지만(통과한 요청 또는 클라이언트에서 막힌 요청) 판정은 바꾸지 않는다 */
  unmetRejections: QaExpectedRejection[];
  stoppedBy: ExploreQaStopReason;
  diagnostics: QaDiagnostics;
  actions: QaActionRecord[];
  usage: AgentUsage;
}

export type ExploreQaEvent =
  | { type: 'action'; record: QaActionRecord }
  | { type: 'finding'; finding: QaFinding }
  | { type: 'rejection'; rejection: QaExpectedRejection }
  | { type: 'text'; text: string }
  | { type: 'frame'; frame: BrowserFrame };

export interface RunExploreQaOptions {
  client: ModelClient;
  goal: ExploreQaGoal;
  /** 시작 경로를 연 절대 URL */
  startUrl: string;
  allowedOrigins: readonly string[];
  viewport?: QaViewport;
  onFrame?: (frame: BrowserFrame) => void;
  onEvent?: (event: ExploreQaEvent) => void;
  /**
   * 주면 행동마다 뷰포트 스크린샷을 찍어 저장하고 식별자를 QaActionRecord.artifact에 남긴다(단계 타임라인 썸네일용).
   * 모델에 보내는 토큰 비용과 무관하다(qa_screenshot 도구 호출과 별개로, 사람이 보는 화면 전용 산출물이다).
   */
  saveArtifact?: (input: { name: string; data: Buffer; contentType: 'image/png' | 'image/jpeg' }) => Promise<string>;
  signal?: AbortSignal;
}

function emptyUsage(): AgentUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

/** 모델 응답 하나의 사용량을 더한다(api 백엔드) */
function addMessageUsage(total: AgentUsage, usage: { input_tokens?: number | null; output_tokens?: number | null; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null } | undefined): void {
  if (!usage) return;
  total.inputTokens += usage.input_tokens ?? 0;
  total.outputTokens += usage.output_tokens ?? 0;
  total.cacheReadTokens += usage.cache_read_input_tokens ?? 0;
  total.cacheWriteTokens += usage.cache_creation_input_tokens ?? 0;
}

/** 목표 문장이 "문제를 찾아라"는 점검형인지. 점검형이면 시스템 지시문에 화면 점검 요령을 더한다 */
export function isInspectionGoal(goalText: string): boolean {
  return /점검|검사|살펴|찾아|문제|잘리|잘려|겹치|겹쳐|넘치|어색|읽기 어려|깨지|이상한|리뷰|검토|inspect|review|audit|layout/i.test(goalText);
}

export function buildQaSystemPrompt(goal?: Pick<ExploreQaGoal, 'goal'>): string {
  const lines = [
    '당신은 웹 애플리케이션의 UI/UX를 사람처럼 눈으로 보고 손으로 조작하며 시험하는 QA 에이전트입니다.',
    '주어진 목표를 화면에서 직접 수행하세요. qa_snapshot으로 화면의 인터랙티브 요소를 관찰하고, 필요한 ref를 골라 행동하세요.',
    '화면이 어떻게 보이는지는 접근성 트리로 알 수 없습니다. 잘림·겹침·넘침·대비·여백·정렬처럼 눈으로 봐야 하는 것은 qa_screenshot으로 직접 확인하세요(이미지가 돌아옵니다).',
    '페이지를 내릴 때는 qa_scroll에 ref를 넣지 말고 direction만 주세요. 결과에 맨 아래에 닿았는지가 나옵니다.',
    '화면에서 문제를 보면 그 자리에서 qa_report_issue로 보고하세요. 본 것만 적고(추측 금지), 어느 요소가 어떻게 잘못됐는지 구체적으로 쓰세요. 문제를 찾았어도 점검을 계속할 수 있습니다.',
    '목표를 끝까지 수행했거나 더 진행할 수 없으면 qa_finish를 부르세요. 성공을 선언해도 플랫폼이 진단 신호·확인 문구·보고된 문제를 따로 확인하니 솔직하게 판단하세요. 문제가 없으면 없다고 적으면 됩니다.',
    '일부러 거절될 조작(로그인 없이 주문, 빈 값 제출 등)을 하기 전에는 먼저 qa_expect_rejection으로 알리세요. 알리지 않은 조작에서 서버가 거절하면 실패한 요청으로 세어 문제로 판정합니다.',
    '화면을 바꾸지 않는 관찰은 필요한 만큼 해도 되지만, 같은 화면에서 같은 조작을 되풀이하지 말고 막히면 다른 요소를 시도하거나 qa_finish(success: false)로 알리세요.',
  ];
  if (goal && isInspectionGoal(goal.goal)) {
    lines.push(
      '이 목표는 화면을 점검하는 일입니다. 다음 순서로 하세요.',
      '1) 시작 화면을 qa_screenshot으로 봅니다. 2) qa_scroll로 한 화면씩 내려가며 위치마다 qa_screenshot을 찍어 맨 아래에 닿을 때까지 확인합니다(한 화면만 보고 끝내지 마세요). 3) 각 화면에서 잘리거나 겹치거나 화면 밖으로 나간 요소, 읽기 어려운 글자(크기·대비), 정렬이 어긋나거나 한쪽으로 쏠린 배치, 큰 빈 여백을 찾습니다. 4) 눌러 볼 만한 요소(탭·열기 버튼)가 있으면 눌러 숨은 화면도 봅니다. 5) 본 문제는 모두 qa_report_issue로 보고하고 qa_finish로 마칩니다.',
    );
  }
  return lines.join('\n');
}

export function buildQaUserPrompt(goal: ExploreQaGoal): string {
  const lines = [`목표: ${goal.goal}`, `시작 화면: ${goal.startPath}`];
  if (goal.confirmText) lines.push(`끝났을 때 화면에 '${goal.confirmText}' 문구가 있어야 합니다.`);
  return lines.join('\n');
}

const STOP_REASON_TEXT: Record<ExploreQaStopReason, string> = {
  finish: 'qa_finish로 마침',
  max_actions: '행동 횟수 한도에 도달함',
  max_time: '시간 한도에 도달함',
  repeated_screen: '같은 화면에서 같은 조작이 되풀이됨',
  no_tool_call: '도구를 부르지 않고 글만 냄',
};

/** 한도·반복·도구 없음으로 끝날 때 모델에게 마지막 보고를 요청하는 문장. 두 백엔드가 같이 쓴다 */
export function buildWrapUpPrompt(reason: ExploreQaStopReason): string {
  return [
    `점검이 곧 끝납니다(${STOP_REASON_TEXT[reason]}). 더 이상 화면을 조작할 수 없습니다.`,
    '지금까지 본 것으로 마지막 보고를 하세요. 아직 보고하지 않은 문제가 있으면 qa_report_issue로 하나씩 보고하고(이미 보고한 것은 다시 하지 마세요), 마지막으로 qa_finish를 부르세요.',
    '문제를 보지 못했다면 qa_finish의 summary에 문제를 보지 못했다고 적으세요. 목표나 점검을 끝까지 하지 못했다면 success: false로 알리세요.',
  ].join('\n');
}

/**
 * 모델이 보낸 발견과 마지막 선언을 모은다. 두 백엔드(api 루프·로컬 CLI)가 같은 규칙으로 쓴다:
 * 같은 요약은 한 번만 싣고, 심각도가 틀리거나 요약이 비면 오류로 돌려줘 모델이 고쳐 부르게 한다.
 */
export class QaReport {
  readonly findings: QaFinding[] = [];
  declared: { success: boolean; summary: string } | undefined;
  /** 선언한 거절이 실제로 있었던 시험 */
  readonly expectedRejections: QaExpectedRejection[] = [];
  readonly #unmet: QaExpectedRejection[] = [];
  /** 선언은 했지만 아직 쓰이지 않은 것(다음 조작을 기다린다) */
  #pendingReason: string | undefined;
  #lastCaptureAction: number | undefined;

  /** 거절될 것으로 선언했지만 거절이 없던 시험. 조작 없이 끝난 선언도 여기에 든다 */
  get unmetRejections(): QaExpectedRejection[] {
    return [...this.#unmet, ...(this.#pendingReason !== undefined ? [{ reason: this.#pendingReason, requests: [] }] : [])];
  }

  /** qa_expect_rejection: 바로 다음 조작 하나가 거절되는 것이 정상이라는 선언을 받는다. 두 번 선언하면 나중 것으로 바꾼다 */
  declareRejection(input: Record<string, unknown>): { ok: boolean; text: string } {
    const reason = typeof input.reason === 'string' ? input.reason.trim().slice(0, MAX_FINDING_DETAIL) : '';
    if (reason === '') return { ok: false, text: 'reason(왜 거절되는 것이 정상인지)을 적어 주세요' };
    const replaced = this.#pendingReason !== undefined;
    this.#pendingReason = reason;
    return {
      ok: true,
      text: `${replaced ? '앞의 선언을 이 선언으로 바꿨습니다. ' : ''}다음 조작 하나(클릭·입력·키·이동)에서 서버가 거절(4xx)하는지 확인합니다. 관찰 동작은 선언을 소모하지 않습니다.`,
    };
  }

  /**
   * 도구 하나를 실행한다. 두 백엔드가 executeQaTool 대신 이것을 부른다.
   * 선언이 있고 이 도구가 화면을 바꾸는 조작이면 그 조작 동안 새로 생긴 4xx 응답을 예상된 거절로 옮기고(진단 신호에서 뺀다),
   * 거절이 없었으면 그 사실을 도구 결과에 덧붙인다. 조작이 실패하면 선언은 유지한다.
   * 가장 최근 캡처·스냅샷의 번호도 여기서 기록해 qa_report_issue의 observedAtAction에 쓴다
   */
  async runAction(name: string, input: Record<string, unknown>, browser: QaBrowser, index: number): Promise<{ outcome: QaToolOutcome; rejection?: QaExpectedRejection }> {
    const reason = OPERATION_TOOLS.has(name) ? this.#pendingReason : undefined;
    const mark = reason !== undefined ? browser.beginRejectionWatch() : 0;
    const outcome = await executeQaTool(name, input, browser);
    if (outcome.ok && (name === 'qa_screenshot' || name === 'qa_snapshot')) this.#lastCaptureAction = index;
    if (reason === undefined) return { outcome };
    if (!outcome.ok) {
      browser.cancelRejectionWatch();
      return { outcome };
    }
    this.#pendingReason = undefined;
    const requests = await browser.endRejectionWatch(mark);
    const rejection: QaExpectedRejection = { actionIndex: index, tool: name, reason, requests };
    if (requests.length > 0) {
      this.expectedRejections.push(rejection);
      const shown = requests.map((request) => `${request.status} ${request.url}`).join(', ');
      return { outcome: { ...outcome, text: `${outcome.text}\n예상한 거절을 확인했습니다: ${shown}` }, rejection };
    }
    this.#unmet.push(rejection);
    return {
      outcome: {
        ...outcome,
        text: `${outcome.text}\n거절될 것으로 선언한 조작에서 거절 응답이 없었습니다. 서버가 요청을 통과시켰거나 요청이 화면(클라이언트)에서 먼저 막혔을 수 있습니다. 통과시킨 것이 문제라면 qa_report_issue로 보고하세요.`,
      },
      rejection,
    };
  }

  addFinding(input: Record<string, unknown>): { ok: boolean; text: string; finding?: QaFinding } {
    const severity = input.severity;
    if (typeof severity !== 'string' || !(QA_FINDING_SEVERITIES as readonly string[]).includes(severity)) {
      return { ok: false, text: `severity는 ${QA_FINDING_SEVERITIES.join(', ')} 중 하나여야 합니다` };
    }
    const summary = typeof input.summary === 'string' ? input.summary.trim().slice(0, MAX_FINDING_SUMMARY) : '';
    if (summary === '') return { ok: false, text: 'summary(어느 요소가 어떻게 잘못됐는지)를 적어 주세요' };
    if (this.findings.some((existing) => existing.severity === severity && existing.summary === summary)) return { ok: true, text: '이미 보고한 문제입니다' };
    if (this.findings.length >= MAX_FINDINGS) return { ok: false, text: `보고할 수 있는 문제는 최대 ${MAX_FINDINGS}건입니다` };
    const where = typeof input.where === 'string' ? input.where.trim().slice(0, MAX_FINDING_DETAIL) : '';
    const evidence = typeof input.evidence === 'string' ? input.evidence.trim().slice(0, MAX_FINDING_DETAIL) : '';
    const finding: QaFinding = {
      severity: severity as QaFindingSeverity,
      summary,
      ...(where ? { where } : {}),
      ...(evidence ? { evidence } : {}),
      ...(this.#lastCaptureAction !== undefined ? { observedAtAction: this.#lastCaptureAction } : {}),
    };
    this.findings.push(finding);
    return { ok: true, text: `문제를 기록했습니다(${this.findings.length}건째)`, finding };
  }

  declare(input: Record<string, unknown>): void {
    this.declared = { success: Boolean(input.success), summary: typeof input.summary === 'string' ? input.summary : '' };
  }
}

/** 조작해서 화면을 바꾸려는 도구. 같은 화면에서 이 조작이 되풀이되는지만 "반복"으로 센다 */
const REPEAT_TRACKED_TOOLS = new Set(['qa_click', 'qa_fill', 'qa_type', 'qa_press', 'qa_navigate']);
/** 예상된 거절 선언을 소모하는 조작. 반복 감지가 세는 조작과 같다(hover·scroll·wait 등 관찰은 소모하지 않는다) */
const OPERATION_TOOLS = REPEAT_TRACKED_TOOLS;

/**
 * "같은 화면에서 같은 조작을 되풀이"하는 루프를 잡는다. 관찰(snapshot·find·screenshot·wait·scroll·hover)과 실패한 동작은 세지 않는다 —
 * 점검형 목표에서는 화면이 안 바뀌는 것이 정상이다. 관찰만 끝없이 하는 경우는 maxActions·maxMs가 막는다.
 * 조작 사이에 관찰이 끼어도 같은 조작·같은 화면이 이어지면 센다(관찰은 연속을 끊지 않는다).
 */
export class RepeatTracker {
  readonly #limit: number;
  #key: string | undefined;
  #count = 0;

  constructor(limit: number) {
    this.#limit = limit;
  }

  /** 조작 하나를 기록한다. `signature`는 그 조작 직후 화면 서명이며, 한도만큼 이어졌으면 true */
  record(action: Pick<QaActionRecord, 'tool' | 'input' | 'ok'>, signature: () => Promise<string>): Promise<boolean> {
    if (!action.ok || !REPEAT_TRACKED_TOOLS.has(action.tool)) return Promise.resolve(false);
    return signature().then((value) => {
      const key = `${action.tool}|${JSON.stringify(action.input)}|${value}`;
      this.#count = key === this.#key ? this.#count + 1 : 1;
      this.#key = key;
      return this.#count >= this.#limit;
    });
  }
}

/** 세션 상태를 모아 플랫폼의 판정이 담긴 결과를 만든다. 두 백엔드가 같이 쓴다 */
export async function buildExploreQaResult(input: {
  goal: ExploreQaGoal;
  browser: QaBrowser;
  report: QaReport;
  stoppedBy: ExploreQaStopReason;
  actions: QaActionRecord[];
  usage: AgentUsage;
}): Promise<ExploreQaResult> {
  const { goal, browser, report, stoppedBy, actions, usage } = input;
  const diagnostics = await browser.currentDiagnostics();
  const pageText = await browser.pageText();
  const judged = judge(goal, diagnostics, pageText, {
    findings: report.findings,
    ...(report.declared ? { declared: report.declared } : {}),
    stoppedBy,
    expectedRejections: report.expectedRejections.length,
    unmetRejections: report.unmetRejections.length,
  });
  return {
    status: judged.status,
    reason: judged.reason,
    ...(report.declared ? { modelDeclared: report.declared } : {}),
    findings: [...report.findings],
    expectedRejections: [...report.expectedRejections],
    unmetRejections: report.unmetRejections,
    stoppedBy,
    diagnostics,
    actions,
    usage,
  };
}

/** 메시지 목록 끝에 사용자 글을 더한다. 끝이 도구 결과(user)면 같은 메시지 안에 덧붙여 user 메시지가 연달아 오지 않게 한다 */
function appendUserText(messages: BetaMessageParam[], text: string): void {
  const last = messages.at(-1);
  if (last?.role === 'user') {
    const blocks = typeof last.content === 'string' ? [{ type: 'text' as const, text: last.content }] : last.content;
    messages[messages.length - 1] = { role: 'user', content: [...blocks, { type: 'text', text }] };
  } else {
    messages.push({ role: 'user', content: text });
  }
}

const WRAP_UP_ROUNDS = 3;

/**
 * api 백엔드(직접 만든 루프)의 모델 호출 방식 그대로 탐색형 QA를 돈다.
 * ModelClient를 그대로 재사용하므로(loop.ts와 같은 인터페이스), model-registry.ts의 clientForModel이 돌려주는
 * 클라이언트나 테스트용 ScriptedModelClient를 그대로 꽂을 수 있다.
 */
export async function runExploreQa(options: RunExploreQaOptions): Promise<ExploreQaResult> {
  const { client, goal, startUrl, allowedOrigins, viewport, onFrame, onEvent, saveArtifact, signal } = options;
  const maxActions = goal.maxActions ?? DEFAULT_MAX_ACTIONS;
  const maxMs = goal.maxMs ?? DEFAULT_MAX_MS;
  const repeatLimit = goal.repeatLimit ?? DEFAULT_REPEAT_LIMIT;
  const deadline = Date.now() + maxMs;

  const browser = await QaBrowser.open(startUrl, { allowedOrigins, ...(viewport ? { viewport } : {}), ...(onFrame ? { onFrame } : {}) });
  try {
    const tools = buildQaTools();
    const system = buildQaSystemPrompt(goal);
    const messages: BetaMessageParam[] = [{ role: 'user', content: buildQaUserPrompt(goal) }];
    const usage = emptyUsage();
    const actions: QaActionRecord[] = [];
    const report = new QaReport();
    const repeats = new RepeatTracker(repeatLimit);
    let stoppedBy: ExploreQaStopReason = 'max_actions';
    let actionCount = 0;
    let previousDiagnosticsCount = 0;

    const handleReportTool = (call: BetaToolUseBlock): BetaToolResultBlockParam | undefined => {
      const input = (call.input ?? {}) as Record<string, unknown>;
      if (call.name === 'qa_report_issue') {
        const added = report.addFinding(input);
        if (added.finding) onEvent?.({ type: 'finding', finding: added.finding });
        return { type: 'tool_result', tool_use_id: call.id, content: added.text, is_error: !added.ok };
      }
      if (call.name === 'qa_finish') {
        report.declare(input);
        return { type: 'tool_result', tool_use_id: call.id, content: 'qa_finish를 받았습니다. 실행을 마칩니다.' };
      }
      return undefined;
    };

    const handleExpectTool = (call: BetaToolUseBlock): BetaToolResultBlockParam => {
      const declared = report.declareRejection((call.input ?? {}) as Record<string, unknown>);
      return { type: 'tool_result', tool_use_id: call.id, content: declared.text, is_error: !declared.ok };
    };

    for (;;) {
      if (Date.now() >= deadline) {
        stoppedBy = 'max_time';
        break;
      }
      if (actionCount >= maxActions) {
        stoppedBy = 'max_actions';
        break;
      }
      signal?.throwIfAborted();
      const message = await client.createMessage({ system, tools, messages }, signal);
      addMessageUsage(usage, message.usage);
      messages.push({ role: 'assistant', content: message.content });
      const text = message.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n')
        .trim();
      if (text) onEvent?.({ type: 'text', text });

      const toolUses = message.content.filter((block): block is BetaToolUseBlock => block.type === 'tool_use');
      if (toolUses.length === 0) {
        stoppedBy = 'no_tool_call';
        break;
      }

      // 모든 tool_use에 결과를 돌려줘야 대화가 이어지므로, 중간에 끝나도 남은 호출까지 결과를 채운다
      const results: BetaToolResultBlockParam[] = [];
      let finished = false;
      let repeated = false;
      let limitHit = false;
      for (const call of toolUses) {
        if (call.name === 'qa_expect_rejection') {
          results.push(handleExpectTool(call));
          continue;
        }
        const reportResult = handleReportTool(call);
        if (reportResult) {
          results.push(reportResult);
          if (call.name === 'qa_finish') finished = true;
          continue;
        }
        if (!ACTION_TOOLS.has(call.name)) {
          results.push({ type: 'tool_result', tool_use_id: call.id, content: `알 수 없는 도구: ${call.name}`, is_error: true });
          continue;
        }
        if (finished || repeated || limitHit) {
          results.push({ type: 'tool_result', tool_use_id: call.id, content: '실행을 마치는 중이라 이 조작은 하지 않았습니다', is_error: true });
          continue;
        }
        const input = (call.input ?? {}) as Record<string, unknown>;
        actionCount += 1;
        const { outcome, rejection } = await report.runAction(call.name, input, browser, actionCount);
        if (rejection) onEvent?.({ type: 'rejection', rejection });
        const diagnostics = await browser.currentDiagnostics();
        const total = diagnosticsCount(diagnostics);
        const artifact = await saveActionThumbnail(browser, saveArtifact, actionCount);
        const record: QaActionRecord = {
          index: actionCount,
          tool: call.name,
          input,
          ok: outcome.ok,
          ...(outcome.ok ? {} : { detail: outcome.text }),
          ...(outcome.resolvedSelector ? { resolvedSelector: outcome.resolvedSelector } : {}),
          ...(outcome.stableSelector ? { stableSelector: outcome.stableSelector } : {}),
          ...(outcome.rect ? { targetRect: outcome.rect } : {}),
          ...(artifact ? { artifact } : {}),
          newDiagnosticsCount: Math.max(0, total - previousDiagnosticsCount),
          url: browser.url,
          at: Date.now(),
        };
        previousDiagnosticsCount = total;
        actions.push(record);
        onEvent?.({ type: 'action', record });
        const content: BetaContentBlockParam[] = [{ type: 'text', text: outcome.text }];
        if (outcome.image) content.push({ type: 'image', source: { type: 'base64', media_type: outcome.image.mediaType, data: outcome.image.data.toString('base64') } });
        results.push({ type: 'tool_result', tool_use_id: call.id, content, is_error: !outcome.ok });
        if (await repeats.record(record, () => browser.screenSignature())) repeated = true;
        else if (actionCount >= maxActions) limitHit = true;
      }
      messages.push({ role: 'user', content: results });

      if (finished) {
        stoppedBy = 'finish';
        break;
      }
      if (repeated) {
        stoppedBy = 'repeated_screen';
        break;
      }
      if (limitHit) {
        stoppedBy = 'max_actions';
        break;
      }
    }

    // 한도·반복·도구 없음으로 끝났으면 도구를 보고용으로 좁혀 한 번 더 묻는다. 여기서 받은 보고는 판정에 그대로 반영된다
    if (!report.declared) {
      const reportTools = tools.filter((entry) => QA_REPORT_TOOLS.has(entry.name));
      appendUserText(messages, buildWrapUpPrompt(stoppedBy));
      for (let round = 0; round < WRAP_UP_ROUNDS && !report.declared; round += 1) {
        signal?.throwIfAborted();
        let message: Awaited<ReturnType<ModelClient['createMessage']>>;
        try {
          message = await client.createMessage({ system, tools: reportTools, messages }, signal);
        } catch (error) {
          if (signal?.aborted) throw error;
          break; // 보고를 못 받았을 뿐이다. 판정은 보고 없음으로 내린다
        }
        addMessageUsage(usage, message.usage);
        messages.push({ role: 'assistant', content: message.content });
        const text = message.content
          .flatMap((block) => (block.type === 'text' ? [block.text] : []))
          .join('\n')
          .trim();
        if (text) onEvent?.({ type: 'text', text });
        const toolUses = message.content.filter((block): block is BetaToolUseBlock => block.type === 'tool_use');
        if (toolUses.length === 0) break;
        const results: BetaToolResultBlockParam[] = toolUses.map(
          (call) => handleReportTool(call) ?? { type: 'tool_result', tool_use_id: call.id, content: '지금은 보고(qa_report_issue·qa_finish)만 받습니다', is_error: true },
        );
        messages.push({ role: 'user', content: results });
      }
    }

    return await buildExploreQaResult({ goal, browser, report, stoppedBy, actions, usage });
  } finally {
    await browser.close();
  }
}

/** 저장이 주어졌을 때만 뷰포트 스크린샷을 찍어 저장한다(실패해도 실행은 계속한다 — 관측용이라 판정에 영향을 주지 않는다) */
export async function saveActionThumbnail(
  browser: QaBrowser,
  saveArtifact: RunExploreQaOptions['saveArtifact'],
  index: number,
): Promise<string | undefined> {
  if (!saveArtifact) return undefined;
  try {
    const data = await browser.screenshot();
    return await saveArtifact({ name: `탐색 ${index}단계`, data, contentType: 'image/jpeg' });
  } catch {
    return undefined;
  }
}

/** 판정에 쓰는 모델 보고. 넘기지 않으면(옛 호출) 진단 신호와 확인 문구만 본다 */
export interface QaReview {
  findings: readonly QaFinding[];
  declared?: { success: boolean; summary: string };
  stoppedBy: ExploreQaStopReason;
  /** 선언한 조작에서 서버가 거절한 시험 수. 판정은 바꾸지 않고 사유에 건수만 남긴다 */
  expectedRejections?: number;
  /** 거절될 것으로 선언했지만 거절 응답이 없던 조작 수. 판정은 바꾸지 않고 사유에 건수만 남긴다 */
  unmetRejections?: number;
}

/**
 * 플랫폼의 최종 판정(설계안 §6.3·§6.8): 모델의 성공 선언만으로 통과시키지 않고, 모델이 본 문제도 버리지 않는다.
 * - fail: 진단 신호가 있거나, 확인 문구가 없거나, blocker·major 발견이 있거나, 모델이 목표를 못 했다고 보고함
 * - inconclusive: 위가 모두 깨끗하지만 모델의 마지막 보고(qa_finish)를 받지 못해 점검을 마쳤는지 알 수 없음
 *   (확인 문구를 적은 목표에서 그 문구가 화면에 있으면 플랫폼이 직접 확인한 것이라 보고가 없어도 마친 것으로 본다)
 * - pass: 위가 모두 깨끗함. minor 발견은 통과를 막지 않지만 사유에 건수를 남기고 결과 목록에 실린다
 */
export function judge(
  goal: Pick<ExploreQaGoal, 'confirmText'>,
  diagnostics: QaDiagnostics,
  pageText: string,
  review?: QaReview,
): { status: ExploreQaStatus; reason: string } {
  const problems: string[] = [];
  if (diagnostics.consoleErrors.length > 0) problems.push(`console.error ${diagnostics.consoleErrors.length}건`);
  if (diagnostics.pageErrors.length > 0) problems.push(`스크립트 예외 ${diagnostics.pageErrors.length}건`);
  if (diagnostics.failedRequests.length > 0) problems.push(`실패한 요청 ${diagnostics.failedRequests.length}건`);
  if (diagnostics.accessibilityViolations.length > 0) problems.push(`접근성 위반 ${diagnostics.accessibilityViolations.length}건`);
  if (diagnostics.horizontalOverflowPx > 1) problems.push(`가로로 ${diagnostics.horizontalOverflowPx}px 넘칩니다`);
  const confirmMissing = Boolean(goal.confirmText) && !pageText.includes(goal.confirmText as string);
  if (confirmMissing) problems.push(`확인 문구 '${goal.confirmText}'를 화면에서 찾지 못했습니다`);

  let minorCount = 0;
  if (review) {
    const serious = review.findings.filter((finding) => finding.severity !== 'minor');
    minorCount = review.findings.length - serious.length;
    if (serious.length > 0) {
      const blockers = serious.filter((finding) => finding.severity === 'blocker').length;
      const counts = [blockers > 0 ? `blocker ${blockers}건` : '', serious.length - blockers > 0 ? `major ${serious.length - blockers}건` : ''].filter(Boolean).join('·');
      const shown = serious.slice(0, 3).map((finding) => `[${finding.severity}] ${finding.summary}`);
      const more = serious.length > shown.length ? ` 외 ${serious.length - shown.length}건` : '';
      problems.push(`모델이 화면에서 본 문제 ${counts} — ${shown.join(' / ')}${more}`);
    }
    if (review.declared && !review.declared.success) {
      problems.push(`모델이 목표를 끝내지 못했다고 보고했습니다${review.declared.summary ? `: ${review.declared.summary}` : ''}`);
    }
  }
  const rejectionNotes = [
    review?.expectedRejections ? `예상된 거절 ${review.expectedRejections}건은 목록 참고` : '',
    review?.unmetRejections ? `거절될 것으로 선언했지만 거절 응답이 없던 조작 ${review.unmetRejections}건은 목록 참고` : '',
  ].filter(Boolean);
  if (problems.length > 0) return { status: 'fail', reason: `${problems.join(' / ')}${rejectionNotes.length > 0 ? ` (${rejectionNotes.join(', ')})` : ''}` };

  if (review && !review.declared) {
    const confirmed = Boolean(goal.confirmText) && !confirmMissing;
    if (!confirmed) {
      const minor = minorCount > 0 ? ` 보고된 minor ${minorCount}건은 목록에 있습니다.` : '';
      const rejections = rejectionNotes.length > 0 ? ` (${rejectionNotes.join(', ')})` : '';
      return { status: 'inconclusive', reason: `점검을 마치지 못했습니다 — ${STOP_REASON_TEXT[review.stoppedBy]}, 모델의 마지막 보고(qa_finish)도 받지 못했습니다.${minor}${rejections}` };
    }
  }
  const notes = [minorCount > 0 ? `minor ${minorCount}건은 목록 참고` : '', ...rejectionNotes].filter(Boolean);
  return { status: 'pass', reason: `진단 신호가 없고 확인 조건을 만족합니다${notes.length > 0 ? `(${notes.join(', ')})` : ''}` };
}

// ───────────────────────────── 기록 → pageChecks steps 변환 ─────────────────────────────

export interface ConvertedSteps {
  steps: WorkflowPageStep[];
  /** steps로 바꿀 수 없던 행동(스크린샷·관찰 도구, 안정적이지 않은 선택자로만 가리킨 행동 등) */
  skipped: Array<{ index: number; tool: string; reason: string }>;
}

/**
 * 탐색 행동 기록을 기존 pageChecks steps(click/fill/press/waitFor) 형식으로 바꾼다(설계안 §6.5).
 * ref는 안정적 선택자(role+name/data-testid/고유 텍스트)가 있을 때만 바꾸고, CSS 구조 선택자로만 남은 행동은
 * "못 바꾸는 행동"으로 표시해 건너뛴다 — 구조 선택자는 리팩터로 쉽게 깨져 재현성이 없다고 보기 때문이다.
 * 관찰 도구(qa_snapshot/qa_find/qa_screenshot/qa_hover)는 애초에 화면을 바꾸지 않으므로 변환 대상이 아니다.
 */
export function toPageCheckSteps(actions: readonly QaActionRecord[]): ConvertedSteps {
  const steps: WorkflowPageStep[] = [];
  const skipped: ConvertedSteps['skipped'] = [];
  for (const action of actions) {
    if (!action.ok) {
      skipped.push({ index: action.index, tool: action.tool, reason: '실패한 행동이라 저장하지 않습니다' });
      continue;
    }
    switch (action.tool) {
      case 'qa_click':
        if (action.stableSelector) steps.push({ click: action.stableSelector });
        else skipped.push({ index: action.index, tool: action.tool, reason: '안정적인 선택자(role+name·data-testid·고유 텍스트)가 없어 저장하지 않습니다' });
        break;
      case 'qa_fill':
      case 'qa_type':
        if (action.stableSelector) steps.push({ fill: { selector: action.stableSelector, text: String(action.input.text ?? '') } });
        else skipped.push({ index: action.index, tool: action.tool, reason: '안정적인 선택자(role+name·data-testid·고유 텍스트)가 없어 저장하지 않습니다' });
        break;
      case 'qa_press':
        steps.push({ press: String(action.input.key ?? '') });
        break;
      case 'qa_wait': {
        const forText = typeof action.input.forText === 'string' ? action.input.forText : undefined;
        if (forText) steps.push({ waitFor: `text=${forText}` });
        else skipped.push({ index: action.index, tool: action.tool, reason: '시간만 기다린 행동은 저장하지 않습니다(화면 신호가 아니라서 재현성이 없습니다)' });
        break;
      }
      default:
        skipped.push({ index: action.index, tool: action.tool, reason: '이 행동은 click/fill/press/waitFor로 표현할 수 없어 저장하지 않습니다' });
    }
  }
  return { steps, skipped };
}
