import { createApiClient } from '/client.mjs';

const $ = (selector) => document.querySelector(selector);
const client = createApiClient({ baseUrl: location.origin, localUi: true });
const kinds = ['history', 'likes', 'collections'];
const labels = { history: '浏览', likes: '点赞', collections: '收藏', answer: '回答', article: '文章', pin: '想法' };
let context = null, page = null, loadingPage = false, refreshing = false, busy = false, settingsTouched = false, planTouched = false;
let syncController = null, nextSyncAt = null, currentReader = null, stopped = false, toastTimer;
const count = (value) => value == null ? '—' : new Intl.NumberFormat('zh-CN').format(value);
const date = (value) => value ? new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '尚未同步';
const selectedSettings = () => ({ ...Object.fromEntries(kinds.map((key) => [key, $(`[name="${key}"]`).checked])), knowledgeFilter: $('[name="knowledgeFilter"]').checked, fetchFullText: $('[name="fetchFullText"]').checked, aiReview: false });
const selectedPlan = () => ({ mode: $('[name="mode"]:checked').value, intervalMinutes: Number($('#interval').value) });
const same = (left, right) => Object.keys(left).every((key) => left[key] === right?.[key]);
const dirty = () => context && !same(selectedSettings(), context.state.settings);
const planDirty = () => context && !same(selectedPlan(), context.syncPlan);
const connected = () => Boolean(context?.local.consented && context.local.bound);
const activeJob = () => context?.state.activeJob;
function show(message, error = false) {
  clearTimeout(toastTimer); $('#toast').textContent = message; $('#toast').className = `toast${error ? ' error' : ''}`; $('#toast').hidden = false;
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, error ? 7000 : 4000);
}
function fillSettings(settings) { for (const key of [...kinds, 'knowledgeFilter', 'fetchFullText']) $(`[name="${key}"]`).checked = Boolean(settings[key]); }
function fillPlan(plan) { $(`[name="mode"][value="${plan.mode}"]`).checked = true; if (!Array.from($('#interval').options).some((option) => Number(option.value) === plan.intervalMinutes)) $('#interval').add(new Option(`每 ${plan.intervalMinutes} 分钟`, String(plan.intervalMinutes))); $('#interval').value = String(plan.intervalMinutes); }
function render() {
  if (!context) return;
  const { state, local, readers } = context, loggedIn = connected(), loggingIn = local.operation === 'login';
  $('#mode-badge').textContent = state.demo ? '合成演示 · 本机模式' : '本机模式';
  $('#account-name').textContent = local.nickname || '尚未连接知乎';
  $('#account-state').textContent = loggingIn ? '等待登录' : loggedIn ? '已连接' : local.bound ? '已撤回同意' : '未登录';
  $('#account-state').className = `badge ${loggedIn ? 'success' : 'muted'}`;
  $('#account-description').textContent = loggingIn ? '请在弹出的知乎窗口完成登录，成功后会自动返回。' : loggedIn ? `${state.demo ? '演示账号' : '当前账号'}已连接，登录会话保存在当前设备。` : local.bound ? '采集同意已撤回，可重新登录并确认范围。' : '在专用窗口完成登录，选择你的采集范围。';
  $('#login').textContent = loggedIn ? '重新登录' : '登录知乎'; $('#login').disabled = busy || loggingIn || Boolean(activeJob());
  $('#revoke').hidden = !loggedIn; $('#revoke').disabled = busy;
  $('#cancel-login').hidden = !loggingIn;
  const latest = state.latestSnapshot?.snapshotId, matching = Boolean(page && latest && page.snapshotId === latest);
  $('#record-count').textContent = latest ? matching ? count(page.page.total) : '—' : '0';
  $('#nav-count').textContent = latest && matching ? count(page.page.total) : '0';
  const counts = matching ? page.metadata.counts : { history: 0, likes: 0, collections: 0 };
  $('#source-counts').textContent = kinds.map((key) => `${labels[key]} ${count(counts[key])}`).join(' · ');
  $('#last-sync').textContent = date(state.latestSnapshot?.receivedAt);
  $('#sync-state').textContent = activeJob() ? activeJob().state === 'queued' ? '已排队，等待本机采集器' : '正在获取所选内容' : loggedIn ? '采集器就绪，等待你的操作' : '选择范围并登录后，即可开始';
  $('#reader-count').textContent = readers.length ? `${readers.length} 个只读入口` : '尚未开启';
  const syncing = busy || Boolean(activeJob());
  for (const input of document.querySelectorAll('#settings-form input')) input.disabled = syncing || loggingIn;
  $('.sync-trigger').disabled = !loggedIn || syncing || loggingIn || Boolean(dirty());
  $('#save-settings').disabled = !loggedIn || busy || Boolean(activeJob()) || loggingIn || !$('#consent').checked;
  $('#save-plan').disabled = busy || loggingIn || Boolean(activeJob());
  $('#settings-hint').textContent = !loggedIn ? '先确认采集同意，再登录知乎' : dirty() ? '范围已更改，请确认并保存' : '当前采集范围已保存';
  $('#task-status').hidden = !syncing && !loggingIn;
  $('#task-label').textContent = loggingIn ? '等待本人完成登录' : activeJob()?.state === 'queued' ? '等待采集器领取任务' : '正在同步所选内容';
  $('#task-note').textContent = loggingIn ? '账号和验证码只在知乎页面输入，本页无需输入密码。' : '完成后会更新采集记录，请保持页面打开。';
  $('#stop-sync').hidden = loggingIn; $('#stop-sync').disabled = false;
  $('#export-json').disabled = !latest; $('#copy-data').disabled = !latest; $('#clear-data').disabled = busy || loggingIn;
  $('#create-reader').disabled = busy;
  renderReaders(); renderSchedule();
}
function renderReaders() {
  const list = $('#reader-list'); list.replaceChildren();
  for (const reader of context.readers) {
    const row = document.createElement('div'); row.className = 'reader-row';
    const info = document.createElement('div'); const name = document.createElement('span'); name.textContent = reader.label;
    const meta = document.createElement('small'); meta.textContent = `只读 · 创建于 ${date(reader.createdAt)}`; info.append(name, meta);
    const revoke = document.createElement('button'); revoke.className = 'text-button danger'; revoke.textContent = '撤销入口';
    revoke.addEventListener('click', async () => { if (!await confirmAction('撤销这个 Agent 入口？', '对应凭证会立即失效，已经采集的数据保留。')) return; await action(async () => { await client.request(`/v1/readers/${reader.readerId}`, { method: 'DELETE' }); if (currentReader?.readerId === reader.readerId) { currentReader = null; $('#reader-created').hidden = true; } await refresh(); show('只读入口已撤销'); }); });
    row.append(info, revoke); list.append(row);
  }
}
async function refresh() {
  if (refreshing || stopped) return; refreshing = true;
  try {
    const next = await client.request('/v1/ui/context'); const first = !context; context = next;
    $('#fatal').hidden = true;
    if (first || !settingsTouched) { fillSettings(next.state.settings); $('#consent').checked = Boolean(next.local.consented); }
    if (first || !planTouched) fillPlan(next.syncPlan);
    render();
    if (!loadingPage && next.state.latestSnapshot && page?.snapshotId !== next.state.latestSnapshot.snapshotId) await loadPage(0, next.state.latestSnapshot.snapshotId);
  } catch (error) {
    if (!context) { $('#fatal').hidden = false; $('#fatal').textContent = '当前页面没有连接到本机操作服务。请在本模块运行 npm run desktop，或 npm run demo 查看合成演示。'; $('.sync-trigger').disabled = true; }
  } finally { refreshing = false; }
}
function validConsent() {
  const settings = selectedSettings();
  if (!kinds.some((key) => settings[key])) throw new Error('请至少选择一种采集信息。');
  if (!$('#consent').checked) throw new Error('请先勾选采集同意，再继续操作。');
  return { consent: true, settings };
}
async function action(callback) {
  try { return await callback(); } catch (error) { if (!stopped) show(error.message || '操作失败，请重试。', true); }
}
async function startSync(automatic = false) {
  if (busy || stopped || activeJob()) return;
  if (!connected()) throw new Error('请先登录知乎并确认采集同意。');
  if (dirty()) throw new Error('采集范围已更改，请先保存设置。');
  busy = true; syncController = new AbortController(); render();
  try {
    await client.sync({ timeoutMs: 900_000, signal: syncController.signal });
    // 自动同步静默完成：只刷新数据与状态行，不打断用户当前操作。
    await loadPage(0); await refresh(); if (!automatic) show('同步完成，数据已保存');
  } catch (error) { if (syncController?.signal.aborted) { if (!stopped) show('同步已停止，保留上次成功结果'); } else throw error; }
  finally { busy = false; syncController = null; nextSyncAt = context?.syncPlan.mode === 'page_interval' ? Date.now() + context.syncPlan.intervalMinutes * 60_000 : null; await refresh(); render(); }
}
async function loadPage(offset = 0, snapshotId) {
  loadingPage = true;
  try {
    page = await client.readPage({ ...(snapshotId ? { snapshotId } : {}), offset, limit: 10, summaryMaxChars: 300 }); renderRecords(); render();
  } catch (error) { if (error.code === 'NOT_FOUND') { page = null; renderRecords(); } else throw error; }
  finally { loadingPage = false; }
}
function renderRecords() {
  const hasRecords = Boolean(page?.page.total); $('#records-empty').hidden = hasRecords; $('#records-table').hidden = !hasRecords; $('#pagination').hidden = !hasRecords;
  $('#table-count').textContent = count(page?.page.total || 0); const body = $('#records-body'); body.replaceChildren();
  for (const item of page?.items || []) {
    const row = document.createElement('tr'); const content = document.createElement('td'); const link = document.createElement('a'); link.className = 'record-title'; link.textContent = item.title || '未命名内容';
    try { const url = new URL(item.url); if (url.protocol === 'https:' && (url.hostname === 'zhihu.com' || url.hostname.endsWith('.zhihu.com'))) { link.href = url.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; } } catch {}
    const summary = document.createElement('div'); summary.className = 'record-summary'; summary.textContent = item.summary || '平台未提供摘要';
    const tags = document.createElement('div'); tags.className = 'record-tags';
    for (const text of [labels[item.contentType] || item.contentType, ...(item.topics || []).slice(0, 3).map((topic) => topic.name)]) { const tag = document.createElement('span'); tag.className = 'record-tag'; tag.textContent = text; tags.append(tag); }
    content.append(link, summary, tags); const sources = document.createElement('td');
    for (const kind of item.kinds) { const tag = document.createElement('span'); tag.className = 'source-tag'; tag.textContent = labels[kind]; sources.append(tag); }
    const metrics = document.createElement('td'); metrics.append(document.createTextNode(`赞 ${count(item.voteCount)}`), document.createElement('br'), document.createTextNode(`评论 ${count(item.commentCount)}`));
    const weight = document.createElement('td'); weight.className = 'weight-value'; weight.textContent = typeof item.weight === 'number' ? item.weight.toFixed(2) : '—'; row.append(content, sources, metrics, weight); body.append(row);
  }
  if (hasRecords) { $('#page-info').textContent = `第 ${page.page.offset + 1}–${page.page.offset + page.page.returned} 条，共 ${page.page.total} 条`; $('#previous-page').disabled = page.page.offset === 0; $('#next-page').disabled = !page.page.hasMore; }
}
function renderSchedule() {
  if (!context) return;
  if (context.syncPlan.mode === 'manual') { nextSyncAt = null; $('#schedule-state').textContent = planDirty() ? '同步方式已更改，保存后生效' : '当前为手动同步'; return; }
  if (!connected() || dirty() || planDirty()) { nextSyncAt = null; $('#schedule-state').textContent = !connected() ? '登录并确认同意后，定时同步才会生效' : '设置有未保存的更改，定时同步已暂停'; return; }
  if (!nextSyncAt) nextSyncAt = Date.now() + context.syncPlan.intervalMinutes * 60_000;
  $('#schedule-state').textContent = busy || activeJob() ? '本次同步进行中，完成后重新计时' : `页面内运行 · 下次同步约在 ${new Date(nextSyncAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}`;
}
// 浏览器可能拒绝剪贴板权限；此时回退到选中复制，仍由用户手势触发，不降低数据交付要求。
function legacyCopy(text) {
  const area = document.createElement('textarea'); area.value = text; area.setAttribute('readonly', '');
  area.className = 'offscreen'; document.body.append(area);
  const selection = document.getSelection(), previous = selection.rangeCount ? selection.getRangeAt(0) : null;
  area.select(); area.setSelectionRange(0, text.length);
  let copied = false;
  try { copied = document.execCommand('copy'); } catch { copied = false; }
  area.remove(); if (previous) { selection.removeAllRanges(); selection.addRange(previous); }
  return copied;
}
async function copy(text) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('NO_CLIPBOARD_API');
    await navigator.clipboard.writeText(text); return;
  } catch (error) {
    if (legacyCopy(text)) return;
    throw new Error('当前浏览器拒绝了剪贴板写入，请改用导出 JSON，或在页面地址栏的站点权限中允许剪贴板。');
  }
}
function download(value) { const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = `collection-${new Date().toISOString().slice(0, 10)}.json`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
async function confirmAction(title, description) { const dialog = $('#confirm-dialog'); $('#confirm-title').textContent = title; $('#confirm-description').textContent = description; dialog.returnValue = 'cancel'; return new Promise((resolve) => { dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), { once: true }); dialog.showModal(); }); }

