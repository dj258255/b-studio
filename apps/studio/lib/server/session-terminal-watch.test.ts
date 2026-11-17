import { findUnhookedCliOrUnknown, type HostCliKind, type ProcessEntry } from '@b-studio/sandbox';
import { readHookBody } from '@b-studio/agent';
import { describe, expect, it } from 'vitest';
import { legacyFindUnhookedCli, legacyHookInput, legacyWatchRound, newLegacyWatchState, type LegacyRoundInput } from './session-terminal-watch-legacy';
import { newWatchState, watchRound, watchView, type WatchFileCheck, type WatchPsCheck } from './session-terminal-watch';

/**
 * 감시 판정을 코어(Rust)로 옮긴 것(ADR-219, 4f B5e)의 차등 시험. 기준은 옛 구현(`session-terminal-watch-legacy.ts`)이다.
 * 무작위 입력은 시드를 고정한 생성기라 다시 돌려도 같다. 옛 판정과 다른 칸은 모두 닫는 쪽이어야 하고, 어떤 칸인지 센다.
 */

/** mulberry32 */
function rng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(random: () => number, items: readonly T[]): T => items[Math.floor(random() * items.length)]!;

const SETTINGS = '/home/kim/.cache/b-studio/agent-gateway/studio-a/settings.json';
const CLI = '/home/kim/.local/bin/claude';
const MARKER = `--settings ${SETTINGS}`;
const CODEX_ROOT = '/home/kim/.cache/b-studio/agent-gateway';

const CLAUDE_ARGS = [
  '/bin/zsh -l -i',
  '/bin/sh /g/bin/claude --settings x',
  `${CLI} --resume`,
  `${CLI} --mcp-config /m/mcp.json ${MARKER} -p hi`,
  `${CLI} ${MARKER}`,
  `${CLI} ${MARKER}x`,
  `${CLI} ${MARKER}/evil.json`,
  `${CLI} x${MARKER}`,
  `${CLI} ${MARKER} --settings /evil.json`,
  `${CLI} --settings=/evil.json ${MARKER}`,
  `${CLI} -p "${MARKER}"`,
  `${CLI} explain --settings`,
  'node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js',
  `node /usr/lib/node_modules/@anthropic-ai/claude-code/cli.js ${MARKER}`,
  'claude',
  '  claude --x',
  ' claude',
  '/usr/bin/claudex',
  '/usr/bin/vim notes.txt',
  '',
  '/',
  `${CLI}\t${MARKER}\t`,
  `${CLI}　${MARKER}　-p`,
];
const CODEX_ARGS = [
  '/bin/zsh',
  '/opt/bin/codex',
  `/opt/bin/codex -c hooks.PreToolUse=node ${CODEX_ROOT}/b-studio-codex-hook.mjs pre-tool`,
  `/opt/bin/codex -c x=${CODEX_ROOT}/b-studio-codex-hook.mjsx`,
  'node /usr/lib/node_modules/@openai/codex/bin/codex.js',
  '/usr/bin/codexy',
];

function randomTree(random: () => number, args: readonly string[]): { root: number; processes: ProcessEntry[] } {
  const count = 1 + Math.floor(random() * 40);
  const pids: number[] = [];
  // pid는 서로 다르다(한 목록에 같은 pid가 둘일 수 없다)
  while (pids.length < count) {
    const pid = 2 + Math.floor(random() * 300);
    if (!pids.includes(pid)) pids.push(pid);
  }
  const processes = pids.map((pid, index) => {
    // 대체로 앞선 프로세스의 자식, 가끔 아무 프로세스나(고리 포함), 가끔 0·1
    const roll = random();
    const ppid = roll < 0.7 && index > 0 ? pids[Math.floor(random() * index)]! : roll < 0.85 ? pick(random, pids) : pick(random, [0, 1, 1, 2]);
    return { pid, ppid, args: pick(random, args) };
  });
  const root = random() < 0.1 ? pick(random, [0, 1, -3]) : pick(random, pids);
  return { root, processes };
}

