import type { Metadata } from 'next';
import Link from 'next/link';
import { RoutingLauncher } from '@/components/routing-launcher';
import { RoutingStatsPanel } from '@/components/routing-stats-panel';
import { WorkOverview } from '@/components/work-overview';
import { pageUser } from '@/lib/server/access';
import { listAgentOverview } from '@/lib/server/agents-overview';
import { readBackendRules } from '@/lib/server/backend-rules';
import { listProjects } from '@/lib/server/projects';
import { routingStats } from '@/lib/server/routing-stats';
import { allowedBackends, resolveSessionBackend, sessionTerminalAllowed } from '@/lib/server/sessions';

export const metadata: Metadata = { title: '작업' };

export default async function WorkPage() {
  const user = await pageUser();
  const [initial, stats, projects] = await Promise.all([listAgentOverview(user), routingStats(), listProjects()]);
  const { rules, error } = readBackendRules();
  const rulesView = { rules, ...(error ? { error } : {}), allowed: [...allowedBackends()], defaultBackend: resolveSessionBackend(undefined) };

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
          개발 화면으로
        </Link>
      </header>
      <div className="mb-6">
        <RoutingLauncher projects={projects.filter((project) => !project.error).map((project) => ({ id: project.id, name: project.name }))} initial={rulesView} terminalAllowed={sessionTerminalAllowed()} />
      </div>
      <WorkOverview initial={initial} />
      <div className="mt-6">
        <RoutingStatsPanel stats={stats} />
      </div>
    </main>
  );
}
