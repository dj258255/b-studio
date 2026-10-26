/**
 * desk의 키 처리. 상태와 받은 글자로 다음 상태와 할 일(effects)을 돌려주는 순수 함수다 — 네트워크·화면은 desk.ts가 한다.
 *
 * 앞글쇠는 Ctrl-b(tmux·herdr와 같다). 앞글쇠가 없으면 친 글자는 고른 칸의 CLI로 그대로 간다.
 * 앞글쇠 다음: 숫자(칸 고르기), o(다음 칸), ↑↓(사이드바, 앞글쇠가 이어지고 그동안 Ctrl-b는 새 앞글쇠다), Enter(고른 세션을 칸에 열기), n(새 요청), l(칸 수),
 * z(고른 칸 크게 보기), s(사이드바 숨기기), [(복사 모드), ?(도움말), g(설정 화면, #890), f(여러 AI 비교, #892), x(칸 비우기), q(나가기), Ctrl-b(Ctrl-b를 CLI로),
 * p(고른 세션 멈추기), r(멈춘 세션 이어서 작업), ,(고른 세션 이름 바꾸기), c(그냥 셸 칸, #873). 새 요청 입력 중에는 글자가 입력으로 간다.
 * 복사 모드·도움말·확인·이름 입력 중에는 키가 CLI로 가지 않는다(#863, #864).
 * 붙여넣기(bracketed paste 표지 사이)는 앞글쇠를 보지 않고 내용 그대로 칸에 간다(#860). 조각 끝에서 끊긴 이스케이프 열은 다음 조각까지 기다린다.
 * 앞글쇠는 설정(desk.json)으로 바꿀 수 있고(state.prefixKey), 마우스(SGR 열)는 CLI로 보내지 않고 mouse 할 일로 낸다. 칸·사이드바 자리는 desk.ts가 가린다(#874)
 * 스페이스 화면(#887, 앞글쇠 다음 w)에서는 앞글쇠 없이 방향키로 카드를 고르고 Enter로 고른 칸에 연다. Tab은 다음 스페이스, Esc는 칸 화면이다.
 * 스페이스 화면에서 친 글자는 CLI로 가지 않는다(칸이 보이지 않는다)
 * 기록 화면(앞글쇠 다음 h)과 세션 자세히(앞글쇠 다음 i, 스페이스 화면의 i)는 화면 전체를 쓰고, 열려 있는 동안 키는 그 화면으로 간다(#891)
 * 사용량 화면(#889, 앞글쇠 다음 u)에서는 앞글쇠 없이 ↑↓로 계정을 고르고 r로 다시 읽는다. Esc는 연 화면(스페이스·칸)으로 돌아간다.
 * 설정 화면(#890, 앞글쇠 다음 g, 스페이스·사용량 화면에서는 g만)은 그 화면들 위에 열린다. 열려 있으면 키와 붙여넣기는 모두 설정 화면이 받고(settings.ts),
 * Esc로 닫으면 아래 화면으로 돌아간다. 입력 칸이나 창이 없을 때의 u·w는 설정을 닫고 사용량 화면·스페이스 화면으로 간다
 * 작업 나누기 화면(#893, 앞글쇠 다음 t)은 본문 자리에 열린다. 열려 있으면 앞글쇠가 아닌 키와 붙여넣기는 그 화면이 받고(plans.ts),
 * 앞글쇠 다음 다른 화면 키(w·u·g·h·i·e·숫자 …)는 작업 나누기를 닫고 그 일을 한다. 열 때 다른 덮는 화면은 닫는다(덮는 화면은 하나만)
 * 요구사항·문서 화면(#894, 앞글쇠 다음 e, 스페이스 화면에서는 e만)도 본문 전체를 덮는다. 열려 있으면 키와 붙여넣기는 그 화면이 받고(requirements.ts), Esc로 닫는다
 * 여러 AI 비교 화면(#892, 앞글쇠 다음 f, 스페이스·사용량 화면에서는 f만)도 작업 나누기처럼 덮는 화면이다. 앞글쇠가 아닌 키와 붙여넣기는 그 화면이 받고(fleets.ts),
 * 앞글쇠 다음 다른 화면 키는 비교 화면을 닫고 그 일을 한다. 그래서 비교 화면 안의 w(승자)와 앞글쇠 다음 w(카드 화면)는 섞이지 않는다
 * 실행 화면(#895, 앞글쇠 다음 v, 스페이스 화면에서는 v만)도 같은 덮는 화면이다. 앞글쇠가 아닌 키(d 배포, b 되돌리기, l·s·G·o·/ …)와 붙여넣기는 그 화면이 받고(runtime.ts),
 * 앞글쇠 다음 다른 화면 키는 실행 화면을 닫고 그 일을 한다. 앞글쇠 다음 v는 닫는다
 * 폴더 열기 화면(#916, 앞글쇠 다음 a, 스페이스 화면에서는 a만, 새 요청의 프로젝트 고르기 끝 줄)도 같은 덮는 화면이다. 경로 입력이라 앞글쇠가 아닌 키와 붙여넣기는
 * 그 화면이 받고(folder.ts), 앞글쇠 다음 다른 화면 키는 폴더 열기를 닫고 그 일을 한다
 * 지금 변경 화면(#924, 앞글쇠 다음 d, 스페이스 화면에서는 d만)도 같은 덮는 화면이다. 앞글쇠가 아닌 키(c 의견, x 해결, S 묶어 넣기 …)와 붙여넣기는
 * 그 화면이 받고(changes.ts), 앞글쇠 다음 다른 화면 키는 지금 변경을 닫고 그 일을 한다. 앞글쇠 다음 d는 닫는다
 */
import { changesKey, changesPaste, type ChangesEffect, type ChangesState } from './changes';
import { fleetsKey, fleetsPaste, openFleets, type FleetsEffect, type FleetsState } from './fleets';
import { folderKey, folderPaste, openFolder, type FolderEffect, type FolderState } from './folder';
import type { KittyImages } from './kitty';
import { openPlans, plansKey, plansPaste, type PlansEffect, type PlansState } from './plans';
import { openRecords, recordsKey, type RecordsLoad, type RecordsState } from './records';
import { detailKey, openDetail, type DetailAction, type DetailState } from './session-detail';
import type { PaneLayout } from './screen';
import { openRuntime, runtimeKey, runtimePaste, type RuntimeEffect, type RuntimeState } from './runtime';
import { requirementsKey, requirementsPaste, type RequirementsEffect, type RequirementsState } from './requirements';
import { openSettings, settingsKey, settingsPaste, type SettingsEffect, type SettingsState } from './settings';
import { deskSessions, deskSpaces } from './sidebar';
import type { Sprite } from './sprite';
import type { Theme } from './theme';
import type { DeskAccountLimits, DeskItem, DeskLimits } from './types';

