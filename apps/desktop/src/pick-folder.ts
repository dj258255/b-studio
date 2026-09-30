import { isLocalHost } from './url-policy';

/**
 * 폴더 선택 대화상자(`b-studio:pick-folder`, ADR-085)를 부를 수 있는 보낸이인지 확인하는 순수 함수.
 *
 * 스튜디오 화면(서버가 준 웹 콘텐츠)에만 좁은 preload로 `pickFolder`를 노출하지만, 도구 막대·로딩 화면도
 * 같은 프로세스 안의 WebContentsView라 원칙적으로 같은 IPC 채널에 말을 걸 수 있다. 그래서 ipcMain.handle 안에서
 * ① 보낸이가 지금 띄운 스튜디오 화면(content) 그 자신인지(다른 뷰가 아닌지), ② 그 화면의 주소가 이 PC의
 * 루프백(127.0.0.1·localhost)인지 두 가지를 모두 확인한다. 서버가 준 화면이 외부 사이트로 옮겨간 뒤에는
 * (예: 링크를 눌러 나갔다가 뒤로 왔더라도 주소가 바뀐 순간) 통과하지 못한다.
 */
export function canPickFolder(input: { senderId: number; senderUrl: string; contentId: number | undefined }): boolean {
  if (input.contentId === undefined || input.senderId !== input.contentId) return false;
  try {
    return isLocalHost(new URL(input.senderUrl).hostname);
  } catch {
    return false;
  }
}
