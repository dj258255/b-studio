import { z } from 'zod';

const NAME = /^[a-z][a-z0-9-]*$/;
/** 컨테이너 안에서 값을 받을 환경 변수 이름 */
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
/** 정책에서 샌드박스 서비스가 아닌 호출자: 에이전트 도구와 API 탐색기 (스튜디오 서버가 대신 부른다) */
export const STUDIO_CALLER = 'studio';

/**
 * 서비스 안의 경로. `//host/...`는 `new URL(path, base)`에서 다른 호스트를 가리키게 되므로 거부한다
 */
const SERVICE_PATH = z.string().regex(/^\/(?!\/)/, '"/"로 시작하고 "//"로 시작하지 않는 경로여야 합니다');

/** 서비스가 요청을 받을 준비가 됐는지 HTTP로 확인하는 방법 */
export const HttpProbeSchema = z.object({
  path: SERVICE_PATH,
  expectStatus: z.number().int().min(100).max(599).default(200),
  /** 첫 기동은 의존성 다운로드 때문에 오래 걸릴 수 있다 (Gradle 등) */
  timeoutSeconds: z.number().int().positive().optional(),
});

export const PreviewKindSchema = z.enum(['browser', 'openapi', 'logs']);
const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export const HttpMethodSchema = z.enum(HTTP_METHODS);

/** 서비스 폴더 안의 상대 경로 */
const RELATIVE_PATH = z
  .string()
  .min(1)
  .refine((value) => !/^([a-zA-Z]:)?[\\/]/.test(value) && !value.split(/[\\/]/).includes('..'), '서비스 폴더 안의 상대 경로여야 합니다');

/**
 * 입력 파일 내용이 같으면 다른 세션의 결과를 재사용할 수 있는 볼륨 (의존성 설치 결과, 빌드 도구 캐시).
 * 스냅샷은 출발점일 뿐이고 서비스의 설치 단계는 그대로 돌아 내용을 확인한다.
 */
export const SnapshotSchema = z.object({
  /** compose.yaml의 volumes에 선언한 샌드박스 전용 볼륨 이름 */
  volume: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/),
  /** 이 파일들의 내용이 스냅샷의 키가 된다 (서비스 폴더 기준) */
  key: z.array(RELATIVE_PATH).min(1),
});

/** 스튜디오가 코드를 만들고 샌드박스에서 실행하는 서비스 */
export const ManagedServiceSchema = z.object({
  source: z.literal('managed'),
  template: z.string().min(1),
  /** 서비스 코드 위치 (프로젝트 루트 기준) */
  path: z.string().min(1),
  /** 컨테이너 안에서 서비스가 듣는 포트 */
  port: z.number().int().min(1).max(65535),
  preview: PreviewKindSchema,
  ready: HttpProbeSchema.optional(),
  /** 실행 중인 서버에서 OpenAPI 문서를 뽑아낼 경로 (코드 우선 방식) */
  contract: z.object({ extract: SERVICE_PATH }).optional(),
  snapshots: z.array(SnapshotSchema).optional(),
});

/** `/api/users/*`: `*`는 한 경로 구간, `**`는 여러 구간 */
const PATH_PATTERN = z.string().regex(/^\/\S*$/, '"/"로 시작하고 공백이 없는 경로 패턴이어야 합니다');

/** 외부 접속 허용 호스트. IP는 이름으로 판단할 수 없으므로 받지 않는다 */
const EGRESS_HOST = z
  .string()
  .regex(/^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}$/i, 'example.com이나 *.example.com 같은 호스트 이름이어야 합니다');

export const PolicyRuleSchema = z.object({
  /** 부를 수 있는 쪽: compose 서비스 이름이나 studio(에이전트 도구·API 탐색기) */
  callers: z.array(z.string().regex(NAME)).min(1),
  methods: z.array(HttpMethodSchema).min(1),
  paths: z.array(PATH_PATTERN).min(1).default(['/**']),
});

