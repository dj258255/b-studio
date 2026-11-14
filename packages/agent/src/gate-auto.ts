import { loadProject, AUTO_PAGE_DEFAULT, AUTO_PAGE_MAX, SPEC_FILE, SpecError, type AutoPageChecks } from '@b-studio/spec';
import type { DeclaredHost } from './gate-check';
import { collectImportGraph, DEFAULT_IMPORT_GRAPH_LIMITS, DEFAULT_TRACE_DEPTH } from './import-graph';
import { DEFAULT_DYNAMIC_ROUTE_FALLBACK } from './next-routes';
import { findStaticShadows, StaticShadowUnknownError } from './next-static-shadow';
import { failure, type HookHandler } from './verify';
import { readProjectFileSync } from './workspace';

/**
 * 게이트의 자동 화면 고르기(`#autoPages` 아래: 실행 중 sample 값 받기·고정 경로 가림 확인·밀려난 화면 되살리기·import 따라가기·동적 기본값·선언과 겹침·이름·건너뜀 check)는
 * Rust(`crates/bstudio-io/src/gate_auto.rs`, ADR-195 4f A5c-2)가 한다. 고르는 규칙·막는 규칙·글 조립은 모두 Rust에 있고, 여기는 그 Rust가 부르는 **바깥 동작**만 한다:
 * 작업 공간의 바뀐 파일 목록, studio.yaml 다시 읽기(일반 파일 확인 포함), 폴더를 읽는 고정 경로 확인(`findStaticShadows`), 작업 공간을 읽는 import 그래프(`collectImportGraph`).
 * 동적 기본값의 요청(sandbox endpoint·URL 풀기·페이지 요청)은 앞 조각의 콜백(`declaredEndpoint`·`declaredResolveUrl`·`declaredPageFetch`)을 그대로 쓴다.
 *
 * 응답은 `{ ok: true, ... }` 또는 `{ ok: false, error: { message } }`다. 알아볼 수 없는 응답은 Rust가 통과가 아니라 오류로 다룬다.
 */

/** `declaredBegin`의 응답에 싣는 자동 화면 고르기의 입력. 설정이 없으면 null이다 */
export function autoInput(declared: DeclaredHost): Record<string, unknown> | null {
  const started = declared.project.spec.workflow?.autoPageChecks;
  if (!started) return null;
  return {
    config: {
      service: started.service,
      mode: started.mode,
      expectStatus: started.expectStatus,
      maxPages: started.maxPages,
      viewport: started.viewport,
      // 객체의 키는 경계에서 인코딩되지 않아 짝 없는 서로게이트가 바뀐다. `[키, 값]` 쌍(Object.entries 순서)으로 보낸다
      sampleParams: started.sampleParams ? Object.entries(started.sampleParams) : null,
      sampleIdFrom: started.sampleIdFrom ?? null,
      dynamicRouteProbe: started.dynamicRouteProbe,
      followImports: started.followImports,
    },
    managed: declared.project.managed.map(([name, spec]) => ({ name, path: spec.path })),
    specFile: SPEC_FILE,
    maxPagesDefault: AUTO_PAGE_DEFAULT,
    maxPagesCap: AUTO_PAGE_MAX,
    defaultFallback: DEFAULT_DYNAMIC_ROUTE_FALLBACK,
    traceDepth: DEFAULT_TRACE_DEPTH,
  };
}

export function autoHandlers(declared: DeclaredHost): Record<string, HookHandler> {
  const { workspace, projectRoot } = declared.auto;
  return {
    autoChangedFiles: () => ({ ok: true, files: workspace.changedFiles() }),
    // 실행 중에 바뀐 studio.yaml에서 autoPageChecks를 다시 읽는다. 어떤 값을 받아들일지는 Rust가 정한다.
    // 설정 파일이 일반 파일인지 먼저 본다 — 호스트에서 읽는 파일이라 다른 곳으로 가는 링크로 바뀌어 있으면 그 너머의 내용이 형식 오류 문구를 타고 모델에게 돌아갈 수 있다
    autoLatest: async () => {
      let reload = declared.auto.reloadProject;
      if (!reload) {
        if (!workspace.changedFiles().includes(SPEC_FILE)) return { ok: true, state: 'unchanged' };
        const file = readProjectFileSync(projectRoot, SPEC_FILE);
        if (file.kind !== 'text') return { ok: true, state: 'irregular', reason: file.kind === 'irregular' ? file.reason : '파일 없음' };
        reload = () => loadProject(projectRoot);
      }
      let latest: AutoPageChecks | undefined;
      try {
        latest = (await reload()).spec.workflow?.autoPageChecks;
      } catch (error) {
        // 형식 오류(SpecError)의 항목은 방금 확인한 일반 파일 studio.yaml에서 온 것이라 그대로 알려 준다. 그 밖의 오류 문구는 어디서 온
        // 내용인지 알 수 없으므로(설정이 가리키는 다른 파일일 수 있다) 문구를 싣지 않는다
        const detail = error instanceof SpecError ? `: ${declared.sandbox.redact([error.message, ...error.issues].join(' / '))}` : '';
        return { ok: true, state: 'failed', detail };
      }
      if (!latest) return { ok: true, state: 'loaded', latest: null };
      return { ok: true, state: 'loaded', latest: { sampleParams: Object.entries(latest.sampleParams ?? {}), sampleIdFrom: latest.sampleIdFrom ?? null } };
    },
    // 다른 고정 경로가 같은 주소를 먼저 받는지(파일 시스템). 끝까지 확인하지 못했으면 이유를 알리고, Rust가 그 값을 받아들이지 않는다
    autoShadows: async ({ servicePath, pageFile, values, check }) => {
      try {
        const shadows = await findStaticShadows({
          root: workspace.root,
          servicePath: String(servicePath),
          pageFile: String(pageFile),
          values: Object.fromEntries(values as Array<[string, string]>),
          check: new Set(check as string[]),
        });
        return { ok: true, shadows: shadows.map((shadow) => ({ name: shadow.name, where: shadow.where })) };
      } catch (error) {
        return error instanceof StaticShadowUnknownError ? { ok: true, unknown: error.message } : { ok: true, unreadable: true };
      }
    },
    // 서비스 폴더의 소스를 읽어 역방향 import 그래프를 만든다. 읽기에 실패하면 실패 응답이고, Rust가 바뀐 page만으로 계속한다
    autoImportGraph: async ({ servicePath }) => {
      try {
        const graph = await collectImportGraph(
          // peek: 게이트가 훑어본 파일에 에이전트용 읽은 표시를 남기지 않는다(다음 쓰기에 낡은 읽기 검사가 걸리지 않게)
          { list: (dir) => workspace.list(dir, 1), read: (file) => workspace.peek(file), now: () => Date.now() },
          String(servicePath),
          DEFAULT_IMPORT_GRAPH_LIMITS,
        );
        return {
          ok: true,
          files: [...graph.files],
          reverse: [...graph.reverse].map(([target, importers]) => [target, [...importers]]),
          incomplete: graph.incomplete ?? null,
          readCount: graph.readCount,
          elapsedMs: graph.elapsedMs,
        };
      } catch (error) {
        return failure(error);
      }
    },
  };
}
