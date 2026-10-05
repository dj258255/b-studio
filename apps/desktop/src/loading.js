/**
 * 로딩·안내 화면. preload가 노출한 window.bStudioLaunch만 쓴다.
 * 진행 문구는 CLI의 stderr를 그대로 보여 준다(무엇을 기다리는지 알 수 있게).
 */
const api = window.bStudioLaunch;
const state = document.getElementById('state');
const stateText = document.getElementById('state-text');
const log = document.getElementById('log');

/** 진행 문구를 모아 두는 줄 수 상한(콜리마 기동 로그가 길다) */
const MAX_LINES = 200;
const lines = [];

function render() {
  log.hidden = lines.length === 0;
  log.textContent = lines.join('\n');
  log.scrollTop = log.scrollHeight;
}

api.onStatus((status) => {
  if (status.type === 'progress' && status.message) {
    for (const line of String(status.message).split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      lines.push(trimmed);
    }
    // 오래된 줄은 버린다
    if (lines.length > MAX_LINES) lines.splice(0, lines.length - MAX_LINES);
    render();
    return;
  }
  if (status.type === 'failed') {
    state.dataset.tone = 'fail';
    stateText.textContent = '서버를 켜지 못했습니다';
    if (status.message) {
      lines.push('');
      lines.push(...String(status.message).split('\n').map((line) => line.trim()).filter(Boolean));
      render();
    }
  }
});

document.getElementById('logs').addEventListener('click', () => void api.openLogs());
