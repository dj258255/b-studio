import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SANDBOX_ID } from '@b-studio/sandbox';
import { afterAll, describe, expect, it } from 'vitest';
import { assertDeletable, assertResumableHome, planRecovery, removeSessionHome } from './session-lifecycle';
import { book, loadTable } from './frozen-vectors';
import { isProcessAlive } from './session-store';

/**
 * 세션 지우기·복구 판정(ADR-204, 4f B2a): Rust `lifecycle`을 옛 TS가 같은 입력에 낸 값(`session-lifecycle-vectors.json`에 고정)과 견준다.
 * 정상 세션(저장 파일의 경로가 세션 폴더와 같다)에서는 결과와 오류 글이 같다. 임시 폴더 경로는 시험마다 달라 입력 번호로 이름표를 붙이고, 글 속의 사용자 폴더는 `<USER>`로 바꿔 견준다. 다른 것은 아래 "의도한 차이"뿐이다.
 */

let cases = 0;
afterAll(() => console.log(`[session-lifecycle 벡터] 사례 ${cases}개`));

const OLD = book(loadTable(new URL('./session-lifecycle-vectors.json', import.meta.url)));
const ROOT = '/r/sessions';
const STATUSES = ['stopped', 'idle', 'ready', 'starting', 'failed', 'running', ''] as const;

describe('지우기 판정 벡터(상태와 작업 공간)', () => {
  it('정상 세션은 상태 일곱 가지 × 작업 공간 네 가지 × 상태 폴더 두 가지에서 옛 판정이 낸 값과 같다', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'lifecycle-diff-'));
    const root = path.join(tmp, 'sessions');
    const home = path.join(root, 'proj-ab12cd34');
    await mkdir(home, { recursive: true });
    const user = path.join(tmp, 'user-folder');
    for (const status of STATUSES) {
      for (const workspace of [undefined, 'copy', 'local', 'weird']) {
        // 정상 세션: 작업 복사본은 workDir이 세션 폴더(stateDir 없음), 내 폴더는 workDir이 사용자 폴더이고 stateDir이 세션 폴더
        // 그 밖에 내 폴더 세션의 stateDir이 없는 꼴(옛 검사가 막는 것)도 견준다
        const shapes: Array<{ workDir: string; stateDir?: string }> =
          workspace === 'local' ? [{ workDir: user, stateDir: home }, { workDir: user }, { workDir: user, stateDir: user }] : [{ workDir: home }];
        for (const [shapeIndex, shape] of shapes.entries()) {
          const old = OLD.get(`delete ${JSON.stringify({ status, workspace, shapeIndex })}`);
          let fresh: { status?: number; message: string } | undefined;
          try {
            assertDeletable(root, home, { id: 'ab12cd34', status: status as never, workspace: workspace as never, ...shape });
          } catch (error) {
            fresh = error as { status?: number; message: string };
          }
          cases += 1;
          expect(fresh ? { status: fresh.status, message: fresh.message.replaceAll(user, '<USER>') } : undefined, JSON.stringify({ status, workspace, shape })).toEqual(old);
        }
      }
    }
  });

  it('의도한 차이: 저장 파일의 경로가 세션 폴더가 아니면 옛 판정은 통과시키고 새 판정은 거부한다', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'lifecycle-diff-'));
    const root = path.join(tmp, 'sessions');
    const home = path.join(root, 'proj-ab12cd34');
    await mkdir(home, { recursive: true });
    const forged = [
      path.join(home, 'link', 'inner'), // 세션 폴더 안의 링크를 지나는 경로
      path.join(root, 'proj-ffff0000'), // 다른 세션의 폴더
      path.join(root, 'proj-ab12cd34', '..', 'proj-ffff0000'),
      `${root}//proj-ffff0000/`,
      path.join(home, 'nested'), // 세션 폴더 안의 폴더(지우면 세션의 일부만 지운다)
    ];
    for (const [index, workDir] of forged.entries()) {
      expect(OLD.get(`forged ${index}`), `옛 판정은 통과시켰다: ${workDir}`).toBeUndefined();
      expect(() => assertDeletable(root, home, { id: 'ab12cd34', status: 'stopped', workDir }), workDir).toThrow(/세션 저장소 밖/);
      cases += 1;
    }
    // 옛 글자 검사가 이미 막던 것은 새 판정도 막는다(같은 말을 넓힌 글)
    for (const [index, workDir] of [root, path.dirname(root), path.join(tmp, 'elsewhere')].entries()) {
      expect(OLD.get(`outside ${index}`), `옛 판정도 막았다: ${workDir}`).toBeDefined();
      expect(() => assertDeletable(root, home, { id: 'ab12cd34', status: 'stopped', workDir }), workDir).toThrow(/세션 저장소 밖/);
      cases += 1;
    }
  });
});

