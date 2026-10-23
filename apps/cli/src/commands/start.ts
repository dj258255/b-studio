/**
 * `pnpm studio`(인자 없이): 스튜디오 서버를 브라우저 없이 뒤에서 띄우고(이미 떠 있으면 재사용) 바로 터미널 작업대(desk)를 연다.
 * 서버를 띄우고 기다리는 일은 launch가, 화면은 desk가 한다. 여기서는 둘을 잇고, 기다리는 동안 한 줄 진행 표시를 보인다
 */
import { desk, type DeskOptions } from '../desk/desk';
import { createLaunchDeps, HEALTH_PATH, runLaunch, studioOrigin, type LaunchMode, type LaunchOptions, type ProbeResult } from './launch';

/**
 * 새로 띄우는 서버에 채울 환경. desk의 칸은 세션 터미널이라 실험 기능을 켠 개인 PC 모드가 필요하고,
 * desk가 띄울 수 있는 CLI는 Claude Code(기본 모드)와 Codex다. 사용자가 이미 정한 값은 그대로 둔다
 */
export const STUDIO_SERVER_ENV: Readonly<Record<string, string>> = { B_STUDIO_EXPERIMENTAL: '1', B_STUDIO_BACKENDS: 'codex' };

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const CLEAR_LINE = '\r\x1b[2K';

/** 기다리는 동안의 한 줄. 확인은 1초 간격이라 도는 글자도 초마다 바뀐다 */
export function waitingLine(elapsedMs: number): string {
  const seconds = Math.floor(elapsedMs / 1_000);
  return `${SPINNER[seconds % SPINNER.length]} 스튜디오를 띄우는 중… ${seconds}초`;
}

export interface StudioOptions {
  mode: LaunchMode;
  port: number;
  notify?: boolean;
  mouse?: boolean;
}

export interface StudioDeps {
  launch: (options: LaunchOptions) => Promise<number>;
  probe: (url: string) => Promise<ProbeResult>;
  desk: (options: DeskOptions & { port: number }) => Promise<number>;
  /** 진행 표시를 쓸 곳. 터미널이 아니면(파이프·로그) 쓰지 않는다 */
  progress: { isTTY: boolean; write: (text: string) => void };
}

/** 헬스가 세션 터미널을 끈 서버라고 알리는지. 이 값이 없는 옛 서버는 막지 않는다 */
function terminalOff(health: ProbeResult): boolean {
  try {
    return (JSON.parse(health.body) as { terminal?: unknown } | null)?.terminal === false;
  } catch {
    return false;
  }
}

export async function runStudio(options: StudioOptions, deps: StudioDeps): Promise<number> {
  const spinning = deps.progress.isTTY;
  let drew = false;
  const code = await deps.launch({
    mode: options.mode,
    port: options.port,
    serverEnv: { ...STUDIO_SERVER_ENV },
    onWaiting: (elapsedMs) => {
      if (!spinning) return;
      drew = true;
      deps.progress.write(`${CLEAR_LINE}${waitingLine(elapsedMs)}`);
    },
  });
  if (drew) deps.progress.write(CLEAR_LINE);
  if (code !== 0) return code;

  // 떠 있던 서버를 재사용했으면 세션 터미널이 꺼진 채일 수 있다. 그러면 desk의 칸이 열리지 않으니 먼저 알린다
  if (terminalOff(await deps.probe(`${studioOrigin(options.port)}${HEALTH_PATH}`))) {
    console.error('떠 있는 스튜디오는 세션 터미널을 쓸 수 없게 떠 있습니다(실험 기능이 꺼졌거나 개인 PC 모드가 아님).');
    console.error('pnpm studio stop으로 끈 뒤 pnpm studio를 다시 실행하세요.');
    return 1;
  }

  const deskCode = await deps.desk({
    port: options.port,
    ...(options.notify === undefined ? {} : { notify: options.notify }),
    ...(options.mouse === undefined ? {} : { mouse: options.mouse }),
  });
  console.log('스튜디오는 뒤에서 계속 돕니다. 다시 열기: pnpm studio · 끄기: pnpm studio stop');
  return deskCode;
}

/** CLI 진입점. 실제 launch·desk로 runStudio를 부른다 */
export function studio(options: StudioOptions): Promise<number> {
  const launchDeps = createLaunchDeps();
  return runStudio(options, {
    launch: (launchOptions) => runLaunch(launchOptions, launchDeps),
    probe: launchDeps.probe,
    desk,
    progress: { isTTY: process.stderr.isTTY === true, write: (text) => process.stderr.write(text) },
  });
}
