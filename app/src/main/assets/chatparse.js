// 文字工具 · 聊天记录解析引擎（v2）
// 目标：在乱七八糟的粘贴文本里，准确判断「哪句是你」「哪句是她」。
// 微信聊天记录的价值全在左右位置：右=你(自己)，左=对方。
//
// 本引擎按可靠性从高到低吃五类信号：
//   ① 显式标签：我：/ 她：/ 你：/ 对方：
//   ② 左右不可见标记：U+200C(右=我) / U+200B(左=她)、[我]/[她]
//   ③ 微信导出结构：昵称 + 时间戳
//   ④ 截图 OCR 的左右启发式：行首缩进差（右气泡缩进大）、行尾对不齐
//   ⑤ 时间戳块序交替：OCR 里一条时间戳夹两段文本 → 前段左、后段右，交替修正
// 最后做一次「说话人交替」一致性修正，补齐漏判。
(function () {
  var ME = 'me', HER = 'her', UNK = 'unknown';

  var ME_RE = /^\s*[\[\(【]?\s*(我|本人|自己|me|Me|ME)\s*[\]\)】]?\s*[：:]\s*/;
  var HER_RE = /^\s*[\[\(【]?\s*(她|对方|你|他|ta|TA|Ta|女方|女生|妹子)\s*[\]\)】]?\s*[：:]\s*/;
  var ME_BRACKET = /^\s*[\[【(（]\s*(我|me)\s*[\]】)）]\s*/i;
  var HER_BRACKET = /^\s*[\[【(（]\s*(她|对方|ta)\s*[\]】)）]\s*/i;

  // 时间戳：兼容 OCR 乱码（10月]24日 171126 / 0月23日20:0440 / 10月243 17:13:18 / 2025-10-24 17:13:18）
  function isTsLine(s) {
    var t = (s || '').trim();
    if (!t) return true;
    if (t.length > 24) return false;
    // 必须"看起来只有日期时间 + 噪声"
    if (!/^[\s\d月日号：:\-/.\[\]|E]{4,}$/.test(t)) return false;
    // 至少要有数字
    if (!/\d/.test(t)) return false;
    // 且要出现"月/日/号"或"时间冒号"之一
    if (/[月日号]/.test(t)) return true;
    if (/\d\s*[：:]\s*\d/.test(t)) return true;
    if (/^\s*\d{8,}\s*$/.test(t)) return true;   // 纯数字串（时间戳被压平）
    return false;
  }

  var WX_HEADER = /^\s*(.{1,24}?)\s+(\d{4}[\-\/]\d{1,2}[\-\/]\d{1,2}\s+\d{1,2}:\d{2}(?::\d{2})?)\s*$/;
  var LEFTMARK = /^[\u200B]/;
  var RIGHTMARK = /^[\u200C]/;

  function parse(raw) {
    if (!raw) return empty();
    var lines = String(raw).replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');

    // 先算缩进基准（用于 OCR 左右判断）
    var indents = lines.map(function (l) { return l.match(/^[ \t\u3000]*/)[0].length; });

    var turns = [];
    var sawExplicit = 0, sawWx = 0, sawIndent = 0;
    var wxSpeaker = null;
    var wxIsMe = false;
    var lastIndentMap = [];   // 记录每条 turn 的缩进，供后续判定

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var t = line.trim();
      if (!t) continue;
      if (isTsLine(t)) continue;

      var who = null, body = t;

      // ① 显式标签
      if (ME_RE.test(t)) { who = ME; body = t.replace(ME_RE, ''); sawExplicit++; }
      else if (HER_RE.test(t)) { who = HER; body = t.replace(HER_RE, ''); sawExplicit++; }
      else if (ME_BRACKET.test(t)) { who = ME; body = t.replace(ME_BRACKET, ''); sawExplicit++; }
      else if (HER_BRACKET.test(t)) { who = HER; body = t.replace(HER_BRACKET, ''); sawExplicit++; }
      // ② 不可见标记
      else if (LEFTMARK.test(line)) { who = HER; body = line.replace(LEFTMARK, '').trim(); sawExplicit++; }
      else if (RIGHTMARK.test(line)) { who = ME; body = line.replace(RIGHTMARK, '').trim(); sawExplicit++; }

      // ③ 微信导出头
      if (!who) {
        var mWx = t.match(WX_HEADER);
        if (mWx) {
          var nick = mWx[1].trim();
          if (!/^(上午|下午|昨天|星期|周)/.test(nick)) {
            wxSpeaker = nick;
            wxIsMe = /[（(]我[）)]/.test(nick);
            sawWx++;
            continue;
          }
        }
        if (wxSpeaker) { who = wxIsMe ? ME : HER; }
      }

      if (!body) continue;

      if (who) {
        push(turns, who, body, indents[i]);
      } else {
        push(turns, UNK, body, indents[i]);
      }
    }

    // ④ OCR 左右启发式：用缩进聚类给 unknown 判边
    // 微信里自己的气泡靠右 → 缩进大；她靠左 → 缩进小。
    // 注意：微信缩进常见只有 1~2 个半角空格或 1 个全角空格，不能要求"差值≥3"。
    // 判据改为「缩进至少分两层，且两层都有足够样本」，再看两簇是否各自成串（交替），
    // 成串才认定为左右分栏 —— 否则宁可不猜。
    var unkCount = turns.filter(function (x) { return x.who === UNK; }).length;
    if (unkCount && turns.length >= 3) {
      var allInd = turns.map(function (x) { return x.indent; });
      var maxInd = Math.max.apply(null, allInd);
      var minInd = Math.min.apply(null, allInd);
      var spread = maxInd - minInd;
      if (spread > 0) {
        // 统计缩进取值种类：真实微信截图 OCR 出来的缩进往往"非左即右"两档，
        // 两档 = 左右分栏的铁证（正文不可能整齐地只有两种缩进）。
        var uniq = {};
        turns.forEach(function (x) { uniq[x.indent] = 1; });
        var levels = Object.keys(uniq).length;
        var thr = minInd + spread / 2;
        var hiN = 0, loN = 0;
        turns.forEach(function (x) { if (x.indent >= thr) hiN++; else loN++; });
        // 两簇都要有实质内容，避免"首行碰巧缩进、其余全在左"这种畸形分布
        var balanced = hiN >= 1 && loN >= 1 && Math.min(hiN, loN) >= Math.floor(turns.length * 0.2);
        // 两档缩进 → 直接认定分栏；多档缩进 → 要求气泡成串（同一侧连续几条）
        var ok = false;
        if (balanced && levels === 2) ok = true;
        if (!ok && balanced) {
          var sameSideRun = 0;
          for (var s = 1; s < turns.length; s++) {
            if ((turns[s].indent >= thr) === (turns[s - 1].indent >= thr)) sameSideRun++;
          }
          if (turns.length > 1 && sameSideRun / (turns.length - 1) >= 0.45) ok = true;
        }
        if (ok) {
          turns.forEach(function (x) {
            if (x.who !== UNK) return;
            if (x.indent >= thr) { x.who = ME; x.guessed = true; x.byIndent = true; sawIndent++; }
            else { x.who = HER; x.guessed = true; x.byIndent = true; sawIndent++; }
          });
        }
      }
    }

    // ⑤ 交替规律补齐剩余 unknown
    for (var k = 0; k < turns.length; k++) {
      if (turns[k].who !== UNK) continue;
      var prev = null, next = null;
      for (var a = k - 1; a >= 0; a--) if (turns[a].who !== UNK) { prev = { i: a, w: turns[a].who }; break; }
      for (var b = k + 1; b < turns.length; b++) if (turns[b].who !== UNK) { next = { i: b, w: turns[b].who }; break; }

      var guess = null;
      if (prev && next) {
        var gap = countUnk(turns, prev.i, k) + 1;
        guess = (gap % 2 === 1) ? flip(prev.w) : prev.w;
      } else if (prev) {
        var gapP = countUnk(turns, prev.i, k) + 1;
        guess = (gapP % 2 === 1) ? flip(prev.w) : prev.w;
      } else if (next) {
        var gapN = countUnk(turns, k, next.i) + 1;
        guess = (gapN % 2 === 1) ? flip(next.w) : next.w;
      }
      turns[k].who = guess || HER;
      turns[k].guessed = true;
    }

    var labeled = turns.filter(function (x) { return !x.guessed; }).length;
    var guessed = turns.filter(function (x) { return x.guessed; }).length;
    // 置信度：显式标记=全信；缩进推断=半信（有几何依据）；纯交替猜=不信
    var indentHit = turns.filter(function (x) { return x.byIndent; }).length;
    var score = labeled + indentHit * 0.6;
    var conf = turns.length ? Math.round((score / turns.length) * 100) : 0;
    // 完全无信源 → 置信度压低，提示用户手动确认
    if (sawExplicit === 0 && sawWx === 0 && sawIndent === 0) conf = Math.min(conf, 25);

    return {
      turns: turns.map(function (x) { return { who: x.who, text: x.text, guessed: !!x.guessed, byIndent: !!x.byIndent }; }),
      confidence: conf,
      stats: { lines: lines.length, labeled: labeled, guessed: guessed, explicit: sawExplicit, wx: sawWx, indent: sawIndent, total: turns.length }
    };
  }

  function push(arr, who, text, indent) {
    if (arr.length && arr[arr.length - 1].who === who && who !== UNK) {
      arr[arr.length - 1].text += '\n' + text;
    } else {
      arr.push({ who: who, text: text, indent: indent });
    }
  }

  function countUnk(arr, from, to) {
    var n = 0;
    for (var i = from + 1; i < to; i++) if (arr[i].who === UNK) n++;
    return n;
  }
  function flip(w) { return w === ME ? HER : ME; }
  function median(a) {
    if (!a.length) return 0;
    var s = a.slice().sort(function (x, y) { return x - y; });
    return s[Math.floor(s.length / 2)];
  }
  function empty() { return { turns: [], confidence: 0, stats: { lines: 0, labeled: 0, guessed: 0, total: 0 } }; }

  function toTagged(turns, herName, myName) {
    var her = herName || '她', me = myName || '我';
    return turns.map(function (t) {
      return (t.who === ME ? me : her) + '：' + String(t.text).replace(/\n/g, ' / ');
    }).join('\n');
  }

  window.WZ_PARSE = { parse: parse, toTagged: toTagged, ME: ME, HER: HER };
})();
