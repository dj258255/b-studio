/**
 * 게이트의 자동 화면 고르기를 Rust로 옮기기 전(ADR-195 4f A5c-2) `gate.ts`의 `VerificationGate.#autoPages`와 그 아래
 * (`#withLatestSampleValues`·`#shadowedByStaticRoute`·`#followImports`·`#dynamicRouteFallback`·`#autoSkipCheck`, `withoutInRunValues`)를 그대로 둔 것이다.
 * 차등 시험(`auto-pages-differential.test.ts`)이 같은 시나리오를 이 옛 구현과 지금 구현에 넣어 견준다. 제품 코드는 이 파일을 쓰지 않는다(옛 선언한 검사 실행 `declared-legacy.ts`만 부른다). 지우지 않는다(4g에서 함께 지운다).
 *
 * 옛 코드가 `this.…`로 읽던 값은 `DeclaredHost`(`host.project`·`host.sandbox`·`host.signal`·`host.page.pageFetcher`·`host.auto`)로 읽는다. 순서와 분기는 옛 코드의 한 줄도 바꾸지 않았다.
 */
import { loadProject, SAFE_SEGMENT, SPEC_FILE, SpecError, type AutoPageChecks, type WorkflowPageCheck } from '@b-studio/spec';
import type { DeclaredHost } from './gate-check';
import { acceptedNotes, autoPageCheck, dynamicNames, readJsonPath, sampledValues, usesInRunValue, type LatestSampleValues } from './gate';
import { collectImportGraph, DEFAULT_IMPORT_GRAPH_LIMITS, DEFAULT_TRACE_DEPTH, isGraphSourceFile, isPageFileInService, tracePages, type PageCandidate } from './import-graph';
import { DEFAULT_DYNAMIC_ROUTE_FALLBACK, routesFromCandidates, routesFromChangedFiles, type NextRoute, type NextRoutes } from './next-routes';
import { findStaticShadows, StaticShadowUnknownError } from './next-static-shadow';
import { readProjectFileSync } from './workspace';
import type { WorkflowCheck } from './workflow';

/** 실행 중에 받아들였다가 고정 경로와 겹쳐 되돌리는 값 */
interface ShadowedValue {
  name: string;
  value: string;
  viaSampleIdFrom: boolean;
  reason: string;
}

/** 고정 경로와 겹친 값을 시작 때의 값으로 되돌린다(시작 때 없던 키는 지운다) */
function withoutInRunValues(latest: LatestSampleValues, started: AutoPageChecks, shadowed: readonly ShadowedValue[]): LatestSampleValues {
  const config: AutoPageChecks = { ...latest.config };
  const sampleParams = { ...config.sampleParams };
  const inRunKeys = new Set(latest.inRunKeys);
  let inRunSampleIdFrom = latest.inRunSampleIdFrom;
  const notes = [...latest.notes];
  for (const entry of shadowed) {
    if (entry.viaSampleIdFrom) {
      inRunSampleIdFrom = false;
      if (started.sampleIdFrom) config.sampleIdFrom = started.sampleIdFrom;
      else delete config.sampleIdFrom;
      notes.push(`${SPEC_FILE}의 autoPageChecks.sampleIdFrom으로 얻은 값(${entry.value})은 반영하지 않았습니다 — ${entry.reason}`);
      continue;
    }
    inRunKeys.delete(entry.name);
    const before = started.sampleParams?.[entry.name];
    if (before === undefined) delete sampleParams[entry.name];
    else sampleParams[entry.name] = before;
    notes.push(`${SPEC_FILE}의 autoPageChecks.sampleParams.${entry.name}=${entry.value}은(는) 반영하지 않았습니다 — ${entry.reason}. 그 동적 화면이 실제로 받는 값을 적으세요`);
  }
  if (Object.keys(sampleParams).length > 0) config.sampleParams = sampleParams;
  else delete config.sampleParams;
  return { config, notes, inRunKeys, inRunSampleIdFrom };
}

function autoSkipCheck(service: string, file: string, reason: string): WorkflowCheck {
  return { stage: 'browser_check', name: `${service} ${file} (자동, 건너뜀)`, ok: true, attempts: 1, detail: reason };
}

