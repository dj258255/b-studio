import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createView } from "@/lib/session-view";
import type { RepositoryView, SessionSnapshot } from "@/lib/studio-events";
import { RepositoryUploadActions } from "./repository-upload-actions";

const baseSnapshot: SessionSnapshot = {
  id: "s1",
  projectId: "orders",
  projectName: "orders",
  workDir: "/tmp/orders-s1",
  status: "ready",
  mode: "api",
  running: false,
  checkpoints: [{ sha: "a".repeat(40), shortSha: "aaaaaaa", message: "요청: 메모 추가", createdAt: "2026-09-20T00:00:00.000Z", files: ["a.ts"] }],
  services: [],
};

const repository = (overrides: Partial<RepositoryView> = {}): RepositoryView => ({
  remote: "github.com/acme/orders",
  kind: "github",
  base: "main",
  branch: "b-studio/orders-s1",
  sourceDirtyFiles: 0,
  canCreatePullRequest: true,
  ...overrides,
});

/**
 * RepositoryBar(코드 탭)와 SubmissionPanel(저장소 탭의 올리기 전 점검)이 함께 쓰는 공유 컴포넌트(ADR-107, 56번 버그).
 * 어느 탭에 끼워도 같은 버튼·판단을 보여야 한다
 */
describe("RepositoryUploadActions", () => {
  it("저장소가 없는 세션은 아무것도 그리지 않는다", () => {
    const html = renderToStaticMarkup(<RepositoryUploadActions view={createView(baseSnapshot)} />);
    expect(html).toBe("");
  });

  it("gh CLI 대체로 토큰을 찾아 canCreatePullRequest가 true면 '올리고 PR 만들기'를 보여준다(57번 버그 수정 반영)", () => {
    const view = createView({ ...baseSnapshot, repository: repository() });
    const html = renderToStaticMarkup(<RepositoryUploadActions view={view} />);
    expect(html).toContain("올리고 PR 만들기");
    expect(html).toContain("브랜치 올리기");
  });

  it("토큰이 없어 canCreatePullRequest가 false면 '올리고 PR 만들기'를 보이지 않는다", () => {
    const view = createView({ ...baseSnapshot, repository: repository({ canCreatePullRequest: false }) });
    const html = renderToStaticMarkup(<RepositoryUploadActions view={view} />);
    expect(html).not.toContain("올리고 PR 만들기");
    expect(html).toContain("브랜치 올리기");
  });

  it("이미 PR이 있으면 만들기 버튼을 보이지 않는다", () => {
    const view = createView({ ...baseSnapshot, repository: repository({ pullRequestUrl: "https://github.com/acme/orders/pull/1" }) });
    const html = renderToStaticMarkup(<RepositoryUploadActions view={view} />);
    expect(html).not.toContain("올리고 PR 만들기");
  });

  it("GitLab 저장소는 PR 대신 MR이라고 한다", () => {
    const view = createView({ ...baseSnapshot, repository: repository({ kind: "gitlab" }) });
    const html = renderToStaticMarkup(<RepositoryUploadActions view={view} />);
    expect(html).toContain("올리고 MR 만들기");
  });
});
