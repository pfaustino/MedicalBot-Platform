@echo off

setlocal EnableExtensions

cd /d "%~dp0"



echo.

echo  MedicalBot — restart dev servers

echo  ================================

echo.



echo [1/4] Stopping anything on ports 3000 and 3001...

call "%~dp0stop-dev.bat"



if not exist "apps\api\.env" (

  echo.

  echo  WARNING: apps\api\.env is missing.

  echo  Copy .env.example there and set DATABASE_URL outside Google Drive, e.g.:

  echo    DATABASE_URL=pglite://C:/Users/pfaus/AppData/Local/medbot-pglite

  echo.

)



echo [2/4] Verifying ports are free before start...

powershell -NoProfile -ExecutionPolicy Bypass -Command ^

  "$ports = @(3000, 3001); $blocked = @(); foreach ($port in $ports) { if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { $blocked += $port } }; if ($blocked.Count -gt 0) { Write-Host ('  ERROR: ports still blocked: ' + ($blocked -join ', ')) -ForegroundColor Red; exit 1 } else { Write-Host '  Ports 3000 and 3001 are free.' }"



if errorlevel 1 (

  echo.

  echo  Cannot start — free the ports manually and try again.

  echo.

  endlocal

  exit /b 1

)



echo [3/4] Starting API...

start "MedicalBot API" cmd /k "cd /d "%~dp0" && set DATABASE_URL=pglite://C:/Users/pfaus/AppData/Local/medbot-pglite&& npm run dev:api"



echo       Waiting for API to bind port 3001...

timeout /t 5 /nobreak >nul



echo [4/4] Starting Web...

start "MedicalBot Web" cmd /k "cd /d "%~dp0" && npm run dev:web"



echo.

echo  Done.

echo    API:  http://localhost:3001/health  ^(wait for "Database ready"^)

echo    Web:  http://localhost:3000

echo.

endlocal

