import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LoadedProject } from '@b-studio/spec';
import { afterEach, describe, expect, it } from 'vitest';
import { buildOverride } from './format';
import { boundDevice, collectHostMounts, computeGitMask, detectGitEntries, findMissingMasks, planGitMask, type GitEntry } from './git-mask';

const ROOT = '/work/shop';
const ro = (source: string, target: string) => ({ type: 'bind', source, target, read_only: true, bind: { create_host_path: false } });
const empty = (dir: string, target: string) => ro(`${dir}/.git/b-studio-empty`, target);
const dirEntry = (dir: string, hasState = true): GitEntry => ({ dir, kind: 'directory', hasState });

describe('planGitMask 마운트 꼴별 계획', () => {
  it('프로젝트 루트 전체를 마운트하면 .git은 읽기 전용, 상태 폴더는 빈 폴더를 읽기 전용으로 얹어 덮는다', () => {
    const plan = planGitMask([{ service: 'api', source: ROOT, target: '/workspace' }], [dirEntry(ROOT)]);
    expect(plan).toEqual({ api: [ro(`${ROOT}/.git`, '/workspace/.git'), empty(ROOT, '/workspace/.git/b-studio')] });
  });

  it('상태 폴더가 없으면 .git만 읽기 전용으로 한다', () => {
    const plan = planGitMask([{ service: 'api', source: ROOT, target: '/app' }], [dirEntry(ROOT, false)]);
    expect(plan).toEqual({ api: [ro(`${ROOT}/.git`, '/app/.git')] });
  });

  it('상위 폴더(모노레포 저장소 루트)를 마운트하면 상위의 .git을 덮는다', () => {
    const plan = planGitMask([{ service: 'api', source: '/work', target: '/repo' }], [dirEntry('/work')]);
    expect(plan).toEqual({ api: [ro('/work/.git', '/repo/.git'), empty('/work', '/repo/.git/b-studio')] });
  });

  it('상위 폴더를 마운트하면 프로젝트 폴더와 저장소 루트 두 곳의 .git을 모두 덮는다', () => {
    const plan = planGitMask([{ service: 'api', source: '/work', target: '/repo' }], [dirEntry(ROOT, false), dirEntry('/work')]);
    expect(plan.api?.map((volume) => volume.target)).toEqual(['/repo/.git', '/repo/.git/b-studio', '/repo/shop/.git']);
  });

  it('프로젝트의 하위 폴더만 마운트하면 .git이 보이지 않으므로 아무것도 하지 않는다', () => {
    expect(planGitMask([{ service: 'api', source: `${ROOT}/api`, target: '/app' }], [dirEntry(ROOT)])).toEqual({});
  });

  it('프로젝트와 무관한 마운트는 건드리지 않는다', () => {
    expect(planGitMask([{ service: 'db', source: '/var/data', target: '/data' }], [dirEntry(ROOT)])).toEqual({});
  });

  it('.git이 없으면 아무것도 하지 않는다', () => {
    expect(planGitMask([{ service: 'api', source: ROOT, target: '/workspace' }], [])).toEqual({});
  });

  it('.git이 파일(worktree 포인터)이면 그 파일만 읽기 전용으로 겹친다', () => {
    const plan = planGitMask([{ service: 'api', source: ROOT, target: '/workspace' }], [{ dir: ROOT, kind: 'file', hasState: false }]);
    expect(plan).toEqual({ api: [ro(`${ROOT}/.git`, '/workspace/.git')] });
  });

  it('서비스마다 자기 마운트 자리에 맞춰 계획한다', () => {
    const plan = planGitMask(
      [
        { service: 'api', source: ROOT, target: '/workspace' },
        { service: 'web', source: ROOT, target: '/srv/web' },
        { service: 'db', source: '/var/data', target: '/data' },
      ],
      [dirEntry(ROOT)],
    );
    expect(Object.keys(plan)).toEqual(['api', 'web']);
    expect(plan.web?.[0]).toEqual(ro(`${ROOT}/.git`, '/srv/web/.git'));
  });

  it('.git 안쪽을 직접 마운트했으면 같은 자리를 읽기 전용으로, 상태 폴더는 빈 폴더로 바꿔 쓴다', () => {
    const plan = planGitMask(
      [
        { service: 'api', source: `${ROOT}/.git`, target: '/g' },
        { service: 'api', source: `${ROOT}/.git/refs`, target: '/refs' },
        { service: 'api', source: `${ROOT}/.git/b-studio/databases`, target: '/dumps' },
      ],
      [dirEntry(ROOT)],
    );
    expect(plan.api).toEqual([empty(ROOT, '/dumps'), ro(`${ROOT}/.git`, '/g'), ro(`${ROOT}/.git/refs`, '/refs')]);
  });

  it('같은 자리를 두 규칙이 덮으면 빈 폴더 쪽이 남는다', () => {
    const plan = planGitMask(
      [
        { service: 'api', source: ROOT, target: '/workspace' },
        { service: 'api', source: `${ROOT}/.git/b-studio`, target: '/workspace/.git/b-studio' },
      ],
      [dirEntry(ROOT)],
    );
    expect(plan.api?.filter((volume) => volume.target === '/workspace/.git/b-studio')).toEqual([empty(ROOT, '/workspace/.git/b-studio')]);
  });

  it('경로 이름이 공백·따옴표·$를 가져도 값 그대로 담는다(셸 문자열을 만들지 않는다)', () => {
    const root = "/work/my shop's $HOME";
    const plan = planGitMask([{ service: 'api', source: root, target: '/work space' }], [dirEntry(root, false)]);
    expect(plan.api).toEqual([ro(`${root}/.git`, '/work space/.git')]);
  });
});

