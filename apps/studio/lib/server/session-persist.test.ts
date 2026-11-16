import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { native } from '@b-studio/sandbox';
import { afterAll, describe, expect, it } from 'vitest';
import { as, randomBody, randomEvent, rng } from './session-persist-fixtures';
import { SessionPersist } from './session-persist';
import { SessionRecord } from './session-record';
import { legacyPush, type LegacyRecord } from './session-record-legacy';
import { legacyToPersisted } from './session-store-legacy';
import { readStoredSessions, sessionFile, splitPersisted, writeSession, type PersistedBody } from './session-store';

/**
 * 세션 저장(ADR-203, 4f B1b): Rust `Persister`가 쓴 파일이 옛 `JSON.stringify(toPersisted(session))`와 바이트까지 같은지,
 * 쓰기 줄(차례·예약·실패)이 옛 `flushPersist`·`schedulePersist`와 같게 구는지 본다.
 */

let cases = 0;
afterAll(() => console.log(`[session-persist 차등] 사례 ${cases}개`));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fixture(): Promise<{ root: string; workDir: string; file: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'session-persist-'));
  const workDir = path.join(root, 'orders-ab12cd34');
  return { root, workDir, file: sessionFile(workDir) };
}

function makePersist(record: SessionRecord, body: () => PersistedBody, file: string, options: { onError?: (m: string) => void; delayMs?: number } = {}) {
  const calls = { state: 0 };
  const persist = new SessionPersist(
    record,
    () => {
      calls.state += 1;
      return { file, ...splitPersisted(body()) };
    },
    options,
  );
  return { persist, calls };
}

describe('저장 파일의 바이트가 옛 JSON.stringify(toPersisted)와 같다', () => {
  for (let seed = 1; seed <= 60; seed += 1) {
    it(`시드 ${seed}`, async () => {
      cases += 1;
      const random = rng(seed * 104729);
      const { workDir, file } = await fixture();
      const legacy: LegacyRecord = { history: [], logs: [] };
      const record = new SessionRecord({ logs: true });
      const length = seed === 1 ? 5_400 : 60 + Math.floor(random() * 400);
      for (let i = 0; i < length; i += 1) {
        const event = randomEvent(random, i, { big: seed % 10 === 0 });
        legacyPush(legacy, event);
        record.push(event);
      }
      const body = randomBody(random, workDir, seed);
      const { persist } = makePersist(record, () => body, file);
      await persist.flush();
      const expected = Buffer.from(JSON.stringify(legacyToPersisted(body, legacy.history)));
      expect(Buffer.compare(readFileSync(file), expected)).toBe(0);
    });
  }

  it('저장용 history 상한(2,000) 경계와 저장하지 않는 종류가 낀 기록', async () => {
    for (const persistedCount of [1_999, 2_000, 2_001, 2_002]) {
      cases += 1;
      const { workDir, file } = await fixture();
      const legacy: LegacyRecord = { history: [], logs: [] };
      const record = new SessionRecord({ logs: true });
      for (let i = 0, kept = 0; kept < persistedCount; i += 1) {
        const event = i % 3 === 0 ? as({ type: 'status', status: 'ready' }) : as({ type: 'notice', text: `n${i}`, at: 'a' });
        legacyPush(legacy, event);
        record.push(event);
        if (i % 3 !== 0) kept += 1;
      }
      const body = randomBody(rng(persistedCount), workDir, 3);
      await makePersist(record, () => body, file).persist.flush();
      expect(Buffer.compare(readFileSync(file), Buffer.from(JSON.stringify(legacyToPersisted(body, legacy.history))))).toBe(0);
    }
  });

  it('head·tail이 이음 자리에서 맞는다(쉼표·빈 tail·빈 history)', async () => {
    const { file } = await fixture();
    const record = new SessionRecord({ logs: true });
    const empty = new SessionPersist(record, () => ({ file, head: '{"a":1}', tail: '{}' }));
    await empty.flush();
    expect(readFileSync(file, 'utf8')).toBe('{"a":1,"history":[]}');
    record.push(as({ type: 'notice', text: 'x' }));
    const both = new SessionPersist(record, () => ({ file, head: '{}', tail: '{"b":2}' }));
    await both.flush();
    expect(readFileSync(file, 'utf8')).toBe('{"history":[{"type":"notice","text":"x"}],"b":2}');
  });

  it('저장 → 읽기 → 저장의 바이트가 같다', async () => {
    for (let seed = 1; seed <= 20; seed += 1) {
      cases += 1;
      const random = rng(seed * 31337);
      const { root, workDir, file } = await fixture();
      const record = new SessionRecord({ logs: true });
      for (let i = 0; i < 200; i += 1) record.push(randomEvent(random, i));
      const body = randomBody(random, workDir, seed);
      await makePersist(record, () => body, file).persist.flush();
      const first = readFileSync(file);
      const [stored] = await readStoredSessions(root);
      expect(stored?.historyError).toBeUndefined();
      const again = path.join(root, 'again', 'session.json');
      const copy = makePersist(stored!.record, () => stored!.data, again);
      await copy.persist.flush();
      expect(Buffer.compare(readFileSync(again), first)).toBe(0);
    }
  });

  it('옛 writeSession(호환 함수)과도 같다', async () => {
    const { workDir, file } = await fixture();
    const body = randomBody(rng(9), workDir, 9);
    const history = [as({ type: 'run_started', runId: 'r', request: 'a' })];
    await writeSession({ ...body, history });
    expect(readFileSync(file, 'utf8')).toBe(JSON.stringify(legacyToPersisted(body, history)));
  });
});

