import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LoadedProject } from '@b-studio/spec';
import { beforeEach, describe, expect, it } from 'vitest';
import { LocalDockerProvider, sandboxBuildNoCache } from './compose-provider';

const INSPECT = JSON.stringify([
  { Name: '/c1', State: { Status: 'running', ExitCode: 0, OOMKilled: false }, HostConfig: {}, Config: { Labels: { 'com.docker.compose.service': 'api' } } },
]);
const STATS = '{"Name":"c1","CPUPerc":"1%","MemUsage":"10MiB / 1GiB","NetIO":"1MB / 1MB"}';

/**
 * start()가 부르는 명령을 log 파일에 그대로 적는 가짜 docker 실행 파일.
 * build 인자에 --no-cache가 붙는지와, 스냅샷 시드 복사(SEED_SCRIPT)가 도는지를 이 log로 확인한다.
 */
async function fakeDocker(dir: string): Promise<{ dockerBin: string; log: string }> {
  const inspectFile = path.join(dir, 'inspect.json');
  const statsFile = path.join(dir, 'stats.json');
  const log = path.join(dir, 'args.log');
  await writeFile(inspectFile, INSPECT);
  await writeFile(statsFile, STATS);
  const bin = path.join(dir, 'docker');
  await writeFile(
    bin,
    `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
for a in "$@"; do
  case "$a" in
    config) printf '{"services":{}}\\n'; exit 0 ;;
    build|up) exit 0 ;;
    port) printf '0.0.0.0:34567\\n'; exit 0 ;;
    ps) printf 'c1\\n'; exit 0 ;;
    inspect) cat "${inspectFile}"; exit 0 ;;
    stats) cat "${statsFile}"; exit 0 ;;
  esac
done
exit 0
`,
  );
  await chmod(bin, 0o755);
  return { dockerBin: bin, log };
}

const project = {
  spec: { name: 'orders' },
  root: '/tmp/orders',
  composePath: '/tmp/orders/compose.yaml',
  managed: [['api', { template: 'node', path: 'api', port: 8_080, snapshots: [{ volume: 'node_modules', key: ['package.json'] }] }]],
  composeServices: ['api'],
  sharedVolumes: [],
  external: [],
} as unknown as LoadedProject;

/** start()가 부른 명령 중 "build" 토큰이 있는 줄 */
function buildLine(log: string): string {
  return log.split('\n').find((line) => line.split(' ').includes('build')) ?? '';
}

beforeEach(() => {
  delete process.env.B_STUDIO_SANDBOX_BUILD_NO_CACHE;
});

describe('샌드박스 빌드 캐시', () => {
  it('sandboxBuildNoCache는 1·true만 켠다', () => {
    expect(sandboxBuildNoCache({} as NodeJS.ProcessEnv)).toBe(false);
    expect(sandboxBuildNoCache({ B_STUDIO_SANDBOX_BUILD_NO_CACHE: '1' } as NodeJS.ProcessEnv)).toBe(true);
    expect(sandboxBuildNoCache({ B_STUDIO_SANDBOX_BUILD_NO_CACHE: 'true' } as NodeJS.ProcessEnv)).toBe(true);
    expect(sandboxBuildNoCache({ B_STUDIO_SANDBOX_BUILD_NO_CACHE: '0' } as NodeJS.ProcessEnv)).toBe(false);
  });

  it('기본은 --no-cache 없이 빌드하고 스냅샷 시드 복사를 한다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'build-cache-'));
    const { dockerBin, log } = await fakeDocker(dir);
    const sandbox = await new LocalDockerProvider({ dockerBin }).create(project);

    await sandbox.start();

    const args = await readFile(log, 'utf8');
    expect(buildLine(args)).toBeTruthy();
    expect(buildLine(args)).not.toContain('--no-cache');
    // 스냅샷 볼륨 재사용(SEED_SCRIPT)이 돌았다
    expect(args).toContain('[ -f /from/');
  });

  it('B_STUDIO_SANDBOX_BUILD_NO_CACHE=1이면 --no-cache로 빌드하고 스냅샷을 쓰지 않는다', async () => {
    process.env.B_STUDIO_SANDBOX_BUILD_NO_CACHE = '1';
    try {
      const dir = await mkdtemp(path.join(tmpdir(), 'build-cache-'));
      const { dockerBin, log } = await fakeDocker(dir);
      const sandbox = await new LocalDockerProvider({ dockerBin }).create(project);

      await sandbox.start();

      const args = await readFile(log, 'utf8');
      expect(buildLine(args)).toContain('--no-cache');
      // 스냅샷 시드 복사를 건너뛴다(볼륨을 지우지는 않는다)
      expect(args).not.toContain('[ -f /from/');
    } finally {
      delete process.env.B_STUDIO_SANDBOX_BUILD_NO_CACHE;
    }
  });
});
