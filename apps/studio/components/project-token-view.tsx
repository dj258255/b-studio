"use client";

import { useState } from "react";
import {
  MAX_REQUEST_ROWS,
  PRICE_DISCLAIMER,
  REQUEST_RESULT_LABEL,
  SESSION_KIND_LABEL,
  TRIM_ESTIMATE_METHOD,
  formatCost,
  formatLocalStamp,
  formatRatio,
  formatTokens,
  priceSourceLabel,
  rangeText,
  totalTokens,
  type ProjectRequestRow,
  type ProjectTokenReport,
} from "@/lib/project-token-types";

/**
 * 프로젝트 토큰 보고서 화면. 쓴 양과 줄인 양을 나눠 보여 주고, 과제 README에 붙일 마크다운을 복사하거나 파일로 받는다.
 * 좁은 화면에서는 표를 압축 표기(text-xs, 최소 너비 없음)로 그려 가로 스크롤을 만들지 않는다(토큰 탭과 같은 규칙).
 */
export function ProjectTokenView({ report }: { report: ProjectTokenReport }) {
  const [copy, setCopy] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  const params = new URLSearchParams({ format: "markdown" });
  if (report.range?.from) params.set("from", report.range.from);
  if (report.range?.to) params.set("to", report.range.to);
  const markdownUrl = `/api/projects/${encodeURIComponent(report.projectId)}/token-report?${params.toString()}`;

  async function copyMarkdown() {
    setCopy("copying");
    try {
      const response = await fetch(markdownUrl, { cache: "no-store" });
      if (!response.ok) throw new Error(String(response.status));
      await navigator.clipboard.writeText(await response.text());
      setCopy("copied");
    } catch {
      setCopy("failed");
    }
  }

  const models = Object.entries(report.usageByModel);
  const saved = report.saved;
  const header = [
    report.range ? `기간 ${rangeText(report.range)}` : "전체 기간",
    `세션 ${report.sessions}개`,
    `만든 시각 ${formatLocalStamp(report.generatedAt)}`,
  ].join(" · ");
  const priced = report.estimatedCostUsd === undefined;
  const calls = `모델 호출 ${formatTokens(report.modelCalls)}회${priced && report.priceNote && report.priceNote !== "단가 미설정" ? ` · ${report.priceNote}` : ""}`;
  return (
    <div className="mt-4">
      <h1 className="text-2xl font-semibold tracking-tight">토큰 보고서 — {report.projectName}</h1>
      <p className="mt-2 text-sm text-muted">{header}</p>
      <p className="mt-1 text-sm text-muted">
        이 프로젝트의 모든 세션(작업 분해 레인·통합·Fleet 멤버 포함)이 쓴 토큰과 b-studio가 줄인 양을 모았습니다.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void copyMarkdown()}
          disabled={copy === "copying"}
          className="glass-soft rounded-control px-4 py-1.5 text-sm font-medium hover:bg-panel disabled:opacity-60"
        >
          마크다운으로 복사
        </button>
        <a href={`${markdownUrl}&download=1`} className="glass-soft rounded-control px-4 py-1.5 text-sm font-medium hover:bg-panel">
          파일로 받기
        </a>
        <span role="status" aria-live="polite" className="text-sm text-muted">
          {copy === "copying" && "마크다운을 만드는 중"}
          {copy === "copied" && "복사했습니다"}
          {copy === "failed" && "복사하지 못했습니다. 파일로 받기를 쓰세요"}
        </span>
      </div>

      {report.requests.length === 0 ? (
        <p className="glass mt-6 rounded-panel px-5 py-4 text-sm text-muted">
          {report.sessions === 0
            ? "이 프로젝트에는 아직 세션이 없습니다. 요청을 하나 보내면 쓴 토큰과 줄인 양이 여기 모입니다."
            : "이 기간에 끝난 요청이 없습니다. 기간을 넓히거나 요청을 하나 보내 보세요."}
        </p>
      ) : (
        <>
          <section aria-labelledby="token-spent" className="glass mt-6 rounded-panel px-5 py-4">
            <h2 id="token-spent" className="text-sm font-semibold">
              쓴 양
            </h2>
            <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
              <Stat label="총 토큰" value={formatTokens(totalTokens(report.totals))} />
              <Stat
                label="환산 비용"
                value={`${formatCost(report.estimatedCostUsd)}${report.estimatedCostUsd === undefined ? "" : ` · ${priceSourceLabel(report.priceSource)}`}`}
              />
              <Stat label="요청 수" value={formatTokens(report.requests.length)} />
              <Stat label="캐시 적중률" value={formatRatio(report.cacheHitRatio)} />
              <Stat label="입력" value={formatTokens(report.totals.inputTokens)} />
              <Stat label="캐시 읽기" value={formatTokens(report.totals.cacheReadTokens)} />
              <Stat label="캐시 쓰기" value={formatTokens(report.totals.cacheWriteTokens)} />
              <Stat label="출력" value={formatTokens(report.totals.outputTokens)} />
            </dl>
            <p className="mt-3 text-xs text-muted">{calls}</p>
          </section>

          {models.length > 0 && (
            <section aria-labelledby="token-models" className="mt-8">
              <h2 id="token-models" className="text-sm font-semibold">
                모델별
              </h2>
              <table className="mt-2 w-full text-left text-xs">
                <thead className="border-b border-line text-muted">
                  <tr>
                    <th scope="col" className="py-1.5 pr-2 font-medium">모델</th>
                    <th scope="col" className="py-1.5 pr-2 text-right font-medium">입력</th>
                    <th scope="col" className="py-1.5 pr-2 text-right font-medium">캐시 읽기</th>
                    <th scope="col" className="py-1.5 pr-2 text-right font-medium">캐시 쓰기</th>
                    <th scope="col" className="py-1.5 pr-2 text-right font-medium">출력</th>
                    <th scope="col" className="py-1.5 text-right font-medium">비용</th>
                  </tr>
                </thead>
                <tbody>
                  {models.map(([model, usage]) => (
                    <tr key={model} className="border-b border-line/60">
                      <th scope="row" className="py-1.5 pr-2 font-mono font-medium break-all">{model}</th>
                      <td className="py-1.5 pr-2 text-right font-mono">{formatTokens(usage.inputTokens)}</td>
                      <td className="py-1.5 pr-2 text-right font-mono">{formatTokens(usage.cacheReadTokens)}</td>
                      <td className="py-1.5 pr-2 text-right font-mono">{formatTokens(usage.cacheWriteTokens)}</td>
                      <td className="py-1.5 pr-2 text-right font-mono">{formatTokens(usage.outputTokens)}</td>
                      <td className="py-1.5 text-right font-mono">{report.modelCosts[model] === undefined ? "단가 없음" : `$${report.modelCosts[model]!.toFixed(4)}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {report.kinds.length > 1 && (
            <section aria-labelledby="token-kinds" className="mt-8">
              <h2 id="token-kinds" className="text-sm font-semibold">
                세션 종류별
              </h2>
              <table className="mt-2 w-full text-left text-xs">
                <thead className="border-b border-line text-muted">
                  <tr>
                    <th scope="col" className="py-1.5 pr-2 font-medium">종류</th>
                    <th scope="col" className="py-1.5 pr-2 text-right font-medium">세션</th>
                    <th scope="col" className="py-1.5 pr-2 text-right font-medium">요청</th>
                    <th scope="col" className="py-1.5 pr-2 text-right font-medium">토큰</th>
                    <th scope="col" className="py-1.5 text-right font-medium">비용</th>
                  </tr>
                </thead>
                <tbody>
                  {report.kinds.map((entry) => (
                    <tr key={entry.kind} className="border-b border-line/60">
                      <th scope="row" className="py-1.5 pr-2 font-medium">{SESSION_KIND_LABEL[entry.kind]}</th>
                      <td className="py-1.5 pr-2 text-right font-mono">{entry.sessions}</td>
                      <td className="py-1.5 pr-2 text-right font-mono">{entry.requests}</td>
                      <td className="py-1.5 pr-2 text-right font-mono">{formatTokens(totalTokens(entry.usage))}</td>
                      <td className="py-1.5 text-right font-mono">{formatCost(entry.costUsd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <section aria-labelledby="token-saved" className="mt-8">
            <h2 id="token-saved" className="text-sm font-semibold">
              줄인 양
            </h2>
            <div className="mt-2 grid items-start gap-4 sm:grid-cols-2">
              <div className="glass rounded-panel px-5 py-4">
                <h3 className="text-sm font-semibold">측정</h3>
                <p className="mt-1 text-xs text-muted">기록에 남은 사실입니다. 아래 추정과 섞지 마세요.</p>
                <dl className="mt-3 space-y-3">
                  <Stat label="도구 결과 예산이 잘라낸 글자" value={`${formatTokens(saved.trimmedChars)}자`} />
                  <Stat label="앞과 같은 결과를 참조로 대체" value={`${formatTokens(saved.repeatedResults)}회`} />
                  <Stat label="묶어서 비운 도구 결과" value={`${formatTokens(saved.clearedCount)}개 · ${formatTokens(saved.clearedChars)}자`} />
                  <Stat
                    label="가볍게 확인으로 끝난 실행"
                    value={`${formatTokens(saved.lightRuns)}회${
                      saved.lightSkipped.length > 0 ? ` · 건너뛴 단계 ${saved.lightSkipped.map((entry) => `${entry.stage} ${entry.runs}회`).join(", ")}` : ""
                    }`}
                  />
                </dl>
              </div>
              <div className="glass rounded-panel px-5 py-4">
                <h3 className="text-sm font-semibold">
                  추정 <span className="font-normal text-muted">(근사)</span>
                </h3>
                <p className="mt-1 text-xs text-muted">자르지 않았다면 그 글자가 남은 호출마다 다시 실려 갔을 양입니다.</p>
                <dl className="mt-3 space-y-3">
                  <Stat label="다시 읽혔을 토큰 (추정)" value={`${formatTokens(saved.trimmedTokensEstimated)} 토큰`} />
                  <Stat
                    label="환산 금액 (추정)"
                    value={saved.trimmedCostUsd === undefined ? "단가 미설정" : `$${saved.trimmedCostUsd.toFixed(4)} · 캐시 읽기 단가 ${saved.trimmedCostModel ?? ""}`}
                  />
                </dl>
                <p className="mt-3 text-xs text-muted">방식: {TRIM_ESTIMATE_METHOD}</p>
              </div>
            </div>
          </section>

          <section aria-labelledby="token-requests" className="mt-8">
            <h2 id="token-requests" className="text-sm font-semibold">
              요청별 (최근 순)
            </h2>
            <table className="mt-2 w-full text-left text-xs">
              <thead className="border-b border-line text-muted">
                <tr>
                  <th scope="col" className="py-1.5 pr-2 font-medium">시각</th>
                  <th scope="col" className="py-1.5 pr-2 font-medium">요청</th>
                  <th scope="col" className="py-1.5 pr-2 text-right font-medium">토큰</th>
                  <th scope="col" className="py-1.5 pr-2 text-right font-medium">비용</th>
                  <th scope="col" className="py-1.5 pr-2 font-medium">노력</th>
                  <th scope="col" className="py-1.5 font-medium">결과</th>
                </tr>
              </thead>
              <tbody>
                {report.requests.slice(0, MAX_REQUEST_ROWS).map((request) => (
                  <RequestRow key={`${request.sessionId}-${request.request}-${request.at ?? ""}`} request={request} />
                ))}
              </tbody>
            </table>
            {report.requests.length > MAX_REQUEST_ROWS && (
              <p className="mt-2 text-xs text-muted">최근 {MAX_REQUEST_ROWS}개만 보여 줍니다. 전체 {formatTokens(report.requests.length)}개는 파일로 받아 보세요.</p>
            )}
          </section>

          {report.notes.length > 0 && (
            <section aria-labelledby="token-notes" className="mt-8">
              <h2 id="token-notes" className="text-sm font-semibold">
                알아둘 점
              </h2>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-muted">
                {report.notes.map((note) => (
                  <li key={note}>{note}</li>
                ))}
              </ul>
            </section>
          )}

          <p className="mt-8 text-xs text-muted">{PRICE_DISCLAIMER}</p>
        </>
      )}
    </div>
  );
}

function RequestRow({ request }: { request: ProjectRequestRow }) {
  return (
    <tr className="border-b border-line/60 align-top">
      <td className="py-1.5 pr-2 font-mono whitespace-nowrap">{request.at ? formatLocalStamp(request.at) : "—"}</td>
      <th scope="row" className="py-1.5 pr-2 font-normal">
        <span className="text-muted">{SESSION_KIND_LABEL[request.kind]}</span>
        <span className="mt-0.5 block break-words">{request.request || "(요청 없음)"}</span>
      </th>
      <td className="py-1.5 pr-2 text-right font-mono">{formatTokens(totalTokens(request.usage))}</td>
      <td className="py-1.5 pr-2 text-right font-mono">{formatCost(request.costUsd)}</td>
      <td className="py-1.5 pr-2">{request.effort ?? "—"}</td>
      <td className="py-1.5">{REQUEST_RESULT_LABEL[request.result]}</td>
    </tr>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="font-mono text-sm">{value}</dd>
    </div>
  );
}