export const EgressRuleSchema = z.union([
  EGRESS_HOST,
  z.object({
    host: EGRESS_HOST,
    methods: z.array(HttpMethodSchema).min(1).default(['GET', 'HEAD']),
    paths: z.array(PATH_PATTERN).min(1).default(['/**']),
  }),
]);

/** 등록한 API를 샌드박스에서 부를 때 edge가 적용하는 정책 */
export const ExternalPolicySchema = z.object({
  /** 적지 않으면 모든 호출자에게 GET·HEAD만 허용한다. 적으면 적은 규칙만 허용한다 */
  allow: z.array(PolicyRuleSchema).optional(),
  /** 응답 JSON에서 값을 가릴 필드 이름 (대소문자 무시, 어느 깊이든) */
  mask: z.array(z.string().min(1)).default([]),
  /**
   * 필드 이름이 아니라 값의 형태로 가린다. 자유 텍스트(메모, 설명) 안에 든 개인정보를 위해서다.
   * studio.yaml은 에이전트가 고칠 수 있는 파일이므로 임의 정규식은 받지 않고 정해 둔 이름만 받는다
   */
  maskPatterns: z.array(z.enum(['phone', 'email', 'residentNumber', 'card'])).default([]),
  /** edge가 요청에 붙이는 인증 헤더. 값은 secrets에 선언한 시크릿이며 샌드박스 서비스에는 들어가지 않는다 */
  auth: z
    .object({
      header: z.string().regex(/^[A-Za-z0-9-]+$/, 'HTTP 헤더 이름이어야 합니다'),
      secret: z.string().regex(ENV_NAME),
      prefix: z.string().default(''),
    })
    .optional(),
});

/** 이미 운영 중인 API를 등록만 하는 서비스 (TOI 방식). 샌드박스에서는 edge의 정책 프록시로만 부른다 */
export const ExternalServiceSchema = z.object({
  source: z.literal('external'),
  baseUrl: z
    .url()
    .refine((value) => /^https?:\/\//.test(value), 'http나 https 주소여야 합니다')
    // studio.yaml은 저장소에 커밋되므로 자격 증명은 policy.auth와 secrets로만 받는다
    .refine((value) => URL.canParse(value) && !new URL(value).username && !new URL(value).password, '주소에 자격 증명을 넣지 말고 policy.auth와 secrets를 쓰세요'),
  preview: PreviewKindSchema.exclude(['browser']).default('openapi'),
  contract: z.object({ url: z.url() }).optional(),
  // 기본값은 다시 파싱되지 않으므로 모든 필드를 적는다
  policy: ExternalPolicySchema.default({ mask: [], maskPatterns: [] }),
});

export const ServiceSchema = z.discriminatedUnion('source', [ManagedServiceSchema, ExternalServiceSchema]);

/** 컨테이너 한도. memory는 docker 표기(512m, 1.5g), cpus는 CPU 개수 */
export const ResourceLimitSchema = z
  .object({
    memory: z
      .string()
      .regex(/^\d+(\.\d+)?[kmg]$/i, '512m, 1.5g 같은 docker 메모리 표기여야 합니다')
      .optional(),
    cpus: z.number().positive().max(64).optional(),
  })
  .refine((limit) => limit.memory !== undefined || limit.cpus !== undefined, 'memory나 cpus 중 하나는 적어야 합니다');

/** SQL 식별자. 셸을 거치지 않더라도 SQL 문에 들어가므로 좁게 허용한다 */
const SQL_IDENTIFIER = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/, 'SQL 식별자(영문, 숫자, 밑줄)여야 합니다');

/**
 * 샌드박스와 함께 뜨는 개발용 데이터베이스. 체크포인트마다 상태를 저장해,
 * 파일을 되돌릴 때 스키마와 데이터도 같은 시점으로 되돌린다.
 */
export const DatabaseSchema = z.object({
  engine: z.literal('postgres'),
  database: SQL_IDENTIFIER,
  /** 데이터베이스를 지우고 다시 만들 권한이 있어야 한다 */
  user: SQL_IDENTIFIER,
});

