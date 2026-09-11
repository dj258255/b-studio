"use client";

import { memo, useEffect, useMemo, useState } from "react";
import { languageFor, type HighlightedLine } from "@/lib/highlight";
import { latestWrite, type SessionView } from "@/lib/session-view";
import type { CodeFile, CodeSearch, CodeTree } from "@/lib/studio-events";
import { CodeTokens, useHighlightedCode } from "./code-tokens";
import { DiffView } from "./diff-view";

const CHANGE_LABEL = { added: "추가", modified: "수정", deleted: "삭제" } as const;
const CHANGE_TONE = { added: "text-pass", modified: "text-wait", deleted: "text-fail" } as const;
/** 한 번에 받는 파일 수. 서버의 기본 쪽 크기와 같다 */
const PAGE_SIZE = 500;
/** 입력을 멈춘 뒤 서버에 물어보기까지 기다리는 시간 */
const TYPING_DELAY_MS = 250;

type SearchMode = "path" | "content";

/**
 * 샌드박스에서 실제로 도는 코드. 에이전트가 파일을 쓰거나 고칠 때마다 이벤트 스트림을 따라 다시 불러와,
 * 요청이 끝나기 전에도 무엇을 바꾸고 있는지 볼 수 있다.
 * 파일이 많은 저장소를 위해 목록은 서버에서 좁혀 쪽 단위로 받고, 내용 찾기도 서버가 한다
 */
