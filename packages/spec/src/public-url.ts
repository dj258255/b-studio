/**
 * 런타임 공개 URL 주입(fix/frontend-backend-url). 폴더 열기로 들여온 풀스택 프로젝트는 프론트엔드가 백엔드 주소를
 * `NEXT_PUBLIC_API_BASE_URL=http://localhost:8080` 같은 값으로 받는데, 샌드박스에서는 백엔드가 무작위 호스트 포트로
 * 뜨므로(edge 프록시가 공개하는 포트는 `docker compose up` 뒤에만 안다) 그 값이 전혀 다른 주소가 돼 버린다.
 *
 * 그래서 compose.b-studio.yaml에는 실제 값 대신 자리 표시자 `${b-studio:services.<서비스>.publicUrl}`을 적어 두고,
 * 샌드박스가 띄우기 직전(packages/sandbox/src/docker)에 그 서비스의 호스트 포트를 먼저 정해(pre-allocate) 실제 주소로
 * 바꿔 넣는다. 이 파일은 그 자리 표시자의 문법과 찾기·채우기 순수 함수만 둔다(Docker를 모른다 — 어느 샌드박스
 * 제공자든 같은 규칙을 쓸 수 있게 한다).
 *
 * 자리 표시자 문법은 일부러 `${VAR}` / `${VAR:-default}`처럼 docker compose가 아는 모양이 아니게 골랐다. compose의
 * 치환 규칙은 중괄호 안이 셸 변수 이름(영문·숫자·_로 시작)이어야 하는데 `b-studio:services.backend.publicUrl`은
 * 콜론·점·하이픈이 섞여 있어 그 규칙에 맞지 않는다. compose는 모양이 안 맞는 `${...}`는 건드리지 않고 그대로
 * 둔다(치환 실패로 보지 않는다) — 그래서 compose에 넘기기 전에 우리가 직접 바꿔 넣어야 한다.
 */

/** 자리 표시자 안의 서비스 이름 문법. studio.yaml 서비스 이름 규칙(소문자로 시작, 소문자·숫자·-)과 같다 */
const SERVICE_NAME = '[a-z][a-z0-9-]*';

/** 자리 표시자를 값 하나에서 여러 번 찾을 수 있어 전역 플래그를 쓴다. exec()를 거듭 부를 때마다 lastIndex가 섞이지 않게 쓰는 자리에서 새로 만든다 */
function pattern(): RegExp {
  return new RegExp(`\\$\\{b-studio:services\\.(${SERVICE_NAME})\\.publicUrl\\}`, 'g');
}

/** 자리 표시자를 만든다. 프로젝트가 생성하는 compose.b-studio.yaml에 이 문자열을 그대로 적는다 */
export function publicUrlPlaceholder(service: string): string {
  return `\${b-studio:services.${service}.publicUrl}`;
}

/** 값에 자리 표시자가 있으면 true */
export function hasPublicUrlPlaceholder(value: string): boolean {
  return pattern().test(value);
}

/** 값 안의 모든 자리 표시자를 resolve가 돌려주는 주소로 바꾼다. 자리 표시자가 없으면 값을 그대로 돌려준다 */
export function resolvePublicUrlPlaceholders(value: string, resolve: (service: string) => string): string {
  return value.replace(pattern(), (_match, service: string) => resolve(service));
}

/** compose 서비스 하나의 environment 값(문자열만) 중 자리 표시자가 있는 항목 하나 */
export interface PublicUrlRef {
  /** 자리 표시자가 들어 있는 compose 서비스 이름(보통 프론트엔드) */
  service: string;
  /** 그 서비스의 환경 변수 이름 */
  envKey: string;
  /** 원래 값 전체(자리 표시자 + 접미사, 예: "${b-studio:services.backend.publicUrl}/api") */
  template: string;
  /** 자리 표시자가 가리키는 서비스 이름(보통 백엔드). 값 하나에 자리 표시자가 여럿이면 첫 번째만 본다 */
  targetService: string;
}

/** compose의 environment 항목(목록 "KEY=value" 또는 맵 { KEY: value })에서 문자열 값만 꺼낸다 */
function stringEnvEntries(value: unknown): Array<[string, string]> {
  if (Array.isArray(value)) {
    const out: Array<[string, string]> = [];
    for (const entry of value) {
      if (typeof entry !== 'string') continue;
      const eq = entry.indexOf('=');
      if (eq === -1) continue;
      out.push([entry.slice(0, eq), entry.slice(eq + 1)]);
    }
    return out;
  }
  if (value && typeof value === 'object') {
    const out: Array<[string, string]> = [];
    for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
      if (typeof raw === 'string') out.push([key, raw]);
    }
    return out;
  }
  return [];
}

/**
 * 파싱한 compose의 services 전체(`Record<서비스, unknown>`)에서 자리 표시자가 있는 environment 값을 모두 찾는다.
 * 순수 함수라 compose 파일을 읽는 일은 호출자가 한다(packages/spec/src/load.ts).
 */
export function findPublicUrlRefs(services: Record<string, unknown>): PublicUrlRef[] {
  const refs: PublicUrlRef[] = [];
  for (const [service, raw] of Object.entries(services)) {
    const def = raw as { environment?: unknown } | null;
    if (!def || typeof def !== 'object') continue;
    for (const [envKey, template] of stringEnvEntries(def.environment)) {
      const match = pattern().exec(template);
      if (match) refs.push({ service, envKey, template, targetService: match[1]! });
    }
  }
  return refs;
}
