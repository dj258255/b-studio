"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

interface InfraProposal {
  name: string;
  engine: string;
  image: string;
  /** 기존 compose에서 가져왔으면 그 파일, 새로 제안했으면 없다(reason을 대신 보여준다) */
  sourceFile?: string;
  reason?: string;
  /** 확인이 필요한 메모(예: env_file(.env)에 자격 증명이 있었는데 저장소에 없어 개발용 값을 넣었다는 경고) */
  notes?: string[];
}

interface Proposal {
  detection: {
    folder: string;
    name: string;
    hasSpec: boolean;
    services: Array<{ name: string; template: string; path: string; port: number; notes: string[] }>;
    /** 기존 compose에서 가져오거나 새로 제안한 부가 서비스(DB·캐시 등, ADR-073) */
    infra: InfraProposal[];
    warnings: string[];
  };
  files: Array<{ path: string; content: string }>;
  registeredId?: string;
}

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
 * 아무 폴더나 프로젝트로 연다(ADR-067). 경로를 넣으면 먼저 무엇을 할지(알아낸 서비스·만들 파일) 보여 주고,
 * 확인하면 파일을 쓰고 등록한 뒤 그 프로젝트의 개발 화면을 연다
 */
export function OpenFolder() {
  const router = useRouter();
  const [folder, setFolder] = useState("");
  const [proposal, setProposal] = useState<Proposal>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [shown, setShown] = useState<string>();

  async function call(apply: boolean) {
    setBusy(true);
    setError(undefined);
    const response = await fetch("/api/projects/open", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: folder, ...(apply ? { apply: true } : {}) }),
    }).catch(() => undefined);
    const body = response ? await response.json().catch(() => ({})) : {};
    setBusy(false);
    if (!response?.ok) {
      setError(body.error ?? "폴더를 열지 못했습니다");
      return;
    }
    if (!apply) {
      setProposal(body as Proposal);
      return;
    }
    router.push(`/?project=${encodeURIComponent(body.id)}`);
  }

  const services = proposal?.detection.services ?? [];
  const canApply = proposal !== undefined && (proposal.detection.hasSpec || proposal.files.length > 0);

  return (
    <section className="glass rounded-panel p-5" aria-labelledby="open-folder">
      <h2 id="open-folder" className="text-lg font-semibold">
        폴더 열기
      </h2>
      <p className="mt-1 text-sm leading-6 text-muted">
        이 PC의 프로젝트 폴더를 엽니다. studio.yaml이 없으면 폴더를 보고 Next.js·Vite·Spring Boot·FastAPI를 찾아 실행 설정을 만들어 보여 줍니다.
      </p>
      <form
        className="mt-3 flex flex-wrap gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (folder.trim()) void call(false);
        }}
      >
        <label htmlFor="folder-path" className="sr-only">
          폴더 경로
        </label>
        <input
          id="folder-path"
          value={folder}
          onChange={(event) => {
            setFolder(event.target.value);
            setProposal(undefined);
          }}
          placeholder="~/Desktop/my-app"
          className="min-w-0 flex-1 rounded-control border border-line bg-panel px-3 py-2 font-mono text-sm"
        />
        <button type="submit" disabled={busy || !folder.trim()} className="glass-soft rounded-control px-4 py-2 text-sm font-medium hover:bg-panel disabled:opacity-50">
          {busy && !proposal ? "살펴보는 중" : "살펴보기"}
        </button>
      </form>

      {error && (
        <p role="alert" className="mt-3 text-sm text-fail">
          {error}
        </p>
      )}

      {proposal && (
        <div className="mt-4 space-y-3 text-sm">
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
                  <p className="text-muted">부가 서비스(DB·캐시 등, ADR-073)</p>
                  <ul className="mt-1 space-y-1.5" aria-label="찾거나 제안한 부가 서비스">
                    {proposal.detection.infra.map((service) => (
                      <li key={service.name}>
                        <span className="font-medium">{service.name}</span>
                        <span className="text-muted">
                          {" "}
                          · {ENGINE_LABEL[service.engine] ?? service.engine} · <span className="font-mono">{service.image}</span>
                        </span>
                        {service.sourceFile ? (
                          <p className="text-xs text-muted">{service.sourceFile}에서 가져왔습니다</p>
                        ) : (
                          <p className="text-xs text-wait">새로 제안: {service.reason}</p>
                        )}
                        {service.notes?.map((note) => (
                          <p key={note} className="text-xs text-wait">
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
            <button type="button" onClick={() => void call(true)} disabled={busy} className="rounded-control bg-ink px-4 py-2 font-semibold text-panel hover:bg-ink/85 disabled:opacity-50">
              {busy ? "여는 중" : proposal.detection.hasSpec ? "등록하고 열기" : "파일을 만들고 열기"}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
