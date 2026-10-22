import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { DeskHint } from './desk-hint';

describe('DeskHint(#848)', () => {
  it('터미널에서 여러 AI를 나란히 쓰는 명령을 한 줄로 알린다', () => {
    const html = renderToStaticMarkup(<DeskHint />);
    expect(html).toContain('pnpm studio desk');
    expect(html).toContain('터미널');
  });
});
