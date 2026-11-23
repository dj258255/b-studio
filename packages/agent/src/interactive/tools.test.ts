import { lstatSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTools, globToRegExp, MAX_RESULTS, type InteractiveTools } from './tools';

let base: string;
let work: string;
let outside: string;
let tools: InteractiveTools;

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), 'interactive-tools-'));
  work = path.join(base, 'work');
  outside = path.join(base, 'outside');
  await mkdir(work);
  await mkdir(outside);
  await writeFile(path.join(outside, 'secret.txt'), '비밀\n');
  tools = createTools(work);
});
afterEach(() => rm(base, { recursive: true, force: true }));

const run = (name: string, input: Record<string, unknown>) => tools.execute(name, input);

describe('도구 기본 동작', () => {
  it('Write → Read → Edit', async () => {
    expect((await run('Write', { file_path: 'app/a.txt', content: '하나\n둘\n하나\n' })).isError).toBe(false);
    expect(await readFile(path.join(work, 'app/a.txt'), 'utf8')).toBe('하나\n둘\n하나\n');
    expect((await run('Read', { file_path: path.join(work, 'app/a.txt') })).text).toBe('1\t하나\n2\t둘\n3\t하나\n4\t');
    // 여러 곳이면 거절, replace_all이면 바꾼다
    expect((await run('Edit', { file_path: 'app/a.txt', old_string: '하나', new_string: 'X' })).isError).toBe(true);
    expect((await run('Edit', { file_path: 'app/a.txt', old_string: '둘', new_string: '2' })).isError).toBe(false);
    expect((await run('Edit', { file_path: 'app/a.txt', old_string: '하나', new_string: 'X', replace_all: true })).isError).toBe(false);
    expect(await readFile(path.join(work, 'app/a.txt'), 'utf8')).toBe('X\n2\nX\n');
    expect((await run('Edit', { file_path: 'app/none.txt', old_string: 'a', new_string: 'b' })).isError).toBe(true);
  });

  it('훅에 알릴 입력은 file_path를 작업 폴더 기준 절대 경로로 푼다', () => {
    expect(tools.hookInput('Write', { file_path: 'app/a.txt', content: 'x' })).toEqual({ file_path: path.join(work, 'app/a.txt'), content: 'x' });
    expect(tools.hookInput('Grep', { pattern: 'x' })).toEqual({ pattern: 'x' });
  });

  it('Glob·Grep: 패턴, 하위 폴더 기준, 건너뛴 폴더 알림', async () => {
    await mkdir(path.join(work, 'src/deep'), { recursive: true });
    await mkdir(path.join(work, 'node_modules/x'), { recursive: true });
    await writeFile(path.join(work, 'src/a.ts'), 'const hit = 1;\n');
    await writeFile(path.join(work, 'src/deep/b.ts'), 'nothing\nhit again\n');
    await writeFile(path.join(work, 'src/c.md'), 'hit\n');
    await writeFile(path.join(work, 'node_modules/x/d.ts'), 'hit\n');
    const glob = await run('Glob', { pattern: '**/*.ts' });
    expect(glob.text.split('\n').filter((line) => line.endsWith('.ts'))).toEqual(['src/a.ts', 'src/deep/b.ts']);
    expect(glob.text).toContain('건너뛴 폴더');
    expect((await run('Glob', { pattern: '*.ts', path: 'src' })).text).toContain('src/a.ts');
    const grep = await run('Grep', { pattern: 'hit', glob: '*.ts' });
    expect(grep.text.split('\n').filter((line) => line.includes(':'))).toEqual(expect.arrayContaining(['src/a.ts:1:const hit = 1;', 'src/deep/b.ts:2:hit again']));
    expect(grep.text).not.toContain('c.md');
    expect(grep.text).not.toContain('node_modules/x');
  });

  it('globToRegExp: **, *, ?, {a,b}', () => {
    expect(globToRegExp('src/**/*.{ts,tsx}').test('src/a/b/c.tsx')).toBe(true);
    expect(globToRegExp('src/**/*.ts').test('src/c.ts')).toBe(true);
    expect(globToRegExp('*.ts').test('src/c.ts')).toBe(false);
    expect(globToRegExp('a?.ts').test('ab.ts')).toBe(true);
    expect(globToRegExp('a.ts').test('aXts')).toBe(false);
  });

  it('결과가 상한을 넘으면 truncated로 알린다(조용히 자르지 않는다)', async () => {
    await mkdir(path.join(work, 'many'));
    await Promise.all(Array.from({ length: MAX_RESULTS + 5 }, (_, index) => writeFile(path.join(work, 'many', `f${index}.txt`), 'x\n')));
    const glob = await run('Glob', { pattern: 'many/*.txt' });
    expect(glob.text).toContain('truncated');
    expect(glob.text.split('\n').filter((line) => line.startsWith('many/'))).toHaveLength(MAX_RESULTS);
    expect((await run('Grep', { pattern: 'x' })).text).toContain('truncated');
  });
});

