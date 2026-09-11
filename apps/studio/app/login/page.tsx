import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/login-form";
import { authConfig, safeNextPath, SESSION_COOKIE, sessionUser } from "@/lib/server/auth";

export default async function LoginPage(props: PageProps<"/login">) {
  const { next } = await props.searchParams;
  const target = safeNextPath(typeof next === "string" ? next : undefined);
  const config = authConfig();
  if (config.mode === "none") redirect(target);
  if (config.mode === "token" && sessionUser((await cookies()).get(SESSION_COOKIE)?.value, config)) redirect(target);

  return (
    <main className="mx-auto max-w-sm px-6 py-24">
      <p className="text-sm font-semibold text-muted">b-studio</p>
      <h1 className="mt-2 text-2xl font-semibold tracking-tight">로그인</h1>
      {config.mode === "token" ? (
        <>
          <p className="mt-2 text-sm leading-6 text-muted">운영자에게 받은 접근 토큰을 입력하세요.</p>
          <LoginForm next={target} />
        </>
      ) : (
        <p className="mt-2 text-sm leading-6 text-muted">이 스튜디오는 사내 SSO로 로그인합니다. SSO 프록시 주소로 다시 접속하세요.</p>
      )}
    </main>
  );
}