describe('findUnhookedCli: 옛 판정과의 차등', () => {
  it('claude: 옛 판정이 찾은 것은 모두 찾고(순서 같다), 더 찾은 것은 표식 대조를 좁혀서뿐이며, 루트 pid가 2보다 작으면 할 수 없음이다', () => {
    const random = rng(20261118);
    const counts = { cases: 0, same: 0, wider: 0, unknownRoot: 0 };
    const extraArgs = new Set<string>();
    for (let i = 0; i < 6000; i += 1) {
      const { root, processes } = randomTree(random, CLAUDE_ARGS);
      const expected = { settingsPath: SETTINGS, cliPath: CLI, kind: 'claude' as HostCliKind };
      const next = findUnhookedCliOrUnknown(root, processes, expected);
      counts.cases += 1;
      if (root < 2) {
        expect(next).toBeUndefined();
        counts.unknownRoot += 1;
        continue;
      }
      const old = legacyFindUnhookedCli(root, processes, expected);
      const oldPids = old.map((entry) => entry.pid);
      const nextPids = next!.map((entry) => entry.pid);
      // 옛 판정이 찾은 것은 모두 찾는다. 공통 부분의 순서도 같다
      const rest = [...nextPids];
      for (const pid of oldPids) {
        const at = rest.indexOf(pid);
        expect(at, `옛 판정이 찾은 pid ${pid}를 놓쳤습니다`).toBeGreaterThanOrEqual(0);
        rest.splice(0, at + 1);
      }
      if (nextPids.length === oldPids.length) counts.same += 1;
      else {
        counts.wider += 1;
        for (const pid of nextPids) if (!oldPids.includes(pid)) extraArgs.add(processes.find((entry) => entry.pid === pid)!.args);
      }
    }
    // 옛 판정과 다른 칸: 표식 글은 인자에 있지만 낱말 경계가 아니거나 --settings가 둘 이상이다(모두 더 찾는 쪽)
    for (const args of extraArgs) {
      const hasMarker = args.includes(MARKER);
      const settingsWords = args.split(/\s+/).filter((word) => word === '--settings' || word.startsWith('--settings=')).length;
      expect(hasMarker && (!new RegExp(`(^|\\s)${MARKER.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}(\\s|$)`).test(args) || settingsWords !== 1), args).toBe(true);
    }
    expect(counts.cases).toBe(6000);
    expect(counts.wider).toBeGreaterThan(0);
    expect(counts.same).toBeGreaterThan(1000);
    expect(counts.unknownRoot).toBeGreaterThan(100);
    // 사례 수와 다른 칸의 종류는 PR 본문에 적는다
    expect({ ...counts, extraKinds: [...extraArgs].sort() }).toMatchObject({ cases: 6000 });
  });

  it('codex: 옛 판정과 똑같다(루트 pid가 2 이상일 때)', () => {
    const random = rng(7);
    let compared = 0;
    for (let i = 0; i < 4000; i += 1) {
      const { root, processes } = randomTree(random, CODEX_ARGS);
      if (root < 2) continue;
      const expected = { settingsPath: `${CODEX_ROOT}/studio-a`, cliPath: '/opt/bin/codex', kind: 'codex' as HostCliKind };
      expect(findUnhookedCliOrUnknown(root, processes, expected)?.map((entry) => entry.pid)).toEqual(legacyFindUnhookedCli(root, processes, expected).map((entry) => entry.pid));
      compared += 1;
    }
    expect(compared).toBeGreaterThan(3000);
  });

  it('옛 판정은 루트 pid 0에서 이 컴퓨터의 모든 프로세스를 훑었다(N20)', () => {
    const processes = [
      { pid: 1, ppid: 0, args: '/sbin/launchd' },
      { pid: 900, ppid: 1, args: `${CLI} --resume` },
    ];
    const expected = { settingsPath: SETTINGS, cliPath: CLI };
    expect(legacyFindUnhookedCli(0, processes, expected).map((entry) => entry.pid)).toEqual([900]);
    expect(findUnhookedCliOrUnknown(0, processes, expected)).toBeUndefined();
  });
});

// ── 감시 상태 전이 ──

function randomFile(random: () => number): WatchFileCheck {
  const roll = random();
  if (roll < 0.25) return { kind: 'failed' };
  if (roll < 0.6) return { kind: 'clean' };
  if (roll < 0.85) return { kind: 'changed', names: ['settings.json'] };
  return { kind: 'changed', names: ['mcp.json', 'settings.json'], restoreError: 'EACCES' };
}

function randomPs(random: () => number): WatchPsCheck {
  const roll = random();
  if (roll < 0.1) return { kind: 'unavailable' };
  if (roll < 0.35) return { kind: 'failed' };
  const pids = [101, 102, 103, 104].filter(() => random() < 0.35);
  return { kind: 'listed', pids };
}

const legacyInput = (file: WatchFileCheck, ps: WatchPsCheck): LegacyRoundInput => ({
  file: file.kind === 'changed' ? { kind: 'changed', names: file.names, ...(file.restoreError !== undefined ? { restoreError: file.restoreError } : {}) } : { kind: file.kind },
  ps: ps.kind === 'unavailable' ? undefined : ps.kind === 'failed' ? 'failed' : ps.pids,
});

const multiset = (items: string[]): Map<string, number> => {
  const map = new Map<string, number>();
  for (const item of items) map.set(item, (map.get(item) ?? 0) + 1);
  return map;
};

