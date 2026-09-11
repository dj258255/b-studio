"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function LogoutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  async function logout() {
    setBusy(true);
    await fetch("/api/auth/logout", { method: "POST" }).catch(() => undefined);
    // 쿠키가 지워진 상태로 서버 컴포넌트를 다시 그리게 한다
    router.replace("/login");
    router.refresh();
  }

  return (
    <button
      type="button"
      onClick={() => void logout()}
      disabled={busy}
      className="glass-soft rounded-full px-3 py-1 text-xs font-medium text-muted hover:text-ink disabled:opacity-60"
    >
      {busy ? "로그아웃하는 중" : "로그아웃"}
    </button>
  );
}
