@echo off
setlocal
call "%~dp0build-and-start.bat" --stop
exit /b %ERRORLEVEL%
