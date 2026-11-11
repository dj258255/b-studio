/**
 * 계정 목록 벡터 생성기(ADR-195 4d). 기대값은 옛 TS(`listAiAccounts` 그대로)가 만든다. 파일 글 하나마다 임시 설정 폴더에 `accounts.json`을 쓰고
 * 목록을 읽어 `JSON.stringify({ accounts })`(성공) 또는 던진 오류(error)를 `accounts-vectors.json`에 적는다.
 * Rust(tests/accounts_vectors.rs)가 같은 글을 `routes::ai_accounts::render`로 견준다.
 *
 * 실행(저장소 루트): pnpm exec tsx crates/bstudio-server/tests/vectors/gen-accounts-vectors.ts
 * 씨앗이 고정이다. 임시 폴더만 쓴다
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listAiAccounts } from '../../../../apps/studio/lib/server/ai-accounts';

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(Number(process.env.VECTOR_SEED ?? 1154));
const int = (n: number) => Math.floor(rand() * n);
const pick = <T>(items: readonly T[]): T => items[int(items.length)]!;
const COUNT = Number(process.env.VECTOR_COUNT ?? 6000);
const OUT = process.env.VECTOR_OUT ?? path.join(import.meta.dirname, 'accounts-vectors.json');

const BACKENDS_ALL = ['claude-code', 'codex', 'commandcode', 'opencode', 'gemini'] as const;
const CHARS = ['a', 'b', 'Z', '0', '9', '-', '_', '.', '/', '\\', ' ', '\t', '\n', '\u0001', '\u007f', '\u0085', ' ', '﻿', 'é', '한', '😀', 'ſ', 'ı', 'p', 'n', 'g', 'i', 'f', '"', "'"];
const randomString = (max: number) => Array.from({ length: int(max) }, () => pick(CHARS)).join('');
const sprites = (): string => {
  const kind = int(8);
  const ext = pick(['.png', '.gif', '.PNG', '.Gif', '.jpg', '.png ', '.png\n', '']);
  if (kind === 0) return `${randomString(6)}${ext}`;
  if (kind === 1) return `${'x'.repeat(int(130))}${ext}`;
  if (kind === 2) return `${Array.from({ length: int(6) }, () => 'd'.repeat(int(68))).join('/')}/a${ext}`;
  if (kind === 3) return `${pick(['a', '.a', '..', 'a b', ''])}/${pick(['b', '.b', 'b\\c'])}/${randomString(4)}${ext}`;
  if (kind === 4) return pick(['a.png', 'pokemon/25.gif', 'a/b/c/d.png', 'a/b/c/d/e.png', '.png', 'a..png', 'a//b.png', '/a.png']);
  return `${randomString(10)}${ext}`;
};
const ids = (): string => pick(['claude-code', 'codex', 'gemini', 'acct-1234abcd', 'a', '0', '-a', 'A', 'a_b', 'x'.repeat(40), 'x'.repeat(41), '', 'acct-é', 'a\n']);
const configDirs = (): unknown => pick(['/home/x/.claude-work', '/', 'rel', '', '~/x', null, 5, '/a/\u0001', '/한']);
const names = (): unknown => pick(['기본', '업무', ' ', '', '\u0085', '﻿', ' ', ' x ', 'a"b', 'a\\b', ' ', 'x\u0000y', 5, null]);

function entry(): Record<string, unknown> {
  const e: Record<string, unknown> = {};
  if (int(30)) e.id = ids();
  if (int(30)) e.name = names();
  if (int(20)) e.backend = int(12) ? pick(BACKENDS_ALL) : pick(['api', 'demo', '', 5, null]);
  if (int(3) === 0) e.configDir = configDirs();
  if (int(3) === 0) e.sprite = int(10) ? sprites() : pick([null, 5, '', undefined]);
  if (int(10) === 0) e.extra = { nested: [1, 2] };
  return e;
}

function fileText(): string | undefined {
  const kind = int(40);
  if (kind === 0) return undefined;
  if (kind === 1) return pick(['', '{', '[]', 'null', '{"accounts":{}}', '{"accounts":null}', '﻿{"accounts":[]}', '{"accounts":[]} x', '{"accounts":[],"accounts":[{"id":"a","name":"x","backend":"codex"}]}', '{"accounts":[1e999]}', '{"accounts":[{"id":"a","name":"\\ud800","backend":"codex"}]}']);
  const count = int(6);
  const list = Array.from({ length: count }, () => (int(25) ? entry() : pick([1, null, 'x', [], [{}]])));
  const text = JSON.stringify({ accounts: list }, null, int(2) ? 2 : 0);
  // 같은 키가 둘인 경우를 섞는다
  return int(15) === 0 ? text.replace('"id"', '"id":"zzz","id"') : text;
}

// 올바른 항목이 많이 나오도록 틀린 부분을 줄인 항목도 섞는다
function goodEntry(): Record<string, unknown> {
  const e: Record<string, unknown> = { id: pick(['claude-code', 'codex', 'acct-1234abcd', 'acct-aaaa0000', 'gemini']), name: pick(['업무', 'x', ' y ', 'a"b\\c', 'x ']), backend: pick(BACKENDS_ALL) };
  if (int(2)) e.configDir = '/home/x/.work';
  if (int(2)) e.sprite = pick(['a.png', 'pokemon/25.gif', 'A/B.GIF', `${'x'.repeat(124)}.png`, `${'d'.repeat(64)}/a.png`, 'a.b.png']);
  return e;
}

const root = mkdtempSync(path.join(tmpdir(), 'accvec-'));
const cases: unknown[] = [];
try {
  for (let i = 0; i < COUNT; i++) {
    const text = int(3) === 0 ? JSON.stringify({ accounts: Array.from({ length: 1 + int(4) }, goodEntry) }) : fileText();
    const backends = BACKENDS_ALL.filter(() => int(3) !== 0);
    const dir = path.join(root, String(i));
    mkdirSync(path.join(dir, 'b-studio'), { recursive: true });
    if (text !== undefined) writeFileSync(path.join(dir, 'b-studio', 'accounts.json'), text);
    let expected: { ok: string } | { error: true };
    try {
      expected = { ok: JSON.stringify({ accounts: await listAiAccounts({ XDG_CONFIG_HOME: dir, HOME: '/nonexistent' }, backends) }) };
    } catch {
      expected = { error: true };
    }
    cases.push({ text: text ?? null, backends, ...expected });
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
writeFileSync(OUT, `${JSON.stringify(cases)}\n`);
console.log(`${cases.length}개를 ${OUT}에 썼습니다`);
