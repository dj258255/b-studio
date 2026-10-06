/**
 * 명령줄 인자 해석.
 *
 * run.ts가 모듈을 불러오면 바로 실행되기 때문에(main() 즉시 호출), 인자 해석만 따로 떼어
 * 실행 없이 테스트할 수 있게 한다.
 */
import { STRATEGIES, type Strategy } from './tasks';
import type { Topology } from '@b-studio/agent';

export interface Args {
  dry: boolean;
  force: boolean;
  taskIds?: string[];
  strategies?: Strategy[];
  repeats?: number;
  out?: string;
  backend?: string;
  model?: string;
  freeOnly?: boolean;
  onRateLimit?: string;
  rateLimitWaitMinutes?: number;
  /** 컨텍스트 비우기(on|off). 기본 off */
  contextClearing?: string;
  topology?: string;
  /** 통합 게이트에 api 값 확인을 덧붙일지. 기본 꺼짐 */
  integrationChecks?: boolean;
  /** 검증 범위(full|light). 기본 full. light면 레인·통합 실행이 가볍게 확인한다 */
  verify?: string;
  selfCheck?: string;
  /** 레인 사이 계약의 출처(human|model). 기본 human. model은 S2에서만 */
  contracts?: string;
  escalateTo?: string;
  escalateAfter?: number;
  /** 서명과 무관하게 게이트 실패 N번이면 승격(선택). 기본 없음 */
  escalateAfterFailures?: number;
  /** 승격 뒤 새로 주는 게이트 재시도 횟수. 기본 2 */
  escalateRetryBudget?: number;
  /** `--lane-backend <레인 그룹>=<백엔드>[:<모델>]` 반복. 레인마다 백엔드를 고른다 */
  laneBackends?: string[];
  /** 모델 이름 일부 → 단가 표 JSON 파일. 모델별 API 환산 비용을 계산한다 */
  prices?: string;
  /** 계획-실행 분리(ADR-075). 큰 모델로 계획을 한 번 받은 뒤 실행은 --model(또는 --execute-model)로 돈다. claude-code에서만 */
  planModel?: string;
  /** 계획-실행 분리의 실행 모델. 없으면 --model을 그대로 실행에도 쓴다(지금과 같다) */
  executeModel?: string;
  /** --plan-always. 요청 복잡도와 무관하게 계획을 세운다(B_STUDIO_PLAN_BRIEF=always). 벤치 과제는 짧아 기본 auto면 계획을 건너뛴다 */
  planAlways?: boolean;
  /** --concurrency N. 기본 1(지금과 같은 직렬 실행). N>1이면 run.ts가 스스로를 자식 프로세스로 띄워 최대 N개를 동시에 돈다 */
  concurrency?: number;
  /**
   * 내부용(문서에 적지 않음). 부모가 자식 프로세스를 띄울 때만 붙인다.
   * 자식은 이 값을 --concurrency로 받지 않는다(그러면 자식이 또 풀을 띄운다) — 행·meta.json에 남길 동시성 값만 넘긴다
   */
  childConcurrency?: number;
  /** 내부용. 부모가 이 반복 번호 하나만 돌게 자식에게 준다(생략하면 1..repeats를 모두 돈다) */
  repeatIndex?: number;
  /** 내부용. 부모가 전체 계획에서 이 자식이 맡은 순번을 지정한다(행의 order가 부모의 계획 순서와 같아지게) */
  orderStart?: number;
  /** environment 실패가 연달아 이 횟수에 이르면 남은 실행을 돌리지 않고 멈춘다(이슈 #411). 기본 2 */
  maxEnvFailures?: number;
}

