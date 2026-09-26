@echo off
for /f "delims=" %%i in ('node %HOME%\.claude\scripts\cclogview.js --print-dir') do (
	set LOGDIR=%%i
)
ch --window-name="CCLOG" %LOGDIR%\ChatLog.html
