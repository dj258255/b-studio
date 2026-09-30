"use client";

import { useEffect, useState } from "react";
import type { SessionView } from "@/lib/session-view";
import { useChatDraft } from "./chat-draft-context";

type ChecklistStatus = "pass" | "warn" | "fail" | "skip";

interface ChecklistFix {
  label: string;
  prefill: string;
}

interface ChecklistItem {
  id: string;
  title: string;
  status: ChecklistStatus;
  reason: string;
  fix?: ChecklistFix;
}

interface SubmissionReportData {
  items: ChecklistItem[];
  score: { passed: number; total: number };
}

const STATUS_ICON: Record<ChecklistStatus, string> = { pass: "✓", warn: "!", fail: "✗", skip: "–" };
const STATUS_LABEL: Record<ChecklistStatus, string> = { pass: "통과", warn: "확인 필요", fail: "실패", skip: "해당 없음" };
const STATUS_TEXT: Record<ChecklistStatus, string> = { pass: "text-pass", warn: "text-wait", fail: "text-fail", skip: "text-muted" };

/**
 * "저장소" 탭의 "올리기 전 점검" 하위 탭(ADR-080, ADR-087). PR을 올리거나 저장소를 넘기기 전 점검 기준
 * (요구사항·테스트·실행·환경 변수·데이터·비밀 값·커밋 기록·작업 트리/원격·문서)을 점검표로 보여 준다. 요청이 끝날
 * 때마다(체크포인트·커밋이 바뀔 수 있으므로) key로 다시 마운트해 다시 불러온다
 * (RepositoryPanel과 같은 방식. effect 안에서 "불러오는 중"으로 되돌리는 setState를 하지 않아도 된다)
 */
export function SubmissionPanel({ view }: { view: SessionView }) {
  return <SubmissionList key={`${view.snapshot.id}:${view.completedRuns}`} sessionId={view.snapshot.id} />;
}

function SubmissionList({ sessionId }: { sessionId: string }) {
  const [loaded, setLoaded] = useState<{ report?: SubmissionReportData; error?: string }>();
  const draft = useChatDraft();

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/sessions/${sessionId}/submission`)
      .then(async (response) => {
        const data = await response.json();
        if (cancelled) return;
        setLoaded(response.ok ? { report: data as SubmissionReportData } : { error: data.error ?? "점검표를 불러오지 못했습니다" });
      })
      .catch((reason: unknown) => {
        if (!cancelled) setLoaded({ error: String(reason) });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  if (!loaded) {
    return (
      <p role="status" className="p-6 text-sm text-muted">
        점검표를 불러오는 중
      </p>
    );
  }
  if (loaded.error) {
    return (
      <p role="alert" className="p-6 text-sm text-fail">
        {loaded.error}
      </p>
    );
  }
  const report = loaded.report!;

  return (
    <div className="h-full min-h-0 overflow-y-auto p-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium">올리기 전 점검</h3>
        <span className="text-sm text-muted">
          {report.score.passed}/{report.score.total} 통과
        </span>
      </div>
      <p className="mt-1 text-xs leading-5 text-muted">
        PR을 올리거나 저장소를 넘기기 전에 테스트·실행 방법·환경 변수·비밀 값·커밋 기록·문서를 확인합니다. “고치기”는 대화 입력창에 요청 글만 채우고 바로 보내지 않습니다.
      </p>
      <ul className="mt-3 space-y-2">
        {report.items.map((item) => (
          <li key={item.id} className="rounded-panel border border-line p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 items-start gap-2">
                <span aria-hidden="true" className={`shrink-0 font-semibold ${STATUS_TEXT[item.status]}`}>
                  {STATUS_ICON[item.status]}
                </span>
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {item.title}
                    <span className="sr-only">: {STATUS_LABEL[item.status]}</span>
                  </p>
                  <p className="mt-0.5 text-sm text-muted">{item.reason}</p>
                </div>
              </div>
              {item.fix && (
                <button
                  type="button"
                  onClick={() => draft.fill(item.fix!.prefill)}
                  className="shrink-0 rounded-control border border-line px-2.5 py-1 text-xs font-medium whitespace-nowrap hover:border-ink"
                >
                  {item.fix.label}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
