/**
 * `studio ls·new·send·keys·wait·read·status·events`와 `studio stop --session <id>`의 진입점.
 * 이 명령들은 desk와 같은 스튜디오 API를 부르는 얇은 겉이다(새 판정 없음). 자기 옵션을 따로 읽는다 —
 * 기존 명령의 옵션(--backend의 기본값 api 등)과 뜻이 겹치지 않게
 */
import { parseArgs } from 'node:util';
import { connectStudio, CtlError, type ConnectOptions } from './connect';
import { DEFAULT_TIMING, events, exitFor, keys, ls, newSession, read, send, status, stopSession, wait, type Ctx } from './commands';
import { EXIT, WAIT_TARGETS, type WaitTarget } from './phase';

export const CTL_COMMANDS: readonly string[] = ['ls', 'new', 'send', 'keys', 'wait', 'read', 'status', 'events'];

export const CTL_USAGE = `스크립트로 세션 제어:
  studio ls [--project <p>] [--json]
  studio new <프로젝트> "<요청>" [--backend <b>] [--account <a>] [--model <m>] [--json]
  studio send <세션> "<글>" [--json]
  studio keys <세션> <키...> [--json]
  studio wait <세션> [--for idle|input|permission|done|gate|any] [--timeout <초>] [--json]
  studio read <세션> [--lines <N>] [--raw] [--json]
  studio status <세션> [--json]
  studio stop --session <세션> [--json]
  studio events [--session <세션>] [--json]
  모든 명령: --port <n>(스튜디오 포트, 기본: launch가 남긴 포트, 없으면 3000)

  <세션>은 id 전체나 겹치지 않는 앞부분이다. <프로젝트>는 id나 이름이다
  ls      세션 목록: id, 상태, 게이트, 프로젝트, AI, 제목, 마지막 활동(탭으로 나눈 줄). --project로 한 프로젝트만
  new     desk의 n과 같은 길로 세션을 만들고 터미널로 첫 요청을 보낸다. --backend를 안 주면 라우팅 규칙이 AI를 고른다.
          성공하면 stdout에 세션 id 한 줄만 쓴다(나머지는 stderr). --account·--model은 --backend와 함께 준다
  send    그 세션 터미널에 글을 붙여 넣고 Enter를 보낸다. CLI가 받았는지(작업 시작·활동 시각 갱신)를 확인하고, 아니면 Enter를 한 번 더 보낸다.
          그래도 확인하지 못하면 종료 코드 9. CLI가 안 떠 있거나 권한·질문 창이 떠 있으면 보내지 않는다(권한·질문은 keys로)
  keys    키를 차례로 보낸다: ${'Enter Esc Tab S-Tab Space BSpace Delete Up Down Left Right Home End PgUp PgDn C-<글자> M-<글자> 또는 글자 하나(1 y n …)'}
  wait    조건이 될 때까지 기다린다(스튜디오의 이벤트 통로를 쓴다). 기본 --for any, 기본 --timeout 1800(0이면 끝없이)
            idle        요청이 끝나 쉬는 중이고 게이트가 끝났다(게이트 실패면 종료 코드 1)
            input       CLI가 질문이나 입력을 기다린다
            permission  CLI가 권한 확인을 기다린다
            done        세션이 끝났다(멈춤)
            gate        게이트 판정이 나왔다(통과 0, 실패 1, 판정 없음 10)
            any         위 가운데 먼저 오는 것
  read    터미널 화면의 글(서식 없음). --lines N이면 지난 줄까지 합친 마지막 N줄, --raw면 서식 제어 문자를 남긴 지금 화면
  status  게이트 결과, 체크포인트, 바뀐 파일, 토큰, 확인 필요 항목
  stop    세션을 멈춘다(기록과 작업 복사본은 남는다). 스튜디오를 끄는 \`studio stop\`(옵션 없음)과 다르다. 빈 변수가 스튜디오를 끄지 않게 --session을 꼭 준다
  events  세션 상태가 바뀔 때마다 한 줄씩 낸다(--json이면 한 줄 JSON). 처음에 지금 세션을 snapshot으로 낸다. Ctrl-c로 끝낸다

종료 코드:
  0 성공 · 조건 맞음(게이트를 기다렸다면 통과)       6 세션이 끝났는데 기다리던 조건이 아니다
  1 게이트 실패 · 세션 오류 · 스튜디오가 거절함        7 스튜디오에 붙지 못했다 · 인증 실패
  2 사용법                                           8 세션·프로젝트가 없다
  3 시간 초과                                        9 send: 보냈지만 CLI가 받았다는 확인을 못 했다
  4 권한 확인에서 기다린다                            10 gate: 쉬는 중인데 게이트 판정이 없다
  5 질문·입력 요구에서 기다린다

인증:
  개인 PC는 studio launch가 만든 로컬 토큰 파일을 desk처럼 읽는다.
  인증을 켠 서버는 B_STUDIO_URL(또는 --url), B_STUDIO_USER(--user), B_STUDIO_TOKEN(--token)을 준다. 토큰은 studio auth token <이름>이 내준 것이다.
  토큰은 명령줄 대신 환경 변수로 주는 편이 낫다(프로세스 목록에 보이지 않는다)
  터미널을 움직이는 명령(send·keys)은 세션을 만든 사람만 된다. 서버가 판정하고 이 명령은 그대로 따른다`;

