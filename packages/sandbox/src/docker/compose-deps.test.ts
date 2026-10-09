import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LoadedProject } from '@b-studio/spec';
import { afterEach, describe, expect, it } from 'vitest';
import { awaitedCondition, parseDependsOn, startWaves } from './compose-deps';
import { LocalDockerProvider } from './compose-provider';

describe('compose 설정에서 의존 관계를 읽는다', () => {
  it('긴 형식(조건이 있는 객체)과 짧은 형식(배열)을 모두 읽고, depends_on이 없는 서비스는 비워 둔다', () => {
    expect(
      parseDependsOn({
        services: {
          api: { depends_on: { db: { condition: 'service_healthy', required: true }, migrate: { condition: 'service_completed_successfully' } } },
          web: { depends_on: ['api'] },
          db: {},
        },
      }),
    ).toEqual({
      api: { db: { condition: 'service_healthy', required: true }, migrate: { condition: 'service_completed_successfully' } },
      web: { api: { condition: 'service_started' } },
    });
    expect(parseDependsOn({})).toEqual({});
    expect(parseDependsOn(null)).toEqual({});
  });
});

describe('시작 순서', () => {
  const dependsOn = { api: { db: { condition: 'service_healthy' }, kafka: { condition: 'service_started' } }, web: { api: { condition: 'service_started' } } };

  it('의존하는 서비스가 앞 묶음에 오도록 묶는다', () => {
    expect(startWaves(['web', 'api', 'db', 'kafka'], dependsOn)).toEqual([['db', 'kafka'], ['api'], ['web']]);
  });

  it('목록에 없는 의존 서비스는 무시한다(꺼 둔 의존 서비스를 따라 켜지 않는다)', () => {
    // kafka와 db를 뺀 목록: api는 기다릴 것이 없어 첫 묶음이다
    expect(startWaves(['web', 'api'], dependsOn)).toEqual([['api'], ['web']]);
    expect(startWaves(['api'], dependsOn)).toEqual([['api']]);
  });

  it('의존이 돌고 돌거나 자기 자신을 가리켜도 멈추지 않고 남은 것을 한 묶음으로 둔다', () => {
    expect(startWaves(['a', 'b', 'c'], { a: { b: {} }, b: { a: {} }, c: { c: {} } })).toEqual([['c'], ['a', 'b']]);
  });

  it('기다릴 조건은 뒤에 시작할 서비스가 건 것만 보고, 여럿이면 healthy를 고른다', () => {
    expect(awaitedCondition('db', ['api', 'web'], dependsOn)).toBe('service_healthy');
    expect(awaitedCondition('kafka', ['api'], dependsOn)).toBeUndefined();
    expect(awaitedCondition('db', ['web'], dependsOn)).toBeUndefined();
    expect(awaitedCondition('seed', ['api', 'job'], { api: { seed: { condition: 'service_completed_successfully' } }, job: { seed: { condition: 'service_healthy' } } })).toBe('service_healthy');
  });
});

