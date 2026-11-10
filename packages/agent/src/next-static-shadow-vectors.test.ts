import { chmodSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findStaticShadows as findNew, StaticShadowUnknownError, type StaticShadow, type StaticShadowInput } from './next-static-shadow';
import { findStaticShadows as findLegacy, StaticShadowUnknownError as LegacyUnknownError } from './next-static-shadow-legacy';
import { buildProject } from './next-static-shadow-testkit';

/**
 * 고정 경로 판정(ADR-191 3aa)의 벡터. 기대값은 옛 TS(`next-static-shadow-legacy.ts`)가 낸 값이다. 옛 구현에 돌리면(`STATIC_SHADOW_IMPL=legacy`, 의도한 차이는 "다르다"를 단언한다)
 * `intended`로 표시한 것만 실패해야 하고, 그것들은 옛 구현이 놓쳤거나(옛 [] → 새 겹침) 더 막는 쪽으로 바꾼 곳이다.
 */
/** `legacy`: 옛 구현에 돌려 intended만 다른지 본다. `legacy-raw`: 옛 구현에 돌려 intended도 기대값 그대로 견준다(고치기 전 실패 출력용) */
const IMPL = process.env['STATIC_SHADOW_IMPL'] ?? 'new';
const find = IMPL.startsWith('legacy') ? findLegacy : findNew;

/** unknown: StaticShadowUnknownError 메시지에 든 글 */
type Expected = { shadows: Array<[string, string, string]> } | { unknown: string };

interface Vector {
  name: string;
  files?: string[];
  links?: Record<string, string>;
  service?: string;
  page: string;
  values: Record<string, string>;
  check?: string[];
  maxFolders?: number;
  expected: Expected;
  /** 옛 구현과 다른 곳(의도한 차이) */
  intended?: boolean;
}

const hit = (name: string, value: string, where: string): Expected => ({ shadows: [[name, value, where]] });
const none: Expected = { shadows: [] };
const PAGE = 'web/app/orders/[id]/page.tsx';

async function run(vector: Vector, implementation: typeof find): Promise<Expected> {
  const root = buildProject(vector.files ?? [], vector.links ?? {});
  const input: StaticShadowInput = {
    root,
    servicePath: vector.service ?? 'web',
    pageFile: vector.page,
    values: vector.values,
    check: new Set(vector.check ?? Object.keys(vector.values)),
    ...(vector.maxFolders === undefined ? {} : { maxFolders: vector.maxFolders }),
  };
  try {
    const shadows: StaticShadow[] = await implementation(input);
    return { shadows: shadows.map((s): [string, string, string] => [s.name, s.value, s.where]) };
  } catch (error) {
    if (error instanceof StaticShadowUnknownError || error instanceof LegacyUnknownError) return { unknown: error.message };
    throw error;
  }
}

const vectors: Vector[] = [];

