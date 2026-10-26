// 文字工具 · 前端主逻辑 v2
// 关键变化：
//  1) 聊天记录先经 WZ_PARSE 打标签（我/她），彻底解决"分不清谁是谁"；
//  2) 自动判断关系阶段 → 请用户确认 → 再出话术（防止阶段错位）；
//  3) 输出三档话术（稳/撩/撤）+ 每条附「她会怎么回→你怎么接」预判；
//  4) 话术一键复制，且是干净成品句，不带括号解释。
(function () {
  var $ = function (id) { return document.getElementById(id); };
  var LS_HIST = 'wz_history';
  var LS_STYLE = 'wz_use_style';
  var LS_MODEL = 'wz_model';
  var LS_HER = 'wz_her_name';

  var LABELS = {
    'zhipu-glm': '智谱 GLM-4-Flash',
    'tencent-hy3': '腾讯混元 hy3',
    'deepseek-chat': 'DeepSeek V3'
  };

  var hasBridge = (typeof Android !== 'undefined');

  var history = [];
  try { history = JSON.parse(localStorage.getItem(LS_HIST) || '[]'); } catch (e) { history = []; }

  // ---------- 聊天记录解析状态 ----------
  var parsed = null;        // { turns, confidence, stats }
  var confirmedStage = '';  // 用户确认的阶段

  // ---------- 聊天窗口（她左 / 我右，微信式气泡） ----------
  // 数据来源优先级：
  //   A) 双窗（她说 / 我说的）逐条录入 —— 微信不能多选复制，靠这个打
  //   B) 整段粘贴 —— 有就优先当骨架，双窗内容按时间追加在后
  // 两条路都走同一个 turns 结构，AI 侧无差别。
  function collectDual() {
    function lines(id) {
      return ($(id).value || '').split('\n')
        .map(function (s) { return s.replace(/^\s*[\[\(【]?\s*(我|她|对方|你)\s*[\]\)】]?\s*[：:]\s*/, '').trim(); })
        .filter(function (s) { return s && !/^[＋+]$/.test(s); });
    }
    var her = lines('herLog'), me = lines('meLog');
    if (!her.length && !me.length) return null;

    // 两窗按"各记各的"录入时无法知道真实先后，取较短一侧的长度做上限，
    // 然后交替拼成时间线（他一句她一句是最常见的聊天节奏）。
    var turns = [], n = Math.max(her.length, me.length);
    var hi = 0, mi = 0;
    // 第一条归属：看哪边先有内容且"她"通常先开口 —— 但更稳的是：谁多谁后
    for (var k = 0; k < n; k++) {
      if (hi < her.length) turns.push({ who: 'her', text: her[hi++], guessed: false });
      if (mi < me.length) turns.push({ who: 'me', text: me[mi++], guessed: false });
    }
    return { turns: turns, confidence: 100, stats: { total: turns.length, explicit: turns.length, dual: 1 } };
  }

  function mergeLogs(dual, rawLog) {
    var fromLog = rawLog ? window.WZ_PARSE.parse(rawLog) : null;
    if (dual && fromLog && fromLog.turns.length) {
      // 整段在前（更早），双窗在后（最新几句）—— 合并成一条时间线
      return {
        turns: fromLog.turns.concat(dual.turns),
        confidence: 100,
        stats: fromLog.stats
      };
    }
    return dual || fromLog;
  }

  function getParsed() {
    var rawLog = $('chatlog').value.trim();
    var dual = collectDual();
    if (!dual && !rawLog) { parsed = null; return null; }
    parsed = mergeLogs(dual, rawLog);
    return parsed;
  }

  function renderChatWin() {
    var win = $('chatWin');
    var p = getParsed();
    if (!p || !p.turns.length) { win.style.display = 'none'; return; }
    win.style.display = 'block';

    var conf = p.confidence;
    var level = conf >= 80 ? 'high' : (conf >= 40 ? 'mid' : 'low');
    var note = p.stats && p.stats.dual
      ? '双窗录入，归属确定'
      : (level === 'high' ? '说话人识别清晰'
        : (level === 'mid' ? '部分靠推断，点气泡可改' : '几乎全靠推断，点气泡翻转修正'));

    var list = $('chatList');
    list.innerHTML = '';
    var show = p.turns.slice(-40);
    var head = document.createElement('div');
    head.className = 'chat-conf';
    head.innerHTML = '共 <b>' + p.turns.length + '</b> 条 · 置信度 <b class="' + level + '">' + conf + '%</b> · ' + note;
    list.appendChild(head);
    for (var i = 0; i < show.length; i++) {
      list.appendChild(buildBubble(show[i]));
    }
  }

  function buildBubble(t) {
    var row = document.createElement('div');
    row.className = 'chat-row ' + (t.who === 'me' ? 'right' : 'left');

    var bubble = document.createElement('div');
    bubble.className = 'chat-bubble ' + (t.who === 'me' ? 'me' : 'her') + (t.guessed ? ' unsure' : '');
    bubble.textContent = t.text;
    bubble.onclick = function () {
      t.who = t.who === 'me' ? 'her' : 'me';
      t.guessed = false;
      var newRow = buildBubble(t);
      row.parentNode.replaceChild(newRow, row);
    };

    var who = document.createElement('div');
    who.className = 'chat-who';
    who.textContent = (t.who === 'me' ? '我' : ($('herName').value.trim() || '她')) + (t.guessed ? ' ?' : '');

    if (t.who === 'me') row.className += ' right';
    row.appendChild(bubble);
    row.appendChild(who);
    return row;
  }

  // ---------- 桥接 ----------
  var reqSeq = 0;
  var waiters = {};
  window.__onLLM = function (reqId, result) {
    var w = waiters[reqId];
    if (!w) return;
    delete waiters[reqId];
    w(result);
  };
  function askLLM(modelId, messages, temperature) {
    return new Promise(function (resolve, reject) {
      if (!hasBridge) { reject(new Error('no-bridge')); return; }
      var reqId = 'r' + (++reqSeq);
      var timer = setTimeout(function () {
        if (waiters[reqId]) { delete waiters[reqId]; reject(new Error('timeout')); }
      }, 45000);
      waiters[reqId] = function (result) { clearTimeout(timer); resolve(result); };
      Android.askLLM(reqId, JSON.stringify({
        model_id: modelId, messages: messages, temperature: temperature == null ? 0.85 : temperature
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

  // ---------- 结构归一化：兼容旧{reply,analysis,mindset}与新{stage,read,options} ----------
  function normalize(r) {
    r = r || {};
    var out = { stage: r.stage || '', stage_confidence: r.stage_confidence || '', read: r.read || '', dont: r.dont || '', profile_update: r.profile_update || '', options: [] };

    if (Array.isArray(r.options) && r.options.length) {
      out.options = r.options.slice(0, 3).map(function (o, i) {
        return {
          tone: o.tone || ['稳', '撩', '撤'][i] || '稳',
          text: o.text || '',
          why: o.why || '',
          predict: o.predict || '',
          then: o.then || ''
        };
      });
    } else if (r.reply) {
      // 旧格式 / 离线兜底 → 包成单条「稳」
      out.options = [{ tone: '稳', text: r.reply, why: r.analysis || '', predict: '', then: '' }];
      out.read = r.mindset || out.read;
    }
    if (!out.read && r.analysis) out.read = r.analysis;
    return out;
  }

  // ---------- 阶段判断 ----------
  function guessStage(modelId, taggedLog) {
    if (modelId === 'offline' || !hasBridge) return Promise.resolve(null);
    var msgs = [
      { role: 'system', content: window.WZ_STAGE_PROMPT },
      { role: 'user', content: taggedLog.slice(-6000) }
    ];
    return askLLM(modelId, msgs, 0.3)
      .then(function (res) {
        if (!res || !res.ok) return null;
        return parseContent(res.content);
      })
      .catch(function () { return null; });
  }

  function renderStageCard(info) {
    var card = $('stageCard');
    if (!info || !info.stage) { card.style.display = 'none'; return; }
    card.style.display = 'block';
    $('stageGuess').innerHTML = '<b>' + info.stage + '</b>' +
      (info.confidence ? ' <span class="conf">置信度' + info.confidence + '</span>' : '');
    $('stageReason').textContent = (info.reason || '') +
      (info.signals && info.signals.length ? '\n信号：' + info.signals.join(' / ') : '');
  }

  // ---------- 主流程 ----------
  function doChat() {
    var message = $('message').value.trim();
    var herName = $('herName').value.trim() || '她';

    var p = getParsed();
    var hasDual = $('herLog').value.trim() || $('meLog').value.trim();

    if (!message && !p && !hasDual) { alert('先把她说的话填进来～（她最后那句 + 她说过的/你说过的）'); return; }

    var stage = confirmedStage || $('stage').value || '';
    var goal = $('goal').value || '';
    var useStyle = $('useStyle').checked;
    var modelId = $('model').value || 'auto';
    localStorage.setItem(LS_STYLE, useStyle ? '1' : '0');
    localStorage.setItem(LS_MODEL, modelId);
    localStorage.setItem(LS_HER, herName);

    var tagged = '';
    if (p && p.turns.length) {
      tagged = window.WZ_PARSE.toTagged(p.turns, herName, '我');
    }

    $('go').disabled = true;
    $('go').textContent = '想着呢…';
    $('stageStatus').textContent = '';

    var chain = Promise.resolve();

    // 若还没确认阶段且有聊天记录 → 先自动判断，给用户确认
    if (tagged && !confirmedStage && !$('stage').value) {
      $('stageStatus').textContent = '先判断一下你们到哪一步…';
      chain = guessStage(modelId, tagged).then(function (info) {
        if (info && info.stage) {
          renderStageCard(info);
          $('stageStatus').textContent = '↑ 阶段我判断在这，确认或改一下再发一次（也可直接不管它，按判断出话术）';
          confirmedStage = info.stage;
          $('stage').value = '';
          $('stageConfirmed').textContent = '已确认阶段：' + info.stage;
        }
        return null;
      });
    }

    chain.then(function () {
      var sp = buildSystem(stage || confirmedStage, goal, useStyle, herName);
      var userContent = buildUserContent(message, tagged, herName);
      var messages = [{ role: 'system', content: sp }, { role: 'user', content: userContent }];

      if (modelId === 'offline') {
        var off = offlineFallback(message, stage || confirmedStage, goal, useStyle, tagged);
        render(off);
        return;
      }
      return askLLM(modelId, messages, 0.85)
        .then(function (result) {
          if (!result || !result.ok) throw new Error(result && result.error ? result.error : 'llm-failed');
          var data = parseContent(result.content);
          if (!data || (!data.options && !data.reply)) throw new Error('empty-reply');
          data.provider_label = '🌐 ' + (LABELS[result.provider] || result.provider || '云端');
          render(data);
        })
        .catch(function (err) {
          var off = offlineFallback(message, stage || confirmedStage, goal, useStyle, tagged);
          if (err && err.message && err.message !== 'no-bridge') {
            off.read = '（云端失败：' + err.message + '）已切离线兜底。' + (off.read || '');
          }
          render(off);
        });
    });
  }

  function buildSystem(stage, goal, useStyle, herName) {
    var sp = window.WZ_SYSTEM_PROMPT || '';
    if (stage) sp += '\n\n【本轮关系阶段（已确认）】' + stage + '　请按此阶段的打法给话术，不要越阶段。';
    if (goal) sp += '\n【用户目标】' + goal;
    if (herName) sp += '\n【对方的称呼】' + herName + '（话术里不必反复叫名字，自然即可）';
    if (useStyle && window.WZ_USER_STYLE_PROMPT) sp += '\n\n' + window.WZ_USER_STYLE_PROMPT;
    return sp;
  }

  function buildUserContent(message, tagged, herName) {
    var s = '';
    if (tagged) {
      s += '【聊天记录（已标注说话人，我=用户本人，' + herName + '=对方）】\n' + tagged + '\n\n';
    }
    if (message) {
      s += '【当前情况/她刚说了什么】\n' + message + '\n\n';
    }
    s += '请按 JSON 格式输出：三档话术（稳/撩/撤），每条带「她可能怎么回→我怎么接」。话术必须是能直接发的成品句。';
    return s;
  }

  function offlineFallback(message, stage, goal, useStyle, tagged) {
    try {
      if (tagged && window.WZ_OFFLINE.analyzeLog) return window.WZ_OFFLINE.analyzeLog(tagged);
      return window.WZ_OFFLINE.offlineReply(message, stage, goal, useStyle);
    } catch (e) {
      return { reply: '（离线话术库也没匹配到，换个说法再试试）', analysis: '' };
    }
  }

  function render(raw) {
    var res = normalize(raw);
    if (raw.provider_label) res.provider_label = raw.provider_label;
    history.push({ user: $('message').value.trim() || '【整段记录】', res: res });
    localStorage.setItem(LS_HIST, JSON.stringify(history.slice(-20)));
    renderStream();
    $('go').disabled = false;
    $('go').textContent = '给话术 🔥';
    $('stageStatus').textContent = '';
  }

  // ---------- 渲染 ----------
  function copyText(text, btn) {
    if (navigator.clipboard) navigator.clipboard.writeText(text);
    else {
      var ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); document.body.removeChild(ta);
    }
    var old = btn.textContent;
    btn.textContent = '已复制 ✓';
    setTimeout(function () { btn.textContent = old; }, 1400);
  }

  function buildCard(res) {
    var wrap = document.createElement('div');
    wrap.className = 'res-card';

    // 阶段 + 点破
    if (res.stage) {
      var sh = document.createElement('div');
      sh.className = 'stage-line';
      sh.innerHTML = '🎯 ' + res.stage + (res.stage_confidence ? ' <span class="conf">' + res.stage_confidence + '</span>' : '');
      wrap.appendChild(sh);
    }
    if (res.read) {
      var rd = document.createElement('div');
      rd.className = 'read-line';
      rd.textContent = res.read;
      wrap.appendChild(rd);
    }

    // 三档话术
    (res.options || []).forEach(function (o) {
      wrap.appendChild(buildOption(o));
    });

    if (res.dont) {
      var d = document.createElement('div');
      d.className = 'dont-line';
      d.textContent = '⛔ 别做：' + res.dont;
      wrap.appendChild(d);
    }
    return wrap;
  }

  function buildOption(o) {
    var box = document.createElement('div');
    box.className = 'opt tone-' + (o.tone === '撩' ? 'liao' : (o.tone === '撤' ? 'che' : 'wen'));

    var head = document.createElement('div');
    head.className = 'opt-head';
    var tag = document.createElement('span');
    tag.className = 'opt-tag';
    tag.textContent = o.tone;
    head.appendChild(tag);

    var cp = document.createElement('button');
    cp.className = 'opt-copy';
    cp.textContent = '复制';
    cp.onclick = function () { copyText(o.text, cp); };
    head.appendChild(cp);
    box.appendChild(head);

    var text = document.createElement('div');
    text.className = 'opt-text';
    text.textContent = o.text;
    box.appendChild(text);

    if (o.why) {
      var why = document.createElement('div');
      why.className = 'opt-why';
      why.textContent = '为什么：' + o.why;
      box.appendChild(why);
    }
    if (o.predict) {
      var pr = document.createElement('div');
      pr.className = 'opt-predict';
      pr.textContent = '→ ' + o.predict;
      box.appendChild(pr);
    }
    if (o.then) {
      var th = document.createElement('div');
      th.className = 'opt-then';
      th.textContent = '↳ 你接：' + o.then.replace(/^那你就[：:]\s*/, '');
      box.appendChild(th);
    }
    return box;
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
    stream.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }

  // ---------- 模型下拉 ----------
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
    $('herName').value = localStorage.getItem(LS_HER) || '';
  }

  function init() {
    $('go').addEventListener('click', doChat);
    $('clear').addEventListener('click', function () {
      if (confirm('清空本地对话历史？')) { history = []; localStorage.removeItem(LS_HIST); renderStream(); }
    });
    // 三个输入区任意变动 → 自动重建聊天窗
    var timer = null;
    function scheduleRebuild() {
      clearTimeout(timer);
      timer = setTimeout(renderChatWin, 350);
    }
    ['chatlog', 'herLog', 'meLog'].forEach(function (id) {
      $(id).addEventListener('input', scheduleRebuild);
    });

    // 「＋ 加一句」：光标落到该窗末尾新行，方便一条条贴
    Array.prototype.forEach.call(document.querySelectorAll('.dual-add'), function (btn) {
      btn.addEventListener('click', function () {
        var id = btn.getAttribute('data-side') === 'me' ? 'meLog' : 'herLog';
        var ta = $(id);
        if (ta.value && !/\n$/.test(ta.value)) ta.value += '\n';
        ta.focus();
        ta.selectionStart = ta.selectionEnd = ta.value.length;
        ta.scrollTop = ta.scrollHeight;
      });
    });
    // 手动改阶段 → 视为已确认
    $('stage').addEventListener('change', function () {
      confirmedStage = $('stage').value;
      $('stageConfirmed').textContent = confirmedStage ? '已确认阶段：' + confirmedStage : '';
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
