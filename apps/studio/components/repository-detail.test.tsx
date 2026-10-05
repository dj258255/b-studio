import { renderToStaticMarkup } from "react-dom/server";
import type { IssueDetail, PullDetail } from "@b-studio/agent";
import { describe, expect, it } from "vitest";
import { IssueDetailBody, PullDetailBody } from "./repository-detail";

const issue = (overrides: Partial<IssueDetail> = {}): IssueDetail => ({
  number: 57,
  title: "주문 목록이 느립니다",
  author: "yuna",
  labels: ["bug"],
  updatedAt: "2026-09-20T00:00:00.000Z",
  url: "https://github.com/acme/orders/issues/57",
  state: "open",
  body: "재현 방법\n\n- [ ] 인덱스 추가\n- [x] 쿼리 프로파일링",
  assignees: ["kim"],
  comments: [{ author: "kim", body: "진행 중입니다", createdAt: "2026-09-20T01:00:00.000Z", url: "#" }],
  totalComments: 1,
  commentsTruncated: false,
  taskList: { total: 2, checked: 1, items: [{ text: "인덱스 추가", checked: false }, { text: "쿼리 프로파일링", checked: true }] },
  linkedPulls: [{ number: 60, title: "fixes #57", url: "https://github.com/acme/orders/pull/60", state: "open", draft: false }],
  ...overrides,
});

describe("IssueDetailBody", () => {
  it("본문·라벨·담당자·체크리스트 진행도·연결된 PR·댓글을 보여준다", () => {
    const html = renderToStaticMarkup(<IssueDetailBody issue={issue()} canManage={true} onWork={() => {}} />);

    expect(html).toContain("bug");
    expect(html).toContain("kim");
    expect(html).toContain("체크리스트 1/2");
    expect(html).toContain("재현 방법");
    expect(html).toContain("fixes #57");
    expect(html).toContain("진행 중입니다");
  });

  it("작업 권한이 있으면 미완료 체크리스트마다 항목별 작업 버튼과, 통째 작업 버튼을 둔다", () => {
    const html = renderToStaticMarkup(<IssueDetailBody issue={issue()} canManage={true} onWork={() => {}} />);

    expect(html).toContain("체크리스트 항목으로 작업");
    expect(html).toContain("인덱스 추가");
    // 완료한 항목은 항목별 작업 버튼을 두지 않는다("쿼리 프로파일링" 자체는 본문에도 나오므로 버튼 개수로 확인한다)
    expect((html.match(/체크리스트 항목으로 작업/g) ?? []).length).toBe(1);
    expect(html).toContain("이 이슈로 작업");
  });

  it("작업 권한이 없으면 작업 관련 버튼을 하나도 그리지 않는다", () => {
    const html = renderToStaticMarkup(<IssueDetailBody issue={issue()} canManage={false} onWork={() => {}} />);

    expect(html).not.toContain("체크리스트 항목으로 작업");
    expect(html).not.toContain("이 이슈로 작업");
  });

  it("댓글이 잘렸으면 안내 문구를 더한다", () => {
    const html = renderToStaticMarkup(<IssueDetailBody issue={issue({ totalComments: 25, commentsTruncated: true })} canManage={false} onWork={() => {}} />);
    expect(html).toContain("댓글 25개");
    expect(html).toContain("최근 1개만 보여줍니다");
  });
});

const pull = (overrides: Partial<PullDetail> = {}): PullDetail => ({
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
  checkStatus: "success",
  reviewDecision: "approved",
  body: "closes #10",
  baseBranch: "main",
  mergeable: true,
  mergeableState: "clean",
  files: [
    { path: "src/orders.ts", status: "modified", additions: 10, deletions: 2, patch: "@@ -1,2 +1,10 @@", binary: false, truncated: false },
    { path: "logo.png", status: "added", additions: 0, deletions: 0, binary: true, truncated: false },
  ],
  filesSupported: true,
  filesTruncated: false,
  checkRuns: [{ name: "빌드", status: "completed", conclusion: "success", url: "https://ci/1", durationMs: 300_000 }],
  checksSupported: true,
  reviews: [{ author: "reviewer", state: "approved", submittedAt: "2026-09-22T01:00:00.000Z" }],
  reviewComments: [{ author: "reviewer", body: "여기 고쳐주세요", path: "src/orders.ts", line: 5, url: "#", createdAt: "2026-09-22T01:00:00.000Z" }],
  reviewCommentsSupported: true,
  linkedIssues: [10],
  ...overrides,
});