describe('쓰기 줄', () => {
  it('flush를 기다리지 않고 여러 번 불러도 앞의 쓰기가 끝난 뒤에 다음 상태를 읽는다', async () => {
    const { workDir, file } = await fixture();
    const record = new SessionRecord({ logs: true });
    let counter = 0;
    const seen: Array<number | undefined> = [];
    const persist = new SessionPersist(record, () => {
      // 지금 파일에 있는 번호가 바로 앞 호출의 번호여야 한다(앞 쓰기가 끝났다)
      seen.push(existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { n: number }).n : undefined);
      counter += 1;
      return { file, head: `{"n":${counter}}`, tail: '{}' };
    });
    void workDir;
    await Promise.all(Array.from({ length: 6 }, () => persist.flush()));
    expect(seen).toEqual([undefined, 1, 2, 3, 4, 5]);
  });

  it('flush의 약속은 이번 쓰기가 끝난 뒤에 풀린다', async () => {
    const { file } = await fixture();
    const record = new SessionRecord({ logs: true });
    const persist = new SessionPersist(record, () => ({ file, head: '{"k":1}', tail: '{}' }));
    await persist.flush();
    expect(existsSync(file)).toBe(true);
  });

  it('동시에 flush 여러 번과 flushSync를 섞어도 임시 파일이 남지 않고 깨지지 않는다', async () => {
    const { file } = await fixture();
    const record = new SessionRecord({ logs: true });
    let n = 0;
    const errors: string[] = [];
    const persist = new SessionPersist(record, () => ({ file, head: `{"n":${(n += 1)}}`, tail: '{}' }), { onError: (m) => errors.push(m) });
    const pending: Promise<void>[] = [];
    for (let i = 0; i < 30; i += 1) {
      pending.push(persist.flush());
      if (i % 5 === 0) persist.flushSync({ file, head: `{"sync":${i}}`, tail: '{}' });
    }
    await Promise.all(pending);
    expect(errors).toEqual([]);
    expect(readdirSync(path.dirname(file))).toEqual(['session.json']);
    expect(() => JSON.parse(readFileSync(file, 'utf8'))).not.toThrow();
  });

  it('같은 파일에 동시에 쓰는 여러 저장이 임시 파일 이름을 나눠 쓰지 않는다', async () => {
    const { workDir, file } = await fixture();
    const body = randomBody(rng(5), workDir, 5);
    const results = await Promise.allSettled(Array.from({ length: 50 }, (_, i) => writeSession({ ...body, demoIndex: i, history: [] })));
    expect(results.filter((r) => r.status === 'rejected')).toEqual([]);
    expect(readdirSync(path.dirname(file))).toEqual(['session.json']);
  });

  it('쓰기 실패(폴더 자리에 파일)는 오류로 알리고 약속은 던지지 않으며 다음 쓰기는 계속한다', async () => {
    const { root } = await fixture();
    const blocked = path.join(root, 'blocked');
    await writeFile(blocked, 'x');
    const file = path.join(blocked, '.git', 'b-studio', 'session.json');
    const record = new SessionRecord({ logs: true });
    const errors: string[] = [];
    const persist = new SessionPersist(record, () => ({ file, head: '{"a":1}', tail: '{}' }), { onError: (m) => errors.push(m) });
    await expect(persist.flush()).resolves.toBeUndefined();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('폴더를 만들지 못했습니다');
    const good = path.join(root, 'good', 'session.json');
    const second = new SessionPersist(record, () => ({ file: errors.length === 1 ? good : file, head: '{"a":2}', tail: '{}' }));
    await second.flush();
    expect(readFileSync(good, 'utf8')).toBe('{"a":2,"history":[]}');
  });

  it('session.json 자리에 폴더가 있어 rename이 실패하면 임시 파일을 남기지 않는다', async () => {
    const { file } = await fixture();
    await mkdir(file, { recursive: true });
    const errors: string[] = [];
    const persist = new SessionPersist(new SessionRecord({ logs: true }), () => ({ file, head: '{"a":1}', tail: '{}' }), { onError: (m) => errors.push(m) });
    await persist.flush();
    expect(errors).toHaveLength(1);
    expect(readdirSync(path.dirname(file))).toEqual(['session.json']);
  });

  it('콜백이 던지거나 객체 글자가 아닌 글자를 주면 쓰지 않고 오류로 알리며 이전 파일이 남는다', async () => {
    const { file } = await fixture();
    const record = new SessionRecord({ logs: true });
    const errors: string[] = [];
    let mode = 'ok';
    const persist = new SessionPersist(
      record,
      () => {
        if (mode === 'throw') throw new Error('상태를 못 만듦');
        if (mode === 'head-array') return { file, head: '[1]', tail: '{}' };
        if (mode === 'head-string') return { file, head: '"x"', tail: '{}' };
        if (mode === 'tail-array') return { file, head: '{"a":1}', tail: '[1]' };
        if (mode === 'tail-empty') return { file, head: '{"a":1}', tail: '' };
        if (mode === 'undefined') return undefined as never;
        if (mode === 'numbers') return { file, head: 1, tail: 2 } as never;
        return { file, head: '{"a":"first"}', tail: '{}' };
      },
      { onError: (m) => errors.push(m) },
    );
    await persist.flush();
    const first = readFileSync(file, 'utf8');
    for (const next of ['throw', 'head-array', 'head-string', 'tail-array', 'tail-empty', 'undefined', 'numbers']) {
      mode = next;
      await persist.flush();
      expect(readFileSync(file, 'utf8'), next).toBe(first);
    }
    expect(errors).toHaveLength(7);
    expect(errors[0]).toContain('상태를 못 만듦');
    expect(errors[1]).toContain('head');
    expect(errors[3]).toContain('tail');
    mode = 'ok';
    await persist.flush();
    expect(errors).toHaveLength(7);
  });

  it('flushSync는 <file>.<pid>.exit.tmp에 쓴다', async () => {
    const { file } = await fixture();
    const persist = new SessionPersist(new SessionRecord({ logs: true }), () => ({ file, head: '{}', tail: '{}' }));
    await mkdir(`${file}.${process.pid}.exit.tmp`, { recursive: true });
    expect(() => persist.flushSync({ file, head: '{"a":1}', tail: '{}' })).toThrow(/exit\.tmp/);
    expect(() => persist.flushSync({ file, head: '[', tail: '{}' })).toThrow(/head/);
  });
});

