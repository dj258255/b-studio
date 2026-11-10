import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import { decodeNative, encodeNative, native } from '@b-studio/sandbox';

/**
 * 동적 경로(`app/orders/[id]/page.tsx`)를 어떤 값으로 채워 열 때, 라우터가 그 주소를 **다른 고정 경로**로 먼저 보내는지 본다(ADR-159 결정 11).
 *
 * 왜 필요한가: 자동 화면 확인은 실행 중에 에이전트가 알려 준 값으로 동적 경로를 채운다. 그 값이 같은 주소 자리의 고정 경로와 같으면
 * (`id: "new"`인데 `/orders/new`가 따로 있다) 바뀐 동적 화면 대신 다른 화면이 열려 확인 하나가 사라진다.
 *
 * 무엇을 고정 경로로 보는가(받지 않는 쪽으로 넓게 잡는다):
 *  - app 라우터(`app`·`src/app` 둘 다): 주소가 같은 자리에 오는 이름. 라우트 그룹 `(x)`와 병렬 라우트 `@slot`은 주소에 나타나지 않으므로
 *    통과해서 본다 — `app/(a)/orders/[id]`의 형제는 `app/(b)/orders/new`일 수도 있어, 부모 폴더 하나가 아니라 app 폴더에서부터 주소를 따라 내려간다.
 *  - pages 라우터(`pages`·`src/pages`): 같은 자리의 이름
 *  - `public/`: 채운 주소 전체와 같은 경로의 파일(정적 파일이 화면보다 먼저 나간다)
 *
 * 이름을 견주는 규칙(라우터와 내 해석이 달라질 수 있는 곳은 넓게 잡는다):
 *  - 폴더·파일·심볼릭 링크를 가리지 않는다(폴더 안에 page가 없어도, app 라우터의 파일이어도).
 *  - 이름의 `%5F` 같은 인코딩을 풀고(`%5Fnew`는 `/_new`를 받는다), 첫 점 앞까지만 보고(`new.tsx`·`new.page.tsx`), 대소문자를 가리지 않는다.
 *
 * 심볼릭 링크는 따라가지 않는다. 이 확인은 호스트에서 하고 화면은 컨테이너에서 열리는데, 링크는 두 곳에서 다른 곳을 가리킬 수 있다
 * (컨테이너 안에서만 유효한 절대 경로). 주소를 따라 내려가는 길(서비스 폴더, app·pages·public, 그룹·슬롯, 앞 조각과 이름이 같은 폴더)에
 * 링크가 있으면 그 너머를 알 수 없으므로 `StaticShadowUnknownError`를 던진다. 프로젝트 밖 폴더의 이름을 읽지도 않는다.
 *
 * 한계: 폴더 구조에 드러나지 않는 가로채기(미들웨어 rewrite, `next.config`의 redirects·rewrites)는 알 수 없다.
 * 폴더를 읽지 못하거나 살펴볼 폴더가 상한을 넘어도 `StaticShadowUnknownError`를 던진다 — 호출자는 값을 받지 않는 쪽으로 처리한다.
 *
 * 판정(이름 접기·그룹 구분·page 경로 읽기·내려갈 폴더 결정·겹침·"모름")은 Rust(crates/bstudio-guard/src/static_shadow.rs, ADR-191 3단계)가 하고,
 * 이 파일은 폴더 읽기(`readdir`·`lstat`)만 한다. Rust가 다음에 읽을 것 하나를 돌려주면 읽어서 넘기는 것을 끝날 때까지 되풀이한다.
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

const DEFAULT_MAX_FOLDERS = 2_000;

/** 짝 없는 서로게이트를 U+FFFD로(파일 시스템·napi 경계가 읽는 꼴). 이름 견주기는 거부 목록이라 합쳐져도 더 막을 뿐이다 */
const wellFormed = (text: string): string => text.replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '\ufffd');

type LstatKind = 'missing' | 'error' | 'link' | 'dir' | 'other';
interface Known {
  lstat: Record<string, LstatKind>;
  readdir: Record<string, Array<[string, 'l' | 'd' | 'f']> | null>;
}
type Step = { need: { kind: 'lstat' | 'readdir'; path: string } } | { shadows: Array<{ name: string; where: string }> } | { unknown: string };

/** 살펴볼 폴더 수 상한. 수가 아니거나 NaN이면 기본값(옛 구현은 NaN이면 상한이 없었다 — 더 막는 쪽으로 바꿨다), 끝없이 큰 값은 아주 큰 유한한 수 */
function folderLimit(value: number | undefined): number {
  if (value === undefined || Number.isNaN(value)) return DEFAULT_MAX_FOLDERS;
  return Math.max(-1, Math.min(value, 1e15));
}

export async function findStaticShadows(input: StaticShadowInput): Promise<StaticShadow[]> {
  const values: Record<string, string> = {};
  /** Rust가 돌려주는 이름은 파일 시스템 꼴이라, 원래 값은 그 꼴의 이름으로 찾는다(결과의 value는 짝 없는 서로게이트까지 입력 그대로) */
  const originals = new Map<string, string>();
  for (const [name, value] of Object.entries(input.values)) {
    values[wellFormed(name)] = wellFormed(value);
    originals.set(wellFormed(name), value);
  }
  const request = encodeNative({
    servicePath: wellFormed(input.servicePath),
    pageFile: wellFormed(input.pageFile),
    values,
    check: [...input.check].map((name) => wellFormed(name)),
    maxFolders: folderLimit(input.maxFolders),
  });
  const known: Known = { lstat: {}, readdir: {} };
  // 프로젝트 루트 기준 상대 경로(Rust가 만든 것)를 실제 경로로. 읽는 곳과 판정하는 곳이 같은 문자열이다
  const absolute = (relative: string): string => path.join(input.root, relative);
  for (;;) {
    const step = decodeNative<Step>(native.staticShadowStep(request, JSON.stringify(known)));
    if ('unknown' in step) throw new StaticShadowUnknownError(step.unknown);
    if ('shadows' in step) return step.shadows.map((shadow) => ({ name: shadow.name, value: originals.get(shadow.name) ?? '', where: shadow.where }));
    const target = step.need.path;
    // 이미 읽은 것을 또 달라고 하면 판정이 나아가지 않는다 — 끝없이 되풀이하지 않고 모른다고 던진다
    if (target in (step.need.kind === 'lstat' ? known.lstat : known.readdir)) throw new StaticShadowUnknownError(`${target}을(를) 읽었지만 판정이 나아가지 않습니다`);
    if (step.need.kind === 'lstat') {
      known.lstat[target] = await lstatKind(absolute(target));
    } else {
      known.readdir[target] = await listFolder(absolute(target));
    }
  }
}

async function lstatKind(absolutePath: string): Promise<LstatKind> {
  try {
    const stat = await lstat(absolutePath);
    return stat.isSymbolicLink() ? 'link' : stat.isDirectory() ? 'dir' : 'other';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'error';
  }
}

async function listFolder(absolutePath: string): Promise<Array<[string, 'l' | 'd' | 'f']> | null> {
  try {
    const entries = await readdir(absolutePath, { withFileTypes: true });
    return entries.map((entry): [string, 'l' | 'd' | 'f'] => [entry.name, entry.isSymbolicLink() ? 'l' : entry.isDirectory() ? 'd' : 'f']);
  } catch {
    return null;
  }
}
