# 算价引擎输出格式与协议说明

本文定义 `quotation-engine` 对 `agent/` 会话服务与 `frontend-design/` 界面交付的纯 JSON 数据契约。所有示例均为合成演示数据，不包含真实用户会话或外部私有材料。

- 单句报价 Schema：[quote-v1.schema.json](schemas/quote-v1.schema.json)
- 单句报价合成样例：[quote-v1.json](examples/quote-v1.json)
- 前端独立消费完整样例（星图 + 账单 + 改写对照）：[frontend-consume-sample.json](examples/frontend-consume-sample.json)

## 1. 核心数学规则

1. **有向无环判断图（DAG）**：
   - 每个节点包含 `id`（非空唯一字符串）、`text`（非空判断原文）、`cluster`（非空字符串或有限数字）、`deps`（直接依赖的支撑节点 ID 数组，无重复、无自环、无悬空引用、无有向环）。
   - 若输入节点尚未按拓扑序排列，`validateDag` / `topologicalSortNodes` 采用按原始下标保序的最小堆 Kahn 算法输出唯一确定性的拓扑序；若输入原本已是合法拓扑序，节点顺序保持完全不变。
2. **传递承重数 `S` 与最短依赖深度 `d`**：
   - `S`：全图中直接或间接依赖该节点的不同下游节点总数（传递闭包基数）。叶节点的 `S = 0`。
   - `d`：到任一根节点（`deps = []`）的最短有向路径步数；根节点的 `d = 0`。
3. **过半失效级联坍塌（`collapseAfter`）**：
   - 初始失效集合为经证据核验的直接冲突节点 `directConflicts`。
   - 迭代检查其余有依赖节点：设某节点原有 `k = deps.length` 个直接依据，当前仍存活 `alive` 个。当且仅当 **`alive / k < 0.5`** 时该节点连带坍塌；**恰好保留一半依据（`alive / k === 0.5`，如双依据损一 `1/2`、四依据损二 `2/4`）的节点继续成立**。
4. **结构影响比例 `rate`**：
   - 分子 `numerator` = 全部受影响节点（`affected = directConflicts ∪ collateral`）的 `S` 之和。
   - 分母 `denominator` = 当前已确认全图所有节点的 `S` 之和。
   - 当 `denominator > 0` 时，冲突句子的 `rate = Math.round((100 * numerator) / denominator)`（先对分子乘 `100` 再除以分母四舍五入，避免浮点先除后乘导致 `23/40` 误舍为 `57`）。

> **禁用说明**：旧演示中的 `conflictSet()` 按信念簇自动挑选最大坍塌节点，不代表任何具体句子的语义冲突，不得用于句子算价。

## 2. 判断结论与数值组合表（`evaluateStatementQuote`）

| `assessment` | 全图分母 `denominator` | 直接冲突类型 | `rate` 输出 | `directConflicts` / `collateral` / `affected` | 说明 |
| --- | --- | --- | --- | --- | --- |
| `insufficient_evidence` | 任意（`>= 0`） | 无已核验冲突 | `null` | 全部为 `[]`，`numerator = 0` | 证据不足维持未定，严禁预设降分或伪造 `0` |
| `compatible` | `> 0` | 无冲突 | `0` | 全部为 `[]`，`numerator = 0` | 与当前已确认图相容 |
| `compatible` | `0`（空图或全孤立点） | 无冲突 | `null` | 全部为 `[]`，`numerator = 0` | 尚无承重边可供折算结构比例 |
| `conflict` | `> 0` | 含承重节点（`numerator > 0`） | `0..100` 整数 | 保留实际直接冲突与级联坍塌节点 | 标准承重冲突算价 |
| `conflict` | `> 0` | 仅叶节点冲突（`S = 0`） | `0` | **完整保留 `directConflicts` 与 `affected`**，`numerator = 0` | 比例为 `0` 仍须向用户展示实际冲突的叶节点 |
| `conflict` | `0`（全孤立稀疏图） | 任意节点冲突 | `null` | **完整保留 `directConflicts` 与 `affected`**，`numerator = 0` | 给出明确冲突理由与冲突节点，比例留空 |

