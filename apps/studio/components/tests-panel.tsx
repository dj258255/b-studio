"use client";

import { useEffect, useMemo, useState } from "react";
import type { SessionView } from "@/lib/session-view";
import { useChatDraft } from "./chat-draft-context";
import { useCodeOpen } from "./code-open-context";
import { Dot, type Tone } from "./status";

type TestStatus = "pass" | "fail" | "skip" | "not-run";

interface TestRowView {
  file: string;
  framework: string;
  suitePath: string[];
  name: string;
  displayName: string;
  line: number;
  skipped: boolean;
  requirementIds: string[];
  status: TestStatus;
  durationMs?: number;
  failureMessage?: string;
  stack?: string[];
  fixPrefill?: string;
}

interface TestServiceView {
  service: string;
  template: string;
  running: boolean;
  supported: boolean;
  runner?: string;
  counts: { pass: number; fail: number; skip: number; notRun: number };
  lastRunAt?: string;
  lastRunSource?: "run" | "gate";
  error?: string;
  /** 문제는 아니지만 알아 둘 만한 안내(예: 서비스가 꺼져 있어 마지막 실행 결과만 보여줌). error와 달리 경고색으로 그리지 않는다 */
  notice?: string;
  rows: TestRowView[];
}

interface RequirementWithoutTest {
  id: string;
  title: string;
  prefill: string;
}

interface TestsSnapshot {
  services: TestServiceView[];
  requirementsWithoutTests: RequirementWithoutTest[];
}

type Filter = "all" | "fail" | "requirements";

const STATUS_LABEL: Record<TestStatus, string> = { pass: "통과", fail: "실패", skip: "건너뜀", "not-run": "안 돌림" };
const STATUS_TONE: Record<TestStatus, Tone> = { pass: "pass", fail: "fail", skip: "idle", "not-run": "idle" };

async function readJson<T>(response: Response): Promise<T & { error?: string }> {
  return (await response.json().catch(() => ({}))) as T & { error?: string };
}

/**
 * 개발 화면의 "테스트" 탭(ADR-084). 백엔드·프론트 테스트 케이스를 서비스마다 찾아 한 줄씩 보여 주고,
 * 전체·서비스·파일·테스트 하나 단위로 돌릴 수 있다. 실패한 줄에서는 "이 테스트 고쳐 줘"로 대화창을 채우고,
 * docs/requirements.md에 있지만 테스트가 없는 요구사항은 "테스트 추가"로 채운다(둘 다 채우기만 하고 자동으로 보내지 않는다).
 */
