import { contextBridge, ipcRenderer } from 'electron';

/**
 * 도구 막대와 앱 사이의 좁은 통로. 여기 있는 것만 할 수 있다.
 * 스튜디오 화면(아래 뷰)에는 preload를 주지 않는다 — 서버가 준 웹 콘텐츠를 신뢰하지 않는다.
 */
const api = {
  /** 입력 한 줄을 정규화해 연다. 열지 못하면 이유를 돌려준다 */
  navigate: (text: string): Promise<{ ok: boolean; reason?: string; external?: boolean }> => ipcRenderer.invoke('b-studio:navigate', text),
  back: (): Promise<void> => ipcRenderer.invoke('b-studio:back'),
  forward: (): Promise<void> => ipcRenderer.invoke('b-studio:forward'),
  reload: (): Promise<void> => ipcRenderer.invoke('b-studio:reload'),
  /** 지금 화면을 기본 브라우저에서 연다 */
  openExternal: (): Promise<void> => ipcRenderer.invoke('b-studio:open-external'),
  /** 현재 주소가 바뀔 때마다 부른다 */
  onUrl: (listener: (url: string) => void): void => {
    ipcRenderer.on('b-studio:url', (_event, url: unknown) => {
      if (typeof url === 'string') listener(url);
    });
  },
  /** 정책이 막았거나 화면을 열지 못했을 때의 한 줄 안내 */
  onMessage: (listener: (text: string) => void): void => {
    ipcRenderer.on('b-studio:message', (_event, text: unknown) => {
      if (typeof text === 'string') listener(text);
    });
  },
};

contextBridge.exposeInMainWorld('bStudio', api);
