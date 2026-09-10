import { parseArgs } from 'node:util';
import type { Effort } from '@b-studio/agent';
import { loadProject, SpecError } from '@b-studio/spec';
import { agent, type Backend } from './commands/agent';
import { up } from './commands/up';

const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
const BACKENDS: readonly Backend[] = ['api', 'claude-code'];

const USAGE = `사용법:
  studio up <프로젝트 경로> [--keep]
  studio agent <프로젝트 경로> "<요청>" [옵션]

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
    },
  });
  const [command, dir, request] = positionals;

  if (command === 'up' && dir) {
    return up(await loadProject(dir), { keep: values.keep });
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
