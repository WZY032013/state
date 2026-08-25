@echo off
chcp 65001 >nul
cd /d "C:\Users\zhang\Desktop\WZY\github files\github files(stating.pages.dev)"
echo === Stating 网站推送GitHub ===
echo.
git add .
git commit -m "feat: 新增群成员管理/消息置顶/收藏/@提及/草稿/群信息编辑 + 延迟优化"
git push
echo.
echo === 推送完成 ===
pause
