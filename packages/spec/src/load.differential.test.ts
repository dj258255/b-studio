import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { stringify } from 'yaml';
import { afterAll, describe, expect, it } from 'vitest';
import * as legacy from './load-legacy';
import * as current from './load';

/**
 * `loadProject`의 파일 읽기·YAML·스키마·교차 검증은 Rust(`bstudio-io`·`bstudio-guard`)로 옮겼다.
 * 옛 TS(`load-legacy.ts`)와 성공 값·오류 글·issues를 견준다.
 */

const SPEC = {
  version: 1,
  name: 'orders',
  services: {
    web: { source: 'managed', template: 'nextjs', path: 'web', port: 3000, preview: 'browser', ready: { path: '/' } },
    api: { source: 'managed', template: 'spring-boot', path: 'api', port: 8080, preview: 'openapi', snapshots: [{ volume: 'cache', key: ['package.json'] }] },
    users: {
      source: 'external',
      baseUrl: 'https://users.example.com',
      policy: { allow: [{ callers: ['studio', 'web'], methods: ['GET'], paths: ['/**'] }], auth: { header: 'X-Key', secret: 'TOKEN' } },
    },
  },
  databases: { db: { engine: 'postgres', database: 'app', user: 'app' } },
  resources: { db: { memory: '512m' } },
  network: { egress: ['example.com', { host: '*.example.com', methods: ['GET'], paths: ['/x'] }] },
  secrets: { TOKEN: { services: ['web'] } },
  design: { figma: { fileUrl: 'https://www.figma.com/design/abc/x' } },
  workflow: {
    required: ['plan', 'implement', 'run', 'test'],
    tests: [{ name: 'unit', service: 'api', command: ['./gradlew', 'test'] }],
    pageChecks: [
      { service: 'web', path: '/', mode: 'browser', expectText: 'x', viewport: 'mobile' },
      { service: 'web', path: '/orders', compare: { reference: 'design/home.png', maxDiffRatio: 0.1 } },
    ],
    concurrencyChecks: [{ name: 'c', service: 'api', method: 'GET', path: '/', concurrent: 2, expect: { allStatusIn: [200] } }],
    loadChecks: [{ name: 'l', service: 'api', method: 'GET', path: '/', concurrent: 2, expect: { p95Ms: 200 } }],
    autoPageChecks: { service: 'web', mode: 'browser', viewport: { width: 390, height: 844 } },
  },
  repository: { monorepo: true },
  review: { auto: false, maxRounds: 1 },
  guide: { file: 'AGENTS.md', maxChars: 1000 },
  models: { plan: 'opus' },
  checkpoints: { conventionalCommits: false },
};
const COMPOSE = {
  services: {
    web: { image: 'node:22' },
    api: { image: 'eclipse-temurin:21-jdk', volumes: ['cache:/var/cache'] },
    db: { image: 'postgres:17' },
    users: { image: 'x' },
  },
  volumes: { cache: { external: true } },
};

