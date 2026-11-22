# 前端设计模块

本目录是「报价 / QUOTATION」四屏演示的正式前端，以及旧版归档。

## 目录

```text
frontend-design/
├─ web/                          # 唯一正式站点
│  ├─ index.html                 # 唯一入口
│  └─ src/
│     ├─ demo.js                 # 四屏逻辑：报价计算 + 星空⇄结构形变
│     ├─ quotation-case.js       # 30 条判断、三个改写版本与 quote()
│     ├─ starfield.js            # 承重 → 亮度 / 半径 / 辉光
│     ├─ structure-layout.js     # 结构态布局
│     ├─ structure-morph.js      # 形变量与相机插值
│     └─ verify/                 # P0–P2 验收脚本（Node 运行）
├─ archive/2026-11-21-web/       # 旧版快照，不部署、不被引用
└─ shots/                        # 截图、视频与 PDF 预览
```

`archive/` 里的旧页面保持完整可运行，仅作留档；正式站点只使用 `web/`，改动前端请以 `web/index.html` 为唯一入口。

## 本地预览

将 `web/` 作为静态 HTTP 站点根目录即可，无需安装依赖：

```powershell
python -m http.server 5173 --bind 127.0.0.1 --directory frontend-design/web
```

打开 <http://127.0.0.1:5173/>。页面使用相对路径。

## 验收脚本

在模块目录执行，常规测试不需要浏览器或网络：

```powershell
node web/src/verify/verify-p0.mjs
node web/src/verify/verify-p1.mjs
node web/src/verify/verify-p2.mjs
```

## 已知限制

- 当前 `web/index.html` 为桌面尺寸设计，没有移动端断点，也没有打印样式；旧版的响应式与打印规则只存在于 `archive/`。
- 页面数据来自 `quotation-case.js` 的合成示例，尚未接入 `information-search/` 或数据采集模块。

## 归档

`archive/2026-11-21-web/` 冻结了整理前的 4 个旧入口（`index.html`、`index-v2.html`、`index-v3.html`、`index3.html`）及其脚本、样式与演示数据。其中 `index3.html` 与 `index-v3.html` 内容完全相同。归档目录不作为站点发布。