describe('작업 폴더 가둠(막는 검사)', () => {
  it('.. 으로 나가는 경로는 읽기·쓰기·고치기 모두 거절하고 밖에 아무것도 만들지 않는다', async () => {
    for (const name of ['Read', 'Write', 'Edit']) {
      const result = await run(name, { file_path: '../outside/secret.txt', content: 'x', old_string: '비밀', new_string: 'x' });
      expect(result.isError, name).toBe(true);
    }
    expect((await run('Write', { file_path: 'a/../../outside/new.txt', content: 'x' })).isError).toBe(true);
    expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('비밀\n');
    expect(() => lstatSync(path.join(outside, 'new.txt'))).toThrow();
  });

  it('밖의 절대 경로는 거절한다(작업 폴더 이름을 앞에 둔 형제 폴더도)', async () => {
    expect((await run('Read', { file_path: path.join(outside, 'secret.txt') })).isError).toBe(true);
    expect((await run('Write', { file_path: path.join(outside, 'new.txt'), content: 'x' })).isError).toBe(true);
    await mkdir(`${work}-sibling`);
    expect((await run('Write', { file_path: `${work}-sibling/x.txt`, content: 'x' })).isError).toBe(true);
    expect(() => lstatSync(`${work}-sibling/x.txt`)).toThrow();
  });

  it('밖을 가리키는 링크 파일은 읽기·쓰기·고치기 모두 거절한다', async () => {
    await symlink(path.join(outside, 'secret.txt'), path.join(work, 'link.txt'));
    expect((await run('Read', { file_path: 'link.txt' })).isError).toBe(true);
    expect((await run('Write', { file_path: 'link.txt', content: '덮음' })).isError).toBe(true);
    expect((await run('Edit', { file_path: 'link.txt', old_string: '비밀', new_string: '덮음' })).isError).toBe(true);
    expect(await readFile(path.join(outside, 'secret.txt'), 'utf8')).toBe('비밀\n');
  });

  it('밖을 가리키는 링크 폴더를 지나는 경로는 읽기·새 파일 쓰기 모두 거절한다', async () => {
    await symlink(outside, path.join(work, 'dirlink'));
    expect((await run('Read', { file_path: 'dirlink/secret.txt' })).isError).toBe(true);
    expect((await run('Write', { file_path: 'dirlink/new.txt', content: 'x' })).isError).toBe(true);
    expect((await run('Write', { file_path: 'dirlink/sub/new.txt', content: 'x' })).isError).toBe(true);
    expect(() => lstatSync(path.join(outside, 'new.txt'))).toThrow();
    expect(() => lstatSync(path.join(outside, 'sub'))).toThrow();
  });

  it('작업 폴더 안을 가리키는 폴더 링크를 지나는 경로도 읽기·쓰기 모두 거절한다(서버가 본 경로와 실제 경로가 갈리지 않게)', async () => {
    await mkdir(path.join(work, 'tests', 'acceptance'), { recursive: true });
    await writeFile(path.join(work, 'tests', 'acceptance', 'spec.txt'), '보호');
    await mkdir(path.join(work, 'web'), { recursive: true });
    await symlink(path.join(work, 'tests', 'acceptance'), path.join(work, 'web', 'notes'));
    expect((await run('Write', { file_path: 'web/notes/new.txt', content: 'x' })).isError).toBe(true);
    expect((await run('Edit', { file_path: 'web/notes/spec.txt', old_string: '보호', new_string: '바꿈' })).isError).toBe(true);
    expect((await run('Read', { file_path: 'web/notes/spec.txt' })).isError).toBe(true);
    expect(() => lstatSync(path.join(work, 'tests', 'acceptance', 'new.txt'))).toThrow();
    expect(await readFile(path.join(work, 'tests', 'acceptance', 'spec.txt'), 'utf8')).toBe('보호');
    // 링크가 없는 같은 곳은 그대로 쓸 수 있다
    expect((await run('Write', { file_path: 'web/plain.txt', content: 'y' })).isError).toBe(false);
  });

  it('쓰기는 마지막 조각이 링크면 안쪽을 가리켜도 거절하고, 깨진 링크도 거절한다', async () => {
    await writeFile(path.join(work, 'real.txt'), '원본');
    await symlink(path.join(work, 'real.txt'), path.join(work, 'inner-link.txt'));
    expect((await run('Write', { file_path: 'inner-link.txt', content: '덮음' })).isError).toBe(true);
    expect(await readFile(path.join(work, 'real.txt'), 'utf8')).toBe('원본');
    // 읽기도 안쪽을 가리키는 링크를 따라가지 않는다(서버가 본 경로와 읽는 파일이 갈리면 숨긴 경로를 링크로 비켜 읽을 수 있다)
    expect((await run('Read', { file_path: 'inner-link.txt' })).isError).toBe(true);
    await symlink(path.join(outside, 'not-there.txt'), path.join(work, 'dangling.txt'));
    expect((await run('Write', { file_path: 'dangling.txt', content: 'x' })).isError).toBe(true);
    expect((await run('Read', { file_path: 'dangling.txt' })).isError).toBe(true);
    expect(() => lstatSync(path.join(outside, 'not-there.txt'))).toThrow();
  });

  it('Glob·Grep은 링크 폴더·링크 파일로 내려가지 않고 밖의 파일을 돌려주지 않으며, path가 밖이면 거절한다', async () => {
    await symlink(outside, path.join(work, 'dirlink'));
    await symlink(path.join(outside, 'secret.txt'), path.join(work, 'filelink.txt'));
    await writeFile(path.join(work, 'own.txt'), '비밀 아님\n');
    const glob = await run('Glob', { pattern: '**/*' });
    expect(glob.text).toContain('own.txt');
    expect(glob.text).not.toContain('secret');
    expect(glob.text).not.toContain('filelink');
    expect((await run('Grep', { pattern: '비밀' })).text).not.toContain('secret');
    expect((await run('Grep', { pattern: '비밀$' })).text).toContain('맞는 줄 없음');
    expect((await run('Glob', { pattern: '*', path: outside })).isError).toBe(true);
    expect((await run('Glob', { pattern: '*', path: 'dirlink' })).isError).toBe(true);
    expect((await run('Grep', { pattern: '.', path: '..' })).isError).toBe(true);
  });

  it('입력이 이상하면(빈 경로, NUL, 칸 없음) 거절한다', async () => {
    expect((await run('Read', { file_path: '' })).isError).toBe(true);
    expect((await run('Read', { file_path: 'a\0b' })).isError).toBe(true);
    expect((await run('Write', {})).isError).toBe(true);
    expect((await run('Nope', {})).isError).toBe(true);
  });
});
