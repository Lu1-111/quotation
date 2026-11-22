# 前端设计模块

本目录是「报价 / QUOTATION」的正式前端。

当前 `web/index.html` 是封面（第 0 屏）：白天 Neumorphism，夜晚 Liquid Glass，右上角可切换主题。绑定知乎、Mind Galaxy 与成本账单在后续阶段接入；原四屏逻辑保留在 `src/demo.js`，尚未挂到新入口。

## 目录

```text
frontend-design/
├─ web/
│  ├─ index.html                 # 唯一入口：封面
│  └─ src/
│     ├─ cover.js                # 主题切换、说明面板、玻璃折射
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

## 本地预览

```powershell
python -m http.server 5173 --bind 127.0.0.1 --directory frontend-design/web
```

打开 <http://127.0.0.1:5173/>。封面默认白天；点右上角太阳／月亮切换，选择会记住。也可以直接用 `?theme=dark` 打开夜晚版。

## 材质与交互

- 白天：Neumorphism，不透明软阴影。
- 夜晚：Liquid Glass，半透明、背景模糊、边缘折射（SVG `feDisplacementMap`）；不支持该滤镜的浏览器回退为普通磨砂。
- 主题切换以按钮为圆心做 `clip-path: circle()` 扩散；系统开启“减少动画”时直接切换。
- 右上角 `?` 打开说明面板，点外部或按 Esc 关闭。

## 验收脚本

```powershell
node web/src/verify/verify-p0.mjs
node web/src/verify/verify-p1.mjs
node web/src/verify/verify-p2.mjs
```

## 已知限制

- 登录入口目前是占位：演示账号只提示，绑定知乎待后端接入。
- 星图、成本账单、改写对比尚未接到新封面；原实现保留在 `src/demo.js`。
- 页面数据仍是 `quotation-case.js` 的合成示例，尚未接入数据采集或搜索模块。
- 漫游（WASD／鼠标视角）与移动端触控方案在下一阶段实现。

## 归档

`archive/2026-11-21-web/` 冻结了整理前的旧入口（`index.html`、`index-v2.html`、`index-v3.html`）及其脚本、样式与演示数据。归档目录不作为站点发布。