describe('복구 판정 벡터', () => {
  const deadPid = spawnSync('true').pid!;
  const pids = [process.pid, process.ppid, 1, 0, -1, -999_999, deadPid, 2 ** 31, 4_194_305, 1.5e10];
  /** 실행마다 다른 pid(이 프로세스·부모·끝난 프로세스)는 이름으로 적는다 */
  const pidLabel = (pid: number): string => (pid === process.pid ? 'self' : pid === process.ppid ? 'parent' : pid === deadPid ? 'dead' : String(pid));

  it('주인 프로세스 × 상태 × 샌드박스 id가 옛 판정이 낸 값과 같다(pid 0·음수 포함)', () => {
    const ids = ['studio-web-abcdef', 'studio-web-abcde', 'studio-Web-abcdef', 'studio-web-abcdef\n', 'other-web-abcdef', ''];
    for (const ownerPid of pids) {
      for (const status of STATUSES) {
        for (const sandboxId of ids) {
          const old = OLD.get(`recover ${JSON.stringify({ owner: pidLabel(ownerPid), status, sandboxId })}`);
          expect(planRecovery(status, ownerPid, sandboxId), JSON.stringify({ ownerPid, status, sandboxId })).toEqual(old);
          cases += 1;
        }
      }
    }
  });

  it('pid 0은 옛 동작 그대로 "다른 프로세스가 살아 있다"로 건너뛴다(kill(0, 0)은 자기 프로세스 그룹이라 성공한다)', () => {
    expect(isProcessAlive(0)).toBe(true);
    expect(planRecovery('stopped', 0, 'studio-web-abcdef').skip).toBe(true);
    // 이 프로세스의 pid는 살아 있어도 건너뛰지 않는다(자기가 주인이다)
    expect(planRecovery('stopped', process.pid, 'studio-web-abcdef').skip).toBe(false);
    // 끝난 프로세스의 세션은 복구한다
    expect(planRecovery('stopped', deadPid, 'studio-web-abcdef').skip).toBe(false);
  });

  it('SANDBOX_ID 꼴을 정규식과 같게 가른다(경계와 무작위 글자 3만 개)', () => {
    const edges = ['studio-a-abcdef', 'studio-a-abcdef\n', 'studio-a-abcdef\r', 'studio-\na-abcdef', 'studio-a-abcdeF', 'studio-a-abcdé', 'studio-ａ-abcdef', 'studio-a-abcdef\u0000', 'studio-a -abcdef', ' studio-a-abcdef'];
    const alphabet = ['studio-', 'a', 'z', '0', '9', 'f', 'g', 'A', '-', '_', '\n', ' ', 'é', '\u0000', 'abcdef', '-abcdef'];
    let seed = 20_261_116;
    const next = () => (seed = (seed * 1_103_515_245 + 12_345) & 0x7fff_ffff);
    const generated: string[] = [];
    for (let at = 0; at < 30_000; at += 1) {
      let text = next() % 4 === 0 ? '' : 'studio-';
      for (let n = next() % 6; n > 0; n -= 1) text += alphabet[next() % alphabet.length];
      generated.push(text);
    }
    for (const text of [...edges, ...generated]) {
      expect(planRecovery('stopped', 1, text).sandboxIdOk, JSON.stringify(text)).toBe(SANDBOX_ID.test(text));
    }
    cases += edges.length + generated.length;
  });
});

