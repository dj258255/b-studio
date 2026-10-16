/**
 * 이 서버에서 못 쓰는 방식의 이유. 실험 기능이라 꺼 둔 경우에는 켜는 방법을 적은 설정 문서로 잇는다
 * (화면에 환경 변수 이름을 그대로 내지 않는다).
 */
export function CapabilityReason({ reason, docsUrl, className }: { reason: string; docsUrl?: string; className: string }) {
  return (
    <p className={className}>
      {reason}
      {docsUrl && (
        <>
          {" "}
          <a href={docsUrl} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-2 hover:text-ink">
            설정 문서 보기
          </a>
        </>
      )}
    </p>
  );
}
