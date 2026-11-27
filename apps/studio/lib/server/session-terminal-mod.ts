/**
 * Command Code의 mod가 불러와졌다는 신호(`/session-start`)를 기다리는 시계(보안 검토, ADR-233).
 *
 * 설정의 `mods.disableAll`·`mods.disabled`가 `--mod`로 준 mod를 끄면 CLI는 훅 없이 그냥 돈다. 띄우기 전 검사와 설정 쓰기 막기가 닫지 못한 길(셸로 설정을 쓰는 것, 검사 뒤에 사람이 설정을 바꾸는 것)에서
 * 훅이 없다는 것은 "신호가 오지 않는다"로만 보인다. 그래서 터미널을 연 뒤, 그리고 mod가 reload로 끝난 뒤 정해진 시간 안에 session-start가 오지 않으면 훅 없이 뜬 것으로 보고 위반으로 처리한다.
 * 이 모듈은 `session-terminal.ts`와 따로 둔다: `sessions.ts`가 알림을 보내는 자리라서, 터미널 모듈을 통째로 가짜로 바꾸는 시험에서도 가짜로 바뀌지 않게 한다(감시 모듈과 같은 이유).
 *
 * 부르는 자리마다 막는 쪽인지 여는 쪽인지:
 * - `armModClock`: 막는 쪽이다. 신호가 없으면 시간이 지난 뒤 위반을 부른다
 * - `noteModStarted`: 여는 쪽이다(시계를 멈춘다). session-start를 보낼 수 있는 쪽은 mod와 관문 토큰을 가진 쪽이다 — 토큰을 읽은 에이전트가 직접 보내면 속일 수 있다(남는 틈, ADR-233)
 * - `noteModReloading`: 막는 쪽이다. reload 뒤 새 신호가 오지 않으면 위반이다
 */

/** 기본 상한(밀리초). 폴더 신뢰 창에서 사람이 답하는 시간을 포함한다: 그 창이 떠 있는 동안에는 mod가 불러와지지 않는다(2026-11-27 실측) */
const DEFAULT_TIMEOUT_MS = 90_000;

/**
 * 이 시계를 거는 CLI. Command Code는 mod 파일, OpenCode(ADR-241)는 플러그인 파일, Gemini(ADR-242)는 설정의 훅이 붙는다. 같은 시계와 같은 신호(`/session-start`)를 쓴다.
 * 시험이 시간을 낮추는 환경 변수와 위반 글의 낱말만 CLI마다 다르다
 */
export type ModClockCli = 'commandcode' | 'opencode' | 'gemini';
const LABELS: Record<ModClockCli, { timeoutEnv: string; subject: string; loaded: string; failure: string }> = {
  commandcode: {
    timeoutEnv: 'B_STUDIO_COMMANDCODE_MOD_TIMEOUT_MS',
    subject: 'Command Code가',
    loaded: 'b-studio의 mod가 불러와졌다는',
    failure: '설정이 mod를 껐거나 mod를 읽지 못해',
  },
  opencode: {
    timeoutEnv: 'B_STUDIO_OPENCODE_MOD_TIMEOUT_MS',
    subject: 'OpenCode가',
    loaded: 'b-studio의 플러그인이 불러와졌다는',
    failure: '설정이 플러그인을 껐거나 플러그인을 읽지 못하거나 다른 플러그인이 있어',
  },
  gemini: {
    timeoutEnv: 'B_STUDIO_GEMINI_MOD_TIMEOUT_MS',
    subject: 'Gemini가',
    loaded: 'b-studio의 훅이 불러와졌다는',
    failure: '믿지 않는 폴더라서 설정의 훅이 하나도 등록되지 않았거나 설정이 훅을 껐거나 훅 명령이 실행되지 못해',
  },
};

/** 상한. 환경 변수는 낮추기만 한다(높이면 더 늦게 막을 뿐이라 받지 않는다). 양수가 아닌 값·글자·무한대는 무시한다 */
export function modLoadTimeoutMs(env: Record<string, string | undefined> = process.env, cli: ModClockCli = 'commandcode'): number {
  const wanted = Number(env[LABELS[cli].timeoutEnv]);
  return Number.isFinite(wanted) && wanted > 0 && wanted < DEFAULT_TIMEOUT_MS ? wanted : DEFAULT_TIMEOUT_MS;
}

interface ModClock {
  ms: number;
  cli: ModClockCli;
  onTimeout: (reason: string) => void;
  timer?: NodeJS.Timeout;
}

// 개발 서버의 HMR로 모듈이 다시 로드돼도 걸린 시계를 잃지 않도록 전역에 둔다(터미널과 같은 이유)
const globalStore = globalThis as typeof globalThis & { __bStudioModClocks?: Map<string, ModClock> };
const clocks = (globalStore.__bStudioModClocks ??= new Map());

function start(clock: ModClock, why: string): void {
  if (clock.timer) clearTimeout(clock.timer);
  const seconds = Math.max(1, Math.round(clock.ms / 1000));
  const label = LABELS[clock.cli];
  clock.timer = setTimeout(() => {
    clock.timer = undefined;
    clock.onTimeout(`${label.subject} ${why} ${seconds}초 안에 ${label.loaded} 신호(session-start)가 오지 않았습니다. ${label.failure} 훅 없이 뜬 것으로 보고 터미널을 닫습니다`);
  }, clock.ms);
  // 시계가 스튜디오 프로세스를 붙들지 않는다
  clock.timer.unref?.();
}

/** 터미널을 연 직후 건다. 같은 세션에 이미 걸려 있으면(터미널을 다시 열었다) 앞의 것을 세운다 */
export function armModClock(sessionId: string, onTimeout: (reason: string) => void, ms?: number, cli: ModClockCli = 'commandcode'): void {
  disarmModClock(sessionId);
  const clock: ModClock = { ms: ms ?? modLoadTimeoutMs(process.env, cli), cli, onTimeout };
  clocks.set(sessionId, clock);
  start(clock, '뜬 뒤');
}

/** mod가 불러와졌다(session-start). 시계를 세운다. 걸린 시계가 없으면 아무 일도 하지 않는다 */
export function noteModStarted(sessionId: string): void {
  const clock = clocks.get(sessionId);
  if (clock?.timer) {
    clearTimeout(clock.timer);
    clock.timer = undefined;
  }
}

/** mod가 reload로 끝났다. 같은 시간 안에 새 session-start가 오지 않으면 위반이다. 걸린 시계가 없으면 아무 일도 하지 않는다 */
export function noteModReloading(sessionId: string): void {
  const clock = clocks.get(sessionId);
  if (clock) start(clock, 'reload한 뒤');
}

/** 시계를 푼다(터미널이 닫히거나 끝났다) */
export function disarmModClock(sessionId: string): void {
  const clock = clocks.get(sessionId);
  if (!clock) return;
  if (clock.timer) clearTimeout(clock.timer);
  clocks.delete(sessionId);
}
