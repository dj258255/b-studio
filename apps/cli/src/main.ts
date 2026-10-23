import { parseArgs } from 'node:util';
import type { Effort } from '@b-studio/agent';
import { loadProject, SpecError } from '@b-studio/spec';
import { agent, BACKENDS, type Backend } from './commands/agent';
import { authToken } from './commands/auth';
import { bootProbe } from './commands/boot-probe';
import { deploy } from './commands/deploy';
import { desk } from './desk/desk';
import { launch, LAUNCH_MODES, type LaunchMode } from './commands/launch';
import { sandboxPrune } from './commands/sandbox';
import { studio } from './commands/start';
import { stop } from './commands/stop';
import { up } from './commands/up';
import { verify } from './commands/verify';
import { workflow } from './commands/workflow';

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

const USAGE = `사용법:
  studio [--mode local|demo|commandcode|codex] [--port <n>] [--no-notify] [--no-mouse]
  studio up <프로젝트 경로> [--keep]
  studio launch [--mode local|demo|commandcode|codex] [--port <n>] [--web] [--json]
  studio stop [--json]
  studio desk [--port <n>] [--no-notify] [--no-mouse]
  studio boot-probe <프로젝트 경로> [--json]
  studio agent <프로젝트 경로> "<요청>" [옵션]
  studio deploy <프로젝트 경로> [--status | --rollback <릴리스> | --remove [--volumes]]
  studio workflow <프로젝트 경로> [--pi-env]
  studio verify <프로젝트 경로> [--allow-breaking] [--keep] [--logs]
  studio auth token <이름>
  studio sandbox prune [--dry-run]

verify:
  편집기·명령으로 바꾼 현재 변경을 에이전트와 같은 검증 게이트로 확인한다. 체크포인트는 만들지 않는다
  종료 코드          0 통과 · 1 검증 실패 · 2 사용법·git 오류 · 3 검증할 변경 없음
  --allow-breaking   계약을 깨는 변경(필드·엔드포인트 삭제, 타입 변경)을 허용한다
  --keep             끝나거나 실패해도 컨테이너를 지우지 않는다 (디버깅용)
  --logs             서비스 로그를 함께 출력한다

studio (명령 없이):
  스튜디오를 브라우저 없이 뒤에서 띄우고(이미 떠 있으면 재사용) 바로 터미널 작업대(desk)를 연다
  세션 터미널(B_STUDIO_EXPERIMENTAL=1)과 Codex(B_STUDIO_BACKENDS=codex)를 켜서 띄운다. 직접 정한 값이 있으면 그대로 쓴다
  desk를 나가도 스튜디오는 뒤에서 돈다. 끄기는 studio stop

launch:
  스튜디오를 백그라운드로 띄운다. 이미 떠 있으면 새로 띄우지 않는다. 브라우저는 --web일 때만 연다
  준비 로그는 ~/.cache/b-studio/launch/studio.log, PID는 studio.pid에 남는다
  --mode      local(기본, 이 PC의 Claude Code) | demo | commandcode | codex
  --port      기본 3000
  --web       준비되면 브라우저를 연다(--open과 같다). 브라우저 화면이 있는 next dev로 띄운다
  --next      브라우저를 열지 않아도 next dev로 띄운다(기본은 Next 없이 도는 가벼운 Node 서버)
  --json      브라우저를 열지 않고, 준비되면 stdout에 한 줄 JSON만 쓴다(진행 안내는 stderr).
              {"url":"http://127.0.0.1:3000","port":3000,"mode":"claude-code","pid":12345,"started":true}

desk:
  터미널 하나에서 여러 AI CLI를 나란히 쓴다. 왼쪽은 스페이스(프로젝트), 오른쪽은 세션 카드 화면(Ctrl-b w) 또는 터미널 칸 1·2·4개
  띄워 둔 스튜디오에 붙는다(이 컴퓨터 방식 세션 터미널, B_STUDIO_EXPERIMENTAL=1). 띄우기까지 한 번에 하려면 studio(명령 없이). 나가도 세션과 CLI는 계속 돈다
  Ctrl-b 다음에  숫자 칸 고르기 · ↑↓ 사이드바 · Enter 고른 세션을 칸에 열기 · n 새 요청(규칙으로 AI를 골라 터미널로) · w 카드 화면
                 l 칸 수 1→2→4 · x 칸 비우기 · p 세션 멈추기 · r 이어서 작업 · , 이름 바꾸기 · ? 도움말 · q 나가기
                 g 설정(계정 더하기·로그인·그림, 라우팅 규칙, 화면, 키·알림)
                 h 기록(AI·계정별 결과, 토큰 보고서) · i 고른 세션 자세히(체크포인트·확인·리뷰·올리기)
                 t 작업 나누기(계획 목록·새 계획·단계별 레인 카드, 승인 대기면 레인 AI·계정 바꾸기와 승인)
                 e 요구사항·문서(명세, 이 요구사항으로 작업, 편집기로 고치기, 테스트, 문서 읽기, 현황)
                 f 여러 AI 비교(같은 요청을 계정·모델까지 고른 2~4개 AI에 보내 카드로 나란히 보고 승자 고르기, 참가자를 칸에 나란히)
                 Ctrl-b CLI에 Ctrl-b 보내기
  세션이 권한·답을 기다리거나 검증이 끝나면 사이드바에 !를 붙이고 벨과 OS 알림(OSC 9)을 낸다
  마우스로 칸·사이드바를 고르고 휠로 지난 출력을 본다. 칸 배치는 나갈 때 기억해 다음에 되살린다
  설정은 ~/.config/b-studio/desk.json({"prefix":"C-a","notify":false,"mouse":false,"color":"256"}). 인자가 설정보다 앞선다
  --port      스튜디오 포트(기본: launch가 남긴 포트, 없으면 3000)
  --no-notify 벨과 OS 알림을 내지 않는다(사이드바 표시와 아래 줄 알림은 그대로)
  --no-mouse  마우스를 받지 않는다(터미널의 글 고르기를 그대로 쓴다)

stop:
  launch가 띄운 스튜디오를 멈춘다. PID 파일의 프로세스 그룹에 SIGTERM을 보낸다(로그는 남는다)
  --json      stdout에 {"stopped":true|false} 한 줄만 쓴다

boot-probe:
  샌드박스를 띄워 기동 시간(ms)과 서비스별 받은·보낸 바이트를 재고 곧바로 내린다(keep 없음). 캐시 없음/있음 기동 비교에 쓴다
  B_STUDIO_SANDBOX_BUILD_NO_CACHE=1을 함께 주면 이 프로젝트 이미지만 레이어 캐시 없이 빌드하고 스냅샷도 쓰지 않는다
  --json   사람이 읽는 한 줄 대신 한 줄 JSON을 출력한다

workflow:
  studio.yaml에서 강제할 단계, 테스트, 화면 확인, 보호 경로, 배포 조건을 보여 준다
  --pi-env           Pi 확장(packages/agent/pi/bstudio-policy.ts)이 읽는 환경 변수를 export 문으로 출력한다

auth token:
  웹 스튜디오 token 모드에 쓸 접근 토큰과, 서버의 B_STUDIO_AUTH_TOKENS에 넣을 해시 값을 만든다

sandbox:
  studio sandbox prune  b-studio가 만들었지만 쓰지 않는 Docker 자원(컨테이너·이미지·볼륨·네트워크)을 찾아 지운다
  --dry-run             지울 목록만 보여 주고 아무것도 지우지 않는다

deploy:
  운영 Dockerfile로 이미지를 만들어 로컬 Docker에 배포하고, 준비되면 고정 주소를 새 릴리스로 무중단 전환한다
  --status           운영 주소, 컨테이너 상태, 릴리스 기록
  --rollback <id>    이미지를 남긴 이전 릴리스로 빌드 없이 되돌린다 (데이터베이스 마이그레이션은 되돌리지 않는다)
  --remove           운영 프록시, 릴리스, 기반 스택을 지운다. --volumes를 더하면 데이터베이스 볼륨도 지운다

공통 옵션:
  --keep             끝나거나 실패해도 컨테이너를 지우지 않는다 (디버깅용)

agent 옵션:
  --backend <name>   api | claude-code | codex | commandcode | opencode (기본: api)
                     claude-code는 이 PC의 claude CLI에 로그인한 계정으로 실행한다 (API 키 불필요, 개인 PC 전용)
                     codex는 이 PC의 Codex CLI에 ChatGPT로 로그인한 계정으로 실행한다 (API 키 불필요, 개인 PC 전용)
                     codex는 대화를 이어받지 않는다. 요청 하나를 한 번에 처리하고 끝낸다
                     commandcode는 이 PC에 로그인한 Command Code로 실행한다. 모델을 고를 수 있고 기본은 계정 기본 모델이다
                     opencode는 이 PC에 설치된 OpenCode CLI로 실행한다. --model이 필수다(무료 Zen 모델은 내장 도구를 끈 b-studio 구성에서 거절된다)
  --allow-breaking   요청이 필드·엔드포인트 삭제나 타입 변경을 원할 때 호환 깨짐을 허용한다
  --effort <level>   low | medium | high | xhigh | max (기본: high)
  --model <id>       api 기본: claude-opus-5, claude-code·codex·commandcode 기본: 로그인한 계정의 기본 모델, opencode 필수: 로그인한 제공자의 모델('opencode models'로 확인)
  --free-only        commandcode·opencode에서 무료 모델만 쓴다. 무료가 아니거나 쓸 수 없는 --model이면 오류
  --logs             서비스 로그를 함께 출력한다`;

