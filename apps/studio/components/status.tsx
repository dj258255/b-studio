import type { ServiceState, SessionMode, SessionStatus } from "@/lib/studio-events";

export type Tone = "pass" | "fail" | "wait" | "idle";

/** 세션·Fleet 멤버가 도는 백엔드의 사람이 읽는 이름. 세션 헤더와 Fleet 카드가 함께 쓴다 */
export const SESSION_BACKEND_LABEL: Record<SessionMode, string> = {
  api: "Claude API",
  "claude-code": "로컬 Claude Agent",
  codex: "로컬 ChatGPT Agent",
  commandcode: "로컬 Command Code Agent",
  opencode: "로컬 OpenCode Agent",
  demo: "데모 모드",
};

export const SESSION_STATUS_LABEL: Record<SessionStatus, string> = {
  idle: "대기(샌드박스 꺼짐)",
  starting: "샌드박스 준비 중",
  ready: "준비됨",
  failed: "시작 실패",
  stopped: "중지됨",
};

export const SERVICE_STATE_LABEL: Record<ServiceState, string> = {
  starting: "빌드 중",
  probing: "준비 확인 중",
  ready: "준비됨",
  failed: "실패",
  stopped: "중지됨",
};

export function toneOfService(state: ServiceState): Tone {
  if (state === "ready") return "pass";
  if (state === "failed") return "fail";
  if (state === "stopped") return "idle";
  return "wait";
}

const DOT: Record<Tone, string> = {
  pass: "bg-pass",
  fail: "bg-fail",
  wait: "border-2 border-wait bg-panel motion-safe:animate-pulse",
  idle: "bg-line",
};

export const TONE_TEXT: Record<Tone, string> = {
  pass: "text-pass",
  fail: "text-fail",
  wait: "text-wait",
  idle: "text-muted",
};

/** 색만으로 상태를 전하지 않도록 항상 옆에 글자를 함께 둔다 */
export function Dot({ tone }: { tone: Tone }) {
  return <span aria-hidden className={`inline-block size-2.5 shrink-0 rounded-full ${DOT[tone]}`} />;
}
