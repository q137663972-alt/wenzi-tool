package com.wenzigongju;

import android.Manifest;
import android.annotation.SuppressLint;
import android.content.ClipData;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import androidx.appcompat.app.AppCompatActivity;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.math.BigInteger;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Enumeration;
import java.util.List;
import java.util.zip.ZipEntry;
import java.util.zip.ZipFile;

/**
 * 文字工具 · 主壳
 *
 * 设计要点（规避小学学习乐园踩过的坑）：
 * 1) 热更新在【原生层】做：拉 update.json/manifest → 双路下载 zip → sha256 校验 → 原子替换。
 *    不依赖 JS 里的 boot.js 哨兵，从根上绕开「哨兵熔断」「boot.js 冻结必须出 APK」那一类坑。
 * 2) 启动零网络：先读本地（files/hot 优先，否则 android_asset 内置兜底），成功 3 秒后才后台更新。
 *    远程挂了只退化为「这次没更新」，永不白屏。
 * 3) zip 带 build 指纹；manifest 的包名用真实文件名，避免 404。
 * 4) LLM 调用走 Java 桥接（WebView → Java → HTTPS），避开浏览器 CORS，密钥不进 JS。
 */
public class MainActivity extends AppCompatActivity {

    private static final String TAG = "WenziTool";
    private WebView webView;
    private final Handler ui = new Handler(Looper.getMainLooper());

    // ---- 图片选择（贴聊天截图）----
    private static final int REQ_PICK_FILE = 1001;
    private static final int REQ_PERM_MEDIA = 1002;
    private ValueCallback<Uri[]> mFileCallback;   // H5 的 <input type=file> 回调
    private ValueCallback<Uri[]> mPendingCb;      // 等权限结果时暂存
    private boolean mAllowMultiple = false;
    private JSONObject appConfig;

    // 热更根（由 config.json 的 hot_base 决定，可经热更覆盖，不用出 APK）
    private String HOT_BASE = "https://example.github.io/wenzi-tool/";

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        loadConfig();

        webView = findViewById(R.id.webview);
        WebSettings ws = webView.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setAllowFileAccess(true);
        ws.setCacheMode(WebSettings.LOAD_NO_CACHE);   // 永不被缓存坑到
        ws.setUserAgentString(ws.getUserAgentString() + " WenziTool/" + versionName());

        webView.addJavascriptInterface(new JSBridge(), "Android");
        // 关键：不设 WebChromeClient，H5 里的 <input type="file"> 点了没反应。
        // 这里接管文件选择，把系统选到的图交回 WebView（贴聊天截图 = 核心功能）。
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                // 上一次还没结完就取消，避免回调悬挂
                if (mFileCallback != null) {
                    mFileCallback.onReceiveValue(null);
                }
                mFileCallback = callback;
                boolean allowMultiple = params != null
                        && params.getMode() == FileChooserParams.MODE_OPEN_MULTIPLE;