describe('저장 예약', () => {
  it('예약이 겹치면 한 번만 쓴다(이미 예약돼 있으면 아무것도 하지 않는다)', async () => {
    const { file } = await fixture();
    const { persist, calls } = makePersist(new SessionRecord({ logs: true }), () => ({ a: 1 }) as unknown as PersistedBody, file, { delayMs: 80 });
    for (let i = 0; i < 20; i += 1) persist.schedule();
    expect(existsSync(file)).toBe(false);
    await sleep(300);
    expect(calls.state).toBe(1);
    expect(existsSync(file)).toBe(true);
  });

  it('모으는 시간은 처음 예약한 때부터 센다(예약을 계속해도 미뤄지지 않는다)', async () => {
    const { file } = await fixture();
    const { persist, calls } = makePersist(new SessionRecord({ logs: true }), () => ({ a: 1 }) as unknown as PersistedBody, file, { delayMs: 100 });
    const started = Date.now();
    while (Date.now() - started < 450) {
      persist.schedule();
      await sleep(15);
    }
    expect(calls.state).toBeGreaterThanOrEqual(3);
  });

  it('flush는 예약을 지운다(쓰기 한 번만 한다). cancel은 쓰지 않는다', async () => {
    const { file } = await fixture();
    const { persist, calls } = makePersist(new SessionRecord({ logs: true }), () => ({ a: 1 }) as unknown as PersistedBody, file, { delayMs: 60 });
    persist.schedule();
    await persist.flush();
    await sleep(200);
    expect(calls.state).toBe(1);
    persist.schedule();
    persist.cancel();
    await sleep(200);
    expect(calls.state).toBe(1);
    persist.schedule();
    await sleep(200);
    expect(calls.state).toBe(2);
  });

  it('idle은 줄에 선 쓰기가 끝난 뒤에 풀린다', async () => {
    const { file } = await fixture();
    const { persist, calls } = makePersist(new SessionRecord({ logs: true }), () => ({ a: 1 }) as unknown as PersistedBody, file);
    void persist.flush();
    void persist.flush();
    await persist.idle();
    expect(calls.state).toBe(2);
  });

  it('타이머와 콜백이 Node 프로세스를 붙잡지 않는다', async () => {
    const nativePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../../packages/sandbox/native/bstudio_node.node');
    const script = `
      const n = require(${JSON.stringify(nativePath)});
      const record = new n.SessionRecord(true);
      const persister = new n.Persister(record, () => { throw new Error('불리면 안 된다'); }, () => {}, 60000);
      persister.schedule();
      console.log('scheduled');
    `;
    const started = Date.now();
    const run = spawnSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 20_000 });
    expect(run.status).toBe(0);
    expect(run.stdout).toContain('scheduled');
    expect(Date.now() - started).toBeLessThan(15_000);
  });
});

