"use client";

import { useEffect, useRef, useState } from "react";
import type { AccountStatus, CliAccountBackend, LoginProgress } from "@/lib/server/cli-accounts";

/** 진행 중인 로그인을 다시 읽어 오는 주기 */
const POLL_MS = 1200;

type LoginStartResponse = { spawnable: true; progress: LoginProgress } | { spawnable: false; command: string; note?: string };

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { cache: "no-store", ...init });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `요청이 실패했습니다 (${response.status})`);
  return body;
}

/**
 * 계정 연결 화면(ADR-093). 터미널 없이 구독 CLI 네 가지의 로그인 상태를 보고, 되는 CLI는 바로 로그인을 시작한다.
 * 개인 PC 모드가 아니면 서버가 403을 돌려주므로, 이 컴포넌트는 그 안내만 보여준다.
 */
export function AccountsPanel() {
  const [accounts, setAccounts] = useState<AccountStatus[]>();
  const [error, setError] = useState<string>();

  const load = () => {
    getJson<{ accounts: AccountStatus[] }>("/api/accounts")
      .then((body) => setAccounts(body.accounts))
      .catch((loadError: Error) => setError(loadError.message));
  };

  useEffect(load, []);

  if (error) return <p className="glass rounded-panel px-5 py-4 text-sm text-fail">{error}</p>;
  if (!accounts) return <p className="glass rounded-panel px-5 py-4 text-sm text-muted">불러오는 중</p>;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-xs text-muted">비밀번호와 토큰은 b-studio가 보지 않습니다. 각 CLI가 직접 저장합니다.</p>
      <ul className="flex flex-col gap-3">
        {accounts.map((account) => (
          <li key={account.backend}>
            <AccountCard initial={account} onChanged={(status) => setAccounts((prev) => prev?.map((item) => (item.backend === status.backend ? status : item)))} />
          </li>
        ))}
      </ul>
    </div>
  );
}

function statusLabel(status: AccountStatus): string {
  if (status.connected) return "연결됨";
  if (!status.installed) return "설치 안 됨";
  return "로그인 필요";
}

function statusTone(status: AccountStatus): string {
  if (status.connected) return "text-pass";
  if (!status.installed) return "text-muted";
  return "text-wait";
}

