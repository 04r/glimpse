@echo off
rem Starts Glimpse in the tray (no console window stays open).
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
