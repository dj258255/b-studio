/**
 * 소스 파일의 import를 거꾸로 따라가 "이 파일을 쓰는 page 파일"을 찾는다(ADR-154, 게이트 자동 화면 확인용).
 *
 * 왜 필요한가: 자동 화면 확인은 바뀐 page 파일만 열어서, 컴포넌트·유틸만 고친 실행은 그 화면을 한 번도 열지 않은 채 통과했다.
 * 여기서는 서비스 폴더의 소스를 읽어 "파일 → 그 파일을 import하는 파일" 그래프를 만들고, 바뀐 파일에서 page까지 거슬러 올라간다.
 *
 * 타입스크립트 컴파일러나 번들러를 쓰지 않는 **가벼운 근사**다(새 의존성 없음). 판정(토큰 분해·별칭 풀기·그래프·추적)은 Rust
 * (`crates/bstudio-guard/src/import_graph.rs`, ADR-191 3단계 3b)에 있고, 여기에는 같은 이름의 껍데기와 파일 읽는 순서(`collectImportGraph`)만 남았다. 한계:
 *  - import 문은 토큰 단위로 읽는다. 주석·문자열·템플릿 리터럴 안의 `import …`는 무시하지만, 정규식 리터럴과 JSX 글자 속 따옴표는
 *    경험칙으로만 구분한다(따옴표 문자열은 한 줄을 넘지 않는다고 보고, 닫히지 않으면 그 한 줄만 버린다).
 *  - 경로 별칭은 서비스의 tsconfig.json·jsconfig.json(`extends`는 서비스 안의 상대 경로 한 단계만)의 `paths`·`baseUrl`만 푼다.
 *    못 읽으면 `@/`·`~/`를 서비스 루트와 `src/`로 시도한다. 와일드카드는 패턴당 `*` 하나만 지원한다.
 *  - 변수로 만든 동적 import(`import(name)`), `require` 안의 표현식, 번들러 전용 별칭(webpack `resolve.alias`)은 따라가지 못한다.
 *  - css·json·이미지 import는 그래프에 넣지 않는다(소스 확장자 ts·tsx·js·jsx·mjs·mdx만).
 *  - 서비스 폴더 밖으로 나가는 경로(`..` 탈출)는 따라가지 않는다. 심볼릭 링크는 Workspace가 막는다.
 */


import { decodeNative, encodeNative, native } from '@b-studio/sandbox';

/** 읽지 않는 디렉터리. node_modules·.next·build 같은 것은 Workspace도 막지만 여기서도 걸러 호출 수를 아낀다 */
const SKIPPED_DIRS = new Set([
  'node_modules',
  '.next',
  '.git',
  '.turbo',
  '.vercel',
  'dist',
  'build',
  'out',
  'coverage',
  'storybook-static',
  '__tests__',
  'e2e',
  'cypress',
  'playwright-report',
  'test-results',
]);

/** 서비스 기준 상대 경로가 page 파일인지 */
export function isPageFileInService(relative: string): boolean {
  return native.importGraphIsPageFile(relative);
}

/** 서비스 기준 상대 경로가 layout·loading·error 같은 app 라우터 특수 파일이면 그 폴더(서비스 기준)를 돌려준다 */
export function routeWrapperFolder(relative: string): string | undefined {
  return native.importGraphRouteWrapperFolder(relative) ?? undefined;
}

/** 소스 파일 하나를 읽을 때 쓰는 확장자 판정. `.d.ts`와 테스트·스토리 파일은 뺀다 */
export function isGraphSourceFile(relative: string): boolean {
  return native.importGraphIsSourceFile(relative);
}

// ───────────────────────── import 추출 ─────────────────────────

export type Token = { t: 'str'; v: string; template: boolean } | { t: 'word'; v: string } | { t: 'p'; v: string };

/**
 * 소스를 토큰으로 자른다. 주석은 버리고 문자열은 통째로 하나의 토큰이 되므로, 주석·문자열 속의 `import …`는 문장으로 읽히지 않는다.
 * 따옴표 문자열은 줄바꿈에서 끝난 것으로 본다 — JSX 글자(`Don't`)의 따옴표가 뒤쪽 import를 삼키지 못하게 하려는 것이다.
 */
export function tokenize(source: string): Token[] {
  // Rust 쪽 토큰: ["s", 값, 템플릿 여부] · ["w", 단어] · ["p", UTF-16 코드 단위] · ["r"](정규식 리터럴)
  const rows = decodeNative<Array<[string, string | number, boolean?]>>(native.importGraphTokenize(source));
  return rows.map((row): Token => {
    if (row[0] === 's') return { t: 'str', v: row[1] as string, template: row[2] === true };
    if (row[0] === 'w') return { t: 'word', v: row[1] as string };
    if (row[0] === 'p') return { t: 'p', v: String.fromCharCode(row[1] as number) };
    return { t: 'p', v: '/re/' };
  });
}

