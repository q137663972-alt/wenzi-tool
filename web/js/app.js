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

  function getParsed() {
    var rawLog = $('chatlog').value.trim();
    var dual = collectDual();
    // 优先级：截图识别 > 整段粘贴 > 双窗
    // 截图最准（左右来自像素），整段次之，双窗需人工排先后
    var base = null;
    if (shotTurns && shotTurns.length) {
      base = {
        turns: shotTurns.map(function (t) { return { who: t.who, text: t.text, guessed: !!t.placeholder }; }),
        confidence: 100,
        stats: { total: shotTurns.length, shot: 1 }
      };
    }
    var fromLog = rawLog ? window.WZ_PARSE.parse(rawLog) : null;
    if (base && fromLog && fromLog.turns.length) {
      base.turns = base.turns.concat(fromLog.turns);
      base.stats = fromLog.stats;
    } else if (!base && fromLog && fromLog.turns.length) {
      base = fromLog;
    }
    if (base && dual) base.turns = base.turns.concat(dual.turns);
    if (!base && dual) base = dual;
    parsed = base;
    return parsed;
  }

  function renderChatWin() {
    var win = $('chatWin');
    var p = getParsed();
    if (!p || !p.turns.length) { win.style.display = 'none'; return; }
    win.style.display = 'block';

    var conf = p.confidence;
    var level = conf >= 80 ? 'high' : (conf >= 40 ? 'mid' : 'low');
    var note = (p.stats && p.stats.shot)
      ? '截图识别（左右按像素判定）'
      : (p.stats && p.stats.dual
        ? '双窗录入，归属确定'
        : (level === 'high' ? '说话人识别清晰'
          : (level === 'mid' ? '部分靠推断，点气泡可改' : '几乎全靠推断，点气泡翻转修正')));

    var list = $('chatList');
    list.innerHTML = '';
    // 时间线：从上到下 = 最早 → 最新（她左 / 我右），原生 DOM 顺序即视觉顺序
    var head = document.createElement('div');
    head.className = 'chat-conf';
    head.innerHTML = '共 <b>' + p.turns.length + '</b> 条 · 置信度 <b class="' + level + '">' + conf + '%</b> · ' + note;
    list.appendChild(head);
    for (var i = 0; i < p.turns.length; i++) {
      list.appendChild(buildBubble(p.turns[i]));
    }
    // 滚到底部看最新一句
    requestAnimationFrame(function () { list.scrollTop = list.scrollHeight; });
  }

  function buildBubble(t) {
    var row = document.createElement('div');
    row.className = 'chat-row ' + (t.who === 'me' ? 'right' : 'left');
    if (t.who === 'me') row.className += ' right';

    var bubble = document.createElement('div');
    bubble.className = 'chat-bubble ' + (t.who === 'me' ? 'me' : 'her') + (t.guessed ? ' unsure' : '');
    if (!t.text) {
      // 截图切出气泡但没读到文字 → 可点击直接补
      bubble.className += ' empty';
      bubble.textContent = '点这里补上这句…';
    } else {
      bubble.textContent = t.text;
    }
    bubble.onclick = function () {
      if (!t.text) {
        var v = window.prompt('这句说的是什么？', '');
        if (v == null) return;
        t.text = v.trim();
        if (!t.text) return;
        t.guessed = false;
        var nr = buildBubble(t);
        row.parentNode.replaceChild(nr, row);
        return;
      }
      t.who = t.who === 'me' ? 'her' : 'me';
      t.guessed = false;
      var newRow = buildBubble(t);
      row.parentNode.replaceChild(newRow, row);
    };

    var who = document.createElement('div');
    who.className = 'chat-who';
    who.textContent = (t.who === 'me' ? '我' : ($('herName').value.trim() || '她')) + (t.guessed ? ' ?' : '');

    row.appendChild(bubble);
    row.appendChild(who);
    return row;
  }

  // ---------- 截图识别 ----------
  // 分工（实测得出）：
  //   像素 → 每个气泡的 y 与左右（准确率 5/5，且不吃配色）
  //   模型 → 只读文字（准确率 5/5）
  // 模型判左右会错 3/5，所以绝不让它判 side。
  var shots = [];        // [{img, dataUrl, bubbles}]
  var shotTurns = [];    // 从截图得到的 turns

  var SHOT_OCR_PROMPT =
    '你是微信聊天截图 OCR。任务只有一个：把图里**所有聊天气泡中的文字**按从上到下的顺序读出来。\n' +
    '规则：\n' +
    '1. 只输出 JSON 数组，形如 [{"text":"原文字"}]，不要任何解释、不要 markdown 代码块。\n' +
    '2. 一条气泡 = 一个元素。文字照抄，不要改错别字、不要补标点、不要翻译。\n' +
    '3. **不要输出头像、昵称、时间戳、"以下为新消息"这类系统提示**。\n' +
    '4. 不要判断左右，不要编号。\n' +
    '5. 气泡里的 emoji 保留原样。';

  function addShotFiles(files) {
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return;
    var jobs = list.map(function (f) {
      return window.WZ_SHOT.loadImage(f).then(function (img) {
        var dataUrl = window.WZ_SHOT.toDataUrl(img, 1280);
        var cv = window.WZ_SHOT.toCanvas(img, 720);
        var bubbles = window.WZ_SHOT.segment(cv);
        shots.push({ img: img, dataUrl: dataUrl, bubbles: bubbles, name: f.name || 'screenshot' });
      }).catch(function () {});
    });
    $('shotStatus').textContent = '正在读取截图…';
    Promise.all(jobs).then(function () {
      renderShotList();
      var tot = shots.reduce(function (s, x) { return s + x.bubbles.length; }, 0);
      $('shotStatus').innerHTML = '已加 <b>' + shots.length + '</b> 张图 · 切出 <b>' + tot + '</b> 个气泡';
      parseShots();
    });
  }

  function renderShotList() {
    var box = $('shotList');
    box.innerHTML = '';
    shots.forEach(function (s, i) {
      var item = document.createElement('div');
      item.className = 'shot-item';
      var im = document.createElement('img');
      im.src = s.dataUrl;
      item.appendChild(im);
      var x = document.createElement('div');
      x.className = 'shot-x'; x.textContent = '×';
      x.onclick = function () { shots.splice(i, 1); renderShotList(); parseShots(); };
      item.appendChild(x);
      var tag = document.createElement('div');
      tag.className = 'shot-tag';
      tag.textContent = s.bubbles.length + ' 条';
      item.appendChild(tag);
      box.appendChild(item);
    });
  }

  // 把多张截图的气泡按 y 串起来（同一张图内从上到下，图与图按加入顺序）
  function allBubbles() {
    var out = [];
    shots.forEach(function (s) { out = out.concat(s.bubbles); });
    return out;
  }

  function parseShots() {
    if (!shots.length) { shotTurns = []; return Promise.resolve([]); }
    var bubbles = allBubbles();
    if (!bubbles.length) {
      $('shotStatus').textContent = '没切出气泡，试试原图/未压缩的截图。';
      return Promise.resolve([]);
    }

    var modelId = $('model').value || 'auto';
    if (modelId === 'offline' || !hasBridge) {
      // 离线：只能用像素骨架（左右和顺序已对，文字留空待补）
      shotTurns = window.WZ_SHOT.skeleton(bubbles);
      $('shotStatus').innerHTML = '离线模式：已按像素切出 <b>' + bubbles.length + '</b> 条并可判断左右，点虚线气泡可补文字。';
      renderChatWin();
      return Promise.resolve(shotTurns);
    }

    $('shotStatus').innerHTML = '识别文字中…（切出 <b>' + bubbles.length + '</b> 个气泡）';
    // 逐张送模型，保证文字与气泡的对应关系不乱
    var idx = 0;
    var textsAll = [];
    function next() {
      if (idx >= shots.length) return Promise.resolve();
      var s = shots[idx++];
      var msgs = [
        { role: 'system', content: SHOT_OCR_PROMPT },
        {
          role: 'user', content: [
            { type: 'image_url', image_url: { url: s.dataUrl } },
            { type: 'text', text: '按从上到下顺序输出所有聊天气泡的文字 JSON 数组。' }
          ]
        }
      ];
      return askLLM(modelId, msgs, 0.05, 1000, { vision: true })
        .then(function (res) {
          if (res && res.ok) {
            var arr = parseTextArray(res.content);
            textsAll.push(arr);
          } else {
            textsAll.push([]);
          }
          return next();
        })
        .catch(function () { textsAll.push([]); return next(); });
    }

    return next().then(function () {
      var turns = [];
      shots.forEach(function (s, i) {
        var texts = textsAll[i] || [];
        turns = turns.concat(window.WZ_SHOT.align(s.bubbles, texts));
      });
      shotTurns = turns;
      var got = turns.length, total = bubbles.length;
      if (got) {
        $('shotStatus').innerHTML = '识别完成：<b>' + got + '</b> 条对话已还原（气泡 ' + total + ' 个）' +
          (got < total ? '　<span style="color:#ffc857">有条未识别出文字，可在下方双窗补充</span>' : '');
      } else {
        $('shotStatus').innerHTML = '文字没读出来（可能是密钥不支持看图）。已按像素切出 <b>' + total + '</b> 条，左右已判定，文字请手动补。';
        shotTurns = window.WZ_SHOT.skeleton(bubbles);
      }
      renderChatWin();
    });
  }

  // 模型返回可能是纯数组、也可能是 {texts:[...]} / 带代码块，全部兜住
  function parseTextArray(content) {
    if (!content) return [];
    var s = String(content).replace(/```json/gi, '').replace(/```/g, '').trim();
    var arr = null;
    var m = s.match(/\[[\s\S]*\]/);
    if (m) { try { arr = JSON.parse(m[0]); } catch (e) {} }
    if (!arr) {
      var m2 = s.match(/\{[\s\S]*\}/);
      if (m2) {
        try {
          var o = JSON.parse(m2[0]);
          if (Array.isArray(o.texts)) arr = o.texts;
          else if (Array.isArray(o.turns)) arr = o.turns;
          else if (Array.isArray(o.messages)) arr = o.messages;
        } catch (e) {}
      }
    }
    if (!Array.isArray(arr)) return [];
    return arr.map(function (x) {
      if (typeof x === 'string') return x;
      return x && (x.text || x.content || '') || '';
    }).filter(Boolean);
  }

  // ---------- 桥接 ----------
  var reqSeq = 0;
  var waiters = {};
  window.__onLLM = function (reqId, result) {
    var w = waiters[reqId];
    if (!w) return;
    delete waiters[reqId];
    // 原生通常回对象；但若某层把它序列化成字符串，这里兜一下，避免上层全部失效
    if (typeof result === 'string') {
      try { result = JSON.parse(result); } catch (e) { result = { ok: false, error: result }; }
    }
    w(result);
  };
  function askLLM(modelId, messages, temperature, maxTokens, opts) {
    return new Promise(function (resolve, reject) {
      if (!hasBridge) { reject(new Error('no-bridge')); return; }
      var reqId = 'r' + (++reqSeq);
      var timer = setTimeout(function () {
        if (waiters[reqId]) { delete waiters[reqId]; reject(new Error('timeout')); }
      }, maxTokens ? 90000 : 45000);
      waiters[reqId] = function (result) { clearTimeout(timer); resolve(result); };
      var payload = {
        model_id: modelId, messages: messages, temperature: temperature == null ? 0.85 : temperature
      };
      if (maxTokens) payload.max_tokens = maxTokens;
      // 看图请求 → 原生层切到 config.vision（多模态模型），不影响对话模型
      if (opts && opts.vision) payload.vision_model = true;
      try {
        Android.askLLM(reqId, JSON.stringify(payload));
      } catch (e) {
        delete waiters[reqId]; clearTimeout(timer); reject(e);
      }
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
    var out = {
      stage: r.stage || '', stage_confidence: r.stage_confidence || '',
      read: r.read || '', dont: r.dont || '', profile_update: r.profile_update || '',
      dynamics: r.dynamics || null, thread: r.thread || '',
      options: []
    };

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
      var userContent = buildUserContent(message, tagged, herName, (p && p.turns) || []);
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

  function buildUserContent(message, tagged, herName, turns) {
    var s = '';
    if (tagged) {
      s += '【聊天记录（已标注说话人，我=用户本人，' + herName + '=对方）】\n' + tagged + '\n\n';
    }
    // 锚点：最近 3 回合 + 她最后一句，确保话术接得住上文（治"前后不通"）
    if (turns && turns.length) {
      var recent = turns.slice(-3);
      s += '【最近 3 回合（从上到下，时间序）】\n';
      recent.forEach(function (t) {
        s += (t.who === 'me' ? '我' : herName) + '：' + (t.text || '（空）') + '\n';
      });
      var lastHer = null;
      for (var i = turns.length - 1; i >= 0; i--) { if (turns[i].who === 'her') { lastHer = turns[i].text; break; } }
      if (lastHer) s += '\n【锚点·她最后一句（话术必须先接这句）】\n' + lastHer + '\n\n';
    }
    if (message) {
      s += '【当前情况/她刚说了什么（补充）】\n' + message + '\n\n';
    }
    s += '请按 JSON 格式输出：先用 dynamics 看清这一句的动作/风险，再用 thread 写清这一轮怎么接上文，最后给三档话术（稳/撩/撤），每条带「她可能怎么回→我怎么接」，且每条 text 必须先接住她最后一句。话术必须是能直接发的成品句。';
    return s;
  }

  function offlineFallback(message, stage, goal, useStyle, tagged) {
    try {
      if (tagged && window.WZ_OFFLINE.analyzeLog) return window.WZ_OFFLINE.analyzeLog(tagged);
      return window.WZ_OFFLINE.offlineReply(message, stage, goal, useStyle, tagged);
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

    // 对话动力学（来自文件 taxonomy 的识别结构）
    var dyn = res.dynamics;
    if (dyn) {
      var dh = document.createElement('div');
      dh.className = 'dyn-line';
      var parts = [];
      if (dyn.she_move && dyn.she_move !== '无') parts.push('她：' + dyn.she_move);
      if (dyn.user_move && dyn.user_move !== '无') parts.push('你：' + dyn.user_move);
      var riskTag = '';
      if (dyn.risk && dyn.risk !== '低') {
        var lvl = dyn.risk === '极高' ? 'ext' : (dyn.risk === '高' ? 'hi' : 'mid');
        riskTag = ' <span class="dyn-risk ' + lvl + '">' + dyn.risk + '风险</span>';
      }
      var lbl = (Array.isArray(dyn.labels) && dyn.labels.length) ? ' 〔' + dyn.labels.join('/') + '〕' : '';
      dh.innerHTML = '🧭 ' + (parts.join(' ｜ ') || '动力学平稳') + riskTag + (lbl ? '<span class="dyn-lbl">' + lbl + '</span>' : '');
      wrap.appendChild(dh);
      if (dyn.note) {
        var dn = document.createElement('div');
        dn.className = 'dyn-note';
        dn.textContent = dyn.note;
        wrap.appendChild(dn);
      }
    }

    // 接话逻辑（治"前后不通"）
    if (res.thread) {
      var th = document.createElement('div');
      th.className = 'thread-line';
      th.innerHTML = '🔗 接话逻辑：' + res.thread;
      wrap.appendChild(th);
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
    // ---------- 截图识别事件 ----------
    var zone = $('shotZone');
    var fileInput = $('shotFile');
    if (zone && fileInput) {
      zone.addEventListener('click', function () { fileInput.click(); });
      fileInput.addEventListener('change', function () {
        addShotFiles(fileInput.files);
        fileInput.value = '';
      });
      // 拖拽
      ['dragenter', 'dragover'].forEach(function (ev) {
        zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.add('hover'); });
      });
      ['dragleave', 'drop'].forEach(function (ev) {
        zone.addEventListener(ev, function (e) { e.preventDefault(); zone.classList.remove('hover'); });
      });
      zone.addEventListener('drop', function (e) {
        if (e.dataTransfer && e.dataTransfer.files) addShotFiles(e.dataTransfer.files);
      });
      // 桌面端 Ctrl+V 直接贴图
      document.addEventListener('paste', function (e) {
        if (!e.clipboardData) return;
        var imgs = [];
        for (var i = 0; i < e.clipboardData.items.length; i++) {
          var it = e.clipboardData.items[i];
          if (it.type.indexOf('image') === 0) {
            var f = it.getAsFile();
            if (f) imgs.push(f);
          }
        }
        if (imgs.length) { e.preventDefault(); addShotFiles(imgs); }
      });
    }

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
