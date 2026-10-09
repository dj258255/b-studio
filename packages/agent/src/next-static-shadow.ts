import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * 동적 경로(`app/orders/[id]/page.tsx`)를 어떤 값으로 채워 열 때, 라우터가 그 주소를 **다른 고정 경로**로 먼저 보내는지 본다(ADR-159 결정 11).
 *
 * 왜 필요한가: 자동 화면 확인은 실행 중에 에이전트가 알려 준 값으로 동적 경로를 채운다. 그 값이 같은 주소 자리의 고정 경로와 같으면
 * (`id: "new"`인데 `/orders/new`가 따로 있다) 바뀐 동적 화면 대신 다른 화면이 열려 확인 하나가 사라진다.
 *
 * 무엇을 고정 경로로 보는가(받지 않는 쪽으로 넓게 잡는다):
 *  - app 라우터: 주소가 같은 자리에 오는 폴더. 라우트 그룹 `(x)`와 병렬 라우트 `@slot`은 주소에 나타나지 않으므로 통과해서 본다 —
 *    `app/(a)/orders/[id]`의 형제는 `app/(b)/orders/new`일 수도 있어, 부모 폴더 하나가 아니라 app 폴더에서부터 주소를 따라 내려간다.
 *  - pages 라우터(`pages`·`src/pages`): 같은 자리의 폴더와, 확장자를 뗀 이름이 값과 같은 파일
 *  - `public/`: 채운 주소 전체와 같은 경로의 파일(정적 파일이 화면보다 먼저 나간다)
 *  - 이름은 대소문자를 가리지 않고 견준다. 폴더·파일·심볼릭 링크를 가리지 않고 이름이 같으면 겹친 것으로 본다(폴더 안에 page가 없어도).
 *
 * 한계: 폴더 구조에 드러나지 않는 가로채기(미들웨어 rewrite, `next.config`의 redirects·rewrites)는 알 수 없다.
 * 폴더를 읽지 못하거나 살펴볼 폴더가 상한을 넘으면 `StaticShadowUnknownError`를 던진다 — 호출자는 값을 받지 않는 쪽으로 처리한다.
 */

export interface StaticShadow {
  /** 겹친 동적 세그먼트 이름 */
  name: string;
  /** 그 세그먼트에 채운 값 */
  value: string;
  /** 같은 주소를 먼저 받는 폴더·파일(프로젝트 루트 기준) */
  where: string;
}

/** 고정 경로가 있는지 끝까지 확인하지 못했다 */
export class StaticShadowUnknownError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StaticShadowUnknownError';
  }
}

export interface StaticShadowInput {
  /** 프로젝트 루트(절대 경로) */
  root: string;
  /** 서비스 폴더(프로젝트 루트 기준) */
  servicePath: string;
  /** 동적 경로의 page 파일(프로젝트 루트 기준) */
  pageFile: string;
  /** 동적 세그먼트 이름 → 채운 값. 이 page의 모든 동적 세그먼트가 들어 있어야 한다 */
  values: Readonly<Record<string, string>>;
  /** 확인할 동적 세그먼트 이름(실행 중에 받아들인 값으로 채운 것) */
  check: ReadonlySet<string>;
  /** 살펴볼 폴더 수 상한 */
  maxFolders?: number;
}

const PAGE_FILE = /^((?:src\/)?app)\/(?:(.*)\/)?page\.(?:tsx|jsx|ts|js|mdx)$/;
const DYNAMIC_FOLDER = /^\[([^[\]]+)\]$/;
/** 인터셉트 라우트 `(.)x`·`(..)x`는 주소를 직접 열 때 쓰이지 않는다 */
const INTERCEPT_FOLDER = /^\(\.{1,3}\)/;
const GROUP_FOLDER = /^\(.+\)$/;
const MAX_FOLDERS = 2_000;

function normalize(value: string): string {
  return value.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/{2,}/g, '/').replace(/\/$/, '');
}

/** 주소에 나타나지 않는 폴더: 라우트 그룹과 병렬 라우트 슬롯 */
function isTransparent(name: string): boolean {
  return name.startsWith('@') || (GROUP_FOLDER.test(name) && !INTERCEPT_FOLDER.test(name));
}

