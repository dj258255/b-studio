/** git patch를 줄 단위로 색을 입혀 보여준다. 추가는 통과 색, 삭제는 실패 색 */
export function DiffView({ patch }: { patch: string }) {
  if (!patch.trim()) return <p className="text-sm text-muted">바뀐 파일이 없습니다.</p>;

  return (
    <pre className="overflow-auto rounded-md border border-line bg-panel py-2 font-mono text-xs leading-5">
      {patch.split("\n").map((line, index) => (
        <div key={index} className={`whitespace-pre-wrap break-all ${lineClass(line)}`}>
          {line || " "}
        </div>
      ))}
    </pre>
  );
}

function lineClass(line: string): string {
  if (line.startsWith("diff --git")) return "mt-3 bg-ground px-3 py-1 font-medium text-ink first:mt-0";
  if (/^(\+\+\+|---|index |new file|deleted file|similarity|rename )/.test(line)) return "px-3 text-muted";
  if (line.startsWith("@@")) return "px-3 text-wait";
  if (line.startsWith("+")) return "bg-pass/10 px-3 text-pass";
  if (line.startsWith("-")) return "bg-fail/10 px-3 text-fail";
  return "px-3";
}
