import { z } from 'zod';

const NAME = /^[a-z][a-z0-9-]*$/;

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

/** 이미 운영 중인 API를 등록만 하는 서비스 (TOI 방식) */
export const ExternalServiceSchema = z.object({
  source: z.literal('external'),
  baseUrl: z.url(),
  preview: PreviewKindSchema.exclude(['browser']).default('openapi'),
  contract: z.object({ url: z.url() }).optional(),
});

export const ServiceSchema = z.discriminatedUnion('source', [ManagedServiceSchema, ExternalServiceSchema]);

export const StudioSpecSchema = z.object({
  version: z.literal(1),
  name: z.string().regex(NAME),
  /** 실행은 표준 compose 파일에 맡기고, studio.yaml은 스튜디오 전용 정보만 담는다 */
  compose: z.string().default('compose.yaml'),
  services: z
    .record(z.string().regex(NAME), ServiceSchema)
    .refine((services) => Object.keys(services).length > 0, '서비스가 최소 1개 필요합니다'),
});

export type HttpProbe = z.infer<typeof HttpProbeSchema>;
export type SnapshotSpec = z.infer<typeof SnapshotSchema>;
export type PreviewKind = z.infer<typeof PreviewKindSchema>;
export type ManagedServiceSpec = z.infer<typeof ManagedServiceSchema>;
export type ExternalServiceSpec = z.infer<typeof ExternalServiceSchema>;
export type ServiceSpec = z.infer<typeof ServiceSchema>;
export type StudioSpec = z.infer<typeof StudioSpecSchema>;
