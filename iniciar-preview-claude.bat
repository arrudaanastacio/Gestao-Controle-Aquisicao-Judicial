@echo off
cd /d "%~dp0backend"
if not defined PORT set PORT=3099
node src/server.js
