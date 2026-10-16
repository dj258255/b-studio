import { PageNotice } from "@/components/page-notice";

/** 없는 세션(지워졌거나 다른 서버에서 만든 세션). 작업 목록에서 다른 세션을 고르게 한다 */
export default function SessionNotFound() {
  return (
    <PageNotice title="세션을 찾지 못했습니다" tabTitle="세션을 찾지 못했습니다">
      지워졌거나 이 서버에서 만들지 않은 세션입니다. 작업 목록에서 다른 세션을 고르거나 개발 화면에서 새로 시작하세요.
    </PageNotice>
  );
}
