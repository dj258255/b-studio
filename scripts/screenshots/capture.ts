/**
 * 문서용 화면 캡처 스크립트. 이미 떠 있는 studio 서버(기본 http://127.0.0.1:3000)에 Playwright로 접속해
 * 읽기 전용 화면만 골라 찍고, 캡처한 원본을 macOS 창 틀로 다시 찍어 docs/images에 내보낸다.
 *
 * 세션은 CI·pnpm test에 쓰지 않는다. b-studio를 실제로 띄워 둔 상태에서만 수동으로 돌린다:
 *   SESSION_ID=<세션 id> pnpm docs:screenshots
 *
 * 상태를 바꾸는 조작(대화 전송, 승인/거절, 발행, 체크포인트 되돌리기 등)은 절대 하지 않는다. 탭 전환·스크롤·
 * 테마 전환(emulateMedia)처럼 읽기만 하는 조작만 한다.
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
const MAX_BYTES = 360_000;

type ColorScheme = "light" | "dark";

interface ShotSpec {
  /** 최종 파일 이름(확장자 없이) */
  name: string;
  path: string;
  viewport: { width: number; height: number };
  colorScheme: ColorScheme;
  /** 액자 창의 표시 너비(CSS px) */
  frameWidth: number;
  setup: (page: Page) => Promise<void>;
  /** 표준 단일 스크린샷으로 담기 어려운 화면(예: 토큰 탭)은 직접 원본 PNG를 만들어 반환한다 */
  custom?: (browser: Browser) => Promise<string>;
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
 * "토큰" 탭은 이 세션에서 "반복 작업" 구역이 길어 턴별 컨텍스트 그래프·문맥 급증 카드가 평범한 뷰포트에서는
 * flex 레이아웃이 짜부라진 32px짜리 스크롤 박스 안에 거의 안 보이게 숨는다(실제 화면도 그렇게 뜬다 — 버그를
 * 만든 게 아니라 이 화면의 실제 레이아웃이다). 그래서 위쪽 창 틀(헤더·탭 줄)과, 안쪽 스크롤 박스를 그래프가
 * 보이도록 충분히 큰 뷰포트에서 따로 찍어 세로로 이어 붙인다.
 */