describe('buildOverride의 .git 마스크', () => {
  const project = { managed: [['api', { template: 'node', path: '.', port: 3000 }]], composeServices: ['api', 'db'], external: [] } as unknown as LoadedProject;

  it('마스크를 준 서비스의 volumes에 겹치는 마운트를 적고, 안 준 서비스에는 volumes를 적지 않는다', () => {
    const gitMask = planGitMask([{ service: 'api', source: ROOT, target: '/workspace' }], [dirEntry(ROOT)]);
    const override = buildOverride(project, 'studio-shop-abc123', { gitMask });
    expect(override.services.api?.volumes).toEqual(gitMask.api);
    expect(override.services.db).not.toHaveProperty('volumes');
  });

  it('마스크가 없으면 예전과 똑같다', () => {
    const override = buildOverride(project, 'studio-shop-abc123');
    expect(override.services.api).not.toHaveProperty('volumes');
  });
});

describe('detectGitEntries / computeGitMask 실제 폴더', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });
  const temp = async () => {
    const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'git-mask-')));
    dirs.push(dir);
    return dir;
  };

  it('프로젝트 폴더의 .git 폴더와 상태 폴더를 찾는다', async () => {
    const root = await temp();
    await mkdir(path.join(root, '.git', 'b-studio'), { recursive: true });
    expect(await detectGitEntries(root, [root])).toEqual([{ dir: root, kind: 'directory', hasState: true }]);
  });

  it('.git이 파일이면 파일로, 없으면 아무것도 돌려주지 않는다', async () => {
    const root = await temp();
    expect(await detectGitEntries(root, [root])).toEqual([]);
    await writeFile(path.join(root, '.git'), 'gitdir: /elsewhere/.git/worktrees/x\n');
    expect(await detectGitEntries(root, [root])).toEqual([{ dir: root, kind: 'file', hasState: false }]);
  });

  it('심볼릭 링크 .git은 마운트 지점으로 쓸 수 없어 건너뛴다', async () => {
    const root = await temp();
    await mkdir(path.join(root, 'real-git'));
    await symlink('real-git', path.join(root, '.git'));
    expect(await detectGitEntries(root, [root])).toEqual([]);
  });

  it('모노레포 하위 폴더 프로젝트는 상위를 마운트한 서비스가 있을 때만 상위의 .git까지 찾는다', async () => {
    const repo = await temp();
    const root = path.join(repo, 'api');
    await mkdir(path.join(repo, '.git', 'b-studio'), { recursive: true });
    await mkdir(root);
    expect(await detectGitEntries(root, [root])).toEqual([]);
    expect(await detectGitEntries(root, [repo])).toEqual([{ dir: repo, kind: 'directory', hasState: true }]);
  });

  it('compose가 정규화한 services에서 서비스별 마스크를 계산한다(심볼릭 링크 경로도 같은 곳으로 본다)', async () => {
    const base = await temp();
    const root = path.join(base, 'proj');
    await mkdir(path.join(root, '.git', 'b-studio'), { recursive: true });
    const link = path.join(base, 'link');
    await symlink(root, link);
    const mask = await computeGitMask(root, {
      services: {
        api: { volumes: [{ type: 'bind', source: link, target: '/workspace' }] },
        db: { volumes: [{ type: 'volume', source: 'db-data', target: '/var/lib/data' }] },
      },
    });
    expect(mask).toEqual({ api: [ro(path.join(root, '.git'), '/workspace/.git'), empty(root, '/workspace/.git/b-studio')] });
  });

  it('서비스 여럿이 함께 재시작돼 동시에 불려도 실패하지 않고, 빈 폴더는 비어 있다(도그푸딩 마찰 187)', async () => {
    const base = await temp();
    const root = path.join(base, 'proj');
    await mkdir(path.join(root, '.git', 'b-studio'), { recursive: true });
    const config = { services: { api: { volumes: [{ type: 'bind', source: root, target: '/workspace' }] } } };
    // 전에는 "지우고 다시 만들기"가 엇갈려 EEXIST(또는 ENOENT)로 실패했다
    const results = await Promise.all(Array.from({ length: 24 }, () => computeGitMask(root, config)));
    for (const mask of results) expect(mask).toEqual({ api: [ro(path.join(root, '.git'), '/workspace/.git'), empty(root, '/workspace/.git/b-studio')] });
    expect(await readdir(path.join(root, '.git', 'b-studio-empty'))).toEqual([]);
  });

  it('빈 폴더 자리가 프로젝트 밖을 가리키는 링크면 따라가지 않는다: 링크만 지우고 진짜 빈 폴더를 만든다(그 너머의 파일은 그대로)', async () => {
    const base = await temp();
    const root = path.join(base, 'proj');
    await mkdir(path.join(root, '.git', 'b-studio'), { recursive: true });
    const outside = path.join(base, 'outside');
    await mkdir(path.join(outside, 'keep'), { recursive: true });
    await writeFile(path.join(outside, 'important.txt'), '지우면 안 되는 파일');
    await symlink(outside, path.join(root, '.git', 'b-studio-empty'));

    await computeGitMask(root, { services: { api: { volumes: [{ type: 'bind', source: root, target: '/workspace' }] } } });

    expect(await readFile(path.join(outside, 'important.txt'), 'utf8')).toBe('지우면 안 되는 파일');
    expect(await readdir(outside)).toEqual(['important.txt', 'keep']);
    const made = await lstat(path.join(root, '.git', 'b-studio-empty'));
    expect(made.isSymbolicLink()).toBe(false);
    expect(made.isDirectory()).toBe(true);
    expect(await readdir(path.join(root, '.git', 'b-studio-empty'))).toEqual([]);
  });

  it('빈 폴더 자리가 상태 폴더를 가리키는 링크여도 상태 폴더를 "빈 폴더"로 쓰지 않는다(상태는 그대로, 가리는 폴더는 진짜 빈 폴더)', async () => {
    const base = await temp();
    const root = path.join(base, 'proj');
    await mkdir(path.join(root, '.git', 'b-studio'), { recursive: true });
    await writeFile(path.join(root, '.git', 'b-studio', 'session.json'), '{"secret":true}');
    await symlink(path.join(root, '.git', 'b-studio'), path.join(root, '.git', 'b-studio-empty'));

    await computeGitMask(root, { services: { api: { volumes: [{ type: 'bind', source: root, target: '/workspace' }] } } });

    expect(await readFile(path.join(root, '.git', 'b-studio', 'session.json'), 'utf8')).toBe('{"secret":true}');
    expect((await lstat(path.join(root, '.git', 'b-studio-empty'))).isSymbolicLink()).toBe(false);
    expect(await readdir(path.join(root, '.git', 'b-studio-empty'))).toEqual([]);
  });

  it('빈 폴더에 내용이 들어 있으면 지우지 않고 멈춘다(이 코드는 아무것도 재귀적으로 지우지 않는다)', async () => {
    const base = await temp();
    const root = path.join(base, 'proj');
    await mkdir(path.join(root, '.git', 'b-studio'), { recursive: true });
    const outside = path.join(base, 'outside');
    await mkdir(outside);
    await writeFile(path.join(outside, 'important.txt'), 'x');
    await mkdir(path.join(root, '.git', 'b-studio-empty', 'leftover'), { recursive: true });
    await writeFile(path.join(root, '.git', 'b-studio-empty', 'leftover', 'note.txt'), 'x');
    await symlink(outside, path.join(root, '.git', 'b-studio-empty', 'link'));

    const config = { services: { api: { volumes: [{ type: 'bind', source: root, target: '/workspace' }] } } };
    const error = await computeGitMask(root, config).then(
      () => undefined,
      (caught: unknown) => caught as Error & { detail?: string },
    );
    expect(error?.message).toContain('가릴 빈 폴더를 준비하지 못했습니다');
    // 사용자의 코드로 고칠 수 없는 실패라고 표시한다(게이트가 재시도 횟수로 세지 않는다)
    expect((error as { platform?: boolean } | undefined)?.platform).toBe(true);
    expect(`${error?.message}\n${error?.detail ?? ''}`).toContain('폴더가 비어 있지 않습니다(leftover, link)');
    // 안의 것도, 링크가 가리키는 곳도 그대로다
    expect(await readFile(path.join(root, '.git', 'b-studio-empty', 'leftover', 'note.txt'), 'utf8')).toBe('x');
    expect(await readdir(outside)).toEqual(['important.txt']);
  });
});