$('#settings-form').addEventListener('change', () => { settingsTouched = true; render(); });
$('#plan-form').addEventListener('change', () => { planTouched = true; render(); });
$('#login').addEventListener('click', () => action(async () => { const input = validConsent(); await client.request('/v1/ui/login', { method: 'POST', body: input }); await refresh(); show(context?.state.demo ? '正在连接演示账号' : '已请求打开知乎，请在专用窗口完成登录'); }));
$('#cancel-login').addEventListener('click', () => action(async () => { await client.request('/v1/ui/login', { method: 'DELETE' }); await refresh(); show('登录操作已取消'); }));
$('#settings-form').addEventListener('submit', (event) => { event.preventDefault(); action(async () => { await client.request('/v1/ui/consent', { method: 'POST', body: validConsent() }); settingsTouched = false; await refresh(); show('采集范围已确认并保存'); }); });
$('#plan-form').addEventListener('submit', (event) => { event.preventDefault(); action(async () => { const plan = selectedPlan(); if (plan.mode === 'page_interval' && !connected()) throw new Error('请先登录并确认采集同意，再开启定时同步。'); await client.request('/v1/sync-plan', { method: 'PUT', body: plan }); planTouched = false; nextSyncAt = null; await refresh(); show('同步方式已保存'); }); });
$('#sync-top').addEventListener('click', () => action(() => startSync()));
$('#stop-sync').addEventListener('click', () => action(async () => { syncController?.abort(); await client.request('/v1/ui/stop', { method: 'POST', body: {} }); await refresh(); show('同步已停止'); }));
$('#revoke').addEventListener('click', () => action(async () => { if (!await confirmAction('撤回采集同意？', '将停止当前同步并清除本机知乎登录会话。已经保存的数据和 Agent 只读入口保留。')) return; syncController?.abort(); await client.request('/v1/ui/consent', { method: 'DELETE' }); settingsTouched = false; nextSyncAt = null; await refresh(); show('已撤回采集同意'); }));
$('#refresh-records').addEventListener('click', () => action(async () => { await loadPage(0); await refresh(); show('已读取最新保存结果'); }));
$('#previous-page').addEventListener('click', () => action(() => loadPage(Math.max(0, page.page.offset - 10), page.snapshotId)));
$('#next-page').addEventListener('click', () => action(() => loadPage(page.page.nextOffset, page.snapshotId)));
$('#export-json').addEventListener('click', () => action(async () => download(await client.read())));
$('#copy-data').addEventListener('click', () => action(async () => { await copy(JSON.stringify(await client.read(), null, 2)); show('已复制已保存数据，可交付给 Agent'); }));
$('#reader-form').addEventListener('submit', (event) => { event.preventDefault(); action(async () => { currentReader = await client.request('/v1/readers', { method: 'POST', body: { label: $('#reader-label').value.trim() } }); $('#reader-created').hidden = false; await refresh(); show('Agent 只读入口已创建'); }); });
$('#copy-mcp').addEventListener('click', () => action(async () => { if (!currentReader) throw new Error('请先创建只读入口。'); await copy(JSON.stringify({ mcpServers: { 'zhihu-collection': { command: 'node', args: [context.local.mcpServerPath], env: { DATA_SERVICE_URL: location.origin, DATA_SERVICE_AGENT_TOKEN: currentReader.agentToken } } } }, null, 2)); show('已复制 MCP 配置，请交给 Agent 宿主，不要贴入模型对话'); }));
$('#clear-data').addEventListener('click', () => action(async () => { if (!await confirmAction('清除当前档案的数据？', '将删除本机采集结果、账号绑定和登录会话，需要重新登录。Agent 只读入口保留，可单独撤销；已导出的文件不受影响。')) return; syncController?.abort(); await client.request('/v1/ui/data', { method: 'DELETE', body: { confirm: true } }); page = null; renderRecords(); settingsTouched = false; nextSyncAt = null; await refresh(); show('当前档案的数据已清除'); }));
for (const link of document.querySelectorAll('.nav-link')) link.addEventListener('click', () => { for (const other of document.querySelectorAll('.nav-link')) other.classList.toggle('active', other === link); });
const refreshTimer = setInterval(() => { void refresh(); }, 1800);
const scheduleTimer = setInterval(() => { renderSchedule(); if (!stopped && nextSyncAt && Date.now() >= nextSyncAt && !busy && !activeJob() && connected() && !dirty() && !planDirty()) void startSync(true).catch(() => {}); }, 1000);
window.addEventListener('pagehide', () => {
  stopped = true; clearInterval(refreshTimer); clearInterval(scheduleTimer); syncController?.abort(); currentReader = null;
  const path = context?.local.operation === 'login' ? '/v1/ui/login' : '/v1/ui/stop';
  void fetch(path, { method: path.endsWith('/login') ? 'DELETE' : 'POST', headers: { 'X-Local-UI': '1', 'Content-Type': 'application/json' }, ...(path.endsWith('/stop') ? { body: '{}' } : {}), keepalive: true }).catch(() => {});
}, { once: true });
void refresh();
