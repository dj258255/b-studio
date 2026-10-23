/**
 * desk에 붙은 요구사항·문서 화면(#894): Ctrl-b e로 열고, 스튜디오 API·편집기·세션 터미널과 주고받는 것을 가짜로 본다
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudioRequestError } from './client';
import { DeskApp, type DeskClient, type DeskIo, type RequirementsHost } from './desk';
import { REQUIREMENTS_FILE } from './requirements';
import { stripAnsi } from './screen';
import type { DeskItem, DeskRequirements } from './types';

const item = (id: string, patch: Partial<DeskItem> = {}): DeskItem => ({ kind: 'session', id, title: `요청 ${id}`, projectName: 'shop', state: 'idle', backend: 'claude-code', lastActivityAt: '2026-10-23T00:00:00Z', ...patch });

class FakeIo implements DeskIo {
  out: string[] = [];
  raw: boolean[] = [];
  #input: (chunk: string) => void = () => {};
  write(data: string) {
    this.out.push(data);
  }
  size() {
    return { cols: 120, rows: 30 };
  }
  onInput(listener: (chunk: string) => void) {
    this.#input = listener;
  }
  onResize() {}
  setRaw(on: boolean) {
    this.raw.push(on);
  }
  type(chunk: string) {
    this.#input(chunk);
  }
}

function screenText(io: FakeIo): string {
  const rows: string[] = [];
  for (const chunk of io.out) {
    for (const match of chunk.matchAll(/\x1b\[(\d+);1H([^\x1b]*(?:\x1b(?!\[\d+;1H)[^\x1b]*)*)/g)) rows[Number(match[1]) - 1] = stripAnsi(match[2]!);
  }
  return rows.join('\n');
}

const snapshot: DeskRequirements = {
  exists: true,
  requirements: [
    { id: 'R1', title: '주문을 받는다', kind: 'api', priority: 'must', acceptance: ['POST /orders는 201로 답한다'], status: '미착수', workPrefill: '[R1] 주문을 받는다\n인수 조건을 지켜 작업해 줘' },
  ],
  coverage: { text: '1개 중 0개 검증됨' },
  assumptions: [],
  manualSteps: [],
};

class FakeClient implements DeskClient {
  calls: string[] = [];
  inputs: Array<{ id: string; data: string }> = [];
  files: Record<string, string> = { [REQUIREMENTS_FILE]: '# 요구사항\n\n## R1. 주문을 받는다\n' };
  saveError: Error | undefined;
  constructor(readonly items: DeskItem[]) {}
  async agents() {
    return { items: this.items };
  }
  async projects() {
    return [{ id: 'p1', name: 'shop' }];
  }
  async accounts() {
    return [];
  }
  async rules() {
    return { rules: { rules: [] }, allowed: ['claude-code'], defaultBackend: 'claude-code' };
  }
  async preview() {
    return { backend: 'claude-code', rule: 'default' as const, matched: '' };
  }
  async start(): Promise<never> {
    throw new Error('쓰지 않는다');
  }
  async open(id: string) {
    this.calls.push(`open ${id}`);
  }
  async resize() {}
  async input(id: string, data: string) {
    this.inputs.push({ id, data });
  }
  async stop() {}
  async resume() {}
  async rename() {}
  stream(_ids: readonly string[], _on: unknown, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve()));
  }
  async requirements(id: string) {
    this.calls.push(`requirements ${id}`);
    return snapshot;
  }
  async tests(id: string) {
    this.calls.push(`tests ${id}`);
    return { services: [], requirementsWithoutTests: [] };
  }
  async docs(id: string) {
    this.calls.push(`docs ${id}`);
    return Object.keys(this.files).map((path) => ({ path, title: path }));
  }
  async doc(id: string, path: string) {
    this.calls.push(`doc ${id} ${path}`);
    const content = this.files[path];
    if (content === undefined) throw new StudioRequestError('문서를 찾을 수 없습니다', 404);
    return content;
  }
  async saveDoc(id: string, path: string, content: string) {
    this.calls.push(`save ${id} ${path}`);
    if (this.saveError) throw this.saveError;
    this.files[path] = content;
  }
  async projectStatus(id: string): Promise<never> {
    this.calls.push(`status ${id}`);
    throw new Error('쓰지 않는다');
  }
  async verifyRequirement(id: string, requirementId: string, note: string) {
    this.calls.push(`verify ${id} ${requirementId} ${note}`);
    return { ...snapshot, requirements: snapshot.requirements.map((entry) => ({ ...entry, status: '검증됨' as const, verifiedBy: 'manual' as const })) };
  }
  async clearVerification(id: string, requirementId: string) {
    this.calls.push(`unverify ${id} ${requirementId}`);
    return snapshot;
  }
  async applyRequirements(id: string) {
    this.calls.push(`apply ${id}`);
    return snapshot;
  }
}

/** 편집기 자리: 받은 파일을 change로 고치고 code로 끝난다 */
function editorHost(change?: (text: string) => string, code = 0) {
  const seen: Array<{ file: string; content: string; raw: boolean[] }> = [];
  const host: RequirementsHost & { seen: typeof seen } = {
    seen,
    editor: (file) => {
      seen.push({ file, content: readFileSync(file, 'utf8'), raw: [] });
      if (change) writeFileSync(file, change(readFileSync(file, 'utf8')));
      return code;
    },
  };
  return host;
}

