import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createView, reduceSession, type SessionView } from "@/lib/session-view";
import type { ModelPickerView } from "@/lib/server/model-picker";
import type { SessionSnapshot, StudioEvent } from "@/lib/studio-events";
import { ChatPanel, ModelPicker, ModelPickerDialog } from "./chat-panel";

// 비교·병렬을 보내면 그 화면으로 옮겨 가려고 라우터를 쓴다. 서버 렌더 테스트에는 앱 라우터가 없어 흉내 낸다
vi.mock("next/navigation", () => ({ useRouter: () => ({ replace: () => undefined, push: () => undefined }) }));

const snapshot: SessionSnapshot = {
  id: "s1",
  projectId: "orders",
  projectName: "orders",
  workDir: "/tmp/orders-s1",
  status: "ready",
  mode: "api",
  running: false,
  checkpoints: [],
  services: [{ name: "web", template: "nextjs", preview: "browser", state: "ready", hasContract: false }],
};

/** 이벤트를 접어 화면 상태를 만든다(대화 화면이 받는 것과 같은 모양) */
function view(events: StudioEvent[] = []): SessionView {
  return events.reduce(reduceSession, createView(snapshot));
}

const render = (state: SessionView) => renderToStaticMarkup(<ChatPanel view={state} />);

const asked: StudioEvent[] = [
  { type: "run_started", runId: "r1", request: "이 함수는 어떻게 동작해?" },
  { type: "run_finished", runId: "r1", status: "done", summary: "이렇게 동작합니다", turns: 1 },
];

describe("ChatPanel 입력", () => {
  it("입력창은 하나이고, 만들기/질문 토글 대신 읽기만 스위치가 있다(기본 꺼짐)", () => {
    const html = render(view());

    // 입력창 하나
    expect(html.match(/<textarea/g)).toHaveLength(1);
    expect(html.match(/id="request"/g)).toHaveLength(1);
    // 예전 모드 토글은 사라졌다
    expect(html).not.toContain("요청 종류");
    expect(html).not.toContain("만들기</button>");
    expect(html).not.toContain(">질문</button>");
    // 스위치는 꺼진 채로 그려지고, 기본이 만들기 경로라는 것을 글로 알린다
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain("읽기만");
    expect(html).toContain("질문이면 답만 하고, 바꾸면 검증 게이트를 통과한 변경만 남습니다");
    // 기본 경로에서는 호환성 파괴 허용을 고를 수 있다
    expect(html).toContain("필드 삭제나 타입 변경 허용");
  });

  it("입력창에는 방식 버튼이 없다. 한 명이 처리하고, 필요하면 에이전트가 제안한다(ADR-068)", () => {
    const html = render(view());

    expect(html).not.toContain('aria-label="방식"');
    expect(html).not.toContain(">여러 명 비교</button>");
    expect(html).toContain("요청 보내기");
  });

  it("에이전트가 제안하면 제안 카드를 그리고, 서버 답을 받기 전에는 넘기기 버튼을 막아 둔다", () => {
    const html = render(
      view([
        { type: "run_started", runId: "r1", request: "주문 API와 화면을 만들어줘" },
        { type: "question", runId: "r1", question: "API와 화면을 나눠 동시에 만들 수 있습니다", options: ["나눠서 병렬로 하기", "한 명으로 계속"], allowOther: false, proposal: { mode: "split", request: "주문 API와 화면을 만들어줘" } },
        { type: "run_finished", runId: "r1", status: "awaiting_input", summary: "제안" },
      ]),
    );

    expect(html).toContain("에이전트의 제안 · 나눠서 병렬");
    expect(html).toContain("API와 화면을 나눠 동시에 만들 수 있습니다");
    expect(html).toMatch(/disabled=""[^>]*>나눠서 병렬로 하기</);
    expect(html).toContain(">한 명으로 계속</button>");
  });

  it("제안을 받아 넘긴 요청은 대화 안에 진행 카드로 남는다(화면을 옮기지 않는다)", () => {
    const html = render(
      view([
        { type: "run_started", runId: "r1", request: "주문 API와 화면" },
        { type: "question", runId: "r1", question: "나눌까요?", options: ["나눠서 병렬로 하기", "한 명으로 계속"], allowOther: false, proposal: { mode: "split", request: "주문 API와 화면" } },
        { type: "run_finished", runId: "r1", status: "awaiting_input", summary: "제안" },
        { type: "question_dismissed", runId: "r1", to: "split", href: "/task-plans?id=p1" },
      ]),
    );

    expect(html).toContain("제안을 받아 이 요청을 나눠서 병렬로 넘겼습니다");
    expect(html).toContain('aria-label="나눠서 병렬 진행"');
    expect(html).not.toContain("에이전트의 제안 · 나눠서 병렬");
  });

  it("읽기만 스위치는 세션마다 저장된 값을 쓰고, 켜지면 파일을 바꾸지 않는다고 알린다", () => {
    // 저장된 값을 읽는 훅은 브라우저 저장소를 쓴다. 여기서는 저장소가 없는 서버 렌더라 기본값을 본다
    const html = render(view(asked));
    expect(html).toContain('aria-checked="false"');
  });
});

