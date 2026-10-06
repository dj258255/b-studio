/**
 * 문서용 화면 캡처 스크립트. 이미 떠 있는 studio 서버(기본 http://127.0.0.1:3000)에 Playwright로 접속해
 * 읽기 전용 화면만 골라 찍고, 캡처한 원본을 macOS 창 틀로 다시 찍어 docs/images에 내보낸다.
 *
 * 세션은 CI·pnpm test에 쓰지 않는다. b-studio를 실제로 띄워 둔 상태에서만 수동으로 돌린다:
 *   SESSION_ID=<세션 id> PLAN_ID=<작업 분해 id> pnpm docs:screenshots
 *
 * 상태를 바꾸는 조작(대화 전송, 승인/거절, 발행, 체크포인트 되돌리기 등)은 절대 하지 않는다. 탭 전환·스크롤·
 * 개발 배너 닫기(로컬 state만 바꾼다, DevStatusBanner 참고)·테마 전환(emulateMedia)처럼 읽기만 하는
 * 조작만 한다.
 */
import { chromium, type Browser, type Page } from "playwright-core";
import { mkdirSync, readFileSync, writeFileSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const outDir = path.join(repoRoot, "docs", "images");
const rawDir = path.join(here, ".raw");

const BASE_URL = process.env.STUDIO_BASE_URL ?? "http://127.0.0.1:3000";
const SESSION_ID = process.env.SESSION_ID ?? "c55417ad";
const PLAN_ID = process.env.PLAN_ID ?? "45539ab6";
const MAX_BYTES = 600_000;

type ColorScheme = "light" | "dark";

interface ShotSpec {
  /** 최종 파일 이름(확장자 없이) */
  name: string;
  path: string;
  viewport: { width: number; height: number };
  colorScheme: ColorScheme;
  /** 액자 창의 표시 너비(CSS px, 1배). 액자 렌더는 deviceScaleFactor 2라 최종 파일은 이 값의 2배 폭이 된다 */
  frameWidth: number;
  setup: (page: Page) => Promise<void>;
}

/** "불러오는 중" 같은 로딩 문구가 화면에서 사라질 때까지 기다린다(없으면 바로 통과) */
async function waitLoaded(page: Page, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stillLoading = await page.getByText(/불러오는 중/).count();
    if (stillLoading === 0) return;
    await page.waitForTimeout(200);
  }
}

async function clickTab(page: Page, listName: string, tabName: string): Promise<void> {
  await page.getByRole("tablist", { name: listName }).getByRole("tab", { name: tabName }).click();
}

/**
 * 개발 서버 코드가 바뀌었다는 배너(DevStatusBanner)를 닫는다. 닫기는 컴포넌트 안의 React state만
 * 바꾸고(dismissedHead) 서버에 아무것도 보내지 않는다 — 읽기 전용 조작이다. 배너가 없으면 그냥 넘어간다
 */
async function dismissDevBanner(page: Page): Promise<void> {
  const dismiss = page.getByRole("button", { name: "닫기" });
  if ((await dismiss.count()) > 0) await dismiss.first().click({ timeout: 2_000 }).catch(() => {});
}

/**
 * Next.js 개발 모드 표시(왼쪽 아래 "N" 동그라미, `<nextjs-portal>`)를 숨긴다. b-studio 페이지 자신과
 * 미리보기 iframe(앱 안의 Next.js 앱) 둘 다에 떠서, 지금 열려 있는 모든 프레임에 스타일을 심는다.
 * 페이지 상태는 전혀 안 바꾸는 순수 화면 조작이라 안전하다
 */
async function hideDevChrome(page: Page): Promise<void> {
  for (const frame of page.frames()) {
    await frame.addStyleTag({ content: "nextjs-portal, next-route-announcer { display: none !important; }" }).catch(() => {});
  }
}

