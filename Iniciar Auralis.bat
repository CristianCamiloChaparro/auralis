@echo off
setlocal
chcp 65001 >nul
title Auralis
cd /d "%~dp0"

echo.
echo   ===================================
echo     Auralis - descarga video y audio
echo   ===================================
echo.

rem ---------- ¿Ya está abierta? ----------
powershell -NoProfile -Command "try { Invoke-WebRequest -UseBasicParsing http://localhost:3000/api/config -TimeoutSec 2 | Out-Null; exit 0 } catch { exit 1 }" >nul 2>nul
if not errorlevel 1 (
  echo   Auralis ya está abierta. Abriendo el navegador...
  start "" http://localhost:3000
  timeout /t 3 >nul
  goto :eof
)

rem ---------- Node.js ----------
where node >nul 2>nul
if errorlevel 1 goto :falta_node
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"
if errorlevel 1 goto :node_viejo

rem ---------- Python ----------
set "PY="
python -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul && set "PY=python"
if not defined PY py -3 -c "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)" >nul 2>nul && set "PY=py -3"
if not defined PY goto :falta_python

rem ---------- yt-dlp ----------
echo   [1/3] Actualizando yt-dlp, el componente de descarga de YouTube...
%PY% -m pip install --user --upgrade --quiet --disable-pip-version-check "yt-dlp[default]"
if errorlevel 1 (
  echo         Aviso: no se pudo actualizar yt-dlp. YouTube podría no funcionar.
)

rem ---------- Dependencias ----------
if exist "node_modules\express\" (
  echo   [2/3] Dependencias listas.
) else (
  echo   [2/3] Instalando dependencias. Solo la primera vez, tarda unos minutos...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto :error_npm
)

rem ---------- Arrancar ----------
echo   [3/3] Iniciando Auralis en http://localhost:3000
echo.
echo   Deja esta ventana abierta mientras uses la app.
echo   Para cerrarla, cierra esta ventana.
echo.
if not defined AURALIS_NO_BROWSER (
  start "" /b powershell -NoProfile -WindowStyle Hidden -Command "for ($i = 0; $i -lt 60; $i++) { try { Invoke-WebRequest -UseBasicParsing http://localhost:3000/api/config -TimeoutSec 2 | Out-Null; Start-Process 'http://localhost:3000'; break } catch { Start-Sleep -Seconds 1 } }"
)
node server\index.js
echo.
echo   Auralis se detuvo. Si ves un error arriba, envíaselo a quien te pasó la app.
pause
goto :eof

rem ================= Mensajes y ayudas =================

:falta_node
echo   No se encontró Node.js, que Auralis necesita para funcionar.
call :instalar "OpenJS.NodeJS.LTS" "Node.js" "https://nodejs.org"
goto :eof

:node_viejo
echo   Tu versión de Node.js es demasiado antigua. Auralis necesita la 20 o superior.
call :instalar "OpenJS.NodeJS.LTS" "Node.js" "https://nodejs.org"
goto :eof

:falta_python
echo   No se encontró Python 3.10 o superior, que Auralis necesita para descargar de YouTube.
call :instalar "Python.Python.3.13" "Python" "https://www.python.org/downloads/"
goto :eof

:error_npm
echo.
echo   No se pudieron instalar las dependencias. Revisa tu conexión a internet
echo   y vuelve a abrir este archivo.
pause
goto :eof

:instalar
rem %1 = id de winget, %2 = nombre, %3 = página de descarga
echo.
where winget >nul 2>nul
if errorlevel 1 goto :instalar_manual
choice /c SN /m "  ¿Quieres instalar %~2 ahora"
if errorlevel 2 goto :instalar_manual
winget install --exact --id %~1
echo.
echo   Cuando termine la instalación, cierra esta ventana y vuelve a abrir
echo   "Iniciar Auralis.bat".
pause
exit /b

:instalar_manual
echo   Descárgalo desde %~3, instálalo y vuelve a abrir "Iniciar Auralis.bat".
if "%~2"=="Python" echo   Durante la instalación marca la casilla "Add Python to PATH".
start "" %~3
pause
exit /b
