import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { StudioEvent } from '@/lib/studio-events';
import { as, pick, randomEvent, rng, WEIRD_TEXTS } from './session-persist-fixtures';
import { SessionRecord } from './session-record';
import { closeUnfinished, readStoredSessions, sessionFile } from './session-store';
import { legacyCloseUnfinished, legacyReadSessions } from './session-store-legacy';

/**
 * 세션 읽기·닫기(ADR-203, 4f B1b): Rust `read_sessions`·`close_unfinished`를 옛 TS(`session-store-legacy.ts`)와 같은 입력으로 견준다.
 */

let cases = 0;
afterAll(() => console.log(`[session-store 차등] 사례 ${cases}개`));

const valid = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  version: 1,
  savedAt: '2026-11-16T00:00:00.000Z',
  owner: { pid: 4242 },
  snapshot: { id, workDir: `/w/${id}`, services: [] },
  history: [],
  conversation: [],
  demoIndex: 0,
  claudeCode: { notes: [] },
  sourceDirtyFiles: 0,
  sandbox: { id: `studio-${id}`, provider: 'local-docker' },
  ...extra,
});

async function putRaw(root: string, name: string, text: string): Promise<void> {
  const file = sessionFile(path.join(root, name));
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text);
}

/** 옛 `readSessions`와 새 결과(나머지 + history 객체)를 견준다 */
async function expectSameRead(root: string): Promise<number> {
  const old = await legacyReadSessions(root);
  const fresh = await readStoredSessions(root);
  const rebuilt = fresh.filter((s) => !s.historyError).map((s) => ({ ...s.data, history: s.record.history() }));
  expect(rebuilt).toEqual(old.filter((d) => Array.isArray(d.history)));
  expect(fresh.length).toBe(old.length);
  return old.length;
}

