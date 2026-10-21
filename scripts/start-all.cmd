@echo off
rem Double-click to start NexLink. Arguments are passed through, e.g.  start-all.cmd -NoAI
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-all.ps1" %*
pause
