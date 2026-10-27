// 文字工具 · 版本检查 / 热更状态（纯 H5，无需改 APK）
// 能力：
//   - 显示「客户端(APK)版本」与「当前 H5 版本(build)」
//   - 启动自动检查一次，主动「显示有无更新」
//   - 「检查更新」按钮：拉线上 update.json，与本地 build 比对
//   - 「立即应用」按钮：刷新页面；原生会在每次启动时自动拉取最新 H5，
//     所以绝大多数情况下刷新即生效（仅「App 一直开着、期间发布了新版」需彻底重开）
(function () {
  var $ = function (id) { return document.getElementById(id); };
  // 本地版本元数据（由 gen-pack 注入 zip，随热更解压到 files/hot/version.json）
  var LOCAL_VER_URL = 'version.json';
  // 兜底热更根（优先用原生 config.hot_base）
  var FALLBACK_HOT = 'https://q137663972-alt.github.io/wenzi-tool/';

  function getHotBase() {
    try {
      if (typeof Android !== 'undefined') {
        var cfg = JSON.parse(Android.getConfig() || '{}');
        if (cfg.hot_base) return cfg.hot_base;
      }
    } catch (e) {}
    return FALLBACK_HOT;
  }

  // APK 版本写在 WebView UA 里（原生 setUserAgentString 追加 " WenziTool/<versionName>"）
  function getApkVersion() {
    var m = (navigator.userAgent || '').match(/WenziTool\/([\d.]+)/);
    return m ? m[1] : '—';
  }

  var state = { localBuild: '—', remoteBuild: null, remoteTs: '' };

  function shortBuild(b) {
    if (!b || b === '—') return '—';
    return b.length > 8 ? b.slice(0, 8) : b;
  }

  function renderVersions() {
    if ($('verApk')) $('verApk').textContent = getApkVersion();
    if ($('verH5')) $('verH5').textContent = shortBuild(state.localBuild);
  }

  function setState(text, hasUpdate) {
    if ($('verState')) $('verState').textContent = text;
    if ($('verApply')) $('verApply').style.display = hasUpdate ? '' : 'none';
  }

  function checkUpdate(manual) {
    var base = getHotBase();
    fetch(base + 'update.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (upd) {
        if (!upd || !upd.build) {
          if (manual) setState('未能获取更新信息，稍后再试', false);
          return;
        }
        state.remoteBuild = upd.build;
        state.remoteTs = upd.ts || '';
        var newer = state.localBuild && state.localBuild !== upd.build;
        if (newer) {
          var t = upd.ts ? '（' + String(upd.ts).slice(0, 10) + '）' : '';
          setState('🔔 发现新版本 ' + shortBuild(upd.build) + t + '，点「立即应用」刷新即可生效', true);
        } else {
          setState('✅ 已是最新（' + shortBuild(upd.build) + '）', false);
        }
      })
      .catch(function () {
        if (manual) setState('检查更新失败（网络问题）', false);
      });
  }

  function initUpdate() {
    // 先读本地 build
    fetch(LOCAL_VER_URL, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (v) {
        if (v && v.build) state.localBuild = v.build;
        renderVersions();
        // 启动自动检查一次（主动显示有无更新）
        checkUpdate(false);
      })
      .catch(function () { renderVersions(); });

    if ($('verCheck')) {
      $('verCheck').onclick = function () { setState('检查中…', false); checkUpdate(true); };
    }
    if ($('verApply')) {
      $('verApply').onclick = function () {
        // 若原生提供了「强制重新拉取并刷新」桥，则走它；否则直接刷新页面。
        // 原生每次启动都会自动拉取最新 H5，刷新通常即生效。
        try {
          if (typeof Android !== 'undefined' && Android.applyUpdate) { Android.applyUpdate(); return; }
        } catch (e) {}
        location.reload();
      };
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUpdate);
  else initUpdate();
})();