// ── 이름을 견주는 규칙: 같은 자리의 이름 하나와 값 하나. 폴더(page 있음)와 파일, pages 라우터에서 모두 본다
interface NameCase {
  entry: string;
  value: string;
  match: boolean;
  intended?: boolean;
}
const NAME_CASES: NameCase[] = [
  { entry: 'new', value: 'new', match: true },
  { entry: 'New', value: 'new', match: true },
  { entry: 'NEW', value: 'new', match: true },
  { entry: 'new', value: 'NEW', match: true },
  { entry: 'new.tsx', value: 'new', match: true },
  { entry: 'new.page.tsx', value: 'new', match: true },
  { entry: 'new.', value: 'new', match: true },
  { entry: '%6Eew', value: 'new', match: true },
  { entry: 'new%2Etsx', value: 'new', match: true },
  { entry: '%5Fnew', value: '_new', match: true },
  { entry: '_new', value: '%5Fnew', match: true },
  { entry: '%E2%82%AC', value: '€', match: true },
  { entry: '€', value: '%E2%82%AC', match: true },
  { entry: 'new', value: 'new.json', match: true },
  { entry: 'newer', value: 'new', match: false },
  { entry: 'ne', value: 'new', match: false },
  { entry: 'xnew', value: 'new', match: false },
  { entry: 'new-', value: 'new', match: false },
  { entry: 'new_x', value: 'new', match: false },
  { entry: 'n.ew', value: 'new', match: false },
  { entry: '.new', value: 'new', match: false },
  { entry: 'new', value: 'newer', match: false },
  { entry: 'new', value: '70', match: false },
  { entry: '70.tsx', value: '7', match: false },
  { entry: '%', value: 'new', match: false },
  { entry: '%zz', value: '%zz', match: true },
  { entry: '[]', value: '[]', match: true },
  { entry: '[[x]]', value: '[[x]]', match: true },
  { entry: '%E2%82', value: 'x', match: false },
  { entry: '%80', value: '\u0080', match: false },
  { entry: '%C3%A9', value: '\u00e9', match: true },
  // 의도한 차이: 옛 구현이 놓치던 이름 꼴(더 막는 쪽)
  { entry: 'new ', value: 'new', match: true, intended: true },
  { entry: 'new. ', value: 'new', match: true },
  { entry: 'new​', value: 'new', match: true, intended: true },
  { entry: 'new .tsx', value: 'new', match: true, intended: true },
  { entry: 'new\uff0etsx', value: 'new', match: true, intended: true },
  { entry: 'ne​w', value: 'new', match: true, intended: true },
  { entry: 'ｎｅｗ', value: 'new', match: true, intended: true },
  { entry: 'café', value: 'café', match: true, intended: true },
  { entry: 'café', value: 'café', match: true, intended: true },
  { entry: 'new', value: 'new​', match: true, intended: true },
  { entry: 'new', value: 'ｎｅｗ', match: true, intended: true },
  { entry: 'Kafka', value: 'kafka', match: true },
  { entry: 'new�', value: 'new\ud800', match: true, intended: true },
  { entry: 'new�', value: 'new\udc00', match: true, intended: true },
  { entry: 'newx', value: 'new\ud800', match: false },
];
for (const c of NAME_CASES) {
  const label = `${JSON.stringify(c.entry)} 와 값 ${JSON.stringify(c.value)}`;
  const where = (base: string): Expected => (c.match ? hit('id', c.value, `${base}/${c.entry}`) : none);
  vectors.push({ name: `app 폴더: ${label}`, files: [`web/app/orders/${c.entry}/layout.tsx`], page: PAGE, values: { id: c.value }, expected: where('web/app/orders'), ...(c.intended ? { intended: true } : {}) });
  vectors.push({ name: `app 파일: ${label}`, files: [`web/app/orders/${c.entry}`], page: PAGE, values: { id: c.value }, expected: where('web/app/orders'), ...(c.intended ? { intended: true } : {}) });
  vectors.push({ name: `pages 파일: ${label}`, files: [`web/pages/orders/${c.entry}`], page: PAGE, values: { id: c.value }, expected: where('web/pages/orders'), ...(c.intended ? { intended: true } : {}) });
}

