import Link from 'next/link';
import { AgentsOverview } from '@/components/agents-overview';
import { pageUser } from '@/lib/server/access';
import { listAgentOverview } from '@/lib/server/agents-overview';

export default async function AgentsPage() {
  const user = await pageUser();
  const initial = await listAgentOverview(user);

  return (
    <main className="mx-auto max-w-[72rem] px-4 py-6 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-muted">b-studio / 관제</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">모든 에이전트의 상태와 개입이 필요한 것을 한 곳에서 봅니다</h1>
          <p className="mt-2 max-w-[70ch] text-sm leading-6 text-muted">
            세션·작업 분해 레인·플릿 구성원을 한 목록으로 모읍니다. 답을 기다리거나 계획 승인이 필요한 것처럼 사람이 봐야 할 것을 먼저 세우고, 3초마다 다시 읽습니다.
          </p>
        </div>
        <Link href="/" className="glass-soft rounded-control px-4 py-2 text-sm font-medium hover:bg-panel">
          프로젝트로 돌아가기
        </Link>
      </header>
      <AgentsOverview initial={initial} />
    </main>
  );
}
