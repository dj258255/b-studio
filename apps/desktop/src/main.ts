import path from 'node:path';
import { BaseWindow, Menu, WebContentsView, app, dialog, ipcMain, session, shell, type MenuItemConstructorOptions } from 'electron';
import { configPath, readConfig, saveWindowBounds, type DesktopConfig } from './config';
import { createSpawnRunner, launchLogDir, launchStudio, stopIfStarted, type CommandRunner, type LaunchResult } from './launch';
import { decideInput, decideUrl } from './url-policy';

/**
 * b-studio 데스크톱 앱 — **웹이 본체, 앱은 껍데기**.
 *
 * 하는 일은 셋뿐이다: ① 저장소에서 스튜디오 서버를 켠다 ② 창(도구 막대 + 스튜디오 화면)을 띄운다
 * ③ 앱을 닫을 때 앱이 켠 서버만 끈다. 화면은 서버가 주는 웹이라 apps/studio에 Electron 전용 코드가 없고,
 * 스튜디오를 고쳐도(git pull) 앱을 다시 만들 필요가 없다(Figma·Slack·VS Code·토스 POS와 같은 구조).
 *
 * 창은 BaseWindow + WebContentsView 두 개다(위: 도구 막대, 아래: 스튜디오). BrowserView는 폐기 예정이라 쓰지 않는다.
 * 스튜디오 화면에는 preload·Node를 주지 않는다(도구 막대만 좁은 preload 통로를 쓴다).
 */

/** 도구 막대 높이(px) */
const TOOLBAR_HEIGHT = 44;
/** 로딩·안내 화면의 글자색 배경. 스튜디오 토큰과 맞춘다 */
const BACKGROUND = '#fbfdfc';
/**
 * 껍데기 화면(HTML·JS)의 위치. 컴파일된 main.js는 dist에 있으므로 `../src`가 원본 폴더다.
 * `app.getAppPath()`는 `electron dist/main.js`처럼 파일을 직접 넘길 때 dist를 가리켜서 쓰지 않는다.
 * 패키징한 앱에서는 electron-builder의 files가 `dist/**`와 `src/*.html`·`src/*.js`를 같은 모양으로 넣는다
 */
const ASSETS = path.join(__dirname, '..', 'src');

interface Studio {
  config: DesktopConfig;
  launched: LaunchResult;
  runner: CommandRunner;
  /** 앱이 이미 서버를 껐는가(종료 경로 중복 방지) */
  stopped: boolean;
}

let studio: Studio | undefined;
let win: BaseWindow | undefined;
let toolbar: WebContentsView | undefined;
let content: WebContentsView | undefined;
let loading: WebContentsView | undefined;
/** 로딩 화면이 준비되기 전의 상태 메시지. did-finish-load 뒤에 한 번에 보낸다 */
let loadingQueue: unknown[] = [];
let loadingReady = false;
let quitting = false;
/** 서버를 켜는 중이면 그 자식 프로세스를 끊기 위한 신호 */
let launching: AbortController | undefined;

app.setName('b-studio');

void app.whenReady().then(async () => {
  installPermissionPolicy();
  installMenu();
  registerIpc();
  await start();
});

// 창을 닫으면 앱을 끝낸다(이 앱의 목적이 그 창 하나다). 서버 정리는 before-quit에서 한다
app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => handleQuit(event));

async function start(): Promise<void> {
  const file = configPath();
  let config: DesktopConfig | undefined;
  let configError: string | undefined;
  try {
    config = readConfig(file);
  } catch (error) {
    configError = describe(error);
  }

  win = new BaseWindow({
    title: 'b-studio',
    width: config?.window?.width ?? 1280,
    height: config?.window?.height ?? 900,
    ...(config?.window?.x === undefined ? {} : { x: config.window.x }),
    ...(config?.window?.y === undefined ? {} : { y: config.window.y }),
    backgroundColor: BACKGROUND,
  });
  win.on('resize', () => layout());
  win.on('close', () => rememberBounds(file));

  // 서버가 뜰 때까지(콜리마 켜기 포함 몇 분) 로딩 화면을 보여 준다
  loading = createView('loading');
  win.contentView.addChildView(loading);
  layout();

  if (!config) {
    loadingSend({
      type: 'failed',
      message: configError ?? `설정 파일이 없습니다: ${file}\n터미널에서 \`pnpm desktop:install\`을 다시 실행하세요.`,
    });
    return;
  }

  const runner = createSpawnRunner(config.node, config.path);
  let launched: LaunchResult;
  const controller = new AbortController();
  launching = controller;
  try {
    launched = await launchStudio(config, runner, { onProgress: (text) => loadingSend({ type: 'progress', text }), signal: controller.signal });
  } catch (error) {
    loadingSend({ type: 'failed', message: describe(error) });
    return;
  } finally {
    launching = undefined;
  }

  studio = { config, launched, runner, stopped: false };
  openStudio();
}