/** 옛 `#autoPages` */
export async function legacyAutoPages(
  host: DeclaredHost,
  declared: readonly WorkflowPageCheck[],
): Promise<{ pages: Array<{ page: WorkflowPageCheck; name: string; probedId?: string; sampled?: string }>; skipped: WorkflowCheck[] }> {
  const started = host.project.spec.workflow?.autoPageChecks;
  if (!started) return { pages: [], skipped: [] };
  const service = host.project.managed.find(([name]) => name === started.service);
  // 불러올 때 막지만(load.ts), 여기서도 조용히 넘어가지 않고 이유를 남긴다
  if (!service) {
    return {
      pages: [],
      skipped: [autoSkipCheck(started.service, started.service, `autoPageChecks.service '${started.service}'를 이 프로젝트의 관리형 서비스에서 찾지 못했습니다`)],
    };
  }

  // 실행 중에 에이전트가 알려 준 sample 값만 받아들인다. 나머지 설정은 시작 때의 것이다(ADR-159)
  let refreshed = await withLatestSampleValues(host, started);
  const followed = started.followImports === false ? undefined : await followImports(host, service[1].path);
  const build = (config: AutoPageChecks, fallback: string | undefined): NextRoutes =>
    followed
      ? routesFromCandidates(followed.candidates, service[1].path, config.sampleParams ?? {}, config.maxPages, fallback)
      : routesFromChangedFiles(host.auto.workspace.changedFiles(), service[1].path, config.sampleParams ?? {}, config.maxPages, fallback);
  let fallbackValue = await dynamicRouteFallback(host, refreshed.config);
  let found = build(refreshed.config, fallbackValue);
  // 시작 때의 값이었다면 열었을 화면인데 실행 중 값 때문에 목록에서 빠진 것. 시작 때의 값 그대로 되살려 연다
  const kept = new Map<NextRoute, string | undefined>();
  if (refreshed.inRunKeys.size > 0 || refreshed.inRunSampleIdFrom) {
    // 값은 "어떤 id로 여는가"만 정해야 한다. 값이 "무엇을 여는가"를 바꾸는 두 경우를 막는다(ADR-159 결정 11)
    const startedFallback = refreshed.inRunSampleIdFrom ? await dynamicRouteFallback(host, started) : fallbackValue;
    // ① 값을 채운 주소를 다른 고정 경로(app·pages 폴더, public 파일)가 먼저 받으면 그 화면이 대신 열린다 — 바뀐 동적 화면은 열리지 않는다
    const shadowed = await shadowedByStaticRoute(host, found.routes, service[1].path, refreshed, fallbackValue);
    if (shadowed.length > 0) {
      refreshed = withoutInRunValues(refreshed, started, shadowed);
      if (!refreshed.inRunSampleIdFrom) fallbackValue = startedFallback;
      found = build(refreshed.config, fallbackValue);
    }
    // ② 값이 바뀌면 경로 이름순이 바뀌어 다른 화면이 maxPages 밖으로 밀리거나, 두 파일이 같은 경로가 돼 하나가 빠질 수 있다
    const have = new Set(found.routes.map((route) => route.file));
    const dropped = build(started, startedFallback).routes.filter((route) => !have.has(route.file));
    if (dropped.length > 0) {
      for (const route of dropped) kept.set(route, startedFallback);
      const files = new Set(dropped.map((route) => route.file));
      found = { routes: [...found.routes, ...dropped], skipped: found.skipped.filter((entry) => !files.has(entry.file)) };
    }
  }
  const config = refreshed.config;
  const declaredKeys = new Set(declared.map((page) => `${page.service} ${page.path}`));
  const pages: Array<{ page: WorkflowPageCheck; name: string; probedId?: string; sampled?: string }> = [];
  const skipped = [
    ...[...refreshed.notes, ...acceptedNotes(refreshed)].map((note) => autoSkipCheck(config.service, SPEC_FILE, note)),
    ...(followed?.notes ?? []).map((note) => autoSkipCheck(config.service, note.file, note.reason)),
    ...found.skipped.map((entry) => autoSkipCheck(config.service, entry.file, entry.reason)),
  ];
  for (const route of found.routes) {
    // 선언한 pageChecks와 같은 경로는 두 번 열지 않는다. 단, 실행 중에 받아들인 값으로 채운 동적 경로는 건너뛰지 않는다: 에이전트가
    // 값을 골라 경로를 선언된 확인과 겹치게 만들면, 엄격한 자동 확인이 더 느슨할 수 있는 선언된 확인(콘솔 오류 허용 등)으로 바뀐다.
    // 값과 무관한 정적 경로는 지금처럼 건너뛴다
    const fromStart = kept.has(route);
    if ((fromStart || !usesInRunValue(route, refreshed)) && declaredKeys.has(`${config.service} ${route.path}`)) {
      skipped.push(autoSkipCheck(config.service, route.file, `${route.path}은(는) 이미 선언한 pageChecks에 있어 두 번 열지 않았습니다`));
      continue;
    }
    // id를 추정해 채운 동적 경로는 이름에 표시하고, 404·500만 실패로 보도록 probedId를 남긴다
    const fallback = fromStart ? kept.get(route) : fallbackValue;
    const probed = (route.usedFallbackParams?.length ?? 0) > 0 && fallback !== undefined;
    // sampleParams로 알려 준 값으로 연 동적 경로는 추정이 아니므로 엄격하게 판정한다. 실패하면 어느 값으로 열었는지 사유에 붙인다
    const sampled = probed ? undefined : sampledValues(route.file, (fromStart ? started : config).sampleParams);
    pages.push({
      page: autoPageCheck(config, route.path),
      name: `${config.service} ${route.path} (자동${probed ? ', id 추정' : ''}${route.cause ? ` · ${route.cause.slice(route.cause.lastIndexOf('/') + 1)} 변경` : ''})`,
      ...(probed ? { probedId: fallback } : {}),
      ...(sampled ? { sampled } : {}),
    });
  }
  return { pages, skipped };
}

