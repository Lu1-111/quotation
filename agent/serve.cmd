@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo 正在启动知乎数据工作台（关闭本窗口即停止）...
echo.
node --env-file-if-exists=..\..\.env --env-file-if-exists=.env web.mjs --port 3210
echo.
echo 服务已停止。
pause