/**
 * 대화 목록(`ol[aria-live="polite"]`)은 항상 맨 아래로 스크롤된 채 뜬다(ADR 없이 chat-panel.tsx 자체 동작).
 * 그런데 패널 높이가 메시지 하나보다 작을 때가 많아, 맨 위 줄이 "작업 단계 · 리뷰"처럼 중간에서 반쯤
 * 잘린 채로 찍힌다. 각 li(메시지 묶음) 경계에 맞춰 스크롤을 미세 조정해, 위쪽이 완전한 요소 하나의
 * 시작점에서 끊기게 한다(li 하나를 통째로 더 가리는 대신, 잘린 그림을 없앤다)
 */
async function snapChatToCleanTop(page: Page): Promise<void> {
  const list = page.locator('ol[aria-live="polite"]');
  if ((await list.count()) === 0) return;
  await list.first().evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    const containerTop = el.getBoundingClientRect().top;
    for (const child of Array.from(el.children)) {
      const relTop = child.getBoundingClientRect().top - containerTop;
      if (relTop > -2) {
        el.scrollTop += relTop;
        return;
      }
    }
  });
}

const SHOTS: ShotSpec[] = [
  {
    name: "studio-hero-light",
    path: `/sessions/${SESSION_ID}`,
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
    frameWidth: 1056,
    setup: async (page) => {
      await clickTab(page, "미리보기 대상", "화면 (frontend)");
      await waitLoaded(page);
      await page.waitForTimeout(1200);
      // 이 세션엔 저장된 QA 확인 프레임이 있어 "화면 확인 중 QA 보기로 자동 전환"이 앱 미리보기를
      // 곧장 QA 보기로 덮어쓴다 — 게시판 화면을 보여주려면 앱 미리보기로 다시 돌려놓는다
      await clickTab(page, "화면 하위 탭", "앱 미리보기");
      await page.waitForTimeout(2200);
    },
  },
  {
    name: "studio-hero-dark",
    path: `/sessions/${SESSION_ID}`,
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
    frameWidth: 1056,
    setup: async (page) => {
      await clickTab(page, "미리보기 대상", "화면 (frontend)");
      await waitLoaded(page);
      await page.waitForTimeout(1200);
      await clickTab(page, "화면 하위 탭", "앱 미리보기");
      await page.waitForTimeout(2200);
    },
  },
  {
    name: "studio-requirements",
    path: `/sessions/${SESSION_ID}`,
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
    frameWidth: 1056,
    setup: async (page) => {
      await clickTab(page, "미리보기 대상", "요구사항");
      await waitLoaded(page);
      await page.waitForTimeout(1200);
    },
  },
  {
    name: "studio-tests",
    path: `/sessions/${SESSION_ID}`,
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
    frameWidth: 1056,
    setup: async (page) => {
      await clickTab(page, "미리보기 대상", "요구사항");
      await waitLoaded(page);
      await clickTab(page, "요구사항 하위 탭", "테스트");
      await waitLoaded(page);
      await page.waitForTimeout(1200);
    },
  },
  {
    name: "studio-repository",
    path: `/sessions/${SESSION_ID}`,
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
    frameWidth: 1056,
    setup: async (page) => {
      await clickTab(page, "미리보기 대상", "저장소");
      await waitLoaded(page);
      // 기본 "열림" 필터는 이 프로젝트의 이슈가 전부 닫혀 있어 비어 보인다 — "전체"로 바꿔 실제 목록을 보여준다
      await page.getByRole("group", { name: "상태 필터" }).getByRole("button", { name: "전체" }).click();
      await waitLoaded(page);
      await page.waitForTimeout(1200);
    },
  },
  {
    name: "studio-checkpoints",
    path: `/sessions/${SESSION_ID}`,
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
    frameWidth: 1056,
    setup: async (page) => {
      await clickTab(page, "미리보기 대상", "코드");
      await waitLoaded(page);
      await clickTab(page, "코드 하위 탭", "변경 기록");
      await waitLoaded(page);
      await page.waitForTimeout(1200);
    },
  },
  {
    name: "studio-tokens",
    path: `/sessions/${SESSION_ID}`,
    // "반복 작업"이 기본으로 접히고(#421) 탭 전체가 한 스크롤로 바뀌어, 더 이상 이어 붙이지 않고 한 번에
    // 찍는다. 그래프·표·문맥 급증 카드가 모두 들어가도록 세로로 넉넉한 뷰포트를 쓴다
    viewport: { width: 1440, height: 1500 },
    colorScheme: "light",
    frameWidth: 1056,
    setup: async (page) => {
      await clickTab(page, "미리보기 대상", "토큰");
      await waitLoaded(page);
      await page.waitForTimeout(600);
      // 가장 최근 실행(PR #22 리뷰 수정)은 문맥 급증이 없다 — 급증 막대·원인 카드가 있는 실행(R17)을 고른다
      const runTabs = page.getByRole("tablist", { name: "실행", exact: true }).getByRole("tab");
      if ((await runTabs.count()) > 1) await runTabs.nth(1).click();
      await page.waitForTimeout(600);
    },
  },
  {
    name: "studio-task-plan",
    path: `/task-plans?id=${PLAN_ID}`,
    viewport: { width: 1440, height: 1100 },
    colorScheme: "light",
    frameWidth: 1056,
    setup: async (page) => {
      await waitLoaded(page);
      const header = page.getByText(`apr · 작업 분해 ${PLAN_ID}`);
      await header.waitFor({ state: "visible", timeout: 10_000 });
      await header.scrollIntoViewIfNeeded();
      await page.mouse.wheel(0, -40);
      await page.waitForTimeout(800);
    },
  },
  {
    name: "studio-accounts",
    path: "/accounts",
    viewport: { width: 760, height: 620 },
    colorScheme: "light",
    frameWidth: 620,
    setup: async (page) => {
      await waitLoaded(page);
      await page.waitForTimeout(800);
    },
  },
];