// ── 그룹·슬롯·인터셉트
const group = (name: string, entry: string, expected: Expected, extra: Partial<Vector> = {}): void => {
  vectors.push({ name, files: [entry], page: PAGE, values: { id: 'new' }, expected, ...extra });
};
group('그룹 안의 같은 자리 이름', 'web/app/(a)/orders/new/page.tsx', hit('id', 'new', 'web/app/(a)/orders/new'));
group('그룹 둘 겹침', 'web/app/(a)/(b)/orders/(c)/new/page.tsx', hit('id', 'new', 'web/app/(a)/(b)/orders/(c)/new'));
group('슬롯 안', 'web/app/orders/@modal/new/page.tsx', hit('id', 'new', 'web/app/orders/@modal/new'));
group('빈 이름 슬롯 `@`', 'web/app/orders/@/new/page.tsx', hit('id', 'new', 'web/app/orders/@/new'));
group('인터셉트 `(.)new`는 건너뛴다', 'web/app/orders/(.)new/page.tsx', none);
group('인터셉트 `(..)new`', 'web/app/orders/(..)new/page.tsx', none);
group('인터셉트 `(...)new`', 'web/app/orders/(...)new/page.tsx', none);
group('인터셉트 `(..)(..)new`', 'web/app/orders/(..)(..)new/page.tsx', none);
group('점 네 개 `(....)`는 그룹이다', 'web/app/(....)/orders/new/page.tsx', hit('id', 'new', 'web/app/(....)/orders/new'));
group('다른 깊이의 이름은 겹치지 않는다', 'web/app/(a)/new/page.tsx', none);
group('앞 조각이 다르면 내려가지 않는다', 'web/app/other/new/page.tsx', none);
group('대소문자만 다른 앞 조각', 'web/app/Orders/new/page.tsx', hit('id', 'new', 'web/app/Orders/new'));
group('앞 조각이 인코딩된 이름', 'web/app/%6Frders/new/page.tsx', hit('id', 'new', 'web/app/%6Frders/new'));
group('앞 조각이 점이 든 이름', 'web/app/orders.x/new/page.tsx', hit('id', 'new', 'web/app/orders.x/new'));
vectors.push({ name: '값이 동적 폴더 이름 꼴(`[id]`)이어도 그 폴더는 고정 경로가 아니다', files: ['web/app/orders/[id]/page.tsx'], page: PAGE, values: { id: '[id]' }, expected: none });
group('동적 형제는 고정 경로가 아니다', 'web/app/orders/[new]/page.tsx', none);
group('캐치올 형제는 고정 경로가 아니다', 'web/app/orders/[...new]/page.tsx', none);
group('앞 조각 자리의 동적 폴더를 따라 내려간다', 'web/app/[x]/orders/new/page.tsx', none);
group('줄 끝 글자가 든 그룹 이름(옛 구현은 그룹으로 읽지 못했다)', 'web/app/(a\nb)/orders/new/page.tsx', hit('id', 'new', 'web/app/(a\nb)/orders/new'), { intended: true });
group('줄 끝 글자(U+2028)가 든 그룹 이름', 'web/app/(a b)/orders/new/page.tsx', hit('id', 'new', 'web/app/(a b)/orders/new'), { intended: true });
group('빈 그룹 `()`(Next.js는 그룹으로 본다)', 'web/app/()/orders/new/page.tsx', hit('id', 'new', 'web/app/()/orders/new'), { intended: true });
group('줄 끝 글자가 든 그룹 이름이 값과 같은 일반 이름이기도 하다', 'web/app/orders/(a\nb)/page.tsx', hit('id', '(a\nb)', 'web/app/orders/(a\nb)'), { values: { id: '(a\nb)' } } as Partial<Vector>);

