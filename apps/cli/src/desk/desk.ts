/**
 * `studio desk`: herdr처럼 터미널 하나에서 여러 AI CLI를 나란히 쓰는 작업대(#837, ADR-183).
 *
 * 화면·키·스튜디오 손님은 따로 테스트한 순수 함수와 작은 객체이고, 여기서는 그것들을 잇는다:
 * 키 → handleInput → 할 일(입력 보내기, 칸 열기, 새 요청 …) → 스튜디오 API, 터미널 출력 → 칸 해석 → 화면 그리기.
 * 터미널을 대체 화면 버퍼로 바꾸고 raw 모드로 두므로, 어떤 길로 끝나든 되돌린다
 */
import { execFile, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { StudioClient, StudioRequestError, findStudio, splitChoice } from './client';
import { colorDepth, deskConfigDir, loadDeskConfig, loadDeskLayout, saveDeskConfig, saveDeskLayout, type DeskConfig, type DeskLayout, type DeskPrefix } from './config';
import { BROWSING, SHELL_ID, SHELL_TAKEN, flushPending, handleInput, initialState, isShellId, openFolderScreen, pasteFor, reselect, toInnerKeys, type DeskState, type Effect } from './keys';
import { changesFailed, changesLoaded, openChanges, type ChangesEffect, type ChangesState, type DeskComment } from './changes';
import { loadComments, saveComments } from './comments-store';
import { applyListing, listingFailed, type FolderEffect, type FolderState } from './folder';
import { PaneTerminal } from './pane';
import type { DeskPlan, LaneChoice, PlansEffect, PlansState } from './plans';
import { spaceItems, spaceScreen, spriteFor } from './cards';
import { previewLine, renderScreen, sidebarView, spaceRect, type PaneView } from './render';
import { recordsScrollLimit, type RecordsLoad } from './records';
import { placePanes, terminalSize, type PaneLayout } from './screen';
import { parsePatch, type DetailAction, type DetailState } from './session-detail';
import { agentStatus, backendLabel, byUrgency, deskSessions, deskSpaces, gateStatus, keepOrder, urgencyRank } from './sidebar';
import { graphicsMode, KittyImages, type GraphicsMode } from './kitty';
import { defaultSprite, loadSprite, MIN_FRAME_MS, pickSprite, readSprite, scanSprites, shortestFrame, spriteDir, type Sprite } from './sprite';
import { applyRuntimeEvent, type RuntimeEffect } from './runtime';
import { fleetOptions, placeMembers, type FleetsEffect, type FleetsState } from './fleets';
import { loaded, openRequirements, REQUIREMENTS_FILE, REQUIREMENTS_TEMPLATE, type RequirementsEffect, type RequirementsState, type RequirementsTab } from './requirements';
import { openSettings, type SettingsAccount, type SettingsEffect, type SettingsState } from './settings';
import { DEFAULT_THEME, type ThemeName } from './theme';
import type { DeskAccount, DeskItem, DeskLoginProgress, DeskTerminalMessage } from './types';
import { accountSprite, byTightness, sessionLimits, usageScreen, usageSpriteKey } from './usage';

/** 사이드바를 새로 받는 주기 */
const POLL_MS = 1_500;
/** 목록이 그대로여도 다시 그리는 주기(마지막 활동 "N분 전"이 낡지 않게) */
const CLOCK_MS = 30_000;
/** 사용량을 새로 받는 주기(#889). 스튜디오가 계정마다 최소 간격(Claude 10분)을 지키므로 이보다 자주 묻지 않는다 */
const USAGE_POLL_MS = 60_000;
/** 화면을 다시 그리는 최소 간격 */
const FRAME_MS = 30;
/** 미리보기를 묻기 전에 기다리는 시간(쓰는 동안 매 글자 묻지 않게) */
const PREVIEW_DELAY_MS = 300;
/** 통로를 다시 열면 스튜디오가 최근 출력을 다시 보낸다. 그동안 그 칸의 해석기가 내는 질의 응답은 CLI에 보내지 않는다(ADR-177 4) */
const REPLAY_QUIET_MS = 500;
/** 통로가 끊기면 다시 여는 간격 */
const RECONNECT_MS = 2_000;
/** 조각 끝의 Esc가 방향키의 앞인지 기다리는 시간. 지나면 Esc 하나로 본다 */
const ESC_WAIT_MS = 25;
/** 작업 글을 넣기 전에 막 뜬 CLI가 붙여넣기 표지를 켜기를 기다리는 시간(#894) */
const WORK_PASTE_WAIT_MS = 3_000;
/** 창 크기를 끌어 바꾸는 동안 스튜디오에 알리는 것을 미루는 시간(칸 안 해석기는 바로 맞춘다) */
const RESIZE_SETTLE_MS = 150;
/** 터미널로 띄울 수 있는 AI. 스튜디오 routed-session.ts의 terminalBackends와 같은 기준이다(desk가 붙는 launch는 이 컴퓨터 방식) */
const TERMINAL_BACKENDS: readonly string[] = ['claude-code', 'codex'];

/**
 * 새 요청에서 고를 것(#885). 규칙대로, 그리고 CLI마다 하나씩이다. 한 CLI에 계정이 둘 이상이면 그 CLI 대신 계정마다 하나씩 두고
 * (`백엔드@계정id`, 기본 계정은 백엔드 이름 그대로), 화면 이름에 계정 이름을 붙인다
 */
function promptChoices(backends: readonly string[], accounts: readonly DeskAccount[]): { choices: string[]; labels: Record<string, string> } {
  const choices = ['rules'];
  const labels: Record<string, string> = {};
  for (const backend of backends) {
    const mine = accounts.filter((account) => account.backend === backend);
    if (mine.length <= 1) {
      choices.push(backend);
      continue;
    }
    for (const account of mine) {
      const choice = account.id === backend ? backend : `${backend}@${account.id}`;
      choices.push(choice);
      labels[choice] = `${backendLabel(backend)} · ${account.name}`;
    }
  }
  return { choices, labels };
}
/** 사람이 손대야 하는 상태. 이리로 바뀌면 알린다(#864) */
const WAITING: readonly string[] = ['권한 대기', '답 기다림', '승인 대기', '입력 필요'];
/** 작업 중에서 이리로 바뀌면 끝났다고 알린다 */
const SETTLED: readonly string[] = ['CLI 대기', '쉼'];
/** 게이트 판정이 이리로 바뀌면 알린다. 값은 알림 문구 */
const GATE_NOTICE: Record<string, string> = { 실패: '검증 실패', '확인 필요': '확인 필요', 통과: '검증 통과' };
/** 이어서 작업한 세션이 아직 켜지지 않은 상태 */
const NOT_READY: readonly string[] = ['stopped', 'booting'];
/** 한 번에 내는 OS 알림의 상한(여럿이 한꺼번에 바뀌어도 알림이 쏟아지지 않게) */
const MAX_OS_NOTICES = 3;
/** 카드 화면에서 키를 누른 뒤 이만큼은 카드 순서를 바꾸지 않는다(#922) */
const HOLD_ORDER_MS = 5_000;
/** 휠 한 칸에 옮기는 줄 수 */
const WHEEL_LINES = 3;

// 밖 터미널의 bracketed paste를 켜서 붙여넣기를 표지로 받는다(붙인 글 안의 Ctrl-b를 명령으로 보지 않게, #860)
const ENTER_SCREEN = '\x1b[?1049h\x1b[?2004h\x1b[H\x1b[2J';
const LEAVE_SCREEN = '\x1b[?2026l\x1b[0m\x1b[?25h\x1b[?2004l\x1b[?1049l';
// 마우스는 누름·뗌·휠(1000)을 SGR 꼴(1006)로 받는다. 끌기(1002)는 받지 않는다(#874)
const MOUSE_ON = '\x1b[?1000h\x1b[?1006h';
const MOUSE_OFF = '\x1b[?1006l\x1b[?1000l';
// 창이 포커스를 잃고 얻는 것(1004)을 받아 그동안 움짤을 멈춘다(#902)
const FOCUS_ON = '\x1b[?1004h';
const FOCUS_OFF = '\x1b[?1004l';
const FOCUS_EVENT = /\x1b\[([IO])/g;
/** 읽어 둔 무작위 그림의 상한(오래된 것부터 버린다) */
const SPRITE_CACHE = 64;
/** 로그인이 끝났는지 묻는 간격(#890) */
const LOGIN_POLL_MS = 1_500;
/** 여러 AI 비교에 진행 중인 참가자가 있으면 다시 받는 간격(#892) */
const FLEET_POLL_MS = 3_000;

/** 카드 그림을 그림 폴더에서 고르는 곳(#902). 테스트에서는 가짜를 넣는다 */
export interface SpriteCatalog {
  /** 세션 id에 맞는 그림: 그 id 이름의 그림, 그다음 random이면 폴더에서 무작위. 없으면 sprite가 없다. 읽지 못했으면 warning */
  pick(id: string): { sprite?: Sprite; warning?: string };
  /**
   * 그림 폴더 안의 그 파일(계정에 고른 그림, #889·#890). 폴더 기준 상대 경로이고(하위 폴더 포함), 그림 폴더에서 찾은 파일 목록에 있을 때만 읽는다
   * (링크·숨은 파일·폴더 밖은 목록에 들지 않는다). 없거나 읽지 못하면 warning
   */
  file?(name: string): { sprite?: Sprite; warning?: string };
}

/** 그림 폴더의 그림 목록. 시작할 때 목록만 읽고, 그림은 처음 보일 때 읽는다 */
export function folderCatalog(dir: string, options: { random: boolean }): SpriteCatalog {
  // 목록은 늘 읽는다: 계정 그림도 이 목록에 있는 파일만 읽는다(링크·숨은 파일·폴더 밖은 목록에 들지 않는다)
  let files = scanSprites(dir);
  const cache = new Map<string, Sprite | null>();
  return {
    pick(id) {
      const named = loadSprite(dir, [id]);
      if (named) return { sprite: named };
      const file = options.random ? pickSprite(id, files) : undefined;
      return file ? read(file) : {};
    },
    file(name) {
      // desk를 띄운 뒤 넣은 그림일 수 있다. 목록에 없으면 한 번 다시 읽는다
      if (!files.includes(name)) files = scanSprites(dir);
      if (!files.includes(name)) return { warning: `계정 그림 ${name}가 그림 폴더에 없습니다` };
      return read(name);
    },
  };

  function read(file: string): { sprite?: Sprite; warning?: string } {
    if (cache.has(file)) {
      const known = cache.get(file);
      return known ? { sprite: known } : {};
    }
    if (cache.size >= SPRITE_CACHE) cache.delete(cache.keys().next().value!);
    try {
      const sprite = readSprite(join(dir, file));
      cache.set(file, sprite);
      return { sprite };
    } catch (error) {
      cache.set(file, null);
      return { warning: `그림 ${file}를 읽지 못했습니다: ${messageOf(error)}` };
    }
  }
}

/** 설정 화면이 부르는 스튜디오 API(#890) */
export type SettingsClient = Pick<StudioClient, 'accounts' | 'rules' | 'preview' | 'addAccount' | 'updateAccount' | 'removeAccount' | 'accountStatus' | 'startLogin' | 'loginProgress' | 'cancelLogin' | 'saveRules'>;

/** 설정 화면이 쓰는 바깥(#890): 스튜디오 API, desk.json, 그림 폴더, 브라우저. 테스트에서는 가짜를 넣는다 */
export interface SettingsHost {
  client: SettingsClient;
  loadConfig(): DeskConfig;
  /** 받은 값만 desk.json에 쓴다. 실패하면 던진다 */
  saveConfig(patch: DeskConfig): void;
  /** 그림 폴더의 그림 파일(폴더 기준 상대 경로) */
  spriteFiles(): string[];
  /** 그림 폴더의 파일 하나를 읽는다. 목록에 없거나 읽지 못하면 던진다 */
  readSprite(file: string): Sprite;
  /** 주소를 이 컴퓨터의 브라우저로 연다(http·https만 넘긴다) */
  openUrl(url: string): void;
}

/** 탐색형 QA가 도는 동안 상태를 다시 받는 주기(웹 화면과 같다, #916) */
const QA_POLL_MS = 1_200;

/** 작업 나누기 화면이 열려 있는 동안 계획을 다시 받는 주기 */
const PLANS_POLL_MS = 2_000;

/** 요구사항·문서 화면이 부르는 스튜디오 API(#894). DeskClient에 없으면(옛 손님) 부를 때 실패로 알린다 */
type RequirementsCall = 'requirements' | 'tests' | 'docs' | 'doc' | 'saveDoc' | 'projectStatus' | 'verifyRequirement' | 'clearVerification' | 'applyRequirements';

/** 요구사항·문서 화면이 쓰는 편집기(#894). 테스트에서는 가짜를 넣는다 */
export interface RequirementsHost {
  /** 파일 하나를 편집기로 열고 끝날 때까지 기다린다. 편집기의 끝 값(0이면 정상)을 돌려준다. 그동안 desk는 화면과 raw 모드를 내려놓는다 */
  editor(file: string): number;
  /** 고칠 글을 잠깐 두는 폴더(없으면 시스템 임시 폴더) */
  tmpDir?: string;
}

/** $VISUAL, $EDITOR, 없으면 vi(git과 같다)로 연다. 편집기 값에 인자가 있을 수 있어 셸로 띄우고, 파일 이름은 셸 글에 잇지 않고 인자로 넘긴다 */
function systemEditor(env: NodeJS.ProcessEnv): (file: string) => number {
  const editor = env.VISUAL?.trim() || env.EDITOR?.trim() || 'vi';
  return (file) => spawnSync('/bin/sh', ['-c', `${editor} "$1"`, 'sh', file], { stdio: 'inherit' }).status ?? 1;
}

/** 이 컴퓨터의 브라우저로 연다. 셸을 거치지 않고 주소를 인자 하나로 넘긴다 */
function openInBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = execFile(command, [url], { timeout: 10_000 }, () => {});
  child.unref();
}

/** 브라우저로 열어도 되는 주소: http·https만 */
export function browsable(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

export interface DeskOptions {
  port?: number;
  /** false면 벨과 OS 알림을 내지 않는다(--no-notify). 설정 파일보다 앞선다. 사이드바 표시와 아래 줄 알림은 그대로다 */
  notify?: boolean;
  /** false면 마우스를 받지 않는다(--no-mouse). 설정 파일보다 앞선다 */
  mouse?: boolean;
}

/** 셸 칸의 가상 터미널에서 desk가 쓰는 부분(node-pty와 같은 꼴, #873) */
export interface ShellPty {
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): unknown;
}
/** 셸 칸의 가상 터미널을 띄우는 자리(테스트가 가짜를 끼운다) */
export type SpawnShell = (file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }) => ShellPty | Promise<ShellPty>;

const spawnWithNodePty: SpawnShell = async (file, args, options) => {
  // 스튜디오의 세션 터미널(packages/sandbox host-terminal)과 같은 가상 터미널 모듈이다. 셸 칸을 열 때만 읽는다
  const pty = await import('@lydell/node-pty');
  return pty.spawn(file, args, options);
};

/**
 * 셸 칸에 넘길 환경. desk의 환경에서 B_STUDIO_로 시작하는 것을 모두 뺀다:
 * 관문·MCP·인증 토큰과 비밀(B_STUDIO_GATE_TOKEN, B_STUDIO_GATEWAY_TOKEN, B_STUDIO_MCP_TOKEN, B_STUDIO_AUTH_*, B_STUDIO_SECRET_* …)이 이 이름 아래 있고,
 * 셸 칸은 관문 밖이다. desk를 세션 터미널 안에서 띄웠을 때 그 세션의 토큰이 관문 밖 셸로 새지 않게 한다
 */
export function shellEnvOf(env: Record<string, string | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || name.startsWith('B_STUDIO_')) continue;
    out[name] = value;
  }
  return { ...out, TERM: 'xterm-256color', COLORTERM: 'truecolor' };
}

/** 지금 변경 화면의 의견을 읽고 쓰는 곳(#924, 실제로는 desk-comments.json, 없으면 desk를 띄운 동안만 메모리에 둔다) */
export interface DeskCommentStore {
  load(sessionId: string): DeskComment[];
  save(sessionId: string, comments: readonly DeskComment[]): void;
}

/** 파일 없이 desk를 띄운 동안만 의견을 든다(테스트와 설정 폴더가 없는 손님) */
function memoryComments(): DeskCommentStore {
  const kept = new Map<string, DeskComment[]>();
  return { load: (id) => [...(kept.get(id) ?? [])], save: (id, comments) => void kept.set(id, [...comments]) };
}

/** 배치를 읽고 쓰는 곳(실제로는 desk-state.json, 테스트에서는 메모리) */
export interface DeskLayoutStore {
  load(): DeskLayout | undefined;
  save(layout: DeskLayout): void;
}

export interface DeskAppOptions {
  notify?: boolean;
  /** false면 작업이 끝났을 때 벨·OS 알림을 내지 않는다(#922). 표시는 그대로다 */
  notifyDone?: boolean;
  /** false면 권한·질문·입력 필요일 때 벨·OS 알림을 내지 않는다(#922). 표시는 그대로다 */
  notifyInput?: boolean;
  /** false면 밖 터미널의 마우스를 켜지 않는다 */
  mouse?: boolean;
  /** false면 칸의 24비트 색을 256색으로 낮춰 그린다 */
  truecolor?: boolean;
  /** desk 자신의 색 팔레트(#887). 없으면 dark */
  theme?: ThemeName;
  /** 카드 그림(세션 id·AI 이름·default 차례로 찾는다). 없으면 desk의 기본 그림 */
  sprites?: Record<string, Sprite>;
  /** 이름 붙인 그림이 없는 세션의 그림을 고르는 곳(#902). 없으면 기본 그림 */
  spriteCatalog?: SpriteCatalog;
  /** false면 움짤을 움직이지 않는다 */
  animate?: boolean;
  /** 그림을 그리는 법: kitty(Ghostty·kitty의 그래픽)·blocks(반칸 블록, 기본) */
  graphics?: GraphicsMode;
  /** 설정한 앞글쇠(없으면 Ctrl-b) */
  prefix?: DeskPrefix;
  layoutStore?: DeskLayoutStore;
  /** 지금 변경 화면의 의견(#924) */
  commentStore?: DeskCommentStore;
  /** 시작할 때 아래 줄에 보일 설정 알림(잘못된 값) */
  warnings?: string[];
  /** 셸 칸을 띄우는 자리(기본은 node-pty, #873) */
  spawnShell?: SpawnShell;
  /** 셸 칸에 넘길 환경의 바탕(기본은 desk의 환경. B_STUDIO_로 시작하는 것은 뺀다) */
  shellEnv?: Record<string, string | undefined>;
  /** 셸 칸의 폴더(기본은 desk를 띄운 폴더) */
  shellCwd?: string;
  /** 설정 화면(#890). 없으면 Ctrl-b g가 열 수 없다고 알린다 */
  settings?: SettingsHost;
  /** AI 계정(#885). 계정에 고른 그림을 그 계정 세션의 카드에 쓴다 */
  accounts?: DeskAccount[];
  /** 주소를 이 컴퓨터의 브라우저로 여는 곳(작업 나누기의 추적 이슈, #893). 없으면 열 수 없다고 알린다 */
  openUrl?: (url: string) => void;
  /** 요구사항·문서 화면의 편집기(#894). 없으면 $VISUAL·$EDITOR·vi */
  requirements?: RequirementsHost;
}

