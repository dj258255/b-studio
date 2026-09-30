import { renderToStaticMarkup } from "react-dom/server";
import type { IssueSummary, PullRequestSummary } from "@b-studio/agent";
import { describe, expect, it } from "vitest";
import { createView } from "@/lib/session-view";
import type { SessionSnapshot } from "@/lib/studio-events";
import { IssueRow, PullRow, RepositoryPanel } from "./repository-panel";

const baseSnapshot: SessionSnapshot = {
  id: "s1",
  projectId: "orders",
  projectName: "orders",
  workDir: "/tmp/orders-s1",
  status: "ready",
  mode: "api",
  running: false,
  checkpoints: [],
  services: [],
};

const issue = (overrides: Partial<IssueSummary> = {}): IssueSummary => ({
  number: 12,
  title: "로그인 오류",
  author: "yuna",
  labels: ["bug"],
  updatedAt: "2026-09-20T00:00:00.000Z",
  url: "https://github.com/acme/orders/issues/12",
  state: "open",
  ...overrides,
});

const pull = (overrides: Partial<PullRequestSummary> = {}): PullRequestSummary => ({
  number: 21,
  title: "주문 목록 API",
  author: "yuna",
  labels: ["feature"],
  updatedAt: "2026-09-22T00:00:00.000Z",
  url: "https://github.com/acme/orders/pull/21",
  state: "open",
  draft: false,
  headBranch: "b-studio/orders-s1",
  headSha: "abc123",
  ...overrides,
});

describe("RepositoryPanel", () => {
  it("이슈·PR 하위 탭과 상태 필터를 보여주고, 데이터를 받기 전에는 불러오는 중이라고 알린다", () => {
    const html = renderToStaticMarkup(<RepositoryPanel view={createView(baseSnapshot)} />);

    expect(html).toContain(">이슈<");
    expect(html).toContain(">PR<");
    expect(html).toContain(">열림<");
    expect(html).toContain(">닫힘<");
    expect(html).toContain(">전체<");
    expect(html).toContain("불러오는 중");
  });
});

describe("IssueRow", () => {
  it("이슈 번호·제목·라벨·작성자·시간을 보여주고, 작업 권한이 있으면 이슈로 작업 버튼을 둔다", () => {
    const html = renderToStaticMarkup(<IssueRow issue={issue()} onWork={() => {}} onOpen={() => {}} />);

    expect(html).toContain("#12");
    expect(html).toContain("로그인 오류");
    expect(html).toContain("bug");
    expect(html).toContain("yuna");
    expect(html).toContain("이 이슈로 작업");
    expect(html).toContain(issue().url);
  });

  it("작업 권한이 없으면(onWork 없음) 작업 버튼을 그리지 않는다", () => {
    const html = renderToStaticMarkup(<IssueRow issue={issue()} onOpen={() => {}} />);
    expect(html).not.toContain("이 이슈로 작업");
  });

  it("닫힌 이슈는 열린 이슈와 다른 상태 점을 쓴다", () => {
    const open = renderToStaticMarkup(<IssueRow issue={issue({ state: "open" })} onOpen={() => {}} />);
    const closed = renderToStaticMarkup(<IssueRow issue={issue({ state: "closed" })} onOpen={() => {}} />);
    expect(open).toContain("bg-pass");
    expect(closed).toContain("bg-line");
  });
});

describe("PullRow", () => {
  it("CI 상태·리뷰 판정·b-studio 세션 배지를 보여준다", () => {
    const html = renderToStaticMarkup(<PullRow pull={pull({ checkStatus: "success", reviewDecision: "approved", sessionId: "s1" })} onOpen={() => {}} />);

    expect(html).toContain("#21");
    expect(html).toContain("CI 통과");
    expect(html).toContain("리뷰 승인");
    expect(html).toContain("b-studio");
    expect(html).toContain('href="/sessions/s1"');
  });

  it("초안 PR은 (초안) 표시를 더하고, 세션과 무관한 PR은 b-studio 배지를 두지 않는다", () => {
    const html = renderToStaticMarkup(<PullRow pull={pull({ draft: true, headBranch: "feature/manual" })} onOpen={() => {}} />);

    expect(html).toContain("(초안)");
    expect(html).not.toContain(">b-studio<");
  });

  it("체크·리뷰 정보를 못 얻었으면(Gitea 등) 그 줄을 아예 보이지 않는다", () => {
    const html = renderToStaticMarkup(<PullRow pull={pull({ checkStatus: undefined, reviewDecision: undefined })} onOpen={() => {}} />);

    expect(html).not.toContain("CI ");
    expect(html).not.toContain("리뷰 ");
  });

  it("실패·변경 요청은 강조 색으로 보여준다", () => {
    const html = renderToStaticMarkup(<PullRow pull={pull({ checkStatus: "failure", reviewDecision: "changes_requested" })} onOpen={() => {}} />);
    expect(html).toContain("text-fail");
    expect(html).toContain("CI 실패");
    expect(html).toContain("리뷰 변경 요청");
  });
});
