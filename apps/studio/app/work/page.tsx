import Link from 'next/link';
import { WorkOverview } from '@/components/work-overview';
import { pageUser } from '@/lib/server/access';
import { listAgentOverview } from '@/lib/server/agents-overview';

export default async function WorkPage() {
  const user = await pageUser();
  const initial = await listAgentOverview(user);

  return (
    <main className="mx-auto max-w-[72rem] px-4 py-6 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-muted">b-studio / 작업</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">보낸 요청과 개입이 필요한 것을 한 곳에서 봅니다</h1>
          <p className="mt-2 max-w-[70ch] text-sm leading-6 text-muted">
            한 명·여러 명 비교·나눠서 병렬로 보낸 요청을 요청 하나당 한 줄로 모읍니다. 답을 기다리거나 계획 승인이 필요한 것을 먼저 세우고, 여러 줄을 골라 나란히 볼 수 있습니다.
          </p>
        </div>
        <Link href="/" className="glass-soft rounded-control px-4 py-2 text-sm font-medium hover:bg-panel">
          홈으로
        </Link>
      </header>
      <WorkOverview initial={initial} />
    </main>
  );
}
