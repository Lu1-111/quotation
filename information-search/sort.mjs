import { SearchError } from './official-client.mjs';

const fields = {
  CommentCount: 'commentCount',
  VoteUpCount: 'voteCount',
  EditTime: 'editedTime',
  CreateTime: 'createdTime',
};

// 使用官方支持的字段、方向和包含端点的整数范围，归一化后用于缓存和查询。
export function parseSortBy(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 100) {
    throw new SearchError('排序条件格式无效。', 400, 'INVALID_CRITERIA');
  }
  const normalized = value.trim().replace(/^([^:]+):\(/, '$1::(');
  const match = /^(CommentCount|VoteUpCount|EditTime|CreateTime)(?::(asc|desc|none)?)?(?::\((\d*),(\d*)\))?$/i.exec(normalized);
  if (!match || !Object.hasOwn(fields, match[1])) {
    throw new SearchError('排序字段、方向或范围无效。', 400, 'INVALID_CRITERIA');
  }
  const [, field, rawDirection, lower, upper] = match;
  if (lower && upper && BigInt(lower) > BigInt(upper)) {
    throw new SearchError('排序范围的最小值不能大于最大值。', 400, 'INVALID_CRITERIA');
  }
  const direction = (rawDirection || 'desc').toLowerCase();
  const range = lower !== undefined ? `:(${lower},${upper})` : '';
  return { field, direction, lower: lower || null, upper: upper || null,
    canonical: `${field}:${direction}${range}` };
}

export function sortResults(items, sort) {
  if (!sort) {
    return [...items].sort((a, b) => (b.rankingScore ?? -Infinity) - (a.rankingScore ?? -Infinity) || a.key.localeCompare(b.key));
  }
  if (sort.direction === 'none') return [...items];
  const key = fields[sort.field];
  return [...items].sort((a, b) => {
    const left = a[key] === null || a[key] === undefined || a[key] === '' ? null : Number(a[key]);
    const right = b[key] === null || b[key] === undefined || b[key] === '' ? null : Number(b[key]);
    const validLeft = left !== null && Number.isFinite(left);
    const validRight = right !== null && Number.isFinite(right);
    if (!validLeft || !validRight) return validLeft === validRight ? 0 : validLeft ? -1 : 1;
    return sort.direction === 'asc' ? left - right : right - left;
  });
}

export function filterDemoSortRange(items, sort) {
  if (!sort || (sort.lower === null && sort.upper === null)) return items;
  const key = fields[sort.field];
  return items.filter((item) => {
    const value = item[key];
    if (value === null || value === undefined || !/^\d+$/.test(String(value))) return false;
    const number = BigInt(value);
    return (sort.lower === null || number >= BigInt(sort.lower))
      && (sort.upper === null || number <= BigInt(sort.upper));
  });
}
