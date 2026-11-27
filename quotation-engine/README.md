# 算价引擎模块（`quotation-engine`）

`quotation-engine` 是「报价」项目的零依赖纯函数算价与图结构校验引擎。它接收**经本人确认的有向无环判断图（DAG）**与**有已核验证据支撑的直接冲突集合**，确定性地计算每个判断节点的传递承重数 `S`、最短依赖深度 `d`、过半失效级联坍塌集合、星等亮度以及单句／多改写同图对照账单。

## 设计边界与禁用旧口径说明

- **零外部运行依赖**：仅使用 Node.js 24+ 标准语法与内置测试运行器（`node --test`），不包含 HTTP 服务、模型调用、会话数据库或浏览器渲染逻辑。
- **严禁用图结构反推句子冲突**：历史原型中的 `conflictSet()` / `price()` 按每个信念簇挑“破坏力最大”的节点，属于无输入句子的静态演示启发式，**已从本引擎正式移除，绝对不能用于判断具体一句话的冲突**。一句话是否与某个节点冲突，必须由上层基于已核验证据传入 `directConflicts`。
- **判断与数值严格分离**：定性结论 `assessment`（`conflict` / `compatible` / `insufficient_evidence`）与结构比例 `rate`（`0..100` 整数或 `null`）分开表达：
  - 无充分证据时保持 `insufficient_evidence` 且 `rate: null`，不做预设降分。
  - 仅冲突于承重 `S = 0` 的叶节点时，`assessment: "conflict"`、`rate: 0`，但仍完整保留并返回 `directConflicts`。
  - 全图无边（分母 `denominator = 0`）却存在已核验冲突时，`assessment: "conflict"`、`rate: null`，保留冲突节点与冲突理由。
- **固定解释边界**：所有报价固定附带 `RATE_INTERPRETATION_NOTE`——*“数值仅解释当前已确认图上的承重结构影响比例，不能作为授权者会被说服的概率。”*

## 目录结构

```text
quotation-engine/
├─ index.mjs                          # 统一对外导出入口
├─ package.json                       # Node.js >=24，零第三方依赖
├─ README.md                          # 模块说明与快速上手
├─ OUTPUT_FORMAT.md                   # 输出协议、字段语义与算例说明
├─ engine/
│  ├─ starfield.mjs                   # DAG 校验、稳定拓扑排序、承重 S、深度 d、坍塌与星等亮度
│  └─ quotation.mjs                   # 基础算价、协议化单句算价与同图多版本改写比较
├─ schemas/
│  └─ quote-v1.schema.json            # 单句报价与对照结构 JSON Schema（2020-12）
├─ examples/
│  ├─ quote-v1.json                   # 单句报价合成示例
│  └─ frontend-consume-sample.json    # 含星图节点、承重账单与原句/双改写同图对比的完整前端消费样例
└─ test/
   └─ engine.test.mjs                 # 数学基准、边界情况、环检测与前端逐位一致性测试
```

## 运行测试

```bash
cd quotation-engine
npm test
```

## 导出接口速览

统一从 [index.mjs](index.mjs) 导出：

| 名称 | 来源文件 | 用途 |
| --- | --- | --- |
| `validateGraph(nodes, { allowEmpty })` | [starfield.mjs](engine/starfield.mjs) | 严格拓扑序图结构校验（要求依赖仅指向更早出现的节点） |
| `validateDag(nodes, { allowEmpty })` | [starfield.mjs](engine/starfield.mjs) | 任意顺序有向无环图校验（检测自环/二元环/多元环/悬空引用/重复依赖）并返回稳定 `sortedNodes` |
| `topologicalSortNodes(nodes)` | [starfield.mjs](engine/starfield.mjs) | 校验并返回稳定拓扑序节点数组；非法时抛 `code = 'INVALID_GRAPH'` 错误 |
| `computeGraph(nodes)` | [starfield.mjs](engine/starfield.mjs) | 计算每个节点的传递承重数 `S`、最短依赖深度 `d` 与 `depsOf` |
| `collapseAfter(removed, graph)` | [starfield.mjs](engine/starfield.mjs) | 级联坍塌计算：存活依据 `< 0.5` 坍塌，`=== 0.5` 继续成立 |
| `brightness(graph)` | [starfield.mjs](engine/starfield.mjs) | 与前端 [starfield.js](../frontend-design/web/src/starfield.js) 逐位一致的星等亮度函数 |
| `quote(graph, conflicts)` | [quotation.mjs](engine/quotation.mjs) | 底层兼容算价纯函数（返回 `{ conflicts, dead, collapsed, lost, total, rate }`） |
| `evaluateStatementQuote(options)` | [quotation.mjs](engine/quotation.mjs) | 协议化单句报价，遵循 `quote-v1` 契约 |
| `compareStatementsOnGraph(options)` | [quotation.mjs](engine/quotation.mjs) | 锁定同一张已确认图、同一 `graphVersion` 与同一分母批量重算并对比原句与改写 |
| `RATE_INTERPRETATION_NOTE` | [quotation.mjs](engine/quotation.mjs) | 结构影响比例口径说明常量 |
| `ASSESSMENTS` / `PROTOCOL_VERSION` / `QUOTE_SCHEMA_VERSION` | [quotation.mjs](engine/quotation.mjs) | 与 `agent/protocol.mjs` 对齐的协议枚举与版本常量 |

详细字段契约与边界规则见 [OUTPUT_FORMAT.md](OUTPUT_FORMAT.md)。
