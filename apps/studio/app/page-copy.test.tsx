import { readFile } from "node:fs/promises";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import ErrorPage from "./error";
import NotFound from "./not-found";
import SessionNotFound from "./sessions/[id]/not-found";

/**
 * 사람이 보는 페이지 문구(이슈 #720). 없는 주소는 Next 기본 영어 404 대신 한국어 안내와 돌아갈 링크를 보이고,
 * 탭 제목은 화면마다 다르며, 뒤로 가는 링크는 같은 말을 쓴다.
 */
describe("없는 페이지·오류 화면", () => {
  it("없는 주소는 한국어로 알리고 개발 화면·작업 목록으로 돌아갈 링크를 둔다", () => {
    const html = renderToStaticMarkup(<NotFound />);

    expect(html).toContain("페이지를 찾지 못했습니다");
    expect(html).toContain('href="/"');
    expect(html).toContain("개발 화면으로");
    expect(html).toContain('href="/work"');
    expect(html).toContain("작업 목록");
    expect(html).not.toMatch(/could not be found/i);
    expect(html).toContain("<title>페이지를 찾지 못했습니다 · b-studio</title>");
  });

  it("없는 세션은 세션이 없다고 알리고 같은 링크를 둔다", () => {
    const html = renderToStaticMarkup(<SessionNotFound />);

    expect(html).toContain("세션을 찾지 못했습니다");
    expect(html).toContain('href="/"');
    expect(html).toContain('href="/work"');
  });

  it("화면을 그리다 오류가 나면 한국어로 알리고 다시 시도와 돌아갈 링크를 둔다", () => {
    const html = renderToStaticMarkup(<ErrorPage error={Object.assign(new Error("boom"), { digest: "abc123" })} retry={() => undefined} />);

    expect(html).toContain("화면을 그리지 못했습니다");
    expect(html).toContain("다시 시도");
    expect(html).toContain('href="/"');
    // 오류 원문(스택·영어 메시지)은 화면에 내지 않고, 서버 로그와 맞춰 볼 번호만 남긴다
    expect(html).not.toContain("boom");
    expect(html).toContain("abc123");
  });
});

const PAGES_WITH_TITLE = [
  "app/page.tsx",
  "app/sessions/[id]/page.tsx",
  "app/accounts/page.tsx",
  "app/work/page.tsx",
  "app/projects/[id]/tokens/page.tsx",
  "app/fleets/page.tsx",
  "app/task-plans/page.tsx",
  "app/split/page.tsx",
  "app/login/page.tsx",
];

async function source(relative: string): Promise<string> {
  return readFile(path.join(import.meta.dirname, "..", relative), "utf8");
}

describe("탭 제목", () => {
  // 레이아웃은 next/font를 불러 테스트에서 바로 읽을 수 없어 원문을 본다
  it("뿌리 레이아웃은 화면 제목 뒤에 b-studio를 붙이는 틀을 쓴다", async () => {
    expect(await source("app/layout.tsx")).toContain('title: { default: "b-studio", template: "%s · b-studio" }');
  });

  it.each(PAGES_WITH_TITLE)("%s는 자기 제목을 정한다", async (file) => {
    expect(await source(file)).toMatch(/export (const metadata|async function generateMetadata)/);
  });
});

describe("대시보드 화면을 잇는 탭(#848)", () => {
  // 작업·격자·비교·작업 분해·계정은 같은 탭 줄로 오가고, 개발 화면으로 가는 길도 그 줄에 있다. 페이지마다 따로 둔 뒤로 가기 단추는 두지 않는다
  it.each([
    ["app/work/page.tsx", "work"],
    ["app/split/page.tsx", "split"],
    ["app/fleets/page.tsx", "fleets"],
    ["app/task-plans/page.tsx", "task-plans"],
    ["app/accounts/page.tsx", "accounts"],
  ])("%s는 탭 줄을 두고 자기 화면을 현재로 표시한다", async (file, current) => {
    const text = await source(file);
    expect(text).toMatch(new RegExp(`<DashboardTabs[^>]*current="${current}"`));
    expect(text).not.toMatch(/>\s*작업 목록\s*</);
    expect(text).not.toMatch(/>\s*개발 화면으로\s*</);
  });

  it("토큰 화면은 탭에 들지 않아 개발 화면으로 가는 링크를 그대로 둔다", async () => {
    const text = await source("app/projects/[id]/tokens/page.tsx");
    expect(text).toContain("개발 화면으로");
    expect(text).not.toContain("← 개발 화면으로");
  });

  it("작업 화면은 터미널을 쓸 수 있을 때만 studio desk 안내를 둔다", async () => {
    expect(await source("app/work/page.tsx")).toMatch(/sessionTerminalAllowed\(\)\s*&&\s*<DeskHint/);
  });
});
