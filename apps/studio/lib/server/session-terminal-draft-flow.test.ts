import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentTerminal, TerminalSize } from '@b-studio/sandbox';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readDraftFile } from './session-terminal-draft';
import {
  closeSessionTerminal,
  disposeSessionTerminal,
  noteSessionTerminalCli,
  openSessionTerminal,
  sessionTerminalPresence,
  type TerminalBackend,
  type TerminalTarget,
} from './session-terminal';

/**
 * 쓰다 만 글의 저장·복원 흐름(ADR-237)을 세션 터미널 전체로 본다. 터미널은 가짜(실제 PTY를 열지 않는다):
 * 첫 터미널에서 입력창에 글이 남은 채 닫히고, 스튜디오를 다시 띄운 것(다른 세션 상태, 같은 파일)처럼 두 번째 터미널을 이어 붙여 연다
 */
const RULE = '─'.repeat(80);
const box = (text: string) => `\x1b[?2004h\x1b[2J\x1b[H${['', RULE, text === '' ? '❯' : `❯ ${text}`, RULE, '  ⏵⏵ auto mode on (shift+tab to cycle)'].join('\r\n')}`;
const DRAFT = 'README.md의 첫 줄만 읽어서 알려 줘';

class FakeTerminal implements AgentTerminal {
  written: string[] = [];
  #data: Array<(chunk: Buffer) => void> = [];
  #exit: Array<(code: number | null) => void> = [];
  constructor(
    readonly container: string,
    readonly id: string,
    readonly echo: boolean,
  ) {}
  write(data: string) {
    this.written.push(data);
    // CLI가 붙여 넣은 글을 입력창에 그리는 것
    const pasted = /^\x1b\[200~(.*)\x1b\[201~$/su.exec(data)?.[1];
    if (this.echo && pasted !== undefined) this.emit(box(pasted));
  }
  async resize(size: TerminalSize) {
    void size;
  }
  onData(listener: (chunk: Buffer) => void) {
    this.#data.push(listener);
  }
  onExit(listener: (code: number | null) => void) {
    this.#exit.push(listener);
  }
  close() {}
  emit(text: string) {
    for (const listener of this.#data) listener(Buffer.from(text, 'utf8'));
  }
}

function backend(options: { acceptsResume?: boolean; echo?: boolean } = {}) {
  const terminals: FakeTerminal[] = [];
  const result: TerminalBackend = {
    async prepare(target) {
      return `${target.sandboxId}-agent`;
    },
    open(place, { id }) {
      const terminal = new FakeTerminal(place, id, options.echo !== false);
      terminals.push(terminal);
      return terminal;
    },
    ...(options.acceptsResume === false ? {} : { acceptsResume: true }),
    async remove() {},
    async reachable() {
      return true;
    },
    unreachable: 'x',
  };
  return { backend: result, terminals };
}

let dir = '';
let file = '';
let counter = 0;
let id = '';
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'b-studio-draft-flow-'));
  file = path.join(dir, '.git', 'b-studio', 'terminal-draft.json');
  id = `draft-flow-${++counter}`;
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const target = (patch: Partial<TerminalTarget> = {}): TerminalTarget => ({ sandboxId: `sb-${counter}`, root: dir, projectId: 'p', draftFile: file, resumeConversation: () => 'conv-1', ...patch });
const settle = (ms = 400) => new Promise((resolve) => setTimeout(resolve, ms));

describe('쓰다 만 글 저장·복원 흐름', () => {
  it('입력창에 남은 글을 닫을 때 600 권한으로 저장하고, 다시 열어 CLI가 뜨면 괄호 붙여 넣기로만 되살린다(Enter 없음)', async () => {
    const first = backend();
    await openSessionTerminal(id, target(), {}, first.backend);
    first.terminals[0]!.emit(box(DRAFT));
    closeSessionTerminal(id);
    await settle(100);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await readDraftFile(file)).live?.text).toBe(DRAFT);
    await disposeSessionTerminal(id, `sb-${counter}`, first.backend);

    // 스튜디오를 다시 띄운 것: 상태는 비었고 같은 파일이 남아 있다
    const second = backend();
    const id2 = `${id}-restarted`;
    await openSessionTerminal(id2, target(), {}, second.backend);
    const terminal = second.terminals[0]!;
    terminal.emit(box(''));
    // 신호가 오기 전에는 아무것도 보내지 않는다
    await settle(50);
    expect(terminal.written).toEqual([]);
    noteSessionTerminalCli(id2, true);
    await settle(600);
    expect(terminal.written).toEqual([`\x1b[200~${DRAFT}\x1b[201~`]);
    expect(terminal.written.join('')).not.toMatch(/[\r\n]/);
    expect(sessionTerminalPresence(id2)?.draft).toBeUndefined();
    await disposeSessionTerminal(id2, `sb-${counter}`, second.backend);
  });

