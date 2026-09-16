import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DOCKER_OUT_OF_SPACE, describeDockerFailure } from './docker/compose-provider';
import { findSandboxLeftovers, pruneSandboxLeftovers } from './docker/prune';

/** `studio-orders-1a2b3c`가 남긴 자원, 실행 중인 `studio-live-9f9f9f`, 남의 것 `dbtower`가 섞인 목록 */
const CONTAINERS = [
  'studio-orders-1a2b3c-api-1\tstudio-orders-1a2b3c',
  'studio-live-9f9f9f-api-1\tstudio-live-9f9f9f',
  'dbtower-postgres\tdbtower',
].join('\n');

const IMAGES = [
  'studio-orders-1a2b3c-api:latest',
  'studio-orders-1a2b3c-web:latest',
  'studio-live-9f9f9f-api:latest',
  'dbtower-api:latest',
  'postgres:17-alpine',
].join('\n');

const VOLUMES = [
  'studio-orders-1a2b3c_api-build\tstudio-orders-1a2b3c\t',
  'b-studio-cache-pnpm\t\ttrue',
  '4f1a2b3c4d5e\t\t',
  'studio-live-9f9f9f_db\tstudio-live-9f9f9f\t',
  'dbtower_pgdata\tdbtower\t',
].join('\n');

const NETWORKS = [
  'studio-orders-1a2b3c_default\tstudio-orders-1a2b3c',
  'studio-live-9f9f9f_default\tstudio-live-9f9f9f',
  'dbtower_default\tdbtower',
].join('\n');

const REMAINS = {
  containers: ['studio-orders-1a2b3c-api-1'],
  images: ['studio-orders-1a2b3c-api:latest', 'studio-orders-1a2b3c-web:latest'],
  volumes: ['studio-orders-1a2b3c_api-build'],
  networks: ['studio-orders-1a2b3c_default'],
};

interface FakeOutput {
  /** `docker ps`가 알려 주는 실행 중인 compose 프로젝트 */
  running?: string;
  containers?: string;
  images?: string;
  volumes?: string;
  networks?: string;
  /** 이 문자열이 명령에 들어가면 실패한 것으로 흉내 낸다 */
  failOn?: string[];
}

/** 받은 인자를 파일에 남기고, 명령별로 준비한 출력을 돌려주는 가짜 docker 실행 파일 */
async function fakeDocker(output: FakeOutput = {}): Promise<{ bin: string; calls: () => Promise<string[]> }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'fake-docker-'));
  const bin = path.join(dir, 'docker');
  const log = path.join(dir, 'calls.log');
  const write = async (name: string, content: string | undefined) => {
    const file = path.join(dir, `${name}.txt`);
    await writeFile(file, content ? `${content.replace(/\n+$/, '')}\n` : '');
    return file;
  };
  const running = await write('running', output.running);
  const containers = await write('containers', output.containers);
  const images = await write('images', output.images);
  const volumes = await write('volumes', output.volumes);
  const networks = await write('networks', output.networks);
  const failures = (output.failOn ?? []).map((value) => `  *"${value}"*) echo "removal failed" >&2; exit 1 ;;`).join('\n');

  await writeFile(
    bin,
    `#!/bin/sh
echo "$*" >> "${log}"
case "$*" in
${failures}
esac
case "$1 $2" in
  "ps --format") cat "${running}" ;;
  "ps -a") cat "${containers}" ;;
  "image ls") cat "${images}" ;;
  "volume ls") cat "${volumes}" ;;
  "network ls") cat "${networks}" ;;
esac
exit 0
`,
  );
  await chmod(bin, 0o755);
  return { bin, calls: async () => (await readFile(log, 'utf8').catch(() => '')).split('\n').filter(Boolean) };
}

function leftoversFixture() {
  return { running: 'studio-live-9f9f9f', containers: CONTAINERS, images: IMAGES, volumes: VOLUMES, networks: NETWORKS };
}