/**
 * 소스에서 import한 모듈 지정자를 모두 뽑는다: `import x from '…'`, `import '…'`, `import type …`, `export … from '…'`,
 * `import('…')`(문자열·보간 없는 템플릿), `require('…')`. 주석·문자열 안의 가짜 import는 무시한다.
 */
export function extractImportSpecifiers(source: string): string[] {
  return native.importGraphExtractSpecifiers(source);
}

// ───────────────────────── 경로 풀기 ─────────────────────────

/** tsconfig/jsconfig에서 읽은 경로 별칭 설정. 모든 경로는 서비스 폴더 기준 상대 경로다 */
export interface AliasConfig {
  /** `compilerOptions.baseUrl`. 없으면 undefined */
  baseUrl?: string;
  /** `paths` 항목. targets는 baseUrl(없으면 설정 파일 폴더) 기준이었던 것을 서비스 기준으로 바꿔 둔다 */
  paths: Array<{ pattern: string; targets: string[] }>;
}

/** 서비스 기준 경로를 정규화한다(`a/./b/../c` → `a/c`). 서비스 밖으로 나가면 undefined */
export function normalizeServicePath(value: string): string | undefined {
  return native.importGraphNormalizePath(value) ?? undefined;
}

/** JSON에서 주석과 꼬리 쉼표를 걷어낸다(tsconfig는 JSONC다). 문자열 안은 건드리지 않는다 */
export function stripJsonc(text: string): string {
  return native.importGraphStripJsonc(text);
}

/** extends 값이 서비스 안의 상대 경로 파일이면 그 서비스 기준 경로를 돌려준다 */
export function tsconfigExtendsPath(text: string, configDir: string): string | undefined {
  return native.importGraphExtendsPath(text, configDir) ?? undefined;
}

/**
 * tsconfig.json·jsconfig.json 본문에서 `baseUrl`과 `paths`를 읽는다. `base`는 extends로 물려받은 설정이다(자기 값이 있으면 덮어쓴다).
 * `configDir`은 설정 파일이 있는 폴더(서비스 기준). 읽을 수 없으면 base를 그대로 돌려준다.
 */
export function parseAliasConfig(text: string, configDir = '', base?: AliasConfig): AliasConfig {
  return decodeNative<AliasConfig>(native.importGraphParseAliasConfig(text, configDir, base === undefined ? undefined : encodeNative(base)));
}

/**
 * import 지정자 하나를 서비스 안의 소스 파일로 푼다(서비스 기준 상대 경로). 못 풀거나(패키지 import, 없는 파일) 서비스 밖이면 undefined.
 * 순서: 상대 경로 → tsconfig paths(가장 긴 접두사 먼저) → baseUrl → 설정이 없을 때의 `@/`·`~/` 추정.
 */
export function resolveImport(specifier: string, fromFile: string, files: ReadonlySet<string>, alias: AliasConfig): string | undefined {
  return native.importGraphResolveImport(specifier, fromFile, [...files], encodeNative(alias)) ?? undefined;
}

// ───────────────────────── 그래프 ─────────────────────────

/** 파일 → 그 파일을 import하는 파일들 */
export type ReverseImportGraph = Map<string, Set<string>>;

/** 읽은 소스(서비스 기준 경로 → 내용)로 역방향 import 그래프를 만든다. 자기 자신을 import하는 줄은 뺀다 */
export function buildReverseGraph(sources: ReadonlyMap<string, string>, files: ReadonlySet<string>, alias: AliasConfig): ReverseImportGraph {
  const rows = decodeNative<Array<[string, string[]]>>(native.importGraphBuildReverse([...sources.keys()], [...sources.values()], [...files], encodeNative(alias)));
  return new Map(rows.map(([target, importers]) => [target, new Set(importers)]));
}

export interface PageCandidate {
  /** 열어 볼 page 파일(서비스 기준) */
  page: string;
  /** 이 page를 찾게 한 바뀐 파일(서비스 기준). page가 직접 바뀐 것이면 page 자신 */
  cause: string;
  /** import 단계 수. 0이면 바뀐 page 자체, 1이면 바뀐 파일을 직접 import하는 page */
  distance: number;
  /** 같은 거리끼리의 순서. layout·template 등이 바뀐 경우 그 폴더에서 얼마나 깊은 page인지 */
  tie: number;
}

export interface TruncatedTrace {
  /** 깊이 상한에서 멈춘 갈래의 바뀐 파일(서비스 기준) */
  cause: string;
  /** 멈춘 파일. 이 파일을 import하는 파일이 더 있었지만 따라가지 않았다 */
  stoppedAt: string;
}

