import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { LoadedProject } from '@b-studio/spec';
import { afterEach, describe, expect, it } from 'vitest';
import { buildOverride } from './format';
import { computeGitMask, detectGitEntries, planGitMask, type GitEntry } from './git-mask';

const ROOT = '/work/shop';
const ro = (source: string, target: string) => ({ type: 'bind', source, target, read_only: true, bind: { create_host_path: false } });
const dirEntry = (dir: string, hasState = true): GitEntry => ({ dir, kind: 'directory', hasState });

describe('planGitMask 마운트 꼴별 계획', () => {
  it('프로젝트 루트 전체를 마운트하면 .git은 읽기 전용, 상태 폴더는 tmpfs로 덮는다', () => {
    const plan = planGitMask([{ service: 'api', source: ROOT, target: '/workspace' }], [dirEntry(ROOT)]);
    expect(plan).toEqual({ api: [ro(`${ROOT}/.git`, '/workspace/.git'), { type: 'tmpfs', target: '/workspace/.git/b-studio' }] });
  });

  it('상태 폴더가 없으면 .git만 읽기 전용으로 한다', () => {
    const plan = planGitMask([{ service: 'api', source: ROOT, target: '/app' }], [dirEntry(ROOT, false)]);
    expect(plan).toEqual({ api: [ro(`${ROOT}/.git`, '/app/.git')] });
  });

  it('상위 폴더(모노레포 저장소 루트)를 마운트하면 상위의 .git을 덮는다', () => {
    const plan = planGitMask([{ service: 'api', source: '/work', target: '/repo' }], [dirEntry('/work')]);
    expect(plan).toEqual({ api: [ro('/work/.git', '/repo/.git'), { type: 'tmpfs', target: '/repo/.git/b-studio' }] });
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

  it('.git 안쪽을 직접 마운트했으면 같은 자리를 읽기 전용으로, 상태 폴더는 tmpfs로 바꿔 쓴다', () => {
    const plan = planGitMask(
      [
        { service: 'api', source: `${ROOT}/.git`, target: '/g' },
        { service: 'api', source: `${ROOT}/.git/refs`, target: '/refs' },
        { service: 'api', source: `${ROOT}/.git/b-studio/databases`, target: '/dumps' },
      ],
      [dirEntry(ROOT)],
    );
    expect(plan.api).toEqual([{ type: 'tmpfs', target: '/dumps' }, ro(`${ROOT}/.git`, '/g'), ro(`${ROOT}/.git/refs`, '/refs')]);
  });

  it('같은 자리를 두 규칙이 덮으면 tmpfs가 남는다', () => {
    const plan = planGitMask(
      [
        { service: 'api', source: ROOT, target: '/workspace' },
        { service: 'api', source: `${ROOT}/.git/b-studio`, target: '/workspace/.git/b-studio' },
      ],
      [dirEntry(ROOT)],
    );
    expect(plan.api?.filter((volume) => volume.target === '/workspace/.git/b-studio')).toEqual([{ type: 'tmpfs', target: '/workspace/.git/b-studio' }]);
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
      api: { volumes: [{ type: 'bind', source: link, target: '/workspace' }] },
      db: { volumes: [{ type: 'volume', source: 'db-data', target: '/var/lib/data' }] },
    });
    expect(mask).toEqual({ api: [ro(path.join(root, '.git'), '/workspace/.git'), { type: 'tmpfs', target: '/workspace/.git/b-studio' }] });
  });
});
