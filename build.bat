@echo off
cd /d "%~dp0"

echo ========================================
echo Aether Streaming Build Script
echo ========================================

net session >nul 2>&1
if errorlevel 1 goto NOT_ADMIN

echo Checking Node.js installation...
set PATH=%PATH%;C:\Program Files\nodejs
where npm >nul 2>&1
if errorlevel 1 goto NO_NPM

echo Installing dependencies...
call npm install
if errorlevel 1 goto ERROR_INSTALL

echo Erhoehe Versionsnummer...
call npm version patch --no-git-tag-version

echo Raeume alte Setup-Dateien auf...
if exist dist\*.exe del /Q dist\*.exe >nul 2>&1
if exist dist\*.blockmap del /Q dist\*.blockmap >nul 2>&1

echo Checking for GitHub Token...
if not exist github_token.txt goto NO_TOKEN

echo Token gefunden! Starte Build und lade Release auf GitHub hoch...
set /p GH_TOKEN=<github_token.txt

echo.
echo ==============================================================
echo GIB EIN KURZES UPDATE-PROTOKOLL EIN (oder druecke Enter fuer Standard):
set /p RELEASE_NOTES="Neu in dieser Version: "
if "%RELEASE_NOTES%"=="" set RELEASE_NOTES=Allgemeine Verbesserungen und Fehlerbehebungen.
echo %RELEASE_NOTES% > release-notes.md
echo ==============================================================
echo.

call npm run publish
goto AFTER_BUILD

:NO_TOKEN
echo Kein github_token.txt gefunden. Baue nur lokales Setup (kein Upload)...
call npm run build

:AFTER_BUILD

if errorlevel 1 goto ERROR_BUILD

echo.
echo ========================================
echo BUILD SUCCESSFUL!
echo You can find your Setup.exe in the 'dist' folder.
echo ========================================
pause
exit /b

:NOT_ADMIN
echo.
echo ==============================================================
echo FEHLER: KEINE ADMINISTRATOR-RECHTE!
echo ==============================================================
echo Bitte mache einen Rechtsklick auf "build.bat" und waehle
echo "Als Administrator ausfuehren", damit das Setup
echo erfolgreich gebaut werden kann.
echo.
pause
exit /b

:NO_NPM
echo.
echo ==============================================================
echo FEHLER: NODE.JS NICHT GEFUNDEN!
echo ==============================================================
echo Node.js (npm) wurde nicht gefunden. Bitte installiere Node.js.
echo Wenn du es gerade erst installiert hast, starte deinen PC neu!
echo.
pause
exit /b

:ERROR_INSTALL
echo.
echo ========================================
echo NPM INSTALL FAILED!
echo ========================================
pause
exit /b

:ERROR_BUILD
echo.
echo ========================================
echo BUILD FAILED! Check the output above for errors.
echo ========================================
pause
exit /b