describe('지운 뒤의 디스크 상태 차등', () => {
  /** 임시 폴더 아래 같은 모양의 세션 폴더와 바깥 폴더를 만든다(링크 포함) */
  async function build(tmp: string): Promise<void> {
    const home = path.join(tmp, 'sessions', 'proj-ab12cd34');
    await mkdir(path.join(home, '.git', 'b-studio'), { recursive: true });
    await mkdir(path.join(home, 'web', 'node_modules', 'x'), { recursive: true });
    await writeFile(path.join(home, 'web', 'a.txt'), 'a');
    await writeFile(path.join(home, '.git', 'b-studio', 'session.json'), '{}');
    await mkdir(path.join(tmp, 'outside', 'inner'), { recursive: true });
    await writeFile(path.join(tmp, 'outside', 'inner', 'marker.txt'), 'keep');
    await symlink(path.join(tmp, 'outside'), path.join(home, 'link-dir'));
    await symlink(path.join(tmp, 'outside', 'inner', 'marker.txt'), path.join(home, 'link-file'));
    await symlink(path.join(tmp, 'missing'), path.join(home, 'dangling'));
    await mkdir(path.join(tmp, 'sessions', 'proj-ffff0000'), { recursive: true });
  }
  async function listing(dir: string, prefix = ''): Promise<string[]> {
    const out: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}${entry.isSymbolicLink() ? '@' : entry.isDirectory() ? '/' : ''}`;
      out.push(name);
      if (entry.isDirectory()) out.push(...(await listing(path.join(dir, entry.name), `${prefix}${entry.name}/`)));
    }
    return out.sort();
  }

  it('정상 세션을 지운 뒤의 폴더 모양이 옛 `rm -rf`와 같다(안의 링크는 링크만 지운다)', async () => {
    const oldTmp = await mkdtemp(path.join(tmpdir(), 'lifecycle-old-'));
    const newTmp = await mkdtemp(path.join(tmpdir(), 'lifecycle-new-'));
    await build(oldTmp);
    await build(newTmp);
    await rm(path.join(oldTmp, 'sessions', 'proj-ab12cd34'), { recursive: true, force: true });
    await removeSessionHome(path.join(newTmp, 'sessions'), path.join(newTmp, 'sessions', 'proj-ab12cd34'), { id: 'ab12cd34', status: 'stopped', workDir: path.join(newTmp, 'sessions', 'proj-ab12cd34') });
    expect(await listing(newTmp)).toEqual(await listing(oldTmp));
    expect(await listing(newTmp)).toContain('outside/inner/marker.txt');
    cases += 1;
  });

  it('이미 없는 폴더는 옛 `rm -f`처럼 성공한다', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'lifecycle-gone-'));
    const home = path.join(tmp, 'sessions', 'proj-ab12cd34');
    await mkdir(path.join(tmp, 'sessions'), { recursive: true });
    await rm(home, { recursive: true, force: true });
    await removeSessionHome(path.join(tmp, 'sessions'), home, { id: 'ab12cd34', status: 'stopped', workDir: home });
    cases += 1;
  });
});

describe('이어받기 판정', () => {
  it('정상 세션은 통과하고 저장 파일의 폴더가 다르면 409다', () => {
    const home = path.join(ROOT, 'proj-ab12cd34');
    expect(() => assertResumableHome(home, { workDir: home })).not.toThrow();
    expect(() => assertResumableHome(home, { workDir: '/u/project', stateDir: home, workspace: 'local' })).not.toThrow();
    for (const snapshot of [{ workDir: '/u/project' }, { workDir: path.join(home, 'link') }, { workDir: '/u/project', workspace: 'local' as const }]) {
      expect(() => assertResumableHome(home, snapshot)).toThrowError(expect.objectContaining({ status: 409 }) as never);
    }
    cases += 5;
  });
});
