import { describe, expect, it } from 'vitest';
import { buildOverride } from './docker/format';
import { edgeEnvironment } from './edge-config';
import type { LoadedProject } from '@b-studio/spec';
import { decodeNative, encodeNative } from './native';

describe('Rust 경계의 JSON(encodeNative·decodeNative)', () => {
  it('유한하지 않은 수와 -0은 표시 객체로 오가고 되돌아온다', () => {
    const value = { a: NaN, b: Infinity, c: -Infinity, d: -0, e: [1, NaN] };
    const back = decodeNative<typeof value>(encodeNative(value));
    expect(back.a).toBeNaN();
    expect(back.b).toBe(Infinity);
    expect(back.c).toBe(-Infinity);
    expect(Object.is(back.d, -0)).toBe(true);
    expect(back.e[1]).toBeNaN();
  });

  it('데이터의 NUL로 시작하는 키는 표시 객체를 흉내 내지 못하게 던진다', () => {
    expect(() => encodeNative({ cpus: { '\u0000nf': 'Infinity' } })).toThrow(/NUL/);
    expect(() => encodeNative([{ '\u0000x': 1 }])).toThrow(/NUL/);
    expect(encodeNative({ 'a\u0000': 1 })).toBe('{"a\\u0000":1}');
  });
});

describe('override 입력도 경계 규칙을 거친다', () => {
  const project = (cpus: unknown) =>
    ({ managed: [['web', { port: 3000 }]], composeServices: ['web'], resources: { web: { cpus } } }) as unknown as LoadedProject;

  it('표시 객체 꼴의 값은 수로 읽히지 않고 거절된다', () => {
    expect(() => buildOverride(project({ '\u0000nf': 'Infinity' }), 's1')).toThrow(/NUL/);
  });

  it('유한하지 않은 cpus는 null로 바뀌지 않고 옛 TS처럼 수로 간다(Infinity는 옛 TS가 "Infinity"로 적었다, NaN은 거짓이라 뺐다)', () => {
    expect(buildOverride(project(Infinity), 's1').services.web!.deploy).toEqual({ resources: { limits: { cpus: 'Infinity' } } });
    expect(buildOverride(project(NaN), 's1').services.web!.deploy).toEqual({ resources: { limits: {} } });
  });

  it('edge 설정도 같은 규칙을 거친다', () => {
    const external = [['users', { source: 'external', baseUrl: 'https://u.example.com', policy: { mask: [], maskPatterns: [], allow: [], '\u0000nf': 'Infinity' } }]];
    const edgeProject = { managed: [['web', { port: 3000 }]], external } as unknown as LoadedProject;
    expect(() => edgeEnvironment(edgeProject, ['web'])).toThrow(/NUL/);
  });
});
