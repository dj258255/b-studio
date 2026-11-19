import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import * as legacy from './schema-legacy';
import * as current from './schema';
import { parseSpec as parseCurrent } from './load';
import { parseSpec as parseLegacy } from './load-legacy';

/**
 * `schema.ts`의 검증은 Rust(`crates/bstudio-guard/src/spec_schema/`)로 옮겼다(3단계 (b)).
 * 옛 Zod(`schema-legacy.ts`)와 issues(path·message·순서)와 성공 값을 모두 견준다.
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

function normalized(result: { success: boolean; data?: unknown; error?: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> } }) {
  return result.success ? { ok: true, data: result.data } : { ok: false, issues: result.error!.issues.map((issue) => ({ path: [...issue.path], message: issue.message })) };
}

function compare(label: string, left: { safeParse: (value: unknown) => any }, right: { safeParse: (value: unknown) => any }, input: unknown) {
  const a = normalized(left.safeParse(input));
  const b = normalized(right.safeParse(input));
  expect(b, label).toEqual(a);
}

const BASE = {
  version: 1,
  name: 'orders',
  services: {
    web: { source: 'managed', template: 'nextjs', path: 'web', port: 3000, preview: 'browser', ready: { path: '/' } },
    api: { source: 'managed', template: 'spring-boot', path: 'api', port: 8080, preview: 'openapi', contract: { extract: '/v3/api-docs' } },
    users: { source: 'external', baseUrl: 'https://users.example.com' },
  },
  databases: { db: { engine: 'postgres', database: 'app', user: 'app' } },
  resources: { db: { memory: '512m' } },
  network: { egress: ['example.com', { host: '*.example.com', methods: ['GET'], paths: ['/x'] }] },
  secrets: { TOKEN: { services: ['web'] } },
  deploy: { services: { web: { dockerfile: 'Dockerfile', port: 8300 } } },
  workflow: {
    required: ['plan', 'implement', 'run', 'test'],
    tests: [{ name: 'unit', service: 'api', command: ['./gradlew', 'test'] }],
    pageChecks: [{ service: 'web', path: '/', mode: 'browser', expectText: 'x', steps: [{ click: '#a' }], viewport: 'mobile' }],
    concurrencyChecks: [{ name: 'c', service: 'api', method: 'GET', path: '/', concurrent: 2, expect: { allStatusIn: [200] } }],
    loadChecks: [{ name: 'l', service: 'api', method: 'GET', path: '/', concurrent: 2, expect: { p95Ms: 200 } }],
    autoPageChecks: { service: 'web', mode: 'browser', viewport: { width: 390, height: 844 } },
    maxTurns: 30,
    allowedTools: ['read_file'],
    protectedPaths: ['.env'],
    evaluationAssets: ['tests/x'],
  },
  repository: { monorepo: true },
  review: { auto: false, maxRounds: 1 },
  guide: { file: 'AGENTS.md', maxChars: 1000 },
  models: { plan: 'opus' },
  checkpoints: { conventionalCommits: false },
};

const JUNK = [null, true, false, 0, 1, -1, 1.5, -0, 'x', '', '한글', 'a b', '../x', [], {}, { a: 1 }, ['x'], { length: 5 }, Number.NaN, Number.POSITIVE_INFINITY, '\u0000', '\u0000nf'];

const MEASURED: Array<[string, any, any, unknown]> = [
  ['필드 누락', legacy.StudioSpecSchema, current.StudioSpecSchema, { version: 1, name: 'orders' }],
  ['형식 틀림', legacy.StudioSpecSchema, current.StudioSpecSchema, { ...BASE, services: { web: { ...BASE.services.web, port: '3000' } } }],
  ['알 수 없는 키', legacy.StudioSpecSchema, current.StudioSpecSchema, { ...BASE, unknownTop: { a: 1 }, services: { web: { ...BASE.services.web, unknownField: true } } }],
  ['중첩 경로', legacy.StudioSpecSchema, current.StudioSpecSchema, { ...BASE, workflow: { maxTurns: 0 } }],
  ['discriminator 없음', legacy.ServiceSchema, current.ServiceSchema, { template: 'nextjs' }],
  ['discriminator 틀림', legacy.ServiceSchema, current.ServiceSchema, { source: 'other' }],
  ['managed 누락', legacy.ManagedServiceSchema, current.ManagedServiceSchema, { source: 'managed', template: 'nextjs' }],
  ['URL 형식', legacy.ExternalServiceSchema, current.ExternalServiceSchema, { source: 'external', baseUrl: 'not-a-url' }],
  ['URL 자격 증명', legacy.ExternalServiceSchema, current.ExternalServiceSchema, { source: 'external', baseUrl: 'http://user:pass@example.com' }],
  ['egress union 원시값', legacy.StudioSpecSchema, current.StudioSpecSchema, { ...BASE, network: { egress: [42] } }],
  ['egress union 호스트', legacy.StudioSpecSchema, current.StudioSpecSchema, { ...BASE, network: { egress: [{ host: 'not a host' }] } }],
  ['이름 정규식', legacy.StudioSpecSchema, current.StudioSpecSchema, { ...BASE, name: 'Orders' }],
  ['경로 refine', legacy.StudioSpecSchema, current.StudioSpecSchema, { ...BASE, workflow: { protectedPaths: ['../x'] } }],
  ['숫자 상한', legacy.StudioSpecSchema, current.StudioSpecSchema, { ...BASE, services: { web: { ...BASE.services.web, port: 70000 } } }],
  ['정수 아님', legacy.StudioSpecSchema, current.StudioSpecSchema, { ...BASE, services: { web: { ...BASE.services.web, port: 3000.5 } } }],
  ['정수 안전 범위', legacy.StudioSpecSchema, current.StudioSpecSchema, { ...BASE, services: { web: { ...BASE.services.web, port: 1e20 } } }],
  ['음수 정수 안전 범위', legacy.StudioSpecSchema, current.StudioSpecSchema, { ...BASE, services: { web: { ...BASE.services.web, port: -1e20 } } }],
  ['enum', legacy.StudioSpecSchema, current.StudioSpecSchema, { ...BASE, services: { web: { ...BASE.services.web, preview: 'mobile' } } }],
  ['literal', legacy.StudioSpecSchema, current.StudioSpecSchema, { ...BASE, version: 2 }],
  ['record 키', legacy.StudioSpecSchema, current.StudioSpecSchema, { ...BASE, secrets: { lower: { services: [] } } }],
  ['record 값', legacy.StudioSpecSchema, current.StudioSpecSchema, { ...BASE, databases: { web: { engine: 'mysql', database: 'app', user: 'app' } } }],
  ['배열 min(superRefine)', legacy.StudioSpecSchema, current.StudioSpecSchema, { ...BASE, workflow: { required: ['test'], tests: [] } }],
  ['배열 max', legacy.StudioSpecSchema, current.StudioSpecSchema, { ...BASE, services: { web: { ...BASE.services.web, includes: Array.from({ length: 21 }, (_, i) => `d${i}`) } } }],
  ['pageCheck http 전용', legacy.StudioSpecSchema, current.StudioSpecSchema, { ...BASE, workflow: { pageChecks: [{ service: 'web', path: '/', viewport: 'mobile' }] } }],
  ['객체 refine', legacy.StudioSpecSchema, current.StudioSpecSchema, { ...BASE, resources: { web: {} } }],
  ['단계 정확히 하나', legacy.WorkflowPageCheckSchema, current.WorkflowPageCheckSchema, { service: 'web', path: '/', steps: [{ click: '#a', press: 'Enter' }] }],
  ['이름 중복', legacy.StudioSpecSchema, current.StudioSpecSchema, { ...BASE, workflow: { tests: [{ name: 'unit', service: 'web', command: ['x'] }, { name: 'unit', service: 'web', command: ['y'] }] } }],
  ['문자열 min', legacy.ManagedServiceSchema, current.ManagedServiceSchema, { source: 'managed', template: '', path: 'web', port: 3000, preview: 'browser' }],
  ['null', legacy.StudioSpecSchema, current.StudioSpecSchema, { ...BASE, name: null }],
  ['deploy 포트 범위', legacy.DeploySchema, current.DeploySchema, { services: { web: { port: 80 } } }],
  ['여러 오류 순서', legacy.StudioSpecSchema, current.StudioSpecSchema, { version: 1, name: 'Bad Name', services: { web: { source: 'managed', template: 'nextjs', path: 'web', port: 0, preview: 'browser' } }, secrets: { bad: { services: ['UPPER'] } } }],
  ['stage enum', legacy.WorkflowSchema, current.WorkflowSchema, { required: ['deploy'] }],
  ['viewport 변환', legacy.WorkflowPageCheckSchema, current.WorkflowPageCheckSchema, { service: 'web', path: '/', mode: 'browser', viewport: 'mobile' }],
  ['load expect 빈 값', legacy.LoadExpectSchema, current.LoadExpectSchema, {}],
  ['equals union', legacy.ConcurrencyExpectSchema, current.ConcurrencyExpectSchema, { then: { method: 'GET', path: '/', jsonPath: '$', equals: true } }],
  ['maxPages 상한', legacy.StudioSpecSchema, current.StudioSpecSchema, { ...BASE, workflow: { autoPageChecks: { service: 'web', maxPages: 11 } } }],
];

const SPEC_YAML = `
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
    contract: { extract: /v3/api-docs }
  legacy-users:
    source: external
    baseUrl: https://users.internal.example.com
`;

const YAML_CASES = [
  SPEC_YAML,
  `${SPEC_YAML}deploy:\n  services:\n    web: { port: 80 }\n`,
  `${SPEC_YAML}repository:\n  monorepo: "yes"\n`,
  `${SPEC_YAML}review:\n  maxRounds: 0\n`,
  `${SPEC_YAML}guide:\n  maxChars: 0\n`,
  `${SPEC_YAML}models:\n  plan: ""\n`,
  `${SPEC_YAML}workflow:\n  required: [plan, deploy]\n`,
  `${SPEC_YAML}workflow:\n  required: [plan, test, checkpoint]\n`,
  `${SPEC_YAML}workflow:\n  tests:\n    - { name: unit, service: api, command: [./gradlew, test], maxAttempts: 4 }\n`,
  `${SPEC_YAML}workflow:\n  pageChecks:\n    - { service: web, path: //evil.example.com }\n`,
  `${SPEC_YAML}workflow:\n  pageChecks:\n    - { service: web, path: /, viewport: { width: 390, height: 844 }, noHorizontalScroll: true }\n`,
  `${SPEC_YAML}workflow:\n  pageChecks:\n    - { service: web, path: /, mode: browser, steps: [{ click: "#a", fill: { selector: "#q", text: x } }] }\n`,
  `${SPEC_YAML}workflow:\n  concurrencyChecks:\n    - { name: a, service: api, method: GET, path: /, concurrent: 1, expect: { allStatusIn: [200] } }\n`,
  `${SPEC_YAML}workflow:\n  loadChecks:\n    - { name: l, service: api, method: GET, path: /, concurrent: 2, requests: 1, expect: { p95Ms: 200 } }\n`,
  `${SPEC_YAML}workflow:\n  autoPageChecks: { service: web, sampleParams: { "a/b": "1" } }\n`,
  `${SPEC_YAML}network:\n  egress: [not a host, { host: "*.example.com", methods: [GET], paths: ["/x"] }]\n`,
  `${SPEC_YAML}secrets:\n  lower: { services: [web] }\n`,
  `${SPEC_YAML}services:\n  web:\n    source: managed\n    template: nextjs\n    path: web\n    port: 3000\n    preview: browser\n    includes: [../x]\n`,
  'version: 1\nname: x\nservices: {}\n',
  'version: 1\nname: x\nservices: [a]\n',
  'services: 3\n',
];

describe('schema: legacy Zod와 Rust가 같다', () => {
  it('측정한 오류 꼴 전부가 같은 issues(path·message·순서)를 낸다', () => {
    for (const [label, a, b, input] of MEASURED) compare(label, a, b, input);
  });

  it('spec 시험의 YAML 예시들이 같은 값·오류를 낸다', () => {
    for (const yaml of YAML_CASES) {
      let left: unknown;
      let right: unknown;
      try {
        left = { ok: true, value: parseLegacy(yaml) };
      } catch (error) {
        left = { ok: false, message: (error as Error).message, issues: (error as { issues?: string[] }).issues ?? [] };
      }
      try {
        right = { ok: true, value: parseCurrent(yaml) };
      } catch (error) {
        right = { ok: false, message: (error as Error).message, issues: (error as { issues?: string[] }).issues ?? [] };
      }
      expect(right, yaml.slice(0, 80)).toEqual(left);
    }
  });

  it('무작위 변이 3000개(스키마 12개)에서 issues와 성공 값이 같다', () => {
    const rand = makeRandom(20_261_125);
    const int = (n: number) => Math.floor(rand() * n);
    const pick = <T,>(items: readonly T[]): T => items[int(items.length)]!;
    const mutate = (value: any, depth = 0): any => {
      if (depth > 6) return value;
      const kind = int(10);
      if (kind === 0) return pick(JUNK);
      if (Array.isArray(value)) {
        if (kind === 1) return value.slice(0, int(value.length + 1));
        if (kind === 2 && value.length) return [...value, pick(JUNK)];
        if (kind === 3 && value.length) {
          const copy = [...value];
          const at = int(copy.length);
          copy[at] = mutate(copy[at], depth + 1);
          return copy;
        }
        return value;
      }
      if (value && typeof value === 'object') {
        const copy = { ...value };
        const keys = Object.keys(copy);
        if (kind === 1 && keys.length) delete copy[pick(keys)];
        if (kind === 2) copy[pick(['extra', 'unknown', 'zzz', '\u0000key'])] = pick(JUNK);
        if (kind === 3 && keys.length) {
          const key = pick(keys);
          copy[key] = mutate(copy[key], depth + 1);
        }
        if (kind === 4) return pick(JUNK);
        return copy;
      }
      if (typeof value === 'string' && kind === 3) return value + pick(['', ' ', '한', '/', '..', '\n']);
      return value;
    };
    const cases = [
      ['studio', legacy.StudioSpecSchema, current.StudioSpecSchema, BASE],
      ['workflow', legacy.WorkflowSchema, current.WorkflowSchema, BASE.workflow],
      ['managed', legacy.ManagedServiceSchema, current.ManagedServiceSchema, BASE.services.web],
      ['page', legacy.WorkflowPageCheckSchema, current.WorkflowPageCheckSchema, BASE.workflow.pageChecks[0]],
      ['concurrency', legacy.WorkflowConcurrencyCheckSchema, current.WorkflowConcurrencyCheckSchema, BASE.workflow.concurrencyChecks[0]],
      ['load', legacy.WorkflowLoadCheckSchema, current.WorkflowLoadCheckSchema, BASE.workflow.loadChecks[0]],
      ['egress', legacy.EgressRuleSchema, current.EgressRuleSchema, BASE.network.egress[1]],
      ['resource', legacy.ResourceLimitSchema, current.ResourceLimitSchema, BASE.resources.db],
      ['deploy', legacy.DeploySchema, current.DeploySchema, BASE.deploy],
      ['external', legacy.ExternalServiceSchema, current.ExternalServiceSchema, BASE.services.users],
      ['auto', legacy.AutoPageChecksSchema, current.AutoPageChecksSchema, BASE.workflow.autoPageChecks],
    ] as const;
    for (let iteration = 0; iteration < 3000; iteration += 1) {
      for (const [label, a, b, seed] of cases as ReadonlyArray<readonly [string, any, any, unknown]>) {
        compare(`${label} ${iteration}`, a, b, mutate(structuredClone(seed)));
      }
    }
  });

  it('무작위 URL 5000개에서 z.url()과 refine 결과가 같다', () => {
    const rand = makeRandom(20_261_127);
    const int = (n: number) => Math.floor(rand() * n);
    const pick = <T,>(items: readonly T[]): T => items[int(items.length)]!;
    const pieces = ['http://', 'https://', 'ftp://', 'mailto:', 'x:', '//', '', '://', 'HTTP://', 'https:/', 'http:', ' ', '\t', '\n', 'example.com', 'a', 'a.b', '한글.kr', 'user:pass@', 'user@', '@', ':', ':80', ':99999', '[::1]', '127.0.0.1', 'localhost', '%', '%20', '/', '/a?b#c', '?x=1', '#frag', '\\', '\u0000', '\u007f', 'example.com:bad', 'exa mple.com', 'https://example.com', 'https://example.com/a'];
    for (let i = 0; i < 5000; i += 1) {
      const url = Array.from({ length: int(8) }, () => pick(pieces)).join('');
      compare(`url ${JSON.stringify(url)}`, legacy.ExternalServiceSchema, current.ExternalServiceSchema, { source: 'external', baseUrl: url });
    }
  });
});

describe('schema: 지운 studio.yaml 항목을 거절한다(ADR-221)', () => {
  const WITHOUT_DESIGN = {
    version: 1,
    name: 'orders',
    services: { web: { source: 'managed', template: 'nextjs', path: 'web', port: 3000, preview: 'browser' } },
  };

  it('design은 옛 스키마가 받고 새 스키마는 까닭과 함께 거절한다', () => {
    const input = { ...WITHOUT_DESIGN, design: { figma: { fileUrl: 'https://www.figma.com/design/abc/x' } } };
    expect(normalized(legacy.StudioSpecSchema.safeParse(input)).ok).toBe(true);
    expect(normalized(current.StudioSpecSchema.safeParse(input))).toEqual({
      ok: false,
      issues: [{ path: ['design'], message: '`design`은 더는 지원하지 않습니다. 이 항목을 지우세요' }],
    });
  });

  it('pageChecks[].compare는 옛 스키마가 받고 새 스키마는 까닭과 함께 거절한다', () => {
    const input = {
      ...WITHOUT_DESIGN,
      workflow: { pageChecks: [{ service: 'web', path: '/', mode: 'browser', compare: { reference: 'design/home.png', maxDiffRatio: 0.1 } }] },
    };
    expect(normalized(legacy.StudioSpecSchema.safeParse(input)).ok).toBe(true);
    expect(normalized(current.StudioSpecSchema.safeParse(input))).toEqual({
      ok: false,
      issues: [{ path: ['workflow', 'pageChecks', 0, 'compare'], message: '`pageChecks[].compare`는 더는 지원하지 않습니다. 이 항목을 지우세요' }],
    });
  });
});
