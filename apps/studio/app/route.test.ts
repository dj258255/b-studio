import { describe, expect, it } from 'vitest';
import { GET } from './route';

describe('GET / (화면 없음)', () => {
  it('웹 화면이 없다는 것과 터미널 작업대로 여는 법을 JSON으로 알린다(404)', async () => {
    const response = GET();
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(await response.json()).toEqual({ app: 'b-studio', error: '웹 화면은 없습니다. 터미널에서 pnpm studio로 엽니다' });
  });
});
