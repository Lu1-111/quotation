// 论点依赖图纯函数引擎：DAG 校验、稳定拓扑排序、传递承重 S、最短依赖深度 d、过半坍塌与星等亮度。
// 重要说明：已移除旧版按信念簇挑最大破坏节点的 conflictSet()/price()，具体句子的直接冲突必须来自已核验的证据引用，绝不按图结构反推冲突。

function createGraphError(message, errors = []) {
  const err = new Error(message);
  err.name = 'GraphValidationError';
  err.code = 'INVALID_GRAPH';
  err.errors = errors;
  return err;
}

// 最小二叉堆（按原始下标保序），确保合法拓扑序输入经 Kahn 排序后下标顺序完全不变，非拓扑序输入得到唯一确定性拓扑序。
function pushMinHeap(heap, value) {
  heap.push(value);
  let idx = heap.length - 1;
  while (idx > 0) {
    const parent = (idx - 1) >> 1;
    if (heap[parent] <= heap[idx]) break;
    const tmp = heap[parent];
    heap[parent] = heap[idx];
    heap[idx] = tmp;
    idx = parent;
  }
}

function popMinHeap(heap) {
  const top = heap[0];
  const last = heap.pop();
  if (heap.length > 0) {
    heap[0] = last;
    let idx = 0;
    const len = heap.length;
    while (true) {
      const left = idx * 2 + 1;
      const right = left + 1;
      let smallest = idx;
      if (left < len && heap[left] < heap[smallest]) smallest = left;
      if (right < len && heap[right] < heap[smallest]) smallest = right;
      if (smallest === idx) break;
      const tmp = heap[idx];
      heap[idx] = heap[smallest];
      heap[smallest] = tmp;
      idx = smallest;
    }
  }
  return top;
}

function validateNodeFields(nodes) {
  const errors = [];
  const indexById = new Map();

  nodes.forEach((n, i) => {
    const at = `nodes[${i}]`;
    if (!n || typeof n !== 'object' || Array.isArray(n)) {
      errors.push(`${at} 不是对象。`);
      return;
    }
    if (typeof n.id !== 'string' || !n.id.trim()) {
      errors.push(`${at}.id 必须是非空字符串。`);
    } else if (indexById.has(n.id)) {
      errors.push(`${at}.id 重复：${n.id}。`);
    } else {
      indexById.set(n.id, i);
    }

    if (typeof n.text !== 'string' || !n.text.trim()) {
      errors.push(`${at}.text 必须是非空字符串。`);
    }

    const validCluster =
      (typeof n.cluster === 'string' && n.cluster.trim().length > 0) ||
      (typeof n.cluster === 'number' && Number.isFinite(n.cluster));
    if (!validCluster) {
      errors.push(`${at}.cluster 必须是非空字符串或有限数字。`);
    }

    if (!Array.isArray(n.deps)) {
      errors.push(`${at}.deps 必须是数组。`);
    }
  });

  return { errors, indexById };
}

function popcount32(v) {
  let x = (v >>> 0) - ((v >>> 1) & 0x55555555);
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333);
  return Math.imul((x + (x >>> 4)) & 0x0f0f0f0f, 0x01010101) >>> 24;
}