describe("ChatPanel 결과 표시", () => {
  it("바꾼 파일이 없는 실행은 '답만 했습니다'로 알린다", () => {
    const html = render(view(asked));

    expect(html).toContain("답만 했습니다(바꾼 파일 없음), 1턴");
    expect(html).not.toContain("완료, 1턴");
  });

  it("게이트를 돌아 파일을 바꾼 실행은 지금처럼 완료로 알린다", () => {
    const html = render(
      view([
        { type: "run_started", runId: "r1", request: "필터를 추가해 줘" },
        { type: "agent", runId: "r1", event: { type: "verify_start", files: ["web/app/page.tsx"] } },
        { type: "run_finished", runId: "r1", status: "done", summary: "추가했습니다", turns: 2 },
      ]),
    );

    expect(html).toContain("완료, 2턴");
    expect(html).not.toContain("답만 했습니다");
  });

  it("'이대로 만들기'는 읽기만(질문) 실행의 답에만 붙는다", () => {
    const askedHtml = render(view([{ type: "run_started", runId: "r1", request: "어떻게 만들까?", intent: "ask" }, ...asked.slice(1)]));
    expect(askedHtml).toContain("이대로 만들기");

    // 만들기 경로에서 답만 한 실행에는 붙지 않는다(파일을 바꾸지 않아도 읽기만 실행이 아니다)
    expect(render(view(asked))).not.toContain("이대로 만들기");
  });

  it("claude-code 자동 모델 선택(ADR-091)은 점수표 대신 한 줄 안내로 보여준다", () => {
    const html = render(
      view([
        { type: "run_started", runId: "r1", request: "버튼 문구를 바꿔줘" },
        {
          type: "agent",
          runId: "r1",
          event: {
            type: "route",
            selectedId: "sonnet",
            reason: "단순한 만들기 요청이라 Sonnet 5을 선택합니다",
            complexity: "simple",
            risk: "normal",
            candidates: [
              { id: "haiku", label: "Haiku", eligible: false, score: 0 },
              { id: "sonnet", label: "Sonnet 5", eligible: true, score: 0 },
              { id: "opus", label: "Opus", eligible: false, score: 0 },
            ],
            auto: true,
          },
        },
      ]),
    );

    expect(html).toContain("자동 선택");
    expect(html).toContain("Sonnet 5");
    expect(html).toContain("단순한 만들기 요청이라 Sonnet 5을 선택합니다");
    // api 라우터(ADR-047)의 점수표 접기 블록은 쓰지 않는다
    expect(html).not.toContain("<details");
  });
});

