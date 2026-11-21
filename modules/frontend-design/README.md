# 前端设计模块

本目录收纳原仓库的 `web/` 与 `shots/`，用于前端演示、设计素材和效果预览。

```text
frontend-design/
├─ web/       页面、JavaScript、样式、图片与演示数据
└─ shots/     截图、视频及 PDF 预览
```

此次仅调整目录位置，原有文件内容保持原样。后续前端设计变更提交到本目录。

将 `web/` 作为静态 HTTP 站点根目录即可预览。例如已安装 Python 时，可在仓库根目录执行：

```powershell
python -m http.server 5173 --bind 127.0.0.1 --directory modules/frontend-design/web
```

然后打开 <http://127.0.0.1:5173/>。页面使用相对路径，不能将数据采集模块的 `/history` 页面与本模块的演示页面混为同一入口。

确定性演示数据生成脚本原注释中的命令，需在本模块目录执行：

```powershell
cd modules/frontend-design
node web/src/gen.mjs
```

生成脚本会更新本目录下的前端演示数据，运行前应先检查差异并确认变更用途。
