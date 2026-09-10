import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadProject, parseSpec, SpecError } from './load';

const ORDERS_SPEC = `
version: 1
name: orders
services:
  web:
    source: managed
    template: nextjs
    path: web
    port: 3000
    preview: browser
    ready: { path: / }
  api:
    source: managed
    template: spring-boot
    path: api
    port: 8080
    preview: openapi
    ready: { path: /actuator/health, timeoutSeconds: 600 }
    contract: { extract: /v3/api-docs }
  legacy-users:
    source: external
    baseUrl: https://users.internal.example.com
`;

describe('parseSpec', () => {
  it('managed와 external 서비스를 함께 읽고 기본값을 채운다', () => {
    const spec = parseSpec(ORDERS_SPEC);

    expect(spec.compose).toBe('compose.yaml');
    expect(spec.services.web).toMatchObject({ source: 'managed', port: 3000 });
    expect(spec.services.api).toMatchObject({ ready: { expectStatus: 200, timeoutSeconds: 600 } });
    expect(spec.services['legacy-users']).toMatchObject({ source: 'external', preview: 'openapi' });
  });

  it('external 서비스에는 browser 미리보기를 쓸 수 없다', () => {
    const source = `
version: 1
name: x
services:
  users: { source: external, baseUrl: https://a.example.com, preview: browser }
`;
    expect(() => parseSpec(source)).toThrow(SpecError);
  });

  it('다른 호스트를 가리킬 수 있는 "//" 경로를 거부한다', () => {
    const source = `
version: 1
name: x
services:
  api: { source: managed, template: fastapi, path: api, port: 8000, preview: openapi, contract: { extract: //evil.example/openapi.json } }
`;
    const error = captureError(() => parseSpec(source));
    expect(error.issues.some((issue) => issue.startsWith('services.api.contract.extract'))).toBe(true);
  });

  it('문제가 있는 필드 경로를 알려준다', () => {
    const source = `
version: 1
name: x
services:
  web: { source: managed, template: nextjs, path: web, preview: browser }
`;
    const error = captureError(() => parseSpec(source));
    expect(error.issues.some((issue) => issue.startsWith('services.web.port'))).toBe(true);
  });
});

describe('loadProject', () => {
  it('compose에 없는 managed 서비스와 compose에 있는 external 서비스를 잡아낸다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'spec-test-'));
    await writeFile(path.join(dir, 'studio.yaml'), ORDERS_SPEC);
    await writeFile(
      path.join(dir, 'compose.yaml'),
      'services:\n  web: { build: ./web }\n  legacy-users: { image: nginx }\n',
    );

    const error = await loadProject(dir).then(
      () => expect.unreachable(),
      (e: unknown) => e as SpecError,
    );
    expect(error.issues).toHaveLength(2);
    expect(error.issues[0]).toContain('services.api');
    expect(error.issues[1]).toContain('services.legacy-users');
  });

  it('external 볼륨을 샌드박스 공유 캐시 목록으로 모은다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'spec-test-'));
    await writeFile(
      path.join(dir, 'studio.yaml'),
      'version: 1\nname: x\nservices:\n  api: { source: managed, template: fastapi, path: api, port: 8000, preview: openapi }\n',
    );
    await writeFile(
      path.join(dir, 'compose.yaml'),
      'services:\n  api: { build: ./api }\nvolumes:\n  data:\n  uv-cache: { external: true, name: b-studio-cache-uv }\n  shared: { external: true }\n',
    );

    const project = await loadProject(dir);
    expect(project.sharedVolumes).toEqual(['b-studio-cache-uv', 'shared']);
  });
});

function captureError(fn: () => unknown): SpecError {
  try {
    fn();
  } catch (error) {
    if (error instanceof SpecError) return error;
    throw error;
  }
  return expect.unreachable('SpecError가 발생해야 합니다');
}
