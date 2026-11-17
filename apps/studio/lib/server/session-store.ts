import path from 'node:path';
import type { CliTier } from '@b-studio/agent';
import { native } from '@b-studio/sandbox';
import type { SessionSnapshot, StudioEvent } from '../studio-events';
import { SessionRecord } from './session-record';

/** 세션 상태 폴더 안의 저장 위치. .git 아래라 에이전트 도구가 접근하지 못하고 커밋에도 들어가지 않는다 */
const FILE = path.join('.git', 'b-studio', 'session.json');
export const PERSISTED_HISTORY_LIMIT = 2_000;

/**
 * b-studio가 작업 복사본 밖에 기억해 두는 Git 상태(이슈 #699). CheckpointStore의 같은 이름 타입과 구조가 같다 —
 * 여기서 따로 두는 것은 세션 저장이 이 값의 주인이고, studio가 agent 패키지의 내부 타입을 직접 가져오지 않게 하기 위함이다.
 * 올리기·가져오기는 이 구조를 그대로 받아 지금 Git과 견준다
 */
export interface RememberedGit {
  /** 세션 브랜치 이름. 지금 체크아웃된 브랜치가 이것과 다르면 멈춘다 */
  branch: string;
  /** b-studio가 마지막으로 남긴 체크포인트(HEAD). 지금 HEAD가 이것과 다르면 멈춘다 */
  lastCheckpoint: string;
  /** 기억한 origin 주소. 있으면 지금 remote.origin.url과 같아야 한다 */
  originUrl?: string;
}

/** 스튜디오 서버가 다시 시작돼도 세션을 이어서 띄울 수 있게 남기는 상태 */
export interface PersistedSession {
  version: 1;
  savedAt: string;
  /** 마지막으로 쓴 스튜디오 프로세스. 살아 있으면 다른 프로세스가 복구하지 않는다 */
  owner: { pid: number };
  snapshot: SessionSnapshot;
  history: StudioEvent[];
  /** api 모드의 모델 대화 */
  conversation: unknown[];
  demoIndex: number;
  claudeCode: {
    sessionId?: string;
    notes: string[];
    /** claude-code 자동 모델 선택(ADR-091)의 stickiness: 이 세션에서 이미 성공적으로 쓴 가장 높은 단계. 이 필드가 생기기 전 기록에는 없다 */
    autoTier?: CliTier;
  };
  /** 세션 단위로 설정한 디자인(Figma) URL. studio.yaml을 스튜디오가 고치지 않고 여기에 둔다 */
  design?: { fileUrl: string; fileKey: string };
  /** codex 모드의 짧은 이전 맥락. 러너가 대화를 이어받지 못해 요약만 넘긴다. 이 필드가 생기기 전 기록에는 없다 */
  codex?: { notes: string[]; recent: Array<{ request: string; summary: string; status: string }> };
  /** commandcode 모드의 이어받을 세션과 알림. 이 필드가 생기기 전 기록에는 없다 */
  commandCode?: { sessionId?: string; notes: string[] };
  /** opencode 모드의 이어받을 세션과 알림. 이 필드가 생기기 전 기록에는 없다 */
  openCode?: { sessionId?: string; notes: string[] };
  /** gemini 모드의 이어받을 세션과 알림. 이 필드가 생기기 전 기록에는 없다 */
  gemini?: { sessionId?: string; notes: string[] };
  sourceDirtyFiles: number;
  /** 터미널 세션의 메인·서브에이전트 내역(#843·#849). 화면용이라 모양이 틀리면 버린다. 이 필드가 생기기 전 기록에는 없다 */
  agentLedger?: unknown;
  /** 세션 터미널의 CLI가 훅으로 알려 온 대화 id(#872). 스튜디오를 다시 띄운 뒤 그 대화를 이어 붙인다. 모양이 틀리면 버린다 */
  terminalConversation?: unknown;
  /** 정리할 때 쓰는 샌드박스 id와 제공자 이름 */
  sandbox: { id: string; provider: string };
  /** 원격 미리보기 주소에 넣는 토큰. 이어서 작업해도 같은 주소를 쓰도록 남긴다 */
  previewToken?: string;
  /**
   * b-studio가 작업 복사본 밖에 기억해 두는 Git 상태(이슈 #699): 세션 브랜치, 마지막 체크포인트(HEAD), 원격 주소.
   * 이 컴퓨터 방식에서는 에이전트가 작업 복사본의 .git을 고칠 수 있어, 올리기·가져오기·터미널 턴 끝 검사가 이 값과
   * 지금 Git을 견준다. 이 필드가 생기기 전 기록에는 없다 — 그때는 처음 읽을 때 지금 값으로 채운다
   */
  git?: RememberedGit;
}

export function sessionFile(stateDir: string): string {
  return path.join(stateDir, FILE);
}

