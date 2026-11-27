import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { LoadedProject } from '@b-studio/spec';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckpointStore } from './checkpoints';
import { reviewChanges, type TestChangeEntry, type WorkflowCheck } from './workflow';

vi.setConfig({ testTimeout: 30_000 });

const execFileAsync = promisify(execFile);

/**
 * 시험을 약하게 만드는 변경(이슈 #1436): 선언하지 않은 일반 시험 파일을 지우거나 건너뛰기 표시를 더하면 리뷰 단계가 돌려보낸다.
 * 앞쪽은 판정(Rust)을 껍데기로 부르는 벡터, 뒤쪽은 실제 git 저장소에서 변경 목록을 읽는 부분이다.
 * 기대값은 파일 시스템 종류(대소문자 구분 여부)에 기대지 않는다.
 */

const project = { spec: { name: 'x' } } as unknown as LoadedProject;

function review(entries: TestChangeEntry[], extra: { allowed?: boolean; incomplete?: string } = {}): WorkflowCheck | undefined {
  return reviewChanges(project, [], [], { entries, ...extra }).find((check) => check.name === 'test-weakening');
}

describe('reviewChanges의 시험 약화 검사', () => {
  it('지운 시험 파일은 실패로 돌려보낸다', () => {
    const check = review([{ status: 'D', path: 'web/cart.test.ts' }]);
    expect(check).toMatchObject({ stage: 'review', ok: false });
    expect(check?.detail).toContain('지운 시험 파일: web/cart.test.ts');
    expect(check?.detail).toContain('확인 선언 변경 허용');
  });

  it('지운 파일이 시험 파일이 아니면 걸리지 않는다', () => {
    expect(review([{ status: 'D', path: 'web/cart.ts' }])).toBeUndefined();
  });

  it('입력이 없으면 검사도 없다(보호 경로·변경 크기는 그대로다)', () => {
    const checks = reviewChanges(project, ['a.ts']);
    expect(checks.map((check) => check.name)).toEqual(['protected-paths']);
  });

  it('이름을 바꿔 옮긴 시험 파일은, 옮긴 곳도 시험 파일이고 건너뛰기를 더하지 않았으면 지운 것이 아니다', () => {
    expect(review([{ status: 'R', from: 'web/cart.test.ts', path: 'web/__tests__/cart.test.ts', added: [] }])).toBeUndefined();
  });

  it('시험이 아닌 이름으로 옮기면 지운 것이다', () => {
    const check = review([{ status: 'R', from: 'web/cart.test.ts', path: 'web/cart.ts.bak', added: [] }]);
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('web/cart.test.ts → web/cart.ts.bak');
  });

  it('실행기가 집지 않는 이름(tests 폴더의 일반 파일, 대소문자만 다른 접미사)으로 옮긴 것도 지운 것이다', () => {
    for (const to of ['web/tests/helper.ts', 'web/CART.TEST.TS']) {
      expect(review([{ status: 'R', from: 'web/cart.test.ts', path: to, added: [] }])?.ok, to).toBe(false);
    }
  });

  it('옮기면서 건너뛰기를 더하면 실패다', () => {
    const check = review([{ status: 'R', from: 'a.test.ts', path: 'b.test.ts', added: ["it.skip('x', () => {})"] }]);
    expect(check?.ok).toBe(false);
  });

  it.each([
    ['a.test.ts', "  it.skip('x', () => {})"],
    ['a.test.ts', "test.skip('x', () => {})"],
    ['a.test.ts', "describe.skip('x', () => {})"],
    ['a.test.ts', "xit('x', () => {})"],
    ['a.test.ts', "xdescribe('x', () => {})"],
    ['a.test.ts', "it.todo('x')"],
    ['OrderTest.java', '  @Disabled'],
    ['OrderTest.kt', '@Ignore("later")'],
    ['test_order.py', "@pytest.mark.skip(reason='x')"],
    ['test_order.py', '    @unittest.skip("x")'],
    ['test_order.py', "    pytest.skip('x')"],
    ['src/lib.rs', '    #[ignore]'],
    ['order_test.go', '\tt.Skip("later")'],
  ])('더해진 줄의 건너뛰기 표시를 잡는다: %s %s', (file, line) => {
    const check = review([{ status: 'M', path: file, added: [line] }]);
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('새로 더한 건너뛰기 표시');
  });

  it('더해진 줄이 아니면(원래 있던 표시만 남았거나 표시 없는 줄만 더했으면) 걸리지 않는다', () => {
    expect(review([{ status: 'M', path: 'a.test.ts', added: ["it('x', () => {})", 'const skip = 1;'] }])).toBeUndefined();
    expect(review([{ status: 'M', path: 'a.test.ts', added: [] }])).toBeUndefined();
  });

  it('새로 만든 시험 파일의 표시도 잡는다. 시험 파일이 아닌 곳의 표시는 잡지 않는다', () => {
    expect(review([{ status: 'A', path: 'new.test.ts', added: ["xit('x', f)"] }])?.ok).toBe(false);
    expect(review([{ status: 'M', path: 'src/app.ts', added: ["it.skip('x')"] }])).toBeUndefined();
  });

  it('대소문자·폴더 꼴이 다른 시험 파일 이름도 시험 파일로 본다(넓게 맞춘다)', () => {
    for (const file of ['A.TEST.TS', 'web/__tests__/x.ts', 'src/test/java/Helper.java', 'pkg/x_test.go', 'tests/test_a.py']) {
      expect(review([{ status: 'D', path: file }])?.ok, file).toBe(false);
    }
  });

  it('이름이 정규화 꼴이 달라도(NFD) 접미사로 시험 파일을 알아본다', () => {
    const nfd = 'é'.normalize('NFD');
    expect(review([{ status: 'D', path: `web/${nfd}.test.ts` }])?.ok).toBe(false);
    expect(review([{ status: 'D', path: `web/${nfd}.test.ts`.normalize('NFC') }])?.ok).toBe(false);
  });

  it('줄을 받지 못한 시험 파일 변경은 통과가 아니라 확인하지 못함이다', () => {
    const check = review([{ status: 'M', path: 'a.test.ts' }]);
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('확인하지 못함');
  });

  it('끝까지 읽지 못했으면 실패다', () => {
    const check = review([], { incomplete: '시험 파일이 너무 많습니다' });
    expect(check?.ok).toBe(false);
    expect(check?.detail).toContain('끝까지 확인하지 못했습니다');
  });

  it('허용이 있으면 통과하고 받아들인 것을 남긴다. 읽지 못했어도 허용이 있으면 막지 않는다', () => {
    const allowed = review([{ status: 'D', path: 'a.test.ts' }], { allowed: true });
    expect(allowed).toMatchObject({ ok: true });
    expect(allowed?.detail).toContain('a.test.ts');
    expect(review([], { allowed: true, incomplete: '실패' })).toBeUndefined();
    expect(review([{ status: 'D', path: 'a.ts' }], { allowed: true })).toBeUndefined();
  });

  it('입력의 모양이 어긋나면 던진다', () => {
    expect(() => reviewChanges(project, [], [], { entries: [{ status: '', path: 'a.test.ts' }] })).toThrow();
  });
});

