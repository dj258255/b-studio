"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function logout() {
    setBusy(true);
    setFailed(false);
    const response = await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    // 로그인 쿠키는 HttpOnly라 화면이 지울 수 없다. 서버가 지우지 못했으면 넘기지 않는다. 넘기면 세션이 살아 있는데 로그아웃된 것처럼 보인다
    if (!response?.ok) {
      setBusy(false);
      setFailed(true);
      return;
    }
    // 쿠키가 지워진 상태로 서버 컴포넌트를 다시 그리게 한다
    router.replace("/login");
    router.refresh();
  }

  return (
    <span className="inline-flex items-center gap-2">
      {failed && (
        <span role="alert" className="text-xs text-fail">
          로그아웃하지 못했습니다. 다시 시도하세요
        </span>
      )}
      <button
        type="button"
        onClick={() => void logout()}
        disabled={busy}
        className="tap-target glass-soft rounded-control px-3 py-1 text-xs font-medium text-muted hover:text-ink disabled:opacity-60"
      >
        {busy ? "로그아웃하는 중" : "로그아웃"}
      </button>
    </span>
  );
}
