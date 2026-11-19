import { readYaml, YamlReadError } from './yaml-read';
import {
  StudioSpecSchema,
  type DatabaseSpec,
  type EgressRule,
  type ExternalServiceSpec,
  type ManagedServiceSpec,
  type ResourceLimit,
  type SecretSpec,
  type StudioSpec,
} from './schema';
import type { PublicUrlRef } from './public-url';
import { decodeNative, native } from './native';

export const SPEC_FILE = 'studio.yaml';

export class SpecError extends Error {
  readonly issues: string[];

  constructor(message: string, issues: string[] = []) {
    super(issues.length > 0 ? `${message}\n${issues.map((issue) => `  - ${issue}`).join('\n')}` : message);
    this.name = 'SpecError';
    this.issues = issues;
  }
}

export interface LoadedProject {
  root: string;
  spec: StudioSpec;
  composePath: string;
  managed: Array<[name: string, service: ManagedServiceSpec]>;
  /** compose의 external 볼륨. 샌드박스끼리 공유하는 의존성 캐시(Gradle, pnpm, uv) 용도 */
  sharedVolumes: string[];
  /** compose 서비스 이름과 데이터베이스. dependents는 compose depends_on으로 이 DB에 기대는 managed 서비스 */
  databases: Array<[name: string, database: DatabaseSpec & { dependents: string[] }]>;
  /** compose 서비스 이름 → 컨테이너 한도 */
  resources: Record<string, ResourceLimit>;
  /** compose 파일의 모든 서비스 이름 (부가 서비스 포함) */
  composeServices: string[];
  /** compose 서비스 이름 → 그 서비스가 depends_on으로 기다리는 compose 서비스 이름(부가 서비스끼리의 기댐도 포함). 서비스 선택의 기본값(관리형 + 기댐 닫힘, ADR-083)을 계산할 때 쓴다 */
  dependsOn: Record<string, string[]>;
  /**
   * 이 세션에서 꺼 둔(띄우지 않는) compose 서비스 이름(ADR-083). loadProject()는 채우지 않는다(항상 undefined) —
   * 서비스 선택을 다루는 쪽(studio 서버)이 프로젝트를 불러온 뒤 세션마다 붙인다. 검증 게이트는 여기 있는 서비스를
   * 재시작·확인하지 않고 건너뛴 것으로 기록한다
   */
  offServices?: ReadonlySet<string>;
  /** 기본 패키지 저장소 외에 외부 접속을 허용할 호스트나 평문 HTTP 경로·메서드 규칙 */
  egress: EgressRule[];
  /** 시크릿 이름(컨테이너 환경 변수 이름) → 받을 서비스. 값은 들어 있지 않다 */
  secrets: Array<[name: string, secret: SecretSpec]>;
  /** 등록한 사내 API. 샌드박스에서는 이 이름의 호스트로 부르고 edge가 정책을 적용한다 */
  external: Array<[name: string, service: ExternalServiceSpec]>;
  /**
   * 런타임 공개 URL 주입(fix/frontend-backend-url). compose의 environment 값에 `${b-studio:services.<서비스>.publicUrl}`
   * 자리 표시자가 있으면 여기 담는다. 샌드박스 제공자가 띄우기 직전에 targetService의 호스트 포트를 먼저 정해(pre-allocate)
   * 이 자리를 실제 주소로 채운다(packages/sandbox/src/docker/compose-provider.ts)
   */
  publicUrlRefs: PublicUrlRef[];
}

export function parseSpec(source: string): StudioSpec {
  const result = StudioSpecSchema.safeParse(parseYaml(source, SPEC_FILE));
  if (!result.success) {
    throw new SpecError(
      `${SPEC_FILE} 형식이 올바르지 않습니다`,
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data as StudioSpec;
}

/**
 * 프로젝트 폴더를 읽어 `LoadedProject`를 만든다. 파일 경로 확인·O_NOFOLLOW 열기·크기 제한은 `bstudio-io`가,
 * studio.yaml·compose 파싱과 교차 검증은 Rust(`bstudio-guard`)가 한다. 오류는 옛 TS와 같은 `SpecError`다.
 */
export async function loadProject(dir: string): Promise<LoadedProject> {
  const result = decodeNative<{ ok: true; project: LoadedProject } | { ok: false; message: string; issues: string[] }>(await native.specLoadProject(dir));
  if (!result.ok) throw new SpecError(result.message, result.issues);
  return result.project;
}

/**
 * YAML을 해석한다. 문법 오류는 위치(줄·칸)만 담은 SpecError로 바꾼다 — yaml 라이브러리의 오류 문구에는 문제 줄의 내용이
 * 그대로 실려, 읽으면 안 되는 파일이 읽혔을 때 그 내용이 새는 길이 된다
 */
function parseYaml(source: string, label: string, options?: { merge?: boolean }): unknown {
  try {
    return readYaml(source, options);
  } catch (error) {
    if (!(error instanceof YamlReadError)) throw error;
    // 오류 글에는 문제 글자를 싣지 않는다(읽으면 안 되는 파일의 내용이 새는 길이 된다). Rust 쪽 설명은 고정된 문구다
    if (error.kind === 'unsupported') throw new SpecError(`${label}: 이 YAML 꼴은 지원하지 않습니다: ${error.detail}${error.where}`);
    throw new SpecError(`${label}의 YAML 문법이 올바르지 않습니다${error.where}: ${error.detail}`);
  }
}
