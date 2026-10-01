import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createView } from "@/lib/session-view";
import type { SessionSnapshot } from "@/lib/studio-events";
import {
  DiffSummary,
  ExtractionResultView,
  formatDraftTimestamp,
  formatElapsed,
  hasUnsavedDraftEdits,
  ImportFlow,
  RequirementPublishFlow,
  requirementsDraftStatusLine,
  RequirementsList,
  RequirementsPanel,
  shouldConfirmBeforePlanAll,
} from "./requirements-panel";

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

describe("RequirementsPanel", () => {
  it("데이터를 받기 전에는 불러오는 중이라고 알린다(명세 → 요구사항 → 검증 추적, ADR-079)", () => {
    const html = renderToStaticMarkup(<RequirementsPanel view={createView(baseSnapshot)} />);

    expect(html).toContain("명세 → 요구사항 → 검증 추적");
    expect(html).toContain("불러오는 중");
  });
});

describe("ImportFlow 용어", () => {
  it("과제처럼 들리는 말 대신 중립적인 제품 용어를 쓴다", () => {
    const html = renderToStaticMarkup(<ImportFlow sessionId="s1" onExtracted={() => {}} />);

    expect(html).not.toContain("과제");
    expect(html).toContain("만들 것을 적어 주세요");
  });
});

describe("ImportFlow initialSpecText(대화 '요구사항에 반영', ADR-094)", () => {
  it("붙여넣기 칸을 그 글로 채운 채 그려(마운트 때부터 한 번 추출하는 중으로 시작한다)", () => {
    const html = renderToStaticMarkup(<ImportFlow sessionId="s1" onExtracted={() => {}} initialSpecText="[R4] 주문 목록 필터\n\n질문: 상태 값은?" />);

    expect(html).toContain("[R4] 주문 목록 필터");
    expect(html).toContain("질문: 상태 값은?");
  });

  it("initialSpecText가 없으면(사람이 직접 연 가져오기) 평소처럼 빈 칸으로 그린다", () => {
    const html = renderToStaticMarkup(<ImportFlow sessionId="s1" onExtracted={() => {}} />);

    expect(html).toContain("만들 것을 적어 주세요");
  });

  it("마운트 때부터 뽑는 중이면 경과 시간(0초)과 취소 버튼을 함께 보여준다(A)", () => {
    const html = renderToStaticMarkup(<ImportFlow sessionId="s1" onExtracted={() => {}} initialSpecText="[R4] 주문 목록 필터" />);

    expect(html).toContain("뽑는 중 · 0초");
    expect(html).toContain("취소");
  });
});

describe("formatElapsed(ADR-097, '뽑는 중' 경과 시간 표시)", () => {
  it("1분 미만은 초만 보여준다", () => {
    expect(formatElapsed(0)).toBe("0초");
    expect(formatElapsed(13_000)).toBe("13초");
    expect(formatElapsed(59_000)).toBe("59초");
  });

  it("1분 이상은 분·초를 함께 보여준다", () => {
    expect(formatElapsed(60_000)).toBe("1분 0초");
    expect(formatElapsed(133_000)).toBe("2분 13초");
  });
});

const baseDraft = {
  savedAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  requirements: [{ id: "R1", title: "로그인 API", kind: "api" as const, priority: "must" as const, acceptance: ["a"] }],
  questions: [],
  source: "model" as const,
  referencedFiles: [],
  outOfScope: [],
  assumptions: [],
  manualSteps: [],
};

