@echo off

setlocal EnableExtensions

cd /d "%~dp0"



echo.

echo  MedicalBot — stop dev servers

echo  ===============================

echo.



echo [1/2] Killing orphaned API watchers (tsx) that may hold PGlite locks...

powershell -NoProfile -ExecutionPolicy Bypass -Command ^

  "Get-CimInstance Win32_Process -Filter 'Name=''node.exe''' -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'medicalbot-platform.*tsx.*watch src/index' } | ForEach-Object { $name = (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue).ProcessName; Write-Host ('  Killing ' + $name + ' (PID ' + $_.ProcessId + ') — orphaned API watcher'); Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"



echo [2/2] Stopping listeners on ports 3000 and 3001...

powershell -NoProfile -ExecutionPolicy Bypass -Command ^

  "$ports = @(3000, 3001); foreach ($port in $ports) { $listeners = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue; if ($listeners) { foreach ($c in $listeners) { $pid = $c.OwningProcess; $name = (Get-Process -Id $pid -ErrorAction SilentlyContinue).ProcessName; Write-Host ('  Killing ' + $name + ' (PID ' + $pid + ') on port ' + $port); Stop-Process -Id $pid -Force -ErrorAction SilentlyContinue } } else { Write-Host ('  Port ' + $port + ': nothing listening') } }; $pgPid = 'C:\Users\pfaus\AppData\Local\medbot-pglite\postmaster.pid'; if (Test-Path $pgPid) { Remove-Item $pgPid -Force -ErrorAction SilentlyContinue; Write-Host '  Removed stale PGlite postmaster.pid' }; Write-Host ''; Write-Host '  Waiting for ports to clear...'; for ($i = 0; $i -lt 10; $i++) { $blocked = @(); foreach ($port in $ports) { if (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue) { $blocked += $port } }; if ($blocked.Count -eq 0) { break }; Start-Sleep -Seconds 1 }; Write-Host ''; foreach ($port in $ports) { $still = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue; if ($still) { Write-Host ('  WARNING: port ' + $port + ' still in use (PID ' + $still[0].OwningProcess + ')') -ForegroundColor Yellow } else { Write-Host ('  Port ' + $port + ': free') } }"



echo.

echo  Done.

echo.

endlocal