/** 옛 `#withLatestSampleValues` */
async function withLatestSampleValues(host: DeclaredHost, started: AutoPageChecks): Promise<LatestSampleValues> {
  const { project, sandbox } = host;
  const { workspace } = host.auto;
  const unchanged: LatestSampleValues = { config: started, notes: [], inRunKeys: new Set(), inRunSampleIdFrom: false };
  let reload = host.auto.reloadProject;
  if (!reload) {
    if (!workspace.changedFiles().includes(SPEC_FILE)) return unchanged;
    // 디스크에서 다시 읽기 전에 설정 파일이 일반 파일인지 본다. 호스트에서 읽는 파일이라, 다른 곳으로 가는 링크로 바뀌어 있으면
    // 그 너머의 내용이 형식 오류 문구를 타고 모델에게 돌아갈 수 있다. 일반 파일이 아니면 읽지 않고 시작 때의 값으로 간다
    const file = readProjectFileSync(host.auto.projectRoot, SPEC_FILE);
    if (file.kind !== 'text') {
      return { ...unchanged, notes: [`${SPEC_FILE}을(를) 일반 파일로 읽을 수 없어(${file.kind === 'irregular' ? file.reason : '파일 없음'}) 이번 검증은 실행을 시작할 때의 autoPageChecks로 진행했습니다`] };
    }
    reload = () => loadProject(host.auto.projectRoot);
  }
  let latest: AutoPageChecks | undefined;
  try {
    latest = (await reload()).spec.workflow?.autoPageChecks;
  } catch (error) {
    // 형식 오류(SpecError)의 항목은 방금 확인한 일반 파일 studio.yaml에서 온 것이라 그대로 알려 준다. 그 밖의 오류 문구는 어디서 온
    // 내용인지 알 수 없으므로(설정이 가리키는 다른 파일일 수 있다) 문구를 싣지 않는다
    const detail = error instanceof SpecError ? `: ${sandbox.redact([error.message, ...error.issues].join(' / '))}` : '';
    return { ...unchanged, notes: [`${SPEC_FILE}의 새 값을 읽지 못해 이번 검증은 실행을 시작할 때의 autoPageChecks로 진행했습니다(sampleParams·sampleIdFrom 변경 미반영)${detail}`] };
  }
  if (!latest) return unchanged;
  const notes: string[] = [];
  const config: AutoPageChecks = { ...started };
  const inRunKeys = new Set<string>();
  let inRunSampleIdFrom = false;
  const changed = Object.entries(latest.sampleParams ?? {}).filter(([key, value]) => started.sampleParams?.[key] !== value);
  // 스키마가 이미 같은 제한을 걸지만, 경로 조각으로 쓰이는 값이라 여기서도 안전한 문자만 받는다(다른 문자는 경로를 바꿔 다른 화면을 열게 한다)
  const added = changed.filter(([key, value]) => SAFE_SEGMENT.test(key) && typeof value === 'string' && SAFE_SEGMENT.test(value));
  const rejected = changed.filter((entry) => !added.includes(entry)).map(([key]) => key);
  if (rejected.length > 0) notes.push(`${SPEC_FILE}의 autoPageChecks.sampleParams 중 ${rejected.join(', ')}은(는) 경로 조각으로 쓸 수 없는 값이라 반영하지 않았습니다(영문·숫자·_·-만)`);
  if (added.length > 0) {
    for (const [key] of added) inRunKeys.add(key);
    config.sampleParams = { ...started.sampleParams, ...Object.fromEntries(added) };
  }
  const from = latest.sampleIdFrom;
  if (from && JSON.stringify(from) !== JSON.stringify(started.sampleIdFrom)) {
    // 세션의 관리형 서비스만 부른다(load.ts의 pageChecks.expectFromApi와 같은 규칙). 시작 때 추정을 껐으면 id 추정 자체가 없어 쓰이지 않는다
    if (!project.managed.some(([name]) => name === from.service)) {
      notes.push(`${SPEC_FILE}의 autoPageChecks.sampleIdFrom.service '${from.service}'은(는) 이 프로젝트의 관리형 서비스가 아니라 반영하지 않았습니다`);
    } else if (started.dynamicRouteProbe === false) {
      notes.push(`autoPageChecks.dynamicRouteProbe가 실행을 시작할 때 꺼져 있어 sampleIdFrom은 반영하지 않았습니다(sampleParams는 반영됩니다)`);
    } else {
      config.sampleIdFrom = from;
      inRunSampleIdFrom = true;
    }
  }
  return { config, notes, inRunKeys, inRunSampleIdFrom };
}

