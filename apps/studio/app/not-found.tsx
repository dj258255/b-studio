import { PageNotice } from "@/components/page-notice";

/**
 * 없는 주소. Next 기본 영어 404 대신 한국어로 알리고 돌아갈 곳을 보여 준다.
 * not-found 파일은 metadata를 내보내는 자리가 아니라서 탭 제목은 React의 <title>로 정한다
 */
export default function NotFound() {
  return (
    <PageNotice title="페이지를 찾지 못했습니다" tabTitle="페이지를 찾지 못했습니다">
      주소가 바뀌었거나 지워진 화면입니다. 아래에서 돌아갈 곳을 고르세요.
    </PageNotice>
  );
}