describe('세션 읽기 차등', () => {
  it('형식 검사의 경계값이 JS의 참·거짓과 같다', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'session-read-'));
    const raws: string[] = [];
    const add = (text: string) => raws.push(text);
    const base = JSON.stringify(valid('a'));
    // version
    for (const v of ['1', '1.0', '1e0', '10e-1', '0', '2', '"1"', 'true', 'null', '1.5', '[1]', '{}', '-0', '1e999', '[]', '""']) add(base.replace('"version":1', `"version":${v}`));
    // snapshot.id / workDir / sandbox.id
    for (const v of ['""', '0', '-0', 'false', 'null', '"0"', '[]', '{}', '1', '"x"', '0.0', '1e999', 'true']) {
      add(base.replace('"id":"a"', `"id":${v}`));
      add(base.replace('"workDir":"/w/a"', `"workDir":${v}`));
      add(base.replace('"id":"studio-a"', `"id":${v}`));
    }
    // owner.pid
    for (const v of ['1.5', '"1"', 'null', '-0', '0', '1e300', '1e999', '-5', '1.0', '1e0', 'true', '[]', '9007199254740993', '5e-324']) add(base.replace('"pid":4242', `"pid":${v}`));
    // 최상위·멤버가 객체가 아님, 없는 멤버
    for (const v of ['[]', 'null', '5', '"x"', 'true', '', '   ', '{', '{"a":1,}', '﻿' + base, '{} {}']) add(v);
    add(JSON.stringify({ ...JSON.parse(base), snapshot: 'abc' }));
    add(JSON.stringify({ ...JSON.parse(base), snapshot: null }));
    add(JSON.stringify({ ...JSON.parse(base), owner: 'x' }));
    add(JSON.stringify({ ...JSON.parse(base), sandbox: [] }));
    add(base.replace('"version":1,', ''));
    // 같은 키가 두 번(마지막이 이긴다)
    add(base.replace('"version":1', '"version":2,"version":1'));
    add(base.replace('"version":1', '"version":1,"version":2'));
    add(`{"version":1,"snapshot":{"id":"d","workDir":"/w","id":""},"sandbox":{"id":"s"},"owner":{"pid":1},"history":[]}`);
    // 공백이 든 손으로 고친 파일
    add(JSON.stringify(valid('ws'), null, 2));
    add(` \n\t${base}\r\n `);
    for (let i = 0; i < raws.length; i += 1) await putRaw(root, `case-${String(i).padStart(3, '0')}`, raws[i]!);
    cases += raws.length;
    const kept = await expectSameRead(root);
    expect(kept).toBeGreaterThan(5);
    expect(kept).toBeLessThan(raws.length);
  });

  it('폴더가 아닌 항목·링크·session.json이 폴더인 경우·없는 .git을 건너뛴다', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'session-read-'));
    await putRaw(root, 'ok', JSON.stringify(valid('ok')));
    await writeFile(path.join(root, 'plain-file'), JSON.stringify(valid('f')));
    await mkdir(path.join(root, 'no-git'));
    await mkdir(sessionFile(path.join(root, 'dir-session')), { recursive: true });
    await putRaw(path.join(root, '..'), path.basename(root) + '-target', JSON.stringify(valid('link')));
    await symlink(path.join(root, '..', path.basename(root) + '-target'), path.join(root, 'link'));
    await putRaw(root, 'not-json', '{ nope');
    cases += 6;
    expect(await expectSameRead(root)).toBe(1);
    expect(await legacyReadSessions(path.join(root, 'missing'))).toEqual([]);
    expect(await readStoredSessions(path.join(root, 'missing'))).toEqual([]);
  });

  it('이름 순서대로 읽는다', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'session-read-'));
    for (const name of ['b', 'a', 'Z', 'a1', 'a-', '한글']) await putRaw(root, name, JSON.stringify(valid(name)));
    cases += 1;
    expect(await expectSameRead(root)).toBe(6);
    expect((await readStoredSessions(root)).map((s) => s.data.snapshot.id)).toEqual((await legacyReadSessions(root)).map((d) => d.snapshot.id));
  });

  it('무작위 history(수·NaN 자리·NUL 키·짝 없는 서로게이트·공백)를 옛 파일 읽기와 같게 올린다', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'session-read-'));
    for (let seed = 1; seed <= 40; seed += 1) {
      const random = rng(seed * 977);
      const events: StudioEvent[] = Array.from({ length: 50 + Math.floor(random() * 150) }, (_, i) => randomEvent(random, i, { big: seed % 10 === 0 }));
      const text = JSON.stringify(valid(`s${seed}`, { history: events }), null, seed % 2 === 0 ? 2 : undefined);
      // 파일에서만 오는 수 꼴을 섞는다
      const spiced = text.replace(/"index":(\d+)/g, (_m, n: string) => (Number(n) % 4 === 0 ? `"index": ${n}.0` : Number(n) % 7 === 0 ? `"index":${n}e0` : `"index":${n}`));
      const extra = seed % 3 === 0 ? spiced.replace('"history":[', '"history":[{"big":1e999,"neg":-1e999,"z":-0,"zz":-0.0,"k":1.0,"\\u0000nf":"NaN","\\u0000x":[1e0]},') : spiced;
      await putRaw(root, `s${String(seed).padStart(2, '0')}`, extra);
      cases += 1;
    }
    expect(await expectSameRead(root)).toBe(40);
  });

  it('history가 없거나 배열이 아니거나 읽을 수 없으면 그 세션에만 이유가 붙는다(파일은 그대로)', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'session-read-'));
    const noHistory = valid('n');
    delete noHistory.history;
    await putRaw(root, 'a-none', JSON.stringify(noHistory));
    await putRaw(root, 'b-object', JSON.stringify(valid('o', { history: { a: 1 } })));
    await putRaw(root, 'c-deep', JSON.stringify(valid('d')).replace('"history":[]', `"history":[${'['.repeat(2_500)}${']'.repeat(2_500)}]`));
    await putRaw(root, 'd-ok', JSON.stringify(valid('k')));
    cases += 4;
    const found = await readStoredSessions(root);
    expect(found.map((s) => [s.data.snapshot.id, Boolean(s.historyError)])).toEqual([['n', true], ['o', true], ['d', true], ['k', false]]);
    expect(found[0]!.historyError).toContain('history');
    expect(found[2]!.historyError).toContain('깊어');
  });
});

