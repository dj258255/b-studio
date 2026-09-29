/**
 * 협업 벤치마크 과제 정의와 전략별 고정 계획.
 *
 * 계획은 과제마다 고정한다. 모델이 레인을 어떻게 나누느냐가 섞이면 전략 차이를 잴 수 없기 때문이다.
 * 여기서 만든 계획은 프록시가 계획 요청에 그대로 돌려준다.
 *
 * 전략(검토 문서 1.6):
 *  - S0 직렬화    같은 레인·같은 세션 (기존)
 *  - S1 격리 병렬 공유 없음 (기존)
 *  - S2 계약 먼저 계획의 인터페이스 계약을 레인 시작 전에 플랫폼이 contract 메모로 게시. 레인은 읽기만
 *  - S3 게시판    레인이 contract·fact를 쓰고 읽음. topology로 읽기 범위 제한
 *  - S4 통합 후 수리 공유 없음. 통합 게이트 실패 시 통합 세션에 모델 수리 요청 한 번
 *  - S5 실패 서명만 작업마다 플랫폼이 검증 실패 서명을 failure 메모로 게시. 레인은 읽기만
 *
 *  - P0 기준선   작업 분해 없이 Claude Code 하나가 과제 전체를 한 번에 한다(비교 기준, `--backend claude-code` 전용)
 */
import type { PlanBackend, Topology } from '@b-studio/agent';
import type { WorkflowPageCheck } from '@b-studio/spec';

export type Strategy = 'P0' | 'S0' | 'S1' | 'S2' | 'S3' | 'S4' | 'S5';

/** 실행기가 받는 전략 전체(순서대로). P0는 작업 분해를 쓰지 않는다 */
export const STRATEGIES: readonly Strategy[] = ['P0', 'S0', 'S1', 'S2', 'S3', 'S4', 'S5'];

/** 전략 표시 이름 */
export const STRATEGY_LABELS: Record<Strategy, string> = {
  P0: '그냥 Claude Code',
  S0: 'S0 직렬화',
  S1: 'S1 격리 병렬',
  S2: 'S2 계약 먼저',
  S3: 'S3 게시판',
  S4: 'S4 통합 후 수리',
  S5: 'S5 실패 서명만',
};

export interface AcceptanceCheck {
  service: 'api' | 'web';
  path: string;
  /** 모두 들어 있어야 통과 */
  expectAll?: string[];
  /** 하나라도 들어 있으면 통과 (예: '45000' 또는 '45,000') */
  expectAny?: string[];
}

export interface BenchTask {
  id: string;
  /** 사용자가 스튜디오에 적을 법한 전체 요청. 인터페이스 세부(경로·필드 이름)를 넣지 않는다 */
  request: string;
  /** 인터페이스로 엮인 과제인지 (독립 과제는 대조군) */
  coupled: boolean;
  api: { title: string; request: string };
  web: { title: string; request: string };
  acceptance: AcceptanceCheck[];
  /** S2에서 레인 시작 전에 플랫폼이 게시하는 인터페이스 계약. web 담당이 스스로 맞춰야 할 경계를 명시한다 */
  contract: { body: string; refs: string[] };
}

export interface PlannedTask {
  id: string;
  title: string;
  request: string;
  paths: string[];
  dependsOn: string[];
  /** 이 작업을 돌릴 세션 백엔드(--lane-backend). 없으면 계획 기본(서버 모드) */
  backend?: PlanBackend;
  /** 이 작업에 고정할 모델(백엔드마다 뜻이 다르다) */
  model?: string;
}

/** 레인 그룹(첫 쓰기 경로) → 그 레인 세션의 backend·model. run.ts가 --lane-backend를 해석해 만든다 */
export type LaneBackends = ReadonlyMap<string, { backend: PlanBackend; model?: string }>;

/**
 * 과제 4개. api 요청에는 경로와 샘플 값을 적고, web 요청에는 화면 경로만 적는다(api 경로·필드 이름은 적지 않는다).
 * 이것이 실험의 핵심이다 — web 담당은 api의 인터페이스를 스스로 맞춰야 한다.
 */
