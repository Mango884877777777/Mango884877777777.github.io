@echo off
setlocal
cd /d "%~dp0"

set "NODE=C:\Users\huazhenyu\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
set "TOKENURL=https://github.com/settings/tokens/new?scopes=repo,workflow&description=blog-deploy"

echo ==================================================
echo    部署「芒果干的太阳浴场」到 GitHub Pages
echo ==================================================
echo.

if not exist "%NODE%" (
  echo [错误] 找不到 Node 运行时：
  echo   %NODE%
  echo 如果 DSH 运行时位置变了，请修改本文件里的 NODE 变量。
  echo.
  pause
  exit /b 1
)

if not exist "scripts\deploy-github.mjs" (
  echo [错误] 找不到 scripts\deploy-github.mjs
  echo 请确认本文件放在 my-blog 目录下运行。
  echo.
  pause
  exit /b 1
)

if not exist "github-token.txt" (
  echo 需要先创建一个 GitHub 访问令牌，大约 40 秒。
  echo.
  echo 按任意键后，会自动打开创建页面 —— 权限已经预选好了 repo + workflow。
  echo.
  echo   1. 页面上的 Note 已填好 blog-deploy，不用改
  echo   2. Expiration 选 90 days
  echo   3. 确认 repo 和 workflow 两个 scope 都是打勾状态
  echo   4. 拉到底部，点绿色按钮 Generate token
  echo   5. 复制那串 ghp_ 开头的字符串（只显示一次，务必复制）
  echo   6. 回到这个窗口
  echo.
  pause
  start "" "%TOKENURL%"
  echo.
  echo 已经复制好令牌了？按任意键打开记事本粘贴。
  pause >nul
  > "github-token.txt" echo 把这行删掉，粘贴你的令牌后保存
  notepad "github-token.txt"
  echo.
  echo 在记事本里粘贴并保存了吗？按任意键开始部署。
  pause >nul
)

echo.
echo 开始部署，请稍候（约 1-2 分钟）…
echo.
"%NODE%" "scripts\deploy-github.mjs"
echo.
echo ==================================================
pause
