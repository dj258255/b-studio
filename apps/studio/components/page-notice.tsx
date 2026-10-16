import Link from "next/link";
import type { ReactNode } from "react";

/**
 * 없는 주소·없는 세션·화면 오류처럼 본문을 그릴 수 없을 때 쓰는 안내. 무엇이 없는지 한 줄로 알리고
 * 개발 화면(첫 화면)과 작업 목록으로 돌아갈 링크를 둔다.
 */
export function PageNotice({ title, tabTitle, children, actions }: { title: string; tabTitle?: string; children?: ReactNode; actions?: ReactNode }) {
  return (
    <main className="mx-auto max-w-xl px-4 py-24 sm:px-6">
      {tabTitle && <title>{`${tabTitle} · b-studio`}</title>}
      <p className="text-sm font-semibold text-muted">b-studio</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">{title}</h1>
      {children && <div className="mt-2 text-sm leading-6 text-muted">{children}</div>}
      <div className="mt-6 flex flex-wrap items-center gap-2">
        {actions}
        <Link href="/" className="rounded-control bg-ink px-4 py-2 text-sm font-medium text-panel hover:bg-ink/85">
          개발 화면으로
        </Link>
        <Link href="/work" className="glass-soft rounded-control px-4 py-2 text-sm font-medium hover:bg-panel">
          작업 목록
        </Link>
      </div>
    </main>
  );
}
