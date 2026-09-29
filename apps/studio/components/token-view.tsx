"use client";

import { useEffect, useState } from "react";
import type { AgentUsage } from "@b-studio/agent";
import type { SessionView } from "@/lib/session-view";
import type { ContextJump, TokenReport, TokenWarningKind } from "@/lib/token-types";
import { formatTokenCount } from "@/lib/usage";

const number = (value: number) => value.toLocaleString("ko-KR");
const percent = (ratio: number) => `${(ratio * 100).toFixed(0)}%`;

/** 경고 종류별 색. 실패(낭비가 확실)와 확인 중(주의)만 색을 쓴다 */
const WARNING_TONE: Record<TokenWarningKind, string> = {
  big_result: "text-wait",
  repeated_result: "text-wait",
  node_modules: "text-wait",
  context_jump: "text-fail",
  price_table: "text-wait",
};

/** 비용을 어느 방식으로 계산했는지 화면에 붙일 이름 */
const PRICE_SOURCE_LABEL: Record<TokenReport["priceSource"], string> = {
  "by-model": "모델별 단가",
  single: "단일 단가",
  none: "단가 미설정",
};

/**
 * "토큰" 탭. 실행별로 턴 컨텍스트 그래프·턴 표·도구별 비중·큰 결과·경고·합계를 보여 준다.
 * 글자 수는 모델에 간 그대로이고, 토큰은 기록된 값만 쓴다(글자에서 토큰을 추정하지 않는다).
 */
