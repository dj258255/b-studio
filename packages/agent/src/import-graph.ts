/**
 * 소스 파일의 import를 거꾸로 따라가 "이 파일을 쓰는 page 파일"을 찾는다(ADR-154, 게이트 자동 화면 확인용).
 *
 * 왜 필요한가: 자동 화면 확인은 바뀐 page 파일만 열어서, 컴포넌트·유틸만 고친 실행은 그 화면을 한 번도 열지 않은 채 통과했다.
 * 여기서는 서비스 폴더의 소스를 읽어 "파일 → 그 파일을 import하는 파일" 그래프를 만들고, 바뀐 파일에서 page까지 거슬러 올라간다.
 *
 * 타입스크립트 컴파일러나 번들러를 쓰지 않는 **가벼운 근사**다(새 의존성 없음). 한계:
 *  - import 문은 토큰 단위로 읽는다. 주석·문자열·템플릿 리터럴 안의 `import …`는 무시하지만, 정규식 리터럴과 JSX 글자 속 따옴표는
 *    경험칙으로만 구분한다(따옴표 문자열은 한 줄을 넘지 않는다고 보고, 닫히지 않으면 그 한 줄만 버린다).
 *  - 경로 별칭은 서비스의 tsconfig.json·jsconfig.json(`extends`는 서비스 안의 상대 경로 한 단계만)의 `paths`·`baseUrl`만 푼다.
 *    못 읽으면 `@/`·`~/`를 서비스 루트와 `src/`로 시도한다. 와일드카드는 패턴당 `*` 하나만 지원한다.
 *  - 변수로 만든 동적 import(`import(name)`), `require` 안의 표현식, 번들러 전용 별칭(webpack `resolve.alias`)은 따라가지 못한다.
 *  - css·json·이미지 import는 그래프에 넣지 않는다(소스 확장자 ts·tsx·js·jsx·mjs·mdx만).
 *  - 서비스 폴더 밖으로 나가는 경로(`..` 탈출)는 따라가지 않는다. 심볼릭 링크는 Workspace가 막는다.
 */

/** 그래프에 넣는 소스 확장자. 확장자를 생략한 import를 풀 때 이 순서로 시도한다 */
const SOURCE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.mdx'] as const;
const SOURCE_FILE = /\.(?:tsx|ts|jsx|js|mjs|mdx)$/;
const DECLARATION_FILE = /\.d\.ts$/;
/** 화면에 영향이 없는 테스트·스토리 파일은 읽지 않는다(읽기 상한을 아낀다) */
const NON_RUNTIME_FILE = /\.(?:test|spec|stories)\.[a-z]+$/;
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

/** app 라우터에서 같은 폴더(와 하위) 모든 page의 모양에 영향을 주는 특수 파일 */
const ROUTE_WRAPPER_FILE = /^((?:src\/)?app(?:\/.*)?)\/(?:layout|template|loading|error|global-error|not-found|default)\.(?:tsx|jsx|ts|js|mdx)$/;
const PAGE_FILE_IN_SERVICE = /^(?:src\/)?app\/(?:.*\/)?page\.(?:tsx|jsx|ts|js|mdx)$/;

/** 서비스 기준 상대 경로가 page 파일인지 */
export function isPageFileInService(relative: string): boolean {
  return PAGE_FILE_IN_SERVICE.test(relative);
}

/** 서비스 기준 상대 경로가 layout·loading·error 같은 app 라우터 특수 파일이면 그 폴더(서비스 기준)를 돌려준다 */
export function routeWrapperFolder(relative: string): string | undefined {
  return ROUTE_WRAPPER_FILE.exec(relative)?.[1];
}

/** 소스 파일 하나를 읽을 때 쓰는 확장자 판정. `.d.ts`와 테스트·스토리 파일은 뺀다 */
export function isGraphSourceFile(relative: string): boolean {
  return SOURCE_FILE.test(relative) && !DECLARATION_FILE.test(relative) && !NON_RUNTIME_FILE.test(relative);
}

// ───────────────────────── import 추출 ─────────────────────────

type Token = { t: 'str'; v: string; template: boolean } | { t: 'word'; v: string } | { t: 'p'; v: string };

const WORD_CHAR = /[A-Za-z0-9_$]/;
/** 앞 토큰이 이 단어들이면 `/`는 나눗셈이 아니라 정규식의 시작이다 */
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else', 'do', 'yield', 'await']);

