"use client";

import type { OpenApiDocument } from "@b-studio/agent";
import { useEffect, useState } from "react";
import type { ProxyResponse } from "@/lib/studio-events";
import { useSessionAccess } from "./session-access";

const METHODS = ["get", "post", "put", "patch", "delete"] as const;

interface Operation {
  method: string;
  path: string;
  summary?: string;
}

type SchemaMap = NonNullable<NonNullable<OpenApiDocument["components"]>["schemas"]>;

/** API 탐색기가 다루는 대상: 샌드박스 서비스나 등록한 사내 API */
export interface ExplorerTarget {
  name: string;
  requestUrl: string;
  contractUrl?: string;
  ready: boolean;
  /** 재시작으로 주소가 바뀌면 계약을 다시 불러오기 위한 값 */
  address?: string;
  notice?: string;
}

export function ApiExplorer({ target, revision }: { target: ExplorerTarget; revision: number }) {
  const [contract, setContract] = useState<{ document?: OpenApiDocument; error?: string }>({});
  const [method, setMethod] = useState("GET");
  const [path, setPath] = useState("/");
  const [body, setBody] = useState("");
  const [response, setResponse] = useState<ProxyResponse | { error: string }>();
  const [sending, setSending] = useState(false);
  const access = useSessionAccess();

  useEffect(() => {
    if (!target.contractUrl) return;
    let cancelled = false;
    fetch(target.contractUrl)
      .then(async (res) => {
        const data = await res.json();
        if (!cancelled) setContract(res.ok ? { document: data as OpenApiDocument } : { error: data.error });
      })
      .catch((error: unknown) => {
        if (!cancelled) setContract({ error: String(error) });
      });
    return () => {
      cancelled = true;
    };
    // 재시작(주소 변경)이나 요청 완료 뒤에 계약을 다시 불러온다
  }, [target.contractUrl, target.address, revision]);

  const operations = listOperations(contract.document);
  const schemas = contract.document?.components?.schemas ?? {};

  async function send() {
    setSending(true);
    const res = await fetch(target.requestUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ method, path, body }),
    });
    const data = await res.json();
    setResponse(res.ok ? (data as ProxyResponse) : { error: data.error });
    setSending(false);
  }

  return (
    <div className="grid h-full min-h-0 grid-cols-1 md:grid-cols-[18rem_minmax(0,1fr)]">
      <aside className="min-h-0 overflow-y-auto border-b border-line bg-panel md:border-r md:border-b-0">
        <h3 className="px-4 pt-4 text-sm font-semibold">엔드포인트</h3>
        {contract.error && <p className="px-4 pt-2 text-sm text-fail">{contract.error}</p>}
        {target.notice && <p className="px-4 pt-2 text-sm text-muted">{target.notice}</p>}
        <ul className="px-2 py-2">
          {operations.map((operation) => {
            const selected = operation.method === method && operation.path === path;
            return (
              <li key={`${operation.method} ${operation.path}`}>
                <button
                  type="button"
                  onClick={() => {
                    setMethod(operation.method);
                    setPath(operation.path);
                    setResponse(undefined);
                  }}
                  className={`flex w-full items-baseline gap-2 rounded px-2 py-1.5 text-left ${selected ? "bg-ground" : "hover:bg-ground"}`}
                >
                  <span className="w-12 shrink-0 font-mono text-xs font-medium">{operation.method}</span>
                  <span className="font-mono text-sm break-all">{operation.path}</span>
                </button>
              </li>
            );
          })}
        </ul>
        <SchemaList schemas={schemas} />
      </aside>

      <div className="flex min-h-0 flex-col overflow-y-auto p-4">
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          <label htmlFor="api-method" className="sr-only">
            메서드
          </label>
          <select id="api-method" value={method} onChange={(event) => setMethod(event.target.value)} className="rounded-lg border border-line bg-panel px-2 py-1.5 font-mono text-sm">
            {METHODS.map((value) => (
              <option key={value}>{value.toUpperCase()}</option>
            ))}
          </select>
          <label htmlFor="api-path" className="sr-only">
            경로
          </label>
          <input
            id="api-path"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            className="min-w-0 flex-1 rounded-lg border border-line bg-panel px-2 py-1.5 font-mono text-sm"
          />
          <button type="submit" disabled={sending || !target.ready || !access.canManage} className="rounded-full bg-ink px-4 py-1.5 text-sm font-medium text-panel shadow-sm hover:bg-ink/85 disabled:opacity-50">
            {sending ? "보내는 중" : "보내기"}
          </button>
        </form>

        {method !== "GET" && (
          <>
            <label htmlFor="api-body" className="mt-3 text-sm text-muted">
              요청 본문 (JSON)
            </label>
            <textarea
              id="api-body"
              value={body}
              onChange={(event) => setBody(event.target.value)}
              rows={5}
              className="mt-1 rounded-lg border border-line bg-panel px-2 py-1.5 font-mono text-sm"
            />
          </>
        )}

        {response && <ResponseView response={response} />}
      </div>
    </div>
  );
}

