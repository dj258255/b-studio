import { chmod, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LoadedProject } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import type { BootNetwork } from '../types';
import { LocalDockerProvider } from './compose-provider';

const INSPECT = JSON.stringify([
  { Name: '/c1', State: { Status: 'running', ExitCode: 0, OOMKilled: false }, HostConfig: {}, Config: { Labels: { 'com.docker.compose.service': 'api' } } },
  { Name: '/c2', State: { Status: 'running', ExitCode: 0, OOMKilled: false }, HostConfig: {}, Config: { Labels: { 'com.docker.compose.service': 'db' } } },
  { Name: '/c3', State: { Status: 'running', ExitCode: 0, OOMKilled: false }, HostConfig: {}, Config: { Labels: { 'com.docker.compose.service': 'b-studio-edge' } } },
]);
const STATS = [
  '{"Name":"c1","CPUPerc":"1%","MemUsage":"10MiB / 1GiB","NetIO":"1.2MB / 3.4kB"}',
  '{"Name":"c2","CPUPerc":"1%","MemUsage":"10MiB / 1GiB","NetIO":"500kB / 100kB"}',
  '{"Name":"c3","CPUPerc":"1%","MemUsage":"10MiB / 1GiB","NetIO":"9MB / 8MB"}',
].join('\n');

/**
 * start()가 부르는 명령에만 답하는 가짜 docker 실행 파일.
 * compose build/up과 port, 그리고 stats()의 ps/inspect/stats에 응답한다. ps 호출은 counter 파일에 세어 한 번만 읽는지 확인한다.
 */
async function fakeDocker(dir: string): Promise<string> {
  const inspectFile = path.join(dir, 'inspect.json');
  const statsFile = path.join(dir, 'stats.json');
  const counterFile = path.join(dir, 'ps-count');
  await writeFile(inspectFile, INSPECT);
  await writeFile(statsFile, STATS);
  const bin = path.join(dir, 'docker');
  await writeFile(
    bin,
    `#!/bin/sh
case " $* " in *" --no-trunc "*) exit 0 ;; esac
for a in "$@"; do
  case "$a" in
    config) printf '{"services":{}}\\n'; exit 0 ;;
    build|up) exit 0 ;;
    port) printf '0.0.0.0:34567\\n'; exit 0 ;;
    ps) echo x >> "${counterFile}"; printf 'c1\\nc2\\nc3\\n'; exit 0 ;;
    inspect) cat "${inspectFile}"; exit 0 ;;
    stats) cat "${statsFile}"; exit 0 ;;
  esac
done
exit 0
`,
  );
  await chmod(bin, 0o755);
  return bin;
}

const project = {
  spec: { name: 'orders' },
  root: '/tmp/orders',
  composePath: '/tmp/orders/compose.yaml',
  managed: [
    ['api', { template: 'node', path: 'api', port: 8_080 }],
    ['db', { template: 'postgres', path: 'db', port: 5_432 }],
  ],
  composeServices: ['api', 'db'],
  sharedVolumes: [],
  external: [],
} as unknown as LoadedProject;

describe('기동 네트워크 지표', () => {
  it('서비스가 준비된 뒤 stats를 한 번 읽어 edge를 뺀 BootNetwork를 돌려준다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'boot-network-'));
    const dockerBin = await fakeDocker(dir);
    const sandbox = await new LocalDockerProvider({ dockerBin }).create(project);

    const network: BootNetwork[] = [];
    await sandbox.start({ onBootNetwork: (value) => network.push(value) });

    // api·db만 담고 edge(b-studio-edge)는 뺀다
    expect(network).toEqual([
      [
        { service: 'api', rxBytes: 1_200_000, txBytes: 3_400 },
        { service: 'db', rxBytes: 500_000, txBytes: 100_000 },
      ],
    ]);
    // ps는 stats()에서 한 번만 부른다
    expect((await readFile(path.join(dir, 'ps-count'), 'utf8')).trim().split('\n')).toHaveLength(1);
  });

  it('onBootNetwork를 주지 않으면 stats를 읽지 않는다', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'boot-network-'));
    const dockerBin = await fakeDocker(dir);
    const sandbox = await new LocalDockerProvider({ dockerBin }).create(project);

    await sandbox.start();

    await expect(readFile(path.join(dir, 'ps-count'), 'utf8')).rejects.toThrow();
  });
});
