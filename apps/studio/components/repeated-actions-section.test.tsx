import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RepeatedActionCandidate } from "@/lib/repeated-actions";
import { CandidateCard, RepeatedActionsSection } from "./repeated-actions-section";

function candidate(overrides: Partial<RepeatedActionCandidate> = {}): RepeatedActionCandidate {
  return {
    id: "command-abc123",
    kind: "command",
    title: 'web 서비스에서 "pnpm test" 명령을 3번(실행 3개에 걸쳐) 반복했습니다',
    occurrences: 3,
    runCount: 3,
    sessionCount: 2,
    runIds: ["r1", "r2", "r3"],
    sessionIds: ["s1", "s2"],
    totalChars: 900,
    examples: [{ runId: "r1", sessionId: "s1", input: "web pnpm test" }],
    suggestion: { scriptName: "web-pnpm", scriptBody: "#!/bin/sh\npnpm test\n" },
    ...overrides,
  };
}

describe("RepeatedActionsSection", () => {
  it("불러오는 중에는 안내 문구만 보여준다(마운트 시점에는 아직 fetch 응답이 없다)", () => {
    const html = renderToStaticMarkup(<RepeatedActionsSection projectId="orders" />);
    expect(html).toContain("반복 작업을 분석하는 중");
  });
});

describe("CandidateCard", () => {
  it("명령·순서 후보는 스크립트로 만들기 버튼을 보여준다", () => {
    const html = renderToStaticMarkup(<CandidateCard candidate={candidate()} onIgnore={() => {}} />);
    expect(html).toContain("스크립트로 만들기");
    expect(html).not.toContain("노트에 요약 남기기");
    expect(html).toContain("무시");
    expect(html).toContain("pnpm test");
    expect(html).toContain("3회");
    expect(html).toContain("실행 3개");
    expect(html).toContain("세션 2개");
  });

  it("큰 반복 읽기 후보는 노트에 요약 남기기 버튼을 보여준다", () => {
    const html = renderToStaticMarkup(
      <CandidateCard
        candidate={candidate({
          kind: "big_read",
          title: '"docs/spec.md" 파일을 크게(총 12,000자) 3번(실행 3개에서) 다시 읽었습니다',
          suggestion: { noteText: "docs/spec.md 요약을 프로젝트 노트에 남겨, 다음부터는 이 노트를 먼저 보게 하세요" },
        })}
        onIgnore={() => {}}
      />,
    );
    expect(html).toContain("노트에 요약 남기기");
    expect(html).not.toContain("스크립트로 만들기");
  });
});
