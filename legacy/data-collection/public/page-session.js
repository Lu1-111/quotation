let sessionReady;
let stream;
let pageId;

function connect() {
  if (stream) return Promise.resolve();
  pageId = crypto.randomUUID();
  const currentId = pageId;
  stream = new EventSource(`/api/history/page?${new URLSearchParams({ id: currentId })}`);
  const current = stream;
  let confirm;
  const connected = new Promise((resolve, reject) => {
    confirm = resolve;
    current.onerror = () => {
      if (current.readyState === EventSource.CLOSED) {
        if (stream === current) { stream = null; pageId = null; }
        reject(new Error('网页连接失败，请刷新重试。'));
      }
    };
  });
  current.onmessage = () => {
    fetch('/api/history/page/heartbeat', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pageId: currentId }), cache: 'no-store' })
      .then((response) => { if (response.ok) confirm(); }).catch(() => {});
  };
  return connected;
}

export function ensurePageSession() {
  if (!sessionReady) {
    sessionReady = (async () => {
      const response = await fetch('/api/history/session', { cache: 'no-store' });
      if (!response.ok) throw new Error('无法建立本机网页会话，请刷新重试。');
      await connect();
    })().catch((error) => { sessionReady = null; throw error; });
  }
  return sessionReady;
}

addEventListener('pagehide', () => {
  const departing = pageId;
  stream?.close();
  stream = null;
  pageId = null;
  sessionReady = null;
  if (departing) navigator.sendBeacon('/api/history/page/close', new Blob([JSON.stringify({ pageId: departing })], { type: 'application/json' }));
});

addEventListener('pageshow', (event) => {
  if (event.persisted) ensurePageSession().catch(() => {});
});
