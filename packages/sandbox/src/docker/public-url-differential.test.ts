import { publicUrlPlaceholder, resolvePublicUrlPlaceholders } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import { native } from '../native';

/**
 * 공개 URL 자리 표시자를 읽는 규칙은 두 곳에 있다(ADR-191 2단계 2b-2a): `@b-studio/spec`의 TS(`public-url.ts`, 프로젝트를 불러올 때 찾는다)와
 * Rust(`crates/bstudio-guard/src/public_url.rs`, compose override를 만들 때 채운다). spec은 sandbox의 네이티브 모듈을 부를 수 없어 한 벌로 합치지 못했다.
 * 두 구현이 같은 글자를 같게 읽는지 무작위 입력으로 묶는다. 한쪽 규칙을 바꾸면 이 테스트가 먼저 실패한다.
 */

// mulberry32: 시드가 같으면 늘 같은 입력이 나온다
function makeRandom(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

const SERVICES = ['backend', 'api', 'a-b', 'x1', 'z', 'web', 'Api', '1a', 'a_b', 'é', '', 'a.b', 'a-', '-a', 'backend', 'api'];
const NOISE = ['', ' ', '$', '$$', '{}', '${A:-1}', '${b-studio:services.', '.publicUrl}', '${b-studio:services.api.publicUrl', '${B-studio:services.api.publicUrl}', '${b-studio:services.api.publicurl}', '/v1', '日本', '\n', '😀'];

describe('공개 URL 자리 표시자: spec의 TS와 Rust가 같게 읽는다', () => {
  it('무작위 입력 2만 개에서 채운 결과가 같다', () => {
    const rand = makeRandom(20_261_106);
    const int = (n: number) => Math.floor(rand() * n);
    const pick = <T>(items: readonly T[]): T => items[int(items.length)]!;
    let replaced = 0;
    let untouched = 0;
    let withMissingPort = 0;
    for (let i = 0; i < 20_000; i += 1) {
      const pieces = Array.from({ length: int(5) }, () => (rand() < 0.5 ? `\${b-studio:services.${pick(SERVICES)}.publicUrl}` : pick(NOISE)));
      const value = pieces.join(pick(['', ' ', '/']));
      const ports: Record<string, number> = {};
      for (const service of Array.from({ length: 1 + int(5) }, () => pick(SERVICES))) ports[service] = pick([0, 80, 3000, 65_535]);
      const expected = resolvePublicUrlPlaceholders(value, (service) => (Object.hasOwn(ports, service) ? `http://127.0.0.1:${ports[service]}` : publicUrlPlaceholder(service)));
      expect(native.resolvePublicUrlPlaceholders(value, JSON.stringify(ports)), JSON.stringify({ value, ports })).toBe(expected);
      if (expected === value) untouched += 1;
      else replaced += 1;
      if (pieces.some((p) => p.startsWith('${b-studio:services.') && !Object.hasOwn(ports, p.slice('${b-studio:services.'.length, -'.publicUrl}'.length)))) withMissingPort += 1;
    }
    // 입력이 한쪽으로 쏠리지 않았는지: 바뀐 값과 그대로인 값, 포트가 없는 참조가 모두 충분히 있다
    expect(replaced).toBeGreaterThan(2000);
    expect(untouched).toBeGreaterThan(2000);
    expect(withMissingPort).toBeGreaterThan(2000);
  });

  it('자리 표시자 글자를 만드는 쪽도 같다: 만든 글자를 두 구현이 같게 읽는다', () => {
    for (const service of SERVICES) {
      const text = publicUrlPlaceholder(service);
      const expected = resolvePublicUrlPlaceholders(text, () => 'http://127.0.0.1:1');
      expect(native.resolvePublicUrlPlaceholders(text, JSON.stringify({ [service]: 1 }))).toBe(Object.hasOwn({ [service]: 1 }, service) ? expected : text);
    }
  });
});