// ── 서비스 폴더와 라우터 루트
vectors.push({ name: 'src/app의 page가 app의 고정 경로를 본다', files: ['web/app/orders/new/page.tsx'], page: 'web/src/app/orders/[id]/page.tsx', values: { id: 'new' }, expected: hit('id', 'new', 'web/app/orders/new') });
vectors.push({ name: 'pages와 src/pages', files: ['web/src/pages/orders/new.tsx'], page: PAGE, values: { id: 'new' }, expected: hit('id', 'new', 'web/src/pages/orders/new.tsx') });
vectors.push({ name: '서비스 폴더가 없는 프로젝트(루트)', files: ['app/orders/new/page.tsx'], service: '', page: 'app/orders/[id]/page.tsx', values: { id: 'new' }, expected: hit('id', 'new', 'app/orders/new') });
vectors.push({ name: '서비스 폴더 `.`', files: ['app/orders/new/page.tsx'], service: '.', page: './app/orders/[id]/page.tsx', values: { id: 'new' }, expected: hit('id', 'new', 'app/orders/new') });
vectors.push({ name: '서비스 폴더 `./web/`와 역슬래시 page 경로', files: ['web/app/orders/new/page.tsx'], service: './web/', page: 'web\\app\\orders\\[id]\\page.tsx', values: { id: 'new' }, expected: hit('id', 'new', 'web/app/orders/new') });
vectors.push({ name: '서비스 폴더가 두 단계', files: ['apps/web/app/orders/new/page.tsx'], service: 'apps/web', page: 'apps/web/app/orders/[id]/page.tsx', values: { id: 'new' }, expected: hit('id', 'new', 'apps/web/app/orders/new') });
vectors.push({ name: '서비스 폴더 밖의 같은 이름은 보지 않는다', files: ['other/app/orders/new/page.tsx'], page: PAGE, values: { id: 'new' }, expected: none });
vectors.push({ name: '서비스 폴더가 page 경로의 접두가 아니면 모른다', page: 'app/orders/[id]/page.tsx', values: { id: 'new' }, expected: { unknown: 'page 파일 경로를 알아볼 수 없습니다: app/orders/[id]/page.tsx' } });
vectors.push({ name: '서비스 폴더 이름만 같은 접두(`web2/`)는 접두가 아니다', page: 'web2/app/orders/[id]/page.tsx', values: { id: 'new' }, expected: { unknown: 'page 파일 경로를 알아볼 수 없습니다' } });
for (const bad of ['web/components/Card.tsx', 'web/app/orders/[id]/layout.tsx', 'web/app/orders/[id]/page.css', 'web/pages/orders/[id].tsx', 'web/app/a\nb/page.tsx', 'web/app/orders/[id]/Page.tsx', 'web/lib/app/orders/[id]/page.tsx']) {
  vectors.push({ name: `page 경로를 알아볼 수 없다: ${JSON.stringify(bad)}`, page: bad, values: { id: 'new' }, expected: { unknown: 'page 파일 경로를 알아볼 수 없습니다' } });
}
for (const ext of ['tsx', 'jsx', 'ts', 'js', 'mdx']) {
  vectors.push({ name: `page 확장자 ${ext}`, files: ['web/app/orders/new/x'], page: `web/app/orders/[id]/page.${ext}`, values: { id: 'new' }, expected: hit('id', 'new', 'web/app/orders/new') });
}
vectors.push({ name: 'page 확장자 css는 아니다', page: 'web/app/orders/[id]/page.cssx', values: { id: 'new' }, expected: { unknown: 'page 파일 경로' } });
vectors.push({ name: 'app 바로 아래 page(동적 세그먼트 없음)는 겹칠 것이 없다', files: ['web/app/new/page.tsx'], page: 'web/app/page.tsx', values: {}, check: [], expected: none });