function setup(options: { change?: (text: string) => string; code?: number; oldStudio?: boolean; items?: DeskItem[] } = {}) {
  const items = options.items ?? [item('a', { title: '주문 모듈' }), item('b')];
  const client = new FakeClient(items);
  // 옛 손님: 요구사항 API를 모른다
  if (options.oldStudio) Object.assign(client, { requirements: undefined });
  const io = new FakeIo();
  const requirements = editorHost(options.change, options.code);
  const app = new DeskApp(client, items, io, { requirements });
  const done = app.run();
  return { client, io, app, done, requirements };
}

async function tick(ms = 50): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('요구사항 화면 열기(#894)', () => {
  it('Ctrl-b e는 고른 세션의 요구사항을 받아 보이고, 친 글자는 칸으로 보내지 않는다', async () => {
    const ctx = setup();
    ctx.io.type('\x02e');
    await tick();
    expect(ctx.client.calls).toContain('requirements a');
    const text = screenText(ctx.io);
    expect(text).toContain('요구사항');
    expect(text).toContain('주문을 받는다');
    expect(text).toContain('1개 중 0개 검증됨');
    ctx.io.type('j');
    await tick();
    expect(ctx.client.inputs).toEqual([]);
    ctx.io.type('\x1b');
    await tick();
    expect(ctx.app.state.requirements).toBeUndefined();
  });

  it('스페이스 화면에서는 앞글쇠 없이 e로 고른 카드의 요구사항을 연다', async () => {
    const ctx = setup();
    // 열린 칸이 없으면 처음부터 스페이스 화면이다
    expect(ctx.app.state.view).toBe('space');
    ctx.io.type('l');
    ctx.io.type('e');
    await tick();
    expect(ctx.client.calls).toContain('requirements b');
    expect(ctx.app.state.requirements?.sessionId).toBe('b');
  });

  it('요구사항 API를 모르는 옛 스튜디오면 알린다', async () => {
    const ctx = setup({ oldStudio: true });
    ctx.io.type('\x02e');
    await tick();
    expect(ctx.app.state.requirements).toBeUndefined();
    expect(ctx.app.state.message).toContain('요구사항');
  });

  it('세션이 없으면 열지 않는다', async () => {
    const ctx = setup({ items: [] });
    ctx.io.type('\x02e');
    await tick();
    expect(ctx.app.state.requirements).toBeUndefined();
  });
});

describe('이 요구사항으로 작업', () => {
  it('Enter는 화면을 닫고 세션을 칸에 연 뒤 작업 글을 줄바꿈 없이 넣는다(보내기는 사람이)', async () => {
    const ctx = setup();
    ctx.io.type('\x02e');
    await tick();
    ctx.io.type('\r');
    await tick(4_000);
    expect(ctx.app.state.requirements).toBeUndefined();
    expect(ctx.app.state.slots[ctx.app.state.focus]).toBe('a');
    expect(ctx.client.calls).toContain('open a');
    const sent = ctx.client.inputs.filter((entry) => entry.id === 'a').map((entry) => entry.data).join('');
    expect(sent).toContain('[R1] 주문을 받는다');
    expect(sent).toContain('인수 조건을 지켜 작업해 줘');
    expect(sent).not.toMatch(/\r/);
    expect(ctx.app.state.message).toContain('Enter');
  });
});

