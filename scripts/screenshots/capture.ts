/**
 * 문서용 화면 캡처 스크립트. 이미 떠 있는 studio 서버에 진짜 Chrome(Playwright의 chrome 채널)으로 접속해
 * docs/images의 화면 사진을 찍는다. 틀(창 테두리) 없이 화면을 그대로 찍고, sips로 JPEG(600KB 이하)로 바꾼다.
 *
 * CI·pnpm test에 쓰지 않는다. 사진용 스튜디오를 띄우고 세션을 만들어 둔 뒤 수동으로 돌린다:
 *   STUDIO_BASE_URL=http://localhost:3105 SESSION_CLAUDE=<id> SESSION_CODEX=<id> SESSION_FAIL=<id> \
 *   SESSION_REVIEW=<id> PLAN_ID=<작업 카드 계획 id> ONLY=studio-hero-light pnpm docs:screenshots
 *
 * - 사진용 스튜디오는 모델을 부르지 않게 띄운다(임시 HOME, 가짜 CLI를 B_STUDIO_CLAUDE_BIN·B_STUDIO_CODEX_BIN으로).
 *   3000번 포트의 개발 서버나 실제 계정의 스튜디오를 쓰지 않는다. 사진 속 경로와 이름이 그대로 공개된다.
 * - 쿠키는 그 스튜디오의 로컬 토큰이다. STUDIO_TOKEN이 없으면 STUDIO_HOME(기본 HOME)의
 *   ~/.cache/b-studio/launch/local-token을 읽는다.
 * - 화면 속 홈 폴더 경로(STUDIO_HOME, HOME)는 찍기 전에 ~로 가린다.
 * - 세션 id가 필요한 사진은 그 값이 없으면 건너뛴다.
 * - 수동 촬영: 터미널 작업대 사진(studio-desk.jpg)은 브라우저 화면이 아니라서 이 스크립트가 찍지 않는다.
 *   진짜 터미널에서 `pnpm studio desk`를 띄워 찍는다. ADR·실험 문서의 사진은 그때의 기록이라 다시 찍지 않는다.
 *
 * 상태를 바꾸는 조작(요청 보내기, 승인, 되돌리기 등)은 하지 않는다. 입력칸에 글을 쓰고(보내지 않음) 펼치기·탭
 * 전환처럼 화면만 바꾸는 조작만 한다.
 */
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");
const outDir = path.join(repoRoot, "docs", "images");
const rawDir = path.join(here, ".raw");

const BASE_URL = process.env.STUDIO_BASE_URL ?? "http://localhost:3105";
const STUDIO_HOME = process.env.STUDIO_HOME ?? os.homedir();
const SESSIONS = {
  claude: process.env.SESSION_CLAUDE,
  codex: process.env.SESSION_CODEX,
  fail: process.env.SESSION_FAIL,
  review: process.env.SESSION_REVIEW,
};
const PLAN_ID = process.env.PLAN_ID;
/** 쉼표로 고른 사진만 찍는다(예: ONLY=studio-hero-light,studio-requirements). 비우면 전부 */
const ONLY = (process.env.ONLY ?? "").split(",").map((name) => name.trim()).filter(Boolean);
const MAX_BYTES = 600_000;

type Clip = { x: number; y: number; width: number; height: number };

interface ShotSpec {
  /** 최종 파일 이름(확장자 없이) */
  name: string;
  /** 필요한 값이 없으면 undefined를 돌려 건너뛴다 */
  path: () => string | undefined;
  viewport?: { width: number; height: number };
  colorScheme?: "light" | "dark";
  /** 화면을 준비하고, 일부만 찍을 때는 자를 자리를 돌려준다 */
  setup?: (page: Page) => Promise<Clip | void>;
}

function localToken(): string {
  if (process.env.STUDIO_TOKEN) return process.env.STUDIO_TOKEN;
  return readFileSync(path.join(STUDIO_HOME, ".cache", "b-studio", "launch", "local-token"), "utf8").trim();
}

