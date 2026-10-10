import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { canonicalProjectPath, foldName, normalizeProjectPath } from './path-names';
import { checkToolPolicy, isProtectedPath, isWithinScope } from './policy';
import { isInScope } from './task-plan';
import { Workspace } from './workspace';

describe('경로를 비교할 수 있는 꼴로 맞춘다 (트러블슈팅 125)', () => {
  it('구분자, ., .., 겹친 /를 정리하고 조각마다 대소문자·정규화 꼴·보이지 않는 문자를 맞춘다', () => {
    expect(canonicalProjectPath('web/../.github/workflows/ci.yml')).toBe('.github/workflows/ci.yml');
    expect(canonicalProjectPath('.github//workflows/./ci.yml')).toBe('.github/workflows/ci.yml');
    expect(canonicalProjectPath('.GITHUB/Workflows/CI.yml')).toBe('.github/workflows/ci.yml');
    expect(canonicalProjectPath('./infra/')).toBe('infra');
    expect(canonicalProjectPath('.')).toBe('');
    expect(foldName('.g\u200cit')).toBe('.git');
    // NFD로 풀린 한글도 같은 이름이다
    expect(foldName('문서'.normalize('NFD'))).toBe('문서');
  });

  it('거부 목록용 접기는 소문자 변환이 놓치는 닮은 글자와 끝의 점·공백까지 모은다', () => {
    // 긴 s(ſ)는 이미 소문자라 toLowerCase로는 그대로 남지만, 대소문자를 구분하지 않는 볼륨에서는 s와 같은 글자다
    expect(foldName('node_module\u017f')).toBe('node_modules');
    expect(foldName('workflow\u017f')).toBe('workflows');
    // 켈빈 기호, 전각 글자, 악센트
    expect(foldName('\u212Aafka')).toBe('kafka');
    expect(foldName('\uff0e\uff47\uff49\uff54')).toBe('.git');
    expect(foldName('.g\u00eft')).toBe('.git');
    // Windows·SMB는 이름 끝의 점과 공백을 무시한다
    expect(foldName('.git.')).toBe('.git');
    expect(foldName('.env ')).toBe('.env');
    expect(foldName('...')).toBe('...');
    // 평범한 이름은 소문자가 될 뿐이다
    expect(foldName('LiveViewer.tsx')).toBe('liveviewer.tsx');
  });

  it('표기만 정리하는 함수는 이름을 접지 않는다(허용 목록용)', () => {
    expect(normalizeProjectPath('WEB/app/../App//Page.tsx')).toBe('WEB/App/Page.tsx');
    expect(normalizeProjectPath('./web/')).toBe('web');
    expect(normalizeProjectPath('a\0b')).toBeUndefined();
    // 콜론이 든 평범한 이름은 상대 경로다. 드라이브 절대 경로만 거른다
    expect(normalizeProjectPath('notes/a:b.txt')).toBe('notes/a:b.txt');
    expect(normalizeProjectPath('a:b.txt')).toBe('a:b.txt');
    expect(normalizeProjectPath('C:/Windows/x')).toBeUndefined();
  });

  it('POSIX에서 역슬래시가 든 경로는 받지 않는다 — 검사는 구분자로, 파일 시스템은 이름의 글자로 읽어 어긋난다', () => {
    if (path.sep === '\\') return;
    // 검사가 구분자로 읽으면 `infra/a\..\..\x`는 `x`가 되지만, 실제로는 infra 안에 그 이름의 파일이 생긴다
    expect(normalizeProjectPath('infra/a\\..\\..\\x')).toBeUndefined();
    expect(canonicalProjectPath('.GITHUB\\Workflows\\CI.yml')).toBeUndefined();
    // 설정에 적은 규칙은 같은 뜻으로 읽는다
    expect(normalizeProjectPath('infra\\prod', { lenientSeparators: true })).toBe('infra/prod');
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
      '.github/workflow\u017f/ci.yml',
      '.github/workflows./ci.yml',
      'infra/a\\..\\..\\x',
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
    for (const file of ['web/app/plan-a/../../../api/Secret.java', 'web/app/plan-a/../plan-b/x.md', 'web/app/plan-ab/x.md']) expect(decide(file, scoped), file).toBe('deny');
  });

  it('쓰기 범위는 이름을 글자 그대로 본다 — 보호 경로처럼 접어서 비교하면 다른 폴더가 범위 안이 된다 (트러블슈팅 126)', () => {
    const scoped = { writablePaths: ['web/app/plan-a', '.github'] };
    // 대소문자를 구분하는 볼륨에서 WEB/app/Plan-A는 다른 폴더다. 구분하지 않는 볼륨에서는 같은 폴더지만, 막아도 잃는 것이 없다
    for (const file of ['WEB/app/Plan-A/x.md', 'web/app/PLAN-A/x.md', 'web/app/plan-a\u200c/x.md', 'web/app/plan-\u00e1/x.md', 'web/app/plan-a./x.md']) {
      expect(decide(file, scoped), file).toBe('deny');
      expect(isWithinScope(file, 'web/app/plan-a'), file).toBe(false);
      expect(isInScope(file, ['web/app/plan-a']), file).toBe(false);
    }
    // 점 접두사 규칙(`.env`가 `.env.local`을 덮는 것)은 보호 경로의 것이다. 범위에 쓰면 `.github`이 `.github.bak`까지 연다
    expect(decide('.github/workflows/ci.yml', scoped)).toBe('allow');
    expect(decide('.github.bak/x.yml', scoped)).toBe('deny');
    expect(isProtectedPath('.env.local', '.env')).toBe(true);
    // 역슬래시가 든 경로는 범위 안으로 보지 않는다
    expect(decide('web/app/plan-a\\..\\..\\x.md', scoped)).toBe('deny');
  });

  it('꼴을 맞출 수 없으면 보호 경로는 보호되는 쪽으로, 쓰기 범위는 범위 밖으로 본다', () => {
    expect(isProtectedPath('../x', 'infra')).toBe(true);
    expect(isProtectedPath('web/x.ts', '../outside')).toBe(true);
    expect(isWithinScope('../x', 'web')).toBe(false);
    expect(isWithinScope('web/x.ts', '../outside')).toBe(false);
    expect(isWithinScope('web/x.ts', '/abs')).toBe(false);
  });

  it('프로젝트 밖으로 나가는 경로는 범위를 따지기 전에 거절한다', () => {
    expect(checkToolPolicy('write_file', { path: '../outside.txt' }, protectedPolicy, undefined)).toMatchObject({ decision: 'deny', reason: 'path leaves the project' });
    expect(checkToolPolicy('write_file', { path: '/etc/hosts' }, { writablePaths: ['web'] }, undefined)).toMatchObject({ decision: 'deny', reason: 'path leaves the project' });
  });

  it('규칙 쪽의 표기가 달라도 같은 범위다', () => {
    expect(isProtectedPath('infra/main.tf', './Infra/')).toBe(true);
    expect(isProtectedPath('.github/workflows/ci.yml', '.github\\workflows')).toBe(true);
    expect(isProtectedPath('web/x.ts', '.')).toBe(true);
    expect(isWithinScope('web/app/x.ts', './web/app/')).toBe(true);
    expect(isWithinScope('web/app/x.ts', 'web\\app')).toBe(true);
    expect(isWithinScope('anything/x.ts', '.')).toBe(true);
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