describe("hasUnsavedDraftEdits(ADR-097 개정 — 재추출 전 확인)", () => {
  it("추출 결과가 없으면 확인할 필요가 없다", () => {
    expect(hasUnsavedDraftEdits(undefined)).toBe(false);
  });

  it("저장(apply)한 적이 없으면 확인이 필요하다", () => {
    expect(hasUnsavedDraftEdits(baseDraft)).toBe(true);
  });

  it("저장한 뒤로 바뀌지 않았으면 확인이 필요 없다", () => {
    expect(hasUnsavedDraftEdits({ ...baseDraft, appliedAt: "2026-01-01T00:10:00.000Z" })).toBe(false);
  });

  it("저장한 뒤에 또 바뀌었으면(updatedAt이 더 늦으면) 확인이 필요하다", () => {
    expect(hasUnsavedDraftEdits({ ...baseDraft, appliedAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:10:00.000Z" })).toBe(true);
  });
});

describe("ImportFlow 재추출 전 확인(ADR-097 개정)", () => {
  it("저장 안 한 편집이 있는 추출 결과가 있으면 '요구사항 뽑기'를 눌렀을 때 바꾼다는 확인을 보여준다", () => {
    const html = renderToStaticMarkup(<ImportFlow sessionId="s1" onExtracted={() => {}} draft={baseDraft} />);

    // 서버 렌더는 클릭 이벤트를 실행하지 않으므로 아직 확인 배너는 없다 — 버튼이 눌리기 전 상태를 확인한다
    expect(html).not.toContain("이전 추출 결과를 새 결과로 바꿉니다");
    expect(html).toContain("요구사항 뽑기");
  });

  it("추출 결과가 없으면 평소처럼 바로 뽑기 버튼만 보인다", () => {
    const html = renderToStaticMarkup(<ImportFlow sessionId="s1" onExtracted={() => {}} />);

    expect(html).not.toContain("이전 추출 결과를 새 결과로 바꿉니다");
  });
});

describe("formatDraftTimestamp/requirementsDraftStatusLine(ADR-097 개정 — '추출 결과' 상태줄)", () => {
  it("월·일·시·분을 사람이 읽는 모양으로 바꾼다(실행 환경의 로캘 타임존 기준)", () => {
    // 로캘 타임존에 따라 날짜가 하루 앞뒤로 밀릴 수 있어(UTC 입력), 모양만 확인한다 — 실제 월·일은 Date로 계산해 맞춘다
    expect(formatDraftTimestamp("2026-10-01T16:20:00.000Z")).toMatch(/^\d{1,2}월 \d{1,2}일 \d{2}:\d{2}$/);
  });

  it("저장한 적이 없으면 '아직 저장 안 함'", () => {
    expect(requirementsDraftStatusLine(undefined, "2026-01-01T00:00:00.000Z")).toBe("아직 저장 안 함");
  });

  it("저장한 뒤로 바뀌지 않았으면 '저장됨 · 시각'만 보여준다", () => {
    const line = requirementsDraftStatusLine("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z");
    expect(line).toContain("저장됨 ·");
    expect(line).not.toContain("저장한 뒤 바뀜");
  });

  it("저장한 뒤에 또 바뀌었으면 '저장한 뒤 바뀜'을 덧붙인다", () => {
    const line = requirementsDraftStatusLine("2026-01-01T00:00:00.000Z", "2026-01-01T00:10:00.000Z");
    expect(line).toContain("저장됨 ·");
    expect(line).toContain("저장한 뒤 바뀜");
  });
});

describe("ExtractionResultView(ADR-097 개정 — 배너 없이 항상 보여주는 '추출 결과' 화면)", () => {
  it("저장한 적이 없으면 '아직 저장 안 함'을 보여준다", () => {
    const html = renderToStaticMarkup(<ExtractionResultView sessionId="s1" draft={baseDraft} onApplied={() => {}} onDiscarded={() => {}} onRefresh={() => {}} />);

    expect(html).toContain("아직 저장 안 함");
    expect(html).toContain("로그인 API");
    expect(html).toContain("지우기");
  });

  it("저장(apply)한 적이 있으면 '저장됨 · 시각'을 보여준다", () => {
    const html = renderToStaticMarkup(
      <ExtractionResultView sessionId="s1" draft={{ ...baseDraft, appliedAt: "2026-01-01T00:00:00.000Z" }} onApplied={() => {}} onDiscarded={() => {}} onRefresh={() => {}} />,
    );

    expect(html).toContain("저장됨 ·");
    expect(html).not.toContain("아직 저장 안 함");
  });

  it("결정론적 대체 파서(fallback)로 나눴으면 눈에 띄게 경고한다", () => {
    const html = renderToStaticMarkup(
      <ExtractionResultView sessionId="s1" draft={{ ...baseDraft, source: "fallback", reason: "이 세션 백엔드는 모델 호출을 지원하지 않습니다" }} onApplied={() => {}} onDiscarded={() => {}} onRefresh={() => {}} />,
    );

    expect(html).toContain("모델 호출 없이 결정론적 방식으로 나눴습니다");
    expect(html).toContain("이 세션 백엔드는 모델 호출을 지원하지 않습니다");
  });

  it("모델 추출이면 경고 없이 평소 문구만 보여준다", () => {
    const html = renderToStaticMarkup(<ExtractionResultView sessionId="s1" draft={baseDraft} onApplied={() => {}} onDiscarded={() => {}} onRefresh={() => {}} />);

    expect(html).not.toContain("모델 호출 없이 결정론적 방식으로 나눴습니다");
    expect(html).toContain("추출 모델이 나눴습니다");
  });

  it("사람이 답한 내용과 추천을 그대로 보여준다", () => {
    const html = renderToStaticMarkup(
      <ExtractionResultView
        sessionId="s1"
        draft={{
          ...baseDraft,
          questions: ["동시 접속자 규모는?"],
          answers: { "0": "100명" },
          recommendations: {
            "0": { question: "동시 접속자 규모는?", answer: "100명", rationale: "업계 관례", sources: [], basis: "spec", specQuote: "동시 접속자 100명을 가정한다" },
          },
        }}
        onApplied={() => {}}
        onDiscarded={() => {}}
        onRefresh={() => {}}
      />,
    );

    expect(html).toContain("동시 접속자 규모는?");
    expect(html).toContain("100명");
    expect(html).toContain("명세에 있음");
    expect(html).toContain("동시 접속자 100명을 가정한다");
  });

  it("sourceInput이 있으면 '스펙을 고치고 다시 뽑기' 버튼을 보여준다", () => {
    const html = renderToStaticMarkup(
      <ExtractionResultView
        sessionId="s1"
        draft={{ ...baseDraft, questions: ["동시 접속자 규모는?"], sourceInput: { specText: "주문 서비스를 만든다" } }}
        onApplied={() => {}}
        onDiscarded={() => {}}
        onRefresh={() => {}}
      />,
    );

    expect(html).toContain("스펙을 고치고 다시 뽑기");
  });

  it("sourceInput이 없으면(옛 draft) '스펙을 고치고 다시 뽑기' 버튼을 숨긴다", () => {
    const html = renderToStaticMarkup(
      <ExtractionResultView sessionId="s1" draft={{ ...baseDraft, questions: ["동시 접속자 규모는?"] }} onApplied={() => {}} onDiscarded={() => {}} onRefresh={() => {}} />,
    );

    expect(html).not.toContain("스펙을 고치고 다시 뽑기");
  });
});

const snapshot = {
  exists: true as const,
  requirements: [
    {
      id: "R1",
      title: "로그인 API",
      kind: "api" as const,
      priority: "must" as const,
      acceptance: ["a"],
      status: "미착수" as const,
      confidence: "🔴" as const,
      evidence: { checkpoints: [], tests: [], gateChecks: [] },
      workPrefill: "[R1] 로그인 API",
    },
  ],
  allMustHavesPrefill: "다음 필수(must) 요구사항을 모두 구현해 주세요.\n\n- [R1] 로그인 API",
  assumptions: [],
  manualSteps: [],
};

describe("RequirementsList 다음 단계 순서(ADR-092)", () => {
  it("원격이 GitHub이고 아직 발행하지 않았으면 이슈로 발행이 전체 계획 세우기보다 먼저 나온다", () => {
    const html = renderToStaticMarkup(<RequirementsList sessionId="s1" snapshot={snapshot} canManage isGithub onWork={() => {}} onRefresh={() => {}} />);
    const publishIndex = html.indexOf("이슈로 발행");
    const planIndex = html.indexOf("전체 계획 세우기");
    expect(publishIndex).toBeGreaterThan(-1);
    expect(planIndex).toBeGreaterThan(-1);
    expect(publishIndex).toBeLessThan(planIndex);
  });

  it("원격이 GitHub이 아니면 '다음 단계'에 이슈로 발행 지름길을 보여주지 않는다", () => {
    const html = renderToStaticMarkup(<RequirementsList sessionId="s1" snapshot={snapshot} canManage isGithub={false} onWork={() => {}} onRefresh={() => {}} />);
    expect(html).toContain("전체 계획 세우기");
    expect(html).not.toContain("이슈로 발행");
  });

  it("이미 발행된(issue 있음) 요구사항이면 관리 권한이 있어도 확인을 다시 묻지 않는다(순수 로직)", () => {
    expect(shouldConfirmBeforePlanAll(true, false, false)).toBe(true);
    expect(shouldConfirmBeforePlanAll(true, true, false)).toBe(false);
    expect(shouldConfirmBeforePlanAll(true, false, true)).toBe(false);
    expect(shouldConfirmBeforePlanAll(false, false, false)).toBe(false);
  });
});

describe("RequirementPublishFlow(ADR-092)", () => {
  it("미리보기를 불러오는 동안 안내 문구와 설명을 보여준다(서버 렌더는 effect를 돌리지 않아 fetch가 일어나지 않는다)", () => {
    const html = renderToStaticMarkup(<RequirementPublishFlow sessionId="s1" onRefresh={() => {}} />);

    expect(html).toContain("요구사항을 GitHub 이슈로 발행");
    expect(html).toContain("docs/requirements.md");
    expect(html).toContain("미리보기를 만드는 중");
  });
});

describe("DiffSummary(재추출 병합 요약)", () => {
  const entry = (status: "added" | "changed" | "unchanged" | "removed", id: string) => ({
    status,
    id,
    requirement: { id, title: id, kind: "api" as const, priority: "must" as const, acceptance: ["a"] },
  });

  it("명세에서 사라진 항목이 있으면 한 번에 빼는 버튼을 보여 준다", () => {
    const html = renderToStaticMarkup(<DiffSummary diff={[entry("added", "R1"), entry("removed", "R3"), entry("removed", "R4")]} onDropRemoved={() => {}} />);
    expect(html).toContain("사라진 2개도 목록에서 빼기");
  });

  it("사라진 항목이 없으면 버튼이 없다", () => {
    const html = renderToStaticMarkup(<DiffSummary diff={[entry("unchanged", "R1")]} onDropRemoved={() => {}} />);
    expect(html).not.toContain("목록에서 빼기");
  });
});
