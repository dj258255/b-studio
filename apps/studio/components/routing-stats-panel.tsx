import { taskKindLabel, type RoutingStats, type RoutingStatsRow } from "@/lib/routing-types";
import type { SessionMode } from "@/lib/studio-events";
import { formatCostShort } from "@/lib/terminal";
import { SESSION_BACKEND_LABEL } from "./status";

function backendLabel(backend: string): string {
  return SESSION_BACKEND_LABEL[backend as SessionMode] ?? backend;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes}분` : `${minutes}분 ${rest}초`;
}

function passCell(row: RoutingStatsRow): string {
  if (row.passRate === undefined) return "판정할 변경 없음";
  const judged = row.passed + row.failed + row.errors;
  return `${Math.round(row.passRate * 100)}% (${row.passed}/${judged})`;
}

/** 통과율 옆에 붙이는 나머지 결과. 플랫폼 문제는 AI의 성적과 따로 적는다 */
function detailCell(row: RoutingStatsRow): string {
  const parts: string[] = [];
  if (row.failed > 0) parts.push(`실패 ${row.failed}`);
  if (row.errors > 0) parts.push(`오류 ${row.errors}`);
  if (row.noChange > 0) parts.push(`바꾼 것 없음 ${row.noChange}`);
  if (row.platformFailures > 0) parts.push(`플랫폼 문제 ${row.platformFailures}`);
  return parts.join(" · ");
}

/**
 * AI별 결과표(#821). 만들기 요청을 AI × 시작 모델 × 작업 종류로 묶어 게이트가 판정한 결과를 보인다.
 * 통과율은 통과 ÷ (통과 + 실패 + 오류)이고, b-studio 쪽 문제로 판정하지 못한 실행과 바꾼 것 없이 끝난 실행은 넣지 않는다.
 */
export function RoutingStatsPanel({ stats }: { stats: RoutingStats }) {
  const { asks, unfinished } = stats.excluded;
  const skipped = [asks > 0 ? `질문 ${asks}건` : "", unfinished > 0 ? `끝나지 않은 실행 ${unfinished}건` : ""].filter(Boolean).join(", ");
  return (
    <section aria-labelledby="routing-stats-title" className="glass rounded-panel px-4 py-4">
      <h2 id="routing-stats-title" className="text-base font-semibold">
        AI별 결과
      </h2>
      <p className="mt-1 text-xs leading-5 text-muted">
        만들기 요청을 AI·시작 모델·작업 종류로 묶어 게이트가 판정한 결과입니다. 통과율에는 b-studio 쪽 문제로 판정하지 못한 실행과 바꾼 것 없이 끝난 실행을 넣지 않습니다.
      </p>
      {stats.rows.length === 0 ? (
        <p className="mt-3 text-sm text-muted">아직 판정한 만들기 요청이 없습니다. 요청을 보내면 여기에 AI별로 쌓입니다.</p>
      ) : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full min-w-[40rem] text-left text-sm">
            <thead className="text-xs text-muted">
              <tr>
                <th scope="col" className="py-1.5 pr-3 font-medium">AI</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">시작 모델</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">작업 종류</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">통과율</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">비용 중앙값</th>
                <th scope="col" className="py-1.5 pr-3 font-medium">시간 중앙값</th>
                <th scope="col" className="py-1.5 font-medium">나머지</th>
              </tr>
            </thead>
            <tbody>
              {stats.rows.map((row) => (
                <tr key={`${row.backend}-${row.model}-${taskKindLabel(row.kind)}`} className="border-t border-line">
                  <td className="py-1.5 pr-3">{backendLabel(row.backend)}</td>
                  <td className="py-1.5 pr-3 font-mono text-xs">{row.model}</td>
                  <td className="py-1.5 pr-3">{taskKindLabel(row.kind)}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{passCell(row)}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{row.medianCostUsd === undefined ? "—" : formatCostShort(row.medianCostUsd)}</td>
                  <td className="py-1.5 pr-3 tabular-nums">{row.medianDurationMs === undefined ? "—" : formatDuration(row.medianDurationMs)}</td>
                  <td className="py-1.5 text-xs text-muted">{detailCell(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {skipped && <p className="mt-2 text-xs text-muted">표에 넣지 않은 실행: {skipped}</p>}
    </section>
  );
}
