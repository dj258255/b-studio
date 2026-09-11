import type { LoadedProject } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import {
  buildOverride,
  DEFAULT_EGRESS_ALLOW,
  EDGE_SERVICE,
  edgePortFor,
  parseContainerState,
  parseEgressDenial,
  parseHostPort,
  parseLogLine,
  parseSyncOutput,
} from './format';

const ORDERS = {
  managed: [
    ['web', { source: 'managed', template: 'nextjs', path: 'web', port: 3000, preview: 'browser' }],
    ['api', { source: 'managed', template: 'spring-boot', path: 'api', port: 8080, preview: 'openapi' }],
  ],
  composeServices: ['web', 'api', 'db'],
  egress: ['api.slack.com'],
  resources: { api: { memory: '1536m', cpus: 2 }, db: { memory: '256m' } },
} as unknown as LoadedProject;

describe('buildOverride 네트워크 격리', () => {
  it('모든 서비스를 internal 네트워크에만 붙이고 포트는 edge만 루프백에 공개한다', () => {
    const override = buildOverride(ORDERS, 's1');

    expect(override.networks).toEqual({ 'b-studio-sandbox': { internal: true }, 'b-studio-egress': {} });
    for (const name of ['web', 'api', 'db']) {
      expect(override.services[name]).toMatchObject({
        networks: ['b-studio-sandbox'],
        depends_on: { [EDGE_SERVICE]: { condition: 'service_healthy' } },
      });
      expect(override.services[name]).not.toHaveProperty('ports');
    }
    expect(override.services[EDGE_SERVICE]).toMatchObject({
      networks: { 'b-studio-sandbox': { aliases: [] }, 'b-studio-egress': {} },
      ports: ['127.0.0.1::20000', '127.0.0.1::20001'],
      environment: { EDGE_FORWARDS: '20000=web:3000,20001=api:8080' },
    });
    expect(edgePortFor(ORDERS, 'api')).toBe(20001);
  });

  it('기본 패키지 저장소와 studio.yaml의 허용 호스트를 edge에 넘긴다', () => {
    const allow = (buildOverride(ORDERS, 's1').services[EDGE_SERVICE]!.environment as Record<string, string>).EDGE_ALLOW;
    expect(allow?.split(',')).toEqual([...DEFAULT_EGRESS_ALLOW, 'api.slack.com']);
  });

  it('서비스끼리는 프록시를 거치지 않고, 밖으로 나가는 HTTP는 JVM까지 edge 프록시를 쓴다', () => {
    const environment = buildOverride(ORDERS, 's1').services.api!.environment as Record<string, string>;
    expect(environment.HTTPS_PROXY).toBe('http://b-studio-edge:3128');
    expect(environment.NO_PROXY).toBe('localhost,127.0.0.1,web,api,db');
    expect(environment.JAVA_TOOL_OPTIONS).toContain('-Dhttps.proxyHost=b-studio-edge');
    expect(environment.JAVA_TOOL_OPTIONS).toContain('-Dhttp.nonProxyHosts=localhost|127.0.0.1|web|api|db');
  });

  it('compose가 스크립트의 $를 변수로 치환하지 않게 적는다', () => {
    const command = buildOverride(ORDERS, 's1', { edgeScript: 'console.log(`${a}` + $b)' }).services[EDGE_SERVICE]!.command as string[];
    expect(command.at(-1)).toBe('console.log(`$${a}` + $$b)');
  });

  it('managed 서비스에는 라벨을, 부가 서비스까지 deploy 형식 자원 한도를 건다', () => {
    const { services } = buildOverride(ORDERS, 's1');
    expect(services.api).toMatchObject({
      labels: { 'b-studio.sandbox': 's1', 'b-studio.service': 'api' },
      deploy: { resources: { limits: { memory: '1536m', cpus: '2' } } },
    });
    expect(services.db).toMatchObject({ deploy: { resources: { limits: { memory: '256m' } } } });
    expect(services.db).not.toHaveProperty('labels');
  });
});