  it('입력창이 이미 차 있으면 넣지 않고 쓰다 만 글로 보인다. 요청을 보내면 치운다', async () => {
    const first = backend();
    await openSessionTerminal(id, target(), {}, first.backend);
    first.terminals[0]!.emit(box(DRAFT));
    closeSessionTerminal(id);
    await settle(100);
    await disposeSessionTerminal(id, `sb-${counter}`, first.backend);

    const second = backend();
    const id2 = `${id}-restarted`;
    await openSessionTerminal(id2, target(), {}, second.backend);
    second.terminals[0]!.emit(box('다른 글'));
    noteSessionTerminalCli(id2, true);
    await settle(300);
    expect(second.terminals[0]!.written).toEqual([]);
    expect(sessionTerminalPresence(id2)?.draft).toBe(DRAFT);

    // 요청을 보내면(프롬프트 훅) 치운다
    noteSessionTerminalCli(id2, true, { promptSubmitted: true });
    await settle(100);
    expect(sessionTerminalPresence(id2)?.draft).toBeUndefined();
    expect((await readDraftFile(file)).leftover).toBeUndefined();
    await disposeSessionTerminal(id2, `sb-${counter}`, second.backend);
  });

  it('이어 붙인 대화가 없으면 입력창에 넣지 않고 보여 준다', async () => {
    const first = backend();
    await openSessionTerminal(id, target(), {}, first.backend);
    first.terminals[0]!.emit(box(DRAFT));
    closeSessionTerminal(id);
    await settle(100);
    await disposeSessionTerminal(id, `sb-${counter}`, first.backend);

    const second = backend();
    const id2 = `${id}-restarted`;
    await openSessionTerminal(id2, target({ resumeConversation: () => undefined }), {}, second.backend);
    second.terminals[0]!.emit(box(''));
    noteSessionTerminalCli(id2, true);
    await settle(300);
    expect(second.terminals[0]!.written).toEqual([]);
    expect(sessionTerminalPresence(id2)?.draft).toBe(DRAFT);
    await disposeSessionTerminal(id2, `sb-${counter}`, second.backend);
  });

  it('파일을 주지 않았거나 이어 붙이기를 받지 않는 방식이면 화면을 읽지도 저장하지도 않는다', async () => {
    const plain = backend();
    await openSessionTerminal(id, target({ draftFile: undefined }), {}, plain.backend);
    plain.terminals[0]!.emit(box(DRAFT));
    closeSessionTerminal(id);
    await settle(100);
    await expect(stat(file)).rejects.toThrow();
    await disposeSessionTerminal(id, `sb-${counter}`, plain.backend);

    const container = backend({ acceptsResume: false });
    const id2 = `${id}-container`;
    await openSessionTerminal(id2, target(), {}, container.backend);
    container.terminals[0]!.emit(box(DRAFT));
    closeSessionTerminal(id2);
    await settle(100);
    await expect(stat(file)).rejects.toThrow();
    await disposeSessionTerminal(id2, `sb-${counter}`, container.backend);
  });
});
