@echo off
setlocal
cd /d "%~dp0"

where py >nul 2>nul
if %errorlevel%==0 (
  py serve.py --open
  goto :eof
)

where python >nul 2>nul
if %errorlevel%==0 (
  python serve.py --open
  goto :eof
)

echo.
echo 未找到 Python。请用任意静态服务器托管本文件夹，或参考 README 的 Netlify Drop / GitHub Pages 部署方式。
echo Web Bluetooth 需要 HTTPS；在电脑上调试时 Android 手机可通过 adb reverse 访问 localhost。
echo.
pause
