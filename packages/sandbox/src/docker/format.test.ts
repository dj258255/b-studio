import type { LoadedProject } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import { buildOverride, parseContainerState, parseHostPort, parseLogLine } from './format';

describe('buildOverride', () => {
  it('managed 서비스 포트를 루프백의 빈 포트에 공개한다', () => {
    const project = {
      managed: [['api', { source: 'managed', template: 'spring-boot', path: 'api', port: 8080, preview: 'openapi' }]],
    } as unknown as LoadedProject;

    expect(buildOverride(project, 'studio-orders-abc123')).toEqual({
      services: {
        api: {
          ports: ['127.0.0.1::8080'],
          labels: { 'b-studio.sandbox': 'studio-orders-abc123', 'b-studio.service': 'api' },
        },
      },
    });
  });
});

describe('parseHostPort', () => {
  it('compose port 출력에서 호스트 포트를 읽는다', () => {
    expect(parseHostPort('127.0.0.1:55012\n')).toBe(55012);
  });

  it('포트가 공개되지 않았으면 에러를 던진다', () => {
    expect(() => parseHostPort('')).toThrow();
    expect(() => parseHostPort(':0')).toThrow();
  });
});

describe('parseContainerState', () => {
  it('줄 단위 JSON 출력', () => {
    expect(parseContainerState('{"Service":"api","State":"running"}\n')).toBe('running');
  });

  it('배열 출력', () => {
    expect(parseContainerState('[{"Service":"api","State":"exited"}]')).toBe('exited');
  });

  it('컨테이너가 없으면 unknown', () => {
    expect(parseContainerState('')).toBe('unknown');
  });
});

describe('parseLogLine', () => {
  it('하이픈이 들어간 서비스 이름과 나노초 타임스탬프를 처리한다', () => {
    expect(parseLogLine('order-api-1  | 2026-09-10T11:48:35.123456789Z Started Application in 3.2 seconds')).toEqual({
      service: 'order-api',
      text: 'Started Application in 3.2 seconds',
      at: new Date('2026-09-10T11:48:35.123Z'),
    });
  });

  it('형식이 다른 줄은 원문을 그대로 남긴다', () => {
    expect(parseLogLine('some raw output')).toMatchObject({ service: 'unknown', text: 'some raw output' });
  });
});