export const BENCH_TASKS: BenchTask[] = [
  {
    id: 'orders-list',
    request: '주문 목록 API와 주문 목록 화면을 만들어 줘.',
    coupled: true,
    api: {
      title: '주문 목록 API',
      request:
        'GET /api/orders 가 샘플 주문 3건을 JSON 배열로 돌려주게 해 줘. 각 주문은 id, 고객 이름, 금액, 상태를 가진다. 샘플 고객 이름은 김민수, 이영희, 박철수다. 데이터베이스 없이 메모리 목록이면 된다.',
    },
    web: {
      title: '주문 목록 화면',
      request:
        '새 페이지 /orders 를 만들어 api 서버(환경 변수 API_BASE_URL)에서 주문 목록을 받아 표로 보여 줘. 서버에서 요청할 때마다 새로 받아야 한다. 홈 화면(/)은 바꾸지 않는다.',
    },
    acceptance: [
      { service: 'api', path: '/api/orders', expectAll: ['김민수'] },
      { service: 'web', path: '/orders', expectAll: ['김민수', '이영희', '박철수'] },
    ],
    contract: {
      body: 'GET /api/orders → JSON 배열. 항목: id(number), customerName(string), amount(number), status(string). 샘플 고객 이름 김민수·이영희·박철수',
      refs: ['api'],
    },
  },
  {
    id: 'order-detail',
    request: '주문 상세 API와 주문 상세 화면을 만들어 줘.',
    coupled: true,
    api: {
      title: '주문 상세 API',
      request:
        'GET /api/orders/{id} 가 id 1~3의 샘플 주문 상세를 돌려주게 해 줘. 상세에는 고객 이름, 품목 목록(이름·수량), 배송 메모가 있다. 1번 주문은 고객 김민수, 품목 사과 2개와 배 1개, 배송 메모 "문 앞에 놓아 주세요"다. 없는 id는 404. 데이터베이스 없이 메모리 데이터면 된다.',
    },
    web: {
      title: '주문 상세 화면',
      request:
        '새 페이지 /orders/[id] 를 만들어 api 서버(환경 변수 API_BASE_URL)에서 해당 주문 상세를 받아 고객 이름, 품목, 배송 메모를 보여 줘. 서버에서 요청할 때마다 새로 받아야 한다. 홈 화면(/)은 바꾸지 않는다.',
    },
    acceptance: [
      { service: 'api', path: '/api/orders/1', expectAll: ['문 앞에 놓아 주세요'] },
      { service: 'web', path: '/orders/1', expectAll: ['김민수', '문 앞에 놓아 주세요'] },
    ],
    contract: {
      body: 'GET /api/orders/{id} → JSON. 항목: customerName(string), items(배열: name(string)·quantity(number)), shippingMemo(string). 1번 주문: customerName 김민수, items 사과 2·배 1, shippingMemo "문 앞에 놓아 주세요". 없는 id는 404',
      refs: ['api'],
    },
  },
  {
    id: 'order-summary',
    request: '주문 요약 API와 요약 대시보드 화면을 만들어 줘.',
    coupled: true,
    api: {
      title: '주문 요약 API',
      request:
        'GET /api/orders/summary 가 상태별 주문 수와 총매출을 돌려주게 해 줘. 샘플 값은 결제 완료(PAID) 2건, 배송 중(SHIPPED) 1건, 총매출 45000원이다. 데이터베이스 없이 고정 값이면 된다.',
    },
    web: {
      title: '요약 대시보드 화면',
      request:
        '새 페이지 /dashboard 를 만들어 api 서버(환경 변수 API_BASE_URL)에서 주문 요약을 받아 상태별 주문 수와 총매출을 보여 줘. 서버에서 요청할 때마다 새로 받아야 한다. 홈 화면(/)은 바꾸지 않는다.',
    },
    acceptance: [
      { service: 'api', path: '/api/orders/summary', expectAny: ['45000'] },
      { service: 'web', path: '/dashboard', expectAny: ['45000', '45,000'] },
    ],
    contract: {
      body: 'GET /api/orders/summary → JSON. 항목: statusCount(상태별 건수: PAID 결제 완료 2, SHIPPED 배송 중 1), totalRevenue(총매출 45000)',
      refs: ['api'],
    },
  },
  {
    id: 'independent',
    request: '서버 시각 API와 소개 화면을 만들어 줘.',
    coupled: false,
    api: {
      title: '서버 시각 API',
      request: 'GET /api/time 이 서버의 현재 시각을 ISO 8601 문자열로 담은 JSON을 돌려주게 해 줘.',
    },
    web: {
      title: '소개 화면',
      request: '새 페이지 /about 을 만들어 "b-studio 주문 예제" 라는 문구를 보여 줘. api는 부르지 않는다. 홈 화면(/)은 바꾸지 않는다.',
    },
    acceptance: [
      { service: 'api', path: '/api/time', expectAny: ['T'] },
      { service: 'web', path: '/about', expectAll: ['b-studio 주문 예제'] },
    ],
    contract: {
      body: 'GET /api/time → JSON. 항목: time(string, ISO 8601 현재 시각)',
      refs: ['api'],
    },
  },
];

