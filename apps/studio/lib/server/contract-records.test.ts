import { mkdir, mkdtemp, readdir, readFile, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { readContractRecord, saveContractRecord } from './contract-records';

const sha = (digit: string) => digit.repeat(40);
const contracts = new Map<string, unknown>([['api', { paths: { '/api/orders': { get: {} } } }]]);
let stateDir: string;
let outside: string;
const recordsDir = () => path.join(stateDir, '.git/b-studio/contracts');

beforeEach(async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'b-studio-contract-records-'));
  stateDir = path.join(root, 'session');
  outside = path.join(root, 'outside');
  await mkdir(stateDir, { recursive: true });
  await mkdir(outside, { recursive: true });
});

describe('체크포인트 곁의 API 계약 기록 (이슈 #677)', () => {
  it('체크포인트마다 따로 남기고 그대로 읽는다. 남긴 적 없는 체크포인트는 없다고 답한다(빈 계약으로 읽지 않는다)', async () => {
    await saveContractRecord(stateDir, sha('a'), contracts);
    expect(Object.fromEntries((await readContractRecord(stateDir, sha('a')))!)).toEqual(Object.fromEntries(contracts));
    expect(await readContractRecord(stateDir, sha('b'))).toBeUndefined();
    // 세션 기록·산출물과 같은 자리(컨테이너에 가려지는 저장소의 상태 폴더)에 둔다. 임시 파일은 남기지 않는다
    expect(await readdir(recordsDir())).toEqual([`${sha('a')}.json`]);
    // 다시 남기면 바꿔 쓴다
    await saveContractRecord(stateDir, sha('a'), new Map([['api', { paths: {} }]]));
    expect(Object.fromEntries((await readContractRecord(stateDir, sha('a')))!)).toEqual({ api: { paths: {} } });
  });

  it('온전한 커밋 id가 아니면 쓰지도 읽지도 않는다(경로에 끼워 넣을 수 있는 글자를 받지 않는다)', async () => {
    for (const bad of ['', 'abc1234', 'HEAD', '../'.repeat(13) + 'x', `${sha('a')}/../x`, sha('A'), `${sha('a')}\n`]) {
      await expect(saveContractRecord(stateDir, bad, contracts)).rejects.toThrow('체크포인트 id 형식');
      expect(await readContractRecord(stateDir, bad)).toBeUndefined();
    }
    expect(await readdir(stateDir)).toEqual([]);
  });

  it('기록이 깨졌거나 꼴이 다르면 없는 것으로 본다', async () => {
    await saveContractRecord(stateDir, sha('a'), contracts);
    for (const broken of ['{깨진', '[]', '"글자"', 'null', '']) {
      await writeFile(path.join(recordsDir(), `${sha('a')}.json`), broken);
      expect(await readContractRecord(stateDir, sha('a'))).toBeUndefined();
    }
  });

  it('기록 폴더가 다른 곳을 가리키는 링크면 쓰지도 읽지도 않는다(링크 너머에 쓰거나 지우지 않는다)', async () => {
    await writeFile(path.join(outside, `${sha('c')}.json`), JSON.stringify({ api: { planted: true } }));
    await writeFile(path.join(outside, 'keep.txt'), 'x');
    // 폴더 자체가 링크인 경우와, 그 위의 폴더가 링크인 경우
    for (const link of ['.git/b-studio/contracts', '.git/b-studio', '.git']) {
      const root = await mkdtemp(path.join(tmpdir(), 'b-studio-contract-records-link-'));
      stateDir = path.join(root, 'session');
      await mkdir(path.dirname(path.join(stateDir, link)), { recursive: true });
      const target = link === '.git/b-studio/contracts' ? outside : path.join(root, 'elsewhere');
      if (target !== outside) {
        await mkdir(path.join(target, link === '.git' ? 'b-studio/contracts' : 'contracts'), { recursive: true });
        await writeFile(path.join(target, link === '.git' ? 'b-studio/contracts' : 'contracts', `${sha('c')}.json`), JSON.stringify({ api: { planted: true } }));
      }
      await symlink(target, path.join(stateDir, link));
      await expect(saveContractRecord(stateDir, sha('a'), contracts)).rejects.toThrow('다른 곳을 가리킵니다');
      // 링크 너머에 심어 둔 기록을 기준으로 믿지 않는다
      expect(await readContractRecord(stateDir, sha('c'))).toBeUndefined();
    }
    expect((await readdir(outside)).sort()).toEqual([`${sha('c')}.json`, 'keep.txt']);
  });

  it('기록 자리에 놓인 링크는 따라가지 않는다. 읽을 때는 없는 것으로 보고, 쓸 때는 링크를 기록으로 바꿔 놓는다', async () => {
    await mkdir(recordsDir(), { recursive: true });
    const secret = path.join(outside, 'secret.json');
    await writeFile(secret, JSON.stringify({ api: { planted: true } }));
    await symlink(secret, path.join(recordsDir(), `${sha('a')}.json`));
    expect(await readContractRecord(stateDir, sha('a'))).toBeUndefined();

    await saveContractRecord(stateDir, sha('a'), contracts);
    // 링크가 가리키던 파일은 그대로다
    expect(JSON.parse(await readFile(secret, 'utf8'))).toEqual({ api: { planted: true } });
    expect(Object.fromEntries((await readContractRecord(stateDir, sha('a')))!)).toEqual(Object.fromEntries(contracts));
  });

  it('오래된 기록부터 지운다. 기록이 아닌 파일과 링크는 건드리지 않는다', async () => {
    await mkdir(recordsDir(), { recursive: true });
    const digits = '0123456789abcdef';
    const names: string[] = [];
    for (let index = 0; index < 205; index++) names.push([...String(index).padStart(3, '0')].map((digit) => digits[Number(digit)]).join('').padEnd(40, 'f'));
    for (const [index, name] of names.entries()) {
      const file = path.join(recordsDir(), `${name}.json`);
      await writeFile(file, '{}');
      await utimes(file, 1_000_000 + index, 1_000_000 + index);
    }
    await writeFile(path.join(recordsDir(), 'notes.txt'), 'x');
    await utimes(path.join(recordsDir(), 'notes.txt'), 1, 1);
    await symlink(path.join(outside, 'nowhere'), path.join(recordsDir(), `${sha('e')}.json`));

    await saveContractRecord(stateDir, sha('a'), contracts);
    const left = await readdir(recordsDir());
    // 기록은 200개까지 남는다(205 + 방금 것 1 → 가장 오래된 6개가 지워진다). 다른 파일과 링크는 그대로다
    expect(left.filter((name) => name.endsWith('.json') && name !== `${sha('e')}.json`)).toHaveLength(200);
    expect(left).toContain('notes.txt');
    expect(left).toContain(`${sha('e')}.json`);
    expect(left).toContain(`${sha('a')}.json`);
    for (const name of names.slice(0, 6)) expect(left).not.toContain(`${name}.json`);
    expect(left).toContain(`${names[6]}.json`);
  });
});
