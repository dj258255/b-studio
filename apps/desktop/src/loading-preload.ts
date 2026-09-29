import { contextBridge, ipcRenderer } from 'electron';

/**
 * 로딩·안내 화면의 좁은 통로. 서버가 뜨는 동안의 진행 문구를 받고, 실패하면 로그 폴더를 연다.
 */
const api = {
  onStatus: (listener: (status: { type: string; message?: string }) => void): void => {
    ipcRenderer.on('b-studio:launch', (_event, status: unknown) => {
      if (status && typeof status === 'object') listener(status as { type: string; message?: string });
    });
  },
  /** `~/.cache/b-studio/launch` — CLI가 남긴 기동 로그 */
  openLogs: (): Promise<void> => ipcRenderer.invoke('b-studio:open-logs'),
};

contextBridge.exposeInMainWorld('bStudioLaunch', api);
