import { mkdir, mkdtemp, open, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCodexRolloutReader, type CodexRolloutFs } from './codex-rollout-context';

const THREAD = '01a180c4-6682-7a82-b709-d96ff6ca4375';
const OTHER = '01a18039-0b6b-7c73-8e06-67e9c5029a41';
const SECRET = '주문 테이블의 비밀 메모 sk-test-대화내용';

/** 진짜 codex 0.160.1 세션 기록과 같은 꼴(숫자는 실측 값) */
const tokenCount = (input: number, output: number, window = 475_000) =>
  JSON.stringify({
    timestamp: '2026-10-28T01:56:34.574Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: { input_tokens: input * 2, cached_input_tokens: 0, output_tokens: output * 2, reasoning_output_tokens: 0, total_tokens: (input + output) * 2 },
        last_token_usage: { input_tokens: input, cached_input_tokens: 12_288, cache_write_input_tokens: 0, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output },
        model_context_window: window,
      },
      rate_limits: { primary: { used_percent: 0, window_minutes: 300 } },
    },
  });
const meta = JSON.stringify({ type: 'session_meta', payload: { id: THREAD, cwd: '/work', base_instructions: { text: SECRET } } });
const message = (text: string) => JSON.stringify({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });

let home: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(tmpdir(), 'codex-home-'));
});
afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

async function rollout(day: string, thread: string, lines: string[]): Promise<string> {
  const dir = path.join(home, 'sessions', ...day.split('-'));
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `rollout-${day}T10-56-28-${thread}.jsonl`);
  await writeFile(file, `${lines.join('\n')}\n`);
  return file;
}

/** 연 파일과 읽은 바이트를 센다 */
function spyFs(): CodexRolloutFs & { opened: string[]; bytes: number } {
  const spy = {
    opened: [] as string[],
    bytes: 0,
    readdir: (dir: string) => readdir(dir),
    open: async (file: string) => {
      spy.opened.push(file);
      const handle = await open(file, 'r');
      return {
        stat: () => handle.stat(),
        read: async (buffer: Buffer, offset: number, length: number, position: number) => {
          const result = await handle.read(buffer, offset, length, position);
          spy.bytes += result.bytesRead;
          return result;
        },
        close: () => handle.close(),
      };
    },
  };
  return spy;
}

describe('Codex 세션 기록에서 문맥 숫자만 읽는다(#978)', () => {
  it('대화 id로 찾은 기록의 마지막 token_count로 문맥 %를 낸다', async () => {
    await rollout('2026-10-28', THREAD, [meta, message(SECRET), tokenCount(10_000, 100), message(SECRET), tokenCount(47_400, 100)]);
    const reader = createCodexRolloutReader();
    expect(await reader.read(home, THREAD)).toEqual({ usedPct: 10, used: 47_500, size: 475_000 });
  });

  it('결과에 대화 내용이 새지 않는다', async () => {
    await rollout('2026-10-28', THREAD, [meta, message(SECRET), tokenCount(1_000, 10)]);
    const context = await createCodexRolloutReader().read(home, THREAD);
    expect(JSON.stringify(context)).not.toContain('비밀');
    expect(Object.keys(context ?? {}).sort()).toEqual(['size', 'used', 'usedPct']);
  });

  it('다른 세션의 기록 파일은 열지 않는다', async () => {
    const mine = await rollout('2026-10-28', THREAD, [meta, tokenCount(1_000, 10)]);
    await rollout('2026-10-28', OTHER, [meta, tokenCount(9_000, 10)]);
    await rollout('2026-10-27', OTHER, [meta, tokenCount(9_000, 10)]);
    const fs = spyFs();
    await createCodexRolloutReader(fs).read(home, THREAD);
    expect(fs.opened).toEqual([mine]);
  });

  it('찾은 자리를 기억해 다음에는 폴더를 다시 훑지 않는다', async () => {
    await rollout('2026-10-28', THREAD, [meta, tokenCount(1_000, 10)]);
    let listed = 0;
    const fs: CodexRolloutFs = { readdir: async (dir) => (listed++, readdir(dir)), open: spyFs().open };
    const reader = createCodexRolloutReader(fs);
    await reader.read(home, THREAD);
    const first = listed;
    await reader.read(home, THREAD);
    expect(listed).toBe(first);
  });

  it('큰 기록도 끝에서부터 읽어 전부 읽지 않는다', async () => {
    const filler = Array.from({ length: 400 }, () => message(SECRET.repeat(40)));
    const file = await rollout('2026-10-28', THREAD, [meta, ...filler, tokenCount(2_000, 20)]);
    const fs = spyFs();
    expect((await createCodexRolloutReader(fs).read(home, THREAD))?.used).toBe(2_020);
    const { size } = await (await open(file, 'r')).stat();
    expect(fs.bytes).toBeLessThan(size / 4);
  });

  it('token_count가 없거나 기록이 없으면 비운다', async () => {
    await rollout('2026-10-28', THREAD, [meta, message(SECRET)]);
    const reader = createCodexRolloutReader();
    expect(await reader.read(home, THREAD)).toBeUndefined();
    expect(await reader.read(home, OTHER)).toBeUndefined();
  });

  it('대화 id 꼴이 아니면 폴더를 훑지도 않는다', async () => {
    let listed = 0;
    const fs: CodexRolloutFs = { readdir: async (dir) => (listed++, readdir(dir)), open: spyFs().open };
    const reader = createCodexRolloutReader(fs);
    for (const bad of ['../../etc/passwd', '*', '', 'a/b', `${THREAD}.jsonl`]) expect(await reader.read(home, bad)).toBeUndefined();
    expect(listed).toBe(0);
  });

  it('문맥 창이 0이거나 숫자가 틀리면 비운다', async () => {
    await rollout('2026-10-28', THREAD, [meta, tokenCount(1_000, 10, 0)]);
    expect(await createCodexRolloutReader().read(home, THREAD)).toBeUndefined();
  });
});