/** S3의 읽기 범위. 기본 mesh. 다른 전략에는 영향이 없다 */
export function parseTopology(value: string | undefined): Topology {
  if (value === undefined) return 'mesh';
  if (value === 'star' || value === 'hierarchical' || value === 'mesh') return value;
  throw new Error(`전략 topology는 star, hierarchical, mesh 중 하나여야 합니다 (지금 값: ${value})`);
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { dry: false, force: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === '--dry') args.dry = true;
    else if (arg === '--force') args.force = true;
    else if (arg === '--integration-checks') args.integrationChecks = true;
    else if (arg === '--verify') args.verify = next(argv, index++, '--verify');
    else if (arg === '--self-check') args.selfCheck = next(argv, index++, '--self-check');
    else if (arg === '--tasks') args.taskIds = split(next(argv, index++, '--tasks'));
    else if (arg === '--strategies') args.strategies = split(next(argv, index++, '--strategies')) as Strategy[];
    else if (arg === '--repeats') args.repeats = Number(next(argv, index++, '--repeats'));
    else if (arg === '--out') args.out = next(argv, index++, '--out');
    else if (arg === '--backend') args.backend = next(argv, index++, '--backend');
    else if (arg === '--model') args.model = next(argv, index++, '--model');
    else if (arg === '--free-only') args.freeOnly = true;
    else if (arg === '--on-rate-limit') args.onRateLimit = next(argv, index++, '--on-rate-limit');
    else if (arg === '--rate-limit-wait-minutes') args.rateLimitWaitMinutes = Number(next(argv, index++, '--rate-limit-wait-minutes'));
    else if (arg === '--topology') args.topology = next(argv, index++, '--topology');
    else if (arg === '--contracts') args.contracts = next(argv, index++, '--contracts');
    else if (arg === '--context-clearing') args.contextClearing = next(argv, index++, '--context-clearing');
    else if (arg === '--escalate-to') args.escalateTo = next(argv, index++, '--escalate-to');
    else if (arg === '--escalate-after') args.escalateAfter = Number(next(argv, index++, '--escalate-after'));
    else if (arg === '--escalate-after-failures') args.escalateAfterFailures = Number(next(argv, index++, '--escalate-after-failures'));
    else if (arg === '--escalate-retry-budget') args.escalateRetryBudget = Number(next(argv, index++, '--escalate-retry-budget'));
    else if (arg === '--lane-backend') (args.laneBackends ??= []).push(next(argv, index++, '--lane-backend'));
    else if (arg === '--prices') args.prices = next(argv, index++, '--prices');
    else if (arg === '--plan-model') args.planModel = next(argv, index++, '--plan-model');
    else if (arg === '--execute-model') args.executeModel = next(argv, index++, '--execute-model');
    else if (arg === '--plan-always') args.planAlways = true;
    else if (arg === '--concurrency') args.concurrency = Number(next(argv, index++, '--concurrency'));
    else if (arg === '--child-concurrency') args.childConcurrency = Number(next(argv, index++, '--child-concurrency'));
    else if (arg === '--repeat-index') args.repeatIndex = Number(next(argv, index++, '--repeat-index'));
    else if (arg === '--order-start') args.orderStart = Number(next(argv, index++, '--order-start'));
    else if (arg === '--max-env-failures') args.maxEnvFailures = Number(next(argv, index++, '--max-env-failures'));
    else if (arg.startsWith('--tasks=')) args.taskIds = split(arg.slice('--tasks='.length));
    else if (arg.startsWith('--strategies=')) args.strategies = split(arg.slice('--strategies='.length)) as Strategy[];
    else if (arg.startsWith('--repeats=')) args.repeats = Number(arg.slice('--repeats='.length));
    else if (arg.startsWith('--out=')) args.out = arg.slice('--out='.length);
    else if (arg.startsWith('--backend=')) args.backend = arg.slice('--backend='.length);
    else if (arg.startsWith('--model=')) args.model = arg.slice('--model='.length);
    else if (arg.startsWith('--on-rate-limit=')) args.onRateLimit = arg.slice('--on-rate-limit='.length);
    else if (arg.startsWith('--rate-limit-wait-minutes=')) args.rateLimitWaitMinutes = Number(arg.slice('--rate-limit-wait-minutes='.length));
    else if (arg.startsWith('--topology=')) args.topology = arg.slice('--topology='.length);
    else if (arg.startsWith('--contracts=')) args.contracts = arg.slice('--contracts='.length);
    else if (arg.startsWith('--context-clearing=')) args.contextClearing = arg.slice('--context-clearing='.length);
    else if (arg.startsWith('--verify=')) args.verify = arg.slice('--verify='.length);
    else if (arg.startsWith('--self-check=')) args.selfCheck = arg.slice('--self-check='.length);
    else if (arg.startsWith('--escalate-to=')) args.escalateTo = arg.slice('--escalate-to='.length);
    else if (arg.startsWith('--escalate-after=')) args.escalateAfter = Number(arg.slice('--escalate-after='.length));
    else if (arg.startsWith('--escalate-after-failures=')) args.escalateAfterFailures = Number(arg.slice('--escalate-after-failures='.length));
    else if (arg.startsWith('--escalate-retry-budget=')) args.escalateRetryBudget = Number(arg.slice('--escalate-retry-budget='.length));
    else if (arg.startsWith('--lane-backend=')) (args.laneBackends ??= []).push(arg.slice('--lane-backend='.length));
    else if (arg.startsWith('--prices=')) args.prices = arg.slice('--prices='.length);
    else if (arg.startsWith('--plan-model=')) args.planModel = arg.slice('--plan-model='.length);
    else if (arg.startsWith('--execute-model=')) args.executeModel = arg.slice('--execute-model='.length);
    else if (arg.startsWith('--concurrency=')) args.concurrency = Number(arg.slice('--concurrency='.length));
    else if (arg.startsWith('--child-concurrency=')) args.childConcurrency = Number(arg.slice('--child-concurrency='.length));
    else if (arg.startsWith('--repeat-index=')) args.repeatIndex = Number(arg.slice('--repeat-index='.length));
    else if (arg.startsWith('--order-start=')) args.orderStart = Number(arg.slice('--order-start='.length));
    else if (arg.startsWith('--max-env-failures=')) args.maxEnvFailures = Number(arg.slice('--max-env-failures='.length));
    else throw new Error(`알 수 없는 인자입니다: ${arg}`);
  }
  return args;
}

