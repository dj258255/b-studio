"use client";

import { memo, useEffect, useMemo, useState } from "react";
import { languageFor, type HighlightedLine } from "@/lib/highlight";
import { latestWrite, type SessionView } from "@/lib/session-view";
import type { CodeFile, CodeTree } from "@/lib/studio-events";
import { CodeTokens, useHighlightedCode } from "./code-tokens";
import { DiffView } from "./diff-view";

const CHANGE_LABEL = { added: "추가", modified: "수정", deleted: "삭제" } as const;
const CHANGE_TONE = { added: "text-pass", modified: "text-wait", deleted: "text-fail" } as const;

/**
 * 샌드박스에서 실제로 도는 코드. 에이전트가 파일을 쓰거나 고칠 때마다 이벤트 스트림을 따라 다시 불러와,
 * 요청이 끝나기 전에도 무엇을 바꾸고 있는지 볼 수 있다
 */
export function CodePanel({ view }: { view: SessionView }) {
  const { snapshot, chat } = view;
  const write = useMemo(() => latestWrite(chat), [chat]);
  const [tree, setTree] = useState<CodeTree>();
  const [selected, setSelected] = useState<string>();
  const [file, setFile] = useState<CodeFile | { path: string; error: string }>();
  const [showDiff, setShowDiff] = useState(false);
  const [follow, setFollow] = useState(true);
  const [error, setError] = useState<string>();

  // 쓰기, 요청 완료, 체크포인트·되돌리기·가져오기가 일어날 때마다 목록을 새로 받는다
  const revision = `${write.count}|${view.completedRuns}|${snapshot.checkpoints[0]?.sha ?? ""}|${snapshot.status}`;
  const active = follow && write.path ? write.path : selected;

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/sessions/${snapshot.id}/files`)
      .then(async (response) => {
        const data = await response.json();
        if (cancelled) return;
        if (response.ok) {
          setTree(data as CodeTree);
          setError(undefined);
        } else setError(data.error ?? "파일 목록을 불러오지 못했습니다");
      })
      .catch((reason: unknown) => !cancelled && setError(String(reason)));
    return () => {
      cancelled = true;
    };
  }, [snapshot.id, revision]);

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

        <h3 className="border-t border-line px-4 pt-3 text-sm font-semibold">모든 파일 {tree ? `${tree.files.length}개` : ""}</h3>
        <ul className="px-2 py-1 pb-3">
          {tree?.files.map((path) => (
            <li key={path}>
              <FileButton path={path} active={active === path} onOpen={open} badge={changeOf(path)} fresh={false} />
            </li>
          ))}
          {tree?.truncated && <li className="px-2 py-1 text-xs text-muted">파일이 많아 목록을 줄였습니다.</li>}
        </ul>
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
