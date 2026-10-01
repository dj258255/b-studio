/**
 * 구독 CLI 계정 연결(ADR-0XX). 터미널을 열지 않고도 화면에서 로그인 상태를 보고, 되는 CLI는 로그인을 시작할 수 있게 한다.
 *
 * 상태 확인은 packages/agent의 `preflight*` 함수를 그대로 재사용한다 — 토큰 파일을 읽지 않고, 각 CLI의 상태 확인
 * 명령(`claude`·`codex login status`·`cmd status`·`opencode --version`)만 부른다(0단계 근거는 각 러너 파일에 있다).
 *
 * 로그인 시작은 각 CLI가 공식으로 제공하는 로그인 명령을 자식 프로세스로 띄우고, stdout·stderr을 그대로 사람이 읽는
 * 줄로 모아 화면에 보여준다. b-studio는 비밀번호·토큰을 입력받지도, CLI가 쓰는 자격 증명 파일을 읽지도 않는다 —
 * 로그인은 각 CLI가 직접 브라우저·OAuth 콜백으로 처리하고 자기 자리에 저장한다.
 *
 * CLI마다 로그인 명령이 헤드리스(TTY 없이)로 끝까지 되는지는 다르다. `claude auth login`·`codex login --device-auth`·
 * `cmd login`은 브라우저 URL(또는 기기 코드)을 표준출력에 찍고 콜백·폴링으로 기다리는 꼴이라 띄울 수 있다고 본다.
 * `opencode auth login`은 opencode 전체가 ink 기반 대화형 CLI라 제공자·인증 방식 선택이 TTY 상호작용을 전제해
 * 여기서는 억지로 흉내 내지 않고 명령만 보여준다(ADR-0XX "CLI별 조사 결과" 참고. 실제로 실행해 관측한 값이 아니라
 * `--help`와 각 CLI의 공개된 설계로 미룬 추정이라, 표준출력 형식이 이 추정과 다르면 URL·코드 추출 정규식만 못 맞고
 * 로그인 자체(각 CLI 프로세스)는 그대로 진행된다 — 사람이 로그를 보고 "브라우저에서 열기" 전에 직접 복사할 수 있다).
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { describeAccount, preflightClaudeCode, preflightCodex, preflightCommandCode, preflightOpenCode } from '@b-studio/agent';

/** 계정 연결 화면이 다루는 백엔드. api·demo는 로그인 CLI가 없어 뺀다 */
export const CLI_ACCOUNT_BACKENDS = ['claude-code', 'codex', 'commandcode', 'opencode'] as const;
export type CliAccountBackend = (typeof CLI_ACCOUNT_BACKENDS)[number];

/**
 * 화면 표기. `components/status.tsx`의 `SESSION_BACKEND_LABEL`과 같은 값이다(제품 브랜딩 가이드상 "Claude Code" 같은
 * 원래 이름 대신 "로컬 Claude Agent" 식으로 보여준다). 서버 모듈(lib/server)이 컴포넌트 파일을 불러오지 않는 관례를
 * 따르느라 값을 그대로 복사해 둔다 — 두 쪽 중 하나를 바꾸면 나머지도 같이 바꿔야 한다
 */
const BACKEND_LABEL: Record<CliAccountBackend, string> = {
  'claude-code': '로컬 Claude Agent',
  codex: '로컬 ChatGPT Agent',
  commandcode: '로컬 Command Code Agent',
  opencode: '로컬 OpenCode Agent',
};

export function isCliAccountBackend(value: unknown): value is CliAccountBackend {
  return typeof value === 'string' && (CLI_ACCOUNT_BACKENDS as readonly string[]).includes(value);
}

