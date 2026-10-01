import type { LoadedProject } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import { preallocatePublicUrlPorts } from './compose-provider';

describe('preallocatePublicUrlPorts(fix/frontend-backend-url)', () => {
  it('참조가 가리키는 서비스마다 호스트 포트를 하나씩 미리 정한다', async () => {
    const project = {
      publicUrlRefs: [{ service: 'web', envKey: 'NEXT_PUBLIC_API_BASE_URL', template: '${b-studio:services.api.publicUrl}/api', targetService: 'api' }],
    } as unknown as LoadedProject;

    const hostPorts = await preallocatePublicUrlPorts(project);
    expect(Object.keys(hostPorts)).toEqual(['api']);
    expect(hostPorts.api).toBeGreaterThan(0);
  });

  it('같은 서비스를 여러 참조가 가리켜도 포트는 하나만 만든다', async () => {
    const project = {
      publicUrlRefs: [
        { service: 'web', envKey: 'NEXT_PUBLIC_API_BASE_URL', template: '${b-studio:services.api.publicUrl}/api', targetService: 'api' },
        { service: 'web', envKey: 'API_BASE_URL', template: '${b-studio:services.api.publicUrl}', targetService: 'api' },
      ],
    } as unknown as LoadedProject;

    const hostPorts = await preallocatePublicUrlPorts(project);
    expect(Object.keys(hostPorts)).toEqual(['api']);
  });

  it('참조가 없으면(대부분의 프로젝트) 빈 객체를 돌려준다', async () => {
    const withEmpty = { publicUrlRefs: [] } as unknown as LoadedProject;
    expect(await preallocatePublicUrlPorts(withEmpty)).toEqual({});

    // 이전 테스트 픽스처처럼 publicUrlRefs가 아예 없는 프로젝트 객체도 받아들인다
    const withoutField = {} as unknown as LoadedProject;
    expect(await preallocatePublicUrlPorts(withoutField)).toEqual({});
  });
});
