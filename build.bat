@echo off
setlocal
cd /d "%~dp0"

echo ===== Sborka Pi Desktop =====
echo.

where npm >nul 2>nul
if errorlevel 1 (
  echo OSIBKA: npm ne nayden v PATH. Ustanovi Node.js ili dodaj ego v PATH.
  pause
  exit /b 1
)

call npm run release:update
if errorlevel 1 (
  echo.
  echo ===== Sborka ne udalas. Smot tekst vyse. =====
  pause
  exit /b 1
)

echo.
echo ===== Gotovo: release\Pi Desktop\app\Pi Desktop.exe =====
pause