describe('collectHostMounts bind가 아닌 꼴', () => {
  const volumes = {
    src: { driver: 'local', driver_opts: { type: 'none', o: 'bind', device: '/work/shop' } },
    rw: { driver: 'local', driver_opts: { type: 'none', o: 'rw,rbind', device: '/work/shop/api' } },
    nfs: { driver: 'local', driver_opts: { type: 'nfs', o: 'addr=10.0.0.1', device: ':/export' } },
    plain: {},
  };

  it('로컬 드라이버로 호스트 폴더에 묶은 이름 있는 볼륨은 bind와 같게 본다', () => {
    expect(boundDevice(volumes.src)).toBe('/work/shop');
    expect(boundDevice(volumes.rw)).toBe('/work/shop/api');
    expect(boundDevice(volumes.nfs)).toBeUndefined();
    expect(boundDevice(volumes.plain)).toBeUndefined();
    expect(boundDevice({ driver: 'rexray', driver_opts: { o: 'bind', device: '/work/shop' } })).toBeUndefined();
    expect(boundDevice({ driver_opts: { o: 'bind', device: 'relative' } })).toBeUndefined();

    const mounts = collectHostMounts({
      services: { api: { volumes: [{ type: 'volume', source: 'src', target: '/w' }, { type: 'volume', source: 'plain', target: '/p' }, { type: 'volume', target: '/anon' }] } },
      volumes,
    });
    expect(mounts).toEqual([{ service: 'api', source: '/work/shop', target: '/w' }]);
    expect(planGitMask(mounts, [dirEntry(ROOT)])).toEqual({ api: [ro(`${ROOT}/.git`, '/w/.git'), empty(ROOT, '/w/.git/b-studio')] });
  });

  it('volumes_from는 물려준 서비스의 마운트를 같은 target으로 물려받는다(전이적, 순환은 끊는다)', () => {
    const mounts = collectHostMounts({
      services: {
        a: { volumes: [{ type: 'bind', source: ROOT, target: '/workspace' }], volumes_from: ['c'] },
        b: { volumes_from: ['a:ro'] },
        c: { volumes_from: ['b'] },
      },
    });
    const of = (service: string) => mounts.filter((mount) => mount.service === service);
    expect(of('a')).toEqual([{ service: 'a', source: ROOT, target: '/workspace' }]);
    expect(of('b')).toEqual([{ service: 'b', source: ROOT, target: '/workspace' }]);
    expect(of('c')).toEqual([{ service: 'c', source: ROOT, target: '/workspace' }]);
    expect(Object.keys(planGitMask(mounts, [dirEntry(ROOT)])).sort()).toEqual(['a', 'b', 'c']);
  });

  it('volumes_from가 compose 밖 컨테이너를 가리키면 무엇이 붙는지 알 수 없어 던진다', () => {
    expect(() => collectHostMounts({ services: { a: { volumes_from: ['container:legacy:ro'] } } })).toThrow(/compose 밖의 컨테이너/);
  });
});