function next(argv: string[], index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value) throw new Error(`${flag} 뒤에 값이 필요합니다`);
  return value;
}

function split(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean);
}

/**
 * 검증된 `--concurrency` 값. 기본 1(지금과 같은 직렬 실행). 정수가 아니거나 1 미만이면 거부한다.
 * 자식 프로세스는 `--concurrency`를 받지 않으므로(대신 `--child-concurrency`로 표시값만 받는다) 이 함수는
 * 최상위(부모 또는 직렬) 호출에서만 쓴다.
 */
export function resolveConcurrency(value: number | undefined): number {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || value < 1) throw new Error(`--concurrency는 1 이상의 정수여야 합니다 (지금 값: ${value})`);
  return value;
}

/**
 * 이 프로세스가 행·meta.json에 남길 동시성 값. 부모가 띄운 자식이면 `--child-concurrency`(부모의 N),
 * 아니면 이 프로세스 자신의 `--concurrency`(직렬이면 1).
 */
export function concurrencyLabel(args: Pick<Args, 'concurrency' | 'childConcurrency'>): number {
  return args.childConcurrency ?? resolveConcurrency(args.concurrency);
}

/** --dry의 가짜 제공자가 돌 수 있는 기준선 전략 */
const DRY_STRATEGIES: readonly Strategy[] = ['S0', 'S1'];

/**
 * 돌릴 전략을 고른다. --dry의 가짜 제공자는 S2~S5의 조율과 P0(로컬 Claude Code)을 모르므로 S0·S1 안에서만 고른다.
 * 그 안에서는 준 전략을 따른다 — 동시 실행(--concurrency)의 자식은 전략 하나만 받는데, 이를 무시하면 자식마다 일을 두 배로 한다
 */
export function selectStrategies(strategies: Strategy[] | undefined, dry: boolean): Strategy[] {
  const asked = strategies && strategies.length > 0 ? strategies : undefined;
  const values = dry ? (asked?.filter((strategy) => DRY_STRATEGIES.includes(strategy)) ?? []) : (asked ?? []);
  if (values.length === 0) return [...DRY_STRATEGIES];
  for (const value of values) if (!STRATEGIES.includes(value)) throw new Error(`전략은 ${STRATEGIES.join(', ')} 중 하나여야 합니다: ${value}`);
  return [...new Set(values)];
}