export interface AccountStatus {
  backend: CliAccountBackend;
  /** 화면 표기(BACKEND_LABEL과 같다. 제품 브랜딩 가이드상 "Claude Code" 같은 원래 이름 대신 "로컬 Claude Agent" 식으로 보여준다) */
  label: string;
  connected: boolean;
  /** CLI 자체를 찾지 못했는지(설치 안 됨) vs CLI는 있는데 로그인만 안 됐는지 */
  installed: boolean;
  /** 연결돼 있을 때 preflight가 이미 알고 있는 계정 종류(예: "Max 구독"). 모르면 비워 둔다 — 토큰 파일을 따로 읽어 지어내지 않는다 */
  accountKind?: string;
  /** 연결돼 있지 않을 때 preflight가 돌려준 이유(사람이 읽는 문장) */
  reason?: string;
}

/** 로그인 명령 하나. command·args는 화면의 복사 버튼과 실제로 띄우는 자식 프로세스가 함께 쓴다 */
export interface LoginCommandSpec {
  command: string;
  args: string[];
  /** false면 TTY 상호작용이 필요해 자동으로 띄우지 않는다(명령만 보여주고 사람이 터미널에서 실행한다) */
  spawnable: boolean;
  /** spawnable이 false일 때 화면에 보여줄 이유 */
  note?: string;
}

/**
 * 각 CLI가 공식으로 제공하는 로그인 명령(조사 근거는 ADR-0XX). `--claudeai`·`--device-auth`처럼 선택 메뉴를 건너뛰는
 * 플래그를 골라, 사람이 화살표 키로 고르지 않아도 되는 경로를 쓴다.
 */
const LOGIN_COMMANDS: Record<CliAccountBackend, LoginCommandSpec> = {
  'claude-code': { command: 'claude', args: ['auth', 'login', '--claudeai'], spawnable: true },
  codex: { command: 'codex', args: ['login', '--device-auth'], spawnable: true },
  commandcode: { command: 'cmd', args: ['login'], spawnable: true },
  opencode: {
    command: 'opencode',
    args: ['auth', 'login'],
    spawnable: false,
    note: 'opencode는 제공자·인증 방식을 고르는 대화형 CLI라 b-studio가 대신 실행할 수 없습니다. 터미널에서 실행한 뒤 다시 확인해 주세요.',
  },
};

export function loginCommandFor(backend: CliAccountBackend): LoginCommandSpec {
  return LOGIN_COMMANDS[backend];
}

/** 복사 버튼에 쓰는 한 줄 명령 문자열 */
export function loginCommandText(backend: CliAccountBackend): string {
  const spec = LOGIN_COMMANDS[backend];
  return [spec.command, ...spec.args].join(' ');
}

/** preflight가 돌려준 이유 문장에서 "CLI 자체가 없다"를 가려낸다(ENOENT 등). 못 가려내면 "로그인만 안 됐다"로 본다 */
function looksNotInstalled(reason: string): boolean {
  return /ENOENT|command not found|no such file|not recognized/i.test(reason);
}

export interface AccountPreflights {
  claudeCode?: typeof preflightClaudeCode;
  codex?: typeof preflightCodex;
  commandCode?: typeof preflightCommandCode;
  openCode?: typeof preflightOpenCode;
}

/** 백엔드 하나의 지금 상태. 토큰·자격 증명 파일은 읽지 않고 preflight 결과만 옮긴다 */
export async function checkAccountStatus(backend: CliAccountBackend, preflights: AccountPreflights = {}): Promise<AccountStatus> {
  const label = BACKEND_LABEL[backend];
  if (backend === 'claude-code') {
    const result = await (preflights.claudeCode ?? preflightClaudeCode)();
    if (result.ok) return { backend, label, connected: true, installed: true, accountKind: describeAccount(result.account) };
    return { backend, label, connected: false, installed: !looksNotInstalled(result.reason), reason: result.reason };
  }
  if (backend === 'codex') {
    const result = await (preflights.codex ?? preflightCodex)();
    if (result.ok) return { backend, label, connected: true, installed: true };
    return { backend, label, connected: false, installed: !looksNotInstalled(result.reason), reason: result.reason };
  }
  if (backend === 'commandcode') {
    const result = await (preflights.commandCode ?? preflightCommandCode)();
    if (result.ok) return { backend, label, connected: true, installed: true };
    return { backend, label, connected: false, installed: !looksNotInstalled(result.reason), reason: result.reason };
  }
  const result = await (preflights.openCode ?? preflightOpenCode)();
  if (result.ok) return { backend, label, connected: true, installed: true };
  return { backend, label, connected: false, installed: !looksNotInstalled(result.reason), reason: result.reason };
}