export function CodePanel({ view }: { view: SessionView }) {
  const { snapshot, chat } = view;
  const write = useMemo(() => latestWrite(chat), [chat]);
  const [tree, setTree] = useState<CodeTree>();
  const [files, setFiles] = useState<string[]>([]);
  // 결과를 요청 조건과 함께 두어, 조건이 바뀌면 효과에서 상태를 되돌리지 않고도 헌 결과를 쓰지 않는다
  const [found, setFound] = useState<{ key: string; data?: CodeSearch; error?: string }>();
  const [mode, setMode] = useState<SearchMode>("path");
  const [query, setQuery] = useState("");
  const [applied, setApplied] = useState("");
  const [selected, setSelected] = useState<string>();
  const [file, setFile] = useState<CodeFile | { path: string; error: string }>();
  const [showDiff, setShowDiff] = useState(false);
  const [follow, setFollow] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string>();

  // 쓰기, 요청 완료, 체크포인트·되돌리기·가져오기, 서비스 안에서 명령이 바꾼 파일이 있을 때마다 목록을 새로 받는다
  const revision = `${write.count}|${view.completedRuns}|${snapshot.checkpoints[0]?.sha ?? ""}|${snapshot.status}|${snapshot.fileRevision ?? 0}`;
  const active = follow && write.path ? write.path : selected;
  const needle = applied.trim();

  useEffect(() => {
    const timer = setTimeout(() => setApplied(query), TYPING_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let cancelled = false;
    const search = mode === "path" && needle ? `&query=${encodeURIComponent(needle)}` : "";
    fetch(`/api/sessions/${snapshot.id}/files?offset=0&limit=${PAGE_SIZE}${search}`)
      .then(async (response) => {
        const data = await response.json();
        if (cancelled) return;
        if (response.ok) {
          setTree(data as CodeTree);
          setFiles((data as CodeTree).files);
          setError(undefined);
        } else setError(data.error ?? "파일 목록을 불러오지 못했습니다");
      })
      .catch((reason: unknown) => !cancelled && setError(String(reason)));
    return () => {
      cancelled = true;
    };
  }, [snapshot.id, revision, mode, needle]);

  // 내용 찾기는 두 글자부터, 입력을 멈춘 뒤에만 서버에 묻는다
  const searchKey = mode === "content" && needle.length >= 2 ? `${revision}|${needle}` : "";
  useEffect(() => {
    if (!searchKey) return;
    let cancelled = false;
    fetch(`/api/sessions/${snapshot.id}/files/search?q=${encodeURIComponent(needle)}`)
      .then(async (response) => {
        const data = await response.json();
        if (cancelled) return;
        setFound(response.ok ? { key: searchKey, data: data as CodeSearch } : { key: searchKey, error: data.error ?? "내용을 찾지 못했습니다" });
      })
      .catch((reason: unknown) => !cancelled && setFound({ key: searchKey, error: String(reason) }));
    return () => {
      cancelled = true;
    };
  }, [snapshot.id, searchKey, needle]);
  const current = found?.key === searchKey ? found : undefined;
  const search = current?.data;
  const searching = Boolean(searchKey) && !current;

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    fetch(`/api/sessions/${snapshot.id}/files/content?path=${encodeURIComponent(active)}`)
      .then(async (response) => {
        const data = await response.json();
        if (!cancelled) setFile(response.ok ? (data as CodeFile) : { path: active, error: data.error ?? "파일을 열지 못했습니다" });
      })
      .catch((reason: unknown) => !cancelled && setFile({ path: active, error: String(reason) }));
    return () => {
      cancelled = true;
    };
  }, [snapshot.id, active, revision]);

  const changes = tree?.changes ?? [];
  const changeOf = (path: string) => changes.find((change) => change.file === path)?.change;
  const open = (path: string) => {
    setFollow(false);
    setSelected(path);
    setShowDiff(false);
  };

  async function loadMore() {
    if (!tree) return;
    setLoadingMore(true);
    const search = mode === "path" && needle ? `&query=${encodeURIComponent(needle)}` : "";
    try {
      const response = await fetch(`/api/sessions/${snapshot.id}/files?offset=${files.length}&limit=${PAGE_SIZE}${search}`);
      const data = await response.json();
      if (response.ok) setFiles((current) => [...current, ...(data as CodeTree).files]);
      else setError(data.error ?? "파일 목록을 더 불러오지 못했습니다");
    } catch (reason: unknown) {
      setError(String(reason));
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-1 md:grid-cols-[18rem_minmax(0,1fr)]">
      <aside className="min-h-0 overflow-y-auto border-b border-line md:border-r md:border-b-0" aria-label="파일">
        <div className="border-b border-line px-4 py-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={follow} onChange={(event) => setFollow(event.target.checked)} className="accent-ink" />
            에이전트가 고치는 파일 따라가기
          </label>
          <p className="mt-1 text-xs leading-5 text-muted">
            {snapshot.running ? "요청을 처리하는 중입니다. 파일을 쓰면 바로 반영됩니다." : "마지막 체크포인트 이후 바뀐 파일을 먼저 보여 줍니다."}
          </p>
        </div>

        {error && <p className="px-4 py-3 text-sm text-fail">{error}</p>}

        <h3 className="px-4 pt-3 text-sm font-semibold">바뀐 파일 {changes.length}개</h3>
        <ul className="px-2 py-1">
          {changes.length === 0 && <li className="px-2 py-1 text-xs text-muted">체크포인트 이후 바뀐 파일이 없습니다.</li>}
          {changes.map((change) => (
            <li key={change.file}>
              <FileButton path={change.file} active={active === change.file} onOpen={open} badge={change.change} fresh={write.path === change.file} />
            </li>
          ))}
        </ul>

        <h3 className="border-t border-line px-4 pt-3 text-sm font-semibold">
          모든 파일 {tree ? `${tree.total.toLocaleString()}개` : ""}
          {mode === "path" && needle && tree && <span className="ml-1 font-normal text-muted">중 맞는 파일 {tree.total.toLocaleString()}개</span>}
        </h3>
        <div className="flex gap-1 px-4 pt-2" role="group" aria-label="찾는 방법">
          {(
            [
              ["path", "경로"],
              ["content", "내용"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
              className={`rounded-full px-3 py-1 text-xs ${mode === value ? "bg-ink text-panel" : "text-muted hover:text-ink"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="px-4 pt-2">
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={mode === "path" ? "파일 이름이나 경로로 찾기" : "파일 내용에서 찾기 (두 글자 이상)"}
            aria-label={mode === "path" ? "파일 찾기" : "내용 찾기"}
            className="w-full rounded-lg border border-line bg-panel px-2.5 py-1.5 font-mono text-xs placeholder:font-sans placeholder:text-muted"
          />
        </div>

        {mode === "content" ? (
          <div className="px-2 py-1 pb-3">
            {needle.length < 2 && <p className="px-2 py-1 text-xs text-muted">두 글자 이상 입력하면 파일 내용에서 찾습니다.</p>}
            {searching && <p className="px-2 py-1 text-xs text-muted">찾는 중</p>}
            {current?.error && <p className="px-2 py-1 text-xs text-fail">{current.error}</p>}
            {!searching && search && search.results.length === 0 && <p className="px-2 py-1 text-xs text-muted">&apos;{search.query}&apos;가 든 파일이 없습니다.</p>}
            <ul>
              {search?.results.map((result) => (
                <li key={result.file} className="pb-1">
                  <FileButton path={result.file} active={active === result.file} onOpen={open} badge={changeOf(result.file)} fresh={false} />
                  <ul className="pl-2">
                    {result.matches.map((match) => (
                      <li key={match.line}>
                        <button
                          type="button"
                          onClick={() => open(result.file)}
                          className="flex w-full gap-2 rounded px-2 py-0.5 text-left font-mono text-[11px] hover:bg-ground"
                        >
                          <span className="w-8 shrink-0 text-right text-muted">{match.line}</span>
                          <span className="min-w-0 truncate">
                            {match.text.slice(0, match.start)}
                            <mark className="bg-wait/30 text-ink">{match.text.slice(match.start, match.start + match.length)}</mark>
                            {match.text.slice(match.start + match.length)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
            </ul>
            {search?.truncated && <p className="px-2 py-1 text-xs text-muted">결과가 많아 일부만 보여 줍니다. 더 좁혀서 찾아 보세요.</p>}
          </div>
        ) : (
          <ul className="px-2 py-1 pb-3">
            {needle && files.length === 0 && <li className="px-2 py-1 text-xs text-muted">&apos;{needle}&apos;와 맞는 파일이 없습니다.</li>}
            {files.map((path) => (
              <li key={path}>
                <FileButton path={path} active={active === path} onOpen={open} badge={changeOf(path)} fresh={false} />
              </li>
            ))}
            {tree && files.length < tree.total && (
              <li className="px-2 py-1">
                <button type="button" onClick={() => void loadMore()} disabled={loadingMore} className="w-full rounded border border-line px-2 py-1 text-xs hover:border-ink disabled:opacity-60">
                  {loadingMore ? "불러오는 중" : `더 보기 (${(tree.total - files.length).toLocaleString()}개 남음)`}
                </button>
              </li>
            )}
            {tree?.truncated && <li className="px-2 py-1 text-xs text-muted">파일이 아주 많아 일부만 셌습니다.</li>}
          </ul>
        )}
      </aside>

      <section className="flex min-h-0 flex-col" aria-label="파일 내용">
        {!file || file.path !== active ? (
          <p className="p-6 text-sm text-muted">{active ? "파일을 불러오는 중" : "왼쪽에서 파일을 고르세요."}</p>
        ) : "error" in file ? (
          <p className="p-6 text-sm text-fail">{file.error}</p>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2.5">
              <span className="min-w-0 truncate font-mono text-sm" title={file.path}>
                {file.path}
              </span>
              {file.change && <span className={`text-xs font-medium ${CHANGE_TONE[file.change]}`}>{CHANGE_LABEL[file.change]}</span>}
              {write.path === file.path && snapshot.running && <span className="text-xs text-wait motion-safe:animate-pulse">방금 에이전트가 고침</span>}
              {file.patch && (
                <div className="ml-auto flex gap-1" role="group" aria-label="보기">
                  <button
                    type="button"
                    aria-pressed={!showDiff}
                    onClick={() => setShowDiff(false)}
                    className={`rounded-full px-3 py-1 text-xs ${!showDiff ? "bg-ink text-panel" : "text-muted hover:text-ink"}`}
                  >
                    내용
                  </button>
                  <button
                    type="button"
                    aria-pressed={showDiff}
                    onClick={() => setShowDiff(true)}
                    className={`rounded-full px-3 py-1 text-xs ${showDiff ? "bg-ink text-panel" : "text-muted hover:text-ink"}`}
                  >
                    체크포인트 이후 변경
                  </button>
                </div>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-auto">
              {showDiff && file.patch ? (
                <div className="p-3">
                  <DiffView patch={file.patch} />
                </div>
              ) : file.binary ? (
                <p className="p-6 text-sm text-muted">바이너리 파일이라 내용을 표시하지 않습니다.</p>
              ) : file.content === undefined ? (
                <div className="p-3">
                  <p className="pb-2 text-sm text-muted">체크포인트 이후 삭제한 파일입니다.</p>
                  {file.patch && <DiffView patch={file.patch} />}
                </div>
              ) : (
                <CodeLines path={file.path} content={file.content} />
              )}
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function FileButton({
  path,
  active,
  onOpen,
  badge,
  fresh,
}: {
  path: string;
  active: boolean;
  onOpen: (path: string) => void;
  badge?: "added" | "modified" | "deleted";
  fresh: boolean;
}) {
  const slash = path.lastIndexOf("/");
  return (
    <button
      type="button"
      onClick={() => onOpen(path)}
      aria-current={active}
      title={path}
      className={`flex w-full items-baseline gap-2 rounded px-2 py-1 text-left font-mono text-xs ${active ? "bg-ground" : "hover:bg-ground"}`}
    >
      {/* 경로가 길어 잘릴 때 파일 이름이 가려지지 않게 이름을 먼저, 폴더를 뒤에 흐리게 둔다 */}
      <span className="min-w-0 flex-1 truncate">
        {path.slice(slash + 1)}
        {slash >= 0 && <span className="ml-2 text-muted">{path.slice(0, slash)}</span>}
      </span>
      {fresh && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-wait" />}
      {badge && <span className={`shrink-0 ${CHANGE_TONE[badge]}`}>{CHANGE_LABEL[badge]}</span>}
    </button>
  );
}

/** 줄 번호와 함께 보여 준다. 아직 강조하지 않은 줄과 강조하지 않는 파일은 평문으로 두고, 긴 줄은 가로로 스크롤한다 */
function CodeLines({ path, content }: { path: string; content: string }) {
  const highlighted = useHighlightedCode(content, languageFor(path));
  const lines = useMemo(() => {
    const split = content.split("\n");
    if (split.at(-1) === "") split.pop();
    return split;
  }, [content]);
  return (
    <pre className="min-w-max py-2 font-mono text-xs leading-5">
      {lines.map((line, index) => (
        <CodeLine key={index} number={index + 1} text={line} tokens={highlighted?.[index]} />
      ))}
    </pre>
  );
}

/** 조각을 강조할 때마다 목록 전체가 다시 그려지므로, 이미 그린 줄은 건너뛴다 */
const CodeLine = memo(function CodeLine({ number, text, tokens }: { number: number; text: string; tokens?: HighlightedLine }) {
  return (
    <div className="flex">
      <span aria-hidden className="w-12 shrink-0 pr-3 text-right text-muted select-none">
        {number}
      </span>
      <span className="pr-4 whitespace-pre">{tokens ? <CodeTokens line={tokens} /> : text || " "}</span>
    </div>
  );
});
