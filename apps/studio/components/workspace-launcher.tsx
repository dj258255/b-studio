"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

type Opened = { id: string; projectId: string; action: "opened" | "booting" | "resumed" | "created" };

// React 개발 모드는 효과를 두 번 실행한다. 같은 화면에서 개발 세션을 두 번 열지 않도록 요청 하나를 나눠 쓴다(서버도 한 번에 하나만 연다)
let pending: { key: string; promise: Promise<Opened> } | undefined;

function openOnce(projectId: string | undefined): Promise<Opened> {
  const key = projectId ?? "";
  if (pending?.key === key) return pending.promise;
  const promise = fetch("/api/workspace", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(projectId ? { projectId } : {}),
  }).then(async (response) => {
    const body = (await response.json().catch(() => ({}))) as Partial<Opened> & { error?: string };
    if (!response.ok || !body.id) throw new Error(body.error ?? "개발 화면을 열지 못했습니다");
    return body as Opened;
  });
  pending = { key, promise };
  // 끝나면 비워 둔다. 나중에 첫 화면으로 다시 오면 그때의 상태로 다시 고른다
  promise.finally(() => {
    if (pending?.promise === promise) pending = undefined;
  }).catch(() => undefined);
  return promise;
}

/** 개발 세션을 열고 그 화면으로 넘어간다. 실패하면 이유와 처음 화면으로 돌아가는 링크를 보여 준다 */
export function WorkspaceLauncher({ projectId }: { projectId?: string }) {
  const router = useRouter();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    openOnce(projectId)
      .then((opened) => {
        if (!cancelled) router.replace(`/sessions/${opened.id}`);
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : String(reason));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, router]);

  return (
    <main className="mx-auto flex min-h-dvh max-w-xl flex-col justify-center px-6 py-16">
      <p className="text-sm font-semibold text-muted">b-studio</p>
      {error ? (
        <>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">개발 화면을 열지 못했습니다</h1>
          <p role="alert" className="mt-3 text-sm leading-6 text-fail">
            {error}
          </p>
          <div className="mt-6 flex flex-wrap gap-3">
            <button type="button" onClick={() => location.reload()} className="rounded-control bg-ink px-4 py-2 text-sm font-semibold text-panel hover:bg-ink/85">
              다시 시도
            </button>
            <Link href="/" className="glass-soft rounded-control px-4 py-2 text-sm font-medium hover:bg-panel">
              처음 화면으로
            </Link>
          </div>
        </>
      ) : (
        <>
          <h1 className="mt-2 text-2xl font-semibold tracking-tight">개발 화면을 여는 중</h1>
          <p className="mt-3 text-sm leading-6 text-muted" aria-live="polite">
            마지막 프로젝트를 열고 샌드박스를 켭니다. 켜는 동안 요청을 적을 수 있습니다. 다른 프로젝트로 시작하려면 열린 뒤 머리의 프로젝트 이름을 누르세요.
          </p>
        </>
      )}
    </main>
  );
}
