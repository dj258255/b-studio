import type { HighlighterCore } from 'shiki/core';

/** 한 줄의 토큰. className은 밝은·어두운 테마 색 변수(--shiki-light, --shiki-dark)를 담은 CSS 규칙이다 */
export type HighlightedLine = Array<{ content: string; className?: string }>;

/**
 * 한 번에 토큰화할 줄 수. 강조는 화면 스레드에서 돌고, 1,500줄을 한 번에 토큰화하고 그리면 화면이 1초 넘게 멈췄다(트러블슈팅 28).
 * 조각 사이에 브라우저가 입력과 그리기를 처리하게 한다
 */
const LINES_PER_CHUNK = 100;
/** 압축한 코드처럼 아주 긴 줄은 토큰화하지 않고 한 덩어리로 둔다. 줄 단위로 나눠도 한 줄이 조각 하나를 오래 붙잡는다 */
const MAX_LINE_LENGTH = 2_000;

export interface HighlightOptions {
  /** 조각을 끝낼 때마다 지금까지 강조한 줄을 넘긴다. 화면을 위에서부터 채울 수 있다 */
  onProgress?: (lines: HighlightedLine[]) => void;
  /** 파일이 바뀌면 남은 조각을 강조하지 않는다 */
  signal?: AbortSignal;
  linesPerChunk?: number;
}

const THEMES = { light: 'github-light', dark: 'github-dark' } as const;

const BY_EXTENSION: Record<string, string> = {
  ts: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  tsx: 'tsx',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'jsx',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  gradle: 'groovy',
  groovy: 'groovy',
  py: 'python',
  go: 'go',
  rs: 'rust',
  rb: 'ruby',
  php: 'php',
  cs: 'csharp',
  sql: 'sql',
  json: 'json',
  yaml: 'yaml',
  yml: 'yaml',
  toml: 'toml',
  properties: 'properties',
  ini: 'ini',
  md: 'markdown',
  css: 'css',
  scss: 'scss',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  sh: 'shellscript',
  bash: 'shellscript',
  zsh: 'shellscript',
  prisma: 'prisma',
  vue: 'vue',
  svelte: 'svelte',
};

const BY_NAME: Record<string, string> = {
  dockerfile: 'docker',
  makefile: 'make',
  gradlew: 'shellscript',
  mvnw: 'shellscript',
};

/** 템플릿이 다루는 언어(Next.js, Spring Boot, FastAPI)와 흔한 설정 파일. 모두 JavaScript 정규식 엔진으로 불러오는 것을 테스트로 확인한다 */
export const SUPPORTED_LANGUAGES: ReadonlySet<string> = new Set([...Object.values(BY_EXTENSION), ...Object.values(BY_NAME), 'dotenv']);

export function languageFor(file: string): string | undefined {
  const name = (file.split('/').pop() ?? '').toLowerCase();
  if (BY_NAME[name]) return BY_NAME[name];
  if (name.startsWith('dockerfile.')) return 'docker';
  if (/^\.env(\..+)?$/.test(name)) return 'dotenv';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? BY_EXTENSION[name.slice(dot + 1)] : undefined;
}

let highlighter: Promise<HighlighterCore> | undefined;

/** Shiki는 코드를 처음 강조할 때 불러와 첫 화면 번들에 넣지 않는다. WASM이 필요 없는 JavaScript 정규식 엔진을 쓴다 */
function getHighlighter(): Promise<HighlighterCore> {
  highlighter ??= (async () => {
    const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, { bundledThemes }] = await Promise.all([
      import('shiki/core'),
      import('shiki/engine/javascript'),
      import('shiki/themes'),
    ]);
    return createHighlighterCore({
      themes: [bundledThemes[THEMES.light], bundledThemes[THEMES.dark]],
      langs: [],
      // 브라우저 정규식으로 옮기지 못하는 드문 문법 패턴은 건너뛰고 나머지로 강조한다
      engine: createJavaScriptRegexEngine({ forgiving: true }),
    });
  })().catch((error: unknown) => {
    highlighter = undefined;
    throw error;
  });
  return highlighter;
}

/**
 * 줄마다 토큰을 돌려준다. 모르는 언어면 undefined를 돌려 평문으로 보여 주게 한다.
 * 조각마다 문법 상태를 넘겨, 조각 경계를 넘는 여러 줄 주석이나 문자열도 한 번에 강조한 것과 같게 나온다
 */
