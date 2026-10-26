// 文字工具 · 前端主逻辑（浏览器端）
// 在 Android WebView 中：经 Android 桥接调用大模型（避开 CORS、密钥不进 JS）。
// 无桥接（桌面预览）或调用失败时：回退到内置离线引擎。
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var LS_HIST = 'wz_history';
  var LS_STYLE = 'wz_use_style';
  var LS_MODEL = 'wz_model';

  var LABELS = {
    'zhipu-glm': '智谱 GLM-4-Flash',
    'tencent-hy3': '腾讯混元 hy3',
    'deepseek-chat': 'DeepSeek V3'
  };

  var hasBridge = (typeof Android !== 'undefined');

  // 关系档案（本地 localStorage，跨会话记忆）
  var DEFAULT_PROFILE = { stage: '', goal: '', timeline: [], notes: '' };
  function loadProfile() {
    try { return Object.assign({}, DEFAULT_PROFILE, JSON.parse(localStorage.getItem('wz_profile') || '{}')); }
    catch (e) { return Object.assign({}, DEFAULT_PROFILE); }
  }
  function saveProfile(p) {
    localStorage.setItem('wz_profile', JSON.stringify(p));
  }
  function profileSummary(p) {
    var lines = [];
    if (p.stage) lines.push('关系阶段：' + p.stage);
    if (p.goal) lines.push('用户目标：' + p.goal);
    if (p.timeline && p.timeline.length) lines.push('进展时间线：' + p.timeline.slice(-8).join('；'));
    if (p.notes) lines.push('备注/她的特点：' + p.notes);
    return lines.join('\n');
  }

  // 对话历史（连贯记忆）
  var history = [];
  try { history = JSON.parse(localStorage.getItem(LS_HIST) || '[]'); } catch (e) { history = []; }
  function toMessages() {
    var msgs = [];
    history.slice(-10).forEach(function (t) {
      msgs.push({ role: 'user', content: t.user });
      msgs.push({ role: 'assistant', content: t.res.reply || '' });
    });
    return msgs;
  }

  // 组装 messages（与后端同源）
  function buildMessages(message, stage, goal, hist, chatlog, mode, useStyle) {
    var prof = profileSummary(loadProfile());
    var sp = window.WZ_SYSTEM_PROMPT || '';
    if (prof) sp += '\n\n【已知关系档案】\n' + prof + '\n（结合档案保持连贯，必要时给出档案更新建议）';
    if (useStyle && window.WZ_USER_STYLE_PROMPT) sp += '\n\n' + window.WZ_USER_STYLE_PROMPT;
    if (mode === 'analysis' && chatlog) sp += '\n\n【当前任务】用户提交的是一段完整聊天记录，请开启完整聊天记录综合分析模式，综合从头到尾研判并给出结构化结论。';

    var messages = [{ role: 'system', content: sp }];
    (hist || []).slice(-12).forEach(function (h) {
      messages.push({ role: h.role === 'user' ? 'user' : 'assistant', content: h.content || '' });
    });

    var userContent;
    if (mode === 'analysis' && chatlog) {
      userContent = '【背景】关系阶段：' + (stage || '见档案') + '；目标：' + (goal || '见档案') +
        '\n【补充情况】' + (message || '无') +
        '\n\n【完整聊天记录（从头到尾）】\n' + chatlog +
        '\n\n请综合研判并给整体打法与下一步。';
    } else {
      userContent = '【背景】关系阶段：' + (stage || '未知') + '；目标：' + (goal || '未知') +
        '\n【对方说了什么 / 当前情况】\n' + message;
    }
    messages.push({ role: 'user', content: userContent });
    return messages;
  }

  // 桥接调用（Promise 化）
  var reqSeq = 0;
  var waiters = {};
  window.__onLLM = function (reqId, result) {
    var w = waiters[reqId];
    if (!w) return;
    delete waiters[reqId];
    w(result);
  };
  function askLLM(modelId, messages, useStyle) {
    return new Promise(function (resolve, reject) {
      if (!hasBridge) { reject(new Error('no-bridge')); return; }
      var reqId = 'r' + (++reqSeq);
      var timer = setTimeout(function () {
        if (waiters[reqId]) { delete waiters[reqId]; reject(new Error('timeout')); }
      }, 30000);
      waiters[reqId] = function (result) {
        clearTimeout(timer);
        resolve(result);
      };
      Android.askLLM(reqId, JSON.stringify({
        model_id: modelId, messages: messages, temperature: 0.9
      }));
    });
  }

  function parseContent(content) {
    if (!content) return null;
    try { return JSON.parse(content); } catch (e) {}
    var m = content.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch (e) {} }
    return null;
  }

  function fillDefaults(r) {
    r.reply = r.reply || '';
    r.analysis = r.analysis || '';
    r.mindset = r.mindset || '';
    r.stage_guess = r.stage_guess || '';
    r.interest_level = r.interest_level || '';
    r.signals = r.signals || [];
    r.provider_label = r.provider_label || '';
    return r;
  }

  // 主流程
  function doChat() {
    var message = $('message').value.trim();
    var chatlog = $('chatlog').value.trim();
    if (!message && !chatlog) { alert('先说说情况，或粘贴完整聊天记录～'); return; }
    var stage = $('stage').value;
    var goal = $('goal').value;
    var mode = chatlog ? 'analysis' : 'single';
    var useStyle = $('useStyle').checked;
    var modelId = $('model').value || 'auto';
    localStorage.setItem(LS_STYLE, useStyle ? '1' : '0');
    localStorage.setItem(LS_MODEL, modelId);

    $('go').disabled = true;
    $('go').textContent = '思考中…';

    function render(res) {
      res = fillDefaults(res);
      var userLabel = message || ('【整段记录分析】' + chatlog.slice(0, 40) + '…');
      history.push({ user: userLabel, res: res });
      localStorage.setItem(LS_HIST, JSON.stringify(history.slice(-20)));
      renderStream();
      $('go').disabled = false;
      $('go').textContent = '支个招 🔥';
    }

    // 显式选离线
    if (modelId === 'offline') {
      var r = mode === 'analysis' && chatlog
        ? window.WZ_OFFLINE.analyzeLog(chatlog)
        : window.WZ_OFFLINE.offlineReply(message, stage, goal, useStyle);
      render(r);
      return;
    }

    var messages = buildMessages(message, stage, goal, toMessages(), chatlog, mode, useStyle);
    askLLM(modelId, messages, useStyle)
      .then(function (result) {
        if (!result || !result.ok) throw new Error(result && result.error ? result.error : 'llm-failed');
        var data = parseContent(result.content);
        if (!data || !data.reply) throw new Error('empty-reply');
        data.provider_label = '🌐 ' + (LABELS[result.provider] || result.provider || '云端');
        render(data);
      })
      .catch(function (err) {
        // 桥接失败 / 超时 / 该模型无密钥 → 离线兜底
        var r = mode === 'analysis' && chatlog
          ? window.WZ_OFFLINE.analyzeLog(chatlog)
          : window.WZ_OFFLINE.offlineReply(message, stage, goal, useStyle);
        if (err && err.message && err.message !== 'no-bridge') {
          r.analysis = '（云端调用失败：' + err.message + '）已自动切离线兜底。\n' + r.analysis;
        }
        render(r);
      });
  }

  // 渲染
  function buildCard(res) {
    var wrap = document.createElement('div');
    wrap.className = 'res-card wrap';

    var head = document.createElement('div');
    head.className = 'res-head';
    var prov = res.provider_label ? ' <span class="prov">' + res.provider_label + '</span>' : '';
    head.innerHTML = '<span>💬 建议回复' + prov + '</span>';
    var copy = document.createElement('button');
    copy.className = 'copy';
    copy.textContent = '复制';
    copy.onclick = function () {
      navigator.clipboard.writeText(res.reply || '');
      copy.textContent = '已复制 ✓';
      setTimeout(function () { copy.textContent = '复制'; }, 1500);
    };
    head.appendChild(copy);
    wrap.appendChild(head);
    var b1 = document.createElement('div');
    b1.className = 'res-body';
    b1.textContent = res.reply || '';
    wrap.appendChild(b1);

    if (res.stage_guess || res.interest_level || (res.signals && res.signals.length)) {
      var h2 = document.createElement('div');
      h2.className = 'res-head'; h2.textContent = '📊 综合研判'; wrap.appendChild(h2);
      var b2 = document.createElement('div');
      b2.className = 'res-body';
      var s = '';
      if (res.stage_guess) s += '阶段判断：' + res.stage_guess + '\n';
      if (res.interest_level) s += '兴趣度：' + res.interest_level + '\n';
      if (res.signals && res.signals.length) s += '关键信号：\n- ' + res.signals.join('\n- ');
      b2.textContent = s; wrap.appendChild(b2);
    }

    var h3 = document.createElement('div'); h3.className = 'res-head'; h3.textContent = '🧠 策略分析'; wrap.appendChild(h3);
    var b3 = document.createElement('div'); b3.className = 'res-body'; b3.textContent = res.analysis || ''; wrap.appendChild(b3);

    var h4 = document.createElement('div'); h4.className = 'res-head'; h4.textContent = '🔥 心态提醒'; wrap.appendChild(h4);
    var b4 = document.createElement('div'); b4.className = 'res-body'; b4.textContent = res.mindset || ''; wrap.appendChild(b4);
    return wrap;
  }

  function renderStream() {
    var stream = $('stream');
    stream.innerHTML = '';
    history.forEach(function (turn) {
      var u = document.createElement('div');
      u.className = 'bubble';
      u.textContent = '🙂 我：' + turn.user;
      stream.appendChild(u);
      stream.appendChild(buildCard(turn.res));
    });
    stream.scrollIntoView({ behavior: 'smooth' });
  }

  // 模型下拉
  function loadModels() {
    var sel = $('model');
    var saved = localStorage.getItem(LS_MODEL) || 'auto';
    var opts = [{ id: 'auto', label: '自动（推荐）' }];
    if (hasBridge) {
      try {
        var enabled = JSON.parse(Android.getEnabledModels() || '[]');
        enabled.forEach(function (m) {
          var label = LABELS[m.id] || m.id;
          if (!m.enabled) label = '⚠ ' + label + '（无密钥）';
          opts.push({ id: m.id, label: label });
        });
      } catch (e) {}
    } else {
      // 桌面预览无桥接：仅展示离线
    }
    opts.push({ id: 'offline', label: '离线话术库（免费兜底）' });

    sel.innerHTML = '';
    opts.forEach(function (o) {
      var el = document.createElement('option');
      el.value = o.id; el.textContent = o.label;
      sel.appendChild(el);
    });
    var ids = opts.map(function (o) { return o.id; });
    sel.value = ids.indexOf(saved) >= 0 ? saved : 'auto';
    sel.onchange = function () { localStorage.setItem(LS_MODEL, sel.value); };
  }

  function loadProfileUI() {
    var p = loadProfile();
    $('p_stage').value = p.stage || '';
    $('p_goal').value = p.goal || '';
    $('p_timeline').value = (p.timeline || []).join('\n');
    $('p_notes').value = p.notes || '';
  }
  function saveProfileUI() {
    saveProfile({
      stage: $('p_stage').value,
      goal: $('p_goal').value,
      timeline: $('p_timeline').value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean),
      notes: $('p_notes').value
    });
    var t = $('saveTip'); t.textContent = '档案已保存 ✓'; t.style.opacity = 1;
    setTimeout(function () { t.style.opacity = 0; }, 1500);
  }

  // 初始化
  function init() {
    $('go').addEventListener('click', doChat);
    $('saveProfile').addEventListener('click', saveProfileUI);
    $('clear').addEventListener('click', function () {
      if (confirm('清空本地对话历史？')) { history = []; localStorage.removeItem(LS_HIST); renderStream(); }
    });
    loadModels();
    loadProfileUI();
    renderStream();
    var savedStyle = localStorage.getItem(LS_STYLE);
    $('useStyle').checked = savedStyle !== '0';
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
