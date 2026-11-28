// 独立数据工作台页面控制器（支持浏览器内知乎官方 OAuth 授权 + 工作台页面内扫码登录 + 实时多智能体管线）
const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const toggle = $('themeToggle');
const toastEl = $('toast');

let toastTimer = null;
let qrPollTimer = null;
let state = { status: null, profile: null, planetsDb: { records: [] } };

function toast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('on'), 3500);
}

async function api(url, { method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------- 主题切换 ----------
function syncTheme() {
  const dark = root.dataset.theme === 'dark';
  toggle.setAttribute('aria-pressed', String(dark));
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', dark ? '#07080f' : '#e9edf2');
}
toggle.addEventListener('click', () => {
  const next = root.dataset.theme === 'dark' ? 'light' : 'dark';
  root.dataset.theme = next;
  try {
    localStorage.setItem('quotation-theme', next);
  } catch {
    // ignore
  }
  syncTheme();
});
syncTheme();

// ---------- 渲染状态 ----------
function renderStatus() {
  const s = state.status;
  if (!s) return;

  const planetTotal = s.counts?.starMapPlanets ?? 0;
  $('heroPlanetCount').textContent = String(planetTotal);
  $('tabPlanetCount').textContent = String(s.counts?.planetsDbTotal ?? 0);

  // 1. 知乎官方 OAuth 状态
  const oauth = s.oauth || {};
  const oauthChip = $('oauthStatusChip');
  const btnOAuthLogin = $('btnOAuthLogin');
  const btnSyncOAuth = $('btnSyncOAuth');
  const btnOAuthLogout = $('btnOAuthLogout');
  const oauthNote = $('oauthAccountNote');

  if (!oauth.configured) {
    oauthChip.textContent = '未配置凭据';
    oauthChip.className = 'status-chip warn';
    btnOAuthLogin.setAttribute('aria-disabled', 'true');
    btnSyncOAuth.disabled = true;
    btnOAuthLogout.hidden = true;
    oauthNote.textContent = '未检测到 ZHIHU_OAUTH_APP_ID / ZHIHU_OAUTH_APP_KEY，请检查根目录 .env 配置。';
  } else if (oauth.authenticated) {
    oauthChip.textContent = `已授权 · ${oauth.account?.nickname || '知乎账号'}`;
    oauthChip.className = 'status-chip ok';
    btnOAuthLogin.textContent = '重新授权知乎账号';
    btnSyncOAuth.disabled = false;
    btnOAuthLogout.hidden = false;
    oauthNote.textContent = `当前官方授权身份：${oauth.account?.nickname || '知乎用户'}（${oauth.account?.accountId || ''}），回调地址：${oauth.redirectUri}`;
  } else {
    oauthChip.textContent = '就绪 · 可直接授权';
    oauthChip.className = 'status-chip';
    btnOAuthLogin.textContent = '在浏览器打开知乎官方授权';
    btnSyncOAuth.disabled = true;
    btnOAuthLogout.hidden = true;
    oauthNote.textContent = `官方授权回调已就绪（${oauth.redirectUri}）。点击按钮将前往知乎官方授权页并自动跳回本工作台。`;
  }

  // 2. 浏览历史扫码登录状态
  const col = s.collection || {};
  const qrChip = $('qrStatusChip');
  if (col.loggedIn) {
    qrChip.textContent = `已登录 · ${col.account?.nickname || '知乎'}`;
    qrChip.className = 'status-chip ok';
    stopQrPoll();
    $('qrStage').innerHTML = `<p class="muted-note" style="color:#2f8f66">已登录知乎账号：<strong>${escapeHtml(
      col.account?.nickname || '已认证',
    )}</strong>，现在可以点击下方「同步浏览历史并生成星图」。</p>`;
  } else if (col.waitingLogin) {
    qrChip.textContent = '等待扫码确认...';
    qrChip.className = 'status-chip warn';
  } else {
    qrChip.textContent = '未登录';
    qrChip.className = 'status-chip';
  }

  // 3. 采集选项与统计
  $('optHistory').checked = Boolean(col.settings?.history);
  $('optLikes').checked = Boolean(col.settings?.likes);
  $('optCollections').checked = Boolean(col.settings?.collections);
  $('optFilter').checked = col.settings?.knowledgeFilter !== false;
  $('collectStatusChip').textContent = col.syncing ? `采集中 (${col.fetched})` : '就绪';
  $('statUserCount').textContent = `${col.totalRecords ?? 0} 条`;

  if (col.syncStats) {
    $('statDuration').textContent = `${(col.syncStats.durationMs / 1000).toFixed(2)}s`;
    $('statMode').textContent = col.syncStats.mode === 'initial' ? '初次采集' : '增量同步';
    $('statBudget').textContent = col.syncStats.withinBudget
      ? `达标 (≤${col.syncStats.budgetMs / 1000}s)`
      : `超出 (${col.syncStats.budgetMs / 1000}s)`;
  }

  // 4. 模型状态
  const llmChip = $('llmStatusChip');
  if (s.model?.ready) {
    llmChip.textContent = `模型就绪 · ${s.model.modelName}`;
    llmChip.className = 'status-chip ok';
  } else {
    llmChip.textContent = '模型未配置（规则兜底）';
    llmChip.className = 'status-chip warn';
  }
  if ($('inBaseUrl') && !$('inBaseUrl').value) $('inBaseUrl').value = s.model?.baseURL || '';
  if ($('inModelName') && !$('inModelName').value) $('inModelName').value = s.model?.modelName || '';

  // 5. 四大 Agent 管线状态与日志
  const p = s.pipeline || {};
  const mapText = { idle: '待命', running: '运行中...', watching: '实时监听中', error: '异常' };
  const setPipe = (id, status) => {
    const el = $(id);
    el.textContent = mapText[status] || status || '待命';
    el.className = `pipe-state ${status === 'watching' ? 'active' : status}`;
  };
  setPipe('pipeCollect', p.collection?.status || 'idle');
  setPipe('pipeProfile', p.profile?.status || 'idle');
  setPipe('pipeConverter', p.converter?.status || 'idle');
  setPipe('pipeWriter', p.starWriter?.status || 'watching');

  if (Array.isArray(s.logs) && s.logs.length) {
    $('pipelineLogBox').innerHTML = s.logs
      .slice(0, 14)
      .map(
        (item) =>
          `<p class="log-entry"><strong>[${escapeHtml(item.actor)}]</strong>${escapeHtml(item.message)}</p>`,
      )
      .join('');
  }
}

function renderProfile() {
  const box = $('profileContent');
  const p = state.profile;
  if (!p) {
    box.innerHTML = '<p class="muted-note">尚未生成画像。完成一次采集后画像 Agent 会自动生成并保存。</p>';
    return;
  }
  const domainsHtml = (p.domains || [])
    .map((d) => {
      const pct = d.share == null ? 0 : Math.round(d.share * 100);
      return `<div><div class="domain-bar-head"><span>${escapeHtml(d.name)}</span><strong>${pct}%</strong></div><div class="domain-bar-track"><div class="domain-bar-fill" style="width:${pct}%"></div></div></div>`;
    })
    .join('');
  const topicsHtml = (p.topics || []).map((t) => `<span class="topic-tag">${escapeHtml(t)}</span>`).join('');
  box.innerHTML = `
    <p class="profile-summary">${escapeHtml(p.summary || '')}</p>
    <div class="domain-bar-list">${domainsHtml}</div>
    <div class="tag-wrap">${topicsHtml}</div>
    <p class="muted-note" style="margin-top:10px">更新于 ${new Date(p.generatedAt).toLocaleString()} · 驱动：${escapeHtml(p.model || 'local')}</p>
  `;
}

function renderPlanets() {
  const records = state.planetsDb?.records || [];
  const box = $('planetsListBox');
  if (!records.length) {
    box.innerHTML = '<p class="muted-note">星球数据库暂无记录。</p>';
    return;
  }
  box.innerHTML = '';
  for (const rec of [...records].reverse()) {
    const row = document.createElement('div');
    row.className = 'planet-row';
    const sourcesHtml = (rec.sources || []).length
      ? `<p class="planet-row-source">出处：${rec.sources
          .map((s) =>
            s.url
              ? `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.title || s.key)}</a>`
              : escapeHtml(s.title || s.key),
          )
          .join('；')}</p>`
      : '';
    row.innerHTML = `
      <div class="planet-row-top">
        <span class="planet-row-id">${escapeHtml(rec.id)} · ${escapeHtml(rec.domain)}</span>
        <span class="status-chip ${rec.status === 'placed' ? 'ok' : 'warn'}">权重 ${rec.weight} · ${rec.status === 'placed' ? '已入星图' : '待写入'}</span>
      </div>
      <div class="planet-row-title">${escapeHtml(rec.knowledgePoint)}</div>
      <p class="planet-row-summary">${escapeHtml(rec.summary)}</p>
      ${sourcesHtml}
    `;
    box.appendChild(row);
  }
}

