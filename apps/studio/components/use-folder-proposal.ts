"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export interface InfraProposal {
  name: string;
  engine: string;
  image: string;
  /** 기존 compose에서 가져왔으면 그 파일, 새로 제안했으면 없다(reason을 대신 보여준다) */
  sourceFile?: string;
  reason?: string;
  /** 확인이 필요한 메모(예: env_file(.env)에 자격 증명이 있었는데 저장소에 없어 개발용 값을 넣었다는 경고) */
  notes?: string[];
}

export interface Proposal {
  detection: {
    folder: string;
    name: string;
    hasSpec: boolean;
    services: Array<{ name: string; template: string; path: string; port: number; notes: string[] }>;
    /** 기존 compose에서 가져오거나 새로 제안한 부가 서비스(DB·캐시 등, ADR-073) */
    infra: InfraProposal[];
    /** infra 중 앱이 실제로 기대는(닫힘) 이름(ADR-083). 부가 서비스 체크박스의 기본 선택값이다 */
    defaultInfra: string[];
    warnings: string[];
  };
  files: Array<{ path: string; content: string }>;
  registeredId?: string;
}

/**
 * `POST /api/projects/open`을 감싸는 공용 상태(ADR-067·082). 경로 하나를 주면 무엇을 할지 제안을 받고,
 * 확인하면 파일을 쓰고 등록한 뒤 그 프로젝트의 개발 화면으로 이동한다. 경로 직접 입력(`open-folder.tsx`)과
 * 폴더 선택 모달(`folder-browser.tsx`·`desktop-folder-picker.tsx`)이 같은 훅을 쓴다 — 제안을 보여주는
 * 방식(`FolderProposalView`)도 하나로 맞춘다
 */
export function useFolderProposal() {
  const router = useRouter();
  const [proposal, setProposal] = useState<Proposal>();
  const [selectedInfra, setSelectedInfra] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function call(folder: string, apply: boolean): Promise<Record<string, unknown> | undefined> {
    setBusy(true);
    setError(undefined);
    const response = await fetch("/api/projects/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: folder, ...(apply ? { apply: true, selectedInfra: [...selectedInfra] } : {}) }),
    }).catch(() => undefined);
    const body = response ? ((await response.json().catch(() => ({}))) as Record<string, unknown>) : {};
    setBusy(false);
    if (!response?.ok) {
      setError(typeof body.error === "string" ? body.error : apply ? "폴더를 열지 못했습니다" : "폴더를 살펴보지 못했습니다");
      if (!apply) setProposal(undefined);
      return undefined;
    }
    return body;
  }

  /** 무엇을 할지 제안만 받는다(쓰지 않는다) */
  async function propose(folder: string): Promise<void> {
    const body = await call(folder, false);
    if (!body) return;
    const next = body as unknown as Proposal;
    setProposal(next);
    // 기본값(ADR-083): 앱이 기대는 부가 서비스만 체크한다 — 아무도 기대지 않는 부가 서비스(가져온 카프카 등)는 기본으로 끈다
    setSelectedInfra(new Set(next.detection.defaultInfra ?? []));
  }

  /** 파일을 쓰고 등록한 뒤 그 프로젝트의 개발 화면으로 간다 */
  async function apply(folder: string): Promise<void> {
    const body = await call(folder, true);
    if (body && typeof body.id === "string") router.push(`/?project=${encodeURIComponent(body.id)}`);
  }

  function toggleInfra(name: string, on: boolean): void {
    setSelectedInfra((current) => {
      const next = new Set(current);
      if (on) next.add(name);
      else next.delete(name);
      return next;
    });
  }

  function reset(): void {
    setProposal(undefined);
    setError(undefined);
  }

  return { proposal, busy, error, propose, apply, reset, selectedInfra, toggleInfra };
}
