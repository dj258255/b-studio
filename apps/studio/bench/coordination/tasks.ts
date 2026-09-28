/**
 * 협업 벤치마크 과제 정의와 전략별 고정 계획.
 *
 * 계획은 과제마다 고정한다. 모델이 레인을 어떻게 나누느냐가 섞이면 전략(S0/S1) 차이를 잴 수 없기 때문이다.
 * 여기서 만든 계획은 프록시가 계획 요청에 그대로 돌려준다.
 */

export type Strategy = 'S0' | 'S1';

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
}

export interface PlannedTask {
  id: string;
  title: string;
  request: string;
  paths: string[];
  dependsOn: string[];
}

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
  },
];

/**
 * 전략별 고정 계획. 작업 id는 `${task.id}-api`·`${task.id}-web`(소문자·숫자·하이픈, 40자 이하)이고,
 * 요청 앞에 작업 표지 `[task:<id>]`를 붙여 작업 담당 모델(또는 dry 제공자)이 자기 작업을 알아본다.
 *
 * - S0 직렬화: web이 api에 의존 → 한 레인에서 api 다음 web이 차례로 돈다
 * - S1 격리 병렬: 둘 다 의존 없음 → 다른 레인에서 동시에 돈다
 */
export function planFor(task: BenchTask, strategy: Strategy): { tasks: PlannedTask[] } {
  const apiId = `${task.id}-api`;
  const webId = `${task.id}-web`;
  return {
    tasks: [
      { id: apiId, title: task.api.title, request: `[task:${apiId}] ${task.api.request}`, paths: ['api'], dependsOn: [] },
      { id: webId, title: task.web.title, request: `[task:${webId}] ${task.web.request}`, paths: ['web'], dependsOn: strategy === 'S0' ? [apiId] : [] },
    ],
  };
}
