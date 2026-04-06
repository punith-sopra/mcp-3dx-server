@echo off
setlocal

set "URL=http://localhost:3000/chat"
set "MSG=create a simple task with name task 1 and description this is task 1"

curl -X POST "%URL%" ^
  -H "Content-Type: application/json" ^
  -d "{\"message\":\"%MSG%\",\"conversation\":[]}"

echo.
pause