/** 세션 상태를 두는 폴더. 작업 복사본 세션은 작업 복사본 자체이고, 로컬 폴더 세션은 사용자 폴더 밖의 세션 폴더다 */
export function stateDirOf(snapshot: Pick<SessionSnapshot, 'workDir' | 'stateDir'>): string {
  return snapshot.stateDir ?? snapshot.workDir;
}

/**
 * 로컬 구독 CLI 러너(Command Code·OpenCode)가 쓰는 세션별 고정 상태 폴더. 러너의 HOME과 작업 폴더가 이 아래에 들어간다.
 *
 * 두 CLI 모두 대화 세션을 HOME 아래에 저장하므로(cmd: `$HOME/.commandcode/projects/<cwd 이름>/`,
 * opencode: `$XDG_DATA_HOME/opencode/opencode.db`) 실행 사이에 이어받으려면 HOME·cwd가 같아야 한다.
 * `session.json`·아티팩트와 같은 `.git/b-studio/` 아래에 두면 에이전트 도구가 닿지 않고 커밋에도 들어가지 않는다
 * (작업 폴더에 두면 `git add -A`가 체크포인트에 넣고 되돌리기의 `git clean -fd`가 지운다).
 */
function runnerStateDirOf(snapshot: Pick<SessionSnapshot, 'workDir' | 'stateDir'>, runner: 'commandcode' | 'opencode' | 'gemini'): string {
  return path.join(stateDirOf(snapshot), '.git', 'b-studio', runner);
}

/** Command Code 러너(`runCommandCodeAgent`의 `stateDir`)용 */
export function commandCodeStateDirOf(snapshot: Pick<SessionSnapshot, 'workDir' | 'stateDir'>): string {
  return runnerStateDirOf(snapshot, 'commandcode');
}

/** OpenCode 러너(`runOpenCodeAgent`의 `stateDir`)용 */
export function openCodeStateDirOf(snapshot: Pick<SessionSnapshot, 'workDir' | 'stateDir'>): string {
  return runnerStateDirOf(snapshot, 'opencode');
}

/** Gemini CLI 러너(`runGeminiAgent`의 `stateDir`)용 */
export function geminiStateDirOf(snapshot: Pick<SessionSnapshot, 'workDir' | 'stateDir'>): string {
  return runnerStateDirOf(snapshot, 'gemini');
}

/**
 * 화면의 대화와 체크포인트를 다시 그리는 이벤트만 남긴다.
 * 로그·사용량·서비스 상태는 샌드박스와 함께 사라지고, 세션 상태는 스냅샷이 들고 있으므로 뺀다
 */
export function trimHistory(history: readonly StudioEvent[]): StudioEvent[] {
  return history.filter((event) => !['log', 'usage', 'service', 'status', 'snapshot', 'deploy_log'].includes(event.type)).slice(-PERSISTED_HISTORY_LIMIT);
}

/**
 * 서버가 멈춰 끝나지 못한 요청과 되돌리기를 닫는다. 그대로 두면 다시 그린 화면이 "처리 중"에 멈춘다.
 * Rust 기록(`SessionRecord.closeUnfinished`, ADR-203 B1b)이 한다. 옛 구현은 `session-store-legacy.ts`의 `legacyCloseUnfinished`다
 */
export function closeUnfinished(history: readonly StudioEvent[], reason: string): StudioEvent[] {
  const record = new SessionRecord({ logs: false, history });
  record.closeUnfinished(reason);
  return record.history();
}

/** 저장 상태에서 history를 뺀 것. history는 세션의 기록(Rust `SessionRecord`)이 쥐고 저장할 때 `Persister`가 끼운다 */
export type PersistedBody = Omit<PersistedSession, 'history'>;

/**
 * 저장할 상태를 두 글자로 가른다. Rust가 `head`의 끝 `}`와 `tail`의 앞 `{`를 떼고 사이에 `,"history":[…],`를 끼워 파일을 쓴다.
 * `body`의 키 순서가 파일의 키 순서다: `version`·`savedAt`·`owner`·`snapshot`이 앞에 오고 나머지가 `history` 뒤에 그 순서로 온다
 * (옛 `JSON.stringify(toPersisted(session))`와 바이트까지 같다)
 */
export function splitPersisted(body: PersistedBody): { head: string; tail: string } {
  const { version, savedAt, owner, snapshot, ...rest } = body;
  return { head: JSON.stringify({ version, savedAt, owner, snapshot }), tail: JSON.stringify(rest) };
}