async function captureTokensRaw(browser: Browser): Promise<string> {
  const chromePath = path.join(rawDir, "studio-tokens.chrome.png");
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "light" });
    const page = await context.newPage();
    await page.goto(`${BASE_URL}/sessions/${SESSION_ID}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(900);
    await clickTab(page, "미리보기 대상", "토큰");
    await waitLoaded(page);
    await page.waitForTimeout(500);
    await page.screenshot({ path: chromePath, clip: { x: 0, y: 0, width: 1440, height: 196 } });
    await context.close();
  }

  const contentPath = path.join(rawDir, "studio-tokens.content.png");
  {
    const context = await browser.newContext({ viewport: { width: 1440, height: 2000 }, deviceScaleFactor: 2, colorScheme: "light" });
    const page = await context.newPage();
    await page.goto(`${BASE_URL}/sessions/${SESSION_ID}`, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await page.waitForTimeout(900);
    await clickTab(page, "미리보기 대상", "토큰");
    await waitLoaded(page);
    const heading = page.getByRole("heading", { name: "턴별 컨텍스트" });
    await heading.waitFor({ state: "visible", timeout: 10_000 });
    const box = await heading.evaluate((el) => {
      let node = el.parentElement;
      let container: Element | null = null;
      while (node) {
        const style = getComputedStyle(node);
        if (node.scrollHeight > node.clientHeight + 2 && (style.overflowY === "auto" || style.overflowY === "scroll")) {
          container = node;
          break;
        }
        node = node.parentElement;
      }
      if (!container) return null;
      const elRect = el.getBoundingClientRect();
      const containerRect = container.getBoundingClientRect();
      (container as HTMLElement).scrollTop = elRect.top - containerRect.top + (container as HTMLElement).scrollTop - 16;
      const settled = container.getBoundingClientRect();
      return { top: settled.top, left: settled.left, width: settled.width, height: settled.height };
    });
    if (!box) throw new Error("토큰 탭의 턴별 컨텍스트 스크롤 영역을 찾지 못했습니다");
    await page.waitForTimeout(300);
    await page.screenshot({ path: contentPath, clip: { x: box.left, y: box.top, width: box.width, height: Math.min(box.height, 860) } });
    await context.close();
  }

  const gap = 16;
  const stitchWidth = 1440;
  const chromeSize = await pngSize(chromePath);
  const contentSize = await pngSize(contentPath);
  const chromeHeight = Math.round((chromeSize.height / chromeSize.width) * stitchWidth);
  const contentDisplayWidth = 972;
  const contentHeight = Math.round((contentSize.height / contentSize.width) * contentDisplayWidth);
  const stitchHeight = chromeHeight + gap + contentHeight;

  const stitchHtml = `<!doctype html><html><head><meta charset="utf-8" /><style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { width: ${stitchWidth}px; height: ${stitchHeight}px; background: #fbfdfc; }
    img { display: block; }
    .chrome { width: ${stitchWidth}px; }
    .content { width: ${contentDisplayWidth}px; margin: ${gap}px 0 0 12px; border: 1px solid rgba(16,42,43,0.1); border-radius: 8px; overflow: hidden; }
  </style></head><body>
    <img class="chrome" src="file://${chromePath}" />
    <img class="content" src="file://${contentPath}" />
  </body></html>`;
  const stitchPagePath = path.join(rawDir, "studio-tokens.stitch.html");
  writeFileSync(stitchPagePath, stitchHtml);

  const stitchedPath = path.join(rawDir, "studio-tokens.png");
  const context = await browser.newContext({ viewport: { width: stitchWidth, height: stitchHeight }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  await page.goto(`file://${stitchPagePath}`);
  await page.waitForTimeout(150);
  await page.screenshot({ path: stitchedPath });
  await context.close();
  return stitchedPath;
}

const SHOTS: ShotSpec[] = [
  {
    name: "studio-hero-light",
    path: `/sessions/${SESSION_ID}`,
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
    frameWidth: 1180,
    setup: async (page) => {
      await clickTab(page, "미리보기 대상", "화면 (frontend)");
      await waitLoaded(page);
      await page.waitForTimeout(2500);
    },
  },
  {
    name: "studio-hero-dark",
    path: `/sessions/${SESSION_ID}`,
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
    frameWidth: 1180,
    setup: async (page) => {
      await clickTab(page, "미리보기 대상", "화면 (frontend)");
      await waitLoaded(page);
      await page.waitForTimeout(2500);
    },
  },
  {
    name: "studio-requirements",
    path: `/sessions/${SESSION_ID}`,
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
    frameWidth: 1080,
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
    frameWidth: 1080,
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
    frameWidth: 1080,
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
    frameWidth: 1080,
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
    viewport: { width: 1440, height: 900 },
    colorScheme: "light",
    frameWidth: 1080,
    setup: async () => {
      // 이 shot은 custom(captureTokensRaw)이 전부 처리한다 — 표준 단일 스크린샷으로는 안 닿는다(위 주석 참고)
    },
    custom: captureTokensRaw,
  },
  {
    name: "studio-task-plan",
    path: `/task-plans?id=${PLAN_ID}`,
    viewport: { width: 1440, height: 1100 },
    colorScheme: "light",
    frameWidth: 1180,
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
    frameWidth: 660,
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
  // 처리기가 안 붙어 있어 클릭이 씹힌다. 하이드레이션이 끝날 시간을 준 뒤에 setup()에서 조작한다
  await page.waitForTimeout(900);
  await spec.setup(page);
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

  const context = await browser.newContext({ viewport: { width: pageWidth, height: pageHeight }, deviceScaleFactor: 1 });
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
  const qualities = [85, 78, 70, 62];
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
      const rawPath = spec.custom ? await spec.custom(browser) : await captureRaw(browser, spec);
      const framedPngPath = await frameShot(browser, spec, rawPath);
      const outPath = path.join(outDir, `${spec.name}.jpg`);
      compressToJpeg(framedPngPath, outPath);
      const { size } = statSync(outPath);
      console.log(`완료 (${Math.round(size / 1024)}KB) -> ${path.relative(repoRoot, outPath)}`);
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