describe('Codex 세션 기록의 한도·캐시(#1468): 같은 token_count 줄에서 숫자만 읽는다', () => {
  const RESET_5H = 1_795_000_000;
  const RESET_WEEK = 1_795_500_000;
  /** 현재 codex(0.162)의 token_count 꼴: rate_limits.primary·secondary의 used_percent·window_minutes·resets_at(epoch 초) */
  const withLimits = (limits: unknown, total = { input_tokens: 1_000, cached_input_tokens: 750 }) =>
    JSON.stringify({
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { total_token_usage: { ...total, output_tokens: 10, total_tokens: 1_010 }, last_token_usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 }, model_context_window: 400_000 },
        rate_limits: limits,
      },
    });
  const both = { primary: { used_percent: 12.5, window_minutes: 300, resets_at: RESET_5H }, secondary: { used_percent: 40, window_minutes: 10_080, resets_at: RESET_WEEK } };

  it('창은 슬롯 이름이 아니라 창 길이(300분·10080분)로 가른다. resets_at은 ISO로 바꾼다', async () => {
    await rollout('2026-11-27', THREAD, [meta, withLimits(both)]);
    const read = await createCodexRolloutReader().readAll(home, THREAD);
    expect(read?.usage).toEqual({
      fiveHour: { usedPct: 12.5, resetsAt: new Date(RESET_5H * 1000).toISOString() },
      sevenDay: { usedPct: 40, resetsAt: new Date(RESET_WEEK * 1000).toISOString() },
      cacheHitRatio: 0.75,
    });
    // 슬롯이 바뀌어도(주간이 primary) 길이로 가른다
    await rollout('2026-11-28', OTHER, [withLimits({ primary: both.secondary, secondary: both.primary })]);
    expect((await createCodexRolloutReader().readAll(home, OTHER))?.usage?.fiveHour?.usedPct).toBe(12.5);
  });

  it('모르는 창 길이·범위 밖 값·resets_at이 없는 창은 싣지 않고, 입력이 0이면 캐시도 싣지 않는다', async () => {
    await rollout('2026-11-27', THREAD, [
      withLimits({ primary: { used_percent: 12, window_minutes: 60, resets_at: RESET_5H }, secondary: { used_percent: 250, window_minutes: 10_080, resets_at: RESET_WEEK } }, { input_tokens: 0, cached_input_tokens: 0 }),
    ]);
    const read = await createCodexRolloutReader().readAll(home, THREAD);
    expect(read?.usage).toBeUndefined();
    expect(read?.context).toEqual({ usedPct: 0, used: 110, size: 400_000 });
    await rollout('2026-11-28', OTHER, [withLimits({ primary: { used_percent: 12, window_minutes: 300 } })]);
    expect((await createCodexRolloutReader().readAll(home, OTHER))?.usage).toEqual({ cacheHitRatio: 0.75 });
  });

  it('결과에 대화 내용이 새지 않는다', async () => {
    await rollout('2026-11-27', THREAD, [meta, message(SECRET), withLimits(both)]);
    expect(JSON.stringify(await createCodexRolloutReader().readAll(home, THREAD))).not.toContain('비밀');
  });
});
