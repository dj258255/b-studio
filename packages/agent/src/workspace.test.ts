import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { isSecretFile, readProjectFileSync, readRegularFileSync, syncExternalChanges, Workspace, WorkspaceError } from './workspace';

let root: string;
let workspace: Workspace;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'workspace-test-'));
  await mkdir(path.join(root, 'api/src'), { recursive: true });
  await mkdir(path.join(root, 'web/node_modules/next'), { recursive: true });
  await writeFile(path.join(root, 'api/src/App.java'), 'class App {\n  int a = 1;\n  int b = 1;\n}\n');
  await writeFile(path.join(root, 'web/node_modules/next/index.js'), '');
  await writeFile(path.join(root, '.env'), 'SECRET=1');
  workspace = new Workspace(root);
});

describe('Workspace', () => {
  it('생성물과 비밀 파일을 빼고 목록을 보여준다', async () => {
    expect(await workspace.list()).toEqual(['api/', 'api/src/', 'api/src/App.java', 'web/']);
  });

  it('peek은 읽은 표시를 남기지 않아, 그 뒤 밖에서 바뀐 파일도 쓰기를 막지 않는다(read는 막는다)', async () => {
    // 게이트가 훑어본 파일(peek)은 에이전트가 읽은 것이 아니므로 낡은 읽기 검사 대상이 아니다
    expect(await workspace.peek('api/src/App.java')).toContain('class App');
    await writeFile(path.join(root, 'api/src/App.java'), 'class App { /* 밖에서 고침 */ }\n');
    await workspace.write('api/src/App.java', 'class App { int c = 1; }\n');
    expect(await readFile(path.join(root, 'api/src/App.java'), 'utf8')).toBe('class App { int c = 1; }\n');

    // read로 읽은 파일은 기존처럼 밖에서 바뀌면 다시 읽으라고 거절한다
    await workspace.read('api/src/App.java');
    await writeFile(path.join(root, 'api/src/App.java'), 'class App { /* 또 고침 */ }\n');
    await expect(workspace.write('api/src/App.java', 'x')).rejects.toThrow('다시 읽고');
    // peek도 read와 같은 경로 제한을 따른다
    await expect(workspace.peek('.env')).rejects.toThrow(WorkspaceError);
    await expect(workspace.peek('../outside.txt')).rejects.toThrow(WorkspaceError);
  });

  it('readRegularFileSync는 일반 파일이고 상한 이하일 때만 읽고, 링크·폴더·FIFO·큰 파일은 읽지 않고 이유를 돌려준다', async () => {
    expect(readRegularFileSync(path.join(root, 'api/src/App.java'))).toEqual({ kind: 'text', content: 'class App {\n  int a = 1;\n  int b = 1;\n}\n' });
    expect(readRegularFileSync(path.join(root, 'api/src/None.java'))).toEqual({ kind: 'missing' });
    // 상위 요소가 파일이어도(ENOTDIR) 없는 것으로 본다
    expect(readRegularFileSync(path.join(root, 'api/src/App.java/inner'))).toEqual({ kind: 'missing' });

    // 링크는 가리키는 대상이 멀쩡한 파일이어도 따라가지 않는다
    await symlink(path.join(root, 'api/src/App.java'), path.join(root, 'link.md'));
    expect(readRegularFileSync(path.join(root, 'link.md'))).toMatchObject({ kind: 'irregular', reason: expect.stringContaining('링크') });
    expect(readRegularFileSync(path.join(root, 'api'))).toMatchObject({ kind: 'irregular' });

    await writeFile(path.join(root, 'big.md'), 'x'.repeat(2048));
    expect(readRegularFileSync(path.join(root, 'big.md'), 1024)).toMatchObject({ kind: 'irregular', reason: expect.stringContaining('너무 큽니다') });
    expect(readRegularFileSync(path.join(root, 'big.md'), 4096)).toMatchObject({ kind: 'text' });

    // FIFO는 쓰는 쪽이 없으면 여는 데서 영영 멈춘다. 멈추지 않고 일반 파일이 아니라고 돌려줘야 한다
    execFileSync('mkfifo', [path.join(root, 'pipe.md')]);
    expect(readRegularFileSync(path.join(root, 'pipe.md'))).toMatchObject({ kind: 'irregular' });
  });

  it('readProjectFileSync는 상위 폴더가 링크면 읽지 않는다(마지막 요소만 보는 확인을 폴더 링크로 비켜 가지 못한다)', async () => {
    expect(readProjectFileSync(root, 'api/src/App.java')).toMatchObject({ kind: 'text' });
    expect(readProjectFileSync(root, 'api/none/App.java')).toEqual({ kind: 'missing' });
    expect(readProjectFileSync(root, '../outside.txt')).toMatchObject({ kind: 'irregular', reason: expect.stringContaining('프로젝트 밖') });
    expect(readProjectFileSync(root, '/etc/hosts')).toMatchObject({ kind: 'irregular' });

    // 문서 폴더 자체를 다른 폴더로 가는 링크로 바꾼다: 그 안의 파일은 일반 파일이지만 읽지 않는다
    await mkdir(path.join(root, 'elsewhere'), { recursive: true });
    await writeFile(path.join(root, 'elsewhere/requirements.md'), '# 위조한 문서\n');
    await symlink(path.join(root, 'elsewhere'), path.join(root, 'docs'));
    expect(readProjectFileSync(root, 'docs/requirements.md')).toMatchObject({ kind: 'irregular', reason: expect.stringContaining('상위 폴더') });
    // 링크가 아닌 원래 폴더로는 그대로 읽힌다
    expect(readProjectFileSync(root, 'elsewhere/requirements.md')).toEqual({ kind: 'text', content: '# 위조한 문서\n' });
    // 고정 읽기도 같은 조건을 쓴다
    expect(workspace.snapshotRead('docs/requirements.md')).toMatchObject({ kind: 'irregular' });
  });

  it('beginRun에 기준 문서를 넘기면 디스크가 아니라 그것을 고정한다(없었으면 null)', async () => {
    await mkdir(path.join(root, 'docs'), { recursive: true });
    await writeFile(path.join(root, 'docs/requirements.md'), '# 디스크의 문서(체크포인트 없이 남은 변경 포함)\n');

    const fromCheckpoint = new Workspace(root);
    fromCheckpoint.beginRun('# 마지막 체크포인트의 문서\n');
    expect(fromCheckpoint.snapshotRead('docs/requirements.md')).toEqual({ kind: 'text', content: '# 마지막 체크포인트의 문서\n' });

    const noneAtCheckpoint = new Workspace(root);
    noneAtCheckpoint.beginRun(null);
    expect(noneAtCheckpoint.snapshotRead('docs/requirements.md')).toEqual({ kind: 'missing' });

    // 넘기지 않으면 예전처럼 지금 디스크의 문서를 쓴다
    const fromDisk = new Workspace(root);
    fromDisk.beginRun();
    expect(fromDisk.snapshotRead('docs/requirements.md')).toMatchObject({ kind: 'text', content: expect.stringContaining('디스크의 문서') });
  });

  it('snapshotRead는 부른 순간의 내용을 고정하고, 프로젝트 밖 경로는 받지 않는다', async () => {
    const first = workspace.snapshotRead('api/src/App.java');
    expect(first).toMatchObject({ kind: 'text' });
    // 고정한 직후에 파일이 바뀌어도 기준점은 그대로다(비동기 읽기였다면 바뀐 내용이 기준이 될 수 있었다)
    await writeFile(path.join(root, 'api/src/App.java'), 'class Changed {}\n');
    expect(workspace.snapshotRead('api/src/App.java')).toBe(first);
    expect(await workspace.snapshotFile('api/src/App.java')).toContain('class App');
    expect(workspace.snapshotRead('api/src/None.java')).toEqual({ kind: 'missing' });

    expect(() => workspace.snapshotRead('../outside.txt')).toThrow(WorkspaceError);
    expect(() => workspace.snapshotRead('/etc/hosts')).toThrow(WorkspaceError);
    expect(() => workspace.snapshotRead('api/../../outside.txt')).toThrow(WorkspaceError);
  });

  it('프로젝트 밖, 절대 경로, 거부된 경로를 막는다', async () => {
    await expect(workspace.read('../outside.txt')).rejects.toThrow(WorkspaceError);
    await expect(workspace.read('/etc/hosts')).rejects.toThrow(WorkspaceError);
    await expect(workspace.read('.env')).rejects.toThrow(WorkspaceError);
    await expect(workspace.write('web/node_modules/x.js', '')).rejects.toThrow(WorkspaceError);
  });

  it('프로젝트 밖을 가리키는 심볼릭 링크로 쓰지 못한다', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'outside-'));
    await symlink(outside, path.join(root, 'escape'));
    await expect(workspace.write('escape/evil.txt', 'x')).rejects.toThrow('링크');
  });

  it('정확히 한 곳만 일치할 때 수정하고 바뀐 파일을 기록한다', async () => {
    await workspace.edit('api/src/App.java', 'int a = 1;', 'int a = 2;');
    expect(await readFile(path.join(root, 'api/src/App.java'), 'utf8')).toContain('int a = 2;');
    expect(workspace.changedFiles()).toEqual(['api/src/App.java']);
  });

  it('여러 곳에 일치하거나 없으면 수정을 거부한다', async () => {
    await expect(workspace.edit('api/src/App.java', ' = 1;', ' = 3;')).rejects.toThrow('여러 번');
    await expect(workspace.edit('api/src/App.java', 'int c', 'int d')).rejects.toThrow('찾지 못했습니다');
    expect(workspace.changedFiles()).toEqual([]);
  });

  it('읽은 뒤 사람이 파일을 바꿨으면 덮어쓰지 않는다', async () => {
    await workspace.read('api/src/App.java');
    await writeFile(path.join(root, 'api/src/App.java'), 'class App { /* 사람이 수정 */ }\n');
    await expect(workspace.write('api/src/App.java', 'class App {}')).rejects.toThrow('다른 곳에서');
  });

  it('새 파일은 상위 폴더까지 만든다', async () => {
    await workspace.write('api/src/main/resources/db/migration/V1__init.sql', 'create table t (id bigint);');
    expect(workspace.changedFiles()).toEqual(['api/src/main/resources/db/migration/V1__init.sql']);
  });

  it('파일을 지우면 바뀐 파일과 지운 파일에 함께 기록한다', async () => {
    await workspace.remove('api/src/App.java');
    await expect(readFile(path.join(root, 'api/src/App.java'), 'utf8')).rejects.toThrow();
    expect(workspace.changedFiles()).toEqual(['api/src/App.java']);
    expect(workspace.deletedFiles()).toEqual(['api/src/App.java']);
  });

  it('없는 파일과 비밀 파일은 지우지 못한다', async () => {
    await expect(workspace.remove('api/src/Missing.java')).rejects.toThrow('파일이 없습니다');
    await expect(workspace.remove('.env')).rejects.toThrow(WorkspaceError);
    expect(await readFile(path.join(root, '.env'), 'utf8')).toBe('SECRET=1');
    expect(workspace.deletedFiles()).toEqual([]);
  });

  it('지운 뒤 같은 경로에 다시 쓰면 지운 파일 목록에서 빠진다', async () => {
    await workspace.remove('api/src/App.java');
    await workspace.write('api/src/App.java', 'class App {}\n');
    expect(workspace.deletedFiles()).toEqual([]);
    expect(workspace.changedFiles()).toEqual(['api/src/App.java']);
    expect(await readFile(path.join(root, 'api/src/App.java'), 'utf8')).toBe('class App {}\n');
  });

  it('마지막으로 읽은 뒤 사람이 바꾼 파일은 지우지 않는다', async () => {
    await workspace.read('api/src/App.java');
    await writeFile(path.join(root, 'api/src/App.java'), 'class App { /* 사람이 수정 */ }\n');
    await expect(workspace.remove('api/src/App.java')).rejects.toThrow('다른 곳에서');
    expect(await readFile(path.join(root, 'api/src/App.java'), 'utf8')).toContain('사람이 수정');
    expect(workspace.deletedFiles()).toEqual([]);
  });

  it('바깥에서 바뀐 파일을 알리고 경로를 정규화하며 여러 번 불러도 중복되지 않는다', () => {
    workspace.trackExternalChanges(['./api/src/App.java', 'web\\src\\page.tsx']);
    workspace.trackExternalChanges(['api/src/App.java']);
    expect(workspace.changedFiles()).toEqual(['api/src/App.java', 'web/src/page.tsx']);
  });

  it('바깥 변경으로 루트 밖 경로를 알리면 거부한다', () => {
    expect(() => workspace.trackExternalChanges(['../secret.txt'])).toThrow(WorkspaceError);
    expect(workspace.changedFiles()).toEqual([]);
  });

  it('지운 것으로 기록된 파일을 다시 알리면 지운 파일 목록에서 빠진다', async () => {
    await workspace.remove('api/src/App.java');
    workspace.trackExternalChanges(['api/src/App.java']);
    expect(workspace.deletedFiles()).toEqual([]);
    expect(workspace.changedFiles()).toEqual(['api/src/App.java']);
  });

  it('바깥 변경을 알릴 때 파일 내용을 읽지 않는다', () => {
    expect(() => workspace.trackExternalChanges(['api/src/Ghost.java'])).not.toThrow();
    expect(workspace.changedFiles()).toEqual(['api/src/Ghost.java']);
  });

  it('바깥 변경 입구에서도 비밀 파일·생성물·루트 경로를 거부한다', () => {
    expect(() => workspace.trackExternalChanges(['.env'])).toThrow(WorkspaceError);
    expect(() => workspace.trackExternalChanges(['node_modules/x.js'])).toThrow(WorkspaceError);
    expect(() => workspace.trackExternalChanges([''])).toThrow(WorkspaceError);
    expect(workspace.changedFiles()).toEqual([]);
  });
});