describe('편집기로 고치기', () => {
  it('e는 대체 화면을 나가 편집기로 docs/requirements.md를 열고, 고친 글을 저장한 뒤 다시 읽는다', async () => {
    const ctx = setup({ change: (text) => `${text}- 종류: api · 우선순위: must\n` });
    ctx.io.type('\x02e');
    await tick();
    const before = ctx.io.out.length;
    ctx.io.type('e');
    await tick();
    expect(ctx.requirements.seen).toHaveLength(1);
    expect(ctx.requirements.seen[0]!.content).toBe('# 요구사항\n\n## R1. 주문을 받는다\n');
    // 편집기 앞에서 화면과 raw 모드를 내려놓고, 뒤에서 되돌린다
    const after = ctx.io.out.slice(before).join('');
    expect(after.indexOf('\x1b[?1049l')).toBeGreaterThanOrEqual(0);
    expect(after.indexOf('\x1b[?1049h')).toBeGreaterThan(after.indexOf('\x1b[?1049l'));
    expect(ctx.io.raw.slice(-2)).toEqual([false, true]);
    expect(ctx.client.calls).toContain(`save a ${REQUIREMENTS_FILE}`);
    expect(ctx.client.files[REQUIREMENTS_FILE]).toContain('- 종류: api · 우선순위: must');
    expect(ctx.client.calls.filter((call) => call === 'requirements a')).toHaveLength(2);
    expect(existsSync(ctx.requirements.seen[0]!.file)).toBe(false);
    expect(ctx.app.state.requirements?.note).toContain('저장');
  });

  it('바꾸지 않았거나 편집기가 실패로 끝나면 저장하지 않는다', async () => {
    const same = setup();
    same.io.type('\x02e');
    await tick();
    same.io.type('e');
    await tick();
    expect(same.client.calls.some((call) => call.startsWith('save'))).toBe(false);
    expect(same.app.state.requirements?.note).toContain('바뀐 것이 없습니다');

    const failed = setup({ change: () => '바뀐 글', code: 1 });
    failed.io.type('\x02e');
    await tick();
    failed.io.type('e');
    await tick();
    expect(failed.client.calls.some((call) => call.startsWith('save'))).toBe(false);
    expect(failed.app.state.requirements?.note).toContain('편집기');
  });

  it('요구사항 문서가 없으면 틀을 채워 연다', async () => {
    const ctx = setup({ change: (text) => text.replace('첫 요구사항', '주문') });
    delete ctx.client.files[REQUIREMENTS_FILE];
    ctx.io.type('\x02e');
    await tick();
    ctx.io.type('e');
    await tick();
    expect(ctx.requirements.seen[0]!.content).toMatch(/^## R1\. /m);
    expect(ctx.client.calls).toContain(`save a ${REQUIREMENTS_FILE}`);
  });

  it('저장하지 못하면 고친 글을 파일로 남기고 그 자리를 알린다', async () => {
    const ctx = setup({ change: (text) => `${text}고침\n` });
    ctx.client.saveError = new StudioRequestError('요청을 처리하는 동안에는 요구사항 문서를 저장할 수 없습니다', 409);
    ctx.io.type('\x02e');
    await tick();
    ctx.io.type('e');
    await tick();
    const file = ctx.requirements.seen[0]!.file;
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, 'utf8')).toContain('고침');
    expect(ctx.app.state.requirements?.note).toContain(file);
    expect(ctx.app.state.requirements?.note).toContain('저장할 수 없습니다');
  });
});

describe('사람 확인', () => {
  it('v로 쓴 메모를 스튜디오에 남기고 받은 상태로 바꾼다', async () => {
    const ctx = setup();
    ctx.io.type('\x02e');
    await tick();
    ctx.io.type('v');
    ctx.io.type('손으로 확인');
    ctx.io.type('\r');
    await tick();
    expect(ctx.client.calls).toContain('verify a R1 손으로 확인');
    expect(ctx.app.state.requirements?.spec?.requirements[0]?.status).toBe('검증됨');
  });

  it('문서 탭에서 Enter로 문서를 받아 읽는다', async () => {
    const ctx = setup();
    ctx.io.type('\x02e');
    await tick();
    ctx.io.type('3');
    await tick();
    expect(ctx.client.calls).toContain('docs a');
    ctx.io.type('\r');
    await tick();
    expect(ctx.client.calls).toContain(`doc a ${REQUIREMENTS_FILE}`);
    expect(ctx.app.state.requirements?.reader?.content).toContain('주문을 받는다');
  });
});