describe('파일 쓰기와 읽기 경계', () => {
  it('원자적 쓰기: 새 파일 권한과 이전 파일 교체, 임시 파일이 남지 않는다', async () => {
    const { root } = await fixture();
    const target = path.join(root, 'side', 'requirements-draft.json');
    await native.writeFileAtomic(target, 'one', 0o600);
    expect((await import('node:fs')).statSync(target).mode & 0o777).toBe(0o600);
    await native.writeFileAtomic(target, 'two', 0o600);
    expect(await readFile(target, 'utf8')).toBe('two');
    const plain = path.join(root, 'side', 'test-results.json');
    await native.writeFileAtomic(plain, 'x');
    expect((await import('node:fs')).statSync(plain).mode & 0o777).toBe(0o666 & ~process.umask());
    expect((await readdir(path.dirname(target))).sort()).toEqual(['requirements-draft.json', 'test-results.json']);
    await Promise.all(Array.from({ length: 50 }, (_, i) => native.writeFileAtomic(plain, `v${i}`)));
    expect((await readdir(path.dirname(target))).sort()).toEqual(['requirements-draft.json', 'test-results.json']);
    await writeFile(path.join(root, 'f'), 'x');
    await expect(native.writeFileAtomic(path.join(root, 'f', 'g.json'), 'x')).rejects.toThrow();
  });
});