async function captureRaw(browser: Browser, spec: ShotSpec): Promise<string> {
  const context = await browser.newContext({
    viewport: spec.viewport,
    deviceScaleFactor: 2,
    colorScheme: spec.colorScheme,
  });
  const page = await context.newPage();
  // dev 서버는 HMR 웹소켓을 계속 열어 두므로 networkidle을 기다리지 않는다(절대 끝나지 않을 수 있다).
  // DOM이 뜨면 바로 넘어가고, 실제 데이터가 찼는지는 각 shot의 setup()이 직접 기다린다
  await page.goto(`${BASE_URL}${spec.path}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
  // 서버 렌더 HTML은 떠도 React 하이드레이션이 아직 안 끝났을 수 있다 — 지금 바로 탭을 누르면 이벤트
  // 처리기가 안 붙어 있어 클릭이 씹힌다. 하이드레이션이 끝날 시간을 준 뒤에 조작한다
  await page.waitForTimeout(900);
  await dismissDevBanner(page);
  await spec.setup(page);
  await snapChatToCleanTop(page);
  await hideDevChrome(page);
  await page.waitForTimeout(150);
  const rawPath = path.join(rawDir, `${spec.name}.png`);
  await page.screenshot({ path: rawPath });
  await context.close();
  return rawPath;
}

/** 라이트/다크에 맞는 액자 배경·테두리 색(studio의 app/globals.css 토큰과 맞춘다) */
function paletteFor(scheme: ColorScheme) {
  return scheme === "dark"
    ? {
        background: "radial-gradient(circle at 30% 20%, #163230 0%, #0a1413 60%)",
        panel: "#101c1b",
        titlebar: "#132220",
        border: "rgba(227,238,235,0.12)",
        shadow: "0 1px 2px rgba(0,0,0,0.5), 0 50px 90px -30px rgba(0,0,0,0.8)",
      }
    : {
        background: "radial-gradient(circle at 30% 20%, #eef6f3 0%, #dbe8e3 60%)",
        panel: "#fbfdfc",
        titlebar: "#eef3f1",
        border: "rgba(16,42,43,0.12)",
        shadow: "0 1px 2px rgba(16,42,43,0.08), 0 50px 90px -30px rgba(16,42,43,0.35)",
      };
}

async function pngSize(filePath: string): Promise<{ width: number; height: number }> {
  // PNG 헤더의 IHDR 청크(바이트 16~24)에서 폭·높이를 직접 읽는다(의존성 추가 없이)
  const buffer = readFileSync(filePath);
  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  return { width, height };
}

/** 액자(macOS 창 틀)를 deviceScaleFactor 2로 다시 찍어, 원본 캡처가 1배여도 최종 파일은 레티나 해상도가 되게 한다 */
async function frameShot(browser: Browser, spec: ShotSpec, rawPath: string): Promise<string> {
  const { width: rawWidth, height: rawHeight } = await pngSize(rawPath);
  const displayWidth = spec.frameWidth;
  const displayHeight = Math.round((rawHeight / rawWidth) * displayWidth);
  const titlebarHeight = 34;
  const padding = 72;
  const pageWidth = displayWidth + padding * 2;
  const pageHeight = displayHeight + titlebarHeight + padding * 2;
  const palette = paletteFor(spec.colorScheme);

  const template = readFileSync(path.join(here, "frame-template.html"), "utf8");
  const html = template
    .replaceAll("__COLOR_SCHEME__", spec.colorScheme)
    .replaceAll("__PAGE_WIDTH__", String(pageWidth))
    .replaceAll("__PAGE_HEIGHT__", String(pageHeight))
    .replaceAll("__BACKGROUND__", palette.background)
    .replaceAll("__PANEL_COLOR__", palette.panel)
    .replaceAll("__TITLEBAR_COLOR__", palette.titlebar)
    .replaceAll("__WINDOW_BORDER__", palette.border)
    .replaceAll("__WINDOW_SHADOW__", palette.shadow)
    .replaceAll("__WINDOW_WIDTH__", String(displayWidth))
    .replaceAll("__IMAGE_PATH__", `file://${rawPath}`);

  const framePagePath = path.join(rawDir, `${spec.name}.frame.html`);
  writeFileSync(framePagePath, html);

  const context = await browser.newContext({ viewport: { width: pageWidth, height: pageHeight }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  await page.goto(`file://${framePagePath}`);
  await page.waitForTimeout(150);
  const framedPngPath = path.join(rawDir, `${spec.name}.framed.png`);
  await page.screenshot({ path: framedPngPath });
  await context.close();
  return framedPngPath;
}

/** sips로 JPEG 변환, MAX_BYTES를 넘으면 품질을 낮춰 가며 다시 인코딩한다 */
function compressToJpeg(framedPngPath: string, outPath: string): void {
  const qualities = [82, 75, 68, 60];
  for (const quality of qualities) {
    execFileSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", String(quality), framedPngPath, "--out", outPath], { stdio: "pipe" });
    const { size } = statSync(outPath);
    if (size <= MAX_BYTES) return;
  }
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  mkdirSync(rawDir, { recursive: true });

  const browser = await chromium.launch();
  try {
    for (const spec of SHOTS) {
      process.stdout.write(`찍는 중: ${spec.name} ... `);
      const rawPath = await captureRaw(browser, spec);
      const framedPngPath = await frameShot(browser, spec, rawPath);
      const outPath = path.join(outDir, `${spec.name}.jpg`);
      compressToJpeg(framedPngPath, outPath);
      const { size } = statSync(outPath);
      const { width, height } = await pngSize(framedPngPath);
      console.log(`완료 (${Math.round(size / 1024)}KB, ${width}x${height}) -> ${path.relative(repoRoot, outPath)}`);
    }
  } finally {
    await browser.close();
  }

  rmSync(rawDir, { recursive: true, force: true });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
