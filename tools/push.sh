#!/usr/bin/env bash
# 文字工具 · 一键推送热更到 GitHub Pages
#
# 用法（在本机执行）：
#   GH_TOKEN=ghp_xxx sh tools/push.sh
#
# 说明：
#   - 通过 ghfast.top 镜像加速（github.com 直连很慢，~12s/往返）
#   - 用一次性 http.extraHeader 携带 token，不写入任何配置文件、不留痕
#   - 本地 master 分支 → 远程 main 分支（本仓库约定）
#   - 仅推送，不打包；打包请用 node tools/gen-pack.mjs
set -euo pipefail

REPO_DIR="/workspace/wenzi-tool"
cd "$REPO_DIR"

: "${GH_TOKEN:?未检测到 GH_TOKEN，请用 GH_TOKEN=xxx sh tools/push.sh 传入}"

git -c "url.https://ghfast.top/https://github.com/.insteadOf=https://github.com/" \
    -c "http.extraHeader=Authorization: Bearer ${GH_TOKEN}" \
    push origin master:main

echo "PUSH_DONE"