// 使用显式迭代栈的三色标记 DFS 提取确定性的循环依赖路径（方向：支撑节点 -> 下游依赖节点），避免大图深链递归栈溢出。
function detectCycleDescriptions(nodes, childrenByIndex) {
  const count = nodes.length;
  const color = new Uint8Array(count); // 0=未访问, 1=访问中(栈内), 2=已完成
  const posInStack = new Int32Array(count).fill(-1);
  const childCursor = new Int32Array(count);
  const stack = [];
  const cycleMessages = [];
  const seenCycleKeys = new Set();

  for (let i = 0; i < count; i += 1) {
    if (color[i] !== 0 || !nodes[i] || typeof nodes[i] !== 'object' || Array.isArray(nodes[i])) {
      continue;
    }

    color[i] = 1;
    posInStack[i] = stack.length;
    childCursor[i] = 0;
    stack.push(i);

    while (stack.length > 0) {
      const u = stack[stack.length - 1];
      const children = childrenByIndex[u];
      const cursor = childCursor[u];

      if (cursor < children.length) {
        childCursor[u] = cursor + 1;
        const v = children[cursor];
        if (color[v] === 0) {
          color[v] = 1;
          posInStack[v] = stack.length;
          childCursor[v] = 0;
          stack.push(v);
        } else if (color[v] === 1) {
          const startPos = posInStack[v];
          const cycleIndices = stack.slice(startPos);
          const cycleIds = cycleIndices.map((idx) => nodes[idx].id);
          // 旋转到最小下标节点开头以去重同一环路
          let minPos = 0;
          for (let k = 1; k < cycleIndices.length; k += 1) {
            if (cycleIndices[k] < cycleIndices[minPos]) minPos = k;
          }
          const canonical = [
            ...cycleIds.slice(minPos),
            ...cycleIds.slice(0, minPos),
          ];
          const key = canonical.join('->');
          if (!seenCycleKeys.has(key)) {
            seenCycleKeys.add(key);
            cycleMessages.push(`检测到循环依赖：${[...canonical, canonical[0]].join(' -> ')}。`);
          }
        }
      } else {
        stack.pop();
        posInStack[u] = -1;
        color[u] = 2;
      }
    }
  }

  return cycleMessages;
}

/* ---------- 严格拓扑序图校验（要求 deps 只指向数组中更早出现的节点） ---------- */
export function validateGraph(nodes, { allowEmpty = false } = {}) {
  if (!Array.isArray(nodes)) {
    return {
      ok: false,
      errors: [allowEmpty ? '节点列表必须是数组。' : '节点列表必须是非空数组。'],
    };
  }
  if (nodes.length === 0) {
    return allowEmpty
      ? { ok: true, errors: [] }
      : { ok: false, errors: ['节点列表必须是非空数组。'] };
  }

  const { errors, indexById } = validateNodeFields(nodes);

  nodes.forEach((n, i) => {
    if (!n || typeof n !== 'object' || Array.isArray(n) || !Array.isArray(n.deps)) return;
    const seenDeps = new Set();
    n.deps.forEach((dep, j) => {
      if (typeof dep !== 'string' || !dep.trim()) {
        errors.push(`nodes[${i}].deps[${j}] 无效。`);
        return;
      }
      if (seenDeps.has(dep)) {
        errors.push(`nodes[${i}] 包含重复依赖：${dep}。`);
        return;
      }
      seenDeps.add(dep);
      if (!indexById.has(dep)) {
        errors.push(`nodes[${i}] 依赖了不存在的节点：${dep}。`);
        return;
      }
      if (dep === n.id) {
        errors.push(`nodes[${i}] 不能依赖自身：${dep}。`);
        return;
      }
      if (indexById.get(dep) >= i) {
        errors.push(`nodes[${i}] 的依赖 ${dep} 不是更早出现的节点，违反拓扑序。`);
      }
    });
  });

  return { ok: errors.length === 0, errors };
}