export function TokenView({ view }: { view: SessionView }) {
  const sessionId = view.snapshot.id;
  // 실행이 끝날 때마다 다시 불러온다
  const revision = view.completedRuns;
  const [reports, setReports] = useState<TokenReport[]>();
  const [error, setError] = useState<string>();
  const [selected, setSelected] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/sessions/${sessionId}/tokens`, { cache: "no-store" })
      .then(async (response) => {
        const data = (await response.json().catch(() => ({}))) as { runs?: TokenReport[]; error?: string };
        if (cancelled) return;
        if (!response.ok) {
          setError(data.error ?? "토큰 보고서를 불러오지 못했습니다");
          return;
        }
        setReports(data.runs ?? []);
        setError(undefined);
      })
      .catch(() => {
        if (!cancelled) setError("토큰 보고서를 불러오지 못했습니다");
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, revision]);

  if (error) return <p role="alert" className="p-6 text-sm text-fail">{error}</p>;
  if (!reports) return <p role="status" className="p-6 text-sm text-muted">토큰 보고서를 불러오는 중</p>;
  if (reports.length === 0) {
    return <p className="p-6 text-sm text-muted">아직 끝난 요청이 없습니다. 요청을 하나 보내면 턴별 컨텍스트와 도구 결과 크기를 여기서 볼 수 있습니다.</p>;
  }

  const active = reports.find((report) => report.runId === selected) ?? reports[0]!;

  return (
    <div className="flex h-full flex-col">
      <div role="tablist" aria-label="실행" className="flex flex-wrap gap-1 border-b border-line bg-panel px-3 py-2">
        {reports.map((report) => (
          <button
            key={report.runId}
            role="tab"
            type="button"
            aria-selected={report.runId === active.runId}
            onClick={() => setSelected(report.runId)}
            className={`min-w-0 max-w-[16rem] rounded-control px-3 py-1 text-left text-sm ${
              report.runId === active.runId ? "bg-panel text-ink ring-1 ring-line" : "text-muted hover:text-ink"
            }`}
          >
            <span className="block truncate">{report.request || "(요청 없음)"}</span>
            <span className="text-xs text-muted">
              {report.turns.length}턴 · 입력 {number(report.totals.inputTokens)} · 캐시 {number(report.totals.cacheReadTokens)}
            </span>
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        <RunDetail report={active} />
      </div>
    </div>
  );
}

export function RunDetail({ report }: { report: TokenReport }) {
  const models = Object.entries(report.usageByModel ?? {});
  return (
    <div className="flex flex-col gap-6">
      <section aria-labelledby="token-totals">
        <h3 id="token-totals" className="text-sm font-semibold">합계</h3>
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-sm sm:grid-cols-3">
          <Stat label="입력" value={number(report.totals.inputTokens)} />
          <Stat label="출력" value={number(report.totals.outputTokens)} />
          <Stat label="캐시 읽기" value={number(report.totals.cacheReadTokens)} />
          <Stat label="캐시 쓰기" value={number(report.totals.cacheWriteTokens)} />
          <Stat label="캐시 적중률" value={percent(report.cacheHitRatio)} />
          <Stat label="추정 비용" value={costText(report)} />
          <Stat label="비운 도구 결과" value={report.cleared.count === 0 ? "없음" : `${number(report.cleared.count)}개 · ${number(report.cleared.chars)}자`} />
        </dl>
        <p className="mt-1 text-xs text-muted">캐시 적중률은 캐시 읽기 ÷ (입력 + 캐시 읽기 + 캐시 쓰기)입니다. 추정 비용은 단가 환경 변수를 넣었을 때만 계산합니다.</p>
        {report.escalation && (
          <p className="mt-1 text-sm text-muted">
            {report.escalation.attempt}번째 게이트 실패 뒤 <span className="font-mono text-ink">{report.escalation.from}</span> →{" "}
            <span className="font-mono text-ink">{report.escalation.to}</span> 모델로 올렸습니다
          </p>
        )}
      </section>

      {models.length > 0 && (
        <section aria-labelledby="token-models">
          <h3 id="token-models" className="text-sm font-semibold">모델별</h3>
          <ModelBreakdown report={report} models={models} />
        </section>
      )}

      <section aria-labelledby="token-turns">
        <h3 id="token-turns" className="text-sm font-semibold">턴별 컨텍스트</h3>
        {report.turns.length === 0 ? (
          <p className="mt-2 text-sm text-muted">이 실행은 턴 사용량을 남기지 않았습니다(스크립트 실행 등).</p>
        ) : (
          <>
            <ContextChart turns={report.turns} jumps={report.contextGrowth?.jumps} />
            <TurnsTable turns={report.turns} jumps={report.contextGrowth?.jumps} />
          </>
        )}
      </section>

      {report.contextGrowth && (
        <section aria-labelledby="token-context-jumps">
          <h3 id="token-context-jumps" className="text-sm font-semibold">문맥 급증 {report.contextGrowth.jumps.length}개</h3>
          {report.contextGrowth.jumps.length === 0 ? (
            <p className="mt-2 text-sm text-muted">문맥이 급격히 늘어난 턴이 없습니다.</p>
          ) : (
            <ul className="mt-2 flex flex-col gap-3 text-sm">
              {report.contextGrowth.jumps.map((jump) => (
                <ContextJumpCard key={jump.turn} jump={jump} />
              ))}
            </ul>
          )}
        </section>
      )}

      <section aria-labelledby="token-tools">
        <h3 id="token-tools" className="text-sm font-semibold">도구별 비중</h3>
        {report.toolTotals.length === 0 ? (
          <p className="mt-2 text-sm text-muted">도구 결과가 없습니다.</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[32rem] text-left text-sm">
              <thead className="border-b border-line text-muted">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-medium">도구</th>
                  <th scope="col" className="py-2 pr-4 font-medium">호출</th>
                  <th scope="col" className="py-2 pr-4 font-medium">결과 글자</th>
                  <th scope="col" className="py-2 font-medium">비중</th>
                </tr>
              </thead>
              <tbody>
                {report.toolTotals.map((tool) => (
                  <tr key={tool.name} className="border-b border-line/60">
                    <th scope="row" className="py-2 pr-4 font-mono text-xs font-medium">{tool.name}</th>
                    <td className="py-2 pr-4 font-mono text-xs">{number(tool.calls)}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{number(tool.chars)}</td>
                    <td className="py-2">
                      <span className="flex items-center gap-2">
                        <span className="w-12 shrink-0 font-mono text-xs text-muted">{percent(tool.share)}</span>
                        <span
                          role="meter"
                          aria-label={`${tool.name} 결과 글자 비중`}
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={Math.round(tool.share * 100)}
                          className="h-1.5 w-24 rounded-full bg-line"
                        >
                          <span className="block h-full rounded-full bg-ink" style={{ width: `${Math.min(100, Math.round(tool.share * 100))}%` }} />
                        </span>
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="token-biggest">
        <h3 id="token-biggest" className="text-sm font-semibold">큰 결과 상위 {report.biggest.length}개</h3>
        {report.biggest.length === 0 ? (
          <p className="mt-2 text-sm text-muted">도구 결과가 없습니다.</p>
        ) : (
          <div className="mt-2 overflow-x-auto">
            <table className="w-full min-w-[32rem] text-left text-sm">
              <thead className="border-b border-line text-muted">
                <tr>
                  <th scope="col" className="py-2 pr-4 font-medium">도구</th>
                  <th scope="col" className="py-2 pr-4 font-medium">입력</th>
                  <th scope="col" className="py-2 pr-4 font-medium">모델에 간 글자</th>
                  <th scope="col" className="py-2 font-medium">원래 글자</th>
                </tr>
              </thead>
              <tbody>
                {report.biggest.map((result, index) => (
                  <tr key={`${result.name}:${index}`} className="border-b border-line/60 align-top">
                    <th scope="row" className="py-2 pr-4 font-mono text-xs font-medium">{result.name}</th>
                    <td className="py-2 pr-4 font-mono text-xs break-all">{result.input}</td>
                    <td className="py-2 pr-4 font-mono text-xs">{number(result.chars)}</td>
                    <td className="py-2 font-mono text-xs">
                      {number(result.rawChars)}
                      {result.rawChars > result.chars && <span className="ml-1 text-muted">(줄임)</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="token-warnings">
        <h3 id="token-warnings" className="text-sm font-semibold">경고 {report.warnings.length}개</h3>
        {report.warnings.length === 0 ? (
          <p className="mt-2 text-sm text-muted">낭비 신호가 없습니다.</p>
        ) : (
          <ul className="mt-2 flex flex-col gap-1 text-sm">
            {report.warnings.map((warning, index) => (
              <li key={`${warning.kind}:${index}`} className={WARNING_TONE[warning.kind]}>
                {warning.turn !== undefined && <span className="mr-1 font-mono text-xs text-muted">턴 {warning.turn}</span>}
                {warning.message}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * 턴별 컨텍스트 크기 막대. 라이브러리 없이 SVG로 그린다(표가 같은 값을 글로도 보여 준다).
 * 문맥이 급증한 턴은 막대를 빨갛게 칠하고 점을 얹어, 표를 보지 않아도 어디서 뛰었는지 한눈에 보인다(마우스를 올리면 수치를 보여 준다).
 */
function ContextChart({ turns, jumps }: { turns: TokenReport["turns"]; jumps?: ContextJump[] }) {
  const height = 96;
  const width = Math.max(240, turns.length * 28);
  const max = Math.max(1, ...turns.map((turn) => Math.abs(turn.contextTokens)));
  const slot = width / turns.length;
  const barWidth = Math.max(4, Math.min(18, slot - 8));
  const jumpTurns = new Set((jumps ?? []).map((jump) => jump.turn));
  return (
    <div className="mt-2 overflow-x-auto">
      <svg
        viewBox={`0 0 ${width} ${height + 20}`}
        className="h-32 w-full min-w-[240px] text-ink"
        role="img"
        aria-label={`턴별 컨텍스트 크기 막대 그래프${jumpTurns.size > 0 ? "(빨간 막대는 문맥이 급증한 턴)" : ""}`}
      >
        {turns.map((turn, index) => {
          const barHeight = Math.max(2, Math.round((turn.contextTokens / max) * height));
          const x = index * slot + (slot - barWidth) / 2;
          const isJump = jumpTurns.has(turn.turn);
          return (
            <g key={turn.turn} className={isJump ? "text-fail" : undefined}>
              <rect x={x} y={height - barHeight} width={barWidth} height={barHeight} rx={2} fill="currentColor" opacity={isJump ? 1 : 0.85}>
                {isJump && <title>{`턴 ${turn.turn}: 컨텍스트 ${number(turn.contextTokens)} (+${number(turn.delta)})`}</title>}
              </rect>
              {isJump && <circle cx={x + barWidth / 2} cy={Math.max(0, height - barHeight - 6)} r={3} fill="currentColor" />}
              <text x={x + barWidth / 2} y={height + 14} textAnchor="middle" className="fill-muted text-[10px]">
                {turn.turn}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** 턴별 컨텍스트 표. 문맥 급증 목록에 있는 턴은 증가 칸을 강조해 "급증" 표시를 붙인다 */
function TurnsTable({ turns, jumps }: { turns: TokenReport["turns"]; jumps?: ContextJump[] }) {
  const jumpTurns = new Set((jumps ?? []).map((jump) => jump.turn));
  return (
    <div className="mt-3 overflow-x-auto">
      <table className="w-full min-w-[40rem] text-left text-sm">
        <thead className="border-b border-line text-muted">
          <tr>
            <th scope="col" className="py-2 pr-4 font-medium">턴</th>
            <th scope="col" className="py-2 pr-4 font-medium">컨텍스트</th>
            <th scope="col" className="py-2 pr-4 font-medium">증가</th>
            <th scope="col" className="py-2 pr-4 font-medium">출력</th>
            <th scope="col" className="py-2 pr-4 font-medium">캐시 읽기</th>
            <th scope="col" className="py-2 pr-4 font-medium">비움</th>
            <th scope="col" className="py-2 font-medium">가장 큰 도구 결과</th>
          </tr>
        </thead>
        <tbody>
          {turns.map((turn) => {
            const isJump = jumpTurns.has(turn.turn);
            return (
              <tr key={turn.turn} className="border-b border-line/60 align-top">
                <th scope="row" className="py-2 pr-4 font-medium">{turn.turn}</th>
                <td className="py-2 pr-4 font-mono text-xs">{number(turn.contextTokens)}</td>
                <td className={`py-2 pr-4 font-mono text-xs ${isJump ? "text-fail" : ""}`}>
                  +{number(turn.delta)}
                  {isJump && <span className="ml-1">급증</span>}
                </td>
                <td className="py-2 pr-4 font-mono text-xs">{number(turn.output)}</td>
                <td className="py-2 pr-4 font-mono text-xs">{number(turn.cacheRead)}</td>
                <td className="py-2 pr-4 text-muted">
                  {turn.cleared ? `도구 결과 ${number(turn.cleared.count)}개 비움(${number(turn.cleared.chars)}자)` : "-"}
                </td>
                <td className="py-2 text-muted">
                  {turn.biggestTool ? `${turn.biggestTool.name} ${turn.biggestTool.input} · ${number(turn.biggestTool.chars)}자` : "-"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** 문맥 급증 카드 하나: 몇 턴에서 얼마나 늘었는지, 무엇이 늘렸는지, 다시 읽힐 것으로 추정되는 비용, 줄이는 방법 */
function ContextJumpCard({ jump }: { jump: ContextJump }) {
  return (
    <li className="rounded-control border border-line p-3">
      <p className="font-mono text-xs text-fail">
        턴 {jump.turn} · +{number(jump.delta)} 토큰 ({number(jump.previousContext)} → {number(jump.previousContext + jump.delta)})
      </p>
      <p className="mt-1 text-muted">
        원인:{" "}
        {jump.sources.length === 0
          ? "알 수 없음"
          : jump.sources.map((source) => `${source.kind === "model_output" ? "모델 출력" : source.name} ${number(source.chars)}자(${percent(source.share)})`).join(", ")}
      </p>
      <p className="mt-1 text-muted">
        다시 읽힐 것으로 추정되는 비용: {number(jump.estimatedRereadTokens)} 토큰(남은 {jump.remainingTurns}턴 × {number(jump.delta)})
      </p>
      {jump.hints.length > 0 && (
        <ul className="mt-1 list-disc pl-4 text-xs text-muted">
          {jump.hints.map((hint) => (
            <li key={hint}>{hint}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

/** 합계의 추정 비용 한 칸. 계산 방식을 함께 붙이고, 계산하지 못했으면 사유를 보여 준다 */
function costText(report: TokenReport): string {
  const amount = report.estimatedCostUsd === undefined ? (report.priceNote ?? "단가 미설정") : `$${report.estimatedCostUsd.toFixed(4)}`;
  return report.priceSource === "none" ? amount : `${amount} · ${PRICE_SOURCE_LABEL[report.priceSource]}`;
}

/** 모델 한 줄의 비용 칸. 단가를 찾은 모델만 값을, 아니면 사유를 보여 준다 */
function modelCostText(report: TokenReport, model: string): string {
  const cost = report.modelCosts?.[model];
  if (cost !== undefined) return `$${cost.toFixed(4)}`;
  return report.priceSource === "none" ? "단가 미설정" : "단가 없음";
}

/**
 * 실행이 쓴 모델별 토큰과 비용. 모델이 하나면 표 대신 한 줄로 적고, 여럿이면 좁은 화면에서도
 * 가로로 넘치지 않게 압축 표기(compact)로 표를 그린다.
 */
function ModelBreakdown({ report, models }: { report: TokenReport; models: Array<[string, AgentUsage]> }) {
  if (models.length === 1) {
    const [model, usage] = models[0]!;
    return (
      <p className="mt-2 text-sm text-muted">
        <span className="font-mono text-ink">{model}</span> · 입력 {formatTokenCount(usage.inputTokens)} · 캐시 읽기{" "}
        {formatTokenCount(usage.cacheReadTokens)} · 캐시 쓰기 {formatTokenCount(usage.cacheWriteTokens)} · 출력{" "}
        {formatTokenCount(usage.outputTokens)} · {modelCostText(report, model)}
      </p>
    );
  }
  return (
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
            <td className="py-1.5 pr-2 text-right font-mono">{formatTokenCount(usage.inputTokens)}</td>
            <td className="py-1.5 pr-2 text-right font-mono">{formatTokenCount(usage.cacheReadTokens)}</td>
            <td className="py-1.5 pr-2 text-right font-mono">{formatTokenCount(usage.cacheWriteTokens)}</td>
            <td className="py-1.5 pr-2 text-right font-mono">{formatTokenCount(usage.outputTokens)}</td>
            <td className="py-1.5 text-right font-mono">{modelCostText(report, model)}</td>
          </tr>
        ))}
      </tbody>
    </table>
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
