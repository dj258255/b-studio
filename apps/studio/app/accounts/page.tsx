import Link from 'next/link';
import { AccountsPanel } from '@/components/accounts-panel';
import { pageUser } from '@/lib/server/access';
import { studioCapabilities } from '@/lib/server/capabilities';

/**
 * 계정 연결 화면(ADR-093). 내 폴더에서 바로 작업하기(ADR-067)와 같은 조건(개인 PC 모드)에서만 연다 —
 * "이 서버의 CLI에 로그인"이라는 개념이 여러 사람이 쓰는 서버에서는 안전하지 않다.
 */
export default async function AccountsPage() {
  await pageUser();
  const capabilities = studioCapabilities();

  return (
    <main className="mx-auto max-w-2xl px-4 py-6 sm:px-6 lg:px-8">
      <header className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-muted">b-studio / 계정 연결</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">구독 CLI 계정 연결</h1>
        </div>
        <Link href="/" className="glass-soft rounded-control px-4 py-2 text-sm font-medium hover:bg-panel">
          개발 화면으로
        </Link>
      </header>
      {capabilities.openFolder ? (
        <AccountsPanel />
      ) : (
        <p className="glass rounded-panel px-5 py-4 text-sm text-muted">
          계정 연결은 개인 PC 모드(로컬 CLI)에서만 씁니다. 지금 이 서버는 다른 모드로 돌고 있습니다.
        </p>
      )}
    </main>
  );
}