/** --mode·--port를 검사한다. 잘못됐으면 안내를 찍고 종료 코드 2 */
function modeAndPort(modeValue: string | undefined, portValue: string | undefined): { mode: LaunchMode; port: number } | number {
  const mode = modeValue ?? 'local';
  if (!LAUNCH_MODES.includes(mode as LaunchMode)) {
    console.error(`--mode는 ${LAUNCH_MODES.join(', ')} 중 하나여야 합니다 (지금 값: ${modeValue})`);
    return 2;
  }
  const port = portValue === undefined ? 3000 : Number(portValue);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`--port는 1~65535 사이의 정수여야 합니다 (지금 값: ${portValue})`);
    return 2;
  }
  return { mode: mode as LaunchMode, port };
}

async function main(argv: string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      keep: { type: 'boolean', default: false },
      logs: { type: 'boolean', default: false },
      'allow-breaking': { type: 'boolean', default: false },
      backend: { type: 'string', default: 'api' },
      effort: { type: 'string' },
      model: { type: 'string' },
      'free-only': { type: 'boolean', default: false },
      status: { type: 'boolean', default: false },
      rollback: { type: 'string' },
      remove: { type: 'boolean', default: false },
      volumes: { type: 'boolean', default: false },
      'pi-env': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      mode: { type: 'string' },
      port: { type: 'string' },
      'no-open': { type: 'boolean', default: false },
      web: { type: 'boolean', default: false },
      next: { type: 'boolean', default: false },
      open: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      'no-notify': { type: 'boolean', default: false },
      'no-mouse': { type: 'boolean', default: false },
    },
  });
  const [command, dir, request] = positionals;

  if (values.help) {
    console.log(USAGE);
    return 0;
  }

  if (command === undefined) {
    const parsed = modeAndPort(values.mode, values.port);
    if (typeof parsed === 'number') return parsed;
    const code = await studio({
      ...parsed,
      ...(values['no-notify'] ? { notify: false } : {}),
      ...(values['no-mouse'] ? { mouse: false } : {}),
    });
    // desk가 끝난 뒤 남은 연결이 프로세스를 붙잡지 않게 바로 끝낸다(studio desk와 같다)
    process.exit(code);
  }

  if (command === 'up' && dir) {
    return up(await loadProject(dir), { keep: values.keep });
  }

  if (command === 'launch') {
    if (dir !== undefined) {
      console.error(USAGE);
      return 2;
    }
    const parsed = modeAndPort(values.mode, values.port);
    if (typeof parsed === 'number') return parsed;
    // 브라우저는 --web(또는 --open)일 때만 연다. --no-open은 예전 인자라 받기만 한다
    return launch({ ...parsed, open: (values.web || values.open) && !values['no-open'], json: values.json, ...(values.next ? { server: 'next' as const } : {}) });
  }

  if (command === 'desk') {
    if (dir !== undefined) {
      console.error(USAGE);
      return 2;
    }
    const port = values.port === undefined ? undefined : Number(values.port);
    if (port !== undefined && (!Number.isInteger(port) || port < 1 || port > 65535)) {
      console.error(`--port는 1~65535 사이의 정수여야 합니다 (지금 값: ${values.port})`);
      return 2;
    }
    // 인자로 끈 것만 넘긴다. 넘기지 않으면 설정 파일(desk.json)을 따른다
    const code = await desk({
      ...(port === undefined ? {} : { port }),
      ...(values['no-notify'] ? { notify: false } : {}),
      ...(values['no-mouse'] ? { mouse: false } : {}),
    });
    // 끝난 뒤에도 남은 연결(끊는 중인 통로)이 프로세스를 붙잡지 않게 바로 끝낸다
    process.exit(code);
  }

  if (command === 'stop') {
    if (dir !== undefined) {
      console.error(USAGE);
      return 2;
    }
    return stop({ json: values.json });
  }

  if (command === 'boot-probe' && dir) {
    // 재는 명령이라 모르는 인자를 조용히 무시하지 않는다
    if (request !== undefined) {
      console.error(USAGE);
      return 2;
    }
    return bootProbe(await loadProject(dir), { json: values.json });
  }

  if (command === 'deploy' && dir) {
    if ([values.status, values.remove, values.rollback !== undefined].filter(Boolean).length > 1) {
      console.error('--status, --rollback, --remove는 하나만 쓸 수 있습니다');
      return 2;
    }
    return deploy(await loadProject(dir), { status: values.status, rollback: values.rollback, remove: values.remove, volumes: values.volumes });
  }

  if (command === 'workflow' && dir) {
    return workflow(await loadProject(dir), { piEnv: values['pi-env'] });
  }

  if (command === 'verify' && dir) {
    if (request !== undefined) {
      console.error(USAGE);
      return 2;
    }
    return verify(await loadProject(dir), { keep: values.keep, logs: values.logs, allowBreaking: values['allow-breaking'] });
  }

  if (command === 'auth' && dir === 'token' && request) {
    return authToken(request);
  }

  if (command === 'sandbox' && dir === 'prune') {
    // 삭제 명령이라 모르는 인자를 조용히 무시하지 않고 사용법을 보여 준다
    if (request !== undefined) {
      console.error(USAGE);
      return 2;
    }
    return sandboxPrune({ dryRun: values['dry-run'] });
  }

  if (command === 'agent' && dir && request) {
    const effort = values.effort;
    if (effort !== undefined && !EFFORTS.includes(effort as Effort)) {
      console.error(`--effort는 ${EFFORTS.join(', ')} 중 하나여야 합니다`);
      return 2;
    }
    if (!BACKENDS.includes(values.backend as Backend)) {
      console.error(`--backend는 ${BACKENDS.join(', ')} 중 하나여야 합니다`);
      return 2;
    }
    return agent(await loadProject(dir), request, {
      keep: values.keep,
      logs: values.logs,
      allowBreaking: values['allow-breaking'],
      backend: values.backend as Backend,
      model: values.model,
      effort: effort as Effort | undefined,
      freeOnly: values['free-only'],
    });
  }

  console.error(USAGE);
  return 2;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(error instanceof SpecError ? error.message : error);
    process.exitCode = 1;
  },
);
