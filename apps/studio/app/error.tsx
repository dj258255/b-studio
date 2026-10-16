"use client";

import { PageNotice } from "@/components/page-notice";

/**
 * 화면을 그리다 난 오류. 오류 원문(영어 메시지·스택)은 서버 로그에 남기고, 화면에는 서버 로그와 맞춰 볼 번호만 보인다.
 * "다시 시도"는 이 구간을 다시 받아 그린다. 오류 경계는 metadata를 내보낼 수 없어 탭 제목은 React의 <title>로 정한다.
 */
export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <PageNotice
      title="화면을 그리지 못했습니다"
      tabTitle="오류"
      actions={
        <button type="button" onClick={() => retry()} className="glass-soft rounded-control px-4 py-2 text-sm font-medium hover:bg-panel">
          다시 시도
        </button>
      }
    >
      <p>잠시 뒤 다시 시도해 보세요. 계속되면 서버 로그를 확인하세요.</p>
      {error.digest && <p className="mt-1 font-mono text-xs">오류 번호 {error.digest}</p>}
    </PageNotice>
  );
}