// ── 동적 세그먼트와 채운 값
vectors.push({ name: '값이 비어 있으면 모른다', page: PAGE, values: { id: '' }, expected: { unknown: '동적 세그먼트 \'id\'에 채운 값을 알 수 없습니다' } });
vectors.push({ name: '값이 없으면 모른다', page: PAGE, values: {}, check: ['id'], expected: { unknown: '동적 세그먼트 \'id\'에 채운 값을 알 수 없습니다' } });
vectors.push({ name: '캐치올 이름은 점이 든 채로 읽는다', files: ['web/app/docs/guide/page.tsx'], page: 'web/app/docs/[...slug]/page.tsx', values: { '...slug': 'guide' }, expected: hit('...slug', 'guide', 'web/app/docs/guide') });
vectors.push({
  name: '여러 동적 세그먼트: 확인 대상만 본다',
  files: ['web/app/shops/[shopId]/orders/new/page.tsx', 'web/app/shops/main/page.tsx'],
  page: 'web/app/shops/[shopId]/orders/[id]/page.tsx',
  values: { shopId: 'main', id: 'new' },
  check: ['id'],
  expected: hit('id', 'new', 'web/app/shops/[shopId]/orders/new'),
});
vectors.push({
  name: '여러 동적 세그먼트: 앞 조각도 확인 대상이면 따로 겹친다',
  files: ['web/app/shops/main/page.tsx'],
  page: 'web/app/shops/[shopId]/orders/[id]/page.tsx',
  values: { shopId: 'main', id: '7' },
  expected: hit('shopId', 'main', 'web/app/shops/main'),
});
vectors.push({
  name: '둘 다 겹친다',
  files: ['web/app/shops/main/orders/new/page.tsx'],
  page: 'web/app/shops/[shopId]/orders/[id]/page.tsx',
  values: { shopId: 'main', id: 'new' },
  expected: { shadows: [['shopId', 'main', 'web/app/shops/main'], ['id', 'new', 'web/app/shops/main/orders/new']] },
});
vectors.push({ name: '확인 대상이 아니면 겹쳐도 보고하지 않는다', files: ['web/app/orders/new/page.tsx'], page: PAGE, values: { id: 'new' }, check: [], expected: none });
vectors.push({ name: '채운 값이 앞 조각 이름이면 그 자리의 하위 경로를 본다', files: ['web/app/orders/new/edit/page.tsx'], page: 'web/app/orders/[id]/edit/page.tsx', values: { id: 'new' }, expected: hit('id', 'new', 'web/app/orders/new') });
vectors.push({ name: '그룹이 낀 page 경로(그룹은 주소에서 뺀다)', files: ['web/app/orders/new/page.tsx'], page: 'web/app/(shop)/orders/(detail)/[id]/page.tsx', values: { id: 'new' }, expected: hit('id', 'new', 'web/app/orders/new') });
vectors.push({ name: '슬롯이 낀 page 경로', files: ['web/app/orders/new/page.tsx'], page: 'web/app/@modal/orders/[id]/page.tsx', values: { id: 'new' }, expected: hit('id', 'new', 'web/app/orders/new') });
vectors.push({ name: '인터셉트 폴더가 낀 page 경로는 주소 조각으로 남는다', files: ['web/app/(.)orders/new/page.tsx'], page: 'web/app/(.)orders/[id]/page.tsx', values: { id: 'new' }, expected: none });

// ── public의 정적 파일
const asset = (name: string, files: string[], page: string, values: Record<string, string>, expected: Expected, extra: Partial<Vector> = {}): void => {
  vectors.push({ name, files, page, values, expected, ...extra });
};
asset('public 파일이 채운 주소 전체와 같다', ['web/public/orders/new/edit'], 'web/app/orders/[id]/edit/page.tsx', { id: 'new' }, hit('id', 'new', 'web/public/orders/new/edit'));
asset('public 폴더도 같다(파일이 아니어도)', ['web/public/orders/new/'], PAGE, { id: 'new' }, hit('id', 'new', 'web/public/orders/new'));
asset('public의 이름이 한 글자 다르면 겹치지 않는다', ['web/public/orders/news'], PAGE, { id: 'new' }, none);
asset('public의 접두만 같으면 겹치지 않는다', ['web/public/orders'], 'web/app/orders/[id]/edit/page.tsx', { id: 'new' }, none);
asset('public은 이름을 접지 않고 파일 시스템이 읽는 대로 본다(확장자가 붙으면 다른 이름)', ['web/public/orders/new.png'], PAGE, { id: 'new' }, none);
asset('public 파일이 여러 값에 걸치면 확인 대상 모두를 겹친 것으로 본다', ['web/public/shops/main/orders/new'], 'web/app/shops/[shopId]/orders/[id]/page.tsx', { shopId: 'main', id: 'new' }, {
  shadows: [['shopId', 'main', 'web/public/shops/main/orders/new'], ['id', 'new', 'web/public/shops/main/orders/new']],
});
asset('이미 app에서 겹친 이름은 public에서 또 더하지 않는다', ['web/app/orders/new/x', 'web/public/orders/new'], PAGE, { id: 'new' }, hit('id', 'new', 'web/app/orders/new'));
asset('public이 파일이면(폴더가 아니면) 아래를 따라갈 수 없다', ['web/public'], PAGE, { id: 'new' }, none);
asset('채운 값에 `..`이 있으면 모른다(옛 구현은 줄여 읽었다)', ['web/public/x'], PAGE, { id: '..' }, { unknown: '채운 값이 경로 조각이 아니라' }, { intended: true });
asset('채운 값이 `.`이면 모른다(옛 구현은 public 자체와 겹쳤다)', ['web/public/x'], PAGE, { id: '.' }, { unknown: '채운 값이 경로 조각이 아니라' }, { intended: true });
asset('채운 값에 `/`가 있으면 모른다(옛 구현은 하위 경로로 읽었다)', ['web/public/a/b'], PAGE, { id: 'a/b' }, { unknown: '채운 값이 경로 조각이 아니라' }, { intended: true });
asset('채운 값에 NUL이 있으면 확인하지 못한 것이다', ['web/public/orders/x'], PAGE, { id: 'a\u0000b' }, { unknown: '을(를) 확인하지 못했습니다' });