/**
 * 샌드박스 서비스에 넣을 시크릿. 값은 프로젝트가 아니라 스튜디오 서버의 환경 변수나 시크릿 파일에서 읽고,
 * 샌드박스에서 나오는 로그·명령 출력·응답에서는 가린다.
 */
export const SecretSchema = z.object({
  /** 이 값을 같은 이름의 환경 변수로 받을 compose 서비스. 외부 API 인증에만 쓰는 시크릿은 비워 둔다 */
  services: z.array(z.string().regex(NAME)).default([]),
  description: z.string().optional(),
});

/** 운영 배포 설정. managed 서비스마다 운영 이미지를 빌드할 Dockerfile과 운영 주소로 공개할 루프백 포트 */
export const DeploySchema = z.object({
  services: z
    .record(
      z.string().regex(NAME),
      z.object({
        /** compose build.context 기준 경로. 개발용 Dockerfile.dev와 따로 둔다 */
        dockerfile: RELATIVE_PATH.default('Dockerfile'),
        /** 운영 프록시가 이 서비스를 공개할 127.0.0.1의 포트. 없으면 첫 배포 때 빈 포트를 골라 기억한다 */
        port: z.number().int().min(1024).max(65535).optional(),
      }),
    )
    .default({}),
});

/** 에이전트가 작업을 끝냈다고 주장해도 스튜디오가 순서대로 확인할 개발 단계 */
export const WorkflowStageSchema = z.enum([
  'plan',
  'implement',
  'run',
  'browser_check',
  'contract_check',
  'test',
  'review',
  'checkpoint',
]);

/** test 단계에서 플랫폼이 서비스 컨테이너 안에서 직접 실행하는 명령. 종료 코드 0이어야 통과 */
export const WorkflowTestSchema = z.object({
  name: z.string().regex(NAME),
  service: z.string().regex(NAME),
  command: z.array(z.string().min(1)).min(1),
  /** 불안정한 테스트를 몇 번까지 다시 돌릴지. 재시도 횟수는 결과에 남는다 */
  maxAttempts: z.number().int().min(1).max(3).default(1),
});

/**
 * browser_check의 browser 모드에서 페이지를 연 뒤 순서대로 실행할 동작 하나.
 * 화면 확인이 코드 실행 경로가 되지 않도록 정해 둔 네 동작만 받고, 각 단계는 정확히 하나의 동작을 가져야 한다.
 */
export const WorkflowPageStepSchema = z
  .object({
    /** Playwright 선택자. 클릭한다 */
    click: z.string().min(1).optional(),
    /** Playwright 선택자를 입력칸에 채운다 */
    fill: z.object({ selector: z.string().min(1), text: z.string() }).optional(),
    /** 키보드를 누른다 (예: Enter) */
    press: z.string().min(1).optional(),
    /** Playwright 선택자가 나타날 때까지 기다린다 */
    waitFor: z.string().min(1).optional(),
  })
  .superRefine((step, ctx) => {
    const actions = [step.click, step.fill, step.press, step.waitFor].filter((value) => value !== undefined);
    if (actions.length !== 1) {
      ctx.addIssue({ code: 'custom', message: '단계에는 click, fill, press, waitFor 중 정확히 하나를 적어야 합니다' });
    }
  });

const PAGE_STEPS_MAX = 10;

/**
 * browser_check 단계에서 재시작한 서비스의 화면을 확인한다.
 * http는 응답 상태와 본문 문구만 보고, browser는 헤드리스 Chromium으로 렌더링해 스크립트 예외·console.error·가로 넘침까지 본다
 */