/** 옛 `#shadowedByStaticRoute` */
async function shadowedByStaticRoute(host: DeclaredHost, routes: readonly NextRoute[], servicePath: string, latest: LatestSampleValues, fallbackValue: string | undefined): Promise<ShadowedValue[]> {
  const found = new Map<string, ShadowedValue>();
  for (const route of routes) {
    const names = dynamicNames(route.file);
    const viaFallback = new Set(latest.inRunSampleIdFrom ? (route.usedFallbackParams ?? []) : []);
    const check = new Set(names.filter((name) => latest.inRunKeys.has(name) || viaFallback.has(name)));
    if (check.size === 0) continue;
    const values: Record<string, string> = {};
    for (const name of names) {
      const value = route.usedFallbackParams?.includes(name) ? fallbackValue : latest.config.sampleParams?.[name];
      if (value !== undefined) values[name] = value;
    }
    const reject = (name: string, reason: string): void => {
      const viaSampleIdFrom = viaFallback.has(name);
      found.set(viaSampleIdFrom ? 'sampleIdFrom' : name, { name, value: values[name] ?? '', viaSampleIdFrom, reason });
    };
    try {
      const shadows = await findStaticShadows({ root: host.auto.workspace.root, servicePath, pageFile: route.file, values, check });
      for (const shadow of shadows) reject(shadow.name, `같은 주소를 고정 경로(${shadow.where})가 먼저 받아 그 화면이 대신 열립니다`);
    } catch (error) {
      const why = error instanceof StaticShadowUnknownError ? error.message : '폴더를 읽지 못했습니다';
      for (const name of check) reject(name, `같은 주소를 먼저 받는 고정 경로가 있는지 확인하지 못했습니다(${why})`);
    }
  }
  return [...found.values()];
}