async function refreshAll() {
  const [status, profileRes, planetsDb] = await Promise.all([
    api('/api/status'),
    api('/api/profile'),
    api('/api/planets'),
  ]);
  state.status = status;
  state.profile = profileRes.profile;
  state.planetsDb = planetsDb;
  renderStatus();
  renderProfile();
  renderPlanets();
}

// ---------- 页面内知乎二维码扫码轮询 ----------
function stopQrPoll() {
  if (qrPollTimer) {
    clearInterval(qrPollTimer);
    qrPollTimer = null;
  }
}

function renderQrImage(qrDataUrl) {
  const stage = $('qrStage');
  if (!qrDataUrl) return;
  stage.innerHTML = `
    <img src="${qrDataUrl}" alt="知乎登录二维码">
    <p class="muted-note">请使用手机知乎 App 扫码并在手机上点击确认登录（二维码自动刷新中）</p>
  `;
}

async function startInPageQrLogin() {
  const btn = $('btnStartQr');
  btn.disabled = true;
  $('qrStage').innerHTML = '<p class="muted-note">正在连接知乎登录页提取实时二维码，请稍候 2-3 秒...</p>';
  try {
    const res = await api('/api/collection/qr-login', { method: 'POST' });
    if (res.loggedIn) {
      toast(`已检测到知乎登录态（${res.account?.nickname || '已认证'}）`);
      await refreshAll();
      return;
    }
    if (res.qrDataUrl) {
      renderQrImage(res.qrDataUrl);
    } else {
      $('qrStage').innerHTML = '<p class="muted-note">未能直接截取二维码，正在重试或可尝试点击右侧按钮。</p>';
    }
    stopQrPoll();
    qrPollTimer = setInterval(async () => {
      try {
        const snap = await api('/api/collection/qr-state');
        if (snap.loggedIn) {
          stopQrPoll();
          toast(`知乎扫码登录成功（${snap.account?.nickname || '已认证'}）！`);
          await refreshAll();
          return;
        }
        if (snap.qrDataUrl) renderQrImage(snap.qrDataUrl);
      } catch {
        // ignore transient poll error
      }
    }, 2200);
    await refreshAll();
  } catch (err) {
    $('qrStage').innerHTML = `<p class="muted-note" style="color:var(--danger)">${escapeHtml(err.message)}</p>`;
    toast(err.message);
  } finally {
    btn.disabled = false;
  }
}