describe('확인한 컨테이너를 의존 순서대로 시작한다 (트러블슈팅 121)', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  const project = { spec: { name: 'shop' }, root: '/tmp/shop', composePath: '/tmp/shop/compose.yaml', managed: [], composeServices: ['api', 'db'], sharedVolumes: [], external: [], publicUrlRefs: [] } as unknown as LoadedProject;

  /**
   * 서비스 api·db·edge의 컨테이너(c-api, c-db, c-edge)가 만들어진 것처럼 답하는 가짜 docker.
   * `compose config`는 api가 db를 조건(condition)으로 기다린다고 답하고, db의 상태 조회는 states에 적은 순서대로 답한다(마지막 값이 되풀이된다)
   */
  async function fakeDocker(condition: string, states: string[]): Promise<{ dockerBin: string; log: () => Promise<string> }> {
    const dir = await mkdtemp(path.join(tmpdir(), 'start-order-'));
    dirs.push(dir);
    const log = path.join(dir, 'args.log');
    const containers = ['api', 'db', 'b-studio-edge'].map((service) => ({ Id: `c-${service === 'b-studio-edge' ? 'edge' : service}`, Config: { Labels: { 'com.docker.compose.service': service } }, Mounts: [] }));
    await writeFile(path.join(dir, 'inspect.json'), JSON.stringify(containers));
    await writeFile(path.join(dir, 'config.json'), JSON.stringify({ services: { api: { depends_on: { db: { condition } } }, db: {} } }));
    await Promise.all(states.map((state, index) => writeFile(path.join(dir, `state-${index + 1}.json`), state)));
    await writeFile(path.join(dir, 'state-count'), '0');
    const bin = path.join(dir, 'docker');
    await writeFile(
      bin,
      `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
case " $* " in
  *" --no-trunc "*) printf 'c-api\\nc-db\\nc-edge\\n'; exit 0 ;;
  *" inspect --format "*)
    n=$(cat "${dir}/state-count"); n=$((n + 1)); echo "$n" > "${dir}/state-count"
    if [ -f "${dir}/state-$n.json" ]; then cat "${dir}/state-$n.json"; else cat "${dir}/state-${states.length}.json"; fi
    exit 0 ;;
  *" inspect c-api c-db c-edge "*) cat "${dir}/inspect.json"; exit 0 ;;
esac
for a in "$@"; do
  case "$a" in
    config) case "$*" in *"--profile *"*) cat "${dir}/config.json" ;; *) echo '{"services":{}}' ;; esac; exit 0 ;;
    ps) echo '[]'; exit 0 ;;
  esac
done
exit 0
`,
    );
    await chmod(bin, 0o755);
    return { dockerBin: bin, log: () => readFile(log, 'utf8') };
  }

  const starts = (log: string) => log.split('\n').filter((line) => line.startsWith('start '));

  it('healthy를 기다리는 서비스는 의존 서비스가 healthy가 된 뒤에 시작한다', async () => {
    const { dockerBin, log } = await fakeDocker('service_healthy', ['{"Status":"running","Health":{"Status":"starting"}}', '{"Status":"running","Health":{"Status":"starting"}}', '{"Status":"running","Health":{"Status":"healthy"}}']);
    const sandbox = await new LocalDockerProvider({ dockerBin }).create(project);
    await sandbox.ensureInfra!(['api', 'db']);
    const lines = (await log()).split('\n');
    // 첫 묶음(의존이 없는 db와 edge)을 시작하고, db의 상태를 세 번 본 뒤에 api를 시작한다
    expect(starts(await log())).toEqual(['start c-db c-edge', 'start c-api']);
    const first = lines.indexOf('start c-db c-edge');
    const second = lines.indexOf('start c-api');
    expect(lines.slice(first, second).filter((line) => line.startsWith('inspect --format')).length).toBe(3);
    // 컨테이너를 만들 수 있는 명령(up)은 만들기 단계 한 번뿐이다
    expect(lines.filter((line) => line.split(' ').includes('up')).every((line) => line.includes('--no-start'))).toBe(true);
  });

  it('의존 서비스가 unhealthy가 되면 뒤의 서비스를 시작하지 않고 실패로 돌려준다', async () => {
    const { dockerBin, log } = await fakeDocker('service_healthy', ['{"Status":"running","Health":{"Status":"unhealthy"}}']);
    const sandbox = await new LocalDockerProvider({ dockerBin }).create(project);
    const result = await sandbox.ensureInfra!(['api', 'db']);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('container db is unhealthy');
    expect(starts(await log())).toEqual(['start c-db c-edge']);
  });

  it('healthcheck가 없는 서비스에 service_healthy를 걸면 compose처럼 실패한다', async () => {
    const { dockerBin, log } = await fakeDocker('service_healthy', ['{"Status":"running"}']);
    const sandbox = await new LocalDockerProvider({ dockerBin }).create(project);
    const result = await sandbox.ensureInfra!(['api', 'db']);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('has no healthcheck configured');
    expect(starts(await log())).toEqual(['start c-db c-edge']);
  });

  it('service_started 조건은 순서만 지키고 상태를 기다리지 않는다', async () => {
    const { dockerBin, log } = await fakeDocker('service_started', ['{"Status":"running"}']);
    const sandbox = await new LocalDockerProvider({ dockerBin }).create(project);
    await sandbox.ensureInfra!(['api', 'db']);
    expect(starts(await log())).toEqual(['start c-db c-edge', 'start c-api']);
    expect(await log()).not.toContain('inspect --format');
  });

  it('service_completed_successfully는 의존 서비스가 0으로 끝난 뒤에 시작하고, 0이 아니면 시작하지 않는다', async () => {
    const done = await fakeDocker('service_completed_successfully', ['{"Status":"running"}', '{"Status":"exited","ExitCode":0}']);
    await (await new LocalDockerProvider({ dockerBin: done.dockerBin }).create(project)).ensureInfra!(['api', 'db']);
    expect(starts(await done.log())).toEqual(['start c-db c-edge', 'start c-api']);

    const failed = await fakeDocker('service_completed_successfully', ['{"Status":"exited","ExitCode":3}']);
    const result = await (await new LocalDockerProvider({ dockerBin: failed.dockerBin }).create(project)).ensureInfra!(['api', 'db']);
    expect(result.ok).toBe(false);
    expect(starts(await failed.log())).toEqual(['start c-db c-edge']);
  });
});
