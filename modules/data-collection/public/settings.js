import { ensurePageSession } from './page-session.js';

const form = document.getElementById('settings-form');
const save = document.getElementById('settings-save');
const feedback = document.getElementById('settings-feedback');
const kinds = ['history', 'likes', 'collections'];
const options = [...kinds, 'knowledgeFilter', 'aiReview'];

function message(text) {
  feedback.textContent = text;
  feedback.hidden = !text;
}

async function load() {
  await ensurePageSession();
  const response = await fetch('/api/history/settings', { cache: 'no-store' });
  const settings = await response.json();
  if (!response.ok) throw new Error(settings.error || '设置加载失败。');
  for (const kind of options) form.elements[kind].checked = settings[kind];
  try {
    const agent = await (await fetch('/api/history/agent', { cache: 'no-store' })).json();
    document.getElementById('agent-status').textContent = `${agent.model ? `模型 ${agent.model}。` : ''}${agent.message}`;
    form.elements.aiReview.disabled = !agent.ready && !settings.aiReview;
  } catch { document.getElementById('agent-status').textContent = '模型状态暂时无法读取，本地规则仍可使用。'; }
  save.disabled = false;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  save.disabled = true;
  try {
    const settings = Object.fromEntries(options.map((kind) => [kind, form.elements[kind].checked]));
    const response = await fetch('/api/history/settings', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings, consent: true }),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '保存失败。');
    message(kinds.some((kind) => settings[kind]) ? '已保存。已按新规则重新筛选缓存，后续同步按此设置执行。' : '已保存，当前全部信息种类已关闭。');
  } catch (error) { message(error.message); }
  finally { save.disabled = false; }
});

load().catch((error) => message(error.message));
