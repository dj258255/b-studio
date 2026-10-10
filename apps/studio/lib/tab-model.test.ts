import { describe, expect, it } from "vitest";
import {
  buildTopTabs,
  CODE_SUB_TABS,
  defaultSubTab,
  mapLegacyTab,
  readSubTab,
  REPOSITORY_SUB_TABS,
  REQUIREMENTS_SUB_TABS,
  RUN_SUB_TABS,
  runSubTabs,
  screenSubTabs,
  subTabStorageKey,
  writeSubTab,
} from "./tab-model";

/** 테스트용 가짜 Storage. 실패 시나리오는 getItem/setItem을 던지도록 바꿔 만든다 */
function fakeStorage(initial: Record<string, string> = {}): Storage {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
    clear: () => data.clear(),
    key: () => null,
    length: data.size,
  } as Storage;
}

describe("mapLegacyTab", () => {
  it("예전 탭 id를 새 (상위 묶음, 하위 탭)으로 옮긴다", () => {
    expect(mapLegacyTab("design")).toEqual({ group: "screen", subTab: "design" });
    expect(mapLegacyTab("requirements")).toEqual({ group: "requirements", subTab: "spec" });
    expect(mapLegacyTab("tests")).toEqual({ group: "requirements", subTab: "tests" });
    expect(mapLegacyTab("code")).toEqual({ group: "code", subTab: "files" });
    expect(mapLegacyTab("history")).toEqual({ group: "code", subTab: "history" });
    expect(mapLegacyTab("deploy")).toEqual({ group: "run", subTab: "deploy" });
    expect(mapLegacyTab("logs")).toEqual({ group: "run", subTab: "logs" });
    expect(mapLegacyTab("resources")).toEqual({ group: "run", subTab: "resources" });
    expect(mapLegacyTab("repository")).toEqual({ group: "repository", subTab: "issues" });
    expect(mapLegacyTab("submission")).toEqual({ group: "repository", subTab: "presubmit" });
    // 토큰은 실행 묶음의 하위 탭으로 옮겼다(ADR-166)
    expect(mapLegacyTab("tokens")).toEqual({ group: "run", subTab: "tokens" });
  });
});

describe("buildTopTabs", () => {
  it("서비스·사내 API 뒤에 코드·요구사항·실행·저장소 네 고정 탭을 둔다 (ADR-166)", () => {
    const tabs = buildTopTabs([{ name: "api", preview: "openapi" } as never], []);
    expect(tabs.map((tab) => tab.id)).toEqual(["api", "code", "requirements", "run", "repository"]);
    // 문서·현황·토큰은 위 탭이 아니다(요구사항·실행 묶음의 하위 탭)
    expect(REQUIREMENTS_SUB_TABS.map((tab) => tab.id)).toEqual(["spec", "tests", "docs", "status"]);
    expect(RUN_SUB_TABS.map((tab) => tab.id)).toEqual(["logs", "resources", "myenv", "deploy", "tokens"]);
  });

  it("서비스·사내 API가 없어도 고정 탭 순서는 그대로다", () => {
    const tabs = buildTopTabs([], []);
    expect(tabs.map((tab) => tab.id)).toEqual(["code", "requirements", "run", "repository"]);
  });

  it("꺼 둔 서비스와 로그 전용 서비스는 위 탭을 두지 않는다", () => {
    const tabs = buildTopTabs(
      [
        { name: "commerce", preview: "openapi", state: "ready" },
        { name: "web", preview: "browser", state: "ready" },
        { name: "consumer-app", preview: "browser", state: "off" },
        { name: "worker", preview: "logs", state: "ready" },
        { name: "booting", preview: "browser", state: "starting" },
      ] as never,
      [{ name: "users" } as never],
    );
    // 켜 둔 서비스 3 + 사내 API 1 + 고정 4. 뜨는 중인 서비스는 탭을 둔다(곧 화면이 생긴다)
    expect(tabs.map((tab) => tab.id)).toEqual(["commerce", "web", "booting", "external:users", "code", "requirements", "run", "repository"]);
  });

  it("서비스 둘을 켠 프로젝트의 위 탭은 여섯 개다", () => {
    const tabs = buildTopTabs(
      [
        { name: "commerce", preview: "openapi", state: "ready" },
        { name: "web", preview: "browser", state: "ready" },
        { name: "consumer-app", preview: "browser", state: "off" },
      ] as never,
      [],
    );
    expect(tabs).toHaveLength(6);
  });
});

