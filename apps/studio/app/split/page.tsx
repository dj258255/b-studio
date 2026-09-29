import { SplitPicker, SplitView } from "@/components/split-view";
import { pageUser } from "@/lib/server/access";
import { getSnapshot, listSessions, recoverSessions } from "@/lib/server/sessions";
import { parseSplitIds } from "@/lib/split";

/**
 * 세션 2~4개를 나란히 보는 화면. `?ids=a,b,c`로 대상을 받고, 없으면 세션 고르기 화면을 보여 준다.
 * 각 칸은 세션 화면과 같은 이벤트 스트림을 따로 열어 실시간으로 갱신된다
 */
export default async function SplitPage(props: PageProps<"/split">) {
  await pageUser();
  await recoverSessions();
  const ids = parseSplitIds((await props.searchParams).ids);
  if (ids.length === 0) return <SplitPicker sessions={await listSessions()} />;
  return <SplitView panes={ids.map((id) => ({ id, snapshot: getSnapshot(id) }))} />;
}
