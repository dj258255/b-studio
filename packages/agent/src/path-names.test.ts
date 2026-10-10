import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalName, canonicalProjectPath } from './path-names';
import { checkToolPolicy, isProtectedPath } from './policy';
import { Workspace } from './workspace';

describe('경로를 비교할 수 있는 꼴로 맞춘다 (트러블슈팅 125)', () => {
  it('구분자, ., .., 겹친 /를 정리하고 조각마다 대소문자·정규화 꼴·보이지 않는 문자를 맞춘다', () => {
    expect(canonicalProjectPath('web/../.github/workflows/ci.yml')).toBe('.github/workflows/ci.yml');
    expect(canonicalProjectPath('.github//workflows/./ci.yml')).toBe('.github/workflows/ci.yml');
    expect(canonicalProjectPath('.GITHUB\\Workflows\\CI.yml')).toBe('.github/workflows/ci.yml');
    expect(canonicalProjectPath('./infra/')).toBe('infra');
    expect(canonicalProjectPath('.')).toBe('');
    expect(canonicalName('.g\u200cit')).toBe('.git');
    // NFD로 풀린 한글도 같은 이름이다
    expect(canonicalName('문서'.normalize('NFD'))).toBe('문서');
  });

  it('루트 밖으로 나가는 경로와 절대 경로는 꼴이 없다', () => {
    for (const file of ['..', '../x', 'web/../../x', '/etc/hosts', 'C:/Windows/x']) expect(canonicalProjectPath(file), file).toBeUndefined();
  });
});

describe('실행 정책의 경로 검사는 같은 파일의 다른 표기를 놓치지 않는다 (트러블슈팅 125)', () => {
  const protectedPolicy = { protectedPaths: ['.env', '.github/workflows', 'infra', 'migrations'] };
  const decide = (file: string, policy: object, tool = 'write_file') => checkToolPolicy(tool, { path: file }, policy, undefined).decision;

  it('보호 경로: .., 겹친 /, 대소문자를 바꾼 표기를 모두 거절한다', () => {
    for (const file of [
      '.github/workflows/ci.yml',
      'web/../.github/workflows/ci.yml',
      '.github//workflows/ci.yml',
      '.GITHUB/workflows/ci.yml',
      'Infra/main.tf',
      'infra/./main.tf',
      'migrations/../migrations/V2.sql',
      '.ENV',
      '.env.local',
      'web/app/../../.Env.production',
    ]) {
      expect(decide(file, protectedPolicy), file).toBe('deny');
      expect(decide(file, protectedPolicy, 'edit_file'), file).toBe('deny');
      expect(decide(file, protectedPolicy, 'delete_file'), file).toBe('deny');
    }
  });

  it('보호 경로를 닮았을 뿐인 경로는 그대로 허용한다', () => {
    for (const file of ['web/app/page.tsx', 'docs/infra-notes.md', 'infrastructure/main.tf', 'web/migrations-helper.ts', 'env.md']) expect(decide(file, protectedPolicy), file).toBe('allow');
  });

  it('쓰기 범위: ..로 범위를 벗어나는 경로를 거절한다', () => {
    const scoped = { writablePaths: ['web/app/plan-a'] };
    expect(decide('web/app/plan-a/x.md', scoped)).toBe('allow');
    expect(decide('web/app/plan-a/sub/../y.md', scoped)).toBe('allow');
    expect(decide('WEB/app/Plan-A/x.md', scoped)).toBe('allow');
    for (const file of ['web/app/plan-a/../../../api/Secret.java', 'web/app/plan-a/../plan-b/x.md', 'web/app/plan-ab/x.md']) expect(decide(file, scoped), file).toBe('deny');
  });

  it('프로젝트 밖으로 나가는 경로는 범위를 따지기 전에 거절한다', () => {
    expect(checkToolPolicy('write_file', { path: '../outside.txt' }, protectedPolicy, undefined)).toMatchObject({ decision: 'deny', reason: 'path leaves the project' });
    expect(checkToolPolicy('write_file', { path: '/etc/hosts' }, { writablePaths: ['web'] }, undefined)).toMatchObject({ decision: 'deny', reason: 'path leaves the project' });
  });

  it('규칙 쪽의 표기가 달라도 같은 범위다', () => {
    expect(isProtectedPath('infra/main.tf', './Infra/')).toBe(true);
    expect(isProtectedPath('.github/workflows/ci.yml', '.github\\workflows')).toBe(true);
    expect(isProtectedPath('web/x.ts', '.')).toBe(true);
  });
});

describe('작업 공간은 바뀐 파일을 실제 저장 이름으로 기록한다 (트러블슈팅 125)', () => {
  it('..와 겹친 /가 든 경로로 써도 정리된 경로로 기록한다', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'path-names-'));
    await mkdir(path.join(root, 'web', 'app'), { recursive: true });
    const workspace = new Workspace(root);
    await workspace.write('web/app/../app//page.tsx', 'export default function Page() {}');
    expect(workspace.changedFiles()).toEqual(['web/app/page.tsx']);
  });

  it('대소문자를 구분하지 않는 볼륨에서는 대소문자를 바꿔 써도 실제 폴더 이름으로 기록한다', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'path-names-'));
    await mkdir(path.join(root, 'web', 'app'), { recursive: true });
    await writeFile(path.join(root, 'web', 'app', 'page.tsx'), 'old');
    // 이 볼륨이 대소문자를 구분하면(리눅스 CI) 다른 폴더가 새로 생기는 것이 맞으므로 확인할 것이 없다
    if (!existsSync(path.join(root, 'WEB', 'APP'))) return;
    const workspace = new Workspace(root);
    await workspace.write('WEB/App/page.tsx', 'new');
    await workspace.write('Web/APP/New.tsx', 'x');
    expect(workspace.changedFiles()).toEqual(['web/app/New.tsx', 'web/app/page.tsx']);
  });
});
