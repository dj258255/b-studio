import { describe, expect, it } from 'vitest';
import * as legacyDeps from './compose-deps-legacy';
import { composeEnvironment as legacyComposeEnvironment } from './compose-env-legacy';
import * as legacyHelpers from './compose-helpers-legacy';
import { externalCallScript as legacyExternalCallScript } from './external-call-legacy';
import * as legacyLoad from './load-runner-legacy';
import { awaitedCondition, parseDependsOn, startWaves, type DependsOn } from './compose-deps';
import { composeEnvironment } from './compose-env';
import { describeDockerFailure, DOCKER_OUT_OF_SPACE, isPortBindConflict, runtimeFromEnv, sandboxBuildNoCache, splitUpArgs } from './compose-provider';
import { externalCallScript } from './external-call';
import { LOAD_DEADLINE_MS, LOAD_REQUEST_TIMEOUT_MS, LOAD_RUNNER_IMAGE, LOAD_RUNNER_SERVICE, loadConfig, loadRunArgs, loadScript, loadThreads, parseLoadOutput } from './load-runner';
import type { LoadRequest } from '../types';

/**
 * 샌드박스 조율의 순수 도우미를 Rust로 옮기면서(ADR-195 4f A4a) 옛 TS 구현(`*-legacy.ts`)을 기준값으로 남겼다.
 * 같은 입력을 옛 구현과 지금 껍데기(Rust)에 넣어 결과가 같은지 견준다. "의도한 차이"라고 적은 시험만 다르다.
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
const THROWS = Symbol('throws');
function observe(fn: () => unknown): unknown {
  try {
    return fn();
  } catch {
    return THROWS;
  }
}

describe('externalCallScript: 바이트까지 같다', () => {
  // 따옴표·개행·NUL·$·역따옴표·역슬래시·유니코드. 요청은 JSON 리터럴로만 들어가므로 어떤 글자도 코드가 되지 않아야 한다
  const NASTY = [
    '',
    "'",
    '"',
    '\n',
    '\r\n',
    '\0',
    '$',
    '${process.exit(1)}',
    '`',
    '`${1}`',
    '\\',
    '\\\\n',
    "');process.exit(1);//",
    '"};process.exit(1);//',
    '</script>',
    '  ',
    '\u0007\u001f\u007f',
    '한글 😀 é',
    '\ud83d',
    '\ude00',
    'a\ud83d b',
    '﻿',
    '*/ /* // <!--',
  ];
  const EDGE = ['', 'const x = 1;', "import a from 'a';\nconsole.log(`${a}`, \"q\", '\\n', $1, \0);\n", '// 한글 😀\r\n$&`\'', 'export {};\n'.repeat(50)];

  it('거친 글자를 모든 자리에 넣어도 옛 구현과 같다', () => {
    let compared = 0;
    for (const edge of EDGE) {
      for (const text of NASTY) {
        for (const request of [
          { name: text, via: 'agent', method: 'GET', path: '/x' },
          { name: 'billing', via: text, method: 'POST', path: `/a${text}`, body: text },
          { name: 'n', via: 'v', method: text, path: '/', body: JSON.stringify({ k: text }) },
          { name: 'n', via: 'v', method: 'get', path: '/' },
        ]) {
          expect(externalCallScript(edge, request)).toBe(legacyExternalCallScript(edge, request));
          compared += 1;
        }
      }
    }
    expect(compared).toBe(EDGE.length * NASTY.length * 4);
  });

  it('무작위 글자 조합 5천 개에서 같다', () => {
    const rand = makeRandom(20_261_111);
    const alphabet = ["'", '"', '\n', '\0', '$', '`', '\\', '{', '}', 'a', ' ', '한', '😀', ' ', '\ud83d', '/', '?', '&', '='];
    for (let i = 0; i < 5000; i += 1) {
      const text = Array.from({ length: Math.floor(rand() * 12) }, () => alphabet[Math.floor(rand() * alphabet.length)]).join('');
      const request = { name: text, via: text.slice(1), method: 'POST', path: `/${text}`, ...(rand() < 0.5 ? { body: text } : {}) };
      // edge 본문은 파일을 utf8로 읽은 글자라 짝 없는 서로게이트가 없다(아래 시험이 따로 본다)
      const edge = `// ${text}`.replace(/[\ud800-\udfff]/g, '');
      expect(externalCallScript(edge, request), JSON.stringify(request)).toBe(legacyExternalCallScript(edge, request));
    }
  });

  it('의도한 차이: edge 본문에 짝 없는 서로게이트가 있으면 napi 경계에서 U+FFFD가 된다(파일을 utf8로 읽은 글자에는 생기지 않는다). 요청의 것은 \\udXXX 이스케이프라 그대로다', () => {
    const request = { name: '\ud83d', via: 'v', method: 'GET', path: '/' };
    expect(externalCallScript('//\ud83d', request)).toBe(legacyExternalCallScript('//\ufffd', request));
    expect(externalCallScript('', request)).toContain('"name":"\\ud83d"');
  });

  it('요청 값은 대본 안에서 JSON 문자열 리터럴 하나로만 나타난다', () => {
    const body = '"+process.exit(1)+"\'`${x}\\';
    const script = externalCallScript('', { name: 'n', via: 'v', method: 'POST', path: '/', body });
    const line = script.split('\n').find((candidate) => candidate.startsWith('const studioRequest = '))!;
    expect(JSON.parse(line.slice('const studioRequest = '.length, -1)).body).toBe(body);
  });
});

describe('composeEnvironment: 허용 목록이 옛 구현과 같다', () => {
  const NAMES = [
    'PATH', 'Path', 'path', 'HOME', 'Home', 'USER', 'user', 'LOGNAME', 'TMPDIR', 'TMP', 'TEMP', 'Temp', 'LANG', 'lang', 'SSH_AUTH_SOCK', 'ssh_auth_sock',
    'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'XDG_DATA_HOME', 'SystemRoot', 'SYSTEMROOT', 'systemroot', 'ComSpec', 'COMSPEC', 'PATHEXT', 'PathExt', 'USERPROFILE',
    'UserProfile', 'APPDATA', 'AppData', 'LOCALAPPDATA', 'ProgramData', 'PROGRAMDATA', 'ProgramFiles',
    'DOCKER_HOST', 'DOCKER_', 'DOCKER', 'docker_host', 'Docker_Host', 'DOCKERX', 'XDOCKER_HOST', 'COMPOSE_PROJECT_NAME', 'COMPOSE_', 'COMPOSE', 'compose_x',
    'BUILDKIT_PROGRESS', 'BUILDKIT_', 'BUILDKIT', 'buildkit_x', 'BUILDX_BUILDER', 'BUILDX', 'LC_ALL', 'LC_', 'LC', 'lc_all', 'Lc_Ctype', 'LC-ALL',
    'GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'NODE_ENV', 'NPM_TOKEN', 'SHELL', 'PWD', 'OLDPWD', 'HOMEDRIVE', 'HOME2',
    '', ' ', ' PATH', 'PATH ', 'PATH\0', 'PATH\n', 'K', 'LANĠ', 'ＰＡＴＨ', 'DOCKER_é', '__proto__', 'constructor', 'toString', '1', '0',
  ];

  it('이름마다 같은 결과를 낸다(대소문자만 다른 이름, 접두사 경계, 빈 이름 포함)', () => {
    for (const name of NAMES) {
      const env = { [name]: 'v', PATH: '/bin' };
      expect(composeEnvironment({}, env), JSON.stringify(name)).toEqual(legacyComposeEnvironment({}, env));
      expect(Object.keys(composeEnvironment({}, env)), JSON.stringify(name)).toEqual(Object.keys(legacyComposeEnvironment({}, env)));
    }
  });

  it('빈 값과 값이 없는 이름(undefined)을 같게 다룬다', () => {
    const env: NodeJS.ProcessEnv = { HOME: '', PATH: undefined, DOCKER_HOST: undefined, LANG: '', LC_ALL: 'C' };
    expect(composeEnvironment({}, env)).toEqual(legacyComposeEnvironment({}, env));
    expect(composeEnvironment({}, env)).toEqual({ HOME: '', LANG: '', LC_ALL: 'C' });
  });

  it('시크릿은 허용 목록과 상관없이 얹고 같은 이름은 값을 덮는다', () => {
    const env = { PATH: '/bin', HOME: '/h', GITHUB_TOKEN: 'leak', Path: 'p' };
    const secrets = { HOME: '/s', API_KEY: 'k', path: 'x', '': 'e', 'ＰＡＴＨ': 'w' };
    expect(composeEnvironment(secrets, env)).toEqual(legacyComposeEnvironment(secrets, env));
    expect(composeEnvironment(secrets, env)).not.toHaveProperty('GITHUB_TOKEN');
    expect(composeEnvironment(secrets, env)).not.toHaveProperty('Path');
  });

  it('무작위 환경 3천 개에서 같다. 범위 밖 이름은 하나도 새지 않는다', () => {
    const rand = makeRandom(7);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
    for (let i = 0; i < 3000; i += 1) {
      const env: NodeJS.ProcessEnv = {};
      for (let k = 0; k < 1 + Math.floor(rand() * 8); k += 1) env[pick(NAMES)] = rand() < 0.2 ? undefined : pick(['', 'v', '한글', '=', ' ']);
      const secrets: Record<string, string> = {};
      if (rand() < 0.4) secrets[pick(NAMES)] = 's';
      const got = composeEnvironment(secrets, env);
      expect(got, JSON.stringify({ env, secrets })).toEqual(legacyComposeEnvironment(secrets, env));
      for (const name of Object.keys(got)) {
        if (name in secrets) continue;
        expect(legacyComposeEnvironment({}, { [name]: 'x' })).toHaveProperty([name]);
      }
    }
  });

  it('process.env 기본값도 같다', () => {
    expect(composeEnvironment()).toEqual(legacyComposeEnvironment());
  });
});

describe('compose depends_on: 해석·시작 묶음·기다릴 조건이 옛 구현과 같다', () => {
  const CONFIGS: unknown[] = [
    null,
    undefined,
    5,
    'x',
    true,
    [],
    {},
    { services: null },
    { services: 5 },
    { services: 'web' },
    { services: [] },
    { services: [{ depends_on: ['db'] }, null, 'x'] },
    { services: { a: null, b: 'x', c: 5, d: [], e: { depends_on: null }, f: { depends_on: 0 }, g: { depends_on: '' }, h: { depends_on: 'db' } } },
    { services: { web: { depends_on: ['db', 'db', 5, null, 'cache', { x: 1 }] } } },
    { services: { web: { depends_on: { db: { condition: 'service_healthy', required: false }, cache: null, x: { condition: 3, required: 'yes' }, y: 'str', z: [], w: { condition: 'service_started', required: true } } } } },
    { services: { web: { depends_on: { 2: { condition: 'service_started' }, 1: {}, b: {}, a: {} } }, '10': { depends_on: ['2'] }, '2': {}, db: {} } },
    { services: { web: { depends_on: { constructor: { condition: 'service_healthy' }, toString: {}, __proto__x: {} } } } },
    { services: { a: { depends_on: ['b'] }, b: { depends_on: ['a'] }, c: { depends_on: { a: { condition: 'service_completed_successfully' } } } } },
    JSON.parse('{"services":{"web":{"depends_on":{"__proto__":{"condition":"service_started"},"db":{}}}}}'),
  ];

  it('모양이 제각각인 설정을 같게 읽는다', () => {
    for (const config of CONFIGS) {
      const got = observe(() => parseDependsOn(config));
      const want = observe(() => legacyDeps.parseDependsOn(config));
      expect(got, JSON.stringify(config)).toEqual(want);
      if (got !== THROWS) expect(Object.keys(got as object), JSON.stringify(config)).toEqual(Object.keys(want as object));
    }
  });

  it('의도한 차이: 서비스 이름이 __proto__이면 옛 구현은 결과의 프로토타입을 바꿨다. 지금은 그 서비스를 버린다', () => {
    const config = JSON.parse('{"services":{"__proto__":{"depends_on":["db"]},"web":{"depends_on":["db"]}}}');
    const got = parseDependsOn(config);
    const old = legacyDeps.parseDependsOn(config);
    // 키로는 둘 다 없다. 옛 구현은 객체의 프로토타입에 숨었다(그래서 dependsOn['db']가 엉뚱하게 찾아졌다)
    expect(Object.keys(got)).toEqual(['web']);
    expect(Object.keys(old)).toEqual(['web']);
    expect(Object.getPrototypeOf(got)).toBe(Object.prototype);
    expect((got as Record<string, unknown>).db).toBeUndefined();
  });

  const SERVICES = ['web', 'api', 'db', 'cache', 'worker', 'a', 'b', 'c', 'constructor', 'toString', '', '1', '2'];

  it('무작위 의존 그래프 3천 개에서 시작 묶음과 기다릴 조건이 같다', () => {
    const rand = makeRandom(1170);
    const pick = <T>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]!;
    const conditions = ['service_started', 'service_healthy', 'service_completed_successfully', '', undefined];
    let cyclic = 0;
    for (let i = 0; i < 3000; i += 1) {
      const dependsOn: DependsOn = {};
      for (const name of SERVICES) {
        if (rand() < 0.3) continue;
        dependsOn[name] = {};
        for (const dep of SERVICES) if (rand() < 0.25) dependsOn[name]![dep] = rand() < 0.2 ? {} : { condition: pick(conditions) as string };
      }
      const list = Array.from({ length: Math.floor(rand() * 9) }, () => pick(SERVICES));
      const got = startWaves(list, dependsOn);
      expect(got, JSON.stringify({ list, dependsOn })).toEqual(legacyDeps.startWaves(list, dependsOn));
      if (got.length === 1 && got[0]!.length > 1) cyclic += 1;
      const later = Array.from({ length: Math.floor(rand() * 5) }, () => pick(SERVICES));
      for (const service of SERVICES) {
        expect(awaitedCondition(service, later, dependsOn), JSON.stringify({ service, later, dependsOn })).toBe(legacyDeps.awaitedCondition(service, later, dependsOn));
      }
    }
    expect(cyclic).toBeGreaterThan(50);
  });

  it('고정 사례: 순서·순환·겹친 이름·목록 밖 의존', () => {
    const deps: DependsOn = { web: { api: { condition: 'service_healthy' } }, api: { db: { condition: 'service_completed_successfully' } }, db: {} };
    for (const list of [['web', 'api', 'db'], ['db', 'web'], ['web', 'web', 'db', 'db'], [], ['x']]) expect(startWaves(list, deps)).toEqual(legacyDeps.startWaves(list, deps));
    expect(startWaves(['web', 'api', 'db'], deps)).toEqual([['db'], ['api'], ['web']]);
    expect(awaitedCondition('api', ['web'], deps)).toBe('service_healthy');
    expect(awaitedCondition('db', ['api'], deps)).toBe('service_completed_successfully');
    expect(awaitedCondition('db', ['web'], deps)).toBeUndefined();
  });

  it('parseDependsOn이 만든 값을 startWaves가 그대로 받는다(compose가 정규화한 설정 한 벌)', () => {
    const config = { services: { web: { depends_on: { api: { condition: 'service_healthy', required: true } } }, api: { depends_on: ['db'] }, db: {} } };
    expect(startWaves(['web', 'api', 'db'], parseDependsOn(config))).toEqual(legacyDeps.startWaves(['web', 'api', 'db'], legacyDeps.parseDependsOn(config)));
  });
});

describe('부하 러너: 계획과 출력 해석이 옛 구현과 같다', () => {
  it('상수가 Rust의 값과 맞는다', () => {
    const config = loadConfig({ service: 'a', method: 'GET', path: '/', requests: 1, concurrent: 1 }, { port: 1, threads: 1 });
    expect(config.requestTimeoutMs).toBe(LOAD_REQUEST_TIMEOUT_MS);
    expect(config.deadlineMs).toBe(LOAD_DEADLINE_MS);
    expect(loadRunArgs({ name: 'n', network: 'x', sandboxId: 's', threads: 1 })).toContain(`b-studio.service=${LOAD_RUNNER_SERVICE}`);
  });

  it('loadThreads: 연결 수와 CPU 수의 경계, NaN·Infinity·음수·0', () => {
    const values = [0, 1, 249, 250, 251, 500, 501, 750, 1000, 1001, 100_000, -1, -250, 0.5, NaN, Infinity, -Infinity];
    const cpus = [undefined, 0, 1, 2, 3, 4, 7, 8, 16, 0.5, -1, NaN, Infinity, -Infinity];
    for (const concurrent of values) {
      for (const daemonCpus of cpus) {
        expect(loadThreads(concurrent, daemonCpus), `${concurrent}/${daemonCpus}`).toEqual(legacyLoad.loadThreads(concurrent, daemonCpus));
      }
    }
  });

  it('loadRunArgs: 런타임 유무, 빈 런타임, 수 표기', () => {
    for (const runtime of [undefined, '', 'runsc', 'kata-qemu', ' runsc ', '한글']) {
      for (const threads of [1, 2, 4, 1.5, 0, NaN, 1e21, 1e-7]) {
        const plan = { name: 'b-studio-load-ab', network: 'sb_sandbox', sandboxId: 'sb', threads, ...(runtime === undefined ? {} : { runtime }) };
        expect(loadRunArgs(plan), JSON.stringify(plan)).toEqual(legacyLoad.loadRunArgs(plan));
      }
    }
    expect(LOAD_RUNNER_IMAGE).toBe(legacyLoad.LOAD_RUNNER_IMAGE);
  });

  const REQUESTS: LoadRequest[] = [
    { service: 'api', method: 'GET', path: '/', concurrent: 1, requests: 1 },
    { service: 'api', method: 'POST', path: '/x?y=1', headers: { 'content-type': 'application/json', 'x-a': "'`$\\" }, body: '{"a":"\n"}', concurrent: 50, requests: 1000, warmup: 10, latencyOf: [200, 201] },
    { service: 'api', method: 'GET', path: '/', headers: {}, body: '', concurrent: 1, requests: 1, warmup: 0, latencyOf: [] },
    { service: 'api', method: 'GET', path: '/{{seq}}', concurrent: 1, requests: 1, headers: undefined, body: undefined, warmup: undefined, latencyOf: undefined },
    { service: 'api', method: 'GET', path: '/', concurrent: NaN, requests: Infinity, warmup: -0 },
    { service: '한글', method: 'GET', path: '/😀', concurrent: 2, requests: 3 },
    { service: 'api', method: 'GET', path: '/', concurrent: 1, requests: 1, body: null as unknown as string, warmup: null as unknown as number, headers: null as unknown as Record<string, string> },
  ];

  it('loadConfig: 속성 유무와 순서가 같다', () => {
    for (const request of REQUESTS) {
      for (const target of [{ port: 3000, threads: 1 }, { port: 80, threads: 4 }]) {
        const got = loadConfig(request, target);
        const want = legacyLoad.loadConfig(request, target);
        expect(got, JSON.stringify(request)).toEqual(want);
        expect(Object.keys(got), JSON.stringify(request)).toEqual(Object.keys(want).filter((key) => want[key] !== undefined));
        // 러너가 받는 글자(JSON.stringify)가 같다
        expect(loadScript('RUN', got)).toBe(legacyLoad.loadScript('RUN', want));
      }
    }
  });

  it('loadConfig: latencyOf를 글자로 주면 글자마다 펼친다(옛 구현의 [...x]와 같다). 배열이 아닌 참 값은 둘 다 던진다', () => {
    for (const latencyOf of ['200', '😀a', 5, true, {}, 0, '']) {
      const request = { service: 'a', method: 'GET', path: '/', concurrent: 1, requests: 1, latencyOf } as unknown as LoadRequest;
      expect(observe(() => loadConfig(request, { port: 1, threads: 1 })), String(latencyOf)).toEqual(observe(() => legacyLoad.loadConfig(request, { port: 1, threads: 1 })));
    }
  });

  it('loadScript: 거친 글자가 든 러너와 설정을 그대로 잇는다', () => {
    for (const runner of ['', 'run();', "'`$\\\n\0한글😀", '// no newline']) {
      for (const config of [{}, { a: "'`$\\\n\0" }, { host: '한글', n: [1, null] }]) expect(loadScript(runner, config)).toBe(legacyLoad.loadScript(runner, config));
    }
  });

  // parseLoadOutput의 기준 출력. 하나씩 망가뜨려 옛 구현과 같은 판정을 내는지 본다
  const GOOD = {
    requests: 10,
    concurrent: 2,
    threads: 1,
    completed: 8,
    elapsedMs: 12.5,
    statuses: { '200': 7, '500': 1 },
    errors: { timeout: 2 },
    latency: { count: 8, p50: 1, p95: 2, p99: 3, max: 4 },
    connect: { count: 2, p50: 1, p95: 1, p99: 1, max: 1, errors: 0 },
    loopDelay: { p99: 1, max: 2 },
    warmup: { requests: 0, errors: 0 },
  };
  const clone = () => JSON.parse(JSON.stringify(GOOD)) as Record<string, any>;
  const MUTATIONS: Array<[string, (o: Record<string, any>) => void]> = [
    ['정상', () => {}],
    ['completed 불일치', (o) => (o.completed = 7)],
    ['completed 소수', (o) => (o.completed = 8.5)],
    ['completed 음수', (o) => (o.completed = -8)],
    ['completed 문자열', (o) => (o.completed = '8')],
    ['요청 수 불일치', (o) => (o.requests = 11)],
    ['동시 수 불일치', (o) => (o.concurrent = 3)],
    ['오류 합 부족', (o) => (o.errors = { timeout: 1 })],
    ['오류 합 초과', (o) => (o.errors = { timeout: 3 })],
    ['오류 키 여럿', (o) => (o.errors = { timeout: 1, reset: 1 })],
    ['오류 값 소수', (o) => (o.errors = { timeout: 2.5 })],
    ['오류 값 음수', (o) => (o.errors = { timeout: -1 })],
    ['오류 배열', (o) => (o.errors = [2])],
    ['오류 null', (o) => (o.errors = null)],
    ['상태 키 100', (o) => (o.statuses = { '100': 7, '500': 1 })],
    ['상태 키 600', (o) => (o.statuses = { '200': 7, '600': 1 })],
    ['상태 키 99', (o) => (o.statuses = { '99': 7, '500': 1 })],
    ['상태 키 2000', (o) => (o.statuses = { '2000': 7, '500': 1 })],
    ['상태 키 개행', (o) => (o.statuses = { '200\n': 7, '500': 1 })],
    ['상태 키 전각', (o) => (o.statuses = { '２００': 7, '500': 1 })],
    ['상태 키 공백', (o) => (o.statuses = { ' 20': 7, '500': 1 })],
    ['상태 없음', (o) => delete o.statuses],
    ['지연 표본 초과', (o) => (o.latency.count = 9)],
    ['지연 표본 0', (o) => (o.latency = { count: 0 })],
    ['지연 표본 0이고 값 있음', (o) => (o.latency = { count: 0, p50: 'x' })],
    ['지연 p50 null', (o) => (o.latency.p50 = null)],
    ['지연 p95 음수', (o) => (o.latency.p95 = -1)],
    ['지연 max 문자열', (o) => (o.latency.max = '4')],
    ['지연 없음', (o) => delete o.latency],
    ['지연 배열', (o) => (o.latency = [])],
    ['연결 오류 없음', (o) => delete o.connect.errors],
    ['연결 오류 소수', (o) => (o.connect.errors = 0.5)],
    ['연결 지연 p99 없음', (o) => delete o.connect.p99],
    ['연결 표본 0', (o) => (o.connect = { count: 0, errors: 1 })],
    ['연결 없음', (o) => delete o.connect],
    ['루프 지연 없음', (o) => delete o.loopDelay],
    ['루프 지연 p99 음수', (o) => (o.loopDelay.p99 = -1)],
    ['루프 지연 null', (o) => (o.loopDelay = null)],
    ['준비 없음', (o) => delete o.warmup],
    ['준비 요청 소수', (o) => (o.warmup.requests = 1.5)],
    ['경과 음수', (o) => (o.elapsedMs = -1)],
    ['경과 문자열', (o) => (o.elapsedMs = '1')],
    ['스레드 0', (o) => (o.threads = 0)],
    ['스레드 소수', (o) => (o.threads = 1.5)],
    ['여분 키', (o) => (o.extra = { a: 1 })],
    ['요청 1.0 표기', (o) => (o.requests = 10.0)],
  ];

  it('출력 해석: 하나씩 망가뜨린 출력 46개에서 판정과 읽은 값이 같다', () => {
    let accepted = 0;
    for (const [name, mutate] of MUTATIONS) {
      const output = clone();
      mutate(output);
      const stdout = `log line\n${JSON.stringify(output)}\n`;
      const got = parseLoadOutput(stdout, { requests: 10, concurrent: 2 });
      expect(got, name).toEqual(legacyLoad.parseLoadOutput(stdout, { requests: 10, concurrent: 2 }));
      if (got) {
        accepted += 1;
        expect(Object.keys(got), name).toEqual(Object.keys(legacyLoad.parseLoadOutput(stdout, { requests: 10, concurrent: 2 })!));
      }
    }
    expect(accepted).toBeGreaterThan(2);
    expect(accepted).toBeLessThan(MUTATIONS.length / 2);
  });

  it('출력 해석: 줄 처리와 JSON 문법(마지막 줄만, 공백, 여러 줄, 깨진 JSON, 큰 수, 중복 키)', () => {
    const line = JSON.stringify(GOOD);
    const texts = [
      '', '\n', '  \n  ', line, `${line}\n`, `\n\n${line}\n\n`, `x\n${line}`, `${line}\nx`, `${line}\n `, `  ${line}  `, `\t${line}\r\n`, `a\r\n${line}\r\n`, `　${line}`, `﻿${line}`,
      line.slice(0, -1), `${line}}`, `[${line}]`, 'null', '5', '"x"', 'true', '{}', '[]', `${line}${line}`,
      line.replace('"requests":10', '"requests":1e1'), line.replace('"requests":10', '"requests":10.0'), line.replace('"requests":10', '"requests":1E+1'), line.replace('"elapsedMs":12.5', '"elapsedMs":1e999'),
      line.replace('"elapsedMs":12.5', '"elapsedMs":-0'), line.replace('"elapsedMs":12.5', '"elapsedMs":1e308'), line.replace('"threads":1', '"threads":1e0'),
      line.replace('"completed":8', '"completed":8,"completed":7'), line.replace('"completed":8', '"completed":7,"completed":8'), line.replace('"errors":{"timeout":2}', '"errors":{"__proto__":2}'),
      line.replace('"errors":{"timeout":2}', '"errors":{"1":2}'), line.replace('"errors":{"timeout":2}', '"errors":{"b":1,"a":1}'), line.replace('"statuses":{"200":7,"500":1}', '"statuses":{"500":1,"200":7}'),
      line.replace('"errors":{"timeout":2}', '"errors":{"timeout":0,"x":2}'), line.replace('"warmup"', '"warmup":{"requests":0,"errors":0},"warmup"'),
      line.replace(/"requests":10/, '"requests":9007199254740993'), line.replace('"elapsedMs":12.5', '"elapsedMs":0.1e1'),
    ];
    for (const stdout of texts) {
      const got = observe(() => parseLoadOutput(stdout, { requests: 10, concurrent: 2 }));
      const want = observe(() => legacyLoad.parseLoadOutput(stdout, { requests: 10, concurrent: 2 }));
      expect(got, JSON.stringify(stdout)).toEqual(want);
      if (got && got !== THROWS) expect(JSON.stringify(got), JSON.stringify(stdout)).toBe(JSON.stringify(want));
    }
    // 요청 쪽이 NaN이거나 다르면 읽지 않는다
    for (const request of [{ requests: NaN, concurrent: 2 }, { requests: 10, concurrent: NaN }, { requests: 10, concurrent: 3 }, { requests: 9, concurrent: 2 }]) {
      expect(parseLoadOutput(line, request)).toEqual(legacyLoad.parseLoadOutput(line, request));
    }
  });
});

describe('LocalDockerProvider의 순수 도우미가 옛 구현과 같다', () => {
  const STDERRS = [
    '',
    'Bind for 0.0.0.0:40001 failed: port is already allocated',
    'Error response from daemon: driver failed programming external connectivity on endpoint x: Error starting userland proxy: listen tcp4 0.0.0.0:3000: bind: address already in use',
    'failed to bind port 0.0.0.0:80/tcp: listen tcp4: address already in use',
    'failed to bind port x\naddress already in use',
    'ADDRESS ALREADY IN USE',
    'Address Already In Use',
    'PORT IS ALREADY ALLOCATED',
    'ERROR STARTING USERLAND PROXY',
    'address already\nin use',
    'address  already in use',
    'port is already\nallocated',
    'addreſs already in use',
    'port iſ already allocated',
    'error starting userland prÅoxy',
    'no space left on device',
    'pull access denied for x',
    'address already in us',
    'failed to bind port',
    ' address already in use',
    'x address already in use y',
  ];

  it('isPortBindConflict', () => {
    for (const stderr of STDERRS) expect(isPortBindConflict(stderr), JSON.stringify(stderr)).toBe(legacyHelpers.isPortBindConflict(stderr));
  });

  it('describeDockerFailure: Error·글자·그 밖의 값, 디스크 부족 문구 위치', () => {
    const inputs: unknown[] = [
      ...STDERRS,
      new Error('write: no space left on device'),
      new Error('No space left on device'),
      new Error(''),
      'x no space left on device y',
      'no space left on device\n',
      'a\ud83d no space left on device',
      'a\ud83d b',
      undefined,
      null,
      5,
      { message: 'no space left on device' },
      ['no space left on device'],
      Symbol.iterator.description,
    ];
    for (const input of inputs) expect(describeDockerFailure(input), String(input)).toBe(legacyHelpers.describeDockerFailure(input));
    expect(describeDockerFailure('no space left on device')).toBe(`no space left on device\n${DOCKER_OUT_OF_SPACE}`);
  });

  it('splitUpArgs', () => {
    const cases: string[][] = [
      [], ['up'], ['up', '--detach'], ['up', '--detach', '--build', '--force-recreate'], ['up', '--no-deps', 'web'], ['up', '--no-deps'], ['up', 'web', 'api'],
      ['up', '--detach', '--no-deps', 'web', '--build'], ['create', 'a'], ['--detach'], ['-d', 'x'], ['up', '', 'x'], ['up', '-'], ['up', '--no-deps', '--no-deps', 'w', '--detach', '--detach'],
      ['up', '한글', '😀'], ['up', '--no-deps=true', 'w'], ['up', '--NO-DEPS', 'w'], ['up', ' --detach'],
    ];
    for (const args of cases) {
      expect(splitUpArgs(args), JSON.stringify(args)).toEqual(legacyHelpers.splitUpArgs(args));
      expect(Object.keys(splitUpArgs(args))).toEqual(Object.keys(legacyHelpers.splitUpArgs(args)));
    }
  });

  it('runtimeFromEnv·sandboxBuildNoCache: 공백, 대소문자, 닮은 글자', () => {
    const values = [undefined, '', ' ', '\n', 'runsc', ' runsc ', '\truntime\n', '﻿runsc', ' runsc', '\u0085runsc', 'run sc', '1', ' 1 ', '1\n', '01', '0', 'true', 'TRUE', 'True', ' tRuE\t', 'tru', 'truee', 'yes', 'on', '2', 'K', 'trıe', 'TRUE ', '　true', '１', 'ｔｒｕｅ'];
    for (const value of values) {
      const env = value === undefined ? {} : { B_STUDIO_CONTAINER_RUNTIME: value, B_STUDIO_SANDBOX_BUILD_NO_CACHE: value };
      expect(runtimeFromEnv(env), JSON.stringify(value)).toBe(legacyHelpers.runtimeFromEnv(env));
      expect(sandboxBuildNoCache(env), JSON.stringify(value)).toBe(legacyHelpers.sandboxBuildNoCache(env));
    }
    expect(runtimeFromEnv()).toBe(legacyHelpers.runtimeFromEnv());
    expect(sandboxBuildNoCache()).toBe(legacyHelpers.sandboxBuildNoCache());
  });
});
