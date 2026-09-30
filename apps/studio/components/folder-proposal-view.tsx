"use client";

import { useState } from "react";
import type { Proposal } from "./use-folder-proposal";

const TEMPLATE_LABEL: Record<string, string> = { nextjs: "Next.js", vite: "Vite", "spring-boot": "Spring Boot", fastapi: "FastAPI" };
const ENGINE_LABEL: Record<string, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
  mariadb: "MariaDB",
  redis: "Redis",
  valkey: "Valkey",
  kafka: "Kafka",
  zookeeper: "ZooKeeper",
  rabbitmq: "RabbitMQ",
  mongodb: "MongoDB",
  elasticsearch: "Elasticsearch",
  opensearch: "OpenSearch",
  minio: "MinIO",
  mailpit: "Mailpit",
  localstack: "LocalStack",
};

/**
 * 폴더 하나를 열기 전에 무엇을 할지 보여준다(찾은 서비스·부가 서비스·만들 파일) 그리고 확인 버튼(ADR-067).
 * `useFolderProposal`이 받아온 결과를 그리기만 하는 순수 표시 컴포넌트라, 경로 직접 입력(`open-folder.tsx`)과
 * 폴더 선택 모달(`folder-browser.tsx`·`desktop-folder-picker.tsx`)이 그대로 함께 쓴다
 */
export function FolderProposalView({
  proposal,
  busy,
  onApply,
  selectedInfra,
  onToggleInfra,
}: {
  proposal: Proposal;
  busy: boolean;
  onApply: () => void;
  /** 기본으로 띄울 부가 서비스(ADR-083). 앱이 기대는 것만 처음에 골라져 있다 */
  selectedInfra: ReadonlySet<string>;
  onToggleInfra: (name: string, on: boolean) => void;
}) {
  const [shown, setShown] = useState<string>();
  const services = proposal.detection.services;
  const canApply = proposal.detection.hasSpec || proposal.files.length > 0;

  return (
    <div className="space-y-3 text-sm">
      <p className="break-all font-mono text-xs text-muted">{proposal.detection.folder}</p>
      {proposal.registeredId && <p className="text-muted">이미 등록한 폴더입니다(프로젝트 {proposal.registeredId}).</p>}
      {proposal.detection.hasSpec ? (
        <p>studio.yaml이 있어 그대로 씁니다. 파일을 만들지 않습니다.</p>
      ) : services.length === 0 ? (
        proposal.detection.warnings.map((warning) => (
          <p key={warning} className="text-wait">
            {warning}
          </p>
        ))
      ) : (
        <>
          <ul className="space-y-1.5" aria-label="찾은 서비스">
            {services.map((service) => (
              <li key={service.name}>
                <span className="font-medium">{service.name}</span>
                <span className="text-muted">
                  {" "}
                  · {TEMPLATE_LABEL[service.template] ?? service.template} · {service.path === "." ? "폴더 바로 아래" : `${service.path}/`} · 포트 {service.port}
                </span>
                {service.notes.map((note) => (
                  <p key={note} className="text-xs text-wait">
                    {note}
                  </p>
                ))}
              </li>
            ))}
          </ul>
          {proposal.detection.infra.length > 0 && (
            <div>
              <p className="text-muted">부가 서비스(DB·캐시 등) — 기본으로 띄울 서비스를 고르세요. 앱이 기대지 않는 서비스는 기본으로 껐습니다</p>
              <ul className="mt-1 space-y-1.5" aria-label="찾거나 제안한 부가 서비스">
                {proposal.detection.infra.map((service) => (
                  <li key={service.name}>
                    <label className="flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={selectedInfra.has(service.name)}
                        onChange={(event) => onToggleInfra(service.name, event.target.checked)}
                        className="accent-ink"
                      />
                      <span className="font-medium">{service.name}</span>
                      <span className="text-muted">
                        · {ENGINE_LABEL[service.engine] ?? service.engine} · <span className="font-mono">{service.image}</span>
                      </span>
                    </label>
                    {service.sourceFile ? (
                      <p className="ml-6 text-xs text-muted">{service.sourceFile}에서 가져왔습니다</p>
                    ) : (
                      <p className="ml-6 text-xs text-wait">새로 제안: {service.reason}</p>
                    )}
                    {service.notes?.map((note) => (
                      <p key={note} className="ml-6 text-xs text-wait">
                        확인: {note}
                      </p>
                    ))}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <p className="text-muted">만들 파일(git 추적에서 빼 둡니다, 저장소 기록은 바뀌지 않습니다)</p>
            <ul className="mt-1 flex flex-wrap gap-1.5">
              {proposal.files.map((file) => (
                <li key={file.path}>
                  <button
                    type="button"
                    onClick={() => setShown(shown === file.path ? undefined : file.path)}
                    aria-expanded={shown === file.path}
                    className="glass-soft rounded-control px-2 py-1 font-mono text-xs hover:bg-panel"
                  >
                    {file.path}
                  </button>
                </li>
              ))}
            </ul>
            {shown && (
              <pre className="mt-2 max-h-64 overflow-auto rounded-control border border-line bg-panel p-3 font-mono text-xs leading-5">
                {proposal.files.find((file) => file.path === shown)?.content}
              </pre>
            )}
          </div>
        </>
      )}
      {canApply && (
        <button type="button" onClick={onApply} disabled={busy} className="rounded-control bg-ink px-4 py-2 font-semibold text-panel hover:bg-ink/85 disabled:opacity-50">
          {busy ? "여는 중" : proposal.detection.hasSpec ? "등록하고 열기" : "파일을 만들고 열기"}
        </button>
      )}
    </div>
  );
}