export function TestsPanel({ view }: { view: SessionView }) {
  const sessionId = view.snapshot.id;
  const draft = useChatDraft();
  const codeOpen = useCodeOpen();
  const [snapshot, setSnapshot] = useState<{ data?: TestsSnapshot; error?: string }>();
  const [filter, setFilter] = useState<Filter>("all");
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [runningLocally, setRunningLocally] = useState<string>();
  const [actionError, setActionError] = useState<string>();

  const revision = `${view.snapshot.testsRevision ?? 0}|${view.snapshot.status}`;
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/sessions/${sessionId}/tests`)
      .then(async (response) => {
        const data = await readJson<TestsSnapshot>(response);
        if (!cancelled) setSnapshot(response.ok ? { data } : { error: data.error ?? "테스트를 불러오지 못했습니다" });
      })
      .catch(() => {
        if (!cancelled) setSnapshot({ error: "테스트를 불러오지 못했습니다" });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, revision]);

  async function run(body: { service: string; file?: string; suitePath?: string[]; testName?: string }) {
    setActionError(undefined);
    setRunningLocally(body.service);
    try {
      const response = await fetch(`/api/sessions/${sessionId}/tests/run`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await readJson<TestsSnapshot>(response);
      if (response.ok) setSnapshot({ data });
      else setActionError(data.error ?? "테스트를 돌리지 못했습니다");
    } catch {
      setActionError("테스트를 돌리지 못했습니다");
    } finally {
      setRunningLocally(undefined);
    }
  }

  async function cancel(service: string) {
    await fetch(`/api/sessions/${sessionId}/tests/cancel`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ service }),
    }).catch(() => {});
  }

  function toggleSuite(key: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  async function runAll() {
    if (!snapshot?.data) return;
    for (const service of snapshot.data.services) {
      if (!service.supported) continue;
      await run({ service: service.service });
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-line bg-panel px-3 py-2">
        <p className="text-sm font-medium text-ink">백엔드·프론트 테스트를 한 줄씩 보고 돌린다</p>
        <div className="glass-soft ml-auto inline-flex rounded-control p-0.5 text-sm" role="tablist" aria-label="테스트 필터">
          {(
            [
              ["all", "전체"],
              ["fail", "실패만"],
              ["requirements", "요구사항 연결"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={filter === value}
              onClick={() => setFilter(value)}
              className={`rounded-md px-3 py-1 font-medium transition-colors ${filter === value ? "bg-panel text-ink ring-1 ring-line" : "text-muted hover:text-ink"}`}
            >
              {label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={() => void runAll()}
          disabled={runningLocally !== undefined}
          className="shrink-0 rounded-control bg-ink px-3 py-1.5 text-sm font-medium text-panel hover:bg-ink/85 disabled:opacity-60"
        >
          전체 실행
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {!snapshot ? (
          <p className="text-sm text-muted">불러오는 중</p>
        ) : snapshot.error ? (
          <p className="text-sm text-fail">{snapshot.error}</p>
        ) : (
          <div className="flex flex-col gap-4">
            {actionError && <p className="text-sm text-fail">{actionError}</p>}
            {snapshot.data!.services.map((service) => (
              <ServiceSection
                key={service.service}
                service={service}
                filter={filter}
                collapsed={collapsed}
                onToggleSuite={toggleSuite}
                running={service.running || runningLocally === service.service || (view.snapshot.testsRunning ?? []).includes(service.service)}
                onRunService={() => void run({ service: service.service })}
                onRunFile={(file) => void run({ service: service.service, file })}
                onRunTest={(row) => void run({ service: service.service, file: row.file, suitePath: row.suitePath, testName: row.name })}
                onCancel={() => void cancel(service.service)}
                onFix={(row) => draft.fill(row.fixPrefill!)}
                onOpenCode={(row) => codeOpen.open({ path: row.file, line: row.line })}
              />
            ))}
            {filter !== "fail" && snapshot.data!.requirementsWithoutTests.length > 0 && (
              <div className="rounded-control border border-line p-3">
                <p className="text-sm font-medium text-ink">테스트가 없는 요구사항</p>
                <ul className="mt-2 flex flex-col gap-1.5">
                  {snapshot.data!.requirementsWithoutTests.map((requirement) => (
                    <li key={requirement.id} className="flex items-center gap-2 text-sm">
                      <span className="min-w-0 flex-1 truncate">
                        <span className="font-mono text-xs text-muted">{requirement.id}</span> {requirement.title}
                      </span>
                      <button
                        type="button"
                        onClick={() => draft.fill(requirement.prefill)}
                        className="shrink-0 rounded-control border border-line px-2.5 py-1 text-xs font-medium hover:border-ink"
                      >
                        테스트 추가
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function ServiceSection({
  service,
  filter,
  collapsed,
  onToggleSuite,
  running,
  onRunService,
  onRunFile,
  onRunTest,
  onCancel,
  onFix,
  onOpenCode,
}: {
  service: TestServiceView;
  filter: Filter;
  collapsed: ReadonlySet<string>;
  onToggleSuite: (key: string) => void;
  running: boolean;
  onRunService: () => void;
  onRunFile: (file: string) => void;
  onRunTest: (row: TestRowView) => void;
  onCancel: () => void;
  onFix: (row: TestRowView) => void;
  onOpenCode: (row: TestRowView) => void;
}) {
  const visibleRows = useMemo(() => {
    if (filter === "fail") return service.rows.filter((row) => row.status === "fail");
    if (filter === "requirements") return service.rows.filter((row) => row.requirementIds.length > 0);
    return service.rows;
  }, [service.rows, filter]);

  const byFile = useMemo(() => {
    const groups = new Map<string, TestRowView[]>();
    for (const row of visibleRows) {
      const list = groups.get(row.file) ?? [];
      list.push(row);
      groups.set(row.file, list);
    }
    return [...groups.entries()];
  }, [visibleRows]);

  return (
    <section className="rounded-control border border-line">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <p className="font-medium text-ink">
          {service.service} <span className="text-xs font-normal text-muted">({service.template}{service.runner ? ` · ${service.runner}` : ""})</span>
        </p>
        <p className="text-xs text-muted">
          통과 {service.counts.pass} · 실패 {service.counts.fail} · 건너뜀 {service.counts.skip} · 안 돌림 {service.counts.notRun}
          {service.lastRunAt && <> · {service.lastRunSource === "gate" ? "게이트에서 모음" : "마지막 실행"} {new Date(service.lastRunAt).toLocaleTimeString("ko-KR")}</>}
        </p>
        <div className="ml-auto flex shrink-0 gap-1.5">
          {running ? (
            <button type="button" onClick={onCancel} className="rounded-control border border-line px-2.5 py-1 text-xs font-medium hover:border-ink">
              취소
            </button>
          ) : (
            <button
              type="button"
              onClick={onRunService}
              disabled={!service.supported}
              className="rounded-control border border-line px-2.5 py-1 text-xs font-medium hover:border-ink disabled:opacity-40"
            >
              서비스 실행
            </button>
          )}
        </div>
      </div>
      {service.error && <p className="border-b border-line px-3 py-2 text-xs text-fail">{service.error}</p>}
      {service.notice && <p className="border-b border-line px-3 py-2 text-xs text-muted">{service.notice}</p>}
      {running && <p role="status" className="border-b border-line px-3 py-2 text-xs text-wait motion-safe:animate-pulse">테스트를 돌리는 중입니다</p>}
      <div className="p-2">
        {byFile.length === 0 ? (
          <p className="px-2 py-2 text-xs text-muted">{service.rows.length === 0 ? "테스트 파일을 찾지 못했습니다." : "이 필터에 맞는 테스트가 없습니다."}</p>
        ) : (
          byFile.map(([file, rows]) => (
            <FileGroup
              key={file}
              file={file}
              rows={rows}
              collapsed={collapsed}
              onToggleSuite={onToggleSuite}
              onRunFile={() => onRunFile(file)}
              onRunTest={onRunTest}
              onFix={onFix}
              onOpenCode={onOpenCode}
              disabled={!service.supported || running}
            />
          ))
        )}
      </div>
    </section>
  );
}

function FileGroup({
  file,
  rows,
  collapsed,
  onToggleSuite,
  onRunFile,
  onRunTest,
  onFix,
  onOpenCode,
  disabled,
}: {
  file: string;
  rows: TestRowView[];
  collapsed: ReadonlySet<string>;
  onToggleSuite: (key: string) => void;
  onRunFile: () => void;
  onRunTest: (row: TestRowView) => void;
  onFix: (row: TestRowView) => void;
  onOpenCode: (row: TestRowView) => void;
  disabled: boolean;
}) {
  return (
    <div className="mb-2">
      <div className="flex items-center gap-2 rounded px-2 py-1">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted" title={file}>
          {file}
        </span>
        <button type="button" onClick={onRunFile} disabled={disabled} className="shrink-0 text-xs font-medium text-muted hover:text-ink disabled:opacity-40">
          파일 실행
        </button>
      </div>
      <ul>
        {rows.map((row, index) => {
          const suiteKey = `${file}::${row.suitePath.join("/")}`;
          const showSuiteHeader = row.suitePath.length > 0 && (index === 0 || rows[index - 1]!.suitePath.join("/") !== row.suitePath.join("/"));
          const suiteCollapsed = row.suitePath.some((_, depth) => collapsed.has(`${file}::${row.suitePath.slice(0, depth + 1).join("/")}`));
          return (
            <li key={`${row.file}:${row.suitePath.join("/")}:${row.name}:${row.line}`}>
              {showSuiteHeader && (
                <button
                  type="button"
                  onClick={() => onToggleSuite(suiteKey)}
                  style={{ paddingLeft: (row.suitePath.length - 1) * 14 + 8 }}
                  className="flex w-full items-center gap-1.5 py-1 text-left text-xs font-medium text-muted hover:text-ink"
                >
                  <span aria-hidden className={`transition-transform ${collapsed.has(suiteKey) ? "" : "rotate-90"}`}>
                    ›
                  </span>
                  {row.suitePath.at(-1)}
                </button>
              )}
              {!suiteCollapsed && <TestLine row={row} depth={row.suitePath.length} onRunTest={onRunTest} onFix={onFix} onOpenCode={onOpenCode} disabled={disabled} />}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function TestLine({
  row,
  depth,
  onRunTest,
  onFix,
  onOpenCode,
  disabled,
}: {
  row: TestRowView;
  depth: number;
  onRunTest: (row: TestRowView) => void;
  onFix: (row: TestRowView) => void;
  onOpenCode: (row: TestRowView) => void;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 py-0.5 text-sm" style={{ paddingLeft: depth * 14 + 8 }}>
      <Dot tone={STATUS_TONE[row.status]} />
      <span className={`w-12 shrink-0 text-xs ${row.status === "fail" ? "text-fail" : row.status === "pass" ? "text-pass" : "text-muted"}`}>{STATUS_LABEL[row.status]}</span>
      <button
        type="button"
        onClick={() => onOpenCode(row)}
        className="min-w-0 flex-1 truncate text-left hover:underline"
        title={`${row.file}:${row.line}`}
      >
        {row.displayName || row.name}
        {row.skipped && <span className="ml-1 text-xs text-muted">(건너뜀)</span>}
      </button>
      {row.requirementIds.map((id) => (
        <span key={id} className="glass-soft shrink-0 rounded-control px-1.5 py-0.5 text-xs font-mono">
          {id}
        </span>
      ))}
      {row.durationMs !== undefined && <span className="shrink-0 font-mono text-xs text-muted">{row.durationMs}ms</span>}
      <span className="shrink-0 font-mono text-xs text-muted">{row.file}:{row.line}</span>
      {row.status === "fail" && (
        <button type="button" onClick={() => onFix(row)} className="shrink-0 rounded-control border border-line px-2 py-0.5 text-xs font-medium hover:border-ink">
          이 테스트 고쳐 줘
        </button>
      )}
      <button
        type="button"
        onClick={() => onRunTest(row)}
        disabled={disabled}
        className="shrink-0 rounded-control border border-line px-2 py-0.5 text-xs font-medium hover:border-ink disabled:opacity-40"
      >
        이 테스트만 실행
      </button>
      {row.failureMessage && (
        <p className="w-full pl-14 font-mono text-xs text-fail">
          {row.failureMessage}
          {row.stack && row.stack.length > 0 && (
            <>
              <br />
              {row.stack.slice(0, 3).join(" · ")}
            </>
          )}
        </p>
      )}
    </div>
  );
}
