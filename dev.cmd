@echo off
setlocal
cd /d "%~dp0"
where uv >nul 2>nul
if errorlevel 1 (
    if exist ".venv\Scripts\python.exe" (
        .venv\Scripts\python.exe scripts/dev.py
    ) else (
        py -m uv run --locked python scripts/dev.py
    )
) else (
    uv run --locked python scripts/dev.py
)
exit /b %errorlevel%