export async function findStaticShadows(input: StaticShadowInput): Promise<StaticShadow[]> {
  const prefix = normalize(input.servicePath);
  const inService = prefix === '' || prefix === '.';
  const file = normalize(input.pageFile);
  const relative = inService ? file : file.startsWith(`${prefix}/`) ? file.slice(prefix.length + 1) : undefined;
  const match = relative === undefined ? null : PAGE_FILE.exec(relative);
  if (!match) throw new StaticShadowUnknownError(`page 파일 경로를 알아볼 수 없습니다: ${input.pageFile}`);
  const serviceRoot = inService ? input.root : path.join(input.root, prefix);
  const toProject = (absolute: string): string => normalize(path.relative(input.root, absolute));

  // 주소 조각: 그룹·슬롯은 빼고, 동적 세그먼트는 채운 값으로 바꾼다
  const url: Array<{ text: string; dynamic?: string }> = [];
  for (const folder of (match[2] ?? '').split('/').filter(Boolean)) {
    if (isTransparent(folder)) continue;
    const dynamic = DYNAMIC_FOLDER.exec(folder)?.[1];
    if (dynamic === undefined) {
      url.push({ text: folder });
      continue;
    }
    const value = input.values[dynamic];
    if (value === undefined || value === '') throw new StaticShadowUnknownError(`동적 세그먼트 '${dynamic}'에 채운 값을 알 수 없습니다`);
    url.push({ text: value, dynamic });
  }

  let budget = input.maxFolders ?? MAX_FOLDERS;
  const same = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

  /**
   * dir 아래에서 target 주소(마지막 조각이 확인할 값)와 같은 자리에 오는 고정 이름을 찾는다. depth는 지금까지 맞춘 주소 조각 수.
   * files가 참이면(pages 라우터) 마지막 자리에서 확장자를 뗀 파일 이름도 견준다.
   */
  const walk = async (dir: string, target: readonly string[], depth: number, files: boolean): Promise<string | undefined> => {
    budget -= 1;
    if (budget < 0) throw new StaticShadowUnknownError('살펴볼 폴더가 너무 많습니다');
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // 맨 위 폴더가 없으면(pages 라우터를 쓰지 않는 등) 겹칠 것이 없다. 링크가 폴더가 아닌 것을 가리킬 때도 같다
      if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
      throw new StaticShadowUnknownError(`${toProject(dir)} 폴더를 읽지 못했습니다`);
    }
    const last = depth === target.length - 1;
    const want = target[depth]!;
    for (const entry of entries) {
      const child = path.join(dir, entry.name);
      // 링크는 폴더를 가리킬 수 있으므로 폴더처럼 다룬다(가리키는 곳이 폴더가 아니면 아래 readdir가 조용히 넘어간다)
      const folderLike = entry.isDirectory() || entry.isSymbolicLink();
      if (folderLike && isTransparent(entry.name)) {
        const found = await walk(child, target, depth, files);
        if (found) return found;
        continue;
      }
      if (INTERCEPT_FOLDER.test(entry.name)) continue;
      if (last) {
        // 같은 자리의 동적 폴더는 이 화면 자신이거나 다른 동적 경로다 — 고정 경로가 아니다
        if (DYNAMIC_FOLDER.test(entry.name)) continue;
        const name = files && !folderLike ? entry.name.replace(/\.[^.]+$/, '') : entry.name;
        if ((folderLike || files) && same(name, want)) return toProject(child);
        continue;
      }
      if (folderLike && (same(entry.name, want) || DYNAMIC_FOLDER.test(entry.name))) {
        const found = await walk(child, target, depth + 1, files);
        if (found) return found;
      }
    }
    return undefined;
  };

  const shadows: StaticShadow[] = [];
  const names = url.filter((segment) => segment.dynamic !== undefined && input.check.has(segment.dynamic));
  for (const [index, segment] of url.entries()) {
    if (segment.dynamic === undefined || !input.check.has(segment.dynamic)) continue;
    const target = url.slice(0, index + 1).map((part) => part.text);
    const where =
      (await walk(path.join(serviceRoot, match[1]!), target, 0, false)) ??
      (await walk(path.join(serviceRoot, 'pages'), target, 0, true)) ??
      (await walk(path.join(serviceRoot, 'src/pages'), target, 0, true));
    if (where) shadows.push({ name: segment.dynamic, value: segment.text, where });
  }

  // public의 정적 파일은 채운 주소 전체와 같을 때만 겹친다. 어느 값 때문인지 가릴 수 없으므로 확인 대상 값 모두를 겹친 것으로 본다
  if (url.length > 0 && names.length > 0) {
    const asset = path.join(serviceRoot, 'public', ...url.map((part) => part.text));
    let exists = false;
    try {
      await lstat(asset);
      exists = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw new StaticShadowUnknownError(`${toProject(asset)}을(를) 확인하지 못했습니다`);
    }
    if (exists) {
      for (const segment of names) {
        if (!shadows.some((shadow) => shadow.name === segment.dynamic)) shadows.push({ name: segment.dynamic!, value: segment.text, where: toProject(asset) });
      }
    }
  }
  return shadows;
}
