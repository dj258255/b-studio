import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { DashboardTabs } from "@/components/dashboard-tabs";
import { SplitPicker, SplitView, type SplitCardsEditor } from "@/components/split-view";
import { pageUser } from "@/lib/server/access";
import { studioCapabilities } from "@/lib/server/capabilities";
import { StudioError } from "@/lib/server/errors";
import { listProjects } from "@/lib/server/projects";
import { getSnapshot, listSessions, recoverSessions, sessionTerminalAllowed } from "@/lib/server/sessions";
import { getTaskPlan, PLAN_LIMITS } from "@/lib/server/task-plans";
import { MAX_SPLIT, parseSplitIds, parseSplitPlanId } from "@/lib/split";
import type { TaskPlanView } from "@/lib/task-plan-types";

export const metadata: Metadata = { title: "나란히 보기" };

/**
 * 세션 2~4개를 나란히 보는 화면. `?ids=a,b,c`로 대상을 받는다.
 * `?plan=<id>`가 있으면 그 계획의 레인 세션들을 칸으로 띄우고(레인 세션이 생기는 대로 더한다), 없으면 세션 고르기 화면을 보여 준다.
 * 각 칸은 세션 화면과 같은 이벤트 스트림을 따로 열어 실시간으로 갱신된다.
 */
export default async function SplitPage(props: PageProps<"/split">) {
  const user = await pageUser();
  await recoverSessions();
  const searchParams = await props.searchParams;
  const planId = parseSplitPlanId(searchParams.plan);
  let plan: TaskPlanView | undefined;
  if (planId) {
    try {
      plan = getTaskPlan(planId, user);
    } catch (error) {
      // 없거나 남의 계획이면 화면을 보여 주지 않는다(404)
      if (error instanceof StudioError && (error.status === 404 || error.status === 403)) notFound();
      throw error;
    }
  }
  // plan이 있으면 그 레인 세션들이 ids를 이긴다. 아직 세션이 없으면 빈 목록(레인 세션을 만드는 중 빈 상태를 보인다)
  const ids = parseSplitIds(searchParams.ids);
  const paneIds = plan ? plan.lanes.map((lane) => lane.sessionId).filter((id): id is string => Boolean(id)).slice(0, MAX_SPLIT) : ids;

  const projects = await listProjects();
  const cardsEditor: SplitCardsEditor = {
    terminalAllowed: sessionTerminalAllowed(),
    projects,
    // 나란히 보기에서는 (첫 칸의) 프로젝트가 기본값이다
    defaultProjectId: paneIds.map((id) => getSnapshot(id)?.projectId).find((id): id is string => Boolean(id)),
    limits: { maxTasks: PLAN_LIMITS.maxTasks },
    services: Object.fromEntries(projects.map((project) => [project.id, project.services.map((service) => service.name)])),
  };

  const capabilities = studioCapabilities();
  if (!plan && paneIds.length === 0) {
    return <SplitPicker sessions={await listSessions()} cardsEditor={cardsEditor} tabs={<DashboardTabs current="split" experimental={capabilities.experimental} openFolder={capabilities.openFolder} className="mb-2" />} />;
  }
  // 격자는 화면 높이를 꽉 채우므로 탭은 격자 머리 안에 작게 그린다
  return (
    <SplitView
      panes={paneIds.map((id) => ({ id, snapshot: getSnapshot(id) }))}
      plan={plan}
      cardsEditor={cardsEditor}
      tabs={<DashboardTabs current="split" experimental={capabilities.experimental} openFolder={capabilities.openFolder} className="mb-0" />}
    />
  );
}
