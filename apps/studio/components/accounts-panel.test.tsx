import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { AccountStatus } from "@/lib/server/cli-accounts";
import { AccountCard, AccountsPanel } from "./accounts-panel";

describe("AccountsPanel", () => {
  it("첫 그리기는 불러오는 중을 보여준다(목록은 효과가 돈 뒤에 온다)", () => {
    const html = renderToStaticMarkup(<AccountsPanel />);
    expect(html).toContain("불러오는 중");
  });
});

describe("AccountCard", () => {
  const connected: AccountStatus = { backend: "claude-code", label: "로컬 Claude Agent", connected: true, installed: true, accountKind: "max 구독" };
  const needsLogin: AccountStatus = { backend: "codex", label: "로컬 ChatGPT Agent", connected: false, installed: true, reason: "Codex CLI에 로그인돼 있지 않습니다." };
  const notInstalled: AccountStatus = { backend: "opencode", label: "로컬 OpenCode Agent", connected: false, installed: false, reason: "OpenCode CLI를 찾지 못했습니다." };

  it("연결된 계정은 연결됨과 계정 종류를 보여주고 로그인 버튼은 없다", () => {
    const html = renderToStaticMarkup(<AccountCard initial={connected} onChanged={() => undefined} />);

    expect(html).toContain("연결됨");
    expect(html).toContain("max 구독");
    expect(html).not.toContain(">로그인<");
    expect(html).toContain("다시 확인");
  });

  it("로그인이 안 된 계정은 로그인 필요와 이유, 로그인 버튼을 보여준다", () => {
    const html = renderToStaticMarkup(<AccountCard initial={needsLogin} onChanged={() => undefined} />);

    expect(html).toContain("로그인 필요");
    expect(html).toContain("Codex CLI에 로그인돼 있지 않습니다.");
    expect(html).toContain(">로그인<");
  });

  it("CLI 자체가 없는 계정은 설치 안 됨을 보여주고 로그인 버튼은 없다(설치부터 해야 한다)", () => {
    const html = renderToStaticMarkup(<AccountCard initial={notInstalled} onChanged={() => undefined} />);

    expect(html).toContain("설치 안 됨");
    expect(html).not.toContain(">로그인<");
  });
});