function makeRandom(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

async function outcome(run: () => Promise<unknown>) {
  try {
    return { ok: true, value: await run() };
  } catch (error) {
    return { ok: false, message: (error as Error).message, issues: (error as { issues?: string[] }).issues };
  }
}

async function compare(dir: string, label: string) {
  const left = await outcome(() => legacy.loadProject(dir));
  const right = await outcome(() => current.loadProject(dir));
  if (isDeepStrictEqual(left, right)) return;
  expect(right, label).toEqual(left);
}

const root = await mkdtemp(path.join(tmpdir(), 'spec-load-diff-'));
let sequence = 0;
async function makeDir(specText: string, composeText: string | undefined = stringify(COMPOSE)): Promise<string> {
  const dir = path.join(root, `case-${sequence++}`);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'studio.yaml'), specText);
  if (composeText !== undefined) await writeFile(path.join(dir, 'compose.yaml'), composeText);
  return dir;
}

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('loadProject: legacy TS와 Rust가 같다', () => {
  it('성공·교차 검증 오류·YAML 오류·읽기 오류가 같다', async () => {
    await compare(await makeDir(stringify(SPEC)), 'valid');

    const invalid = structuredClone(SPEC);
    invalid.name = 'Orders';
    await compare(await makeDir(stringify(invalid)), 'spec schema');

    await compare(await makeDir(stringify(SPEC), undefined), 'missing compose');
    await compare(await makeDir(stringify(SPEC), 'services: 3\n'), 'compose schema');
    await compare(await makeDir('secret: [1,\nname: oops\n'), 'yaml syntax');
    const composedOutside = structuredClone(SPEC) as typeof SPEC & { compose?: string };
    composedOutside.compose = '../x.yaml';
    await compare(await makeDir(stringify(composedOutside)), 'compose outside');

    const cross = structuredClone(SPEC);
    cross.services.web = { ...cross.services.web, ...{ snapshots: [{ volume: 'missing', key: ['x'] }] } } as never;
    await compare(await makeDir(stringify(cross)), 'missing volume');

    const notCompose = structuredClone(SPEC);
    notCompose.workflow.tests = [{ name: 'unit', service: 'users', command: ['x'] }];
    await compare(await makeDir(stringify(notCompose)), 'test service external');

    const badCaller = structuredClone(SPEC);
    badCaller.services.users.policy = { allow: [{ callers: ['nobody'], methods: ['GET'], paths: ['/**'] }] } as never;
    await compare(await makeDir(stringify(badCaller)), 'caller');

    const badSecret = structuredClone(SPEC);
    badSecret.services.users.policy = { auth: { header: 'X', secret: 'MISSING' } } as never;
    await compare(await makeDir(stringify(badSecret)), 'auth secret');

    const badDb = structuredClone(SPEC);
    badDb.databases = { nope: { engine: 'postgres', database: 'app', user: 'app' } } as never;
    await compare(await makeDir(stringify(badDb)), 'database missing');

    const badResources = structuredClone(SPEC);
    badResources.resources = { nope: { cpus: 1 } } as never;
    await compare(await makeDir(stringify(badResources)), 'resources missing');

    const badAuto = structuredClone(SPEC);
    badAuto.workflow.autoPageChecks = { service: 'api' } as never;
    await compare(await makeDir(stringify(badAuto)), 'auto page template');

    const badEgress = structuredClone(SPEC);
    badEgress.network = { egress: ['not a host'] } as never;
    await compare(await makeDir(stringify(badEgress)), 'egress host');

    const badSecretServices = structuredClone(SPEC);
    badSecretServices.secrets = { TOKEN: { services: ['nope'] } } as never;
    await compare(await makeDir(stringify(badSecretServices)), 'secret service missing');

    const unusedSecret = structuredClone(SPEC);
    unusedSecret.secrets = { UNUSED: { services: [] } } as never;
    await compare(await makeDir(stringify(unusedSecret)), 'unused secret');

    await compare(await makeDir(stringify(SPEC), 'not: [valid'), 'compose yaml');
    await compare(path.join(root, 'does-not-exist'), 'missing spec');
  });

  it('링크·폴더·큰 파일 경계가 같다', async () => {
    const base = await makeDir(stringify(SPEC));
    const linkOutside = path.join(root, 'link-outside');
    await mkdir(linkOutside, { recursive: true });
    const outsideTarget = path.join(root, 'outside.yaml');
    await writeFile(outsideTarget, stringify(SPEC));
    await symlink(outsideTarget, path.join(linkOutside, 'studio.yaml'));
    await writeFile(path.join(linkOutside, 'compose.yaml'), stringify(COMPOSE));
    await compare(linkOutside, 'symlink outside');

    const linkInside = path.join(root, 'link-inside');
    await mkdir(linkInside, { recursive: true });
    await writeFile(path.join(linkInside, 'real.yaml'), stringify(SPEC));
    await symlink(path.join(linkInside, 'real.yaml'), path.join(linkInside, 'studio.yaml'));
    await writeFile(path.join(linkInside, 'compose.yaml'), stringify(COMPOSE));
    await compare(linkInside, 'symlink inside');

    const directory = path.join(root, 'directory-at-file');
    await mkdir(path.join(directory, 'studio.yaml'), { recursive: true });
    await compare(directory, 'directory at studio');

    const large = path.join(root, 'large');
    await mkdir(large, { recursive: true });
    await writeFile(path.join(large, 'studio.yaml'), 'x'.repeat(4 * 1024 * 1024 + 1));
    await compare(large, 'too large');

    await compare(base, 'valid again');
  });

  it('무작위로 만든 spec 40개에서 값과 오류가 같다', async () => {
    const rand = makeRandom(20_261_128);
    const int = (n: number) => Math.floor(rand() * n);
    const pick = <T,>(items: readonly T[]): T => items[int(items.length)]!;
    const junk = [null, true, false, 0, 1, 'x', '', [], {}, ['x'], 3000.5];
    const mutate = (value: any, depth = 0): any => {
      if (depth > 4) return value;
      const kind = int(8);
      if (kind === 0) return pick(junk);
      if (Array.isArray(value)) {
        if (kind === 1) return value.slice(0, int(value.length + 1));
        if (kind === 2 && value.length) return [...value, pick(junk)];
        return value.map((item) => mutate(item, depth + 1));
      }
      if (value && typeof value === 'object') {
        const copy = { ...value };
        const keys = Object.keys(copy);
        if (kind === 1 && keys.length) delete copy[pick(keys)];
        if (kind === 2) copy[pick(['extra', 'unknown'])] = pick(junk);
        if (kind === 3 && keys.length) {
          const key = pick(keys);
          copy[key] = mutate(copy[key], depth + 1);
        }
        return copy;
      }
      if (typeof value === 'string' && kind === 3) return value + pick(['', ' ', '한', '/', '..']);
      return value;
    };
    for (let i = 0; i < 40; i += 1) {
      const spec = mutate(structuredClone(SPEC));
      const dir = await makeDir(stringify(spec));
      await compare(dir, `random ${i}`);
    }
  });
});
