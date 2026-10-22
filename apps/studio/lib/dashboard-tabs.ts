/**
 * 대시보드 화면을 잇는 한 줄 탭(#848, ADR-184). 주소와 화면 내용은 그대로 두고 오가는 길만 하나로 맞춘다.
 * 격자·비교·작업 분해는 실험 기능이라(ADR-166) 켰을 때만, 계정 연결은 개인 PC 모드에서만 둔다
 */
export type DashboardTabId = 'work' | 'split' | 'fleets' | 'task-plans' | 'accounts';

export interface DashboardTab {
  id: DashboardTabId;
  href: string;
  label: string;
}

const TABS: Record<DashboardTabId, DashboardTab> = {
  work: { id: 'work', href: '/work', label: '작업' },
  split: { id: 'split', href: '/split', label: '격자' },
  fleets: { id: 'fleets', href: '/fleets', label: '비교' },
  'task-plans': { id: 'task-plans', href: '/task-plans', label: '작업 분해' },
  accounts: { id: 'accounts', href: '/accounts', label: '계정' },
};

export function dashboardTabs(input: { experimental: boolean; openFolder: boolean }): DashboardTab[] {
  return [
    TABS.work,
    ...(input.experimental ? [TABS.split, TABS.fleets, TABS['task-plans']] : []),
    ...(input.openFolder ? [TABS.accounts] : []),
  ];
}

/** 지금 화면이 목록에 없을 때(실험 기능을 끈 채 그 주소를 직접 열었을 때) 그 탭을 제자리에 끼운다 */
export function tabsWithCurrent(tabs: readonly DashboardTab[], current: DashboardTabId): DashboardTab[] {
  if (tabs.some((tab) => tab.id === current)) return [...tabs];
  const order = Object.keys(TABS) as DashboardTabId[];
  return [...tabs, TABS[current]].sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
}
