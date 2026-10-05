/**
 * 도구 막대 화면. preload가 노출한 window.bStudio만 쓴다(여기서 Node·원격 코드를 부르지 않는다).
 */
const api = window.bStudio;
const address = document.getElementById('address');
const status = document.getElementById('status');

/** 주소를 입력하는 동안에는 화면 이동 알림으로 입력창을 덮어쓰지 않는다 */
let editing = false;

function show(text, tone = '') {
  status.textContent = text || '';
  status.hidden = !text;
  status.dataset.tone = tone;
  status.title = text || '';
}

address.addEventListener('focus', () => {
  editing = true;
  address.select();
});
address.addEventListener('blur', () => {
  editing = false;
});
address.addEventListener('keydown', async (event) => {
  if (event.key !== 'Enter') return;
  const result = await api.navigate(address.value);
  if (!result.ok) {
    show(result.reason, 'fail');
    return;
  }
  show(result.external ? '기본 브라우저로 열었습니다' : '');
  address.blur();
});

document.getElementById('back').addEventListener('click', () => void api.back());
document.getElementById('forward').addEventListener('click', () => void api.forward());
document.getElementById('reload').addEventListener('click', () => void api.reload());
document.getElementById('browser').addEventListener('click', () => void api.openExternal());

api.onUrl((url) => {
  if (!editing) address.value = url;
  show('');
});
api.onMessage((text) => show(text));
