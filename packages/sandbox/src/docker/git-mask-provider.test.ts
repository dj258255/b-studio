import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LoadedProject } from '@b-studio/spec';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalDockerProvider } from './compose-provider';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * `compose config`는 설정 파일(config.json)을 그대로 내보내고, `compose up`은 그 순간의 override 파일을 복사해 두는 가짜 docker.
 * 에이전트가 compose 파일을 고쳐 마운트를 늘린 상황을 config.json을 바꿔 흉내 낸다
 */
async function setup(): Promise<{ project: LoadedProject; dockerBin: string; configFile: string; overrideAtUp: () => Promise<string>; root: string }> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'git-mask-')));
  dirs.push(dir);
  const root = path.join(dir, 'shop');
  await mkdir(path.join(root, '.git', 'b-studio'), { recursive: true });
  const configFile = path.join(dir, 'config.json');
  await writeFile(configFile, JSON.stringify({ services: { api: { volumes: [{ type: 'bind', source: root, target: '/workspace' }] } } }));
  const snapshot = path.join(dir, 'override-at-up.yaml');
  const bin = path.join(dir, 'docker');
  await writeFile(
    bin,
    `#!/bin/sh
override=""
for a in "$@"; do
  case "$a" in
    *compose.override.yaml) override="$a" ;;
  esac
done
for a in "$@"; do
  case "$a" in
    config) case "$*" in *"--profile *"*) cat "${configFile}" ;; *) echo '{"services":{}}' ;; esac; exit 0 ;;
    up) cp "$override" "${snapshot}"; exit 0 ;;
  esac
done
exit 0
`,
  );
  await chmod(bin, 0o755);
  const project = {
    spec: { name: 'shop' },
    root,
    composePath: path.join(root, 'compose.yaml'),
    managed: [['api', { template: 'node', path: '.', port: 3000 }]],
    composeServices: ['api'],
    sharedVolumes: [],
    external: [],
  } as unknown as LoadedProject;
  return { project, dockerBin: bin, configFile, overrideAtUp: () => readFile(snapshot, 'utf8'), root };
}

describe('서비스 컨테이너의 .git 보호', () => {
  it('샌드박스를 만들 때 compose가 정규화한 마운트를 읽어 override에 .git 읽기 전용과 상태 폴더 tmpfs를 적는다', async () => {
    const { project, dockerBin, overrideAtUp, root } = await setup();
    const sandbox = await new LocalDockerProvider({ dockerBin }).create(project);
    await sandbox.setServiceRunning!('api', true);

    const override = await overrideAtUp();
    expect(override).toContain(`source: ${root}/.git`);
    expect(override).toContain('target: /workspace/.git');
    expect(override).toContain('read_only: true');
    expect(override).toContain('type: tmpfs');
    expect(override).toContain('target: /workspace/.git/b-studio');
  });

  it('compose 파일이 세션 중에 바뀌어 마운트가 늘면 컨테이너를 만들기 직전에 마스크를 다시 맞춘다', async () => {
    const { project, dockerBin, configFile, overrideAtUp, root } = await setup();
    const sandbox = await new LocalDockerProvider({ dockerBin }).create(project);
    // 에이전트가 compose 파일에 같은 폴더를 다른 자리에 한 번 더 마운트하는 줄을 더했다
    await writeFile(
      configFile,
      JSON.stringify({
        services: {
          api: {
            volumes: [
              { type: 'bind', source: root, target: '/workspace' },
              { type: 'bind', source: root, target: '/backdoor' },
            ],
          },
        },
      }),
    );
    await sandbox.setServiceRunning!('api', true);

    const override = await overrideAtUp();
    expect(override).toContain('target: /backdoor/.git');
    expect(override).toContain('target: /backdoor/.git/b-studio');
  });

  it("프로필이 걸린 서비스도 마운트를 읽도록 모든 프로필을 켜고 config를 읽는다(가짜 docker는 --profile '*'가 있을 때만 서비스를 내보낸다)", async () => {
    const { project, dockerBin, overrideAtUp } = await setup();
    const sandbox = await new LocalDockerProvider({ dockerBin }).create(project);
    await sandbox.setServiceRunning!('api', true);
    expect(await overrideAtUp()).toContain('target: /workspace/.git');
  });

  it('상태 폴더가 아직 없어도 미리 만들어 두고 tmpfs로 가린다', async () => {
    const { project, dockerBin, overrideAtUp, root } = await setup();
    await rm(path.join(root, '.git', 'b-studio'), { recursive: true });
    const sandbox = await new LocalDockerProvider({ dockerBin }).create(project);
    await sandbox.setServiceRunning!('api', true);
    expect(await overrideAtUp()).toContain('target: /workspace/.git/b-studio');
    expect((await stat(path.join(root, '.git', 'b-studio'))).isDirectory()).toBe(true);
  });

  it('compose 설정을 읽지 못하면 보호 없이 띄우지 않고 멈춘다', async () => {
    const { project, dockerBin, configFile } = await setup();
    const sandbox = await new LocalDockerProvider({ dockerBin }).create(project);
    await writeFile(configFile, 'not json');
    await expect(sandbox.setServiceRunning!('api', true)).rejects.toThrow(/\.git 보호/);
  });
});
