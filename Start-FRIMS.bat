@echo off
REM Double-click to run FRIMS on Windows. Needs Node.js 20+ (https://nodejs.org).
cd /d "%~dp0"
where node >nul 2>nul || (echo Node.js is not installed. Install the LTS version from https://nodejs.org and run this again. & pause & exit /b 1)
if not exist node_modules (echo Installing dependencies, please wait... & call npm install --no-audit --no-fund)
start "" http://localhost:3000
echo FRIMS is starting. Close this window to stop the server.
call npm start
pause
