import { parseArgs } from 'node:util';
import type { Effort } from '@b-studio/agent';
import { loadProject, SpecError } from '@b-studio/spec';
import { agent, BACKENDS, type Backend } from './commands/agent';
import { authToken } from './commands/auth';
import { bootProbe } from './commands/boot-probe';
import { deploy } from './commands/deploy';
import { launch, LAUNCH_MODES, type LaunchMode } from './commands/launch';
import { sandboxPrune } from './commands/sandbox';
import { stop } from './commands/stop';
import { up } from './commands/up';
import { verify } from './commands/verify';
import { workflow } from './commands/workflow';

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

const USAGE = `사용법:
  studio up <프로젝트 경로> [--keep]
  studio launch [--mode local|demo|commandcode|codex] [--port <n>] [--no-open] [--json]
  studio stop [--json]
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

launch:
  스튜디오를 백그라운드로 띄우고 준비되면 브라우저를 연다. 이미 떠 있으면 새로 띄우지 않고 브라우저만 연다
  준비 로그는 ~/.cache/b-studio/launch/studio.log, PID는 studio.pid에 남는다
  --mode      local(기본, 이 PC의 Claude Code) | demo | commandcode | codex
  --port      기본 3000
  --no-open   브라우저를 열지 않고 주소만 출력한다
  --json      브라우저를 열지 않고, 준비되면 stdout에 한 줄 JSON만 쓴다(진행 안내는 stderr).
              {"url":"http://127.0.0.1:3000","port":3000,"mode":"claude-code","pid":12345,"started":true}

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
  --backend <name>   api | claude-code | codex | commandcode (기본: api)
                     claude-code는 이 PC의 claude CLI에 로그인한 계정으로 실행한다 (API 키 불필요, 개인 PC 전용)
                     codex는 이 PC의 Codex CLI에 ChatGPT로 로그인한 계정으로 실행한다 (API 키 불필요, 개인 PC 전용)
                     codex는 대화를 이어받지 않는다. 요청 하나를 한 번에 처리하고 끝낸다
                     commandcode는 이 PC에 로그인한 Command Code로 실행한다. 모델을 고를 수 있고 기본은 계정 기본 모델이다
  --allow-breaking   요청이 필드·엔드포인트 삭제나 타입 변경을 원할 때 호환 깨짐을 허용한다
  --effort <level>   low | medium | high | xhigh | max (기본: high)
  --model <id>       api 기본: claude-opus-5, claude-code·codex·commandcode 기본: 로그인한 계정의 기본 모델
  --free-only        commandcode에서 무료 모델만 쓴다. 무료가 아닌 --model이면 오류
  --logs             서비스 로그를 함께 출력한다`;

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
    },
  });
  const [command, dir, request] = positionals;

  if (command === 'up' && dir) {
    return up(await loadProject(dir), { keep: values.keep });
  }

  if (command === 'launch') {
    if (dir !== undefined) {
      console.error(USAGE);
      return 2;
    }
    const mode = values.mode ?? 'local';
    if (!LAUNCH_MODES.includes(mode as LaunchMode)) {
      console.error(`--mode는 ${LAUNCH_MODES.join(', ')} 중 하나여야 합니다 (지금 값: ${values.mode})`);
      return 2;
    }
    const port = values.port === undefined ? 3000 : Number(values.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      console.error(`--port는 1~65535 사이의 정수여야 합니다 (지금 값: ${values.port})`);
      return 2;
    }
    return launch({ mode: mode as LaunchMode, port, open: !values['no-open'], json: values.json });
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
