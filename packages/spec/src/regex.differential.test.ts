import { describe, expect, it } from 'vitest';
import * as legacy from './schema-legacy';
import * as current from './schema';

/**
 * Zod 정규식은 JS 의미(`\w`·`\d`·`\s`·`/i`)를 쓴다. Rust `regex`와 다른 입력을 무작위로 찾아,
 * 필드마다 legacy Zod와 같은 판정을 내는지 확인한다(허용 목록이 넓어지면 범위 밖이 통과한다).
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

const ALPHABET = ['a', 'Z', '0', '9', '-', '_', '.', '+', '/', '\\', ' ', '\t', '\n', '\r', '한', 'é', 'ſ', 'İ', '😀', '\u0000', '\u001f', '\u007f', '\u00a0', '\u2028', '\ufeff', ':', '*', '$', '#', '?', '..', 'http://', 'https://', 'postgres'];

function result(schema: { safeParse: (value: unknown) => any }, input: unknown) {
  const parsed = schema.safeParse(input);
  return parsed.success ? { ok: true } : { ok: false, issues: parsed.error.issues.map((issue: any) => ({ path: [...issue.path], message: issue.message })) };
}

describe('schema 정규식: legacy Zod와 Rust가 같은 판정을 낸다', () => {
  const rand = makeRandom(20_261_126);
  const int = (n: number) => Math.floor(rand() * n);
  const pick = <T,>(items: readonly T[]): T => items[int(items.length)]!;
  const randomString = () => Array.from({ length: int(14) }, () => pick(ALPHABET)).join('');

  const fields: Array<[string, any, any, (value: string) => unknown]> = [
    ['name', legacy.StudioSpecSchema, current.StudioSpecSchema, (s) => ({ version: 1, name: s, services: { web: { source: 'managed', template: 'x', path: 'x', port: 1, preview: 'browser' } } })],
    ['volume', legacy.SnapshotSchema, current.SnapshotSchema, (s) => ({ volume: s, key: ['x'] })],
    ['ready.path', legacy.ManagedServiceSchema, current.ManagedServiceSchema, (s) => ({ source: 'managed', template: 'x', path: 'x', port: 1, preview: 'browser', ready: { path: s } })],
    ['contract.extract', legacy.ManagedServiceSchema, current.ManagedServiceSchema, (s) => ({ source: 'managed', template: 'x', path: 'x', port: 1, preview: 'browser', contract: { extract: s } })],
    ['relative path', legacy.SnapshotSchema, current.SnapshotSchema, (s) => ({ volume: 'v', key: [s] })],
    ['deploy dockerfile', legacy.DeploySchema, current.DeploySchema, (s) => ({ services: { web: { dockerfile: s } } })],
    ['project relative', legacy.StudioSpecSchema, current.StudioSpecSchema, (s) => ({ version: 1, name: 'x', services: { web: { source: 'managed', template: 'x', path: 'x', port: 1, preview: 'browser', includes: [s] } } })],
    ['path pattern', legacy.PolicyRuleSchema, current.PolicyRuleSchema, (s) => ({ callers: ['studio'], methods: ['GET'], paths: [s] })],
    ['egress host', legacy.EgressRuleSchema, current.EgressRuleSchema, (s) => s],
    ['egress host object', legacy.EgressRuleSchema, current.EgressRuleSchema, (s) => ({ host: s })],
    ['header', legacy.ExternalPolicySchema, current.ExternalPolicySchema, (s) => ({ auth: { header: s, secret: 'TOKEN' } })],
    ['env name', legacy.ExternalPolicySchema, current.ExternalPolicySchema, (s) => ({ auth: { header: 'X', secret: s } })],
    ['memory', legacy.ResourceLimitSchema, current.ResourceLimitSchema, (s) => ({ memory: s })],
    ['sql identifier', legacy.DatabaseSchema, current.DatabaseSchema, (s) => ({ engine: 'postgres', database: s, user: 'app' })],
    ['system package', legacy.ManagedServiceSchema, current.ManagedServiceSchema, (s) => ({ source: 'managed', template: 'x', path: 'x', port: 1, preview: 'browser', systemPackages: [s] })],
    ['figma url', legacy.DesignSchema, current.DesignSchema, (s) => ({ figma: { fileUrl: s } })],
    ['sample param key', legacy.AutoPageChecksSchema, current.AutoPageChecksSchema, (s) => ({ service: 'web', sampleParams: { [s]: 'x' } })],
    ['secret key', legacy.StudioSpecSchema, current.StudioSpecSchema, (s) => ({ version: 1, name: 'x', services: { web: { source: 'managed', template: 'x', path: 'x', port: 1, preview: 'browser' } }, secrets: { [s]: { services: [] } } })],
  ];

  it('무작위 글자 8000개 × 필드 18개에서 결과가 같다', () => {
    for (let i = 0; i < 8000; i += 1) {
      const value = randomString();
      for (const [label, a, b, make] of fields) {
        const input = make(value);
        expect(result(b, input), `${label} ${JSON.stringify(value)}`).toEqual(result(a, input));
      }
    }
  });
});
