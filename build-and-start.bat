@echo off
setlocal
chcp 65001 >nul
if not defined ELEVATOR_WSL_DISTRO set "ELEVATOR_WSL_DISTRO=Ubuntu"
set "WSLENV=%WSLENV%:ELEVATOR_PREVIEW_PORT:ELEVATOR_NO_BROWSER"
where wsl.exe >nul 2>&1
if errorlevel 1 (
  echo WSL is required. Install Ubuntu with: wsl --install -d Ubuntu
  pause
  exit /b 1
)
wsl.exe -d %ELEVATOR_WSL_DISTRO% --cd "%~dp0." --exec bash ./ci/dev/build-preview.sh %*
set "RESULT=%ERRORLEVEL%"
if not "%RESULT%"=="0" echo Command failed. See the error above and the WSL build log.
if not defined ELEVATOR_NO_PAUSE pause
exit /b %RESULT%