function ResponseView({ response }: { response: ProxyResponse | { error: string } }) {
  if ("error" in response) return <p className="mt-4 text-sm text-fail">{response.error}</p>;

  const tone = response.status >= 500 ? "text-fail" : response.status >= 400 ? "text-wait" : "text-pass";
  return (
    <div className="mt-4 min-h-0">
      <p className="text-sm">
        <span className={`font-semibold ${tone}`}>HTTP {response.status}</span>
        <span className="text-muted">, {response.durationMs}ms</span>
        {response.truncated && <span className="text-wait">, 응답이 길어 앞부분만 표시</span>}
      </p>
      {response.policy && (
        <p className={`mt-1 text-sm ${response.policy.decision === "deny" ? "text-fail" : "text-muted"}`}>
          {response.policy.decision === "deny"
            ? `정책으로 막힘: ${response.policy.reason ?? "허용하지 않은 호출"}`
            : response.policy.masked > 0
              ? `정책 통과. ${response.policy.masked}곳을 가렸습니다`
              : "정책 통과. 가린 곳은 없습니다"}
        </p>
      )}
      <pre className="mt-2 overflow-auto rounded-md border border-line bg-panel p-3 font-mono text-xs leading-5 whitespace-pre-wrap">
        {prettyBody(response)}
      </pre>
    </div>
  );
}

function SchemaList({ schemas }: { schemas: SchemaMap }) {
  const entries = Object.entries(schemas);
  if (entries.length === 0) return null;
  return (
    <>
      <h3 className="border-t border-line px-4 pt-4 text-sm font-semibold">스키마</h3>
      <dl className="px-4 py-2">
        {entries.map(([name, schema]) => {
          const required = new Set(schema.required ?? []);
          return (
            <div key={name} className="py-1.5">
              <dt className="font-mono text-sm font-medium">{name}</dt>
              <dd className="font-mono text-xs leading-5 text-muted">
                {Object.entries(schema.properties ?? {})
                  .map(([prop, definition]) => `${prop}${required.has(prop) ? "" : "?"}: ${typeLabel(definition)}`)
                  .join(", ")}
              </dd>
            </div>
          );
        })}
      </dl>
    </>
  );
}

function listOperations(document?: OpenApiDocument): Operation[] {
  if (!document?.paths) return [];
  return Object.entries(document.paths).flatMap(([path, item]) =>
    METHODS.filter((method) => method in item).map((method) => ({ method: method.toUpperCase(), path })),
  );
}

function typeLabel(schema: { type?: string | string[]; $ref?: string; format?: string }): string {
  if (schema.$ref) return schema.$ref.split("/").at(-1) ?? schema.$ref;
  const type = Array.isArray(schema.type) ? schema.type.filter((value) => value !== "null").join("|") : (schema.type ?? "any");
  return schema.format ? `${type}(${schema.format})` : type;
}

function prettyBody(response: ProxyResponse): string {
  if (response.contentType?.includes("json")) {
    try {
      return JSON.stringify(JSON.parse(response.body), null, 2);
    } catch {
      // JSON이라고 했지만 파싱되지 않으면 원문을 보여준다
    }
  }
  return response.body || "(본문 없음)";
}