const options = {
  json: { type: 'boolean', default: false },
  port: { type: 'string' },
  url: { type: 'string' },
  user: { type: 'string' },
  token: { type: 'string' },
  project: { type: 'string' },
  backend: { type: 'string' },
  account: { type: 'string' },
  model: { type: 'string' },
  for: { type: 'string' },
  timeout: { type: 'string' },
  lines: { type: 'string' },
  raw: { type: 'boolean', default: false },
  session: { type: 'string' },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

function usageError(message?: string): number {
  if (message) console.error(message);
  console.error(CTL_USAGE);
  return EXIT.usage;
}

function positiveInt(raw: string | undefined, name: string, min: number): number | undefined | CtlError {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min) return new CtlError(`${name}은(는) ${min} 이상의 정수여야 합니다 (지금 값: ${raw})`, EXIT.usage);
  return value;
}

export interface CtlDeps {
  env: Record<string, string | undefined>;
  out: (line: string) => void;
  err: (line: string) => void;
  /** 테스트가 스튜디오 없이 만든 손님을 끼운다 */
  connect?: (env: Record<string, string | undefined>, options: ConnectOptions) => ReturnType<typeof connectStudio>;
  timing?: Partial<typeof DEFAULT_TIMING>;
  signal?: AbortSignal;
}

