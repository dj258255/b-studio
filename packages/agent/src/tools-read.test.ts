import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Sandbox } from '@b-studio/sandbox';
import type { LoadedProject } from '@b-studio/spec';
import { describe, expect, it } from 'vitest';
import { buildTools, executeTool, LOCAL_TOOLS, type ToolContext } from './tools';
import { Workspace } from './workspace';

const project = { root: '/tmp/none', managed: [['api', { source: 'managed', template: 'spring-boot', path: 'api', port: 8080, preview: 'openapi' }]] } as unknown as LoadedProject;

async function setup(files: Record<string, string>, extra: Partial<ToolContext> = {}): Promise<{ root: string; context: ToolContext }> {
  const root = await mkdtemp(path.join(tmpdir(), 'tools-read-'));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  }
  const context: ToolContext = { project, workspace: new Workspace(root), sandbox: { redact: (text: string) => text.replaceAll('s3cret', '***') } as unknown as Sandbox, fetcher: async () => ({}), ...extra };
  return { root, context };
}

const numbered = (count: number) => Array.from({ length: count }, (_, index) => `line ${index + 1}`).join('\n');

describe('읽기 도구: 줄 범위(read_lines)와 검색(search_files) (트러블슈팅 127)', () => {
  it('두 도구가 목록에 있고 샌드박스 없이 도는 도구로 분류돼 있다', () => {
    const names = buildTools(project).map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(['read_lines', 'search_files']));
    expect(LOCAL_TOOLS.has('read_lines') && LOCAL_TOOLS.has('search_files')).toBe(true);
  });

  it('read_file이 긴 파일을 자르면 몇 줄짜리인지와 read_lines로 읽으라는 안내를 붙인다', async () => {
    const { context } = await setup({ 'big.txt': numbered(3_000) });
    const outcome = await executeTool('read_file', { path: 'big.txt' }, context);
    expect(outcome.content).toContain('파일은 3000줄입니다. 생략된 부분은 read_lines로 줄 범위를 읽으세요');
    // 자르지 않은 파일에는 안내가 없다
    const small = await setup({ 'small.txt': numbered(10) });
    expect((await executeTool('read_file', { path: 'small.txt' }, small.context)).content).toBe(numbered(10));
  });

  it('read_lines는 고른 줄만, 어느 줄인지 머리줄과 함께 돌려준다', async () => {
    const { context } = await setup({ 'big.txt': numbered(3_000) });
    const outcome = await executeTool('read_lines', { path: 'big.txt', start_line: 1500, end_line: 1502 }, context);
    expect(outcome).toMatchObject({ ok: true });
    expect(outcome.content).toBe('[big.txt 1500-1502줄 / 전체 3000줄]\nline 1500\nline 1501\nline 1502');
  });

  it('read_lines는 범위를 파일 안으로 맞추고 한 번에 400줄까지만 돌려준다', async () => {
    const { context } = await setup({ 'big.txt': numbered(3_000), 'short.txt': numbered(5) });
    const capped = await executeTool('read_lines', { path: 'big.txt', start_line: 100, end_line: 2_000 }, context);
    expect(capped.content.split('\n')[0]).toBe('[big.txt 100-499줄 / 전체 3000줄]');
    expect(capped.content.split('\n')).toHaveLength(401);
    const beyond = await executeTool('read_lines', { path: 'short.txt', start_line: 4, end_line: 99 }, context);
    expect(beyond.content).toBe('[short.txt 4-5줄 / 전체 5줄]\nline 4\nline 5');
    // 끝이 시작보다 앞이면 시작 줄 하나를 돌려준다(빈 결과를 돌려주지 않는다)
    const reversed = await executeTool('read_lines', { path: 'short.txt', start_line: 3, end_line: 1 }, context);
    expect(reversed.content).toBe('[short.txt 3-3줄 / 전체 5줄]\nline 3');
  });

  it('read_lines도 시크릿 값을 가리고, 없는 파일은 실패로 돌려준다', async () => {
    const { context } = await setup({ 'config.txt': 'token=s3cret\nname=shop' });
    expect((await executeTool('read_lines', { path: 'config.txt', start_line: 1, end_line: 2 }, context)).content).toContain('token=***');
    expect(await executeTool('read_lines', { path: 'missing.txt', start_line: 1, end_line: 2 }, context)).toMatchObject({ ok: false });
  });

  it('search_files는 낱말 중 하나라도 든 줄을 경로:줄: 내용으로 돌려준다', async () => {
    const { context } = await setup({
      'api/src/PaymentConfirmController.java': 'package pay;\nclass PaymentConfirmController {\n  // POST /payments/confirm\n}\n',
      'api/src/Order.java': 'class Order {}\n',
      'web/lib/pay.ts': 'export const url = "/payments/confirm";\n',
    });
    const outcome = await executeTool('search_files', { terms: ['payments/confirm', 'class PaymentConfirm'], path: '.', ignore_case: false, max_results: 50 }, context);
    expect(outcome.content.split('\n')).toEqual([
      'api/src/PaymentConfirmController.java:2: class PaymentConfirmController {',
      'api/src/PaymentConfirmController.java:3:   // POST /payments/confirm',
      'web/lib/pay.ts:1: export const url = "/payments/confirm";',
    ]);
  });

  it('낱말은 글자 그대로 찾는다 — 정규식 기호를 해석하지 않는다', async () => {
    const { context } = await setup({ 'a.txt': 'price (a+b)*\nprice aab\n' });
    const outcome = await executeTool('search_files', { terms: ['(a+b)*'], path: '.', ignore_case: false, max_results: 10 }, context);
    expect(outcome.content).toBe('a.txt:1: price (a+b)*');
  });

  it('대소문자를 무시할 수 있고, 폴더나 파일 하나로 좁힐 수 있다', async () => {
    const { context } = await setup({ 'api/A.java': 'class OrderService {}\n', 'web/b.ts': 'const orderservice = 1;\n' });
    const all = await executeTool('search_files', { terms: ['orderservice'], path: '.', ignore_case: true, max_results: 10 }, context);
    expect(all.content.split('\n')).toHaveLength(2);
    const exact = await executeTool('search_files', { terms: ['orderservice'], path: '.', ignore_case: false, max_results: 10 }, context);
    expect(exact.content).toBe('web/b.ts:1: const orderservice = 1;');
    const narrowed = await executeTool('search_files', { terms: ['orderservice'], path: 'api', ignore_case: true, max_results: 10 }, context);
    expect(narrowed.content).toBe('api/A.java:1: class OrderService {}');
    const single = await executeTool('search_files', { terms: ['orderservice'], path: 'web/b.ts', ignore_case: false, max_results: 10 }, context);
    expect(single.content).toBe('web/b.ts:1: const orderservice = 1;');
  });

  it('생성물 폴더·.git·비밀 파일·이진 파일은 찾지 않고, 프로젝트 밖으로 가는 링크를 따라가지 않는다', async () => {
    const { root, context } = await setup({
      'src/a.ts': 'const needle = 1;\n',
      'node_modules/pkg/index.js': 'needle\n',
      '.git/config': 'needle\n',
      'build/out.js': 'needle\n',
      '.env': 'TOKEN=needle\n',
      'bin/blob.bin': 'needle\u0000\u0000binary',
    });
    const outside = await mkdtemp(path.join(tmpdir(), 'tools-read-outside-'));
    await writeFile(path.join(outside, 'leak.txt'), 'needle outside\n');
    await symlink(outside, path.join(root, 'linked'));
    await symlink(path.join(outside, 'leak.txt'), path.join(root, 'src', 'leak.txt'));
    const outcome = await executeTool('search_files', { terms: ['needle'], path: '.', ignore_case: false, max_results: 50 }, context);
    expect(outcome.content).toBe('src/a.ts:1: const needle = 1;');
    // 프로젝트 밖 경로를 직접 가리키면 거절한다
    expect(await executeTool('search_files', { terms: ['needle'], path: '../', ignore_case: false, max_results: 5 }, context)).toMatchObject({ ok: false });
  });

  it('결과가 상한을 넘으면 거기까지만 돌려주고 더 있다고 알린다. 긴 줄은 자른다', async () => {
    const { context } = await setup({ 'many.txt': Array.from({ length: 30 }, (_, index) => `hit ${index}`).join('\n'), 'long.txt': `hit ${'x'.repeat(500)}` });
    const outcome = await executeTool('search_files', { terms: ['hit'], path: 'many.txt', ignore_case: false, max_results: 5 }, context);
    const lines = outcome.content.split('\n');
    expect(lines).toHaveLength(6);
    expect(lines[5]).toContain('결과가 더 있습니다');
    const long = await executeTool('search_files', { terms: ['hit'], path: 'long.txt', ignore_case: false, max_results: 5 }, context);
    expect(long.content.length).toBeLessThan(260);
    expect(long.content.endsWith('…')).toBe(true);
  });

  it('찾은 것이 없으면 몇 개 파일을 봤는지 알리고, 낱말이 비었으면 실패한다. 결과의 시크릿 값은 가린다', async () => {
    const { context } = await setup({ 'a.txt': 'hello\n', 'b.txt': 'key=s3cret\n' });
    expect((await executeTool('search_files', { terms: ['zzz'], path: '.', ignore_case: false, max_results: 5 }, context)).content).toBe('(no matches in 2 files)');
    expect(await executeTool('search_files', { terms: [''], path: '.', ignore_case: false, max_results: 5 }, context)).toMatchObject({ ok: false });
    expect((await executeTool('search_files', { terms: ['key='], path: '.', ignore_case: false, max_results: 5 }, context)).content).toBe('b.txt:1: key=***');
  });

  it('시크릿 값의 일부로 찾아도 걸리지 않는다 — 찾았다는 사실로 값을 알아낼 수 없다', async () => {
    const { context } = await setup({ 'config.txt': 'token=s3cret\n' });
    const search = (term: string) => executeTool('search_files', { terms: [term], path: '.', ignore_case: false, max_results: 5 }, context);
    // 값 전체, 앞부분, 한 글자씩 넓혀 가는 추측이 모두 "없음"이다
    for (const guess of ['s3cret', 's3c', 's3', '3', 'token=s', 'token=s3cret']) expect((await search(guess)).content, guess).toBe('(no matches in 1 files)');
    // 가린 뒤의 글로는 찾을 수 있다(값이 아니라 자리만 드러난다)
    expect((await search('token=')).content).toBe('config.txt:1: token=***');
  });

  it('여러 줄에 걸친 시크릿 값과 200자를 넘는 줄의 시크릿 값도 가려진다(가린 뒤에 줄을 나누고 자른다)', async () => {
    const multiline = 'BEGIN\nline-a\nline-b\nEND';
    const long = `sk-${'a'.repeat(400)}`;
    const redact = (text: string) => text.replaceAll(multiline, '***').replaceAll(long, '***');
    const { context } = await setup({ 'key.pem.txt': `key:\n${multiline}\n`, 'long.txt': `value=${long} tail\n` }, { sandbox: { redact } as unknown as Sandbox });
    const search = (term: string) => executeTool('search_files', { terms: [term], path: '.', ignore_case: false, max_results: 5 }, context);
    expect((await search('line-a')).content).toBe('(no matches in 2 files)');
    const hit = (await search('value=')).content;
    expect(hit).toBe('long.txt:1: value=*** tail');
    expect(hit).not.toContain('sk-aaa');
  });

  it('상한을 넘는 파일은 읽기 전에 건너뛰고(통째로 읽어 들이지 않는다), 링크인 대상은 거절한다', async () => {
    const { root, context } = await setup({ 'small.txt': 'needle\n', 'huge.txt': `needle\n${'x'.repeat(300 * 1024)}` });
    await symlink('small.txt', path.join(root, 'link.txt'));
    const all = await executeTool('search_files', { terms: ['needle'], path: '.', ignore_case: false, max_results: 5 }, context);
    expect(all.content).toBe('small.txt:1: needle');
    expect((await executeTool('search_files', { terms: ['needle'], path: 'huge.txt', ignore_case: false, max_results: 5 }, context)).content).toBe('(no matches in 0 files)');
    // 링크를 직접 가리키면 따라가지 않는다
    const linked = await executeTool('search_files', { terms: ['needle'], path: 'link.txt', ignore_case: false, max_results: 5 }, context);
    expect(linked.content).not.toContain('needle');
  });

  it('질문 모드(읽기 전용)에서도 쓸 수 있다', async () => {
    const { context } = await setup({ 'a.txt': numbered(3) }, { readOnly: true });
    expect(await executeTool('read_lines', { path: 'a.txt', start_line: 2, end_line: 2 }, context)).toMatchObject({ ok: true });
    expect(await executeTool('search_files', { terms: ['line 3'], path: '.', ignore_case: false, max_results: 5 }, context)).toMatchObject({ ok: true, content: 'a.txt:3: line 3' });
  });
});