describe('syncExternalChanges (ADR-131: 게이트 없이 체크포인트가 생기던 사고 방지)', () => {
  it('세션이 시작되기 전부터 있던 변경(보관본 되살리기 등)을 동기화해 게이트가 검증 대상으로 보게 한다', () => {
    syncExternalChanges(workspace, ['api/src/App.java', 'web/src/page.tsx']);
    expect(workspace.changedFiles()).toEqual(['api/src/App.java', 'web/src/page.tsx']);
  });

  it('거부되는 경로(프로젝트 밖·생성물·비밀 파일·폴더)는 조용히 건너뛰고 나머지는 동기화한다', () => {
    expect(() => syncExternalChanges(workspace, ['../secret.txt', '.env', 'node_modules/x.js', 'api/src/', 'api/src/App.java'])).not.toThrow();
    expect(workspace.changedFiles()).toEqual(['api/src/App.java']);
  });

  it('빈 목록이면 아무것도 바뀌지 않는다', () => {
    syncExternalChanges(workspace, []);
    expect(workspace.changedFiles()).toEqual([]);
  });
});

describe('Workspace — .env 예시 파일', () => {
  it('.env.example·.env.sample·.env.local.example은 읽고 쓸 수 있지만 .env·.env.local·.env.production은 여전히 막는다', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'b-studio-env-example-'));
    try {
      const workspace = new Workspace(root);
      await workspace.write('.env.example', 'API_BASE_URL=\n');
      await workspace.write('frontend/.env.sample', 'NEXT_PUBLIC_API_BASE_URL=\n');
      await workspace.write('.env.local.example', 'X=\n');
      expect(await readFile(path.join(root, '.env.example'), 'utf8')).toBe('API_BASE_URL=\n');
      await expect(workspace.write('.env', 'SECRET=1')).rejects.toThrow(WorkspaceError);
      await expect(workspace.write('.env.local', 'SECRET=1')).rejects.toThrow(WorkspaceError);
      await expect(workspace.write('.env.production', 'SECRET=1')).rejects.toThrow(WorkspaceError);
      expect(isSecretFile('.env.example')).toBe(false);
      expect(isSecretFile('backend/.env')).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
