/**
 * 샌드박스와의 연결 상태(트러블슈팅 123). 세션 상태는 "준비됨"으로 남아 있는데 도커에 닿지 않거나 컨테이너가 사라진 경우를 화면이
 * 사실대로 말하게 한다. 값이 없으면 문제없음이다.
 *  - unreachable: 도커에 물어도 답이 없거나 오류가 난다(소켓이 끊김, 도커가 꺼짐, 응답 없음)
 *  - missing: 도커는 답하는데 이 세션의 컨테이너가 하나도 없다(도커를 다시 띄운 뒤 등)
 */
export interface SandboxLink {
  state: 'unreachable' | 'missing';
  /** 처음 그렇게 본 시각 */
  since: string;
  /** 사람이 읽을 사유(도커가 낸 문구 등). 길이를 묶어 둔다 */
  reason: string;
}

/** 사용량 측정 한 번의 결과: 읽었으면 컨테이너 수, 못 읽었으면 사유 */
export type SandboxProbe = { ok: true; containers: number } | { ok: false; reason: string };

export interface SandboxLinkTracker {
  failures: number;
  empties: number;
  /** 연속된 실패·빈 목록이 시작된 시각 */
  since?: string;
  link?: SandboxLink;
}

/** 한 번의 실패나 빈 목록으로 상태를 바꾸지 않는다. 서비스를 다시 올리는 동안 컨테이너가 잠깐 없거나 도커가 한 번 늦게 답할 수 있다 */
export const SANDBOX_LINK_THRESHOLD = 2;
const MAX_REASON_LENGTH = 200;

export function newSandboxLinkTracker(): SandboxLinkTracker {
  return { failures: 0, empties: 0 };
}

/**
 * 측정 결과 하나를 받아 다음 상태를 낸다. `ready`는 세션이 "준비됨"인지 — 기동 중이거나 멈춘 세션에서 컨테이너가 없는 것은 정상이라
 * 빈 목록을 문제로 세지 않는다. 읽지 못한 것(실패)은 세션 상태와 무관하게 센다
 */
export function advanceSandboxLink(tracker: SandboxLinkTracker, probe: SandboxProbe, now: string, ready: boolean): SandboxLinkTracker {
  if (!probe.ok) {
    const failures = tracker.failures + 1;
    const since = tracker.failures > 0 && tracker.since ? tracker.since : now;
    const reason = probe.reason.trim().split('\n')[0]!.slice(0, MAX_REASON_LENGTH) || '도커가 응답하지 않습니다';
    return { failures, empties: 0, since, ...(failures >= SANDBOX_LINK_THRESHOLD ? { link: { state: 'unreachable', since, reason } } : tracker.link ? { link: tracker.link } : {}) };
  }
  if (probe.containers === 0 && ready) {
    const empties = tracker.empties + 1;
    const since = tracker.empties > 0 && tracker.since ? tracker.since : now;
    return {
      failures: 0,
      empties,
      since,
      ...(empties >= SANDBOX_LINK_THRESHOLD ? { link: { state: 'missing', since, reason: '이 세션의 컨테이너가 하나도 없습니다' } } : tracker.link?.state === 'missing' ? { link: tracker.link } : {}),
    };
  }
  // 컨테이너가 보이거나, 준비됨이 아닌 세션이다: 문제없음으로 되돌린다
  return newSandboxLinkTracker();
}

/** 두 연결 상태가 화면에 같은 것으로 보이는지(같으면 이벤트를 다시 보내지 않는다) */
export function sameSandboxLink(a: SandboxLink | undefined, b: SandboxLink | undefined): boolean {
  return a?.state === b?.state && a?.since === b?.since && a?.reason === b?.reason;
}

/** 헤더에 보일 한 줄 */
export function describeSandboxLink(link: SandboxLink): string {
  return link.state === 'unreachable' ? '샌드박스에 닿지 않습니다' : '샌드박스 컨테이너가 없습니다';
}