describe('감시 상태 전이: 옛 판정과의 차등', () => {
  it('무작위 검사 결과 열: 옛 판정이 알린 글은 모두 알리고, 더 알리는 것은 닫는 쪽(되풀이 알림과 pid를 모르는 알림)뿐이다', () => {
    const random = rng(424242);
    const extras = new Set<string>();
    let rounds = 0;
    let identical = 0;
    for (let sequence = 0; sequence < 1500; sequence += 1) {
      let state = newWatchState('claude');
      const legacy = newLegacyWatchState();
      const length = 1 + Math.floor(random() * 30);
      for (let step = 0; step < length; step += 1) {
        const file = randomFile(random);
        const ps = randomPs(random);
        const old = legacyWatchRound(legacy, legacyInput(file, ps), 'claude');
        const round = watchRound(state, file, ps);
        state = round.state;
        rounds += 1;
        const have = multiset(round.reports);
        for (const [text, count] of multiset(old)) expect(have.get(text) ?? 0, `옛 판정의 알림을 놓쳤습니다: ${text}`).toBeGreaterThanOrEqual(count);
        if (round.reports.length === old.length) identical += 1;
        const left = multiset(old);
        for (const text of round.reports) {
          if ((left.get(text) ?? 0) > 0) left.set(text, left.get(text)! - 1);
          else extras.add(text.replace(/pid \d+/, 'pid N'));
        }
      }
    }
    expect(rounds).toBeGreaterThan(20_000);
    expect(identical).toBeGreaterThan(10_000);
    // 다른 칸의 글은 이 넷뿐이다
    expect([...extras].sort()).toEqual(
      [
        '검증이 붙지 않은 CLI가 터미널에서 돌고 있습니다(pid N). 이 터미널의 claude는 b-studio가 붙여 주는 설정으로 띄워야 합니다',
        '관문 파일을 확인하지 못했습니다',
        '터미널의 프로세스 번호를 알 수 없어 훅 없이 뜬 CLI를 확인하지 못합니다',
        '터미널의 프로세스를 확인하지 못했습니다',
      ].sort(),
    );
  });

  it('되풀이가 없는 열(검사가 성공하고 pid가 늘기만 한다)은 알림이 옛 판정과 똑같다', () => {
    const random = rng(99);
    for (let sequence = 0; sequence < 800; sequence += 1) {
      let state = newWatchState('claude');
      const legacy = newLegacyWatchState();
      const seen = new Set<number>();
      for (let step = 0; step < 20; step += 1) {
        const file = ((): WatchFileCheck => {
          const roll = random();
          return roll < 0.5 ? { kind: 'clean' } : roll < 0.8 ? { kind: 'changed', names: ['settings.json'] } : { kind: 'changed', names: ['settings.json'], restoreError: 'EACCES' };
        })();
        if (random() < 0.4) seen.add(pick(random, [101, 102, 103, 104]));
        const ps: WatchPsCheck = { kind: 'listed', pids: [...seen].sort() };
        const old = legacyWatchRound(legacy, legacyInput(file, ps), 'claude');
        const round = watchRound(state, file, ps);
        state = round.state;
        expect(round.reports).toEqual(old);
      }
    }
  });

  it('건강과 살아 있는 위반은 마지막 검사 결과로만 정해진다(무작위 열을 간단한 모델과 견준다)', () => {
    const random = rng(31337);
    for (let sequence = 0; sequence < 1500; sequence += 1) {
      let state = newWatchState('claude');
      let lastFile: WatchFileCheck | undefined;
      let lastPs: WatchPsCheck | undefined;
      let listed: number[] = [];
      let fileFailures = 0;
      let psFailures = 0;
      const length = 1 + Math.floor(random() * 25);
      for (let step = 0; step < length; step += 1) {
        const file = randomFile(random);
        const ps = randomPs(random);
        state = watchRound(state, file, ps).state;
        lastFile = file;
        lastPs = ps;
        fileFailures = file.kind === 'failed' ? fileFailures + 1 : 0;
        if (ps.kind === 'failed') psFailures += 1;
        if (ps.kind === 'listed') {
          psFailures = 0;
          listed = ps.pids;
        }
        const view = watchView(state);
        const fileOk = lastFile.kind === 'clean' || (lastFile.kind === 'changed' && lastFile.restoreError === undefined);
        const psOk = lastPs.kind === 'listed';
        expect(view.problems.length === 0).toBe(fileOk && psOk);
        // 되돌리지 못한 파일·연달아 실패한 검사·훅 없는 CLI가 살아 있는 위반이다
        const liveCount = (lastFile.kind === 'changed' && lastFile.restoreError !== undefined ? 1 : 0) + (fileFailures >= 3 ? 1 : 0) + (psFailures >= 3 ? 1 : 0) + listed.length;
        expect(view.live.length).toBe(liveCount);
      }
    }
  });
});