export interface TraceResult {
  candidates: PageCandidate[];
  truncated: TruncatedTrace[];
}

/**
 * 바뀐 파일에서 출발해 import를 거꾸로 따라가며 page를 찾는다(너비 우선, 순환은 방문 표시로 끊는다).
 *  - 바뀐 page 자체가 거리 0, 그 파일을 직접 import하는 page가 거리 1, … `maxDepth`단계까지만 따라간다.
 *  - app 라우터의 layout·template·loading·error·not-found가 바뀌었거나 그 파일에 닿으면 그 폴더 아래의 모든 page를 한 단계 뒤로 잇는다
 *    (같은 거리에서는 폴더가 얕은 page를 먼저). 이 파일들은 하위 모든 화면의 모양에 영향을 주기 때문이다.
 *  - 같은 page에 여러 경로로 닿으면 가장 가까운 것 하나만 남긴다.
 */
export function tracePages(changed: readonly string[], reverse: ReverseImportGraph, files: ReadonlySet<string>, maxDepth: number): TraceResult {
  const rows = [...reverse].map(([target, importers]) => [target, [...importers]]);
  return decodeNative<TraceResult>(native.importGraphTracePages([...changed], encodeNative(rows), [...files], maxDepth));
}

// ───────────────────────── 파일 수집 ─────────────────────────

export interface ImportGraphDeps {
  /** 폴더 하나의 직계 항목(루트 기준 경로, 폴더는 끝에 `/`). Workspace.list(dir, 1) */
  list(dir: string): Promise<string[]>;
  /** 파일 내용. 게이트는 Workspace.peek(읽은 표시를 남기지 않는 읽기)을 넘긴다 */
  read(file: string): Promise<string>;
  now(): number;
}

export interface ImportGraphLimits {
  /** 읽는 소스 파일 수 상한 */
  maxFiles: number;
  /** 폴더를 훑는 횟수 상한 */
  maxDirs: number;
  /** 전체 시간 상한(밀리초) */
  maxMs: number;
}

export const DEFAULT_IMPORT_GRAPH_LIMITS: ImportGraphLimits = { maxFiles: 800, maxDirs: 400, maxMs: 10_000 };
/** 목록 단계에서 모아 두는 소스 파일 수 상한(읽기 상한의 배수). 이만큼 모이면 더 훑지 않는다 — 읽기 상한을 목록을 다 모은 뒤에만 적용하면 그 전에 메모리·시간을 한없이 쓴다 */
const LISTED_FILES_PER_READ_LIMIT = 4;
/** 건너뛴 이유에 이름을 적는 파일·폴더 수 */
const NAMED_FAILURES = 3;
/** 역추적 깊이 상한. 컴포넌트 → 화면 컴포넌트 → 래퍼 → page 정도의 사슬을 덮고, 그 너머는 사실상 공용 파일이다 */
export const DEFAULT_TRACE_DEPTH = 5;

export interface ImportGraph {
  /** 서비스 기준 상대 경로로 본 모든 소스 파일(읽지 못한 것 포함) */
  files: Set<string>;
  reverse: ReverseImportGraph;
  readCount: number;
  elapsedMs: number;
  /** 상한 때문에 그래프가 일부만 만들어졌으면 이유. 없으면 전부 읽은 것이다 */
  incomplete?: string;
}

/**
 * 서비스 폴더의 소스를 읽어 역방향 import 그래프를 만든다. 파일 읽기·목록은 주입받는다.
 * 상한(파일 수·폴더 수·시간)을 넘으면 거기까지 만든 그래프와 이유(`incomplete`)를 돌려준다 — 호출자가 건너뜀으로 남긴다.
 */
