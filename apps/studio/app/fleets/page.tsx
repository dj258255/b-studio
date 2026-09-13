import Link from 'next/link';
import { FleetWorkbench } from '@/components/fleet-workbench';
import { pageUser } from '@/lib/server/access';
import { listFleets } from '@/lib/server/fleets';
import { listModelOptions } from '@/lib/server/model-registry';
import { listProjects } from '@/lib/server/projects';

export default async function FleetsPage() {
  const user = await pageUser();
  const [projects, models] = await Promise.all([listProjects(), Promise.resolve(listModelOptions())]);
  const initial = listFleets(user);

  return (
    <main className="mx-auto max-w-[96rem] px-4 py-6 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-muted">b-studio / Agent Fleet</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">같은 요청을 격리된 여러 에이전트에서 비교합니다</h1>
        </div>
        <Link href="/" className="glass-soft rounded-full px-4 py-2 text-sm font-medium hover:bg-panel">
          프로젝트로 돌아가기
        </Link>
      </header>
      <FleetWorkbench projects={projects} models={models} initialFleets={initial} />
    </main>
  );
}
