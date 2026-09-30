import { contextBridge, ipcRenderer } from 'electron';

/**
 * 스튜디오 화면(서버가 준 웹 콘텐츠)에 주는 단 하나의 좁은 통로(ADR-082).
 *
 * 이전에는 이 화면에 preload를 주지 않았다(신뢰하지 않는 콘텐츠라서). 폴더 선택 창만은 OS 대화상자를
 * 앱(메인 프로세스)이 대신 띄워 줘야 해서(웹 페이지 스스로는 파일 시스템 경로를 고를 방법이 없다) 딱 이 하나만
 * 열었다. `pickFolder`가 하는 일은 메인 프로세스에 대화상자를 띄워 달라고 부탁하고 고른 절대 경로(취소하면
 * undefined)를 돌려받는 것뿐이다 — 읽기·쓰기 같은 다른 기능은 주지 않는다. 메인 프로세스(`main.ts`)도
 * 이 화면(`content`) 자신이 이 PC 주소에서 불렀는지 한 번 더 확인한다(`pick-folder.ts`의 `canPickFolder`).
 */
const api = {
  pickFolder: (): Promise<string | undefined> => ipcRenderer.invoke('b-studio:pick-folder'),
};

contextBridge.exposeInMainWorld('bStudioDesktop', api);
