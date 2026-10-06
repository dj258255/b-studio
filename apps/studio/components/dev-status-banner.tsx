"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export interface DevStatusResponse {
  active: boolean;
  bootHead?: string;
  headNow?: string;
  codeChanged?: boolean;
  lockfileChanged?: boolean;
}

/** 포커스가 다시 올 때마다 확인하되, 이 간격보다 자주는 다시 묻지 않는다 — 공격적으로 폴링하지 않는다 */
const MIN_CHECK_INTERVAL_MS = 60_000;

/**
 * 개발 서버(로컬 `next dev`)의 코드가 켤 때와 달라졌으면 알려주는 배너. 운영 빌드에서는 서버가 항상
 * `{ active: false }`를 돌려주므로 아무것도 그리지 않는다. 데스크톱 앱(apps/desktop/src/main.ts의
 * `warnIfRoutesAreStale`)과 같은 결로, 창(탭)이 포커스를 받을 때만 확인한다(최소 침습).
 */
export function DevStatusBanner() {
  const [status, setStatus] = useState<DevStatusResponse | undefined>();
  const [dismissedHead, setDismissedHead] = useState<string | undefined>();
  const lastCheckedAt = useRef(0);

  const check = useCallback(() => {
    const now = Date.now();
    if (now - lastCheckedAt.current < MIN_CHECK_INTERVAL_MS) return;
    lastCheckedAt.current = now;
    fetch("/api/dev-status")
      .then((response) => (response.ok ? (response.json() as Promise<DevStatusResponse>) : undefined))
      .then((data) => {
        if (data) setStatus(data);
      })
      .catch(() => {
        // 확인 자체가 실패해도(네트워크 순간 끊김 등) 배너는 참고용이라 그냥 넘어간다
      });
  }, []);

  useEffect(() => {
    check();
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, [check]);

  return <DevStatusBannerView status={status} dismissedHead={dismissedHead} onDismiss={setDismissedHead} />;
}

/**
 * 실제로 그리는 부분만 떼어 둔다(테스트가 fetch·effect 없이 상태만 넣어 확인할 수 있게, AccountCard와 같은 결).
 * 데스크톱 셸에 "다시 시작" IPC가 아직 없어(content-preload.ts가 여는 통로는 pickFolder뿐이다) 버튼은
 * 두지 않고 글로만 안내한다 — 그 통로가 생기면 여기에 버튼을 더한다.
 */
export function DevStatusBannerView({
  status,
  dismissedHead,
  onDismiss,
}: {
  status: DevStatusResponse | undefined;
  dismissedHead: string | undefined;
  onDismiss: (head: string | undefined) => void;
}) {
  if (!status?.active || !status.codeChanged || status.headNow === dismissedHead) return null;

  // 머리 줄(제목·프로젝트 이름·서비스 상태·중지 버튼)은 각 페이지에서 일반 문서 흐름의 맨 위를 차지한다(트러블슈팅 #89).
  // 배너가 `fixed`로 그 자리 위에 떠 있으면 문서 흐름에서 빠져 공간을 차지하지 않아 머리 줄과 같은 자리를 다퉈 글자가
  // 겹친다. `sticky`로 바꾸면 body의 첫 자식으로 자기 높이만큼 공간을 차지해 머리 줄을 그 아래로 밀어내면서(일반 흐름
  // 안에 있으므로 작업 목록 페이지 같은 곳의 `fixed bottom-4` 토스트(work-overview.tsx)와도 자리를 다투지 않는다),
  // 스크롤해도 화면 위에 그대로 붙어 있어 알림을 놓치지 않는다
  return (
    <div
      role="status"
      className="sticky top-0 z-50 flex items-center justify-between gap-3 border-b border-wait/40 bg-wait/10 px-4 py-2 text-sm text-wait"
    >
      <p>
        b-studio 코드가 바뀌었습니다({status.bootHead}→{status.headNow}). 진행 중인 작업이 끝나면 앱을 다시 시작하세요.
        {status.lockfileChanged ? " 의존성도 바뀌어 다시 시작할 때 설치합니다." : ""}
      </p>
      <button
        type="button"
        onClick={() => onDismiss(status.headNow)}
        aria-label="닫기"
        className="shrink-0 rounded-control px-2 py-1 text-xs hover:bg-wait/15"
      >
        닫기
      </button>
    </div>
  );
}
