@echo off
chcp 65001 >nul
if not exist "%~dp0dist\desktop-player\视频记忆助手\一键启动.exe" (
  echo 请先完整解压发布包，再运行其中的一键安装到浏览器.cmd。
  pause
  exit /b 1
)
start "" "%~dp0dist\desktop-player\视频记忆助手\一键启动.exe" --install-browser