/** 쓰는 도중 서버가 멈춰도 이전 파일이 남도록 임시 파일에 쓴 뒤 이름을 바꾼다(Rust). `data.history`를 그대로 쓴다 */
export async function writeSession(data: PersistedSession): Promise<void> {
  const { history, ...body } = data;
  const { head, tail } = splitPersisted(body);
  await native.writeSessionRecord(new SessionRecord({ logs: false, history }).native, sessionFile(stateDirOf(data.snapshot)), head, tail, true);
}

/**
 * 보관 세션(이전 프로세스가 남긴 세션)을 쓴다. `record`의 history 전체를 쓴다(저장용으로 줄이지 않는다: 옛 구현이 `entry.record.history()`를 그대로 썼다).
 * 바이트는 이 호출 안에서 만든다
 */
export async function writeStoredSession(data: PersistedBody, record: SessionRecord, home: string): Promise<void> {
  const { head, tail } = splitPersisted(data);
  // 쓰는 곳은 저장 파일의 경로 글자(`stateDirOf(data.snapshot)`)가 아니라 이 세션을 읽어 온 폴더다(ADR-204)
  await native.writeSessionRecord(record.native, sessionFile(home), head, tail, true);
}

/**
 * 종료 신호 처리처럼 기다릴 수 없는 곳에서 쓴다. 진행 중일 수 있는 비동기 쓰기와 같은 임시 파일을 동시에 쓰지 않도록 이름을 달리한다.
 * 세션이 살아 있으면 `SessionPersist.flushSync`를 쓴다(이 함수는 `data.history`를 그대로 쓴다)
 */
export function writeSessionSync(data: PersistedSession): void {
  const { history, ...body } = data;
  const { head, tail } = splitPersisted(body);
  native.writeSessionRecordSync(new SessionRecord({ logs: false, history }).native, sessionFile(stateDirOf(data.snapshot)), head, tail, true);
}

/** 사이드카 파일(`test-results.json`·`requirements-draft.json`)을 원자적으로 쓴다: 임시 파일 → rename. `mode`는 새 파일의 권한 */
export function writeSidecar(file: string, text: string, mode?: number): Promise<void> {
  return native.writeFileAtomic(file, text, mode);
}

/** 읽은 세션 하나: `history`를 뺀 상태와 파일의 history를 올린 기록(logs 없음) */
export interface StoredSession {
  /** 이 세션을 읽어 온 폴더(`<root>/<항목 이름>`). 지우기·이어받기는 저장 파일의 경로 글자(`workDir`·`stateDir`)가 아니라 이 값으로 폴더를 정한다(ADR-204) */
  home: string;
  data: PersistedBody;
  record: SessionRecord;
  /** history를 기록에 올리지 못한 이유(없거나 배열이 아니거나 이벤트가 JSON 문법 밖이거나 너무 깊다). 있으면 그 세션만 건너뛰어야 한다. 파일은 그대로 둔다 */
  historyError?: string;
}

/** 세션 폴더들에서 저장된 세션을 읽는다(Rust). 폴더가 아닌 항목·읽을 수 없는 파일·JSON이 아니거나 형식이 다른 파일은 건너뛴다 */
export async function readStoredSessions(root: string): Promise<StoredSession[]> {
  const sessions: StoredSession[] = [];
  for (const found of await native.readSessions(root)) {
    let data: PersistedBody;
    try {
      data = JSON.parse(found.rest) as PersistedBody;
    } catch {
      continue;
    }
    sessions.push({ home: found.home, data, record: new SessionRecord({ native: found.record }), ...(found.historyError ? { historyError: found.historyError } : {}) });
  }
  return sessions;
}

/** `readStoredSessions`의 결과에 history를 객체로 다시 붙인다(시험과 옛 호출부용). history를 올리지 못한 세션은 뺀다 */
export async function readSessions(root: string): Promise<PersistedSession[]> {
  return (await readStoredSessions(root)).flatMap((stored) => (stored.historyError ? [] : [{ ...stored.data, history: stored.record.history() }]));
}

/** 신호 0은 보내지 않고 권한과 존재만 확인한다. 다른 사용자의 프로세스(EPERM)도 살아 있는 것으로 본다 */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 샌드박스가 없는 세션의 화면 상태. 이전 주소와 사용량은 더 이상 의미가 없다 */
export function archivedSnapshot(data: Pick<PersistedSession, 'snapshot'>, error?: string): SessionSnapshot {
  return {
    ...data.snapshot,
    status: 'stopped',
    running: false,
    cancelling: undefined,
    deploying: undefined,
    // 켜 둔 확인 선언 변경 허용은 읽어 온 세션에 이어지지 않는다(ADR-215). 옛 파일에 실려 있어도 읽을 수 있고, 여기서 뺀다
    allowCheckChangesNext: undefined,
    error,
    usage: undefined,
    services: data.snapshot.services.map((service) => ({ ...service, state: 'stopped' as const, url: undefined, previewUrl: undefined, detail: undefined })),
  };
}
