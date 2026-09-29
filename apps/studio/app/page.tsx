import Link from "next/link";
import { HomeEntry } from "@/components/home-entry";
import { HomeInbox } from "@/components/home-inbox";
import { LogoutButton } from "@/components/logout-button";
import { pageUser } from "@/lib/server/access";
import { authConfig } from "@/lib/server/auth";
import { listModelOptions } from "@/lib/server/model-registry";
import { listProjects, projectPath } from "@/lib/server/projects";
import { listSessions, localFolderAllowed } from "@/lib/server/sessions";
import { SESSION_STATUS_LABEL, TONE_TEXT, type Tone } from "@/components/status";
import type { SessionStatus } from "@/lib/studio-events";

const MODE_NOTE: Record<string, string> = {
  api: "요청은 Claude API로 처리합니다. 서버에 ANTHROPIC_API_KEY가 있어야 합니다.",
  "claude-code":
    "요청은 이 PC의 claude CLI에 로그인한 계정으로 처리합니다. API 키가 필요 없는 대신 본인 PC에서만 쓰세요. 여러 사람이 쓰는 서버에는 api 모드를 씁니다.",
  codex:
    "이 PC에 ChatGPT로 로그인한 Codex CLI로 실행합니다. 대화는 이어받지 않고 최근 요청 요약만 넘깁니다. API 키가 필요 없는 대신 본인 PC에서만 쓰세요. 아직 실제 계정으로 확인하지 못한 모드입니다(#54).",
  commandcode:
    "이 PC에 로그인한 Command Code로 실행합니다. 모델을 고를 수 있고 기본은 계정 기본 모델입니다. 무료 모델만 쓰도록 설정할 수도 있습니다. API 키가 필요 없는 대신 본인 PC에서만 쓰세요.",
  opencode:
    "이 PC에 설치된 OpenCode CLI로 실행합니다. 모델을 고를 수 있고 기본은 무료 모델만 씁니다. API 키가 필요 없는 대신 본인 PC에서만 쓰세요.",
  demo: "데모 모드로 실행 중입니다. 준비된 요청을 스크립트로 실행하므로 API 키가 필요 없습니다.",
};

const STATUS_TONE: Record<SessionStatus, Tone> = { idle: "idle", starting: "wait", ready: "pass", failed: "fail", stopped: "idle" };
const RECENT_SESSIONS = 20;
const TIME = new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium", timeStyle: "short" });

export default async function HomePage() {
  const viewer = await pageUser();
  const auth = authConfig().mode;
  const [projects, sessions] = await Promise.all([listProjects(), listSessions()]);
  const mode = process.env.B_STUDIO_MODE?.trim() || "api";
  const note = MODE_NOTE[mode] ?? `B_STUDIO_MODE 값 "${mode}"을 알 수 없습니다. api, claude-code, codex, commandcode, opencode, demo 중 하나로 실행하세요.`;
  const localAllowed = localFolderAllowed();
  const models = listModelOptions();
  // 내 폴더를 고를 수 있으면 "자세히"에서 실제 경로를 보여 준다
  const projectItems = projects.map((project) => ({ ...project, folder: localAllowed && !project.error ? projectPath(project.id) : undefined }));

  return (
    <main className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm font-semibold text-muted">b-studio</p>
        {auth !== "none" && (
          <div className="flex items-center gap-3 text-sm text-muted">
            <span>{viewer}</span>
            {auth === "token" && <LogoutButton />}
          </div>
        )}
      </div>

      <h1 className="mt-2 text-3xl font-semibold tracking-tight">무엇을 만들까요?</h1>
      <p className="mt-3 max-w-[60ch] leading-7 text-muted">
        요청을 한 곳에서 보냅니다. 한 명에게 맡길지, 여러 명에게 같은 요청을 맡겨 비교할지, 나눠서 병렬로 돌릴지 고르세요. 에이전트가 끝내면 스튜디오가 바뀐
        서비스를 재시작하고 API 계약을 비교해, 통과한 결과만 완료로 보여줍니다.
      </p>

      <p className="mt-6 rounded-panel border border-line bg-panel px-4 py-3 text-sm leading-6 text-muted">{note}</p>

      <div className="mt-8 grid items-start gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <HomeEntry projects={projectItems} models={models} localAllowed={localAllowed} />
        <HomeInbox />
      </div>

      {sessions.length > 0 && (
        <section className="mt-14" aria-labelledby="sessions-heading">
          <h2 id="sessions-heading" className="text-lg font-semibold">
            최근 세션
          </h2>
          <p className="mt-1 text-sm text-muted">중지된 세션도 작업 복사본과 체크포인트가 남아 있어 열어서 이어서 작업할 수 있습니다.</p>
          <ul className="glass mt-4 divide-y divide-line overflow-hidden rounded-panel">
            {sessions.slice(0, RECENT_SESSIONS).map((session) => (
              <li key={session.id} className="flex flex-wrap items-center gap-4 px-5 py-4">
                <div className="min-w-0 flex-1">
                  <p className="flex items-baseline gap-2">
                    <span className="font-semibold">{session.projectName}</span>
                    <span className={`text-sm ${TONE_TEXT[STATUS_TONE[session.status]]}`}>{SESSION_STATUS_LABEL[session.status]}</span>
                  </p>
                  <p className="mt-1 truncate text-sm text-muted">
                    {session.lastRequest ? `마지막 요청: ${session.lastRequest}` : "아직 보낸 요청이 없습니다"}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">
                    {session.workspace === "local" && "내 폴더, "}
                    체크포인트 {session.checkpoints}개, {TIME.format(new Date(session.updatedAt))}
                    {auth !== "none" && session.owner && `, 만든 사람 ${session.owner}`}
                  </p>
                </div>
                <Link href={`/sessions/${session.id}`} className="glass-soft rounded-control px-4 py-1.5 text-sm font-medium hover:bg-panel">
                  열기
                </Link>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
