#!/usr/bin/env bash
# 文字工具 · 出包 SOP（对齐《小学学习乐园·项目总手册》§4 出包 SOP）
#
# 三件事缺一不可（与手册一致）：
#   ① 同步 H5：把仓库根 web/ 全量同步进壳工程 assets（先清后拷，config.json 例外）。
#      手册铁律第 1 条：assets 必须先删干净再拷，否则用户拿旧代码（史上最大坑）。
#   ② Gradle 构建：有 keystore/keystore.properties 走 release 签名，否则出 debug 版（可安装自测）。
#   ③ zipalign + apksigner 本地签名（仅 release）+ apksigner verify --print-certs 核对。
#
# 签名凭据：读 keystore/keystore.properties（整目录 .gitignore，绝不入库）。
#   keystore.properties 格式：
#     KEY_ALIAS=wenzigongju
#     KEYSTORE_STORE_PASS=****
#     KEYSTORE_KEY_PASS=****
#   keystore 文件：keystore/release.jks（PKCS12）。缺失则只出 debug。
#
# 注意：学习乐园的签名密钥（com.example.chineseplayground）不可复用到本包（包名不同），
#       文字工具需独立生成并妥善备份 keystore（丢失 = 已装用户必须卸载重装）。

set -euo pipefail
cd "$(dirname "$0")"

# 确保 local.properties 指向本地 SDK
if [ -n "${ANDROID_HOME:-}" ] && [ ! -f local.properties ]; then
  echo "sdk.dir=$ANDROID_HOME" > local.properties
fi

# ① 同步内置兜底 H5（先清后拷，config.json 不参与拷贝，单独保留）
echo "==> ① 同步 web/ -> app/src/main/assets/（保留 config.json）"
ASSETS=app/src/main/assets
rm -rf "$ASSETS/index.html" "$ASSETS/css" "$ASSETS/js"
cp -r web/index.html web/css web/js "$ASSETS/"
echo "    已同步：$(ls -1 web | tr '\n' ' ')"

# ② 构建 + 签名
KS_DIR=keystore
KS_PROP=$KS_DIR/keystore.properties
BT=$(ls -d "${ANDROID_HOME:-$HOME/Android/Sdk}"/build-tools/*/ 2>/dev/null | sort | tail -1)

if [ -f "$KS_PROP" ]; then
  echo "==> ② release 构建 + 签名"
  ./gradlew assembleRelease
  UNSIGNED=app/build/outputs/apk/release/app-release-unsigned.apk
  # shellcheck disable=SC1090
  source "$KS_PROP"
  ALIGNED=app/build/outputs/apk/release/wenzigongju-release-aligned.apk
  OUT=app/build/outputs/apk/release/wenzigongju-release.apk
  "$BT/zipalign" -f 4 "$UNSIGNED" "$ALIGNED"
  "$BT/apksigner" sign --ks "$KS_DIR/release.jks" --ks-key-alias "$KEY_ALIAS" \
       --ks-pass "pass:$KEYSTORE_STORE_PASS" --key-pass "pass:$KEYSTORE_KEY_PASS" "$ALIGNED"
  mv "$ALIGNED" "$OUT"
  echo "==> ③ verify"
  "$BT/apksigner" verify --print-certs "$OUT"
  echo "release APK: $OUT"
else
  echo "==> ② debug 构建（未找到 keystore/keystore.properties，输出可安装 debug 版）"
  ./gradlew assembleDebug
  APK=app/build/outputs/apk/debug/app-debug.apk
  echo "==> ③ verify"
  "$BT/apksigner" verify --print-certs "$APK"
  echo "debug APK: $APK"
fi
