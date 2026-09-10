import { mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { Workspace, WorkspaceError } from './workspace';

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
});
