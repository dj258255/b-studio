import { redirect } from "next/navigation";

/**
 * 새로 시작 화면은 없앴다(ADR-070). 다른 프로젝트로 시작하거나 폴더를 열거나 최근 세션·토큰 보고서를 보는 일은
 * 개발 화면 머리의 프로젝트 메뉴로 옮겼다(`components/project-menu.tsx`). 예전 주소로 온 사람은 첫 화면으로 보낸다.
 */
export default function StartPage() {
  redirect("/");
}