/** desk가 부르는 스튜디오 API(테스트에서는 가짜를 넣는다) */
export type DeskClient = Pick<StudioClient, 'agents' | 'projects' | 'accounts' | 'rules' | 'preview' | 'start' | 'open' | 'resize' | 'input' | 'stream' | 'stop' | 'resume' | 'rename'> &
  /** 사용량(#889). 없으면 사용량을 묻지 않는다 */
  { limits?: StudioClient['limits'] } &
  /** 오늘·최근 7일 쓴 양(#925). 없으면 묻지 않는다 */
  { spend?: StudioClient['spend'] } &
  /** 기록 화면과 세션 자세히(#891). 없으면 그 화면에서 할 수 없다고 알린다 */
  Partial<Pick<StudioClient, RecordsCall>> &
  /** 작업 나누기(#893). 없으면 Ctrl-b t가 열 수 없다고 알린다 */
  Partial<Pick<StudioClient, PlansCall>> &
  /** 요구사항·문서 화면(#894). 없으면 그 화면에서 할 수 없다고 알린다 */
  Partial<Pick<StudioClient, RequirementsCall>> &
  /** 여러 AI 비교(#892). 없으면 Ctrl-b f가 열 수 없다고 알린다 */
  Partial<Pick<StudioClient, FleetsCall>> &
  /** 실행·배포·미리보기·저장소 화면(#895). 없으면 그 화면에서 할 수 없다고 알린다 */
  Partial<Pick<StudioClient, RuntimeCall>> &
  /** 폴더 열기(#916). 없으면 그 화면에서 할 수 없다고 알린다 */
  Partial<Pick<StudioClient, FolderCall>> &
  /** 지금 변경(#924). 없으면 그 화면에서 할 수 없다고 알린다 */
  Partial<Pick<StudioClient, ChangesCall>> &
  /** 목록 통로(#923). 없으면 지금처럼 POLL_MS마다 묻는다 */
  Partial<Pick<StudioClient, 'agentsStream'>>;

/** 지금 변경 화면이 부르는 스튜디오 API(#924) */
type ChangesCall = 'liveChanges';

/** 실행 화면이 부르는 스튜디오 API(#895) */
/** 폴더 열기가 부르는 스튜디오 API(#916) */
type FolderCall = 'folders' | 'proposeFolder' | 'registerFolder';

type RuntimeCall = 'sessionEvents' | 'deploys' | 'deploy' | 'rollback' | 'setService' | 'boot' | 'previewUrl' | 'submission' | 'repository' | 'exploreQa' | 'startExploreQa' | 'stopExploreQa' | 'saveExploreQa' | 'artifactUrl';

/** 여러 AI 비교 화면이 부르는 스튜디오 API(#892) */
type FleetsCall = 'fleets' | 'fleet' | 'createFleet' | 'chooseFleetWinner' | 'deleteFleet';

/** 작업 나누기 화면이 부르는 스튜디오 API(#893) */
type PlansCall = 'plans' | 'plan' | 'createPlan' | 'approvePlan' | 'rejectPlan' | 'deletePlan' | 'resumePlan' | 'laneBackends' | 'setLane';

/** 기록 화면과 세션 자세히가 부르는 스튜디오 API(#891) */
type RecordsCall =
  | 'allowCheckChanges'
  | 'routingStats'
  | 'tokenReport'
  | 'session'
  | 'checkpointPatch'
  | 'restoreCheckpoint'
  | 'reverify'
  | 'deleteSession'
  | 'exportPreview'
  | 'exportSession'
  | 'reviewRound'
  | 'resolveFinding';

/** desk가 쓰는 터미널 입출력. 실제로는 process.stdin·stdout이다 */
export interface DeskIo {
  write(data: string): void;
  size(): { cols: number; rows: number };
  onInput(listener: (chunk: string) => void): void;
  onResize(listener: () => void): void;
  setRaw(on: boolean): void;
  /** 신호·처리 못 한 예외에서도 화면을 되돌리게 건다(테스트에서는 없다) */
  guard?(restore: () => void, stop: (code: number) => void): void;
}