/**
 * 소스를 토큰으로 자른다. 주석은 버리고 문자열은 통째로 하나의 토큰이 되므로, 주석·문자열 속의 `import …`는 문장으로 읽히지 않는다.
 * 따옴표 문자열은 줄바꿈에서 끝난 것으로 본다 — JSX 글자(`Don't`)의 따옴표가 뒤쪽 import를 삼키지 못하게 하려는 것이다.
 */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  const length = source.length;
  let i = 0;
  while (i < length) {
    const ch = source[i]!;
    const next = source[i + 1];
    if (ch === '\n' || ch === ' ' || ch === '\t' || ch === '\r') {
      i++;
      continue;
    }
    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      i = end === -1 ? length : end + 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      i = end === -1 ? length : end + 2;
      continue;
    }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      let value = '';
      let closed = false;
      while (j < length) {
        const c = source[j]!;
        if (c === '\\') {
          value += source[j + 1] ?? '';
          j += 2;
          continue;
        }
        if (c === '\n') break;
        if (c === ch) {
          closed = true;
          break;
        }
        value += c;
        j++;
      }
      if (closed) {
        tokens.push({ t: 'str', v: value, template: false });
        i = j + 1;
      } else {
        // 닫히지 않은 따옴표(JSX 글자의 아포스트로피 등): 따옴표 하나만 버리고 다음 글자부터 다시 읽는다
        i++;
      }
      continue;
    }
    if (ch === '`') {
      let j = i + 1;
      let value = '';
      while (j < length && source[j] !== '`') {
        if (source[j] === '\\') {
          value += source[j + 1] ?? '';
          j += 2;
          continue;
        }
        value += source[j];
        j++;
      }
      tokens.push({ t: 'str', v: value, template: true });
      i = j + 1;
      continue;
    }
    if (ch === '/') {
      const prev = tokens[tokens.length - 1];
      const regexAllowed = prev === undefined || (prev.t === 'p' && ![')', ']', '}', '<'].includes(prev.v)) || (prev.t === 'word' && REGEX_AFTER_WORD.has(prev.v));
      if (regexAllowed) {
        let j = i + 1;
        let inClass = false;
        let closed = false;
        while (j < length && source[j] !== '\n') {
          const c = source[j]!;
          if (c === '\\') {
            j += 2;
            continue;
          }
          if (c === '[') inClass = true;
          else if (c === ']') inClass = false;
          else if (c === '/' && !inClass) {
            closed = true;
            break;
          }
          j++;
        }
        if (closed) {
          // 정규식 리터럴 전체를 하나의 토큰으로 접는다(안의 따옴표가 문자열로 읽히지 않게)
          tokens.push({ t: 'p', v: '/re/' });
          i = j + 1;
          while (i < length && /[a-z]/.test(source[i]!)) i++; // 플래그
          continue;
        }
      }
      tokens.push({ t: 'p', v: '/' });
      i++;
      continue;
    }
    if (WORD_CHAR.test(ch)) {
      let j = i + 1;
      while (j < length && WORD_CHAR.test(source[j]!)) j++;
      tokens.push({ t: 'word', v: source.slice(i, j) });
      i = j;
      continue;
    }
    tokens.push({ t: 'p', v: ch });
    i++;
  }
  return tokens;
}

const SCAN_LIMIT = 400;
/** `export` 뒤에서 재수출이 아니라 선언임을 알려 주는 단어. 중괄호 밖에서 만나면 재수출 문장이 아니다 */
const EXPORT_DECLARATION_WORDS = new Set(['function', 'class', 'const', 'let', 'var', 'default', 'async', 'interface', 'enum', 'namespace', 'declare', 'abstract']);

/** `from '…'`에 닿을 때까지 import/export 절을 훑는다. 재수출·import가 아닌 문장이면 undefined */
function specifierAfterClause(tokens: readonly Token[], start: number, kind: 'import' | 'export'): string | undefined {
  let depth = 0;
  const end = Math.min(tokens.length - 1, start + SCAN_LIMIT);
  for (let j = start; j <= end; j++) {
    const token = tokens[j]!;
    if (token.t === 'p') {
      if (token.v === '{') depth++;
      else if (token.v === '}') depth = Math.max(0, depth - 1);
      else if (depth === 0 && [';', '(', '=', '.'].includes(token.v)) return undefined;
      continue;
    }
    if (token.t === 'str') {
      if (depth === 0) return undefined; // from 없이 문자열이 나오면 이 절이 아니다
      continue;
    }
    if (depth === 0) {
      if (token.v === 'from') {
        const target = tokens[j + 1];
        return target?.t === 'str' && !target.template ? target.v : undefined;
      }
      if (token.v === 'import' || token.v === 'export') return undefined;
      if (kind === 'export' && EXPORT_DECLARATION_WORDS.has(token.v)) return undefined;
    }
  }
  return undefined;
}

