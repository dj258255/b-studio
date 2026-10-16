import { startFailureHint, summarizeFailure } from "@/lib/start-failure";

/**
 * 오류 원문을 요약 한 줄과 "자세히" 아래 원문으로 나눠 보여 준다(#718).
 * 끊기지 않는 긴 문자열(URL)이 화면을 가로로 밀지 않게 어디서든 줄을 바꾼다.
 * hint가 켜져 있으면 알려진 실패의 원인과 조치를 맨 위에 한 줄로 적는다
 */
export function FailureDetails({ text, workDir, hint = false, className = "" }: { text: string; workDir?: string; hint?: boolean; className?: string }) {
  const known = hint ? startFailureHint(text, { workDir }) : undefined;
  const { summary, truncated } = summarizeFailure(text);
  return (
    <div className={`min-w-0 [overflow-wrap:anywhere] break-words ${className}`}>
      {known && (
        <p className="font-medium">
          {known.cause} {known.action}
        </p>
      )}
      <p className="line-clamp-2">{summary}</p>
      {truncated && (
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-muted hover:text-ink">자세히</summary>
          <pre className="mt-1 max-h-60 overflow-auto rounded-control bg-panel/60 p-2 font-mono text-xs leading-5 [overflow-wrap:anywhere] whitespace-pre-wrap">{text}</pre>
        </details>
      )}
    </div>
  );
}