export async function collectImportGraph(
  deps: ImportGraphDeps,
  servicePath: string,
  limits: ImportGraphLimits = DEFAULT_IMPORT_GRAPH_LIMITS,
): Promise<ImportGraph> {
  const started = deps.now();
  const service = normalizeServicePath(servicePath) ?? '';
  const toService = (rootRelative: string): string | undefined => {
    if (service === '') return rootRelative;
    return rootRelative.startsWith(`${service}/`) ? rootRelative.slice(service.length + 1) : undefined;
  };
  const toRoot = (inService: string): string => (service === '' ? inService : `${service}/${inService}`);
  // 그래프가 덜 만들어진 이유를 전부 모은다. 하나라도 있으면 호출자가 건너뜀 check로 남긴다 —
  // 읽지 못한 폴더·파일을 조용히 넘기면 그 너머의 화면을 "따라갈 것이 없었다"와 구분할 수 없다
  const reasons: string[] = [];
  const expired = (): boolean => deps.now() - started > limits.maxMs;
  const maxListed = limits.maxFiles * LISTED_FILES_PER_READ_LIMIT;
  const unreadableDirs: string[] = [];

  const files = new Set<string>();
  const queue: string[] = [service === '' ? '.' : service];
  let dirCount = 0;
  while (queue.length > 0) {
    if (dirCount >= limits.maxDirs) {
      reasons.push(`폴더 ${limits.maxDirs}개까지만 훑었습니다`);
      break;
    }
    if (files.size >= maxListed) {
      reasons.push(`소스 파일 ${maxListed}개를 찾은 데서 훑기를 멈췄습니다`);
      break;
    }
    if (expired()) {
      reasons.push(`폴더를 훑다가 시간 상한(${limits.maxMs}ms)을 넘었습니다`);
      break;
    }
    const dir = queue.shift()!;
    dirCount++;
    let entries: string[];
    try {
      entries = await deps.list(dir);
    } catch {
      unreadableDirs.push(dir); // 건너뛰되, 그 아래 파일이 그래프에서 빠졌다는 것을 남긴다
      continue;
    }
    for (const entry of entries) {
      const relative = toService(entry.replace(/\/$/, ''));
      if (relative === undefined || relative === '') continue;
      const name = relative.slice(relative.lastIndexOf('/') + 1);
      if (entry.endsWith('/')) {
        if (!SKIPPED_DIRS.has(name)) queue.push(entry.replace(/\/$/, ''));
      } else if (isGraphSourceFile(relative)) {
        files.add(relative);
      }
    }
  }

  // app 아래 파일을 먼저 읽는다: 상한에 걸려도 page와 그 가까운 이웃이 그래프에 남게 한다
  const ordered = [...files].sort((a, b) => Number(isUnderApp(b)) - Number(isUnderApp(a)) || a.localeCompare(b));
  const toRead = ordered.slice(0, limits.maxFiles);
  if (unreadableDirs.length > 0) reasons.push(`폴더 ${unreadableDirs.length}개를 훑지 못했습니다(${nameSome(unreadableDirs)})`);
  if (ordered.length > limits.maxFiles) reasons.push(`소스 파일 ${ordered.length}개 중 ${limits.maxFiles}개까지만 읽었습니다`);

  const sources = new Map<string, string>();
  const unreadableFiles: string[] = [];
  const BATCH = 16;
  for (let i = 0; i < toRead.length; i += BATCH) {
    if (expired()) {
      reasons.push(`파일을 읽다가 시간 상한(${limits.maxMs}ms)을 넘었습니다(${toRead.length}개 중 ${i}개 읽음)`);
      break;
    }
    await Promise.all(
      toRead.slice(i, i + BATCH).map(async (file) => {
        try {
          sources.set(file, await deps.read(toRoot(file)));
        } catch {
          unreadableFiles.push(file); // 너무 크거나 읽을 수 없는 파일. 그 파일의 import는 그래프에서 빠진다
        }
      }),
    );
  }
  if (unreadableFiles.length > 0) reasons.push(`소스 파일 ${unreadableFiles.length}개를 읽지 못했습니다(${nameSome(unreadableFiles.sort())})`);
  const incomplete = reasons.length > 0 ? reasons.join(' · ') : undefined;

  const alias = await readAliasConfig(deps, toRoot);
  return { files, reverse: buildReverseGraph(sources, files, alias), readCount: sources.size, elapsedMs: deps.now() - started, ...(incomplete ? { incomplete } : {}) };
}

/** 이유에 적을 이름 몇 개. 나머지는 수로만 남긴다 */
function nameSome(names: readonly string[]): string {
  const shown = names.slice(0, NAMED_FAILURES).join(', ');
  return names.length > NAMED_FAILURES ? `${shown} 외 ${names.length - NAMED_FAILURES}개` : shown;
}

function dirOf(file: string): string {
  return native.importGraphDirOf(file);
}

function isUnderApp(file: string): boolean {
  return file.startsWith('app/') || file.startsWith('src/app/');
}

/** tsconfig.json → jsconfig.json 순으로 첫 번째 설정에서 별칭을 읽는다. extends는 서비스 안의 상대 경로 한 단계만 따른다 */
async function readAliasConfig(deps: ImportGraphDeps, toRoot: (inService: string) => string): Promise<AliasConfig> {
  for (const name of ['tsconfig.json', 'jsconfig.json']) {
    let text: string;
    try {
      text = await deps.read(toRoot(name));
    } catch {
      continue;
    }
    let base: AliasConfig | undefined;
    const parent = tsconfigExtendsPath(text, '');
    if (parent !== undefined) {
      try {
        base = parseAliasConfig(await deps.read(toRoot(parent)), dirOf(parent));
      } catch {
        base = undefined;
      }
    }
    return parseAliasConfig(text, '', base);
  }
  return { paths: [] };
}
