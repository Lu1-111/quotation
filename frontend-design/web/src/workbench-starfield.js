const root = document.querySelector('#content');
const notice = document.querySelector('#notice');
const debateTab = document.querySelector('#debate-tab');
const galaxyTab = document.querySelector('#galaxy-tab');
const coverStart = document.getElementById('startDebate');
const sessionKey = 'quotation-workbench-debate-session';
const attemptKey = 'quotation-workbench-debate-attempt';

let shell;
let host = null;
let view = 'debate';
let topics = [];
let snapshot = null;
let knowledge = null;
let knowledgeError = '';
let highlightedSession = null;
let busy = false;
let source = null;
let currentText = '';
let retry = null;
let attempt = null;
let restoring = false;
let restoreFailed = false;
let cancelling = false;
let snapshotRequest = 0;
let mapRequest = 0;
let navigation = 0;
let connecting = null;
let connectionError = false;

function getStored(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function store(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch { /* 隐私设置可能禁止本地存储，仍可在当前页使用。 */ }
}

function rememberAttempt(value) {
  attempt = value;
  store(attemptKey, value ? JSON.stringify(value) : null);
}

function currentAction(operation) {
  const debate = snapshot?.debate;
  if (!debate || debate.settlement || !operation) return false;
  if (operation.type === 'open_debate') return !debate.currentRound;
  return debate.currentRound?.id === operation.roundId
    && debate.currentRound.options.some(({ id }) => id === operation.optionId);
}

function el(tag, text = '', className = '') {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function action(label, onClick, { primary = false, disabled = false } = {}) {
  const button = el('button', label, primary ? 'analysis-btn primary' : 'analysis-btn');
  button.type = 'button';
  button.disabled = disabled;
  button.addEventListener('click', onClick);
  return button;
}

function sourceDetails(refs) {
  if (!refs?.length) return null;
  const details = el('details');
  details.append(el('summary', '看看出处'));
  for (const ref of refs) {
    const label = [ref.author, ref.title].filter(Boolean).join(' · ');
    const row = el('div', '', 'source-row');
    if (typeof ref.url === 'string' && /^https:\/\/(?:[a-z0-9-]+\.)*zhihu\.com(?:\/|$)/i.test(ref.url)) {
      const link = el('a', label);
      link.href = ref.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      row.append(link);
    } else if (label) {
      row.append(el('span', label));
    }
    if (ref.quote) row.append(el('p', ref.quote));
    const activity = [
      Number.isFinite(ref.votes) ? ref.votes + ' 赞同' : '',
      Number.isFinite(ref.comments) ? ref.comments + ' 评论' : '',
    ].filter(Boolean);
    if (activity.length) row.append(el('small', activity.join(' · ')));
    if (ref.round) row.append(el('small', '来自本局第 ' + ref.round + ' 轮'));
    details.append(row);
  }
  return details;
}

function includeSources(parent, refs) {
  const sources = sourceDetails(refs);
  if (sources) parent.append(sources);
}

function hero(title, description) {
  const section = el('section', '', 'hero');
  section.append(el('h1', title), el('p', description));
  return section;
}

async function api(path, body) {
  const response = await fetch(path, body === undefined ? undefined : {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => null);
  const payload = await response?.json().catch(() => null);
  if (payload?.ok) return payload.data;
  const error = new Error(payload?.error?.message ?? '刚才没连上，可以再试一次。');
  error.code = payload?.error?.code;
  if (error.code === 'ZHIHU_LOGIN_REQUIRED') location.replace('/login');
  throw error;
}

function fail(error) {
  if (error.code === 'WORKBENCH_LINK_REQUIRED' && host) {
    host.connected = false;
    shell.closeMap();
    snapshotRequest += 1;
    mapRequest += 1;
    knowledge = null;
    snapshot = null;
    topics = [];
    source?.close();
    source = null;
    currentText = '';
  }
  notice.textContent = error.message;
  render();
}

async function loadTopics(refresh = false) {
  if (busy) return;
  busy = true;
  notice.textContent = '正在知乎找三道可以认真辩一辩的题。';
  render();
  try {
    topics = (await api('/v1/debate/topics', { refresh })).topics;
    notice.textContent = '';
  } catch (error) {
    fail(error);
  } finally {
    busy = false;
    render();
  }
}

async function start(topicId) {
  if (busy) return;
  busy = true;
  render();
  try {
    snapshot = await api('/v1/sessions', { topicId });
    store(sessionKey, snapshot.sessionId);
    busy = false;
    await submit({ type: 'open_debate' });
  } catch (error) {
    busy = false;
    fail(error);
  }
}

async function loadSnapshot(sessionId = snapshot?.sessionId) {
  if (!sessionId) return;
  const version = ++snapshotRequest;
  const next = await api('/v1/sessions/' + sessionId);
  if (version !== snapshotRequest) return;
  snapshot = next;
  busy = Boolean(snapshot.activeTurnId);
  const recent = snapshot.lastTurn;
  if (attempt?.sessionId === sessionId && (recent?.clientRequestId === attempt.clientRequestId
    || !currentAction(attempt.action))) {
    rememberAttempt(null);
  }
  retry = !busy && recent?.error && currentAction(recent.action) ? recent.action : null;
  if (!busy) notice.textContent = recent?.error?.message ?? '';
  render();
}

async function restoreSession(sessionId = getStored(sessionKey)) {
  if (!sessionId || restoring) return;
  restoring = true;
  restoreFailed = false;
  render();
  try {
    await loadSnapshot(sessionId);
    if (snapshot?.activeTurnId) watch(snapshot.activeTurnId);
  } catch (error) {
    if (['SESSION_NOT_FOUND', 'SESSION_FORBIDDEN', 'NOT_FOUND'].includes(error.code)) {
      store(sessionKey, null);
      rememberAttempt(null);
      snapshot = null;
    } else {
      restoreFailed = true;
      fail(error);
    }
  } finally {
    restoring = false;
    render();
  }
}

function watch(turnId) {
  source?.close();
  const path = '/v1/sessions/' + snapshot.sessionId + '/turns/' + turnId + '/events';
  const feed = new EventSource(path);
  source = feed;
  let lastId = 0;
  let checking = false;
  function on(type, fn) {
    feed.addEventListener(type, (event) => {
      const id = Number(event.lastEventId);
      if (id <= lastId || source !== feed) return;
      lastId = id;
      fn(JSON.parse(event.data));
    });
  }
  on('stage.changed', (data) => { notice.textContent = data.message ?? ''; });
  on('text.delta', ({ delta }) => {
    currentText += delta;
    const draft = document.querySelector('#live-argument');
    if (draft) draft.textContent = currentText;
  });
  on('turn.done', async () => {
    feed.close();
    source = null;
    currentText = '';
    try {
      await loadSnapshot();
      if (view === 'debate') root.querySelector('[data-focus-round]')?.focus({ preventScroll: true });
      else if (snapshot?.debate.settlement) await refreshKnowledge();
    } catch (error) {
      restoreFailed = true;
      fail(error);
    }
  });
  feed.onerror = async () => {
    if (source !== feed || checking) return;
    checking = true;
    try {
      await loadSnapshot();
      if (source !== feed) return;
      if (!snapshot.activeTurnId) {
        feed.close();
        source = null;
      } else if (snapshot.activeTurnId !== turnId) {
        watch(snapshot.activeTurnId);
      }
    } catch (error) {
      if (source !== feed) return;
      if (error.code === 'WORKBENCH_LINK_REQUIRED') fail(error);
      else notice.textContent = '连接暂时中断，正在重新连接。';
    } finally {
      checking = false;
    }
  };
}

async function submit(operation, previousAttempt = null) {
  if (busy || cancelling || !currentAction(operation)) return;
  const request = previousAttempt ?? {
    sessionId: snapshot.sessionId, clientRequestId: crypto.randomUUID(),
    baseGraphVersion: snapshot.graphVersion, action: operation,
  };
  rememberAttempt(request);
  retry = null;
  busy = true;
  currentText = '';
  notice.textContent = '在准备这一轮，请稍等。';
  render();
  try {
    const { sessionId, ...payload } = request;
    const result = await api('/v1/sessions/' + sessionId + '/turns', payload);
    snapshot.activeTurnId = result.turnId;
    render();
    watch(result.turnId);
  } catch (error) {
    busy = false;
    let refreshed = false;
    try {
      await loadSnapshot();
      refreshed = true;
    } catch { /* 尚无法判断服务器是否接收，保留请求编号。 */ }
    if (snapshot?.activeTurnId) {
      watch(snapshot.activeTurnId);
      return;
    }
    if (refreshed && snapshot?.lastTurn?.clientRequestId === request.clientRequestId) return;
    if (error.code?.startsWith('STALE_')) rememberAttempt(null);
    if (!attempt && currentAction(operation)) retry = operation;
    fail(error);
  }
}

async function cancel() {
  const turnId = snapshot.activeTurnId;
  if (!turnId || cancelling) return;
  cancelling = true;
  render();
  try {
    await api('/v1/sessions/' + snapshot.sessionId + '/turns/' + turnId + '/cancel', {});
    source?.close();
    source = null;
    currentText = '';
    await loadSnapshot();
  } catch (error) { fail(error); }
  finally {
    cancelling = false;
    render();
  }
}

function resetDebate() {
  source?.close();
  source = null;
  snapshot = null;
  snapshotRequest += 1;
  retry = null;
  busy = false;
  notice.textContent = '';
  store(sessionKey, null);
  rememberAttempt(null);
  render();
}

async function refreshKnowledge(updateView = true) {
  const request = ++mapRequest;
  knowledgeError = '';
  try {
    const map = await api('/v1/knowledge-map');
    if (request !== mapRequest) return null;
    knowledge = map;
  } catch (error) {
    if (request !== mapRequest) return null;
    if (error.code === 'WORKBENCH_LINK_REQUIRED') fail(error);
    else knowledgeError = error.message;
  }
  if (view === 'galaxy' && updateView !== false) render();
  return knowledgeError || !host ? null : knowledge;
}

async function showKnowledge(sessionId = null) {
  navigation += 1;
  view = 'galaxy';
  highlightedSession = sessionId;
  knowledgeError = '';
  render();
  await refreshKnowledge();
}

function renderTopics() {
  const intro = hero('挑一句，你想和它较较真。', '两条来自你平时关心的领域，一条来自知乎近期讨论。对手会守住自己挑的理由，你每轮选一句最想说的话。');
  const buttons = el('div', '', 'controls');
  buttons.append(action(topics.length ? '换一批观点' : '找三个观点', () => loadTopics(Boolean(topics.length)), { primary: !topics.length, disabled: busy }));
  intro.append(buttons);
  root.append(intro);
  if (!topics.length) return;

  const list = el('div', '', 'grid');
  for (const topic of topics) {
    const tile = el('article', '', 'card topic');
    const content = el('div');
    content.append(el('p', topic.source === 'hot' ? '知乎近期高互动' : '来自你的画像偏好', 'kicker'),
      el('h2', topic.topic), el('p', topic.claim, 'claim'));
    includeSources(content, topic.references);
    tile.append(content, action('挑战这条观点', () => start(topic.id), { primary: true, disabled: busy }));
    list.append(tile);
  }
  root.append(list);
}

function renderSettlement(panel, debate) {
  const { settlement, history } = debate;
  const result = el('h2', settlement.persuaded ? '对手愿意放下原来的结论' : '有些分歧还可以继续想一想');
  result.tabIndex = -1;
  result.dataset.focusRound = '';
  panel.append(result);
  const summary = el('p', '十二轮结束。你选过的观点里，有 ' + settlement.points.length + ' 条可核验的知识。', 'muted');
  panel.append(summary);
  const ctl = el('div', '', 'controls');
  ctl.append(action('去知识星图看看', () => showKnowledge(snapshot.sessionId), { primary: true }),
    action('再挑一个观点', resetDebate));
  panel.append(ctl);
  const heading = el('h2', '这十二轮你选了什么');
  heading.style.marginTop = '2rem';
  panel.append(heading);
  const list = el('div', '', 'timeline');
  for (const record of history) {
    const card = el('article', '', 'card');
    card.append(el('p', '第 ' + record.number + ' 轮 · ' + record.focus.lens, 'kicker'),
      el('p', record.option.text),
      el('p', settlement.pending.some((item) => item.round === record.number) ? '这一处还待查' : '这一处有可核对的出处', 'muted'));
    includeSources(card, record.option.citations);
    list.append(card);
  }
  panel.append(list);
}

function renderDebate() {
  if (restoring) return root.append(el('p', '正在取回交锋进度。', 'muted'));
  if (restoreFailed) {
    return root.append(action('重新读取进度', () => restoreSession(snapshot?.sessionId || getStored(sessionKey)), { primary: true }));
  }
  if (!snapshot) return renderTopics();
  const { debate } = snapshot;
  const panel = el('section', '', 'debate');
  panel.append(el('p', '对手观点', 'kicker'), el('h1', debate.topic.claim));
  root.append(panel);
  if (debate.settlement) return renderSettlement(panel, debate);

  const round = debate.currentRound;
  const bar = el('div', '', 'bar');
  const meter = el('progress');
  meter.value = debate.willpower;
  meter.max = 140;
  meter.setAttribute('aria-label', '对手意志');
  bar.append(el('span', '第 ' + (round?.number ?? 1) + ' / 12 轮'), meter,
    el('span', '对手意志 ' + debate.willpower, 'muted'));
  panel.append(bar);
  const previous = debate.history.at(-1);
  if (previous) {
    const lastChoice = el('details');
    const delta = previous.willpower - (debate.history.at(-2)?.willpower ?? 100);
    const feedback = delta === 0 ? '对手意志未变' : '对手意志 ' + (delta > 0 ? '+' : '') + delta;
    lastChoice.append(el('summary', '上轮你选了 · ' + previous.option.angle + ' · ' + feedback),
      el('p', previous.option.text));
    includeSources(lastChoice, previous.option.citations);
    panel.append(lastChoice);
  }
  if (busy) {
    const section = el('section', '', 'opponent');
    section.append(el('p', '对手正在整理回应', 'kicker'));
    const drafting = el('blockquote', currentText);
    drafting.id = 'live-argument';
    section.append(drafting);
    if (snapshot.activeTurnId) section.append(action(cancelling ? '正在暂停' : '暂停这轮', cancel, { disabled: cancelling }));
    panel.append(section);
    return;
  }
  const waiting = attempt?.sessionId === snapshot.sessionId && currentAction(attempt.action) ? attempt : null;
  if (waiting || retry) {
    panel.append(action(waiting ? '重新提交这次选择' : '重试这轮',
      () => waiting ? submit(waiting.action, waiting) : submit(retry), { primary: true, disabled: cancelling }));
  }
  if (!round) {
    if (!waiting && !retry) panel.append(action('开始第一轮', () => submit({ type: 'open_debate' }),
      { primary: true, disabled: cancelling }));
    return;
  }

  const opponent = el('section', '', 'opponent');
  opponent.append(el('p', round.focus.lens + ' · 对手' + (round.number === 1 ? '立论' : '回应'), 'kicker'),
    el('blockquote', round.opponent.argument));
  if (round.opponent.responseRef) {
    opponent.append(el('p', '回应了你上轮提到的「' + round.opponent.responseRef + '」。', 'muted'));
  }
  includeSources(opponent, round.opponent.citations);
  const heading = el('h2', '这一轮，你想从哪儿说起？');
  heading.tabIndex = -1;
  heading.dataset.focusRound = '';
  panel.append(opponent, heading);
  const list = el('div', '', 'options');
  for (const option of round.options) {
    const card = el('article', '', 'card');
    const button = action('', () => submit({ type: 'choose_debate_option', roundId: round.id, optionId: option.id }),
      { disabled: Boolean(waiting) || cancelling });
    button.className = 'option-button';
    button.append(el('strong', option.angle), el('span', option.text));
    card.append(button);
    if (option.citations?.length) includeSources(card, option.citations);
    else card.append(el('p', '这是一条待查问题。', 'option-note'));
    list.append(card);
  }
  panel.append(list);
}

function renderKnowledge() {
  root.append(hero('知识星图', '每个星系是一片知识领域。你读过的话题在这里落下第一点光，交锋后核验过的知识会沿着它长出来。'));
  if (knowledgeError) {
    root.append(el('p', knowledgeError, 'muted'), action('重试读取星图', refreshKnowledge));
    return;
  }
  if (!knowledge) {
    if (!knowledgeError) root.append(el('p', '正在读取你的星图。', 'muted'));
    return;
  }
  if (knowledge.pending && !knowledgeError) root.append(action('有一局知识待入图，重试', refreshKnowledge));
  root.append(action('进入三维星图', openMap, { primary: true }));
  if (!knowledge.domains.length) {
    root.append(el('p', '星图还很空。可以先更新工作台画像，或完成一次交锋。', 'muted'));
    if (!host.connected) root.append(workbenchLink());
    return;
  }
  const groups = el('div', '', 'grid constellations');
  for (const domain of knowledge.domains) {
    const group = el('article', '', 'card constellation');
    group.append(el('h2', domain.name));
    const stars = el('div', '', 'stars');
    for (const point of domain.points) {
      const star = el('details', '', 'star');
      star.id = 'star-' + point.id;
      star.dataset.kind = point.kind;
      const title = el('summary', point.title);
      star.append(title);
      star.append(el('p', point.kind === 'verified' ? '交锋中核验过' : '从阅读画像初始化', 'muted'));
      const fromThisDebate = highlightedSession && point.sources.some((item) => item.sessionId === highlightedSession);
      if (fromThisDebate) star.append(el('p', '出处来自刚结束的这局交锋', 'muted'));
      if (point.description) star.append(el('p', point.description));
      includeSources(star, point.sources);
      stars.append(star);
      star.append(action('在三维星图中查看', () => openMap(point.id)));
    }
    if (domain.points.length) group.append(stars);
    groups.append(group);
  }
  root.append(groups);
}

function workbenchLink() {
  const link = el('a', '去工作台连接', 'analysis-btn primary');
  link.href = host?.workbenchUrl ?? 'http://127.0.0.1:3210/?connect-starfield=1';
  return link;
}

function render() {
  coverStart.textContent = snapshot ? (snapshot.debate.settlement ? '回看这场交锋' : '继续观点交锋') : '开始观点交锋';
  debateTab.setAttribute('aria-pressed', String(view === 'debate'));
  galaxyTab.setAttribute('aria-pressed', String(view === 'galaxy'));
  debateTab.disabled = galaxyTab.disabled = !host || connectionError;
  notice.hidden = view === 'galaxy' && Boolean(host);
  root.replaceChildren();
  if (!host?.connected) {
    if (connectionError) {
      root.append(action('重试工作台连接', connect, { primary: true }));
      return;
    }
    if (!host) {
      root.append(el('p', '正在连接你的工作台。', 'muted'));
      return;
    }
    if (view === 'galaxy') { renderKnowledge(); return; }
    const intro = hero('把工作台的阅读带进星图。', '在工作台使用同一个知乎账号，同步阅读并生成画像。点「连接正式星图」，就能从你关心的话题开始交锋。');
    intro.append(workbenchLink());
    root.append(intro);
    return;
  }
  if (view === 'galaxy') renderKnowledge();
  else renderDebate();
}

async function openDebate() {
  const intent = ++navigation;
  shell.enterWorkspace();
  view = 'debate';
  render();
  await connecting;
  if (intent !== navigation) return;
  if (host?.connected && !snapshot && !restoring && !restoreFailed && !topics.length) await loadTopics();
}

async function openMap(pointId = null) {
  const intent = ++navigation;
  await connecting;
  if (intent !== navigation) return;
  if (!host || connectionError) { shell.enterWorkspace(); render(); return; }
  const map = await refreshKnowledge(false);
  if (intent !== navigation) return;
  if (map) shell.openMapScene(map, sourceDetails, typeof pointId === 'string' ? pointId : null,
    host.connected ? null : host.workbenchUrl);
  else { shell.enterWorkspace(); view = 'galaxy'; render(); }
}

function pendingPairCode() {
  return new URLSearchParams(location.hash.slice(1)).get('pair');
}

async function handshake(pairCode) {
  connectionError = false;
  notice.textContent = '';
  if (pairCode) {
    history.replaceState(null, '', location.pathname + location.search);
    shell.closeMap();
    source?.close();
    source = null;
    snapshotRequest += 1;
    mapRequest += 1;
    topics = [];
    snapshot = null;
    knowledge = null;
    busy = false;
    retry = null;
    attempt = null;
    view = 'debate';
    host = null;
    render();
  }
  try {
    host = await api('/api/host/session', pairCode ? { pairCode } : {});
    if (host.connected) {
      const localSessionId = getStored(sessionKey);
      const sessionId = host.resumeSessionId || localSessionId;
      if (sessionId) store(sessionKey, sessionId);
      try {
        const saved = JSON.parse(getStored(attemptKey));
        if (saved?.sessionId === sessionId) attempt = saved;
      } catch { store(attemptKey, null); }
      await restoreSession(sessionId);
      if ((snapshot && localSessionId === sessionId) || pairCode) shell.enterWorkspace();
    }
  } catch (error) {
    connectionError = error.code !== 'WORKBENCH_LINK_REQUIRED';
    if (!connectionError) host = { connected: false };
    notice.textContent = error.message;
    if (pairCode) shell.enterWorkspace();
  }
  render();
}

function connect() {
  if (connecting) return connecting;
  connecting = handshake(pendingPairCode()).finally(() => { connecting = null; });
  return connecting;
}

window.addEventListener('hashchange', () => {
  if (pendingPairCode()) void connect();
});
export function mountWorkbench(callbacks) {
  shell = callbacks;
  debateTab.addEventListener('click', openDebate);
  galaxyTab.addEventListener('click', () => showKnowledge());
  return { openDebate, openMap, connect, leaveWorkspace() { navigation += 1; } };
}