describe('buildOverride 사내 API', () => {
  it('등록한 이름을 edge 별칭으로 두고, 서비스는 프록시 없이 부르며, 인증 시크릿은 edge에만 넣는다', () => {
    const policy = { mask: ['phone'], auth: { header: 'Authorization', secret: 'LEGACY_USERS_TOKEN', prefix: 'Bearer $' } };
    const project = {
      ...ORDERS,
      secrets: [['LEGACY_USERS_TOKEN', { services: [] }]],
      external: [['legacy-users', { source: 'external', baseUrl: 'https://users.internal.example.com/v1', preview: 'openapi', policy }]],
    } as unknown as LoadedProject;

    const { services } = buildOverride(project, 's1');
    const edge = services[EDGE_SERVICE]!;
    const environment = edge.environment as Record<string, unknown>;

    expect(edge.networks).toEqual({ 'b-studio-sandbox': { aliases: ['legacy-users'] }, 'b-studio-egress': {} });
    expect(edge.extra_hosts).toEqual(['host.docker.internal:host-gateway']);
    expect(environment.LEGACY_USERS_TOKEN).toBeNull();
    expect(environment.EDGE_CALLERS).toBe('web,api,db');
    expect(JSON.parse(String(environment.EDGE_EXTERNALS).replaceAll('$$', '$'))).toEqual([
      { name: 'legacy-users', baseUrl: 'https://users.internal.example.com/v1', policy },
    ]);
    expect((services.api!.environment as Record<string, string>).NO_PROXY).toBe('localhost,127.0.0.1,web,api,db,legacy-users');
    expect(services.api!.environment).not.toHaveProperty('LEGACY_USERS_TOKEN');
  });
});

describe('buildOverride 시크릿', () => {
  it('받을 서비스에만 이름을 적고 값 자리는 비워 둔다', () => {
    const project = { ...ORDERS, secrets: [['PAYMENT_API_KEY', { services: ['api'] }]] } as unknown as LoadedProject;
    const { services } = buildOverride(project, 's1');

    expect(services.api!.environment).toMatchObject({ PAYMENT_API_KEY: null, HTTPS_PROXY: 'http://b-studio-edge:3128' });
    expect(services.web!.environment).not.toHaveProperty('PAYMENT_API_KEY');
  });
});

describe('parseEgressDenial', () => {
  it('edge 감사 로그에서 거부 기록만 읽는다', () => {
    expect(
      parseEgressDenial('{"edge":"egress","decision":"deny","host":"example.com","port":443,"reason":"허용 목록에 없는 호스트나 포트","at":"2026-09-11T01:00:00.000Z"}'),
    ).toEqual({ host: 'example.com', port: 443, reason: '허용 목록에 없는 호스트나 포트', at: new Date('2026-09-11T01:00:00.000Z') });
    expect(parseEgressDenial('{"edge":"egress","decision":"allow","host":"registry.npmjs.org","port":443,"at":"2026-09-11T01:00:00.000Z"}')).toBeUndefined();
    expect(parseEgressDenial('{"edge":"started","forwards":[]}')).toBeUndefined();
    expect(parseEgressDenial('{"edge":"egress", 잘린 줄')).toBeUndefined();
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

describe('parseSyncOutput', () => {
  it('해시와 경로를 나누고 공백이 들어간 경로를 보존한다', () => {
    const seen = parseSyncOutput('abc123 api/src/Order.java\nMISSING web/app/my page.tsx\n');
    expect([...seen]).toEqual([
      ['api/src/Order.java', 'abc123'],
      ['web/app/my page.tsx', 'MISSING'],
    ]);
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

  it('제어 코드가 붙은 컨테이너 상태 줄을 서비스별로 나눈다', () => {
    expect(parseLogLine('\u001b[Kapi-1 exited with code 143')).toMatchObject({ service: 'api', text: 'exited with code 143' });
    expect(parseLogLine('\u001b[Korder-web-1 has been recreated')).toMatchObject({ service: 'order-web', text: 'has been recreated' });
  });

  it('로그 본문의 대괄호는 제어 코드로 보고 지우지 않는다', () => {
    const raw = 'api-1  | 2026-09-10T13:21:18.241Z  WARN 109 --- [api] [           main] o.s.core.events.SpringDocAppInitializer';
    expect(parseLogLine(raw)?.text).toBe(' WARN 109 --- [api] [           main] o.s.core.events.SpringDocAppInitializer');
  });

  it('내용이 없는 줄은 건너뛴다', () => {
    expect(parseLogLine('')).toBeUndefined();
    expect(parseLogLine('\u001b[K')).toBeUndefined();
  });
});
