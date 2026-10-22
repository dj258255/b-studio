import Link from "next/link";
import { dashboardTabs, tabsWithCurrent, type DashboardTabId } from "@/lib/dashboard-tabs";

/** 대시보드 화면(작업·격자·비교·작업 분해·계정)을 잇는 한 줄 탭(#848). 끝에 개발 화면으로 가는 길을 둔다 */
export function DashboardTabs({ current, experimental, openFolder, className = "mb-4" }: { current: DashboardTabId; experimental: boolean; openFolder: boolean; className?: string }) {
  const tabs = tabsWithCurrent(dashboardTabs({ experimental, openFolder }), current);
  return (
    <nav aria-label="대시보드 화면" className={`${className} flex flex-wrap items-center gap-1 text-sm`}>
      {tabs.map((tab) => (
        <Link
          key={tab.id}
          href={tab.href}
          aria-current={tab.id === current ? "page" : undefined}
          className={`rounded-control px-3 py-1.5 font-medium ${tab.id === current ? "bg-ink text-panel" : "text-muted hover:bg-panel hover:text-ink"}`}
        >
          {tab.label}
        </Link>
      ))}
      <Link href="/" className="ml-auto glass-soft rounded-control px-3 py-1.5 font-medium hover:bg-panel">
        개발 화면으로
      </Link>
    </nav>
  );
}
