"use client";

import { useEffect, useMemo, useState } from "react";
import { highlightLines, languageFor, parsePatch, type HighlightedLine, type PatchFile, type PatchLineKind } from "@/lib/highlight";
import { CodeTokens } from "./code-tokens";

const LINE_CLASS: Record<PatchLineKind, string> = {
  file: "mt-3 bg-ground px-3 py-1 font-medium text-ink first:mt-0",
  meta: "px-3 text-muted",
  hunk: "px-3 text-wait",
  added: "bg-pass/10 px-3 text-pass",
  removed: "bg-fail/10 px-3 text-fail",
  context: "px-3",
  other: "px-3 text-muted",
};

type HighlightedFile = { before?: HighlightedLine[]; after?: HighlightedLine[] };

/** git patch를 보여 준다. 줄 배경과 +/- 표시는 추가·삭제 색으로, 코드는 파일 언어에 맞춰 강조한다 */
export function DiffView({ patch }: { patch: string }) {
  const parsed = useMemo(() => parsePatch(patch), [patch]);
  const highlighted = useHighlightedPatch(patch, parsed.files);
  if (!patch.trim()) return <p className="text-sm text-muted">바뀐 파일이 없습니다.</p>;

  return (
    <pre className="overflow-auto rounded-md border border-line bg-panel py-2 font-mono text-xs leading-5">
      {parsed.lines.map((line, index) => {
        const file = highlighted?.[line.file];
        const tokens = line.index === undefined ? undefined : (line.kind === "removed" ? file?.before : file?.after)?.[line.index];
        return (
          <div key={index} className={`whitespace-pre-wrap break-all ${LINE_CLASS[line.kind]}`}>
            {tokens ? (
              <>
                {line.text[0]}
                <CodeTokens line={tokens} />
              </>
            ) : (
              line.text || " "
            )}
          </div>
        );
      })}
    </pre>
  );
}

/** 파일마다 바꾸기 전 코드와 바꾼 뒤 코드를 따로 강조한다. 끝나기 전에는 색 없이 보여 준다 */
function useHighlightedPatch(patch: string, files: PatchFile[]): HighlightedFile[] | undefined {
  const [result, setResult] = useState<{ patch: string; files: HighlightedFile[] }>();
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    Promise.all(
      files.map(async (file): Promise<HighlightedFile> => {
        const lang = languageFor(file.path);
        const [before, after] = await Promise.all([
          highlightLines(file.before.join("\n"), lang, { signal }),
          highlightLines(file.after.join("\n"), lang, { signal }),
        ]);
        return { before, after };
      }),
    ).then(
      (value) => !signal.aborted && setResult({ patch, files: value }),
      (error: unknown) => {
        if (!signal.aborted) console.warn("[b-studio] diff 강조에 실패해 평문으로 보여 줍니다", error);
      },
    );
    return () => controller.abort();
  }, [patch, files]);
  return result?.patch === patch ? result.files : undefined;
}