export interface PlannedPlan {
  tasks: PlannedTask[];
  coordination?: {
    strategy: 'S2' | 'S3' | 'S4' | 'S5';
    topology?: Topology;
    contracts?: Array<{ body: string; refs: string[] }>;
  };
}

/**
 * 전략별 고정 계획. 작업 id는 `${task.id}-api`·`${task.id}-web`(소문자·숫자·하이픈, 40자 이하)이고,
 * 요청 앞에 작업 표지 `[task:<id>]`를 붙여 작업 담당 모델(또는 dry 제공자)이 자기 작업을 알아본다.
 *
 * - S0 직렬화: web이 api에 의존 → 한 레인에서 api 다음 web이 차례로 돈다
 * - S1 격리 병렬: 둘 다 의존 없음 → 다른 레인에서 동시에 돈다(공유 없음)
 * - S2~S5: 레인 둘(격리 병렬)에 조율 설정을 얹는다. topology는 S3에서만 쓴다
 *
 * laneBackends(레인 그룹 → backend·model)를 주면 그 그룹의 레인 작업에 backend·model을 싣는다. 한 레인은 한 세션이라
 * 같은 레인의 작업은 같은 backend·model을 쓴다(레인 그룹이 다르므로 api·web이 각각 다르다).
 */
export function planFor(task: BenchTask, strategy: Strategy, topology: Topology = 'mesh', laneBackends?: LaneBackends): PlannedPlan {
  // P0는 작업 분해 없이 Claude Code 하나가 과제 전체를 한다(plain-baseline.ts). 레인 계획을 만들지 않는다
  if (strategy === 'P0') throw new Error('P0(그냥 Claude Code)는 작업 분해 계획을 쓰지 않습니다');

  const apiId = `${task.id}-api`;
  const webId = `${task.id}-web`;
  const coordination: PlannedPlan['coordination'] =
    strategy === 'S2'
      ? { strategy, contracts: [{ body: task.contract.body, refs: [...task.contract.refs] }] }
      : strategy === 'S3'
        ? { strategy, topology }
        : strategy === 'S4' || strategy === 'S5'
          ? { strategy }
          : undefined;
  // 레인 그룹은 작업의 첫 쓰기 경로다(laneGroup과 같은 기준). 그룹에 backend가 있으면 그 작업에 싣는다
  const withBackend = (planned: PlannedTask): PlannedTask => {
    const group = planned.paths[0];
    const choice = group ? laneBackends?.get(group) : undefined;
    return choice ? { ...planned, backend: choice.backend, ...(choice.model ? { model: choice.model } : {}) } : planned;
  };
  return {
    tasks: [
      withBackend({ id: apiId, title: task.api.title, request: `[task:${apiId}] ${task.api.request}`, paths: ['api'], dependsOn: [] }),
      withBackend({ id: webId, title: task.web.title, request: `[task:${webId}] ${task.web.request}`, paths: ['web'], dependsOn: strategy === 'S0' ? [apiId] : [] }),
    ],
    ...(coordination ? { coordination } : {}),
  };
}

