import { describe, expect, it } from 'vitest';
import { dashboardTabs } from './dashboard-tabs';

/** 대시보드 화면을 잇는 한 줄 탭(#848). 실험 화면은 실험 기능을 켰을 때만, 계정은 개인 PC 모드에서만 둔다 */
describe('dashboardTabs', () => {
  it('기본은 작업 탭 하나다', () => {
    expect(dashboardTabs({ experimental: false, openFolder: false }).map((tab) => tab.id)).toEqual(['work']);
  });

  it('실험 기능을 켜면 격자·비교·작업 분해가 작업 다음에 온다', () => {
    expect(dashboardTabs({ experimental: true, openFolder: false }).map((tab) => [tab.id, tab.href, tab.label])).toEqual([
      ['work', '/work', '작업'],
      ['split', '/split', '격자'],
      ['fleets', '/fleets', '비교'],
      ['task-plans', '/task-plans', '작업 분해'],
    ]);
  });

  it('개인 PC 모드면 계정 탭이 끝에 붙는다', () => {
    expect(dashboardTabs({ experimental: true, openFolder: true }).at(-1)).toEqual({ id: 'accounts', href: '/accounts', label: '계정' });
    expect(dashboardTabs({ experimental: false, openFolder: true }).map((tab) => tab.id)).toEqual(['work', 'accounts']);
  });
});
