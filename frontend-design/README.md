# 前端设计模块

本目录是「报价 / QUOTATION」的正式前端。

正式版在 [本机 3006 首页](http://127.0.0.1:3006/) 使用 `web/index.html` 的星球封面、昼夜主题和三维画布。通过前置登录页完成知乎官方授权后，封面上的「开始观点交锋」会取回工作台选出的三个观点。「我的知识星图」展示授权画像与已结算对局中的知识点，点击星点可以展开出处。工作台连接、模型和知乎搜索配置见 [工作台说明](../agent/README.md)。

同一份前端在静态预览与合成演示模式下提供以下视图。

- **封面（第 0 屏）**：白天 Neumorphism，夜晚 Liquid Glass，右上角切换主题；提供「使用演示账号」与「绑定知乎 · 即将开放」两个入口。
- **信息页（第 1 屏）**：进入演示账号后，星球缩小并居中，显示「YOUR MIND GALAXY」、账号与判断数量。
- **Mind Galaxy（第 2 屏）**：点击信息页的星球进入 30 条判断的三维星图；星球先坍缩成黑洞、周围内容螺旋吸入后再展开星图（白天与夜晚一致；减少动画时直接扩圈）。拖动转视角，WASD／方向键移动，Shift 加速；点击节点查看原话、承重与依赖关系。
- **承重分析（信息页下滑）**：承重损失率、受影响判断、改写对比；可切换「换语气」与「缩小范围」。

原四屏演示 `src/demo.js` 仍保留作参考；新的封面、信息页、星图与承重分析分别在 `cover.js` / `galaxy.js` / `analysis.js`。

## 目录

```text
frontend-design/
├─ web/
│  ├─ index.html                 # 唯一入口：封面
│  └─ src/
│     ├─ cover.js                # 封面/信息页交互、主题切换、玻璃折射
│     ├─ galaxy.js               # 三维星图：布局、投影、漫游、节点卡
│     ├─ analysis.js             # 承重账单、受影响判断与改写对比
│     ├─ assets/black-hole.webp  # 入场黑洞素材（本地生成）
│     ├─ theme.css               # 白天 / 夜晚两套 token
│     ├─ cover.css               # 封面布局与材质
│     ├─ demo.js                 # 原四屏逻辑（待接入）
│     ├─ quotation-case.js       # 30 条判断、三个改写版本与 quote()
│     ├─ starfield.js            # 承重 → 亮度 / 半径 / 辉光
│     ├─ structure-layout.js     # 结构态布局
│     ├─ structure-morph.js      # 形变量与相机插值
│     └─ verify/                 # P0–P2 验收脚本
├─ archive/2026-11-21-web/       # 旧版快照，不部署、不被引用
└─ shots/                        # 截图、视频与 PDF 预览
```

## 静态设计预览

```powershell
python -m http.server 5173 --bind 127.0.0.1 --directory frontend-design/web
```

打开 <http://127.0.0.1:5173/>。封面默认白天；点右上角太阳／月亮切换，选择会记住。也可以直接用 `?theme=dark` 打开夜晚版。

## 材质与交互

- 白天：Neumorphism，不透明软阴影。
- 夜晚：Liquid Glass，半透明、背景模糊、边缘折射（SVG `feDisplacementMap`）；不支持该滤镜的浏览器回退为普通磨砂。
- 主题切换以按钮为圆心做 `clip-path: circle()` 扩散；系统开启“减少动画”时直接切换。
- 封面 → 信息页使用 View Transition：星球作为共享元素缩小，其余内容淡入淡出。
- 信息页左上角箭头回到封面；星图左下角返回。Esc 先关闭节点卡，再退出星图，再回到封面。
- Mind Galaxy 使用自研 canvas 透视投影，星图始终为深空配色；拖动／WASD 漫游，点击节点打开信息卡。
- 星图有缓慢呼吸：星尘盘自转、节点与背景星独立相位闪烁、整图轻微膨胀收缩；系统开启“减少动画”时静止。
- 进入星图：星球收缩成黑洞，顶栏与信息页内容螺旋吸入，随后星图从黑洞中心扩圈展开；白天与夜晚一致，减少动画时直接扩圈。
- 黑洞素材 `assets/black-hole.webp` 由本机 ComfyUI（Z-Image）生成，1024 源图转为 22KB WebP。
- 信息页下滑进入承重分析；账单与改写卡片白天为 Neumorphism，夜晚为 Liquid Glass，滚动时淡入。
- 右上角 `?` 打开说明面板，点外部或按 Esc 关闭。

## 验收脚本

```powershell
node web/src/verify/verify-p0.mjs
node web/src/verify/verify-p1.mjs
node web/src/verify/verify-p2.mjs
```

## 已知限制

- 静态预览中的「绑定知乎」是设计占位。正式版从工作台连接已有账号。
- 改写版本 `scope` 当前为 0%，展示的是“不撞承重墙”的极端情况。
- 静态预览使用 `quotation-case.js` 中的示例。真实选题与知识星图需要启动上述工作台服务。
- 鼠标视角目前是按住拖动，未启用 Pointer Lock；手机端为拖动转视角、点击节点。

## 归档

`archive/2026-11-21-web/` 冻结了整理前的旧入口（`index.html`、`index-v2.html`、`index-v3.html`）及其脚本、样式与演示数据。归档目录不作为站点发布。
