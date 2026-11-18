import { describe, expect, it } from 'vitest';
import * as legacy from './public-url-legacy';
import * as current from './public-url';

/**
 * `findPublicUrlRefs`는 Rust(`crates/bstudio-guard/src/public_url.rs`의 `find_refs`)로 옮겼다.
 * 옛 TS(`public-url-legacy.ts`)와 같은 입력에 같은 목록을 내는지 무작위로 견준다.
 */

function makeRandom(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const SERVICES = ['frontend', 'backend', 'a-b', 'x1', '2', '10', '01', '', '한글', 'A'];
const ENV_KEYS = ['NEXT_PUBLIC_API_BASE_URL', 'API_URL', '', 'PORT', '2', 'lower-key', '한글'];
const TEMPLATES = [
  '${b-studio:services.backend.publicUrl}',
  '${b-studio:services.backend.publicUrl}/api',
  'http://backend:8080',
  '${b-studio:services.Backend.publicUrl}',
  '${b-studio:services.a-b.publicUrl}${b-studio:services.x1.publicUrl}',
  '',
  '${BACKEND_PORT:-8080}',
  '${b-studio:services.backend.publicUrl}\n${b-studio:services.x1.publicUrl}',
];
const OTHERS: unknown[] = [null, 0, 1, true, false, [], {}, ['x'], { nested: 'y' }];

describe('findPublicUrlRefs: legacy TS와 Rust가 같다', () => {
  it('무작위 compose services 5000개에서 같은 목록을 낸다', () => {
    const rand = makeRandom(20_261_119);
    const int = (n: number) => Math.floor(rand() * n);
    const pick = <T,>(items: readonly T[]): T => items[int(items.length)]!;
    for (let i = 0; i < 5000; i += 1) {
      const services: Record<string, unknown> = {};
      for (const service of SERVICES) {
        if (rand() < 0.2) continue;
        const kind = int(6);
        if (kind === 0) services[service] = null;
        else if (kind === 1) services[service] = pick(OTHERS);
        else {
          const environment =
            int(2) === 0
              ? Object.fromEntries(Array.from({ length: int(4) }, () => [pick(ENV_KEYS), rand() < 0.8 ? pick(TEMPLATES) : pick(OTHERS)]))
              : Array.from({ length: int(4) }, () =>
                  int(4) === 0 ? pick(OTHERS) : `${pick(ENV_KEYS)}=${pick(TEMPLATES)}`,
                );
          services[service] = { environment, ...(rand() < 0.3 ? { build: './x' } : {}) };
        }
      }
      const label = JSON.stringify(services);
      let expected: unknown;
      let expectedError: unknown;
      try {
        expected = legacy.findPublicUrlRefs(services);
      } catch (error) {
        expectedError = error;
      }
      let actual: unknown;
      let actualError: unknown;
      try {
        actual = current.findPublicUrlRefs(services);
      } catch (error) {
        actualError = error;
      }
      if (expectedError) {
        expect(actualError, label).toBeInstanceOf(Error);
      } else {
        expect(actualError, label).toBeUndefined();
        expect(actual, label).toEqual(expected);
      }
    }
  });

  it('경계값: environment가 배열일 때 "="만 있거나 없는 항목, 중복 키, 같은 값의 자리 표시자 둘', () => {
    const cases: Record<string, unknown>[] = [
      {},
      { a: {} },
      { a: { environment: null } },
      { a: { environment: 'ENV=1' } },
      { a: { environment: ['', '=', '=x', 'x=', 'x=y=z', 1, null, {}] } },
      { a: { environment: { A: '${b-studio:services.b.publicUrl}', B: '${b-studio:services.c.publicUrl}', C: 0, D: null } } },
      { '2': { environment: { A: '${b-studio:services.b.publicUrl}' } }, '1': { environment: { B: '${b-studio:services.c.publicUrl}' } } },
      { '': { environment: { '': '${b-studio:services.b.publicUrl}' } } },
    ];
    for (const services of cases) {
      expect(current.findPublicUrlRefs(services), JSON.stringify(services)).toEqual(legacy.findPublicUrlRefs(services));
    }
  });
});