async function clickText(page: Page, text: string): Promise<void> {
  await page.getByText(text, { exact: true }).first().click({ timeout: 5_000 });
  await page.waitForTimeout(1200);
}

/** 대상의 자리에 여백을 더한 자르기 상자 */
async function boxOf(locator: Locator, pad = 12): Promise<Clip> {
  const rect = await locator.boundingBox();
  if (!rect) throw new Error("찍을 자리를 찾지 못했습니다");
  return { x: Math.max(0, rect.x - pad), y: Math.max(0, rect.y - pad), width: rect.width + pad * 2, height: rect.height + pad * 2 };
}

const newRequest = (page: Page) => page.getByPlaceholder(/무엇을 만들거나 고칠지/);

function hero(name: string, colorScheme: "light" | "dark"): ShotSpec {
  return {
    name,
    path: () => "/work",
    viewport: { width: 1440, height: 945 },
    colorScheme,
    setup: async (page) => {
      await newRequest(page).fill("주문 목록의 글자 색을 바꿔 줘");
      await page.waitForTimeout(2500);
    },
  };
}

const SHOTS: ShotSpec[] = [
  // README 첫 화면: 작업 화면(새 요청 미리보기와 같은 종류 기록, 개입 필요 목록)
  hero("studio-hero-light", "light"),
  hero("studio-hero-dark", "dark"),
  {
    name: "studio-work-rules",
    path: () => "/work",
    viewport: { width: 1440, height: 1000 },
    setup: async (page) => {
      await newRequest(page).fill("결제 화면의 환불 버튼 문구를 고쳐 줘");
      await page.waitForTimeout(2000);
      await page.getByText(/^규칙 고치기/).first().click({ timeout: 5_000 });
      await page.waitForTimeout(1200);
      return boxOf(page.locator('section[aria-labelledby="routing-launcher-title"]').first());
    },
  },
  {
    // 메인 CLI와 서브에이전트의 토큰, 할 수 있는 범위. SESSION_CLAUDE 세션의 마지막 요청 글로 줄을 찾는다
    name: "studio-agent-breakdown",
    path: () => (SESSIONS.claude ? "/work" : undefined),
    viewport: { width: 1000, height: 1400 },
    setup: async (page) => {
      await page.getByText(/^전체\(\d+\)$/).first().click({ timeout: 5_000 });
      await page.waitForTimeout(1200);
      // 줄 안의 세션 링크로 그 세션의 줄을 찾는다
      const card = page.locator("li.glass").filter({ has: page.locator(`a[href*="/sessions/${SESSIONS.claude}"]`) }).first();
      await card.getByText("에이전트·범위").first().click();
      await page.waitForTimeout(1200);
      return boxOf(card);
    },
  },
  {
    name: "studio-requirements",
    path: () => (SESSIONS.claude ? `/sessions/${SESSIONS.claude}` : undefined),
    viewport: { width: 1440, height: 1000 },
    setup: async (page) => {
      await clickText(page, "요구사항");
      return { x: 728, y: 84, width: 700, height: 900 };
    },
  },
  {
    name: "studio-reverify",
    path: () => (SESSIONS.codex ? `/sessions/${SESSIONS.codex}` : undefined),
    setup: async (page) => {
      await clickText(page, "코드");
      await clickText(page, "변경 기록");
      return { x: 728, y: 132, width: 700, height: 500 };
    },
  },
  // 세션 화면 전체(터미널과 오른쪽 탭)
  { name: "studio-session-terminal", path: () => (SESSIONS.claude ? `/sessions/${SESSIONS.claude}` : undefined) },
  {
    name: "studio-tabs-default",
    path: () => (SESSIONS.claude ? `/sessions/${SESSIONS.claude}` : undefined),
    setup: async () => ({ x: 720, y: 0, width: 720, height: 420 }),
  },
  {
    name: "studio-session-usage",
    path: () => (SESSIONS.claude ? `/sessions/${SESSIONS.claude}` : undefined),
    setup: async () => ({ x: 0, y: 816, width: 720, height: 80 }),
  },
  {
    name: "studio-split-grid",
    path: () => {
      const ids = [SESSIONS.claude, SESSIONS.codex, SESSIONS.fail, SESSIONS.review];
      return ids.every(Boolean) ? `/split?ids=${ids.join(",")}` : undefined;
    },
    viewport: { width: 1440, height: 960 },
    setup: async (page) => {
      await page.waitForTimeout(2500);
    },
  },
  {
    // 작업 카드 계획을 돌리는 중에 찍는다(끝난 카드와 도는 카드가 함께 보이게)
    name: "studio-split-cards",
    path: () => (PLAN_ID ? `/split?plan=${PLAN_ID}` : undefined),
    viewport: { width: 1440, height: 960 },
    setup: async (page) => {
      await page.waitForTimeout(3000);
    },
  },
  { name: "studio-accounts", path: () => "/accounts", viewport: { width: 900, height: 760 } },
];

