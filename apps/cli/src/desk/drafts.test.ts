import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DRAFT_FILE, MAX_DRAFT_BYTES, MAX_DRAFT_FILE_BYTES, MAX_DRAFTS, createDraftStore, loadDrafts, saveDrafts } from './drafts';

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'desk-drafts-'));
  file = path.join(dir, DRAFT_FILE);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(content: unknown, mode = 0o600) {
  writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  chmodSync(file, mode);
}

describe('쓰던 글 임시 저장 파일', () => {
  it('저장한 글을 그대로 읽어 오고, 파일은 600이다', () => {
    const store = createDraftStore(dir);
    store.save(new Map([['prompt:p1', '로그인 고쳐 줘'], ['plan:p1', '주문 나누기']]));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    const loaded = store.load();
    expect(loaded.warning).toBeUndefined();
    expect([...loaded.drafts]).toEqual([['prompt:p1', '로그인 고쳐 줘'], ['plan:p1', '주문 나누기']]);
    // 임시 파일이 남지 않는다
    expect(readdirSync(dir)).toEqual([DRAFT_FILE]);
  });

  it('umask가 느슨해도 600으로 쓴다', () => {
    const before = process.umask(0);
    try {
      saveDrafts(dir, new Map([['k', 'v']]));
    } finally {
      process.umask(before);
    }
    expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it('없는 파일은 경고 없이 빈 목록이다', () => {
    expect(loadDrafts(file)).toEqual({ drafts: new Map() });
  });

  it('남길 글이 없으면 파일을 지운다', () => {
    saveDrafts(dir, new Map([['k', 'v']]));
    saveDrafts(dir, new Map());
    expect(readdirSync(dir)).toEqual([]);
    // 이미 없어도 던지지 않는다
    saveDrafts(dir, new Map());
  });

  it('링크는 600의 올바른 파일을 가리켜도 읽지 않고 알린다', () => {
    const real = path.join(dir, 'real.json');
    writeFileSync(real, JSON.stringify({ version: 1, drafts: { k: '몰래' } }));
    chmodSync(real, 0o600);
    symlinkSync(real, file);
    const loaded = loadDrafts(file);
    expect(loaded.drafts.size).toBe(0);
    expect(loaded.warning).toMatch(/링크/);
  });

  it('저장은 링크를 따라가 쓰지 않고 링크 자체를 갈아 끼운다', () => {
    const target = path.join(dir, 'target.txt');
    writeFileSync(target, '그대로');
    symlinkSync(target, file);
    saveDrafts(dir, new Map([['k', 'v']]));
    expect(readFileSync(target, 'utf8')).toBe('그대로');
    expect(loadDrafts(file).drafts.get('k')).toBe('v');
  });

  it('FIFO면 열다가 멈추지 않고 알린다', () => {
    execFileSync('mkfifo', ['-m', '600', file]);
    // 열기가 멈추면 이벤트 루프째 막힌다. 자식 프로세스에서 상한을 두고 돌린다
    const loader = fileURLToPath(import.meta.resolve('tsx'));
    const script = `import { loadDrafts } from ${JSON.stringify(fileURLToPath(new URL('./drafts.ts', import.meta.url)))};
const result = loadDrafts(${JSON.stringify(file)}); console.log(result.warning ?? '읽음');`;
    const out = execFileSync(process.execPath, ['--import', loader, '--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000 });
    expect(out).toMatch(/일반 파일이 아닙니다/);
  });

  it('그룹·다른 사용자 권한이 있으면 읽지 않고 알린다(죽지 않는다)', () => {
    for (const mode of [0o644, 0o640, 0o604]) {
      write({ version: 1, drafts: { k: 'v' } }, mode);
      const loaded = loadDrafts(file);
      expect(loaded.drafts.size).toBe(0);
      expect(loaded.warning).toMatch(/권한이 600이 아닙니다/);
    }
  });

  it('깨진 JSON이나 꼴이 다른 파일은 알리고 비운다', () => {
    write('{ 깨짐');
    expect(loadDrafts(file).warning).toMatch(/JSON이 아닙니다/);
    write(JSON.stringify({ drafts: ['a'] }));
    expect(loadDrafts(file).warning).toMatch(/꼴이 맞지 않습니다/);
    write('null');
    expect(loadDrafts(file).warning).toMatch(/꼴이 맞지 않습니다/);
  });

  it('글이 아닌 값·빈 글·너무 긴 이름은 그것만 버린다', () => {
    write({ version: 1, drafts: { ok: '남김', num: 3, empty: '', ['x'.repeat(300)]: 'v' } });
    expect([...loadDrafts(file).drafts]).toEqual([['ok', '남김']]);
  });

  it('글 하나가 상한을 넘으면 저장하지 않는다(경계는 바이트로 센다)', () => {
    const exact = '가'.repeat(Math.floor(MAX_DRAFT_BYTES / 3));
    expect(Buffer.byteLength(exact)).toBeLessThanOrEqual(MAX_DRAFT_BYTES);
    saveDrafts(dir, new Map([['fits', exact], ['big', '가'.repeat(Math.floor(MAX_DRAFT_BYTES / 3) + 1)]]));
    expect([...loadDrafts(file).drafts.keys()]).toEqual(['fits']);
  });

  it('읽을 때도 상한을 넘는 글은 버린다', () => {
    write({ version: 1, drafts: { fits: 'a', big: 'a'.repeat(MAX_DRAFT_BYTES + 1) } });
    expect([...loadDrafts(file).drafts.keys()]).toEqual(['fits']);
  });

  it('파일이 상한보다 크면 읽기 전에 거절한다', () => {
    write(' '.repeat(MAX_DRAFT_FILE_BYTES + 1));
    const loaded = loadDrafts(file);
    expect(loaded.drafts.size).toBe(0);
    expect(loaded.warning).toMatch(/너무 큽니다/);
  });

  it('글이 너무 많으면 오래된 것부터 버린다', () => {
    const many = new Map(Array.from({ length: MAX_DRAFTS + 5 }, (_, index) => [`k${index}`, `v${index}`] as [string, string]));
    saveDrafts(dir, many);
    const keys = [...loadDrafts(file).drafts.keys()];
    expect(keys).toHaveLength(MAX_DRAFTS);
    expect(keys[0]).toBe('k5');
    expect(keys.at(-1)).toBe(`k${MAX_DRAFTS + 4}`);
  });
});
