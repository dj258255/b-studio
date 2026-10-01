import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PrReviewFinding } from "@b-studio/agent";
import type { ReviewStateView } from "@/lib/studio-events";
import { fixRequestDraft, ReviewCard } from "./review-card";

const finding = (overrides: Partial<PrReviewFinding> = {}): PrReviewFinding => ({
  severity: "blocker",
  file: "api/SeedRunner.java",
  title: "시퀀스 미복원",
  detail: "설명",
  ...overrides,
});

describe("fixRequestDraft", () => {
  it("위치·제목·설명·제안을 담아 다음 요청 글을 만든다", () => {
    const draft = fixRequestDraft(finding({ line: 10, suggestion: "ALTER TABLE ... RESTART WITH" }));
    expect(draft).toContain("api/SeedRunner.java:10");
    expect(draft).toContain("시퀀스 미복원");
    expect(draft).toContain("ALTER TABLE ... RESTART WITH");
  });
});

describe("ReviewCard", () => {
  it("리뷰가 사람 확인으로 끝났으면 '사람이 확인함'을 보여준다(과제 67-b)", () => {
    const review: ReviewStateView = { state: "resolved", maxRounds: 1, rounds: [] };
    const html = renderToStaticMarkup(<ReviewCard sessionId="s1" review={review} canManage hasPullRequest />);
    expect(html).toContain("사람이 확인함");
  });

  it("라운드가 사람 확인으로 닫혔으면 라운드 줄에도 같은 라벨을 보여준다", () => {
    const review: ReviewStateView = {
      state: "resolved",
      maxRounds: 1,
      rounds: [{ round: 1, status: "resolved_by_human", findings: [finding()], startedAt: "2026-01-01T00:00:00.000Z", humanResolutions: { 0: { reason: "확인됨", at: "2026-01-01T00:01:00.000Z" } } }],
    };
    const html = renderToStaticMarkup(<ReviewCard sessionId="s1" review={review} canManage hasPullRequest />);
    expect(html).toContain("사람이 확인함");
    expect(html).toContain("지적 펼치기");
  });

  it("PR이 없으면 아무것도 그리지 않는다", () => {
    expect(renderToStaticMarkup(<ReviewCard sessionId="s1" canManage hasPullRequest={false} />)).toBe("");
  });
});
