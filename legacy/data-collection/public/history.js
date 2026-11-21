import { ensurePageSession } from './page-session.js';

const element = (id) => document.getElementById(`history-${id}`);
const formatDate = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
const labels = { answer: '回答', article: '文章', question: '提问', pin: '想法', profile: '用户主页', zvideo: '视频' };
const kindLabels = { history: '浏览', likes: '点赞', collections: '收藏', analysis: '正文分析' };
let current;
let busy = false;
let lastRendered = null;
let polling = false;
let controlsEdited = false;

function feedback(message) {
  element('feedback').textContent = message || '';
  element('feedback').hidden = !message;
}

async function request(path, body) {
  const response = await fetch(`/api/history/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
    cache: 'no-store',
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '请求失败，请稍后重试。');
  return data;
}

function renderStatus(state) {
  current = state;
  element('demo').hidden = !state.demo;
  element('account').textContent = state.nickname || (state.browserOpen ? '请在专用窗口登录知乎' : '尚未连接知乎');
  element('status').textContent = state.syncing ? `正在获取${kindLabels[state.stage] || '信息'}，已获取 ${state.fetched} 条`
    : state.opening ? '正在打开知乎'
      : state.autoSyncActive ? '网页已连接，每 5 分钟自动检查更新'
        : state.autoSync && !state.pageConnected ? '网页连接中断，自动采集已暂停'
        : state.browserOpen ? '已连接，可开始同步'
          : state.consented && state.lastSyncedAt ? '登录会话已保存，可随时同步' : '等待连接';
  element('time').textContent = [
    state.lastSyncedAt && `上次成功同步 · ${formatDate.format(new Date(state.lastSyncedAt))}`,
    state.nextSyncAt && !state.syncing && `下次检查 · ${formatDate.format(new Date(state.nextSyncAt))}`,
  ].filter(Boolean).join('　');
  element('count').textContent = String(state.total);
  element('kinds').textContent = ['history', 'likes', 'collections'].filter((kind) => state.settings?.[kind])
    .map((kind) => `${kindLabels[kind]} ${state.counts?.[kind] || 0} 条`).join(' · ') || '请在采集设置中勾选信息种类';
  element('excluded-count').textContent = String(state.excludedCount || 0);
  element('export').hidden = !state.lastSyncedAt;
  if (!controlsEdited) {
    element('consent').checked = state.consented;
    element('auto').checked = state.autoSync;
  }
  updateButtons();
}

function updateButtons() {
  const selected = ['history', 'likes', 'collections'].some((kind) => current?.settings?.[kind]);
  element('connect').disabled = busy || current?.opening || current?.syncing || !element('consent').checked || !selected || !current?.pageConnected;
  element('sync').disabled = busy || current?.syncing || current?.opening || !current?.consented || !selected || !current?.pageConnected;
  element('pause').disabled = !current?.autoSync && !current?.syncing && !busy;
  element('disconnect').disabled = !current?.consented && !current?.browserOpen && !busy;
  element('clear').disabled = busy || !current?.total;
}

async function renderRecords(state) {
  const revision = `${state.lastSyncedAt}:${state.revision}`;
  if (revision === lastRendered) return;
  const snapshot = await request('data');
  const list = element('records');
  list.replaceChildren();
  const fragment = document.createDocumentFragment();
  for (const record of snapshot.records) {
    const row = document.createElement('li');
    const meta = document.createElement('small');
    meta.textContent = [labels[record.contentType] || record.contentType, record.author,
      record.kinds?.map((kind) => kindLabels[kind]).join('、'),
      record.weight == null ? '权重待配置' : `权重 ${record.weight.toFixed(3)}`].filter(Boolean).join(' · ');
    const title = document.createElement(record.url ? 'a' : 'strong');
    title.textContent = record.title || '未命名内容';
    if (record.url) { title.href = record.url; title.target = '_blank'; title.rel = 'noopener noreferrer'; }
    row.append(meta, title);
    if (record.summary) {
      const summary = document.createElement('p');
      summary.textContent = record.summary;
      row.append(summary);
    }
    const analysis = record.analysis;
    if (analysis) {
      const annotation = document.createElement('p');
      annotation.className = 'review-annotation';
      annotation.textContent = `${analysis.method === 'ollama' ? '本机 AI' : '本地规则'} · ${analysis.decision === 'review' ? '待复核' : analysis.decision === 'exclude' ? '排除候选（过滤已关闭）' : '知识候选'} · ${(analysis.domains || []).join('、') || '领域待分类'}。${analysis.reason}${analysis.agentWarning || ''}`;
      row.append(annotation);
      if (analysis.summary) {
        const summary = document.createElement('p');
        summary.textContent = `正文总结：${analysis.summary}`;
        row.append(summary);
      }
      const tags = document.createElement('p');
      tags.className = 'footnote';
      tags.textContent = [`关键词：${analysis.keywords?.join('、') || '待分析'}`, `标签：${analysis.tags?.join('、') || '待分析'}`,
        analysis.knowledgePoints?.length ? `知识点：${analysis.knowledgePoints.join('；')}` : '',
        analysis.coverage ? `已分析接口正文 ${analysis.coverage.characters} 字符，共 ${analysis.coverage.chunks} 段` : ''].filter(Boolean).join('。');
      row.append(tags);
    }
    const details = document.createElement('details');
    const heading = document.createElement('summary');
    heading.textContent = '查看权重明细';
    const explanation = document.createElement('p');
    const weight = record.weightDetails;
    explanation.textContent = weight ? `类型权重 ${weight.base ?? '待配置'}，行为系数 ${weight.actionMultiplier.toFixed(3)}，互动加分 ${weight.engagementBonus.toFixed(3)}，相似帖子 ${weight.similarPostCount} 条，主题加分 ${weight.themeBonus.toFixed(1)}，时间系数 ${weight.timeFactor}。${record.metricsMissing ? '部分互动数据缺失。' : `点赞 ${record.voteCount}，评论 ${record.commentCount}。`}` : '等待重新同步计算权重。';
    details.append(heading, explanation);
    row.append(details);
    fragment.append(row);
  }
  list.append(fragment);
  const excluded = element('excluded');
  excluded.replaceChildren();
  for (const record of snapshot.excluded || []) {
    const row = document.createElement('li');
    const title = document.createElement('strong');
    title.textContent = record.title || '未命名内容';
    const reason = document.createElement('p');
    reason.textContent = `${record.analysis?.method === 'ollama' ? '本机 AI' : '本地规则'}：${record.analysis?.reason || '未提供理由'}`;
    row.append(title, reason); excluded.append(row);
  }
  element('empty').hidden = snapshot.records.length > 0;
  element('empty').textContent = state.lastSyncedAt ? '此次同步没有获取到符合条件的帖子。' : '连接并同步后，帖子会出现在这里。';
  lastRendered = revision;
}

async function refresh() {
  const status = await request('session');
  renderStatus(status);
  await renderRecords(status);
  return status;
}

async function action(path, body, message) {
  busy = true;
  updateButtons();
  feedback(message);
  try {
    await request(path, body);
    controlsEdited = false;
    const status = await refresh();
    feedback(status.error);
  } catch (error) {
    feedback(error.message);
    await refresh().catch(() => {});
  } finally {
    busy = false;
    updateButtons();
  }
}

element('consent').addEventListener('change', () => {
  controlsEdited = true;
  if (!element('consent').checked && current?.consented) {
    action('disconnect', {}, '正在撤回采集同意并断开连接…');
    return;
  }
  updateButtons();
});
element('auto').addEventListener('change', () => { controlsEdited = true; });
element('connect').addEventListener('click', () => action('connect', { consent: element('consent').checked }, '正在打开专用知乎窗口，请亲自登录后回来点击立即同步。'));
element('sync').addEventListener('click', () => action('sync', { autoSync: element('auto').checked }, '正在获取选定的知乎信息…'));
element('pause').addEventListener('click', () => action('pause', {}, '正在暂停同步…'));
element('disconnect').addEventListener('click', () => action('disconnect', {}, '正在断开连接…'));
element('clear').addEventListener('click', () => {
  if (confirm('删除本机保存的浏览、点赞和收藏记录，并断开采集连接？')) action('clear', {}, '正在删除本机记录…');
});

ensurePageSession().then(refresh).catch((error) => feedback(error.message));
setInterval(async () => {
  if (polling || document.hidden) return;
  polling = true;
  try {
    await ensurePageSession();
    const status = await refresh();
    if (status.error) feedback(status.error);
  } catch (error) { feedback(error.message); }
  finally { polling = false; }
}, 3000);
