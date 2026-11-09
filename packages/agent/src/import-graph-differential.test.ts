/**
 * import-graph의 순수 코어를 Rust로 옮기면서(ADR-191 3단계 3b) 옛 TS 구현을 아래 `makeLegacy`에 그대로 복사해 두고, 같은 무작위 입력(시드 고정)을
 * 옛 TS와 새 껍데기(Rust)에 넣어 결과를 `JSON.stringify` 글자(키 순서 포함)로 견준다. 한쪽 규칙을 바꾸면 이 테스트가 먼저 실패한다.
 *
 * `tracePages`의 마지막 정렬만 의도한 차이다(옛 TS는 `localeCompare`, 새 코드는 UTF-16 코드 단위 순서). 그래서 옛 구현을 비교 함수를 받는 꼴로 복사했고,
 * UTF-16 순서 판본과는 글자까지 같아야 하며 `localeCompare` 판본과는 순서만 달라야(같은 후보 집합) 한다.
 */
import { describe, expect, it } from 'vitest';
import { buildReverseGraph, extractImportSpecifiers, isGraphSourceFile, isPageFileInService, normalizeServicePath, parseAliasConfig, resolveImport, routeWrapperFolder, stripJsonc, tokenize, tracePages, tsconfigExtendsPath, type AliasConfig } from './import-graph';

type Compare = (a: string, b: string) => number;

// ───────────────────────── 옮기기 전의 TS(복사) ─────────────────────────

