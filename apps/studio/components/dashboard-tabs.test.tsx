import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DashboardTabs } from './dashboard-tabs';

/** 탭 링크 하나(<a ...>글</a>)의 속성 묶음을 찾는다. 속성 순서에 기대지 않는다 */
function tabAnchor(html: string, href: string): string | undefined {
  return html.match(new RegExp(`<a[^>]*href="${href.replace(/\//g, '\\/')}"[^>]*>`))?.[0];
}

describe('DashboardTabs', () => {
  it('지금 화면을 표시하고 다른 화면과 개발 화면으로 가는 길을 둔다', () => {
    const html = renderToStaticMarkup(<DashboardTabs current="fleets" experimental openFolder={false} />);
    expect(html).toContain('aria-label="대시보드 화면"');
    expect(tabAnchor(html, '/fleets')).toContain('aria-current="page"');
    expect(tabAnchor(html, '/work')).toBeDefined();
    expect(tabAnchor(html, '/work')).not.toContain('aria-current');
    expect(html).toMatch(/href="\/"[^>]*>개발 화면으로</);
    expect(html).not.toContain('href="/accounts"');
  });

  it('지금 화면이 탭에 없으면(실험 기능을 끈 채 실험 화면을 열었을 때) 그 화면도 탭으로 보여 현재로 표시한다', () => {
    const html = renderToStaticMarkup(<DashboardTabs current="split" experimental={false} openFolder={false} />);
    expect(tabAnchor(html, '/split')).toContain('aria-current="page"');
  });
});