/** 로딩 화면을 걷고 도구 막대 + 스튜디오 화면을 붙인다 */
function openStudio(): void {
  const target = studio;
  if (!win || !target) return;
  toolbar = createView('toolbar');
  content = createStudioView(target.launched.url);
  win.contentView.addChildView(toolbar);
  win.contentView.addChildView(content);
  if (loading) {
    win.contentView.removeChildView(loading);
    loading.webContents.close();
    loading = undefined;
    loadingQueue = [];
  }
  layout();
  toolbar.webContents.on('did-finish-load', () => toolbarUrl(target.launched.url));
  installMenu();
}

/** 창 크기에 맞춰 두 뷰의 자리를 잡는다(막대는 위 고정, 화면은 나머지) */
function layout(): void {
  if (!win) return;
  const { width, height } = win.getContentBounds();
  if (loading) {
    loading.setBounds({ x: 0, y: 0, width, height });
    return;
  }
  toolbar?.setBounds({ x: 0, y: 0, width, height: TOOLBAR_HEIGHT });
  content?.setBounds({ x: 0, y: TOOLBAR_HEIGHT, width, height: Math.max(0, height - TOOLBAR_HEIGHT) });
}

/** 로컬 HTML 화면(도구 막대·로딩). 스튜디오 화면이 아니라 앱의 껍데기라 preload를 준다 */
function createView(name: 'toolbar' | 'loading'): WebContentsView {
  const view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: path.join(__dirname, `${name}-preload.js`),
    },
  });
  view.webContents.on('did-finish-load', () => {
    if (name !== 'loading') return;
    loadingReady = true;
    const queued = loadingQueue;
    loadingQueue = [];
    for (const payload of queued) view.webContents.send('b-studio:launch', payload);
  });
  void view.webContents.loadFile(path.join(ASSETS, `${name}.html`));
  return view;
}

/** 스튜디오 화면. 서버가 준 웹 콘텐츠라 preload·Node를 주지 않는다 */
function createStudioView(url: string): WebContentsView {
  const view = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } });
  applyNavigationPolicy(view);
  void view.webContents.loadURL(url);
  return view;
}

/** 화면 안의 링크 이동·새 창에도 도구 막대와 같은 주소 정책을 쓴다 */
function applyNavigationPolicy(view: WebContentsView): void {
  const { webContents } = view;

  webContents.on('will-navigate', (event, target) => {
    const decision = decideUrl(target);
    if (decision.kind === 'app') return;
    event.preventDefault();
    if (decision.kind === 'external') {
      void shell.openExternal(decision.url);
      toolbarMessage(`기본 브라우저로 열었습니다: ${decision.url}`);
      return;
    }
    toolbarMessage(decision.reason);
  });

  // target="_blank"로 새 창을 열지 않는다. 이 PC 주소면 같은 화면에서, 외부면 기본 브라우저로
  webContents.setWindowOpenHandler(({ url }) => {
    const decision = decideUrl(url);
    if (decision.kind === 'app') void webContents.loadURL(decision.url);
    else if (decision.kind === 'external') void shell.openExternal(decision.url);
    else toolbarMessage(decision.reason);
    return { action: 'deny' };
  });

  const sendUrl = () => toolbarUrl(webContents.getURL());
  webContents.on('did-navigate', sendUrl);
  webContents.on('did-navigate-in-page', sendUrl);
  webContents.on('did-fail-load', (_event, code, description) => {
    // -3(ERR_ABORTED)은 사용자가 이동했거나 정책이 막았을 때도 나온다 — 오류로 알리지 않는다
    if (code === -3) return;
    toolbarMessage(`화면을 열지 못했습니다 (${code}): ${description}`);
  });
}

/** 도구 막대에 지금 주소를 알린다 */
function toolbarUrl(url: string): void {
  toolbar?.webContents.send('b-studio:url', url);
}

/** 도구 막대 아래 한 줄에 안내·이유를 보여 준다 */
function toolbarMessage(text: string): void {
  toolbar?.webContents.send('b-studio:message', text);
}

function loadingSend(payload: unknown): void {
  if (!loading) return;
  if (!loadingReady) {
    loadingQueue.push(payload);
    return;
  }
  loading.webContents.send('b-studio:launch', payload);
}

