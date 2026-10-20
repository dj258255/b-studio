import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LoadedProject } from '@b-studio/spec';
import { afterEach, describe, expect, it } from 'vitest';
import { buildOverride } from './format';
import { boundDevice, collectHostMounts, computeGitMask, detectGitEntries, findMissingMasks, planEvaluationAssetMask, planGitMask, type GitEntry } from './git-mask';

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

describe('planEvaluationAssetMask 마운트 꼴별 계획', () => {
  const COPY = '/cache/evaluation-assets/sb/asset-1';
  const assets = [{ path: 'tests/acceptance', source: COPY }];

  it('프로젝트 루트를 마운트하면 자산 복사본이 컨테이너의 같은 자리에 읽기 전용으로 붙는다', () => {
    const plan = planEvaluationAssetMask([{ service: 'api', source: ROOT, target: '/app' }], ROOT, assets);
    expect(plan).toEqual({
      api: [ro(COPY, '/app/tests/acceptance')],
    });
  });

  it('자산을 품은 하위 폴더만 마운트하면 그 마운트 자리 기준으로 붙는다', () => {
    expect(planEvaluationAssetMask([{ service: 'api', source: `${ROOT}/tests`, target: '/t' }], ROOT, assets)).toEqual({
      api: [ro(COPY, '/t/acceptance')],
    });
  });

  it('자산 폴더 자체를 마운트하면 같은 자리에 복사본을 붙인다', () => {
    expect(planEvaluationAssetMask([{ service: 'api', source: `${ROOT}/tests/acceptance`, target: '/x' }], ROOT, assets)).toEqual({
      api: [ro(COPY, '/x')],
    });
  });

  it('자산과 무관한 마운트는 건드리지 않고, 선언이 없으면 빈 맵이다', () => {
    expect(planEvaluationAssetMask([{ service: 'db', source: '/var/data', target: '/data' }], ROOT, assets)).toEqual({});
    expect(planEvaluationAssetMask([{ service: 'api', source: ROOT, target: '/app' }], ROOT, [])).toEqual({});
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

  it('평가 자산 마스크도 서비스의 volumes에 적는다', () => {
    const copy = { path: 'tests/acceptance', source: '/cache/evaluation-assets/sb/asset-1' };
    const gitMask = planEvaluationAssetMask([{ service: 'api', source: ROOT, target: '/workspace' }], ROOT, [copy]);
    const override = buildOverride(project, 'studio-shop-abc123', { gitMask });
    expect(override.services.api?.volumes).toEqual([ro(copy.source, '/workspace/tests/acceptance')]);
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

  it('평가 자산은 선언 목록 그대로 git 마스크와 한 맵으로 합친다. 파일·링크·없는 자산도 기대에서 빠지지 않는다', async () => {
    const base = await temp();
    const root = path.join(base, 'proj');
    await mkdir(path.join(root, '.git', 'b-studio'), { recursive: true });
    // 붙일 원본은 작업 복사본이 아니라 b-studio가 가진 복사본이다(#745). 작업 복사본의 모습은 마스크 목록에 영향이 없다
    const copies = [
      { path: 'tests/acceptance', source: path.join(base, 'copies', 'dir') },
      { path: 'expected.json', source: path.join(base, 'copies', 'file') },
      { path: 'missing.json', source: path.join(base, 'copies', 'missing') },
      { path: 'linked', source: path.join(base, 'copies', 'linked') },
    ];

    const mask = await computeGitMask(
      root,
      { services: { api: { volumes: [{ type: 'bind', source: root, target: '/app' }] } } },
      { evaluationAssets: copies },
    );

    expect(mask).toEqual({
      api: [
        ro(path.join(root, '.git'), '/app/.git'),
        empty(root, '/app/.git/b-studio'),
        ro(copies[1]!.source, '/app/expected.json'),
        ro(copies[3]!.source, '/app/linked'),
        ro(copies[2]!.source, '/app/missing.json'),
        ro(copies[0]!.source, '/app/tests/acceptance'),
      ].sort((a, b) => a.target.localeCompare(b.target)),
    });
  });

  it('작업 복사본에서 자산을 지우거나 링크로 바꿔도 붙일 목록과 사후 확인 목록이 줄지 않는다(커밋 보안 검토)', async () => {
    const base = await temp();
    const root = path.join(base, 'proj');
    await mkdir(path.join(root, '.git', 'b-studio'), { recursive: true });
    await mkdir(path.join(root, 'tests', 'acceptance'), { recursive: true });
    const outside = path.join(base, 'outside');
    await mkdir(outside);
    const copies = [{ path: 'tests/acceptance', source: path.join(base, 'copies', 'dir') }];
    const config = { services: { api: { volumes: [{ type: 'bind', source: root, target: '/app' }] } } };

    // 자산을 지운 뒤에도 같은 자리를 기대한다
    await rm(path.join(root, 'tests', 'acceptance'), { recursive: true });
    const afterDelete = await computeGitMask(root, config, { evaluationAssets: copies });
    expect(afterDelete.api?.find((volume) => volume.target === '/app/tests/acceptance')?.source).toBe(copies[0]!.source);
    expect(await findMissingMasks(root, [{ Type: 'bind', Source: root, Destination: '/app', RW: true }], {}, { evaluationAssets: copies })).toContain('/app/tests/acceptance');

    // 링크로 바꿔도 기대가 줄지 않고, 마운트 원본은 작업 복사본이 아니다
    await symlink(outside, path.join(root, 'tests', 'acceptance'));
    const afterLink = await computeGitMask(root, config, { evaluationAssets: copies });
    const volume = afterLink.api?.find((entry) => entry.target === '/app/tests/acceptance');
    expect(volume?.source).toBe(copies[0]!.source);
    expect(volume?.source.startsWith(root)).toBe(false);
    expect(await findMissingMasks(root, [{ Type: 'bind', Source: root, Destination: '/app', RW: true }], {}, { evaluationAssets: copies })).toContain('/app/tests/acceptance');
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

  it('평가 자산 자리의 실제 마운트가 없거나 쓰기 가능하면 그 자리를 돌려준다(마운트 원본은 복사본)', async () => {
    const root = await project();
    const copies = [{ path: 'tests/acceptance', source: '/cache/evaluation-assets/sb/asset-1' }];
    const base = [
      { Type: 'bind', Source: root, Destination: '/workspace', RW: true },
      { Type: 'bind', Source: path.join(root, '.git'), Destination: '/workspace/.git', RW: false },
      { Type: 'bind', Source: path.join(root, '.git', 'b-studio-empty'), Destination: '/workspace/.git/b-studio', RW: false },
    ];
    const declared = { evaluationAssets: copies };
    expect(await findMissingMasks(root, base, {}, declared)).toEqual(['/workspace/tests/acceptance']);
    expect(await findMissingMasks(root, [...base, { Type: 'bind', Source: copies[0]!.source, Destination: '/workspace/tests/acceptance', RW: true }], {}, declared)).toEqual(['/workspace/tests/acceptance']);
    expect(await findMissingMasks(root, [...base, { Type: 'bind', Source: copies[0]!.source, Destination: '/workspace/tests/acceptance', RW: false }], {}, declared)).toEqual([]);
  });

  it('평가 자산 자리의 원본이 복사본이 아니거나 그 안쪽에 다른 마운트가 있으면 빠진 것으로 본다(커밋 보안 검토)', async () => {
    const root = await project();
    const copies = [{ path: 'tests/acceptance', source: '/cache/evaluation-assets/sb/asset-1' }];
    const base = [
      { Type: 'bind', Source: root, Destination: '/workspace', RW: true },
      { Type: 'bind', Source: path.join(root, '.git'), Destination: '/workspace/.git', RW: false },
      { Type: 'bind', Source: path.join(root, '.git', 'b-studio-empty'), Destination: '/workspace/.git/b-studio', RW: false },
    ];
    const declared = { evaluationAssets: copies };
    const copy = { Type: 'bind', Source: copies[0]!.source, Destination: '/workspace/tests/acceptance', RW: false };

    // 읽기 전용 마운트가 같은 자리에 있지만 원본이 b-studio의 복사본이 아니다
    const otherSource = { ...copy, Source: path.join(root, 'tests', 'acceptance') };
    expect(await findMissingMasks(root, [...base, otherSource], {}, declared)).toEqual(['/workspace/tests/acceptance']);
    // 자리 안쪽에 더 깊은 마운트가 있으면 컨테이너에는 그 내용이 덧씌워진다
    const nested = { Type: 'bind', Source: '/evil/check.mjs', Destination: '/workspace/tests/acceptance/check.mjs', RW: false };
    expect(await findMissingMasks(root, [...base, copy, nested], {}, declared)).toEqual(['/workspace/tests/acceptance']);
    // 셋 다 맞으면 통과
    expect(await findMissingMasks(root, [...base, copy], {}, declared)).toEqual([]);
  });

  /** Docker Desktop이 Source를 접두어 붙여 알려 주는 상황의 기본 마운트 */
  async function desktop() {
    const root = await project();
    const copies = [{ path: 'tests/acceptance', source: '/cache/evaluation-assets/sb/asset-1' }];
    const base = [
      { Type: 'bind', Source: root, Destination: '/workspace', RW: true },
      { Type: 'bind', Source: path.join(root, '.git'), Destination: '/workspace/.git', RW: false },
      { Type: 'bind', Source: path.join(root, '.git', 'b-studio-empty'), Destination: '/workspace/.git/b-studio', RW: false },
    ];
    const at = (Source: string) => [...base, { Type: 'bind', Source, Destination: '/workspace/tests/acceptance', RW: false }];
    return { root, copies, declared: { evaluationAssets: copies }, at };
  }

  it('Docker Desktop의 /host_mnt 접두어를 떼고 복사본과 견준다', async () => {
    const { root, copies, declared, at } = await desktop();
    expect(await findMissingMasks(root, at(`/host_mnt${copies[0]!.source}`), {}, declared)).toEqual([]);
  });

  it('Docker Desktop의 /run/desktop/mnt/host 접두어를 떼고 복사본과 견준다', async () => {
    const { root, copies, declared, at } = await desktop();
    expect(await findMissingMasks(root, at(`/run/desktop/mnt/host${copies[0]!.source}`), {}, declared)).toEqual([]);
  });

  it('접미어만 같은 다른 경로는 받지 않는다', async () => {
    const { root, copies, declared, at } = await desktop();
    expect(await findMissingMasks(root, at(`/elsewhere${copies[0]!.source}`), {}, declared)).toEqual(['/workspace/tests/acceptance']);
  });

  it('접두어를 떼고 난 경로에 `..`가 있으면 받지 않는다', async () => {
    const { root, copies, declared, at } = await desktop();
    expect(await findMissingMasks(root, at(`/host_mnt/..${copies[0]!.source}`), {}, declared)).toEqual(['/workspace/tests/acceptance']);
  });
});
