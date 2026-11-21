import { plainText } from './official-client.mjs';

const escape = (value) => plainText(String(value ?? '')).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/([\\`*_{}\[\]()#+.!|~])/g, '\\$1');

export function toMarkdown(snapshot) {
  const lines = ['# 知乎信息搜索结果', '', `- 来源：${snapshot.provider === 'demo' ? '演示数据' : '知乎官方搜索接口'}`,
    `- 搜索时间：${snapshot.createdAt}`, `- 查询语句：${escape(snapshot.criteria.query || '未填写')}`,
    `- 关键词：${snapshot.criteria.keywords.map(escape).join('、') || '未填写'}`, `- 标签词：${snapshot.criteria.tags.map(escape).join('、') || '未填写'}`,
    '- 标签词仅匹配标题和摘要，不代表知乎原生话题标签；接口提供的是摘要，不是已验证全文。',
    `- 官方调用 ${snapshot.stats.apiCalls} 次，命中缓存 ${snapshot.stats.cacheHits} 次，去重前 ${snapshot.stats.rawCount} 条，匹配 ${snapshot.stats.matchedCount} 条。`,
    snapshot.queryPlan.truncated ? '- 查询计划受预算限制，未执行全部候选查询。' : '- 已执行本次计划的全部查询。',
    '', '## 查询记录', '', '| 查询 | 返回数量 | 缓存 |', '| --- | ---: | --- |'];
  for (const search of snapshot.searches) lines.push(`| ${escape(search.query)} | ${search.returnedCount} | ${search.fromCache ? '是' : '否'} |`);
  lines.push('', '## 匹配内容', '');
  for (const [index, item] of snapshot.items.entries()) {
    lines.push(`### ${index + 1}. ${escape(item.title)}`, '');
    if (item.url) lines.push(`[查看原帖](${item.url.replace(/\(/g, '%28').replace(/\)/g, '%29')})`, '');
    lines.push(`- 类型：${escape(item.contentType)}；作者：${escape(item.author || '未提供')}`,
      `- 赞同：${item.voteCount ?? '未提供'}；评论：${item.commentCount ?? '未提供'}`,
      `- 匹配关键词：${item.matches.keywords.map(escape).join('、') || '无'}`,
      `- 匹配标签词：${item.matches.tags.map(escape).join('、') || '无'}`, '', `> ${escape(item.excerpt || '未提供摘要。')}`, '');
  }
  if (!snapshot.items.length) lines.push('本次召回结果中没有符合全部本地条件的内容。', '');
  return lines.join('\n');
}
