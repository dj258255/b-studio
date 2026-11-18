import { createRequire } from 'node:module';

/**
 * Rust로 옮긴 spec의 판정·읽기(crates/bstudio-guard, ADR-195 4e 뒤 3단계 (a)). sandbox와 같은 `.node` 파일을 싣는다
 * (spec은 sandbox에 의존할 수 없다: sandbox가 spec에 의존한다). createRequire는 경로를 기준으로 한 번만 실으므로
 * 두 패키지가 같은 모듈을 쓴다. 저장소 루트의 `pnpm build:native`가 만든다.
 *
 * 불러오지 못하면 던진다. TS로 대신하는 길을 두지 않는다 — 두 구현이 함께 있으면 같은 입력을 다르게 읽는 자리가 생긴다.
 * 옛 TS 구현은 `*-legacy.ts`로 남겨 차등 시험만 그것을 import한다.
 */
export interface NativeSpec {
  yamlParse(text: string, merge: boolean): { kind: 'value' | 'syntax' | 'unsupported'; json?: string | null; message?: string | null; line: number; col: number };

  serviceDependencyClosure(roots: string[], graphJson: string): string[];
  serviceDefaultSelection(roots: string[], graphJson: string): string[];
  serviceDependentsOf(name: string, selected: string[], graphJson: string): string[];
  serviceNewlyAdded(known: string[], composeServices: string[]): string[];

  publicUrlFindRefs(servicesJson: string): string;

  systemPackageDetectFamily(image: string): string | null;
  /** 옛 `SystemPackageError`와 같은 글자로 던진다 */
  systemPackageApply(dockerfile: string, packages: string[]): string;

  composeEngineOfImage(image: string): string | null;
  composeIsProdComposeFile(fileName: string): boolean;
  composeImportSupportingServices(composeText: string, sourceFile: string): string;
  composeSanitizeServiceName(value: string): string;
  composeSanitizeSqlIdentifier(value: string): string;
  composeProposePostgresService(database: string, reason: string, serviceName: string): string;
  composeSuggestsPostgresNeed(template: string, dependencyText: string): boolean;
  composeDetectEnvReferences(configText: string): string;
  composeDatabaseCredentialsFor(engine: string, environmentJson: string): string | null;
  composeNeedsDevDefaultCredentials(engine: string, environmentJson: string): boolean;
  composeWithDevDefaultCredentials(serviceJson: string, note: string): string;
  composeWithDefaultHealthcheck(serviceJson: string): string;
  composeWireAppEnvironment(template: string, refsJson: string, infraJson: string): string;
  composeDatabaseSpecFor(engine: string, environmentJson: string): string | null;
  composeSuffixFromUrlValue(value: string): string;
  composeDetectBackendUrlEnvFromEnvironment(environmentJson: string): string | null;
  composeDetectBackendUrlEnvFromCode(sourceText: string): string | null;
  composeDetectServerBackendUrlEnvFromCode(sourceText: string): string | null;
  composeDetectBackendUrlEnvFromAssignments(text: string): string | null;
  composeEnvironmentFromComposeText(composeText: string, serviceName: string): string | null;
  composeOriginalComposeServiceFor(composeText: string, servicePath: string, serviceName: string): string | null;
  composeCorsEnvironmentFrom(environmentJson: string): string;
  composeFrontendBackendEnvName(name: string): boolean;
}

function load(): NativeSpec {
  try {
    return createRequire(import.meta.url)('../../sandbox/native/bstudio_node.node') as NativeSpec;
  } catch (error) {
    throw new Error(`b-studio 네이티브 모듈을 불러오지 못했습니다. 저장소 루트에서 pnpm build:native 를 실행하세요: ${(error as Error).message}`);
  }
}

export const native: NativeSpec = load();

/** 옛 이름(YAML 읽기만 쓰던 때). 같은 모듈이다 */
export const nativeYaml: NativeSpec = native;

/** `NaN`·`Infinity`·`-0`은 JSON으로 쓸 수 없어 NUL로 시작하는 키 하나짜리 객체로 주고받는다(crates/bstudio-guard/src/js_json.rs) */
const NONFINITE_KEY = '\u0000nf';

/**
 * Rust로 보낼 JSON. 유한하지 않은 수와 -0은 표시 객체로 쓴다. 데이터의 객체가 NUL로 시작하는 키를 가지면 던진다.
 * sandbox의 같은 함수와 같은 규칙이다(spec은 sandbox에 의존할 수 없어 한 벌 더 둔다)
 */
export function encodeNative(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === 'number' && (!Number.isFinite(item) || Object.is(item, -0))) return { [NONFINITE_KEY]: Object.is(item, -0) ? '-0' : String(item) };
    if (item !== null && typeof item === 'object' && !Array.isArray(item) && Object.keys(item).some((key) => key.startsWith('\u0000'))) {
      throw new Error('NUL로 시작하는 키는 Rust 판정으로 보낼 수 없습니다');
    }
    return item;
  });
}

/** Rust가 보낸 JSON. 표시 객체를 `NaN`·`Infinity`·`-0`으로 되돌린다 */
export function decodeNative<T>(text: string): T {
  return JSON.parse(text, (_key, item: unknown) => {
    if (item !== null && typeof item === 'object' && !Array.isArray(item) && NONFINITE_KEY in item) return Number((item as Record<string, string>)[NONFINITE_KEY]);
    return item;
  }) as T;
}
