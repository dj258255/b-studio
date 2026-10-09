import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LoadedProject } from '@b-studio/spec';
import { afterEach, describe, expect, it } from 'vitest';
import { LocalDockerProvider, splitUpArgs } from './compose-provider';

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Fixture {
  project: LoadedProject;
  dockerBin: string;
  root: string;
  dir: string;
  /** `compose config`가 내보낼 설정. 호출 순서 N번째에 `config-N.json`이 있으면 그것을 대신 내보낸다 */
  configFile: string;
  /** `docker inspect`가 내보낼 컨테이너 목록(JSON). 파일이 없으면 컨테이너가 없는 것으로 본다. 호출 순서 N번째에 `inspect-N.json`이 있으면 그것을 대신 내보낸다 */
  inspectFile: string;
  /** 실행한 docker 명령 인자(줄마다 하나) */
  log: () => Promise<string>;
  /** 마지막 `up` 순간의 override 파일 */
  overrideAtUp: () => Promise<string>;
  upCount: () => Promise<number>;
}

const SERVICE = (root: string, extra: object[] = []) => ({ services: { api: { volumes: [{ type: 'bind', source: root, target: '/workspace' }, ...extra] } } });

/**
 * `compose config`는 설정 파일(config.json)을, `compose up`은 그 순간의 override 파일 복사를, `ps --quiet`/`inspect`는 준비한 컨테이너 목록을
 * 내보내는 가짜 docker. 에이전트가 compose 파일을 고쳐 마운트를 늘린 상황을 config.json을 바꿔 흉내 낸다
 */