/* ---------- 任意顺序有向无环图（DAG）校验与稳定拓扑排序 ---------- */
export function validateDag(nodes, { allowEmpty = true } = {}) {
  if (!Array.isArray(nodes)) {
    return {
      ok: false,
      errors: [allowEmpty ? '节点列表必须是数组。' : '节点列表必须是非空数组。'],
      sortedNodes: [],
    };
  }
  if (nodes.length === 0) {
    return allowEmpty
      ? { ok: true, errors: [], sortedNodes: [] }
      : { ok: false, errors: ['节点列表必须是非空数组。'], sortedNodes: [] };
  }

  const { errors, indexById } = validateNodeFields(nodes);
  const childrenByIndex = Array.from({ length: nodes.length }, () => []);
  const inDegree = new Int32Array(nodes.length);

  nodes.forEach((n, i) => {
    if (!n || typeof n !== 'object' || Array.isArray(n) || !Array.isArray(n.deps)) return;
    const seenDeps = new Set();
    n.deps.forEach((dep, j) => {
      if (typeof dep !== 'string' || !dep.trim()) {
        errors.push(`nodes[${i}].deps[${j}] 无效。`);
        return;
      }
      if (seenDeps.has(dep)) {
        errors.push(`nodes[${i}] 包含重复依赖：${dep}。`);
        return;
      }
      seenDeps.add(dep);
      if (dep === n.id) {
        errors.push(`nodes[${i}] 不能依赖自身（自环）：${dep}。`);
        return;
      }
      if (!indexById.has(dep)) {
        errors.push(`nodes[${i}] 依赖了不存在的节点：${dep}。`);
        return;
      }
      const depIdx = indexById.get(dep);
      if (depIdx !== undefined && indexById.get(n.id) === i) {
        childrenByIndex[depIdx].push(i);
        inDegree[i] += 1;
      }
    });
  });

  // 三色标记检测二元环、三元环及任意多元环
  const cycleErrors = detectCycleDescriptions(nodes, childrenByIndex);
  for (const msg of cycleErrors) {
    errors.push(msg);
  }

  if (errors.length > 0) {
    return { ok: false, errors, sortedNodes: [] };
  }

  // 稳定 Kahn 拓扑排序（最小堆按输入下标保序）
  const heap = [];
  for (let i = 0; i < nodes.length; i += 1) {
    if (inDegree[i] === 0) pushMinHeap(heap, i);
  }

  const sortedNodes = [];
  while (heap.length > 0) {
    const u = popMinHeap(heap);
    const node = nodes[u];
    sortedNodes.push({
      ...node,
      deps: [...node.deps],
    });
    for (const v of childrenByIndex[u]) {
      inDegree[v] -= 1;
      if (inDegree[v] === 0) {
        pushMinHeap(heap, v);
      }
    }
  }

  if (sortedNodes.length !== nodes.length) {
    return {
      ok: false,
      errors: [...errors, '检测到有向图存在循环依赖，无法完成拓扑排序。'],
      sortedNodes: [],
    };
  }

  return { ok: true, errors: [], sortedNodes };
}

/* ---------- 校验并返回稳定拓扑序节点数组 ---------- */
export function topologicalSortNodes(nodes) {
  const result = validateDag(nodes, { allowEmpty: true });
  if (!result.ok) {
    throw createGraphError(`图结构校验失败：${result.errors.join(' ')}`, result.errors);
  }
  return result.sortedNodes;
}

/* ---------- 图计算：S（传递承重节点数）与 d（最短依赖深度） ---------- */
export function computeGraph(nodes) {
  const sorted = topologicalSortNodes(nodes);
  const count = sorted.length;
  if (count === 0) return [];

  const idToIdx = new Map();
  for (let i = 0; i < count; i += 1) {
    idToIdx.set(sorted[i].id, i);
  }

  const kidsIdx = Array.from({ length: count }, () => []);
  const parentCount = new Int32Array(count);
  for (let i = 0; i < count; i += 1) {
    const deps = sorted[i].deps;
    parentCount[i] = deps.length;
    for (let j = 0; j < deps.length; j += 1) {
      const p = idToIdx.get(deps[j]);
      kidsIdx[p].push(i);
    }
  }

  // 最短依赖深度：已按拓扑序排列，一趟扫描即可
  const depthArr = new Int32Array(count);
  for (let i = 0; i < count; i += 1) {
    const deps = sorted[i].deps;
    if (deps.length === 0) {
      depthArr[i] = 0;
    } else {
      let minD = 0x7fffffff;
      for (let j = 0; j < deps.length; j += 1) {
        const p = idToIdx.get(deps[j]);
        if (depthArr[p] + 1 < minD) minD = depthArr[p] + 1;
      }
      depthArr[i] = minD;
    }
  }

  // 承重数 S：紧凑 Uint32Array 位图求传递闭包不同后代总数（支持万级长链与多路径汇合菱形 DAG）
  const wordsPerNode = (count + 31) >>> 5;
  const remainingParents = new Int32Array(parentCount);
  const descBits = new Array(count).fill(null);
  const bitsetPool = [];
  const weightS = new Int32Array(count);

  for (let u = count - 1; u >= 0; u -= 1) {
    const children = kidsIdx[u];
    if (children.length === 0) {
      weightS[u] = 0;
      continue;
    }

    const bits = bitsetPool.length > 0 ? bitsetPool.pop() : new Uint32Array(wordsPerNode);
    for (let k = 0; k < children.length; k += 1) {
      const c = children[k];
      bits[c >>> 5] |= 1 << (c & 31);
      const childBits = descBits[c];
      if (childBits !== null) {
        for (let w = 0; w < wordsPerNode; w += 1) {
          bits[w] |= childBits[w];
        }
        remainingParents[c] -= 1;
        if (remainingParents[c] === 0) {
          childBits.fill(0);
          bitsetPool.push(childBits);
          descBits[c] = null;
        }
      }
    }

    let totalDescendants = 0;
    for (let w = 0; w < wordsPerNode; w += 1) {
      if (bits[w] !== 0) {
        totalDescendants += popcount32(bits[w]);
      }
    }
    weightS[u] = totalDescendants;

    if (parentCount[u] > 0) {
      descBits[u] = bits;
    } else {
      bits.fill(0);
      bitsetPool.push(bits);
    }
  }

  return sorted.map((n, idx) => ({
    ...n,
    deps: [...n.deps],
    S: weightS[idx],
    d: depthArr[idx],
    depsOf: [...n.deps],
  }));
}