export const WorkflowPageCheckSchema = z
  .object({
    service: z.string().regex(NAME),
    path: SERVICE_PATH,
    mode: z.enum(['http', 'browser']).default('http'),
    expectStatus: z.number().int().min(100).max(599).default(200),
    /** http는 응답 본문, browser는 렌더링된 화면 텍스트에 들어 있어야 하는 문구. browser에서는 단계를 모두 마친 뒤의 화면을 본다 */
    expectText: z.string().min(1).optional(),
    /** browser 전용. 페이지를 연 뒤 순서대로 실행할 상호작용. 정해 둔 네 동작만 받는다 */
    steps: z.array(WorkflowPageStepSchema).max(PAGE_STEPS_MAX, `단계는 최대 ${PAGE_STEPS_MAX}개까지 쓸 수 있습니다`).optional(),
    /** browser 전용. 모바일 화면처럼 창 크기를 정해 확인한다 */
    viewport: z.object({ width: z.number().int().min(240).max(3840), height: z.number().int().min(240).max(3840) }).optional(),
    /** browser 전용. 기본은 console.error나 실패한 요청(4xx·5xx·연결 실패, 자동 favicon 제외)이 하나라도 있으면 실패 */
    allowConsoleErrors: z.boolean().default(false),
    /** browser 전용. 문서가 창보다 넓어 가로 스크롤이 생기면 실패 */
    noHorizontalScroll: z.boolean().default(false),
  })
  .superRefine((check, ctx) => {
    if (check.mode === 'browser') return;
    // http 모드에서 무시되는 옵션을 받으면 검사한 것처럼 보이기만 한다
    if (check.steps) ctx.addIssue({ code: 'custom', path: ['steps'], message: 'steps는 mode: browser에서만 쓸 수 있습니다' });
    if (check.viewport) ctx.addIssue({ code: 'custom', path: ['viewport'], message: 'viewport는 mode: browser에서만 쓸 수 있습니다' });
    if (check.noHorizontalScroll) ctx.addIssue({ code: 'custom', path: ['noHorizontalScroll'], message: 'noHorizontalScroll은 mode: browser에서만 쓸 수 있습니다' });
    if (check.allowConsoleErrors) ctx.addIssue({ code: 'custom', path: ['allowConsoleErrors'], message: 'allowConsoleErrors는 mode: browser에서만 쓸 수 있습니다' });
  });

/** 모델 프롬프트가 아니라 실행기에서 적용하는 프로젝트별 워크플로 정책 */
export const WorkflowSchema = z
  .object({
    /** 생략하면 현재 b-studio 기본 검증 흐름을 사용한다 */
    required: z.array(WorkflowStageSchema).min(1).optional(),
    /** required에 test를 넣으면 최소 하나가 필요하다 */
    tests: z.array(WorkflowTestSchema).optional(),
    /** required에 browser_check를 넣으면 최소 하나가 필요하다 */
    pageChecks: z.array(WorkflowPageCheckSchema).optional(),
    /** review 단계에서 한 번의 요청이 바꿀 수 있는 파일 수 상한. 넘으면 나눠서 요청하게 한다 */
    maxChangedFiles: z.number().int().min(1).optional(),
    /** 이 목록 밖의 도구는 모델이 요청해도 실행하지 않는다 */
    allowedTools: z.array(z.string().min(1)).min(1).optional(),
    /** 명령의 첫 토큰부터 비교하는 추가 차단 목록 */
    deniedCommands: z.array(z.string().min(1)).optional(),
    /** 파일 변경·서비스 실행 전에 사람 승인을 요구할 도구 */
    requireApprovalFor: z.array(z.string().min(1)).optional(),
    /** 에이전트가 변경할 수 없는 프로젝트 상대 경로 접두사 */
    protectedPaths: z.array(RELATIVE_PATH).optional(),
    /** 배포할 체크포인트가 통과했어야 하는 단계. checkpoint만 두면(기본) 모든 체크포인트를 배포할 수 있다 */
    releaseRequires: z.array(WorkflowStageSchema).min(1).optional(),
  })
  // 실행할 수단이 없는 단계를 필수로 두면 "선언은 됐지만 한 번도 돌지 않은" 단계가 통과처럼 보인다. 불러올 때 막는다
  .superRefine((workflow, ctx) => {
    const required = new Set(workflow.required ?? []);
    if (required.has('test') && !workflow.tests?.length) {
      ctx.addIssue({ code: 'custom', path: ['tests'], message: 'required에 test가 있으면 실행할 tests가 최소 1개 필요합니다' });
    }
    if (required.has('browser_check') && !workflow.pageChecks?.length) {
      ctx.addIssue({ code: 'custom', path: ['pageChecks'], message: 'required에 browser_check가 있으면 확인할 pageChecks가 최소 1개 필요합니다' });
    }
    const names = new Set<string>();
    workflow.tests?.forEach((test, index) => {
      if (names.has(test.name)) ctx.addIssue({ code: 'custom', path: ['tests', index, 'name'], message: `테스트 이름 '${test.name}'이 중복됩니다` });
      names.add(test.name);
    });
  });