/** argv는 명령 이름부터다(예: ['wait', 's1', '--for', 'idle']). 종료 코드를 돌려준다 */
export async function ctlMain(argv: string[], deps: CtlDeps): Promise<number> {
  let parsed: ReturnType<typeof parseArgs<{ options: typeof options; allowPositionals: true }>>;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options });
  } catch (error) {
    return usageError(error instanceof Error ? error.message : String(error));
  }
  const { positionals, values } = parsed;
  const [command, ...rest] = positionals;
  if (values.help) {
    console.log(CTL_USAGE);
    return EXIT.ok;
  }
  if (!command) return usageError();

  try {
    const port = positiveInt(values.port, '--port', 1);
    if (port instanceof CtlError) throw port;
    if (port !== undefined && port > 65535) throw new CtlError(`--port는 1~65535 사이의 정수여야 합니다 (지금 값: ${values.port})`, EXIT.usage);

    // 인자 검사는 스튜디오에 붙기 전에 끝낸다(틀린 사용법이 연결 오류로 가려지지 않게)
    let run: ((ctx: Ctx) => Promise<number>) | undefined;
    const need = (count: number, text: string): void => {
      if (rest.length !== count) throw new CtlError(`사용법: ${text}`, EXIT.usage);
    };
    switch (command) {
      case 'ls':
        need(0, 'studio ls [--project <p>] [--json]');
        run = (ctx) => ls(ctx, { ...(values.project === undefined ? {} : { project: values.project }) });
        break;
      case 'new':
        need(2, 'studio new <프로젝트> "<요청>" [--backend <b>] [--account <a>] [--model <m>] [--json]');
        if (!rest[1]!.trim()) throw new CtlError('요청이 비어 있습니다', EXIT.usage);
        if ((values.account !== undefined || values.model !== undefined) && values.backend === undefined) throw new CtlError('--account·--model은 --backend와 함께 줍니다', EXIT.usage);
        run = (ctx) => newSession(ctx, { project: rest[0]!, request: rest[1]!, ...(values.backend === undefined ? {} : { backend: values.backend }), ...(values.account === undefined ? {} : { account: values.account }), ...(values.model === undefined ? {} : { model: values.model }) });
        break;
      case 'send':
        need(2, 'studio send <세션> "<글>" [--json]');
        run = (ctx) => send(ctx, rest[0]!, rest[1]!);
        break;
      case 'keys':
        if (rest.length < 2) throw new CtlError('사용법: studio keys <세션> <키...> [--json]', EXIT.usage);
        run = (ctx) => keys(ctx, rest[0]!, rest.slice(1));
        break;
      case 'wait': {
        need(1, 'studio wait <세션> [--for idle|input|permission|done|gate|any] [--timeout <초>] [--json]');
        const target = values.for ?? 'any';
        if (!WAIT_TARGETS.includes(target as WaitTarget)) throw new CtlError(`--for는 ${WAIT_TARGETS.join(', ')} 중 하나여야 합니다 (지금 값: ${target})`, EXIT.usage);
        const timeout = positiveInt(values.timeout, '--timeout', 0);
        if (timeout instanceof CtlError) throw timeout;
        run = (ctx) => wait(ctx, rest[0]!, target as WaitTarget, timeout ?? 1800);
        break;
      }
      case 'read': {
        need(1, 'studio read <세션> [--lines <N>] [--raw] [--json]');
        const lines = positiveInt(values.lines, '--lines', 1);
        if (lines instanceof CtlError) throw lines;
        run = (ctx) => read(ctx, rest[0]!, { ...(lines === undefined ? {} : { lines }), raw: values.raw });
        break;
      }
      case 'status':
        need(1, 'studio status <세션> [--json]');
        run = (ctx) => status(ctx, rest[0]!);
        break;
      case 'stop':
        need(0, 'studio stop --session <세션> [--json]');
        if (!values.session) throw new CtlError('--session에 세션 id를 주세요(스튜디오를 끄려면 옵션 없이 studio stop)', EXIT.usage);
        run = (ctx) => stopSession(ctx, values.session!);
        break;
      case 'events':
        need(0, 'studio events [--session <세션>] [--json]');
        run = (ctx) => events(ctx, { ...(values.session === undefined ? {} : { session: values.session }) });
        break;
      default:
        return usageError();
    }

    const client = await (deps.connect ?? connectStudio)(deps.env, { ...(port === undefined ? {} : { port }), ...(values.url === undefined ? {} : { url: values.url }), ...(values.user === undefined ? {} : { user: values.user }), ...(values.token === undefined ? {} : { token: values.token }) });
    return await run({ client, json: values.json, out: deps.out, err: deps.err, timing: { ...DEFAULT_TIMING, ...deps.timing }, ...(deps.signal ? { signal: deps.signal } : {}) });
  } catch (error) {
    const { code, message } = exitFor(error);
    if (values.json) deps.out(JSON.stringify({ ok: false, code, error: message }));
    else deps.err(message);
    return code;
  }
}
