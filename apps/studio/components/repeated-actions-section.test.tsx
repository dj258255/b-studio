import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { RepeatedActionCandidate } from "@/lib/repeated-actions";
import { CandidateCard, RepeatedActionsList, RepeatedActionsSection } from "./repeated-actions-section";

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

describe("RepeatedActionsList(이슈 #83 — 기본 접힘, 토큰 탭 그래프를 짜부러뜨리지 않는다)", () => {
  it("여러 개여도 기본은 접힌 채로 그려 개수만 보여준다(펼치기 전에는 카드 목록이 차지하는 높이가 없다)", () => {
    const candidates = Array.from({ length: 6 }, (_, i) => candidate({ id: `c${i}`, title: `후보 ${i}` }));
    const html = renderToStaticMarkup(<RepeatedActionsList candidates={candidates} sessionsAnalyzed={4} onIgnore={() => {}} />);

    expect(html).toContain("반복 작업 6개");
    // <details>에 open 속성이 없으면 기본은 접힌 상태다(네이티브 렌더가 summary 말고는 공간을 차지하지 않는다)
    expect(html).toMatch(/<details>/);
    expect(html).not.toMatch(/<details open/);
    // 접혀 있어도 내용 자체는 지우지 않는다(펼치면 바로 보여야 한다)
    expect(html).toContain("후보 0");
    expect(html).toContain("후보 5");
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
