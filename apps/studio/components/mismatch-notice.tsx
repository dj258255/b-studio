import type { RequestMismatch } from "@b-studio/agent";
import { mismatchLine } from "@/lib/mismatch";

/**
 * 에이전트가 알린 요청과 확인(테스트)의 어긋남(#666). 게이트는 통과했지만 어느 쪽이 맞는지 사람이 봐야 한다.
 * 대화의 결과 줄과 계획 화면의 작업 카드가 같은 모양으로 쓴다
 */
export function MismatchNotice({ mismatches }: { mismatches: readonly RequestMismatch[] | undefined }) {
  if (!mismatches?.length) return null;
  return (
    <div className="mt-1 rounded-control border border-wait/40 bg-wait/10 px-2 py-1.5 text-xs leading-5">
      <p className="font-medium text-wait">확인 필요: 요청과 주어진 확인이 어긋난다고 알렸습니다</p>
      <ul className="mt-0.5 space-y-0.5 text-muted">
        {mismatches.map((mismatch, index) => (
          <li key={index}>
            <span className="text-ink">{mismatchLine(mismatch)}</span> · {mismatch.note}
          </li>
        ))}
      </ul>
      <p className="mt-0.5 text-muted">게이트는 통과했습니다. 어느 쪽이 맞는지 정해 요청이나 테스트를 고쳐 주세요</p>
    </div>
  );
}