describe("PullDetailBody", () => {
  it("base←head, 라벨, 연결된 이슈, CI 체크, 리뷰, 파일을 보여준다", () => {
    const html = renderToStaticMarkup(
      <PullDetailBody pull={pull()} remoteWebUrl="https://github.com/acme/orders" canManage={true} matchBusy={false} onMatchRequirements={() => {}} onWorkOnBranch={() => {}} />,
    );

    expect(html).toContain("main");
    expect(html).toContain("b-studio/orders-s1");
    expect(html).toContain("feature");
    expect(html).toContain("closes #10");
    expect(html).toContain('href="https://github.com/acme/orders/issues/10"');
    expect(html).toContain("빌드");
    expect(html).toContain("300초");
    expect(html).toContain("reviewer");
    expect(html).toContain("승인");
    expect(html).toContain("src/orders.ts");
    expect(html).toContain("여기 고쳐주세요");
    expect(html).toContain("5줄");
    expect(html).toContain("logo.png");
    expect(html).toContain("이진 파일");
  });

  it("파일·체크·리뷰 댓글을 지원하지 않는 호스트(Gitea)는 그 이유를 보여준다", () => {
    const html = renderToStaticMarkup(
      <PullDetailBody
        pull={pull({
          checkStatus: undefined,
          reviewDecision: undefined,
          files: [],
          filesSupported: false,
          filesUnsupportedReason: "Gitea는 파일을 지원하지 않습니다",
          checksSupported: false,
          checksUnsupportedReason: "Gitea는 체크를 지원하지 않습니다",
          reviewComments: [],
          reviewCommentsSupported: false,
          reviewCommentsUnsupportedReason: "Gitea는 리뷰 댓글을 지원하지 않습니다",
        })}
        canManage={true}
        matchBusy={false}
        onMatchRequirements={() => {}}
        onWorkOnBranch={() => {}}
      />,
    );

    expect(html).toContain("Gitea는 파일을 지원하지 않습니다");
    expect(html).toContain("Gitea는 체크를 지원하지 않습니다");
    expect(html).toContain("Gitea는 리뷰 댓글을 지원하지 않습니다");
  });

  it("작업 권한이 있으면 확인 액션(요구 사항 대조·PR 브랜치로 작업)을 보여준다", () => {
    const html = renderToStaticMarkup(
      <PullDetailBody pull={pull()} canManage={true} matchBusy={false} onMatchRequirements={() => {}} onWorkOnBranch={() => {}} />,
    );
    expect(html).toContain("요구 사항 대조");
    expect(html).toContain("PR 브랜치로 작업");
  });

  it("작업 권한이 없으면 확인 액션을 그리지 않는다", () => {
    const html = renderToStaticMarkup(
      <PullDetailBody pull={pull()} canManage={false} matchBusy={false} onMatchRequirements={() => {}} onWorkOnBranch={() => {}} />,
    );
    expect(html).not.toContain("요구 사항 대조");
    expect(html).not.toContain("PR 브랜치로 작업");
  });

  it("b-studio 세션이 만든 PR이면 AI 리뷰 카드를 함께 보여준다", () => {
    const html = renderToStaticMarkup(
      <PullDetailBody pull={pull({ sessionId: "s1" })} canManage={true} matchBusy={false} onMatchRequirements={() => {}} onWorkOnBranch={() => {}} />,
    );
    expect(html).toContain("AI 리뷰");
    expect(html).toContain('href="/sessions/s1"');
  });

  it("세션과 무관한 PR이면 AI 리뷰 카드를 두지 않는다", () => {
    const html = renderToStaticMarkup(
      <PullDetailBody pull={pull({ sessionId: undefined })} canManage={true} matchBusy={false} onMatchRequirements={() => {}} onWorkOnBranch={() => {}} />,
    );
    expect(html).not.toContain("AI 리뷰");
  });
});