/** 닫기 시험용 이벤트 열: 열린 것 여러 종류, 필드 없음·글자 아님·중복 runId·객체 runId */
function closeEvents(random: () => number, length: number): StudioEvent[] {
  // 객체·배열은 이벤트마다 새로 만든다(파일에서 읽은 이벤트는 서로 다른 객체다)
  const makers: Array<() => unknown> = [() => 'r1', () => 'r2', () => 'r3', () => 1, () => 1.0, () => -0, () => 0, () => null, () => true, () => false, () => '', () => Number.NaN, () => undefined, () => ({ a: 1 }), () => ['x'], () => 'a\ud800b'];
  const out: StudioEvent[] = [];
  for (let i = 0; i < length; i += 1) {
    const id = pick(random, makers)();
    const roll = random();
    if (roll < 0.2) out.push(as({ type: 'run_started', ...(id === undefined && random() < 0.5 ? {} : { runId: id }), request: 'q' }));
    else if (roll < 0.35) out.push(as({ type: 'run_finished', ...(id === undefined && random() < 0.5 ? {} : { runId: id }), status: 'done' }));
    else if (roll < 0.43) out.push(as({ type: 'restore_started', checkpoint: pick(random, [{ sha: 'a' }, undefined, null, 0, '', 'x', Number.NaN, -0, [], false]) }));
    else if (roll < 0.5) out.push(as({ type: pick(random, ['restored', 'restore_failed']) }));
    else if (roll < 0.56) out.push(as({ type: 'backup_restore_started', backupId: pick(random, ['b1', '', 0, undefined, null, { x: 1 }]) }));
    else if (roll < 0.62) out.push(as({ type: pick(random, ['backup_restored', 'backup_restore_failed']) }));
    else if (roll < 0.67) out.push(as({ type: 'remote_sync_started' }));
    else if (roll < 0.72) out.push(as({ type: pick(random, ['remote_synced', 'remote_sync_failed']) }));
    else if (roll < 0.78) out.push(as({ type: 'deploy_started', action: pick(random, ['deploy', undefined, null, 5, { a: 1 }]), target: pick(random, ['abc', undefined, 7]), at: 'x' }));
    else if (roll < 0.83) out.push(as({ type: pick(random, ['deploy_finished', 'deploy_failed']) }));
    else if (roll < 0.86) out.push(as(pick(random, [5, 'x', [1], true, { type: 5 }, { type: null }, { type: 'run_started ' }, { type: 'RUN_STARTED' }])));
    else out.push(randomEvent(random, i));
  }
  return out;
}

describe('끝나지 못한 요청 닫기 차등', () => {
  for (let seed = 1; seed <= 80; seed += 1) {
    it(`시드 ${seed}`, () => {
      cases += 1;
      const random = rng(seed * 6007);
      const history = closeEvents(random, 5 + Math.floor(random() * 60));
      const reason = pick(random, ['서버가 멈췄습니다', WEIRD_TEXTS[0]!, '한글 "따옴표"\n']);
      expect(closeUnfinished(history, reason)).toEqual(legacyCloseUnfinished(history, reason));
    });
  }

  it('열린 것이 없으면 그대로이고, 여러 종류가 열려 있으면 정해진 순서로 덧붙인다', () => {
    cases += 2;
    const done = [as({ type: 'run_started', runId: 'a' }), as({ type: 'run_finished', runId: 'a' })];
    expect(closeUnfinished(done, 'x')).toEqual(done);
    const open = [
      as({ type: 'deploy_started', action: 'deploy', target: 't' }),
      as({ type: 'remote_sync_started' }),
      as({ type: 'backup_restore_started', backupId: 'b' }),
      as({ type: 'restore_started', checkpoint: { sha: 's' } }),
      as({ type: 'run_started', runId: 'z' }),
      as({ type: 'run_started', runId: 'y' }),
    ];
    const result = closeUnfinished(open, 'x');
    expect(result.slice(6).map((e) => e.type)).toEqual(['run_finished', 'run_finished', 'restore_failed', 'backup_restore_failed', 'remote_sync_failed', 'deploy_failed']);
    expect(result).toEqual(legacyCloseUnfinished(open, 'x'));
  });

  it('null 이벤트는 옛 구현처럼 던지고 아무것도 덧붙이지 않는다', () => {
    cases += 1;
    const history = [as({ type: 'run_started', runId: 'a' }), as(null)];
    expect(() => legacyCloseUnfinished(history, 'x')).toThrow();
    const record = new SessionRecord({ logs: false, history });
    expect(() => record.closeUnfinished('x')).toThrow();
    expect(record.history()).toHaveLength(2);
  });

  it('기록 끝에 덧붙이고 상한을 걸지 않는다', () => {
    cases += 1;
    const record = new SessionRecord({ logs: false, history: Array.from({ length: 5_000 }, (_, i) => as({ type: 'run_started', runId: `r${i}` })) });
    expect(record.closeUnfinished('x')).toBe(5_000);
    expect(record.history()).toHaveLength(10_000);
  });
});
