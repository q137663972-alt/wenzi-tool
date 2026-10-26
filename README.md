# 文字工具（WenziTool）

一个 **WebView 壳 + H5 内容 + 热更新** 的安卓应用。界面与全部业务逻辑都在 H5（可热更），
原生层只负责：加载页面、经桥接调用大模型、后台静默热更新。**改 H5 不用重出 APK，用户零操作。**

> 命名：对外叫「文字工具」；内核是恋爱军师·童锦程风格的聊天参谋，调用多家大模型生成回复。
> H5 源码在 `web/`，内置兜底副本在 `app/src/main/assets/`（首次安装/无网时兜底）。

---

## 一、目录结构

```
wenzi-tool/
├── app/src/main/
│   ├── java/com/wenzigongju/MainActivity.java   # 壳：WebView + JS 桥接 + 热更新原生层
│   ├── assets/                                  # 内置兜底 H5（= web/ 的副本）
│   │   ├── index.html / css/ / js/               #   H5 页面与逻辑
│   │   └── config.json                          #   模型密钥 + 热更基址（可经热更覆盖）
│   ├── res/                                      # 布局 / 字符串（app_name=文字工具）/ 网络配置
│   └── AndroidManifest.xml
├── web/                                          # H5 源码（改这里，gen-pack 打包上线）
│   ├── index.html / css/style.css
│   └── js/{prompts,offline,app}.js
├── tools/gen-pack.mjs                            # 热更打包（build 指纹 + 双发）
├── .github/workflows/build.yml                    # 推 main → 打包 → 发 gh-pages
└── hot/                                          # 生成物（gitignore）：update.json / code.<build>.zip / pack/
```

---

## 二、本地编译 APK（Android Studio）

1. 用 Android Studio 打开本目录（Gradle 会自动同步；若缺 wrapper，Studio 会生成）。
2. `app/build.gradle` 已配：minSdk 21 / targetSdk 34 / AGP 8.2。
3. `Build → Build Bundle(s) / APK(s) → Build APK(s)`。
4. 装到手机：设置 → 允许未知来源 → 安装 `app-debug.apk`。

> 首次打开走内置 `assets/` 兜底；之后后台自动拉热更包，下次打开即最新。

---

## 三、热更新机制（保证「改完推上去即生效」）

**三层加载（零网络启动）：** 内置 assets → `files/hot/`（上次装好的包）→ 远程 `hot/pack/`（最新 zip）

- 启动只读本地，**网络请求只发生在启动成功 3 秒后**的后台更新。远程挂了只退化为「这次没更新」，永不白屏。
- 原生层下载 `update.json → manifest.json → code.<build>.zip`：**双路**尝试 `hot/<name>` 与 `hot/pack/<name>`，
  校验 **sha256**，原子替换（`hot.new` 解压 → rename 成 `hot`）。
- zip 文件名带 **build 指纹**，绕开 CDN 12h 缓存。
- `min_apk` 门槛：热更包要求更高版本时，旧壳自动退回内置兜底，不会加载装不上的包。

**用户侧生效路径（零操作）：** 打开 App（后台拉包落盘）→ 完全退出 → 再次打开 → 生效。
（若本次就在用内置，装好后会直接刷新到新内容并提示「新内容已就绪」。）

---

## 四、热更基址（已配置好，无需操作）

仓库：**https://github.com/q137663972-alt/wenzi-tool**
热更站点：**https://q137663972-alt.github.io/wenzi-tool/**

- GitHub Pages 已设为 `main` 分支的 `/docs` 目录，站点根 = `docs/` 内容。
- `app/src/main/assets/config.json` 的 `hot_base` 已指向该站点，**编译出来的 APK 直接可用**。
- 已实测线上四件套：`update.json` 200、`pack/manifest.json` 200、`docs/code.<build>.zip` 200（根与 pack/ 双发）、下载 sha256 与 manifest 记录一致。

### 以后改 H5 怎么发布（一条命令）

