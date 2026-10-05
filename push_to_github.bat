@echo off
chcp 65001 >nul
cd /d "c:\Users\zhang\Desktop\WZY\github files\stating.pages.dev"
echo === Stating Liquid Plus → GitHub ===
git add .
git commit -m "feat: liquid glass plus + bio gate + nfc login"
git push
echo === Done ===
pause
