const byId = (id) => document.getElementById(id);
const form = byId('search-form');
let controller;
const split = (value) => value.split(/[,，;；\n]+/).map((item) => item.trim()).filter(Boolean);
function feedback(message) { byId('feedback').textContent = message || ''; byId('feedback').hidden = !message; }
function render(snapshot) {
  byId('result-panel').hidden = false; byId('count').textContent = String(snapshot.items.length);
  byId('summary').textContent = `召回 ${snapshot.stats.rawCount} 条，去重后 ${snapshot.stats.uniqueCount} 条，匹配 ${snapshot.stats.matchedCount} 条。接口调用 ${snapshot.stats.apiCalls} 次，缓存命中 ${snapshot.stats.cacheHits} 次。${snapshot.queryPlan.truncated ? '查询计划已按预算截取。' : ''}`;
  for (const format of ['json', 'markdown']) byId(`export-${format}`).href = `/api/export?${new URLSearchParams({ id: snapshot.requestId, format })}`;
  byId('queries').replaceChildren();
  for (const query of snapshot.searches) { const li = document.createElement('li'); li.textContent = `${query.query} · ${query.returnedCount} 条 · ${query.fromCache ? '缓存' : '官方接口'}`; byId('queries').append(li); }
  byId('results').replaceChildren();
  for (const item of snapshot.items) {
    const li = document.createElement('li'); const meta = document.createElement('small');
    meta.textContent = `${({ answer: '回答', article: '文章', question: '问题' })[item.contentType] || item.contentType} · ${item.author || '作者未提供'} · 赞同 ${item.voteCount ?? '未知'} · 评论 ${item.commentCount ?? '未知'}`;
    const title = document.createElement(item.url ? 'a' : 'strong'); title.textContent = item.title || '未提供标题';
    if (item.url) { title.href = item.url; title.target = '_blank'; title.rel = 'noopener noreferrer'; }
    const excerpt = document.createElement('p'); excerpt.textContent = item.excerpt;
    const evidence = document.createElement('p'); evidence.className = 'hint'; evidence.textContent = `匹配关键词：${item.matches.keywords.join('、') || '无'}；匹配标签词：${item.matches.tags.join('、') || '无'}（本地文本匹配）`;
    li.append(meta, title, excerpt, evidence); byId('results').append(li);
  }
  byId('empty').hidden = snapshot.items.length > 0;
}
form.addEventListener('submit', async (event) => {
  event.preventDefault(); if (controller) return;
  controller = new AbortController(); byId('submit').disabled = true; byId('cancel').disabled = false;
  feedback('正在按查询预算获取与匹配内容…');
  try {
    const criteria = { query: form.elements.query.value, keywords: split(form.elements.keywords.value), tags: split(form.elements.tags.value), keywordMode: form.elements.keywordMode.value,
      tagMode: form.elements.tagMode.value, countPerQuery: Number(form.elements.countPerQuery.value), maxQueries: Number(form.elements.maxQueries.value),
      contentTypes: [...form.querySelectorAll('input[name="contentType"]:checked')].map((element) => element.value) };
    const response = await fetch('/api/search', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal, body: JSON.stringify({ criteria, refresh: form.elements.refresh.checked }) });
    const data = await response.json(); if (!response.ok) throw new Error(data.error || '搜索失败。'); render(data); feedback('搜索完成，结果已保存到本机。');
  } catch (error) { feedback(controller.signal.aborted ? '已取消，之前保存的结果保留。' : error.message); }
  finally { controller = null; byId('submit').disabled = false; byId('cancel').disabled = true; }
});
byId('cancel').addEventListener('click', () => controller?.abort());
addEventListener('pagehide', () => controller?.abort());
try {
  const status = await (await fetch('/api/status', { cache: 'no-store' })).json();
  byId('status').textContent = status.demo ? '演示模式：使用合成数据，不调用知乎接口。' : status.configured ? '官方搜索凭证已配置，仅在点击搜索时调用。' : '尚未配置 Access Secret，请在模块本机 .env 中填写后重启。';
  byId('submit').disabled = !status.configured;
  const saved = await fetch('/api/results', { cache: 'no-store' }); if (saved.ok) render(await saved.json());
} catch { byId('status').textContent = '无法连接本机服务，请检查服务是否启动。'; }