describe('남은 샌드박스 자원 정리', () => {
  it('b-studio가 만든 idle 샌드박스의 컨테이너·이미지·볼륨·네트워크를 찾아 지운다', async () => {
    const { bin, calls } = await fakeDocker(leftoversFixture());
    const result = await pruneSandboxLeftovers({ dockerBin: bin });

    expect(result.found).toEqual(REMAINS);
    expect(result.removed).toEqual(REMAINS);
    // 강제 삭제(-f) 없이 이름으로 지운다
    const removals = (await calls()).filter((call) => /^(rm |image rm |volume rm |network rm )/.test(call));
    expect(removals).toEqual([
      'rm studio-orders-1a2b3c-api-1',
      'image rm studio-orders-1a2b3c-api:latest',
      'image rm studio-orders-1a2b3c-web:latest',
      'volume rm studio-orders-1a2b3c_api-build',
      'network rm studio-orders-1a2b3c_default',
    ]);
  });

  it('공유 캐시·익명 볼륨·실행 중인 샌드박스·남의 자원은 지우지 않는다', async () => {
    const { bin } = await fakeDocker(leftoversFixture());
    const result = await pruneSandboxLeftovers({ dockerBin: bin });
    const removed = [...result.removed.containers, ...result.removed.images, ...result.removed.volumes, ...result.removed.networks];

    for (const untouched of [
      'b-studio-cache-pnpm',
      '4f1a2b3c4d5e',
      'dbtower-postgres',
      'dbtower-api:latest',
      'dbtower_pgdata',
      'dbtower_default',
      'studio-live-9f9f9f-api-1',
      'studio-live-9f9f9f-api:latest',
      'studio-live-9f9f9f_db',
      'studio-live-9f9f9f_default',
    ]) {
      expect(removed).not.toContain(untouched);
    }

    expect(result.skipped).toEqual(
      expect.arrayContaining([
        { resource: 'b-studio-cache-pnpm', reason: '공유 캐시 볼륨' },
        { resource: '4f1a2b3c4d5e', reason: 'compose 라벨 없음' },
        { resource: 'studio-live-9f9f9f-api-1', reason: '실행 중' },
        { resource: 'studio-live-9f9f9f-api:latest', reason: '실행 중' },
        { resource: 'studio-live-9f9f9f_db', reason: '실행 중' },
        { resource: 'studio-live-9f9f9f_default', reason: '실행 중' },
      ]),
    );
  });

  it('findSandboxLeftovers는 목록만 구하고 아무것도 지우지 않는다', async () => {
    const { bin, calls } = await fakeDocker(leftoversFixture());
    const found = await findSandboxLeftovers({ dockerBin: bin });

    expect(found).toEqual(REMAINS);
    expect((await calls()).some((call) => call.includes('rm '))).toBe(false);
  });

  it('--dry-run이면 지울 목록만 돌려주고 rm 명령을 한 번도 부르지 않는다', async () => {
    const { bin, calls } = await fakeDocker(leftoversFixture());
    const result = await pruneSandboxLeftovers({ dockerBin: bin, dryRun: true });

    expect(result.found).toEqual(REMAINS);
    expect(result.removed).toEqual({ containers: [], images: [], volumes: [], networks: [] });
    expect((await calls()).filter((call) => /^(rm |image rm |volume rm |network rm )/.test(call))).toEqual([]);
  });

  it('하나를 지우다 실패해도 나머지를 계속 지우고 이유를 남긴다', async () => {
    const { bin } = await fakeDocker({ ...leftoversFixture(), failOn: ['studio-orders-1a2b3c-web:latest'] });
    const result = await pruneSandboxLeftovers({ dockerBin: bin });

    expect(result.removed.containers).toEqual(['studio-orders-1a2b3c-api-1']);
    expect(result.removed.images).toEqual(['studio-orders-1a2b3c-api:latest']);
    expect(result.removed.volumes).toEqual(['studio-orders-1a2b3c_api-build']);
    expect(result.removed.networks).toEqual(['studio-orders-1a2b3c_default']);
    expect(result.skipped).toEqual(
      expect.arrayContaining([{ resource: 'studio-orders-1a2b3c-web:latest', reason: 'removal failed' }]),
    );
  });

  it('볼륨 목록을 물을 때 공유 캐시 라벨과 compose 라벨을 함께 요청한다', async () => {
    const { bin, calls } = await fakeDocker(leftoversFixture());
    await pruneSandboxLeftovers({ dockerBin: bin });

    // 캐시 볼륨을 지우지 않으려면 이 라벨을 실제로 물어봐야 한다
    const volumeList = (await calls()).find((call) => call.startsWith('volume ls '));
    expect(volumeList).toContain('b-studio.cache');
    expect(volumeList).toContain('com.docker.compose.project');
  });

  it('서비스 이름에 하이픈이 있어도 id를 잘못 자르지 않아 실행 중인 샌드박스의 이미지를 지우지 않는다', async () => {
    const { bin, calls } = await fakeDocker({
      running: 'studio-orders-1a2b3c',
      images: 'studio-orders-1a2b3c-api:latest\nstudio-orders-1a2b3c-facade-api:latest',
    });
    const result = await pruneSandboxLeftovers({ dockerBin: bin });

    expect(result.removed.images).toEqual([]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([{ resource: 'studio-orders-1a2b3c-facade-api:latest', reason: '실행 중' }]),
    );
    expect((await calls()).filter((call) => call.startsWith('image rm '))).toEqual([]);
  });

  it('실행 중인 샌드박스 이름으로 시작하는 이미지는 id 추출이 어긋나도 지우지 않는다', async () => {
    const { bin } = await fakeDocker({
      running: 'studio-orders-1a2b3c-facade',
      images: 'studio-orders-1a2b3c-facade-api:latest',
    });
    const result = await pruneSandboxLeftovers({ dockerBin: bin });

    expect(result.removed.images).toEqual([]);
    expect(result.skipped).toEqual(
      expect.arrayContaining([{ resource: 'studio-orders-1a2b3c-facade-api:latest', reason: '실행 중' }]),
    );
  });
});

describe('디스크 부족 진단', () => {
  it('no space left on device를 만나면 원문과 함께 정리 명령을 안내한다', () => {
    const message = describeDockerFailure('write /var/lib/docker/tmp: no space left on device');
    expect(message).toContain('no space left on device');
    expect(message).toContain(DOCKER_OUT_OF_SPACE);
    expect(message).toContain('studio sandbox prune --dry-run');
  });

  it('다른 오류는 원문을 그대로 돌려준다', () => {
    expect(describeDockerFailure(new Error('port is already allocated'))).toBe('port is already allocated');
    expect(describeDockerFailure('cannot connect to the Docker daemon')).toBe('cannot connect to the Docker daemon');
  });
});