// ── 훅 본문 읽기 ──

const GOOD_OBJECTS = ['{}', '{"a":1}', '{"tool_name":"Write","tool_input":{"file_path":"a","content":"x"}}', '{"a":{"b":[1,2,{"c":null}]},"d":"\\u00e9"}', '{"a":"\\ud800"}', '{"a":1,"a":2}', '{"n":12345678901234567890123}', '{"s":"\\ud83d\\ude00"}', ' \n\t{"a":true}\r\n'];
const BAD_BODIES: Array<Buffer | string> = [
  '',
  ' ',
  '{',
  '{"a":}',
  '[]',
  '[1,2]',
  'null',
  'true',
  '12',
  '"x"',
  '{} x',
  "{'a':1}",
  '{"a":1,}',
  '﻿{}',
  Buffer.from([0x7b, 0xff, 0x7d]),
  Buffer.from('{"a":"'),
  '{"a":01}',
  '{"a":"\\x"}',
  '{"a":"\n"}',
  ' {}',
  '{"a":NaN}',
];

function randomBody(random: () => number): Buffer {
  const roll = random();
  if (roll < 0.3) return Buffer.from(pick(random, GOOD_OBJECTS));
  if (roll < 0.5) {
    const bad = pick(random, BAD_BODIES);
    return Buffer.from(bad);
  }
  // 좋은 본문을 바이트 단위로 망가뜨린다
  const bytes = Buffer.from(pick(random, GOOD_OBJECTS));
  const out = Buffer.from(bytes);
  const edits = 1 + Math.floor(random() * 3);
  for (let i = 0; i < edits && out.length > 0; i += 1) {
    const at = Math.floor(random() * out.length);
    const mode = random();
    if (mode < 0.4) out[at] = Math.floor(random() * 256);
    else if (mode < 0.7) return out.subarray(0, at);
    else return Buffer.concat([out.subarray(0, at), Buffer.from([Math.floor(random() * 256)]), out.subarray(at)]);
  }
  return out;
}

describe('훅 본문 읽기: 옛 판정과의 차등(N18)', () => {
  it('무작위 바이트: 객체로 읽은 것은 옛 입력과 값이 같고, 옛 판정이 읽은 것을 읽지 못함으로 바꾸는 칸은 거절 쪽이다', () => {
    const random = rng(8128);
    const counts = { cases: 0, object: 0, empty: 0, notObject: 0, invalid: 0, oldReadButRejected: 0 };
    const rejectedCells = new Set<string>();
    for (let i = 0; i < 8000; i += 1) {
      const body = randomBody(random);
      const old = legacyHookInput(body);
      const next = readHookBody(body);
      counts.cases += 1;
      if (next.kind === 'object') {
        counts.object += 1;
        expect(next.input).toEqual(old);
      } else {
        expect(next.input).toEqual({});
        if (next.kind === 'empty') counts.empty += 1;
        else if (next.kind === 'not_object') counts.notObject += 1;
        else counts.invalid += 1;
        // 옛 판정은 읽지 못한 본문을 `{}`로 두었다. 읽은 본문(`{}`가 아닌 객체)을 읽지 못함으로 보면 거절 쪽으로 다른 칸이다
        if (Object.keys(old).length > 0) {
          counts.oldReadButRejected += 1;
          rejectedCells.add(body.toString('utf8').slice(0, 60));
        }
      }
    }
    expect(counts.object).toBeGreaterThan(1500);
    expect(counts.invalid).toBeGreaterThan(500);
    expect(counts.notObject).toBeGreaterThan(100);
    expect(counts.empty).toBeGreaterThan(10);
    // 옛 판정이 객체로 읽는 본문을 읽지 못함으로 바꾸는 칸이 있다면 목록으로 남긴다(없어야 한다: 같은 문법이다)
    expect([...rejectedCells]).toEqual([]);
  });

  it('고정한 표: 읽지 못하는 본문은 종류가 갈리고 입력은 {}다', () => {
    const kinds = new Map<string, string>([
      ['', 'empty'],
      ['{}', 'object'],
      ['[]', 'not_object'],
      ['null', 'not_object'],
      ['"x"', 'not_object'],
      ['not json', 'invalid'],
      [' ', 'invalid'],
      ['﻿{}', 'invalid'],
      ['{"a":"\\ud800"}', 'object'],
    ]);
    for (const [body, kind] of kinds) expect(readHookBody(Buffer.from(body)).kind, JSON.stringify(body)).toBe(kind);
  });
});
