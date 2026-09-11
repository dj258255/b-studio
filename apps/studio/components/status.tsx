import type { ServiceState, SessionStatus } from "@/lib/studio-events";

export type Tone = "pass" | "fail" | "wait" | "idle";

export const SESSION_STATUS_LABEL: Record<SessionStatus, string> = {
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