function processIo(): DeskIo {
  return {
    write: (data) => process.stdout.write(data),
    size: () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 }),
    onInput: (listener) => {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', listener);
      process.stdin.resume();
    },
    onResize: (listener) => process.stdout.on('resize', listener),
    setRaw: (on) => {
      try {
        process.stdin.setRawMode(on);
      } catch {
        // 이미 닫힌 입력
      }
      // 편집기를 띄웠다 돌아오면(#894) 멈춰 둔 입력을 다시 받는다
      if (on) process.stdin.resume();
      else process.stdin.pause();
    },
    guard: (restore, stop) => {
      process.once('exit', restore);
      const fatal = (error: unknown) => {
        restore();
        console.error(`studio desk가 멈췄습니다: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
        process.exit(1);
      };
      process.on('uncaughtException', fatal);
      process.on('unhandledRejection', fatal);
      for (const signal of ['SIGTERM', 'SIGHUP'] as const) process.once(signal, () => stop(0));
    },
  };
}

export async function desk(options: DeskOptions, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('studio desk는 터미널에서 실행합니다(입력과 출력이 터미널이어야 합니다)');
    return 2;
  }
  const found = await findStudio(env, options);
  if ('error' in found) {
    console.error(found.error);
    return 1;
  }
  const client = new StudioClient(found);
  let first: DeskState['items'];
  try {
    first = (await client.agents()).items;
  } catch (error) {
    console.error(`스튜디오(${found.origin})에 닿지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
    console.error('`pnpm studio launch`로 띄운 뒤 다시 실행하세요. 다른 포트면 --port를 주세요');
    return 1;
  }
  const dir = deskConfigDir(env);
  const { config, warnings } = loadDeskConfig(dir);
  // 카드 그림: 그림 폴더의 AI 이름별 그림과 default(#887), 그 밖에는 세션마다 그림 폴더에서 무작위(#902)
  const spriteSetting = config.sprites ?? 'random';
  const sprites: Record<string, Sprite> = {};
  if (spriteSetting !== 'off') {
    for (const name of ['claude-code', 'codex', 'gemini', 'default']) {
      const sprite = loadSprite(spriteDir(dir), [name], warnings);
      if (sprite) sprites[name] = sprite;
    }
  }
  // 계정 그림(#890)을 카드에 쓰려고 계정 목록을 받는다. 옛 스튜디오면 없다
  const accounts = await client.accounts().catch((): DeskAccount[] => []);
  const folder = spriteDir(dir);
  let knownSprites: string[] = [];
  const settings: SettingsHost = {
    client,
    loadConfig: () => loadDeskConfig(dir).config,
    saveConfig: (patch) => saveDeskConfig(dir, patch),
    spriteFiles: () => (knownSprites = scanSprites(folder)),
    readSprite: (file) => {
      // 목록(링크·숨은 파일·폴더 밖은 들지 않는다)에 있는 파일만 읽는다
      if (!knownSprites.includes(file)) throw new Error('그림 폴더에 없는 파일입니다');
      return readSprite(join(folder, file));
    },
    openUrl: openInBrowser,
  };
  const app = new DeskApp(client, first, processIo(), {
    settings,
    openUrl: openInBrowser,
    requirements: { editor: systemEditor(env) },
    accounts,
    // 명령 인자가 설정 파일보다 앞선다
    notify: options.notify ?? config.notify ?? true,
    notifyDone: config.notifyDone ?? true,
    notifyInput: config.notifyInput ?? true,
    mouse: options.mouse ?? config.mouse ?? true,
    truecolor: colorDepth(env, config.color) === 'truecolor',
    ...(config.theme ? { theme: config.theme } : {}),
    sprites,
    ...(spriteSetting === 'off' ? {} : { spriteCatalog: folderCatalog(spriteDir(dir), { random: spriteSetting === 'random' }) }),
    animate: config.animate ?? true,
    graphics: graphicsMode(env, config.graphics),
    ...(config.prefix ? { prefix: config.prefix } : {}),
    layoutStore: { load: () => loadDeskLayout(dir), save: (layout) => saveDeskLayout(dir, layout) },
    commentStore: { load: (id) => loadComments(dir, id), save: (id, comments) => saveComments(dir, id, comments) },
    warnings,
  });
  const code = await app.run();
  if (app.exitWarning) console.error(app.exitWarning);
  return code;
}

export class DeskApp {
  readonly #client: DeskClient;
  readonly #io: DeskIo;
  #state: DeskState;
  readonly #panes = new Map<string, PaneTerminal>();
  readonly #notes = new Map<string, string>();
  /** 칸마다 마지막으로 스튜디오에 알린 터미널 크기 */
  readonly #sizes = new Map<string, string>();
  /** 터미널이 끝났거나 열지 못한 세션. 사람이 다시 고를 때(Ctrl-b Enter)까지 열기·크기를 보내지 않는다 */
  readonly #closed = new Set<string>();
  #pendingTimer: NodeJS.Timeout | undefined;
  #resizeTimer: NodeJS.Timeout | undefined;
  #polling = false;
  /** 목록 통로(#923)가 목록을 보내 주는 중이다. 그동안은 묻지 않는다 */
  #agentsLive = false;
  #agentsAbort: AbortController | undefined;
  #agentsRetry: NodeJS.Timeout | undefined;
  /** 마지막으로 받은 목록(같은 목록이면 다시 그리지 않는다) */
  #itemsKey = '';
  /** 같은 목록만 와도 "N분 전" 같은 글이 낡지 않게 가끔 다시 그린다 */
  #clockTimer: NodeJS.Timeout | undefined;
  #prevFrame: string[] = [];
  #frameTimer: NodeJS.Timeout | undefined;
  #pollTimer: NodeJS.Timeout | undefined;
  #usageTimer: NodeJS.Timeout | undefined;
  /** 사용량을 묻는 중(앞 요청이 끝나기 전에 또 묻지 않는다) */
  #usageFetching = false;
  #previewTimer: NodeJS.Timeout | undefined;
  /** 칸마다 따로 연 터미널 통로. 칸 하나를 열고 닫아도 다른 칸의 통로와 화면은 그대로다(#863) */
  readonly #streams = new Map<string, { controller: AbortController; timer?: NodeJS.Timeout }>();
  /** 칸마다 최근 출력을 다시 받는 동안(질의 응답을 CLI에 보내지 않는 때)의 끝 */
  readonly #quietUntil = new Map<string, number>();
  readonly #notify: boolean;
  /** 끝남·손댈 상태 알림을 따로 끈다(#922). 설정 화면에서 바꾸면 바로 적용한다 */
  #notifyDone: boolean;
  #notifyInput: boolean;
  /** 마지막으로 키를 받은 때(카드를 고르는 동안 순서를 지키려고, #922) */
  #lastKeyAt = 0;
  /** 세션마다 지난번에 본 상태·게이트(바뀐 것을 알리려고 둔다). 처음 받은 목록은 알리지 않고 여기에 적기만 한다 */
  readonly #last = new Map<string, { status: string; gate?: string }>();
  /** 이어서 작업을 보낸 세션. 켜지면 칸을 다시 연다 */
  readonly #resuming = new Set<string>();
  /** 칸 안 CLI가 벨을 울린 세션(칸 머리에 보이고, 그 칸을 고르면 지운다) */
  readonly #bells = new Set<string>();
  #restored = false;
  #finish: (code: number) => void = () => {};
  readonly #mouseOn: boolean;
  readonly #truecolor: boolean;
  readonly #layoutStore: DeskLayoutStore | undefined;
  readonly #commentStore: DeskCommentStore;
  /** 배치를 저장하지 못한 것을 이미 알렸다(같은 알림을 되풀이하지 않는다) */
  #layoutWarned = false;
  /** 나갈 때 배치를 저장하지 못했으면 화면을 되돌린 뒤 보일 글 */
  #exitWarning: string | undefined;
  /** 셸 칸(#873). desk가 직접 든 로컬 셸이라 스튜디오·관문을 거치지 않고, desk를 나가거나 칸을 비우면 끝난다 */
  readonly #shells = new Map<string, { pty?: ShellPty; ended: boolean; dir: string }>();
  #shellSeq = 0;
  readonly #spawnShell: SpawnShell;
  readonly #catalog: SpriteCatalog | undefined;
  readonly #animate: boolean;
  /** 움짤 시계의 시작 */
  readonly #animStart = Date.now();
  #animTimer: NodeJS.Timeout | undefined;
  /** 밖 터미널 창이 포커스를 가졌다(1004로 받는다. 받지 못하면 늘 가진 것으로 본다) */
  #windowFocused = true;
  /** 읽지 못한 그림을 이미 알렸다 */
  readonly #spriteWarned = new Set<string>();
  readonly #shellEnv: Record<string, string | undefined>;
  readonly #shellCwd: string;
  readonly #settingsHost: SettingsHost | undefined;
  readonly #requirementsHost: RequirementsHost;
  /** 편집기를 띄운 동안(#894). 그사이 온 키는 편집기가 끝난 뒤의 desk로 가지 않게 버린다 */
  #editing = false;
  /** 칸에 처음 여는 중인 터미널. 끝나면 true(열림), false(열지 못함) */
  readonly #opening = new Map<string, Promise<boolean>>();
  /** AI 계정(#885). 계정에 고른 그림을 찾는 데 쓴다 */
  #accounts: DeskAccount[];
  /** 그림 폴더·계정 그림에서 단 카드 그림의 세션. 계정이 바뀌면 지우고 다시 단다 */
  readonly #assignedSprites = new Set<string>();
  #loginTimer: NodeJS.Timeout | undefined;
  #loginPolling = false;
  /** 여러 AI 비교를 다시 받는 시계(#892). 진행 중인 참가자가 있을 때만 건다 */
  #fleetTimer: NodeJS.Timeout | undefined;
  readonly #openUrl: ((url: string) => void) | undefined;
  /** 실행 화면(#895)이 받는 세션 이벤트 통로 */
  #runtimeStream: AbortController | undefined;
  /** 탐색형 QA가 도는 동안 상태를 다시 받는 시계(#916) */
  #qaTimer: ReturnType<typeof setTimeout> | undefined;
  #plansTimer: NodeJS.Timeout | undefined;
  /** 작업 나누기 화면의 계획을 받는 중(앞 요청이 끝나기 전에 또 받지 않는다) */
  #plansFetching = false;

  constructor(client: DeskClient, items: DeskState['items'], io: DeskIo, options: DeskAppOptions = {}) {
    this.#client = client;
    this.#io = io;
    this.#notify = options.notify !== false;
    this.#notifyDone = options.notifyDone !== false;
    this.#notifyInput = options.notifyInput !== false;
    this.#mouseOn = options.mouse !== false;
    this.#truecolor = options.truecolor !== false;
    this.#layoutStore = options.layoutStore;
    this.#commentStore = options.commentStore ?? memoryComments();
    this.#spawnShell = options.spawnShell ?? spawnWithNodePty;
    this.#shellEnv = options.shellEnv ?? process.env;
    this.#shellCwd = options.shellCwd ?? process.cwd();
    this.#catalog = options.spriteCatalog;
    this.#animate = options.animate !== false;
    this.#settingsHost = options.settings;
    this.#openUrl = options.openUrl;
    this.#requirementsHost = options.requirements ?? { editor: systemEditor(process.env) };
    this.#accounts = options.accounts ?? [];
    const prefix = options.prefix ? { prefixKey: options.prefix.key, prefixLabel: options.prefix.label } : {};
    const warnings = options.warnings?.length ? { message: `설정: ${options.warnings.join(' / ')}` } : {};
    const theme = { name: options.theme ?? 'dark', depth: this.#truecolor ? 'truecolor' : '256' } as const;
    const restored = this.#restoredLayout(items);
    // 열린 칸이 없으면 스페이스 화면(카드)부터 보인다(#887)
    const open = (restored.slots ?? []).some((id, slot) => id && slot < (restored.layout ?? 1));
    const kitty = options.graphics === 'kitty' ? { kitty: new KittyImages() } : {};
    const ordered = byUrgency(items, new Set(restored.unseenDone ?? []));
    this.#state = { ...initialState(), items: ordered, theme, sprites: options.sprites ?? {}, ...kitty, ...prefix, ...warnings, ...restored, ...(open ? {} : { view: 'space' as const }) };
    for (const item of items) this.#last.set(item.id, statusOf(item));
  }

  /** 나갈 때 배치를 저장하지 못했으면 그 알림(desk가 화면을 되돌린 뒤 보인다) */
  get exitWarning(): string | undefined {
    return this.#exitWarning;
  }

  /** 저장해 둔 배치. 지금 없는 세션의 자리는 비운다 */
  #restoredLayout(items: DeskState['items']): Partial<DeskState> {
    const saved = this.#layoutStore?.load();
    if (!saved) return {};
    const known = new Set(deskSessions(items).map((item) => item.id));
    const slots = saved.slots.map((id, slot) => (id && slot < saved.layout && known.has(id) ? id : undefined));
    // 안 본 표시(#922)도 지금 있는 세션 것만 되살린다
    const flagged = saved.flagged?.filter((id) => known.has(id));
    const unseenDone = saved.unseenDone?.filter((id) => known.has(id));
    return { layout: saved.layout, slots, focus: Math.min(saved.focus, saved.layout - 1), zoom: saved.zoom, sidebarHidden: saved.sidebarHidden, ...(flagged?.length ? { flagged } : {}), ...(unseenDone?.length ? { unseenDone } : {}) };
  }

  #saveLayout(): void {
    if (!this.#layoutStore) return;
    const { layout, slots, focus, zoom, sidebarHidden } = this.#state;
    try {
      // 셸 칸은 남기지 않는다: desk를 나가면 셸이 끝나고, 다음에 같은 자리에 새 셸을 띄우면 전과 다른 셸인데 이어진 것처럼 보인다
      this.#layoutStore.save({
        layout,
        slots: slots.map((id, slot) => (slot < layout && !isShellId(id) ? id : undefined)),
        focus,
        zoom: zoom === true,
        sidebarHidden: sidebarHidden === true,
        // 안 본 표시(#922)는 다시 열어도 남는다
        flagged: this.#state.flagged ?? [],
        unseenDone: this.#state.unseenDone ?? [],
      });
    } catch (error) {
      const text = `칸 배치를 저장하지 못했습니다: ${messageOf(error)}`;
      if (this.#restored) {
        if (!this.#layoutWarned) this.#exitWarning = text;
      } else if (!this.#layoutWarned) this.#say(text);
      this.#layoutWarned = true;
    }
  }

  /** 지금 상태(테스트가 본다) */
  get state(): DeskState {
    return this.#state;
  }

  run(): Promise<number> {
    const done = new Promise<number>((resolve) => {
      this.#finish = resolve;
    });
    this.#io.guard?.(
      () => this.#restore(),
      (code) => this.#stop(code),
    );
    this.#io.write(ENTER_SCREEN + (this.#mouseOn ? MOUSE_ON : '') + (this.#animate ? FOCUS_ON : ''));
    this.#io.setRaw(true);
    this.#io.onInput((chunk) => this.#onInput(chunk));
    this.#io.onResize(() => {
      // 칸 해석기와 화면은 바로 맞추고, 스튜디오에는 크기가 멈춘 뒤 한 번만 알린다
      this.#prevFrame = [];
      this.#ensurePanes();
      this.#render();
      clearTimeout(this.#resizeTimer);
      this.#resizeTimer = setTimeout(() => this.#syncPanes(), RESIZE_SETTLE_MS);
    });
    this.#pollTimer = setInterval(() => void this.#poll(), POLL_MS);
    this.#clockTimer = setInterval(() => this.#scheduleRender(), CLOCK_MS);
    this.#openAgentsStream();
    // 사용량(#889): 처음 한 번, 그 뒤 1분마다
    void this.#fetchUsage({ refresh: false, force: true });
    if (this.#client.limits) this.#usageTimer = setInterval(() => void this.#fetchUsage({ refresh: false, force: true }), USAGE_POLL_MS);
    // 되살린 배치의 칸을 연다
    if (this.#visible().length > 0) this.#slotsChanged();
    this.#render();
    return done;
  }

  #size(): { cols: number; rows: number } {
    const { cols, rows } = this.#io.size();
    return { cols: Math.max(20, cols), rows: Math.max(6, rows) };
  }

  #onInput(raw: string): void {
    // 편집기를 띄우는 동안 온 글자는 desk의 키가 아니다(#894)
    if (this.#editing) return;
    let chunk = raw;
    if (this.#animate) {
      // 창 포커스 알림은 키가 아니다. 움짤을 멈추거나 다시 움직이는 데만 쓴다
      chunk = raw.replace(FOCUS_EVENT, (_, which: string) => {
        this.#windowFocused = which === 'I';
        return '';
      });
      if (chunk !== raw) this.#scheduleRender();
      if (!chunk) return;
    }
    clearTimeout(this.#pendingTimer);
    this.#lastKeyAt = Date.now();
    this.#take(handleInput(this.#state, chunk));
    // 조각 끝에서 끊긴 이스케이프 열은 잠깐 기다린다. 이어지는 조각이 없으면 그대로 처리한다(혼자 누른 Esc)
    if (this.#state.pending) this.#pendingTimer = setTimeout(() => this.#take(flushPending(this.#state)), ESC_WAIT_MS);
  }

  #take({ state, effects }: { state: DeskState; effects: Effect[] }): void {
    this.#state = state;
    for (const effect of effects) this.#apply(effect);
    this.#clampRecords();
    this.#clearSeen();
    this.#scheduleRender();
  }

  /** 기록 화면을 끝보다 더 굴리지 않는다(끝에서 더 내린 만큼 다시 올려야 하는 일이 없게) */
  #clampRecords(): void {
    const records = this.#state.records;
    if (!records) return;
    const size = this.#size();
    const limit = recordsScrollLimit(records, { theme: this.#state.theme ?? DEFAULT_THEME, width: size.cols, height: size.rows - 2, now: Date.now() });
    if (records.scroll > limit) this.#state = { ...this.#state, records: { ...records, scroll: limit } };
  }

  /** 지금 고른 칸의 세션 */
  #focused(): string | undefined {
    return this.#state.focus < this.#state.layout ? this.#state.slots[this.#state.focus] : undefined;
  }

  /**
   * 사람이 본 세션의 표시를 지운다: 고른 칸의 세션, 사이드바를 고르는 중이면 고른 세션.
   * 안 본 끝남(#922)은 다시 일을 시작했거나 사라진 세션 것도 지운다. 바뀌었으면 배치와 함께 저장한다
   */
  #clearSeen(): void {
    const seen = new Set<string>();
    const focused = this.#state.view === undefined ? this.#focused() : undefined;
    if (focused) seen.add(focused);
    if (this.#state.browsing) {
      const selected = deskSessions(this.#state.items)[this.#state.selected]?.id;
      if (selected) seen.add(selected);
    }
    for (const id of seen) this.#bells.delete(id);
    let changed = false;
    const flagged = this.#state.flagged?.filter((id) => !seen.has(id));
    if (flagged && flagged.length !== this.#state.flagged!.length) {
      this.#state = { ...this.#state, flagged };
      changed = true;
    }
    const byId = new Map(this.#state.items.map((item) => [item.id, item]));
    const unseenDone = this.#state.unseenDone?.filter((id) => {
      const item = byId.get(id);
      return !seen.has(id) && item !== undefined && urgencyRank(item, false) === 0;
    });
    if (unseenDone && unseenDone.length !== this.#state.unseenDone!.length) {
      this.#state = { ...this.#state, unseenDone };
      changed = true;
    }
    if (changed) this.#saveLayout();
  }

  /** 사람이 지금 이 세션을 보고 있다(#922): 칸 화면의 고른 칸이고, 덮는 화면이 없고, 밖 터미널 창이 포커스를 가졌다 */
  #seeing(id: string): boolean {
    const state = this.#state;
    if (state.view !== undefined || this.#focused() !== id || !this.#windowFocused) return false;
    return !(state.help || state.settings || state.records || state.detail || state.requirements || state.runtime || state.fleets || state.plans || state.folder || state.switcher);
  }

  #send(id: string, data: string): void {
    if (isShellId(id)) {
      const shell = this.#shells.get(id);
      if (shell?.pty && !shell.ended) shell.pty.write(data);
      return;
    }
    this.#client.input(id, data).catch((error: unknown) => this.#say(`입력을 보내지 못했습니다: ${messageOf(error)}`));
  }

  #apply(effect: Effect): void {
    switch (effect.type) {
      case 'input': {
        // 안쪽 CLI가 응용 커서 키 모드면 방향키를 그 꼴로 바꾼다(밖 터미널은 늘 보통 꼴로 보낸다)
        const modes = this.#panes.get(effect.id)?.modes();
        this.#send(effect.id, modes ? toInnerKeys(effect.data, modes) : effect.data);
        return;
      }
      case 'paste':
        this.#send(effect.id, pasteFor(effect, this.#panes.get(effect.id)?.modes().bracketedPaste ?? false));
        return;
      case 'reopen':
        // 끝났거나 열지 못한 터미널만 다시 연다. 열려 있으면 크기가 같아 아무것도 보내지 않는다
        if (this.#closed.delete(effect.id)) this.#sizes.delete(effect.id);
        this.#syncPanes();
        return;
      case 'close':
        if (isShellId(effect.id)) {
          this.#closeShell(effect.slot, effect.id, effect.confirmed === true);
          return;
        }
        this.#slotsChanged();
        this.#saveLayout();
        return;
      case 'open':
      case 'layout':
        this.#slotsChanged();
        this.#saveLayout();
        return;
      case 'usage':
        void this.#fetchUsage({ refresh: effect.refresh, force: effect.refresh });
        return;
      case 'mouse':
        this.#mouse(effect);
        return;
      case 'copy':
        this.#copy(effect.id, effect.action, effect.text);
        return;
      case 'quit': {
        // 셸 칸은 desk와 함께 끝난다. 살아 있는 셸이 있으면 한 번 묻는다
        const live = [...this.#shells.values()].filter((shell) => !shell.ended).length;
        if (live > 0 && !effect.confirmed) {
          this.#state = { ...this.#state, confirm: { action: 'quit', id: '', title: `셸 칸 ${live}개` } };
          return;
        }
        this.#stop(0);
        return;
      }
      case 'shell':
        void this.#openShell(effect.slot);
        return;
      case 'prompt':
        void this.#openPrompt();
        return;
      case 'preview':
        this.#schedulePreview(effect.text);
        return;
      case 'submit':
        void this.#submit(effect.projectId, effect.request, effect.choice, effect.allowCheckChanges === true);
        return;
      case 'session':
        void this.#sessionAction(effect.action, effect.id);
        return;
      case 'rename':
        void this.#rename(effect.id, effect.label);
        return;
      case 'settings-open':
        this.#openSettings();
        return;
      case 'settings':
        void this.#settingsEffect(effect.effect);
        return;
      case 'plans-open':
        this.#openPlans();
        return;
      case 'plans':
        void this.#plansEffect(effect.effect);
        return;
      case 'requirements-open':
        this.#openRequirements(effect.id, effect.title);
        return;
      case 'requirements':
        if (effect.effect.type !== 'close') void this.#requirementsEffect(effect.effect);
        return;
      case 'records':
        if (effect.open) void this.#openRecords();
        if (effect.load) void this.#loadRecords(effect.load);
        return;
      case 'detail':
        void this.#detailAction(effect.action);
        return;
      case 'fleets-open':
        this.#openFleets();
        return;
      case 'fleets':
        void this.#fleetsEffect(effect.effect);
        return;
      case 'runtime-open':
        this.#openRuntime(effect.id);
        return;
      case 'runtime':
        void this.#runtimeEffect(effect.effect);
        return;
      case 'folder':
        void this.#folderEffect(effect.effect);
        return;
      case 'changes-open':
        this.#openChanges(effect.id, effect.title);
        return;
      case 'changes':
        void this.#changesEffect(effect.effect);
        return;
    }
  }

  // ─── 지금 변경(#924) ───

  #openChanges(id: string, title: string): void {
    let comments: DeskComment[] = [];
    try {
      comments = this.#commentStore.load(id);
    } catch {
      // 읽지 못한 의견은 없는 것으로 연다(화면은 변경을 먼저 보인다)
    }
    const opened = openChanges(id, title, comments);
    this.#state = { ...this.#state, changes: opened.state };
    for (const effect of opened.effects) void this.#changesEffect(effect);
  }

  #patchChanges(id: string, change: (state: ChangesState) => ChangesState): void {
    const changes = this.#state.changes;
    if (!changes || changes.id !== id) return;
    this.#state = { ...this.#state, changes: change(changes) };
    this.#scheduleRender();
  }

  async #changesEffect(effect: ChangesEffect): Promise<void> {
    switch (effect.type) {
      case 'close':
        return;
      case 'load':
        try {
          const data = await this.#call('liveChanges')(effect.id);
          this.#patchChanges(effect.id, (state) => changesLoaded(state, data));
        } catch (error) {
          this.#patchChanges(effect.id, (state) => changesFailed(state, messageOf(error)));
        }
        return;
      case 'save-comments':
        try {
          this.#commentStore.save(effect.id, effect.comments);
        } catch (error) {
          this.#patchChanges(effect.id, (state) => ({ ...state, note: `의견을 저장하지 못했습니다: ${messageOf(error)}` }));
        }
        return;
      case 'send':
        await this.#work(effect.id, effect.text, {
          done: `의견 ${effect.count}개를 칸에 넣었습니다. 살펴보고 Enter로 보냅니다(보낸 의견은 x로 해결 표시할 때까지 다음 묶음에도 들어갑니다)`,
          blocked: (text) => this.#patchChanges(effect.id, (state) => ({ ...state, note: text })),
        });
        return;
    }
  }

  // ─── 폴더 열기(#916) ───

  #patchFolder(change: (folder: FolderState) => FolderState): void {
    const folder = this.#state.folder;
    if (!folder) return;
    this.#state = { ...this.#state, folder: change(folder) };
    this.#scheduleRender();
  }

  async #folderEffect(effect: FolderEffect): Promise<void> {
    switch (effect.type) {
      case 'close':
        return;
      case 'list':
        try {
          const listing = await this.#call('folders')(effect.path);
          this.#patchFolder((folder) => applyListing(folder, effect.path, listing));
        } catch (error) {
          this.#patchFolder((folder) => listingFailed(folder, effect.path, messageOf(error)));
        }
        return;
      case 'propose':
        try {
          const proposal = await this.#call('proposeFolder')(effect.path);
          this.#patchFolder((folder) => ({ ...folder, sending: false, proposal }));
        } catch (error) {
          this.#patchFolder((folder) => ({ ...folder, sending: false, error: `이 폴더를 열 수 없습니다: ${messageOf(error)}` }));
        }
        return;
      case 'register': {
        try {
          const result = await this.#call('registerFolder')(effect.path);
          const name = this.#state.folder?.proposal?.detection.name ?? result.id;
          this.#state = { ...this.#state, folder: undefined };
          // 등록한 프로젝트로 바로 새 요청을 연다. 스페이스는 세션이 생기면 사이드바에 나온다
          await this.#openPrompt(result.id, `‹${name}›을 ${result.created ? '프로젝트로 등록했습니다' : '엽니다(이미 등록한 폴더)'}${result.written.length ? ` · 만든 파일 ${result.written.join(', ')}` : ''}. 첫 요청을 쓰세요`);
        } catch (error) {
          this.#patchFolder((folder) => ({ ...folder, sending: false, proposal: undefined, error: `등록하지 못했습니다: ${messageOf(error)}` }));
        }
        return;
      }
    }
  }

  // ─── 실행·배포·미리보기·저장소 화면(#895) ───

  /** 실행 화면을 바꾼다. 그사이 닫혔거나 다른 세션의 화면이면 아무것도 하지 않는다 */
  #patchRuntime(id: string, change: (runtime: NonNullable<DeskState['runtime']>) => NonNullable<DeskState['runtime']>): void {
    const runtime = this.#state.runtime;
    if (!runtime || runtime.id !== id) return;
    this.#state = { ...this.#state, runtime: change(runtime) };
    this.#scheduleRender();
  }

  #closeRuntimeStream(): void {
    this.#runtimeStream?.abort();
    this.#runtimeStream = undefined;
    clearTimeout(this.#qaTimer);
    this.#qaTimer = undefined;
  }

  /** 키 처리가 연 실행 화면에 그 세션의 이벤트를 흘린다. 닫으면(close) 통로를 끊는다. 옛 스튜디오면 화면에 까닭을 보인다 */
  #openRuntime(id: string): void {
    this.#closeRuntimeStream();
    if (!this.#client.sessionEvents) {
      this.#state = { ...this.#state, runtime: undefined };
      this.#say('이 스튜디오는 실행 화면을 지원하지 않습니다. 스튜디오를 새로 띄운 뒤 다시 엽니다');
      return;
    }
    this.#state = { ...this.#state, help: false, message: undefined };
    const controller = new AbortController();
    this.#runtimeStream = controller;
    this.#call('sessionEvents')(
      id,
      (event) => {
        if (controller.signal.aborted) return;
        this.#patchRuntime(id, (runtime) => applyRuntimeEvent(runtime, event));
        // 배포가 끝나면 릴리스 목록이 바뀌었다. 배포 탭을 본 적이 있으면 다시 받는다
        if ((event.type === 'deploy_finished' || event.type === 'deploy_failed') && this.#state.runtime?.deploy.status) void this.#loadDeploys(id);
      },
      controller.signal,
    ).then(
      () => {
        if (!controller.signal.aborted) this.#patchRuntime(id, (runtime) => ({ ...runtime, error: '스튜디오가 세션 이벤트를 끊었습니다. Esc로 닫고 다시 여세요' }));
      },
      (error: unknown) => {
        if (!controller.signal.aborted) this.#patchRuntime(id, (runtime) => ({ ...runtime, error: `세션 이벤트를 받지 못했습니다: ${messageOf(error)}` }));
      },
    );
  }

  /** 탐색형 QA의 마지막 실행을 받는다. 도는 중이면 조금 뒤 다시 받는다(웹 화면과 같은 1.2초) */
  async #loadQa(id: string): Promise<void> {
    try {
      const run = await this.#call('exploreQa')(id);
      this.#patchRuntime(id, (runtime) => ({ ...runtime, qa: { ...runtime.qa, run, loading: false, error: undefined } }));
      if (run?.status === 'running') this.#scheduleQaPoll(id);
    } catch (error) {
      this.#patchRuntime(id, (runtime) => ({ ...runtime, qa: { ...runtime.qa, loading: false, error: `탐색형 QA를 받지 못했습니다: ${messageOf(error)}` } }));
    }
  }

  #scheduleQaPoll(id: string): void {
    clearTimeout(this.#qaTimer);
    this.#qaTimer = setTimeout(() => {
      this.#qaTimer = undefined;
      const runtime = this.#state.runtime;
      // QA 탭을 보고 있을 때만 다시 받는다. 다른 탭으로 가면 들어올 때 다시 받는다
      if (runtime?.id !== id || runtime.tab !== 'qa') {
        if (runtime?.id === id) this.#state = { ...this.#state, runtime: { ...runtime, qa: { ...runtime.qa, run: undefined, loading: false } } };
        return;
      }
      void this.#loadQa(id);
    }, QA_POLL_MS);
    this.#qaTimer.unref?.();
  }

  async #loadDeploys(id: string): Promise<void> {
    try {
      const status = await this.#call('deploys')(id);
      this.#patchRuntime(id, (runtime) => ({ ...runtime, deploy: { ...runtime.deploy, status, loading: false, error: undefined } }));
    } catch (error) {
      this.#patchRuntime(id, (runtime) => ({ ...runtime, deploy: { ...runtime.deploy, loading: false, error: `배포 상태를 받지 못했습니다: ${messageOf(error)}` } }));
    }
  }

  #runtimeOpenUrl(id: string, url: string): void {
    const note = (text: string) => this.#patchRuntime(id, (runtime) => ({ ...runtime, note: text }));
    if (!browsable(url)) note(`열 수 없는 주소입니다: ${url}`);
    else if (!this.#openUrl) note(`브라우저를 열 수 없습니다: ${url}`);
    else {
      this.#openUrl(url);
      note(`브라우저로 열었습니다: ${url}`);
    }
  }

  async #runtimeEffect(effect: RuntimeEffect): Promise<void> {
    if (effect.type === 'close') {
      this.#closeRuntimeStream();
      return;
    }
    const id = this.#state.runtime?.id;
    if (!id) return;
    const note = (text: string) => this.#patchRuntime(id, (runtime) => ({ ...runtime, note: text }));
    try {
      switch (effect.type) {
        case 'load-deploys':
          await this.#loadDeploys(id);
          return;
        case 'deploy':
          await this.#call('deploy')(id, effect.sha);
          note('배포를 시작했습니다. 진행은 이 화면에 나옵니다');
          return;
        case 'rollback':
          await this.#call('rollback')(id, effect.releaseId);
          note('되돌리기를 시작했습니다. 진행은 이 화면에 나옵니다');
          return;
        case 'service':
          await this.#call('setService')(id, effect.service, effect.on);
          note(effect.on ? `${effect.service}를 켜는 중입니다` : `${effect.service}를 껐습니다`);
          return;
        case 'boot':
          await this.#call('boot')(id);
          return;
        case 'open-url':
          this.#runtimeOpenUrl(id, effect.url);
          return;
        case 'preview': {
          const service = this.#state.runtime?.snapshot?.services.find((entry) => entry.name === effect.service);
          if (!service) return;
          this.#patchRuntime(id, (runtime) => ({ ...runtime, previews: { ...runtime.previews, [effect.service]: { loading: true } } }));
          try {
            const url = await this.#call('previewUrl')(id, service);
            this.#patchRuntime(id, (runtime) => ({ ...runtime, previews: { ...runtime.previews, [effect.service]: { url } } }));
            if (effect.open) this.#runtimeOpenUrl(id, url);
          } catch (error) {
            this.#patchRuntime(id, (runtime) => ({ ...runtime, previews: { ...runtime.previews, [effect.service]: { error: `주소를 받지 못했습니다: ${messageOf(error)}` } } }));
          }
          return;
        }
        case 'qa-load':
          await this.#loadQa(id);
          return;
        case 'qa-start':
          try {
            const run = await this.#call('startExploreQa')(id, effect.input);
            this.#patchRuntime(id, (runtime) => ({ ...runtime, qa: { ...runtime.qa, run, starting: false, error: undefined } }));
            this.#scheduleQaPoll(id);
          } catch (error) {
            this.#patchRuntime(id, (runtime) => ({ ...runtime, qa: { ...runtime.qa, starting: false, error: `시작하지 못했습니다: ${messageOf(error)}` } }));
          }
          return;
        case 'qa-stop':
          await this.#call('stopExploreQa')(id);
          await this.#loadQa(id);
          return;
        case 'qa-save': {
          const saved = await this.#call('saveExploreQa')(id, effect.service);
          const skipped = saved.skipped.length ? ` · 저장하지 못한 동작 ${saved.skipped.length}개(${saved.skipped.slice(0, 3).map((entry) => `${entry.index}번 ${entry.reason}`).join(', ')})` : '';
          note(`화면 확인으로 저장했습니다: ${saved.path}${skipped}`);
          return;
        }
        case 'qa-artifact': {
          const artifactUrl = this.#client.artifactUrl;
          if (!artifactUrl) {
            note('이 스튜디오는 사진 주소를 주지 않습니다');
            return;
          }
          this.#runtimeOpenUrl(id, artifactUrl.call(this.#client, id, effect.artifact));
          return;
        }
        case 'load-repo': {
          if (effect.view === 'presubmit') {
            const submission = await this.#call('submission')(id);
            this.#patchRuntime(id, (runtime) => ({ ...runtime, repo: { ...runtime.repo, submission, loading: false, error: undefined } }));
            return;
          }
          const projectId = this.#state.runtime?.snapshot?.projectId;
          if (!projectId) {
            this.#patchRuntime(id, (runtime) => ({ ...runtime, repo: { ...runtime.repo, loading: false, error: '세션 정보를 아직 받지 못했습니다. 잠시 뒤 r로 다시 받으세요' } }));
            return;
          }
          const list = await this.#call('repository')(projectId, effect.view, effect.state);
          this.#patchRuntime(id, (runtime) => ({ ...runtime, repo: { ...runtime.repo, [effect.view]: list, loading: false, error: undefined } }));
          return;
        }
      }
    } catch (error) {
      const text = messageOf(error);
      if (effect.type === 'load-repo') this.#patchRuntime(id, (runtime) => ({ ...runtime, repo: { ...runtime.repo, loading: false, error: `받지 못했습니다: ${text}` } }));
      else note(`하지 못했습니다: ${text}`);
    }
  }

  // ─── 여러 AI 비교(#892) ───

  /** 비교 화면을 바꾼다. 그사이 닫혔으면 아무것도 하지 않는다 */
  #patchFleets(change: (fleets: FleetsState) => FleetsState): void {
    const fleets = this.#state.fleets;
    if (!fleets) return;
    this.#state = { ...this.#state, fleets: change(fleets) };
    this.#scheduleRender();
  }

  #openFleets(): void {
    if (!this.#client.fleets) {
      this.#state = { ...this.#state, fleets: undefined, message: '이 스튜디오는 여러 AI 비교를 지원하지 않습니다. 스튜디오를 새로 띄운 뒤 다시 엽니다' };
      return;
    }
    void this.#loadFleets();
  }

  /** 목록을 받는다. 고르던 비교는 id로 기억해 그대로 고른다 */
  async #loadFleets(): Promise<void> {
    try {
      const list = await this.#call('fleets')();
      this.#patchFleets((fleets) => {
        const id = fleets.fleets[fleets.row]?.id;
        const row = Math.max(0, list.findIndex((fleet) => fleet.id === id));
        // 보던 비교는 목록이 다시 받은 것보다 새로울 수 있다(보기는 따로 받는다)
        const detail = fleets.detail ? fleets.fleets.find((fleet) => fleet.id === fleets.detail) : undefined;
        const merged = detail && !list.some((fleet) => fleet.id === detail.id) ? [detail, ...list] : list;
        return { ...fleets, fleets: merged, loading: false, error: undefined, row: Math.min(row, Math.max(0, merged.length - 1)) };
      });
    } catch (error) {
      this.#patchFleets((fleets) => ({ ...fleets, loading: false, error: messageOf(error) }));
    }
    this.#scheduleFleetPoll();
  }

  /** 비교 하나를 다시 받아 목록의 것을 바꾼다 */
  async #loadFleet(id: string): Promise<void> {
    try {
      const fresh = await this.#call('fleet')(id);
      this.#patchFleets((fleets) => ({ ...fleets, fleets: fleets.fleets.some((fleet) => fleet.id === id) ? fleets.fleets.map((fleet) => (fleet.id === id ? fresh : fleet)) : [fresh, ...fleets.fleets] }));
    } catch (error) {
      this.#patchFleets((fleets) => ({ ...fleets, note: `비교를 받지 못했습니다: ${messageOf(error)}` }));
    }
    this.#scheduleFleetPoll();
  }

  /** 보는 비교(보기면 그것, 목록이면 전체)에 진행 중인 참가자가 있으면 조금 뒤 다시 받는다 */
  #scheduleFleetPoll(): void {
    clearTimeout(this.#fleetTimer);
    this.#fleetTimer = undefined;
    const fleets = this.#state.fleets;
    if (!fleets || this.#restored || fleets.mode === 'new') return;
    const shown = fleets.mode === 'detail' ? fleets.fleets.filter((fleet) => fleet.id === fleets.detail) : fleets.fleets;
    const live = shown.some((fleet) => fleet.members.some((member) => member.status === 'booting' || member.status === 'running'));
    if (!live) return;
    this.#fleetTimer = setTimeout(() => {
      this.#fleetTimer = undefined;
      const now = this.#state.fleets;
      if (!now) return;
      if (now.mode === 'detail' && now.detail) void this.#loadFleet(now.detail);
      else if (now.mode === 'list') void this.#loadFleets();
    }, FLEET_POLL_MS);
    this.#fleetTimer.unref?.();
  }

  /** 새 비교 입력에 쓸 프로젝트와 고를 AI(스튜디오가 허용한 것, 계정이 둘 이상인 CLI는 계정마다) */
  async #loadFleetForm(): Promise<void> {
    try {
      const [projects, rules, accounts] = await Promise.all([this.#client.projects(), this.#client.rules(), this.#client.accounts().catch((): DeskAccount[] => this.#accounts)]);
      const usable = projects.filter((project) => !project.error).map(({ id, name }) => ({ id, name }));
      // 데모는 비교할 후보가 아니다(스튜디오 FLEET_MODES와 같다)
      const options = fleetOptions(rules.allowed.filter((backend) => backend !== 'demo'), accounts);
      const at = Math.max(0, usable.findIndex((project) => project.name === deskSessions(this.#state.items)[this.#state.selected]?.projectName));
      this.#patchFleets((fleets) =>
        fleets.form ? { ...fleets, form: { ...fleets.form, loading: false, projects: usable, projectIndex: at, options, ...(usable.length === 0 ? { error: '프로젝트가 없습니다' } : {}) } } : fleets,
      );
    } catch (error) {
      this.#patchFleets((fleets) => (fleets.form ? { ...fleets, form: { ...fleets.form, loading: false, error: `목록을 받지 못했습니다: ${messageOf(error)}` } } : fleets));
    }
  }

  async #fleetsEffect(effect: FleetsEffect): Promise<void> {
    const note = (text: string) => this.#patchFleets((fleets) => ({ ...fleets, note: text }));
    switch (effect.type) {
      case 'close':
        clearTimeout(this.#fleetTimer);
        this.#fleetTimer = undefined;
        return;
      case 'reload':
        await this.#loadFleets();
        return;
      case 'detail':
        await this.#loadFleet(effect.id);
        return;
      case 'form':
        clearTimeout(this.#fleetTimer);
        await this.#loadFleetForm();
        return;
      case 'create': {
        try {
          const made = await this.#call('createFleet')({ projectId: effect.projectId, request: effect.request, candidates: effect.candidates });
          this.#patchFleets((fleets) => ({ ...fleets, mode: 'detail', detail: made.id, member: 0, form: undefined, fleets: [made, ...fleets.fleets.filter((fleet) => fleet.id !== made.id)], note: `참가자 ${made.members.length}명에게 보냈습니다` }));
          // 참가자 세션이 카드·사이드바에 바로 보이게 목록을 다시 받는다
          void this.#poll();
        } catch (error) {
          this.#patchFleets((fleets) => (fleets.form ? { ...fleets, form: { ...fleets.form, sending: false, error: `만들지 못했습니다: ${messageOf(error)}` } } : fleets));
        }
        this.#scheduleFleetPoll();
        return;
      }
      case 'winner': {
        try {
          const chosen = await this.#call('chooseFleetWinner')(effect.id, effect.sessionId);
          this.#patchFleets((fleets) => ({ ...fleets, fleets: fleets.fleets.map((fleet) => (fleet.id === chosen.id ? chosen : fleet)), note: '승자를 골랐습니다' }));
        } catch (error) {
          note(`승자를 고르지 못했습니다: ${messageOf(error)}`);
        }
        return;
      }
      case 'delete': {
        try {
          await this.#call('deleteFleet')(effect.id);
          this.#patchFleets((fleets) => {
            const rest = fleets.fleets.filter((fleet) => fleet.id !== effect.id);
            return { ...fleets, fleets: rest, mode: 'list', detail: undefined, member: 0, row: Math.min(fleets.row, Math.max(0, rest.length - 1)), note: '비교와 참가자 세션을 지웠습니다' };
          });
          void this.#poll();
        } catch (error) {
          note(`지우지 못했습니다: ${messageOf(error)}`);
        }
        return;
      }
      case 'open': {
        const placed = placeMembers(this.#state, effect.sessionIds);
        if ('error' in placed) {
          note(placed.error);
          return;
        }
        clearTimeout(this.#fleetTimer);
        this.#fleetTimer = undefined;
        this.#state = { ...this.#state, ...placed, fleets: undefined, view: undefined, zoom: false, message: `참가자 ${effect.sessionIds.length}명의 작업 복사본을 칸에 열었습니다` };
        this.#slotsChanged();
        this.#saveLayout();
        this.#scheduleRender();
        return;
      }
    }
  }

  /** 기록 화면·세션 자세히의 API. 옛 손님이 그 API를 모르면 부를 때 실패로 알린다(화면은 까닭을 보인다) */
  #call<K extends RecordsCall | PlansCall | RequirementsCall | FleetsCall | RuntimeCall | FolderCall | ChangesCall>(name: K): StudioClient[K] {
    const method = this.#client[name];
    if (method) return method.bind(this.#client) as StudioClient[K];
    return (async () => {
      throw new Error('이 스튜디오는 이 기능을 지원하지 않습니다. 스튜디오를 새로 띄운 뒤 다시 엽니다');
    }) as unknown as StudioClient[K];
  }

  /** 기록 화면을 채운다: 프로젝트 목록(토큰 보고서용)과 계정 이름, 그리고 AI별 결과(#891) */
  async #openRecords(): Promise<void> {
    const [projects, accounts] = await Promise.all([
      this.#client.projects().catch(() => [] as Array<{ id: string; name: string; error?: string }>),
      this.#client.accounts().catch((): DeskAccount[] => []),
    ]);
    const records = this.#state.records;
    if (!records) return;
    const usable = projects.filter((project) => !project.error).map((project) => ({ id: project.id, name: project.name }));
    const name = deskSessions(this.#state.items)[this.#state.selected]?.projectName;
    const names = Object.fromEntries(accounts.map((account) => [account.id, account.name]));
    this.#state = { ...this.#state, records: { ...records, projects: usable, projectIndex: Math.max(0, usable.findIndex((project) => project.name === name)), names } };
    await this.#loadRecords({ kind: 'stats' });
  }

  async #loadRecords(load: RecordsLoad): Promise<void> {
    try {
      if (load.kind === 'stats') {
        const stats = await this.#call('routingStats')();
        if (this.#state.records) this.#state = { ...this.#state, records: { ...this.#state.records, stats, statsError: undefined, loading: false } };
      } else {
        const report = await this.#call('tokenReport')(load.projectId, load.from);
        const records = this.#state.records;
        // 그사이 다른 프로젝트를 골랐으면 버린다
        if (records && records.projects[records.projectIndex]?.id === load.projectId) this.#state = { ...this.#state, records: { ...records, report, reportError: undefined, loading: false } };
      }
    } catch (error) {
      const records = this.#state.records;
      if (records) this.#state = { ...this.#state, records: { ...records, ...(load.kind === 'stats' ? { statsError: messageOf(error) } : { reportError: messageOf(error) }), loading: false } };
    }
    this.#scheduleRender();
  }

  /** 세션 자세히의 일을 서버에 보낸다(#891). 답이 오기 전에 다른 세션의 자세히로 바뀌었으면 버린다 */
  async #detailAction(action: DetailAction): Promise<void> {
    const id = this.#state.detail?.id;
    if (!id) return;
    const update = (patch: Partial<DetailState>) => {
      const detail = this.#state.detail;
      if (detail?.id === id) this.#state = { ...this.#state, detail: { ...detail, ...patch } };
      this.#scheduleRender();
    };
    const fail = (what: string) => (error: unknown) => update({ busy: undefined, message: `${what}: ${messageOf(error)}` });
    const reload = async () => {
      try {
        const snapshot = await this.#call('session')(id);
        const detail = this.#state.detail;
        const count = detail?.tab === 'checkpoints' ? snapshot.checkpoints.length : Number.POSITIVE_INFINITY;
        update({ snapshot, loading: false, error: undefined, ...(detail ? { selected: Math.max(0, Math.min(detail.selected, count - 1)) } : {}) });
      } catch (error) {
        update({ loading: false, error: messageOf(error) });
      }
    };
    switch (action.kind) {
      case 'load':
        await reload();
        return;
      case 'checkChanges':
        // 확인 선언 변경 허용(#916, ADR-164): 터미널 세션의 다음 요청 하나에 켜고 끈다
        await this.#call('allowCheckChanges')(id, action.allow).then(
          (armed) =>
            update({
              busy: undefined,
              checkChangesArmed: armed,
              message: armed ? '켰습니다. 이 세션의 다음 요청 하나가 바뀐 확인 선언으로 검증합니다' : '껐습니다',
            }),
          fail(action.allow ? '켜지 못했습니다' : '끄지 못했습니다'),
        );
        return;
      case 'patch':
        try {
          const files = parsePatch(await this.#call('checkpointPatch')(id, action.sha));
          const patch = this.#state.detail?.patch;
          if (patch?.sha === action.sha) update({ patch: { ...patch, files, loading: false } });
        } catch (error) {
          const patch = this.#state.detail?.patch;
          if (patch?.sha === action.sha) update({ patch: { ...patch, loading: false, error: messageOf(error) } });
        }
        return;
      case 'restore':
        await this.#call('restoreCheckpoint')(id, action.sha).then(
          () => update({ busy: undefined, message: '되돌리기를 시작했습니다. 끝나면 체크포인트 목록이 바뀝니다(r로 다시 부릅니다)' }),
          fail('되돌리지 못했습니다'),
        );
        await reload();
        return;
      case 'reverify':
        await this.#call('reverify')(id, action.sha).then(
          () => update({ busy: undefined, message: '다시 검증을 시작했습니다. 결과는 끝난 뒤 r로 다시 불러 봅니다' }),
          fail('다시 검증하지 못했습니다'),
        );
        return;
      case 'delete':
        try {
          await this.#call('deleteSession')(id);
          const title = this.#state.detail?.title ?? id;
          // 지운 세션이 칸에 있으면 비운다
          const slots = this.#state.slots.map((slot) => (slot === id ? undefined : slot));
          this.#state = { ...this.#state, detail: undefined, slots, message: `세션을 지웠습니다: ${title}` };
          this.#slotsChanged();
          this.#saveLayout();
          void this.#poll();
          this.#scheduleRender();
        } catch (error) {
          fail('지우지 못했습니다')(error);
        }
        return;
      case 'exportPreview':
        try {
          update({ preview: await this.#call('exportPreview')(id), previewError: undefined });
        } catch (error) {
          update({ previewError: messageOf(error) });
        }
        return;
      case 'export':
        try {
          const result = await this.#call('exportSession')(id, action.pullRequest);
          const pr = result.pullRequest;
          const text = pr
            ? pr.created
              ? 'PR을 만들었습니다'
              : pr.updated
                ? '이미 열린 PR의 본문을 지금 상태로 고쳤습니다'
                : '이미 열린 PR에 올렸습니다'
            : result.pullRequestError
              ? `브랜치를 올렸지만 PR을 만들지 못했습니다: ${result.pullRequestError}`
              : `브랜치를 올렸습니다(커밋 ${result.commits}개${result.forced ? ', 되돌린 기록으로 맞춤' : ''})`;
          update({ busy: undefined, result: { text, ...(pr ? { url: pr.url } : {}) } });
          await reload();
        } catch (error) {
          fail('올리지 못했습니다')(error);
        }
        return;
      case 'review':
        await this.#call('reviewRound')(id, action.restart).then(
          () => update({ busy: undefined, message: 'AI 리뷰를 시작했습니다. 진행은 r로 다시 불러 봅니다' }),
          fail('AI 리뷰를 돌리지 못했습니다'),
        );
        return;
      case 'resolve':
        try {
          await this.#call('resolveFinding')(id, { round: action.round, findingIndex: action.findingIndex, reason: action.reason });
          update({ busy: undefined, message: '지적을 오탐으로 닫았습니다' });
          await reload();
        } catch (error) {
          fail('지적을 닫지 못했습니다')(error);
        }
        return;
    }
  }

  // ─── 작업 나누기 화면(#893) ───

  /** 작업 나누기 화면을 바꾼다. 그사이 닫혔으면 아무것도 하지 않는다 */
  #patchPlans(change: (plans: PlansState) => PlansState): void {
    const plans = this.#state.plans;
    if (!plans) return;
    this.#state = { ...this.#state, plans: change(plans) };
    this.#scheduleRender();
  }

  #openPlans(): void {
    if (!this.#client.plans) {
      this.#state = { ...this.#state, plans: undefined, message: '이 스튜디오는 작업 나누기를 지원하지 않습니다. 스튜디오를 새로 띄운 뒤 다시 엽니다' };
      return;
    }
    this.#patchPlans((plans) => ({ ...plans, accounts: this.#accounts }));
    void this.#loadPlans();
    clearInterval(this.#plansTimer);
    // 열려 있는 동안 레인 상태가 바뀌므로 다시 받는다. 닫으면 멈춘다
    this.#plansTimer = setInterval(() => {
      if (!this.#state.plans) {
        clearInterval(this.#plansTimer);
        this.#plansTimer = undefined;
        return;
      }
      void this.#loadPlans();
    }, PLANS_POLL_MS);
    this.#plansTimer.unref?.();
  }

  /** 지금 모드에 맞게 목록이나 계획 하나를 받는다. 새 계획을 쓰는 중이면 받지 않는다 */
  async #loadPlans(): Promise<void> {
    const plans = this.#state.plans;
    if (!plans || plans.mode === 'new' || this.#plansFetching) return;
    this.#plansFetching = true;
    try {
      if (plans.mode === 'detail' && plans.detail) {
        const id = plans.detail.id;
        const plan = await this.#call('plan')(id);
        if (this.#restored) return;
        this.#patchPlans((current) => (current.mode === 'detail' && current.detail?.id === id ? { ...current, detail: plan, loading: false, error: undefined } : current));
      } else {
        const list = await this.#call('plans')();
        if (this.#restored) return;
        this.#patchPlans((current) => (current.mode === 'list' ? { ...current, list, loading: false, error: undefined, row: Math.max(0, Math.min(current.row, list.length - 1)) } : current));
      }
    } catch (error) {
      if (this.#restored) return;
      const gone = error instanceof StudioRequestError && error.status === 404;
      this.#patchPlans((current) =>
        gone && current.mode === 'detail'
          ? { ...current, mode: 'list', detail: undefined, note: '계획이 없어졌습니다' }
          : { ...current, loading: false, error: `계획을 받지 못했습니다: ${messageOf(error)}` },
      );
    } finally {
      this.#plansFetching = false;
    }
  }

  /** 받은 계획으로 보는 계획과 목록의 그 줄을 바꾼다 */
  #showPlan(plan: DeskPlan, note?: string): void {
    this.#patchPlans((plans) => ({
      ...plans,
      ...(plans.mode === 'detail' && plans.detail?.id === plan.id ? { detail: plan } : {}),
      ...(plans.list ? { list: plans.list.map((entry) => (entry.id === plan.id ? plan : entry)) } : {}),
      ...(note ? { note } : {}),
    }));
  }

  async #plansEffect(effect: PlansEffect): Promise<void> {
    if (effect.type === 'close') {
      clearInterval(this.#plansTimer);
      this.#plansTimer = undefined;
      return;
    }
    const note = (text: string) => this.#patchPlans((plans) => ({ ...plans, note: text }));
    try {
      switch (effect.type) {
        case 'list':
        case 'detail':
          await this.#loadPlans();
          return;
        case 'projects': {
          const projects = (await this.#client.projects()).filter((project) => !project.error);
          this.#patchPlans((plans) => (plans.form ? { ...plans, form: { ...plans.form, projects } } : plans));
          if (projects.length === 0) note('프로젝트가 없습니다');
          return;
        }
        case 'create': {
          try {
            const plan = await this.#call('createPlan')(effect.projectId, effect.request);
            this.#patchPlans((plans) => ({ ...plans, mode: 'detail', form: undefined, detail: plan, lane: 0, list: [plan, ...(plans.list ?? []).filter((entry) => entry.id !== plan.id)] }));
          } catch (error) {
            this.#patchPlans((plans) => ({ ...plans, ...(plans.form ? { form: { ...plans.form, sending: false } } : {}), note: `계획을 만들지 못했습니다: ${messageOf(error)}` }));
          }
          return;
        }
        case 'approve':
          this.#showPlan(await this.#call('approvePlan')(effect.id, effect.publishIssues), effect.publishIssues ? '승인했습니다. 레인이 시작되고 이슈를 올립니다' : '승인했습니다. 레인이 시작됩니다');
          return;
        case 'reject':
          this.#showPlan(await this.#call('rejectPlan')(effect.id), '거부했습니다');
          return;
        case 'resume':
          this.#showPlan(await this.#call('resumePlan')(effect.id), '통합을 다시 시작했습니다');
          return;
        case 'delete':
          await this.#call('deletePlan')(effect.id);
          note('계획을 지웠습니다');
          await this.#loadPlans();
          return;
        case 'lane-choices': {
          const [backends, accounts] = await Promise.all([this.#call('laneBackends')(), this.#client.accounts().catch((): DeskAccount[] => this.#accounts)]);
          const choices: LaneChoice[] = [{ backend: '', label: '세션과 같음(계획 기본)' }];
          for (const backend of backends) {
            choices.push({ backend, label: backendLabel(backend) });
            // 기본 계정(id가 CLI 이름)은 위의 AI 줄과 같다
            for (const account of accounts) if (account.backend === backend && !account.builtin && account.id !== backend) choices.push({ backend, accountId: account.id, label: `${backendLabel(backend)} · ${account.name}` });
          }
          this.#patchPlans((plans) => {
            const lane = plans.detail?.lanes.find((entry) => entry.id === plans.picker?.laneId);
            const index = lane ? choices.findIndex((choice) => choice.backend === (lane.backend ?? '') && (choice.accountId ?? '') === (lane.accountId ?? '')) : -1;
            return { ...plans, choices, accounts, ...(plans.picker ? { picker: { ...plans.picker, index: Math.max(0, index) } } : {}) };
          });
          return;
        }
        case 'lane':
          this.#showPlan(await this.#call('setLane')(effect.id, effect.laneId, effect.backend, effect.accountId), '레인 AI·계정을 바꿨습니다');
          return;
        case 'open':
          this.#openFromPlans([effect.sessionId]);
          return;
        case 'grid':
          this.#openFromPlans(effect.sessionIds);
          return;
        case 'open-url':
          if (!browsable(effect.url)) note('브라우저로 열 수 없는 주소입니다');
          else if (this.#openUrl) this.#openUrl(effect.url);
          else note(`브라우저를 열 수 없습니다: ${effect.url}`);
          return;
      }
    } catch (error) {
      note(messageOf(error));
    }
  }

  /**
   * 작업 나누기 화면을 닫고 레인 세션을 칸에 연다. 하나면 고른 칸에(이미 칸에 있으면 그 칸으로 간다),
   * 여럿이면 칸 수를 2·4로 늘려 나란히 연다. 셸 칸은 그대로 두고 남은 칸에 놓는다
   */
  #openFromPlans(ids: readonly string[]): void {
    clearInterval(this.#plansTimer);
    this.#plansTimer = undefined;
    const state: DeskState = { ...this.#state, plans: undefined, view: undefined, usageBack: undefined };
    if (ids.length === 1) {
      const id = ids[0]!;
      const already = state.slots.findIndex((slot, index) => slot === id && index < state.layout);
      if (already >= 0) {
        this.#state = { ...state, focus: already };
        this.#apply({ type: 'reopen', id });
      } else if (isShellId(state.slots[state.focus])) {
        this.#state = { ...state, message: SHELL_TAKEN };
      } else {
        const slots = [...state.slots];
        slots[state.focus] = id;
        this.#state = { ...state, slots };
        this.#apply({ type: 'open', slot: state.focus, id });
      }
      this.#scheduleRender();
      return;
    }
    const layout: PaneLayout = ids.length <= 2 ? 2 : 4;
    const slots = state.slots.map((id, slot) => (slot < layout && isShellId(id) ? id : undefined));
    let at = 0;
    for (const id of ids) {
      while (at < layout && slots[at] !== undefined) at++;
      if (at >= layout) break;
      slots[at] = id;
    }
    // 가려 둔 셸 칸(배치 밖)은 그대로 둔다
    for (let slot = layout; slot < state.slots.length; slot++) if (isShellId(state.slots[slot])) slots[slot] = state.slots[slot];
    this.#state = { ...state, layout, slots, focus: 0, zoom: false };
    this.#apply({ type: 'layout' });
    this.#scheduleRender();
  }

  // ─── 요구사항·문서 화면(#894) ───

  #openRequirements(id: string, title: string): void {
    if (!this.#client.requirements) {
      this.#say('이 스튜디오는 요구사항 화면을 지원하지 않습니다. 스튜디오를 새로 띄운 뒤 다시 엽니다');
      return;
    }
    const opened = openRequirements({ sessionId: id, title });
    // 덮는 화면은 하나만 둔다
    clearInterval(this.#plansTimer);
    this.#plansTimer = undefined;
    this.#state = { ...this.#state, requirements: opened.state, records: undefined, detail: undefined, plans: undefined, help: false, message: undefined };
    for (const effect of opened.effects) void this.#requirementsEffect(effect);
    this.#scheduleRender();
  }

  /** 요구사항 화면을 바꾼다. 그사이 닫혔거나 다른 세션의 화면이면 아무것도 하지 않는다 */
  #patchRequirements(sessionId: string, change: (state: RequirementsState) => RequirementsState): void {
    const current = this.#state.requirements;
    if (!current || current.sessionId !== sessionId) return;
    this.#state = { ...this.#state, requirements: change(current) };
    this.#scheduleRender();
  }

  async #loadRequirementsTab(sessionId: string, tab: RequirementsTab): Promise<void> {
    try {
      const value =
        tab === 'spec'
          ? { spec: await this.#call('requirements')(sessionId) }
          : tab === 'tests'
            ? { tests: await this.#call('tests')(sessionId) }
            : tab === 'docs'
              ? { docs: await this.#call('docs')(sessionId) }
              : { status: await this.#call('projectStatus')(sessionId) };
      this.#patchRequirements(sessionId, (state) => loaded(state, tab, value));
    } catch (error) {
      this.#patchRequirements(sessionId, (state) => loaded(state, tab, { error: messageOf(error) }));
    }
  }

  async #requirementsEffect(effect: RequirementsEffect): Promise<void> {
    const current = this.#state.requirements;
    if (!current) return;
    const sessionId = current.sessionId;
    const note = (text: string) => this.#patchRequirements(sessionId, (state) => ({ ...state, note: text }));
    switch (effect.type) {
      case 'load':
        await this.#loadRequirementsTab(sessionId, effect.tab);
        return;
      case 'doc':
        try {
          const content = await this.#call('doc')(sessionId, effect.path);
          this.#patchRequirements(sessionId, (state) => (state.reader?.path === effect.path ? { ...state, reader: { ...state.reader, content, error: undefined } } : state));
        } catch (error) {
          this.#patchRequirements(sessionId, (state) => (state.reader?.path === effect.path ? { ...state, reader: { ...state.reader, error: messageOf(error) } } : state));
        }
        return;
      case 'work':
        await this.#work(sessionId, effect.text);
        return;
      case 'edit':
        await this.#edit(this.#requirementsHost, sessionId, effect.path);
        return;
      case 'verify':
      case 'unverify':
      case 'apply-draft':
        try {
          const spec =
            effect.type === 'verify'
              ? await this.#call('verifyRequirement')(sessionId, effect.requirementId, effect.note)
              : effect.type === 'unverify'
                ? await this.#call('clearVerification')(sessionId, effect.requirementId)
                : await this.#call('applyRequirements')(sessionId, current.spec?.draft ?? { requirements: [] });
          const done = effect.type === 'verify' ? `${effect.requirementId}에 사람 확인을 남겼습니다` : effect.type === 'unverify' ? `${effect.requirementId}의 사람 확인을 지웠습니다` : `${REQUIREMENTS_FILE}로 저장했습니다`;
          this.#patchRequirements(sessionId, (state) => ({ ...loaded(state, 'spec', { spec }), ...(effect.type === 'apply-draft' ? { draft: false, row: 0 } : {}), note: done }));
        } catch (error) {
          note(`하지 못했습니다: ${messageOf(error)}`);
        }
        return;
    }
  }

  /**
   * "이 요구사항으로 작업"(#894): 화면을 닫고 세션을 칸에 연 뒤(이미 있으면 그 칸) 글을 CLI 입력 칸에 넣는다. 보내기(Enter)는 사람이 한다.
   * 안쪽 CLI가 붙여넣기 표지를 켜면 여러 줄 그대로 붙여 넣고, 켜지 않으면 줄바꿈을 띄어쓰기로 바꾼다(줄바꿈이 곧 보내기가 되지 않게)
   */
  async #work(
    sessionId: string,
    text: string,
    say: { done: string; blocked: (text: string) => void } = {
      done: '작업 글을 칸에 넣었습니다. 살펴보고 Enter로 보냅니다',
      blocked: (note) => this.#patchRequirements(sessionId, (current) => ({ ...current, note })),
    },
  ): Promise<void> {
    const state = this.#state;
    let slot = state.slots.findIndex((id, at) => id === sessionId && at < state.layout);
    if (slot < 0) {
      slot = !isShellId(state.slots[state.focus]) ? state.focus : state.slots.findIndex((id, at) => at < state.layout && !isShellId(id));
      if (slot < 0) {
        say.blocked('모든 칸에 셸이 돌고 있습니다. 칸을 하나 비운 뒤 다시 합니다');
        return;
      }
    }
    const slots = [...state.slots];
    slots[slot] = sessionId;
    // 요구사항(#894)·지금 변경(#924) 화면을 닫고 그 칸을 보인다
    this.#state = { ...state, requirements: undefined, changes: undefined, slots, focus: slot, view: undefined, zoom: state.zoom && slot === state.focus };
    // 끝났거나 열지 못한 터미널이면 다시 연다
    if (this.#closed.delete(sessionId)) this.#sizes.delete(sessionId);
    this.#slotsChanged();
    this.#saveLayout();
    this.#render();
    const opened = await (this.#opening.get(sessionId) ?? Promise.resolve(true));
    if (!opened || this.#restored) {
      this.#say('터미널을 열지 못해 작업 글을 넣지 못했습니다');
      return;
    }
    // 막 뜬 CLI는 붙여넣기 표지를 조금 뒤에 켠다. 잠깐 기다려 본다
    const pane = () => this.#panes.get(sessionId);
    for (let waited = 0; waited < WORK_PASTE_WAIT_MS && !pane()?.modes().bracketedPaste; waited += 100) await new Promise((resolve) => setTimeout(resolve, 100));
    if (this.#restored) return;
    const bracketed = pane()?.modes().bracketedPaste === true;
    this.#send(sessionId, bracketed ? `\x1b[200~${text}\x1b[201~` : text.replace(/\r\n?|\n/g, ' '));
    this.#say(say.done);
  }

  /**
   * 문서를 편집기로 고친다(#894): 스튜디오에서 받은 글을 임시 파일에 두고, 화면과 raw 모드를 내려놓은 채 편집기를 띄운다.
   * 끝나면 화면을 되돌리고, 바뀌었으면 스튜디오에 쓴다. 쓰지 못하면 고친 글을 그 파일에 남기고 자리를 알린다
   */
  async #edit(host: RequirementsHost, sessionId: string, path: string): Promise<void> {
    if (this.#editing) return;
    const say = (text: string) => this.#patchRequirements(sessionId, (state) => ({ ...state, note: text }));
    let original: string;
    try {
      original = await this.#call('doc')(sessionId, path);
    } catch (error) {
      if (path === REQUIREMENTS_FILE && error instanceof StudioRequestError && error.status === 404) original = REQUIREMENTS_TEMPLATE;
      else {
        say(`문서를 받지 못했습니다: ${messageOf(error)}`);
        return;
      }
    }
    if (this.#restored || this.#state.requirements?.sessionId !== sessionId) return;
    let dir: string;
    let file: string;
    try {
      dir = mkdtempSync(join(host.tmpDir ?? tmpdir(), 'b-studio-edit-'));
      file = join(dir, basename(path) || 'doc.md');
      writeFileSync(file, original, { mode: 0o600 });
    } catch (error) {
      say(`임시 파일을 만들지 못했습니다: ${messageOf(error)}`);
      return;
    }
    let code: number;
    this.#editing = true;
    this.#suspendScreen();
    try {
      code = host.editor(file);
    } catch (error) {
      code = -1;
      say(`편집기를 띄우지 못했습니다: ${messageOf(error)}`);
    } finally {
      this.#resumeScreen();
      this.#editing = false;
    }
    let edited: string;
    try {
      edited = readFileSync(file, 'utf8');
    } catch (error) {
      say(`고친 글을 읽지 못했습니다: ${messageOf(error)}`);
      return;
    }
    const cleanup = () => rmSync(dir, { recursive: true, force: true });
    if (edited === original) {
      cleanup();
      if (code === 0) say('바뀐 것이 없습니다');
      else if (code !== -1) say(`편집기가 ${code}로 끝났습니다. 저장하지 않았습니다`);
      return;
    }
    if (code !== 0) {
      say(`편집기가 ${code}로 끝나 저장하지 않았습니다. 고친 글은 ${file}에 남겨 두었습니다`);
      return;
    }
    try {
      await this.#call('saveDoc')(sessionId, path, edited);
    } catch (error) {
      say(`저장하지 못했습니다: ${messageOf(error)} · 고친 글은 ${file}에 남겨 두었습니다`);
      return;
    }
    cleanup();
    say(`${path}를 저장했습니다`);
    // 고친 문서를 쓰는 탭을 다시 읽는다
    const state = this.#state.requirements;
    if (!state || state.sessionId !== sessionId) return;
    const reload: RequirementsEffect[] = [];
    if (path === REQUIREMENTS_FILE) reload.push({ type: 'load', tab: 'spec' });
    if (state.docs) reload.push({ type: 'load', tab: 'docs' });
    if (state.reader?.path === path) reload.push({ type: 'doc', path });
    for (const effect of reload) await this.#requirementsEffect(effect);
  }

  /**
   * 편집기 같은 다른 프로그램에 터미널을 넘긴다: Kitty 그림·마우스·포커스 알림을 끄고 대체 화면과 raw 모드를 나간다.
   * 편집기는 동기로 띄우므로(spawnSync) 그동안 이벤트 루프가 멈춰 움짤 시계·사용량·사이드바 폴링·통로가 화면에 쓰지 않는다.
   * 그사이 쌓인 일은 되돌린 뒤 처음부터 다시 그린 화면 위에서 이어진다
   */
  #suspendScreen(): void {
    this.#io.write((this.#state.kitty?.clear() ?? '') + (this.#animate ? FOCUS_OFF : '') + (this.#mouseOn ? MOUSE_OFF : '') + LEAVE_SCREEN);
    this.#io.setRaw(false);
  }

  /** 넘겼던 터미널을 되찾아 처음부터 다시 그린다 */
  #resumeScreen(): void {
    this.#io.setRaw(true);
    this.#io.write(ENTER_SCREEN + (this.#mouseOn ? MOUSE_ON : '') + (this.#animate ? FOCUS_ON : ''));
    this.#prevFrame = [];
    this.#render();
  }

  // ─── 설정 화면(#890) ───

  /** 설정 화면을 바꾼다. 그사이 닫혔으면 아무것도 하지 않는다 */
  #patchSettings(change: (settings: SettingsState) => SettingsState): void {
    const settings = this.#state.settings;
    if (!settings) return;
    this.#state = { ...this.#state, settings: change(settings) };
    this.#scheduleRender();
  }

  /** 키 처리가 연 설정 화면에 desk.json의 값과 그림 목록을 채우고, 계정·규칙을 받는다 */
  #openSettings(): void {
    const host = this.#settingsHost;
    if (!host) {
      this.#state = { ...this.#state, settings: undefined };
      this.#say('이 desk는 설정 화면을 열 수 없습니다. pnpm studio로 다시 여세요');
      return;
    }
    let config: DeskConfig = {};
    let sprites: string[] = [];
    try {
      config = host.loadConfig();
    } catch {
      // 읽지 못한 설정은 기본값으로 보인다. 바꾸면 새로 쓴다
    }
    try {
      sprites = host.spriteFiles();
    } catch {
      // 그림 폴더가 없으면 고를 그림이 없다
    }
    // 여는 사이 이미 바꾼 값(같은 입력 조각에서 친 키)이 파일 값보다 앞선다
    const opened = this.#state.settings ?? openSettings({ config: {}, sprites: [] });
    this.#state = { ...this.#state, settings: { ...opened, config: { ...config, ...opened.config }, sprites }, help: false, message: undefined };
    void this.#loadSettings(host);
  }

  async #loadSettings(host: SettingsHost): Promise<void> {
    const [accounts, rules] = await Promise.all([
      host.client.accounts().then(
        (list) => ({ list }),
        (error: unknown) => ({ list: [] as DeskAccount[], error: messageOf(error) }),
      ),
      host.client.rules().then(
        (view) => ({ view }),
        (error: unknown) => ({ view: undefined, error: messageOf(error) }),
      ),
    ]);
    if (!('error' in accounts)) this.#setAccounts(accounts.list);
    this.#patchSettings((settings) => ({
      ...settings,
      loading: false,
      accounts: accounts.list.map((account): SettingsAccount => ({ ...account, checking: true })),
      ...('error' in accounts && accounts.error ? { accountsError: accounts.error } : {}),
      backends: rules.view?.allowed ?? [],
      ...(rules.view?.rules ? { rules: rules.view.rules } : {}),
      ...(rules.view?.defaultBackend ? { defaultBackend: rules.view.defaultBackend } : {}),
      ...('error' in rules && rules.error ? { rulesError: `규칙을 받지 못했습니다: ${rules.error}` } : rules.view?.error ? { rulesError: `저장한 규칙을 쓰지 못합니다: ${rules.view.error}` } : {}),
    }));
    // 로그인 상태는 CLI를 띄워 재서 느리다. 계정마다 따로 묻는다
    for (const account of accounts.list) void this.#checkStatus(host, account.id);
  }

  async #checkStatus(host: SettingsHost, id: string): Promise<void> {
    try {
      const status = await host.client.accountStatus(id);
      this.#patchSettings((settings) => ({ ...settings, accounts: settings.accounts.map((account) => (account.id === id ? { ...account, status, checking: false, statusError: undefined } : account)) }));
    } catch (error) {
      this.#patchSettings((settings) => ({ ...settings, accounts: settings.accounts.map((account) => (account.id === id ? { ...account, checking: false, statusError: messageOf(error) } : account)) }));
    }
  }

  /** 계정 목록을 다시 받아 설정 화면과 카드 그림에 쓴다. select를 주면 그 계정을 고른다. 이미 잰 로그인 상태는 남긴다 */
  async #reloadAccounts(host: SettingsHost, select?: string): Promise<void> {
    const list = await host.client.accounts();
    this.#setAccounts(list);
    this.#patchSettings((settings) => {
      const known = new Map(settings.accounts.map((account) => [account.id, account]));
      const accounts = list.map((account): SettingsAccount => {
        const before = known.get(account.id);
        return { ...account, ...(before?.status ? { status: before.status } : {}), ...(before?.checking ? { checking: true } : {}) };
      });
      const index = select === undefined ? -1 : accounts.findIndex((account) => account.id === select);
      const row = settings.tab === 'accounts' ? (index >= 0 ? index : Math.min(settings.row, Math.max(0, accounts.length - 1))) : settings.row;
      return { ...settings, accounts, row, accountsError: undefined };
    });
  }

  /** 카드 그림에 쓰는 계정이 바뀌었다: 그림 폴더·계정 그림에서 단 카드 그림을 지워 다시 단다 */
  #setAccounts(list: DeskAccount[]): void {
    const changed = JSON.stringify(list.map((account) => [account.id, account.sprite ?? ''])) !== JSON.stringify(this.#accounts.map((account) => [account.id, account.sprite ?? '']));
    this.#accounts = list;
    if (!changed) return;
    // 사용량 화면의 계정 그림(#889)도 새 계정 목록을 따른다(다음 사용량 읽기를 기다리지 않는다)
    const usage = this.#state.usage;
    if (usage) {
      const accounts = usage.accounts.map((entry) => {
        const account = list.find((candidate) => candidate.id === entry.id);
        if (!account) return entry;
        const { sprite: _old, ...rest } = entry;
        return account.sprite ? { ...rest, sprite: account.sprite } : rest;
      });
      this.#state = { ...this.#state, usage: { ...usage, accounts } };
    }
    const sprites = { ...(this.#state.sprites ?? {}) };
    for (const id of this.#assignedSprites) delete sprites[id];
    this.#assignedSprites.clear();
    this.#state = { ...this.#state, sprites };
    this.#scheduleRender();
  }

  async #settingsEffect(effect: SettingsEffect): Promise<void> {
    const host = this.#settingsHost;
    if (!host) return;
    const note = (text: string) => this.#patchSettings((settings) => ({ ...settings, note: text }));
    try {
      switch (effect.type) {
        case 'close':
          this.#stopLoginPoll();
          return;
        case 'account-add': {
          const account = await host.client.addAccount({ name: effect.name, backend: effect.backend, configDir: effect.configDir });
          await this.#reloadAccounts(host, account.id);
          note(`${account.name} 계정을 더했습니다. l로 로그인합니다`);
          void this.#checkStatus(host, account.id);
          return;
        }
        case 'account-update': {
          await host.client.updateAccount(effect.id, { ...(effect.name !== undefined ? { name: effect.name } : {}), ...(effect.sprite !== undefined ? { sprite: effect.sprite } : {}) });
          await this.#reloadAccounts(host, effect.id);
          note(effect.name !== undefined ? `이름을 바꿨습니다: ${effect.name}` : effect.sprite ? `그림을 바꿨습니다: ${effect.sprite}` : '그림을 지웠습니다(세션마다 무작위)');
          return;
        }
        case 'account-remove':
          await host.client.removeAccount(effect.id);
          await this.#reloadAccounts(host);
          note('목록에서 뺐습니다(설정 폴더는 그대로입니다)');
          return;
        case 'account-status':
          await this.#checkStatus(host, effect.id);
          return;
        case 'login-start': {
          const started = await host.client.startLogin(effect.id);
          if (!started.spawnable || !started.progress) {
            this.#patchSettings((settings) => (settings.login?.accountId === effect.id ? { ...settings, login: { ...settings.login, state: 'manual', ...(started.command ? { command: started.command } : {}), ...(started.note ? { note: started.note } : {}) } } : settings));
            return;
          }
          this.#applyLogin(host, effect.id, started.progress);
          if (started.progress.state === 'running') this.#startLoginPoll(host, effect.id);
          return;
        }
        case 'login-cancel':
          this.#applyLogin(host, effect.id, await host.client.cancelLogin(effect.id));
          return;
        case 'open-url':
          if (!browsable(effect.url)) {
            note('http·https 주소만 브라우저로 엽니다');
            return;
          }
          host.openUrl(effect.url);
          note('브라우저로 열었습니다');
          return;
        case 'rules-save': {
          const rules = await host.client.saveRules(effect.rules).catch((error: unknown) => {
            const text = `저장하지 못했습니다: ${messageOf(error)}`;
            this.#patchSettings((settings) => ({ ...settings, rulesError: text, note: text }));
            return undefined;
          });
          if (rules) this.#patchSettings((settings) => ({ ...settings, rules, rulesDirty: false, rulesError: undefined, note: '규칙을 저장했습니다' }));
          return;
        }
        case 'rules-reload': {
          const view = await host.client.rules();
          this.#patchSettings((settings) => ({
            ...settings,
            ...(view.rules ? { rules: view.rules } : {}),
            backends: view.allowed,
            defaultBackend: view.defaultBackend,
            rulesDirty: false,
            rulesError: view.error ? `저장한 규칙을 쓰지 못합니다: ${view.error}` : undefined,
            note: '저장한 규칙을 다시 읽었습니다',
          }));
          return;
        }
        case 'preview': {
          const result = await host.client.preview(effect.text).then(previewLine, (error: unknown) => `묻지 못했습니다: ${messageOf(error)}`);
          this.#patchSettings((settings) => (settings.preview?.text === effect.text ? { ...settings, preview: { text: effect.text, result } } : settings));
          return;
        }
        case 'config':
          this.#saveConfig(host, effect.config);
          return;
        case 'sprite-preview': {
          let preview: NonNullable<SettingsState['previewSprite']>;
          try {
            preview = { file: effect.file, sprite: host.readSprite(effect.file) };
          } catch (error) {
            preview = { file: effect.file, error: messageOf(error) };
          }
          this.#patchSettings((settings) => (settings.picker ? { ...settings, previewSprite: preview } : settings));
          return;
        }
      }
    } catch (error) {
      note(messageOf(error));
    }
  }

  /** desk.json에 쓰고, 바로 적용할 수 있는 것(팔레트·앞글쇠)은 바로 적용한다 */
  #saveConfig(host: SettingsHost, patch: DeskConfig): void {
    try {
      host.saveConfig(patch);
    } catch (error) {
      let config: DeskConfig = {};
      try {
        config = host.loadConfig();
      } catch {
        // 읽지도 못하면 기본값으로 보인다
      }
      this.#patchSettings((settings) => ({ ...settings, config, note: `저장하지 못했습니다: ${messageOf(error)}` }));
      return;
    }
    let live = false;
    if (patch.theme) {
      this.#state = { ...this.#state, theme: { name: patch.theme, depth: this.#truecolor ? 'truecolor' : '256' } };
      this.#prevFrame = [];
      live = true;
    }
    if (patch.prefix) {
      this.#state = { ...this.#state, prefixKey: patch.prefix.key, prefixLabel: patch.prefix.label };
      live = true;
    }
    if (patch.notifyDone !== undefined) {
      this.#notifyDone = patch.notifyDone;
      live = true;
    }
    if (patch.notifyInput !== undefined) {
      this.#notifyInput = patch.notifyInput;
      live = true;
    }
    this.#patchSettings((settings) => ({ ...settings, note: live ? '저장했습니다 · 바로 적용' : '저장했습니다 · desk를 다시 열면 적용됩니다' }));
  }

  #applyLogin(host: SettingsHost, id: string, progress: DeskLoginProgress): void {
    this.#patchSettings((settings) => {
      const login = settings.login?.accountId === id
        ? {
            ...settings.login,
            state: progress.state,
            lines: progress.lines,
            ...(progress.url ? { url: progress.url } : {}),
            ...(progress.code ? { code: progress.code } : {}),
            ...(progress.error ? { error: progress.error } : {}),
            ...(progress.status ? { connected: progress.status.connected, ...(progress.status.reason ? { reason: progress.status.reason } : {}) } : {}),
          }
        : settings.login;
      const accounts = progress.status ? settings.accounts.map((account) => (account.id === id ? { ...account, status: progress.status, checking: false } : account)) : settings.accounts;
      return { ...settings, accounts, ...(login ? { login } : {}) };
    });
    if (progress.state !== 'running') {
      this.#stopLoginPoll();
      // 끝났는데 다시 잰 상태가 없으면 한 번 묻는다
      if (!progress.status) void this.#checkStatus(host, id);
    }
  }

  #startLoginPoll(host: SettingsHost, id: string): void {
    this.#stopLoginPoll();
    this.#loginTimer = setInterval(() => {
      if (!this.#state.settings || this.#restored) {
        this.#stopLoginPoll();
        return;
      }
      if (this.#loginPolling) return;
      this.#loginPolling = true;
      host.client
        .loginProgress(id)
        .then((progress) => this.#applyLogin(host, id, progress))
        .catch((error: unknown) => this.#patchSettings((settings) => ({ ...settings, note: `로그인 진행을 묻지 못했습니다: ${messageOf(error)}` })))
        .finally(() => {
          this.#loginPolling = false;
        });
    }, LOGIN_POLL_MS);
  }

  #stopLoginPoll(): void {
    clearInterval(this.#loginTimer);
    this.#loginTimer = undefined;
  }

  /** 세션 멈추기·이어서 작업(#864). 이어서 작업한 세션은 켜진 뒤 칸을 다시 연다(#poll) */
  async #sessionAction(action: 'stop' | 'resume', id: string): Promise<void> {
    const title = this.#state.items.find((entry) => entry.id === id)?.title ?? id;
    try {
      if (action === 'stop') {
        await this.#client.stop(id);
        this.#say(`세션을 멈췄습니다: ${title} (Ctrl-b r로 이어서 작업합니다)`);
      } else {
        await this.#client.resume(id);
        this.#resuming.add(id);
        if (this.#visible().includes(id)) this.#notes.set(id, '이어서 작업하는 중');
        this.#say(`이어서 작업을 시작했습니다: ${title} · 켜지면 칸을 다시 엽니다`);
      }
      void this.#poll();
    } catch (error) {
      this.#say(`${action === 'stop' ? '멈추지' : '이어서 작업하지'} 못했습니다: ${messageOf(error)}`);
    }
  }

  async #rename(id: string, label: string): Promise<void> {
    try {
      await this.#client.rename(id, label);
      this.#say(label ? `이름을 바꿨습니다: ${label}` : '이름을 지웠습니다(제목은 마지막 요청입니다)');
      void this.#poll();
    } catch (error) {
      this.#say(`이름을 바꾸지 못했습니다: ${messageOf(error)}`);
    }
  }

  /**
   * 목록이 바뀐 것을 알린다(#864): 사람이 손댈 상태(권한·답·승인), 게이트 판정, 작업이 끝남.
   * 사이드바에 표시를 붙이고(본 뒤 지운다) 아래 줄에 알린다. 알림을 켰으면 벨을 울리고, 보고 있는 칸이 아닌 세션은 OS 알림(OSC 9)도 낸다
   */
  #announce(items: readonly DeskItem[]): void {
    const notices: Array<{ id: string; text: string; kind: 'input' | 'gate' | 'done' }> = [];
    for (const item of items) {
      const now = statusOf(item);
      const before = this.#last.get(item.id);
      this.#last.set(item.id, now);
      if (!before) continue;
      const what = changeOf(before, now);
      if (what) notices.push({ id: item.id, text: `${backendLabel(item.backend)} · ${item.title} · ${what}`, kind: WAITING.includes(what) ? 'input' : what === '끝남' ? 'done' : 'gate' });
    }
    if (notices.length === 0) return;
    // 지금 보고 있는 칸의 세션은 표시도 소리도 내지 않는다(#922). 아래 줄 알림은 낸다
    const away = notices.filter((notice) => !this.#seeing(notice.id));
    const flagged = new Set(this.#state.flagged ?? []);
    const unseenDone = new Set(this.#state.unseenDone ?? []);
    for (const notice of away) {
      flagged.add(notice.id);
      if (notice.kind === 'done') unseenDone.add(notice.id);
    }
    this.#state = { ...this.#state, flagged: [...flagged], unseenDone: [...unseenDone], message: `알림: ${notices.map((notice) => notice.text).join(' / ')}` };
    if (away.length) this.#saveLayout();
    if (!this.#notify) return;
    const loud = away.filter((notice) => (notice.kind === 'done' ? this.#notifyDone : notice.kind === 'input' ? this.#notifyInput : true));
    if (loud.length === 0) return;
    let out = '\x07';
    for (const notice of loud.slice(0, MAX_OS_NOTICES)) out += `\x1b]9;${oscText(`b-studio: ${notice.text}`)}\x07`;
    this.#io.write(out);
  }

  /**
   * 마우스(#874). 사이드바를 누르면 그 세션을 고르고(고른 세션을 한 번 더 누르면 연다), 칸을 누르면 그 칸을 고른다.
   * 휠은 그 칸의 복사 모드로 지난 출력을 올려 본다. 안쪽 CLI가 마우스를 켰으면 고른 칸 안의 마우스는 칸 좌표로 바꿔 CLI에 넘긴다
   */
  #mouse(event: Extract<Effect, { type: 'mouse' }>): void {
    if (!this.#mouseOn) return;
    const { button, x, y, release } = event;
    const wheel = (button & 64) !== 0 ? ((button & 1) === 0 ? -1 : 1) : 0;
    const press = !release && (button & 32) === 0;
    const size = this.#size();
    const side = sidebarView(this.#state, size);
    if (!this.#state.sidebarHidden && x < side.rect.w && y >= side.rect.y && y < side.rect.y + side.rect.h) {
      if (!press) return;
      const sessions = deskSessions(this.#state.items);
      if (wheel) {
        this.#state = { ...this.#state, selected: Math.max(0, Math.min(sessions.length - 1, this.#state.selected + wheel)) };
      } else {
        const row = side.rows[side.offset + (y - side.rect.y)];
        if (row?.action === 'folder') {
          // "+ 폴더 열기" 줄(#916): Ctrl-b a와 같다
          this.#take(handleInput({ ...this.#state, prefix: true }, 'a'));
          return;
        }
        const space = row?.space === undefined ? undefined : deskSpaces(this.#state.items).find((entry) => entry.name === row.space);
        if (space) {
          // 스페이스를 누르면 그 스페이스 화면(카드)을 연다
          this.#state = { ...this.#state, selected: space.sessions.includes(this.#state.selected) ? this.#state.selected : space.sessions[0]!, view: 'space' };
          this.#clearSeen();
          this.#scheduleRender();
          return;
        }
        if (row?.item === undefined) return;
        if (row.item === this.#state.selected) {
          // 고른 세션을 한 번 더 누르면 Ctrl-b Enter와 같다
          this.#take(handleInput({ ...this.#state, prefix: true }, '\r'));
          return;
        }
        // 고르기만 한다. 이어서 Enter를 누르면 연다(Ctrl-b ↑↓로 고를 때와 같다)
        this.#state = { ...this.#state, selected: row.item, prefix: true, browsing: true, message: BROWSING };
      }
      this.#clearSeen();
      this.#scheduleRender();
      return;
    }
    if (this.#state.view === 'usage') {
      if (!press) return;
      const count = this.#state.usage?.accounts.length ?? 0;
      const current = this.#state.usageSelected ?? 0;
      if (wheel) this.#state = { ...this.#state, usageSelected: Math.max(0, Math.min(count - 1, current + wheel)) };
      else {
        const card = usageScreen(this.#state, spaceRect(this.#state, size)).cards.find(({ rect }) => x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h);
        if (!card) return;
        this.#state = { ...this.#state, usageSelected: card.index };
      }
      this.#scheduleRender();
      return;
    }
    if (this.#state.view === 'space') {
      if (!press) return;
      const sessions = deskSessions(this.#state.items);
      if (wheel) this.#state = { ...this.#state, selected: Math.max(0, Math.min(sessions.length - 1, this.#state.selected + wheel)) };
      else {
        const card = spaceScreen(this.#state, spaceRect(this.#state, size)).cards.find(({ rect }) => x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h);
        if (!card) return;
        // 고른 카드를 한 번 더 누르면 고른 칸에 연다(Enter와 같다)
        if (card.index === this.#state.selected) {
          this.#take(handleInput({ ...this.#state, prefix: true }, '\r'));
          return;
        }
        this.#state = { ...this.#state, selected: card.index };
      }
      this.#clearSeen();
      this.#scheduleRender();
      return;
    }
    const placed = placePanes(size.cols, size.rows, this.#state).panes.find(({ rect }) => x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h);
    if (!placed) return;
    const { slot, rect } = placed;
    const id = this.#state.slots[slot];
    const pane = id ? this.#panes.get(id) : undefined;
    const modes = pane?.modes();
    if (id && pane && modes?.mouse && !pane.inCopy && slot === this.#state.focus && y > rect.y) {
      // 칸 몸의 첫 줄은 칸 머리 다음 줄이다. 좌표는 1부터
      const column = x - rect.x + 1;
      const line = y - rect.y;
      const data = modes.sgrMouse ? `\x1b[<${button};${column};${line}${release ? 'm' : 'M'}` : x10Mouse(release ? 3 : button, column, line);
      if (data) this.#send(id, data);
      return;
    }
    if (!press) return;
    if (slot !== this.#state.focus) {
      // 다른 칸을 고르면 앞 칸의 복사 모드는 닫는다(복사 모드는 고른 칸의 것이다)
      if (this.#state.copy) this.#endCopy();
      this.#state = { ...this.#state, focus: slot };
    }
    if (wheel && id && pane) this.#wheel(id, pane, wheel);
    this.#clearSeen();
    this.#scheduleRender();
  }

  /** 휠로 지난 출력을 본다: 위로 굴리면 복사 모드로 들어가 올라가고, 맨 아래까지 내리면 나온다 */
  #wheel(id: string, pane: PaneTerminal, direction: 1 | -1): void {
    if (!pane.inCopy) {
      if (direction > 0) return;
      this.#copy(id, 'enter');
      this.#state = { ...this.#state, copy: {}, prefix: false, browsing: false };
    }
    pane.copyMove(direction * WHEEL_LINES);
    const status = pane.copyStatus();
    if (direction > 0 && status.line >= status.total) this.#endCopy();
    this.#prevFrame = [];
  }

  #endCopy(): void {
    const id = this.#focused();
    if (id) this.#panes.get(id)?.exitCopy();
    this.#state = { ...this.#state, copy: undefined };
    this.#prevFrame = [];
  }

  /** 복사 모드 조작. 보는 자리와 고른 범위는 칸 해석기가 든다 */
  #copy(id: string, action: Extract<Effect, { type: 'copy' }>['action'], text?: string): void {
    const pane = this.#panes.get(id);
    if (!pane) {
      this.#state = { ...this.#state, copy: undefined, message: '이 칸은 아직 출력을 받지 않았습니다' };
      return;
    }
    switch (action) {
      case 'enter':
        pane.enterCopy();
        break;
      case 'up':
        pane.copyMove(-1);
        break;
      case 'down':
        pane.copyMove(1);
        break;
      case 'pageUp':
        pane.copyPage(-1);
        break;
      case 'pageDown':
        pane.copyPage(1);
        break;
      case 'top':
        pane.copyTop();
        break;
      case 'bottom':
        pane.copyBottom();
        break;
      case 'mark':
        pane.copyMark();
        break;
      case 'search':
      case 'next':
        if (!pane.copySearch(action === 'search' ? text : undefined)) this.#state = { ...this.#state, message: '위쪽에서 찾지 못했습니다' };
        break;
      case 'yank': {
        const copied = pane.copyYank();
        pane.exitCopy();
        // 밖 터미널의 클립보드에 넣는다(OSC 52). 받지 않는 터미널도 있어 안내에 적는다
        this.#io.write(`\x1b]52;c;${Buffer.from(copied).toString('base64')}\x07`);
        const count = copied ? copied.split('\n').length : 0;
        this.#state = { ...this.#state, message: `${count}줄을 클립보드로 보냈습니다(터미널이 OSC 52를 받아야 붙여 넣을 수 있습니다)` };
        break;
      }
      case 'exit':
        pane.exitCopy();
        break;
    }
    this.#prevFrame = [];
  }

  #say(message: string): void {
    this.#state = { ...this.#state, message };
    this.#scheduleRender();
  }

  /** 지금 칸에 보이는 세션 */
  /**
   * 고른 칸에 그냥 셸을 연다(#873). desk가 직접 띄우는 로그인 셸이라 스튜디오와 관문을 거치지 않는다.
   * 칸 해석기·복사 모드·마우스·붙여넣기는 세션 칸과 같다
   */
  async #openShell(slot: number): Promise<void> {
    const id = `${SHELL_ID}${++this.#shellSeq}`;
    const dir = this.#shellCwd;
    const entry: { pty?: ShellPty; ended: boolean; dir: string } = { ended: false, dir };
    this.#shells.set(id, entry);
    const slots = [...this.#state.slots];
    slots[slot] = id;
    this.#state = { ...this.#state, slots, message: '그냥 셸을 열었습니다. 이 칸은 검증 밖이고, desk를 나가거나 칸을 비우면 끝납니다' };
    // 해석기를 먼저 만들어 칸 크기를 안다. 앞서 칸에 있던 셸은 여기서 끝난다
    this.#slotsChanged();
    this.#saveLayout();
    const size = this.#ensurePanes().find((entry) => entry.id === id)?.size ?? { cols: 80, rows: 24 };
    const env = shellEnvOf(this.#shellEnv);
    const file = env.SHELL || '/bin/sh';
    try {
      const pty = await this.#spawnShell(file, ['-l'], { name: 'xterm-256color', cols: size.cols, rows: size.rows, cwd: dir, env });
      if (!this.#shells.has(id) || this.#restored) {
        // 띄우는 동안 칸을 비웠거나 desk를 나갔다
        pty.kill();
        return;
      }
      entry.pty = pty;
      this.#sizes.set(id, `${size.cols}x${size.rows}`);
      pty.onData((data) => {
        const pane = this.#panes.get(id);
        if (pane) void pane.write(data).then(() => this.#scheduleRender());
      });
      pty.onExit(({ exitCode }) => {
        entry.ended = true;
        this.#notes.set(id, `셸이 끝났습니다(${exitCode}) · Ctrl-b x로 칸을 비웁니다`);
        this.#scheduleRender();
      });
    } catch (error) {
      entry.ended = true;
      this.#notes.set(id, `셸을 띄우지 못했습니다: ${messageOf(error)}`);
    }
    this.#scheduleRender();
  }

  /** 셸 칸 비우기: 끝난 셸은 바로 비우고, 살아 있는 셸은 한 번 묻는다(셸에서 돌던 빌드·서버도 끝난다) */
  #closeShell(slot: number, id: string, confirmed: boolean): void {
    const shell = this.#shells.get(id);
    if (shell && !shell.ended && !confirmed) {
      this.#state = { ...this.#state, confirm: { action: 'close', id, title: '셸' } };
      return;
    }
    if (this.#state.slots[slot] !== id) return;
    const slots = [...this.#state.slots];
    slots[slot] = undefined;
    this.#state = { ...this.#state, slots, message: '셸을 끝내고 칸을 비웠습니다' };
    this.#slotsChanged();
    this.#saveLayout();
  }

  #visible(): string[] {
    return this.#state.slots.slice(0, this.#state.layout).filter((id): id is string => Boolean(id));
  }

  /** 칸 구성이 바뀌었다: 새 칸의 통로를 먼저 열고(늦게 붙은 칸이 출력을 놓치지 않게) 칸 크기에 맞춰 터미널을 연다 */
  #slotsChanged(): void {
    const visible = new Set(this.#visible());
    // 칸에서 빠진 세션의 해석기는 버린다(다시 열면 스튜디오가 최근 출력을 다시 보낸다). 세션과 CLI는 계속 돈다
    // 셸 칸은 칸 자리에서 사라졌을 때만 끝낸다(x로 비웠을 때). 칸 수를 줄이거나 크게 보기로 가린 셸은 계속 돌고 해석기도 출력을 받는다
    const held = new Set(this.#state.slots.filter((id): id is string => isShellId(id)));
    for (const [id, shell] of this.#shells) {
      if (held.has(id)) continue;
      if (!shell.ended) shell.pty?.kill();
      this.#shells.delete(id);
    }
    for (const [id, pane] of this.#panes) {
      if (visible.has(id) || held.has(id)) continue;
      pane.dispose();
      this.#panes.delete(id);
      this.#sizes.delete(id);
      this.#notes.delete(id);
      this.#closed.delete(id);
    }
    this.#prevFrame = [];
    // 해석기를 먼저 만들어 둔다: 통로가 열리자마자 오는 최근 출력을 받을 자리가 있어야 한다
    this.#ensurePanes();
    this.#syncStreams();
    this.#syncPanes();
  }

  /**
   * 칸에 있는 세션마다 해석기를 만들고, 화면에 놓인 칸은 그 크기에 맞춘다(스튜디오에는 알리지 않는다).
   * 크게 보기로 가려진 칸은 크기를 그대로 둔다. 그 세션은 통로로 계속 받고, 크게 보기를 풀면 원래 자리로 돌아온다
   */
  #ensurePanes(): Array<{ id: string; size: { cols: number; rows: number } }> {
    const { cols, rows } = this.#size();
    const shown = placePanes(cols, rows, this.#state).panes;
    const base = placePanes(cols, rows, { ...this.#state, zoom: false }).panes;
    const placed: Array<{ id: string; size: { cols: number; rows: number } }> = [];
    this.#state.slots.forEach((id, slot) => {
      if (!id || slot >= this.#state.layout) return;
      const rect = shown.find((entry) => entry.slot === slot)?.rect;
      let pane = this.#panes.get(id);
      if (!pane) {
        const first = terminalSize(rect ?? base.find((entry) => entry.slot === slot)!.rect);
        pane = new PaneTerminal(first.cols, first.rows, { truecolor: this.#truecolor });
        const sessionId = id;
        pane.onResponse((data) => {
          if (Date.now() < (this.#quietUntil.get(sessionId) ?? 0)) return;
          if (isShellId(sessionId)) this.#send(sessionId, data);
          else this.#client.input(sessionId, data).catch(() => {});
        });
        // 칸 안 CLI의 벨은 칸 머리에 보이고 밖 터미널 벨로 잇는다. 다시 받는 옛 출력의 벨은 울리지 않는다
        pane.onBell(() => {
          if (Date.now() < (this.#quietUntil.get(sessionId) ?? 0)) return;
          // 보고 있는 칸의 벨은 밖으로 잇지 않는다(#922)
          if (this.#seeing(sessionId)) return;
          if (sessionId !== this.#focused()) this.#bells.add(sessionId);
          if (this.#notify) this.#io.write('\x07');
          this.#scheduleRender();
        });
        this.#panes.set(id, pane);
      }
      if (!rect) return;
      const size = terminalSize(rect);
      pane.resize(size.cols, size.rows);
      placed.push({ id, size });
    });
    return placed;
  }

  /** 해석기를 맞추고, 크기가 바뀐 칸만 스튜디오에 알린다(처음은 열기, 그다음은 크기) */
  #syncPanes(): void {
    clearTimeout(this.#resizeTimer);
    for (const { id, size } of this.#ensurePanes()) {
      if (isShellId(id)) {
        const key = `${size.cols}x${size.rows}`;
        const shell = this.#shells.get(id);
        if (!shell?.pty || shell.ended || this.#sizes.get(id) === key) continue;
        this.#sizes.set(id, key);
        shell.pty.resize(size.cols, size.rows);
        continue;
      }
      // 끝난 터미널은 창 크기를 바꿨다고 다시 띄우지 않는다(CLI가 새로 뜬다). 사람이 다시 고르면 연다
      if (this.#closed.has(id)) continue;
      const key = `${size.cols}x${size.rows}`;
      const previous = this.#sizes.get(id);
      if (previous === key) continue;
      this.#sizes.set(id, key);
      // 처음은 열기(이미 열린 터미널이면 스튜디오가 크기만 맞춘다), 그다음부터는 크기만 알린다
      const opening = previous === undefined;
      const request = opening ? this.#client.open(id, size.cols, size.rows) : this.#client.resize(id, size.cols, size.rows);
      if (opening) {
        const settled = request.then(
          () => true,
          () => false,
        );
        this.#opening.set(id, settled);
        void settled.then(() => {
          if (this.#opening.get(id) === settled) this.#opening.delete(id);
        });
      }
      request.catch((error: unknown) => {
        // 멈춘 세션이면 스튜디오가 409로 답한다. 이어서 작업하면 켜진 뒤 칸을 다시 연다
        const stopped = error instanceof StudioRequestError && error.status === 409 && this.#state.items.find((entry) => entry.id === id)?.state === 'stopped';
        this.#notes.set(id, stopped ? '멈춘 세션입니다 · Ctrl-b r로 이어서 작업합니다' : `${messageOf(error)} · Ctrl-b Enter로 다시 엽니다`);
        if (opening) this.#markClosed(id);
        this.#scheduleRender();
      });
    }
  }

  /** 터미널이 없다: 다음에 열 때는 열기를 보낸다(크기만 보내면 스튜디오가 조용히 무시한다) */
  #markClosed(id: string): void {
    this.#closed.add(id);
    this.#sizes.delete(id);
  }

  /** 칸에 있는 세션마다 통로 하나. 칸에서 빠진 세션의 통로만 닫고, 새로 들어온 세션의 통로만 연다 */
  #syncStreams(): void {
    const visible = new Set(this.#visible());
    for (const [id, entry] of this.#streams) {
      if (visible.has(id)) continue;
      entry.controller.abort();
      clearTimeout(entry.timer);
      this.#streams.delete(id);
      this.#quietUntil.delete(id);
    }
    for (const id of visible) if (!isShellId(id) && !this.#streams.has(id)) this.#openStream(id);
  }

  #openStream(id: string): void {
    // 통로를 새로 열면 스튜디오가 이 세션의 최근 출력부터 다시 보낸다. 앞 내용을 지우고 그것으로 다시 그린다
    this.#panes.get(id)?.restart();
    this.#quietUntil.set(id, Date.now() + REPLAY_QUIET_MS);
    const controller = new AbortController();
    const entry: { controller: AbortController; timer?: NodeJS.Timeout } = { controller };
    this.#streams.set(id, entry);
    this.#client
      .stream([id], (sessionId, message) => this.#onTerminal(sessionId, message), controller.signal)
      .then(() => {
        if (!controller.signal.aborted) throw new Error('스튜디오가 터미널 통로를 닫았습니다');
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted || this.#restored || this.#streams.get(id) !== entry) return;
        this.#say(`터미널 통로가 끊겼습니다: ${messageOf(error)} — 다시 붙는 중`);
        entry.timer = setTimeout(() => {
          if (this.#streams.get(id) !== entry) return;
          this.#streams.delete(id);
          if (!this.#visible().includes(id)) return;
          this.#openStream(id);
          // 스튜디오를 다시 띄웠으면 터미널이 없다. 이 칸을 다시 연다(열려 있으면 스튜디오가 크기만 맞춘다)
          if (!this.#closed.has(id)) this.#sizes.delete(id);
          this.#syncPanes();
        }, RECONNECT_MS);
      });
  }

  #onTerminal(id: string, message: DeskTerminalMessage): void {
    const pane = this.#panes.get(id);
    switch (message.kind) {
      case 'data':
        if (pane) void pane.write(Buffer.from(message.data, 'base64')).then(() => this.#scheduleRender());
        return;
      case 'status':
        if (message.state === 'open') {
          this.#notes.delete(id);
          this.#closed.delete(id);
        } else if (message.state === 'opening') this.#notes.set(id, '여는 중');
        else {
          this.#notes.set(id, `${message.message ?? '터미널이 닫혔습니다'} · Ctrl-b Enter로 다시 엽니다`);
          this.#markClosed(id);
        }
        break;
      case 'exit':
        this.#notes.set(id, `터미널이 끝났습니다${message.code === null ? '' : `(${message.code})`} · Ctrl-b Enter로 다시 엽니다`);
        this.#markClosed(id);
        break;
      case 'warning':
        this.#state = { ...this.#state, message: `⚠ ${message.message}` };
        break;
      case 'cli':
        break;
    }
    this.#scheduleRender();
  }

  /**
   * 사용량을 받는다(#889). force가 아니면 받은 지 1분이 안 됐을 때 묻지 않는다(사용량 화면을 여닫을 때마다 묻지 않게).
   * 받으면 세션 카드의 막대(state.limits)도 새로 잇는다. 읽지 못하면 받았던 값은 두고 까닭만 남긴다
   */
  async #fetchUsage(options: { refresh: boolean; force: boolean }): Promise<void> {
    const limits = this.#client.limits;
    if (!limits) {
      if (!this.#state.usage) this.#state = { ...this.#state, usage: { accounts: [], unsupported: true } };
      this.#scheduleRender();
      return;
    }
    const received = this.#state.usage?.receivedAt;
    if (!options.force && received !== undefined && Date.now() - received < USAGE_POLL_MS) return;
    if (this.#usageFetching) return;
    this.#usageFetching = true;
    const asked = options.refresh ? this.#state.message : undefined;
    try {
      // 쓴 양(#925)은 함께 묻되, 읽지 못해도(옛 스튜디오) 한도는 그대로 보인다
      const spendCall = this.#client.spend;
      const [read, spend] = await Promise.all([limits.call(this.#client, options.refresh), spendCall ? spendCall.call(this.#client).catch(() => undefined) : undefined]);
      if (this.#restored) return;
      // 가장 빠듯한 계정이 맨 위다(#925). 고른 카드는 차례가 바뀌어도 같은 계정에 둔다
      const accounts = byTightness(read.accounts);
      const warning = read.warning;
      const count = accounts.length;
      const previous = this.#state.usage;
      const selectedId = this.#state.usageSelected !== undefined ? previous?.accounts[this.#state.usageSelected]?.id : undefined;
      const reselected = selectedId !== undefined ? accounts.findIndex((entry) => entry.id === selectedId) : -1;
      const keptSpend = spend ?? previous?.spend;
      this.#state = {
        ...this.#state,
        usage: { accounts, receivedAt: Date.now(), ...(warning ? { warning } : {}), ...(keptSpend ? { spend: keptSpend } : {}) },
        limits: sessionLimits(this.#state.items, accounts),
        ...(this.#state.usageSelected !== undefined ? { usageSelected: reselected >= 0 ? reselected : Math.max(0, Math.min(count - 1, this.#state.usageSelected)) } : {}),
        ...(asked !== undefined && this.#state.message === asked ? { message: '사용량을 다시 읽었습니다(계정마다 최소 간격은 스튜디오가 지킵니다)' } : {}),
      };
    } catch (error) {
      if (this.#restored) return;
      const previous = this.#state.usage;
      this.#state = {
        ...this.#state,
        usage: { accounts: previous?.accounts ?? [], ...(previous?.receivedAt !== undefined ? { receivedAt: previous.receivedAt } : {}), ...(previous?.spend ? { spend: previous.spend } : {}), error: messageOf(error) },
        ...(asked !== undefined && this.#state.message === asked ? { message: undefined } : {}),
      };
    } finally {
      this.#usageFetching = false;
    }
    this.#scheduleRender();
  }

  async #poll(): Promise<void> {
    // 앞 요청이 끝나기 전에는 새로 묻지 않는다(느린 스튜디오에 요청이 쌓이고 늦게 온 옛 목록이 새 목록을 덮지 않게)
    // 목록 통로(#923)가 살아 있으면 묻지 않는다
    if (this.#polling || this.#agentsLive) return;
    this.#polling = true;
    try {
      const received = (await this.#client.agents()).items;
      // 묻는 사이 통로가 붙어 더 새 목록을 받았으면 늦게 온 이 목록으로 덮지 않는다
      if (!this.#agentsLive) this.#applyItems(received);
    } catch (error) {
      this.#say(`세션 목록을 받지 못했습니다: ${messageOf(error)}`);
    } finally {
      this.#polling = false;
    }
  }

  /** 받은 목록을 쓴다(묻기와 목록 통로가 같이 쓴다). 지난번과 같으면 아무것도 하지 않는다 */
  #applyItems(received: DeskItem[]): void {
    // 고르기가 끝나면 같은 목록이라도 급한 순으로 다시 놓아야 하므로 순서를 지키는 중인지도 비교에 넣는다
    const hold = this.#holdOrder();
    const key = `${hold ? 1 : 0}${JSON.stringify(received)}`;
    if (key === this.#itemsKey) return;
    this.#itemsKey = key;
    this.#announce(received);
    // 급한 순으로 놓는다(#922). 사이드바·빠른 전환·카드를 고르는 동안은 앞 순서를 지킨다. 고르던 세션은 그대로 고른다
    const items = hold ? keepOrder(this.#state.items, received) : byUrgency(received, new Set(this.#state.unseenDone ?? []));
    const usage = this.#state.usage;
    this.#state = { ...this.#state, items, selected: reselect(this.#state.items, this.#state.selected, items), ...(usage?.accounts.length ? { limits: sessionLimits(items, usage.accounts) } : {}) };
    this.#reopenResumed(items);
    this.#clearSeen();
    this.#scheduleRender();
  }

  /**
   * 목록 통로(#923)를 연다. 목록이 오는 동안은 묻기를 쉬고, 끊기면 묻기로 돌아가 RECONNECT_MS 뒤 다시 연다.
   * 옛 스튜디오(404)면 다시 열지 않는다. 손님에 통로가 없으면 아무것도 하지 않는다
   */
  #openAgentsStream(): void {
    const open = this.#client.agentsStream;
    if (!open || this.#restored) return;
    const controller = new AbortController();
    this.#agentsAbort = controller;
    const reconnect = (): void => {
      this.#agentsLive = false;
      if (this.#restored || controller.signal.aborted) return;
      this.#agentsRetry = setTimeout(() => this.#openAgentsStream(), RECONNECT_MS);
    };
    open
      .call(
        this.#client,
        (overview) => {
          if (controller.signal.aborted) return;
          this.#agentsLive = true;
          this.#applyItems(overview.items);
        },
        controller.signal,
      )
      .then(reconnect, (error: unknown) => {
        this.#agentsLive = false;
        if (error instanceof StudioRequestError && error.status === 404) return;
        reconnect();
      });
  }

  /** 사람이 목록을 고르는 중이다: 사이드바 고르기, 빠른 전환, 카드 화면에서 방금 키를 누름 */
  #holdOrder(): boolean {
    const state = this.#state;
    return state.browsing === true || state.switcher !== undefined || (state.view === 'space' && Date.now() - this.#lastKeyAt < HOLD_ORDER_MS);
  }

  /** 이어서 작업한 세션이 켜졌으면 칸을 다시 연다. 켜지 못했으면 그만 기다린다 */
  #reopenResumed(items: readonly DeskItem[]): void {
    for (const id of [...this.#resuming]) {
      const item = items.find((entry) => entry.id === id);
      if (item && NOT_READY.includes(item.state)) continue;
      this.#resuming.delete(id);
      if (!item || !this.#visible().includes(id)) continue;
      if (item.state === 'error') {
        this.#notes.set(id, '이어서 작업하지 못했습니다 · 웹 화면에서 까닭을 보세요');
        continue;
      }
      this.#notes.delete(id);
      this.#closed.delete(id);
      this.#sizes.delete(id);
      this.#syncPanes();
    }
  }

  /** 새 요청을 연다. projectId를 주면 그 프로젝트를 골라 요청 쓰기로 바로 간다(폴더를 등록한 뒤, #916) */
  async #openPrompt(projectId?: string, note?: string): Promise<void> {
    try {
      const [projects, rules, accounts] = await Promise.all([
        this.#client.projects(),
        this.#client.rules().catch(() => ({ allowed: [] as string[] })),
        // 계정 목록(#885)을 받지 못하면(옛 스튜디오, 개인 PC 모드 아님) 지금처럼 CLI만 고른다
        this.#client.accounts().catch((): DeskAccount[] => []),
      ]);
      const usable = projects.filter((project) => !project.error).map((project) => ({ id: project.id, name: project.name }));
      if (usable.length === 0) {
        // 처음 쓰는 사람: 내 폴더를 프로젝트로 등록하는 화면을 바로 연다(#916)
        const effects: Effect[] = [];
        this.#state = { ...openFolderScreen(this.#state, effects, 'prompt'), message: '열 수 있는 프로젝트가 없습니다. 내 폴더를 프로젝트로 등록합니다' };
        for (const effect of effects) this.#apply(effect);
        this.#scheduleRender();
        return;
      }
      const picked = projectId ? usable.findIndex((project) => project.id === projectId) : -1;
      this.#state = {
        ...this.#state,
        message: note,
        prompt: {
          step: usable.length === 1 || picked >= 0 ? 'request' : 'project',
          projects: usable,
          projectIndex: Math.max(0, picked),
          text: '',
          // 터미널로 띄울 수 없는 AI는 고를 수 없다(스튜디오가 거절한다)
          ...promptChoices(rules.allowed.filter((backend) => TERMINAL_BACKENDS.includes(backend)), accounts),
          choice: 0,
        },
      };
      this.#scheduleRender();
    } catch (error) {
      this.#say(`새 요청을 열지 못했습니다: ${messageOf(error)}`);
    }
  }

  #schedulePreview(text: string): void {
    clearTimeout(this.#previewTimer);
    if (!text.trim()) {
      if (this.#state.prompt) this.#state = { ...this.#state, prompt: { ...this.#state.prompt, preview: undefined } };
      return;
    }
    this.#previewTimer = setTimeout(() => {
      this.#client
        .preview(text)
        .then((preview) => {
          const prompt = this.#state.prompt;
          if (!prompt || prompt.text !== text) return;
          this.#state = { ...this.#state, prompt: { ...prompt, preview: previewLine(preview) } };
          this.#scheduleRender();
        })
        .catch(() => {});
    }, PREVIEW_DELAY_MS);
  }

  async #submit(projectId: string, request: string, choice: string, allowCheckChanges = false): Promise<void> {
    try {
      const result = await this.#client.start({ projectId, request, choice, ...(allowCheckChanges ? { allowCheckChanges: true } : {}) });
      const slots = [...this.#state.slots];
      // 고른 칸에 셸이 돌고 있으면 덮지 않는다(셸은 x와 나가기로만 끝낸다). 세션은 사이드바에서 연다
      const shellTaken = isShellId(slots[this.#state.focus]);
      if (!shellTaken) slots[this.#state.focus] = result.session.id;
      const target = this.#state.prompt?.labels?.[choice] ?? backendLabel(result.routing?.backend ?? (choice === 'rules' ? undefined : splitChoice(choice).backend));
      const message = result.sendError
        ? `${target} 세션을 만들었지만 요청을 보내지 못했습니다: ${result.sendError}`
        : result.terminal?.pasteError
        ? `세션을 열었지만 첫 요청을 넣지 못했습니다: ${result.terminal.pasteError} — 칸에서 직접 치세요`
        : result.terminal
          ? `${target}로 보냈습니다`
          : `${target} 세션을 만들었습니다(이 스튜디오는 아직 터미널로 첫 요청을 넣지 않습니다)`;
      this.#state = { ...this.#state, prompt: undefined, slots, message: shellTaken ? `${message} · 고른 칸에 셸이 있어 칸에는 열지 않았습니다(사이드바에서 Ctrl-b Enter로 엽니다)` : message };
      this.#slotsChanged();
      this.#saveLayout();
      void this.#poll();
    } catch (error) {
      const prompt = this.#state.prompt;
      if (prompt) this.#state = { ...this.#state, prompt: { ...prompt, sending: false, preview: `보내지 못했습니다: ${messageOf(error)}` } };
    }
    this.#scheduleRender();
  }

  #scheduleRender(): void {
    if (this.#frameTimer || this.#restored) return;
    this.#frameTimer = setTimeout(() => {
      this.#frameTimer = undefined;
      this.#render();
    }, FRAME_MS);
  }

  /**
   * 스페이스 화면에 보일 세션에 카드 그림을 단다(처음 보일 때 한 번). 계정에 고른 그림(#890)이 먼저이고,
   * 그다음 AI 이름이나 default로 이름 붙인 그림, 그다음 그림 폴더(세션 id 이름의 그림, 무작위)다
   */
  #ensureSprites(): void {
    if (this.#state.view === 'usage' && !this.#state.fleets) {
      this.#ensureAccountSprites();
      return;
    }
    const shown = this.#spriteItems();
    if (!this.#catalog || shown.length === 0) return;
    const sprites = this.#state.sprites ?? {};
    let added: Record<string, Sprite> | undefined;
    for (const item of shown) {
      if (sprites[item.id] || added?.[item.id]) continue;
      const file = this.#accountSprite(item);
      if (file && this.#catalog.file) {
        const { sprite, warning } = this.#catalog.file(file);
        this.#warnSprite(warning);
        if (sprite) {
          added = { ...added, [item.id]: sprite };
          this.#assignedSprites.add(item.id);
          continue;
        }
      }
      if ((item.backend && sprites[item.backend]) || sprites.default) continue;
      const { sprite, warning } = this.#catalog.pick(item.id);
      this.#warnSprite(warning);
      added = { ...added, [item.id]: sprite ?? defaultSprite(item.backend) };
      this.#assignedSprites.add(item.id);
    }
    if (added) this.#state = { ...this.#state, sprites: { ...sprites, ...added } };
  }

  /** 그림을 그릴 세션: 여러 AI 비교 보기면 그 참가자들(#892), 스페이스 화면이면 그 스페이스의 세션들 */
  #spriteItems(): DeskItem[] {
    const fleets = this.#state.fleets;
    if (fleets) {
      const fleet = fleets.mode === 'detail' ? fleets.fleets.find((entry) => entry.id === fleets.detail) : undefined;
      return (fleet?.members ?? []).map((member) => ({ kind: 'session', id: member.sessionId, title: member.label, projectName: fleet!.projectName, state: 'idle', backend: member.backend, lastActivityAt: fleet!.createdAt, ...(member.accountId ? { accountId: member.accountId } : {}) }));
    }
    return this.#state.view === 'space' ? spaceItems(this.#state) : [];
  }

  /** 세션의 계정에 고른 그림. 계정이 없는 세션은 그 CLI의 기본 계정(id가 CLI 이름)이다 */
  #accountSprite(item: DeskItem): string | undefined {
    const id = item.accountId ?? item.backend;
    return id ? this.#accounts.find((account) => account.id === id)?.sprite : undefined;
  }

  #warnSprite(warning: string | undefined): void {
    if (!warning || this.#spriteWarned.has(warning)) return;
    this.#spriteWarned.add(warning);
    this.#say(warning);
  }

  /** 사용량 화면의 계정 그림(#889): 계정에 적은 그림 파일, 없으면 계정 id로 그림 폴더에서 고른다. 처음 보일 때 한 번 */
  #ensureAccountSprites(): void {
    const sprites = this.#state.sprites ?? {};
    let added: Record<string, Sprite> | undefined;
    for (const account of this.#state.usage?.accounts ?? []) {
      const key = usageSpriteKey(account.id);
      if (sprites[key] || added?.[key]) continue;
      const found = !this.#catalog ? {} : account.sprite && this.#catalog.file ? this.#catalog.file(account.sprite) : this.#catalog.pick(account.id);
      this.#warnSprite(found.warning);
      added = { ...added, [key]: found.sprite ?? sprites[account.backend] ?? sprites.default ?? defaultSprite(account.backend) };
      // 설정 화면에서 계정 그림을 바꾸면 지우고 다시 단다
      this.#assignedSprites.add(key);
    }
    if (added) this.#state = { ...this.#state, sprites: { ...sprites, ...added } };
  }

  /** 스페이스 화면에 움짤이 보이고 창이 포커스를 가졌으면 다음 프레임에 다시 그린다. 아니면 멈춘다(시계도 멈춘다) */
  #scheduleAnimation(): void {
    const state = this.#state;
    const playing =
      this.#animate &&
      !this.#restored &&
      this.#windowFocused &&
      (state.view === 'space' || state.view === 'usage' || state.fleets !== undefined) &&
      !state.help &&
      !state.copy &&
      !state.settings &&
      !state.records &&
      !state.detail &&
      !state.runtime;
    const shown = !playing
      ? []
      : state.fleets
        ? this.#spriteItems().map((item) => spriteFor(item, state.sprites))
        : state.view === 'usage'
          ? (state.usage?.accounts ?? []).map((account) => accountSprite(account, state.sprites))
          : spaceItems(state).map((item) => spriteFor(item, state.sprites));
    const delays = shown.flatMap((sprite) => shortestFrame(sprite) ?? []);
    if (delays.length === 0) {
      clearTimeout(this.#animTimer);
      this.#animTimer = undefined;
      return;
    }
    if (this.#animTimer) return;
    this.#animTimer = setTimeout(
      () => {
        this.#animTimer = undefined;
        this.#state = { ...this.#state, spriteClock: Date.now() - this.#animStart };
        this.#render();
      },
      Math.max(MIN_FRAME_MS, Math.min(...delays)),
    );
    this.#animTimer.unref?.();
  }

  #render(): void {
    if (this.#restored) return;
    this.#ensureSprites();
    const views: PaneView[] = this.#state.slots.map((id) => {
      const pane = id ? this.#panes.get(id) : undefined;
      const note = id ? this.#notes.get(id) : undefined;
      // CLI가 커서를 숨겼으면 desk도 그리지 않는다(제 커서를 그리는 TUI에서 엉뚱한 자리에 보이지 않게). 복사 모드에서도 그리지 않는다
      const cursor = pane && !pane.inCopy && !pane.modes().cursorHidden ? { cursor: pane.cursor() } : {};
      const copy = pane?.inCopy ? pane.copyStatus() : undefined;
      const mode = copy ? { mode: `복사 모드 ${copy.line}/${copy.total}줄` } : {};
      const bell = id && this.#bells.has(id) ? { bell: true } : {};
      const shell = id && isShellId(id) ? this.#shells.get(id) : undefined;
      const title = shell ? { title: `셸 · 검증 밖 · ${basename(shell.dir) || shell.dir}` } : {};
      return { lines: pane ? pane.lines() : [], ...(pane ? { cols: pane.viewCols } : {}), ...cursor, ...mode, ...bell, ...title, ...(note ? { note } : {}) };
    });
    const frame = renderScreen(this.#state, this.#size(), views);
    // 바뀐 줄만 다시 쓴다. 지원하는 터미널에서는 한 장을 한 번에 바꾼다(동기 출력). 처음 보이는 Kitty 그림은 그 자리 글자보다 먼저 보낸다
    let out = '\x1b[?2026h\x1b[?25l' + (this.#state.kitty?.drain() ?? '');
    frame.lines.forEach((line, row) => {
      if (this.#prevFrame[row] !== line) out += `\x1b[${row + 1};1H${line}`;
    });
    this.#prevFrame = frame.lines;
    if (frame.cursor) out += `\x1b[${frame.cursor.y + 1};${frame.cursor.x + 1}H\x1b[?25h`;
    out += '\x1b[?2026l';
    this.#io.write(out);
    this.#scheduleAnimation();
  }

  #stop(code: number): void {
    this.#restore();
    // 다음에 띄울 때 되살릴 배치(바꿀 때마다 저장했지만 고른 칸은 나갈 때 남긴다)
    this.#saveLayout();
    this.#finish(code);
  }

  #restore(): void {
    if (this.#restored) return;
    this.#restored = true;
    clearInterval(this.#pollTimer);
    clearInterval(this.#clockTimer);
    clearTimeout(this.#agentsRetry);
    this.#agentsAbort?.abort();
    clearInterval(this.#usageTimer);
    clearInterval(this.#plansTimer);
    clearTimeout(this.#frameTimer);
    clearTimeout(this.#previewTimer);
    clearTimeout(this.#pendingTimer);
    clearTimeout(this.#resizeTimer);
    clearTimeout(this.#animTimer);
    clearTimeout(this.#fleetTimer);
    this.#stopLoginPoll();
    this.#runtimeStream?.abort();
    for (const entry of this.#streams.values()) {
      entry.controller.abort();
      clearTimeout(entry.timer);
    }
    for (const pane of this.#panes.values()) pane.dispose();
    for (const shell of this.#shells.values()) if (!shell.ended) shell.pty?.kill();
    this.#io.setRaw(false);
    // desk가 보낸 Kitty 그림을 지운 뒤 대체 화면을 나간다
    this.#io.write((this.#state.kitty?.clear() ?? '') + (this.#animate ? FOCUS_OFF : '') + (this.#mouseOn ? MOUSE_OFF : '') + LEAVE_SCREEN);
  }
}

/** 알림을 가리는 상태 이름과 게이트 판정 */
function statusOf(item: DeskItem): { status: string; gate?: string } {
  const gate = gateStatus(item)?.label;
  return { status: agentStatus(item).label, ...(gate ? { gate } : {}) };
}

/** 알릴 만큼 바뀌었으면 그 문구. 손댈 상태가 먼저, 그다음 게이트 판정, 그다음 작업 끝남이다 */
export function changeOf(before: { status: string; gate?: string }, now: { status: string; gate?: string }): string | undefined {
  if (WAITING.includes(now.status) && now.status !== before.status) return now.status;
  if (now.gate && GATE_NOTICE[now.gate] && now.gate !== before.gate) return GATE_NOTICE[now.gate];
  if (before.status === '작업 중' && SETTLED.includes(now.status)) return '끝남';
  return undefined;
}

/** 옛 꼴(X10) 마우스 열. 좌표가 223을 넘으면 이 꼴로는 보낼 수 없다 */
function x10Mouse(button: number, column: number, line: number): string | undefined {
  if (column > 223 || line > 223) return undefined;
  return `\x1b[M${String.fromCharCode(32 + button, 32 + column, 32 + line)}`;
}

/** OSC 알림에 넣을 글: 제어 글자(알림을 일찍 끝내거나 다른 명령이 될 수 있다)를 빼고 줄인다 */
function oscText(text: string): string {
  return [...text.replace(/[\u0000-\u001f\u007f-\u009f]/g, '')].slice(0, 160).join('');
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
