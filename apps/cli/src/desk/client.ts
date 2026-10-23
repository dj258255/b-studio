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
import type { DeskPlan } from './plans';
import type { DeskAccount, DeskAccountLimits, DeskAccountStatus, DeskDocEntry, DeskFleet, DeskFleetCandidate, DeskLoginProgress, DeskLoginStart, DeskOverview, DeskPreview, DeskProject, DeskProjectStatus, DeskRequirements, DeskRequirementsDraft, DeskRules, DeskRulesView, DeskStartResult, DeskTerminalMessage, DeskTests } from './types';
import type { RecordsReport, RecordsStats } from './records';
import type { DetailExportPreview, DetailExportResult, DetailSnapshot } from './session-detail';

const LOCAL_TOKEN_COOKIE = 'b_studio_local';
/** 터미널 입력 한 번의 크기. 스튜디오의 상한(256KiB)보다 작게 나눠 보낸다 */
export const INPUT_CHUNK = 64 * 1024;

/** 스튜디오가 오류로 답했다. status로 까닭을 나눈다(409: 멈춘 세션 등) */
export class StudioRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

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
  /** 'rules'면 규칙대로, 아니면 그 백엔드로 직접. `백엔드@계정id`면 그 계정으로(#885) */
  choice: string;
}

/** 고른 것을 백엔드와 계정 id로 나눈다. 계정이 없으면 그 CLI의 기본 계정이다 */
export function splitChoice(choice: string): { backend: string; accountId?: string } {
  const at = choice.indexOf('@');
  return at < 0 ? { backend: choice } : { backend: choice.slice(0, at), accountId: choice.slice(at + 1) };
}

