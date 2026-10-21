import { describe, expect, it, vi } from "vitest";
import { discardRequirementsDraft, saveRequirementsDraft } from "./requirements-draft-client";

describe("요구사항 초안 저장·버리기 요청", () => {
  it("저장은 응답이 성공일 때만 참이다. 실패 응답과 끊긴 요청은 거짓이다(조용히 넘기지 않는다)", async () => {
    const ok = vi.fn(async () => new Response(null, { status: 200 }));
    expect(await saveRequirementsDraft("s1", { notes: "x" }, ok)).toBe(true);
    expect(ok).toHaveBeenCalledWith("/api/sessions/s1/requirements/draft", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ notes: "x" }) }));
    expect(await saveRequirementsDraft("s1", { notes: "x" }, async () => new Response(null, { status: 409 }))).toBe(false);
    expect(await saveRequirementsDraft("s1", { notes: "x" }, async () => Promise.reject(new TypeError("network")))).toBe(false);
  });

  it("버리기도 같다", async () => {
    expect(await discardRequirementsDraft("s1", async () => new Response(null, { status: 204 }))).toBe(true);
    expect(await discardRequirementsDraft("s1", async () => new Response(null, { status: 500 }))).toBe(false);
    expect(await discardRequirementsDraft("s1", async () => Promise.reject(new TypeError("network")))).toBe(false);
  });
});