async function setup({ git = 'b-studio' }: { git?: 'b-studio' | 'user' } = {}): Promise<Fixture> {
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'git-mask-')));
  dirs.push(dir);
  const root = path.join(dir, 'shop');
  await mkdir(path.join(root, '.git', 'b-studio'), { recursive: true });
  await writeFile(path.join(root, '.git', 'config'), git === 'b-studio' ? '[core]\n\tbare = false\n[b-studio]\n\tstart = abc\n' : '[core]\n\tbare = false\n');
  const configFile = path.join(dir, 'config.json');
  const inspectFile = path.join(dir, 'inspect.json');
  const log = path.join(dir, 'docker.log');
  const snapshot = path.join(dir, 'override-at-up.yaml');
  const counter = path.join(dir, 'config-count');
  await writeFile(configFile, JSON.stringify(SERVICE(root)));
  await writeFile(counter, '0');
  const bin = path.join(dir, 'docker');
  await writeFile(
    bin,
    `#!/bin/sh
printf '%s\\n' "$*" >> "${log}"
override=""
for a in "$@"; do
  case "$a" in
    *compose.override.yaml) override="$a" ;;
  esac
done
case " $* " in
  *" ps "*) if [ -f "${dir}/ps-fails" ]; then echo "Cannot connect to the Docker daemon" >&2; exit 1; fi; if [ -f "${inspectFile}" ]; then echo c1; fi; exit 0 ;;
esac
for a in "$@"; do
  case "$a" in
    config)
      n=$(cat "${counter}"); n=$((n + 1)); echo "$n" > "${counter}"
      case "$*" in
        *"--profile *"*) if [ -f "${dir}/config-$n.json" ]; then cat "${dir}/config-$n.json"; else cat "${configFile}"; fi ;;
        *) echo '{"services":{}}' ;;
      esac
      exit 0 ;;
    up) cp "$override" "${snapshot}"; echo up >> "${dir}/ups"; exit 0 ;;
    inspect)
      i=$(cat "${dir}/inspect-count" 2>/dev/null || echo 0); i=$((i + 1)); echo "$i" > "${dir}/inspect-count"
      if [ -f "${dir}/inspect-$i.json" ]; then cat "${dir}/inspect-$i.json"; else cat "${inspectFile}"; fi
      exit 0 ;;
    volume) if [ -f "${dir}/volume-fails" ]; then echo "no such volume" >&2; exit 1; fi; echo '[]'; exit 0 ;;
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
  return {
    project,
    dockerBin: bin,
    root,
    dir,
    configFile,
    inspectFile,
    log: () => readFile(log, 'utf8'),
    overrideAtUp: () => readFile(snapshot, 'utf8'),
    upCount: () => readFile(path.join(dir, 'ups'), 'utf8').then((text) => text.split('\n').filter(Boolean).length, () => 0),
  };
}

/** 로그에서 up 호출을 순서대로 뽑아 만들기(`--no-start`)인지 시작(`--no-recreate`)인지로 바꾼다 */
function upPhases(log: string): string[] {
  return log
    .split('\n')
    .filter((line) => / up /.test(` ${line} `) && line.includes('compose'))
    .map((line) => (line.includes('--no-start') ? 'create' : line.includes('--no-recreate') ? 'start' : 'other'));
}

describe('up 인자를 만들기와 시작으로 나눈다', () => {
  it('만들기는 --no-start를 더하고 --detach를 빼며, 시작은 --no-recreate를 더하고 --force-recreate·--build를 뺀다', () => {
    expect(splitUpArgs(['up', '--detach', '--build', '--no-deps', '--force-recreate', 'api'])).toEqual({
      create: ['up', '--no-start', '--build', '--no-deps', '--force-recreate', 'api'],
      start: ['up', '--no-recreate', '--detach', '--no-deps', 'api'],
    });
    expect(splitUpArgs(['up', '--detach', '--remove-orphans'])).toEqual({
      create: ['up', '--no-start', '--remove-orphans'],
      start: ['up', '--no-recreate', '--detach', '--remove-orphans'],
    });
  });
});

describe('서비스 컨테이너의 .git 보호', () => {
  it('샌드박스를 만들 때 compose가 정규화한 마운트를 읽어 override에 .git 읽기 전용과 상태 폴더를 가리는 빈 폴더를 적는다', async () => {
    const { project, dockerBin, overrideAtUp, root } = await setup();
    const sandbox = await new LocalDockerProvider({ dockerBin }).create(project);
    await sandbox.setServiceRunning!('api', true);

    const override = await overrideAtUp();
    expect(override).toContain(`source: ${root}/.git`);
    expect(override).toContain('target: /workspace/.git');
    expect(override).toContain('read_only: true');
    expect(override).toContain(`source: ${root}/.git/b-studio-empty`);
    expect(override).toContain('target: /workspace/.git/b-studio');
  });

  it('프로필·프로젝트 이름·프로젝트 폴더·파일을 up과 같게 주고 모든 프로필을 켜서 읽는다', async () => {
    const { project, dockerBin, overrideAtUp, log, root } = await setup();
    const sandbox = await new LocalDockerProvider({ dockerBin }).create(project);
    await sandbox.setServiceRunning!('api', true);

    expect(await overrideAtUp()).toContain('target: /workspace/.git');
    const lines = (await log()).split('\n');
    const config = lines.find((line) => line.includes(' config '))!;
    const up = lines.find((line) => line.includes(' up '))!;
    for (const part of [`--project-name ${sandbox.id}`, `--project-directory ${root}`, `--file ${root}/compose.yaml`]) {
      expect(config).toContain(part);
      expect(up).toContain(part);
    }
    expect(config).toContain('--profile *');
  });

  it('b-studio의 체크포인트 저장소인데 상태 폴더가 아직 없으면 미리 만들어 두고 빈 폴더로 가린다', async () => {
    const { project, dockerBin, overrideAtUp, root } = await setup();
    await rm(path.join(root, '.git', 'b-studio'), { recursive: true });
    const sandbox = await new LocalDockerProvider({ dockerBin }).create(project);
    await sandbox.setServiceRunning!('api', true);
    expect(await overrideAtUp()).toContain('target: /workspace/.git/b-studio');
    expect((await stat(path.join(root, '.git', 'b-studio'))).isDirectory()).toBe(true);
  });

  it('사용자 자신의 저장소(내 폴더 모드)에는 상태 폴더를 만들지 않고 빈 폴더도 얹지 않는다', async () => {
    const { project, dockerBin, overrideAtUp, root } = await setup({ git: 'user' });
    await rm(path.join(root, '.git', 'b-studio'), { recursive: true });
    const sandbox = await new LocalDockerProvider({ dockerBin }).create(project);
    await sandbox.setServiceRunning!('api', true);
    const override = await overrideAtUp();
    expect(override).toContain('target: /workspace/.git');
    expect(override).not.toContain('b-studio\n');
    expect(override).not.toContain('b-studio-empty');
    await expect(stat(path.join(root, '.git', 'b-studio'))).rejects.toThrow();
  });

  it('compose 파일이 세션 중에 바뀌어 마운트가 늘면 컨테이너를 만들기 직전에 마스크를 다시 맞춘다', async () => {
    const { project, dockerBin, configFile, overrideAtUp, root } = await setup();
    const sandbox = await new LocalDockerProvider({ dockerBin }).create(project);
    // 에이전트가 compose 파일에 같은 폴더를 다른 자리에 한 번 더 마운트하는 줄을 더했다
    await writeFile(configFile, JSON.stringify(SERVICE(root, [{ type: 'bind', source: root, target: '/backdoor' }])));
    await sandbox.setServiceRunning!('api', true);

    const override = await overrideAtUp();
    expect(override).toContain('target: /backdoor/.git');
    expect(override).toContain('target: /backdoor/.git/b-studio');
  });

  it('up이 도는 동안 compose 파일이 바뀌어도 up 뒤에 다시 읽어 마스크를 맞추고 다시 up한다', async () => {
    const { project, dockerBin, dir, overrideAtUp, upCount, log, root } = await setup();
    const sandbox = await new LocalDockerProvider({ dockerBin }).create(project);
    // 호출 순서: create(1), up 직전(2), up 직후(3) — 3번째부터 마운트가 늘어난 설정이 보인다
    for (let n = 3; n <= 12; n++) await writeFile(path.join(dir, `config-${n}.json`), JSON.stringify(SERVICE(root, [{ type: 'bind', source: root, target: '/late' }])));
    await sandbox.setServiceRunning!('api', true);

    // 만들기 → (마스크가 달라짐) → 다시 만들기 → 시작. 옛 마스크로 만든 컨테이너는 한 번도 시작되지 않는다
    expect(await upCount()).toBe(3);
    expect(await overrideAtUp()).toContain('target: /late/.git');
    expect(upPhases(await log())).toEqual(['create', 'create', 'start']);
  });

  it('마스크가 3번 안에 안정되지 않으면 서비스를 내리고 던진다', async () => {
    const { project, dockerBin, dir, log, root } = await setup();
    const sandbox = await new LocalDockerProvider({ dockerBin }).create(project);
    // up 직전(2)과 직후(3)가 다르고, 이어서도 매번 달라진다
    for (let n = 3; n <= 12; n++) {
      await writeFile(path.join(dir, `config-${n}.json`), JSON.stringify(SERVICE(root, [{ type: 'bind', source: root, target: `/t${n}` }])));
    }
    await expect(sandbox.setServiceRunning!('api', true)).rejects.toThrow(/확정하지 못했습니다/);
    expect(await log()).toMatch(/ down --remove-orphans/);
  });

  const UNMASKED = (root: string) => [
    {
      Id: 'c1',
      Name: '/api-1',
      Config: { Labels: { 'com.docker.compose.service': 'api' } },
      Mounts: [{ Type: 'bind', Source: root, Destination: '/workspace', RW: true }],
    },
  ];
  const MASKED = (root: string) => [
    {
      Id: 'c1',
      Mounts: [
        { Type: 'bind', Source: root, Destination: '/workspace', RW: true },
        { Type: 'bind', Source: `${root}/.git`, Destination: '/workspace/.git', RW: false },
        { Type: 'bind', Source: `${root}/.git/b-studio-empty`, Destination: '/workspace/.git/b-studio', RW: false },
      ],
    },
  ];

  it('만든 컨테이너에 .git 읽기 전용 마운트가 빠져 있으면 한 번도 시작하지 않고 지운 뒤 던진다(트러블슈팅 121)', async () => {
    const { project, dockerBin, inspectFile, log, root } = await setup();
    const sandbox = await new LocalDockerProvider({ dockerBin }).create(project);
    await writeFile(inspectFile, JSON.stringify(UNMASKED(root)));
    await expect(sandbox.setServiceRunning!('api', true)).rejects.toThrow(/\.git 읽기 전용 마운트가 빠져 시작하지 않았습니다/);
    const lines = await log();
    // 시작 단계의 up이 한 번도 돌지 않았다. 고치기 전에는 up이 컨테이너를 시작한 뒤에야 확인하고 멈췄다
    expect(upPhases(lines)).toEqual(['create']);
    expect(lines).toMatch(/^rm --force c1$/m);
    expect(lines).not.toMatch(/^stop c1$/m);
  });

  it('만들기 → 마운트 확인 → 시작 순서로 돌고, 시작 단계는 컨테이너를 다시 만들거나 빌드하지 않는다', async () => {
    const { project, dockerBin, inspectFile, log, root } = await setup();
    const sandbox = await new LocalDockerProvider({ dockerBin }).create(project);
    await writeFile(inspectFile, JSON.stringify(MASKED(root)));
    await sandbox.setServiceRunning!('api', true);
    const lines = (await log()).split('\n');
    const createAt = lines.findIndex((line) => / up --no-start /.test(line));
    const inspectAt = lines.findIndex((line, index) => index > createAt && /^inspect c1$/.test(line));
    const startAt = lines.findIndex((line) => / up --no-recreate /.test(line));
    expect(createAt).toBeGreaterThan(-1);
    expect(inspectAt).toBeGreaterThan(createAt);
    expect(startAt).toBeGreaterThan(inspectAt);
    // 빌드는 만들기 단계에서만 한다(다시 만들기 플래그는 위의 splitUpArgs 테스트가 본다). 시작 단계가 다시 만들면 확인한 컨테이너가 아닌 것이 시작된다
    expect(lines[createAt]).toContain('--build');
    expect(lines[createAt]).not.toContain('--detach');
    expect(lines[startAt]).toContain('--detach');
    expect(lines[startAt]).not.toContain('--force-recreate');
    expect(lines[startAt]).not.toContain('--build');
  });

  it('시작 단계에서 새로 만들어진 컨테이너에 마스크가 빠져 있으면 시작한 뒤의 확인이 멈추고 던진다', async () => {
    const { project, dockerBin, dir, inspectFile, log, root } = await setup();
    const sandbox = await new LocalDockerProvider({ dockerBin }).create(project);
    // 시작 전 확인(1번째 inspect)은 통과하고, 시작한 뒤(2번째)에는 보호가 빠진 컨테이너가 보인다
    await writeFile(inspectFile, JSON.stringify(UNMASKED(root)));
    await writeFile(path.join(dir, 'inspect-1.json'), JSON.stringify(MASKED(root)));
    await expect(sandbox.setServiceRunning!('api', true)).rejects.toThrow(/\.git 읽기 전용 마운트가 빠져 멈췄습니다/);
    const lines = await log();
    expect(upPhases(lines)).toEqual(['create', 'start']);
    expect(lines).toMatch(/^stop c1$/m);
  });

  it('컨테이너 목록을 읽지 못하면 컨테이너가 없는 것으로 보지 않고, 시작하지 않은 채 던진다', async () => {
    const { project, dockerBin, dir, inspectFile, log, root } = await setup();
    const sandbox = await new LocalDockerProvider({ dockerBin }).create(project);
    await writeFile(inspectFile, JSON.stringify(UNMASKED(root)));
    await writeFile(path.join(dir, 'ps-fails'), '');
    await expect(sandbox.setServiceRunning!('api', true)).rejects.toThrow(/컨테이너 목록을 확인하지 못했습니다/);
    expect(upPhases(await log())).toEqual(['create']);
  });

  it('이름 있는 볼륨의 정보를 읽지 못하면 그 마운트를 건너뛰지 않고, 시작하지 않은 채 던진다', async () => {
    const { project, dockerBin, dir, inspectFile, log, root } = await setup();
    const sandbox = await new LocalDockerProvider({ dockerBin }).create(project);
    await writeFile(inspectFile, JSON.stringify([{ Id: 'c1', Mounts: [...MASKED(root)[0]!.Mounts, { Type: 'volume', Name: 'shop_src', Destination: '/src', RW: true }] }]));
    await writeFile(path.join(dir, 'volume-fails'), '');
    await expect(sandbox.setServiceRunning!('api', true)).rejects.toThrow(/볼륨 정보를 확인하지 못했습니다/);
    expect(upPhases(await log())).toEqual(['create']);
  });

  it('up 뒤 실제 컨테이너에 마스크가 모두 있으면 통과한다', async () => {
    const { project, dockerBin, inspectFile, root } = await setup();
    const sandbox = await new LocalDockerProvider({ dockerBin }).create(project);
    await writeFile(
      inspectFile,
      JSON.stringify([
        {
          Id: 'c1',
          Mounts: [
            { Type: 'bind', Source: root, Destination: '/workspace', RW: true },
            { Type: 'bind', Source: `${root}/.git`, Destination: '/workspace/.git', RW: false },
            { Type: 'bind', Source: `${root}/.git/b-studio-empty`, Destination: '/workspace/.git/b-studio', RW: false },
          ],
        },
      ]),
    );
    await expect(sandbox.setServiceRunning!('api', true)).resolves.toBeUndefined();
  });

  it('compose 설정을 읽지 못하면 보호 없이 띄우지 않고 멈춘다', async () => {
    const { project, dockerBin, configFile } = await setup();
    const sandbox = await new LocalDockerProvider({ dockerBin }).create(project);
    await writeFile(configFile, 'not json');
    await expect(sandbox.setServiceRunning!('api', true)).rejects.toThrow(/\.git 보호/);
  });
});

describe('compose 설정을 읽다 실패할 때 비밀 값', () => {
  async function failingDocker(dir: string): Promise<string> {
    const bin = path.join(dir, 'docker-fail');
    await writeFile(bin, `#!/bin/sh\necho "error: invalid value for TOKEN=s3cr3t-value in compose" >&2\nexit 1\n`);
    await chmod(bin, 0o755);
    return bin;
  }

  it('create가 던지는 오류의 어디에도 시크릿 값과 명령줄이 없다', async () => {
    const { project, dir } = await setup();
    const dockerBin = await failingDocker(dir);
    const error = await new LocalDockerProvider({ dockerBin }).create(project, { secrets: { TOKEN: 's3cr3t-value' } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const text = JSON.stringify({ message: (error as Error).message, detail: (error as { detail?: string }).detail, stack: (error as Error).stack });
    expect(text).not.toContain('s3cr3t-value');
    expect(text).toContain('invalid value for TOKEN=');
    expect(text).not.toContain('--project-directory');
  });
});
