"use client";

import { useState } from "react";
import type { WorkflowStepCheck } from "@b-studio/agent";
import { artifactUrl } from "@/lib/artifact-url";
import type { LiveFrame } from "./live-frames";

export interface QaCheck {
  name: string;
  ok: boolean;
  attempts: number;
  detail?: string;
  steps?: WorkflowStepCheck[];
}

/**
 * 플랫폼의 화면 확인(browser_check)을 실시간으로 보여 준다.
 * 확인이 도는 동안에는 프레임 채널의 화면을 그대로 그리고, 옆에 확인 이름과 단계 결과(✓/✗)를 둔다.
 * 끝나면 단계별 스크린샷(산출물)을 넘겨 볼 수 있고, 실패한 단계를 강조한다.
 * 부모가 확인이 바뀔 때마다 key를 바꿔 다시 마운트하므로, 새 확인은 마지막(실패 지점) 스크린샷부터 보인다
 */
export function QaView({ sessionId, frame, check }: { sessionId: string; frame?: LiveFrame; check?: QaCheck }) {
  const shots = (check?.steps ?? []).flatMap((step) => (step.artifact ? [{ label: step.label, ok: step.ok, artifact: step.artifact }] : []));
  const [index, setIndex] = useState(() => Math.max(0, shots.length - 1));

  // 확인이 도는 동안에만 프레임을 살아 있는 것으로 본다. 마지막으로 끝난 확인이 이 프레임의 확인이면 끝난 것이다
  const done = (check?.steps?.length ?? 0) > 0 && frame?.check === check?.name;
  const live = frame !== undefined && !done;
  const current = shots[Math.min(index, shots.length - 1)];
  const name = (live ? frame?.check : undefined) ?? check?.name;

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-panel px-3 py-2 text-sm">
        <span className="font-semibold">화면 확인</span>
        {name && (
          <span className="min-w-0 truncate text-muted" title={name}>
            {name}
          </span>
        )}
        {check && <span className={`ml-auto font-medium ${check.ok ? "text-pass" : "text-fail"}`}>{check.ok ? "통과" : "실패"}</span>}
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[minmax(0,1fr)_auto] lg:grid-cols-[minmax(0,1fr)_18rem] lg:grid-rows-1">
        <div className="flex min-h-0 items-center justify-center overflow-hidden bg-ground">
          {live && frame ? (
            <img src={`data:${frame.mime};base64,${frame.data}`} alt="" className="max-h-full max-w-full" />
          ) : current ? (
            <img src={artifactUrl(sessionId, current.artifact)} alt={`${current.label} 화면`} className="max-h-full max-w-full" />
          ) : (
            <p role="status" className="px-4 py-3 text-sm text-muted">
              {check ? "이 확인에는 저장된 화면이 없습니다" : "화면 확인이 시작되면 이곳에 화면이 나옵니다"}
            </p>
          )}
        </div>

        <aside className="min-h-0 overflow-y-auto border-t border-line bg-panel p-3 lg:border-t-0 lg:border-l">
          {check?.steps?.length ? (
            <>
              <ol className="space-y-1.5">
                {check.steps.map((step, stepIndex) => (
                  <li key={stepIndex} className={`flex items-start gap-2 text-sm ${step.ok ? "" : "font-medium text-fail"}`}>
                    <span aria-hidden className={step.ok ? "text-pass" : "text-fail"}>
                      {step.ok ? "✓" : "✗"}
                    </span>
                    <span className="min-w-0 flex-1 break-words">
                      {step.label}
                      {step.detail && <span className="mt-0.5 block text-xs font-normal text-muted">{step.detail}</span>}
                    </span>
                  </li>
                ))}
              </ol>
              {shots.length > 0 && (
                <div className="mt-3 flex items-center gap-2 border-t border-line pt-3">
                  <button
                    type="button"
                    onClick={() => setIndex((value) => Math.max(0, value - 1))}
                    disabled={index <= 0}
                    className="rounded-control border border-line px-2.5 py-1 text-sm disabled:opacity-50"
                  >
                    이전
                  </button>
                  <button
                    type="button"
                    onClick={() => setIndex((value) => Math.min(shots.length - 1, value + 1))}
                    disabled={index >= shots.length - 1}
                    className="rounded-control border border-line px-2.5 py-1 text-sm disabled:opacity-50"
                  >
                    다음
                  </button>
                  <span className="ml-auto text-xs text-muted">
                    단계 {index + 1} / {shots.length}
                  </span>
                </div>
              )}
            </>
          ) : (
            <p className="text-sm text-muted">{name ? "확인 중입니다. 단계 결과는 끝나면 표시됩니다." : "화면 확인 기록이 아직 없습니다."}</p>
          )}
        </aside>
      </div>
    </div>
  );
}