/** 화면 속 홈 폴더 경로를 ~로 가린다 */
async function redactHome(page: Page): Promise<void> {
  const homes = [...new Set([STUDIO_HOME, os.homedir()])];
  await page.evaluate((prefixes) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      let text = node.nodeValue ?? "";
      for (const prefix of prefixes) text = text.split(prefix).join("~");
      if (text !== node.nodeValue) node.nodeValue = text;
    }
  }, homes);
}

async function captureRaw(browser: Browser, spec: ShotSpec, route: string, token: string): Promise<string> {
  const context = await browser.newContext({
    viewport: spec.viewport ?? { width: 1440, height: 900 },
    deviceScaleFactor: 2,
    colorScheme: spec.colorScheme ?? "light",
    locale: "ko-KR",
    timezoneId: "Asia/Seoul",
  });
  await context.addCookies([{ name: "b_studio_local", value: token, url: BASE_URL }]);
  const page = await context.newPage();
  // dev 서버는 HMR 웹소켓을 열어 두어 networkidle이 늦게 오거나 안 올 수 있다. 시간이 넘어도 이어 간다
  await page.goto(`${BASE_URL}${route}`, { waitUntil: "networkidle", timeout: 30_000 }).catch(() => {});
  await page.addStyleTag({ content: "nextjs-portal, next-route-announcer { display: none !important; }" });
  await page.waitForTimeout(2000);
  const clip = (await spec.setup?.(page)) ?? undefined;
  await redactHome(page);
  await page.waitForTimeout(300);
  const rawPath = path.join(rawDir, `${spec.name}.png`);
  await page.screenshot({ path: rawPath, ...(clip ? { clip } : {}) });
  await context.close();
  return rawPath;
}

/** sips로 JPEG 변환, MAX_BYTES를 넘으면 품질을 낮춰 가며 다시 인코딩한다 */
function compressToJpeg(pngPath: string, outPath: string): void {
  for (const quality of [80, 70, 60, 50]) {
    execFileSync("sips", ["-s", "format", "jpeg", "-s", "formatOptions", String(quality), pngPath, "--out", outPath], { stdio: "pipe" });
    if (statSync(outPath).size <= MAX_BYTES) return;
  }
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  mkdirSync(rawDir, { recursive: true });
  const token = localToken();
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    for (const spec of SHOTS.filter((shot) => ONLY.length === 0 || ONLY.includes(shot.name))) {
      const route = spec.path();
      if (!route) {
        console.log(`건너뜀: ${spec.name} (세션·계획 id가 없습니다)`);
        continue;
      }
      process.stdout.write(`찍는 중: ${spec.name} ... `);
      try {
        const rawPath = await captureRaw(browser, spec, route, token);
        const outPath = path.join(outDir, `${spec.name}.jpg`);
        compressToJpeg(rawPath, outPath);
        console.log(`완료 (${Math.round(statSync(outPath).size / 1024)}KB) -> ${path.relative(repoRoot, outPath)}`);
      } catch (error) {
        console.log(`실패: ${(error as Error).message.split("\n")[0]}`);
        process.exitCode = 1;
      }
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