## 3. 单句报价字段契约（`quote-v1`）

| 字段 | 类型 | 含义与消费要求 |
| --- | --- | --- |
| `statementId` | `string` | 句子版本稳定 ID（如 `stmt_original`、`stmt_rewrite_scope`） |
| `text` | `string` | 被评估的原话或改写全文 |
| `graphVersion` | `integer` | 所绑定的已确认图版本号；图更新后须递增并重算 |
| `assessment` | `string` | `'conflict' \| 'compatible' \| 'insufficient_evidence'` |
| `rate` | `integer \| null` | `0..100` 或 `null`；前端遇到 `null` 应显示“未定 / 暂无承重比例”而非 `0%` |
| `directConflicts` | `string[]` | 直接冲突节点 ID 数组（传不存在的节点默认抛 `INVALID_CONFLICT_NODE`） |
| `collateral` | `string[]` | 因失去过半依据而连带失效的节点 ID 数组 |
| `affected` | `string[]` | `directConflicts` 与 `collateral` 合并后的受影响节点 ID 数组 |
| `numerator` | `integer` | 受影响节点 `S` 之和 |
| `denominator` | `integer` | 全图节点 `S` 之和 |
| `reason` | `string` | 总体判断说明 |
| `conflictReasons` | `Array<string \| object>` | 逐项直接冲突原因及证据 ID 引用 |
| `verifiedEvidenceIds` | `string[]` | 本次评估依赖的已核验证据 ID 列表 |
| `interpretationNote` | `string` | 固定为 `RATE_INTERPRETATION_NOTE`，界面须展示或提示该口径边界 |

## 4. 同图多版本改写对照（`compareStatementsOnGraph`）

`compareStatementsOnGraph({ graph, graphVersion, statements, baselineStatementId })` 将原句与所有改写锁定在**同一张已确认图、同一 `graphVersion` 与同一 `denominator`** 上统一重算，避免跨图版本比较失真：

- `quotes`：按输入顺序排列的 `quote-v1` 数组。
- `baselineStatementId`：基准原句 ID（显式指定、标记 `role: 'original'` / `isBaseline: true`，或默认取首项）。
- `comparisons`：每个改写相对基准原句的差异摘要：
  - `deltaRate`：`rate - baselineRate`（例如从 `80` 降到 `0` 时为 `-80`；任一方 `assessment === 'insufficient_evidence'` 或 `rate === null` 时为 `null`）。
  - `resolvedConflicts` / `resolvedAffected`：仅当基准句与改写句在同一 `graphVersion` 上均具备非 `insufficient_evidence` 的已核验结论时，原句存在而改写已消除的直接冲突节点与受影响节点 ID；若任一方为 `insufficient_evidence`（无充分依据未定），一律为 `[]`，不得将未核验改写标为已解决冲突。
  - `addedConflicts` / `addedAffected`：改写经核验新引入的直接冲突节点与受影响节点 ID（改写为 `insufficient_evidence` 时为 `[]`）。
  - `assessmentChanged`：定性结论是否较原句发生变化。

## 5. 标准复核算例

设已确认图包含 5 个节点：`A` 支撑 `B`（`B.deps=['A']`），`B` 支撑 `C`（`C.deps=['B']`），另有 `D` 支撑 `E`（`E.deps=['D']`）：

- 各节点承重 `S`：`A=2, B=1, C=0, D=1, E=0`，全图分母 `denominator = 4`。
- 句子 1 仅直接冲突于 `B`：`C` 连带坍塌，受影响集合 `['B', 'C']`，分子 `1`，报价 `round(100 × 1 / 4) = 25`。
- 句子 2 仅直接冲突于 `A`：`B`、`C` 连带坍塌，受影响集合 `['A', 'B', 'C']`，分子 `3`，报价 `round(100 × 3 / 4) = 75`。