export async function listAccountStatuses(preflights: AccountPreflights = {}): Promise<AccountStatus[]> {
  return Promise.all(CLI_ACCOUNT_BACKENDS.map((backend) => checkAccountStatus(backend, preflights)));
}

// ---------------------------------------------------------------------------
// 로그인 시작·진행·취소

/** 한 번에 보여주는 로그 줄 수(끝없이 쌓이지 않게 자른다) */
const MAX_LINES = 200;
/** 사람이 끝내지 않고 창을 닫아도 자식 프로세스가 영영 남지 않도록 자동으로 끊는 시간 */
export const LOGIN_TIMEOUT_MS = 10 * 60_000;

/** 표준출력·표준에러 줄에서 찾는 URL. 각 CLI의 실제 문구는 관측하지 못했다(ADR-0XX) — 일반적인 http(s) URL 모양만 가정한다 */
const URL_RE = /https?:\/\/[^\s"'<>]+/;
/** 기기 인증 코드 모양(GitHub·Google 등이 쓰는 "XXXX-XXXX" 꼴을 우선 보고, 그다음 4~10자 대문자/숫자 토큰을 본다). 실제로 관측한 값이 아니라 일반적인 꼴의 추정이다 */
const CODE_RE = /\b([A-Z0-9]{4}-[A-Z0-9]{4}|[A-Z0-9]{4,10})\b/;

export type LoginState = 'running' | 'exited' | 'cancelled' | 'timeout';

export interface LoginProgress {
  backend: CliAccountBackend;
  state: LoginState;
  lines: string[];
  url?: string;
  code?: string;
  startedAt: number;
  exitCode?: number | null;
  error?: string;
  /** 프로세스가 끝난 뒤 다시 확인한 상태. route가 한 번만 채워 넣는다(진행 중에는 비어 있다) */
  status?: AccountStatus;
}

/**
 * startLogin이 실제로 쓰는 자식 프로세스의 모양만 추렸다(구조적 타입). node의 `ChildProcess`는 overload가 많아
 * 테스트의 가짜 프로세스(EventEmitter 기반)와 맞추기 번거로운데, 여기서 실제로 쓰는 건 stdout·stderr의 데이터
 * 이벤트, exit·error 한 번, kill뿐이다 — 진짜 `spawn()` 결과는 이 모양을 구조적으로 만족한다
 */
export interface MinimalChildProcess {
  stdout?: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null;
  stderr?: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown } | null;
  once(event: 'exit', listener: (code: number | null) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  kill(): unknown;
}

export type SpawnFn = (command: string, args: string[], options: { stdio: ['ignore', 'pipe', 'pipe'] }) => MinimalChildProcess;

interface LoginSession {
  child: MinimalChildProcess;
  progress: LoginProgress;
  timer: ReturnType<typeof setTimeout>;
}

/** 백엔드별 로그인 세션. 한 백엔드에 하나만 돈다(Map이 곧 "진행 중" 여부다) */
const sessions = new Map<CliAccountBackend, LoginSession>();

/**
 * 로그 한 줄에서 URL·기기 코드 후보를 뽑는다(순수 함수라 테스트하기 쉽다). URL이 이미 있으면 그 URL 안의 글자를
 * 코드로 잘못 집지 않게 뺀다(예: URL에 "?code=ABCD1234"가 들어 있는 경우).
 */
export function extractLoginHint(line: string): { url?: string; code?: string } {
  const url = URL_RE.exec(line)?.[0];
  const codeMatch = CODE_RE.exec(line);
  const code = codeMatch && !(url && url.includes(codeMatch[0])) ? (codeMatch[1] ?? codeMatch[0]) : undefined;
  return { ...(url ? { url } : {}), ...(code ? { code } : {}) };
}

function pushLine(progress: LoginProgress, chunk: string): void {
  for (const raw of chunk.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    progress.lines.push(line);
    if (progress.lines.length > MAX_LINES) progress.lines.shift();
    const hint = extractLoginHint(line);
    if (hint.url && !progress.url) progress.url = hint.url;
    if (hint.code && !progress.code) progress.code = hint.code;
  }
}

/**
 * 로그인을 시작한다. 이미 돌고 있으면 새로 띄우지 않고 그 진행 상황을 그대로 돌려준다(백엔드당 하나).
 * spawnable이 아닌 CLI(opencode)는 호출한 쪽(route)이 미리 걸러야 한다 — 여기서는 방어적으로만 던진다.
 */
export function startLogin(backend: CliAccountBackend, options: { spawn?: SpawnFn; timeoutMs?: number } = {}): LoginProgress {
  const existing = sessions.get(backend);
  if (existing && existing.progress.state === 'running') return existing.progress;

  const spec = LOGIN_COMMANDS[backend];
  if (!spec.spawnable) throw new Error(`${backend}는 자동으로 로그인을 띄울 수 없습니다: ${spec.note ?? '대화형 CLI입니다'}`);

  const spawnFn: SpawnFn = options.spawn ?? nodeSpawn;
  const progress: LoginProgress = { backend, state: 'running', lines: [], startedAt: Date.now() };
  const child = spawnFn(spec.command, spec.args, { stdio: ['ignore', 'pipe', 'pipe'] });

  child.stdout?.on('data', (chunk: Buffer | string) => pushLine(progress, String(chunk)));
  child.stderr?.on('data', (chunk: Buffer | string) => pushLine(progress, String(chunk)));

  const timer = setTimeout(() => {
    cancelLogin(backend, 'timeout');
  }, options.timeoutMs ?? LOGIN_TIMEOUT_MS);
  // Node 테스트 러너가 이 타이머 때문에 종료를 기다리지 않게 한다
  timer.unref?.();

  child.once('exit', (code) => {
    clearTimeout(timer);
    if (progress.state === 'running') progress.state = 'exited';
    progress.exitCode = code;
  });
  child.once('error', (error) => {
    clearTimeout(timer);
    progress.state = 'exited';
    progress.error = error instanceof Error ? error.message : String(error);
  });

  sessions.set(backend, { child, progress, timer });
  return progress;
}

/** 지금 진행(또는 끝난 뒤 남은 마지막) 상황. 없으면(한 번도 시작 안 함) undefined */
export function getLoginProgress(backend: CliAccountBackend): LoginProgress | undefined {
  return sessions.get(backend)?.progress;
}

/** 끝난 세션에 재확인한 상태를 한 번만 채워 넣는다(route가 GET마다 부른다. 이미 있으면 다시 부르지 않는다) */
export function attachStatus(progress: LoginProgress, status: AccountStatus): void {
  progress.status = status;
}

/** 진행 중인 로그인을 끊는다. 없으면 아무것도 하지 않는다(멱등) */
export function cancelLogin(backend: CliAccountBackend, reason: Extract<LoginState, 'cancelled' | 'timeout'> = 'cancelled'): LoginProgress | undefined {
  const session = sessions.get(backend);
  if (!session) return undefined;
  clearTimeout(session.timer);
  if (session.progress.state === 'running') {
    session.progress.state = reason;
    session.child.kill();
  }
  return session.progress;
}

/** 테스트 전용: 모듈이 들고 있는 세션을 모두 지운다(프로세스가 실제로 살아 있어도 Map에서만 뺀다) */
export function resetLoginSessionsForTest(): void {
  for (const session of sessions.values()) clearTimeout(session.timer);
  sessions.clear();
}