                // 先要相册权限，拿到再唤起选择器；否则部分机型选择器直接空列表
                if (!hasMediaPermission()) {
                    mPendingCb = callback;
                    mAllowMultiple = allowMultiple;
                    requestMediaPermission();
                    return true;
                }
                openImagePicker(allowMultiple);
                return true;
            }
        });
        webView.setWebViewClient(new WebViewClient() {
            // 把 https://local.hot/* 映射到 内部存储 files/hot/*（虚拟域，绕过 CORS）
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, String url) {
                if (url != null && url.startsWith("https://local.hot/")) {
                    String rel = url.substring("https://local.hot/".length());
                    // 丢弃 ?b=build 这类查询串
                    int q = rel.indexOf('?');
                    if (q >= 0) rel = rel.substring(0, q);
                    File f = new File(getFilesDir(), "hot/" + rel);
                    if (f.isFile()) {
                        try {
                            return new WebResourceResponse(guessMime(rel), "utf-8", new FileInputStream(f));
                        } catch (IOException e) {
                            Log.w(TAG, "intercept read fail: " + rel, e);
                        }
                    }
                }
                return null;
            }

            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                // 任何加载失败 → 退回内置 assets，绝不白屏
                safeLoadBuiltin();
            }
        });

        // 决定首屏：已有热更且版本门槛通过 → 走 local.hot；否则走内置 assets
        boolean startWithHot = hotUsable();
        idxExistedBefore = startWithHot;   // 供热更完成后判断是否需要自动刷新
        if (startWithHot) {
            webView.loadUrl("https://local.hot/index.html");
        } else {
            webView.loadUrl("file:///android_asset/index.html");
        }

        // 启动成功 3 秒后，后台静默热更新（用户零操作）
        ui.postDelayed(this::backgroundUpdate, 3000);
    }

    // ---------------- 图片选择 / 相册权限 ----------------
    // Android 13+ 是 READ_MEDIA_IMAGES，12 及以下是 READ_EXTERNAL_STORAGE。
    // 注意：即便不给权限，ACTION_GET_CONTENT 在某些 ROM 上也能用（走 SAF 授权单张），
    // 所以这里的策略是「能要到就要，要不到照样尝试打开选择器」，绝不把用户堵死。
    private boolean hasMediaPermission() {
        String perm = Build.VERSION.SDK_INT >= 33
                ? "android.permission.READ_MEDIA_IMAGES"
                : Manifest.permission.READ_EXTERNAL_STORAGE;
        return checkSelfPermission(perm) == PackageManager.PERMISSION_GRANTED;
    }

    private void requestMediaPermission() {
        if (Build.VERSION.SDK_INT >= 33) {
            requestPermissions(new String[]{"android.permission.READ_MEDIA_IMAGES"}, REQ_PERM_MEDIA);
        } else {
            requestPermissions(new String[]{Manifest.permission.READ_EXTERNAL_STORAGE}, REQ_PERM_MEDIA);
        }
    }

    private void openImagePicker(boolean allowMultiple) {
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("image/*");
        if (allowMultiple) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        try {
            startActivityForResult(Intent.createChooser(intent, "选择聊天截图"), REQ_PICK_FILE);
        } catch (Exception e) {
            Log.w(TAG, "picker fail", e);
            finishFileCallback(null);
            ui.post(() -> toast("没找到可用的图片选择器"));
        }
    }

    private void finishFileCallback(Uri[] uris) {
        ValueCallback<Uri[]> cb = mFileCallback;
        mFileCallback = null;
        mPendingCb = null;
        if (cb != null) {
            try { cb.onReceiveValue(uris); } catch (Exception ignore) {}
        }
        // 交回结果后，让 WebView 里的 <input> change 事件正常触发
        if (webView != null) webView.requestFocus();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_PERM_MEDIA) return;
        boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        // 无论是否授权都继续打开选择器：SAF 允许用户只授权单张图片
        if (mPendingCb != null) mFileCallback = mPendingCb;
        mPendingCb = null;
        if (!granted) toast("未授权相册，选择器里可能看不到图片");
        openImagePicker(mAllowMultiple);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != REQ_PICK_FILE) return;
        if (resultCode != RESULT_OK || data == null) {
            finishFileCallback(null);
            return;
        }
        Uri[] uris;
        ClipData clip = data.getClipData();
        if (clip != null && clip.getItemCount() > 0) {
            // 多选：逐项取出
            uris = new Uri[clip.getItemCount()];
            for (int i = 0; i < clip.getItemCount(); i++) {
                uris[i] = clip.getItemAt(i).getUri();
            }
        } else if (data.getData() != null) {
            uris = new Uri[]{data.getData()};
        } else {
            uris = null;
        }
        finishFileCallback(uris);
    }

    private void toast(String msg) {
        Toast.makeText(this, msg, Toast.LENGTH_SHORT).show();
    }

    // ---------------- 配置 ----------------
    private void loadConfig() {
        appConfig = readJsonAssetOrHot("config.json");
        if (appConfig != null) {
            HOT_BASE = appConfig.optString("hot_base", HOT_BASE);
        }
    }

    private JSONObject readJsonAssetOrHot(String name) {
        // 优先 files/hot/config.json（热更可覆盖），其次内置 assets/config.json
        File hot = new File(getFilesDir(), "hot/" + name);
        if (hot.isFile()) {
            try { return new JSONObject(readFile(hot)); } catch (Exception ignore) {}
        }
        try (InputStream is = getAssets().open(name)) {
            return new JSONObject(readStream(is));
        } catch (Exception ignore) {
            return null;
        }
    }

    private String versionName() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "1.0.0";
        }
    }

    private int versionCode() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionCode;
        } catch (Exception e) {
            return 1;
        }
    }

    // ---------------- 首屏选择 ----------------
    private boolean hotUsable() {
        File idx = new File(getFilesDir(), "hot/index.html");
        File build = new File(getFilesDir(), "hot/__build__");
        if (!idx.isFile() || !build.isFile()) return false;
        try {
            JSONObject b = new JSONObject(readFile(build));
            int minApk = b.optInt("min_apk", 1);
            return versionCode() >= minApk;   // 门槛不满足 → 退回内置，不让旧壳加载要求更高的包
        } catch (Exception e) {
            return false;
        }
    }

    private void safeLoadBuiltin() {
        ui.post(() -> webView.loadUrl("file:///android_asset/index.html"));
    }

    // ---------------- 热更新（原生层） ----------------
    private void backgroundUpdate() {
        // 启动静默更新：不强制、不打扰，拿到新版只提示"已就绪"
        runUpdate(false);
    }

    /**
     * 执行一次热更。
     *
     * @param force true = 用户主动点「立即应用」/「检查更新」：
     *              即使本地 build 与线上一致也重新下载校验一遍（修掉"文件坏了但 build 标记还在"的假最新），
     *              成功后清掉 WebView 缓存并重载页面，让新内容立刻生效，无需重启 App。
     *              false = 启动后台静默更新：同 build 直接跳过，不刷新页面。
     */
    private void runUpdate(final boolean force) {
        new Thread(() -> {
            try {
                // 1) 读 update.json（清单索引，含 manifest 位置与 app/sig 等）
                String upd = httpGetText(HOT_BASE + "update.json");
                if (upd == null) {
                    if (force) notifyJs("fail", "拉取更新清单失败，检查网络后重试");
                    return;
                }
                JSONObject update = new JSONObject(upd);
                int minApk = update.optInt("min_apk", 1);
                if (versionCode() < minApk) {
                    // 壳太旧：这次只能靠装新 APK，明确告知，不假装成功
                    if (force) notifyJs("apk", "这次更新需要新版 APK（当前 versionCode " + versionCode()
                            + " < 要求的 " + minApk + "），光热更改不动，请装新包");
                    return;
                }
                String manifestUrl = update.optString("manifest", HOT_BASE + "pack/manifest.json");

                // 2) 读 manifest（列出各 pack 的真实文件名 + sha256）
                String man = httpGetText(manifestUrl);
                if (man == null) {
                    if (force) notifyJs("fail", "拉取包清单失败");
                    return;
                }
                JSONObject manifest = new JSONObject(man);
                String build = manifest.optString("build", "");
                JSONArray packs = manifest.optJSONArray("packs");
                if (packs == null) {
                    if (force) notifyJs("fail", "包清单格式异常");
                    return;
                }

                // 已是同版本则跳过（force 模式不跳过，重下重校一遍）
                File buildFile = new File(getFilesDir(), "hot/__build__");
                if (!force && buildFile.isFile()) {
                    try {
                        JSONObject cur = new JSONObject(readFile(buildFile));
                        if (build.equals(cur.optString("build", ""))) return;
                    } catch (Exception ignore) {}
                }

                if (force) notifyJs("downloading", "正在下载最新内容…");

                File hotDir = new File(getFilesDir(), "hot");
                File tmp = new File(getFilesDir(), "hot.new");
                deleteRecursively(tmp);
                tmp.mkdirs();

                boolean allOk = true;
                for (int i = 0; i < packs.length(); i++) {
                    JSONObject p = packs.getJSONObject(i);
                    String name = p.getString("name");
                    String sha = p.optString("sha256", "");
                    if (!downloadAndVerify(HOT_BASE, name, tmp, sha)) {
                        allOk = false;
                        break;
                    }
                }
                if (!allOk) {
                    deleteRecursively(tmp);
                    if (force) notifyJs("fail", "下载或校验失败，已保留旧版本（内容不会被弄坏）");
                    return;
                }

                // 3) 原子替换：删旧 hot → 新 hot.new 改名 hot
                //    先改名成 hot.old 再删，失败时还能回滚，避免中途异常导致 hot 目录空了
                File oldDir = new File(getFilesDir(), "hot.old");
                deleteRecursively(oldDir);
                if (hotDir.exists()) hotDir.renameTo(oldDir);
                boolean swapped = tmp.renameTo(hotDir);
                if (!swapped) {
                    // 改名失败兜底：直接拷贝
                    copyDir(tmp, hotDir);
                    deleteRecursively(tmp);
                }
                // 写 build 标记（带 min_apk，供首屏门槛判断）
                writeFile(new File(hotDir, "__build__"),
                        new JSONObject().put("build", build).put("min_apk", minApk).toString());
                deleteRecursively(oldDir);

                Log.i(TAG, "hot update applied, build=" + build + " force=" + force);
                final boolean wasBuiltin = !idxExistedBefore;
                final String newBuild = build;
                runOnUiThread(() -> {
                    // 强制模式：清缓存 + 重载，新内容立刻生效（这是「强制更新」的关键）
                    if (force) {
                        webView.clearCache(true);
                        if (wasBuiltin || !"https://local.hot/index.html".equals(webView.getUrl())) {
                            webView.loadUrl("https://local.hot/index.html");
                        } else {
                            webView.reload();
                        }
                        notifyJs("applied", "已更新到 " + newBuild.substring(0, Math.min(8, newBuild.length())));
                        Toast.makeText(MainActivity.this, "已更新到最新版", Toast.LENGTH_SHORT).show();
                    } else {
                        Toast.makeText(MainActivity.this, "新内容已就绪", Toast.LENGTH_SHORT).show();
                        // 静默更新：若本次就在用内置，直接刷新到热更内容；否则不打扰用户当前操作
                        if (wasBuiltin) webView.reload();
                    }
                });
            } catch (Exception e) {
                Log.w(TAG, "hot update failed", e);
                if (force) notifyJs("fail", "更新异常：" + e.getMessage());
            }
        }).start();
    }

    /** 从后台线程安全地把状态回传给 H5 的 window.__onUpdate(state,msg) */
    private void notifyJs(final String state, final String msg) {
        runOnUiThread(() -> {
            try {
                JSONObject o = new JSONObject().put("state", state).put("msg", msg);
                webView.evaluateJavascript("window.__onUpdate && window.__onUpdate(" + o.toString() + ");", null);
            } catch (JSONException ignore) {}
        });
    }

    private volatile boolean idxExistedBefore = false;

    private boolean downloadAndVerify(String base, String name, File outDir, String expectSha) {
        // 双路：先试 hot/ 根，失败再试 hot/pack/（老壳 URL 不带 pack/ 前缀也接得住）
        byte[] data = httpGetBytes(base + name);
        if (data == null) data = httpGetBytes(base + "pack/" + name);
        if (data == null) return false;
        if (!expectSha.isEmpty()) {
            String got = sha256Hex(data);
            if (!got.equalsIgnoreCase(expectSha)) {
                Log.w(TAG, "sha256 mismatch: " + name + " expect=" + expectSha + " got=" + got);
                return false;
            }
        }
        try {
            unzip(data, outDir);
            return true;
        } catch (Exception e) {
            Log.w(TAG, "unzip fail: " + name, e);
            return false;
        }
    }

    // ---------------- HTTP（原生，避开 CORS） ----------------
    private String httpGetText(String urlStr) {
        byte[] b = httpGetBytes(urlStr);
        return b == null ? null : new String(b);
    }

    private byte[] httpGetBytes(String urlStr) {
        try {
            URL url = new URL(urlStr);
            HttpURLConnection c = (HttpURLConnection) url.openConnection();
            c.setRequestMethod("GET");
            c.setConnectTimeout(8000);
            c.setReadTimeout(15000);
            c.setUseCaches(false);
            c.setRequestProperty("Cache-Control", "no-cache");
            c.setRequestProperty("User-Agent", "WenziTool-Update");
            int code = c.getResponseCode();
            if (code != 200) { c.disconnect(); return null; }
            byte[] data = readBytes(c.getInputStream());
            c.disconnect();
            return data;
        } catch (Exception e) {
            Log.w(TAG, "httpGet fail: " + urlStr, e);
            return null;
        }
    }

    // ---------------- JS 桥接 ----------------
    private class JSBridge {
        // 返回带密钥的可用模型 id 列表（H5 据此生成下拉；密钥只在原生，不进 JS 文本）
        @JavascriptInterface
        public String getEnabledModels() {
            try {
                JSONObject cfg = appConfig;
                JSONArray arr = new JSONArray();
                if (cfg != null) {
                    JSONObject prov = cfg.optJSONObject("providers");
                    if (prov != null) {
                        for (String id : new String[]{"zhipu-glm", "tencent-hy3", "deepseek-chat"}) {
                            JSONObject p = prov.optJSONObject(id);
                            boolean enabled = p != null && p.optString("api_key", "").length() > 0;
                            arr.put(new JSONObject().put("id", id).put("enabled", enabled));
                        }
                    }
                }
                return arr.toString();
            } catch (JSONException e) {
                return "[]";
            }
        }

        @JavascriptInterface
        public String getConfig() {
            return appConfig == null ? "{}" : appConfig.toString();
        }

        // 当前 APK 版本信息（H5 版本条直接显示，不必从 UA 里猜）
        @JavascriptInterface
        public String getAppVersion() {
            try {
                return new JSONObject().put("versionCode", versionCode())
                        .put("versionName", versionName()).toString();
            } catch (JSONException e) {
                return "{}";
            }
        }

        // 当前本地已装 H5 的 build 指纹（没有热更时返回空串）
        @JavascriptInterface
        public String getLocalBuild() {
            File bf = new File(getFilesDir(), "hot/__build__");
            if (!bf.isFile()) return "";
            try {
                return new JSONObject(readFile(bf)).optString("build", "");
            } catch (Exception e) {
                return "";
            }
        }

        // 真·强制更新：后台重拉 → 校验 → 原子替换 → 清缓存 → 重载，全程无需重启 App。
        // 进度与结果通过 window.__onUpdate(state, msg) 回调：
        //   checking / downloading / applied / apk / fail
        @JavascriptInterface
        public void applyUpdate() {
            runUpdate(true);
        }

        // H5 把组装好的 messages 交给原生；原生按 model_id 选 provider，发起 HTTPS 调用，返回原文
        @JavascriptInterface
        public void askLLM(final String reqId, final String payloadJson) {
            new Thread(() -> {
                final String result = doLLM(payloadJson);
                ui.post(() -> webView.evaluateJavascript("window.__onLLM('" + reqId + "'," + result + ");", null));
            }).start();
        }
    }

    private String doLLM(String payloadJson) {
        try {
            JSONObject req = new JSONObject(payloadJson);
            String modelId = req.optString("model_id", "auto");
            if ("auto".equals(modelId) && appConfig != null) {
                modelId = appConfig.optString("default_model", "zhipu-glm");
            }
            JSONObject prov = null;
            if (appConfig != null) {
                // 看图请求（截图 OCR）走独立的 vision 配置，不与对话模型混用：
                // 对话多用 glm-4-flash 这类纯文本模型，看图必须用 glm-4v-* 这类多模态模型
                if (req.optBoolean("vision_model", false)) {
                    prov = appConfig.optJSONObject("vision");
                }
                if (prov == null) {
                    JSONObject providers = appConfig.optJSONObject("providers");
                    if (providers != null) prov = providers.optJSONObject(modelId);
                }
            }
            if (prov == null || prov.optString("api_key", "").isEmpty()) {
                return new JSONObject().put("ok", false).put("error", "该模型未配置密钥").toString();
            }
            String base = prov.optString("base_url", "");
            String key = prov.optString("api_key", "");
            String model = prov.optString("model", modelId);
            JSONArray messages = req.optJSONArray("messages");
            double temp = req.optDouble("temperature", 0.9);

            JSONObject body = new JSONObject().put("model", model).put("messages", messages).put("temperature", temp);
            int maxTokens = req.optInt("max_tokens", 0);
            if (maxTokens > 0) body.put("max_tokens", maxTokens);
            byte[] resp = httpPostJson(base + "/chat/completions", key, body);
            if (resp == null) return new JSONObject().put("ok", false).put("error", "网络请求失败").toString();
            String text = new String(resp);
            // 把 choices[0].message.content 取出来透传给 H5（H5 再解析成回复 JSON）
            try {
                JSONObject j = new JSONObject(text);
                String content = j.getJSONArray("choices").getJSONObject(0).getJSONObject("message").getString("content");
                return new JSONObject().put("ok", true).put("content", content).put("provider", modelId).toString();
            } catch (Exception e) {
                return new JSONObject().put("ok", false).put("error", "响应解析失败：" + text.substring(0, Math.min(200, text.length()))).toString();
            }
        } catch (Exception e) {
            try {
                return new JSONObject().put("ok", false).put("error", e.getMessage()).toString();
            } catch (JSONException je) {
                return "{\"ok\":false,\"error\":\"exception\"}";
            }
        }
    }

    private byte[] httpPostJson(String urlStr, String apiKey, JSONObject body) {
        try {
            URL url = new URL(urlStr);
            HttpURLConnection c = (HttpURLConnection) url.openConnection();
            c.setRequestMethod("POST");
            c.setConnectTimeout(20000);
            c.setReadTimeout(60000);
            c.setUseCaches(false);
            c.setRequestProperty("Content-Type", "application/json");
            c.setRequestProperty("Authorization", "Bearer " + apiKey);
            c.setDoOutput(true);
            try (OutputStream os = c.getOutputStream()) {
                os.write(body.toString().getBytes("utf-8"));
            }
            int code = c.getResponseCode();
            InputStream is = (code == 200) ? c.getInputStream() : c.getErrorStream();
            byte[] data = readBytes(is);
            c.disconnect();
            return code == 200 ? data : null;
        } catch (Exception e) {
            Log.w(TAG, "httpPost fail: " + urlStr, e);
            return null;
        }
    }

    // ---------------- 工具 ----------------
    private static String guessMime(String rel) {
        if (rel.endsWith(".html") || rel.endsWith(".htm")) return "text/html";
        if (rel.endsWith(".js")) return "application/javascript";
        if (rel.endsWith(".css")) return "text/css";
        if (rel.endsWith(".json")) return "application/json";
        if (rel.endsWith(".png")) return "image/png";
        if (rel.endsWith(".jpg") || rel.endsWith(".jpeg")) return "image/jpeg";
        if (rel.endsWith(".svg")) return "image/svg+xml";
        if (rel.endsWith(".woff2")) return "font/woff2";
        return "application/octet-stream";
    }

    private static String sha256Hex(byte[] data) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            byte[] h = md.digest(data);
            BigInteger bi = new BigInteger(1, h);
            String s = bi.toString(16);
            while (s.length() < 64) s = "0" + s;
            return s;
        } catch (Exception e) {
            return "";
        }
    }

    private static void unzip(byte[] zip, File outDir) throws IOException {
        File tmp = File.createTempFile("wz", ".zip");
        try (FileOutputStream fos = new FileOutputStream(tmp)) { fos.write(zip); }
        try (ZipFile zf = new ZipFile(tmp)) {
            Enumeration<? extends ZipEntry> en = zf.entries();
            while (en.hasMoreElements()) {
                ZipEntry e = en.nextElement();
                if (e.isDirectory()) continue;
                File out = new File(outDir, sanitize(e.getName()));
                out.getParentFile().mkdirs();
                try (InputStream zis = zf.getInputStream(e); FileOutputStream fos = new FileOutputStream(out)) {
                    byte[] buf = new byte[8192];
                    int n;
                    while ((n = zis.read(buf)) > 0) fos.write(buf, 0, n);
                }
            }
        } finally {
            tmp.delete();
        }
    }

    private static String sanitize(String name) {
        // 防 zip 穿越
        return name.replace("\\", "/").replaceAll("(^|/)\\.\\.(/|$)", "/").replaceAll("^/", "");
    }

    private static void deleteRecursively(File f) {
        if (f == null || !f.exists()) return;
        if (f.isDirectory()) {
            File[] children = f.listFiles();
            if (children != null) for (File c : children) deleteRecursively(c);
        }
        f.delete();
    }

    private static void copyDir(File src, File dst) {
        if (!src.isDirectory()) return;
        dst.mkdirs();
        File[] files = src.listFiles();
        if (files == null) return;
        for (File c : files) {
            if (c.isDirectory()) copyDir(c, new File(dst, c.getName()));
            else {
                try (InputStream is = new FileInputStream(c); FileOutputStream os = new FileOutputStream(new File(dst, c.getName()))) {
                    byte[] buf = new byte[8192]; int n;
                    while ((n = is.read(buf)) > 0) os.write(buf, 0, n);
                } catch (IOException ignore) {}
            }
        }
    }

    private static String readStream(InputStream is) throws IOException {
        return new String(readBytes(is), "utf-8");
    }

    private static byte[] readBytes(InputStream is) throws IOException {
        ByteArrayOutputStream bos = new ByteArrayOutputStream();
        try (BufferedInputStream bis = new BufferedInputStream(is)) {
            byte[] buf = new byte[8192]; int n;
            while ((n = bis.read(buf)) > 0) bos.write(buf, 0, n);
        }
        return bos.toByteArray();
    }

    private static String readFile(File f) throws IOException {
        try (FileInputStream fis = new FileInputStream(f)) { return readStream(fis); }
    }

    private static void writeFile(File f, String s) throws IOException {
        f.getParentFile().mkdirs();
        try (FileOutputStream fos = new FileOutputStream(f)) { fos.write(s.getBytes("utf-8")); }
    }

    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }
}
