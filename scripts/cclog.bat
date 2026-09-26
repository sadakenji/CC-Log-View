@echo off
REM Open the project's ChatLog.html in Chrome
for /f "delims=" %%i in ('node "%USERPROFILE%\.claude\scripts\cclogview.js" --print-dir') do (
	set LOGDIR=%%i
)
call ch --window-name="CCLOG" "%LOGDIR%\ChatLog.html"