function sessionPath(id: string): string {
  return `/api/sessions/${encodeURIComponent(id)}`;
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

  async #request<T>(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', pathname: string, body?: unknown, signal?: AbortSignal): Promise<T> {
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
      throw new StudioRequestError(typeof message === 'string' ? message : `스튜디오가 ${response.status}로 답했습니다 (${pathname})`, response.status);
    }
    return parsed as T;
  }

  agents(): Promise<DeskOverview> {
    return this.#request('GET', '/api/agents');
  }

  projects(): Promise<DeskProject[]> {
    return this.#request('GET', '/api/projects');
  }

  /** AI 계정 목록(#885). 개인 PC 모드가 아니거나 옛 스튜디오면 실패한다 — 부르는 쪽이 계정 없이 고른다 */
  async accounts(): Promise<DeskAccount[]> {
    return (await this.#request<{ accounts: DeskAccount[] }>('GET', '/api/ai-accounts')).accounts;
  }

  /** 계정마다의 사용량 한도(#889). refresh면 다시 읽기를 청한다(스튜디오가 계정마다 최소 간격을 지킨다) */
  limits(refresh = false): Promise<{ accounts: DeskAccountLimits[]; warning?: string }> {
    return this.#request('GET', `/api/usage/limits${refresh ? '?refresh=1' : ''}`);
  }

  rules(): Promise<DeskRulesView> {
    return this.#request('GET', '/api/routing/rules');
  }

  /** 규칙 전체를 바꾼다(#890). 서버가 검사하고, 틀리면 몇 번째 규칙인지 적은 400으로 답한다 */
  async saveRules(rules: DeskRules): Promise<DeskRules> {
    return (await this.#request<{ rules: DeskRules }>('PUT', '/api/routing/rules', rules)).rules;
  }

  /** 계정을 더한다(#890). 설정 폴더는 만들지 않는다(로그인할 때 CLI가 만든다) */
  async addAccount(input: { name: string; backend: string; configDir: string }): Promise<DeskAccount> {
    return (await this.#request<{ account: DeskAccount }>('POST', '/api/ai-accounts', input)).account;
  }

  /** 이름·그림을 고친다. 빈 그림('')은 그림을 지운다(세션마다 무작위) */
  async updateAccount(id: string, patch: { name?: string; sprite?: string }): Promise<DeskAccount> {
    return (await this.#request<{ account: DeskAccount }>('PATCH', `/api/ai-accounts/${encodeURIComponent(id)}`, patch)).account;
  }

  /** 목록에서만 뺀다. 설정 폴더는 그대로다 */
  async removeAccount(id: string): Promise<void> {
    await this.#request('DELETE', `/api/ai-accounts/${encodeURIComponent(id)}`);
  }

  async accountStatus(id: string): Promise<DeskAccountStatus> {
    return (await this.#request<{ status: DeskAccountStatus }>('GET', `/api/ai-accounts/${encodeURIComponent(id)}/status`)).status;
  }

  startLogin(id: string): Promise<DeskLoginStart> {
    return this.#request('POST', `/api/ai-accounts/${encodeURIComponent(id)}/login`);
  }

  async loginProgress(id: string): Promise<DeskLoginProgress> {
    return (await this.#request<{ progress: DeskLoginProgress }>('GET', `/api/ai-accounts/${encodeURIComponent(id)}/login`)).progress;
  }

  async cancelLogin(id: string): Promise<DeskLoginProgress> {
    return (await this.#request<{ progress: DeskLoginProgress }>('DELETE', `/api/ai-accounts/${encodeURIComponent(id)}/login`)).progress;
  }

  /** 여러 AI 비교 목록(#892). 최근 것부터 30개 */
  fleets(): Promise<DeskFleet[]> {
    return this.#request('GET', '/api/fleets');
  }

  fleet(id: string): Promise<DeskFleet> {
    return this.#request('GET', `/api/fleets/${encodeURIComponent(id)}`);
  }

  /** 같은 요청을 여러 AI에 보낸다. 참가자는 2~4이고, 스튜디오가 CLI 로그인을 먼저 확인한다(실패하면 비교를 만들지 않는다) */
  createFleet(input: { projectId: string; request: string; candidates: DeskFleetCandidate[] }): Promise<DeskFleet> {
    return this.#request('POST', '/api/fleets', input);
  }

  /** 승자를 고른다. 검증을 통과한 참가자만 된다 */
  chooseFleetWinner(id: string, sessionId: string): Promise<DeskFleet> {
    return this.#request('POST', `/api/fleets/${encodeURIComponent(id)}/winner`, { sessionId });
  }

  /** 비교를 지운다. 참가자 세션도 함께 지운다(진행 중인 참가자가 있으면 스튜디오가 409로 막는다) */
  async deleteFleet(id: string): Promise<void> {
    await this.#request('POST', `/api/fleets/${encodeURIComponent(id)}/delete`);
  }

  preview(request: string): Promise<DeskPreview> {
    return this.#request('POST', '/api/routing/preview', { request, intent: 'build' });
  }

  // ─── 작업 나누기(#893, /api/task-plans) ───

  plans(): Promise<DeskPlan[]> {
    return this.#request('GET', '/api/task-plans');
  }

  plan(id: string): Promise<DeskPlan> {
    return this.#request('GET', `/api/task-plans/${encodeURIComponent(id)}`);
  }

  /** 요청으로 새 계획을 만든다. 스튜디오가 레인으로 나누는 동안 계획은 planning이고, 다 나누면 승인 대기다 */
  createPlan(projectId: string, request: string): Promise<DeskPlan> {
    return this.#request('POST', '/api/task-plans', { projectId, request });
  }

  approvePlan(id: string, publishIssues: boolean): Promise<DeskPlan> {
    return this.#request('POST', `/api/task-plans/${encodeURIComponent(id)}/approval`, { approve: true, publishIssues });
  }

  rejectPlan(id: string): Promise<DeskPlan> {
    return this.#request('POST', `/api/task-plans/${encodeURIComponent(id)}/approval`, { approve: false });
  }

  async deletePlan(id: string): Promise<void> {
    await this.#request('POST', `/api/task-plans/${encodeURIComponent(id)}/delete`);
  }

  /** 재시작으로 멈춘 계획의 통합을 다시 시작한다(레인은 다시 돌리지 않는다) */
  resumePlan(id: string): Promise<DeskPlan> {
    return this.#request('POST', `/api/task-plans/${encodeURIComponent(id)}/resume`);
  }

  /** 레인에 고를 수 있는 AI(이 스튜디오가 허용한 것) */
  async laneBackends(): Promise<string[]> {
    return (await this.#request<{ backends: string[] }>('GET', '/api/task-plans/lane-backends')).backends;
  }

  /**
   * 승인 대기 중인 레인의 AI·계정을 바꾼다. 빈 AI는 "세션과 같음"(계획 기본)이다.
   * 계정은 늘 함께 보낸다: 빈 계정은 그 CLI의 기본 계정이라, 같은 AI의 다른 계정에서 기본 계정으로 돌아갈 때도 지운다
   */
  async setLane(id: string, laneId: string, backend: string, accountId?: string): Promise<DeskPlan> {
    const route = `/api/task-plans/${encodeURIComponent(id)}/lanes/${encodeURIComponent(laneId)}/backend`;
    return (await this.#request<{ plan: DeskPlan }>('POST', route, { backend, accountId: accountId ?? '' })).plan;
  }

  /** 새 요청을 터미널로 보낸다(#836): 규칙(또는 직접 고른 AI)으로 세션을 만들고 터미널을 열어 첫 요청을 CLI에 넣는다 */
  start(input: StartInput): Promise<DeskStartResult> {
    const picked = splitChoice(input.choice);
    const route = input.choice === 'rules' ? { route: 'rules' } : { route: 'direct', backend: picked.backend, ...(picked.accountId ? { accountId: picked.accountId } : {}) };
    return this.#request('POST', '/api/sessions', { projectId: input.projectId, ...route, request: input.request, intent: 'build', terminal: true });
  }

  /** 세션을 멈춘다(샌드박스·터미널을 내린다. 기록과 작업 복사본은 남는다) */
  async stop(id: string): Promise<void> {
    await this.#request('DELETE', `/api/sessions/${encodeURIComponent(id)}`);
  }

  /** 멈춘 세션을 같은 작업 복사본으로 다시 띄운다. 켜지는 것은 기다리지 않는다 */
  async resume(id: string): Promise<void> {
    await this.#request('POST', `/api/sessions/${encodeURIComponent(id)}/resume`);
  }

  // ─── 요구사항·문서(#894). 웹 세션 화면의 요구사항 묶음(명세·테스트·문서·현황)이 쓰는 API 그대로 ───

  requirements(id: string): Promise<DeskRequirements> {
    return this.#request('GET', `/api/sessions/${encodeURIComponent(id)}/requirements`);
  }

  tests(id: string): Promise<DeskTests> {
    return this.#request('GET', `/api/sessions/${encodeURIComponent(id)}/tests`);
  }

  async docs(id: string): Promise<DeskDocEntry[]> {
    return (await this.#request<{ docs: DeskDocEntry[] }>('GET', `/api/sessions/${encodeURIComponent(id)}/docs`)).docs;
  }

  /** 문서 하나. docs/ 아래 마크다운과 README.md·CHANGELOG.md·CONTRIBUTING.md만 된다(스튜디오가 거른다) */
  async doc(id: string, file: string): Promise<string> {
    return (await this.#request<{ content: string }>('GET', `/api/sessions/${encodeURIComponent(id)}/docs/content?${new URLSearchParams({ path: file })}`)).content;
  }

  /** 문서를 작업 복사본에 쓴다(다음 체크포인트·PR에 실린다). 요청을 처리하는 동안 요구사항 문서는 스튜디오가 받지 않는다 */
  async saveDoc(id: string, file: string, content: string): Promise<void> {
    await this.#request('POST', `/api/sessions/${encodeURIComponent(id)}/docs/content`, { path: file, content });
  }

  projectStatus(id: string): Promise<DeskProjectStatus> {
    return this.#request('GET', `/api/sessions/${encodeURIComponent(id)}/status`);
  }

  /** 사람이 확인했다고 남긴다(무엇을 어떻게 확인했는지 note에 적는다) */
  verifyRequirement(id: string, requirementId: string, note: string): Promise<DeskRequirements> {
    return this.#request('POST', `/api/sessions/${encodeURIComponent(id)}/requirements/verify`, { requirementId, note });
  }

  clearVerification(id: string, requirementId: string): Promise<DeskRequirements> {
    return this.#request('DELETE', `/api/sessions/${encodeURIComponent(id)}/requirements/verify`, { requirementId });
  }

  /** 추출 결과를 docs/requirements.md로 저장한다(웹의 "docs/requirements.md로 저장") */
  applyRequirements(id: string, draft: Pick<DeskRequirementsDraft, 'requirements' | 'assumptions' | 'manualSteps'>): Promise<DeskRequirements> {
    return this.#request('POST', `/api/sessions/${encodeURIComponent(id)}/requirements/apply`, { requirements: draft.requirements, assumptions: draft.assumptions ?? [], manualSteps: draft.manualSteps ?? [] });
  }

  /** AI별 결과표(#891). 서버가 계정별 묶음과 최근 실패를 함께 준다(옛 서버는 주지 않는다) */
  routingStats(): Promise<RecordsStats> {
    return this.#request('GET', '/api/routing/stats');
  }

  /** 프로젝트 토큰 보고서(#891). from을 주면 그 시각부터 */
  async tokenReport(projectId: string, from?: string): Promise<RecordsReport> {
    const query = from ? `?${new URLSearchParams({ from })}` : '';
    return (await this.#request<{ report: RecordsReport }>('GET', `/api/projects/${encodeURIComponent(projectId)}/token-report${query}`)).report;
  }

  /** 세션 스냅숏(체크포인트, 다시 검증 기록, AI 리뷰, 저장소) */
  session(id: string): Promise<DetailSnapshot> {
    return this.#request('GET', sessionPath(id));
  }

  /** 체크포인트 하나의 diff(시크릿 값은 서버가 가린다) */
  async checkpointPatch(id: string, sha: string): Promise<string> {
    return (await this.#request<{ patch: string }>('GET', `${sessionPath(id)}/checkpoints/${encodeURIComponent(sha)}`)).patch;
  }

  /** 체크포인트로 되돌린다. 시작만 하고 돌아온다(진행은 세션 이벤트로 온다) */
  async restoreCheckpoint(id: string, sha: string): Promise<void> {
    await this.#request('POST', `${sessionPath(id)}/checkpoints/${encodeURIComponent(sha)}/restore`);
  }

  /** 지금 체크포인트를 같은 게이트로 다시 검증한다(에이전트는 돌리지 않는다) */
  async reverify(id: string, sha: string): Promise<void> {
    await this.#request('POST', `${sessionPath(id)}/checkpoints/${encodeURIComponent(sha)}/reverify`);
  }

  /** 세션 기록을 지운다. 멈춘 세션만 된다(서버가 409로 막는다) */
  async deleteSession(id: string): Promise<void> {
    await this.#request('POST', `${sessionPath(id)}/delete`);
  }

  /** 올리기 전 점검. 아무것도 올리지 않는다 */
  exportPreview(id: string): Promise<DetailExportPreview> {
    return this.#request('POST', `${sessionPath(id)}/export/preview`, {});
  }

  /** 브랜치를 올리고, pullRequest면 PR도 만든다 */
  exportSession(id: string, pullRequest: boolean): Promise<DetailExportResult> {
    return this.#request('POST', `${sessionPath(id)}/export`, { pullRequest });
  }

  /** AI 리뷰 라운드를 (다시) 돌린다. 시작만 하고 돌아온다 */
  async reviewRound(id: string, restart: boolean): Promise<void> {
    await this.#request('POST', `${sessionPath(id)}/review`, { restart });
  }

  /** AI 리뷰의 지적 하나를 오탐으로 닫는다 */
  async resolveFinding(id: string, input: { round: number; findingIndex: number; reason: string }): Promise<void> {
    await this.#request('POST', `${sessionPath(id)}/review/resolve`, input);
  }

  /** 세션 이름을 바꾼다. 빈 이름은 이름을 지운다(#864) */
  async rename(id: string, label: string): Promise<void> {
    await this.#request('PATCH', `/api/sessions/${encodeURIComponent(id)}`, { label });
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
