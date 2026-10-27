
(function(){
  "use strict";

  // ===== 微信小游戏适配层（本段为移植新增，原网页逻辑在其后）=====
  var MG = {winW:390, winH:844, dpr:1, scale:1, ox:0, oy:0, currentOverlay:null, buttons:[], selPage:0, windowHandlers:{}, docHandlers:{}, els:{}};
  // 文字提示全部取自配置文件 js/textConfig.js，改配置文件即可，找不到文件时用下面的默认值兜底
  var TEXT_CONFIG = (function(){
    var d = {
      healthPrompt: { title: '健康游戏提示 · 适合 8 岁以上玩家', body: '抵制不良游戏，拒绝盗版游戏。注意自我保护，谨防受骗上当。适度游戏益脑，沉迷游戏伤身。合理安排时间，享受健康生活。' },
      ageRating: { title: '适龄提示', badge: '8+', subtitle: '适合 8 岁及以上玩家', body: '本游戏为休闲打砖块玩法，内容健康，无血腥暴力、恐怖、赌博、色情等不适宜内容，无内购与聊天功能，操作简单，适合 8 岁及以上玩家游玩。未成年人请在家长陪同与指导下合理安排游戏时间。', buttonLabel: '适龄提示 · 8+', closeLabel: '知道了' },
      storageNote: '进度存在本机微信存储，不与网页版互通',
      env: 'production'
    };
    try{
      var c = require('./textConfig.js');
      if (c){
        if (c.healthPrompt) d.healthPrompt = c.healthPrompt;
        if (c.ageRating) d.ageRating = c.ageRating;
        if (c.storageNote) d.storageNote = c.storageNote;
        if (c.env) d.env = c.env;
      }
    }catch(e){}
    return d;
  })();
  // 环境标记：测试环境不锁定关卡，生产环境正常顺序锁定；测试环境通关不推进真实解锁进度
  var IS_TEST_ENV = (TEXT_CONFIG.env === 'test' || TEXT_CONFIG.env === 'testing' || TEXT_CONFIG.testMode === true);
  function effectiveUnlocked(){ return IS_TEST_ENV ? 100 : PROG.unlocked; }
  function wxGet(k){ try{ var v = wx.getStorageSync(k); return (v===undefined||v===null)?null:v; }catch(e){ return null; } }
  function wxSet(k,v){ try{ wx.setStorageSync(k,v); }catch(e){} }
  function makeEl(id){
    if (MG.els[id]) return MG.els[id];
    var el = {_id:id, hidden:false, textContent:'', innerHTML:'', className:'', type:'', style:{width:''}, _h:{}, _children:[],
      setAttribute:function(){}, getAttribute:function(){return null;},
      appendChild:function(c){ this._children.push(c); },
      querySelector:function(){ return makeEl(id+'-child'); },
      addEventListener:function(ev,fn){ this._h[ev]=fn; },
      click:function(){ if(this._h.click) this._h.click(); },
      getBoundingClientRect:function(){ return {left:0,top:0,width:MG.winW,height:MG.winH}; },
      setPointerCapture:function(){}};
    el.classList = {toggle:function(){}, add:function(){}, remove:function(){}};
    MG.els[id]=el; return el;
  }
  var _wxCanvas = null;
  try{ _wxCanvas = wx.createCanvas(); }catch(e){ _wxCanvas = null; }
  if (_wxCanvas){
    _wxCanvas._h = {};
    _wxCanvas.addEventListener = function(ev,fn){ this._h[ev]=fn; };
    _wxCanvas.setPointerCapture = function(){};
    _wxCanvas.getBoundingClientRect = function(){ return {left:0,top:0,width:MG.winW,height:MG.winH}; };
  }
  MG.canvasEl = _wxCanvas;
  var document = {
    getElementById:function(id){ return id==='game' ? MG.canvasEl : makeEl(id); },
    createElement:function(tag){ var el=makeEl('el-'+Math.random()); el._id=tag; return el; },
    addEventListener:function(ev,fn){ MG.docHandlers[ev]=fn; },
    hidden:false
  };
  var window = {
    addEventListener:function(ev,fn){ MG.windowHandlers[ev]=fn; },
    localStorage:{getItem:wxGet, setItem:wxSet},
    AudioContext:function(){ if(!wx.createWebAudioContext) throw new Error('no webaudio'); return wx.createWebAudioContext(); },
    webkitAudioContext:function(){ if(!wx.createWebAudioContext) throw new Error('no webaudio'); return wx.createWebAudioContext(); },
    devicePixelRatio:1
  };
  if (typeof performance === 'undefined'){ var performance = {now:function(){ return Date.now(); }}; }


  /* ================= 基础常量（逻辑场地 360 × 640） ================= */
  var W = 360, H = 640;
  var PADDLE_W = 76, PADDLE_H = 11, PADDLE_Y = 588, PADDLE_R = 6;
  var PADDLE_SPEED = 460;               // 键盘移动速度 px/s
  var BALL_R = 4;
  var BALL_SPEED = 330;                 // 基础球速 px/s（按关卡微调）
  var MAX_ANGLE = Math.PI / 3;          // 挡板边缘最大偏角 60°
  var WIN_RATIO = 0.95;
  var STEEL_FADE_AT = 27000;            // 27s 起变淡
  var STEEL_DEAD_AT = 30000;            // 30s 只碰钢块自动熄灭

  var canvas = document.getElementById('game');
  var ctx = canvas.getContext('2d');
  var stage = document.getElementById('stage');

  var hudTime = document.getElementById('hudTime');
  var hudPct  = document.getElementById('hudPct');
  var hudBar  = document.getElementById('hudBar');
  var hudBalls= document.getElementById('hudBalls');
  var hudLv   = document.getElementById('hudLv');
  var hudSub  = document.getElementById('hudSub');
  var btnSpeed= document.getElementById('btnSpeed');
  var btnPause= document.getElementById('btnPause');

  var ovHome  = document.getElementById('ovHome');
  var ovSelect= document.getElementById('ovSelect');
  var ovStart = document.getElementById('ovStart');
  var ovPause = document.getElementById('ovPause');
  var ovWin   = document.getElementById('ovWin');
  var ovFail  = document.getElementById('ovFail');
  var ALL_OV  = [ovHome, ovSelect, ovStart, ovPause, ovWin, ovFail];
  function showOverlay(which){
    ALL_OV.forEach(function(o){ o.hidden = (o !== which); });
    MG.currentOverlay = which ? which._id : null;
  }

  /* ================= 工具 ================= */
  function clamp(v,a,b){ return v<a?a:(v>b?b:v); }
  function fmt(ms){
    if (ms == null || !isFinite(ms)) return '—';
    var t = Math.max(0, ms);
    var m = Math.floor(t/60000), s = Math.floor((t%60000)/1000), c = Math.floor((t%1000)/10);
    function p(n){ return (n<10?'0':'')+n; }
    return m+':'+p(s)+'.'+p(c);
  }
  // 橙色为主：上部略亮 → 下部略深，接近参考图的均匀橙
  function brickColor(row, rows){
    var stops = [
      [255,183,47],   // 亮橙
      [255,163,30],   // 橙
      [255,148,26]    // 深橙
    ];
    var t = rows<=1 ? 0 : row/(rows-1);
    var seg = t * (stops.length-1);
    var i = Math.min(stops.length-2, Math.floor(seg));
    var f = seg - i;
    var a = stops[i], b = stops[i+1];
    var r = Math.round(a[0]+(b[0]-a[0])*f);
    var g = Math.round(a[1]+(b[1]-a[1])*f);
    var bl= Math.round(a[2]+(b[2]-a[2])*f);
    return 'rgb('+r+','+g+','+bl+')';
  }
  // 通用多段渐变取色（各关图案配色用）
  function grad(stops, t){
    t = clamp(t, 0, 1);
    var seg = t * (stops.length - 1);
    var i = Math.min(stops.length - 2, Math.floor(seg));
    var f = seg - i;
    var a = stops[i], b = stops[i + 1];
    return 'rgb(' + Math.round(a[0]+(b[0]-a[0])*f) + ',' + Math.round(a[1]+(b[1]-a[1])*f) + ',' + Math.round(a[2]+(b[2]-a[2])*f) + ')';
  }

  /* ================= 本地进度：解锁关卡 + 每关最佳时间（保存在本机） ================= */
  var PROG = { unlocked: 1, best: {} };
  try {
    var rawProg = window.localStorage.getItem('jy-progress');
    if (rawProg){
      var pp = JSON.parse(rawProg);
      if (pp && pp.unlocked) PROG.unlocked = clamp(parseInt(pp.unlocked,10)||1, 1, 100);
      if (pp && pp.best) PROG.best = pp.best;
    }
  } catch(e){}
  function saveProg(){
    try { window.localStorage.setItem('jy-progress', JSON.stringify(PROG)); } catch(e){}
  }

  /* ================= 自适应难度：未通关尝试次数（单独存本地新键 jy-attempts） =================
     只扶不惩罚：难度靠关卡序号上升；同一关反复未通关才给助力，绝不因打得好调难。
     定义：每次点「开始」进入一局，未通关就退出/回选关/要塞重建，记 1 次未通关尝试；
     通关后该关次数清零。助力只改手感（挡板宽、球速、要塞发球上限），绝不改砖量、
     布局、入口、图案、95% 目标与核心数量/位置。每日关按当天日期单独计次。 */
  var ATT = { lv: {}, dy: {} };
  try {
    var rawAtt = window.localStorage.getItem('jy-attempts');
    if (rawAtt){
      var pa = JSON.parse(rawAtt);
      if (pa && pa.lv) ATT.lv = pa.lv;
      if (pa && pa.dy) ATT.dy = pa.dy;
    }
  } catch(e){}
  function saveAtt(){
    try { window.localStorage.setItem('jy-attempts', JSON.stringify(ATT)); } catch(e){}
  }
  // failedCount = 此前未通关次数；本次挑战序号 = failedCount + 1
  function assistFor(failedCount){
    var no = (failedCount || 0) + 1;
    // 降档：第 21 次挑战起（未通关尝试超过 20 次）在助力 2 之上再降一档，只降一档、
    // 不再继续降；装甲血量 -1、钢框缺口 +1 格由 applyDowngrade 在重建关卡时落实，
    // 要塞发球与助力合计封顶 +2。通关清零后全部取消，恢复原难度。
    var tier = no >= 21 ? 3 : (no >= 5 ? 2 : (no >= 3 ? 1 : 0));
    return {
      no: no, tier: tier, downgrade: tier === 3,
      paddleMul: tier === 3 ? 1.32 : (tier === 2 ? 1.20 : (tier === 1 ? 1.12 : 1)),
      speedMul:  tier === 3 ? 0.76 : (tier === 2 ? 0.85 : (tier === 1 ? 0.92 : 1)),
      servesBonus: tier === 3 ? 2 : (tier === 2 ? 1 : 0),
      armorMinus: tier === 3 ? 1 : 0,
      gapPlus: tier === 3 ? 1 : 0
    };
  }
  function curFailedCount(){
    return S.daily ? (ATT.dy[S.dailyDate] || 0) : (ATT.lv[S.level] || 0);
  }
  // 当前这一局若已开始且未通关，离开/重建时记 1 次未通关尝试（每局只记一次）
  function registerFail(){
    if (!S.attemptActive) return;
    S.attemptActive = false;
    if (S.daily) ATT.dy[S.dailyDate] = (ATT.dy[S.dailyDate] || 0) + 1;
    else ATT.lv[S.level] = (ATT.lv[S.level] || 0) + 1;
    saveAtt();
  }
  function clearAttempts(){
    if (S.daily){ if (ATT.dy[S.dailyDate] != null){ delete ATT.dy[S.dailyDate]; saveAtt(); } }
    else if (ATT.lv[S.level] != null){ delete ATT.lv[S.level]; saveAtt(); }
  }

  // 降档落地（仅 tier 3 时生效，在 loadLevel/loadDailyLevel 构建完关卡后调用）：
     // 装甲砖血量 -1（最低 1）；底部三行钢层里钢块数 >= 8 的行，在最宽缺口一侧去掉
     // 1 格钢，缺口加宽 1 格。不动图案、结构、95% 目标与核心数量/位置，不删任何砖。
  function applyDowngrade(){
    if (!S.assist || !S.assist.downgrade) return;
    S.bricks.forEach(function(b){
      if (b.type === 'armor'){ b.hp = Math.max(1, b.hp - 1); b.maxHp = Math.max(1, b.maxHp - 1); }
    });
    for (var r = ROWS - 3; r < ROWS; r++){
      if (!grid[r]) continue;
      var minC = -1, maxC = -1, steelCnt = 0, cc;
      for (cc = 0; cc < COLS; cc++){
        var cell0 = grid[r][cc];
        if (cell0 && cell0.kind === 'steel'){ steelCnt++; if (minC < 0) minC = cc; maxC = cc; }
      }
      if (steelCnt < 8 || minC < 0) continue;
      var bestStart = -1, bestLen = 0, runStart = -1, runLen = 0;
      for (cc = minC; cc <= maxC; cc++){
        if (!grid[r][cc]){
          if (runStart < 0){ runStart = cc; runLen = 1; } else runLen++;
          if (runLen > bestLen){ bestLen = runLen; bestStart = runStart; }
        } else { runStart = -1; runLen = 0; }
      }
      if (bestStart < 0) continue;
      var target = -1;
      if (bestStart - 1 >= minC && grid[r][bestStart - 1] && grid[r][bestStart - 1].kind === 'steel') target = bestStart - 1;
      else if (bestStart + bestLen <= maxC && grid[r][bestStart + bestLen] && grid[r][bestStart + bestLen].kind === 'steel') target = bestStart + bestLen;
      if (target < 0) continue;
      var stRef = grid[r][target].ref;
      grid[r][target] = null;
      var idx = S.steels.indexOf(stRef);
      if (idx >= 0) S.steels.splice(idx, 1);
    }
  }

  /* ================= 每日关卡存档：最佳时间按 UTC 日期单独保存（键里带日期） =================
     与旅程进度完全分开：不影响 1-30 关解锁、不计入旅程进度；历史日期的最佳时间保留。 */
  var DAILY_BEST = {};
  try {
    var rawDaily = window.localStorage.getItem('jy-daily-best');
    if (rawDaily){
      var pd = JSON.parse(rawDaily);
      if (pd && typeof pd === 'object') DAILY_BEST = pd;
    }
  } catch(e){}
  function saveDailyBest(){
    try { window.localStorage.setItem('jy-daily-best', JSON.stringify(DAILY_BEST)); } catch(e){}
  }
  // 当天 UTC 日期字符串 YYYY-MM-DD（按 UTC 零点换日，不用本地时间）
  function dailyDateStr(){
    var d = new Date();
    function p(n){ return (n<10?'0':'')+n; }
    return d.getUTCFullYear() + '-' + p(d.getUTCMonth()+1) + '-' + p(d.getUTCDate());
  }
  // 字符串哈希（FNV-1a）：日期字符串 → 确定性种子
  function hashStr(str){
    var h = 2166136261;
    for (var i=0;i<str.length;i++){ h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }

  /* ================= 音效：WebAudio 合成，无外部音频文件 =================
     AudioContext 只在玩家点「开始」（用户手势）时创建/恢复，避免浏览器自动播放拦截。
     brick/beam/bomb 等高频事件带节流：同类最小间隔 + 每 100ms 最多叠 5 个声音，
     多球连锁时不会爆音。 */
  var SFX = (function(){
    var actx = null, master = null;
    var enabled = true;                 // 默认开启，可在暂停页切换；选择存本地，下次打开仍生效
    try { enabled = window.localStorage.getItem('jy-sound') !== 'off'; } catch(e){}
    var lastPlay = {};
    var winStart = 0, winCount = 0;
    function unlock(){
      if (!actx){
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        try { actx = new AC(); } catch(e){ return; }
        master = actx.createGain();
        master.gain.value = 0.5;
        master.connect(actx.destination);
      }
      if (actx.state === 'suspended') actx.resume();
    }
    function gate(kind, minGap){
      if (!enabled || !actx || actx.state !== 'running') return false;
      var now = performance.now();
      if (lastPlay[kind] && now - lastPlay[kind] < minGap) return false;
      if (now - winStart > 100){ winStart = now; winCount = 0; }
      if (winCount >= 5) return false;
      winCount++;
      lastPlay[kind] = now;
      return true;
    }
    function tone(freq, dur, type, vol, slideTo, delay){
      var t0 = actx.currentTime + (delay || 0);
      var o = actx.createOscillator(), g = actx.createGain();
      o.type = type || 'square';
      o.frequency.setValueAtTime(freq, t0);
      if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t0 + dur);
      g.gain.setValueAtTime(vol, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      o.connect(g); g.connect(master);
      o.start(t0); o.stop(t0 + dur + 0.03);
    }
    function noise(dur, vol, cutoff){
      var t0 = actx.currentTime;
      var len = Math.max(1, Math.floor(actx.sampleRate * dur));
      var buf = actx.createBuffer(1, len, actx.sampleRate);
      var d = buf.getChannelData(0);
      for (var i=0;i<len;i++) d[i] = (Math.random()*2 - 1) * (1 - i/len);
      var src = actx.createBufferSource(); src.buffer = buf;
      var f = actx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = cutoff || 800;
      var g = actx.createGain(); g.gain.value = vol;
      src.connect(f); f.connect(g); g.connect(master);
      src.start(t0);
    }
    return {
      unlock: unlock,
      isOn: function(){ return enabled; },
      toggle: function(){
        enabled = !enabled;
        try { window.localStorage.setItem('jy-sound', enabled ? 'on' : 'off'); } catch(e){}
        if (enabled) unlock();
        return enabled;
      },
      paddle: function(){ if (gate('paddle', 45)) tone(220, 0.07, 'square', 0.16, 330); },
      wall:   function(){ if (gate('wall', 70)) tone(165, 0.04, 'square', 0.05, 195); },
      brick:  function(){ if (gate('brick', 30)) tone(520 + Math.random()*160, 0.06, 'triangle', 0.14, 240); },
      armor:  function(){ if (gate('armor', 45)) tone(150, 0.05, 'square', 0.12, 105); },
      spawn:  function(){ if (gate('spawn', 60)){ tone(660, 0.07, 'sine', 0.16); tone(990, 0.09, 'sine', 0.16, null, 0.06); } },
      bomb:   function(){ if (gate('bomb', 90)){ noise(0.28, 0.32, 700); tone(90, 0.25, 'sine', 0.28, 40); } },
      beam:   function(){ if (gate('beam', 90)) tone(1200, 0.18, 'sawtooth', 0.10, 180); },
      widen:  function(){ if (gate('widen', 120)){ tone(440, 0.07, 'triangle', 0.16); tone(660, 0.07, 'triangle', 0.16, null, 0.06); tone(880, 0.10, 'triangle', 0.16, null, 0.12); } },
      launch: function(){ if (gate('launch', 100)) tone(300, 0.14, 'sine', 0.18, 620); },
      lost:   function(){ if (gate('lost', 150)) tone(420, 0.16, 'sine', 0.14, 210); },
      win:    function(){ if (gate('win', 200)){ tone(523, 0.11, 'triangle', 0.20); tone(659, 0.11, 'triangle', 0.20, null, 0.10); tone(784, 0.11, 'triangle', 0.20, null, 0.20); tone(1047, 0.20, 'triangle', 0.22, null, 0.30); } }
    };
  })();

  /* ================= 背景音乐：Web Audio 原创合成的轻快循环，无外部音频文件 =================
     原创 8 小节大调循环，76 BPM、4/4，每拍约 0.789 秒、每小节约 3.158 秒、整圈约 25.3 秒，
     无鼓组、无方波、无失真音色。和声为明亮的 I–V–vi–IV 循环（C–G–Am–F，各 1 小节、8 小节走两遍），
     无转调、无紧张和弦。层次：柔和双层微失谐 pad 打底 + 一条清晰轻盈的原创主旋律
     （三角波 + 柔和类钢琴音色，C 大调五声音阶短句动机：前 4 小节提出、后 4 小节呼应微变收尾，
     每轮循环尾音有小变化）+ 每小节起拍极轻的正弦低音根音托底 + 稀疏铃音点缀
     + 很轻的拨弦节奏点缀营造弹跳感（不连续密集琶音）。pad 每小节交叉淡入淡出，
     循环首尾无缝衔接；轻量反馈延迟营造空间感。音乐总增益约 0.19，仍低于音效层。
     只在对局中播放：开始/重玩时启动，暂停时挂起、继续时从原位置续播，
     过关、失败、回选关/首页时停止。连锁、过关等事件只动音效层，不改音乐速度、调性与音量。
     音乐开关与音效开关互不影响：关音乐只停音乐，关音效只停音效。默认开，选择存本地。
     每次 start() 用一个新的 generation 增益节点承载全部新音符；stop() 只清调度器并把
     旧 generation 淡出后断开，旧音符再也不会重响，不会出现两层音乐叠加或停不掉。 */
  var MUSIC = (function(){
    var actx = null, bus = null, gen = null, timer = null;
    var nextTime = 0, bar = 0, loop = 0, paused = false;
    var enabled = true;                 // 默认开启，可在暂停页切换；选择存本地，下次打开仍生效
    try { enabled = window.localStorage.getItem('jy-music') !== 'off'; } catch(e){}
    var BEAT = 60 / 76, BARLEN = BEAT * 4;   // 76 BPM：每拍约 0.789 秒，每小节约 3.158 秒，8 小节约 25.3 秒
    /* 明亮和声循环 I–V–vi–IV，各 1 小节、8 小节里走两遍；低音为各和弦根音。
       每组：[低音根音, pad 三音, 拨弦两音, 铃音]，均为原创和声编排。 */
    var CHORDS = [
      { bass: 130.81, pad: [261.63, 329.63, 392.00], pluck: [523.25, 392.00], bell: 1318.51 },  // I   C 大三和弦
      { bass:  98.00, pad: [246.94, 293.66, 392.00], pluck: [493.88, 392.00], bell: 1174.66 },  // V   G 大三和弦
      { bass: 110.00, pad: [220.00, 261.63, 329.63], pluck: [440.00, 329.63], bell: 1046.50 },  // vi  A 小三和弦
      { bass:  87.31, pad: [174.61, 220.00, 261.63], pluck: [349.23, 261.63], bell: 1318.51 }   // IV  F 大三和弦
    ];
    /* 原创主旋律：C 大调五声音阶（C D E G A）内的短句动机，留白多、不写长线条。
       每小节为一组 [拍偏移, 频率, 时值(拍)]：前半（第 1-4 小节）提出动机，
       后半（第 5-8 小节）呼应再现并微变收尾；第 8 小节尾音在奇数轮改为 D5 作小变化。 */
    var MELODY = [
      [ [0, 659.25, 1], [1, 783.99, 1], [2, 880.00, 1], [3, 783.99, 1] ],   // 1 · C：E5 G5 A5 G5，动机提出
      [ [0, 659.25, 2], [2, 587.33, 2] ],                                   // 2 · G：E5 D5，长音应答
      [ [0, 659.25, 1], [1, 523.25, 1], [2, 440.00, 1], [3, 523.25, 1] ],   // 3 · Am：E5 C5 A4 C5，下行回旋
      [ [0, 587.33, 2], [2, 659.25, 2] ],                                   // 4 · F：D5 E5，半收尾留白
      [ [0, 659.25, 1], [1, 783.99, 1], [2, 880.00, 1], [3, 783.99, 1] ],   // 5 · C：动机呼应再现
      [ [0, 880.00, 2], [2, 783.99, 2] ],                                   // 6 · G：A5 G5，高音起句微变
      [ [0, 659.25, 1], [1, 587.33, 1], [2, 523.25, 1], [3, 587.33, 1] ],   // 7 · Am：E5 D5 C5 D5，级进收束
      [ [0, 659.25, 2], [2, 523.25, 2] ]                                    // 8 · F→C：E5 落回 C5 主音
    ];
    function ensure(){
      if (!actx){
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return false;
        try { actx = new AC(); } catch(e){ return false; }
        bus = actx.createGain();
        bus.gain.value = 0.19;                  // 音乐总增益约 0.19，背景偏上但不抢前景
        bus.connect(actx.destination);
        /* 轻量反馈延迟：约 3/4 拍（0.59 秒）、反馈 0.26、反馈回路低通 1600 Hz，空间感不浑浊。 */
        var delay = actx.createDelay(1.0);
        delay.delayTime.value = BEAT * 0.75;
        var fb = actx.createGain(); fb.gain.value = 0.26;
        var fbFilter = actx.createBiquadFilter();
        fbFilter.type = 'lowpass'; fbFilter.frequency.value = 1600;
        var wet = actx.createGain(); wet.gain.value = 0.14;
        bus.connect(delay);
        delay.connect(fbFilter); fbFilter.connect(fb); fb.connect(delay);
        delay.connect(wet); wet.connect(actx.destination);
      }
      if (actx.state === 'suspended') actx.resume();
      return true;
    }
    /* 双层微失谐 pad：正弦 + 三角（+0.3% 失谐），共用起音 0.45 秒、释放 1.1 秒的包络，
       低通 1100 Hz；每小节一个和弦，释放尾巴伸进下一小节，与下一和弦交叉淡入淡出。 */
    function padTone(freq, t0, vol){
      var g = actx.createGain();
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(vol, t0 + 0.45);
      g.gain.setValueAtTime(vol, t0 + BARLEN);
      g.gain.linearRampToValueAtTime(0, t0 + BARLEN + 1.1);
      var f = actx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = 1100;
      var o1 = actx.createOscillator(); o1.type = 'sine'; o1.frequency.value = freq;
      var o2 = actx.createOscillator(); o2.type = 'triangle'; o2.frequency.value = freq * 1.003;
      o1.connect(f); o2.connect(f); f.connect(g); g.connect(gen);
      o1.start(t0); o2.start(t0);
      o1.stop(t0 + BARLEN + 1.2); o2.stop(t0 + BARLEN + 1.2);
    }
    /* 主旋律音：三角波 + 同度正弦叠成的柔和类钢琴音色，低通 2600 Hz，
       快起音、随时值自然衰减，音量能听清旋律但盖不过音效。 */
    function lead(freq, t0, lenBeats){
      var dur = Math.max(0.45, lenBeats * BEAT * 0.96);
      var g = actx.createGain();
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.17, t0 + 0.015);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
      var f = actx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = 2600;
      var o1 = actx.createOscillator(); o1.type = 'triangle'; o1.frequency.value = freq;
      var o2 = actx.createOscillator(); o2.type = 'sine'; o2.frequency.value = freq;
      var g2 = actx.createGain(); g2.gain.value = 0.5;
      o1.connect(f); o2.connect(g2); g2.connect(f); f.connect(g); g.connect(gen);
      o1.start(t0); o2.start(t0);
      o1.stop(t0 + dur + 0.05); o2.stop(t0 + dur + 0.05);
    }
    /* 极轻正弦低音：每小节起拍轻触和弦根音一次，约 2.4 秒衰减完，只托底、不成低音线。 */
    function bassNote(freq, t0){
      var o = actx.createOscillator(), g = actx.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.13, t0 + 0.03);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 2.4);
      o.connect(g); g.connect(gen);
      o.start(t0); o.stop(t0 + 2.5);
    }
    /* 很轻的拨弦点缀：三角波短衰减，只落在反拍上营造弹跳感，不连续、不密集。 */
    function pluck(freq, t0){
      var o = actx.createOscillator(), g = actx.createGain();
      o.type = 'triangle'; o.frequency.value = freq;
      var f = actx.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = 2000;
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(0.05, t0 + 0.008);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.38);
      o.connect(f); f.connect(g); g.connect(gen);
      o.start(t0); o.stop(t0 + 0.42);
    }
    /* 极轻高音正弦铃音：只在第 2、6 小节出现一次，约 2.2 秒衰减，稀疏点缀。 */
    function bell(freq, t0){
      var o = actx.createOscillator(), g = actx.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.02, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 2.2);
      o.connect(g); g.connect(gen);
      o.start(t0); o.stop(t0 + 2.3);
    }
    function scheduleBar(){
      var ch = CHORDS[bar % CHORDS.length];
      var t0 = nextTime;
      for (var i = 0; i < ch.pad.length; i++) padTone(ch.pad[i], t0, 0.05);   // pad 打底，每小节一和弦
      bassNote(ch.bass, t0);                                                  // 起拍根音托底
      var notes = MELODY[bar];
      for (var n = 0; n < notes.length; n++){
        var freq = notes[n][1];
        if (bar === 7 && n === notes.length - 1 && loop % 2 === 1) freq = 587.33;   // 奇数轮尾音微变 D5
        lead(freq, t0 + notes[n][0] * BEAT, notes[n][2]);
      }
      if (bar % 2 === 0){
        pluck(ch.pluck[1], t0 + BEAT * 3.5);                                  // 旋律密的小节只点一个反拍
      } else {
        pluck(ch.pluck[0], t0 + BEAT * 1.5);
        pluck(ch.pluck[1], t0 + BEAT * 3.5);                                  // 旋律疏的小节补两个反拍
      }
      if (bar === 1 || bar === 5) bell(ch.bell, t0 + BEAT * 2);               // 每 4 小节一个铃音
      nextTime += BARLEN;
      bar++;
      if (bar >= 8){ bar = 0; loop++; }        // 8 小节无缝循环，调度连续、首尾无断点
    }
    function discardGen(){
      if (!gen) return;
      var old = gen; gen = null;
      old.gain.setTargetAtTime(0, actx.currentTime, 0.12);   // 快速淡出
      setTimeout(function(){ try { old.disconnect(); } catch(e){} }, 1200);
    }
    function tick(){
      if (!actx || !gen) return;
      while (nextTime < actx.currentTime + 1.2) scheduleBar();
    }
    return {
      isOn: function(){ return enabled; },
      toggle: function(){
        enabled = !enabled;
        try { window.localStorage.setItem('jy-music', enabled ? 'on' : 'off'); } catch(e){}
        return enabled;
      },
      start: function(){
        if (!enabled || timer) return;          // 已在播放时直接返回，绝不叠加第二层调度器
        if (!ensure()) return;
        paused = false;
        discardGen();                           // 丢弃上一轮 generation，旧音符不再重响
        gen = actx.createGain();
        gen.gain.value = 0;
        gen.connect(bus);
        gen.gain.setTargetAtTime(1, actx.currentTime, 0.6);   // 淡入约 1.5 秒
        bar = 0; loop = 0;
        nextTime = actx.currentTime + 0.2;
        timer = setInterval(tick, 200);
        tick();
      },
      /* 暂停：挂起 AudioContext，冻结当前调度位置；resume() 从原位置继续，不从头开始。
         与 stop() 不同：不丢弃 generation、不重置 bar/loop。 */
      pause: function(){
        if (!timer || !actx) return;
        clearInterval(timer); timer = null;
        paused = true;
        actx.suspend();
      },
      resume: function(){
        if (!paused) return;
        paused = false;
        if (!enabled || !actx || !gen){         // 暂停期间关了音乐：丢弃旧 generation，不再响
          discardGen();
          if (actx && actx.state === 'suspended') actx.resume();
          return;
        }
        actx.resume();
        timer = setInterval(tick, 200);
        tick();
      },
      stop: function(){
        paused = false;
        if (timer){ clearInterval(timer); timer = null; }
        discardGen();
        if (actx && actx.state === 'suspended') actx.resume();   // 不把挂起状态留给下一次 start
      }
    };
  })();

  /* ================= 瞄准线开关：默认开，选择存本地，下次打开仍生效 ================= */
  var AIM = (function(){
    var self = { on: true };
    try { self.on = window.localStorage.getItem('jy-aim') !== 'off'; } catch(e){}
    self.toggle = function(){
      self.on = !self.on;
      try { window.localStorage.setItem('jy-aim', self.on ? 'on' : 'off'); } catch(e){}
      return self.on;
    };
    return self;
  })();

  /* ================= 关卡构建 =================
     统一网格：30 列 × 26 行小方格，格 12px、砖 11px、只留 1px 深色缝线。
     grid[row][col] -> {kind:'brick'|'steel', ref} | null */
  var COLS = 30, ROWS = 26, CELL = 12, BSZ = 11, GOX = 0, GOY = 78;
  // 网格切换：默认标准格（30×26、格 12px）；50/60 关用密格（45×39、格 8px），
  // 61-100 关海洋细格（40×34、格 9px）。每个构建函数开头先设好自己的网格，
  // 场地物理尺寸（360 宽、砖区起点）不变，球半径与挡板不变。
  function setGrid(cols, rows, cell, bsz, gox, goy){ COLS = cols; ROWS = rows; CELL = cell; BSZ = bsz; GOX = gox; GOY = goy; }
  function stdGrid(){ setGrid(30, 26, 12, 11, 0, 78); }
  var grid = [];
  function blankGrid(){
    var g = [];
    for (var r=0;r<ROWS;r++){ var row=[]; for (var c=0;c<COLS;c++) row.push(null); g.push(row); }
    return g;
  }
  function cellPos(r,c){ return { x: GOX + c*CELL + (CELL-BSZ)/2, y: GOY + r*CELL + (CELL-BSZ)/2 }; }
  function putSteel(list,r,c){
    var p = cellPos(r,c);
    var st = { x:p.x, y:p.y, w:BSZ, h:BSZ };
    list.push(st); grid[r][c] = { kind:'steel', ref:st };
  }
  function putBrick(list,r,c,type,hp){
    var p = cellPos(r,c);
    var br = { x:p.x, y:p.y, w:BSZ, h:BSZ, r:r, c:c,
               type:type, hp:hp||1, maxHp:hp||1, color:brickColor(r,24), alive:true };
    list.push(br); grid[r][c] = { kind:'brick', ref:br };
    return br;
  }
  // 固定种子伪随机：同一关每次打开布局一致
  function seeded(seed){
    var s = seed;
    return function(){ s = (s*1103515245 + 12345) & 0x7fffffff; return s/0x7fffffff; };
  }
  function key(r,c){ return r+','+c; }
  function cellSet(list){
    var m = {};
    list.forEach(function(rc){ m[key(rc[0],rc[1])] = true; });
    return m;
  }
  // 通用构建：砖墙区 + 底部钢条（带缺口）+ 额外钢格/额外砖（迷宫、要塞）
  function genericBuild(cfg){
    stdGrid();
    grid = blankGrid();
    var bricks = [], steels = [];
    var rnd = seeded(cfg.seed);
    for (var r=0;r<ROWS;r++){
      for (var c=0;c<COLS;c++){
        var k = key(r,c);
        if (cfg.steelCells && cfg.steelCells[k]){ putSteel(steels, r, c); continue; }
        if (cfg.extra && cfg.extra[k]){ var ex = cfg.extra[k]; putBrick(bricks, r, c, ex.type, ex.hp); continue; }
        if (cfg.steelRow != null && r === cfg.steelRow && c >= cfg.sc0 && c <= cfg.sc1
            && !(cfg.gaps && cfg.gaps[c])){ putSteel(steels, r, c); continue; }
        if (r >= cfg.r0 && r <= cfg.r1 && c >= cfg.c0 && c <= cfg.c1){
          var d = cfg.decide(r, c, rnd);
          if (d){
            var nb = putBrick(bricks, r, c, d.type, d.hp);
            // 每关图案配色：只给普通砖上色，特殊砖保留各自固定标记色
            if (nb.type === 'normal' && cfg.colorFor) nb.color = cfg.colorFor(r, c);
          }
        }
      }
    }
    var total = 0;
    bricks.forEach(function(b){ if (b.type !== 'core') total++; });
    return { bricks:bricks, steels:steels, total:total };
  }
  function rollType(rnd, table){
    var roll = rnd();
    for (var i=0;i<table.length;i++){
      if (roll < table[i][0]) return { type: table[i][1], hp: table[i][2] || 1 };
    }
    return { type:'normal', hp:1 };
  }

  /* ---- 第 1 关：裂缝入门（已确认布局，保持不变） ---- */
  function buildL1(){
    stdGrid();
    grid = blankGrid();
    var bricks = [], steels = [];
    var rnd = seeded(20261026);
    for (var r=0;r<ROWS;r++){
      for (var c=0;c<COLS;c++){
        if (r === 25){
          if (c >= 2 && c <= 27 && c !== 14 && c !== 15) putSteel(steels, r, c);
        } else if (r <= 23 && c >= 2 && c <= 27){
          var roll = rnd();
          var type = 'normal';
          if (roll < 0.055) type = 'ball';
          else if (roll < 0.063) type = 'bomb';
          else if (roll < 0.068) type = 'beam';
          else if (roll < 0.073) type = 'widen';
          putBrick(bricks, r, c, type, 1);
        }
      }
    }
    return { bricks:bricks, steels:steels, total:bricks.length };
  }

  /* ---- 第 2 关：双缺口（左右两座分离砖岛：左琥珀、右珊瑚） ---- */
  function buildL2(){
    return genericBuild({
      seed: 20261027, r0:0, r1:23, c0:2, c1:27,
      steelRow:25, sc0:2, sc1:27, gaps:{7:true, 8:true, 21:true, 22:true},
      decide: function(r,c,rnd){
        if (c >= 13 && c <= 16) return null;   // 两岛之间的分隔空带
        return rollType(rnd, [[0.07,'ball'],[0.078,'bomb'],[0.083,'beam'],[0.088,'widen']]);
      },
      colorFor: function(r,c){
        if (c <= 12) return grad([[255,199,64],[247,164,20],[238,138,10]], r/23);   // 左岛琥珀
        return grad([[255,133,99],[250,104,74],[240,80,54]], r/23);                 // 右岛珊瑚
      }
    });
  }

  /* ---- 第 3 关：球砖初现（同心菱形环，球砖沿环内侧分布） ---- */
  function buildL3(){
    var ballSet = cellSet([[6,8],[6,10],[6,21],[6,22],[12,14],[12,15],[12,16],[18,8],[18,9],[18,21],[18,22],[8,14],[15,20]]);
    var ringPal = ['#ffd23c','#ff9d1c','#ff7847','#ff5a76'];
    function ringDist(r,c){ return Math.abs(r-11.5) + Math.abs(c-14.5); }
    return genericBuild({
      seed: 20261028, r0:0, r1:23, c0:2, c1:27,
      steelRow:25, sc0:3, sc1:26, gaps:{14:true, 15:true},
      decide: function(r,c,rnd){
        var s = ringDist(r,c);
        if (s > 22 || s % 4 === 3) return null;   // 菱形轮廓 + 环与环之间的空环带
        if (ballSet[key(r,c)]) return { type:'ball', hp:1 };
        return rollType(rnd, [[0.04,'ball'],[0.046,'bomb'],[0.05,'beam'],[0.054,'widen']]);
      },
      colorFor: function(r,c){
        return ringPal[Math.floor(ringDist(r,c)/4) % ringPal.length];
      }
    });
  }

  /* ---- 第 4 关：炸弹链（红黑炸弹链带，深红与暗橙交错墙身） ---- */
  function buildL4(){
    return genericBuild({
      seed: 20261029, r0:0, r1:23, c0:2, c1:27,
      steelRow:25, sc0:2, sc1:27, gaps:{14:true, 15:true},
      decide: function(r,c,rnd){
        if (r === 11 && c >= 4 && c <= 25) return { type:'bomb', hp:1 };
        if ((r === 5 || r === 17) && (c === 8 || c === 21)) return { type:'bomb', hp:1 };
        return rollType(rnd, [[0.04,'ball'],[0.044,'widen']]);
      },
      colorFor: function(r,c){
        return ((r + c) % 2 === 0) ? '#cf3527' : '#e06a12';   // 深红 / 暗橙棋盘交错
      }
    });
  }

  /* ---- 第 5 关：光束十字（蓝青十字形墙身，光束砖沿十字主干） ---- */
  function buildL5(){
    var beamSet = cellSet([[11,14],[11,15],[3,14],[8,15],[15,14],[20,15],[11,6],[12,7],[11,22],[12,21]]);
    var steelsIn = cellSet([[11,9],[11,20],[6,14],[16,15]]);
    return genericBuild({
      seed: 20261030, r0:0, r1:23, c0:2, c1:27,
      steelRow:25, sc0:2, sc1:27, gaps:{14:true, 15:true},
      steelCells: steelsIn,
      decide: function(r,c,rnd){
        var onCross = (c >= 13 && c <= 16) || (r >= 10 && r <= 13);
        var corner = (r <= 2 || r >= 21) && (c <= 4 || c >= 25);
        if (!onCross && !corner) return null;   // 只留十字 + 四角小块
        if (beamSet[key(r,c)]) return { type:'beam', hp:1 };
        return rollType(rnd, [[0.04,'ball'],[0.045,'bomb']]);
      },
      colorFor: function(r,c){
        return grad([[56,199,216],[64,110,255],[146,92,246]], (r/23 + (c-2)/25)/2);   // 青 → 蓝 → 紫
      }
    });
  }

  /* ---- 第 6 关：装甲墙（斜向彩色线网，装甲砖嵌在网格节点上） ---- */
  function buildL6(){
    var meshPal = ['#b06ee8','#5ecb6e','#4fa8e0','#f06a9c','#f5c33c'];   // 紫 绿 蓝 粉 黄
    return genericBuild({
      seed: 20261031, r0:0, r1:23, c0:2, c1:27,
      steelRow:25, sc0:2, sc1:27, gaps:{14:true, 15:true},
      decide: function(r,c,rnd){
        if (r >= 8 && r <= 15 && (r + c) % 4 === 0) return { type:'armor', hp: 2 + ((r + c) % 3) };
        return rollType(rnd, [[0.02,'bomb'],[0.032,'beam'],[0.072,'ball']]);
      },
      colorFor: function(r,c){
        return meshPal[Math.floor((r + c) / 5) % meshPal.length];   // 斜向色带交错成线网
      }
    });
  }

  /* ---- 第 7 关：加宽（斜向闪电条纹，橙黄红斜带交错） ---- */
  function buildL7(){
    var widenSet = cellSet([[4,6],[4,23],[10,10],[10,19],[16,6],[16,23],[20,14],[20,15]]);
    var boltPal = ['#ff5a3c','#ff8a1e','#ffc93c'];   // 红 橙 黄
    return genericBuild({
      seed: 20261101, r0:0, r1:23, c0:2, c1:27,
      steelRow:25, sc0:2, sc1:27, gaps:{14:true, 15:true},
      decide: function(r,c,rnd){
        if (widenSet[key(r,c)]) return { type:'widen', hp:1 };
        return rollType(rnd, [[0.01,'widen'],[0.06,'ball'],[0.066,'bomb']]);
      },
      colorFor: function(r,c){
        return boltPal[Math.floor((r - c + 40) / 4) % boltPal.length];   // 斜向条纹
      }
    });
  }

  /* ---- 第 8 关：隧道迷宫 ---- */
  function buildL8(){
    var maze = [];
    var c;
    for (c=2;c<=19;c++) maze.push([18,c]);
    for (c=10;c<=27;c++) maze.push([12,c]);
    for (c=2;c<=19;c++) maze.push([6,c]);
    return genericBuild({
      seed: 20261102, r0:0, r1:23, c0:2, c1:27,
      steelRow:25, sc0:2, sc1:27, gaps:{14:true},
      steelCells: cellSet(maze),
      decide: function(r,c,rnd){
        return rollType(rnd, [[0.05,'ball'],[0.056,'bomb'],[0.062,'beam']]);
      },
      colorFor: function(r,c){
        var mazePal = ['#5d5470','#6d6184','#4e4862','#7a6d94'];   // 暗紫灰，与钢墙呼应
        return mazePal[(r * 5 + c * 3) % mazePal.length];
      }
    });
  }

  /* ---- 第 9 关：连锁风暴（旋涡状五彩旋臂，特殊砖混在旋臂上） ---- */
  function buildL9(){
    var stormPal = ['#ff8a1e','#f06a9c','#38c6d9','#5ecb6e','#b06ee8'];
    return genericBuild({
      seed: 20261103, r0:0, r1:24, c0:1, c1:28,
      steelRow:25, sc0:1, sc1:28, gaps:{14:true, 15:true},
      decide: function(r,c,rnd){
        var roll = rnd();
        if (roll < 0.10) return { type:'armor', hp: 2 + Math.floor(rnd()*2) };
        if (roll < 0.18) return { type:'ball', hp:1 };
        if (roll < 0.21) return { type:'bomb', hp:1 };
        if (roll < 0.228) return { type:'beam', hp:1 };
        if (roll < 0.236) return { type:'widen', hp:1 };
        return { type:'normal', hp:1 };
      },
      colorFor: function(r,c){
        var dr = r - 12, dc = c - 14.5;
        var ang = Math.atan2(dr, dc); if (ang < 0) ang += Math.PI * 2;
        var rad = Math.sqrt(dr * dr + dc * dc);
        var arm = Math.floor(ang / (Math.PI * 2) * 5 + rad * 0.45) % stormPal.length;
        return stormPal[arm];   // 按极角 + 半径分臂，颜色旋向中心
      }
    });
  }

  /* ---- 第 10 关：要塞（易进难出的单向陷阱 + 单个主腔室） ----
     解压原则：入口容易进、进去不容易出来，不再有错位门和偏置密室。
     钢框：顶墙行2、左右墙列3/列26、双层底墙行21-22，围成一个主腔室（行3-20、列4-25）。
     入口在底部中央，呈漏斗形向下张开：行25缺口列9-20（12格宽）→ 行24列10-19
     → 行23列11-18 → 底墙外层行22列12-17（6格宽），挡板中心（场中 x=180，列14/15
     交界）竖直或近竖直发球都能直接穿入，不需要精确瞄准。
     易进难出：底墙内层行21是钢唇，缺口收窄到列13-16（4格）；入口正上方列12/17
     在行19-20 竖起烟囱钢壁。球进腔后下落时，绝大多数落点砸在行21的钢地板上被弹回
     腔室继续打砖，只有正对中央4格窄口才会掉出——进得宽、出得窄。
     腔室内铺满蓝青/青绿冷色砖（混球砖、炸弹、光束），球进去能连续打砖连锁；
     两个金色核心嵌在上部砖墙 (6,10) 与 (6,19)，对称、可见、可达，全碎才获胜。 */
  function buildL10(){
    stdGrid();
    grid = blankGrid();
    var bricks = [], steels = [];
    var rnd = seeded(20261104);
    var coldPal = ['#3f6fe0','#38a6d9','#2ac2b5','#57c785','#4f8fe8'];   // 蓝 青 青绿 绿
    function isSteel(r,c){
      if (r === 2 && c >= 3 && c <= 26) return true;                          // 顶墙
      if ((c === 3 || c === 26) && r >= 3 && r <= 22) return true;            // 左右墙
      if (r === 22 && c >= 3 && c <= 26 && (c <= 11 || c >= 18)) return true; // 底墙外层，缺口列12-17
      if (r === 21 && c >= 3 && c <= 26 && (c <= 12 || c >= 17)) return true; // 底墙内层钢唇，缺口列13-16
      if ((c === 12 || c === 17) && (r === 19 || r === 20)) return true;      // 入口烟囱壁
      if (r === 23 && c >= 3 && c <= 26 && (c <= 10 || c >= 19)) return true; // 漏斗壁，逐层外张
      if (r === 24 && c >= 3 && c <= 26 && (c <= 9 || c >= 20)) return true;
      if (r === 25 && c >= 3 && c <= 26 && (c <= 8 || c >= 21)) return true;
      return false;
    }
    function isThroat(r,c){ return r >= 19 && c >= 13 && c <= 16; }           // 烟囱内通道，保持空
    function isInner(r,c){ return r >= 3 && r <= 20 && c >= 4 && c <= 25; }   // 主腔室内部
    for (var r=0;r<ROWS;r++){
      for (var c=0;c<COLS;c++){
        if (isSteel(r,c)){ putSteel(steels, r, c); continue; }
        if (!isInner(r,c) || isThroat(r,c)) continue;                         // 腔外与通道留空
        if ((r === 6 && c === 10) || (r === 6 && c === 19)){ putBrick(bricks, r, c, 'core', 1); continue; }
        // 定点特殊砖：烟囱正上方放球砖，竖直进腔的第一时间就能在腔内放出斜射球开始连锁；
        // 中上部一对炸弹、一对光束，保证球在腔里能连续清砖，不会只碰钢块
        var fixed = { '17,14':'ball', '17,15':'ball', '14,9':'bomb', '14,20':'bomb', '10,14':'beam', '10,15':'beam' };
        if (fixed[key(r,c)]){ putBrick(bricks, r, c, fixed[key(r,c)], 1); continue; }
        var d = rollType(rnd, [[0.055,'ball'],[0.08,'bomb'],[0.09,'beam']]);
        var nb = putBrick(bricks, r, c, d.type, d.hp);
        if (nb.type === 'normal') nb.color = coldPal[Math.floor((r + c) / 5) % coldPal.length];
      }
    }
    var total = 0;
    bricks.forEach(function(b){ if (b.type !== 'core') total++; });
    return { bricks:bricks, steels:steels, total:total };
  }

  /* ---- 第 11 关：左岸潮汐（横向蓝青波浪带，球砖为主，入口在钢墙左侧 4 格） ---- */
  function buildL11(){
    var wavePal = ['#2f7fe0','#38a6d9','#2ac2b5','#3f8fe8','#57c785'];
    return genericBuild({
      seed: 20261105, r0:0, r1:23, c0:2, c1:27,
      steelRow:25, sc0:2, sc1:27, gaps:{2:true,3:true,4:true,5:true},
      decide: function(r,c,rnd){
        return rollType(rnd, [[0.10,'ball'],[0.115,'bomb'],[0.125,'beam'],[0.135,'widen']]);
      },
      colorFor: function(r,c){
        var band = Math.floor((r + 2.2*Math.sin(c*0.55)) / 3);
        return wavePal[((band % 5) + 5) % 5];   // 波浪带随列起伏
      }
    });
  }

  /* ---- 第 12 关：右岸星棋（靛蓝与金色棋盘格，装甲为主，入口在钢墙右侧 3 格） ---- */
  function buildL12(){
    return genericBuild({
      seed: 20261106, r0:0, r1:23, c0:2, c1:27,
      steelRow:25, sc0:2, sc1:27, gaps:{25:true,26:true,27:true},
      decide: function(r,c,rnd){
        return rollType(rnd, [[0.15,'armor',2],[0.18,'ball'],[0.195,'bomb'],[0.205,'beam']]);
      },
      colorFor: function(r,c){
        return ((r + c) % 2 === 0) ? '#3b4a9e' : '#d9a83f';   // 靛蓝 / 金 棋盘交错
      }
    });
  }

  /* ---- 第 13 关：双塔夹缝（左紫右青双竖塔，光束为主，中央 2 格窄烟囱） ---- */
  function buildL13(){
    var chim = [];
    for (var r=18;r<=24;r++){ chim.push([r,13]); chim.push([r,16]); }   // 烟囱两侧高钢墙
    return genericBuild({
      seed: 20261107, r0:0, r1:23, c0:2, c1:27,
      steelRow:25, sc0:2, sc1:27, gaps:{14:true,15:true},
      steelCells: cellSet(chim),
      decide: function(r,c,rnd){
        if (c >= 13 && c <= 16) return null;   // 两塔之间的空带，中央是烟囱通道
        return rollType(rnd, [[0.10,'beam'],[0.13,'ball'],[0.145,'bomb'],[0.155,'widen']]);
      },
      colorFor: function(r,c){
        if (c <= 12) return grad([[176,110,232],[138,90,224],[110,70,200]], r/23);   // 左塔紫
        return grad([[56,199,216],[38,166,200],[30,130,180]], r/23);                  // 右塔青
      }
    });
  }

  /* ---- 第 14 关：彩虹拱门（彩虹拱形带，炸弹为主，右偏漏斗底部 5 格） ---- */
  function buildL14(){
    var rainPal = ['#ff5a4e','#ff8a1e','#ffd23c','#5ecb6e','#38a6d9','#7a5af8'];
    function archTop(c){ var t = (c - 14.5)/13; return 3 + Math.round(9*t*t); }
    var fun = [];
    for (var c=2;c<=27;c++){ if (c < 18 || c > 20) fun.push([24,c]); }   // 漏斗上层只留 3 格（18-20），下层 5 格
    return genericBuild({
      seed: 20261108, r0:0, r1:23, c0:2, c1:27,
      steelRow:25, sc0:2, sc1:27, gaps:{17:true,18:true,19:true,20:true,21:true},
      steelCells: cellSet(fun),
      decide: function(r,c,rnd){
        var h = archTop(c);
        var inBand = (r >= h && r <= h+6) || (r >= h+9 && r <= h+14);
        if (!inBand) return null;   // 两道拱带
        return rollType(rnd, [[0.12,'bomb'],[0.15,'ball'],[0.16,'beam'],[0.17,'widen']]);
      },
      colorFor: function(r,c){
        return rainPal[clamp(Math.floor((r - archTop(c))/2), 0, 5)];
      }
    });
  }

  /* ---- 第 15 关：左岸阶梯（绿粉斜向阶梯带，加宽为主，左侧阶梯式缺口） ---- */
  function buildL15(){
    var step = [];
    for (var c=6;c<=27;c++) step.push([24,c]);   // 行24钢沿从列6起，与行25只开列2-3错开成台阶
    var greens = ['#79c94f','#57b34a','#3f9e4d'], pinks = ['#f28bb4','#ec6fa5','#e0528f'];
    return genericBuild({
      seed: 20261109, r0:0, r1:23, c0:2, c1:27,
      steelRow:25, sc0:2, sc1:27, gaps:{2:true,3:true},
      steelCells: cellSet(step),
      decide: function(r,c,rnd){
        return rollType(rnd, [[0.11,'widen'],[0.14,'ball'],[0.15,'bomb'],[0.16,'beam']]);
      },
      colorFor: function(r,c){
        var band = Math.floor((r + c) / 4);
        return (band % 2 === 0 ? greens : pinks)[Math.abs(band) % 3];   // 绿 / 粉 斜向阶梯带
      }
    });
  }

  /* ---- 第 16 关：双门蜂巢（琥珀棕蜂巢错行，球砖+炸弹，左右双缺口各 2 格） ---- */
  function buildL16(){
    var amber = ['#f0b64a','#e8a33d','#d98f2e'], brown = ['#a8763a','#96652f','#845526'];
    return genericBuild({
      seed: 20261110, r0:0, r1:23, c0:2, c1:27,
      steelRow:25, sc0:2, sc1:27, gaps:{3:true,4:true,25:true,26:true},
      decide: function(r,c,rnd){
        if ((r % 2 === 0 && c % 3 === 2) || (r % 2 === 1 && c % 3 === 0)) return null;   // 蜂巢错行孔
        return rollType(rnd, [[0.09,'ball'],[0.17,'bomb'],[0.185,'beam'],[0.195,'widen']]);
      },
      colorFor: function(r,c){
        return (r % 2 === 0 ? amber : brown)[c % 3];
      }
    });
  }

  /* ---- 第 17 关：雪山之巅（白与浅蓝三角雪峰，光束+装甲，中央 6 格宽缺口） ---- */
  function buildL17(){
    function peakTop(c){
      return Math.round(Math.min(3 + Math.abs(c-20)*0.85, 5 + Math.abs(c-7)*0.85, 15));
    }
    return genericBuild({
      seed: 20261111, r0:0, r1:23, c0:2, c1:27,
      steelRow:25, sc0:2, sc1:27, gaps:{12:true,13:true,14:true,15:true,16:true,17:true},
      decide: function(r,c,rnd){
        if (r < peakTop(c)) return null;   // 三角雪峰轮廓
        return rollType(rnd, [[0.09,'beam'],[0.17,'armor',2],[0.195,'ball'],[0.21,'bomb']]);
      },
      colorFor: function(r,c){
        var d = r - peakTop(c);
        if (d < 2) return '#ffffff';
        if (d < 5) return '#dcefff';
        if (d < 9) return '#a9cff2';
        return '#6fa8dc';
      }
    });
  }

  /* ---- 第 18 关：火焰斜坡（红橙竖向火焰舌，炸弹+球砖，左侧斜坡缺口） ---- */
  function buildL18(){
    var slope = [];
    for (var c=10;c<=27;c++) slope.push([24,c]);   // 钢墙斜线：行24从列10起、行23从列19起，逐级向右上方收
    for (var c=19;c<=27;c++) slope.push([23,c]);   // 缺口落在斜坡底部左侧（行25列2-5、行24列2-9）
    function flameTop(c){
      return Math.round(clamp(7 - 4*Math.sin(c*0.85) - 2*Math.sin(c*2.1+1), 1, 14));
    }
    return genericBuild({
      seed: 20261112, r0:0, r1:23, c0:2, c1:27,
      steelRow:25, sc0:2, sc1:27, gaps:{2:true,3:true,4:true,5:true},
      steelCells: cellSet(slope),
      decide: function(r,c,rnd){
        if (r < flameTop(c)) return null;   // 火焰舌高低起伏
        return rollType(rnd, [[0.10,'bomb'],[0.19,'ball'],[0.205,'beam'],[0.215,'widen']]);
      },
      colorFor: function(r,c){
        var t = (r - flameTop(c)) / Math.max(1, 23 - flameTop(c));
        return grad([[255,214,64],[255,150,30],[238,80,26],[200,40,30]], t);   // 舌尖黄 → 根部深红
      }
    });
  }

  /* ---- 第 19 关：绿野双层（绿色回字环带，装甲+光束，双层错位缺口：下左上右） ---- */
  function buildL19(){
    var layer = [];
    for (var c=2;c<=27;c++){ if (c < 22 || c > 24) layer.push([22,c]); }   // 上层钢带，缺口在右列22-24
    function ringD(r,c){ return Math.min(r, 23-r, c-2, 27-c); }
    var greens = ['#2f8f5b','#3f9e4d','#57b34a','#79c94f'];
    return genericBuild({
      seed: 20261113, r0:0, r1:23, c0:2, c1:27,
      steelRow:25, sc0:2, sc1:27, gaps:{5:true,6:true,7:true},
      steelCells: cellSet(layer),
      decide: function(r,c,rnd){
        if (ringD(r,c) % 3 === 2) return null;   // 回字环带之间的空环
        return rollType(rnd, [[0.10,'armor',2],[0.19,'beam'],[0.215,'ball'],[0.23,'bomb']]);
      },
      colorFor: function(r,c){
        return greens[Math.floor(ringD(r,c)/3) % greens.length];
      }
    });
  }

  /* ---- 第 20 关：要塞·左岸双子（易进难出，左侧宽漏斗 + 单腔室，蓝紫砖面，双核心） ----
     与第 10 关入口和内部都不同：漏斗整体偏左，底部缺口列3-13（11格）→ 行24列4-12
     → 行23列5-11 → 底墙外层行22列6-10（5格）→ 内层钢唇行21只留列7-9（3格），
     出口比入口窄得多；烟囱壁在列6/10、行19-20。两个金色核心嵌在上部砖墙
     (5,7) 与 (5,22)，左上、右上对称可见，全碎才获胜，发球上限 5 次。 */
  function buildL20(){
    stdGrid();
    grid = blankGrid();
    var bricks = [], steels = [];
    var rnd = seeded(20261114);
    var pal = ['#4f6fe8','#6a5ae0','#38a6d9','#8a6ae8','#4f8fe8'];   // 蓝紫砖面
    function isSteel(r,c){
      if (r === 2 && c >= 3 && c <= 26) return true;                          // 顶墙
      if ((c === 3 || c === 26) && r >= 3 && r <= 22) return true;            // 左右墙
      if (r === 22 && c >= 3 && c <= 26 && (c <= 5 || c >= 11)) return true;  // 底墙外层，缺口列6-10
      if (r === 21 && c >= 3 && c <= 26 && (c <= 6 || c >= 10)) return true;  // 内层钢唇，缺口列7-9
      if ((c === 6 || c === 10) && (r === 19 || r === 20)) return true;       // 入口烟囱壁
      if (r === 23 && c >= 3 && c <= 26 && (c <= 4 || c >= 12)) return true;  // 漏斗壁，逐层向左外张
      if (r === 24 && c >= 3 && c <= 26 && (c <= 3 || c >= 13)) return true;
      if (r === 25 && c >= 3 && c <= 26 && c >= 14) return true;              // 底部缺口列3-13
      return false;
    }
    function isThroat(r,c){ return r >= 17 && c >= 7 && c <= 9; }            // 烟囱内通道，保持空
    function isInner(r,c){ return r >= 3 && r <= 20 && c >= 4 && c <= 25; }    // 主腔室内部
    for (var r=0;r<ROWS;r++){
      for (var c=0;c<COLS;c++){
        if (isSteel(r,c)){ putSteel(steels, r, c); continue; }
        if (!isInner(r,c) || isThroat(r,c)) continue;
        if ((r === 5 && c === 7) || (r === 5 && c === 22)){ putBrick(bricks, r, c, 'core', 1); continue; }
        var fixed = { '16,7':'ball', '16,8':'ball', '13,10':'bomb', '13,19':'bomb', '9,14':'beam', '9,15':'beam' };
        if (fixed[key(r,c)]){ putBrick(bricks, r, c, fixed[key(r,c)], 1); continue; }
        var d = rollType(rnd, [[0.055,'ball'],[0.08,'bomb'],[0.09,'beam']]);
        var nb = putBrick(bricks, r, c, d.type, d.hp);
        if (nb.type === 'normal') nb.color = pal[Math.floor((r + c) / 5) % pal.length];
      }
    }
    var total = 0;
    bricks.forEach(function(b){ if (b.type !== 'core') total++; });
    return { bricks:bricks, steels:steels, total:total };
  }

  /* ---- 第 21 关：极光斜带（青绿紫斜向极光带，球砖+加宽，中央斜向缺口） ---- */
  function buildL21(){
    var diag = [];
    for (var c=2;c<=27;c++){ if (c < 13 || c > 14) diag.push([24,c]); }   // 行24缺口列13-14，与行25缺口列14-15错开成斜线
    var pal = ['#2ac2b5','#3fd68f','#57c785','#6a5ae8','#8a6ae8'];
    return genericBuild({
      seed: 20261115, r0:0, r1:23, c0:2, c1:27,
      steelRow:25, sc0:2, sc1:27, gaps:{14:true,15:true},
      steelCells: cellSet(diag),
      decide: function(r,c,rnd){
        return rollType(rnd, [[0.09,'ball'],[0.18,'widen'],[0.20,'bomb'],[0.21,'beam']]);
      },
      colorFor: function(r,c){
        var band = Math.floor((r*1.4 + c) / 5);
        return pal[((band % 5) + 5) % 5];   // 斜向极光带
      }
    });
  }

  /* ---- 第 22 关：沙漠金字塔（沙金三角金字塔群，炸弹+装甲，右侧高烟囱） ---- */
  function buildL22(){
    var chim = [];
    for (var r=14;r<=24;r++){ chim.push([r,23]); chim.push([r,27]); }   // 烟囱两侧高钢墙，井道列24-26
    function pyrTop(c){
      var t = 17;
      t = Math.min(t, 3 + Math.abs(c-8)*1.1);
      t = Math.min(t, 6 + Math.abs(c-16)*1.1);
      t = Math.min(t, 2 + Math.abs(c-24)*1.1);
      return Math.round(t);
    }
    return genericBuild({
      seed: 20261116, r0:0, r1:23, c0:2, c1:27,
      steelRow:25, sc0:2, sc1:27, gaps:{24:true,25:true,26:true},
      steelCells: cellSet(chim),
      decide: function(r,c,rnd){
        if (c >= 24 && c <= 26 && r >= 12) return null;   // 烟囱井道保持空
        if (r < pyrTop(c)) return null;                    // 金字塔群轮廓
        return rollType(rnd, [[0.10,'bomb'],[0.18,'armor',2],[0.20,'ball'],[0.21,'beam']]);
      },
      colorFor: function(r,c){
        return grad([[240,214,130],[232,197,106],[217,169,78],[199,143,58]], r/23);   // 沙金渐变
      }
    });
  }

  /* ---- 第 23 关：海底珊瑚（珊瑚粉与海蓝分枝，光束+球砖，中央 3 格阶梯缺口） ---- */
  function buildL23(){
    var stepRow = [];
    for (var c=2;c<=27;c++){ if (c < 13 || c > 17) stepRow.push([24,c]); }   // 行24缺口5格，行25缺口3格，左右各退一格成台阶
    return genericBuild({
      seed: 20261117, r0:0, r1:23, c0:2, c1:27,
      steelRow:25, sc0:2, sc1:27, gaps:{14:true,15:true,16:true},
      steelCells: cellSet(stepRow),
      decide: function(r,c,rnd){
        if (r < 2) return null;
        var trunk = (c % 8 === 2 || c % 8 === 3);
        var branchA = ((r + c) % 10 < 2);
        var branchB = ((r - c + 40) % 10 < 2);
        if (!trunk && !branchA && !branchB) return null;   // 主干 + 双向斜枝的分枝状
        return rollType(rnd, [[0.10,'beam'],[0.19,'ball'],[0.21,'bomb'],[0.22,'widen']]);
      },
      colorFor: function(r,c){
        if ((r + c) % 10 < 2) return '#ff8a7a';          // 珊瑚粉分枝
        if ((r - c + 40) % 10 < 2) return '#3f9be0';     // 海蓝分枝
        return (Math.floor(c/8) % 2 === 0) ? '#f2718c' : '#38a6d9';
      }
    });
  }

  /* ---- 第 24 关：霓虹都市（多彩竖向楼群，加宽+炸弹，右侧漏斗底部 4 格） ---- */
  function buildL24(){
    var tops = [7,2,10,4,1,8,3,9,5];
    var neon = ['#ff5a8a','#ffb03a','#4fd8e8','#8a6aff','#5ee86a','#ff7a4d','#f06ab8','#38a6d9','#ffd23c'];
    var fun = [];
    for (var c=2;c<=27;c++){ if (c < 23 || c > 24) fun.push([24,c]); }   // 漏斗上层只留 2 格（23-24），下层 4 格
    function towerTop(c){ return tops[Math.min(tops.length-1, Math.floor((c-2)/3))]; }
    return genericBuild({
      seed: 20261118, r0:0, r1:23, c0:2, c1:27,
      steelRow:25, sc0:2, sc1:27, gaps:{22:true,23:true,24:true,25:true},
      steelCells: cellSet(fun),
      decide: function(r,c,rnd){
        if (r < towerTop(c)) return null;   // 楼群高低不一
        return rollType(rnd, [[0.09,'widen'],[0.18,'bomb'],[0.20,'ball'],[0.21,'beam']]);
      },
      colorFor: function(r,c){
        return neon[Math.min(neon.length-1, Math.floor((c-2)/3))];
      }
    });
  }

  /* ---- 第 25 关：森林年轮（绿棕同心圆环，装甲+球砖，左侧 2 格缺口） ---- */
  function buildL25(){
    function dist(r,c){ var dr = r - 11.5, dc = c - 14.5; return Math.sqrt(dr*dr + dc*dc); }
    var pal = ['#57b34a','#3f9e4d','#8a6a42','#a8834f'];   // 绿 绿 棕 棕
    return genericBuild({
      seed: 20261119, r0:0, r1:23, c0:2, c1:27,
      steelRow:25, sc0:2, sc1:27, gaps:{2:true,3:true},
      decide: function(r,c,rnd){
        var d = dist(r,c);
        if (d > 12) return null;                              // 圆形轮廓（与第 3 关菱形环不同）
        if (Math.floor(d) % 4 === 3 && d > 3) return null;     // 年轮之间的空环
        return rollType(rnd, [[0.10,'armor',2],[0.19,'ball'],[0.21,'bomb'],[0.22,'beam']]);
      },
      colorFor: function(r,c){
        return pal[Math.floor(dist(r,c) / 2) % 4];
      }
    });
  }

  /* ---- 第 26 关：冰晶雪花（白与冰蓝放射六臂，光束+加宽，中央 6 格宽缺口、两侧钢凸起） ---- */
  function buildL26(){
    var cx = 14.5, cy = 11.5;
    var arms = [];
    for (var k=0;k<6;k++){
      var a = -Math.PI/2 + k*Math.PI/3;
      arms.push([Math.cos(a), Math.sin(a)]);
    }
    var knobs = [];
    arms.forEach(function(u){
      [-1,1].forEach(function(s){
        knobs.push([cx + u[0]*6.5 - u[1]*2.4*s, cy + u[1]*6.5 + u[0]*2.4*s]);   // 每臂中段两侧的小分叉
      });
    });
    return genericBuild({
      seed: 20261120, r0:0, r1:23, c0:2, c1:27,
      steelRow:25, sc0:2, sc1:27, gaps:{12:true,13:true,14:true,15:true,16:true,17:true},
      steelCells: cellSet([[24,11],[24,18]]),   // 宽缺口两侧钢墙各一块凸起
      decide: function(r,c,rnd){
        var dx = c - cx, dy = r - cy;
        var d = Math.sqrt(dx*dx + dy*dy);
        var fill = d < 3.2;
        if (!fill && d <= 12.5){
          for (var i=0;i<arms.length;i++){
            var along = dx*arms[i][0] + dy*arms[i][1];
            var perp = Math.abs(-dx*arms[i][1] + dy*arms[i][0]);
            if (along >= 0 && along <= 12 && perp < 1.8){ fill = true; break; }
          }
        }
        if (!fill){
          for (var j=0;j<knobs.length;j++){
            var kx = c - knobs[j][0], ky = r - knobs[j][1];
            if (kx*kx + ky*ky < 2.9){ fill = true; break; }
          }
        }
        if (!fill) return null;
        return rollType(rnd, [[0.10,'beam'],[0.19,'widen'],[0.21,'ball'],[0.22,'bomb']]);
      },
      colorFor: function(r,c){
        var dx = c - cx, dy = r - cy;
        var d = Math.sqrt(dx*dx + dy*dy);
        if (d < 4) return '#f4faff';
        return grad([[168,212,240],[111,179,232],[70,140,210]], clamp((d-4)/8, 0, 1));
      }
    });
  }

  /* ---- 第 27 关：熔岩裂谷（黑底红橙裂纹，炸弹+光束，右侧斜坡缺口） ---- */
  function buildL27(){
    var slope = [];
    for (var c=2;c<=19;c++) slope.push([24,c]);   // 钢墙斜线：行24到列19止、行23到列10止，逐级向右下方落
    for (var c=2;c<=10;c++) slope.push([23,c]);   // 缺口落在斜坡底部右侧（行25列24-27、行24列20-27）
    return genericBuild({
      seed: 20261121, r0:0, r1:23, c0:2, c1:27,
      steelRow:25, sc0:2, sc1:27, gaps:{24:true,25:true,26:true,27:true},
      steelCells: cellSet(slope),
      decide: function(r,c,rnd){
        return rollType(rnd, [[0.10,'bomb'],[0.19,'beam'],[0.21,'ball'],[0.22,'widen']]);
      },
      colorFor: function(r,c){
        var l1 = Math.abs(r - (6 + 3*Math.sin(c*0.5)));
        var l2 = Math.abs(r - (14 + 4*Math.sin(c*0.35 + 2)));
        var l3 = Math.abs(r - (20 + 2*Math.sin(c*0.8 + 1)));
        if (l1 < 1.1 || l2 < 1.1 || l3 < 1.1) return grad([[255,120,40],[255,80,26],[230,50,20]], (c%5)/4);   // 熔岩裂纹带
        return ((r + c) % 2 === 0) ? '#332830' : '#2b232e';   // 黑色岩底
      }
    });
  }

  /* ---- 第 28 关：星云双层（紫粉蓝三色大旋臂，球砖+装甲，双层错位缺口：下右上左） ---- */
  function buildL28(){
    var layer = [];
    for (var c=2;c<=27;c++){ if (c < 5 || c > 8) layer.push([22,c]); }   // 上层钢带，缺口在左列5-8
    var nebPal = ['#8a5ae8','#f06ab8','#4f8fe8'];
    return genericBuild({
      seed: 20261122, r0:0, r1:23, c0:2, c1:27,
      steelRow:25, sc0:2, sc1:27, gaps:{21:true,22:true,23:true,24:true},
      steelCells: cellSet(layer),
      decide: function(r,c,rnd){
        return rollType(rnd, [[0.10,'ball'],[0.19,'armor',2],[0.21,'bomb'],[0.22,'beam']]);
      },
      colorFor: function(r,c){
        var dr = r - 12, dc = c - 14.5;
        var ang = Math.atan2(dr, dc); if (ang < 0) ang += Math.PI * 2;
        var rad = Math.sqrt(dr * dr + dc * dc);
        var arm = ((Math.floor(ang / (Math.PI * 2) * 3 + rad * 0.35) % 3) + 3) % 3;
        return nebPal[arm];   // 三条大旋臂（与第 9 关五臂旋涡不同）
      }
    });
  }

  /* ---- 第 29 关：时光沙漏（上下收窄沙漏形，光束+炸弹，中央窄烟囱底部 2 格） ---- */
  function buildL29(){
    var chim = [];
    for (var r=18;r<=24;r++){ chim.push([r,13]); chim.push([r,16]); }   // 烟囱下窄，井道列14-15
    function halfW(r){ return 3 + 10 * Math.abs(r - 11.5) / 11.5; }
    return genericBuild({
      seed: 20261123, r0:0, r1:23, c0:2, c1:27,
      steelRow:25, sc0:2, sc1:27, gaps:{14:true,15:true},
      steelCells: cellSet(chim),
      decide: function(r,c,rnd){
        if (c >= 14 && c <= 15 && r >= 17) return null;   // 中央烟囱井道
        if (Math.abs(c - 14.5) > halfW(r)) return null;   // 沙漏轮廓：上下宽、腰部窄
        return rollType(rnd, [[0.10,'beam'],[0.19,'bomb'],[0.21,'ball'],[0.22,'widen']]);
      },
      colorFor: function(r,c){
        var t = Math.abs(r - 11.5) / 11.5;
        return grad([[240,200,110],[222,164,80],[150,110,190]], 1 - t);   // 两端金沙 → 腰部紫
      }
    });
  }

  /* ---- 第 30 关：最终要塞·星核（易进难出，中央 8 格超宽漏斗 + 大单腔室，三核心） ----
     腔室比前两座更宽：钢框列2/27、顶墙行2、内腔列3-26 × 行3-20。
     入口中央漏斗向下张开：行25缺口列8-21（14格）→ 行24列9-20 → 行23列10-19
     → 底墙外层行22列11-18（8格），挡板正中竖直发球直接进入；内层钢唇行21
     把出口收窄到列13-16（4格），烟囱壁在列12/17、行19-20，球进腔后不易原路掉回。
     三个金色核心嵌在上部砖墙 (5,7)、(5,15)、(5,22)，左上、中上、右上可见可达，
     三个全碎才获胜；发球上限 6 次。腔内蓝紫砖面点缀金砖，混球砖、炸弹、光束。 */
  function buildL30(){
    stdGrid();
    grid = blankGrid();
    var bricks = [], steels = [];
    var rnd = seeded(20261124);
    var pal = ['#4f6fe8','#6a5ae0','#38a6d9','#8a6ae8','#3f8fe0'];
    function isSteel(r,c){
      if (r === 2 && c >= 2 && c <= 27) return true;                          // 顶墙
      if ((c === 2 || c === 27) && r >= 3 && r <= 22) return true;            // 左右墙
      if (r === 22 && c >= 2 && c <= 27 && (c <= 10 || c >= 19)) return true; // 底墙外层，缺口列11-18
      if (r === 21 && c >= 2 && c <= 27 && (c <= 12 || c >= 17)) return true; // 内层钢唇，缺口列13-16
      if ((c === 12 || c === 17) && (r === 19 || r === 20)) return true;      // 入口烟囱壁
      if (r === 23 && c >= 2 && c <= 27 && (c <= 9 || c >= 20)) return true;  // 漏斗壁，逐层外张
      if (r === 24 && c >= 2 && c <= 27 && (c <= 8 || c >= 21)) return true;
      if (r === 25 && c >= 2 && c <= 27 && (c <= 7 || c >= 22)) return true;  // 底部缺口列8-21
      return false;
    }
    function isThroat(r,c){ return r >= 17 && c >= 13 && c <= 16; }           // 烟囱内通道，保持空
    function isInner(r,c){ return r >= 3 && r <= 20 && c >= 3 && c <= 26; }   // 主腔室内部
    for (var r=0;r<ROWS;r++){
      for (var c=0;c<COLS;c++){
        if (isSteel(r,c)){ putSteel(steels, r, c); continue; }
        if (!isInner(r,c) || isThroat(r,c)) continue;
        if ((r === 5 && c === 7) || (r === 5 && c === 15) || (r === 5 && c === 22)){ putBrick(bricks, r, c, 'core', 1); continue; }
        var fixed = { '16,14':'ball', '16,15':'ball', '12,8':'bomb', '12,21':'bomb', '9,14':'beam', '9,15':'beam' };
        if (fixed[key(r,c)]){ putBrick(bricks, r, c, fixed[key(r,c)], 1); continue; }
        var d = rollType(rnd, [[0.055,'ball'],[0.08,'bomb'],[0.09,'beam']]);
        var nb = putBrick(bricks, r, c, d.type, d.hp);
        if (nb.type === 'normal'){
          nb.color = ((r * 7 + c) % 13 === 0) ? '#c9a227' : pal[Math.floor((r + c) / 5) % pal.length];   // 蓝紫砖面点缀金砖
        }
      }
    }
    var total = 0;
    bricks.forEach(function(b){ if (b.type !== 'core') total++; });
    return { bricks:bricks, steels:steels, total:total };
  }

  /* ---- 中空图案关（31-35）通用构建 ----
     图案区（mask）不放砖、四周一圈相邻格自动放深灰钢块描边；通道区（channel）同样
     保持空、且不被描边钢块堵住；定点特殊砖（fixed）直接放进图案内部或墙面指定位置。
     图案与布局均为原创简化线条，不照搬任何参考像素。 */
  function rectMask(r0,r1,c0,c1){
    var m = {};
    for (var r=r0;r<=r1;r++) for (var c=c0;c<=c1;c++) m[key(r,c)] = true;
    return m;
  }
  function mergeMasks(){
    var m = {};
    for (var i=0;i<arguments.length;i++){ for (var k in arguments[i]) m[k] = true; }
    return m;
  }
  function channelMask(r0,r1,cols){
    var m = {};
    for (var r=r0;r<=r1;r++) cols.forEach(function(c){ m[key(r,c)] = true; });
    return m;
  }
  function fixedOf(list){
    var m = {};
    list.forEach(function(rc){ m[key(rc[0],rc[1])] = { type: rc[2], hp: rc[3] || 1 }; });
    return m;
  }
  function patternBuild(o){
    var open = {}, k;
    for (k in o.mask) open[k] = true;
    if (o.channel) for (k in o.channel) open[k] = true;
    // 通道接长（防密封死局）：从每条通道的顶端向上延伸，直到接进图案中空区，
    // 保证通道与中空区之间不被描边钢块封死，中空内的砖永远有入口可达。
    if (o.channel){
      var chanTop = {};
      for (k in o.channel){
        var cp = k.split(','), cr0 = +cp[0], cc0 = +cp[1];
        if (chanTop[cc0] == null || cr0 < chanTop[cc0]) chanTop[cc0] = cr0;
      }
      for (var ccol in chanTop){
        var rr2 = chanTop[ccol] - 1, guard2 = 0;
        while (rr2 >= 0 && guard2++ < 8 && !o.mask[key(rr2, +ccol)]){
          open[key(rr2, +ccol)] = true;
          rr2--;
        }
      }
    }
    var steels = {};
    for (k in o.mask){
      var parts = k.split(',');
      var r = +parts[0], c = +parts[1];
      for (var dr=-1; dr<=1; dr++) for (var dc=-1; dc<=1; dc++){
        if (!dr && !dc) continue;
        var nk = key(r+dr, c+dc);
        if (!open[nk]) steels[nk] = true;
      }
    }
    if (o.steelExtra) for (k in o.steelExtra) steels[k] = true;
    if (o.fixed) for (k in o.fixed) delete steels[k];   // 定点砖优先于描边钢：定点砖永远可打掉，也成为密封钢环的破口
    return genericBuild({
      seed: o.seed, r0:0, r1:23, c0:2, c1:27,
      steelRow:25, sc0:2, sc1:27, gaps:o.gaps,
      steelCells: steels, extra: o.fixed || null,
      decide: function(r,c,rnd){
        if (open[key(r,c)]) return null;
        return rollType(rnd, o.table);
      },
      colorFor: o.colorFor
    });
  }

  /* ---- 中空图案辅助（36-60 关用，全部原创几何） ---- */
  function discMask(cr, cc, rad){
    var m = {};
    for (var r=0;r<=23;r++) for (var c=2;c<=27;c++){
      var dr = r - cr, dc = c - cc;
      if (dr*dr + dc*dc <= rad*rad) m[key(r,c)] = true;
    }
    return m;
  }
  function ellipseMask(cr, cc, rr, rc){
    var m = {};
    for (var r=0;r<=23;r++) for (var c=2;c<=27;c++){
      var dr = (r - cr)/rr, dc = (c - cc)/rc;
      if (dr*dr + dc*dc <= 1) m[key(r,c)] = true;
    }
    return m;
  }
  function polyMask(pts){
    var m = {};
    for (var r=0;r<=23;r++) for (var c=2;c<=27;c++){
      var x = c, y = r, inside = false;
      for (var i=0, j=pts.length-1; i<pts.length; j=i++){
        var xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
        if (((yi > y) !== (yj > y)) && (x < (xj - xi)*(y - yi)/(yj - yi) + xi)) inside = !inside;
      }
      if (inside) m[key(r,c)] = true;
    }
    return m;
  }
  function maskSub(a, b){
    var m = {};
    for (var k in a) if (!b[k]) m[k] = true;
    return m;
  }

  /* ---- 第 31 关：绿野机器人（绿色墙 + 中央机器人中空图案，底部中央 2 格竖通道） ----
     机器人为原创简化线条：圆头（矩形圆角近似）+ 脖颈 + 身体 + 两条斜触角 + 两臂，
     内部中空、四周钢块描边；身体里定点放 4 颗球砖。通道列14-15 从底部钢条直通身体。 */
  function buildL31(){
    var mask = mergeMasks(
      rectMask(5,8,12,17),                 // 头
      rectMask(9,11,13,16),               // 脖颈
      rectMask(12,18,10,19),              // 身体
      rectMask(12,15,7,8),                // 左臂
      rectMask(12,15,21,22),              // 右臂
      cellSet([[4,11],[3,10],[2,9],[1,8],[4,18],[3,19],[2,20],[1,21]])   // 两条触角
    );
    return patternBuild({
      seed: 20261125, mask: mask,
      channel: mergeMasks(channelMask(19,23,[14,15]), channelMask(0,4,[14,15])),
      gaps: {14:true, 15:true},
      fixed: fixedOf([[13,12,'ball'],[13,17,'ball'],[17,12,'ball'],[17,17,'ball']]),
      table: [[0.05,'ball'],[0.08,'bomb'],[0.10,'beam'],[0.11,'widen']],
      colorFor: function(r,c){ return grad([[146,222,92],[94,192,80],[52,160,70]], r/23); }   // 绿野
    });
  }

  /* ---- 第 32 关：紫色 M（紫红墙 + 中央 M 字母中空图案，底部中央 3 格通道） ----
     M 为原创简化线条：两条竖腿 + 中间 V 形斜线，中空、四周钢块描边；
     通道列13-15 直通 V 形底端；两腿底部各定点放 1 颗球砖，墙面混装甲。 */
  function buildL32(){
    var vCells = [];
    for (var vr=6; vr<=13; vr++){
      var vc = 12 + Math.floor((vr-6)/2);
      vCells.push([vr, vc]);
      vCells.push([vr, 29 - vc]);
    }
    var mask = mergeMasks(
      rectMask(6,19,9,11),                // 左腿
      rectMask(6,19,18,20),               // 右腿
      cellSet(vCells)                     // 中间 V 形
    );
    return patternBuild({
      seed: 20261126, mask: mask,
      channel: mergeMasks(channelMask(14,23,[13,14,15]), cellSet([[20,10],[21,10],[20,19],[21,19]])),
      gaps: {13:true, 14:true, 15:true},
      fixed: fixedOf([[18,10,'ball'],[18,19,'ball']]),
      table: [[0.14,'armor',2],[0.19,'ball'],[0.22,'bomb']],
      colorFor: function(r,c){ return grad([[216,64,160],[188,44,138],[156,32,116]], r/23); }   // 紫红
    });
  }

  /* ---- 第 33 关：回字迷宫（深绿砖面 + 钢框 + 外围一圈黑色边框空道，顶部 2 格烟囱） ----
     砖只在钢框内部；框外一圈全空，球先沿外圈空道绕到顶部，再从顶部中央烟囱
     （列14-15、两侧列13/16 高钢壁）进入框内，烟囱正下方定点放球砖。 */
  function buildL33(){
    var frame = [];
    var c, r;
    for (c=4;c<=25;c++){ if (c !== 14 && c !== 15) frame.push([3,c]); frame.push([21,c]); }
    for (r=4;r<=20;r++){ frame.push([r,4]); frame.push([r,25]); }
    for (r=0;r<=2;r++){ frame.push([r,13]); frame.push([r,16]); }   // 烟囱两侧高钢壁
    return genericBuild({
      seed: 20261127, r0:0, r1:23, c0:2, c1:27,
      steelRow:25, sc0:2, sc1:27, gaps:{14:true, 15:true},
      steelCells: cellSet(frame),
      extra: fixedOf([[4,14,'ball'],[4,15,'ball']]),
      decide: function(r,c,rnd){
        if (r >= 4 && r <= 20 && c >= 5 && c <= 24)
          return rollType(rnd, [[0.06,'bomb'],[0.11,'beam'],[0.15,'ball']]);
        return null;   // 框外边框空道与框外区域保持空
      },
      colorFor: function(r,c){ return grad([[64,168,96],[44,140,76],[30,116,60]], r/23); }   // 深绿
    });
  }

  /* ---- 第 34 关：金色门洞（金黄墙 + 底部中央拱形门洞，门洞本身即入口） ----
     门洞为原创拱形：顶部半圆拱（两行收窄）+ 两侧直壁，内部中空，侧与顶用钢块内衬；
     门洞底部不封、直接朝场地开放，底部钢条在门洞列11-18 全部留空。门洞两侧各放球砖。 */
  function buildL34(){
    var mask = mergeMasks(
      rectMask(14,23,11,18),              // 门洞主体
      rectMask(13,13,12,17),              // 拱肩
      rectMask(12,12,13,16)               // 拱顶
    );
    return patternBuild({
      seed: 20261128, mask: mask,
      channel: channelMask(24,24,[11,12,13,14,15,16,17,18]),   // 门洞正下方保持空，不被描边钢块封底
      gaps: {11:true, 12:true, 13:true, 14:true, 15:true, 16:true, 17:true, 18:true},
      fixed: fixedOf([[17,8,'ball'],[17,21,'ball']]),
      table: [[0.05,'bomb'],[0.09,'widen'],[0.13,'ball']],
      colorFor: function(r,c){ return grad([[255,216,64],[250,192,40],[238,168,24]], r/23); }   // 金黄
    });
  }

  /* ---- 第 35 关：深绿 H（深绿墙 + 中央 H 字母中空图案，底部左右双通道） ----
     H 为原创简化线条：两条竖腿 + 中间横杠，中空、四周钢块描边；横杠两端各放加宽砖。
     入口与前面几关不同：底部左右双通道（左列10-11、右列17-18）分别直通 H 的两条腿。 */
  function buildL35(){
    var mask = mergeMasks(
      rectMask(5,19,10,12),               // 左腿
      rectMask(5,19,17,19),               // 右腿
      rectMask(11,13,10,19)               // 中间横杠
    );
    return patternBuild({
      seed: 20261129, mask: mask,
      channel: mergeMasks(channelMask(20,23,[10,11]), channelMask(20,23,[17,18])),
      gaps: {10:true, 11:true, 17:true, 18:true},
      fixed: fixedOf([[12,10,'widen'],[12,19,'widen']]),
      table: [[0.07,'ball'],[0.12,'beam'],[0.15,'bomb']],
      colorFor: function(r,c){ return grad([[44,156,84],[34,130,66],[24,106,50]], r/23); }   // 深绿
    });
  }

  /* ================= 36-60 关：中空图案风格（全部原创几何，不照搬任何参考像素） =================
     难度分层：36-39 入门进阶（单腔室、入口 3-4 格、球砖多、装甲少）；
     41-49 中等（入口 2 格、双腔室或隔墙、装甲适中、炸弹与光束搭配）；
     51-59 较难（入口 1-2 格、隔断或钢迷宫、装甲与连锁更多，但入口正上方与
     中空内都定点放球砖、内有加宽砖，保证有解）；40/50/60 为要塞。 */

  /* ---- 第 36 关：叶子（竖椭圆叶身 + 叶尖，底部中央 4 格宽入口） ---- */
  function buildL36(){
    var mask = mergeMasks(
      ellipseMask(11, 14.5, 8, 4.6),
      cellSet([[2,14],[2,15],[19,14],[19,15]])
    );
    return patternBuild({
      seed: 20261130, mask: mask,
      channel: channelMask(20,23,[13,14,15,16]),
      gaps: {13:true, 14:true, 15:true, 16:true},
      fixed: fixedOf([[16,14,'ball'],[16,15,'ball'],[9,13,'ball']]),
      table: [[0.12,'ball'],[0.15,'bomb'],[0.17,'beam'],[0.19,'widen']],
      colorFor: function(r,c){ return grad([[190,230,110],[140,205,90],[90,175,80]], r/23); }   // 嫩绿 → 深绿
    });
  }

  /* ---- 第 37 关：星星（五角星中空，底部左偏 3 格入口） ---- */
  function buildL37(){
    var mask = polyMask([[14.5,3.5],[17.3,8.9],[22.1,9.1],[16.2,12.9],[19.2,17.9],[14.5,13.6],[9.8,17.9],[12.8,12.9],[6.9,9.1],[11.7,8.9]]);
    return patternBuild({
      seed: 20261131, mask: mask,
      channel: channelMask(15,23,[12,13,14]),
      gaps: {12:true, 13:true, 14:true},
      fixed: fixedOf([[11,14,'ball'],[15,10,'ball'],[15,19,'ball']]),
      table: [[0.11,'ball'],[0.14,'bomb'],[0.16,'beam'],[0.175,'widen']],
      colorFor: function(r,c){ return grad([[255,220,90],[250,190,60],[240,160,40]], r/23); }   // 金黄
    });
  }

  /* ---- 第 38 关：月亮（月牙中空，右下 4 格宽入口） ---- */
  function buildL38(){
    var mask = maskSub(discMask(11.5, 13.5, 8.5), discMask(9, 17.5, 7));
    return patternBuild({
      seed: 20261132, mask: mask,
      channel: channelMask(20,23,[16,17,18,19]),
      gaps: {16:true, 17:true, 18:true, 19:true},
      fixed: fixedOf([[17,12,'ball'],[10,9,'ball'],[14,10,'bomb']]),
      table: [[0.10,'ball'],[0.13,'bomb'],[0.15,'beam'],[0.16,'widen'],[0.175,'armor',2]],
      colorFor: function(r,c){ return grad([[240,235,200],[215,210,175],[180,178,150]], r/23); }   // 月白
    });
  }

  /* ---- 第 39 关：房子（三角屋顶 + 屋身 + 门洞，底部 3 格入口直通门洞） ---- */
  function buildL39(){
    var mask = mergeMasks(
      polyMask([[9.5,12],[19.5,12],[14.5,5]]),
      rectMask(12,19,10,19),
      rectMask(16,19,14,15)
    );
    return patternBuild({
      seed: 20261133, mask: mask,
      channel: channelMask(20,23,[14,15,16]),
      gaps: {14:true, 15:true, 16:true},
      fixed: fixedOf([[17,12,'ball'],[17,17,'ball'],[9,14,'ball']]),
      table: [[0.11,'ball'],[0.14,'bomb'],[0.155,'beam'],[0.17,'widen']],
      colorFor: function(r,c){ return grad([[240,170,90],[228,140,70],[205,110,55]], r/23); }   // 暖棕橙
    });
  }

  /* ---- 第 40 关：双层套娃要塞（外腔 + 内腔两层，左侧宽漏斗进外腔，右侧 2 格内门进内腔，2 核心，发球 5 次） ----
     钢框列2/27、顶墙行2、底墙行23。入口在左侧：漏斗向下张开 行25缺口列3-10 →
     行24列4-9 → 底墙行23列5-8（4格），先进下层外腔（行13-22）；外腔与上层内腔
     （行3-11）之间隔着行12钢墙，只在右侧留列22-23 两格内门。两个金色核心藏在
     内腔左上 (4,6) 与右上 (4,23)，各自被一圈装甲砖护卫，必须穿过内门才打得到；
     挡板正中竖直一发会被行25钢墙挡回，连外腔都进不去，更碰不到核心。
     外腔蓝紫砖面混球砖与一排炸弹链，内腔装甲更多。砖 450 块 + 2 核心。 */
  function buildL40(){
    stdGrid();
    grid = blankGrid();
    var bricks = [], steels = [];
    var rnd = seeded(20261134);
    var pal = ['#5a5ae0','#6a5ae8','#4f6fe8','#7a6ae8','#6464d8'];   // 蓝紫砖面
    function isSteel(r,c){
      if (r === 2 && c >= 2 && c <= 27) return true;                          // 顶墙
      if ((c === 2 || c === 27) && r >= 3 && r <= 23) return true;            // 左右墙
      if (r === 12 && c >= 3 && c <= 26 && (c <= 21 || c >= 24)) return true; // 内外腔隔墙，内门只留列22-23
      if (r === 23 && c >= 2 && c <= 27 && (c <= 4 || c >= 9)) return true;   // 底墙，入口列5-8
      if (r === 24 && c >= 2 && c <= 27 && (c <= 3 || c >= 10)) return true;  // 漏斗壁，逐层外张
      if (r === 25 && c >= 2 && c <= 27 && (c <= 2 || c >= 11)) return true;  // 底部缺口列3-10
      return false;
    }
    function isThroat(r,c){ return r >= 21 && c >= 6 && c <= 7; }            // 入口正上方通道，保持空
    function isInner(r,c){ return r >= 3 && r <= 22 && c >= 3 && c <= 26 && r !== 12; }
    var armorRing = cellSet([[3,5],[3,6],[3,7],[4,5],[4,7],[5,5],[5,6],[5,7],
                             [3,22],[3,23],[3,24],[4,22],[4,24],[5,22],[5,23],[5,24]]);
    var fixed = { '20,6':'ball', '20,7':'ball',
                  '14,8':'bomb', '14,11':'bomb', '14,14':'bomb', '14,17':'bomb', '14,20':'bomb',
                  '17,14':'beam', '17,15':'beam',
                  '9,9':'ball', '9,20':'ball', '8,6':'bomb', '8,23':'bomb', '6,14':'beam', '6,15':'beam' };
    for (var r=0;r<ROWS;r++){
      for (var c=0;c<COLS;c++){
        if (isSteel(r,c)){ putSteel(steels, r, c); continue; }
        if (!isInner(r,c) || isThroat(r,c)) continue;
        if ((r === 4 && c === 6) || (r === 4 && c === 23)){ putBrick(bricks, r, c, 'core', 1); continue; }
        if (armorRing[key(r,c)]){ putBrick(bricks, r, c, 'armor', 2); continue; }
        if (fixed[key(r,c)]){ putBrick(bricks, r, c, fixed[key(r,c)], 1); continue; }
        var table = (r <= 11) ? [[0.05,'ball'],[0.08,'bomb'],[0.095,'beam'],[0.12,'armor',2]]
                              : [[0.05,'ball'],[0.075,'bomb'],[0.09,'beam'],[0.13,'armor',2]];
        var d = rollType(rnd, table);
        var nb = putBrick(bricks, r, c, d.type, d.hp);
        if (nb.type === 'normal') nb.color = pal[Math.floor((r + c) / 5) % pal.length];
      }
    }
    var total = 0;
    bricks.forEach(function(b){ if (b.type !== 'core') total++; });
    return { bricks:bricks, steels:steels, total:total };
  }

  /* ---- 第 41 关：字母 A（双腿 + 顶盖 + 横杠，右偏 2 格入口） ---- */
  function buildL41(){
    var mask = mergeMasks(
      rectMask(6,19,10,12), rectMask(6,19,17,19),
      rectMask(6,8,10,19), rectMask(12,14,10,19)
    );
    return patternBuild({
      seed: 20261135, mask: mask,
      channel: channelMask(20,23,[15,16]),
      gaps: {15:true, 16:true},
      fixed: fixedOf([[19,15,'ball'],[10,14,'ball'],[13,14,'widen'],[9,14,'bomb']]),
      table: [[0.16,'armor',2],[0.20,'ball'],[0.23,'bomb'],[0.25,'beam']],
      colorFor: function(r,c){ return grad([[240,120,90],[232,95,70],[215,75,55]], r/23); }   // 珊瑚红
    });
  }

  /* ---- 第 42 关：圆环（环形中空，中央留一块砖岛，左下 2 格入口，环带底部另开一条 2 格宽隧道直通环心砖岛（防密封死局）） ---- */
  function buildL42(){
    var mask = maskSub(discMask(11.5, 14.5, 8.2), discMask(11.5, 14.5, 4.2));
    return patternBuild({
      seed: 20261136, mask: mask,
      channel: mergeMasks(channelMask(17,23,[9,10]), cellSet([[15,13],[15,14],[14,13],[14,14]])),
      gaps: {9:true, 10:true},
      fixed: fixedOf([[16,9,'ball'],[7,18,'ball'],[11,7,'widen'],[12,14,'bomb']]),
      table: [[0.15,'armor',2],[0.19,'ball'],[0.215,'bomb'],[0.235,'beam']],
      colorFor: function(r,c){ return grad([[90,200,220],[70,170,215],[55,140,205]], r/23); }   // 湖蓝
    });
  }

  /* ---- 第 43 关：字母 S（横条与竖段拼成的 S 中空，右下 2 格入口） ---- */
  function buildL43(){
    var mask = mergeMasks(
      rectMask(5,7,11,19), rectMask(8,11,11,13), rectMask(11,13,11,19),
      rectMask(14,17,17,19), rectMask(17,19,11,19)
    );
    return patternBuild({
      seed: 20261137, mask: mask,
      channel: channelMask(20,23,[19,20]),
      gaps: {19:true, 20:true},
      fixed: fixedOf([[19,19,'ball'],[18,15,'ball'],[6,15,'bomb']]),
      table: [[0.15,'armor',2],[0.195,'ball'],[0.22,'bomb'],[0.24,'beam']],
      colorFor: function(r,c){ return grad([[170,120,230],[150,100,218],[130,82,200]], r/23); }   // 紫
    });
  }

  /* ---- 第 44 关：蝴蝶双翼（左右双翼双腔室，左右双入口各 2 格） ---- */
  function buildL44(){
    var mask = mergeMasks(
      ellipseMask(9.5, 9.5, 4.5, 4), ellipseMask(16, 9.5, 3.8, 3.4),
      ellipseMask(9.5, 20, 4.5, 4), ellipseMask(16, 20, 3.8, 3.4),
      rectMask(6,18,14,15)
    );
    return patternBuild({
      seed: 20261138, mask: mask,
      channel: mergeMasks(channelMask(19,23,[9,10]), channelMask(19,23,[19,20])),
      gaps: {9:true, 10:true, 19:true, 20:true},
      fixed: fixedOf([[9,9,'ball'],[9,20,'ball'],[16,10,'widen'],[16,19,'widen']]),
      table: [[0.14,'armor',2],[0.19,'ball'],[0.22,'bomb'],[0.24,'beam']],
      colorFor: function(r,c){ return grad([[245,150,190],[238,120,175],[225,95,155]], r/23); }   // 粉
    });
  }

  /* ---- 第 45 关：双层迷宫（整墙砖面 + 两道钢隔墙错位开洞，右下 2 格入口） ---- */
  function buildL45(){
    var part = [];
    var c;
    for (c=4;c<=25;c++){ if (c !== 20 && c !== 21) part.push([11,c]); }        // 横隔墙，洞在右
    for (c=12;c<=20;c++){ if (c !== 17) part.push([c,8]); }                    // 竖隔墙，洞在中
    return genericBuild({
      seed: 20261139, r0:0, r1:23, c0:2, c1:27,
      steelRow:25, sc0:2, sc1:27, gaps:{21:true, 22:true},
      steelCells: cellSet(part),
      extra: fixedOf([[22,21,'ball'],[6,10,'ball'],[16,20,'ball'],[12,6,'bomb'],[4,22,'beam']]),
      decide: function(r,c,rnd){
        return rollType(rnd, [[0.15,'armor',2],[0.19,'ball'],[0.22,'bomb'],[0.24,'beam']]);
      },
      colorFor: function(r,c){ return grad([[70,180,190],[55,155,180],[42,130,168]], r/23); }   // 青蓝
    });
  }

  /* ---- 第 46 关：钻石（菱形中空，底部尖端左偏 2 格入口） ---- */
  function buildL46(){
    var mask = polyMask([[14.5,3],[21.5,10],[14.5,20],[7.5,10]]);
    return patternBuild({
      seed: 20261140, mask: mask,
      channel: channelMask(21,23,[13,14]),
      gaps: {13:true, 14:true},
      fixed: fixedOf([[17,14,'ball'],[17,15,'ball'],[10,14,'widen']]),
      table: [[0.16,'armor',3],[0.20,'ball'],[0.225,'bomb'],[0.245,'beam']],
      colorFor: function(r,c){ return grad([[190,235,245],[160,220,238],[130,200,228]], r/23); }   // 冰晶蓝白
    });
  }

  /* ---- 第 47 关：雨伞（半圆伞盖 + 伞柄中空，柄底 2 格入口） ---- */
  function buildL47(){
    var dm = discMask(11, 14.5, 7.5), canopy = {}, k;
    for (k in dm){ if (+k.split(',')[0] <= 11) canopy[k] = true; }
    var mask = mergeMasks(canopy, rectMask(11,19,14,15), rectMask(18,19,12,13));
    return patternBuild({
      seed: 20261141, mask: mask,
      channel: channelMask(20,23,[14,15]),
      gaps: {14:true, 15:true},
      fixed: fixedOf([[8,12,'ball'],[8,17,'ball'],[15,14,'widen']]),
      table: [[0.15,'armor',2],[0.195,'ball'],[0.22,'beam'],[0.235,'bomb']],
      colorFor: function(r,c){ return grad([[240,105,120],[232,85,105],[218,65,90]], r/23); }   // 红
    });
  }

  /* ---- 第 48 关：帆船（双帆 + 船身中空，船身左下 2 格入口） ---- */
  function buildL48(){
    var mask = mergeMasks(
      polyMask([[8,16],[21,16],[19,20],[10,20]]),
      rectMask(5,15,14,14),
      polyMask([[15.5,6],[15.5,14],[21,14]]),
      polyMask([[13.5,8],[13.5,14],[8,14]])
    );
    return patternBuild({
      seed: 20261142, mask: mask,
      channel: channelMask(21,23,[11,12]),
      gaps: {11:true, 12:true},
      fixed: fixedOf([[18,12,'ball'],[11,17,'ball'],[18,17,'widen'],[11,15,'bomb']]),
      table: [[0.15,'armor',2],[0.19,'ball'],[0.215,'beam'],[0.23,'bomb']],
      colorFor: function(r,c){ return grad([[100,170,235],[80,150,225],[60,125,210]], r/23); }   // 海蓝
    });
  }

  /* ---- 第 49 关：花朵（五瓣 + 花心 + 花茎中空，右瓣下 2 格入口） ---- */
  function buildL49(){
    var mask = mergeMasks(
      discMask(11, 14.5, 3),
      discMask(5.5, 14.5, 3.2), discMask(9, 19.5, 3.2), discMask(15.5, 18, 3.2),
      discMask(15.5, 11, 3.2), discMask(9, 9.5, 3.2),
      rectMask(14,21,14,15)
    );
    return patternBuild({
      seed: 20261143, mask: mask,
      channel: channelMask(19,23,[16,17]),
      gaps: {16:true, 17:true},
      fixed: fixedOf([[11,14,'ball'],[15,18,'ball'],[19,14,'widen']]),
      table: [[0.16,'armor',2],[0.20,'ball'],[0.23,'bomb'],[0.245,'beam']],
      colorFor: function(r,c){ return grad([[250,170,200],[245,140,180],[235,110,160]], r/23); }   // 花粉
    });
  }

  /* ---- 第 50 关：螺旋回廊要塞（密格加密版：45 列 × 39 行、格 8px，结构与原版一致） ----
     原版 30×26 网格里砖量只有 311 块，现按用户要求缩小砖块加密网格：场地物理尺寸
     不变，列数 30→45、行数 26→39，螺旋回廊走向、右侧斜坡漏斗入口、侧 pocket 与
     双核心位置全部按 1.5 倍坐标映射保持不变；回廊宽 3 格 × 8px = 24px，与原版
     2 格 × 12px 物理宽度相同，球半径不变、可通行。砖面定点抽稀后约 520 块 + 2 核心。 */
  function buildL50(){
    setGrid(45, 39, 8, 7, 0, 78);
    grid = blankGrid();
    var bricks = [], steels = [];
    var rnd = seeded(20261144);
    var pal = ['#3a4a8c','#46589e','#5266b0','#3f5a94','#5a6fc0'];   // 螺旋靛蓝砖面
    function isSteel(r,c){
      if (r === 3 && c >= 3 && c <= 40) return true;                          // 顶墙（原行2）
      if ((c === 3 || c === 40) && r >= 4 && r <= 35) return true;            // 左右墙（原列2/27）
      if (r === 35 && c >= 3 && c <= 40 && (c <= 35 || c >= 39)) return true;   // 底墙（原行23），入口列36-38
      if (r === 36 && c >= 3 && c <= 40 && (c <= 34 || c >= 39)) return true;   // 漏斗层（原行24），缺口列35-38
      if (r === 37 && c >= 3 && c <= 40 && (c <= 32 || c >= 39)) return true;   // 底部缺口层（原行25），缺口列33-38
      return false;
    }
    function inCorr(r,c){
      if (c >= 36 && c <= 38 && r >= 6 && r <= 33) return true;   // A 右壁上行（原列24-25）
      if (r >= 6 && r <= 7 && c >= 6 && c <= 38) return true;     // B 顶壁左行（原行4-5）
      if (c >= 6 && c <= 7 && r >= 6 && r <= 27) return true;      // C 左壁下行（原列4-5）
      if (r >= 25 && r <= 27 && c >= 6 && c <= 28) return true;    // D 中下横行（原行17-18）
      if (c >= 27 && c <= 28 && r >= 12 && r <= 27) return true;    // E 内右壁上行（原列18-19）
      if (r >= 12 && r <= 13 && c >= 12 && c <= 28) return true;    // F 内顶横行（原行8-9）
      if (r >= 15 && r <= 16 && c >= 20 && c <= 21) return true;   // 中心密室入口（原行10-11、列13-14）
      if (r >= 19 && r <= 21 && c === 8) return true;              // 侧 pocket 入口（原列6）
      return false;
    }
    function isInner(r,c){ return r >= 4 && r <= 34 && c >= 4 && c <= 39; }
    var corrFixed = { '7,36':'ball', '7,7':'ball', '25,7':'ball', '25,27':'ball', '12,27':'ball',
                      '18,36':'armor', '6,21':'armor', '25,18':'beam', '13,18':'beam' };
    for (var r=0;r<ROWS;r++){
      for (var c=0;c<COLS;c++){
        if (isSteel(r,c)){ putSteel(steels, r, c); continue; }
        if (!isInner(r,c)) continue;
        if ((r === 20 && c === 11) || (r === 20 && c === 21)){ putBrick(bricks, r, c, 'core', 1); continue; }
        if (inCorr(r,c)){
          var cf = corrFixed[key(r,c)];
          if (cf) putBrick(bricks, r, c, cf, cf === 'armor' ? 2 : 1);
          continue;
        }
        if (rnd() < 0.34) continue;   // 加密后定点抽稀，把砖量控制在约 520 块（结构与回廊不动）
        var d = rollType(rnd, [[0.05,'ball'],[0.075,'bomb'],[0.09,'beam'],[0.12,'armor',2]]);
        var nb = putBrick(bricks, r, c, d.type, d.hp);
        if (nb.type === 'normal') nb.color = pal[Math.floor((r + c) / 5) % pal.length];
      }
    }
    var total = 0;
    bricks.forEach(function(b){ if (b.type !== 'core') total++; });
    return { bricks:bricks, steels:steels, total:total };
  }

  /* ---- 第 51 关：字母 B（竖柄 + 双凸肚中空，肚底 2 格入口，入口正上方定点球砖） ---- */
  function buildL51(){
    var mask = mergeMasks(
      rectMask(5,19,9,11), rectMask(5,11,12,17), rectMask(12,19,12,18)
    );
    return patternBuild({
      seed: 20261145, mask: mask,
      channel: channelMask(20,23,[13,14]),
      gaps: {13:true, 14:true},
      fixed: fixedOf([[17,13,'ball'],[17,14,'ball'],[8,14,'ball'],[15,16,'widen']]),
      table: [[0.20,'armor',3],[0.24,'ball'],[0.27,'bomb'],[0.285,'beam']],
      colorFor: function(r,c){ return grad([[235,160,80],[228,140,60],[215,118,45]], r/23); }   // 琥珀
    });
  }

  /* ---- 第 52 关：字母 K（竖柄 + 双斜臂中空，右臂尖下 2 格入口） ---- */
  function buildL52(){
    var arms = [];
    var r;
    for (r=5;r<=12;r++) arms.push([r, 18-(r-5)]);
    for (r=13;r<=19;r++) arms.push([r, 12+(r-13)]);
    var mask = mergeMasks(rectMask(5,19,9,11), cellSet(arms));
    return patternBuild({
      seed: 20261146, mask: mask,
      channel: mergeMasks(channelMask(20,23,[19,20]), cellSet([[20,10],[21,10]])),
      gaps: {19:true, 20:true},
      fixed: fixedOf([[19,18,'ball'],[4,17,'ball'],[12,10,'widen']]),
      table: [[0.20,'armor',2],[0.235,'ball'],[0.265,'beam'],[0.28,'bomb']],
      colorFor: function(r,c){ return grad([[90,190,160],[70,170,145],[52,148,128]], r/23); }   // 青绿
    });
  }

  /* ---- 第 53 关：皇冠（三尖冠身中空，冠底中央 2 格入口） ---- */
  function buildL53(){
    var mask = mergeMasks(
      rectMask(12,19,8,21),
      polyMask([[8,12],[11.5,12],[9.8,6]]),
      polyMask([[13,12],[16,12],[14.5,5]]),
      polyMask([[17.5,12],[21,12],[19.2,6]])
    );
    return patternBuild({
      seed: 20261147, mask: mask,
      channel: channelMask(20,23,[14,15]),
      gaps: {14:true, 15:true},
      fixed: fixedOf([[17,11,'ball'],[17,18,'ball'],[15,14,'widen']]),
      table: [[0.21,'armor',3],[0.25,'ball'],[0.275,'bomb'],[0.29,'beam']],
      colorFor: function(r,c){ return grad([[255,205,70],[248,185,50],[238,160,35]], r/23); }   // 皇冠金
    });
  }

  /* ---- 第 54 关：齿轮（圆盘 + 八齿 + 中心孔中空，左齿下 2 格入口） ---- */
  function buildL54(){
    var teeth = mergeMasks(
      rectMask(3,5,13,16), rectMask(18,20,13,16), rectMask(10,12,5,7), rectMask(10,12,22,24),
      rectMask(5,7,8,10), rectMask(5,7,19,21), rectMask(16,18,8,10), rectMask(16,18,19,21)
    );
    var mask = maskSub(mergeMasks(discMask(11.5, 14.5, 6.5), teeth), discMask(11.5, 14.5, 2.8));
    return patternBuild({
      seed: 20261148, mask: mask,
      channel: channelMask(21,23,[12,13]),
      gaps: {12:true, 13:true},
      fixed: fixedOf([[16,17,'ball'],[7,12,'ball'],[11,18,'widen'],[10,14,'bomb']]),
      table: [[0.20,'armor',2],[0.24,'ball'],[0.265,'beam'],[0.28,'bomb']],
      colorFor: function(r,c){ return grad([[170,180,195],[150,160,178],[128,140,160]], r/23); }   // 钢银灰
    });
  }

  /* ---- 第 55 关：三层迷宫（整墙砖面 + 三层钢隔墙交错开洞，右下 2 格入口） ---- */
  function buildL55(){
    var part = [];
    var c;
    for (c=3;c<=26;c++){ if (c !== 7 && c !== 8) part.push([7,c]); }          // 第一层，洞在左
    for (c=3;c<=26;c++){ if (c !== 21 && c !== 22) part.push([15,c]); }       // 第二层，洞在右
    return genericBuild({
      seed: 20261149, r0:0, r1:23, c0:2, c1:27,
      steelRow:25, sc0:2, sc1:27, gaps:{18:true, 19:true},
      steelCells: cellSet(part),
      extra: fixedOf([[22,18,'ball'],[11,14,'ball'],[3,20,'ball'],[11,22,'beam'],[3,6,'bomb'],[19,8,'widen']]),
      decide: function(r,c,rnd){
        return rollType(rnd, [[0.20,'armor',3],[0.24,'ball'],[0.265,'bomb'],[0.28,'beam']]);
      },
      colorFor: function(r,c){ return grad([[120,110,190],[105,95,175],[90,80,158]], r/23); }   // 靛紫
    });
  }

  /* ---- 第 56 关：双子塔（双塔 + 顶部连桥双腔室，塔底双入口各 2 格） ---- */
  function buildL56(){
    var mask = mergeMasks(
      rectMask(4,19,7,12), rectMask(4,19,17,22), rectMask(4,6,7,22)
    );
    return patternBuild({
      seed: 20261150, mask: mask,
      channel: mergeMasks(channelMask(20,23,[9,10]), channelMask(20,23,[19,20])),
      gaps: {9:true, 10:true, 19:true, 20:true},
      fixed: fixedOf([[16,9,'ball'],[16,20,'ball'],[5,14,'widen'],[12,9,'bomb'],[12,20,'beam']]),
      table: [[0.19,'armor',2],[0.23,'ball'],[0.26,'bomb'],[0.275,'beam']],
      colorFor: function(r,c){ return grad([[80,160,220],[65,140,205],[50,120,188]], r/23); }   // 天蓝
    });
  }

  /* ---- 第 57 关：旋涡隔断（圆盘中空 + 盘内错位钢隔断，底部 2 格入口） ---- */
  function buildL57(){
    var mask = discMask(11.5, 14.5, 8.5);
    return patternBuild({
      seed: 20261151, mask: mask,
      channel: channelMask(20,23,[13,14]),
      gaps: {13:true, 14:true},
      steelExtra: cellSet([[11,8],[11,9],[11,10],[11,11],[11,12],[11,13],[12,16],[12,17],[12,18],[12,19],[12,20],[12,21]]),
      fixed: fixedOf([[17,13,'ball'],[6,11,'ball'],[7,18,'widen']]),
      table: [[0.20,'armor',3],[0.235,'ball'],[0.26,'beam'],[0.275,'bomb']],
      colorFor: function(r,c){
        var dr = r - 11.5, dc = c - 14.5;
        var ang = Math.atan2(dr, dc); if (ang < 0) ang += Math.PI * 2;
        var rad = Math.sqrt(dr*dr + dc*dc);
        return ['#8a5ae8','#f06ab8','#4f8fe8'][((Math.floor(ang/(Math.PI*2)*3 + rad*0.35) % 3) + 3) % 3];
      }
    });
  }

  /* ---- 第 58 关：迷宫回廊（钢框回廊 + 框内隔墙分区，左下 2 格入口穿框而入） ---- */
  function buildL58(){
    var frame = [];
    var c, r;
    for (c=4;c<=25;c++){ frame.push([3,c]); if (c !== 10 && c !== 11) frame.push([21,c]); }
    for (r=4;r<=20;r++){ frame.push([r,4]); frame.push([r,25]); }
    for (c=5;c<=18;c++) frame.push([12,c]);                                  // 框内横隔墙
    for (r=12;r<=20;r++){ if (r !== 16 && r !== 17) frame.push([r,18]); }   // 竖隔墙在行16-17 留门洞（该处填砖，可打通）                                 // 框内竖隔墙
    return genericBuild({
      seed: 20261152, r0:0, r1:23, c0:2, c1:27,
      steelRow:25, sc0:2, sc1:27, gaps:{10:true, 11:true},
      steelCells: cellSet(frame),
      extra: fixedOf([[20,10,'ball'],[6,20,'ball'],[16,8,'widen'],[6,8,'bomb']]),
      decide: function(r,c,rnd){
        if (r >= 4 && r <= 20 && c >= 5 && c <= 24)
          return rollType(rnd, [[0.20,'armor',2],[0.24,'ball'],[0.265,'bomb'],[0.28,'beam']]);
        return null;   // 框外保持空，球沿框外回廊绕行到入口
      },
      colorFor: function(r,c){ return grad([[90,170,110],[72,150,92],[55,130,75]], r/23); }   // 苔绿
    });
  }

  /* ---- 第 59 关：终局前哨（中央堡垒 + 双侧塔楼中空，堡底单格窄入口） ---- */
  function buildL59(){
    var mask = mergeMasks(
      rectMask(8,19,11,18), rectMask(5,19,5,8), rectMask(5,19,21,24), rectMask(5,7,5,24)
    );
    return patternBuild({
      seed: 20261153, mask: mask,
      channel: channelMask(20,23,[15]),
      gaps: {15:true},
      fixed: fixedOf([[17,15,'ball'],[10,13,'widen'],[10,17,'bomb'],[16,6,'ball'],[16,23,'ball']]),
      table: [[0.21,'armor',3],[0.245,'ball'],[0.27,'bomb'],[0.285,'beam']],
      colorFor: function(r,c){ return grad([[200,90,80],[185,75,68],[168,60,55]], r/23); }   // 暗红
    });
  }

  /* ---- 第 60 关：三室星核要塞（密格加密版：45 列 × 39 行、格 8px，结构与原版一致） ----
     原版 30×26 网格里砖量 427 块，现按用户要求缩小砖块加密网格：场地物理尺寸不变，
     列数 30→45、行数 26→39；两道钢隔墙（密格列15、列27）、三间互不连通的密室、
     三个入口（左漏斗、中央烟囱、右斜坡）与三核心位置全部按 1.5 倍坐标映射保持不变，
     各入口宽 3 格 × 8px = 24px，与原版 2 格物理宽度相同、可通行。砖面定点抽稀后
     约 550 块 + 3 核心。发球 6 次不变。 */
  function buildL60(){
    setGrid(45, 39, 8, 7, 0, 78);
    grid = blankGrid();
    var bricks = [], steels = [];
    var rnd = seeded(20261154);
    var pals = [ ['#c9a227','#d9b23a','#b8912a'],            // 左室 金
                 ['#e86a4f','#e85a3a','#d94f35'],            // 中央室 焰红
                 ['#38a6d9','#4fb8e8','#2f8fd0'] ];          // 右室 青蓝
    function roomOf(c){ return c <= 14 ? 0 : (c <= 26 ? 1 : 2); }
    function isSteel(r,c){
      if (r === 3 && c >= 3 && c <= 40) return true;                          // 顶墙（原行2）
      if ((c === 3 || c === 40) && r >= 4 && r <= 35) return true;            // 左右墙（原列2/27）
      if ((c === 15 || c === 27) && r >= 4 && r <= 34) return true;           // 两道隔墙（原列10/18），三室不连通
      if ((c === 20 || c === 24) && (r === 32 || r === 33)) return true;      // 中央烟囱室内钢壁（原列13/16、行21-22）
      if (r === 35 && c >= 3 && c <= 40 && !(c >= 6 && c <= 8) && !(c >= 21 && c <= 23) && !(c >= 36 && c <= 38)) return true;   // 底墙，三个入口各 3 格
      if (r === 36 && c >= 3 && c <= 40 && !(c >= 5 && c <= 9) && !(c >= 21 && c <= 23) && !(c >= 34 && c <= 39)) return true;   // 漏斗层
      if (r === 37 && c >= 3 && c <= 40 && !(c >= 3 && c <= 10) && !(c >= 21 && c <= 23) && !(c >= 33 && c <= 39)) return true;   // 底部缺口层
      return false;
    }
    function isChimney(r,c){ return r >= 30 && c >= 21 && c <= 23; }         // 中央烟囱内通道，保持空
    function isInner(r,c){ return r >= 4 && r <= 34 && c >= 4 && c <= 39; }
    var armorRing = cellSet([[5,8],[5,9],[5,10],[6,7],[6,11],[7,7],[7,11],[8,7],[8,11],[9,8],[9,9],[9,10]]);
    var fixed = { '30,7':'ball', '27,21':'ball', '30,36':'ball',
                  '12,18':'bomb', '12,21':'bomb', '12,24':'bomb', '16,19':'bomb', '16,22':'bomb', '21,18':'bomb', '21,24':'bomb',
                  '16,30':'beam', '16,31':'beam', '16,32':'beam', '16,33':'beam', '16,34':'beam', '16,35':'beam', '16,36':'beam',
                  '14,33':'beam', '15,33':'beam', '18,33':'beam', '20,33':'beam' };
    for (var r=0;r<ROWS;r++){
      for (var c=0;c<COLS;c++){
        if (isSteel(r,c)){ putSteel(steels, r, c); continue; }
        if (!isInner(r,c) || isChimney(r,c)) continue;
        if ((r === 7 && c === 9) || (r === 7 && c === 21) || (r === 7 && c === 33)){ putBrick(bricks, r, c, 'core', 1); continue; }
        if (armorRing[key(r,c)]){ putBrick(bricks, r, c, 'armor', 2); continue; }
        if (fixed[key(r,c)]){ putBrick(bricks, r, c, fixed[key(r,c)], 1); continue; }
        if (rnd() < 0.46) continue;   // 加密后定点抽稀，把砖量控制在约 550 块（三室结构不动）
        var room = roomOf(c);
        var table = (room === 0) ? [[0.06,'ball'],[0.09,'bomb'],[0.11,'beam'],[0.20,'armor',2]]
                  : (room === 1) ? [[0.06,'ball'],[0.16,'bomb'],[0.19,'beam']]
                  : [[0.06,'ball'],[0.10,'bomb'],[0.20,'beam']];
        var d = rollType(rnd, table);
        var nb = putBrick(bricks, r, c, d.type, d.hp);
        if (nb.type === 'normal') nb.color = pals[room][Math.floor((r + c) / 5) % 3];
      }
    }
    var total = 0;
    bricks.forEach(function(b){ if (b.type !== 'core') total++; });
    return { bricks:bricks, steels:steels, total:total };
  }

  /* ================= 61-100 关：海洋世界动物像素风（细格 40 列 × 34 行、格 9px） =================
     砖块本身拼成动物像素图案：每关一种海洋动物，全部用下面的像素画布工具在细格上
     画出轮廓与特征色，再按难度段配钢框：61-69 开放无钢框；71-79 底部钢条 + 两侧
     局部钢框、缺口 4 格；81-89 完整钢框、缺口 3 格；91-99 完整钢框 + 珊瑚迷宫、
     缺口 3 格，且入口正上方定点球砖、迷宫内有球砖与加宽砖；70/80/90/100 为要塞。
     球半径、挡板、场地物理尺寸不变；每关砖量由构建器兜底在 400-800 块之间
     （不足时补海底沙砖、过多时定点抽稀，动物轮廓不动）。 */
  function ocSet(M,r,c,ch){
    if (r < 0 || r >= 34 || c < 0 || c >= 40) return;
    if (ch === null) delete M[key(r,c)]; else M[key(r,c)] = ch;
  }
  function ocE(M,cx,cy,rx,ry,ch){
    for (var r=Math.floor(cy-ry); r<=Math.ceil(cy+ry); r++)
      for (var c=Math.floor(cx-rx); c<=Math.ceil(cx+rx); c++){
        var dr=(r-cy)/ry, dc=(c-cx)/rx;
        if (dr*dr + dc*dc <= 1) ocSet(M,r,c,ch);
      }
  }
  function ocP(M,pts,ch){
    for (var r=0;r<34;r++) for (var c=0;c<40;c++){
      var x=c, y=r, ins=false;
      for (var i=0,j=pts.length-1;i<pts.length;j=i++){
        var xi=pts[i][0], yi=pts[i][1], xj=pts[j][0], yj=pts[j][1];
        if (((yi>y)!==(yj>y)) && (x<(xj-xi)*(y-yi)/(yj-yi)+xi)) ins=!ins;
      }
      if (ins) ocSet(M,r,c,ch);
    }
  }
  function ocR(M,r0,r1,c0,c1,ch){ for (var r=r0;r<=r1;r++) for (var c=c0;c<=c1;c++) ocSet(M,r,c,ch); }
  function ocS(M,r0,c0,r1,c1,w,ch){
    var n = Math.max(Math.abs(r1-r0), Math.abs(c1-c0)) * 2;
    for (var i=0;i<=n;i++) ocE(M, c0+(c1-c0)*i/n, r0+(r1-r0)*i/n, w, w, ch);
  }
  function ocW(M,c,r0,r1,amp,ph,ch,w){
    for (var r=r0;r<=r1;r++){
      var cc = c + Math.round(Math.sin((r-r0)*0.55 + ph) * amp);
      ocE(M, cc, r, w || 0.8, w || 0.8, ch);
    }
  }
  function ocStar(M,cx,cy,R,ri,ch){
    var pts = [];
    for (var k=0;k<10;k++){
      var ang = -Math.PI/2 + k*Math.PI/5, rad = (k%2===0) ? R : ri;
      pts.push([cx + Math.cos(ang)*rad, cy + Math.sin(ang)*rad]);
    }
    ocP(M, pts, ch);
  }
  function ocCols(M,cols,ch){ for (var k in M){ var c = +k.split(',')[1]; if (cols.indexOf(c) >= 0) M[k] = ch; } }
  function ocRows(M,rows,ch){ for (var k in M){ var r = +k.split(',')[0]; if (rows.indexOf(r) >= 0) M[k] = ch; } }
  function ocDot(M,r,c,ch){ if (M[key(r,c)]) M[key(r,c)] = ch; }

  var OC_TABLES = {
    A: [[0.04,'armor',2],[0.08,'ball'],[0.10,'bomb'],[0.115,'beam'],[0.13,'widen']],
    B: [[0.12,'armor',2],[0.16,'armor',3],[0.19,'ball'],[0.21,'bomb'],[0.225,'beam'],[0.24,'widen']],
    C: [[0.14,'armor',2],[0.20,'armor',3],[0.225,'ball'],[0.245,'bomb'],[0.26,'beam'],[0.275,'widen']],
    D: [[0.16,'armor',3],[0.24,'armor',2],[0.265,'ball'],[0.285,'bomb'],[0.30,'beam'],[0.315,'widen']],
    F: [[0.06,'ball'],[0.09,'bomb'],[0.11,'beam'],[0.16,'armor',2]]
  };

  function buildOcean(n){
    var spec = OCEAN_SPECS[n];
    setGrid(40, 34, 9, 8, 0, 75);
    grid = blankGrid();
    var bricks = [], steels = [];
    var rnd = seeded(spec.seed);
    var pal = spec.pal;
    if (!pal.s) pal.s = '#2e4a5f';
    var M = {};
    spec.paint(M);
    var i, k, r, c;
    // 要塞：先挖腔室，再放核心（核心格不被砖覆盖）
    if (spec.carve) spec.carve.forEach(function(cv){ ocE(M, cv[0], cv[1], cv[2], cv[3], null); });
    var coreSet = {};
    if (spec.cores) spec.cores.forEach(function(cc){ coreSet[key(cc[0],cc[1])] = true; delete M[key(cc[0],cc[1])]; });
    // 核心护卫圈：核心周围已画出的砖格改成装甲
    var fixedMap = {};
    if (spec.fixed) spec.fixed.forEach(function(f){ fixedMap[key(f[0],f[1])] = { type:f[2], hp:f[3]||1 }; });
    if (spec.cores) spec.cores.forEach(function(cc){
      for (var dr=-1;dr<=1;dr++) for (var dc=-1;dc<=1;dc++){
        if (!dr && !dc) continue;
        var nk = key(cc[0]+dr, cc[1]+dc);
        if (M[nk]) fixedMap[nk] = { type:'armor', hp:2 };
      }
    });
    // 61-100 关加固：所有普通关都用完整钢框 + 内部分隔钢条，入口随难度收窄；
    // 空白处用深海背景砖补满到目标砖量，动物图案仍以亮色砖呈现，不再是稀疏剪影。
    var isFortOcean = !!spec.cores;
    var gapW = spec.tier === 'A' ? 4 : (spec.tier === 'B' ? 3 : (spec.tier === 'D' ? 2 : 3));
    var mainGap = spec.gap ? spec.gap.slice() : null;
    if (!mainGap && spec.gapsList) mainGap = spec.gapsList[0].slice();
    if (!mainGap){
      var gapCenters = [10, 19, 28];
      var gcen0 = gapCenters[n % 3];
      mainGap = [gcen0 - Math.floor((gapW - 1) / 2), gcen0 + Math.ceil((gapW - 1) / 2)];
      mainGap[0] = Math.max(3, mainGap[0]); mainGap[1] = Math.min(36, mainGap[1]);
    }
    if (mainGap){
      var gw0 = mainGap[1] - mainGap[0] + 1;
      if (gw0 > gapW){
        var gc0 = Math.round((mainGap[0] + mainGap[1]) / 2);
        mainGap = [gc0 - Math.floor((gapW - 1) / 2), gc0 + Math.ceil((gapW - 1) / 2)];
      }
    }
    var gapsList = spec.gapsList ? spec.gapsList.map(function(g){ return g.slice(); }) : (mainGap ? [mainGap] : []);
    var steelSet = {};
    function addSteel(rr,cc){ steelSet[key(rr,cc)] = true; }
    function bottomBar(){
      for (var bc=2; bc<=37; bc++){
        var inGap = false;
        gapsList.forEach(function(g){ if (bc >= g[0] && bc <= g[1]) inGap = true; });
        if (!inGap) addSteel(33, bc);
      }
    }
    var effectiveFrame = isFortOcean ? spec.frame : (spec.frame === 'maze' ? 'maze' : 'full');
    if (effectiveFrame === 'full' || effectiveFrame === 'maze' || effectiveFrame === 'fort'){
      for (var tc=2; tc<=37; tc++) addSteel(1, tc);
      for (var sr=2; sr<=32; sr++){ addSteel(sr, 2); addSteel(sr, 37); }
      bottomBar();
    }
    if (!isFortOcean){
      var gcenMain = mainGap ? Math.round((mainGap[0] + mainGap[1]) / 2) : 19;
      var partRows = spec.tier === 'A' ? [16] : spec.tier === 'B' ? [12, 22] : spec.tier === 'C' ? [10, 20] : [14];
      partRows.forEach(function(pr, idx){
        var gapC = (idx % 2 === 0) ? (gcenMain <= 19 ? 28 : 10) : gcenMain;
        for (var pc=3; pc<=36; pc++){ if (pc < gapC - 1 || pc > gapC + 1) addSteel(pr, pc); }
      });
      if (spec.tier === 'C'){
        for (var vr=4; vr<=9; vr++){ if (vr !== 7) addSteel(vr, 20); }
      }
      if (spec.tier === 'D'){
        for (var vr2=4; vr2<=12; vr2++){ if (vr2 !== 8) addSteel(vr2, 10); }
        for (var vr3=16; vr3<=24; vr3++){ if (vr3 !== 20) addSteel(vr3, 29); }
      }
    }
    if (spec.frame === 'maze' && spec.gap){
      var gc0 = spec.gap[0], gc1 = spec.gap[1], gcen = Math.round((gc0+gc1)/2);
      for (var m1=4; m1<=35; m1++){ if (m1 < gcen-2 || m1 > gcen+2) addSteel(27, m1); }
      for (var m2=gcen-6; m2<=gcen+6; m2++){ if (m2 < gcen-1 || m2 > gcen+1) addSteel(30, m2); }
      for (var m3=28; m3<=29; m3++){
        if (gcen-8 >= 4) addSteel(m3, gcen-8);
        if (gcen+8 <= 35) addSteel(m3, gcen+8);
      }
      fixedMap[key(32, gcen)] = { type:'ball', hp:1 };
      fixedMap[key(28, 7)] = { type:'ball', hp:1 };
      fixedMap[key(28, 32)] = { type:'ball', hp:1 };
      fixedMap[key(25, gcen)] = { type:'widen', hp:1 };
    }
    if (spec.frameSteels) spec.frameSteels.forEach(function(fs){ addSteel(fs[0], fs[1]); });
    for (k in steelSet){ delete M[k]; delete fixedMap[k]; }
    // 补满空白：非要塞关把钢框内的空白格用深海背景砖补到目标砖量，保留单格细节空洞；
    // 分隔钢条都留了 3 格缺口，不会密封任何砖群。
    if (!isFortOcean){
      var fillTarget = spec.tier === 'A' ? 680 : (spec.tier === 'B' ? 720 : (spec.tier === 'C' ? 760 : 780));
      var emptyCells = [];
      for (var fr=2; fr<=32; fr++) for (var fc=3; fc<=36; fc++){
        var fk = key(fr, fc);
        if (M[fk] || steelSet[fk] || coreSet[fk]) continue;
        if (M[key(fr-1,fc)] && M[key(fr+1,fc)] && M[key(fr,fc-1)] && M[key(fr,fc+1)]) continue;
        emptyCells.push(fk);
      }
      for (var sh=emptyCells.length-1; sh>0; sh--){ var sj2 = Math.floor(rnd()*(sh+1)); var tmp2 = emptyCells[sh]; emptyCells[sh]=emptyCells[sj2]; emptyCells[sj2]=tmp2; }
      var filledCount = Object.keys(M).length;
      for (var ei=0; ei<emptyCells.length && filledCount < fillTarget; ei++){ M[emptyCells[ei]] = 's'; filledCount++; }
    }
    var cells = Object.keys(M);
    if (cells.length > 860){
      for (var si=cells.length-1; si>0; si--){ var sj = Math.floor(rnd()*(si+1)); var stmp = cells[si]; cells[si]=cells[sj]; cells[sj]=stmp; }
      var keep = {};
      cells.slice(0, 850).forEach(function(ck){ keep[ck] = true; });
      for (k in M) if (!keep[k] && !fixedMap[k]) delete M[k];
    }
    // 放钢
    for (k in steelSet){ var sp = k.split(','); putSteel(steels, +sp[0], +sp[1]); }
    // 放砖
    for (k in M){
      var bp = k.split(','), br2 = +bp[0], bc2 = +bp[1];
      var fx = fixedMap[k];
      var d = fx ? { type:fx.type, hp:fx.hp } : rollType(rnd, OC_TABLES[spec.tier]);
      var nb = putBrick(bricks, br2, bc2, d.type, d.hp);
      nb.color = pal[M[k]] || pal.a;
    }
    // fixed 里不在图案内的格子（迷宫口袋、要塞通道口的定点砖）单独放
    for (k in fixedMap){
      if (M[k] || steelSet[k] || coreSet[k]) continue;
      var fp = k.split(','), fd = fixedMap[k];
      var fb = putBrick(bricks, +fp[0], +fp[1], fd.type, fd.hp);
      fb.color = pal.a;
    }
    // 放核心
    if (spec.cores) spec.cores.forEach(function(cc){ putBrick(bricks, cc[0], cc[1], 'core', 1); });
    var total = 0;
    bricks.forEach(function(b){ if (b.type !== 'core') total++; });
    return { bricks:bricks, steels:steels, total:total };
  }
  function mkOcean(n){ return function(){ return buildOcean(n); }; }

  /* ---- 61-100 关动物图案定义（paint 在 40×34 细格画布上作画，字符经 pal 取色） ---- */
  var OCEAN_SPECS = {
    61: { seed:20261161, tier:'A', frame:'none', pal:{a:'#ff7d1c',b:'#ff9d45',w:'#ffffff'},
      paint:function(M){
        ocP(M,[[28,15],[36,8],[36,22]],'a');
        ocE(M,17,15,13,8,'a');
        ocE(M,17,7,6,2,'b');
        ocCols(M,[12,13],'w'); ocCols(M,[21,22],'w');
        ocSet(M,13,10,null); ocSet(M,14,10,null);
      },
      fixed:[[17,17,'ball'],[12,24,'ball'],[20,12,'widen']] },
    62: { seed:20261162, tier:'A', frame:'none', pal:{a:'#b04a8a',b:'#e06aa8'},
      paint:function(M){
        ocStar(M,19,16,15,8.5,'a');
        ocE(M,19,16,3,3,'b');
        ocE(M,19,6,1.4,1.4,'b'); ocE(M,28,12,1.4,1.4,'b'); ocE(M,26,24,1.4,1.4,'b');
        ocE(M,12,24,1.4,1.4,'b'); ocE(M,10,12,1.4,1.4,'b');
      },
      fixed:[[16,19,'ball'],[10,19,'ball']] },
    63: { seed:20261163, tier:'A', frame:'none', pal:{a:'#c9a7eb',b:'#9f7fe0',c:'#f2d8ff'},
      paint:function(M){
        ocE(M,19,11,15,10,'a');
        for (var r=12;r<=21;r++) for (var c=4;c<=34;c++) ocSet(M,r,c,null);
        ocE(M,15,8,2.2,1.6,'b'); ocE(M,24,7,2.2,1.6,'b'); ocE(M,19,10,2.6,1.8,'c');
        [9,13,17,21,25,29].forEach(function(cc,ix){ ocW(M,cc,13,29,1.6,ix*1.3,'b',0.9); });
        ocW(M,19,13,25,2.4,0,'a',1.5);
      },
      fixed:[[9,19,'ball'],[20,13,'ball']] },
    64: { seed:20261164, tier:'A', frame:'none', pal:{a:'#f2b134',b:'#e07b39'},
      paint:function(M){
        ocE(M,20,17,7,10,'a');
        ocE(M,25,8,4.5,3.5,'a');
        ocR(M,7,9,29,33,'a');
        ocRows(M,[14,15,19,20,23],'b');
        ocP(M,[[14,12],[8,16],[14,20]],'b');
        ocE(M,13,26,4.5,4.5,'a'); ocE(M,13,26,2,2,null);
        ocR(M,4,5,23,27,'b');
        ocSet(M,8,27,null);
      },
      fixed:[[17,20,'ball'],[24,15,'widen']] },
    65: { seed:20261165, tier:'A', frame:'none', pal:{a:'#e2483d',b:'#b82e26',d:'#401512'},
      paint:function(M){
        ocE(M,19,16,13,7,'a');
        ocE(M,5,9,4,4,'b'); ocE(M,33,9,4,4,'b');
        ocS(M,13,12,8,10,1.2,'a'); ocS(M,25,12,30,10,1.2,'a');
        ocS(M,19,10,9,8,0.9,'a'); ocS(M,19,26,9,8,0.9,'a');
        ocS(M,21,10,11,8,0.9,'a'); ocS(M,21,28,11,30,0.9,'a');
        ocS(M,22,12,7,6,0.9,'a'); ocS(M,22,26,31,32,0.9,'a');
        ocE(M,16,10,1.2,1.2,'d'); ocE(M,22,10,1.2,1.2,'d');
        ocCols(M,[19],'b');
      },
      fixed:[[16,19,'ball'],[14,12,'ball'],[14,26,'widen']] },
    66: { seed:20261166, tier:'A', frame:'none', pal:{a:'#3f9e4d',b:'#7bc47f'},
      paint:function(M){
        ocE(M,18,15,13,9,'a');
        ocE(M,18,15,9,6,'b'); ocE(M,18,15,4,3,'a');
        ocE(M,34,15,3,3.5,'b');
        ocE(M,8,6,3,2,'b'); ocE(M,28,6,3,2,'b'); ocE(M,8,24,3,2,'b'); ocE(M,28,24,3,2,'b');
        ocSet(M,15,35,null);
      },
      fixed:[[15,18,'ball'],[10,12,'ball'],[20,24,'widen']] },
    67: { seed:20261167, tier:'A', frame:'none', pal:{a:'#8a5ae8',b:'#6a3fd0'},
      paint:function(M){
        ocE(M,19,12,10,8,'a');
        ocE(M,14,9,1.6,1.2,'b'); ocE(M,24,10,1.6,1.2,'b');
        [9,13,17,21,25,29].forEach(function(cc,ix){ ocW(M,cc,19,29,1.4,ix,'a',1.1); ocE(M,cc,30,1.2,1,'b'); });
        ocSet(M,14,15,null); ocSet(M,14,23,null);
        ocRows(M,[17],'b');
      },
      fixed:[[12,19,'ball'],[24,17,'ball']] },
    68: { seed:20261168, tier:'A', frame:'none', pal:{a:'#5aa7d6',b:'#3d7fb8',w:'#eaf6ff'},
      paint:function(M){
        ocP(M,[[8,16],[13,10],[26,9],[33,13],[37,16],[33,20],[25,22],[13,21]],'a');
        ocE(M,19,18,11,3,'w');
        ocP(M,[[32,15],[38,10],[38,21]],'b');
        ocP(M,[[18,11],[22,5],[24,11]],'b');
        ocP(M,[[14,19],[17,25],[20,19]],'b');
        ocSet(M,14,12,null);
      },
      fixed:[[15,20,'ball'],[17,28,'widen']] },
    69: { seed:20261169, tier:'A', frame:'none', pal:{a:'#7d8fa3',b:'#5a6d80',w:'#eef3f6',d:'#33424e'},
      paint:function(M){
        ocE(M,18,15,14,6,'a');
        ocE(M,18,18,12,3,'w');
        ocP(M,[[31,15],[38,8],[38,22]],'a');
        ocP(M,[[16,10],[21,4],[24,10]],'b');
        ocP(M,[[12,19],[15,25],[18,19]],'b');
        ocR(M,18,19,3,5,'w');
        ocS(M,12,10,18,10,0.6,'d');
        ocSet(M,13,7,null);
      },
      fixed:[[15,16,'ball'],[13,26,'ball']] },
    70: { seed:20261170, tier:'F', frame:'fort', gapsList:[[16,21]], pal:{a:'#4a7fb5',b:'#35618f',w:'#dceefb'},
      paint:function(M){
        ocP(M,[[31,14],[36,9],[36,19]],'a');
        ocE(M,17,14,15,11,'a');
        ocE(M,17,20,11,4,'w');
        ocP(M,[[12,24],[16,29],[19,24]],'b');
        ocSet(M,11,7,null);
      },
      carve:[[17,17,8,4.5]],
      cores:[[15,11],[15,23]], servesNote:true,
      frameSteels:(function(){ var s=[]; for (var c=10;c<=24;c++){ if (c<16||c>19) s.push([22,c]); } for (var c=15;c<=22;c++){ if (c<16||c>21) s.push([32,c]); } return s; })(),
      fixed:[[8,17,'ball'],[18,28,'ball']] },
    71: { seed:20261171, tier:'B', frame:'partial', gap:[17,20], pal:{a:'#8d99a6',b:'#6e7a86'},
      paint:function(M){
        ocE(M,17,18,13,6,'a');
        ocE(M,27,16,5,4,'a');
        ocE(M,31,13,4.5,4,'a');
        ocP(M,[[6,18],[1,13],[2,23]],'b');
        ocE(M,24,23,4,2,'b');
        ocE(M,14,15,1.3,1,'b'); ocE(M,20,20,1.3,1,'b'); ocE(M,11,19,1.3,1,'b');
        ocSet(M,13,32,null);
      },
      fixed:[[16,15,'ball'],[18,24,'bomb']] },
    72: { seed:20261172, tier:'B', frame:'partial', gap:[8,11], pal:{a:'#3fa7c4',b:'#7fd4e8',w:'#eafcff'},
      paint:function(M){
        ocE(M,18,16,14,4.5,'a');
        ocE(M,18,18,12,2,'w');
        ocP(M,[[12,13],[20,4],[26,13]],'b');
        ocP(M,[[12,19],[20,28],[26,19]],'b');
        ocP(M,[[31,16],[38,11],[38,21]],'a');
        ocSet(M,15,9,null);
      },
      fixed:[[16,18,'ball'],[10,20,'beam']] },
    73: { seed:20261173, tier:'B', frame:'partial', gap:[24,27], pal:{a:'#3f7fbf',b:'#2c5d99',c:'#ffe066'},
      paint:function(M){
        var px=0, py=0;
        for (var i=0;i<=44;i++){
          var t=i/44, cx=5+t*29, cy=17+Math.sin(t*Math.PI*1.7)*6.5;
          ocE(M,cx,cy,3.1,3.1,'a');
          if (i%5===2) ocE(M,cx,cy-3.4,0.9,0.9,'c');
          if (i%4===1) ocDot(M,Math.round(cy)+2,Math.round(cx),'b');
          px=cx; py=cy;
        }
        ocE(M,px+1,py,3.6,2.8,'a');
        ocDot(M,Math.round(py),Math.round(px)+2,'c');
      },
      fixed:[[17,19,'ball'],[11,12,'bomb']] },
    74: { seed:20261174, tier:'B', frame:'partial', gap:[17,20], pal:{a:'#c7512f',b:'#9e3a20',d:'#571f0e'},
      paint:function(M){
        ocP(M,[[4,16],[9,11],[9,21]],'b');
        ocE(M,13,16,5,4.6,'a'); ocE(M,18,16,4.6,4.2,'a'); ocE(M,23,16,4.2,3.8,'a'); ocE(M,27,16,3.8,3.4,'a');
        ocCols(M,[15,20,25],'b');
        ocE(M,34,10,4.5,3.5,'b'); ocE(M,34,22,4.5,3.5,'b');
        ocS(M,14,29,11,32,1.3,'a'); ocS(M,21,29,22,32,1.3,'a');
        ocS(M,13,31,6,37,0.5,'d'); ocS(M,19,31,26,37,0.5,'d');
        ocS(M,20,12,25,9,0.8,'a'); ocS(M,20,27,25,30,0.8,'a');
      },
      fixed:[[16,18,'ball'],[16,27,'widen']] },
    75: { seed:20261175, tier:'B', frame:'partial', gap:[10,13], pal:{a:'#e8c832',d:'#2b2b26',w:'#f7ecc8'},
      paint:function(M){
        var px=0, py=0;
        for (var i=0;i<=46;i++){
          var t=i/46, cx=5+t*29, cy=16+Math.sin(t*Math.PI*2.1+0.6)*6;
          ocE(M,cx,cy,3,3, (Math.floor(t*9)%2===0) ? 'a' : 'd');
          px=cx; py=cy;
        }
        ocE(M,px+1,py,3.8,3,'a');
        ocSet(M,Math.round(py),Math.round(px)+2,null);
      },
      fixed:[[12,20,'ball'],[21,14,'bomb']] },
    76: { seed:20261176, tier:'B', frame:'partial', gap:[24,27], pal:{a:'#5a6e8c',b:'#43536b',w:'#dfe9f5',d:'#2c3644'},
      paint:function(M){
        ocE(M,18,15,16,9,'a');
        ocP(M,[[33,15],[39,9],[39,21]],'a');
        ocP(M,[[17,7],[21,3],[24,7]],'b');
        ocP(M,[[11,21],[14,27],[18,21]],'b');
        for (var r=9;r<=21;r+=3) for (var c=8;c<=28;c+=3) ocDot(M,r,c,'w');
        ocS(M,12,4,18,4,0.7,'d');
        ocSet(M,13,6,null);
      },
      fixed:[[15,18,'ball'],[12,24,'beam']] },
    77: { seed:20261177, tier:'B', frame:'partial', gap:[6,9], pal:{a:'#4a4a68',b:'#34344c',w:'#cfd4e6',d:'#23233a'},
      paint:function(M){
        ocP(M,[[2,15],[19,5],[38,15],[19,25]],'a');
        ocE(M,19,18,10,4,'w');
        ocE(M,5,12,2,1.5,'b'); ocE(M,5,18,2,1.5,'b');
        ocS(M,25,19,33,19,0.6,'d');
        [[11,12],[15,10],[23,10],[27,12],[13,19],[25,19],[19,14]].forEach(function(p){ ocDot(M,p[0],p[1],'w'); });
      },
      fixed:[[15,19,'ball'],[12,15,'bomb']] },
    78: { seed:20261178, tier:'B', frame:'partial', gap:[17,20], pal:{a:'#ff8c42',c:'#f06ab8',w:'#ffffff',b:'#d96a24'},
      paint:function(M){
        ocE(M,19,27,12,3,'c');
        for (var cc=9; cc<=29; cc+=2) ocW(M,cc,16,26,1,cc,'c',1);
        ocE(M,19,11,8,4.5,'a');
        ocP(M,[[26,11],[31,8],[31,14]],'a');
        ocCols(M,[16,17],'w');
        ocE(M,19,6,4,1.6,'b');
        ocSet(M,11,13,null);
      },
      fixed:[[11,19,'ball'],[21,19,'ball']] },
    79: { seed:20261179, tier:'B', frame:'partial', gap:[28,31], pal:{a:'#d94f30',b:'#a83a22',c:'#ff8a5c',d:'#401512'},
      paint:function(M){
        ocS(M,28,8,16,6,1,'c'); ocS(M,16,6,12,3,0.8,'c'); ocS(M,16,6,11,10,0.8,'c');
        ocS(M,28,31,15,33,1,'c'); ocS(M,15,33,10,30,0.8,'c'); ocS(M,15,33,11,36,0.8,'c');
        ocS(M,28,19,18,19,0.9,'c');
        ocE(M,19,20,11,5.5,'a');
        ocE(M,7,14,3.5,3.5,'b'); ocE(M,31,14,3.5,3.5,'b');
        ocS(M,24,10,16,8,0.9,'a'); ocS(M,24,28,16,30,0.9,'a');
        ocE(M,16,15,1.1,1.1,'d'); ocE(M,22,15,1.1,1.1,'d');
      },
      fixed:[[20,19,'ball'],[18,13,'bomb']] },
    80: { seed:20261180, tier:'F', frame:'fort', gapsList:[[7,10],[23,26]], pal:{a:'#607d94',b:'#47606f',w:'#eef3f6',d:'#33424e'},
      paint:function(M){
        ocE(M,18,14,16,9,'a');
        ocE(M,18,18,13,4,'w');
        ocP(M,[[33,14],[39,8],[39,20]],'a');
        ocP(M,[[16,6],[21,1],[24,6]],'b');
        ocP(M,[[11,21],[14,27],[18,21]],'b');
        ocR(M,19,20,3,5,'w');
        ocSet(M,12,6,null);
      },
      carve:[[10,14,4,3],[25,16,5,3.5]],
      cores:[[14,10],[16,25]],
      frameSteels:(function(){ var s=[]; for (var r=5;r<=22;r++) s.push([r,17]); for (var c=6;c<=11;c++){ if (c<7||c>10) s.push([32,c]); } for (var c=22;c<=27;c++){ if (c<23||c>26) s.push([32,c]); } return s; })(),
      fixed:[[9,22,'ball'],[20,14,'bomb']] },
    81: { seed:20261181, tier:'C', frame:'full', gap:[17,19], pal:{a:'#7a6a58',b:'#5d5041'},
      paint:function(M){
        ocP(M,[[6,22],[10,12],[24,9],[33,13],[34,20],[28,25],[12,26]],'a');
        ocE(M,33,10,4,3.6,'a'); ocE(M,36,11,2,1.6,'b');
        ocS(M,22,26,29,30,1.6,'b');
        ocP(M,[[6,22],[1,27],[8,28]],'b');
        ocE(M,16,15,1.4,1,'b'); ocE(M,22,18,1.4,1,'b');
        ocSet(M,10,34,null);
      },
      fixed:[[16,20,'ball'],[13,26,'bomb']] },
    82: { seed:20261182, tier:'C', frame:'full', gap:[8,10], pal:{a:'#3d6fb8',b:'#2c528c',w:'#dcebfb'},
      paint:function(M){
        ocE(M,15,16,12,5,'a');
        ocE(M,15,18,10,2.5,'w');
        ocR(M,15,16,27,38,'b');
        ocP(M,[[12,12],[16,4],[20,12]],'b');
        ocP(M,[[5,16],[1,9],[1,23]],'a');
        ocP(M,[[10,20],[13,26],[16,20]],'b');
        ocSet(M,15,8,null);
      },
      fixed:[[16,15,'ball'],[12,18,'beam']] },
    83: { seed:20261183, tier:'C', frame:'full', gap:[24,26], pal:{a:'#c45a7d',b:'#a03d63'},
      paint:function(M){
        ocP(M,[[19,2],[26,8],[25,16],[13,16],[12,8]],'a');
        ocE(M,19,17,6,3.5,'a');
        for (var cc=11; cc<=27; cc+=2.3) ocW(M,Math.round(cc),20,32,1.2,cc,'a',0.95);
        ocP(M,[[13,8],[7,12],[13,14]],'b'); ocP(M,[[25,8],[31,12],[25,14]],'b');
        ocE(M,15,17,1.3,1.3,null); ocE(M,23,17,1.3,1.3,null);
        ocCols(M,[19],'b');
      },
      fixed:[[12,19,'ball'],[24,24,'ball']] },
    84: { seed:20261184, tier:'C', frame:'full', gap:[17,19], pal:{a:'#4a3560',b:'#6a4a8a',d:'#2e2438'},
      paint:function(M){
        for (var k2=0;k2<16;k2++){
          var ang=k2*Math.PI/8;
          ocS(M, 17+Math.sin(ang)*5, 19+Math.cos(ang)*5, 17+Math.sin(ang)*12.5, 19+Math.cos(ang)*12.5, 0.55,'d');
        }
        ocE(M,19,17,8,8,'d');
        ocE(M,19,17,5,5,'a');
        ocE(M,19,17,2.4,2.4,'b');
      },
      fixed:[[17,19,'ball'],[10,26,'bomb']] },
    85: { seed:20261185, tier:'C', frame:'full', gap:[10,12], pal:{d:'#1f3350',b:'#3f6fb8',c:'#ffd94a',a:'#2c4a70'},
      paint:function(M){
        ocE(M,18,17,12,7,'d');
        ocP(M,[[7,17],[2,12],[2,22]],'d');
        ocP(M,[[14,11],[18,6],[21,11]],'b');
        ocS(M,11,24,6,28,0.6,'b');
        ocE(M,29,5,2.2,2.2,'c');
        for (var cc=10; cc<=26; cc+=3) ocDot(M,22,cc,'c');
        ocDot(M,15,24,'c'); ocDot(M,19,12,'b'); ocDot(M,13,20,'b');
      },
      fixed:[[17,16,'ball'],[20,22,'beam']] },
    86: { seed:20261186, tier:'C', frame:'full', gap:[24,26], pal:{a:'#5aa85e',b:'#8fd07a',c:'#3f7f4d'},
      paint:function(M){
        var px=0, py=0;
        for (var i=0;i<=46;i++){
          var t=i/46, cx=5+t*28, cy=17+Math.sin(t*Math.PI*1.8+0.4)*6;
          ocE(M,cx,cy,2.7,2.7,'a');
          if (i%4===2){ ocE(M,cx+1.5,cy-3,1.7,1.7,'b'); ocE(M,cx-1.5,cy+3,1.7,1.7,'b'); }
          px=cx; py=cy;
        }
        ocE(M,px+1,py,3.6,3,'a');
        ocR(M,Math.round(py)-1,Math.round(py),Math.round(px)+3,Math.round(px)+5,'a');
        ocE(M,8,26,3.6,3.6,'c'); ocE(M,8,26,1.8,1.8,null);
      },
      fixed:[[14,18,'ball'],[20,12,'widen']] },
    87: { seed:20261187, tier:'C', frame:'full', gap:[17,19], pal:{d:'#23272e',w:'#f2f5f7',b:'#3a4048',a:'#2c3138'},
      paint:function(M){
        ocE(M,18,15,15,7.5,'d');
        ocE(M,18,18,12,4,'w');
        ocE(M,27,12,2.5,1.4,'w');
        ocP(M,[[17,9],[21,3],[24,9]],'d');
        ocP(M,[[32,15],[38,10],[38,20]],'d');
        ocP(M,[[12,20],[15,26],[18,20]],'d');
        ocSet(M,13,26,null);
      },
      fixed:[[15,16,'ball'],[11,22,'bomb']] },
    88: { seed:20261188, tier:'C', frame:'full', gap:[8,10], pal:{a:'#b85a78',b:'#96455f'},
      paint:function(M){
        ocE(M,19,16,14,6,'a');
        ocR(M,22,23,8,31,'b');
        for (var r=13;r<=19;r+=3) for (var c=10;c<=28;c+=3) ocDot(M,r,c,'b');
        ocCols(M,[7,32],'b');
        ocRows(M,[12,20],'b');
      },
      fixed:[[16,19,'ball'],[15,13,'beam']] },
    89: { seed:20261189, tier:'C', frame:'full', gap:[24,26], pal:{a:'#6a5a8c',b:'#4f4270',w:'#e3dcf2',d:'#38304e'},
      paint:function(M){
        ocP(M,[[1,15],[19,6],[39,15],[19,24]],'a');
        ocE(M,19,16,10,3,'w');
        ocE(M,4,13,1.8,1.8,'b'); ocE(M,4,17,1.8,1.8,'b');
        ocS(M,24,19,32,19,0.6,'d');
        [[11,12],[16,10],[22,10],[27,12],[13,18],[25,18],[19,20]].forEach(function(p){ ocDot(M,p[0],p[1],'w'); });
      },
      fixed:[[15,19,'ball'],[11,15,'bomb']] },
    90: { seed:20261190, tier:'F', frame:'fort', gapsList:[[6,9],[17,20],[28,31]], pal:{a:'#7a4fd0',b:'#5a34a8',c:'#b48af2'},
      paint:function(M){
        ocE(M,19,12,14,10,'a');
        ocE(M,14,8,1.8,1.3,'c'); ocE(M,24,9,1.8,1.3,'c');
        [8,12,16,20,24,28].forEach(function(cc,ix){ ocW(M,cc,20,30,1.3,ix*1.1,'a',1.2); ocE(M,cc,31,1.2,1,'b'); });
        ocSet(M,14,14,null); ocSet(M,14,24,null);
      },
      carve:[[19,13,8,5]],
      cores:[[11,14],[11,24]],
      frameSteels:(function(){ var s=[]; [10,16,22,27].forEach(function(cc){ for (var r=30;r<=32;r++) s.push([r,cc]); }); return s; })(),
      fixed:[[7,19,'ball'],[26,19,'bomb']] },
    91: { seed:20261191, tier:'D', frame:'maze', gap:[17,19], pal:{a:'#44586e',b:'#2f4152',w:'#dfe7ee',d:'#1e2a36'},
      paint:function(M){
        ocE(M,18,14,16,8,'a');
        ocE(M,18,18,13,4,'w');
        ocP(M,[[33,14],[39,6],[39,22]],'a');
        ocP(M,[[15,7],[20,1],[24,7]],'b');
        ocP(M,[[25,6],[29,3],[30,7]],'b');
        ocR(M,20,21,3,6,'w');
        ocS(M,11,12,13,16,0.5,'w');
        ocSet(M,12,8,null);
      },
      fixed:[[14,20,'ball'],[10,28,'bomb']] },
    92: { seed:20261192, tier:'D', frame:'maze', gap:[8,10], pal:{a:'#a86ae0',b:'#7d3fc4',c:'#e8ccff'},
      paint:function(M){
        ocE(M,19,11,16,10,'a');
        for (var r=12;r<=21;r++) for (var c=3;c<=35;c++) if (Math.abs(c-19) > 16-Math.abs(r-11)) ocSet(M,r,c,null);
        for (var r2=12;r2<=20;r2++) for (var c2=4;c2<=34;c2++){ var dd=(r2-11)/10, ee=(c2-19)/16; if (dd*dd+ee*ee>1) ocSet(M,r2,c2,null); }
        ocE(M,19,12,11,3,'b'); ocE(M,19,12,6,2,'a');
        for (var r3=13;r3<=14;r3++) for (var c3=4;c3<=34;c3++) ocSet(M,r3,c3,null);
        [7,11,15,19,23,27,31].forEach(function(cc,ix){ ocW(M,cc,14,31,1.8,ix*1.2,'b',1.2); });
        [13,19,25].forEach(function(cc,ix){ ocW(M,cc,14,26,2.4,ix,'a',1.7); });
        ocE(M,15,9,2.2,1.6,'c'); ocE(M,24,8,2.2,1.6,'c');
      },
      fixed:[[9,19,'ball'],[22,16,'ball']] },
    93: { seed:20261193, tier:'D', frame:'maze', gap:[24,26], pal:{a:'#5d7052',b:'#42523a',c:'#ffe066',w:'#f5f2e4'},
      paint:function(M){
        ocE(M,16,15,13,10,'a');
        ocE(M,16,22,9,3,'b');
        ocE(M,8,18,7,5,null);
        ocR(M,12,13,4,10,'w'); ocR(M,22,23,4,9,'w');
        ocP(M,[[26,10],[36,14],[36,18],[26,20]],'a');
        ocP(M,[[35,14],[39,10],[39,20]],'b');
        ocS(M,6,10,3,14,0.5,'b');
        ocE(M,15,3,1.8,1.8,'c');
        ocSet(M,15,11,null);
      },
      fixed:[[16,20,'ball'],[9,24,'beam']] },
    94: { seed:20261194, tier:'D', frame:'maze', gap:[17,19], pal:{a:'#3fae8a',b:'#2c8567',c:'#ff8a5c'},
      paint:function(M){
        var px=0, py=0;
        for (var i=0;i<=42;i++){
          var t=i/42, cx=6+t*22, cy=20-Math.sin(t*Math.PI*1.15)*9+t*2;
          ocE(M,cx,cy,3.1,3.1,'a');
          if (i%5===3) ocE(M,cx,cy-3.4,1.5,1.5,'c');
          px=cx; py=cy;
        }
        ocE(M,31,9,5,4,'a');
        ocS(M,6,30,3,34,0.6,'c'); ocS(M,3,34,1,36,0.5,'c'); ocS(M,6,28,4,24,0.6,'c');
        ocP(M,[[27,12],[31,17],[34,11]],'c');
        ocS(M,16,10,13,7,1,'b'); ocS(M,17,24,14,28,1,'b');
        ocSet(M,9,33,null);
      },
      fixed:[[15,17,'ball'],[20,24,'bomb']] },
    95: { seed:20261195, tier:'D', frame:'maze', gap:[8,10], pal:{w:'#e9e4f5',b:'#b8a8dd',d:'#4a4260',a:'#d9d0ee'},
      paint:function(M){
        ocE(M,19,14,11,9,'w');
        ocE(M,7,10,3.5,4.5,'w'); ocE(M,31,10,3.5,4.5,'w');
        ocP(M,[[10,20],[28,20],[24,29],[14,29]],'w');
        ocE(M,15,15,1.2,1.2,'d'); ocE(M,23,15,1.2,1.2,'d');
        ocDot(M,18,13,'b'); ocDot(M,18,25,'b'); ocDot(M,11,19,'b');
        ocRows(M,[21],'a');
      },
      fixed:[[13,19,'ball'],[24,19,'ball']] },
    96: { seed:20261196, tier:'D', frame:'maze', gap:[24,26], pal:{a:'#a83232',b:'#7d2424',c:'#d9a441',d:'#380f0f'},
      paint:function(M){
        ocE(M,19,17,15,8,'a');
        ocR(M,7,8,9,29,'c');
        ocE(M,4,11,4.5,4,'b'); ocE(M,34,11,4.5,4,'b');
        ocS(M,14,7,11,5,1.2,'a'); ocS(M,14,31,11,33,1.2,'a');
        ocS(M,21,6,27,2,1.1,'a'); ocS(M,21,32,27,36,1.1,'a');
        ocS(M,23,9,29,5,1.1,'a'); ocS(M,23,29,29,33,1.1,'a');
        ocS(M,24,13,30,9,1.1,'a'); ocS(M,24,25,30,29,1.1,'a');
        ocE(M,16,12,1.2,1.2,'d'); ocE(M,22,12,1.2,1.2,'d');
        ocCols(M,[19],'b');
      },
      fixed:[[17,19,'ball'],[14,14,'bomb']] },
    97: { seed:20261197, tier:'D', frame:'maze', gap:[17,19], pal:{a:'#2e6e4e',b:'#57a773',d:'#1f4d36'},
      paint:function(M){
        ocE(M,18,16,14,10,'a');
        ocE(M,18,16,11,7.5,'d'); ocE(M,18,16,7,5,'a'); ocE(M,18,16,3,2.4,'b');
        ocS(M,16,29,16,34,2,'b');
        ocE(M,36,16,2.8,3,'b');
        ocE(M,7,7,4,2.5,'b'); ocE(M,29,7,4,2.5,'b'); ocE(M,7,25,4,2.5,'b'); ocE(M,29,25,4,2.5,'b');
        ocSet(M,16,37,null);
      },
      fixed:[[16,18,'ball'],[10,11,'beam']] },
    98: { seed:20261198, tier:'D', frame:'maze', gap:[10,12], pal:{a:'#f2a03d',b:'#4fb8d9',c:'#e86a8a',w:'#e8e2d2'},
      paint:function(M){
        ocR(M,30,31,5,34,'w');
        [8,14,20,26].forEach(function(cc){ ocS(M,30,cc,24,cc,0.9,'w'); });
        ocE(M,35,28,4.5,3.4,'w');
        var fish=[[7,8,'a'],[16,6,'b'],[25,9,'c'],[32,7,'a'],[11,14,'c'],[21,15,'a'],[30,16,'b'],[6,20,'b'],[15,22,'a'],[26,23,'c'],[34,20,'a'],[19,11,'b']];
        fish.forEach(function(f){
          ocE(M,f[1],f[0],2.8,1.5,f[2]);
          ocP(M,[[f[1]+2,f[0]],[f[1]+4.4,f[0]-1.6],[f[1]+4.4,f[0]+1.6]],f[2]);
        });
        ocE(M,12,28,5,3,'c'); ocE(M,31,29,5,3,'c');
      },
      fixed:[[12,18,'ball'],[18,26,'widen']] },
    99: { seed:20261199, tier:'D', frame:'maze', gap:[24,26], pal:{a:'#3a5a8c',b:'#2c4468',c:'#ffc93c',w:'#dce9f8'},
      paint:function(M){
        ocE(M,18,16,16,11,'a');
        ocE(M,18,21,13,5,'w');
        ocP(M,[[33,16],[39,10],[39,22]],'a');
        ocP(M,[[12,24],[16,30],[20,24]],'b');
        ocRows(M,[8],'c');
        ocS(M,7,16,3,13,0.6,'c'); ocS(M,7,19,2,19,0.6,'c'); ocS(M,7,16,3,19,0.6,'c');
        ocDot(M,10,14,'c'); ocDot(M,12,24,'c');
        ocSet(M,14,8,null);
      },
      fixed:[[16,18,'ball'],[12,28,'bomb']] },
    100: { seed:20261200, tier:'F', frame:'fort', gapsList:[[5,8],[17,20],[29,32]], pal:{a:'#3f8fae',b:'#2f6d88',c:'#ff8a5c'},
      paint:function(M){
        ocR(M,3,20,3,36,'a');
        ocRows(M,[8,14],'b');
        ocS(M,6,8,3,5,1,'c'); ocS(M,3,5,1,3,0.7,'c'); ocS(M,6,20,3,17,1,'c'); ocS(M,6,31,3,34,1,'c'); ocS(M,3,34,1,36,0.7,'c');
        ocS(M,17,10,13,7,1,'c'); ocS(M,18,27,14,30,1,'c');
        ocE(M,10,10,2.6,2.6,null); ocE(M,24,11,2.6,2.6,null); ocE(M,17,25,2.6,2.6,null); ocE(M,30,24,2.2,2.2,null);
        ocE(M,6,30,2,2,'c'); ocE(M,12,33,2,2,'c');
      },
      cores:[[6,7],[6,19],[6,32]],
      frameSteels:(function(){ var s=[]; for (var r=3;r<=32;r++){ s.push([r,13]); s.push([r,26]); } for (var c=3;c<=36;c++){ var inGap=(c>=4&&c<=9)||(c>=16&&c<=21)||(c>=28&&c<=33); if (!inGap && c!==13 && c!==26) s.push([32,c]); } return s; })(),
      fixed:[[17,7,'ball'],[17,19,'ball'],[17,32,'ball'],[11,19,'bomb']] }
  };

  /* ---- 每日关卡：UTC 日期字符串做确定性种子，种子决定图案模板、入口位置与形状、特殊砖侧重点 ----
     同一天打开布局完全相同，过了 UTC 零点换新关。砖量控制在 200-800 块之间；
     底部钢条必有缺口，缺口正上方有砖、墙心有定点连锁区（球砖/炸弹/光束），
     保证入口存在、坐标不重叠、至少一条送球入墙并触发连锁的路径。 */
  var DAILY_PALS = [
    [[255,183,47],[255,148,26],[232,94,28]],     // 暖橙
    [[64,199,216],[52,140,224],[96,92,232]],     // 蓝青
    [[242,120,190],[178,110,232],[96,110,238]],  // 粉紫
    [[140,210,90],[70,170,80],[44,140,95]],      // 绿野
    [[242,216,130],[222,172,80],[196,124,58]],   // 金沙
    [[255,130,66],[242,84,44],[204,48,40]]       // 红焰
  ];
  var DAILY_TPL_NAMES = ['波浪墙','菱形环','十字城','棋盘格','旋涡带','阶梯带','双子岛','回纹环'];
  function buildDaily(dateStr){
    stdGrid();
    grid = blankGrid();
    var bricks = [], steels = [];
    var rnd = seeded(hashStr('jy-daily-' + dateStr));
    var tpl = Math.floor(rnd()*8);
    var gapStyle = Math.floor(rnd()*5);
    var focus = Math.floor(rnd()*4);
    var pal = DAILY_PALS[Math.floor(rnd()*DAILY_PALS.length)];
    var v1 = rnd()*6.28;
    var speed = 348 + Math.floor(rnd()*84);
    var gapSets = [
      [14,15],          // 中央 2 格
      [4,5,6],          // 左侧 3 格
      [23,24,25],       // 右侧 3 格
      [6,7,23,24],      // 左右双门
      [13,14,15,16]     // 中央 4 格
    ];
    var gapCols = gapSets[gapStyle];
    var gapMap = {};
    gapCols.forEach(function(c){ gapMap[c] = true; });
    var sc;
    for (sc=2; sc<=27; sc++){ if (!gapMap[sc]) putSteel(steels, 25, sc); }
    function bandIdx(r,c){
      switch(tpl){
        case 0: return Math.floor((r + 2.2*Math.sin(c*0.55 + v1)) / 3);
        case 1: return Math.floor((Math.abs(r-11.5) + Math.abs(c-14.5)) / 4);
        case 2: return Math.floor(r/6) + Math.floor(c/6);
        case 3: return Math.floor(r/3) + Math.floor(c/3);
        case 4: { var dr = r-11.5, dc = c-14.5; var ang = Math.atan2(dr,dc); if (ang<0) ang += Math.PI*2;
                  return Math.floor(ang/(Math.PI*2)*6 + Math.sqrt(dr*dr+dc*dc)*0.4); }
        case 5: return Math.floor((r + c) / 4);
        case 6: return Math.floor((r + (c<14 ? c : 29-c)) / 4);
        default: return Math.min(r, 23-r, c-2, 27-c);
      }
    }
    function tplFill(r,c){
      switch(tpl){
        case 0: return ((r + Math.round(2*Math.sin(c*0.5 + v1))) % 6) !== 5;                    // 波浪墙：横向波纹孔
        case 1: { var d = Math.abs(r-11.5) + Math.abs(c-14.5); return d <= 22 && (Math.floor(d) % 3) !== 2; }  // 菱形环
        case 2: return (c>=13 && c<=16) || (r>=10 && r<=13) || r<=1 || r>=22 || c<=3 || c>=26;   // 十字 + 边框
        case 3: return ((Math.floor(r/3) + Math.floor(c/3)) % 2) === 0;                          // 棋盘格块
        case 4: { var dr = r-11.5, dc = c-14.5; var ang = Math.atan2(dr,dc); if (ang<0) ang += Math.PI*2;
                  var rad = Math.sqrt(dr*dr+dc*dc);
                  return rad <= 12.5 && (Math.floor(ang/(Math.PI*2)*6 + rad*0.45) % 2) === 0; } // 旋涡带
        case 5: return (Math.floor((r + c) / 4) % 2) === 0;                                      // 阶梯带
        case 6: { if (c>=13 && c<=16) return false;                                              // 双子岛：中间空带
                  var d1 = (r-6)*(r-6) + (c-7)*(c-7), d2 = (r-17)*(r-17) + (c-22)*(c-22);
                  return d1 > 10 && d2 > 10; }
        default: { var rd = Math.min(r, 23-r, c-2, 27-c); return (rd % 3) !== 2; }              // 回纹环
      }
    }
    var mask = {};
    var r, c;
    for (r=0;r<=23;r++) for (c=2;c<=27;c++) if (tplFill(r,c)) mask[key(r,c)] = true;
    // 入口正上方三行必须有砖：球穿过缺口立刻打到墙，从入口就能点起连锁
    gapCols.forEach(function(gc){
      mask[key(21,gc)] = true; mask[key(22,gc)] = true; mask[key(23,gc)] = true;
    });
    // 墙心连锁区：3×3 保证有砖，中心和四邻在下面定点放特殊砖
    for (r=10;r<=12;r++) for (c=13;c<=15;c++) mask[key(r,c)] = true;
    var cells = [];
    for (r=0;r<=23;r++) for (c=2;c<=27;c++) if (mask[key(r,c)]) cells.push([r,c]);
    // 砖量兜底（需求范围 200-800）：过多随机抽稀，过少从墙心向外补
    if (cells.length > 780){
      for (var i=cells.length-1;i>0;i--){ var j = Math.floor(rnd()*(i+1)); var tmp = cells[i]; cells[i]=cells[j]; cells[j]=tmp; }
      cells.length = 720;
      mask = {};
      cells.forEach(function(rc){ mask[key(rc[0],rc[1])] = true; });
      gapCols.forEach(function(gc){ [21,22,23].forEach(function(rr){ if (!mask[key(rr,gc)]){ mask[key(rr,gc)] = true; cells.push([rr,gc]); } }); });
      for (r=10;r<=12;r++) for (c=13;c<=15;c++) if (!mask[key(r,c)]){ mask[key(r,c)] = true; cells.push([r,c]); }
    }
    if (cells.length < 210){
      var cand = [];
      for (r=0;r<=23;r++) for (c=2;c<=27;c++) if (!mask[key(r,c)]) cand.push([r,c]);
      cand.sort(function(a,b){
        var da = (a[0]-11.5)*(a[0]-11.5) + (a[1]-14.5)*(a[1]-14.5);
        var db = (b[0]-11.5)*(b[0]-11.5) + (b[1]-14.5)*(b[1]-14.5);
        return da - db;
      });
      for (var ci=0; ci<cand.length && cells.length < 210; ci++){ mask[key(cand[ci][0],cand[ci][1])] = true; cells.push(cand[ci]); }
    }
    // 特殊砖：侧重点决定散布概率表；连锁区和入口定点放特殊砖，不靠概率
    var tables = [
      [[0.12,'ball'],[0.145,'bomb'],[0.16,'beam'],[0.17,'widen'],[0.20,'armor',2]],   // 球砖连锁
      [[0.13,'bomb'],[0.16,'ball'],[0.175,'beam'],[0.185,'widen'],[0.215,'armor',2]], // 炸弹连环
      [[0.12,'beam'],[0.15,'ball'],[0.175,'bomb'],[0.185,'widen'],[0.215,'armor',2]], // 光束切割
      [[0.10,'armor',2],[0.13,'ball'],[0.155,'bomb'],[0.17,'beam'],[0.18,'widen']]     // 装甲混搭
    ];
    var focusNames = ['球砖连锁','炸弹连环','光束切割','装甲混搭'];
    var fixedType = {};
    fixedType[key(11,14)] = 'bomb';
    fixedType[key(11,13)] = 'ball'; fixedType[key(11,15)] = 'ball';
    fixedType[key(10,14)] = 'beam'; fixedType[key(12,14)] = 'ball';
    var gcMid = gapCols[Math.floor(gapCols.length/2)];
    fixedType[key(23,gcMid)] = 'ball';   // 入口正上方第一块就是球砖，进墙立刻放球连锁
    if (mask[key(20,gcMid)]) fixedType[key(20,gcMid)] = 'ball';
    cells.forEach(function(rc){
      var rr = rc[0], cc = rc[1];
      var ft = fixedType[key(rr,cc)];
      var d = ft ? { type: ft, hp: 1 } : rollType(rnd, tables[focus]);
      var nb = putBrick(bricks, rr, cc, d.type, d.hp);
      if (nb.type === 'normal'){
        var bi = bandIdx(rr,cc);
        nb.color = grad(pal, clamp(((Math.abs(bi)%5)/4)*0.8 + (rr/23)*0.2, 0, 1));
      }
    });
    var gapNames = ['中央 2 格','左侧 3 格','右侧 3 格','左右双门','中央 4 格'];
    return {
      bricks: bricks, steels: steels, total: bricks.length, speed: speed,
      desc: '今天的图案是「' + DAILY_TPL_NAMES[tpl] + '」，入口在' + gapNames[gapStyle] + '，' + focusNames[focus] + '是这一关的主角。布局按当天 UTC 日期生成：同一天打开都一样，过了 UTC 零点就会换成新的一关。'
    };
  }
  var DAILY_DEF = { name:'每日关卡', speed:380, paddle:76, serves:0, types:['normal','ball','bomb','beam','widen','armor','steel'] };

  /* ================= 关卡表 ================= */
  var T_ALL = ['normal','ball','bomb','beam','widen','steel'];
  var LEVELS = [
    { name:'裂缝入门', speed:330, paddle:76, serves:0, types:T_ALL, build:buildL1,
      desc:'砖墙由密密麻麻的小方格组成，悬在场地中上部。墙下方一排深灰钢块横条封住去路，正中留了一道缺口——把球从缺口送进墙里，砖就会从里面开始崩。' },
    { name:'双缺口', speed:336, paddle:76, serves:0, types:T_ALL, build:buildL2,
      desc:'砖墙裂成左右两座分开的砖岛：左岛琥珀色，右岛珊瑚色，中间隔着一条空带。钢条上两个缺口各对着一座岛，用挡板边缘把球以大角度斜送进去，练的就是边缘击球。' },
    { name:'球砖初现', speed:342, paddle:76, serves:0, types:T_ALL, build:buildL3,
      desc:'砖块排成一圈圈同心菱形环，球砖沿着环的内侧分布，打碎一颗就多放出两颗球。先稳稳送一颗进环心，剩下的交给连锁。' },
    { name:'炸弹链', speed:348, paddle:76, serves:0, types:['normal','ball','bomb','widen','steel'], build:buildL4,
      desc:'墙身是深红与暗橙交错的格子，中间横着一整排红点炸弹，一颗引爆就会顺着排下去连环炸开。找到链子的一头，把它点着。' },
    { name:'光束十字', speed:354, paddle:76, serves:0, types:['normal','ball','bomb','beam','steel'], build:buildL5,
      desc:'整面墙排成一个蓝青色的大十字，光束砖沿十字主干分布。光束会清掉整行整列，但钢块会把光束挡下来，先想清楚十字从哪里交叉最划算。' },
    { name:'装甲墙', speed:360, paddle:76, serves:0, types:['normal','ball','bomb','beam','armor','steel'], build:buildL6,
      desc:'紫、绿、蓝、粉、黄斜向交错成一张彩色线网，灰色装甲砖嵌在网格节点上，要打 2 到 4 下才碎，裂纹越深离碎越近。炸弹和光束一下顶 3 下，优先往装甲上招呼。' },
    { name:'加宽', speed:366, paddle:52, serves:0, types:['normal','ball','bomb','widen','steel'], build:buildL7,
      desc:'橙、黄、红斜带交错成闪电条纹，加宽砖沿着斜带分布。这一关挡板出厂就窄，打碎一颗加宽砖挡板就宽两格，本关内一直有效——先攒宽度，再慢慢清墙。' },
    { name:'隧道迷宫', speed:372, paddle:76, serves:0, types:['normal','ball','bomb','beam','steel'], build:buildL8,
      desc:'暗紫灰的砖块沿钢墙迷宫的通道排布。钢块在墙里搭出三层迷宫，底部入口只有一个格子宽。瞄准要稳，球进了通道就会自己找到路。' },
    { name:'连锁风暴', speed:384, paddle:76, serves:0, types:['normal','ball','bomb','beam','armor','widen','steel'], build:buildL9,
      desc:'五彩砖块像风暴一样旋向墙心，球砖、炸弹、光束、装甲全混在旋臂上。一次连锁可能带走半面墙，多球同屏是常态。' },
    { name:'要塞', speed:378, paddle:76, serves:5, cores:2, types:['normal','ball','bomb','beam','steel','core'], build:buildL10,
      desc:'要塞是一间钢框围成的主腔室，底部中央开着一个宽漏斗入口：挡板正中竖直发球就能直接进去，不用对准任何错位门。入口内侧有钢唇收口，球进去后下落大多砸在钢地板上弹回腔室，会在里面连着打砖、连锁。腔室里铺满蓝青冷色砖，两个金色核心就嵌在上部砖墙里，看得见、够得着，全部打碎才获胜。发球只有 5 次，用完要塞会重建，已通关的关卡不会丢。' },
    { name:'左岸潮汐', speed:386, paddle:76, serves:0, types:T_ALL, build:buildL11,
      desc:'蓝青色的砖排成一层层横向波浪，像潮水一样起伏。钢墙的缺口开在最左边，球砖特别多，从左岸把球送进去，让多球连锁替你清完整面墙。' },
    { name:'右岸星棋', speed:390, paddle:76, serves:0, types:['normal','armor','ball','bomb','beam','steel'], build:buildL12,
      desc:'靛蓝与金色交错成一整面棋盘，灰色装甲砖星星点点嵌在棋格里，要多打几下才碎。缺口开在钢墙右侧，先从右岸撕开一个口子。' },
    { name:'双塔夹缝', speed:394, paddle:76, serves:0, types:T_ALL, build:buildL13,
      desc:'左右两座竖塔隔空相对：左塔紫，右塔青，中间只留一条两格宽的窄烟囱，烟囱两侧是高钢墙。光束砖沿塔身分布，一束下去能清掉整列。' },
    { name:'彩虹拱门', speed:398, paddle:76, serves:0, types:T_ALL, build:buildL14,
      desc:'红、橙、黄、绿、蓝、紫排成两道彩虹拱带，悬在墙的上方。入口是右边的漏斗，上窄下宽、底部五格宽，从漏斗把球送上去，炸弹会顺着拱带连环开花。' },
    { name:'左岸阶梯', speed:402, paddle:76, serves:0, types:T_ALL, build:buildL15,
      desc:'绿色与粉色沿斜向排成一级级阶梯带。入口在左侧，钢块逐层错开像台阶一样向下收，球要顺着台阶爬进墙里。加宽砖很多，先把挡板喂宽再清墙。' },
    { name:'双门蜂巢', speed:406, paddle:76, serves:0, types:T_ALL, build:buildL16,
      desc:'琥珀与棕色的砖错行排成蜂巢，中间留着错落的小孔。钢墙左右各开一道两格宽的门，球砖和炸弹都多，从哪道门进都能点起连锁。' },
    { name:'雪山之巅', speed:410, paddle:76, serves:0, types:['normal','beam','armor','ball','bomb','steel'], build:buildL17,
      desc:'白色与浅蓝的砖堆成连绵的三角雪峰，峰顶雪白，往下渐渐变蓝。中央开着六格宽的缺口，光束和装甲是这一关的主角。' },
    { name:'火焰斜坡', speed:416, paddle:76, serves:0, types:T_ALL, build:buildL18,
      desc:'红橙色的砖排成一簇簇竖向的火焰舌，舌尖黄、根部深红。钢墙从右侧斜压下来，缺口在斜坡底部的左侧，炸弹和球砖会让火越烧越旺。' },
    { name:'绿野双层', speed:420, paddle:76, serves:0, types:['normal','armor','beam','ball','bomb','steel'], build:buildL19,
      desc:'绿色的砖绕成一圈圈回字形的环带，入口分两层：下层缺口在左，上层缺口在右，中间隔着一层钢带和一条通道。装甲和光束是这一关的主角。' },
    { name:'要塞·左岸双子', speed:412, paddle:76, serves:5, cores:2, types:['normal','ball','bomb','beam','steel','core'], build:buildL20,
      desc:'第二座要塞的入口开在左侧：宽漏斗从底部向左张开，进去后钢唇把出口收窄到三格，球会在蓝紫色的腔室里多弹几圈。两个金色核心分别嵌在腔内左上和右上的砖墙里，看得见、够得着，全部打碎才获胜。发球只有 5 次，用完要塞会重建，已通关的关卡不会丢。' },
    { name:'极光斜带', speed:424, paddle:76, serves:0, types:T_ALL, build:buildL21,
      desc:'青绿与紫色斜斜地交织成极光带，从墙的一角流向另一角。钢墙的缺口呈斜线错开，球要斜着钻进去。球砖和加宽砖是这一关的主角。' },
    { name:'沙漠金字塔', speed:428, paddle:76, serves:0, types:['normal','bomb','armor','ball','beam','steel'], build:buildL22,
      desc:'沙金色的砖堆成一群三角金字塔，高的矮的挨在一起。右侧立着一座高烟囱，井道又深又直，底部缺口就在烟囱脚下。炸弹和装甲是这一关的主角。' },
    { name:'海底珊瑚', speed:432, paddle:76, serves:0, types:T_ALL, build:buildL23,
      desc:'珊瑚粉与海蓝的砖像珊瑚一样分枝生长，主干和斜枝交错成一片海底丛林。入口是中央的三格台阶缺口，钢块左右各退一格。光束和球砖是这一关的主角。' },
    { name:'霓虹都市', speed:436, paddle:76, serves:0, types:T_ALL, build:buildL24,
      desc:'多彩的砖排成高低不一的竖向楼群，像夜里的霓虹天际线。入口是右侧的漏斗，上窄下宽、底部四格。加宽和炸弹是这一关的主角。' },
    { name:'森林年轮', speed:440, paddle:76, serves:0, types:['normal','armor','ball','bomb','beam','steel'], build:buildL25,
      desc:'绿色与棕色的砖绕成一圈圈同心圆，像老树的年轮。入口只有左侧两格宽，装甲砖嵌在年轮里，球砖也不少，耐心从外圈磨进去。' },
    { name:'冰晶雪花', speed:444, paddle:76, serves:0, types:T_ALL, build:buildL26,
      desc:'白色与冰蓝的砖从中心向外伸出六条手臂，拼成一朵放射状的雪花。入口是中央六格宽的缺口，两侧钢墙还各凸出一块。光束和加宽是这一关的主角。' },
    { name:'熔岩裂谷', speed:450, paddle:76, serves:0, types:T_ALL, build:buildL27,
      desc:'黑色的岩面上一道道红橙裂纹纵横交错，像地底的熔岩裂谷。钢墙从左侧斜压下来，缺口在斜坡底部的右侧。炸弹和光束会顺着裂纹把整面墙点亮。' },
    { name:'星云双层', speed:454, paddle:76, serves:0, types:['normal','ball','armor','bomb','beam','steel'], build:buildL28,
      desc:'紫、粉、蓝三色旋成三条大旋臂，缓缓卷向墙心。入口分两层错开：下层缺口在右，上层缺口在左。球砖和装甲是这一关的主角。' },
    { name:'时光沙漏', speed:458, paddle:76, serves:0, types:T_ALL, build:buildL29,
      desc:'金沙色的砖上下宽、中间收成细腰，拼成一只沙漏。入口是中央的窄烟囱，上宽下窄、底部只有两格。光束和炸弹是这一关的主角。' },
    { name:'最终要塞·星核', speed:430, paddle:76, serves:6, cores:3, types:['normal','ball','bomb','beam','steel','core'], build:buildL30,
      desc:'最终要塞比前两座都大：中央开着八格宽的超大漏斗，挡板正中竖直发球就能直接进去，进去后钢唇收口，球会在蓝紫与金色的大腔室里连着打砖。三个金色核心分别嵌在左上、中上、右上的砖墙里，全部打碎才算通关。发球上限 6 次，用完要塞会重建，已通关的关卡不会丢。' },
    { name:'绿野机器人', speed:462, paddle:76, serves:0, types:['normal','ball','bomb','beam','widen','steel'], build:buildL31,
      desc:'整面墙是绿色的，中央留着一个黑色的机器人图案：圆头、身体、两条触角和两臂都是中空的，四周用深灰钢块描边，身体里藏着 4 颗球砖。入口在底部钢条正中、只有两格宽，一条竖直通道直通机器人的身体——把球从通道送进去，就能在机器人肚子里放出多球连锁，墙面还混着少量炸弹和光束。' },
    { name:'紫色 M', speed:466, paddle:76, serves:0, types:['normal','armor','ball','bomb','steel'], build:buildL32,
      desc:'紫红色的墙中央留着一个黑色的 M 字母图案：两条竖腿加中间的 V 形都是中空的，四周用钢块描边，两腿底部各藏着一颗球砖。入口在底部中央，三格宽的通道直通 M 中部 V 形的底端。墙里混着不少灰色装甲砖，要多打几下才碎。' },
    { name:'回字迷宫', speed:470, paddle:76, serves:0, types:['normal','bomb','beam','ball','steel'], build:buildL33,
      desc:'深绿色的砖面被一圈钢框围住，钢框外留着一圈黑色的边框空道。入口不在墙底：先沿外圈空道绕到顶部，再从顶部中央两格宽的烟囱钻进框内，烟囱两侧是高钢壁。烟囱正下方就放着球砖，进去第一下就能放出连锁，墙面混着炸弹和光束。' },
    { name:'金色门洞', speed:474, paddle:76, serves:0, types:['normal','bomb','widen','ball','steel'], build:buildL34,
      desc:'金黄色的墙底部中央留着一个拱形门洞，门洞两侧和顶部用钢块做了内衬，门洞不封底、直接朝场地敞开，门洞本身就是入口：球从下方直接钻进门洞，在洞里反弹着打周围的黄砖。门洞两侧各藏着一颗球砖，墙里还混着少量炸弹和加宽砖。' },
    { name:'深绿 H', speed:478, paddle:76, serves:0, types:['normal','ball','beam','bomb','widen','steel'], build:buildL35,
      desc:'深绿色的墙中央留着一个黑色的 H 字母图案：两条竖腿加中间一道横杠都是中空的，四周用钢块描边，横杠两端各放着一颗加宽砖。入口是底部左右两条通道，各两格宽，分别直通 H 的两条腿，从哪边进都行。墙面混着球砖和光束。' },
    { name:'叶子', speed:472, paddle:76, serves:0, types:['normal','ball','bomb','beam','widen','steel'], build:buildL36,
      desc:'嫩绿的墙中央留着一片黑色的叶子：椭圆叶身、叶尖和叶柄都是中空的，四周钢块描边，叶身里藏着 3 颗球砖。入口在底部中央、四格宽，是这一段最宽的入口之一，先在这里熟悉从中空内部打砖的手感。装甲很少，放心连锁。' },
    { name:'星星', speed:476, paddle:76, serves:0, types:['normal','ball','bomb','beam','widen','steel'], build:buildL37,
      desc:'金黄的墙中央悬着一颗黑色的五角星，五个尖角都是中空的，星心里和两个下角各藏着一颗球砖。入口在底部偏左、三格宽，通道对着星星的下角。难度只比叶子高一点点，球砖依然很多。' },
    { name:'月亮', speed:480, paddle:76, serves:0, types:['normal','ball','bomb','beam','widen','armor','steel'], build:buildL38,
      desc:'月白色的墙中央弯着一弯黑色的月牙，月牙两端尖、中间鼓，内部中空，藏着球砖和一颗炸弹。入口在右下、四格宽，顺着月牙的下尖钻进去。墙里开始出现少量灰色装甲砖，要多打一下，但数量不多。' },
    { name:'房子', speed:484, paddle:76, serves:0, types:['normal','ball','bomb','beam','widen','steel'], build:buildL39,
      desc:'暖棕色的墙中央立着一栋黑色的小房子：三角屋顶、方屋身，屋身正中还有一扇中空的门，门里和屋顶下都藏着球砖。入口在底部、三格宽，通道正对房门，从门进去就能在屋里放出连锁。' },
    { name:'双层套娃要塞', speed:478, paddle:76, serves:5, cores:2, types:['normal','ball','bomb','beam','armor','steel','core'], build:buildL40,
      desc:'第四座要塞是双层套娃：钢框里套着外腔和内腔两层。入口在左侧——宽漏斗先进下层外腔，外腔是蓝紫砖面，混着球砖和一排炸弹链；外腔和上层内腔之间隔着一道钢墙，只在右侧留了两格宽的内门。两个金色核心藏在内腔的左上和右上，周围都有装甲砖护卫。打法：先进外腔、再找右侧内门进内腔。挡板正中竖直发球会被钢框挡回，必须从左侧进。两个核心全部打碎才获胜。发球只有 5 次，用完要塞会重建，已通关的关卡不会丢。' },
    { name:'字母 A', speed:488, paddle:76, serves:0, types:['normal','armor','ball','bomb','beam','widen','steel'], build:buildL41,
      desc:'珊瑚红的墙中央留着一个黑色的 A：两条腿、顶盖和横杠围出上下两个中空，上腔里藏着球砖，横杠上还有一颗加宽砖。入口收窄到两格、在底部偏右，通道口正上方就有一颗球砖，进门第一下就能放球。装甲开始变多，先点连锁再啃硬砖。' },
    { name:'圆环', speed:492, paddle:76, serves:0, types:['normal','armor','ball','bomb','beam','widen','steel'], build:buildL42,
      desc:'湖蓝的墙中央浮着一个黑色的圆环，环带中空，环心还留着一座小砖岛，环带底部开着一条两格宽的小隧道直通环心，岛里还藏着一颗炸弹。入口在左下、两格宽，通道对着环带的左下段，环里藏着球砖，环顶还有一颗加宽砖。球进了环带会沿着圈内壁滚动着打砖，别急着追球。' },
    { name:'字母 S', speed:496, paddle:76, serves:0, types:['normal','armor','ball','bomb','beam','steel'], build:buildL43,
      desc:'紫色的墙中央盘着一个黑色的 S：上下两个弯钩都是中空的，上钩藏着炸弹，下钩藏着球砖。入口在右下、两格宽，通道口正上方就是球砖。S 的弯道会把球引向意想不到的方向，装甲适中，靠炸弹和光束开路最省力。' },
    { name:'蝴蝶', speed:500, paddle:76, serves:0, types:['normal','armor','ball','bomb','beam','widen','steel'], build:buildL44,
      desc:'粉色的墙中央停着一只黑色的蝴蝶：左右四片翅膀是四个分开的中空腔室，身体把它们连在一起，上翼各藏球砖，下翼各藏加宽砖。底部左右两个入口各两格宽，分别通向两片下翼，可以从任意一侧先开一翼，再借身体里的连锁打通另一侧。' },
    { name:'双层迷宫', speed:504, paddle:76, serves:0, types:['normal','armor','ball','bomb','beam','steel'], build:buildL45,
      desc:'青蓝的砖铺满整面墙，中间横着一道钢隔墙把墙分成上下两层，隔墙的洞开在右侧；下层还有一道竖钢墙，洞开在中间。入口在右下、两格宽，正上方定点放着球砖。先在下层点起连锁，再顺着两个洞口逐层往上打。' },
    { name:'钻石', speed:508, paddle:76, serves:0, types:['normal','armor','ball','bomb','beam','widen','steel'], build:buildL46,
      desc:'冰晶色的墙中央嵌着一颗黑色的钻石，菱形内部中空，底部尖端藏着两颗球砖，正中还有一颗加宽砖。入口在底部尖端偏左、两格宽。钻石里的装甲更硬，要打三下，优先用炸弹和光束招呼它们。' },
    { name:'雨伞', speed:512, paddle:76, serves:0, types:['normal','armor','ball','beam','bomb','widen','steel'], build:buildL47,
      desc:'红色的墙中央撑着一把黑色的雨伞：半圆伞盖下是一根中空的伞柄，伞盖里左右各藏一颗球砖，伞柄上有一颗加宽砖。入口就在伞柄底部、两格宽，顺着伞柄直上伞盖。光束在这关唱主角，一束能顺着伞盖横扫一排。' },
    { name:'帆船', speed:516, paddle:76, serves:0, types:['normal','armor','ball','beam','bomb','widen','steel'], build:buildL48,
      desc:'海蓝的墙中央驶着一艘黑色的帆船：两面三角帆和梯形船身都是中空的，船身里藏着球砖和加宽砖，大帆里也有一颗球砖。入口在船身左下、两格宽。先打船身攒球，再让多球去拆两面帆。' },
    { name:'花朵', speed:520, paddle:76, serves:0, types:['normal','armor','ball','bomb','beam','widen','steel'], build:buildL49,
      desc:'花粉色的墙中央开着一朵黑色的花：五片花瓣围着花心，花心和右下花瓣各藏一颗球砖，花茎上有一颗加宽砖。入口在右下花瓣下方、两格宽。花瓣彼此分开，要靠钢描边的反弹和连锁逐瓣打通，是中等段最后一关的小考验。' },
    { name:'螺旋回廊要塞', speed:512, paddle:76, serves:5, cores:2, types:['normal','ball','bomb','beam','armor','steel','core'], build:buildL50,
      desc:'第五座要塞是一条顺时针螺旋回廊：从右侧斜坡漏斗进回廊外端，沿右壁上行、顶壁左行、左壁下行，再绕进内圈，最后钻到中心密室。回廊中段的左壁旁藏着一个侧 pocket，里面嵌着第一个金色核心；第二个核心嵌在中心密室正中。打法：沿螺旋回廊走到中心，别漏中段侧 pocket 核心。回廊转角都放了球砖，沿途有装甲和光束砖挡路，直线冲不到中心。两个核心全部打碎才获胜。发球只有 5 次，用完要塞会重建，已通关的关卡不会丢。' },
    { name:'字母 B', speed:524, paddle:76, serves:0, types:['normal','armor','ball','bomb','beam','widen','steel'], build:buildL51,
      desc:'琥珀色的墙中央留着一个黑色的 B：竖柄连着上下两个鼓肚，肚里都藏着球砖，下肚还有一颗加宽砖。入口在下肚底部、两格宽，正上方连着两颗定点球砖——从这里开始装甲更硬、连锁更多，但每一关都给你留了进门就放球的起点，不会进得去却打不动。' },
    { name:'字母 K', speed:528, paddle:76, serves:0, types:['normal','armor','ball','beam','bomb','widen','steel'], build:buildL52,
      desc:'青绿的墙中央立着一个黑色的 K：竖柄加两条斜臂，臂尖各藏一颗球砖，柄上有一颗加宽砖。入口在右下斜臂的尖端下方、两格宽，进门第一颗砖就是球砖。斜臂会把球弹向对角，想要的角度要提前半拍。' },
    { name:'皇冠', speed:532, paddle:76, serves:0, types:['normal','armor','ball','bomb','beam','widen','steel'], build:buildL53,
      desc:'金黄的墙中央戴着一顶黑色的皇冠：三个尖顶立在冠身上，冠身里左右各藏一颗球砖，正中有一颗加宽砖。入口在冠身底部中央、两格宽。冠身的装甲要打三下，先打碎球砖放出多球，再围攻硬砖。' },
    { name:'齿轮', speed:536, paddle:76, serves:0, types:['normal','armor','ball','beam','bomb','widen','steel'], build:buildL54,
      desc:'钢银灰的墙中央嵌着一枚黑色的齿轮：圆盘伸出八个齿，中心还留着一个圆孔，盘里藏着球砖和加宽砖。入口在左下齿的下方、两格宽。球进了齿盘会在齿间来回磕碰，光束能顺着圆盘的直径一次清掉一整排。' },
    { name:'三层迷宫', speed:540, paddle:76, serves:0, types:['normal','armor','ball','bomb','beam','widen','steel'], build:buildL55,
      desc:'靛紫的砖铺满整面墙，两道钢隔墙把墙切成三层：下层的洞在右，中层的洞在左，入口在右下、两格宽，正上方、每层转弯处都定点放了球砖，逐层往上都有连锁接力。装甲不少，但别慌，这一关考的是耐心，不是手速。' },
    { name:'双子塔', speed:544, paddle:76, serves:0, types:['normal','armor','ball','bomb','beam','widen','steel'], build:buildL56,
      desc:'天蓝的墙上立着两座黑色的高塔，塔顶由一座连桥接通，桥下是空的。两座塔各有自己的中空塔身，各藏一颗球砖，左塔有炸弹、右塔有光束，桥上还有一颗加宽砖。底部双入口各两格宽，分别通向两座塔底——先攻一座，再借连桥打通另一座。' },
    { name:'旋涡隔断', speed:548, paddle:76, serves:0, types:['normal','armor','ball','beam','bomb','widen','steel'], build:buildL57,
      desc:'紫粉蓝三色旋进一个大圆盘，盘心是中空的，盘内错落着两道钢隔断，只留中央一条缝相通。入口在盘底、两格宽，正上方定点放着球砖，上半盘还藏着加宽砖。球要穿过中央缝才能打到上半盘，隔断边缘的反弹角很刁，多利用描边借力。' },
    { name:'迷宫回廊', speed:552, paddle:76, serves:0, types:['normal','armor','ball','bomb','beam','widen','steel'], build:buildL58,
      desc:'苔绿的砖面被一圈钢框围住，框内还有横竖两道隔墙把内部分成几个小间，框外留着一圈回廊空道。入口在左下、两格宽，穿过框底就进内间，正上方定点放着球砖，最远的小间里还藏着加宽砖。先沿回廊摸清框形，再逐间清理。' },
    { name:'终局前哨', speed:556, paddle:76, serves:0, types:['normal','armor','ball','bomb','beam','widen','steel'], build:buildL59,
      desc:'暗红的墙上筑着最后一座前哨：中央堡垒连着左右两座塔楼，塔里各藏一颗球砖，堡里有加宽砖和炸弹。入口只剩堡底正中一格宽，是全旅程最窄的入口——但通道正上方就是定点球砖，只要送进一颗，堡内连锁会替你打开局面。这是终局要塞前的最后一道考验。' },
    { name:'三室星核要塞', speed:520, paddle:76, serves:6, cores:3, types:['normal','ball','bomb','beam','armor','steel','core'], build:buildL60,
      desc:'最终要塞被两道钢隔墙切成左、中、右三间互不连通的密室，每间藏着一个金色核心，一共三个，全部打碎才通关。打法：左、中、右三室各藏一核心，逐个攻破——左室走左侧漏斗、以装甲护卫为主；中央室走中央烟囱、满室炸弹链；右室走右侧斜坡、正中是一座光束十字。打完一室要掉回下方，再从另一个入口进下一室，发球怎么分配本身就是难点。发球上限 6 次，用完要塞会重建，已通关的关卡不会丢。' },
    { name:'小丑鱼', speed:560, paddle:76, serves:0, types:T_ALL, build:mkOcean(61),
      desc:'海洋世界的第一站：橙白条纹的小丑鱼就悬在深色海水里，身上没有钢框，也不设防。动物下方全是开放水域，把球直接送上去打鱼身，鱼鳍和尾巴里藏着球砖和加宽砖，先用这一关熟悉细格像素砖的手感。' },
    { name:'海星', speed:563, paddle:76, serves:0, types:T_ALL, build:mkOcean(62),
      desc:'一只紫红色的五角海星摊在海底，五个角都是砖拼的，角尖各有一颗深色斑点砖。没有钢框，入口就是海星下方的整片开放区；星心藏着球砖，从任意一个角啃进去，点起连锁就能顺着角清过去。' },
    { name:'水母', speed:566, paddle:76, serves:0, types:T_ALL, build:mkOcean(63),
      desc:'半透明的伞盖在上方张着，六条触手在水里轻轻摆动，全是砖，没有钢框。伞盖是这一关最厚的部分，先打触手攒球，再集中火力啃伞盖；伞盖正中和触手根部都藏着球砖。' },
    { name:'海马', speed:569, paddle:76, serves:0, types:T_ALL, build:mkOcean(64),
      desc:'黄色的海马竖着身子，尾巴卷成一个圈，嘴巴朝右探着。身体上一道道横纹是深色砖，背鳍在身后张开。没有钢框，从下方直接打肚子最稳，卷尾的圈心是空的，别对着空处浪费球。' },
    { name:'螃蟹', speed:572, paddle:76, serves:0, types:T_ALL, build:mkOcean(65),
      desc:'红螃蟹横着身子，两只大钳子举在头顶两侧，六条腿撑在身下。钳子和腿都是砖，蟹身正中有一条深色纹路。没有钢框，先打腿和钳子攒球砖，再围攻蟹身，蟹盖里藏着加宽砖。' },
    { name:'海龟', speed:575, paddle:76, serves:0, types:T_ALL, build:mkOcean(66),
      desc:'绿壳海龟慢慢游着，龟壳是一圈深绿套着浅绿的纹路，脑袋探在右边，四只鳍在四角划水。没有钢框，壳沿是最薄的地方，从壳的下沿往里打，壳心藏着球砖，右下鳍边还有加宽砖。' },
    { name:'小章鱼', speed:578, paddle:76, serves:0, types:T_ALL, build:mkOcean(67),
      desc:'紫色小章鱼顶着圆脑袋，六条触手在身下散开，触手尖各有一颗深色砖。没有钢框，触手之间的水道是空的，球会从触手缝里钻上去打脑袋；脑袋两侧各藏一颗球砖，先点连锁再清触手。' },
    { name:'海豚', speed:581, paddle:76, serves:0, types:T_ALL, build:mkOcean(68),
      desc:'海豚拉着一道流线从左游到右，白肚皮、尖嘴巴，背鳍和尾鳍都是深蓝砖。没有钢框，鱼身下沿最薄，从肚子往上打最容易打开局面；身子中段藏着球砖，尾巴根部有加宽砖。' },
    { name:'小鲨鱼', speed:584, paddle:76, serves:0, types:T_ALL, build:mkOcean(69),
      desc:'灰蓝色的小鲨鱼张着一排白牙，背鳍立在背上，尾巴朝右甩开。没有钢框，这是入门海洋段最后一关，球砖比前面几关少了一点；从白肚皮往上打，别正对着牙齿那一排硬啃。' },
    { name:'巨鲸要塞', speed:578, paddle:76, serves:5, cores:2, types:['normal','ball','bomb','beam','armor','steel','core'], build:mkOcean(70),
      desc:'要塞是一头巨鲸：钢框围住整片海域，鲸身里面是一间大腔室，两个金色核心一左一右嵌在腔室上部，各有一圈装甲砖护卫。入口在底部钢条正中，六格宽，进去后有钢唇把出口收窄到四格，球进了腔室就不容易原路掉出来。两个核心全部打碎才获胜，发球只有 5 次，用完要塞重建，已通关进度不会丢。' },
    { name:'海豹', speed:590, paddle:76, serves:0, types:T_ALL, build:mkOcean(71),
      desc:'灰色的海豹趴在水里，脑袋翘在右边，尾鳍朝左张开。从这一段开始动物带上局部钢框：底部一条钢条只留四格缺口，两侧各有一段矮钢墙。先从缺口把球送进去打豹身，豹身中段藏着球砖和炸弹。' },
    { name:'飞鱼', speed:593, paddle:76, serves:0, types:T_ALL, build:mkOcean(72),
      desc:'飞鱼张着一对大翅膀鳍，上翅朝天、下翅朝地，身子是一道细长的流线。底部钢条的缺口开在左侧、四格宽，钢框只围了下半圈。从左缺口斜送进去打鱼身，光束砖藏在翅膀根部，一束能顺着翅膀清一排。' },
    { name:'电鳗', speed:596, paddle:76, serves:0, types:T_ALL, build:mkOcean(73),
      desc:'电鳗在水里盘成一道 S 形，背上隔一段就有一颗亮黄色的电斑砖。底部钢条缺口在右侧、四格宽。电鳗身子细长，先打弯道内侧攒球砖，再沿着身子一路清过去，头部藏着一颗炸弹收尾。' },
    { name:'龙虾', speed:599, paddle:76, serves:0, types:T_ALL, build:mkOcean(74),
      desc:'红龙虾一节一节的身子横在中央，两只大螯举在右边，尾巴扇在左边，两根长须探出框外。底部钢条缺口在正中、四格宽。先打虾节之间的深色纹路，钳子最硬，留到多球连锁起来再拆。' },
    { name:'海蛇', speed:602, paddle:76, serves:0, types:T_ALL, build:mkOcean(75),
      desc:'黄黑环纹的海蛇盘着两道弯，环纹是一节亮黄一节墨黑交替的砖。底部钢条缺口在左侧、四格宽。蛇身比电鳗粗一圈，装甲也多了一些；从弯道外侧打开口子，蛇头旁边的炸弹能帮你炸开一整段。' },
    { name:'鲸鲨', speed:605, paddle:76, serves:0, types:T_ALL, build:mkOcean(76),
      desc:'鲸鲨是这一段最大的鱼：满身白色斑点，嘴巴宽宽地张在左边。底部钢条缺口在右侧、四格宽。鱼身砖量大、装甲适中，先打下沿的斑点区攒球，再让多球去啃背鳍和尾巴，光束砖藏在身子中段。' },
    { name:'魔鬼鱼', speed:608, paddle:76, serves:0, types:T_ALL, build:mkOcean(77),
      desc:'魔鬼鱼摊开一对菱形大翅膀，白肚皮朝下，头前两只小角是头鳍，细尾巴拖在身后。底部钢条缺口在左侧、四格宽。翅膀薄、白肚皮更薄，从缺口斜打进翅膀下沿，炸弹藏在左翼中段。' },
    { name:'海葵鱼', speed:611, paddle:76, serves:0, types:T_ALL, build:mkOcean(78),
      desc:'粉色海葵在海底张着一丛触手，一条橙白条纹的小鱼躲在海葵上方。底部钢条缺口在正中、四格宽。先打海葵触手攒球——触手根部就藏着球砖，再打上方的鱼身；这一关考的是先下后上的顺序。' },
    { name:'珊瑚蟹', speed:614, paddle:76, serves:0, types:T_ALL, build:mkOcean(79),
      desc:'珊瑚蟹躲在橙色珊瑚枝后面，珊瑚枝本身也是砖，能打。底部钢条缺口在右侧、四格宽。先清挡路的珊瑚枝，再打蟹身和两只钳子；蟹盖正中藏着球砖，左钳边上有一颗炸弹接力。' },
    { name:'巨鲨要塞', speed:608, paddle:76, serves:5, cores:2, types:['normal','ball','bomb','beam','armor','steel','core'], build:mkOcean(80),
      desc:'这座要塞是一条巨鲨，鲨身被一道钢隔墙劈成左右双腔室：左腔在鲨头里，右腔在鲨腹里，各藏一个金色核心，隔墙不通，必须分别攻破。底部钢条开了两个入口，左边四格对着鲨头腔，右边四格对着鲨腹腔，入口上方各有一道钢唇收口。两个核心全部打碎才获胜，发球只有 5 次，怎么分配两边的发球本身就是难点。用完要塞重建，已通关进度不会丢。' },
    { name:'海狮', speed:620, paddle:76, serves:0, types:T_ALL, build:mkOcean(81),
      desc:'从这一段开始，动物住进完整的钢框水箱：四面钢墙，只在底部留三格宽的缺口。海狮在框里昂着头，前鳍撑在身下。缺口在正中偏左，先送球进去打狮身下沿，装甲明显变多，炸弹藏在海狮背上。' },
    { name:'剑鱼', speed:623, paddle:76, serves:0, types:T_ALL, build:mkOcean(82),
      desc:'剑鱼的长剑从嘴巴一直探到钢框右边，高背鳍立在背上。完整钢框，底部缺口在左侧、三格宽。从缺口进去先打鱼身，长剑那一排砖细而长，光束砖藏在剑根，一束能顺着剑身清到底。' },
    { name:'鱿鱼', speed:626, paddle:76, serves:0, types:T_ALL, build:mkOcean(83),
      desc:'鱿鱼顶着尖尖的伞帽，十条触手在身下垂成一排帘子，两只大眼睛是身上的空洞。完整钢框，底部缺口在右侧、三格宽。触手帘子之间的缝能漏球上去，先打伞帽攒球砖，再逐条清触手。' },
    { name:'海胆', speed:629, paddle:76, serves:0, types:T_ALL, build:mkOcean(84),
      desc:'海胆是一团深紫色的刺球：中心是层层同心圆的砖，十六根长刺朝四面八方支出去。完整钢框，底部缺口在正中、三格宽。刺与刺之间全是空水道，球能从刺缝钻到球心；先打外圈的刺，再围攻球心，炸弹藏在右上方的刺根。' },
    { name:'灯笼鱼', speed:632, paddle:76, serves:0, types:T_ALL, build:mkOcean(85),
      desc:'深海灯笼鱼通体深蓝，头顶垂着一盏亮黄色的小灯，肚子下面点着一排发光斑点砖。完整钢框，底部缺口在左侧、三格宽。发光斑点大多是球砖和光束砖，先点亮肚子攒球，再啃厚实的鱼头。' },
    { name:'海龙', speed:635, paddle:76, serves:0, types:T_ALL, build:mkOcean(86),
      desc:'海龙在水里盘成一道弯，身上一路长着叶状的鳍，像一片会游的海草，尾巴还卷着一簇海草砖。完整钢框，底部缺口在右侧、三格宽。叶鳍是浅绿砖、身子是深绿砖，先打鳍攒加宽，再沿身子清过去。' },
    { name:'虎鲸', speed:638, paddle:76, serves:0, types:T_ALL, build:mkOcean(87),
      desc:'虎鲸黑背白肚，眼后有一块白斑，高背鳍立在正中。完整钢框，底部缺口在正中、三格宽。白肚皮是最薄的一层，从缺口正上方打进去最快；装甲藏在黑背里，留给炸弹和多球慢慢磨。' },
    { name:'海参', speed:641, paddle:76, serves:0, types:T_ALL, build:mkOcean(88),
      desc:'粉褐色的海参软乎乎地横在框底上方，身上点着一格一格的疙瘩砖，身下还拖着一条足带。完整钢框，底部缺口在左侧、三格宽。海参身子扁、砖层薄，但装甲疙瘩不少，光束砖藏在身子左段，一束横扫整条身子。' },
    { name:'蝠鲼', speed:644, paddle:76, serves:0, types:T_ALL, build:mkOcean(89),
      desc:'蝠鲼摊开一对宽翅膀，比魔鬼鱼更宽更扁，头前两只头鳍卷成小圆筒，背上撒着白斑点。完整钢框，底部缺口在右侧、三格宽，这是较难段的收尾：装甲更多，先从翅膀下沿的白肚皮打开缺口，炸弹藏在左翼。' },
    { name:'章鱼要塞', speed:638, paddle:76, serves:5, cores:2, types:['normal','ball','bomb','beam','armor','steel','core'], build:mkOcean(90),
      desc:'章鱼要塞的脑袋是一间大腔室，两个金色核心并排藏在腔室上部，各有一圈装甲护卫；脑袋下方垂着六条砖砌的触手，触手之间是四条水道，底部钢条开了三个入口，入口之间立着短钢墙把水道分开。球要顺着触手水道游进脑袋腔室，进去后钢唇和触手根会把球多留一会儿。两个核心全部打碎才获胜，发球只有 5 次，用完要塞重建，已通关进度不会丢。' },
    { name:'深海鲨', speed:650, paddle:76, serves:0, types:T_ALL, build:mkOcean(91),
      desc:'最后一段开始：钢框里还砌着珊瑚迷宫，横竖钢墙把下半区隔成几个口袋，入口正上方就定点放着一颗球砖，送进第一颗球就能放出连锁。深海鲨比小鲨鱼大一圈，背上两片背鳍，嘴边一排白牙；迷宫口袋里还藏着球砖和加宽砖，绝不让你进得去却打不动。' },
    { name:'巨型水母', speed:653, paddle:76, serves:0, types:T_ALL, build:mkOcean(92),
      desc:'巨型水母的伞盖几乎撑满钢框，伞下垂着七条长触手和三条粗口腕，框底是珊瑚迷宫，缺口在左侧、三格宽，入口正上方定点球砖。先借迷宫口袋里的球砖攒出多球，再让球群顺着触手缝往上啃伞盖，伞盖里还有一层内铃铛砖。' },
    { name:'海怪鱼', speed:656, paddle:76, serves:0, types:T_ALL, build:mkOcean(93),
      desc:'海怪鱼的大头占了半个钢框，嘴巴是头侧一个现成的凹口，上下各一排白牙砖，头顶垂着发光的钓竿。框底珊瑚迷宫，缺口在右侧、三格宽，入口正上方定点球砖。先从嘴巴凹口往里打，鱼头最厚，靠迷宫里的光束和炸弹接力才啃得动。' },
    { name:'珊瑚龙', speed:659, paddle:76, serves:0, types:T_ALL, build:mkOcean(94),
      desc:'珊瑚龙昂着头，龙角是橙色珊瑚枝，身子盘成一道升起的弯，背上一路珊瑚鳍。框底珊瑚迷宫，缺口在正中、三格宽，入口正上方定点球砖。龙身装甲是全段最硬的一档，先点迷宫连锁攒球，再围攻龙头和龙角。' },
    { name:'幽灵章鱼', speed:662, paddle:76, serves:0, types:T_ALL, build:mkOcean(95),
      desc:'幽灵章鱼通体苍白，两只耳朵鳍张在脑袋两侧，身下是一片裙摆般的腕蹼。框底珊瑚迷宫，缺口在左侧、三格宽，入口正上方定点球砖。白色的砖里混着不少装甲，先打裙摆攒球，两只耳朵鳍里各藏着一颗球砖。' },
    { name:'帝王蟹', speed:665, paddle:76, serves:0, types:T_ALL, build:mkOcean(96),
      desc:'帝王蟹比普通螃蟹大了一整圈，蟹盖顶着一排金色冠刺，长腿一直撑到钢框两侧。框底珊瑚迷宫，缺口在右侧、三格宽，入口正上方定点球砖。腿和钳子先拆，蟹盖最硬，盖心藏着球砖，留到连锁成型再总攻。' },
    { name:'深海龟', speed:668, paddle:76, serves:0, types:T_ALL, build:mkOcean(97),
      desc:'深海龟的壳是深绿套着墨绿的同心纹，壳心一块浅绿，长脖子把脑袋探到框边，四只大鳍在四角。框底珊瑚迷宫，缺口在正中、三格宽，入口正上方定点球砖。壳沿薄、壳心硬，光束砖藏在左上鳍边，先开壳沿再磨壳心。' },
    { name:'鲸落鱼群', speed:671, paddle:76, serves:0, types:T_ALL, build:mkOcean(98),
      desc:'海底躺着一具鲸落：白色的肋骨一根根立着，头骨在右下，十二条小鱼在骨架上方游成一群，每条鱼都是几格砖拼的。框底珊瑚迷宫，缺口在左侧、三格宽，入口正上方定点球砖。小鱼分散，先逐条点掉攒连锁，再清肋骨和珊瑚礁，迷宫里有加宽砖兜底。' },
    { name:'海神鲸', speed:674, paddle:76, serves:0, types:T_ALL, build:mkOcean(99),
      desc:'海神鲸是旅程里最大的动物：身子几乎撑满钢框，头顶喷着三道水柱，背上一道金色冠纹。框底珊瑚迷宫，缺口在右侧、三格宽，入口正上方定点球砖。这是最终要塞前的最后一关，装甲和连锁都是全段之最，迷宫口袋里的球砖和炸弹是为你留的接力。' },
    { name:'深海宫殿要塞', speed:640, paddle:76, serves:6, cores:3, types:['normal','ball','bomb','beam','armor','steel','core'], build:mkOcean(100),
      desc:'最终要塞是海底的一座珊瑚宫殿：两道钢隔墙把宫殿切成左、中、右三间大殿，三间互不连通，每间上方各嵌着一个金色核心，核心周围有装甲护卫，殿里还长着橙色珊瑚枝。底部钢条给每间大殿各开一个入口，左殿四格、中殿四格、右殿四格，入口上方各有一道漏斗钢层收口。三个核心全部打碎才通关，发球上限 6 次，打完一殿掉回下方再换入口进下一殿。用完要塞重建，已通关进度不会丢。' }
  ];

  // 当前生效的关卡定义：每日关用 DAILY_DEF，旅程关用 LEVELS[level-1]
  function curDef(){ return S.daily ? DAILY_DEF : LEVELS[S.level-1]; }

  /* ================= 游戏状态 ================= */
  var S = {
    mode: 'ready',        // ready | menu | card | serve | play | pause | win | fail
    prevMode: 'serve',
    level: 1,
    daily: false,         // 当前玩的是不是每日关
    dailyDate: '',        // 每日关的 UTC 日期字符串
    dailyDesc: '',        // 每日关提示卡文案（由种子生成）
    paddleX: W/2,
    balls: [],
    bricks: [],
    steels: [],
    total: 0, broken: 0,
    servesLeft: 0,
    servesTotal: 0,
    attemptActive: false,   // 本局是否已点开始且未结算（用于未通关尝试计数）
    assist: null,           // 当前局的自适应助力档位（assistFor 的结果）
    coresLeft: 0,
    elapsed: 0,           // 游戏内计时（毫秒），暂停停表
    speedMul: 1,
    servePulse: 0,
    shake: 0
  };

  function loadLevel(n){
    var def = LEVELS[n-1];
    S.level = n;
    S.daily = false;
    S.assist = assistFor(ATT.lv[n] || 0);
    BALL_SPEED = Math.round(def.speed * S.assist.speedMul);
    var lv = def.build();
    S.bricks = lv.bricks; S.steels = lv.steels;
    S.total = lv.total; S.broken = 0;
    applyDowngrade();
    S.coresLeft = 0;
    S.bricks.forEach(function(b){ if (b.type === 'core') S.coresLeft++; });
    S.elapsed = 0; S.paddleX = W/2;
    PADDLE_W = Math.min(180, Math.round((def.paddle || 76) * S.assist.paddleMul));
    S.servesLeft = def.serves ? def.serves + S.assist.servesBonus : 0;
    S.servesTotal = S.servesLeft;
    S.balls = [];
    enterServe();
    hudLv.textContent = '第 ' + n + ' 关';
    lastSub = null;
    updateHUD();
  }
  // 每日关加载：按 S.dailyDate 的种子生成布局，其余状态与普通关一致
  function loadDailyLevel(){
    S.daily = true;
    S.assist = assistFor(ATT.dy[S.dailyDate] || 0);
    var built = buildDaily(S.dailyDate);
    S.bricks = built.bricks; S.steels = built.steels;
    S.total = built.total; S.broken = 0;
    applyDowngrade();
    S.coresLeft = 0;
    S.dailyDesc = built.desc;
    BALL_SPEED = Math.round(built.speed * S.assist.speedMul);
    S.elapsed = 0; S.paddleX = W/2;
    PADDLE_W = Math.min(180, Math.round(76 * S.assist.paddleMul));
    S.servesLeft = 0;
    S.servesTotal = 0;
    S.balls = [];
    enterServe();
    hudLv.textContent = '每日关卡';
    lastSub = null;
    updateHUD();
  }
  function enterServe(){
    S.balls = [ makeBall(S.paddleX, PADDLE_Y - BALL_R - 1, 0, 0, true) ];
    S.mode = 'serve';
  }
  function makeBall(x,y,vx,vy,stuck){
    return { x:x, y:y, vx:vx, vy:vy, stuck:!!stuck, steelMs:0, dead:false, trail:[] };
  }
  function launch(){
    if (S.mode !== 'serve') return;
    var b = S.balls[0];
    b.stuck = false;
    b.vx = 0; b.vy = -BALL_SPEED;
    b.steelMs = 0;
    S.mode = 'play';
    SFX.launch();
  }
  function widenPaddle(){
    PADDLE_W = Math.min(180, PADDLE_W + 24);   // 加宽两格，最宽不超过场地一半
    S.paddleX = clamp(S.paddleX, PADDLE_W/2, W - PADDLE_W/2);
  }
  // 对一格砖造成 dmg 点伤害：装甲先扣血（炸弹/光束 dmg=3），扣光才打碎并触发效果
  function damageCell(r, c, dmg, queue){
    var cell = grid[r] && grid[r][c];
    if (!cell || cell.kind !== 'brick') return;
    var br = cell.ref;
    if (!br.alive) return;
    if (br.type === 'armor'){
      br.hp -= dmg;
      if (br.hp > 0){ SFX.armor(); return; }
    }
    destroyBrick(r, c, br, queue);
  }
  function destroyBrick(r, c, br, queue){
    br.alive = false;
    if (br.type === 'core'){
      S.coresLeft = Math.max(0, S.coresLeft - 1);
      SFX.bomb();
      if (S.coresLeft <= 0) winLevel();   // 两个核心全部打碎才获胜
      return;
    }
    S.broken++;
    SFX.brick();
    if (br.type === 'ball'){ spawnBallBrickBalls(br); SFX.spawn(); }
    else if (br.type === 'widen'){ widenPaddle(); SFX.widen(); }
    else if (br.type === 'bomb') queue.push({ t:'bomb', r:r, c:c });
    else if (br.type === 'beam') queue.push({ t:'beam', r:r, c:c });
  }
  function beamLine(r, c, dr, dc, queue){
    var rr = r + dr, cc = c + dc;
    while (rr >= 0 && rr < grid.length && cc >= 0 && cc < COLS){
      var cell = grid[rr][cc];
      if (cell && cell.kind === 'steel') break;   // 光束遇钢块停下
      damageCell(rr, cc, 3, queue);               // 光束算 3 下
      rr += dr; cc += dc;
    }
  }
  function processQueue(queue){
    while (queue.length){
      var job = queue.shift();
      if (job.t === 'bomb'){
        SFX.bomb();
        for (var dr=-1; dr<=1; dr++){
          for (var dc=-1; dc<=1; dc++){
            if (dr === 0 && dc === 0) continue;
            damageCell(job.r + dr, job.c + dc, 3, queue);   // 爆炸算 3 下，相邻炸弹连锁引爆
          }
        }
      } else if (job.t === 'beam'){
        SFX.beam();
        beamLine(job.r, job.c, 0, -1, queue);
        beamLine(job.r, job.c, 0,  1, queue);
        beamLine(job.r, job.c, -1, 0, queue);
        beamLine(job.r, job.c,  1, 0, queue);
      }
    }
  }
  function spawnBallBrickBalls(br){
    if (S.balls.length >= 300) return;   // 场上球数上限 300 颗，性能兜底
    var cx = br.x + br.w/2, cy = br.y + br.h/2;
    var a1 = -Math.PI/2 - 0.55, a2 = -Math.PI/2 + 0.55;
    S.balls.push(makeBall(cx, cy, Math.cos(a1)*BALL_SPEED, Math.sin(a1)*BALL_SPEED, false));
    if (S.balls.length < 300) S.balls.push(makeBall(cx, cy, Math.cos(a2)*BALL_SPEED, Math.sin(a2)*BALL_SPEED, false));
  }

  /* ================= HUD ================= */
  var lastSub = null;
  function ratio(){ return S.total ? S.broken/S.total : 0; }
  function updateHUD(){
    var p = Math.floor(ratio()*100);
    hudPct.textContent = p + '%';
    hudBar.style.width = p + '%';
    hudBalls.textContent = S.balls.length;
    hudTime.textContent = fmt(S.elapsed);
    var sub;
    if (S.daily){
      sub = '每日关卡 · ' + S.dailyDate;
    } else {
      var def = LEVELS[S.level-1];
      sub = def.serves ? (def.name + ' · 发球剩余 ' + S.servesLeft + ' · 核心 ' + S.coresLeft) : def.name;
    }
    if (sub !== lastSub){ hudSub.textContent = sub; lastSub = sub; }
  }

  /* ================= 碰撞 ================= */
  function circleRect(b, r){
    var nx = clamp(b.x, r.x, r.x+r.w);
    var ny = clamp(b.y, r.y, r.y+r.h);
    var dx = b.x-nx, dy = b.y-ny;
    return (dx*dx + dy*dy) <= BALL_R*BALL_R;
  }
  function bounceRect(b, r){
    // 用穿透最小轴反弹
    var left = Math.abs(b.x - r.x), right = Math.abs(b.x - (r.x+r.w));
    var top = Math.abs(b.y - r.y), bottom = Math.abs(b.y - (r.y+r.h));
    var inside = b.x>r.x && b.x<r.x+r.w && b.y>r.y && b.y<r.y+r.h;
    if (inside){
      var m = Math.min(left,right,top,bottom);
      if (m===left){ b.vx = -Math.abs(b.vx); b.x = r.x - BALL_R; }
      else if (m===right){ b.vx = Math.abs(b.vx); b.x = r.x + r.w + BALL_R; }
      else if (m===top){ b.vy = -Math.abs(b.vy); b.y = r.y - BALL_R; }
      else { b.vy = Math.abs(b.vy); b.y = r.y + r.h + BALL_R; }
    } else {
      var cx = clamp(b.x, r.x, r.x+r.w), cy = clamp(b.y, r.y, r.y+r.h);
      if (Math.abs(b.x-cx) > Math.abs(b.y-cy)) b.vx = (b.x<cx? -Math.abs(b.vx): Math.abs(b.vx));
      else b.vy = (b.y<cy? -Math.abs(b.vy): Math.abs(b.vy));
    }
  }
  function normalize(b){
    var sp = Math.sqrt(b.vx*b.vx + b.vy*b.vy) || 1;
    b.vx = b.vx/sp*BALL_SPEED; b.vy = b.vy/sp*BALL_SPEED;
    // 防止近水平死循环：给一个最小竖直分量
    if (Math.abs(b.vy) < BALL_SPEED*0.22){
      b.vy = (b.vy<0?-1:1)*BALL_SPEED*0.22;
      var s2 = Math.sqrt(b.vx*b.vx + b.vy*b.vy);
      b.vx = b.vx/s2*BALL_SPEED; b.vy = b.vy/s2*BALL_SPEED;
    }
  }

  function stepBall(b, dt){
    b.x += b.vx*dt; b.y += b.vy*dt;

    // 墙
    if (b.x < BALL_R){ b.x = BALL_R; b.vx = Math.abs(b.vx); SFX.wall(); }
    if (b.x > W-BALL_R){ b.x = W-BALL_R; b.vx = -Math.abs(b.vx); SFX.wall(); }
    if (b.y < BALL_R){ b.y = BALL_R; b.vy = Math.abs(b.vy); SFX.wall(); }
    // 掉出底部
    if (b.y - BALL_R > H){ b.dead = true; return; }

    // 挡板
    var px = S.paddleX - PADDLE_W/2;
    if (b.vy > 0 && b.y + BALL_R >= PADDLE_Y && b.y - BALL_R <= PADDLE_Y + PADDLE_H
        && b.x >= px - BALL_R && b.x <= px + PADDLE_W + BALL_R){
      var off = clamp((b.x - S.paddleX)/(PADDLE_W/2), -1, 1);
      var ang = off * MAX_ANGLE;
      b.vx = Math.sin(ang)*BALL_SPEED;
      b.vy = -Math.cos(ang)*BALL_SPEED;
      b.y = PADDLE_Y - BALL_R - 0.5;
      b.steelMs = 0;
      SFX.paddle();
    }

    // 网格碰撞：只查球周围邻域的小方格，砖再多、多球同屏也不卡。
    // 钢块只反弹不重置计时；碰到砖（哪怕装甲没碎）才重置 30 秒钢块计时。
    var c0 = clamp(Math.floor((b.x - BALL_R - GOX)/CELL), 0, COLS-1);
    var c1 = clamp(Math.floor((b.x + BALL_R - GOX)/CELL), 0, COLS-1);
    var r0 = clamp(Math.floor((b.y - BALL_R - GOY)/CELL), 0, ROWS-1);
    var r1 = clamp(Math.floor((b.y + BALL_R - GOY)/CELL), 0, ROWS-1);
    var done = false;
    for (var rr=r0; rr<=r1 && !done; rr++){
      for (var cc=c0; cc<=c1 && !done; cc++){
        var cell = grid[rr] && grid[rr][cc];
        if (!cell) continue;
        var rect = cell.ref;
        if (cell.kind==='brick' && !rect.alive) continue;
        if (!circleRect(b, rect)) continue;
        if (cell.kind==='steel'){
          bounceRect(b, rect); normalize(b);
        } else {
          bounceRect(b, rect); normalize(b);
          b.steelMs = 0;
          var queue = [];
          damageCell(rr, cc, 1, queue);
          processQueue(queue);
          if (!curDef().serves && S.total > 0 && ratio() >= WIN_RATIO){ winLevel(); }
        }
        done = true;
      }
    }
  }

  function physics(dtMs){
    var dt = (dtMs/1000) * S.speedMul;
    var steps = Math.max(1, Math.ceil(dt / (1/240)));
    var sdt = dt/steps;
    for (var s=0;s<steps;s++){
      for (var i=0;i<S.balls.length;i++){
        var b = S.balls[i];
        if (b.stuck) continue;
        b.steelMs += sdt*1000;
        if (b.steelMs >= STEEL_DEAD_AT) b.dead = true;
        stepBall(b, sdt);
      }
    }
    S.balls = S.balls.filter(function(b){ return !b.dead; });
    // 丢光了球 → 普通关补发；要塞扣一次发球，用完则失败重建
    if (S.mode === 'play' && S.balls.length === 0){
      if (curDef().serves){
        S.servesLeft--;
        updateHUD();
        if (S.servesLeft <= 0){ failLevel(); return; }
      }
      SFX.lost(); enterServe();
    }
  }

  /* ================= 流程 ================= */
  function openLevel(n){
    loadLevel(n);
    fillCard(n);
    S.mode = 'card';
    showOverlay(ovStart);
  }
  function openDaily(){
    SFX.unlock();
    S.dailyDate = dailyDateStr();   // 打开时按当前 UTC 日期算当日布局
    loadDailyLevel();
    fillDailyCard();
    S.mode = 'card';
    showOverlay(ovStart);
  }
  function startGame(){
    SFX.unlock();   // 用户手势内创建/恢复 AudioContext
    /* 背景音乐暂时停用：MUSIC.start() 调用已移除，MUSIC 模块与 jy-music 本地值保留，后期恢复时在此重新调用 */
    S.attemptActive = true;   // 本局开始计时：未通关离开时记 1 次尝试
    showOverlay(null);
    S.mode = 'serve';
  }
  function restartLevel(){
    SFX.unlock();
    registerFail();   // 重玩 = 上一局未通关放弃，记 1 次尝试（已结算的局不会重复记）
    /* 背景音乐暂时停用：MUSIC.start() 调用已移除，后期恢复时在此重新调用 */
    if (S.daily){ S.dailyDate = dailyDateStr(); loadDailyLevel(); }   // 跨 UTC 零点重开即换新关
    else loadLevel(S.level);
    S.attemptActive = true;   // 新的一局即刻开始，按新档位助力重开
    showOverlay(null);
    S.mode = 'serve';
  }
  function goSelect(){
    registerFail();   // 对局中途回选关 = 未通关尝试（在提示卡/结算页调用时不会误记）
    MUSIC.stop();
    buildSelect();
    refreshDailyUI();
    S.mode = 'menu';
    showOverlay(ovSelect);
  }
  function goHome(){
    registerFail();   // 对局中途退出 = 未通关尝试
    MUSIC.stop();   // 退出回开始页：背景音乐停止
    refreshDailyUI();
    S.mode = 'menu';
    showOverlay(ovHome);
  }
  function pauseGame(){
    if (S.mode !== 'play' && S.mode !== 'serve') return;
    S.prevMode = S.mode;
    S.mode = 'pause';
    MUSIC.pause();   // 暂停游戏时音乐挂起，继续时从原位置续播
    showOverlay(ovPause);
  }
  function resumeGame(){
    if (S.mode !== 'pause') return;
    showOverlay(null);
    S.mode = S.prevMode;
    /* 背景音乐暂时停用：MUSIC.resume() 调用已移除，后期恢复时在此重新调用 */
  }
  function winLevel(){
    if (S.mode === 'win' || S.mode === 'fail') return;
    S.mode = 'win';
    S.attemptActive = false;
    clearAttempts();   // 通关后该关尝试次数清零，下一关从 0 次开始
    MUSIC.stop();
    var t = S.elapsed;
    var isRecord, bestVal;
    if (S.daily){
      // 每日关结算：最佳时间按日期单独存，不动旅程解锁、不解锁下一关、没有「下一关」
      var dkey = S.dailyDate;
      var prevDaily = DAILY_BEST[dkey];
      isRecord = (prevDaily == null || t < prevDaily);
      if (isRecord) DAILY_BEST[dkey] = t;
      saveDailyBest();
      bestVal = DAILY_BEST[dkey];
      document.getElementById('winTitle').textContent = '砖墙打通了';
      document.getElementById('winDesc').textContent = '每日关卡 · ' + dkey + ' 已完成。';
      document.getElementById('winPct').textContent = Math.floor(ratio()*100) + '%';
      document.getElementById('btnNext').hidden = true;
    } else {
      var n = S.level, def = LEVELS[n-1];
      var prevBest = PROG.best[n];
      isRecord = (prevBest == null || t < prevBest);
      if (isRecord) PROG.best[n] = t;
      if (n < 100 && !IS_TEST_ENV) PROG.unlocked = Math.max(PROG.unlocked, n + 1);
      saveProg();
      bestVal = PROG.best[n];
      document.getElementById('winTitle').textContent = (n === 100) ? '全部通关！' : (def.serves ? '核心摧毁！' : '砖墙打通了');
      document.getElementById('winDesc').textContent = (n === 100)
        ? '第 100 关 · ' + def.name + ' 已完成，100 关全部通关！'
        : ('第 ' + n + ' 关 · ' + def.name + ' 已完成。');
      document.getElementById('winPct').textContent = def.serves ? '核心已碎' : (Math.floor(ratio()*100) + '%');
      document.getElementById('btnNext').hidden = (n >= 100);
    }
    document.getElementById('winTime').textContent = fmt(t);
    document.getElementById('winBest').textContent = fmt(bestVal);
    document.getElementById('winRecord').hidden = !isRecord;
    SFX.win();
    showOverlay(ovWin);
    updateHUD();
    refreshDailyUI();
  }
  function failLevel(){
    if (S.mode === 'fail' || S.mode === 'win') return;
    S.mode = 'fail';
    registerFail();   // 要塞重建 = 1 次未通关尝试，下次挑战按档位给助力
    MUSIC.stop();
    var def = LEVELS[S.level-1];
    document.getElementById('failDesc').textContent = (S.servesTotal || def.serves) + ' 次发球都用完了，要塞已重建，金色核心恢复原样。已经通关的关卡和最佳时间不会丢。';
    SFX.bomb();
    showOverlay(ovFail);
  }

  /* ================= 提示卡与选关 ================= */
  var cardTag = document.getElementById('cardTag');
  var cardTitle = document.getElementById('cardTitle');
  var cardDesc = document.getElementById('cardDesc');
  var cardGoal = document.getElementById('cardGoal');
  var cardTiny = document.getElementById('cardTiny');
  // 助力诚实提示：有助力时在提示卡目标框里写清第几次挑战与助力内容（只改手感，不改关卡本身）
  function assistNote(){
    var a = S.assist;
    if (!a || a.tier === 0) return '';
    if (a.tier === 3) return '<br>已挑战超过20次，已降低一档难度：挡板更宽、球速更慢、装甲更脆、缺口更宽。';
    var txt = a.tier === 1
      ? '挡板已加宽、球速已放慢'
      : '挡板已加宽更多、球速已放慢更多' + (curDef().serves ? '、发球上限 +1' : '');
    return '<br>第 ' + a.no + ' 次挑战：' + txt + '。';
  }
  function fillCard(n){
    var def = LEVELS[n-1];
    cardTag.textContent = def.serves ? ('第 ' + n + ' 关 · 要塞') : ('第 ' + n + ' 关');
    cardTitle.textContent = def.name;
    cardDesc.textContent = def.desc;
    var effServes = def.serves ? def.serves + (S.assist ? S.assist.servesBonus : 0) : 0;
    cardGoal.innerHTML = (def.serves
      ? '目标：摧毁主腔室里的 <b>' + (def.cores === 3 ? '三个' : '两个') + '金色核心</b>，全部打碎才过关。发球上限 <b>' + effServes + ' 次</b>，用完要塞就会重建。'
      : '目标：打掉 <b>95%</b> 的可破坏砖块即可过关。丢球会自动补发，不用担心。') + assistNote();
    cardTiny.textContent = def.serves
      ? '点开始后才计时 · 发球次数用完不影响已通关进度'
      : '点开始后才计时 · 拖动屏幕或下方控制条都能移动挡板';
  }
  function fillDailyCard(){
    cardTag.textContent = '每日关卡';
    cardTitle.textContent = '每日关卡 · ' + S.dailyDate;
    cardDesc.textContent = S.dailyDesc;
    cardGoal.innerHTML = '目标：打掉 <b>95%</b> 的可破坏砖块即可过关。丢球会自动补发，不用担心。每日成绩按日期单独保存，不影响旅程进度。' + assistNote();
    cardTiny.textContent = '点开始后才计时 · 同一天布局相同，过了 UTC 零点换新关';
  }
  /* 每日入口（开始页 + 选关页）：显示当天 UTC 日期和今日是否已通关 / 最佳时间 */
  var homeDailyMain = document.getElementById('homeDailyMain');
  var homeDailyStatus = document.getElementById('homeDailyStatus');
  var selDailyMain = document.getElementById('selDailyMain');
  var selDailyStatus = document.getElementById('selDailyStatus');
  function refreshDailyUI(){
    var d = dailyDateStr();
    var best = DAILY_BEST[d];
    var st = (best != null) ? ('今日已通关 · 最佳 ' + fmt(best) + ' · 点此重玩刷纪录') : '今日还没通关 · 点此挑战';
    homeDailyMain.textContent = '每日关卡 · ' + d;
    homeDailyStatus.textContent = st;
    selDailyMain.textContent = '每日关卡 · ' + d;
    selDailyStatus.textContent = '每天一关';
  }
  var lvGrid = document.getElementById('lvGrid');
  var selCount = document.getElementById('selCount');
  var LOCK_SVG = '<svg class="lock" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><rect x="5" y="10.5" width="14" height="9.5" rx="2" fill="currentColor" stroke="none"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>';
  function buildSelect(){
    lvGrid.innerHTML = '';
    var cleared = 0;
    for (var k=1;k<=100;k++){ if (PROG.best[k] != null) cleared++; }
    if (selCount) selCount.textContent = '已通关 ' + cleared + ' / 100 关';
    for (var i=1;i<=100;i++){
      (function(n){
        var locked = n > effectiveUnlocked();
        var best = PROG.best[n];
        var isFort = (n % 10 === 0);
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'lvbtn' + (isFort ? ' fortress' : '') + (locked ? ' locked' : '');
        b.setAttribute('aria-label', '第 ' + n + ' 关' + (isFort ? ' · 要塞' : '') + (locked ? ' · 已锁定' : ''));
        var html = '';
        if (isFort) html += '<span class="fort">要塞</span>';
        if (locked){
          html += LOCK_SVG;
        } else {
          html += '<span class="n">' + n + '</span>';
          if (best != null) html += '<span class="t">' + fmt(best) + '</span>';
        }
        b.innerHTML = html;
        if (!locked) b.addEventListener('click', function(){ openLevel(n); });
        lvGrid.appendChild(b);
      })(i);
    }
  }

  /* ================= 绘制 ================= */
  function roundRect(x,y,w,h,r){
    ctx.beginPath();
    ctx.moveTo(x+r,y);
    ctx.arcTo(x+w,y,x+w,y+h,r);
    ctx.arcTo(x+w,y+h,x,y+h,r);
    ctx.arcTo(x,y+h,x,y,r);
    ctx.arcTo(x,y,x+w,y,r);
    ctx.closePath();
  }

  function draw(now){
    ctx.setTransform(1,0,0,1,0,0);
    ctx.fillStyle = '#000000';
    try{ ctx.fillRect(0,0,canvas.width,canvas.height); }catch(e){}
    ctx.setTransform(MG.scale,0,0,MG.scale,MG.ox,MG.oy);
    ctx.clearRect(0,0,W,H);
    // 场地
    ctx.fillStyle = '#14161d';
    ctx.fillRect(0,0,W,H);
    // 底部浅条
    ctx.fillStyle = '#1e2129';
    ctx.fillRect(0, H-30, W, 30);

    // 砖：橙色小方格为主，特殊砖只用很小的标记区分
    for (var i=0;i<S.bricks.length;i++){
      var br = S.bricks[i];
      if (!br.alive) continue;
      var bcx = br.x + br.w/2, bcy = br.y + br.h/2;
      if (br.type === 'ball'){
        ctx.fillStyle = '#333a45';
        ctx.fillRect(br.x, br.y, br.w, br.h);
        ctx.fillStyle = '#ffffff';
        ctx.beginPath(); ctx.arc(bcx, bcy, 2.6, 0, Math.PI*2); ctx.fill();
      } else if (br.type === 'bomb'){
        ctx.fillStyle = '#d92662';
        ctx.fillRect(br.x, br.y, br.w, br.h);
        ctx.fillStyle = '#20060f';
        ctx.beginPath(); ctx.arc(bcx, bcy, 2.1, 0, Math.PI*2); ctx.fill();
      } else if (br.type === 'beam'){
        ctx.fillStyle = '#17b6cf';
        ctx.fillRect(br.x, br.y, br.w, br.h);
        ctx.strokeStyle = '#065a66'; ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(bcx-3.4, bcy); ctx.lineTo(bcx+3.4, bcy);
        ctx.moveTo(bcx, bcy-3.4); ctx.lineTo(bcx, bcy+3.4);
        ctx.stroke();
      } else if (br.type === 'widen'){
        ctx.fillStyle = '#27ae60';
        ctx.fillRect(br.x, br.y, br.w, br.h);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(bcx-3.2, bcy-1.1, 6.4, 2.2);
      } else if (br.type === 'armor'){
        var dmg = br.maxHp - br.hp;
        var shades = ['#8b95a1', '#7d8692', '#6f7783'];
        ctx.fillStyle = shades[Math.min(2, dmg)];
        ctx.fillRect(br.x, br.y, br.w, br.h);
        // 裂纹随受损加深
        ctx.fillStyle = 'rgba(15,17,20,.6)';
        if (dmg >= 1){ ctx.fillRect(br.x+1.5, br.y+2, 4.5, 1.4); ctx.fillRect(br.x+1.5, br.y+2, 1.4, 4.5); }
        if (dmg >= 2){ ctx.fillRect(br.x+br.w-6, br.y+br.h-3.4, 4.5, 1.4); ctx.fillRect(br.x+br.w-3.4, br.y+br.h-6, 1.4, 4.5); }
        if (dmg >= 3){ ctx.fillRect(br.x+br.w/2-2.5, br.y+br.h/2-0.7, 5, 1.4); }
      } else if (br.type === 'core'){
        ctx.fillStyle = '#ffc93c';
        ctx.fillRect(br.x, br.y, br.w, br.h);
        ctx.fillStyle = '#e8a812';
        ctx.fillRect(br.x+2.5, br.y+2.5, br.w-5, br.h-5);
        ctx.fillStyle = '#fff3c4';
        var pr2 = 1.5 + Math.sin(now/300)*0.5;
        ctx.beginPath(); ctx.arc(bcx, bcy, Math.max(1, pr2), 0, Math.PI*2); ctx.fill();
      } else {
        ctx.fillStyle = br.color;
        ctx.fillRect(br.x, br.y, br.w, br.h);
      }
    }
    // 钢块：深灰小方格，中心一个暗色小点，扁平无立体感
    for (var j=0;j<S.steels.length;j++){
      var st = S.steels[j];
      ctx.fillStyle = '#4a5058';
      ctx.fillRect(st.x, st.y, st.w, st.h);
      ctx.fillStyle = 'rgba(0,0,0,.35)';
      ctx.fillRect(st.x + st.w/2 - 1, st.y + st.h/2 - 1, 2, 2);
    }

    // 挡板
    var px = S.paddleX - PADDLE_W/2;
    ctx.fillStyle = '#fa8577';
    roundRect(px, PADDLE_Y, PADDLE_W, PADDLE_H, PADDLE_R);
    ctx.fill();

    // 瞄准 / 下落轨迹：淡灰白小圆点。发球前向上瞄准；飞行中只在球下落向挡板时显示落点预测，球接触挡板弹起上升后隐藏
    // 沿方向步进生成点状轨迹的点位：遇左右墙不停止，像真实球反弹一样水平分量
    // 取反、在墙壁处折向继续延伸（可多次折线），直到碰到钢块、存活砖块或顶部
    // 边界才停住。只做视觉提示，不影响真实碰撞。
    function traceDots(x, y, dx, dy){
      var pts = [];
      var step = 3, traveled = 0, nextDot = 14;
      var px = x, py = y;
      for (var g = 0; g < 1200; g++){
        px += dx*step; py += dy*step; traveled += step;
        if (px <= BALL_R){ px = BALL_R; dx = Math.abs(dx); }
        else if (px >= W - BALL_R){ px = W - BALL_R; dx = -Math.abs(dx); }
        if (py <= BALL_R + 1 || py >= H - 1) break;
        if (py >= GOY && py < GOY + ROWS*CELL && px >= GOX && px < GOX + COLS*CELL){
          var cc = Math.floor((px - GOX)/CELL), rr = Math.floor((py - GOY)/CELL);
          var cell = grid[rr] && grid[rr][cc];
          if (cell && (cell.kind === 'steel' || (cell.kind === 'brick' && cell.ref.alive))) break;
        }
        if (traveled >= nextDot){
          nextDot += 14;
          pts.push({ x: px, y: py });
        }
      }
      return pts;
    }
    function drawDotted(ball, dx, dy){
      var pts = traceDots(ball.x, ball.y, dx, dy);
      ctx.fillStyle = 'rgba(208,214,220,.5)';
      for (var i = 0; i < pts.length; i++){
        ctx.beginPath();
        ctx.arc(pts[i].x, pts[i].y, 1.7, 0, Math.PI*2);
        ctx.fill();
      }
    }
    // 反弹瞄准线：球下落向挡板时，先按当前速度直线预测落点（遇左右墙反射折算），
    // 再按落点相对挡板中心的偏移算反弹角（中点正上、边缘最大 60°），从挡板上的落点
    // 出发沿反弹方向向上画点状线：碰到左右墙像真实反弹一样折向继续延伸（可多次折线），
    // 碰到钢块/砖块/顶部边界才停住。落点在挡板外（会漏球）则不画。
    // 线的方向向上，和球的下落方向相反；球上升时不画。
    function drawReboundDots(ball){
      var sp = Math.sqrt(ball.vx*ball.vx + ball.vy*ball.vy);
      if (sp <= 0 || ball.vy <= 0) return;
      var floorY = PADDLE_Y - BALL_R;
      if (ball.y >= floorY) return;
      // 1) 预测落点 x：沿当前速度步进，遇左右墙翻转 dx，直到到达挡板高度
      var dx = ball.vx/sp, dy = ball.vy/sp;
      var x = ball.x, y = ball.y, step = 3, guard = 0;
      while (y < floorY && guard++ < 3000){
        x += dx*step; y += dy*step;
        if (x <= BALL_R){ x = BALL_R; dx = Math.abs(dx); }
        else if (x >= W - BALL_R){ x = W - BALL_R; dx = -Math.abs(dx); }
      }
      var landX = x;
      // 2) 落点在挡板可接范围内才画（与挡板碰撞判定一致的两侧余量）
      var pl = S.paddleX - PADDLE_W/2 - BALL_R, prr = S.paddleX + PADDLE_W/2 + BALL_R;
      if (landX < pl || landX > prr) return;
      // 3) 反弹角：与真实反弹同一公式，偏移越大角度越大，最大偏离竖直 60°
      var off = clamp((landX - S.paddleX)/(PADDLE_W/2), -1, 1);
      var ang = off * MAX_ANGLE;
      var rdx = Math.sin(ang), rdy = -Math.cos(ang);
      // 4) 从落点出发向上画点状线：遇左右墙折线继续延伸，遇钢块/砖块/顶部边界停住
      var sx = landX, sy = PADDLE_Y - BALL_R - 1;
      var pts = traceDots(sx, sy, rdx, rdy);
      ctx.fillStyle = 'rgba(208,214,220,.5)';
      for (var pi = 0; pi < pts.length; pi++){
        ctx.beginPath();
        ctx.arc(pts[pi].x, pts[pi].y, 1.7, 0, Math.PI*2);
        ctx.fill();
      }
    }
    if (AIM.on && S.mode === 'serve' && S.balls.length){
      // 发球前：保留原来的向上瞄准点状线（瞄准线开关关着时整段不画）
      drawDotted(S.balls[0], 0, -1);
    } else if (AIM.on && S.mode === 'play' && S.balls.length){
      // 飞行中：只给下落的主球画反弹瞄准线（从挡板向上），上升的球不画
      for (var di = 0; di < S.balls.length; di++){
        var db = S.balls[di];
        if (db.stuck || db.vy <= 0) continue;
        drawReboundDots(db);
        break;
      }
    }

    // 发球状态：提示圆环 + 提示字
    if (S.mode === 'serve' && S.balls.length){
      var sb = S.balls[0];
      ctx.save();
      var pr = 11 + Math.sin(now/260)*3;
      ctx.strokeStyle = 'rgba(255,255,255,.75)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(sb.x, sb.y, pr, 0, Math.PI*2);
      ctx.stroke();
      ctx.restore();
      // 发球提示文字不再压在挡板上：手机端显示在场地外的控制条里，电脑端看底部说明
    }

    // 球（带淡灰短轨迹）；只碰钢块接近 30 秒时变淡示警
    for (var k=0;k<S.balls.length;k++){
      var b = S.balls[k];
      var alpha = 1;
      if (!b.stuck && b.steelMs > STEEL_FADE_AT){
        alpha = 1 - 0.75 * ((b.steelMs - STEEL_FADE_AT)/(STEEL_DEAD_AT - STEEL_FADE_AT));
      }
      ctx.save();
      ctx.globalAlpha = Math.max(0.2, alpha);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.arc(b.x, b.y, BALL_R, 0, Math.PI*2);
      ctx.fill();
      ctx.restore();
    }
  }

  /* ================= 主循环 ================= */
  var lastTs = 0;
  function loop(ts){
    requestAnimationFrame(loop);
    if (!lastTs) lastTs = ts;
    var dtMs = Math.min(50, ts - lastTs);
    lastTs = ts;

    // 键盘移动
    if ((S.mode === 'play' || S.mode === 'serve') && (keys.left || keys.right)){
      var dir = (keys.right?1:0) - (keys.left?1:0);
      S.paddleX = clamp(S.paddleX + dir * PADDLE_SPEED * (dtMs/1000), PADDLE_W/2, W - PADDLE_W/2);
    }

    if (S.mode === 'play'){
      S.elapsed += dtMs; // 计时走真实时间，暂停即停表；加速只加快球速
      physics(dtMs);
      // 轨迹记录
      S.balls.forEach(function(b){
        if (b.stuck) { b.trail.length = 0; return; }
        b.trail.push({x:b.x, y:b.y});
        var maxTrail = S.balls.length > 12 ? 3 : 6;
        while (b.trail.length > maxTrail) b.trail.shift();
      });
      updateHUD();
    } else if (S.mode === 'serve' || S.mode === 'card'){
      var sb = S.balls[0];
      if (sb){ sb.x = S.paddleX; sb.y = PADDLE_Y - BALL_R - 1; }
      updateHUD();
    }
    draw(ts);
    drawMGUI();
  }

  /* ================= 尺寸自适应 ================= */
  function resize(){
    var info = null;
    try{ info = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync(); }catch(e){}
    if(!info) info = {windowWidth:390, windowHeight:844, pixelRatio:2};
    MG.winW = info.windowWidth; MG.winH = info.windowHeight; MG.dpr = info.pixelRatio || 1;
    try{ window.devicePixelRatio = MG.dpr; }catch(e){}
    var wantW = Math.round(MG.winW * MG.dpr), wantH = Math.round(MG.winH * MG.dpr);
    try{ canvas.width = wantW; canvas.height = wantH; }catch(e){}
    var cw = canvas.width || wantW, ch = canvas.height || wantH;
    var s = Math.min(cw / W, ch / H);
    MG.scale = s; MG.ox = (cw - W*s)/2; MG.oy = (ch - H*s)/2;
    ctx.setTransform(s, 0, 0, s, MG.ox, MG.oy);
  }

  function toLogical(e){
    var cx = e.clientX || 0, cy = e.clientY || 0;
    return { x: (cx * MG.dpr - MG.ox) / MG.scale, y: (cy * MG.dpr - MG.oy) / MG.scale };
  }

  /* ================= 操作：拖动（相对）/ 鼠标移动 / 键盘 ================= */
  var pointer = { active:false, lastX:null, type:'touch' };
  var tap = { x:0, y:0, moved:false };   // 触摸点按判定：几乎没移动才算点按
  var keys = { left:false, right:false };

  // 阻止长按呼出系统菜单（截屏/复制等），游戏内所有区域统一拦截
  document.addEventListener('contextmenu', function(e){ e.preventDefault(); });

  canvas.addEventListener('pointerdown', function(e){
    e.preventDefault();
    if (SFX.isOn()) SFX.unlock();   // 个别浏览器切后台回来会挂起音频，这里顺手恢复
    canvas.setPointerCapture && canvas.setPointerCapture(e.pointerId);
    pointer.active = true; pointer.lastX = toLogical(e).x; pointer.type = e.pointerType;
    tap.x = e.clientX; tap.y = e.clientY; tap.moved = false;
    // 鼠标保持原有手感：按下即发球；触摸改为抬手时按点按判定发球，拖动只移动挡板、不误发球
    if (e.pointerType === 'mouse' && S.mode === 'serve') launch();
  });
  canvas.addEventListener('pointermove', function(e){
    if (S.mode !== 'play' && S.mode !== 'serve') return;
    if (pointer.active && (Math.abs(e.clientX - tap.x) > 9 || Math.abs(e.clientY - tap.y) > 9)) tap.moved = true;
    var p = toLogical(e);
    if (e.pointerType === 'mouse' && !pointer.active){
      // 鼠标移动：挡板跟随
      S.paddleX = clamp(p.x, PADDLE_W/2, W - PADDLE_W/2);
    } else if (pointer.active && pointer.lastX != null){
      // 任意位置相对拖动：按手指/指针移动量走，手指不挡球
      var dx = p.x - pointer.lastX;
      S.paddleX = clamp(S.paddleX + dx, PADDLE_W/2, W - PADDLE_W/2);
    }
    pointer.lastX = p.x;
  });
  function endPointer(e){
    pointer.active = false; pointer.lastX = null;
  }
  canvas.addEventListener('pointerup', function(e){
    // 触摸：点一下（几乎没拖动）才发球；拖动过只移动挡板
    if (e.pointerType !== 'mouse' && pointer.active && !tap.moved && S.mode === 'serve') launch();
    endPointer(e);
  });
  canvas.addEventListener('pointercancel', endPointer);

  /* ================= 手机控制区：场地外纯色区域相对拖动；点按发球 ================= */
  var padbar  = document.getElementById('padbar');
  var padPtr = { active:false, lastX:null, startX:0, moved:false };
  padbar.addEventListener('pointerdown', function(e){
    e.preventDefault();
    if (SFX.isOn()) SFX.unlock();
    padbar.setPointerCapture && padbar.setPointerCapture(e.pointerId);
    padPtr.active = true; padPtr.lastX = e.clientX; padPtr.startX = e.clientX; padPtr.moved = false;
  });
  padbar.addEventListener('pointermove', function(e){
    if (!padPtr.active) return;
    if (Math.abs(e.clientX - padPtr.startX) > 9) padPtr.moved = true;
    if (S.mode !== 'play' && S.mode !== 'serve'){ padPtr.lastX = e.clientX; return; }
    // 拇指在场地外的纯色控制区上拖动，按与场地相同的比例移动挡板，拇指不进场地
    var rect = padbar.getBoundingClientRect();
    var scale = rect.width > 0 ? W / rect.width : 1;
    S.paddleX = clamp(S.paddleX + (e.clientX - padPtr.lastX) * scale, PADDLE_W/2, W - PADDLE_W/2);
    padPtr.lastX = e.clientX;
  });
  padbar.addEventListener('pointerup', function(e){
    // 点一下控制条（几乎没拖动）发球；拖动过只移动挡板
    if (padPtr.active && !padPtr.moved && S.mode === 'serve') launch();
    padPtr.active = false; padPtr.lastX = null;
  });
  padbar.addEventListener('pointercancel', function(){
    padPtr.active = false; padPtr.lastX = null;
  });
  window.addEventListener('keydown', function(e){
    var k = e.key;
    if (k === 'ArrowLeft' || k === 'a' || k === 'A'){ keys.left = true; e.preventDefault(); }
    else if (k === 'ArrowRight' || k === 'd' || k === 'D'){ keys.right = true; e.preventDefault(); }
    else if (k === ' '){
      e.preventDefault();
      if (S.mode === 'serve') launch();
      else if (S.mode === 'pause') resumeGame();
    }
    else if (k === 'p' || k === 'P' || k === 'Escape'){
      if (S.mode === 'pause') resumeGame(); else pauseGame();
    }
  });
  window.addEventListener('keyup', function(e){
    var k = e.key;
    if (k === 'ArrowLeft' || k === 'a' || k === 'A') keys.left = false;
    if (k === 'ArrowRight' || k === 'd' || k === 'D') keys.right = false;
  });

  /* ================= 按钮 ================= */
  document.getElementById('btnHomeDaily').addEventListener('click', openDaily);
  document.getElementById('btnSelectDaily').addEventListener('click', openDaily);
  document.getElementById('btnHomeStart').addEventListener('click', function(){
    SFX.unlock();
    openLevel(Math.min(effectiveUnlocked(), 100));
  });
  document.getElementById('btnHomeSelect').addEventListener('click', goSelect);
  document.getElementById('btnSelectBack').addEventListener('click', goHome);
  document.getElementById('btnStart').addEventListener('click', startGame);
  document.getElementById('btnStartLevels').addEventListener('click', goSelect);
  document.getElementById('btnAgain').addEventListener('click', restartLevel);
  document.getElementById('btnNext').addEventListener('click', function(){ openLevel(Math.min(100, S.level + 1)); });
  document.getElementById('btnLevelsW').addEventListener('click', goSelect);
  document.getElementById('btnRetryF').addEventListener('click', restartLevel);
  document.getElementById('btnLevelsF').addEventListener('click', goSelect);
  document.getElementById('btnRestartP').addEventListener('click', restartLevel);
  document.getElementById('btnLevelsP').addEventListener('click', goSelect);
  document.getElementById('btnResume').addEventListener('click', resumeGame);
  /* 暂停页两个小开关：名称 + 开/关状态，开关互不影响，各自存本地（音乐开关暂时隐藏，MUSIC 模块保留） */
  function setToggle(btn, on){
    btn.querySelector('.tg-state').textContent = on ? '开' : '关';
    btn.classList.toggle('off', !on);
  }
  var btnSound = document.getElementById('btnSound');
  function syncSoundBtn(){ setToggle(btnSound, SFX.isOn()); }
  btnSound.addEventListener('click', function(){ SFX.toggle(); syncSoundBtn(); });
  syncSoundBtn();
  /* 音乐开关按钮暂时隐藏：btnMusic 元素与接线已移除，MUSIC.toggle()/isOn() 保留在模块内，后期恢复按钮时重新接线 */
  var btnAim = document.getElementById('btnAim');
  function syncAimBtn(){ setToggle(btnAim, AIM.on); }
  btnAim.addEventListener('click', function(){ AIM.toggle(); syncAimBtn(); });
  syncAimBtn();
  document.getElementById('btnQuitP').addEventListener('click', goHome);
  btnPause.addEventListener('click', function(){
    if (S.mode === 'pause') resumeGame(); else pauseGame();
  });
  btnSpeed.addEventListener('click', function(){
    S.speedMul = S.speedMul === 1 ? 2 : (S.speedMul === 2 ? 3 : 1);
    btnSpeed.textContent = '×' + S.speedMul;
  });
  document.addEventListener('visibilitychange', function(){
    if (document.hidden && (S.mode === 'play' || S.mode === 'serve')) pauseGame();
  });


  /* ================= 微信小游戏 Canvas 界面层（移植新增） ================= */
  function mgStrip(s){ return String(s==null?'':s).replace(/<br\s*\/?>/gi,'\n').replace(/<[^>]+>/g,''); }
  function mgWrap(text, per){
    var lines = [], cur = '';
    String(text||'').split('\n').forEach(function(part){
      var s = part;
      while (s.length > per){ lines.push(s.slice(0, per)); s = s.slice(per); }
      lines.push(s);
    });
    return lines;
  }
  function mgText(t, x, y, size, color, align){
    ctx.font = size + 'px sans-serif';
    ctx.textAlign = align || 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color || '#ffffff';
    ctx.fillText(String(t==null?'':t), x, y);
  }
  function mgBtn(x, y, w, h, label, fill, color, action){
    ctx.fillStyle = fill || '#2a2e38';
    roundRect(x, y, w, h, 10); ctx.fill();
    mgText(label, x + w/2, y + h/2, 16, color || '#ffffff', 'center');
    MG.buttons.push({x:x, y:y, w:w, h:h, action:action});
    return {x:x, y:y, w:w, h:h};
  }
  function mgCard(x, y, w, h){
    ctx.fillStyle = '#1c1f28';
    roundRect(x, y, w, h, 16); ctx.fill();
    ctx.strokeStyle = '#333845'; ctx.lineWidth = 1;
    roundRect(x, y, w, h, 16); ctx.stroke();
  }
  function drawMGUI(){
    MG.buttons = [];
    var ov = MG.currentOverlay;
    // 游戏内 HUD（无覆盖层时）
    if (!ov && (S.mode === 'play' || S.mode === 'serve')){
      ctx.fillStyle = 'rgba(0,0,0,0.45)'; ctx.fillRect(0, 0, W, 44);
      mgBtn(8, 8, 44, 26, '暂停', '#2a2e38', '#ffffff', function(){ if (S.mode === 'pause') resumeGame(); else pauseGame(); });
      mgText(hudTime ? hudTime.textContent : fmt(S.elapsed), W/2, 21, 15, '#ffffff', 'center');
      mgBtn(W-52, 8, 44, 26, '×' + S.speedMul, '#2a2e38', '#ffffff', function(){ S.speedMul = S.speedMul === 1 ? 2 : (S.speedMul === 2 ? 3 : 1); });
      var p = Math.floor(ratio()*100);
      ctx.fillStyle = '#2a2e38'; ctx.fillRect(8, 50, W-16, 5);
      ctx.fillStyle = '#ff9a1f'; ctx.fillRect(8, 50, (W-16)*p/100, 5);
      mgText((hudSub ? hudSub.textContent : '') + '  ' + p + '%  球 ' + S.balls.length, W/2, 68, 12, '#c8cdd8', 'center');
      if (S.mode === 'serve') mgText('点一下发球，拖动移挡板', W/2, 560, 14, '#c8cdd8', 'center');
      return;
    }
    if (MG.showAge){
      ctx.fillStyle = 'rgba(0,0,0,0.65)'; ctx.fillRect(0, 0, W, H);
      mgCard(28, 150, 304, 340);
      mgText(TEXT_CONFIG.ageRating.title, W/2, 184, 24, '#ffffff', 'center');
      mgText(TEXT_CONFIG.ageRating.badge, W/2, 224, 36, '#e8b93a', 'center');
      mgText(TEXT_CONFIG.ageRating.subtitle, W/2, 254, 14, '#ffffff', 'center');
      var ageLines = mgWrap(TEXT_CONFIG.ageRating.body, 19), ayy = 280;
      ageLines.slice(0, 6).forEach(function(l){ mgText(l, W/2, ayy, 13, '#c8cdd8', 'center'); ayy += 20; });
      mgBtn(88, 428, 184, 44, TEXT_CONFIG.ageRating.closeLabel, '#ff7a1a', '#ffffff', function(){ MG.showAge = false; });
      return;
    }
    if (ov === 'ovHome'){
      ctx.fillStyle = '#101218'; ctx.fillRect(0, 0, W, H);
      mgText('解压砖块', W/2, 180, 36, '#ffffff', 'center');
      if (IS_TEST_ENV) mgText('测试环境 · 全部关卡已解锁', W/2, 222, 13, '#e8b93a', 'center');
      mgBtn(60, 300, 240, 48, '开始', '#ff7a1a', '#ffffff', function(){ SFX.unlock(); openLevel(Math.min(effectiveUnlocked(), 100)); });
      mgBtn(60, 364, 240, 48, '选关', '#2a2e38', '#ffffff', function(){ goSelect(); });
      mgBtn(60, 428, 240, 48, '每日关卡 · ' + dailyDateStr(), '#6b4fd8', '#ffffff', function(){ openDaily(); });
      ctx.fillStyle = 'rgba(255,255,255,0.08)';
      roundRect(28, 496, 304, 84, 12); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 1;
      roundRect(28, 496, 304, 84, 12); ctx.stroke();
      mgText(TEXT_CONFIG.healthPrompt.title, W/2, 512, 12, '#e8b93a', 'center');
      var antiLines = mgWrap(TEXT_CONFIG.healthPrompt.body, 24), ay = 532;
      antiLines.forEach(function(l){ mgText(l, W/2, ay, 11, '#c8cdd8', 'center'); ay += 17; });
      mgText(TEXT_CONFIG.storageNote, W/2, 598, 12, '#8a90a0', 'center');
      return;
    }
    if (ov === 'ovSelect'){
      ctx.fillStyle = '#101218'; ctx.fillRect(0, 0, W, H);
      mgText('选关', W/2, 36, 24, '#ffffff', 'center');
      var cleared = 0; for (var k=1;k<=100;k++){ if (PROG.best[k] != null) cleared++; }
      mgText('已通关 ' + cleared + ' / 100 关', W/2, 64, 13, '#c8cdd8', 'center');
      if (IS_TEST_ENV) mgText('测试环境 · 全部关卡已解锁', W/2, 120, 12, '#e8b93a', 'center');
      mgBtn(12, 84, 100, 36, '每日关卡', '#6b4fd8', '#ffffff', function(){ openDaily(); });
      mgBtn(248, 84, 100, 36, '返回', '#2a2e38', '#ffffff', function(){ goHome(); });
      var per = 20, start = MG.selPage * per + 1;
      for (var i=0;i<per;i++){
        var n = start + i; if (n > 100) break;
        var col = i % 5, row = Math.floor(i / 5);
        var x = 12 + col * 68, y = 132 + row * 68;
        var locked = n > effectiveUnlocked(), fort = (n % 10 === 0);
        ctx.fillStyle = locked ? '#1c1f28' : (fort ? '#3a2c10' : '#2a2e38');
        roundRect(x, y, 62, 62, 10); ctx.fill();
        if (fort && !locked){ ctx.strokeStyle = '#e8b93a'; ctx.lineWidth = 2; roundRect(x, y, 62, 62, 10); ctx.stroke(); }
        if (locked){ mgText('锁', x+31, y+24, 15, '#8a90a0', 'center'); }
        else {
          mgText(n, x+31, y+22, 16, '#ffffff', 'center');
          if (fort) mgText('要塞', x+31, y+40, 11, '#e8b93a', 'center');
          else if (PROG.best[n] != null) mgText(fmt(PROG.best[n]), x+31, y+42, 10, '#c8cdd8', 'center');
          (function(nn){ MG.buttons.push({x:x, y:y, w:62, h:62, action:function(){ openLevel(nn); }}); })(n);
        }
        if (fort && locked) mgText('要塞', x+31, y+44, 11, '#8a90a0', 'center');
      }
      mgBtn(12, 560, 100, 40, '上一页', '#2a2e38', '#ffffff', function(){ MG.selPage = Math.max(0, MG.selPage-1); });
      mgText('第 ' + (MG.selPage+1) + ' / 5 页', W/2, 580, 13, '#c8cdd8', 'center');
      mgBtn(248, 560, 100, 40, '下一页', '#2a2e38', '#ffffff', function(){ MG.selPage = Math.min(4, MG.selPage+1); });
      return;
    }
    if (ov === 'ovStart'){
      ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, W, H);
      mgCard(28, 110, 304, 380);
      mgText(cardTag ? cardTag.textContent : '', W/2, 140, 13, '#ff9a1f', 'center');
      mgText(cardTitle ? cardTitle.textContent : '', W/2, 168, 22, '#ffffff', 'center');
      var lines = mgWrap(cardDesc ? cardDesc.textContent : '', 19), yy = 200;
      lines.slice(0, 4).forEach(function(l){ mgText(l, W/2, yy, 13, '#c8cdd8', 'center'); yy += 20; });
      var gl = mgWrap(mgStrip(cardGoal ? cardGoal.innerHTML : ''), 19);
      gl.slice(0, 5).forEach(function(l){ mgText(l, W/2, yy, 13, '#ffffff', 'center'); yy += 20; });
      mgText(cardTiny ? cardTiny.textContent : '点开始后才计时', W/2, 440, 12, '#8a90a0', 'center');
      mgBtn(48, 452, 120, 44, '开始', '#ff7a1a', '#ffffff', function(){ startGame(); });
      mgBtn(192, 452, 120, 44, '回选关', '#2a2e38', '#ffffff', function(){ goSelect(); });
      return;
    }
    if (ov === 'ovPause'){
      ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, W, H);
      mgCard(48, 140, 264, 360);
      mgText('暂停', W/2, 174, 24, '#ffffff', 'center');
      mgBtn(68, 200, 224, 44, '继续', '#ff7a1a', '#ffffff', function(){ resumeGame(); });
      mgBtn(68, 256, 224, 44, '重玩', '#2a2e38', '#ffffff', function(){ restartLevel(); });
      mgBtn(68, 312, 224, 44, '选关', '#2a2e38', '#ffffff', function(){ goSelect(); });
      mgBtn(68, 368, 106, 40, '音效 ' + (SFX.isOn() ? '开' : '关'), '#2a2e38', '#ffffff', function(){ SFX.toggle(); });
      mgBtn(186, 368, 106, 40, '瞄准线 ' + (AIM.on ? '开' : '关'), '#2a2e38', '#ffffff', function(){ AIM.toggle(); });
      mgBtn(68, 416, 224, 40, TEXT_CONFIG.ageRating.buttonLabel, '#2a2e38', '#ffffff', function(){ MG.showAge = true; });
      mgBtn(68, 464, 224, 28, '退出回开始页', '#1c1f28', '#c8cdd8', function(){ goHome(); });
      return;
    }
    if (ov === 'ovWin'){
      ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, W, H);
      mgCard(28, 140, 304, 340);
      mgText(document.getElementById('winTitle').textContent, W/2, 176, 22, '#ffffff', 'center');
      var wl = mgWrap(document.getElementById('winDesc').textContent, 19), wy = 206;
      wl.slice(0, 3).forEach(function(l){ mgText(l, W/2, wy, 13, '#c8cdd8', 'center'); wy += 20; });
      mgText('进度 ' + document.getElementById('winPct').textContent + '  用时 ' + document.getElementById('winTime').textContent, W/2, wy + 10, 14, '#ffffff', 'center');
      mgText(document.getElementById('winBest').textContent + ' ' + document.getElementById('winRecord').textContent, W/2, wy + 34, 12, '#8a90a0', 'center');
      var showNext = !document.getElementById('btnNext').hidden;
      if (showNext) mgBtn(48, 380, 120, 44, '下一关', '#ff7a1a', '#ffffff', function(){ openLevel(Math.min(100, S.level + 1)); });
      mgBtn(showNext ? 192 : 120, 380, 120, 44, '重玩', '#2a2e38', '#ffffff', function(){ restartLevel(); });
      mgBtn(48, 436, 264, 36, '回选关', '#1c1f28', '#c8cdd8', function(){ goSelect(); });
      return;
    }
    if (ov === 'ovFail'){
      ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(0, 0, W, H);
      mgCard(28, 160, 304, 280);
      mgText('发球用完了', W/2, 196, 22, '#ffffff', 'center');
      var fl = mgWrap(document.getElementById('failDesc').textContent, 19), fy = 226;
      fl.slice(0, 4).forEach(function(l){ mgText(l, W/2, fy, 13, '#c8cdd8', 'center'); fy += 20; });
      mgBtn(48, 330, 120, 44, '重玩', '#ff7a1a', '#ffffff', function(){ restartLevel(); });
      mgBtn(192, 330, 120, 44, '回选关', '#2a2e38', '#ffffff', function(){ goSelect(); });
      return;
    }
  }
  function mgKeyFromCode(code){
    if (code === 37) return 'ArrowLeft';
    if (code === 39) return 'ArrowRight';
    if (code === 32) return ' ';
    if (code === 80) return 'p';
    if (code === 27) return 'Escape';
    if (code === 65) return 'a';
    if (code === 68) return 'd';
    return null;
  }
  function mgTouch(kind, e){
    var t = (e.touches && e.touches[0]) || (e.changedTouches && e.changedTouches[0]) || e;
    var cx = t.clientX || 0, cy = t.clientY || 0;
    var lg = toLogical({clientX:cx, clientY:cy});
    if (kind === 'start'){
      MG.pendingUI = null; MG.touchMoved = false; MG.touchStartX = cx; MG.touchStartY = cy;
      var hit = null;
      for (var i=0;i<MG.buttons.length;i++){
        var b = MG.buttons[i];
        if (lg.x >= b.x && lg.x <= b.x + b.w && lg.y >= b.y && lg.y <= b.y + b.h){ hit = b; break; }
      }
      if (hit){ MG.pendingUI = hit; return; }
      var h = MG.canvasEl && MG.canvasEl._h;
      if (h && h.pointerdown) h.pointerdown({pointerType:'touch', pointerId:1, clientX:cx, clientY:cy, preventDefault:function(){}});
      return;
    }
    if (kind === 'move'){
      if (Math.abs(cx - MG.touchStartX) > 9 || Math.abs(cy - MG.touchStartY) > 9) MG.touchMoved = true;
      if (MG.pendingUI) return;
      var hm = MG.canvasEl && MG.canvasEl._h;
      if (hm && hm.pointermove) hm.pointermove({pointerType:'touch', pointerId:1, clientX:cx, clientY:cy, preventDefault:function(){}});
      return;
    }
    if (kind === 'end'){
      if (MG.pendingUI){
        if (!MG.touchMoved && MG.pendingUI.action) MG.pendingUI.action();
        MG.pendingUI = null; return;
      }
      var hu = MG.canvasEl && MG.canvasEl._h;
      if (hu && hu.pointerup) hu.pointerup({pointerType:'touch', pointerId:1, clientX:cx, clientY:cy, preventDefault:function(){}});
      return;
    }
    if (kind === 'cancel'){
      MG.pendingUI = null;
      var hc = MG.canvasEl && MG.canvasEl._h;
      if (hc && hc.pointercancel) hc.pointercancel({pointerType:'touch', pointerId:1, clientX:cx, clientY:cy, preventDefault:function(){}});
    }
  }
  try{
    if (wx.onTouchStart) wx.onTouchStart(function(e){ mgTouch('start', e); });
    if (wx.onTouchMove) wx.onTouchMove(function(e){ mgTouch('move', e); });
    if (wx.onTouchEnd) wx.onTouchEnd(function(e){ mgTouch('end', e); });
    if (wx.onTouchCancel) wx.onTouchCancel(function(e){ mgTouch('cancel', e); });
    if (wx.onWindowResize) wx.onWindowResize(function(){ resize(); });
    if (wx.onHide) wx.onHide(function(){ if (S.mode === 'play' || S.mode === 'serve') pauseGame(); });
    if (wx.onShow) wx.onShow(function(){ try{ resize(); }catch(err){} });
    if (wx.onKeyDown) wx.onKeyDown(function(e){ var k = mgKeyFromCode(e.keyCode); if (k && MG.windowHandlers.keydown) MG.windowHandlers.keydown({key:k, preventDefault:function(){}}); });
    if (wx.onKeyUp) wx.onKeyUp(function(e){ var k = mgKeyFromCode(e.keyCode); if (k && MG.windowHandlers.keyup) MG.windowHandlers.keyup({key:k, preventDefault:function(){}}); });
  }catch(err){}

  /* ================= 启动 ================= */
  loadLevel(1);
  refreshDailyUI();
  S.mode = 'menu';
  showOverlay(ovHome);
  requestAnimationFrame(function(){ resize(); });
  requestAnimationFrame(loop);
})();