describe('findMissingMasks 실행 중 컨테이너의 마운트 확인', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function project() {
    const root = await realpath(await mkdtemp(path.join(tmpdir(), 'git-mask-inspect-')));
    dirs.push(root);
    await mkdir(path.join(root, '.git', 'b-studio'), { recursive: true });
    return root;
  }

  it('프로젝트 폴더를 쓰기 가능하게 붙였는데 .git 자리가 비어 있으면 그 자리를 돌려준다', async () => {
    const root = await project();
    const missing = await findMissingMasks(root, [{ Type: 'bind', Source: root, Destination: '/workspace', RW: true }], {});
    expect(missing).toEqual(['/workspace/.git', '/workspace/.git/b-studio']);
  });

  it('이름 있는 볼륨이 호스트 폴더에 묶여 있어도 같게 본다', async () => {
    const root = await project();
    const options = { shop_src: { driver: 'local', driver_opts: { type: 'none', o: 'bind', device: root } } };
    const mounts = [{ Type: 'volume', Name: 'shop_src', Source: '/var/lib/docker/volumes/shop_src/_data', Destination: '/w', RW: true }];
    expect(await findMissingMasks(root, mounts, options)).toEqual(['/w/.git', '/w/.git/b-studio']);
    expect(await findMissingMasks(root, mounts, {})).toEqual([]);
  });

  it('읽기 전용 .git과 상태 폴더 가리개가 있으면 빠진 자리가 없다', async () => {
    const root = await project();
    const mounts = [
      { Type: 'bind', Source: root, Destination: '/workspace', RW: true },
      { Type: 'bind', Source: path.join(root, '.git'), Destination: '/workspace/.git', RW: false },
      { Type: 'bind', Source: path.join(root, '.git', 'b-studio-empty'), Destination: '/workspace/.git/b-studio', RW: false },
    ];
    expect(await findMissingMasks(root, mounts, {})).toEqual([]);
  });

  it('.git 자리가 쓰기 가능한 마운트로 남아 있으면 빠진 것으로 본다', async () => {
    const root = await project();
    const mounts = [
      { Type: 'bind', Source: root, Destination: '/workspace', RW: true },
      { Type: 'bind', Source: path.join(root, '.git'), Destination: '/workspace/.git', RW: true },
      { Type: 'bind', Source: path.join(root, '.git', 'b-studio-empty'), Destination: '/workspace/.git/b-studio', RW: false },
    ];
    expect(await findMissingMasks(root, mounts, {})).toEqual(['/workspace/.git']);
  });

  it('프로젝트와 무관한 마운트만 있으면 확인할 것이 없다', async () => {
    const root = await project();
    expect(await findMissingMasks(root, [{ Type: 'volume', Name: 'db', Destination: '/data', RW: true }], {})).toEqual([]);
  });
});
