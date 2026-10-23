/**
 * desk가 스튜디오에 붙는 손님. 터미널·관문·게이트는 모두 스튜디오가 하고, desk는 API만 부른다(ADR-183).
 *
 * 인증: 개인 PC 모드의 터미널 통로는 `studio launch`로 띄운 서버가 만든 로컬 토큰 쿠키를 요구한다(ADR-173 덧붙임).
 * desk는 같은 사용자로 돌므로 그 파일(0600)을 읽어 쿠키로 싣는다. 주소는 이 컴퓨터 주소(127.0.0.1)만 쓴다 —
 * 스튜디오가 터미널 통로를 이 컴퓨터 주소로 온 요청에만 열기 때문이다. Origin은 싣지 않는다(같은 출처 검사는 Origin이 없으면 지난다)
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import type { DeskOverview, DeskPreview, DeskProject, DeskStartResult, DeskTerminalMessage } from './types';

const LOCAL_TOKEN_COOKIE = 'b_studio_local';
/** 터미널 입력 한 번의 크기. 스튜디오의 상한(256KiB)보다 작게 나눠 보낸다 */
export const INPUT_CHUNK = 64 * 1024;

export interface StudioConnection {
  origin: string;
  token: string;
}

function launchDir(env: Record<string, string | undefined>): string {
  return path.join(env.HOME ?? homedir(), '.cache', 'b-studio', 'launch');
}

/** 띄워 둔 스튜디오를 찾는다: 포트는 인자 → launch의 PID 파일 → 3000, 토큰은 스튜디오와 같은 자리(B_STUDIO_LOCAL_TOKEN_FILE) */
export async function findStudio(env: Record<string, string | undefined>, options: { port?: number }): Promise<StudioConnection | { error: string }> {
  let port = options.port;
  if (port === undefined) {
    const raw = await readFile(path.join(launchDir(env), 'studio.pid'), 'utf8').catch(() => undefined);
    try {
      const parsed = raw ? (JSON.parse(raw) as { port?: unknown }) : undefined;
      if (typeof parsed?.port === 'number') port = parsed.port;
    } catch {
      // 깨진 PID 파일이면 기본 포트
    }
  }
  const tokenFile = env.B_STUDIO_LOCAL_TOKEN_FILE?.trim() || path.join(launchDir(env), 'local-token');
  const token = (await readFile(tokenFile, 'utf8').catch(() => ''))?.trim();
  if (!token) return { error: '스튜디오의 로컬 토큰이 없습니다. 먼저 `pnpm studio launch`로 스튜디오를 띄우세요' };
  return { origin: `http://127.0.0.1:${port ?? 3000}`, token };
}

/** SSE 조각을 이어 붙여 `data:` 값만 꺼낸다. 주석 줄(`: ping`)은 버린다. rest는 다음 조각과 이을 남은 글이다 */
export function parseSse(rest: string, chunk: string): { events: string[]; rest: string } {
  let buffer = rest + chunk;
  const events: string[] = [];
  let end: number;
  while ((end = buffer.indexOf('\n\n')) >= 0) {
    const block = buffer.slice(0, end);
    buffer = buffer.slice(end + 2);
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n');
    if (data) events.push(data);
  }
  return { events, rest: buffer };
}

export interface StartInput {
  projectId: string;
  request: string;
  /** 'rules'면 규칙대로, 아니면 그 백엔드로 직접 */
  choice: string;
}

export class StudioClient {
  readonly #connection: StudioConnection;
  /** 세션마다 입력을 차례대로 보낸다(앞 입력이 끝나기 전에 뒤 입력이 먼저 닿지 않게) */
  readonly #inputQueue = new Map<string, Promise<void>>();

  constructor(connection: StudioConnection) {
    this.#connection = connection;
  }

  get origin(): string {
    return this.#connection.origin;
  }