export async function highlightLines(
  code: string,
  lang: string | undefined,
  { onProgress, signal, linesPerChunk = LINES_PER_CHUNK }: HighlightOptions = {},
): Promise<HighlightedLine[] | undefined> {
  if (!lang || !SUPPORTED_LANGUAGES.has(lang)) return undefined;
  const instance = await getHighlighter();
  if (!instance.getLoadedLanguages().includes(lang)) {
    const { bundledLanguages } = await import('shiki/langs');
    await instance.loadLanguage(bundledLanguages[lang as keyof typeof bundledLanguages]);
  }

  const source = code.split('\n');
  const lines: HighlightedLine[] = [];
  let grammarState: ReturnType<HighlighterCore['codeToTokens']>['grammarState'];
  for (let start = 0; start < source.length; start += linesPerChunk) {
    signal?.throwIfAborted();
    const result = instance.codeToTokens(source.slice(start, start + linesPerChunk).join('\n'), {
      lang,
      themes: THEMES,
      defaultColor: false,
      grammarState,
      tokenizeMaxLineLength: MAX_LINE_LENGTH,
    });
    grammarState = result.grammarState;
    for (const line of result.tokens) lines.push(mergeSameStyle(line));
    onProgress?.(lines.slice());
    if (start + linesPerChunk < source.length) await yieldToBrowser();
  }
  return lines;
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** 색이 같은 이웃 토큰과 공백만 있는 토큰을 합쳐 그릴 요소 수를 줄인다 */
function mergeSameStyle(line: ReadonlyArray<{ content: string; htmlStyle?: Record<string, string> }>): HighlightedLine {
  const merged: HighlightedLine = [];
  for (const token of line) {
    const className = classFor(token.htmlStyle);
    const last = merged.at(-1);
    if (last && (last.className === className || isBlank(token.content))) {
      last.content += token.content;
    } else if (last && isBlank(last.content)) {
      // 공백의 색은 보이지 않으므로 뒤 토큰의 색을 따른다
      last.content += token.content;
      last.className = className;
    } else {
      merged.push({ content: token.content, className });
    }
  }
  return merged;
}

const styleClasses = new Map<string, string>();
let styleSheet: CSSStyleSheet | undefined;

/**
 * 토큰 색 조합마다 CSS 클래스를 한 번만 만든다. 토큰마다 인라인 CSS 변수를 넣으면 요소마다 속성을 설정하느라
 * 그리는 시간이 길어진다. 값은 고정된 테마에서만 오므로 에이전트가 쓴 코드가 규칙에 들어가지 않는다
 */
function classFor(style: Record<string, string> | undefined): string | undefined {
  if (!style) return undefined;
  const declarations = Object.entries(style)
    .map(([property, value]) => `${property}:${value}`)
    .join(';');
  let name = styleClasses.get(declarations);
  if (!name) {
    name = `shiki-${styleClasses.size}`;
    styleClasses.set(declarations, name);
    insertRule(`.${name}{${declarations}}`);
  }
  return name;
}

function insertRule(rule: string): void {
  if (typeof document === 'undefined') return;
  if (!styleSheet) {
    const element = document.createElement('style');
    element.dataset.bStudio = 'highlight';
    document.head.append(element);
    styleSheet = element.sheet!;
  }
  styleSheet.insertRule(rule, styleSheet.cssRules.length);
}

/** 지금까지 만든 토큰 색 규칙. 테스트에서 클래스와 색을 확인할 때 쓴다 */
export function highlightStyleRules(): string[] {
  return [...styleClasses].map(([declarations, name]) => `.${name}{${declarations}}`);
}

function isBlank(text: string): boolean {
  return text.trim() === '';
}

export type PatchLineKind = 'file' | 'meta' | 'hunk' | 'added' | 'removed' | 'context' | 'other';

export interface PatchLine {
  text: string;
  kind: PatchLineKind;
  /** files의 위치. 첫 파일 머리말보다 앞선 줄은 -1 */
  file: number;
  /** 강조한 코드에서 이 줄의 위치. 삭제한 줄은 before, 추가한 줄과 문맥 줄은 after 기준이다 */
  index?: number;
}

export interface PatchFile {
  path: string;
  /** 문맥 줄과 삭제한 줄 */
  before: string[];
  /** 문맥 줄과 추가한 줄 */
  after: string[];
}

/**
 * git patch를 줄 종류로 나눈다. 강조는 파일마다 바꾸기 전 코드와 바꾼 뒤 코드를 따로 해서 여러 줄 주석 같은 문맥을 지킨다.
 * 훙크 안에서는 첫 글자로만 판단하므로, 지운 SQL 주석("--- …")을 파일 머리말로 잘못 보지 않는다
 */
export function parsePatch(patch: string): { lines: PatchLine[]; files: PatchFile[] } {
  const lines: PatchLine[] = [];
  const files: PatchFile[] = [];
  let inHunk = false;

  for (const text of patch.split('\n')) {
    const header = /^diff --git a\/.+ b\/(.+)$/.exec(text);
    if (header) {
      files.push({ path: header[1]!, before: [], after: [] });
      inHunk = false;
      lines.push({ text, kind: 'file', file: files.length - 1 });
      continue;
    }

    const file = files.at(-1);
    const position = files.length - 1;
    if (file && text.startsWith('@@')) {
      inHunk = true;
      lines.push({ text, kind: 'hunk', file: position });
    } else if (!file || !inHunk) {
      lines.push({ text, kind: file && text ? 'meta' : 'other', file: position });
    } else if (text.startsWith('+')) {
      lines.push({ text, kind: 'added', file: position, index: file.after.push(text.slice(1)) - 1 });
    } else if (text.startsWith('-')) {
      lines.push({ text, kind: 'removed', file: position, index: file.before.push(text.slice(1)) - 1 });
    } else if (text.startsWith(' ')) {
      file.before.push(text.slice(1));
      lines.push({ text, kind: 'context', file: position, index: file.after.push(text.slice(1)) - 1 });
    } else {
      lines.push({ text, kind: 'other', file: position });
    }
  }
  return { lines, files };
}