// ── 심볼릭 링크는 따라가지 않는다
const linkCase = (name: string, links: Record<string, string>, files: string[] = [], expected: Expected = { unknown: '심볼릭 링크라 그 너머의 경로를 확인할 수 없습니다' }, extra: Partial<Vector> = {}): void => {
  vectors.push({ name, files: ['web/app/orders/x/page.tsx', ...files], links, page: PAGE, values: { id: 'new' }, expected, ...extra });
};
linkCase('고정 경로가 링크여도 겹친 것으로 본다', { 'web/app/orders/new': '@root/web/elsewhere' }, ['web/elsewhere/page.tsx'], hit('id', 'new', 'web/app/orders/new'));
linkCase('끊어진 링크도 겹친 것으로 본다', { 'web/app/orders/new': '/workspace/gone' }, [], hit('id', 'new', 'web/app/orders/new'));
linkCase('그룹이 링크', { 'web/app/(admin)': '/workspace/web/groups' }, [], { unknown: 'web/app/(admin)이(가) 심볼릭 링크라' });
linkCase('슬롯이 링크', { 'web/app/orders/@modal': '/workspace/web/slot' });
linkCase('앞 조각과 이름이 같은(인코딩만 다른) 폴더가 링크', { 'web/app/%6Frders': '/workspace/web/o' });
linkCase('앞 조각 자리의 동적 폴더가 링크', { 'web/app/[x]': '/workspace/web/o' });
linkCase('app이 링크', { 'web/app2': '/x', 'web/src/app': '/workspace/web/app' }, [], { unknown: 'web/src/app이(가) 심볼릭 링크라' });
linkCase('pages가 링크', { 'web/pages': '/workspace/web/legacy' });
linkCase('public이 링크', { 'web/public': '/workspace/web/static' });
linkCase('서비스 폴더가 링크', { web2: '@root/web' }, [], { unknown: '심볼릭 링크라' }, { service: 'web2', page: 'web2/app/orders/[id]/page.tsx' });
linkCase('주소와 상관없는 링크는 막지 않는다', { 'web/app/docs': '/workspace/web/s', 'web/app/orders/assets': '/workspace/web/s', 'web/app/orders/(.)photo': '/workspace/s' }, [], none, { values: { id: '7' } });
linkCase('인터셉트 폴더 링크는 건너뛴다', { 'web/app/orders/(.)new': '/workspace/web/s' }, [], none);
linkCase('앞 조각이 아닌 이름의 링크 폴더는 건너뛴다', { 'web/app/other': '/workspace/web/s' }, [], none);
linkCase('링크인 고정 경로 앞에서 이미 찾았으면 뒤의 링크는 보지 않는다', { 'web/app/orders/zzz-link': '/workspace/s' }, [], none, { values: { id: '7' } });

