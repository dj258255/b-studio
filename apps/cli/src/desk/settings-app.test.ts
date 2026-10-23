/**
 * desk에 붙은 설정 화면(#890): Ctrl-b g로 열고, 스튜디오 API·desk.json·그림 폴더와 주고받는 것을 가짜로 본다
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StudioRequestError } from './client';
import type { DeskConfig } from './config';
import { DeskApp, type DeskClient, type DeskIo, type SettingsHost, type SpriteCatalog } from './desk';
import { stripAnsi } from './screen';
import { spriteFromRows, type Sprite } from './sprite';
import type { DeskAccount, DeskAccountStatus, DeskItem, DeskLoginProgress, DeskLoginStart, DeskRules } from './types';

const item = (id: string, patch: Partial<DeskItem> = {}): DeskItem => ({ kind: 'session', id, title: `요청 ${id}`, projectName: 'shop', state: 'idle', backend: 'claude-code', lastActivityAt: '2026-10-23T00:00:00Z', ...patch });

class FakeIo implements DeskIo {
  out: string[] = [];
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
  setRaw() {}
  type(chunk: string) {
    this.#input(chunk);
  }
}

/** 화면 한 장: 쓴 출력에서 줄 자리 이동을 따라 마지막 글을 모은다 */
function screenText(io: FakeIo): string {
  const rows: string[] = [];
  for (const chunk of io.out) {
    for (const match of chunk.matchAll(/\x1b\[(\d+);1H([^\x1b]*(?:\x1b(?!\[\d+;1H)[^\x1b]*)*)/g)) rows[Number(match[1]) - 1] = stripAnsi(match[2]!);
  }
  return rows.join('\n');
}

class FakeClient implements DeskClient {
  accountList: DeskAccount[] = [
    { id: 'claude-code', name: '기본', backend: 'claude-code', builtin: true },
    { id: 'acct-1a2b3c4d', name: '피오', backend: 'claude-code', configDir: '/h/.b-studio/accounts/claude-code-1', sprite: 'pokemon/25.gif' },
  ];
  rulesValue: DeskRules = { rules: [{ when: {}, backend: 'claude-code' }] };
  saveError: Error | undefined;
  addError: Error | undefined;
  calls: string[] = [];
  loginStart: DeskLoginStart = { spawnable: true, progress: { state: 'running', lines: ['브라우저를 여세요'], url: 'https://claude.ai/oauth/x', code: 'ABCD-1234' } };
  loginNext: DeskLoginProgress = { state: 'exited', lines: [], exitCode: 0, status: { connected: true, installed: true } };
  constructor(readonly items: DeskItem[]) {}
  async agents() {
    return { items: this.items };
  }
  async projects() {
    return [{ id: 'p1', name: 'shop' }];
  }
  async accounts() {
    this.calls.push('accounts');
    return this.accountList;
  }
  async rules() {
    this.calls.push('rules');
    return { rules: this.rulesValue, allowed: ['claude-code', 'codex'], defaultBackend: 'claude-code' };
  }
  async preview(request: string) {
    this.calls.push(`preview ${request}`);
    return { backend: 'codex', rule: 0, matched: '"테스트" 포함' };
  }
  async start(): Promise<never> {
    throw new Error('쓰지 않는다');
  }
  async open() {}
  async resize() {}
  async input() {}
  async stop() {}
  async resume() {}
  async rename() {}
  stream(_ids: readonly string[], _on: unknown, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => signal.addEventListener('abort', () => resolve()));
  }
  async addAccount(input: { name: string; backend: string; configDir: string }): Promise<DeskAccount> {
    this.calls.push(`add ${input.name} ${input.backend} ${input.configDir}`);
    if (this.addError) throw this.addError;
    const account = { id: 'acct-new00001', name: input.name, backend: input.backend, configDir: `/h/${input.configDir.slice(2)}` };
    this.accountList = [...this.accountList, account];
    return account;
  }
  async updateAccount(id: string, patch: { name?: string; sprite?: string }): Promise<DeskAccount> {
    this.calls.push(`update ${id} ${JSON.stringify(patch)}`);
    this.accountList = this.accountList.map((account) => {
      if (account.id !== id) return account;
      const next: DeskAccount = { ...account, ...(patch.name ? { name: patch.name } : {}) };
      if ('sprite' in patch) {
        delete next.sprite;
        if (patch.sprite) next.sprite = patch.sprite;
      }
      return next;
    });
    return this.accountList.find((account) => account.id === id)!;
  }
  async removeAccount(id: string) {
    this.calls.push(`remove ${id}`);
    this.accountList = this.accountList.filter((account) => account.id !== id);
  }
  async accountStatus(id: string): Promise<DeskAccountStatus> {
    this.calls.push(`status ${id}`);
    return id === 'claude-code' ? { connected: true, installed: true, accountKind: 'Max 구독' } : { connected: false, installed: true, reason: '로그인이 필요합니다' };
  }
  async startLogin(id: string): Promise<DeskLoginStart> {
    this.calls.push(`login ${id}`);
    return this.loginStart;
  }
  async loginProgress(id: string): Promise<DeskLoginProgress> {
    this.calls.push(`progress ${id}`);
    return this.loginNext;
  }
  async cancelLogin(id: string): Promise<DeskLoginProgress> {
    this.calls.push(`cancel ${id}`);
    return { state: 'cancelled', lines: [] };
  }
  async saveRules(rules: DeskRules): Promise<DeskRules> {
    this.calls.push(`save ${JSON.stringify(rules)}`);
    if (this.saveError) throw this.saveError;
    this.rulesValue = rules;
    return rules;
  }
}

const pikachu = spriteFromRows(['yy', 'yy'], { y: '#f9e2af' });
const bulbasaur = spriteFromRows(['gg', 'gg'], { g: '#a6e3a1' });
const files: Record<string, Sprite> = { 'pokemon/25.gif': pikachu, 'pokemon/1.gif': bulbasaur };

function host(client: FakeClient, config: DeskConfig = {}) {
  const saved: DeskConfig[] = [];
  const opened: string[] = [];
  const value: SettingsHost & { saved: DeskConfig[]; opened: string[] } = {
    client,
    saved,
    opened,
    loadConfig: () => config,
    saveConfig: (patch) => {
      saved.push(patch);
    },
    spriteFiles: () => Object.keys(files).sort(),
    readSprite: (file) => {
      const sprite = files[file];
      if (!sprite) throw new Error('없는 그림');
      return sprite;
    },
    openUrl: (url) => {
      opened.push(url);
    },
  };
  return value;
}

function setup(items: DeskItem[] = [item('a', { accountId: 'acct-1a2b3c4d' } as Partial<DeskItem>), item('b')], options: { config?: DeskConfig; catalog?: SpriteCatalog } = {}) {
  const client = new FakeClient(items);
  const io = new FakeIo();
  const settings = host(client, options.config);
  const app = new DeskApp(client, items, io, { settings, accounts: client.accountList, ...(options.catalog ? { spriteCatalog: options.catalog } : {}) });
  const done = app.run();
  return { client, io, app, done, settings };
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

describe('설정 화면 열기(#890)', () => {
  it('Ctrl-b g로 열면 계정과 규칙을 받아 보이고, 계정마다 로그인 상태를 묻는다', async () => {
    const ctx = setup();
    ctx.io.type('\x02g');
    await tick();
    expect(ctx.client.calls).toEqual(expect.arrayContaining(['accounts', 'rules', 'status claude-code', 'status acct-1a2b3c4d']));
    const text = screenText(ctx.io);
    expect(text).toContain('설정');
    expect(text).toContain('피오');
    expect(text).toContain('로그인됨(Max 구독)');
    expect(text).toContain('로그인 필요');
    expect(text).toContain('a 더하기');
    // 설정 화면에서 친 글자는 칸으로 가지 않는다
    ctx.io.type('\x1b');
    await tick();
    expect(ctx.app.state.settings).toBeUndefined();
  });

  it('설정을 열 수 없는 desk(옛 스튜디오)면 알린다', async () => {
    const client = new FakeClient([item('a')]);
    const io = new FakeIo();
    const app = new DeskApp(client, [item('a')], io);
    void app.run();
    io.type('\x02g');
    await tick();
    expect(app.state.settings).toBeUndefined();
    expect(app.state.message).toContain('설정');
  });
});

describe('화면과 키 설정', () => {
  it('팔레트를 바꾸면 desk.json에 쓰고 바로 그 색으로 그린다', async () => {
    const ctx = setup();
    ctx.io.type('\x02g\t\t');
    await tick();
    ctx.io.type('\x1b[C');
    await tick();
    expect(ctx.settings.saved).toEqual([{ theme: 'light' }]);
    expect(ctx.app.state.theme?.name).toBe('light');
    expect(ctx.app.state.settings?.note).toContain('바로 적용');
  });

  it('앞글쇠를 바꾸면 바로 그 글쇠로 desk를 다룬다', async () => {
    const ctx = setup();
    ctx.io.type('\x02g\t\t\t');
    await tick();
    ctx.io.type('\x1b[D');
    await tick();
    expect(ctx.settings.saved).toEqual([{ prefix: { key: '\x01', label: 'Ctrl-a' } }]);
    ctx.io.type('\x1b');
    await tick();
    ctx.io.type('\x01g');
    await tick();
    expect(ctx.app.state.settings).toBeDefined();
  });

  it('다시 열어야 적용되는 값은 그렇게 알리고, 쓰지 못하면 까닭을 보인다', async () => {
    const ctx = setup();
    ctx.settings.saveConfig = () => {
      throw new Error('읽기 전용');
    };
    ctx.io.type('\x02g\t\t\x1b[B\x1b[B\r');
    await tick();
    expect(ctx.app.state.settings?.note).toContain('읽기 전용');
  });
});

describe('계정', () => {
  it('더하면 스튜디오에 보내고 목록을 다시 받아 새 계정을 고른다', async () => {
    const ctx = setup();
    ctx.io.type('\x02g');
    await tick();
    ctx.io.type('a');
    ctx.io.type('트레버');
    ctx.io.type('\t\x1b[C\r');
    await tick();
    expect(ctx.client.calls).toContain('add 트레버 codex ~/.b-studio/accounts/codex-1');
    const settings = ctx.app.state.settings!;
    expect(settings.accounts.map((account) => account.name)).toContain('트레버');
    expect(settings.accounts[settings.row]?.name).toBe('트레버');
    expect(settings.note).toContain('l로 로그인');
  });

  it('스튜디오가 거절하면 그 까닭을 보인다', async () => {
    const ctx = setup();
    ctx.client.addError = new StudioRequestError('설정 폴더는 홈 폴더 아래여야 합니다', 400);
    ctx.io.type('\x02g');
    await tick();
    ctx.io.type('a트레버\r');
    await tick();
    expect(ctx.app.state.settings?.note).toContain('홈 폴더 아래');
  });

  it('로그인은 주소와 코드를 보이고, 끝날 때까지 진행을 묻고, 끝나면 계정 상태를 바꾼다', async () => {
    const ctx = setup();
    ctx.io.type('\x02g');
    await tick();
    ctx.io.type('\x1b[Bl');
    await tick();
    expect(ctx.app.state.settings?.login).toMatchObject({ state: 'running', url: 'https://claude.ai/oauth/x', code: 'ABCD-1234' });
    expect(ctx.io.out.join('')).toContain('\x1b]8;;https://claude.ai/oauth/x\x07');
    ctx.io.type('o');
    await tick();
    expect(ctx.settings.opened).toEqual(['https://claude.ai/oauth/x']);
    await tick(1_600);
    expect(ctx.client.calls).toContain('progress acct-1a2b3c4d');
    expect(ctx.app.state.settings?.login).toMatchObject({ state: 'exited', connected: true });
    expect(ctx.app.state.settings?.accounts[1]?.status?.connected).toBe(true);
    // 끝났으면 더 묻지 않는다
    const asked = ctx.client.calls.filter((call) => call.startsWith('progress')).length;
    await tick(5_000);
    expect(ctx.client.calls.filter((call) => call.startsWith('progress')).length).toBe(asked);
  });

  it('대화형이라 대신 띄울 수 없는 CLI는 칠 명령을 보인다', async () => {
    const ctx = setup();
    ctx.client.loginStart = { spawnable: false, command: 'gemini', note: '터미널에서 실행하세요' };
    ctx.io.type('\x02g');
    await tick();
    ctx.io.type('\x1b[Bl');
    await tick();
    expect(ctx.app.state.settings?.login).toMatchObject({ state: 'manual', command: 'gemini' });
  });

  it('그림을 고르면 미리 보고, 바꾸면 그 계정 세션의 카드 그림이 바로 바뀐다', async () => {
    const random = spriteFromRows(['rr', 'rr'], { r: '#ff0000' });
    const catalog: SpriteCatalog = { pick: () => ({ sprite: random }), file: (file) => (files[file] ? { sprite: files[file] } : { warning: '없음' }) };
    const ctx = setup(undefined, { catalog });
    await tick();
    // 계정 그림(pokemon/25.gif)이 그 계정 세션(a)의 카드 그림이고, 계정이 없는 세션(b)은 무작위다
    expect(ctx.app.state.sprites?.a).toBe(pikachu);
    expect(ctx.app.state.sprites?.b).toBe(random);
    ctx.io.type('\x02g');
    await tick();
    ctx.io.type('\x1b[Bp');
    await tick();
    expect(ctx.app.state.settings?.previewSprite).toMatchObject({ file: 'pokemon/25.gif', sprite: pikachu });
    ctx.io.type('\x1b[A');
    await tick();
    expect(ctx.app.state.settings?.previewSprite).toMatchObject({ file: 'pokemon/1.gif', sprite: bulbasaur });
    ctx.io.type('\r');
    await tick();
    expect(ctx.client.calls).toContain('update acct-1a2b3c4d {"sprite":"pokemon/1.gif"}');
    ctx.io.type('\x1b');
    await tick();
    expect(ctx.app.state.sprites?.a).toBe(bulbasaur);
  });

  it('브라우저로 여는 주소는 http(s)만이다', async () => {
    const ctx = setup();
    ctx.client.loginStart = { spawnable: true, progress: { state: 'running', lines: [], url: 'file:///etc/passwd' } };
    ctx.io.type('\x02g');
    await tick();
    ctx.io.type('\x1b[Bl');
    await tick();
    ctx.io.type('o');
    await tick();
    expect(ctx.settings.opened).toEqual([]);
    expect(ctx.app.state.settings?.note).toContain('http');
  });
});

describe('라우팅 규칙', () => {
  it('저장하면 서버에 보내고, 거절하면 까닭을 보이고 저장하지 않음을 남긴다', async () => {
    const ctx = setup();
    ctx.io.type('\x02g\t');
    await tick();
    ctx.io.type('a\r');
    await tick();
    ctx.client.saveError = new StudioRequestError('규칙 2: backend가 틀렸습니다', 400);
    ctx.io.type('s');
    await tick();
    expect(ctx.app.state.settings?.rulesError).toContain('규칙 2');
    expect(ctx.app.state.settings?.rulesDirty).toBe(true);
    ctx.client.saveError = undefined;
    ctx.io.type('s');
    await tick();
    expect(ctx.app.state.settings?.rulesDirty).toBe(false);
    expect(ctx.app.state.settings?.rulesError).toBeUndefined();
    expect(ctx.client.rulesValue.rules).toHaveLength(2);
  });

  it('미리보기는 서버가 고른 AI를 한 줄로 보인다', async () => {
    const ctx = setup();
    ctx.io.type('\x02g\t');
    await tick();
    ctx.io.type('t결제 테스트\r');
    await tick(400);
    expect(ctx.client.calls).toContain('preview 결제 테스트');
    expect(ctx.app.state.settings?.preview?.result).toContain('Codex');
  });
});
