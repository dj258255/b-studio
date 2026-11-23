import { native } from '@b-studio/sandbox';

/**
 * 세션 터미널 감시(관문 파일 변조, 훅 없이 뜬 CLI)의 판정과, 감시가 실행의 열기·턴 끝에 닿는 자리(ADR-219, 4f B5e).
 * 판정은 Rust `crates/bstudio-session`의 `terminal::watch`가 한다(순수 함수). 여기는 검사 결과를 코어에 넘기고 돌려받은 상태를 들고 있는 껍데기이며,
 * `ps`·파일 읽기·`fs.watch`·타이머는 `session-terminal.ts`가 한다. 옛 판정은 지웠다(#1347).
 *
 * 이 모듈은 `session-terminal.ts`와 따로 둔다. `sessions.ts`가 감시에 묻는 두 함수(`liveWatchViolation`·`verifyWatch`)를 여기서 가져가므로, 터미널을 여는 모듈을 가짜로 바꾸는 시험에서도
 * 감시가 없는 세션(등록된 것이 없다)은 지금과 같게 통과한다.
 *
 * 부르는 자리마다 막는 쪽인지 여는 쪽인지:
 * - `liveWatchViolation`(실행을 열 때): 막는 쪽이다. 살아 있는 위반이 있으면 새 실행에 다시 적어 턴 끝에서 실패로 닫는다. 감시가 없으면(등록 없음) 아무것도 적지 않는다 — 감시하지 않는 터미널이다
 * - `verifyWatch`(턴 끝): 막는 쪽이다. 감시가 믿을 수 없는 상태면(한 번도 검사하지 못했거나 마지막 검사가 실패했거나 pid를 모른다) 그 자리에서 한 번 더 검사하고, 그래도 믿을 수 없으면 통과로 닫지 않는다
 */

export type WatchState = ReturnType<typeof native.terminalWatchNew>;

export type WatchFileCheck = { kind: 'failed' } | { kind: 'clean' } | { kind: 'changed'; names: string[]; restoreError?: string };
export type WatchPsCheck = { kind: 'unavailable' } | { kind: 'failed' } | { kind: 'listed'; pids: number[] };

export function newWatchState(kind: string): WatchState {
  return native.terminalWatchNew(kind);
}

/** 한 번의 검사 결과를 상태에 넣는다. 알릴 글은 순서대로다 */
export function watchRound(state: WatchState, file: WatchFileCheck, ps: WatchPsCheck): { state: WatchState; reports: string[] } {
  return native.terminalWatchRound(state, {
    file: file.kind,
    changed: file.kind === 'changed' ? file.names : [],
    ...(file.kind === 'changed' && file.restoreError !== undefined ? { restoreError: file.restoreError } : {}),
    ps: ps.kind,
    unhooked: ps.kind === 'listed' ? ps.pids : [],
  });
}

/** 지금 살아 있는 위반과, 감시를 믿을 수 없는 사유 */
export function watchView(state: WatchState): { live: string[]; problems: string[] } {
  return native.terminalWatchView(state);
}

/** 열린 터미널의 감시가 밖에 내주는 자리 */
export interface WatchControl {
  view(): { live: string[]; problems: string[] };
  /** 지금 검사를 한 번 더 한다(돌고 있으면 끝난 뒤 한 번 더). 던지지 않는다 */
  recheck(): Promise<void>;
}

// 개발 서버의 HMR로 모듈이 다시 로드돼도 열린 터미널의 감시를 잃지 않도록 전역에 둔다(터미널과 같은 이유)
const globalStore = globalThis as typeof globalThis & { __bStudioWatchControls?: Map<string, WatchControl> };
const controls = (globalStore.__bStudioWatchControls ??= new Map());

export function registerWatch(sessionId: string, control: WatchControl): void {
  controls.set(sessionId, control);
}

/** 이 감시의 등록을 지운다. 그 사이 다른 감시가 같은 세션에 등록됐으면(터미널을 다시 열었다) 건드리지 않는다 */
export function unregisterWatch(control: WatchControl): void {
  for (const [sessionId, registered] of controls) if (registered === control) controls.delete(sessionId);
}

/** 이 세션에 열린 터미널의 감시가 등록돼 있는가. 서버가 작업 폴더에 직접 쓰기 전에 CLI·사람이 같은 폴더에 쓰는 자리가 없는지 본다(막는 쪽) */
export function hasWatch(sessionId: string): boolean {
  return controls.has(sessionId);
}

async function recheck(control: WatchControl): Promise<void> {
  try {
    await control.recheck();
  } catch {
    // 검사를 다시 하지 못한 것은 아래의 상태가 그대로 말한다(믿을 수 없음이 남는다)
  }
}

/**
 * 새 실행을 열 때: 지금 살아 있는 위반이 있으면 그 글(없으면 undefined). 살아 있다고 나오면 한 번 더 검사해 이미 없어졌는지 본다
 * (사람이 방금 그 CLI를 끝냈다면 다음 검사 주기 전의 실행이 오탐으로 닫히지 않게 한다)
 */
export async function liveWatchViolation(sessionId: string): Promise<string | undefined> {
  const control = controls.get(sessionId);
  if (!control) return undefined;
  if (control.view().live.length === 0) return undefined;
  await recheck(control);
  const { live } = control.view();
  return live.length > 0 ? live.join(' / ') : undefined;
}

/**
 * 턴 끝에서 통과로 닫기 전에: 감시가 실행을 막아야 할 사유(없으면 undefined). 살아 있는 위반이 있거나, 감시를 믿을 수 없으면(마지막 검사가 실패했거나
 * 한 번도 돌지 않았거나 루트 pid를 모른다) 그 자리에서 한 번 더 검사하고, 그래도 그렇다면 그 사유다. 감시가 없는 터미널은 undefined다
 */
export async function verifyWatch(sessionId: string): Promise<string | undefined> {
  const control = controls.get(sessionId);
  if (!control) return undefined;
  let view = control.view();
  if (view.problems.length > 0) {
    await recheck(control);
    view = control.view();
  }
  if (view.live.length > 0) return view.live.join(' / ');
  if (view.problems.length > 0) return `관문 감시가 확인하지 못했습니다: ${view.problems.join(', ')}`;
  return undefined;
}
