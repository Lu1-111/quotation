const byId = (id) => document.getElementById(id);
const feedback = byId('feedback');
const syncButton = byId('sync');
const disconnectButton = byId('disconnect');
const typeLabel = { answer: '回答', article: '文章', question: '提问', pin: '想法', zvideo: '视频' };
const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });

function showFeedback(message) {
  feedback.textContent = message || '';
  feedback.hidden = !message;
}

async function request(path, method = 'GET') {
  const response = await fetch(path, { method, cache: 'no-store' });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '请求失败，请稍后重试。');
  return result;
}

function renderList(name, items) {
  byId(`${name}-count`).textContent = String(items.length);
  const list = byId(name);
  list.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('li');
    empty.textContent = '暂无记录';
    list.append(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const item of items) {
    const row = document.createElement('li');
    const metadata = document.createElement('small');
    const timestamp = item.favoritedAt ?? item.createdAt;
    metadata.textContent = [typeLabel[item.type], timestamp && dateFormat.format(timestamp * 1000)]
      .filter(Boolean).join(' · ');
    const title = document.createElement(item.url ? 'a' : 'strong');
    title.textContent = item.title || '未命名内容';
    if (item.url) {
      title.href = item.url;
      title.target = '_blank';
      title.rel = 'noopener noreferrer';
    }
    row.append(metadata, title);
    if (item.summary) {
      const summary = document.createElement('p');
      summary.textContent = item.summary;
      row.append(summary);
    }
    fragment.append(row);
  }
  list.append(fragment);
}

function renderSnapshot(snapshot) {
  byId('sync-time').textContent = `上次同步 · ${dateFormat.format(new Date(snapshot.syncedAt))}`;
  renderList('creations', snapshot.creations);
  renderList('collections', snapshot.collections);
  byId('data').hidden = false;
  byId('export').hidden = false;
}

async function load() {
  const session = await request('/api/session');
  byId('demo').hidden = !session.demo;
  byId('actions').hidden = false;
  byId('account-title').textContent = session.connected ? session.nickname || '已连接知乎' : '尚未连接知乎';
  byId('connect').hidden = !session.ready || (session.connected && session.canSync);
  byId('connect-label').textContent = session.connected ? '重新连接知乎' : '连接知乎并同步';
  syncButton.hidden = !session.connected || !session.canSync;
  disconnectButton.hidden = !session.connected;
  byId('sync-time').textContent = session.connected ? '尚未同步' : '';

  const authResult = new URLSearchParams(location.search).get('auth');
  const authMessages = {
    'invalid-state': '知乎回调缺少有效的 state，或授权请求已过期。请确认应用的回调设置后重试。',
    'no-code': '此次授权没有返回授权码。',
    failed: '知乎授权失败，请检查赛事应用凭证、登记的回调地址和账号状态。',
  };
  showFeedback(authMessages[authResult] || session.syncError || (!session.ready ? '请在服务端配置知乎应用凭证，或启动本地演示。' : ''));
  if (!session.connected) return;

  try {
    renderSnapshot(await request('/api/zhihu/data'));
  } catch (error) {
    if (!session.syncError) showFeedback(error.message);
  }
}

syncButton.addEventListener('click', async () => {
  syncButton.disabled = true;
  showFeedback('正在同步公开创作和近期公开收藏…');
  try {
    renderSnapshot(await request('/api/zhihu/sync', 'POST'));
    showFeedback('同步完成。');
  } catch (error) {
    showFeedback(error.message);
    if (error.message.includes('重新连接')) {
      syncButton.hidden = true;
      byId('connect-label').textContent = '重新连接知乎';
      byId('connect').hidden = false;
    }
  } finally {
    syncButton.disabled = false;
  }
});

disconnectButton.addEventListener('click', async () => {
  if (!window.confirm('断开知乎连接并删除本网站保存的同步数据？')) return;
  disconnectButton.disabled = true;
  try {
    await request('/api/zhihu/disconnect', 'POST');
    location.replace('/');
  } catch (error) {
    showFeedback(error.message);
    disconnectButton.disabled = false;
  }
});

load().catch((error) => showFeedback(error.message));
