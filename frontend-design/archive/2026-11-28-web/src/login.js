const login = document.getElementById('zhihuLogin');
const status = document.getElementById('loginStatus');
const retry = document.getElementById('retryLoginStatus');
const theme = document.getElementById('themeToggle');
const params = new URLSearchParams(location.search);
const reason = params.get('error');
const pairCode = new URLSearchParams(location.hash.slice(1)).get('pair');
if (location.hash) history.replaceState(null, '', location.pathname + location.search);
const pendingPair = /^[A-Za-z0-9_-]{43}$/.test(pairCode ?? '') ? pairCode : null;

// 一次性配对票据只在当前页内存中停留，随表单交给同源宿主，官方授权跳转由宿主生成。
if (pendingPair) {
  login.form.method = 'post';
  login.form.addEventListener('formdata', (event) => event.formData.set('pairCode', pendingPair));
}

function applyTheme(dark) {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  theme.setAttribute('aria-pressed', String(dark));
  theme.setAttribute('aria-label', dark ? '切换到白天模式' : '切换到夜间模式');
  document.querySelector('meta[name="theme-color"]').content = dark ? '#07080f' : '#e9edf2';
}

let savedTheme;
try { savedTheme = localStorage.getItem('quotation-theme'); } catch { /* 仍可在当前页切换。 */ }
applyTheme((params.get('theme') || savedTheme) === 'dark');
theme.addEventListener('click', () => {
  const dark = document.documentElement.dataset.theme !== 'dark';
  applyTheme(dark);
  try { localStorage.setItem('quotation-theme', dark ? 'dark' : 'light'); } catch { /* 仅主题需要保存。 */ }
});

const messages = new Map([
  ['cancelled', '你取消了这次授权。想回来时，再点一次登录就好。'],
  ['expired', '这次登录已过期，请重新从这里前往知乎。'],
  ['not_configured', '上一次登录时，本站的知乎授权还没有配好。现在可以重新试试。'],
  ['provider_error', '知乎登录这次没有完成。过一会儿，可以重新授权。'],
]);

async function checkLogin() {
  login.disabled = true;
  retry.hidden = true;
  status.textContent = '正在确认知乎登录是否可用。';
  try {
    const response = await fetch('/auth/zhihu/status', { cache: 'no-store' });
    if (!response.ok) throw new Error();
    const result = await response.json();
    const state = result.ok && result.data;
    if (typeof state?.configured !== 'boolean' || typeof state.authenticated !== 'boolean') throw new Error();
    if (state.authenticated) {
      location.replace(pendingPair ? '/#pair=' + pendingPair : '/');
      return;
    }
    if (!state.configured) {
      status.textContent = '本站还没有配好知乎官方登录。请联系运行工作台的人，待配置完成后再试。';
      retry.hidden = false;
      return;
    }
    login.disabled = false;
    status.textContent = reason
      ? messages.get(reason) || '这次登录没有完成。你可以重新前往知乎授权。'
      : '接下来会前往知乎官方授权页，确认后回到这里。';
  } catch {
    status.textContent = '暂时连不上本站的登录服务。稍等一下，可以再试。';
    retry.hidden = false;
  }
}

retry.addEventListener('click', checkLogin);
await checkLogin();
