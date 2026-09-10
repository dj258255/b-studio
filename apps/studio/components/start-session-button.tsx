"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function StartSessionButton({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string>();

  async function start() {
    setStarting(true);
    setError(undefined);
    const response = await fetch("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ projectId }),
    });
    const data = await response.json();
    if (!response.ok) {
      setError(data.error ?? "샌드박스를 시작하지 못했습니다");
      setStarting(false);
      return;
    }
    router.push(`/sessions/${data.id}`);
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={start}
        disabled={starting}
        className="rounded-md bg-ink px-4 py-2 text-sm font-medium text-panel hover:bg-ink/85 disabled:opacity-60"
      >
        {starting ? "복사본 만드는 중" : "샌드박스 시작"}
      </button>
      {error && <p className="text-sm text-fail">{error}</p>}
    </div>
  );
}