export const StudioSpecSchema = z.object({
  version: z.literal(1),
  name: z.string().regex(NAME),
  /** 실행은 표준 compose 파일에 맡기고, studio.yaml은 스튜디오 전용 정보만 담는다 */
  compose: z.string().default('compose.yaml'),
  services: z
    .record(z.string().regex(NAME), ServiceSchema)
    .refine((services) => Object.keys(services).length > 0, '서비스가 최소 1개 필요합니다'),
  /** compose 서비스 이름 → 데이터베이스 */
  databases: z.record(z.string().regex(NAME), DatabaseSchema).optional(),
  /** compose 서비스 이름 → 컨테이너 한도. 한 샌드박스가 Docker VM 자원을 다 써서 다른 세션까지 멈추지 않게 한다 */
  resources: z.record(z.string().regex(NAME), ResourceLimitSchema).optional(),
  network: z
    .object({
      /** 기본 패키지 저장소 외에 샌드박스에서 HTTP(S)로 접속을 허용할 호스트나 평문 HTTP 경로·메서드 규칙. `*.example.com`은 하위 도메인 */
      egress: z.array(EgressRuleSchema).default([]),
    })
    .optional(),
  /** 환경 변수 이름 → 받을 서비스 */
  secrets: z.record(z.string().regex(ENV_NAME, '대문자, 숫자, 밑줄로 된 환경 변수 이름이어야 합니다'), SecretSchema).optional(),
  deploy: DeploySchema.optional(),
  /** Pi·Claude·API 에이전트에 공통으로 적용하는 실행 정책 */
  workflow: WorkflowSchema.optional(),
  repository: z
    .object({
      /**
       * 이 폴더가 모노레포의 하위 폴더일 때 켠다. 상위 Git 저장소 전체를 복제해 세션 브랜치로 작업하고 PR을 만든다.
       * 끄면(기본) 저장소 루트가 아닌 폴더는 복사본으로 시작하고 원격 연동이 없다
       */
      monorepo: z.boolean().default(false),
    })
    .optional(),
});

export type HttpProbe = z.infer<typeof HttpProbeSchema>;
export type SnapshotSpec = z.infer<typeof SnapshotSchema>;
export type DatabaseSpec = z.infer<typeof DatabaseSchema>;
export type ResourceLimit = z.infer<typeof ResourceLimitSchema>;
export type SecretSpec = z.infer<typeof SecretSchema>;
export type DeploySpec = z.infer<typeof DeploySchema>;
export type DeployServiceSpec = DeploySpec['services'][string];
export type WorkflowStage = z.infer<typeof WorkflowStageSchema>;
export type WorkflowSpec = z.infer<typeof WorkflowSchema>;
export type WorkflowTest = z.infer<typeof WorkflowTestSchema>;
export type WorkflowPageStep = z.infer<typeof WorkflowPageStepSchema>;
export type WorkflowPageCheck = z.infer<typeof WorkflowPageCheckSchema>;
export type PolicyRule = z.infer<typeof PolicyRuleSchema>;
export type ExternalPolicy = z.infer<typeof ExternalPolicySchema>;
export type EgressRule = z.infer<typeof EgressRuleSchema>;
export type PreviewKind = z.infer<typeof PreviewKindSchema>;
export type ManagedServiceSpec = z.infer<typeof ManagedServiceSchema>;
export type ExternalServiceSpec = z.infer<typeof ExternalServiceSchema>;
export type ServiceSpec = z.infer<typeof ServiceSchema>;
export type StudioSpec = z.infer<typeof StudioSpecSchema>;