/**
 * 소스에서 import한 모듈 지정자를 모두 뽑는다: `import x from '…'`, `import '…'`, `import type …`, `export … from '…'`,
 * `import('…')`(문자열·보간 없는 템플릿), `require('…')`. 주석·문자열 안의 가짜 import는 무시한다.
 */
export function extractImportSpecifiers(source: string): string[] {
  const tokens = tokenize(source);
  const found: string[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.t !== 'word') continue;
    // `a.import(...)`·`obj.require(...)` 같은 속성 접근은 건너뛴다
    const before = tokens[i - 1];
    if (before?.t === 'p' && before.v === '.') continue;
    const next = tokens[i + 1];
    if (token.v === 'import' || token.v === 'require') {
      if (next?.t === 'str' && token.v === 'import') {
        if (!next.template) found.push(next.v); // import '…' (부수 효과만)
        continue;
      }
      if (next?.t === 'p' && next.v === '(') {
        const arg = tokens[i + 2];
        const close = tokens[i + 3];
        if (arg?.t === 'str' && !(arg.template && arg.v.includes('${')) && close?.t === 'p' && [')', ','].includes(close.v)) found.push(arg.v);
        continue;
      }
      if (token.v === 'import') {
        const specifier = specifierAfterClause(tokens, i + 1, 'import');
        if (specifier !== undefined) found.push(specifier);
      }
      continue;
    }
    if (token.v === 'export' && next && ((next.t === 'p' && (next.v === '*' || next.v === '{')) || (next.t === 'word' && next.v === 'type'))) {
      const specifier = specifierAfterClause(tokens, i + 1, 'export');
      if (specifier !== undefined) found.push(specifier);
    }
  }
  return found;
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
  const out: string[] = [];
  for (const part of value.replaceAll('\\', '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) return undefined;
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join('/');
}

function dirOf(file: string): string {
  const slash = file.lastIndexOf('/');
  return slash === -1 ? '' : file.slice(0, slash);
}

/** JSON에서 주석과 꼬리 쉼표를 걷어낸다(tsconfig는 JSONC다). 문자열 안은 건드리지 않는다 */
export function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      i = end === -1 ? text.length : end;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += ch;
      i++;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

interface RawTsconfig {
  extends?: unknown;
  compilerOptions?: { baseUrl?: unknown; paths?: unknown };
}

function parseRaw(text: string): RawTsconfig | undefined {
  try {
    const parsed: unknown = JSON.parse(stripJsonc(text));
    return typeof parsed === 'object' && parsed !== null ? (parsed as RawTsconfig) : undefined;
  } catch {
    return undefined;
  }
}

/** extends 값이 서비스 안의 상대 경로 파일이면 그 서비스 기준 경로를 돌려준다 */
export function tsconfigExtendsPath(text: string, configDir: string): string | undefined {
  const value = parseRaw(text)?.extends;
  if (typeof value !== 'string' || !value.startsWith('.')) return undefined;
  const joined = normalizeServicePath(configDir === '' ? value : `${configDir}/${value}`);
  if (joined === undefined) return undefined;
  return joined.endsWith('.json') ? joined : `${joined}.json`;
}

/**
 * tsconfig.json·jsconfig.json 본문에서 `baseUrl`과 `paths`를 읽는다. `base`는 extends로 물려받은 설정이다(자기 값이 있으면 덮어쓴다).
 * `configDir`은 설정 파일이 있는 폴더(서비스 기준). 읽을 수 없으면 base를 그대로 돌려준다.
 */
export function parseAliasConfig(text: string, configDir = '', base?: AliasConfig): AliasConfig {
  const result: AliasConfig = { ...(base?.baseUrl !== undefined ? { baseUrl: base.baseUrl } : {}), paths: base ? [...base.paths] : [] };
  const options = parseRaw(text)?.compilerOptions;
  if (!options) return result;
  const rawBase = typeof options.baseUrl === 'string' ? normalizeServicePath(configDir === '' ? options.baseUrl : `${configDir}/${options.baseUrl}`) : undefined;
  if (rawBase !== undefined) result.baseUrl = rawBase;
  const paths = options.paths;
  if (typeof paths === 'object' && paths !== null) {
    // paths는 baseUrl 기준이고, baseUrl이 없으면 설정 파일 폴더 기준이다
    const root = result.baseUrl ?? configDir;
    const own: AliasConfig['paths'] = [];
    for (const [pattern, targets] of Object.entries(paths as Record<string, unknown>)) {
      if (!Array.isArray(targets)) continue;
      const resolved = targets
        .filter((target): target is string => typeof target === 'string')
        .map((target) => normalizeServicePath(root === '' ? target : `${root}/${target}`))
        .filter((target): target is string => target !== undefined);
      if (resolved.length > 0) own.push({ pattern, targets: resolved });
    }
    // 자기 paths가 있으면 물려받은 paths를 대체한다(TypeScript도 paths를 합치지 않고 덮어쓴다)
    result.paths = own;
  }
  return result;
}

/** 확장자 없는 경로 하나에서 실제 소스 파일을 찾는다: 그대로 → 확장자 붙이기 → index 파일. `./x.js`로 쓴 TS ESM 지정자도 `.ts(x)`로 푼다 */
function findSourceFile(base: string, files: ReadonlySet<string>): string | undefined {
  const bases = [base];
  const jsLike = /\.(?:mjs|jsx?)$/.exec(base);
  if (jsLike) bases.push(base.slice(0, -jsLike[0].length));
  for (const candidate of bases) {
    if (SOURCE_FILE.test(candidate) && files.has(candidate)) return candidate;
    for (const ext of SOURCE_EXTENSIONS) {
      if (files.has(`${candidate}${ext}`)) return `${candidate}${ext}`;
    }
    for (const ext of SOURCE_EXTENSIONS) {
      const index = candidate === '' ? `index${ext}` : `${candidate}/index${ext}`;
      if (files.has(index)) return index;
    }
  }
  return undefined;
}

/**
 * import 지정자 하나를 서비스 안의 소스 파일로 푼다(서비스 기준 상대 경로). 못 풀거나(패키지 import, 없는 파일) 서비스 밖이면 undefined.
 * 순서: 상대 경로 → tsconfig paths(가장 긴 접두사 먼저) → baseUrl → 설정이 없을 때의 `@/`·`~/` 추정.
 */
export function resolveImport(specifier: string, fromFile: string, files: ReadonlySet<string>, alias: AliasConfig): string | undefined {
  if (specifier === '' || /^[a-z][a-z0-9+.-]*:/i.test(specifier)) return undefined; // node:, data:, https: 등
  if (specifier.startsWith('./') || specifier.startsWith('../') || specifier === '.' || specifier === '..') {
    const dir = dirOf(fromFile);
    const joined = normalizeServicePath(dir === '' ? specifier : `${dir}/${specifier}`);
    return joined === undefined ? undefined : findSourceFile(joined, files);
  }
  if (specifier.startsWith('/')) return undefined;

  const matches = alias.paths
    .map((entry) => {
      const star = entry.pattern.indexOf('*');
      if (star === -1) return entry.pattern === specifier ? { entry, captured: '', weight: entry.pattern.length } : undefined;
      const prefix = entry.pattern.slice(0, star);
      const suffix = entry.pattern.slice(star + 1);
      if (specifier.length < prefix.length + suffix.length || !specifier.startsWith(prefix) || !specifier.endsWith(suffix)) return undefined;
      return { entry, captured: specifier.slice(prefix.length, specifier.length - suffix.length), weight: prefix.length };
    })
    .filter((match): match is NonNullable<typeof match> => match !== undefined)
    .sort((a, b) => b.weight - a.weight);
  for (const match of matches) {
    for (const target of match.entry.targets) {
      const joined = normalizeServicePath(target.replace('*', match.captured));
      const found = joined === undefined ? undefined : findSourceFile(joined, files);
      if (found !== undefined) return found;
    }
  }
  if (alias.baseUrl !== undefined) {
    const joined = normalizeServicePath(alias.baseUrl === '' ? specifier : `${alias.baseUrl}/${specifier}`);
    const found = joined === undefined ? undefined : findSourceFile(joined, files);
    if (found !== undefined) return found;
  }
  // 설정에서 못 풀었고 `@/`·`~/`로 시작하면 Next.js의 흔한 관례대로 서비스 루트와 src/를 시도한다
  const conventional = /^[@~]\/(.*)$/.exec(specifier);
  if (conventional) {
    for (const root of ['', 'src']) {
      const joined = normalizeServicePath(root === '' ? conventional[1]! : `${root}/${conventional[1]}`);
      const found = joined === undefined ? undefined : findSourceFile(joined, files);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

// ───────────────────────── 그래프 ─────────────────────────

/** 파일 → 그 파일을 import하는 파일들 */
export type ReverseImportGraph = Map<string, Set<string>>;

/** 읽은 소스(서비스 기준 경로 → 내용)로 역방향 import 그래프를 만든다. 자기 자신을 import하는 줄은 뺀다 */
export function buildReverseGraph(sources: ReadonlyMap<string, string>, files: ReadonlySet<string>, alias: AliasConfig): ReverseImportGraph {
  const reverse: ReverseImportGraph = new Map();
  for (const [file, source] of sources) {
    for (const specifier of extractImportSpecifiers(source)) {
      const target = resolveImport(specifier, file, files, alias);
      if (target === undefined || target === file) continue;
      let importers = reverse.get(target);
      if (!importers) reverse.set(target, (importers = new Set()));
      importers.add(file);
    }
  }
  return reverse;
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
  const pages = [...files].filter(isPageFileInService).sort();
  const visited = new Map<string, { cause: string; distance: number; tie: number }>();
  let frontier: string[] = [];
  for (const file of [...new Set(changed)].sort()) {
    if (visited.has(file)) continue;
    visited.set(file, { cause: file, distance: 0, tie: 0 });
    frontier.push(file);
  }

  const neighborsOf = (file: string): Array<{ file: string; tie: number }> => {
    const result: Array<{ file: string; tie: number }> = [];
    for (const importer of [...(reverse.get(file) ?? [])].sort()) result.push({ file: importer, tie: 0 });
    const folder = routeWrapperFolder(file);
    if (folder !== undefined) {
      const depthOf = (path: string): number => path.split('/').length;
      for (const page of pages) {
        if (page.startsWith(`${folder}/`)) result.push({ file: page, tie: depthOf(dirOf(page)) - depthOf(folder) });
      }
    }
    return result;
  };

  const truncated: TruncatedTrace[] = [];
  for (let distance = 0; frontier.length > 0; distance++) {
    const nextFrontier: string[] = [];
    for (const file of frontier) {
      const info = visited.get(file)!;
      for (const neighbor of neighborsOf(file)) {
        if (visited.has(neighbor.file)) continue;
        if (distance >= maxDepth) {
          // 더 따라갈 수 있었지만 깊이 상한이라 멈췄다 — 조용히 포기하지 않고 호출자가 알리게 한다
          if (!truncated.some((entry) => entry.cause === info.cause && entry.stoppedAt === file)) truncated.push({ cause: info.cause, stoppedAt: file });
          break;
        }
        visited.set(neighbor.file, { cause: info.cause, distance: distance + 1, tie: neighbor.tie });
        nextFrontier.push(neighbor.file);
      }
    }
    frontier = nextFrontier;
  }

  const candidates: PageCandidate[] = [];
  for (const [file, info] of visited) {
    if (isPageFileInService(file)) candidates.push({ page: file, cause: info.cause, distance: info.distance, tie: info.tie });
  }
  candidates.sort((a, b) => a.distance - b.distance || a.tie - b.tie || a.page.localeCompare(b.page));
  return { candidates, truncated };
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
  let incomplete: string | undefined;
  const expired = (): boolean => deps.now() - started > limits.maxMs;

  const files = new Set<string>();
  const queue: string[] = [service === '' ? '.' : service];
  let dirCount = 0;
  while (queue.length > 0) {
    if (dirCount >= limits.maxDirs) {
      incomplete = `폴더 ${limits.maxDirs}개까지만 훑었습니다`;
      break;
    }
    if (expired()) {
      incomplete = `폴더를 훑다가 시간 상한(${limits.maxMs}ms)을 넘었습니다`;
      break;
    }
    const dir = queue.shift()!;
    dirCount++;
    let entries: string[];
    try {
      entries = await deps.list(dir);
    } catch {
      continue; // 읽을 수 없는 폴더는 건너뛴다
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
  if (ordered.length > limits.maxFiles) incomplete ??= `소스 파일 ${ordered.length}개 중 ${limits.maxFiles}개까지만 읽었습니다`;

  const sources = new Map<string, string>();
  const BATCH = 16;
  for (let i = 0; i < toRead.length; i += BATCH) {
    if (expired()) {
      incomplete ??= `파일을 읽다가 시간 상한(${limits.maxMs}ms)을 넘었습니다`;
      break;
    }
    await Promise.all(
      toRead.slice(i, i + BATCH).map(async (file) => {
        try {
          sources.set(file, await deps.read(toRoot(file)));
        } catch {
          // 너무 크거나 읽을 수 없는 파일은 그래프에서 빠진다
        }
      }),
    );
  }

  const alias = await readAliasConfig(deps, toRoot);
  return { files, reverse: buildReverseGraph(sources, files, alias), readCount: sources.size, elapsedMs: deps.now() - started, ...(incomplete ? { incomplete } : {}) };
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