/**
 * 전략이 레인에게 보여 줘야 하는 조율 도구. 프로젝트의 허용 도구 목록에 없으면 도구가 모델에게 보이지 않아
 * 전략이 실제로는 "공유 없음"(S1)과 같아진다. 그런 실행은 측정이 무의미하므로 시작 전에 막는다(E2 첫 시작에서 실제로 그랬다)
 */
export function missingCoordinationTools(strategy: Strategy, allowedTools: readonly string[] | undefined): string[] {
  const needed: Record<Strategy, string[]> = { P0: [], S0: [], S1: [], S2: ['read_notes'], S3: ['post_note', 'read_notes'], S4: [], S5: ['read_notes'] };
  if (!allowedTools) return [];
  return needed[strategy].filter((name) => !allowedTools.includes(name));
}

/**
 * 통합 게이트에만 덧붙일 확인(벤치 `--integration-checks`, 기본 꺼짐). 과제 요청에 적힌 **샘플 값**이 web 화면에
 * 보이는지 본다. E2에서 레인 경계의 필드 이름·모양 불일치가 통합 게이트를 그대로 통과한 것을 잡기 위한 것이다(#124).
 *
 * 값은 **과제를 쓴 계획자가 아는 것**만 쓴다 — 과제 요청에 적힌 고객 이름·배송 메모·총매출이다. 필드 이름은 쓰지 않는다
 * (요청이 필드 이름을 정하지 않으므로, api와 화면이 일관되게 다른 이름을 써도 앱은 정상이다). 이 값들은
 * **인수 검사(`runAcceptance`)의 기대값과 같다.** 그래서 이 확인은 "통합 게이트가 인수 검사와 같은 신호를 보게 되면
 * (게이트가 실패하면) S4 수리가 시작되는가"를 재는 것이다 — H10을 그렇게 판정한다.
 *
 * 인수 검사가 여러 값을 모두 요구하면 확인도 모두 요구한다(expectAllText). E4 첫 묶음에서 첫 값 하나만 보는 확인이
 * '김민수'는 있고 '이영희'·'박철수'가 없는 화면을 통과시켰다 — 확인이 인수 검사보다 약하면 수리할 계기를 놓친다.
 *
 * mode는 http로 둔다(web 요청이 "서버에서 요청할 때마다 새로" 받으라고 한다). 독립 과제는 api↔web을 엮지 않으므로 확인을 두지 않는다.
 */
export function integrationChecksFor(task: BenchTask): { pageChecks: WorkflowPageCheck[] } | undefined {
  switch (task.id) {
    case 'orders-list':
      return { pageChecks: [sampleValuePageCheck('/orders', { expectAllText: ['김민수', '이영희', '박철수'] })] };
    case 'order-detail':
      return { pageChecks: [sampleValuePageCheck('/orders/1', { expectAllText: ['김민수', '문 앞에 놓아 주세요'] })] };
    case 'order-summary':
      return { pageChecks: [sampleValuePageCheck('/dashboard', { expectAnyText: ['45000', '45,000'] })] };
    default:
      return undefined;
  }
}

/** web 페이지(service: web)에 과제의 샘플 값이 그려지는지 보는 http 확인 하나 */
function sampleValuePageCheck(path: string, expect: Pick<WorkflowPageCheck, 'expectAllText' | 'expectAnyText'>): WorkflowPageCheck {
  return { service: 'web', path, mode: 'http', expectStatus: 200, ...expect, allowConsoleErrors: false, noHorizontalScroll: false };
}