export function AccountCard({ initial, onChanged }: { initial: AccountStatus; onChanged: (status: AccountStatus) => void }) {
  const [status, setStatus] = useState(initial);
  const [progress, setProgress] = useState<LoginProgress>();
  const [pending, setPending] = useState<{ command: string; note?: string }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const pollRef = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => () => clearInterval(pollRef.current), []);

  const apply = (next: AccountStatus) => {
    setStatus(next);
    onChanged(next);
  };

  const refresh = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const body = await getJson<{ status: AccountStatus }>(`/api/accounts/${initial.backend}/refresh`, { method: "POST" });
      apply(body.status);
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : String(refreshError));
    } finally {
      setBusy(false);
    }
  };

  const poll = (backend: CliAccountBackend) => {
    clearInterval(pollRef.current);
    pollRef.current = setInterval(async () => {
      try {
        const body = await getJson<{ progress: LoginProgress }>(`/api/accounts/${backend}/login`);
        setProgress(body.progress);
        if (body.progress.state !== "running") {
          clearInterval(pollRef.current);
          if (body.progress.status) apply(body.progress.status);
        }
      } catch {
        clearInterval(pollRef.current);
      }
    }, POLL_MS);
  };

  const startLogin = async () => {
    setBusy(true);
    setError(undefined);
    setPending(undefined);
    try {
      const body = await getJson<LoginStartResponse>(`/api/accounts/${initial.backend}/login`, { method: "POST" });
      if (!body.spawnable) {
        setPending({ command: body.command, note: body.note });
        return;
      }
      setProgress(body.progress);
      poll(initial.backend);
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : String(startError));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    clearInterval(pollRef.current);
    setBusy(true);
    try {
      const body = await getJson<{ progress: LoginProgress }>(`/api/accounts/${initial.backend}/login`, { method: "DELETE" });
      setProgress(body.progress);
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : String(cancelError));
    } finally {
      setBusy(false);
    }
  };

  const copy = (text: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
  };

  const running = progress?.state === "running";

  return (
    <div className="glass flex flex-col gap-3 rounded-panel px-5 py-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-semibold">{status.label}</p>
          <p className={`text-sm font-medium ${statusTone(status)}`}>
            {statusLabel(status)}
            {status.accountKind && <span className="ml-1.5 text-muted">· {status.accountKind}</span>}
          </p>
        </div>
        <div className="flex gap-2">
          <button type="button" disabled={busy} onClick={() => void refresh()} className="glass-soft rounded-control px-3 py-1.5 text-sm font-medium hover:bg-panel disabled:opacity-50">
            다시 확인
          </button>
          {!status.connected && status.installed && !running && (
            <button type="button" disabled={busy} onClick={() => void startLogin()} className="rounded-control bg-ink px-3 py-1.5 text-sm font-medium text-panel hover:bg-ink/85 disabled:opacity-50">
              로그인
            </button>
          )}
          {running && (
            <button type="button" disabled={busy} onClick={() => void cancel()} className="rounded-control border border-line bg-panel px-3 py-1.5 text-sm font-medium hover:border-ink disabled:opacity-50">
              취소
            </button>
          )}
        </div>
      </div>

      {!status.connected && status.reason && <p className="text-sm text-muted">{status.reason}</p>}
      {error && (
        <p role="alert" className="text-sm text-fail">
          {error}
        </p>
      )}

      {pending && (
        <div className="flex flex-col gap-2 rounded-control border border-line bg-panel px-3 py-2.5 text-sm">
          <p>{pending.note ?? "터미널에서 실행한 뒤 다시 확인해 주세요."}</p>
          <div className="flex items-center gap-2">
            <code className="rounded bg-ink/5 px-2 py-1 font-mono text-xs">{pending.command}</code>
            <button type="button" onClick={() => copy(pending.command)} className="glass-soft rounded-control px-2 py-1 text-xs font-medium hover:bg-panel">
              복사
            </button>
          </div>
        </div>
      )}

      {progress && (
        <div className="flex flex-col gap-2 rounded-control border border-line bg-panel px-3 py-2.5 text-sm">
          <p className="text-xs font-medium text-muted">
            {running ? "로그인 진행 중" : progress.state === "cancelled" ? "취소했습니다" : progress.state === "timeout" ? "시간이 지나 멈췄습니다" : "끝났습니다"}
          </p>
          {progress.url && (
            <div className="flex items-center gap-2">
              <a href={progress.url} target="_blank" rel="noreferrer" className="rounded-control bg-ink px-3 py-1.5 text-sm font-medium text-panel hover:bg-ink/85">
                브라우저에서 열기
              </a>
              <button type="button" onClick={() => copy(progress.url!)} className="glass-soft rounded-control px-2 py-1 text-xs font-medium hover:bg-panel">
                주소 복사
              </button>
            </div>
          )}
          {progress.code && (
            <div className="flex items-center gap-2">
              <code className="rounded bg-ink/5 px-2 py-1 font-mono text-xs">{progress.code}</code>
              <button type="button" onClick={() => copy(progress.code!)} className="glass-soft rounded-control px-2 py-1 text-xs font-medium hover:bg-panel">
                코드 복사
              </button>
            </div>
          )}
          {progress.lines.length > 0 && (
            <pre className="max-h-32 overflow-y-auto whitespace-pre-wrap break-all rounded bg-ink/5 p-2 font-mono text-xs text-muted">{progress.lines.join("\n")}</pre>
          )}
        </div>
      )}
    </div>
  );
}