describe("defaultSubTab", () => {
  it("묶음의 첫 하위 탭을 돌려준다", () => {
    expect(defaultSubTab("code")).toBe(CODE_SUB_TABS[0].id);
    expect(defaultSubTab("requirements")).toBe(REQUIREMENTS_SUB_TABS[0].id);
    expect(defaultSubTab("run")).toBe(RUN_SUB_TABS[0].id);
    expect(defaultSubTab("repository")).toBe(REPOSITORY_SUB_TABS[0].id);
  });

  it("options를 주면 그 목록의 첫 번째를 돌려준다", () => {
    expect(defaultSubTab("run", runSubTabs(false))).toBe("logs");
  });
});

describe("runSubTabs", () => {
  it("배포는 deploy 절이 있고 실험 기능을 켰을 때만 보인다 (ADR-166)", () => {
    expect(runSubTabs(true, true).map((tab) => tab.id)).toEqual(["logs", "resources", "myenv", "deploy", "tokens"]);
    // 운영 배포는 실험 기능이다. deploy 절이 있어도 켜지 않았으면 숨긴다
    expect(runSubTabs(true).map((tab) => tab.id)).toEqual(["logs", "resources", "myenv", "tokens"]);
    expect(runSubTabs(true, false).map((tab) => tab.id)).toEqual(["logs", "resources", "myenv", "tokens"]);
  });

  it("deploy 절이 없으면 실험 기능을 켜도 배포 하위 탭을 숨긴다(로컬 폴더 모드 기본값)", () => {
    expect(runSubTabs(false, true).map((tab) => tab.id)).toEqual(["logs", "resources", "myenv", "tokens"]);
    expect(runSubTabs(false).map((tab) => tab.id)).toEqual(["logs", "resources", "myenv", "tokens"]);
  });
});

describe("screenSubTabs", () => {
  it("원격 브라우저와 디자인 비교는 실험 기능을 켰을 때만 보인다 (ADR-166)", () => {
    expect(screenSubTabs().map((tab) => tab.id)).toEqual(["app", "qa"]);
    expect(screenSubTabs(false).map((tab) => tab.id)).toEqual(["app", "qa"]);
    expect(screenSubTabs(true).map((tab) => tab.id)).toEqual(["app", "remote", "qa", "design"]);
  });
});

describe("readSubTab", () => {
  it("storage가 없으면(서버 렌더) 첫 하위 탭을 돌려준다", () => {
    expect(readSubTab(undefined, "code")).toBe("files");
  });

  it("저장된 값이 있고 유효하면 그 값을 돌려준다", () => {
    const storage = fakeStorage({ [subTabStorageKey("code")]: "history" });
    expect(readSubTab(storage, "code")).toBe("history");
  });

  it("저장된 값이 이 묶음의 하위 탭이 아니면(예전 값·다른 묶음 값) 첫 하위 탭으로 돌아간다", () => {
    const storage = fakeStorage({ [subTabStorageKey("code")]: "presubmit" });
    expect(readSubTab(storage, "code")).toBe("files");
  });

  it("읽기가 실패해도(사생활 보호 모드 등) 예외 없이 첫 하위 탭으로 돌아간다", () => {
    const throwing = {
      getItem: () => {
        throw new Error("denied");
      },
    } as unknown as Storage;
    expect(readSubTab(throwing, "run")).toBe("logs");
  });

  it("options를 주면 그 목록 기준으로 검사한다 — 숨겨진 하위 탭(배포)이 저장돼 있으면 첫 하위 탭으로 돌아간다", () => {
    const storage = fakeStorage({ [subTabStorageKey("run")]: "deploy" });
    expect(readSubTab(storage, "run", runSubTabs(false, true))).toBe("logs");
    expect(readSubTab(storage, "run", runSubTabs(true, false))).toBe("logs");
    expect(readSubTab(storage, "run", runSubTabs(true, true))).toBe("deploy");
  });
});

describe("writeSubTab", () => {
  it("묶음별 키로 저장한다", () => {
    const storage = fakeStorage();
    writeSubTab(storage, "repository", "presubmit");
    expect(storage.getItem(subTabStorageKey("repository"))).toBe("presubmit");
  });

  it("저장이 실패해도(사생활 보호 모드 등) 예외를 내지 않는다", () => {
    const throwing = {
      setItem: () => {
        throw new Error("denied");
      },
    } as unknown as Storage;
    expect(() => writeSubTab(throwing, "code", "history")).not.toThrow();
  });
});