export const PREFIX = '\x02';
const ESC = '\x1b';
const UP = '\x1b[A';
const DOWN = '\x1b[B';
const UP_APP = '\x1bOA';
const DOWN_APP = '\x1bOB';
const RIGHT = '\x1b[C';
const LEFT = '\x1b[D';
const RIGHT_APP = '\x1bOC';
const LEFT_APP = '\x1bOD';
const PAGE_UP = '\x1b[5~';
const PAGE_DOWN = '\x1b[6~';
const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';
/** 조각 끝에서 아직 끝나지 않은 이스케이프 열(방향키·붙여넣기 표지·마우스 열의 앞부분) */
const INCOMPLETE_ESCAPE = /^\x1b(\[[0-9;?<=>]*[ -/]*|O)?$/;
/** SGR 마우스 열: 단추;x;y, 끝 글자 M은 누름(휠·끌기 포함), m은 뗌 */
const MOUSE = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/;
const LAYOUTS: readonly PaneLayout[] = [1, 2, 4];
/** 칸 자리 수(4칸 배치까지) */
export const SLOT_COUNT = 4;
/** 셸 칸의 id 앞부분. 스튜디오 세션 id와 섞이지 않는다(셸 칸은 desk가 직접 든 로컬 셸이다, #873) */
export const SHELL_ID = 'shell:';

export function isShellId(id: string | undefined): id is string {
  return id !== undefined && id.startsWith(SHELL_ID);
}

/** 셸 칸 자리에 다른 것을 열려고 할 때의 안내. 셸 칸은 x와 desk 나가기로만 끝낸다 */
export const SHELL_TAKEN = '이 칸에는 셸이 돌고 있습니다. 다른 칸을 고르거나 Ctrl-b x로 셸을 끝낸 뒤 엽니다';

/** 사이드바를 고르는 중의 안내 */
export const BROWSING = '사이드바 고르는 중: ↑↓로 옮기고 Enter로 칸에 엽니다. 다른 글쇠는 Ctrl-b 다음과 같습니다';

export interface PromptState {
  step: 'project' | 'request';
  /** 고를 프로젝트. 프로젝트 고르기의 끝 줄(projects.length)은 "+ 폴더 열기"다(#916) */
  projects: Array<{ id: string; name: string }>;
  projectIndex: number;
  text: string;
  /** 'rules'(규칙대로), 직접 고를 백엔드, 또는 `백엔드@계정id`(#885) */
  choices: string[];
  choice: number;
  /** 고를 것의 화면 이름(계정을 고를 때 "Codex · 피오"). 없으면 백엔드 이름이다 */
  labels?: Record<string, string>;
  /** 미리보기 한 줄 */
  preview?: string;
  sending?: boolean;
  /** 이 요청의 검증에서 확인 선언의 변경을 받아들인다(#916, ADR-164). Ctrl-t로 켜고 끈다 */
  allowCheckChanges?: boolean;
}

/** 복사 모드. search가 있으면 찾을 글을 쓰는 중이다. 보는 자리와 고른 범위는 칸 해석기(PaneTerminal)가 든다 */
export interface CopyState {
  search?: string;
}

/** 세션 조작을 하기 전에 한 번 묻는다(#864). 멈추면 CLI와 샌드박스가 내려가므로 실수로 누른 키로 하지 않게 한다 */
export interface ConfirmState {
  /** quit은 셸 칸이 남은 채 나가기, close는 살아 있는 셸 칸 끝내기(#873) */
  action: SessionAction | 'quit' | 'close';
  id: string;
  title: string;
}

export type SessionAction = 'stop' | 'resume';

export type CopyAction = 'enter' | 'up' | 'down' | 'pageUp' | 'pageDown' | 'top' | 'bottom' | 'mark' | 'yank' | 'exit' | 'search' | 'next';

export interface DeskState {
  items: DeskItem[];
  /** 사이드바에서 고른 항목(deskSessions 순서) */
  selected: number;
  layout: PaneLayout;
  /** 칸마다 연 세션 id. 길이는 늘 SLOT_COUNT다 */
  slots: Array<string | undefined>;
  focus: number;
  prefix: boolean;
  /** 앞글쇠 뒤 ↑↓로 사이드바를 고르는 중. 이때 다시 누른 Ctrl-b는 칸으로 보내지 않고 새 앞글쇠로 본다(#855) */
  browsing?: boolean;
  prompt?: PromptState;
  message?: string;
  /** 붙여넣기 표지 사이에 있다. sent는 이 붙여넣기의 앞부분을 이미 칸에 보냈는가 */
  pasting?: { sent: boolean };
  /** 조각 끝에서 끊겨 다음 조각을 기다리는 글. 오래 오지 않으면 flushPending으로 그대로 처리한다 */
  pending?: string;
  /** 고른 칸의 복사 모드(#863) */
  copy?: CopyState;
  /** 고른 칸 하나만 크게 본다. 다른 칸의 세션과 통로는 그대로다 */
  zoom?: boolean;
  sidebarHidden?: boolean;
  /** 도움말 화면. 다음 키 하나는 닫기만 한다 */
  help?: boolean;
  /** 세션 멈추기·이어서 작업을 묻는 중. y나 Enter면 하고, 다른 키면 그만둔다 */
  confirm?: ConfirmState;
  /** 세션 이름을 쓰는 중 */
  rename?: { id: string; text: string };
  /** 알린 뒤 아직 보지 않은 세션(사이드바에 !로 보인다, #864). desk.ts가 채우고 지운다 */
  flagged?: string[];
  /** 설정한 앞글쇠(없으면 Ctrl-b)와 화면에 보일 이름(#874) */
  prefixKey?: string;
  prefixLabel?: string;
  /** 본문에 칸 대신 스페이스 화면(고른 세션이 든 스페이스의 카드, #887)이나 사용량 화면(계정 카드, #889)을 보인다 */
  view?: 'space' | 'usage';
  /** 사용량 화면을 닫으면 돌아갈 화면(연 곳) */
  usageBack?: 'space';
  /** 사용량 화면에서 고른 계정(usage.accounts 순서) */
  usageSelected?: number;
  /** 계정마다의 사용량 한도. desk가 1분마다 받는다. 없으면 아직 받지 않았다 */
  usage?: UsageState;
  /** 그리는 색(없으면 어두운 팔레트, 24비트 색) */
  theme?: Theme;
  /** 카드 그림: 세션 id, AI 이름(claude-code·codex…), default 차례로 찾는다. 없으면 desk의 기본 그림 */
  sprites?: Readonly<Record<string, Sprite>>;
  /** 세션 id마다의 사용량 한도(카드 막대). 없으면 막대를 그리지 않는다 */
  limits?: Readonly<Record<string, DeskLimits>>;
  /** 움짤 시계(ms, #902). 카드 그림은 이 시각의 프레임을 그린다. 없으면 첫 프레임이다 */
  spriteClock?: number;
  /** 있으면 카드 그림을 Kitty 그래픽으로 그린다(Ghostty·kitty). desk가 보낸 이미지를 들고 있다 */
  kitty?: KittyImages;
  /** 기록 화면(#891): AI별 결과와 토큰 보고서 */
  records?: RecordsState;
  /** 세션 자세히(#891): 체크포인트, 확인·리뷰, 올리기, 지우기 */
  detail?: DetailState;
  /** 설정 화면(#890). 있으면 본문 전체가 설정 화면이다 */
  settings?: SettingsState;
  /** 고른 세션의 실행·배포·미리보기·저장소 화면(#895). 있으면 본문 전체가 이 화면이다 */
  runtime?: RuntimeState;
  /** 여러 AI 비교 화면(#892). 있으면 본문 전체가 비교 화면이다 */
  fleets?: FleetsState;
  /** 작업 나누기 화면(#893). 있으면 본문 자리가 이 화면이다 */
  plans?: PlansState;
  /** 요구사항·문서 화면(#894). 있으면 본문 전체가 그 세션의 요구사항 화면이다 */
  requirements?: RequirementsState;
  /** 폴더 열기 화면(#916). 있으면 본문 전체가 이 화면이다 */
  folder?: FolderState;
  /** 지금 변경 화면(#924). 있으면 본문 전체가 그 세션의 지금 변경이다 */
  changes?: ChangesState;
}

export interface UsageState {
  accounts: DeskAccountLimits[];
  /** 받은 때(ms) */
  receivedAt?: number;
  /** 마지막으로 읽지 못한 까닭(받았던 값은 그대로 둔다) */
  error?: string;
  /** 스튜디오가 알린 까닭(계정 목록 파일을 읽지 못함 등) */
  warning?: string;
  /** 사용량을 알려 주지 않는 스튜디오(옛 서버) */
  unsupported?: boolean;
}

export type Effect =
  | { type: 'input'; id: string; data: string }
  /** 붙여 넣은 글. part가 없으면 붙여넣기 하나 전체, 있으면 여러 조각으로 온 것의 앞·가운데·끝이다 */
  | { type: 'paste'; id: string; data: string; part?: 'start' | 'middle' | 'end' }
  | { type: 'open'; slot: number; id: string }
  /** 이미 칸에 있는 세션을 다시 골랐다: 터미널이 끝났거나 열지 못했으면 다시 연다 */
  | { type: 'reopen'; id: string }
  /** 칸 비우기. 셸 칸이면 칸을 비우는 것은 desk가 정한다(살아 있으면 한 번 묻고, confirmed면 끝낸다) */
  | { type: 'close'; slot: number; id: string; confirmed?: boolean }
  /** 칸 배치가 바뀌었다(칸 수, 크게 보기, 사이드바) */
  | { type: 'layout' }
  | { type: 'copy'; id: string; action: CopyAction; text?: string }
  /** confirmed: 셸 칸이 남은 채 나가도 된다고 답했다 */
  | { type: 'quit'; confirmed?: boolean }
  /** 고른 칸에 그냥 셸 칸을 연다(#873) */
  | { type: 'shell'; slot: number }
  | { type: 'prompt' }
  | { type: 'preview'; text: string }
  | { type: 'submit'; projectId: string; request: string; choice: string; allowCheckChanges?: true }
  | { type: 'session'; action: SessionAction; id: string }
  | { type: 'rename'; id: string; label: string }
  /** 사용량을 읽는다(#889). refresh면 스튜디오에 다시 읽기를 청하고, 아니면 받은 지 오래됐을 때만 묻는다 */
  | { type: 'usage'; refresh: boolean }
  /** 마우스(#874). x·y는 화면 좌표(0부터), button은 SGR 단추 값(64·65는 휠), release는 뗌 */
  | { type: 'mouse'; button: number; x: number; y: number; release: boolean }
  /** 기록 화면(#891): open이면 프로젝트 목록과 AI별 결과를 불러오고, load면 그것을 불러온다 */
  | { type: 'records'; open?: true; load?: RecordsLoad }
  /** 세션 자세히(#891)에서 서버에 보낼 일 */
  | { type: 'detail'; action: DetailAction }
  /** 설정 화면을 연다(#890). 계정·규칙은 desk가 받아 채운다 */
  | { type: 'settings-open' }
  /** 설정 화면이 낸 할 일 */
  | { type: 'settings'; effect: SettingsEffect }
  /** 실행 화면을 열었다(#895). desk가 그 세션의 이벤트를 받기 시작한다 */
  | { type: 'runtime-open'; id: string }
  /** 실행 화면이 낸 할 일 */
  | { type: 'runtime'; effect: RuntimeEffect }
  /** 여러 AI 비교 화면을 연다(#892). 목록은 desk가 받아 채운다 */
  | { type: 'fleets-open' }
  /** 비교 화면이 낸 할 일 */
  | { type: 'fleets'; effect: FleetsEffect }
  /** 작업 나누기 화면을 연다(#893). 목록은 desk가 받아 채운다 */
  | { type: 'plans-open' }
  /** 작업 나누기 화면이 낸 할 일 */
  | { type: 'plans'; effect: PlansEffect }
  /** 요구사항·문서 화면을 연다(#894). 요구사항은 desk가 받아 채운다 */
  | { type: 'requirements-open'; id: string; title: string }
  /** 요구사항 화면이 낸 할 일. close는 화면을 닫았다 */
  | { type: 'requirements'; effect: RequirementsEffect | { type: 'close' } }
  /** 폴더 열기 화면이 낸 할 일(#916). 처음 열 때도 홈 목록을 받는 list를 낸다 */
  | { type: 'folder'; effect: FolderEffect }
  /** 지금 변경 화면을 연다(#924). 의견은 desk가 읽어 채우고 변경을 받는다 */
  | { type: 'changes-open'; id: string; title: string }
  /** 지금 변경 화면이 낸 할 일 */
  | { type: 'changes'; effect: ChangesEffect };

export function initialState(): DeskState {
  return { items: [], selected: 0, layout: 1, slots: Array.from({ length: SLOT_COUNT }, () => undefined), focus: 0, prefix: false };
}

/** 지금 앞글쇠 */
function prefixOf(state: DeskState): string {
  return state.prefixKey ?? PREFIX;
}

/** 받은 글자에서 키 하나를 꺼낸다: 방향키 같은 이스케이프 열, 아니면 글자 하나(서로게이트 쌍 포함) */
function nextKey(input: string, at: number): string {
  if (input[at] === ESC) {
    const csi = /^\x1b(\[[0-9;?<=>]*[ -/]*[@-~]|O[@-~])/.exec(input.slice(at));
    if (csi) return csi[0];
    return ESC;
  }
  const code = input.codePointAt(at)!;
  return String.fromCodePoint(code);
}

export function handleInput(start: DeskState, chunk: string, final = false): { state: DeskState; effects: Effect[] } {
  let state: DeskState = start.pending ? { ...start, pending: undefined } : start;
  const input = (start.pending ?? '') + chunk;
  const effects: Effect[] = [];
  let forward = '';
  const flush = () => {
    const id = state.slots[state.focus];
    if (forward && id) effects.push({ type: 'input', id, data: forward });
    forward = '';
  };

  let at = 0;
  while (at < input.length) {
    if (state.pasting) {
      const end = input.indexOf(PASTE_END, at);
      let content: string;
      if (end >= 0) {
        content = input.slice(at, end);
        at = end + PASTE_END.length;
      } else {
        // 끝 표지의 앞부분으로 끝나면 그만큼은 다음 조각까지 둔다
        const hold = final ? 0 : heldTail(input.slice(at), PASTE_END);
        content = input.slice(at, input.length - hold);
        if (hold) state = { ...state, pending: input.slice(input.length - hold) };
        at = input.length;
      }
      state = pasteContent(state, content, end >= 0, effects);
      continue;
    }
    if (input.startsWith(PASTE_START, at)) {
      flush();
      at += PASTE_START.length;
      // 앞글쇠를 누른 채 붙여 넣었으면 앞글쇠는 버린다
      state = { ...state, prefix: false, browsing: false, pasting: { sent: false } };
      continue;
    }
    if (!final && input[at] === ESC && INCOMPLETE_ESCAPE.test(input.slice(at))) {
      state = { ...state, pending: input.slice(at) };
      break;
    }
    const mouse = input[at] === ESC ? MOUSE.exec(input.slice(at)) : null;
    if (mouse) {
      flush();
      at += mouse[0].length;
      // 묻거나 쓰는 중(도움말·확인·이름·새 요청·설정·요구사항·기록·세션 자세히·작업 나누기·여러 AI 비교·실행)의 마우스는 버린다. 앞글쇠 뒤의 마우스는 앞글쇠를 푼다
      if (state.help || state.confirm || state.rename || state.prompt || state.settings || state.requirements || state.records || state.detail || state.plans || state.fleets || state.runtime || state.folder || state.changes) continue;
      if (state.prefix) state = { ...state, prefix: false, browsing: false, ...(state.message === BROWSING ? { message: undefined } : {}) };
      effects.push({ type: 'mouse', button: Number(mouse[1]), x: Number(mouse[2]) - 1, y: Number(mouse[3]) - 1, release: mouse[4] === 'm' });
      continue;
    }
    if (state.settings) {
      const key = nextKey(input, at);
      at += key.length;
      const settings = state.settings;
      const browsing = !settings.form && !settings.picker && !settings.login && !settings.confirm;
      if (browsing && (key === 'u' || key === 'w')) {
        // 설정을 닫고 사용량 화면(u)이나 스페이스 화면(w)으로 간다. 저장하지 않은 규칙이 있으면 Esc처럼 먼저 묻는다
        if (settings.rulesDirty) {
          state = { ...state, settings: settingsKey(settings, ESC).state };
          continue;
        }
        effects.push({ type: 'settings', effect: { type: 'close' } });
        state = { ...state, settings: undefined };
        if (key === 'w') state = { ...state, view: 'space', usageBack: undefined };
        else if (state.view !== 'usage') state = commandKey({ ...state, prefix: true }, 'u', effects);
        continue;
      }
      const result = settingsKey(settings, key);
      state = { ...state, settings: result.state };
      for (const effect of result.effects) effects.push({ type: 'settings', effect });
      continue;
    }
    if (state.requirements) {
      // 요구사항 화면(#894)이 열려 있으면 키는 모두 그 화면이 받는다. 칸으로 가지 않는다
      const key = nextKey(input, at);
      at += key.length;
      const result = requirementsKey(state.requirements, key);
      state = { ...state, requirements: result.state };
      for (const effect of result.effects) effects.push({ type: 'requirements', effect });
      if (!result.state) effects.push({ type: 'requirements', effect: { type: 'close' } });
      continue;
    }
    if (state.help) {
      // 도움말은 아무 키로 닫는다. 그 키는 다른 데로 보내지 않는다
      at += nextKey(input, at).length;
      state = { ...state, help: false };
      continue;
    }
    if (state.records) {
      const key = nextKey(input, at);
      at += key.length;
      const next = recordsKey(state.records, key, Date.now());
      state = { ...state, records: next.records };
      if (next.load) effects.push({ type: 'records', load: next.load });
      continue;
    }
    if (state.detail) {
      const key = nextKey(input, at);
      at += key.length;
      const next = detailKey(state.detail, key);
      state = { ...state, detail: next.detail };
      if (next.action) effects.push({ type: 'detail', action: next.action });
      continue;
    }
    if (state.copy) {
      const key = nextKey(input, at);
      at += key.length;
      state = copyKey(state, key, effects);
      continue;
    }
    if (state.confirm) {
      const key = nextKey(input, at);
      at += key.length;
      state = confirmKey(state, key, effects);
      continue;
    }
    if (state.rename) {
      const key = nextKey(input, at);
      at += key.length;
      state = renameKey(state, key, effects);
      continue;
    }
    if (state.prompt) {
      const key = nextKey(input, at);
      at += key.length;
      state = promptKey(state, key, effects);
      continue;
    }
    if (state.changes && !state.prefix && input[at] !== prefixOf(state)) {
      // 지금 변경(#924): 앞글쇠가 아닌 키는 모두 그 화면이 받는다. 앞글쇠 다음 키는 commandKey가 받는다
      const key = nextKey(input, at);
      at += key.length;
      const result = changesKey(state.changes, key);
      state = { ...state, changes: result.state };
      for (const effect of result.effects) effects.push({ type: 'changes', effect });
      continue;
    }
    if (state.folder && !state.prefix && input[at] !== prefixOf(state)) {
      // 폴더 열기(#916): 앞글쇠가 아닌 키는 모두 경로 입력이다. 앞글쇠 다음 키는 commandKey가 받는다
      const key = nextKey(input, at);
      at += key.length;
      const result = folderKey(state.folder, key);
      state = { ...state, folder: result.state };
      for (const effect of result.effects) effects.push({ type: 'folder', effect });
      continue;
    }
    if (state.runtime && !state.prefix && input[at] !== prefixOf(state)) {
      // 실행 화면(#895): 앞글쇠가 아닌 키는 모두 그 화면이 받는다(d 배포, b 되돌리기, l 로그, s 서비스, / 찾기 …). 앞글쇠 다음 키는 commandKey가 받는다
      const key = nextKey(input, at);
      at += key.length;
      const result = runtimeKey(state.runtime, key);
      state = { ...state, runtime: result.state };
      for (const effect of result.effects) effects.push({ type: 'runtime', effect });
      continue;
    }
    if (state.fleets && !state.prefix && input[at] !== prefixOf(state)) {
      // 여러 AI 비교 화면(#892): 앞글쇠가 아닌 키는 모두 그 화면이 받는다(w는 승자 고르기다). 앞글쇠 다음 키는 commandKey가 받는다
      const key = nextKey(input, at);
      at += key.length;
      const result = fleetsKey(state.fleets, key);
      state = { ...state, fleets: result.state };
      for (const effect of result.effects) effects.push({ type: 'fleets', effect });
      continue;
    }
    if (state.plans && !state.prefix && input[at] !== prefixOf(state)) {
      const key = nextKey(input, at);
      at += key.length;
      const result = plansKey(state.plans, key);
      state = { ...state, plans: result.state };
      for (const effect of result.effects) effects.push({ type: 'plans', effect });
      continue;
    }
    if (state.prefix) {
      const key = nextKey(input, at);
      at += key.length;
      state = commandKey(state, key, effects);
      continue;
    }
    if (state.view === 'space' && input[at] !== prefixOf(state)) {
      const key = nextKey(input, at);
      at += key.length;
      state = spaceKey(state, key, effects);
      continue;
    }
    if (state.view === 'usage' && input[at] !== prefixOf(state)) {
      const key = nextKey(input, at);
      at += key.length;
      state = usageKey(state, key, effects);
      continue;
    }
    const char = input[at]!;
    if (char === prefixOf(state)) {
      flush();
      state = { ...state, prefix: true, message: undefined };
      at += 1;
      continue;
    }
    forward += char;
    at += 1;
  }
  flush();
  return { state, effects };
}

/** 기다리던 글(pending)을 더 기다리지 않고 처리한다: 혼자 온 Esc는 Esc다 */
export function flushPending(state: DeskState): { state: DeskState; effects: Effect[] } {
  if (!state.pending) return { state, effects: [] };
  return handleInput(state, '', true);
}

/** text가 marker의 앞부분으로 끝나면 그 길이 */
function heldTail(text: string, marker: string): number {
  for (let length = Math.min(marker.length - 1, text.length); length > 0; length--) {
    if (text.endsWith(marker.slice(0, length))) return length;
  }
  return 0;
}

function pasteContent(state: DeskState, content: string, ended: boolean, effects: Effect[]): DeskState {
  const pasting = state.pasting!;
  const next: DeskState = ended ? { ...state, pasting: undefined } : { ...state, pasting: { sent: pasting.sent || content.length > 0 } };
  // 설정 화면이 열려 있으면 그 입력 칸에 넣는다(#890)
  if (state.settings) return { ...next, settings: settingsPaste(state.settings, content) };
  // 비교 화면이 열려 있으면 새 비교의 입력 칸에 넣는다(#892)
  if (state.fleets) return { ...next, fleets: fleetsPaste(state.fleets, content) };
  // 작업 나누기 화면이 열려 있으면 새 계획 요청에 넣는다(#893)
  if (state.plans) return { ...next, plans: plansPaste(state.plans, content) };
  // 요구사항 화면이면 확인 메모 칸에 넣는다(#894)
  if (state.requirements) return { ...next, requirements: requirementsPaste(state.requirements, content) };
  if (state.detail?.resolving) {
    // 리뷰 지적을 닫을 까닭에는 한 줄로 넣는다
    const clean = content.replace(/\r\n?|\n/g, ' ').replace(/[\x00-\x1f\x7f]/g, '');
    return { ...next, detail: { ...state.detail, resolving: { ...state.detail.resolving, text: state.detail.resolving.text + clean } } };
  }
  // 지금 변경(#924)은 의견을 쓰는 중에만 받는다
  if (state.changes) return { ...next, changes: changesPaste(state.changes, content) };
  // 폴더 열기(#916)는 경로 입력 칸에 넣는다
  if (state.folder) {
    const result = folderPaste(state.folder, content);
    for (const effect of result.effects) effects.push({ type: 'folder', effect });
    return { ...next, folder: result.state };
  }
  // 실행 화면(#895)은 로그에서 찾는 글을 쓰는 중일 때만 받는다
  if (state.runtime) return { ...next, runtime: runtimePaste(state.runtime, content) };
  // 복사 모드나 도움말·기록 화면·세션 자세히를 보는 중, 세션 조작을 묻는 중, 스페이스·사용량 화면에서 붙여 넣은 글은 CLI로 보내지 않는다
  if (state.copy || state.help || state.confirm || state.requirements || state.records || state.detail || (state.view !== undefined && !state.rename && !state.prompt)) return next;
  if (state.rename) {
    // 이름에는 한 줄로 넣는다
    const clean = content.replace(/\r\n?|\n/g, ' ').replace(/[\x00-\x1f\x7f]/g, '');
    return { ...next, rename: { ...state.rename, text: state.rename.text + clean } };
  }
  if (state.prompt) {
    // 요청 글에는 한 줄로 넣는다: 줄바꿈은 빈칸, 다른 제어 글자는 버린다
    const clean = content.replace(/\r\n?|\n/g, ' ').replace(/[\x00-\x1f\x7f]/g, '');
    if (!clean) return next;
    const text = state.prompt.text + clean;
    const last = effects.findIndex((effect) => effect.type === 'preview');
    if (last >= 0) effects.splice(last, 1);
    effects.push({ type: 'preview', text });
    return { ...next, prompt: { ...state.prompt, text } };
  }
  const id = state.slots[state.focus];
  if (!id) return next;
  const part = pasting.sent ? (ended ? 'end' : 'middle') : ended ? undefined : 'start';
  if (content || part === 'end') effects.push({ type: 'paste', id, data: content, ...(part ? { part } : {}) });
  return next;
}

/** 안쪽 CLI가 응용 커서 키 모드(DECCKM)를 켰으면 방향키·Home·End를 그 꼴(SS3)로 바꾼다 */
export function toInnerKeys(data: string, modes: { appCursor: boolean }): string {
  return modes.appCursor ? data.replace(/\x1b\[([ABCDHF])/g, '\x1bO$1') : data;
}

/** 칸에 넣을 붙여넣기. CLI가 bracketed paste를 켰을 때만 표지로 감싼다. 내용 안의 표지는 지워 붙여넣기를 일찍 끝내지 못하게 한다 */
export function pasteFor(effect: Extract<Effect, { type: 'paste' }>, bracketed: boolean): string {
  const clean = effect.data.split(PASTE_END).join('').split(PASTE_START).join('');
  if (!bracketed) return clean;
  const head = effect.part === undefined || effect.part === 'start' ? PASTE_START : '';
  const tail = effect.part === undefined || effect.part === 'end' ? PASTE_END : '';
  return head + clean + tail;
}

/** 목록을 새로 받았을 때 고르던 세션의 새 순번. 세션이 사라졌으면 같은 자리(범위 안)다 */
export function reselect(before: readonly DeskItem[], selected: number, after: readonly DeskItem[]): number {
  const id = deskSessions(before)[selected]?.id;
  const sessions = deskSessions(after);
  const index = id === undefined ? -1 : sessions.findIndex((entry) => entry.id === id);
  if (index >= 0) return index;
  return Math.max(0, Math.min(selected, sessions.length - 1));
}

function commandKey(start: DeskState, key: string, effects: Effect[]): DeskState {
  let state = start;
  if (state.plans && key !== 't' && key !== '?' && key !== ESC && key !== prefixOf(state)) {
    // 다른 화면이나 칸을 다루는 키는 작업 나누기를 닫고 한다(#893)
    effects.push({ type: 'plans', effect: { type: 'close' } });
    state = { ...state, plans: undefined };
  }
  if (state.fleets && key !== 'f' && key !== '?' && key !== ESC && key !== prefixOf(state)) {
    // 다른 화면이나 칸을 다루는 키는 여러 AI 비교를 닫고 한다(#892). 앞글쇠 다음 w는 승자가 아니라 카드 화면이다
    effects.push({ type: 'fleets', effect: { type: 'close' } });
    state = { ...state, fleets: undefined };
  }
  if (state.folder && key !== 'a' && key !== '?' && key !== ESC && key !== prefixOf(state)) {
    // 다른 화면이나 칸을 다루는 키는 폴더 열기를 닫고 한다(#916)
    state = { ...state, folder: undefined };
  }
  if (state.changes && key !== 'd' && key !== '?' && key !== ESC && key !== prefixOf(state)) {
    // 다른 화면이나 칸을 다루는 키는 지금 변경을 닫고 한다(#924)
    effects.push({ type: 'changes', effect: { type: 'close' } });
    state = { ...state, changes: undefined };
  }
  if (state.runtime && key !== 'v' && key !== '?' && key !== ESC && key !== prefixOf(state)) {
    // 다른 화면이나 칸을 다루는 키는 실행 화면을 닫고 한다(#895). 앞글쇠 다음 s·l·o는 실행 화면의 키가 아니라 desk의 키다
    effects.push({ type: 'runtime', effect: { type: 'close' } });
    state = { ...state, runtime: undefined };
  }
  if (key === 'a') {
    const done = { ...state, prefix: false, browsing: false, ...(state.message === BROWSING ? { message: undefined } : {}) };
    // 같은 키는 닫는다
    if (state.folder) return { ...done, folder: undefined };
    return openFolderScreen(done, effects);
  }
  if (key === 't') {
    const done = { ...state, prefix: false, browsing: false, ...(state.message === BROWSING ? { message: undefined } : {}) };
    if (state.plans) {
      effects.push({ type: 'plans', effect: { type: 'close' } });
      return { ...done, plans: undefined };
    }
    effects.push({ type: 'plans-open' });
    // 덮는 화면은 하나만 둔다
    return { ...done, plans: openPlans(), prompt: undefined, settings: undefined, records: undefined, detail: undefined, requirements: undefined, fleets: undefined, folder: undefined, changes: undefined };
  }
  if (key === 'f') {
    const done = { ...state, prefix: false, browsing: false, ...(state.message === BROWSING ? { message: undefined } : {}) };
    if (state.fleets) {
      effects.push({ type: 'fleets', effect: { type: 'close' } });
      return { ...done, fleets: undefined };
    }
    if (state.plans) effects.push({ type: 'plans', effect: { type: 'close' } });
    // 바로 연다(이어서 친 키가 비교 화면으로 가게). 목록은 desk가 받아 채운다. 덮는 화면은 하나만 둔다
    effects.push({ type: 'fleets-open' });
    return { ...done, fleets: openFleets(), prompt: undefined, settings: undefined, records: undefined, detail: undefined, requirements: undefined, plans: undefined, folder: undefined, changes: undefined };
  }
  const done = { ...state, prefix: false, browsing: false, ...(state.message === BROWSING ? { message: undefined } : {}) };
  const sessions = deskSessions(state.items);
  if (key === prefixOf(state)) {
    // 사이드바를 고르다가 습관대로 다시 누른 Ctrl-b는 새 앞글쇠다. 칸으로 보내면 다음 글자가 CLI 입력이 된다
    if (state.browsing) return { ...state, prefix: true, browsing: false, message: undefined };
    const id = state.slots[state.focus];
    if (id) effects.push({ type: 'input', id, data: key });
    return done;
  }
  if (key === 'w') return { ...done, view: state.view === 'space' ? undefined : 'space' };
  if (key === 'u') {
    if (state.view === 'usage') return closeUsage(done);
    effects.push({ type: 'usage', refresh: false });
    return { ...done, view: 'usage', usageBack: state.view === 'space' ? 'space' : undefined };
  }
  // 칸을 다루는 키는 칸 화면으로 돌아와서 한다
  if (state.view !== undefined && /^[1-4ozl[xc\r\n]$/.test(key)) return commandKey({ ...state, view: undefined }, key, effects);
  if (/^[1-4]$/.test(key)) {
    const slot = Number(key) - 1;
    if (slot >= state.layout) return done;
    // 크게 보기 중이면 새로 고른 칸을 크게 본다
    if (state.zoom && slot !== state.focus) effects.push({ type: 'layout' });
    return { ...done, focus: slot };
  }
  if (key === 'o') {
    if (state.layout < 2) return done;
    if (state.zoom) effects.push({ type: 'layout' });
    return { ...done, focus: (state.focus + 1) % state.layout };
  }
  if (key === 'z') {
    effects.push({ type: 'layout' });
    return { ...done, zoom: !state.zoom };
  }
  if (key === 's') {
    effects.push({ type: 'layout' });
    return { ...done, sidebarHidden: !state.sidebarHidden };
  }
  if (key === '?') return { ...done, help: true };
  if (key === 'h') {
    // 프로젝트 목록과 결과는 desk가 불러와 채운다. 그동안도 키는 기록 화면으로 간다
    effects.push({ type: 'records', open: true });
    return { ...done, records: openRecords([], sessions[state.selected]?.projectName) };
  }
  if (key === 'i') {
    const item = sessions[state.selected];
    if (!item) return { ...done, message: '사이드바에 고를 세션이 없습니다' };
    effects.push({ type: 'detail', action: { kind: 'load' } });
    return { ...done, detail: openDetail(item) };
  }
  if (key === 'g') {
    // 바로 연다(이어서 친 키가 설정 화면으로 가게). 설정 값·계정·규칙은 desk가 채운다
    effects.push({ type: 'settings-open' });
    return { ...done, settings: openSettings({ config: {}, sprites: [] }), prompt: undefined };
  }
  if (key === 'v') {
    // 칸 화면이면 고른 칸의 세션, 아니면(스페이스 화면·사이드바) 고른 세션
    const slot = state.view === undefined ? state.slots[state.focus] : undefined;
    const target = (slot && !isShellId(slot) ? sessions.find((entry) => entry.id === slot) : undefined) ?? sessions[state.selected];
    if (state.runtime) {
      // 같은 키는 닫는다
      effects.push({ type: 'runtime', effect: { type: 'close' } });
      return { ...done, runtime: undefined };
    }
    if (!target) return { ...done, message: '실행 화면을 열 세션이 없습니다' };
    // 덮는 화면은 하나만 둔다
    if (state.plans) effects.push({ type: 'plans', effect: { type: 'close' } });
    if (state.fleets) effects.push({ type: 'fleets', effect: { type: 'close' } });
    effects.push({ type: 'runtime-open', id: target.id });
    return { ...done, runtime: openRuntime(target.id, target.title), prompt: undefined, settings: undefined, records: undefined, detail: undefined, requirements: undefined, plans: undefined, fleets: undefined, folder: undefined, changes: undefined };
  }
  if (key === 'd') {
    if (state.changes) {
      // 같은 키는 닫는다
      effects.push({ type: 'changes', effect: { type: 'close' } });
      return { ...done, changes: undefined };
    }
    // 지금 변경(#924): 칸 화면이면 고른 칸의 세션, 아니면(스페이스 화면·사이드바) 고른 세션
    const focused = state.view === undefined ? state.slots[state.focus] : undefined;
    const item = (focused && !isShellId(focused) ? sessions.find((entry) => entry.id === focused) : undefined) ?? sessions[state.selected];
    if (!item) return { ...done, message: '지금 변경을 볼 세션이 없습니다' };
    // 덮는 화면은 하나만 둔다
    if (state.plans) effects.push({ type: 'plans', effect: { type: 'close' } });
    if (state.fleets) effects.push({ type: 'fleets', effect: { type: 'close' } });
    if (state.runtime) effects.push({ type: 'runtime', effect: { type: 'close' } });
    effects.push({ type: 'changes-open', id: item.id, title: item.title });
    return { ...done, prompt: undefined, settings: undefined, records: undefined, detail: undefined, requirements: undefined, plans: undefined, fleets: undefined, runtime: undefined, folder: undefined };
  }
  if (key === 'e') {
    // 요구사항·문서(#894): 카드·사용량 화면이면 고른 카드의 세션, 칸 화면이면 고른 칸의 세션(셸·빈 칸이면 사이드바에서 고른 세션)
    const focused = state.view === undefined ? state.slots[state.focus] : undefined;
    const item = (focused && !isShellId(focused) ? sessions.find((entry) => entry.id === focused) : undefined) ?? sessions[state.selected];
    if (!item) return { ...done, message: '요구사항을 볼 세션이 없습니다' };
    effects.push({ type: 'requirements-open', id: item.id, title: item.title });
    return done;
  }
  if (key === '[') {
    const id = state.slots[state.focus];
    if (!id) return { ...done, message: '빈 칸에는 복사 모드가 없습니다' };
    effects.push({ type: 'copy', id, action: 'enter' });
    return { ...done, copy: {} };
  }
  if (key === UP || key === UP_APP) return { ...state, browsing: true, message: BROWSING, selected: Math.max(0, state.selected - 1) };
  if (key === DOWN || key === DOWN_APP) return { ...state, browsing: true, message: BROWSING, selected: Math.max(0, Math.min(sessions.length - 1, state.selected + 1)) };
  if (key === '\r' || key === '\n') {
    const item = sessions[state.selected];
    if (!item) return done;
    const already = state.slots.findIndex((id, slot) => id === item.id && slot < state.layout);
    if (already >= 0) {
      effects.push({ type: 'reopen', id: item.id });
      return { ...done, focus: already };
    }
    if (isShellId(state.slots[state.focus])) return { ...done, message: SHELL_TAKEN };
    const slots = [...state.slots];
    slots[state.focus] = item.id;
    effects.push({ type: 'open', slot: state.focus, id: item.id });
    return { ...done, slots };
  }
  if (key === 'n') {
    effects.push({ type: 'prompt' });
    return done;
  }
  if (key === 'l') {
    const layout = LAYOUTS[(LAYOUTS.indexOf(state.layout) + 1) % LAYOUTS.length]!;
    // 줄어든 배치 밖의 세션 칸은 비운다(세션은 계속 돈다). 셸 칸은 가려 두고 셸도 계속 돈다: 칸 수를 다시 늘리면 그 자리에 보인다
    const slots = state.slots.map((id, slot) => (slot < layout || isShellId(id) ? id : undefined));
    effects.push({ type: 'layout' });
    return { ...done, layout, slots, focus: Math.min(state.focus, layout - 1), zoom: false };
  }
  if (key === 'x') {
    const id = state.slots[state.focus];
    if (!id) return done;
    // 셸 칸은 비우면 셸이 끝난다. 살아 있는지는 desk가 알아 한 번 묻는다
    if (isShellId(id)) {
      effects.push({ type: 'close', slot: state.focus, id });
      return done;
    }
    const slots = [...state.slots];
    slots[state.focus] = undefined;
    effects.push({ type: 'close', slot: state.focus, id });
    return { ...done, slots };
  }
  if (key === 'q') {
    effects.push({ type: 'quit' });
    return done;
  }
  if (key === 'c') {
    if (isShellId(state.slots[state.focus])) return { ...done, message: SHELL_TAKEN };
    effects.push({ type: 'shell', slot: state.focus });
    return done;
  }
  if (key === 'p' || key === 'r' || key === ',') {
    const item = sessions[state.selected];
    if (!item) return { ...done, message: '사이드바에 고를 세션이 없습니다' };
    if (key === ',') return { ...done, rename: { id: item.id, text: '' } };
    if (key === 'p' && item.state === 'stopped') return { ...done, message: '이미 멈춘 세션입니다(Ctrl-b r로 이어서 작업합니다)' };
    if (key === 'r' && item.state !== 'stopped') return { ...done, message: '멈춘 세션만 이어서 작업합니다' };
    return { ...done, confirm: { action: key === 'p' ? 'stop' : 'resume', id: item.id, title: item.title } };
  }
  if (key === ESC) return done;
  return { ...done, message: 'Ctrl-b 다음 키는 Ctrl-b ? 도움말에 있습니다' };
}

/** 스페이스 화면의 키(#887): 앞글쇠 없이 카드를 고르고 연다. 칸으로 보낼 글자는 없다 */
function spaceKey(state: DeskState, key: string, effects: Effect[]): DeskState {
  const sessions = deskSessions(state.items);
  const base: DeskState = state.message ? { ...state, message: undefined } : state;
  const move = (by: number) => ({ ...base, selected: Math.max(0, Math.min(sessions.length - 1, state.selected + by)) });
  if (key === UP || key === UP_APP || key === LEFT || key === LEFT_APP || key === 'k' || key === 'h') return move(-1);
  if (key === DOWN || key === DOWN_APP || key === RIGHT || key === RIGHT_APP || key === 'j' || key === 'l') return move(1);
  if (key === '\t' || key === '\x1b[Z') {
    // 다음(Shift-Tab이면 앞) 스페이스의 첫 세션
    const spaces = deskSpaces(state.items);
    if (spaces.length === 0) return base;
    const at = Math.max(0, spaces.findIndex((space) => space.sessions.includes(state.selected)));
    const next = spaces[(at + (key === '\t' ? 1 : spaces.length - 1)) % spaces.length]!;
    return { ...base, selected: next.sessions[0]! };
  }
  if (key === ESC || key === 'w') return { ...base, view: undefined };
  if (key === '\r' || key === '\n' || key === 'n' || key === 'p' || key === 'r' || key === ',' || key === '?' || key === 'c' || key === 'g' || key === 'i' || key === 'e' || key === 'f' || key === 'v' || key === 'a' || key === 'd') return commandKey(base, key, effects);
  return base;
}

/** 사용량 화면을 닫고 연 화면으로 돌아간다 */
function closeUsage(state: DeskState): DeskState {
  return { ...state, view: state.usageBack, usageBack: undefined };
}

/** 사용량 화면의 키(#889): 앞글쇠 없이 계정을 고르고 다시 읽는다. 칸으로 보낼 글자는 없다 */
function usageKey(state: DeskState, key: string, effects: Effect[]): DeskState {
  const base: DeskState = state.message ? { ...state, message: undefined } : state;
  const count = state.usage?.accounts.length ?? 0;
  const move = (by: number) => ({ ...base, usageSelected: Math.max(0, Math.min(count - 1, (state.usageSelected ?? 0) + by)) });
  if (key === UP || key === UP_APP || key === LEFT || key === LEFT_APP || key === 'k' || key === 'h') return move(-1);
  if (key === DOWN || key === DOWN_APP || key === RIGHT || key === RIGHT_APP || key === 'j' || key === 'l') return move(1);
  if (key === 'r') {
    effects.push({ type: 'usage', refresh: true });
    return { ...base, message: '사용량을 다시 읽는 중…' };
  }
  if (key === ESC || key === 'q' || key === 'u') return closeUsage(base);
  if (key === 'w') return { ...base, view: 'space', usageBack: undefined };
  if (key === '?') return { ...base, help: true };
  if (key === 'n' || key === 'g' || key === 'f') return commandKey(base, key, effects);
  return base;
}

function confirmKey(state: DeskState, key: string, effects: Effect[]): DeskState {
  const confirm = state.confirm!;
  if (key === 'y' || key === 'Y' || key === '\r') {
    if (confirm.action === 'quit') effects.push({ type: 'quit', confirmed: true });
    else if (confirm.action === 'close') {
      const slot = state.slots.indexOf(confirm.id);
      if (slot >= 0) effects.push({ type: 'close', slot, id: confirm.id, confirmed: true });
    }
    else effects.push({ type: 'session', action: confirm.action, id: confirm.id });
    return { ...state, confirm: undefined, message: undefined };
  }
  return { ...state, confirm: undefined, message: '그만두었습니다' };
}

function renameKey(state: DeskState, key: string, effects: Effect[]): DeskState {
  const rename = state.rename!;
  if (key === ESC || key === '\x03') return { ...state, rename: undefined, message: '이름 바꾸기를 그만두었습니다' };
  if (key === '\r') {
    effects.push({ type: 'rename', id: rename.id, label: rename.text.trim() });
    return { ...state, rename: undefined };
  }
  if (key === '\x7f' || key === '\b') return { ...state, rename: { ...rename, text: [...rename.text].slice(0, -1).join('') } };
  if (key.startsWith(ESC)) return state;
  const char = key === '\n' ? ' ' : key;
  if (char.codePointAt(0)! < 32) return state;
  return { ...state, rename: { ...rename, text: rename.text + char } };
}

function copyKey(state: DeskState, key: string, effects: Effect[]): DeskState {
  const copy = state.copy!;
  const id = state.slots[state.focus];
  if (!id) return { ...state, copy: undefined };
  const act = (action: CopyAction, text?: string) => effects.push({ type: 'copy', id, action, ...(text === undefined ? {} : { text }) });
  // 안내는 키를 누를 때마다 지운다(찾지 못함 같은 알림이 남아 있지 않게)
  const base: DeskState = state.message ? { ...state, message: undefined } : state;
  if (copy.search !== undefined) {
    if (key === ESC || key === '\x03') return { ...base, copy: {} };
    if (key === '\r' || key === '\n') {
      if (copy.search) act('search', copy.search);
      return { ...base, copy: {} };
    }
    if (key === '\x7f' || key === '\b') return { ...base, copy: { search: [...copy.search].slice(0, -1).join('') } };
    if (key.startsWith(ESC) || key.codePointAt(0)! < 32) return base;
    return { ...base, copy: { search: copy.search + key } };
  }
  if (key === 'q' || key === ESC || key === '\x03') {
    act('exit');
    return { ...base, copy: undefined };
  }
  if (key === 'y' || key === '\r') {
    act('yank');
    return { ...base, copy: undefined };
  }
  const moves: Record<string, CopyAction> = {
    [UP]: 'up',
    [UP_APP]: 'up',
    k: 'up',
    [DOWN]: 'down',
    [DOWN_APP]: 'down',
    j: 'down',
    [PAGE_UP]: 'pageUp',
    b: 'pageUp',
    '\x15': 'pageUp',
    [PAGE_DOWN]: 'pageDown',
    f: 'pageDown',
    '\x04': 'pageDown',
    ' ': 'pageDown',
    g: 'top',
    G: 'bottom',
    v: 'mark',
    n: 'next',
  };
  const action = moves[key];
  if (action) act(action);
  if (key === '/') return { ...base, copy: { search: '' } };
  return base;
}

function promptKey(state: DeskState, key: string, effects: Effect[]): DeskState {
  const prompt = state.prompt!;
  if (key === ESC || key === '\x03') return { ...state, prompt: undefined, message: '새 요청을 닫았습니다' };
  // Ctrl-t: 이 요청의 확인 선언 변경 허용(#916, ADR-164)
  if (key === '\x14') return { ...state, prompt: { ...prompt, allowCheckChanges: !prompt.allowCheckChanges } };
  if (prompt.step === 'project') {
    if (key === UP || key === UP_APP) return { ...state, prompt: { ...prompt, projectIndex: Math.max(0, prompt.projectIndex - 1) } };
    // 끝 줄(projects.length)은 "+ 폴더 열기"다(#916)
    if (key === DOWN || key === DOWN_APP) return { ...state, prompt: { ...prompt, projectIndex: Math.min(prompt.projects.length, prompt.projectIndex + 1) } };
    if (key === '\r' && prompt.projectIndex >= prompt.projects.length) return openFolderScreen({ ...state, prompt: undefined }, effects, 'prompt');
    if (key === '\r' && prompt.projects[prompt.projectIndex]) return { ...state, prompt: { ...prompt, step: 'request' } };
    return state;
  }
  if (key === '\t') return { ...state, prompt: { ...prompt, choice: (prompt.choice + 1) % Math.max(1, prompt.choices.length) } };
  if (key === '\r') {
    const request = prompt.text.trim();
    const project = prompt.projects[prompt.projectIndex];
    if (!request || !project || prompt.sending) return state;
    effects.push({ type: 'submit', projectId: project.id, request, choice: prompt.choices[prompt.choice] ?? 'rules', ...(prompt.allowCheckChanges ? { allowCheckChanges: true as const } : {}) });
    return { ...state, prompt: { ...prompt, sending: true } };
  }
  if (key === '\x7f' || key === '\b') {
    const text = [...prompt.text].slice(0, -1).join('');
    effects.push({ type: 'preview', text });
    return { ...state, prompt: { ...prompt, text } };
  }
  if (key.startsWith(ESC)) return state;
  // 붙여 넣은 줄바꿈은 보내기가 아니라 빈칸으로 둔다. 다른 제어 글자는 버린다
  const char = key === '\n' ? ' ' : key;
  if (char.codePointAt(0)! < 32) return state;
  const text = prompt.text + char;
  // 미리보기는 마지막 글자 기준 하나면 된다: 이 묶음에서 앞서 낸 미리보기를 바꾼다
  const last = effects.findIndex((effect) => effect.type === 'preview');
  if (last >= 0) effects.splice(last, 1);
  effects.push({ type: 'preview', text });
  return { ...state, prompt: { ...prompt, text } };
}

/** 폴더 열기 화면을 연다(#916). 덮는 화면은 하나만 둔다. 홈 폴더 목록은 desk가 받아 채운다 */
export function openFolderScreen(state: DeskState, effects: Effect[], from?: 'prompt'): DeskState {
  if (state.plans) effects.push({ type: 'plans', effect: { type: 'close' } });
  if (state.fleets) effects.push({ type: 'fleets', effect: { type: 'close' } });
  if (state.runtime) effects.push({ type: 'runtime', effect: { type: 'close' } });
  const opened = openFolder(from);
  for (const effect of opened.effects) effects.push({ type: 'folder', effect });
  return { ...state, folder: opened.state, prompt: undefined, settings: undefined, records: undefined, detail: undefined, requirements: undefined, plans: undefined, fleets: undefined, runtime: undefined, changes: undefined };
}
