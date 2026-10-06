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
/** 스크린샷은 토큰 비용이 크므로(연구 노트 §2.6, §6.7) JPEG로 압축해 보낸다 */
const SCREENSHOT_JPEG_QUALITY = 60;

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
      const recordFailure = (requestUrl: string, reason: string) => {
        if (new URL(requestUrl).pathname === '/favicon.ico' || seenFailures.has(requestUrl) || blockedUrls.has(requestUrl)) return;
        seenFailures.add(requestUrl);
        instance.#diagnostics.failedRequests.push(`${reason} ${requestUrl}`);
      };
      page.on('response', (response) => {
        if (response.status() >= 400) recordFailure(response.url(), String(response.status()));
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

  async scroll(options: { ref?: string; direction?: 'up' | 'down'; amount?: number }): Promise<void> {
    if (options.ref !== undefined) {
      const resolved = this.#resolve(options.ref);
      await this.#page.locator(resolved.selector).scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
      return;
    }
    const amount = options.amount ?? SCROLL_PAGE_PX;
    const delta = options.direction === 'up' ? -amount : amount;
    await this.#page.mouse.wheel(0, delta);
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

  /** 탈출 판정(같은 화면 반복)에 쓰는 값싼 서명. 모델에게 보내지 않아 토큰 비용이 없다 */
  async screenSignature(): Promise<string> {
    return this.#page.evaluate<string>(
      `(() => { const t = document.body ? document.body.innerText : ''; return location.href + '|' + document.title + '|' + document.querySelectorAll('*').length + '|' + t.length; })()`,
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
      '뷰포트 스크린샷을 찍습니다. 접근성 트리로 판단하기 어려운 시각적 확인(레이아웃·색상·이미지)이 필요할 때만 쓰세요 — 매 행동마다 찍지 마세요(토큰 비용이 큽니다).',
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
      'ref를 주면 그 요소가 보이게 스크롤하고, direction만 주면 화면을 위/아래로 스크롤합니다.',
      {
        ref: { type: 'string', description: '화면에 보이게 할 요소의 ref' },
        direction: { type: 'string', enum: ['up', 'down'], description: 'ref 없이 화면을 스크롤할 방향' },
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
      'qa_finish',
      '목표를 끝냈다고 판단하면(성공이든 실패든) 이 도구로 실행을 마칩니다. success와 summary를 함께 주세요. ' +
        '이 선언만으로 통과가 결정되지 않습니다 — 플랫폼이 진단 신호와 확인 문구를 따로 확인합니다.',
      { success: { type: 'boolean', description: '목표를 실제로 달성했다고 보는지' }, summary: { type: 'string', description: '무엇을 했고 어떤 결과를 봤는지 한두 문장' } },
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
        const ref = optionalString(input, 'ref');
        const x = optionalNumber(input, 'x');
        const y = optionalNumber(input, 'y');
        const { stableSelector, rect } = await browser.click({ ...(ref !== undefined ? { ref } : {}), ...(x !== undefined ? { x } : {}), ...(y !== undefined ? { y } : {}) });
        return { ok: true, text: ref ? `${ref}를 클릭했습니다` : `(${x}, ${y})를 클릭했습니다`, ...(stableSelector ? { stableSelector } : {}), ...(rect ? { rect } : {}) };
      }
      case 'qa_fill': {
        const ref = requireString(input, 'ref');
        const { stableSelector, rect } = await browser.fill(ref, requireString(input, 'text'));
        return { ok: true, text: `${ref}에 값을 채웠습니다`, ...(stableSelector ? { stableSelector } : {}), rect };
      }
      case 'qa_type': {
        const ref = requireString(input, 'ref');
        const { stableSelector, rect } = await browser.type(ref, requireString(input, 'text'));
        return { ok: true, text: `${ref}에 입력했습니다`, ...(stableSelector ? { stableSelector } : {}), rect };
      }
      case 'qa_press': {
        const key = requireString(input, 'key');
        await browser.press(key);
        return { ok: true, text: `${key}를 눌렀습니다` };
      }
      case 'qa_hover': {
        const ref = requireString(input, 'ref');
        const { rect } = await browser.hover(ref);
        return { ok: true, text: `${ref} 위에 마우스를 올렸습니다`, rect };
      }
      case 'qa_scroll': {
        const ref = optionalString(input, 'ref');
        const direction = optionalString(input, 'direction') as 'up' | 'down' | undefined;
        const amount = optionalNumber(input, 'amount');
        await browser.scroll({ ...(ref !== undefined ? { ref } : {}), ...(direction !== undefined ? { direction } : {}), ...(amount !== undefined ? { amount } : {}) });
        return { ok: true, text: ref ? `${ref}가 보이게 스크롤했습니다` : `${direction ?? 'down'} 방향으로 스크롤했습니다` };
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

export interface ExploreQaResult {
  /** 플랫폼이 내린 최종 판정. 모델의 qa_finish 선언을 그대로 따르지 않는다(설계안 §6.3·§6.8) */
  status: 'pass' | 'fail';
  reason: string;
  modelDeclared?: { success: boolean; summary: string };
  stoppedBy: ExploreQaStopReason;
  diagnostics: QaDiagnostics;
  actions: QaActionRecord[];
  usage: AgentUsage;
}

export type ExploreQaEvent = { type: 'action'; record: QaActionRecord } | { type: 'text'; text: string } | { type: 'frame'; frame: BrowserFrame };

export interface RunExploreQaOptions {
  client: ModelClient;
  goal: ExploreQaGoal;
  /** 시작 경로를 연 절대 URL */
  startUrl: string;
  allowedOrigins: readonly string[];
  viewport?: QaViewport;
  onFrame?: (frame: BrowserFrame) => void;
  onEvent?: (event: ExploreQaEvent) => void;
  signal?: AbortSignal;
}

function emptyUsage(): AgentUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

export function buildQaSystemPrompt(): string {
  return [
    '당신은 웹 애플리케이션의 UI/UX를 사람처럼 눈으로 보고 손으로 조작하며 시험하는 QA 에이전트입니다.',
    '주어진 목표를 화면에서 직접 수행하세요. qa_snapshot으로 화면의 인터랙티브 요소를 관찰하고, 필요한 ref를 골라 행동하세요.',
    '스크린샷(qa_screenshot)은 접근성 트리로 판단할 수 없는 시각적 확인이 필요할 때만 쓰세요(비용이 큽니다).',
    '목표를 실제로 달성했는지, 아니면 더 진행할 수 없는지 판단되면 qa_finish를 부르세요. 성공을 선언해도 플랫폼이 따로 확인하니 솔직하게 판단하세요.',
    '같은 화면에서 같은 행동을 반복하지 말고, 막히면 다른 요소를 시도하거나 qa_finish(success: false)로 실패를 알리세요.',
  ].join('\n');
}

export function buildQaUserPrompt(goal: ExploreQaGoal): string {
  const lines = [`목표: ${goal.goal}`, `시작 화면: ${goal.startPath}`];
  if (goal.confirmText) lines.push(`끝났을 때 화면에 '${goal.confirmText}' 문구가 있어야 합니다.`);
  return lines.join('\n');
}

/**
 * api 백엔드(직접 만든 루프)의 모델 호출 방식 그대로 탐색형 QA를 돈다.
 * ModelClient를 그대로 재사용하므로(loop.ts와 같은 인터페이스), model-registry.ts의 clientForModel이 돌려주는
 * 클라이언트나 테스트용 ScriptedModelClient를 그대로 꽂을 수 있다.
 */
export async function runExploreQa(options: RunExploreQaOptions): Promise<ExploreQaResult> {
  const { client, goal, startUrl, allowedOrigins, viewport, onFrame, onEvent, signal } = options;
  const maxActions = goal.maxActions ?? DEFAULT_MAX_ACTIONS;
  const maxMs = goal.maxMs ?? DEFAULT_MAX_MS;
  const repeatLimit = goal.repeatLimit ?? DEFAULT_REPEAT_LIMIT;
  const deadline = Date.now() + maxMs;

  const browser = await QaBrowser.open(startUrl, { allowedOrigins, ...(viewport ? { viewport } : {}), ...(onFrame ? { onFrame } : {}) });
  try {
    const tools = buildQaTools();
    const system = buildQaSystemPrompt();
    const messages: BetaMessageParam[] = [{ role: 'user', content: buildQaUserPrompt(goal) }];
    const usage = emptyUsage();
    const actions: QaActionRecord[] = [];
    const signatures: string[] = [];
    let modelDeclared: { success: boolean; summary: string } | undefined;
    let stoppedBy: ExploreQaStopReason = 'max_actions';
    let actionCount = 0;
    let previousDiagnosticsCount = 0;

    runLoop: for (;;) {
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

      const results: BetaToolResultBlockParam[] = [];
      for (const call of toolUses) {
        const input = (call.input ?? {}) as Record<string, unknown>;
        if (call.name === 'qa_finish') {
          modelDeclared = { success: Boolean(input.success), summary: typeof input.summary === 'string' ? input.summary : '' };
          results.push({ type: 'tool_result', tool_use_id: call.id, content: 'qa_finish를 받았습니다. 실행을 마칩니다.' });
          stoppedBy = 'finish';
          messages.push({ role: 'user', content: results });
          break runLoop;
        }
        if (!ACTION_TOOLS.has(call.name)) {
          results.push({ type: 'tool_result', tool_use_id: call.id, content: `알 수 없는 도구: ${call.name}`, is_error: true });
          continue;
        }
        actionCount += 1;
        const outcome = await executeQaTool(call.name, input, browser);
        const diagnostics = await browser.currentDiagnostics();
        const total = diagnosticsCount(diagnostics);
        const record: QaActionRecord = {
          index: actionCount,
          tool: call.name,
          input,
          ok: outcome.ok,
          ...(outcome.ok ? {} : { detail: outcome.text }),
          ...(outcome.resolvedSelector ? { resolvedSelector: outcome.resolvedSelector } : {}),
          ...(outcome.stableSelector ? { stableSelector: outcome.stableSelector } : {}),
          ...(outcome.rect ? { targetRect: outcome.rect } : {}),
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
        if (actionCount >= maxActions) {
          stoppedBy = 'max_actions';
          messages.push({ role: 'user', content: results });
          break runLoop;
        }
      }
      messages.push({ role: 'user', content: results });

      const signature = await browser.screenSignature();
      signatures.push(signature);
      if (signatures.length >= repeatLimit && signatures.slice(-repeatLimit).every((value) => value === signature)) {
        stoppedBy = 'repeated_screen';
        break;
      }
    }

    const diagnostics = await browser.currentDiagnostics();
    const pageText = await browser.pageText();
    const judged = judge(goal, diagnostics, pageText);
    return { status: judged.status, reason: judged.reason, ...(modelDeclared ? { modelDeclared } : {}), stoppedBy, diagnostics, actions, usage };
  } finally {
    await browser.close();
  }
}

/**
 * 플랫폼의 최종 판정(설계안 §6.3·§6.8): 목표 완료 선언만으로 통과시키지 않는다.
 * 진단 신호가 하나도 없고(있으면 실패), confirmText를 적었다면 그 문구가 화면에 있어야 통과다.
 */
export function judge(goal: Pick<ExploreQaGoal, 'confirmText'>, diagnostics: QaDiagnostics, pageText: string): { status: 'pass' | 'fail'; reason: string } {
  const problems: string[] = [];
  if (diagnostics.consoleErrors.length > 0) problems.push(`console.error ${diagnostics.consoleErrors.length}건`);
  if (diagnostics.pageErrors.length > 0) problems.push(`스크립트 예외 ${diagnostics.pageErrors.length}건`);
  if (diagnostics.failedRequests.length > 0) problems.push(`실패한 요청 ${diagnostics.failedRequests.length}건`);
  if (diagnostics.accessibilityViolations.length > 0) problems.push(`접근성 위반 ${diagnostics.accessibilityViolations.length}건`);
  if (diagnostics.horizontalOverflowPx > 1) problems.push(`가로로 ${diagnostics.horizontalOverflowPx}px 넘칩니다`);
  if (goal.confirmText && !pageText.includes(goal.confirmText)) problems.push(`확인 문구 '${goal.confirmText}'를 화면에서 찾지 못했습니다`);
  if (problems.length > 0) return { status: 'fail', reason: problems.join(' / ') };
  return { status: 'pass', reason: '진단 신호가 없고 확인 조건을 만족합니다' };
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
