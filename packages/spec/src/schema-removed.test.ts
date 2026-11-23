import { describe, expect, it } from 'vitest';
import * as current from './schema';

/**
 * 지운 studio.yaml 항목(`deploy`, `design`, `pageChecks[].compare`)을 스키마가 까닭과 함께 거절하는지 본다.
 * 옛 Zod 사본과 견주던 시험(`schema.differential.test.ts`)에서 사본과 무관한 부분만 남긴 것이다(#1347).
 */

function normalized(result: { success: boolean; data?: unknown; error?: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> } }) {
  return result.success ? { ok: true, data: result.data } : { ok: false, issues: result.error!.issues.map((issue) => ({ path: [...issue.path], message: issue.message })) };
}

const BASE = {
  version: 1,
  name: 'orders',
  services: { web: { source: 'managed', template: 'nextjs', path: 'web', port: 3000, preview: 'browser' } },
};

describe('schema: 지운 studio.yaml 항목을 거절한다', () => {
  const removed = '`deploy`는 더는 지원하지 않습니다. 이 항목을 지우세요';

  it('deploy 절은 지우라고 거절한다', () => {
    const input = { ...BASE, deploy: { services: { web: { dockerfile: 'Dockerfile', port: 8300 } } } };
    expect(normalized(current.StudioSpecSchema.safeParse(input))).toEqual({ ok: false, issues: [{ path: ['deploy'], message: removed }] });
  });

  it('deploy.dockerfile에 어떤 글자가 와도 지우라고 거절한다', () => {
    for (const dockerfile of ['Dockerfile', '../Dockerfile', '', '\u0000', 'a b', 'Dockerfile ']) {
      const input = { ...BASE, deploy: { services: { web: { dockerfile } } } };
      expect(normalized(current.StudioSpecSchema.safeParse(input))).toEqual({ ok: false, issues: [{ path: ['deploy'], message: removed }] });
    }
  });

  it('design은 까닭과 함께 거절한다(ADR-221)', () => {
    const input = { ...BASE, design: { figma: { fileUrl: 'https://www.figma.com/design/abc/x' } } };
    expect(normalized(current.StudioSpecSchema.safeParse(input))).toEqual({
      ok: false,
      issues: [{ path: ['design'], message: '`design`은 더는 지원하지 않습니다. 이 항목을 지우세요' }],
    });
  });

  it('pageChecks[].compare는 까닭과 함께 거절한다(ADR-221)', () => {
    const input = {
      ...BASE,
      workflow: { pageChecks: [{ service: 'web', path: '/', mode: 'browser', compare: { reference: 'design/home.png', maxDiffRatio: 0.1 } }] },
    };
    expect(normalized(current.StudioSpecSchema.safeParse(input))).toEqual({
      ok: false,
      issues: [{ path: ['workflow', 'pageChecks', 0, 'compare'], message: '`pageChecks[].compare`는 더는 지원하지 않습니다. 이 항목을 지우세요' }],
    });
  });
});