function makeLegacy(compare: Compare) {
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
  function isPageFileInService(relative: string): boolean {
    return PAGE_FILE_IN_SERVICE.test(relative);
  }

  /** 서비스 기준 상대 경로가 layout·loading·error 같은 app 라우터 특수 파일이면 그 폴더(서비스 기준)를 돌려준다 */
  function routeWrapperFolder(relative: string): string | undefined {
    return ROUTE_WRAPPER_FILE.exec(relative)?.[1];
  }

  /** 소스 파일 하나를 읽을 때 쓰는 확장자 판정. `.d.ts`와 테스트·스토리 파일은 뺀다 */
  function isGraphSourceFile(relative: string): boolean {
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
  function tokenize(source: string): Token[] {
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
  function extractImportSpecifiers(source: string): string[] {
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
  interface AliasConfig {
    /** `compilerOptions.baseUrl`. 없으면 undefined */
    baseUrl?: string;
    /** `paths` 항목. targets는 baseUrl(없으면 설정 파일 폴더) 기준이었던 것을 서비스 기준으로 바꿔 둔다 */
    paths: Array<{ pattern: string; targets: string[] }>;
  }

  /** 서비스 기준 경로를 정규화한다(`a/./b/../c` → `a/c`). 서비스 밖으로 나가면 undefined */
  function normalizeServicePath(value: string): string | undefined {
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
  function stripJsonc(text: string): string {
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
  function tsconfigExtendsPath(text: string, configDir: string): string | undefined {
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
  function parseAliasConfig(text: string, configDir = '', base?: AliasConfig): AliasConfig {
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
  function resolveImport(specifier: string, fromFile: string, files: ReadonlySet<string>, alias: AliasConfig): string | undefined {
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
  type ReverseImportGraph = Map<string, Set<string>>;

  /** 읽은 소스(서비스 기준 경로 → 내용)로 역방향 import 그래프를 만든다. 자기 자신을 import하는 줄은 뺀다 */
  function buildReverseGraph(sources: ReadonlyMap<string, string>, files: ReadonlySet<string>, alias: AliasConfig): ReverseImportGraph {
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

  interface PageCandidate {
    /** 열어 볼 page 파일(서비스 기준) */
    page: string;
    /** 이 page를 찾게 한 바뀐 파일(서비스 기준). page가 직접 바뀐 것이면 page 자신 */
    cause: string;
    /** import 단계 수. 0이면 바뀐 page 자체, 1이면 바뀐 파일을 직접 import하는 page */
    distance: number;
    /** 같은 거리끼리의 순서. layout·template 등이 바뀐 경우 그 폴더에서 얼마나 깊은 page인지 */
    tie: number;
  }

  interface TruncatedTrace {
    /** 깊이 상한에서 멈춘 갈래의 바뀐 파일(서비스 기준) */
    cause: string;
    /** 멈춘 파일. 이 파일을 import하는 파일이 더 있었지만 따라가지 않았다 */
    stoppedAt: string;
  }

  interface TraceResult {
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
  function tracePages(changed: readonly string[], reverse: ReverseImportGraph, files: ReadonlySet<string>, maxDepth: number): TraceResult {
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
    candidates.sort((a, b) => a.distance - b.distance || a.tie - b.tie || compare(a.page, b.page));
    return { candidates, truncated };
  }
  return { isPageFileInService, routeWrapperFolder, isGraphSourceFile, tokenize, extractImportSpecifiers, normalizeServicePath, stripJsonc, tsconfigExtendsPath, parseAliasConfig, resolveImport, buildReverseGraph, tracePages };
}

const legacyLocale = makeLegacy((a, b) => a.localeCompare(b));
const legacy = makeLegacy((a, b) => (a < b ? -1 : a > b ? 1 : 0)); // 문자열 `<`는 UTF-16 코드 단위 순서다

// ───────────────────────── 입력 생성 ─────────────────────────

// mulberry32: 시드가 같으면 늘 같은 입력이 나온다
function makeRandom(seed: number): () => number {
  let state = seed | 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function gen(seed: number) {
  const rand = makeRandom(seed);
  const int = (n: number) => Math.floor(rand() * n);
  const pick = <T>(items: readonly T[]): T => items[int(items.length)]!;
  const chance = (p: number) => rand() < p;
  return { rand, int, pick, chance };
}
type Gen = ReturnType<typeof gen>;

const DIRS = ['', 'app', 'src/app', 'app/live', 'app/live/[id]', 'app/(group)/shop', 'app/B', 'app/a', 'app/é', 'components', 'components/ui', 'lib', 'src', 'src/lib', 'src/components', 'utils', 'app/😀', 'App', 'apps/app', 'app//x', 'app/a b'];
const NAMES = ['page', 'layout', 'template', 'loading', 'error', 'global-error', 'not-found', 'default', 'index', 'Button', 'LiveViewer', 'x', 'a.test', 'b.spec', 'c.stories', 'types.d', 'é', 'util', 'page.client', 'xpage', 'Page', 'LAYOUT'];
const EXTS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.mdx', '.css', '.json', '.d.ts', '.TSX', '', '.test.ts', '.tsx\n'];

function randomFile(g: Gen): string {
  const dir = g.pick(DIRS);
  return `${dir === '' ? '' : `${dir}/`}${g.pick(NAMES)}${g.pick(EXTS)}`;
}

/** 파일 시스템 모양의 경로 이상치: 대소문자·겹친 빗금·끝 빗금·역슬래시·`.`·`..`·줄 끝 글자·보이지 않는 글자 */
function weirdPath(g: Gen): string {
  const parts = Array.from({ length: g.int(6) }, () => g.pick(['', '.', '..', 'a', 'B', 'app', 'src', 'é', '😀', 'x y', '\\', 'a\\b', '..\\x', '\n', '\u2028', '\u00a0', '\ufeff', '...', '.x', 'page.tsx', 'layout.tsx', 'a.test.ts']));
  return parts.join(g.pick(['/', '/', '/', '//', '\\', '/./']));
}

const SPECS = ['react', 'node:fs', 'https://x', 'data:text/plain', 'HTTP:x', 'C:\\x', 'a+b.c-d:e', '1a:b', '', '.', '..', './', '../', './a', '../b', '../../c', '../../../d', '/abs', '@/lib/x', '@/', '~/y', '~/', '@lib/z', '@/components/ui', './x.js', './x.mjs', './y.jsx', './é', '😀/x', './a//b', './A', 'lib/', 'lib/x', 'src/lib/x', 'a$&b', '$`', "$'", '$$', '$1', '@/a\nb', '@/é', '.\\x', './x\\y', '@scope/pkg', 'components', 'app/page', 'utils/esm.js'];

/** 파일 풀에서 가져오는 지정자: 상대 경로·별칭·확장자 생략·index 생략을 섞는다 */
function specifierFor(g: Gen, from: string, pool: readonly string[]): string {
  if (g.chance(0.25)) return g.pick(SPECS);
  const target = g.pick(pool);
  let spec = target;
  if (g.chance(0.6)) spec = spec.replace(/\.(?:tsx|ts|jsx|js|mjs|mdx)$/, '');
  if (g.chance(0.3)) spec = spec.replace(/\/index$/, '');
  if (g.chance(0.2)) spec = `${spec}.js`;
  const style = g.int(5);
  if (style === 0) return `@/${spec}`;
  if (style === 1) return `~/${spec}`;
  if (style === 2) return `@lib/${spec.replace(/^lib\//, '')}`;
  if (style === 3) {
    const depth = from.split('/').length - 1;
    return `${'../'.repeat(depth + (g.chance(0.1) ? 1 : 0)) || './'}${spec}`;
  }
  return spec;
}

const STATEMENTS: Array<(s: string, g: Gen) => string> = [
  (s) => `import React from '${s}';`,
  (s) => `import { A, B as C } from "${s}";`,
  (s) => `import * as ns from '${s}'`,
  (s) => `import type { T } from '${s}';`,
  (s) => `import '${s}';`,
  (s) => `export { x } from '${s}';`,
  (s) => `export * from "${s}";`,
  (s) => `export * as util from '${s}';`,
  (s) => `export type { Y } from '${s}';`,
  (s) => `const Lazy = dynamic(() => import('${s}'));`,
  (s) => `const mod = await import(\`${s}\`);`,
  (s) => `const old = require('${s}');`,
  (s) => `import(  '${s}' , { with: {} })`,
  (s) => `import def, { a, b } from '${s}'; export default def;`,
  (s) => `import {\n  a,\n  b,\n} from '${s}';`,
  (s) => `export { default } from '${s}';`,
  (s) => `export { default as X } from '${s}'`,
  (s) => `import x = require('${s}');`,
  // 가짜·건너뛸 것
  (s) => `// import { A } from '${s}';`,
  (s) => `/* import { B } from '${s}'; */`,
  (s) => `const s = "import { C } from '${s}'";`,
  (s) => `const u = \`import('${s}')\`;`,
  (s) => `const t = \`a \${b} import '${s}' \${c}\`;`,
  (s) => `obj.import('${s}'); a.require('${s}');`,
  (s) => `const a = import(name); const b = import(\`./x/\${id}\`); const c = require(name);`,
  () => `export const c = 1; export default function Page() {} export class K {} export async function f() {}`,
  () => `const m = import.meta.url; const e = a.b.c = 1;`,
  () => `export function A() { return <p>Don't stop</p>; }`,
  () => `const re = /["']import/g; const r2 = a / b / c; x = (a + b) / 2;`,
  () => `const re = /[/]'x/; if (a) /"/.test(b);`,
  () => `return /'/.test(x)`,
  (s) => `const str = "esc \\" quote import '${s}'";`,
  (s) => `const str = 'esc \\' quote'; import '${s}';`,
  () => `const u = 'unclosed\nconst v = "also unclosed`,
  () => `const x = 😀 + "😀" + '\u{1F600}'; // 😀`,
  () => `\ufeff\u00a0import\u00a0x\u00a0from\u00a0'./nbsp'\u2028import './ls';`,
  () => `/* unclosed comment`,
  () => `\`unclosed template`,
  (s) => `import type X from '${s}'; import typeof Y from '${s}'; import { type Z } from '${s}';`,
  (s) => `export type X = import('${s}').Foo;`,
  (s) => `declare module '${s}' { export const x: number; }`,
  () => `export enum E { A } export namespace N {} export declare const d: number; export abstract class AB {}`,
  () => `export = foo; export as namespace Foo;`,
  (s) => `import ${'x, '.repeat(120)}y from '${s}';`,
  (s) => `export { ${'a, '.repeat(120)}z } from '${s}';`,
  (s) => `export {${'\n a,'.repeat(150)} } from '${s}'; export x ${'y '.repeat(200)} from '${s}';`,
  () => `a = b\n/ c / d; e = [1] / 2; f = {} / 3; g = x++ / 2;`,
  () => `<div className="a'b">it's {x / y} "quoted" </div>`,
  () => `else /x'/g.test(y); do /y"/.exec(z); typeof /a'/; in /b/; of /c/`,
];

const SOUP = ['import', 'export', 'from', 'type', 'require', 'default', 'function', 'const', '*', '{', '}', '(', ')', '[', ']', ';', ',', '=', '.', '<', '>', '/', '//', '/*', '*/', "'a'", '"b"', '`c`', "'", '"', '`', '\\', '\n', ' ', '\t', '\r', 'x', 'y1', '$z', '_w', '😀', 'é', '\u00a0', '\u2028', '\ufeff', '${', '}', "'./a'", '"../b"', '`./c`', 'async', 'await', 'return', 'as', 'in', 'of', '/re/g', '/[/]/', '\\/', '\\\\', '\\\n', '\\😀', 'namespace', 'declare'];

function randomSource(g: Gen, from: string, pool: readonly string[]): string {
  const mode = g.int(10);
  const separator = () => g.pick(['\n', '\n', ' ', '', '\t', '\r\n', '\u2028', '\u00a0', '\n\n']);
  if (mode < 6) {
    const count = g.int(8);
    return Array.from({ length: count }, () => g.pick(STATEMENTS)(specifierFor(g, from, pool), g)).join(separator());
  }
  if (mode < 9) return Array.from({ length: g.int(40) }, () => g.pick(SOUP)).join(g.pick(['', ' ', '\n']));
  // 구조 있는 소스를 글자 단위로 흐트러뜨린다
  const base = Array.from({ length: 1 + g.int(4) }, () => g.pick(STATEMENTS)(specifierFor(g, from, pool), g)).join('\n');
  const chars = Array.from(base);
  for (let n = g.int(4); n > 0 && chars.length > 0; n--) {
    const at = g.int(chars.length);
    if (g.chance(0.5)) chars.splice(at, 1);
    else chars.splice(at, 0, g.pick(SOUP));
  }
  return chars.join('');
}

const PATTERNS = ['@/*', '@lib/*', '~/*', '*', '@exact', 'lib', 'a*b', '@/*/x', '$&*', '0', '1', '@/components/*', '@/lib/*', '#int', 'é*', '😀*', '**', '@a/*/*'];
const TARGETS = ['./*', '*', 'lib/*', 'src/*', '../*', '../../*', './lib/*.ts', '*/index', 'components', './components/ui', '$&/*', '$`*', "x/$'*", '*/*', '/abs/*', '', '.', 'a\\*', 'é/*'];

function randomAliasText(g: Gen): string {
  const options: Record<string, unknown> = {};
  if (g.chance(0.5)) options.baseUrl = g.pick(['.', 'src', './src', '..', '../x', '', 'lib/', 'src/../lib', 'a\\b', 5, null, true]);
  if (g.chance(0.85)) {
    const paths: Record<string, unknown> = {};
    for (let n = g.int(5); n > 0; n--) {
      const targets = g.chance(0.9) ? Array.from({ length: g.int(4) }, () => (g.chance(0.93) ? g.pick(TARGETS) : g.pick([1, null, {}, ['x']]))) : g.pick(['str', 5, null, {}]);
      paths[g.pick(PATTERNS)] = targets;
    }
    options.paths = g.chance(0.05) ? g.pick([[['lib/*'], ['src/*']], 'x', null, 5, []]) : paths;
  }
  const config: Record<string, unknown> = {};
  if (g.chance(0.3)) config.extends = g.pick(['./base.json', '../tsconfig.base', './configs/base', '.', 'tsconfig/base.json', '@x/y', 5, '', '..', './a\\b']);
  if (g.chance(0.9)) config.compilerOptions = g.chance(0.05) ? g.pick([0, '', null, 'x', [], 5, true]) : options;
  if (g.chance(0.2)) config.include = ['**/*.ts', 'a,}'];
  let text = JSON.stringify(g.chance(0.04) ? g.pick([[], null, 5, 'x', true]) : config, null, g.pick([0, 2, '\t']));
  // JSONC 장식: 주석, 꼬리 쉼표, BOM, 문자열 속 주석 흉내
  if (g.chance(0.5)) text = text.replace(/\n/g, () => g.pick(['\n', '\n// line comment\n', '\n/* block */\n', ' // c , }\n', '\n']));
  if (g.chance(0.5)) text = text.replace(/([\]}"0-9e])(\s*)(?=[\]}])/g, (_m, a: string, b: string) => `${a}${g.chance(0.6) ? ',' : ''}${b}`);
  if (g.chance(0.1)) text = text.replace(/"\*"/g, () => '"*/ x // y"');
  if (g.chance(0.05)) text = `\ufeff${text}`;
  if (g.chance(0.05)) text = `// head\n${text}`;
  if (g.chance(0.04)) text = Array.from(text).slice(0, g.int(text.length + 1)).join('');
  if (g.chance(0.04) && text.length > 0) {
    const chars = Array.from(text); // 코드 포인트 단위로 자른다: 서로게이트 한쪽만 남기면 napi 경계에서 U+FFFD가 된다(의도한 차이)
    const at = g.int(chars.length);
    text = chars.slice(0, at).join('') + g.pick(['/*', '//', '"', '\\', ',', '\u2028', '\u00a0', ',\u00a0}', ',/* x */]']) + chars.slice(at + 1).join('');
  }
  if (g.chance(0.03)) text = '{"compilerOptions":{"paths":{"@/*":["a/*"],"@/*":["b/*"],"0":["z"],"b":["y"],"a":["x"]}}}';
  return text;
}

function randomAlias(g: Gen, pool: readonly string[]): AliasConfig {
  const alias: AliasConfig = { paths: [] };
  if (g.chance(0.4)) alias.baseUrl = g.pick(['', 'src', 'lib', 'app', '.', 'components']);
  for (let n = g.int(4); n > 0; n--) alias.paths.push({ pattern: g.pick(PATTERNS), targets: Array.from({ length: 1 + g.int(3) }, () => g.pick(TARGETS)) });
  if (g.chance(0.5) && pool.length > 0) alias.paths.push({ pattern: '@/*', targets: ['./*', 'src/*'] });
  return alias;
}

function randomPool(g: Gen): string[] {
  const set = new Set<string>();
  for (let n = 4 + g.int(24); n > 0; n--) set.add(randomFile(g));
  // 실제 소스 파일 모양을 더 많이: 확장자가 소스인 것
  for (let n = 4 + g.int(8); n > 0; n--) set.add(`${g.pick(DIRS)}${g.chance(0.9) ? '/' : ''}${g.pick(NAMES)}${g.pick(['.tsx', '.ts', '.jsx', '.js', '.mjs', '.mdx'])}`.replace(/^\//, ''));
  return [...set];
}

const THROWS = Symbol('throws');
function observe(fn: () => unknown): string {
  try {
    return JSON.stringify(fn()) ?? 'undefined';
  } catch (error) {
    return `${String(THROWS.description)}:${(error as Error).name}`;
  }
}

function reverseJson(map: Map<string, Set<string>>): unknown {
  return [...map].map(([k, v]) => [k, [...v]]);
}

// ───────────────────────── 차등 시험 ─────────────────────────

const SEEDS = [20_261_110, 7, 424_242, 91_823_411];
const ROUNDS = 25_000;

describe('import-graph 순수 코어: 옛 TS와 Rust 껍데기가 같게 읽는다', { timeout: 180_000 }, () => {
  it('경로 판정(isPageFileInService·routeWrapperFolder·isGraphSourceFile·normalizeServicePath)', () => {
    let compared = 0;
    const seen = { page: 0, notPage: 0, wrapper: 0, source: 0, notSource: 0, normalizeUndefined: 0, normalizeValue: 0, normalizeEmpty: 0 };
    for (const seed of SEEDS) {
      const g = gen(seed);
      for (let i = 0; i < ROUNDS; i++) {
        const value = g.chance(0.5) ? randomFile(g) : g.chance(0.5) ? weirdPath(g) : `${g.pick(['', 'src/', 'App/', 'app/'])}${weirdPath(g)}${g.pick(['', '/page.tsx', '/layout.js', '/error.mdx', 'page.ts', '\n/page.tsx', '/page.tsx\n'])}`;
        const expected = [legacy.isPageFileInService(value), legacy.routeWrapperFolder(value), legacy.isGraphSourceFile(value), legacy.normalizeServicePath(value)];
        const actual = [isPageFileInService(value), routeWrapperFolder(value), isGraphSourceFile(value), normalizeServicePath(value)];
        expect(JSON.stringify(actual), JSON.stringify(value)).toBe(JSON.stringify(expected));
        compared += 4;
        if (expected[0]) seen.page++; else seen.notPage++;
        if (expected[1] !== undefined) seen.wrapper++;
        if (expected[2]) seen.source++; else seen.notSource++;
        if (expected[3] === undefined) seen.normalizeUndefined++; else if (expected[3] === '') seen.normalizeEmpty++; else seen.normalizeValue++;
      }
    }
    console.log('경로 판정', compared, seen);
    for (const [name, count] of Object.entries(seen)) expect(count, name).toBeGreaterThan(1000);
  });

  it('tokenize·extractImportSpecifiers', () => {
    let compared = 0;
    const seen = { empty: 0, one: 0, many: 0, withSurrogate: 0, withBom: 0, withLineSep: 0, tokens: 0 };
    for (const seed of SEEDS) {
      const g = gen(seed);
      const pool = randomPool(g);
      for (let i = 0; i < ROUNDS; i++) {
        const from = g.pick(pool);
        const source = randomSource(g, from, pool);
        const expectedTokens = JSON.stringify(legacy.tokenize(source));
        expect(JSON.stringify(tokenize(source)), JSON.stringify(source)).toBe(expectedTokens);
        const expected = legacy.extractImportSpecifiers(source);
        expect(JSON.stringify(extractImportSpecifiers(source)), JSON.stringify(source)).toBe(JSON.stringify(expected));
        compared += 2;
        if (expected.length === 0) seen.empty++; else if (expected.length === 1) seen.one++; else seen.many++;
        if (/[\ud800-\udbff]/.test(source)) seen.withSurrogate++;
        if (source.includes('\ufeff')) seen.withBom++;
        if (source.includes('\u2028')) seen.withLineSep++;
        seen.tokens += JSON.parse(expectedTokens).length;
      }
    }
    console.log('tokenize·extract', compared, seen);
    for (const [name, count] of Object.entries(seen)) if (name !== 'tokens') expect(count, name).toBeGreaterThan(1500);
  });

  it('stripJsonc·tsconfigExtendsPath·parseAliasConfig(extends로 물려받는 경우 포함)', () => {
    let compared = 0;
    const seen = { alias: 0, aliasWithPaths: 0, aliasWithBase: 0, aliasPathsFirst: 0, baseGiven: 0, unreadable: 0, extendsFound: 0, stripChanged: 0 };
    for (const seed of SEEDS) {
      const g = gen(seed);
      for (let i = 0; i < ROUNDS; i++) {
        const text = randomAliasText(g);
        const configDir = g.pick(['', '', 'apps/web', 'a/b', '..', '.', 'é']);
        const base = g.chance(0.4) ? legacy.parseAliasConfig(randomAliasText(g), g.pick(['', 'x']), undefined) : undefined;
        expect(stripJsonc(text), JSON.stringify(text)).toBe(legacy.stripJsonc(text));
        expect(JSON.stringify(tsconfigExtendsPath(text, configDir)), JSON.stringify({ text, configDir })).toBe(JSON.stringify(legacy.tsconfigExtendsPath(text, configDir)));
        const expected = legacy.parseAliasConfig(text, configDir, base);
        const actual = parseAliasConfig(text, configDir, base);
        expect(JSON.stringify(actual), JSON.stringify({ text, configDir, base })).toBe(JSON.stringify(expected));
        compared += 3;
        seen.alias++;
        if (expected.paths.length > 0) seen.aliasWithPaths++;
        if (expected.baseUrl !== undefined) seen.aliasWithBase++;
        if (JSON.stringify(expected).startsWith('{"paths"') && expected.baseUrl !== undefined) seen.aliasPathsFirst++;
        if (base) seen.baseGiven++;
        try {
          JSON.parse(legacy.stripJsonc(text));
        } catch {
          seen.unreadable++;
        }
        if (legacy.tsconfigExtendsPath(text, configDir) !== undefined) seen.extendsFound++;
        if (legacy.stripJsonc(text) !== text) seen.stripChanged++;
      }
    }
    console.log('JSONC·별칭', compared, seen);
    for (const [name, count] of Object.entries(seen)) expect(count, name).toBeGreaterThan(1000);
  });

  it('resolveImport', () => {
    let compared = 0;
    const seen = { found: 0, notFound: 0, relative: 0, alias: 0, withDollar: 0 };
    for (const seed of SEEDS) {
      const g = gen(seed);
      for (let i = 0; i < ROUNDS; i++) {
        const pool = randomPool(g);
        const files = new Set(pool.filter((file) => legacy.isGraphSourceFile(file) || g.chance(0.3)));
        const alias = g.chance(0.5) ? randomAlias(g, pool) : legacy.parseAliasConfig(randomAliasText(g), '', undefined);
        const from = g.pick(pool);
        for (let k = 0; k < 4; k++) {
          const specifier = specifierFor(g, from, pool);
          const expected = legacy.resolveImport(specifier, from, files, alias);
          expect(JSON.stringify(resolveImport(specifier, from, files, alias)), JSON.stringify({ specifier, from, files: [...files], alias })).toBe(JSON.stringify(expected));
          compared++;
          if (expected === undefined) seen.notFound++; else seen.found++;
          if (specifier.startsWith('.')) seen.relative++;
          if (/^[@~]/.test(specifier)) seen.alias++;
          if (specifier.includes('$')) seen.withDollar++;
        }
      }
    }
    console.log('resolveImport', compared, seen);
    for (const [name, count] of Object.entries(seen)) expect(count, name).toBeGreaterThan(1500);
  });

  it('buildReverseGraph(Map·Set의 삽입 순서까지)', () => {
    let compared = 0;
    const seen = { edges: 0, empty: 0, selfOnly: 0, multiImporters: 0 };
    for (const seed of SEEDS) {
      const g = gen(seed);
      for (let i = 0; i < ROUNDS / 5; i++) {
        const pool = randomPool(g);
        const files = new Set(pool.filter((file) => legacy.isGraphSourceFile(file) || g.chance(0.2)));
        const sources = new Map<string, string>();
        for (const file of g.chance(0.8) ? pool : pool.filter(() => g.chance(0.6))) {
          if (g.chance(0.85)) sources.set(file, randomSource(g, file, pool));
        }
        const alias = g.chance(0.5) ? randomAlias(g, pool) : { paths: [] };
        const expected = JSON.stringify(reverseJson(legacy.buildReverseGraph(sources, files, alias)));
        expect(JSON.stringify(reverseJson(buildReverseGraph(sources, files, alias))), JSON.stringify({ sources: [...sources], files: [...files], alias })).toBe(expected);
        compared++;
        const rows = JSON.parse(expected) as Array<[string, string[]]>;
        if (rows.length === 0) seen.empty++;
        seen.edges += rows.length;
        if (rows.some(([, importers]) => importers.length > 1)) seen.multiImporters++;
        if ([...sources].some(([file, source]) => legacy.extractImportSpecifiers(source).length > 0 && !rows.some(([, importers]) => importers.includes(file)))) seen.selfOnly++;
      }
    }
    console.log('buildReverseGraph', compared, seen);
    for (const [name, count] of Object.entries(seen)) expect(count, name).toBeGreaterThan(1000);
  });

  it('tracePages: UTF-16 순서 판본과는 글자까지 같고, localeCompare 판본과는 순서만 다르다', () => {
    let compared = 0;
    let orderOnly = 0;
    let setDiffers = 0;
    const seen = { candidates: 0, noCandidates: 0, truncated: 0, wrapperChanged: 0, depthZero: 0, multiCause: 0, tieBreaks: 0 };
    for (const seed of SEEDS) {
      const g = gen(seed);
      for (let i = 0; i < ROUNDS; i++) {
        const pool = randomPool(g).concat(g.chance(0.5) ? ['app/page.tsx', 'app/layout.tsx', 'app/B/page.tsx', 'app/a/page.tsx', 'app/é/page.tsx', 'app/_/page.tsx', 'app/Z/page.tsx'] : []);
        const files = new Set(pool.filter((file) => legacy.isGraphSourceFile(file) || g.chance(0.2)));
        const members = [...files];
        if (members.length === 0) continue;
        const reverse = new Map<string, Set<string>>();
        for (let n = g.int(members.length * 2); n > 0; n--) {
          const target = g.chance(0.95) ? g.pick(members) : g.pick(SPECS);
          const set = reverse.get(target) ?? new Set<string>();
          set.add(g.pick(members));
          reverse.set(target, set);
        }
        const changed = Array.from({ length: g.int(5) }, () => (g.chance(0.9) ? g.pick(members) : weirdPath(g)));
        const maxDepth = g.pick([-1, 0, 1, 1, 2, 3, 5, 5, 8, Number.POSITIVE_INFINITY, Number.NaN, 2.5]);
        const input = () => JSON.stringify({ changed, reverse: reverseJson(reverse), files: members, maxDepth }, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : v));
        const expected = JSON.stringify(legacy.tracePages(changed, reverse, files, maxDepth));
        const actual = JSON.stringify(tracePages(changed, reverse, files, maxDepth));
        expect(actual, input()).toBe(expected);
        compared++;
        const viaLocale = legacyLocale.tracePages(changed, reverse, files, maxDepth);
        if (JSON.stringify(viaLocale) !== expected) {
          orderOnly++;
          const key = (c: { page: string; cause: string; distance: number; tie: number }) => JSON.stringify(c);
          const a = viaLocale.candidates.map(key).sort();
          const b = legacy.tracePages(changed, reverse, files, maxDepth).candidates.map(key).sort();
          if (JSON.stringify(a) !== JSON.stringify(b) || JSON.stringify(viaLocale.truncated) !== JSON.stringify(legacy.tracePages(changed, reverse, files, maxDepth).truncated)) setDiffers++;
        }
        const result = JSON.parse(expected) as { candidates: Array<{ page: string; cause: string; distance: number; tie: number }>; truncated: unknown[] };
        if (result.candidates.length > 0) seen.candidates++; else seen.noCandidates++;
        if (result.truncated.length > 0) seen.truncated++;
        if (changed.some((file) => legacy.routeWrapperFolder(file) !== undefined)) seen.wrapperChanged++;
        if (maxDepth === 0) seen.depthZero++;
        if (new Set(result.candidates.map((c) => c.cause)).size > 1) seen.multiCause++;
        if (result.candidates.some((c, k) => k > 0 && result.candidates[k - 1]!.distance === c.distance && result.candidates[k - 1]!.tie === c.tie)) seen.tieBreaks++;
      }
    }
    console.log('tracePages', compared, { 정렬만_다른_입력: orderOnly, 후보_집합이_다른_입력: setDiffers }, seen);
    expect(setDiffers).toBe(0);
    // 대조 장치: localeCompare 판본과는 실제로 다른 입력이 있다(이 시험이 정렬 차이를 볼 수 있다는 증거)
    expect(orderOnly).toBeGreaterThan(0);
    for (const [name, count] of Object.entries(seen)) expect(count, name).toBeGreaterThan(1000);
  });

  it('대조 장치: 한쪽만 달라지면 시험이 잡는다(역슬래시를 안 바꾸는 normalize)', () => {
    const g = gen(99);
    let differs = 0;
    const naive = (value: string): string | undefined => {
      const out: string[] = [];
      for (const part of value.split('/')) {
        if (part === '' || part === '.') continue;
        if (part === '..') {
          if (out.length === 0) return undefined;
          out.pop();
          continue;
        }
        out.push(part);
      }
      return out.join('/');
    };
    for (let i = 0; i < 3000; i++) {
      const value = weirdPath(g);
      if (naive(value) !== normalizeServicePath(value)) differs++;
    }
    expect(differs).toBeGreaterThan(100);
  });
});