vectors.push({ name: 'app과 pages 둘 다 겹쳐도 한 번만 보고한다(먼저 찾은 app의 것)', files: ['web/app/orders/new/x', 'web/pages/orders/new.tsx'], page: PAGE, values: { id: 'new' }, expected: hit('id', 'new', 'web/app/orders/new') });
vectors.push({ name: 'pages가 파일이면 라우터 루트가 아니다', files: ['web/pages', 'web/app/orders/x/page.tsx'], page: PAGE, values: { id: 'new' }, expected: none });
vectors.push({ name: 'src/app이 파일이어도 같다', files: ['web/src/app', 'web/app/orders/x/page.tsx'], page: PAGE, values: { id: 'new' }, expected: none });
vectors.push({ name: '서비스 폴더에 `..`가 든 경로는 모른다(옛 구현은 줄여 읽었다)', files: ['web/app/orders/new/x'], service: 'web/../web', page: 'web/../web/app/orders/[id]/page.tsx', values: { id: 'new' }, expected: { unknown: '서비스 폴더 경로를 알아볼 수 없습니다' }, intended: true });
vectors.push({ name: '서비스 폴더에 `.` 조각이 든 경로는 모른다', files: ['web/app/orders/new/x'], service: 'web/./', page: 'web/./app/orders/[id]/page.tsx', values: { id: 'new' }, expected: { unknown: '서비스 폴더 경로를 알아볼 수 없습니다' }, intended: true });

// ── 읽기 실패·상한
const many = (count: number): string[] => Array.from({ length: count }, (_, index) => `web/app/(g${index})/orders/x/page.tsx`);
for (const [limit, expectedUnknown] of [[0, true], [1, true], [4, true], [7, true], [8, false], [9, false], [2000, false]] as const) {
  vectors.push({
    name: `폴더 상한 ${limit}(그룹 6개): 걸어 본 폴더는 app 1개 + 그룹 6개 + orders 6개 = 13`,
    files: many(6),
    page: PAGE,
    values: { id: 'new' },
    maxFolders: limit,
    // 13개를 걸어야 끝난다: 상한 13이 경계. 위 표의 값은 아래 expected 계산이 아니라 아래 경계 벡터가 맡는다
    expected: limit >= 13 ? none : { unknown: '살펴볼 폴더가 너무 많습니다' },
    ...(expectedUnknown ? {} : {}),
  });
}
for (const limit of [12, 13, 14]) {
  vectors.push({ name: `폴더 상한 경계 ${limit}`, files: many(6), page: PAGE, values: { id: 'new' }, maxFolders: limit, expected: limit >= 13 ? none : { unknown: '살펴볼 폴더가 너무 많습니다' } });
}
vectors.push({ name: '상한 2: app과 orders 둘을 걸어 찾는다', files: ['web/app/orders/new'], page: PAGE, values: { id: 'new' }, maxFolders: 2, expected: hit('id', 'new', 'web/app/orders/new') });
vectors.push({ name: '상한 1: orders까지 가지 못하고 모른다', files: ['web/app/orders/new'], page: PAGE, values: { id: 'new' }, maxFolders: 1, expected: { unknown: '살펴볼 폴더가 너무 많습니다' } });
vectors.push({ name: '상한은 확인 대상마다가 아니라 한 번에 센다', files: ['web/app/shops/main/orders/y/x'], page: 'web/app/shops/[shopId]/orders/[id]/page.tsx', values: { shopId: 'a', id: 'b' }, maxFolders: 2, expected: { unknown: '살펴볼 폴더가 너무 많습니다' } });
vectors.push({ name: '폴더를 읽지 못하면(파일이어서) 모른다가 아니라 없는 것이다', files: ['web/app/orders'], page: PAGE, values: { id: 'new' }, expected: none });

