import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { deleteSession, getSnapshot, recoverSessions } from './sessions';

/**
 * 세션 지우기가 지우는 폴더는 저장 파일이 적은 경로가 아니라 세션을 읽어 온 폴더다(ADR-204, 4f B2a).
 * 옛 구현은 저장 파일의 `workDir`(내 폴더 세션은 `stateDir`)을 글자로만 "세션 저장소 안인가" 확인하고 `rm -rf`했다.
 * 세션 폴더 안의 링크·`..`로 그 글자 검사를 지나 저장소 밖이나 다른 세션의 폴더를 지울 수 있었다.
 *
 * 모든 폴더는 임시 폴더 안에 만든다("지워지면 안 되는" 폴더도). `recoverSessions()`는 프로세스마다 한 번만 디스크를 읽으므로
 * (sessions-delete-guard.test.ts의 설명) 모든 사례를 먼저 만들고 한 번 복구한다.
 */

let tmp: string;
let sessions: string;
const saved = { sessions: process.env.B_STUDIO_SESSIONS_DIR };
const deadPid = spawnSync('true').pid;

function forged(id: string, workDir: string, extra: { workspace?: 'local'; stateDir?: string; ownerPid?: number } = {}): string {
  return JSON.stringify({
    version: 1,
    savedAt: new Date().toISOString(),
    owner: { pid: extra.ownerPid ?? deadPid },
    snapshot: { id, projectId: 'p', projectName: 'p', workDir, workspace: extra.workspace, stateDir: extra.stateDir, status: 'stopped', mode: 'api', running: false, services: [], checkpoints: [] },
    history: [],
    conversation: [],
    demoIndex: 0,
    claudeCode: { notes: [] },
    sourceDirtyFiles: 0,
    sandbox: { id: 'studio-p-abcdef', provider: 'fake' },
  });
}

/** 세션 폴더(`<root>/p-<id>`)와 그 안의 저장 파일을 만든다 */
async function sessionFolder(id: string, workDir: string, extra: { workspace?: 'local'; stateDir?: string; ownerPid?: number } = {}): Promise<string> {
  const dir = path.join(sessions, `p-${id}`);
  await mkdir(path.join(dir, '.git', 'b-studio'), { recursive: true });
  await writeFile(path.join(dir, '.git', 'b-studio', 'session.json'), forged(id, workDir, extra));
  return dir;
}

/** 지워지면 안 되는 폴더: 임시 폴더 안, 세션 저장소 밖 */
async function precious(name: string): Promise<{ dir: string; inner: string; marker: string }> {
  const dir = path.join(tmp, `precious-${name}`);
  const inner = path.join(dir, 'inner');
  await mkdir(inner, { recursive: true });
  const marker = path.join(inner, 'marker.txt');
  await writeFile(marker, '지우면 안 되는 파일');
  await writeFile(path.join(dir, 'top.txt'), '지우면 안 되는 파일');
  return { dir, inner, marker };
}

const keep = (file: string) => expect(readFile(file, 'utf8')).resolves.toBe('지우면 안 되는 파일');
/** 지우기를 시도한다. 던진 오류가 있으면 돌려준다(지워진 폴더를 먼저 보려고 던짐 여부는 나중에 확인한다) */
const attempt = (id: string) => deleteSession(id).then(() => undefined, (error: unknown) => error as Error);
const exists = (file: string) => access(file).then(() => true, () => false);

const outside: Record<string, Awaited<ReturnType<typeof precious>>> = {};
let otherDir: string;
let otherMarker: string;
let userFolder: string;

beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'b-studio-home-guard-'));
  sessions = path.join(tmp, 'sessions');
  process.env.B_STUDIO_SESSIONS_DIR = sessions;
  await mkdir(sessions, { recursive: true });

  // 1. 세션 폴더 안의 링크가 저장소 밖을 가리킨다(작업 복사본 세션)
  outside.link = await precious('link');
  const link = await sessionFolder('aaaa0001', '');
  await symlink(outside.link.dir, path.join(link, 'link'));
  await writeFile(path.join(link, '.git', 'b-studio', 'session.json'), forged('aaaa0001', path.join(link, 'link', 'inner')));

  // 2. 다른 세션 폴더를 가리킨다
  otherDir = path.join(sessions, 'p-bbbb0002');
  await mkdir(path.join(otherDir, '.git', 'b-studio'), { recursive: true });
  otherMarker = path.join(otherDir, 'marker.txt');
  await writeFile(otherMarker, '지우면 안 되는 파일');
  await writeFile(path.join(otherDir, '.git', 'b-studio', 'session.json'), forged('bbbb0002', otherDir));
  await sessionFolder('aaaa0002', otherDir);

  // 3. 루트 자체, 4. 루트의 부모
  await sessionFolder('aaaa0003', sessions);
  await sessionFolder('aaaa0004', path.join(sessions, '..'));

  // 5. `..`로 다른 세션 폴더, 6. 겹친 구분자와 끝의 `/`로 다른 세션 폴더
  await sessionFolder('aaaa0005', path.join(sessions, 'p-aaaa0005', '..', 'p-bbbb0002'));
  await sessionFolder('aaaa0006', `${sessions}//p-bbbb0002/`);

  // 7. 내 폴더 세션: 상태 폴더(stateDir)가 세션 폴더 안의 링크를 지난다. 사용자 폴더는 따로 있다
  outside.local = await precious('local');
  userFolder = path.join(tmp, 'user-folder');
  await mkdir(userFolder, { recursive: true });
  await writeFile(path.join(userFolder, 'mine.txt'), '지우면 안 되는 파일');
  const local = await sessionFolder('aaaa0007', userFolder);
  await symlink(outside.local.dir, path.join(local, 'link'));
  await writeFile(path.join(local, '.git', 'b-studio', 'session.json'), forged('aaaa0007', userFolder, { workspace: 'local', stateDir: path.join(local, 'link', 'inner') }));

  // 8. 내 폴더 세션인데 stateDir이 사용자 폴더(workDir)를 가리킨다
  await sessionFolder('aaaa0008', userFolder, { workspace: 'local', stateDir: userFolder });

  // 9. 주인 프로세스(이 프로세스의 부모)가 살아 있는 세션은 복구하지 않는다
  await sessionFolder('aaaa0009', path.join(sessions, 'p-aaaa0009'), { ownerPid: process.ppid });

  await recoverSessions();
});

afterAll(() => {
  if (saved.sessions === undefined) delete process.env.B_STUDIO_SESSIONS_DIR;
  else process.env.B_STUDIO_SESSIONS_DIR = saved.sessions;
});

describe('세션 지우기는 저장 파일의 경로가 아니라 세션을 읽어 온 폴더만 지운다', () => {
  it('세션 폴더 안의 링크를 지나는 경로로 저장소 밖 폴더를 지우지 않는다', async () => {
    expect(getSnapshot('aaaa0001')).toBeDefined();
    const error = await attempt('aaaa0001');
    await keep(outside.link.marker);
    await keep(path.join(outside.link.dir, 'top.txt'));
    expect(error?.message).toMatch(/세션 저장소 밖/);
    expect(getSnapshot('aaaa0001')).toBeDefined();
  });

  it('다른 세션의 폴더를 가리키는 저장 파일로 그 세션의 폴더를 지우지 않는다', async () => {
    const error = await attempt('aaaa0002');
    await keep(otherMarker);
    expect(error?.message).toMatch(/세션 저장소 밖/);
    expect(getSnapshot('bbbb0002')).toBeDefined();
  });

  it('세션 저장소 루트와 그 부모는 지우지 않는다', async () => {
    const errors = [await attempt('aaaa0003'), await attempt('aaaa0004')];
    await keep(otherMarker);
    expect(await exists(path.join(sessions, 'p-aaaa0001'))).toBe(true);
    expect(await exists(tmp)).toBe(true);
    for (const error of errors) expect(error?.message).toMatch(/세션 저장소 밖/);
  });

  it('`..`와 겹친 구분자와 끝의 `/`로 다른 세션 폴더를 가리켜도 지우지 않는다', async () => {
    const errors = [await attempt('aaaa0005'), await attempt('aaaa0006')];
    await keep(otherMarker);
    for (const error of errors) expect(error?.message).toMatch(/세션 저장소 밖/);
  });

  it('내 폴더 세션의 상태 폴더가 링크를 지나 저장소 밖으로 나가면 지우지 않는다', async () => {
    const error = await attempt('aaaa0007');
    await keep(outside.local.marker);
    await keep(path.join(userFolder, 'mine.txt'));
    expect(error?.message).toMatch(/세션 저장소 밖/);
  });

  it('내 폴더 세션의 상태 폴더가 사용자 폴더이면 지우지 않는다(옛 검사 그대로)', async () => {
    const error = await attempt('aaaa0008');
    await keep(path.join(userFolder, 'mine.txt'));
    expect(error?.message).toMatch(/상태 폴더를 확인하지 못해/);
  });

  it('주인 프로세스가 살아 있는 세션은 복구 목록에 올리지 않고, 끝난 프로세스의 세션은 올린다', () => {
    expect(getSnapshot('aaaa0009')).toBeUndefined();
    expect(getSnapshot('aaaa0008')).toBeDefined();
  });
});