```bash
# 1. 改 web/ 下的文件
# 2. 重新打包（自动生成带 build 指纹的 zip 到 docs/）
node tools/gen-pack.mjs
# 3. 提交推送（或用 .github/workflows/build.yml 自动完成）
git add -A && git commit -m "更新" && git push
```

用户侧：打开 App → 后台拉包 → 完全退出 → 再打开，即最新。**不用重新出 APK。**

> 若想换托管（对象存储/CDN/自建服务器），只改 `config.json` 的 `hot_base`，保持
> `update.json` 与 `pack/manifest.json`+zip 的目录结构即可。本地调试可在 `docs/` 跑
> `python -m http.server 8080`，`hot_base` 设为 `http://<电脑IP>:8080/`。

---

## 五、大模型密钥（重要安全提示）

模型密钥写在 `config.json` 的 `providers` 里（已内置你提供的三家的 key）。
**APK 里的密钥可被反编译提取**——本应用是个人自用、密钥是你的，风险可控；
若担心泄露，请改造成「H5 只发 model_id，密钥放一个你自己的后端代理」，
Java 桥接 `askLLM` 改为请求你的代理即可（不进前端）。

当前内置：智谱 GLM-4-Flash（永久免费，默认）、腾讯混元 hy3、DeepSeek V3（余额不足时自动回退离线）。

---

## 六、规避的坑（参考「小学学习乐园」踩坑记录）

- 热更在**原生层**做，不依赖 JS 哨兵 → 从根上绕开「哨兵熔断」「boot.js 冻结必须出 APK」。
- zip **双发** + **build 指纹** + manifest 写真实文件名 → 杜绝 404、杜绝 jsDelivr 12h 缓存导致的旧包。
- 启动**零网络**，远程失败只降级不白屏。
- LLM 调用走 **Java 桥接**，避开浏览器 CORS，密钥不进 JS。
- 入口用顶栏按钮（非飘浮定位）、配置走热更覆盖（不出 APK）。

---

## 七、沙盒推送 GitHub（被墙时的正确姿势）

已按「小学学习乐园」资料库的实战经验验证过，直接照做：

```bash
# ① token 只放文件，绝不写进命令文本（写在命令里会被工具链改写 → 必 401）
printf '%s' 'ghp_xxx' > /root/.git_token && chmod 600 /root/.git_token

# ② 通道判据：401 = 通道通但没带凭据（可用）；000 = 真不可达
#    ghproxy.net / gh-proxy.com -> 401（可用）；ghfast.top -> 000（不可达）

# ③ 凭据走 extraHeader，不写进 URL userinfo（代理会吞掉并返 403）
AUTH=$(printf 'x-access-token:%s' "$(cat /root/.git_token)" | base64 -w0)
git -c "http.extraHeader=Authorization: Basic $AUTH" \
    -c user.name=USER -c user.email=USER@users.noreply.github.com \
    push "https://ghproxy.net/https://github.com/USER/REPO.git" HEAD:refs/heads/main
```

**踩过的坑（都是资料库记录过的）：**

| 坑 | 表现 | 解法 |
|---|---|---|
| token 写命令里 | 必 401 | 只从文件读 |
| 凭据塞 URL `user:token@` | 代理 403 | 用 `extraHeader` |
| `ghfast.top` | 连接超时 000 | 换 `ghproxy.net` |
| token 缺 `workflow` 权限 | push 被拒：`refusing to allow a PAT to create or update workflow` | 去 token 设置勾 `workflow`，或别推 `.github/workflows/` |
| 本地历史与远程不一致 | `fetch first` 拒绝 | 先 `git fetch` 再 `git reset --soft FETCH_HEAD` |

> `gh-proxy.com` 只代理 API（验 token、查提交），**不代理 git push**。

---

## 八、本地预览 H5（无需安卓）

桌面浏览器直接打开 `web/index.html` 即可看界面（无桥接时自动走离线引擎）。
要测真·大模型，需在有 Android 桥接的 WebView 环境（即编译后的 App）中运行。
