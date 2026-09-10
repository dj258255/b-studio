import { z } from 'zod';

const NAME = /^[a-z][a-z0-9-]*$/;

/** 서비스가 요청을 받을 준비가 됐는지 HTTP로 확인하는 방법 */
export const HttpProbeSchema = z.object({
  path: z.string().startsWith('/'),
  expectStatus: z.number().int().min(100).max(599).default(200),
  /** 첫 기동은 의존성 다운로드 때문에 오래 걸릴 수 있다 (Gradle 등) */
  timeoutSeconds: z.number().int().positive().optional(),
});

export const PreviewKindSchema = z.enum(['browser', 'openapi', 'logs']);

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
  contract: z.object({ extract: z.string().startsWith('/') }).optional(),
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
export type PreviewKind = z.infer<typeof PreviewKindSchema>;
export type ManagedServiceSpec = z.infer<typeof ManagedServiceSchema>;
export type ExternalServiceSpec = z.infer<typeof ExternalServiceSchema>;
export type ServiceSpec = z.infer<typeof ServiceSchema>;
export type StudioSpec = z.infer<typeof StudioSpecSchema>;