/* ---------- 坍塌判定：存活依据严格少于原先一半（< 0.5）才坍塌，恰好一半（=== 0.5）继续存活 ---------- */
export function collapseAfter(removed, graph) {
  if (!Array.isArray(graph)) {
    throw createGraphError('collapseAfter 的 graph 参数必须是节点数组。', ['graph 必须是数组。']);
  }
  const initial = removed == null
    ? []
    : (Array.isArray(removed) || removed instanceof Set ? removed : [...removed]);
  const dead = new Set(initial);
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < graph.length; i += 1) {
      const n = graph[i];
      const deps = n.deps;
      if (dead.has(n.id) || !deps.length) continue;
      let alive = 0;
      for (let k = 0; k < deps.length; k += 1) {
        if (!dead.has(deps[k])) alive += 1;
      }
      if (alive / deps.length < 0.5) {
        dead.add(n.id);
        changed = true;
      }
    }
  }
  return dead;
}

/* ---------- 亮度（星等公式）：与 frontend-design/web/src/starfield.js 逐位一致 ---------- */
export function brightness(graph) {
  if (!Array.isArray(graph) || graph.length === 0) return [];
  const g = graph.every((n) => n && typeof n.S === 'number' && Number.isFinite(n.S))
    ? graph
    : computeGraph(graph);

  const raw = g.map((n) => {
    const m = 6.2 - 2.5 * Math.log10(1 + n.S);      // 承重越大，星等越小
    return Math.pow(10, -0.4 * (m - 1.2));          // 到达眼睛的亮度
  });
  const max = raw.reduce((a, v) => Math.max(a, v), 0) || 1;
  const x = raw.map((v) => v / max);                // 归一到 0..1

  const sorted = [...x].sort((a, b) => a - b);
  const med = sorted[Math.floor(sorted.length / 2)] || 1e-6;

  // 求 γ 使 P50 落在 0.18：0.04 + 0.96·med^γ = 0.18
  let gamma = Math.log(0.1458) / Math.log(med);
  if (!Number.isFinite(gamma) || gamma <= 0) gamma = 1;

  const map = (v) => Math.min(1, Math.max(0.04, 0.04 + 0.96 * Math.pow(v, gamma)));
  let L = x.map(map);

  // 分位强制：L>0.5 的星不得超过 8%。用秩映射，而不是整体缩放。
  const sortedL = [...L].sort((a, b) => a - b);
  const cut = Math.floor(0.92 * L.length);
  const q = sortedL[cut];
  const top = sortedL[sortedL.length - 1];
  if (q < 1 && top > 0.5) {
    L = L.map((v) =>
      v <= q ? Math.min(v, 0.499) : 0.5 + 0.5 * ((v - q) / (top - q || 1))
    );
  }
  return L;
}