  async #request<T>(method: 'GET' | 'POST', pathname: string, body?: unknown, signal?: AbortSignal): Promise<T> {
    const response = await fetch(`${this.#connection.origin}${pathname}`, {
      method,
      headers: { cookie: `${LOCAL_TOKEN_COOKIE}=${this.#connection.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = {};
    }
    if (!response.ok) {
      const message = (parsed as { error?: unknown }).error;
      throw new Error(typeof message === 'string' ? message : `스튜디오가 ${response.status}로 답했습니다 (${pathname})`);
    }
    return parsed as T;
  }

  agents(): Promise<DeskOverview> {
    return this.#request('GET', '/api/agents');
  }

  projects(): Promise<DeskProject[]> {
    return this.#request('GET', '/api/projects');
  }

  rules(): Promise<{ allowed: string[]; defaultBackend: string }> {
    return this.#request('GET', '/api/routing/rules');
  }

  preview(request: string): Promise<DeskPreview> {
    return this.#request('POST', '/api/routing/preview', { request, intent: 'build' });
  }

  /** 새 요청을 터미널로 보낸다(#836): 규칙(또는 직접 고른 AI)으로 세션을 만들고 터미널을 열어 첫 요청을 CLI에 넣는다 */
  start(input: StartInput): Promise<DeskStartResult> {
    const route = input.choice === 'rules' ? { route: 'rules' } : { route: 'direct', backend: input.choice };
    return this.#request('POST', '/api/sessions', { projectId: input.projectId, ...route, request: input.request, intent: 'build', terminal: true });
  }

  async open(id: string, cols: number, rows: number): Promise<void> {
    await this.#request('POST', `/api/sessions/${encodeURIComponent(id)}/terminal`, { action: 'open', cols, rows });
  }

  async resize(id: string, cols: number, rows: number): Promise<void> {
    await this.#request('POST', `/api/sessions/${encodeURIComponent(id)}/terminal`, { action: 'resize', cols, rows });
  }

  input(id: string, data: string): Promise<void> {
    const previous = this.#inputQueue.get(id) ?? Promise.resolve();
    const next = previous
      .catch(() => {})
      .then(async () => {
        for (let at = 0; at < data.length; ) {
          let end = Math.min(data.length, at + INPUT_CHUNK);
          // 서로게이트 쌍(이모지 등) 한가운데서 나누지 않는다
          if (end < data.length && /[\ud800-\udbff]/.test(data[end - 1]!)) end -= 1;
          await this.#request('POST', `/api/sessions/${encodeURIComponent(id)}/terminal`, { action: 'input', data: data.slice(at, end) });
          at = end;
        }
      });
    this.#inputQueue.set(id, next);
    return next;
  }

  /** 칸들의 터미널 출력을 묶음 통로 하나로 받는다(ADR-177). signal로 끊으면 끝난다. 서버가 끊어도 끝난다 */
  async stream(ids: readonly string[], onMessage: (id: string, message: DeskTerminalMessage) => void, signal: AbortSignal): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${this.#connection.origin}/api/terminals/stream?${new URLSearchParams({ ids: ids.join(',') })}`, {
        headers: { cookie: `${LOCAL_TOKEN_COOKIE}=${this.#connection.token}`, accept: 'text/event-stream' },
        signal,
      });
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    }
    if (!response.ok || !response.body) {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? `터미널 통로를 열지 못했습니다 (${response.status})`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let rest = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        const parsed = parseSse(rest, decoder.decode(value, { stream: true }));
        rest = parsed.rest;
        for (const event of parsed.events) {
          try {
            const { id, message } = JSON.parse(event) as { id: string; message: DeskTerminalMessage };
            onMessage(id, message);
          } catch {
            // 깨진 조각은 버린다
          }
          if (signal.aborted) return;
        }
      }
    } catch (error) {
      if (signal.aborted) return;
      throw error;
    } finally {
      reader.cancel().catch(() => {});
    }
  }
}