describe("ModelPicker(대화 입력창의 모델 선택)", () => {
  const claudeCode: ModelPickerView = {
    backend: "claude-code",
    current: "sonnet",
    options: [
      { id: "", label: "기본", hint: "로그인한 계정의 기본 모델을 그대로 씁니다" },
      { id: "opus", label: "Opus", hint: "어려운 설계·디버깅에 강합니다", badges: ["깊은 추론"], resolvedId: "claude-opus-5", price: { inputPerMillion: 5, outputPerMillion: 25 } },
      { id: "sonnet", label: "Sonnet", hint: "대부분의 작업에 균형 잡힌 선택입니다", badges: ["권장"], resolvedId: "claude-sonnet-5", price: { inputPerMillion: 2, outputPerMillion: 10 } },
      { id: "haiku", label: "Haiku", hint: "가장 저렴하고 빠릅니다. 작은 수정에 적합합니다", badges: ["빠름", "저렴"], resolvedId: "claude-haiku-4-5", price: { inputPerMillion: 1, outputPerMillion: 5 } },
    ],
    effort: { supported: true, current: "high", levels: [{ id: "low", label: "낮음", hint: "빠르고 싸게" }, { id: "medium", label: "보통", hint: "균형" }, { id: "high", label: "높음", hint: "느리지만 더 깊게" }, { id: "max", label: "최대", hint: "가장 깊게" }] },
  };

  it("닫힌 첫 그리기는 '모델 · 노력' 버튼만 그린다(팝오버는 열어야 뜬다)", () => {
    const html = renderToStaticMarkup(<ModelPicker picker={claudeCode} disabled={false} onChangeModel={() => undefined} onChangeEffort={() => undefined} />);

    expect(html).toContain("Sonnet · 높음");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="dialog"');
  });

  it("요청을 처리하는 동안에는(disabled) 버튼을 막고 이유를 안내한다", () => {
    const html = renderToStaticMarkup(
      <ModelPicker picker={claudeCode} disabled={true} disabledReason="요청을 처리하는 동안에는 모델을 바꿀 수 없습니다" onChangeModel={() => undefined} onChangeEffort={() => undefined} />,
    );

    expect(html).toMatch(/<button[^>]*disabled=""/);
    expect(html).toContain('title="요청을 처리하는 동안에는 모델을 바꿀 수 없습니다"');
  });

  it("팝오버는 모델마다 이름·설명·배지·단가와 지금 고른 표시를 그린다", () => {
    const html = renderToStaticMarkup(<ModelPickerDialog picker={claudeCode} onChangeModel={() => undefined} onChangeEffort={() => undefined} />);

    expect(html).toContain("Opus");
    expect(html).toContain("깊은 추론");
    expect(html).toContain("권장");
    expect(html).toContain("빠름");
    expect(html).toMatch(/aria-selected="true"[^>]*>[\s\S]*?Sonnet|Sonnet[\s\S]*?aria-selected="true"/);
    expect(html).toContain("$5");
  });

  it("노력 단계는 낮음·보통·높음·최대 네 칸으로 그리고, 지금 고른 값을 표시한다", () => {
    const html = renderToStaticMarkup(<ModelPickerDialog picker={claudeCode} onChangeModel={() => undefined} onChangeEffort={() => undefined} />);

    expect(html).toContain("낮음");
    expect(html).toContain("보통");
    expect(html).toContain("높음");
    expect(html).toContain("최대");
    expect(html).toMatch(/role="radio"[^>]*aria-checked="true"[^>]*>높음/);
  });

  it("노력 단계를 지원하지 않는 백엔드는 네 칸을 disabled로 그리고 이유를 툴팁에 남긴다", () => {
    const demo: ModelPickerView = {
      backend: "demo",
      options: [{ id: "", label: "기본" }],
      effort: { supported: false, levels: [], reason: "이 백엔드는 노력 단계를 지원하지 않습니다" },
    };

    const html = renderToStaticMarkup(<ModelPickerDialog picker={demo} onChangeModel={() => undefined} onChangeEffort={() => undefined} />);

    expect(html.match(/role="radio"[^>]*disabled=""/g)).toHaveLength(4);
    expect(html).toContain("이 백엔드는 노력 단계를 지원하지 않습니다");
  });

  it("목록이 길면(9개 넘게) 검색창을 보여준다", () => {
    const many: ModelPickerView = {
      backend: "commandcode",
      options: [{ id: "", label: "기본" }, ...Array.from({ length: 9 }, (_, i) => ({ id: `m${i}`, label: `모델 ${i}` }))],
      effort: { supported: true, levels: claudeCode.effort.levels },
    };

    const html = renderToStaticMarkup(<ModelPickerDialog picker={many} onChangeModel={() => undefined} onChangeEffort={() => undefined} />);

    expect(html).toContain('placeholder="모델 검색"');
  });

  it("고를 것이 '기본'뿐이면(예: codex) 검색창 없이 목록만 그린다", () => {
    const codex: ModelPickerView = {
      backend: "codex",
      options: [{ id: "", label: "기본" }],
      note: "Codex는 스튜디오가 미리 아는 모델 목록이 없습니다",
      effort: { supported: true, levels: claudeCode.effort.levels },
    };

    const html = renderToStaticMarkup(<ModelPickerDialog picker={codex} onChangeModel={() => undefined} onChangeEffort={() => undefined} />);

    expect(html).not.toContain('placeholder="모델 검색"');
    expect(html).toContain("Codex는 스튜디오가 미리 아는 모델 목록이 없습니다");
  });
});
