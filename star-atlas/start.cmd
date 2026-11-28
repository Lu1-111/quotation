@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [Star Atlas] 正在启动正式版工作台与 3D 星图服务...
echo [Star Atlas] 工作台入口：http://127.0.0.1:3300/workbench
echo [Star Atlas] 星图首页：  http://127.0.0.1:3300/
echo.
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://127.0.0.1:3300/workbench"
node --env-file-if-exists=..\.env --env-file-if-exists=.env src\server.mjs
echo.
echo [Star Atlas] 服务已停止。
pause
