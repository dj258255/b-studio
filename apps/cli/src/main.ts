import { parseArgs } from 'node:util';
import type { Effort } from '@b-studio/agent';
import { loadProject, SpecError } from '@b-studio/spec';
import { agent, type Backend } from './commands/agent';
import { authToken } from './commands/auth';
import { deploy } from './commands/deploy';
import { sandboxPrune } from './commands/sandbox';
import { up } from './commands/up';
import { workflow } from './commands/workflow';

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const BACKENDS: readonly Backend[] = ['api', 'claude-code'];

const USAGE = `사용법:
  studio up <프로젝트 경로> [--keep]
  studio agent <프로젝트 경로> "<요청>" [옵션]
  studio deploy <프로젝트 경로> [--status | --rollback <릴리스> | --remove [--volumes]]
  studio workflow <프로젝트 경로> [--pi-env]
  studio auth token <이름>
  studio sandbox prune [--dry-run]

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
  --backend <name>   api | claude-code (기본: api)
                     claude-code는 이 PC의 claude CLI에 로그인한 계정으로 실행한다 (API 키 불필요, 개인 PC 전용)
  --allow-breaking   요청이 필드·엔드포인트 삭제나 타입 변경을 원할 때 호환 깨짐을 허용한다
  --effort <level>   low | medium | high | xhigh | max (기본: high)
  --model <id>       api 기본: claude-opus-5, claude-code 기본: 로그인한 계정의 기본 모델
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
      status: { type: 'boolean', default: false },
      rollback: { type: 'string' },
      remove: { type: 'boolean', default: false },
      volumes: { type: 'boolean', default: false },
      'pi-env': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
    },
  });
  const [command, dir, request] = positionals;

  if (command === 'up' && dir) {
    return up(await loadProject(dir), { keep: values.keep });
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