/** 옛 `#followImports` */
async function followImports(host: DeclaredHost, servicePath: string): Promise<{ candidates: PageCandidate[]; notes: Array<{ file: string; reason: string }> } | undefined> {
  const prefix = servicePath.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/+$/, '');
  const inService = (file: string): string | undefined => (prefix === '' || prefix === '.' ? file : file.startsWith(`${prefix}/`) ? file.slice(prefix.length + 1) : undefined);
  const changed = host.auto.workspace
    .changedFiles()
    .map(inService)
    .filter((file): file is string => file !== undefined && isGraphSourceFile(file));
  if (changed.length === 0) return undefined;
  // 바뀐 소스가 전부 page 파일이면 import를 따라갈 이유가 없다 — 읽기 없이 예전 경로로 간다
  if (changed.every(isPageFileInService)) return undefined;

  const workspace = host.auto.workspace;
  try {
    const graph = await collectImportGraph(
      // peek: 게이트가 훑어본 파일에 에이전트용 읽은 표시를 남기지 않는다(다음 쓰기에 낡은 읽기 검사가 걸리지 않게)
      { list: (dir) => workspace.list(dir, 1), read: (file) => workspace.peek(file), now: () => Date.now() },
      servicePath,
      DEFAULT_IMPORT_GRAPH_LIMITS,
    );
    const trace = tracePages(changed, graph.reverse, graph.files, DEFAULT_TRACE_DEPTH);
    const toProject = (file: string): string => (prefix === '' || prefix === '.' ? file : `${prefix}/${file}`);
    const notes: Array<{ file: string; reason: string }> = [];
    if (graph.incomplete) {
      notes.push({
        file: 'import 역추적',
        reason: `${graph.incomplete}(읽은 파일 ${graph.readCount}개, ${graph.elapsedMs}ms) — 그래프가 일부만 만들어져 바뀐 파일을 쓰는 페이지를 모두 찾지 못했을 수 있습니다`,
      });
    }
    for (const entry of trace.truncated) {
      notes.push({
        file: toProject(entry.cause),
        reason: `${toProject(entry.cause)}에서 import를 거꾸로 ${DEFAULT_TRACE_DEPTH}단계까지 따라갔고, ${toProject(entry.stoppedAt)}를 쓰는 파일이 더 있지만 깊이 상한이라 멈췄습니다`,
      });
    }
    return { candidates: trace.candidates, notes };
  } catch (error) {
    // 그래프를 만들지 못해도 바뀐 page 파일 확인은 계속한다. 다만 못 찾았다는 사실을 남긴다
    const detail = error instanceof Error ? error.message : String(error);
    const ownPages = changed.filter(isPageFileInService).map((page) => ({ page, cause: page, distance: 0, tie: 0 }));
    return { candidates: ownPages, notes: [{ file: 'import 역추적', reason: `import 역추적에 실패해 바뀐 파일을 쓰는 페이지를 찾지 못했습니다: ${detail}` }] };
  }
}

/** 옛 `#dynamicRouteFallback` */
async function dynamicRouteFallback(host: DeclaredHost, config: AutoPageChecks): Promise<string | undefined> {
  if (config.dynamicRouteProbe === false) return undefined;
  const from = config.sampleIdFrom;
  if (!from) return DEFAULT_DYNAMIC_ROUTE_FALLBACK;
  try {
    const { sandbox, signal } = host;
    const pageFetcher = host.page.pageFetcher;
    const endpoint = await sandbox.endpoint(from.service);
    const url = new URL(from.path, endpoint.url);
    if (url.origin !== new URL(endpoint.url).origin) return DEFAULT_DYNAMIC_ROUTE_FALLBACK;
    const { status, text } = await pageFetcher(url.href, signal);
    if (status < 200 || status >= 300) return DEFAULT_DYNAMIC_ROUTE_FALLBACK;
    const value = readJsonPath(text, from.jsonPath);
    if ((typeof value === 'string' || typeof value === 'number') && SAFE_SEGMENT.test(String(value))) return String(value);
    return DEFAULT_DYNAMIC_ROUTE_FALLBACK;
  } catch {
    return DEFAULT_DYNAMIC_ROUTE_FALLBACK;
  }
}