describe('작업 복사본의 변경 목록(CheckpointStore.pendingTestChanges)', () => {
  let root: string;
  const saved = { global: process.env.GIT_CONFIG_GLOBAL, nosystem: process.env.GIT_CONFIG_NOSYSTEM };

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'test-weakening-'));
    const globalConfig = path.join(root, '..', `${path.basename(root)}.gitconfig`);
    await writeFile(globalConfig, '');
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    process.env.GIT_CONFIG_NOSYSTEM = '1';
  });

  afterEach(async () => {
    for (const [key, value] of [
      ['GIT_CONFIG_GLOBAL', saved.global],
      ['GIT_CONFIG_NOSYSTEM', saved.nosystem],
    ] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  const write = async (file: string, content: string) => {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), content);
  };
  const BODY = ['import { it } from "vitest";', "it('a', () => {});", "it.skip('old', () => {});", 'const keep = 1;', ''].join('\n');

  async function started(files: Record<string, string> = {}): Promise<CheckpointStore> {
    await write('web/cart.test.ts', BODY);
    await write('web/cart.ts', 'export const cart = 1;\n');
    for (const [file, content] of Object.entries(files)) await write(file, content);
    const store = new CheckpointStore(root);
    await store.init();
    return store;
  }

  const byPath = (entries: TestChangeEntry[], file: string) => entries.find((entry) => entry.path === file);

  it('아무것도 바뀌지 않았으면 비어 있다', async () => {
    expect(await (await started()).pendingTestChanges()).toEqual([]);
  });

  it('지운 시험 파일을 D로 알린다. 셸로 지운 것도 같다(작업 복사본의 차이만 본다)', async () => {
    const store = await started();
    await rm(path.join(root, 'web/cart.test.ts'));
    const entries = await store.pendingTestChanges();
    expect(entries).toEqual([{ status: 'D', path: 'web/cart.test.ts' }]);
    expect(review(entries)?.ok).toBe(false);
  });

  it('이름을 바꿔 옮긴 시험 파일은 R로 알리고, 시험 파일 사이의 이동은 걸리지 않는다', async () => {
    const store = await started();
    await mkdir(path.join(root, 'web/__tests__'), { recursive: true });
    await rename(path.join(root, 'web/cart.test.ts'), path.join(root, 'web/__tests__/cart.test.ts'));
    const entries = await store.pendingTestChanges();
    expect(entries).toEqual([{ status: 'R', from: 'web/cart.test.ts', path: 'web/__tests__/cart.test.ts', added: [] }]);
    expect(review(entries)).toBeUndefined();
  });

  it('시험이 아닌 이름으로 옮기면(a.test.ts → a.ts.bak) 지운 것으로 걸린다', async () => {
    const store = await started();
    await rename(path.join(root, 'web/cart.test.ts'), path.join(root, 'web/cart.ts.bak'));
    const entries = await store.pendingTestChanges();
    // 시험이 아닌 이름의 파일은 줄을 읽지 않는다
    expect(entries).toEqual([{ status: 'R', from: 'web/cart.test.ts', path: 'web/cart.ts.bak' }]);
    expect(review(entries)?.detail).toContain('web/cart.test.ts → web/cart.ts.bak');
  });

  it('옮기면서 조금 고치고(내용이 달라져도) 건너뛰기를 더하면 걸린다', async () => {
    const store = await started();
    await rm(path.join(root, 'web/cart.test.ts'));
    await write('web/cart2.test.ts', `${BODY}it.skip('new', () => {});\n`);
    const entries = await store.pendingTestChanges();
    const moved = byPath(entries, 'web/cart2.test.ts');
    expect(moved).toMatchObject({ status: 'R', from: 'web/cart.test.ts' });
    // 원래 있던 skip 줄은 더해진 줄이 아니다. 새로 더한 줄만 온다
    expect(moved?.added).toEqual(["it.skip('new', () => {});"]);
    expect(review(entries)?.ok).toBe(false);
  });

  it('원래 있던 건너뛰기는 세지 않고, 새로 더한 줄만 더해진 줄로 읽는다', async () => {
    const store = await started();
    await write('web/cart.test.ts', `${BODY}it.skip('new', () => {});\n`);
    const entries = await store.pendingTestChanges();
    expect(entries).toEqual([{ status: 'M', path: 'web/cart.test.ts', added: ["it.skip('new', () => {});"] }]);
    expect(review(entries)?.ok).toBe(false);

    // 원래 있던 skip 옆의 다른 줄만 바꾸면 걸리지 않는다
    await write('web/cart.test.ts', BODY.replace('const keep = 1;', 'const keep = 2;'));
    const edited = await store.pendingTestChanges();
    expect(edited).toEqual([{ status: 'M', path: 'web/cart.test.ts', added: ['const keep = 2;'] }]);
    expect(review(edited)).toBeUndefined();
  });

  it('새로 만든 시험 파일(추적하지 않던 파일)의 건너뛰기도 읽는다', async () => {
    const store = await started();
    await write('web/new.test.ts', "xit('x', () => {});\n");
    const entries = await store.pendingTestChanges();
    expect(entries).toEqual([{ status: 'A', path: 'web/new.test.ts', added: ["xit('x', () => {});"] }]);
    expect(review(entries)?.ok).toBe(false);
  });

  it('Rust 파일의 #[ignore]와 시험이 아닌 파일의 변경을 가른다', async () => {
    const store = await started({ 'src/lib.rs': '#[test]\nfn a() {}\n' });
    await write('src/lib.rs', '#[test]\n#[ignore]\nfn a() {}\n');
    await write('web/cart.ts', 'export const cart = 2; // it.skip(\n');
    const entries = await store.pendingTestChanges();
    expect(byPath(entries, 'src/lib.rs')).toMatchObject({ status: 'M', added: ['#[ignore]'] });
    // 시험 파일이 아닌 파일은 줄을 읽지 않는다
    expect(byPath(entries, 'web/cart.ts')).toEqual({ status: 'M', path: 'web/cart.ts' });
    expect(review(entries)?.detail).toContain('src/lib.rs(#[ignore]');
    expect(review(entries)?.detail).not.toContain('cart.ts');
  });

  it('공백·따옴표·한글이 든 이름도 그대로 읽는다', async () => {
    const name = 'web/한글 "따옴표" 시험.test.ts';
    const store = await started({ [name]: 'a\n' });
    await rm(path.join(root, name));
    expect(await store.pendingTestChanges()).toEqual([{ status: 'D', path: name }]);
  });

  it('이름이 비슷한 다른 파일이 같이 바뀌어도 줄이 섞이지 않는다', async () => {
    const store = await started({ 'web/a.test.ts': 'x\n', 'web/b.test.ts': 'y\n' });
    await write('web/a.test.ts', "x\nit.skip('a', f);\n");
    await write('web/b.test.ts', 'y\nconst z = 1;\n');
    const entries = await store.pendingTestChanges();
    expect(byPath(entries, 'web/a.test.ts')?.added).toEqual(["it.skip('a', f);"]);
    expect(byPath(entries, 'web/b.test.ts')?.added).toEqual(['const z = 1;']);
  });

  it('읽는 동안 인덱스를 바꾸지 않고 객체도 남기지 않는다(실제 저장소는 그대로)', async () => {
    const store = await started();
    await write('web/new.test.ts', 'x\n');
    const objects = async () => (await execFileAsync('git', ['-C', root, 'count-objects', '-v'])).stdout;
    const before = await objects();
    await store.pendingTestChanges();
    expect(await objects()).toBe(before);
    const { stdout } = await execFileAsync('git', ['-C', root, 'status', '--porcelain=v1']);
    // 아직 스테이징하지 않은 새 파일이 그대로 추적하지 않는 파일이다
    expect(stdout).toContain('?? web/new.test.ts');
  });

  it('바꾼 시험 파일이 너무 많아 끝까지 읽을 수 없으면 던진다(통과로 읽지 않는다)', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 305; i += 1) files[`t/f${i}.test.ts`] = 'x\n';
    const store = await started(files);
    for (let i = 0; i < 305; i += 1) await write(`t/f${i}.test.ts`, 'y\n');
    await expect(store.pendingTestChanges()).rejects.toThrow('너무 많');
  });

  it('저장소를 만든 직후, 같은 크기로 고친 시험 파일도 놓치지 않는다(같은 초에 바뀐 파일)', async () => {
    const store = await started({ 'web/a.test.ts': 'xxxxxxxxxxxx\n' });
    // "it.skip(" 꼴로 크기를 바꾸지 않고 내용만 바꾼다
    await write('web/a.test.ts', 'xit(1,()=>1)\n');
    expect(await store.pendingTestChanges()).toEqual([{ status: 'M', path: 'web/a.test.ts', added: ['xit(1,()=>1)'] }]);
  });

  it('모노레포의 하위 폴더 프로젝트는 프로젝트 기준 경로로 읽고, 폴더 밖 변경은 보지 않는다', async () => {
    const ORDER = ['class OrderTest {', '  void a() {}', '  void b() {}', '  void c() {}', '  void d() {}', '}', ''];
    await write('api/src/OrderTest.java', ORDER.join('\n'));
    await write('other/KeepTest.java', 'class KeepTest {}\n');
    await new CheckpointStore(root).init();
    await execFileAsync('git', ['-C', root, 'config', 'b-studio.subdir', 'api']);
    // 하위 폴더 설정은 저장소 설정에서 읽으므로 새 저장소 객체로 연다
    const store = new CheckpointStore(root);
    await write('api/src/OrderTest.java', [...ORDER.slice(0, 1), '  @Disabled', ...ORDER.slice(1)].join('\n'));
    await rm(path.join(root, 'other/KeepTest.java'));
    await mkdir(path.join(root, 'api/src/legacy'), { recursive: true });
    await rename(path.join(root, 'api/src/OrderTest.java'), path.join(root, 'api/src/legacy/OrderTest.java'));
    const entries = await store.pendingTestChanges();
    expect(entries.map((entry) => entry.path)).toEqual(['src/legacy/OrderTest.java']);
    expect(entries[0]).toMatchObject({ status: 'R', from: 'src/OrderTest.java', added: ['  @Disabled'] });
  });

  it('작업 폴더의 .gitattributes가 시험 파일을 이진(-diff)으로 표시해도 더해진 줄을 읽는다', async () => {
    const store = await started({ 'web/a.test.ts': 'x\n' });
    await write('.gitattributes', '*.test.ts -diff\n');
    await write('web/a.test.ts', "x\nit.skip('a', f);\n");
    const entries = await store.pendingTestChanges();
    expect(byPath(entries, 'web/a.test.ts')?.added).toEqual(["it.skip('a', f);"]);
  });

  it('git 읽기가 실패하면 던진다', async () => {
    const store = await started();
    await rm(path.join(root, '.git/HEAD'));
    await expect(store.pendingTestChanges()).rejects.toThrow();
  });
});
