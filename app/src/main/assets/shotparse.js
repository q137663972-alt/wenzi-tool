// 文字工具 · 截图识别引擎（v3）
// 目标：微信不能多选复制 → 直接贴截图，自动还原成「我 / 她」时间线。
//
// 【为什么这么设计】
// 实测（glm-4v-flash / glm-4v-plus）：
//   · 模型读文字 → 5/5 全对
//   · 模型判断左右 → 3/5 判反（不可用）
//   · 模型给坐标   → 全部报 50%，完全无效
// 结论：文字交给模型，左右交给像素。这是唯一稳定的分工。
//
// 两条路：
//   A) 多模态模型（有视觉密钥时）：模型只做 OCR 出文字，像素分析给每条的左右与 y
//   B) 本地 OCR（无密钥/离线）：Canvas 切气泡 + 系统 OCR，或让用户手填
// 两条路的输入输出都是 [{who, text}]，可互换。
(function () {
  var ME = 'me', HER = 'her';

  // ---------------- 像素分割：从截图里切出气泡 ----------------
  // 不依赖微信绿，任何配色/深色模式都成立：靠"与背景色的差异"找前景。
  function segment(canvas) {
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    var W = canvas.width, H = canvas.height;
    if (!W || !H) return [];
    var d = ctx.getImageData(0, 0, W, H).data;
    function at(x, y) { var i = (y * W + x) * 4; return [d[i], d[i + 1], d[i + 2]]; }

    // 背景色 = 四角众数
    var corners = [at(2, 2), at(W - 3, 2), at(2, H - 3), at(W - 3, H - 3)].map(function (c) { return c.join(','); });
    var freq = {};
    corners.forEach(function (c) { freq[c] = (freq[c] || 0) + 1; });
    var bgStr = Object.keys(freq).sort(function (a, b) { return freq[b] - freq[a]; })[0];
    var bg = bgStr.split(',').map(Number);

    function isFg(c) {
      return Math.abs(c[0] - bg[0]) + Math.abs(c[1] - bg[1]) + Math.abs(c[2] - bg[2]) > 30;
    }

    // 按 y 连续聚成行块（一个气泡 = 一个块）
    var blocks = [];
    for (var y = 0; y < H; y++) {
      var xs = [];
      for (var x = 0; x < W; x++) if (isFg(at(x, y))) xs.push(x);
      if (!xs.length) continue;
      var last = blocks[blocks.length - 1];
      if (last && y - last.y1 <= 4) { last.y1 = y; last.rows.push(xs); }
      else blocks.push({ y0: y, y1: y, rows: [xs] });
    }

    var out = [];
    for (var bi = 0; bi < blocks.length; bi++) {
      var b = blocks[bi];
      var h = b.y1 - b.y0;
      if (h < 18) continue;   // 太薄 → 时间戳/噪声

      var cover = new Int32Array(W);
      for (var r = 0; r < b.rows.length; r++) {
        var row = b.rows[r];
        for (var k = 0; k < row.length; k++) cover[row[k]]++;
      }
      var nb = b.rows.length;

      // x 方向连续段（该块内覆盖率 > 50% 的列）
      var segs = [], st = null;
      for (var cx0 = 0; cx0 < W; cx0++) {
        if (cover[cx0] > nb * 0.5) { if (st === null) st = cx0; }
        else if (st !== null) { segs.push([st, cx0 - 1]); st = null; }
      }
      if (st !== null) segs.push([st, W - 1]);
      if (!segs.length) continue;

      // 头像 = 贴边且窄的段（微信头像靠边、宽约 1/8~1/6）
      var cands = segs.filter(function (s) {
        var wRatio = (s[1] - s[0]) / W;
        var touchL = s[0] < W * 0.06, touchR = s[1] > W * 0.94;
        return !(wRatio < 0.26 && (touchL || touchR));
      });
      if (!cands.length) cands = segs;

      // 气泡主体 = 最宽的段
      var bub = cands[0];
      for (var ci = 1; ci < cands.length; ci++) {
        if (cands[ci][1] - cands[ci][0] > bub[1] - bub[0]) bub = cands[ci];
      }
      var center = (bub[0] + bub[1]) / 2 / W * 100;
      out.push({
        y0: b.y0, y1: b.y1,
        x0: bub[0], x1: bub[1],
        center: Math.round(center * 10) / 10,
        who: center > 50 ? ME : HER
      });
    }
    return out;
  }

  // 把元数据气泡与识别出的文字对齐：
  // 模型按从上到下吐文字，像素按从上到下给气泡 → 顺序一一对应即可。
  // 条数不一致时按序就近分配（宁少不多，多的文字并到最后一个）。
  function align(bubbles, texts) {
    var turns = [];
    var n = Math.min(bubbles.length, texts.length);
    for (var i = 0; i < n; i++) {
      var t = String(texts[i] || '').trim();
      if (!t) continue;
      turns.push({ who: bubbles[i].who, text: t, guessed: false });
    }
    // 文字比气泡多 → 多出来的按最后一条的 side 追加
    if (texts.length > n && turns.length) {
      for (var j = n; j < texts.length; j++) {
        var s = String(texts[j] || '').trim();
        if (s) turns.push({ who: turns[turns.length - 1].who, text: s, guessed: true });
      }
    }
    return mergeAdjacent(turns);
  }

  // 同一侧连续多条 → 合并（微信里自己连发几条，本质是一段话）
  function mergeAdjacent(turns) {
    var out = [];
    for (var i = 0; i < turns.length; i++) {
      var cur = turns[i];
      var prev = out[out.length - 1];
      if (prev && prev.who === cur.who) prev.text += '\n' + cur.text;
      else out.push({ who: cur.who, text: cur.text, guessed: !!cur.guessed });
    }
    return out;
  }

  // ---------------- 本地 OCR 兜底变体 ----------------
  // 没有多模态密钥时：像素切出气泡 → 让用户逐条确认/补文字。
  // 比"整张图啥都出不来"有用得多：前后顺序和左右都已经排好了。
  function skeleton(bubbles) {
    return bubbles.map(function (b, i) {
      return {
        who: b.who,
        text: '',
        guessed: false,
        index: i,
        placeholder: true
      };
    });
  }

  // ---------------- 图片预处理 ----------------
  // 大图先缩放：手机截图 1080x2400 直接逐像素扫太慢，缩到宽 ≤ 720 足够判左右。
  function loadImage(fileOrDataUrl) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('image-load-failed')); };
      if (typeof fileOrDataUrl === 'string') img.src = fileOrDataUrl;
      else img.src = URL.createObjectURL(fileOrDataUrl);
    });
  }

  function toCanvas(img, maxW) {
    maxW = maxW || 720;
    var scale = Math.min(1, maxW / img.width);
    var cv = document.createElement('canvas');
    cv.width = Math.round(img.width * scale);
    cv.height = Math.round(img.height * scale);
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    return cv;
  }

  // 转 dataURL（给多模态模型用），限制长边避免请求过大
  function toDataUrl(img, maxSide) {
    maxSide = maxSide || 1280;
    var scale = Math.min(1, maxSide / Math.max(img.width, img.height));
    var cv = document.createElement('canvas');
    cv.width = Math.round(img.width * scale);
    cv.height = Math.round(img.height * scale);
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/jpeg', 0.85);
  }

  window.WZ_SHOT = {
    segment: segment,
    align: align,
    skeleton: skeleton,
    mergeAdjacent: mergeAdjacent,
    loadImage: loadImage,
    toCanvas: toCanvas,
    toDataUrl: toDataUrl
  };
})();
