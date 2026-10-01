import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createView } from "@/lib/session-view";
import type { SessionSnapshot } from "@/lib/studio-events";
import { SubmissionPanel } from "./submission-panel";

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

describe("SubmissionPanel", () => {
  it("데이터를 받기 전에는 점검표를 불러오는 중이라고 알린다(서버 렌더는 fetch를 하지 않는다)", () => {
    const html = renderToStaticMarkup(<SubmissionPanel view={createView(baseSnapshot)} />);
    expect(html).toContain("점검표를 불러오는 중");
  });

  it("올리기 버튼은 점검표가 완료 요청 수로 다시 마운트되는 구간 밖에 둔다(버그 리포트: 서비스 상태가 바뀔 때마다 PR 미리보기가 저절로 닫혔다)", () => {
    const view = createView({
      ...baseSnapshot,
      repository: { remote: "github.com/acme/orders", kind: "github", base: "main", branch: "b-studio/orders-s1", sourceDirtyFiles: 0, canCreatePullRequest: true },
    });
    const html = renderToStaticMarkup(<SubmissionPanel view={view} />);
    // "올리고 PR 만들기"는 점검표를 불러오는 중("점검표를 불러오는 중")에도 이미 그려져 있다 —
    // 두 블록이 같은 key로 함께 마운트되지 않는다는 뜻이다
    expect(html).toContain("점검표를 불러오는 중");
    expect(html).toContain("올리고 PR 만들기");
  });
});
