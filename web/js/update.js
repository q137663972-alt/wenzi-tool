// 文字工具 · 版本检查 / 热更状态
// 两种运行环境自适应：
//   A) 带原生桥（APK ≥ 3.2.0）：checkUpdate → Android.getAppVersion/getLocalBuild 取本地版本；
//      applyUpdate → Android.applyUpdate() 真·强制更新（重下拉→校验→替换→清缓存→重载，不用重开 App）
//   B) 无桥（旧 APK / 浏览器里）：退回 fetch 比对 update.json，「立即应用」= 刷新页面
// 状态回调：原生通过 window.__onUpdate({state,msg}) 回报进度。
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var LOCAL_VER_URL = 'version.json';
  var FALLBACK_HOT = 'https://q137663972-alt.github.io/wenzi-tool/';

  var BASE_DIRTY = false; // 是否有待应用的新版本

  function hasBridge() { return typeof Android !== 'undefined'; }

  function getHotBase() {
    try {
      if (hasBridge() && Android.getConfig) {
        var cfg = JSON.parse(Android.getConfig() || '{}');
        if (cfg.hot_base) return cfg.hot_base;
      }
    } catch (e) {}
    return FALLBACK_HOT;
  }

  function getApkVersion() {
    try {
      if (hasBridge() && Android.getAppVersion) {
        var v = JSON.parse(Android.getAppVersion() || '{}');
        if (v.versionName) return v.versionName;
      }
    } catch (e) {}
    var m = (navigator.userAgent || '').match(/WenziTool\/([\d.]+)/);
    return m ? m[1] : '—';
  }

  var state = { localBuild: '', remoteBuild: null };

  function shortBuild(b) {
    if (!b) return '—';
    return b.length > 8 ? b.slice(0, 8) : b;
  }

  function renderVersions() {
    if ($('verApk')) $('verApk').textContent = getApkVersion();
    if ($('verH5')) $('verH5').textContent = shortBuild(state.localBuild);
  }

  function setState(text, hasUpdate) {
    BASE_DIRTY = !!hasUpdate;
    if ($('verState')) $('verState').textContent = text;
    if ($('verApply')) $('verApply').style.display = hasUpdate ? '' : 'none';
    if ($('verApply')) $('verApply').textContent = hasBridge() ? '立即更新' : '立即应用';
  }

  function setBusy(on) {
    if ($('verCheck')) $('verCheck').disabled = !!on;
    if ($('verApply') && on) $('verApply').disabled = true;
    if ($('verApply') && !on) $('verApply').disabled = false;
    if ($('verCheck')) $('verCheck').textContent = on ? '检查中…' : '检查更新';
  }

  // ---- 原生回调：applyUpdate 的进度与结果 ----
  window.__onUpdate = function (r) {
    if (typeof r === 'string') { try { r = JSON.parse(r); } catch (e) { r = { state: 'fail', msg: r }; } }
    var st = (r && r.state) || '';
    var msg = (r && r.msg) || '';
    if (st === 'downloading') { setState('⏳ ' + msg, false); setBusy(true); return; }
    if (st === 'applied') {
      // 原生已 reload 到新内容；这里把状态改好并刷新版本号
      setState('✅ ' + msg, false);
      setBusy(false);
      // reload 后页面会重新初始化，这里读一次新 build 让条上数字立刻对
      fetch(LOCAL_VER_URL, { cache: 'no-store' })
        .then(function (r2) { return r2.ok ? r2.json() : null; })
        .then(function (v) { if (v && v.build) { state.localBuild = v.build; renderVersions(); } })
        .catch(function () {});
      return;
    }
    if (st === 'apk') { setState('⚠️ ' + msg, false); setBusy(false); return; }
    if (st === 'fail') { setState('❌ ' + msg, true); setBusy(false); return; }
    if (st === 'checking') { setState('检查中…', false); setBusy(true); return; }
  };

  // ---- 检查更新 ----
  function checkUpdate(manual) {
    // 有桥优先：本地 build 由原生读 __build__（最权威），再比对线上
    if (manual) setBusy(true);
    var base = getHotBase();
    var localP = Promise.resolve(state.localBuild);
    if (hasBridge() && Android.getLocalBuild) {
      try { state.localBuild = Android.getLocalBuild() || state.localBuild; } catch (e) {}
      renderVersions();
    }
    localP.then(function (lb) {
      return fetch(base + 'update.json', { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (upd) {
          if (!upd || !upd.build) {
            if (manual) setState('未能获取更新信息，稍后再试', BASE_DIRTY);
            return;
          }
          state.remoteBuild = upd.build;
          // 本地 build 从 version.json 兜底读（没有原生桥时）
          var finish = function (local) {
            state.localBuild = local;
            renderVersions();
            var newer = local && local !== upd.build;
            if (newer) {
              var t = upd.ts ? '（' + String(upd.ts).slice(0, 10) + '）' : '';
              setState('🔔 发现新版本 ' + shortBuild(upd.build) + t + '，点「立即更新」即可生效', true);
            } else {
              setState('✅ 已是最新（' + shortBuild(upd.build) + '）', false);
            }
          };
          if (lb) finish(lb);
          else {
            fetch(LOCAL_VER_URL, { cache: 'no-store' })
              .then(function (r) { return r.ok ? r.json() : null; })
              .then(function (v) { finish((v && v.build) || ''); })
              .catch(function () { finish(''); });
          }
        });
    }).catch(function () {
      if (manual) setState('检查更新失败（网络问题）', BASE_DIRTY);
    }).then(function () { setBusy(false); });
  }

  function initUpdate() {
    renderVersions();
    // 启动先读本地 build，再自动检查一次（主动显示有无更新）
    fetch(LOCAL_VER_URL, { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (v) { if (v && v.build) state.localBuild = v.build; })
      .catch(function () {})
      .then(function () {
        renderVersions();
        checkUpdate(false);
      });

    if ($('verCheck')) {
      $('verCheck').onclick = function () { setState('检查中…', BASE_DIRTY); checkUpdate(true); };
    }
    if ($('verApply')) {
      $('verApply').onclick = function () {
        // 真·强制更新：优先走原生桥（重下拉+替换+清缓存+重载，不用重开 App）
        if (hasBridge() && Android.applyUpdate) {
          setState('⏳ 正在强制更新…', false);
          setBusy(true);
          try { Android.applyUpdate(); } catch (e) {
            setState('❌ 启动更新失败，改为刷新页面', true);
            setBusy(false);
            setTimeout(function () { location.reload(); }, 600);
          }
          // 兜底：原生 25 秒没回调，解除按钮锁定，避免卡死
          setTimeout(function () { setBusy(false); }, 25000);
          return;
        }
        // 无桥：只能刷新（原生每次启动会自动拉取最新 H5）
        location.reload();
      };
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initUpdate);
  else initUpdate();
})();
