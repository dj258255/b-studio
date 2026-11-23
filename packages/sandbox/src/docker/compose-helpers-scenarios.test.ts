import { describe, expect, it } from 'vitest';
import { parseDependsOn, startWaves, awaitedCondition, type DependsOn } from './compose-deps';
import { composeEnvironment } from './compose-env';
import { describeDockerFailure, DOCKER_OUT_OF_SPACE } from './compose-provider';
import { externalCallScript } from './external-call';
import { LOAD_DEADLINE_MS, LOAD_REQUEST_TIMEOUT_MS, LOAD_RUNNER_SERVICE, loadConfig, loadRunArgs, parseLoadOutput } from './load-runner';

/**
 * 샌드박스 조율의 순수 도우미를 Rust로 옮기면서(ADR-195 4f A4a) 옛 TS 구현과 견주던 시험에서, 옛 구현과 무관한 확인만 남겼다(#1347에서 옛 구현을 지웠다).
 * 남긴 것: 요청 값이 대본에서 JSON 리터럴로만 나타나는 성질, 시크릿·허용 목록, depends_on의 `__proto__` 방어, 고정 사례, Rust와 맞는 상수.
 */

describe('externalCallScript', () => {
  it('의도한 차이: edge 본문에 짝 없는 서로게이트가 있으면 napi 경계에서 U+FFFD가 된다(파일을 utf8로 읽은 글자에는 생기지 않는다). 요청의 것은 \\udXXX 이스케이프라 그대로다', () => {
    const request = { name: '\ud83d', via: 'v', method: 'GET', path: '/' };
    expect(externalCallScript('//\ud83d', request)).toBe(externalCallScript('//\ufffd', request));
    expect(externalCallScript('', request)).toContain('"name":"\\ud83d"');
  });

  it('요청 값은 대본 안에서 JSON 문자열 리터럴 하나로만 나타난다', () => {
    const body = '"+process.exit(1)+"\'`${x}\\';
    const script = externalCallScript('', { name: 'n', via: 'v', method: 'POST', path: '/', body });
    const line = script.split('\n').find((candidate) => candidate.startsWith('const studioRequest = '))!;
    expect(JSON.parse(line.slice('const studioRequest = '.length, -1)).body).toBe(body);
  });
});

describe('composeEnvironment', () => {
  it('빈 값은 남기고 값이 없는 이름(undefined)은 뺀다', () => {
    const env: NodeJS.ProcessEnv = { HOME: '', PATH: undefined, DOCKER_HOST: undefined, LANG: '', LC_ALL: 'C' };
    expect(composeEnvironment({}, env)).toEqual({ HOME: '', LANG: '', LC_ALL: 'C' });
  });

  it('시크릿은 허용 목록과 상관없이 얹고 같은 이름은 값을 덮는다. 허용 목록 밖의 이름은 새지 않는다', () => {
    const env = { PATH: '/bin', HOME: '/h', GITHUB_TOKEN: 'leak', Path: 'p' };
    const secrets = { HOME: '/s', API_KEY: 'k', path: 'x', '': 'e', 'ＰＡＴＨ': 'w' };
    const got = composeEnvironment(secrets, env);
    expect(got).not.toHaveProperty('GITHUB_TOKEN');
    expect(got).not.toHaveProperty('Path');
    expect(got.HOME).toBe('/s');
    expect(got.API_KEY).toBe('k');
  });

  it('허용 목록 밖의 이름(대소문자만 다른 이름, 접두사 경계)은 새지 않는다', () => {
    for (const name of ['GITHUB_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'NPM_TOKEN', 'Path', 'PATH ', ' PATH', 'DOCKERX', 'XDOCKER_HOST', 'HOME2', '__proto__', 'constructor']) {
      expect(composeEnvironment({}, { [name]: 'v', PATH: '/bin' }), JSON.stringify(name)).not.toHaveProperty([name]);
    }
  });
});

describe('compose depends_on', () => {
  it('의도한 차이: 서비스 이름이 __proto__이면 옛 구현은 결과의 프로토타입을 바꿨다. 지금은 그 서비스를 버린다', () => {
    const config = JSON.parse('{"services":{"__proto__":{"depends_on":["db"]},"web":{"depends_on":["db"]}}}');
    const got = parseDependsOn(config);
    // 키로는 없다. 옛 구현은 객체의 프로토타입에 숨었다(그래서 dependsOn['db']가 엉뚱하게 찾아졌다)
    expect(Object.keys(got)).toEqual(['web']);
    expect(Object.getPrototypeOf(got)).toBe(Object.prototype);
    expect((got as Record<string, unknown>).db).toBeUndefined();
  });

  it('고정 사례: 순서·순환·겹친 이름·목록 밖 의존', () => {
    const deps: DependsOn = { web: { api: { condition: 'service_healthy' } }, api: { db: { condition: 'service_completed_successfully' } }, db: {} };
    expect(startWaves(['web', 'api', 'db'], deps)).toEqual([['db'], ['api'], ['web']]);
    expect(awaitedCondition('api', ['web'], deps)).toBe('service_healthy');
    expect(awaitedCondition('db', ['api'], deps)).toBe('service_completed_successfully');
    expect(awaitedCondition('db', ['web'], deps)).toBeUndefined();
  });

  it('parseDependsOn이 만든 값을 startWaves가 그대로 받는다(compose가 정규화한 설정 한 벌)', () => {
    const config = { services: { web: { depends_on: { api: { condition: 'service_healthy', required: true } } }, api: { depends_on: ['db'] }, db: {} } };
    expect(startWaves(['web', 'api', 'db'], parseDependsOn(config))).toEqual([['db'], ['api'], ['web']]);
  });
});

describe('부하 러너', () => {
  it('상수가 Rust의 값과 맞는다', () => {
    const config = loadConfig({ service: 'a', method: 'GET', path: '/', requests: 1, concurrent: 1 }, { port: 1, threads: 1 });
    expect(config.requestTimeoutMs).toBe(LOAD_REQUEST_TIMEOUT_MS);
    expect(config.deadlineMs).toBe(LOAD_DEADLINE_MS);
    expect(loadRunArgs({ name: 'n', network: 'x', sandboxId: 's', threads: 1 })).toContain(`b-studio.service=${LOAD_RUNNER_SERVICE}`);
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

  it('출력 해석: 기준 출력은 읽고, 요청과 어긋나거나 모양이 틀린 출력은 읽지 않는다', () => {
    const request = { requests: 10, concurrent: 2 };
    expect(parseLoadOutput(`log line\n${JSON.stringify(GOOD)}\n`, request)).toBeTruthy();
    for (const [name, mutate] of [
      ['completed 불일치', (o: Record<string, any>) => (o.completed = 7)],
      ['completed 소수', (o: Record<string, any>) => (o.completed = 8.5)],
      ['스레드 소수', (o: Record<string, any>) => (o.threads = 1.5)],
    ] as const) {
      const output = clone();
      mutate(output);
      expect(parseLoadOutput(`log line\n${JSON.stringify(output)}\n`, request), name).toBeFalsy();
    }
    for (const bad of [{ requests: NaN, concurrent: 2 }, { requests: 10, concurrent: NaN }, { requests: 10, concurrent: 3 }, { requests: 9, concurrent: 2 }]) {
      expect(parseLoadOutput(JSON.stringify(GOOD), bad)).toBeFalsy();
    }
  });
});

describe('describeDockerFailure', () => {
  it('디스크 부족 문구가 있으면 안내를 덧붙인다', () => {
    expect(describeDockerFailure('no space left on device')).toBe(`no space left on device\n${DOCKER_OUT_OF_SPACE}`);
  });
});