function registerIpc(): void {
  ipcMain.handle('b-studio:navigate', (_event, text: unknown) => {
    if (typeof text !== 'string') return { ok: false, reason: '주소가 아닙니다' };
    const target = studio;
    if (!target || !content) return { ok: false, reason: '스튜디오 서버가 아직 준비되지 않았습니다' };
    const decision = decideInput(text, target.launched.url);
    if (decision.kind === 'app') {
      void content.webContents.loadURL(decision.url);
      return { ok: true };
    }
    if (decision.kind === 'external') {
      void shell.openExternal(decision.url);
      return { ok: true, external: true };
    }
    return { ok: false, reason: decision.reason };
  });

  ipcMain.handle('b-studio:back', () => {
    const history = content?.webContents.navigationHistory;
    if (history?.canGoBack()) history.goBack();
  });
  ipcMain.handle('b-studio:forward', () => {
    const history = content?.webContents.navigationHistory;
    if (history?.canGoForward()) history.goForward();
  });
  ipcMain.handle('b-studio:reload', () => content?.webContents.reload());
  ipcMain.handle('b-studio:open-external', () => openInBrowser());
  ipcMain.handle('b-studio:open-logs', async () => {
    // 로그 폴더가 없으면 openPath가 조용히 실패한다(아직 한 번도 안 켠 경우)
    await shell.openPath(launchLogDir());
  });
}

/** 앱 안에서 열지 않는 주소는 기본 브라우저로 넘긴다 */
function openInBrowser(): void {
  const url = content?.webContents.getURL() ?? studio?.launched.url;
  if (url) void shell.openExternal(url);
}

function installMenu(): void {
  const isMac = process.platform === 'darwin';
  const canStop = Boolean(studio?.launched.started) && studio?.stopped !== true;
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    {
      label: '편집',
      submenu: [
        // 표준 편집 메뉴가 없으면 복사·붙여넣기·전체 선택 단축키가 화면에서 먹지 않는다
        { role: 'undo', label: '실행 취소' },
        { role: 'redo', label: '다시 실행' },
        { type: 'separator' },
        { role: 'cut', label: '잘라내기' },
        { role: 'copy', label: '복사' },
        { role: 'paste', label: '붙여넣기' },
        { role: 'selectAll', label: '전체 선택' },
      ],
    },
    {
      label: '보기',
      submenu: [
        { label: '새로고침', accelerator: 'CmdOrCtrl+R', click: () => content?.webContents.reload() },
        { label: '확대', accelerator: 'CmdOrCtrl+Plus', click: () => zoom(0.5) },
        { label: '축소', accelerator: 'CmdOrCtrl+-', click: () => zoom(-0.5) },
        { label: '크기 초기화', click: () => content?.webContents.setZoomLevel(0) },
        { type: 'separator' },
        { label: '개발자 도구', accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I', click: () => content?.webContents.toggleDevTools() },
      ],
    },
    {
      label: '스튜디오',
      submenu: [
        { label: '브라우저에서 열기', click: () => openInBrowser() },
        { label: '로그 폴더 열기', click: () => void shell.openPath(launchLogDir()) },
        { type: 'separator' },
        { label: '스튜디오 중지', enabled: canStop, click: () => void stopFromMenu() },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function zoom(delta: number): void {
  const webContents = content?.webContents;
  if (!webContents) return;
  webContents.setZoomLevel(Math.min(5, Math.max(-5, webContents.getZoomLevel() + delta)));
}

async function stopFromMenu(): Promise<void> {
  const target = studio;
  if (!target || target.stopped) return;
  const outcome = await stopIfStarted(target.launched, target.config, target.runner);
  target.stopped = true;
  installMenu();
  const message = outcome.error
    ? `서버를 끄지 못했습니다: ${outcome.error}`
    : outcome.attempted
      ? '스튜디오 서버를 중지했습니다. 앱을 다시 열면 새로 켭니다.'
      : '이 서버는 앱이 켠 것이 아니라 그대로 둡니다.';
  void dialog.showMessageBox({ type: outcome.error ? 'error' : 'info', message, buttons: ['확인'] });
}

/** 카메라·마이크·위치 같은 권한 요청은 거부한다. 알림만 스튜디오가 쓴다 */
function installPermissionPolicy(): void {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => callback(permission === 'notifications'));
  session.defaultSession.setPermissionCheckHandler((_webContents, permission) => permission === 'notifications');
}

function rememberBounds(file: string): void {
  const window = win;
  if (!window) return;
  const bounds = window.getBounds();
  try {
    saveWindowBounds({ width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y }, file);
  } catch (error) {
    console.warn(`[b-studio] 창 크기를 저장하지 못했습니다: ${describe(error)}`);
  }
}

/** 앱이 켠 서버만 끄고 종료한다. 끄지 못해도 앱은 닫고 이유만 로그에 남긴다 */
function handleQuit(event: { preventDefault(): void }): void {
  // 서버를 켜는 중이었다면 자식 프로세스를 끊는다(반쯤 켜진 서버를 남기지 않는다)
  launching?.abort();
  const target = studio;
  if (!target?.launched.started || target.stopped) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  void stopIfStarted(target.launched, target.config, target.runner).then((outcome) => {
    target.stopped = true;
    if (outcome.error) console.warn(`[b-studio] 서버를 끄지 못했습니다: ${outcome.error}`);
    app.quit();
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