// ---------- SSE ----------
function connectSse() {
  const es = new EventSource('/api/events');
  es.addEventListener('collection.logged_in', async (ev) => {
    const acc = JSON.parse(ev.data);
    stopQrPoll();
    toast(`知乎登录成功（${acc?.nickname || '已认证'}），现在可以点击同步生成星图`);
    await refreshAll();
  });
  es.addEventListener('oauth.authenticated', async (ev) => {
    const acc = JSON.parse(ev.data);
    toast(`知乎官方授权登录成功（${acc?.nickname || '已认证'}）`);
    await refreshAll();
  });
  es.addEventListener('starmap.updated', async (ev) => {
    const payload = JSON.parse(ev.data);
    if (payload.stats?.placedCount > 0) {
      toast(`星图写入 Agent 已实时落位 ${payload.stats.placedCount} 颗新星球！`);
    }
    await refreshAll();
  });
  es.addEventListener('profile.updated', async () => {
    await refreshAll();
  });
  es.addEventListener('pipeline.log', async () => {
    const s = await api('/api/status');
    state.status = s;
    renderStatus();
  });
}

// ---------- 事件绑定 ----------
function bindEvents() {
  document.querySelectorAll('[data-wtab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.wtab;
      document.querySelectorAll('[data-wtab]').forEach((b) => b.classList.toggle('active', b.dataset.wtab === target));
      document.querySelectorAll('[data-wpane]').forEach((p) => p.classList.toggle('active', p.dataset.wpane === target));
    });
  });

  $('btnStartQr').addEventListener('click', startInPageQrLogin);
  $('btnOpenDesktopWin').addEventListener('click', async () => {
    try {
      await api('/api/collection/login', { method: 'POST' });
      toast('已请求打开独立 Edge 窗口（若通过 start.cmd 启动将在前台弹出）');
      await refreshAll();
    } catch (err) {
      toast(err.message);
    }
  });

  $('btnOAuthLogout').addEventListener('click', async () => {
    await api('/auth/zhihu/logout', { method: 'POST' });
    toast('已退出官方 OAuth 授权会话');
    await refreshAll();
  });

  $('btnSyncOAuth').addEventListener('click', async () => {
    const btn = $('btnSyncOAuth');
    btn.disabled = true;
    try {
      toast('正在通过知乎官方接口同步创作与收藏，并触发三大 Agent...');
      await api('/api/collection/sync-oauth', { method: 'POST' });
      await refreshAll();
      toast('同步与星图构建完成！点击右上角「直接看 3D 星图」查看');
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  const saveOpts = async () => {
    try {
      await api('/api/collection/settings', {
        method: 'POST',
        body: {
          history: $('optHistory').checked,
          likes: $('optLikes').checked,
          collections: $('optCollections').checked,
          knowledgeFilter: $('optFilter').checked,
        },
      });
    } catch (err) {
      toast(err.message);
    }
  };
  ['optHistory', 'optLikes', 'optCollections', 'optFilter'].forEach((id) => $(id).addEventListener('change', saveOpts));

  $('btnSyncReal').addEventListener('click', async () => {
    const btn = $('btnSyncReal');
    btn.disabled = true;
    try {
      toast('正在高速采集知乎浏览历史（初次 ≤ 15s / 增量 ≤ 10s）...');
      await api('/api/collection/sync', { method: 'POST' });
      await refreshAll();
      toast('全部完成！点击「进入 3D 星图」探索你的知识星系');
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  $('btnSyncDemo').addEventListener('click', async () => {
    const btn = $('btnSyncDemo');
    btn.disabled = true;
    try {
      toast('开始演示同步，即将串联画像、数据转换与星图写入 Agent...');
      await api('/api/collection/sync-demo', { method: 'POST' });
      await refreshAll();
    } catch (err) {
      toast(err.message);
    } finally {
      btn.disabled = false;
    }
  });

  $('btnRefreshProfile').addEventListener('click', async () => {
    try {
      toast('画像 Agent 正在重新分析用户数据库...');
      await api('/api/profile/refresh', { method: 'POST' });
      await refreshAll();
    } catch (err) {
      toast(err.message);
    }
  });

  $('addPlanetForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/planets', {
        method: 'POST',
        body: {
          domain: $('inDomain').value.trim(),
          weight: Number($('inWeight').value),
          knowledgePoint: $('inKnowledgePoint').value.trim(),
          summary: $('inSummary').value.trim(),
        },
      });
      $('addPlanetForm').reset();
      $('inWeight').value = '82';
      await refreshAll();
    } catch (err) {
      toast(err.message);
    }
  });

  $('btnRebuildMap').addEventListener('click', async () => {
    toast('正在重建整个 3D 星图...');
    await api('/api/starmap/rebuild', { method: 'POST' });
    await refreshAll();
  });

  $('btnResetAll').addEventListener('click', async () => {
    await api('/api/reset', { method: 'POST' });
    toast('已清空所有本地数据');
    await refreshAll();
  });

  $('llmSettingsForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/api/settings', {
        method: 'POST',
        body: {
          baseURL: $('inBaseUrl').value.trim(),
          modelName: $('inModelName').value.trim(),
          apiKey: $('inApiKey').value.trim(),
        },
      });
      $('inApiKey').value = '';
      await refreshAll();
      toast('大模型配置已安全保存');
    } catch (err) {
      toast(err.message);
    }
  });
}

// 检查 OAuth 回调提示参数
const qs = new URLSearchParams(location.search);
if (qs.get('oauth') === 'ok') {
  toast('知乎官方 OAuth 授权登录成功！');
  history.replaceState(null, '', '/workbench');
} else if (qs.get('oauth_error')) {
  const map = {
    cancelled: '你取消了知乎授权，随时可再次点击登录。',
    expired: '本次授权已过期，请重新点击知乎官方授权。',
    not_configured: '未配置知乎 OAuth 凭据。',
    provider_error: '知乎官方授权验证失败，请稍后重试。',
  };
  toast(map[qs.get('oauth_error')] || '知乎授权未完成，请重试。');
  history.replaceState(null, '', '/workbench');
}

bindEvents();
connectSse();
refreshAll()
  .then(() => {
    // 若后端已处于等待扫码状态，打开工作台即自动拉取并展示实时二维码
    if (state.status?.collection?.waitingLogin && !state.status?.collection?.loggedIn) {
      startInPageQrLogin();
    }
  })
  .catch((err) => toast(err.message));
