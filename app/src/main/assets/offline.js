// 文字工具 · 离线启发式引擎（无网络/无密钥时的兜底，与原 Python offline_engine 同源）
// v3.2：① 每个场景补"对话动力学 dynamics"+"接话逻辑 thread"，和在线版结构对齐；
//       ② analyzeLog 会解析她最后一句作为锚点，输出不再凭空起话题（治"前后不通"）；
//       ③ 立场不变：操控/打压/忽冷忽热那套不教，只做识别 + 健康接法。
(function () {
  var SCENARIOS = [
    {
      keys: ["pua","套路","玩我","忽冷忽热","打压我","贬低我","煤气灯","画饼","冷暴力","控制我","拿捏我","是不是在套路","被操控","怎么骗","怎么骗她","怎么操控"],
      send: false,
      reply: "操控那套咱不教——靠打压、忽冷忽热拿捏人，那叫骗不是魅力，聪明女生一眼看穿，真喜欢你的也会被吓跑。要进攻就走正道：主动不舔、模糊邀约拿线下、推拉造张力。",
      analysis: "你想'进攻'，我懂。但进攻靠吸引+主动+敢升级，不是靠欺骗控制。PUA 那套（negging 打压、冷热操控、画饼）短期可能有点用，长期必反噬——你撩到的是怕你的人，不是爱你的人。",
      mindset: "真正能'拿下'的人，赢在'我敢往前走，也接得住被拒绝'的松弛，不赢在算计。",
      dynamics: { she_move: "无", user_move: "想走操控路线", risk: "高", labels: ["D04","D09"], note: "你自己想用操控/打压——红牌拦下，改健康版。" },
      thread: "先点破操控必反噬，再把你引回'主动不舔'的正道，不给你越线的话术。"
    },
    {
      keys: ["进攻","拿下","主动追","怎么追","怎么撩她","升温","推进关系","升级关系","主动约","怎么主动","撩她","主动聊","进一步"],
      send: true,
      reply: "这周末带你去个地方，比你手机有意思",
      analysis: "进攻本质是把关系往前推，不是把人按头。真喜欢的女生吃'有主见但不逼人'这一套。主动一次看反馈：有回应就推进，没回应就撤，这叫高位；连发硬撩那叫纠缠，低位。",
      mindset: "进攻的人最帅的不是技术，是'敢往前走也接得住拒绝'的松弛。先把自己活利索，再去拿下。",
      dynamics: { she_move: "IOI(假设)", user_move: "想推进", risk: "低", labels: [], note: "假设她给到 IOI，正常推进即可。" },
      thread: "承接'想进攻'的意图，给一句模糊邀约把线上感觉落地成线下，不纠缠。"
    },
    {
      keys: ["已读不回","不回我","没回","隔很久","半天不回","不回消息"],
      send: true,
      reply: "刷到个东西莫名觉得你会喜欢，发你看看",
      analysis: "你这问题出在：之前的消息要么太无聊、要么暴露需求感像查岗。连发'在吗''怎么不回'直接判负。先停手，用有趣内容轻量破冰，把节奏拿回来。她回了就正常聊，没回就继续过你自己的日子。",
      mindset: "她回不回是她的事，你稳不稳是你的事。后者你说了算。",
      dynamics: { she_move: "IOD(已读不回)", user_move: "需求感过强/查岗", risk: "中", labels: ["D03"], note: "她已读不回=IOD，你越追越低位，先撤。" },
      thread: "先接住'她不回'这个冷信号，用轻量有趣内容破冰，绝不再发'怎么不回'。"
    },
    {
      keys: ["好人卡","你是好人","你是个好人","你人挺好"],
      send: true,
      reply: "行，那我领了好人头衔就撤了，你好好滴（笑）",
      analysis: "你这问题出在：吸引没建立，或者你太快表白/太舔。她礼貌退场，别用'我哪里不好我改'去跪，那等于彻底出局。领卡撤身，退回朋友位，重新建吸引。",
      mindset: "喜欢是加分，不是跪下。领了卡撤身，反而留个念想。",
      dynamics: { she_move: "IOD(礼貌退场)", user_move: "太快表白/低位", risk: "中", labels: [], note: "她在温和拒绝，别跪，领卡撤身保框架。" },
      thread: "接住'好人卡'的拒绝，用幽默领卡+撤身，把姿态拉回高位而不是追问'我哪不好'。"
    },
    {
      keys: ["约不出","改天","没空","怎么约","约她","不出来","不肯出来"],
      send: true,
      reply: "行，那等你有空了主动喊我，我可不天天有空（笑）",
      analysis: "你这问题出在：'改天'基本=没兴趣或吸引不够。反复问'这周六行吗'像催债，瞬间低位。把邀约变成'你来找我'，框架立刻回来。",
      mindset: "你是来谈恋爱的，不是来应聘的。松弛点反而赢了。",
      dynamics: { she_move: "IOD(推托)", user_move: "硬邀约显低位", risk: "低", labels: [], note: "她推托=吸引力不够，别催，把框架交还给她。" },
      thread: "接住她的'改天'推托，不追问不改期，用'你喊我'把主动权交还，保住框架。"
    },
    {
      keys: ["敷衍","就回嗯","回哦","回哈哈","惜字如金","不接话"],
      send: true,
      reply: "你这回复热情度，跟你手机电量一样低啊",
      analysis: "你这问题出在：单方面热，她没参与感。继续查岗式关怀'今天过得咋样'只会让敷衍升级成沉默。先停，用调侃或新话题重启。",
      mindset: "聊天是双向投资，她不接就别硬喂。把精力收回到自己身上。",
      dynamics: { she_move: "IOD(敷衍)", user_move: "单方面热/查岗", risk: "中", labels: ["D03"], note: "她敷衍=你话太密太舔，撤一步给空间。" },
      thread: "接住她的敷衍，用调侃点破但不纠缠，把球抛回给她而不是继续单方面输出。"
    },
    {
      keys: ["冷战","闹矛盾","生气了","吵架","不理我"],
      send: true,
      reply: "咱俩这冷战戏码演得跟韩剧似的，累了，先吃饭",
      analysis: "你这问题出在：小题大做别哄太狠，哄=认输框架。先分谁的问题，轻描淡写破冰，别写小作文道歉——姿态越低她越不珍惜。",
      mindset: "关系里谁先稳，谁就握着方向盘。先吃饭，别内耗。",
      dynamics: { she_move: "框架对抗/冷处理", user_move: "可能哄太狠", risk: "低", labels: [], note: "她在冷处理测试你框架，轻描淡写破冰别认输。" },
      thread: "接住冷战气氛，用自嘲式破冰把氛围拉松，不写小作文道歉、不认输框架。"
    },
    {
      keys: ["喜欢我吗","喜不喜欢我","对我有意思","在意我","暧昧","什么意思"],
      send: true,
      reply: "我怎么感觉你对我比对外人耐心点",
      analysis: "你这问题出在：别直接问'你喜不喜欢我'，那把压力甩给对方，容易把暧昧聊死。用轻微试探看反馈——接=有戏，躲=没戏，及时止损。",
      mindset: "看'投资度'不看'单方面输出'。她愿为你花时间情绪，才是真信号。",
      dynamics: { she_move: "无", user_move: "直接逼问显需求感", risk: "低", labels: [], note: "直接问'喜不喜欢'把压力甩给她，易聊死，改试探。" },
      thread: "接住你想确认关系的冲动，换成轻微试探（'你对我比对别人耐心'），看反馈不逼问。"
    },
    {
      keys: ["挽回","前任","复合","分手","断联","复联"],
      send: true,
      reply: "路过咱以前那家店，突然想起你。最近还好吗",
      analysis: "你这问题出在：分手原因没解决前，任何复合都是重演。先变好再出现，别用'我离不开你'暴露需求感，那只会让前任更确信分手正确。",
      mindset: "先把自己活成花，再等雪。强求不如重构吸引。",
      dynamics: { she_move: "复联试探", user_move: "可能暴露需求感", risk: "低", labels: [], note: "复联先轻点，不暴露离不开，给空间看她反应。" },
      thread: "接住'挽回/复联'的意图，用轻量怀旧破冰，不暴露需求感、不逼复合。"
    },
    {
      keys: ["要微信","要联系方式","加好友","留个微信","怎么加"],
      send: true,
      reply: "你这人聊着还挺投缘，加个微信，省得下次想找你还得在这儿蹲",
      analysis: "你这问题出在：没价值铺垫就'美女留个微信'=骚扰。先让她觉得你这人有点意思，再顺手要，成功率翻倍。",
      mindset: "价值前置，号码自然来。别做没铺垫的伸手党。",
      dynamics: { she_move: "无", user_move: "可能没铺垫就伸手", risk: "低", labels: [], note: "要号码前先让她觉得你有点意思，别做伸手党。" },
      thread: "承接'要微信'需求，给一句带价值铺垫的顺手要法，自然不骚扰。"
    },
    {
      keys: ["谜男","m3","m3模型","吸引阶段","舒适感","舒适阶段","诱惑阶段","dh","高价值展示","兴趣指标","ioi","iod","社交认证","孔雀","群体理论","neg","否定","阶段错位","从吸引到"],
      send: false,
      reply: "用 M3 把局面结构化：你现在卡在 A（吸引）还是 C（舒适）？没进 C 就别表白，那叫阶段错位直接出局。先 DHV 展示你的生活底气（自然带出热爱，别自夸），看她给 IOI（主动接话/问私事）再往 C 推，进 C 后聊真实连接，窗口期到了才定性。",
      analysis: "兄弟，M3 的核心就一句：吸引和舒适是两个游戏，别串台。你这问题大概率是阶段错位——在 A 就表白/讨好（瞬间低位），或没 C 就硬撩（对方警觉）。先判断她给的是 IOI 还是 IOD：有回应推进，没回应撤步，这才是高位。",
      mindset: "M3 是地图不是作弊码。阶段对了，真诚比技术管用；阶段错了，技术救不了你。先把 A 做扎实。",
      dynamics: { she_move: "无", user_move: "可能阶段错位", risk: "低", labels: [], note: "先判阶段再出招，别 A 阶段就表白/硬撩。" },
      thread: "先帮他把局面归到 M3 阶段，再给对应打法，避免阶段错位的致命伤。"
    },
    {
      keys: ["她打压我","她贬低我","她让我自我怀疑","她忽冷忽热","她在吊我","她控制我","她查我","她不让我","她威胁我","她删我","她冷暴力我"],
      send: false,
      reply: "先停。她这波是 D02 贬低 / D03 忽冷忽热 / D07 控制 里的一种，目的就是拿捏你。你越解释越低位。回一句不接招的：'你这么说挺没意思的，我先忙了'，然后真去忙你自己的。",
      analysis: "兄弟，识别出来：她在用打压/冷热/控制拿捏你。这套吃'你越在意越上头'。破解只有一招——不接招、把注意力收回到自己身上。你稳，她才慌；你舔，她才拿捏。",
      mindset: "识别操控是第一课。你不被拿捏，主动权就回来了。别用讨好换她的好脸色。",
      dynamics: { she_move: "D02贬低/D03冷热/D07控制(识别)", user_move: "可能越解释越低位", risk: "高", labels: ["D02","D03","D07"], note: "对方在用操控手段对付你——点破+不接招+抽身，不给讨好话术。" },
      thread: "先识别对方在用什么操控码，再给一句不接招、保框架的抽身话，绝不帮你讨好回去。"
    }
  ];

  var GENERIC = {
    send: true,
    reply: "你这人有点难搞啊，但我偏偏就喜欢难搞的（不是）",
    analysis: "先摸清你们现在什么阶段、她最近啥反应。记住一条：情绪价值>逻辑说服，女生要的是感觉不是道理。先把聊天气氛搞活，再谈升级。",
    mindset: "你稳，世界才稳；你慌，对方就跑。先把日子过明白，桃花自己撞上来。",
    dynamics: { she_move: "无", user_move: "无", risk: "低", labels: [], note: "" },
    thread: "没法精判时，先给一句带点张力的破冰，把气氛盘活再谈升级。"
  };

  function lastHerLine(tagged) {
    if (!tagged) return '';
    var lines = tagged.split('\n');
    for (var i = lines.length - 1; i >= 0; i--) {
      var m = lines[i].match(/^\s*她[：:]\s*(.+)$/);
      if (m && m[1].trim()) return m[1].trim();
    }
    return '';
  }

  function applyUserStyle(text) {
    if (!text) return text;
    var t = text;
    t = t.replace(/😂|哈哈+|haha|笑死|噗嗤/g, "@@");
    t = t.replace(/^\s*[（(]?[兄弟哥们][，, ]*/, "");
    t = t.replace(/[。！]+$/, "");
    if (t.indexOf("参") < 0 && t.indexOf("@@") < 0) {
      if (t.indexOf("，") >= 0 || t.indexOf(",") >= 0) {
        t = t.replace("，", "参，", 1);
      } else {
        t = t + "参";
      }
    }
    return t;
  }

  function offlineReply(message, stage, goal, useStyle, tagged) {
    var text = (message || "") + " " + (stage || "") + " " + (goal || "");
    var matched = null;
    for (var i = 0; i < SCENARIOS.length; i++) {
      var s = SCENARIOS[i];
      for (var j = 0; j < s.keys.length; j++) {
        if (text.indexOf(s.keys[j]) >= 0) { matched = s; break; }
      }
      if (matched) break;
    }
    var base = matched || GENERIC;
    var reply = base.reply;
    if (useStyle && base.send) reply = applyUserStyle(reply);
    return {
      reply: reply, analysis: base.analysis, mindset: base.mindset,
      dynamics: base.dynamics || null, thread: base.thread || '',
      provider_label: "离线话术库 (免费兜底)", mode: "offline"
    };
  }

  function analyzeLog(tagged) {
    var t = tagged || "";
    var warmWords = ["哈哈","喜欢","想你","可爱","想见","晚安","宝贝","想念","在吗","想我"];
    var flatWords = ["嗯","哦","呵呵","在忙","先睡","改天","随便","滚","烦"];
    var warm = 0, flat = 0;
    warmWords.forEach(function (w) { warm += countOcc(t, w); });
    flatWords.forEach(function (w) { flat += countOcc(t, w); });
    var questions = countOcc(t, "？") + countOcc(t, "?");
    var score = warm * 2 - flat + questions;
    var level = score >= 6 ? "高" : (score >= 1 ? "中" : "低");

    var lastHer = lastHerLine(t);
    var sheMove = flat > warm ? "IOD(整体偏冷)" : (warm > 0 ? "IOI(整体偏热)" : "无");
    var anchor = lastHer ? "她最后那句是：「" + lastHer + "」——话术先接这句，别自顾自开新话题。" : "没解析出她最后一句，按整体信号调。";

    return {
      reply: "（整段分析·离线）兄弟，离线只能粗判。她热情信号 " + warm + " 次、敷衍 " + flat + " 次、提问 " + questions + " 次，兴趣度【" + level + "】。" + anchor + "真要精准研判，配个大模型 key 让它通读全记录。现在先按这个调：多主动展示价值、少查岗式提问、用模糊邀约拿线下。",
      analysis: "兄弟，整段看下来，她给你的互动意愿是核心信号，兴趣度【" + level + "】。下一步别急着表白，先把线上聊出的感觉落地成一次见面（模糊邀约），见面才是决胜场。",
      mindset: "记录会说话。别盯着单句纠结，看整体趋势——她整体是靠近还是远离，比一句'哈哈'重要十倍。",
      stage_guess: "离线无法精判（建议配大模型）",
      interest_level: level,
      signals: ["热情信号 " + warm + " 次", "敷衍信号 " + flat + " 次", "她提问 " + questions + " 次"],
      dynamics: { she_move: sheMove, user_move: "无", risk: "低", labels: [], note: anchor },
      thread: anchor,
      provider_label: "离线话术库 (免费兜底)", mode: "offline"
    };
  }

  function countOcc(hay, needle) {
    if (!hay) return 0;
    var c = 0, idx = 0;
    while ((idx = hay.indexOf(needle, idx)) >= 0) { c++; idx += needle.length; }
    return c;
  }

  window.WZ_OFFLINE = { offlineReply: offlineReply, analyzeLog: analyzeLog };
})();
