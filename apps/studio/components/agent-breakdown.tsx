import type { AgentDetail, AgentItem } from "@/lib/server/agents-overview";
import { formatCostShort } from "@/lib/terminal";

/**
 * 작업 화면 한 줄 아래의 에이전트 내역과 할 수 있는 범위(#843). 처음에는 접어 두고, 펼치면 메인과 서브에이전트마다
 * 상태·토큰·비용·하는 일, 그리고 AI·모델·도구·쓰기 범위·권한 방식을 보인다. 둘 다 없는 구성원은 건너뛴다
 */
const STATE_LABEL: Record<AgentDetail["state"], string> = { working: "작업 중", done: "끝남", idle: "대기" };

function total(usage: AgentDetail["tokens"]): number {
  return usage.inputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
}

/** 접힌 줄에 붙일 한마디. 내역이 하나도 없으면 없다 */
export function breakdownSummary(members: readonly AgentItem[]): string | undefined {
  const details = members.flatMap((member) => member.agents ?? []);
  if (details.length === 0) return undefined;
  const subagents = details.filter((detail) => detail.kind === "subagent");
  if (subagents.length === 0) return "서브에이전트 없음";
  const working = subagents.filter((detail) => detail.state === "working").length;
  return `서브에이전트 ${subagents.length}${working > 0 ? `(작업 중 ${working})` : ""}`;
}

export function AgentBreakdown({ members }: { members: readonly AgentItem[] }) {
  const shown = members.filter((member) => (member.agents && member.agents.length > 0) || member.capabilities);
  if (shown.length === 0) return null;
  const summary = breakdownSummary(shown);
  return (
    <details className="mt-1.5 text-xs">
      <summary className="cursor-pointer text-muted hover:text-ink">에이전트·범위{summary ? ` · ${summary}` : ""}</summary>
      <div className="mt-1.5 flex flex-col gap-2">
        {shown.map((member) => (
          <div key={member.id}>
            {shown.length > 1 && <p className="font-medium">{member.title}</p>}
            {member.agents && member.agents.length > 0 && (
              <table className="mt-0.5 w-full text-left">
                <thead className="text-muted">
                  <tr>
                    <th className="pr-3 font-normal">에이전트</th>
                    <th className="pr-3 font-normal">상태</th>
                    <th className="pr-3 text-right font-normal">토큰</th>
                    <th className="pr-3 text-right font-normal">비용</th>
                    <th className="font-normal">하는 일</th>
                  </tr>
                </thead>
                <tbody>
                  {member.agents.map((detail) => (
                    <tr key={detail.id}>
                      <td className="pr-3">{detail.kind === "main" ? detail.name : `↳ ${detail.name}`}</td>
                      <td className="pr-3 text-muted">{STATE_LABEL[detail.state]}</td>
                      <td className="pr-3 text-right tabular-nums">{total(detail.tokens).toLocaleString("ko-KR")}</td>
                      <td className="pr-3 text-right tabular-nums">{detail.costUsd !== undefined ? formatCostShort(detail.costUsd) : "—"}</td>
                      <td className="break-words text-muted">{detail.activity ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {member.capabilities && (
              <p className="mt-0.5 flex flex-wrap gap-x-3 text-muted">
                <span>AI {member.capabilities.backend}</span>
                {member.capabilities.model && <span>모델 {member.capabilities.model}</span>}
                <span>도구 {member.capabilities.tools === "cli-default" ? "CLI 기본 도구" : member.capabilities.tools.join(", ")}</span>
                <span>쓰기 {member.capabilities.writeScope}</span>
                <span>권한 {member.capabilities.permission}</span>
              </p>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}
