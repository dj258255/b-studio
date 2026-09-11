"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function LoginForm({ next }: { next: string }) {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit() {
    setBusy(true);
    setError(undefined);
    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (response.ok) {
      // 새 쿠키로 서버 컴포넌트를 다시 그리게 한다
      router.replace(next);
      router.refresh();
      return;
    }
    setError(((await response.json().catch(() => ({}))) as { error?: string }).error ?? "로그인하지 못했습니다");
    setBusy(false);
  }

  return (
    <form
      className="glass mt-6 space-y-3 rounded-2xl p-5"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label htmlFor="token" className="block text-sm font-medium">
        접근 토큰
      </label>
      <input
        id="token"
        type="password"
        autoComplete="current-password"
        value={token}
        onChange={(event) => setToken(event.target.value)}
        className="w-full rounded-xl border border-line bg-panel px-3 py-2 font-mono text-sm"
      />
      <button
        type="submit"
        disabled={busy || !token}
        className="w-full rounded-full bg-ink px-4 py-2 text-sm font-medium text-panel shadow-sm hover:bg-ink/85 disabled:opacity-50"
      >
        {busy ? "확인하는 중" : "로그인"}
      </button>
      {error && (
        <p role="alert" className="text-sm text-fail">
          {error}
        </p>
      )}
    </form>
  );
}
