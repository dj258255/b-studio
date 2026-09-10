import type { VerificationReport } from "@b-studio/agent";
import { Dot, TONE_TEXT, type Tone } from "./status";

interface Stage {
  title: string;
  tone: Tone;
  lines: Array<{ text: string; tone?: Tone }>;
  logs?: Array<{ service: string; lines: string[] }>;
}

/**
 * 스튜디오 검증 게이트. 에이전트가 끝났다고 한 결과를 믿어도 되는지 보여주는 화면의 중심이다.
 * 파일 반영 → 서비스 재시작과 준비 판정 → 계약 비교는 실제로 순서대로 일어나므로 순서 있는 목록으로 그린다.
 */
export function GateTrack({ files, report }: { files: string[]; report?: VerificationReport }) {
  const verdict: Tone = !report ? "wait" : report.ok ? "pass" : "fail";
  const stages = buildStages(files, report);

  return (
    <figure className={`rounded-lg border bg-panel ${verdict === "fail" ? "border-fail/50" : verdict === "pass" ? "border-pass/40" : "border-line"}`}>
      <figcaption className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <span className="text-sm font-semibold">검증 게이트</span>
        <span className={`text-sm font-medium ${TONE_TEXT[verdict]}`}>{verdict === "wait" ? "확인 중" : verdict === "pass" ? "통과" : "실패"}</span>
      </figcaption>

      <ol className="px-4 py-3">
        {stages.map((stage) => (
          <li key={stage.title} className="relative flex gap-3 pb-3 last:pb-0">
            <span aria-hidden className="absolute top-4 bottom-0 left-[4.5px] w-px bg-line [li:last-child>&]:hidden" />
            <span className="mt-1.5">
              <Dot tone={stage.tone} />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{stage.title}</p>
              {stage.lines.map((line, index) => (
                <p key={index} className={`mt-0.5 text-sm break-words ${line.tone ? TONE_TEXT[line.tone] : "text-muted"}`}>
                  {line.text}
                </p>
              ))}
              {stage.logs?.map((log) => (
                <details key={log.service} className="mt-1.5">
                  <summary className="cursor-pointer text-sm text-muted hover:text-ink">{log.service} 마지막 로그</summary>
                  <pre className="mt-1 max-h-56 overflow-auto rounded bg-ground p-2 font-mono text-[11px] leading-4 whitespace-pre-wrap">
                    {log.lines.join("\n")}
                  </pre>
                </details>
              ))}
            </div>
          </li>
        ))}
      </ol>
    </figure>
  );
}

function buildStages(files: string[], report?: VerificationReport): Stage[] {
  if (!report) {
    return [
      { title: "파일 반영 확인", tone: "wait", lines: [{ text: `바뀐 파일 ${files.length}개` }] },
      { title: "서비스 재시작과 준비 판정", tone: "idle", lines: [] },
      { title: "API 계약 비교", tone: "idle", lines: [] },
    ];
  }

  if ("error" in report.sync) {
    return [
      { title: "파일 반영 확인", tone: "fail", lines: [{ text: report.sync.error, tone: "fail" }] },
      { title: "서비스 재시작과 준비 판정", tone: "idle", lines: [{ text: "파일이 반영되지 않아 재시작하지 않았습니다" }] },
      { title: "API 계약 비교", tone: "idle", lines: [] },
    ];
  }

  const restartFailed = report.restarted.some((check) => !check.ready);
  const contractChanges = report.contracts.flatMap((contract) => contract.changes);
  const contractFailed = report.contracts.some((contract) => contract.error) || (!report.ok && !restartFailed && contractChanges.some((change) => change.breaking));

  return [
    {
      title: "파일 반영 확인",
      tone: "pass",
      lines: [{ text: `바뀐 파일 ${files.length}개, ${(report.sync.elapsedMs / 1000).toFixed(1)}초 만에 샌드박스에서 확인` }],
    },
    {
      title: "서비스 재시작과 준비 판정",
      tone: restartFailed ? "fail" : "pass",
      lines:
        report.restarted.length === 0
          ? [{ text: "재시작할 서비스가 없습니다" }]
          : report.restarted.map((check) =>
              check.ready ? { text: `${check.service} 준비됨`, tone: "pass" as const } : { text: `${check.service} ${check.error ?? "실패"}`, tone: "fail" as const },
            ),
      logs: report.restarted.filter((check) => check.logTail?.length).map((check) => ({ service: check.service, lines: check.logTail ?? [] })),
    },
    {
      title: "API 계약 비교",
      tone: restartFailed && report.contracts.length === 0 ? "idle" : contractFailed ? "fail" : "pass",
      lines: [
        ...report.contracts.flatMap((contract) =>
          contract.error
            ? [{ text: `${contract.service} 계약을 가져오지 못했습니다: ${contract.error}`, tone: "fail" as const }]
            : contract.changes.length === 0
              ? [{ text: `${contract.service} 변경 없음` }]
              : contract.changes.map((change) => ({
                  text: `${change.breaking ? "호환 깨짐" : "추가"}: ${change.target}${change.detail ? ` (${change.detail})` : ""}`,
                  tone: change.breaking ? ("fail" as const) : undefined,
                })),
        ),
        ...(restartFailed && report.contracts.length === 0 ? [{ text: "재시작에 실패해 비교하지 않았습니다" }] : []),
        ...(report.unverifiedFiles.length > 0 ? [{ text: `재시작으로 확인하지 못한 파일: ${report.unverifiedFiles.join(", ")}` }] : []),
      ],
    },
  ];
}