describe('findStaticShadows 벡터(ADR-191 3aa): 기대값은 옛 TS가 낸 값', () => {
  it('벡터 수가 충분하다', () => {
    expect(vectors.length).toBeGreaterThanOrEqual(150);
    expect(vectors.filter((vector) => vector.intended).length).toBeGreaterThan(10);
  });

  for (const vector of vectors) {
    const intended = IMPL === 'legacy' && vector.intended === true;
    const title = `${intended ? '[의도한 차이: 옛 구현은 다르다] ' : ''}${vector.name}`;
    it(title, async () => {
      const actual = await run(vector, find);
      const expected = vector.expected;
      const matches = 'unknown' in expected ? 'unknown' in actual && actual.unknown.includes(expected.unknown) : JSON.stringify(actual) === JSON.stringify(expected);
      if (intended) {
        expect(matches).toBe(false);
        return;
      }
      if ('unknown' in expected) expect(actual).toEqual({ unknown: expect.stringContaining(expected.unknown) });
      else expect(actual).toEqual(expected);
    });
  }
});

describe('짝 없는 서로게이트: 이름 견주기는 거부 목록이라 파일 시스템 꼴(U+FFFD)로 넓게 견준다', () => {
  it('인코딩 없이 보내면 서로 다른 서로게이트가 한 글자로 합쳐진다(JSON·napi 경계)', () => {
    const merged = (text: string): string => text.replace(/[\ud800-\udfff]/g, '\ufffd');
    expect(merged('new\ud800')).toBe('new\ufffd');
    expect(merged('new\ud800')).toBe(merged('new\udc00'));
    expect('new\ud800').not.toBe('new\udc00');
  });

  it('두 값 모두 U+FFFD 이름과 겹친 것으로 본다(더 막는 쪽). 옛 구현은 어느 쪽도 겹치지 않는다고 했다. 결과의 value는 입력 그대로다', async () => {
    for (const value of ['new\ud800', 'new\udc00']) {
      const root = buildProject(['web/app/orders/new\ufffd/page.tsx']);
      const input = { root, servicePath: 'web', pageFile: PAGE, values: { id: value }, check: new Set(['id']) };
      expect(await findNew(input)).toEqual([{ name: 'id', value, where: 'web/app/orders/new\ufffd' }]);
      expect(await findLegacy(input)).toEqual([]);
    }
  });

  it('짝이 맞는 서로게이트 쌍은 그대로 견준다', async () => {
    const root = buildProject(['web/app/orders/\u{1F600}/page.tsx']);
    const input = (value: string) => ({ root, servicePath: 'web', pageFile: PAGE, values: { id: value }, check: new Set(['id']) });
    expect(await findNew(input('\u{1F600}'))).toEqual([{ name: 'id', value: '\u{1F600}', where: 'web/app/orders/\u{1F600}' }]);
    expect(await findNew(input('\u{1F601}'))).toEqual([]);
    expect(await findLegacy(input('\u{1F601}'))).toEqual([]);
  });
});

describe('폴더를 읽지 못하면 모른다(빈 폴더로 읽지 않는다)', () => {
  const unreadable = process.getuid?.() === 0 ? it.skip : it;
  for (const [label, find] of [['새 구현', findNew], ['옛 구현', findLegacy]] as const) {
    unreadable(`${label}: 읽기 권한이 없는 폴더는 StaticShadowUnknownError`, async () => {
      const root = buildProject(['web/app/orders/new/page.tsx']);
      const locked = path.join(root, 'web/app/orders');
      chmodSync(locked, 0o000);
      try {
        await expect(find({ root, servicePath: 'web', pageFile: PAGE, values: { id: 'new' }, check: new Set(['id']) })).rejects.toThrow('web/app/orders 폴더를 읽지 못했습니다');
      } finally {
        chmodSync(locked, 0o755);
      }
    });
  }
});
