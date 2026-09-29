import Link from 'next/link';
import { FleetWorkbench } from '@/components/fleet-workbench';
import { pageUser } from '@/lib/server/access';
import { studioCapabilities } from '@/lib/server/capabilities';
import { listFleets } from '@/lib/server/fleets';
import { listModelOptions } from '@/lib/server/model-registry';
import { listProjects } from '@/lib/server/projects';

export default async function FleetsPage() {
  const user = await pageUser();
  const [projects, models] = await Promise.all([listProjects(), Promise.resolve(listModelOptions())]);
  const initial = listFleets(user);
  // 이 서버에서 여러 후보 비교를 쓸 수 있는지(데모만 못 쓴다). 화면이 이유까지 그대로 보여 준다
  const capabilities = studioCapabilities();
  const fleet = { enabled: capabilities.fleet.enabled, ...(capabilities.fleet.reason ? { reason: capabilities.fleet.reason } : {}) };

  return (
    <main className="mx-auto max-w-[96rem] px-4 py-6 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-muted">b-studio / Agent Fleet</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">같은 요청을 격리된 여러 에이전트에서 비교합니다</h1>
        </div>
        <Link href="/" className="glass-soft rounded-control px-4 py-2 text-sm font-medium hover:bg-panel">
          프로젝트로 돌아가기
        </Link>
      </header>
      <FleetWorkbench projects={projects} models={models} initialFleets={initial} fleet={fleet} />
    </main>
  );
}
