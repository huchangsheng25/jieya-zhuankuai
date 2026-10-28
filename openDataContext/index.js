// 好友排行榜（开放数据域）。
// 与主域完全隔离：不能 require 主域代码，只能用有限 API；不能向主域发消息，
// 只能把榜画到共享画布上，由主域每帧 drawImage 贴到好友榜面板里。
// 主域发来的消息只有原始值：{ cmd:'load', key:'lv_12', myScore:'3163', level:'12' }，
// key 是本关托管键，myScore 是玩家本关本地最佳用时（百分之一秒字符串，越小越好）。
// 这里用 wx.getFriendCloudStorage 拉取同玩好友的托管数据：只有托管过数据的用户
// 才会被视为玩过本游戏，才会出现在返回数组里。返回顺序不保证已排序，这里自行按用时升序排。
(function () {
  var canvas = null, ctx = null;
  try {
    canvas = wx.getSharedCanvas();
    ctx = canvas.getContext('2d');
  } catch (e) { canvas = null; ctx = null; }

  var state = { key: '', myScore: '', level: '', status: 'idle', rows: [], version: 0 };
  var avatars = {}; // avatarUrl -> { state: 'loading'|'ok'|'error', img: Image }

  function toCs(v) {
    var n = parseInt(v, 10);
    return isFinite(n) ? n : null;
  }
  function fmtCs(cs) {
    if (cs == null || !isFinite(cs)) return '—';
    var m = Math.floor(cs / 6000);
    var s = Math.floor((cs % 6000) / 100);
    var c = cs % 100;
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return m + ':' + p(s) + '.' + p(c);
  }
  function truncate(text, maxW) {
    if (!ctx) return text;
    if (ctx.measureText(text).width <= maxW) return text;
    while (text.length > 1 && ctx.measureText(text + '…').width > maxW) text = text.slice(0, -1);
    return text + '…';
  }

  function drawAvatar(url, name, x, y, r, version) {
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#3a3f4d';
    ctx.fill();
    var a = url ? avatars[url] : null;
    if (a && a.state === 'ok' && a.img) {
      ctx.clip();
      try { ctx.drawImage(a.img, x - r, y - r, r * 2, r * 2); } catch (e) {}
      ctx.restore();
      ctx.save();
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.restore();
      return;
    }
    if (a && a.state === 'loading') {
      // 头像还在加载：先画占位，等 onload 后重绘。
      ctx.fillStyle = '#c8cdd8';
      ctx.font = 'bold ' + Math.round(r) + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      try { ctx.fillText('?', x, y + 2); } catch (e) {}
      ctx.restore();
      return;
    }
    if (a && a.state === 'error') {
      ctx.fillStyle = '#c8cdd8';
      ctx.font = 'bold ' + Math.round(r) + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      try { ctx.fillText((name || '?').slice(0, 1), x, y + 2); } catch (e) {}
      ctx.restore();
      return;
    }
    // 首次见到这个头像地址：尝试加载，失败时画首字占位。加载结果回来后按 version 重绘。
    if (url) {
      avatars[url] = { state: 'loading', img: null };
      try {
        if (typeof wx.createImage === 'function') {
          var img = wx.createImage();
          img.onload = function () {
            avatars[url] = { state: 'ok', img: img };
            if (version === state.version) draw();
          };
          img.onerror = function () {
            avatars[url] = { state: 'error', img: null };
            if (version === state.version) draw();
          };
          img.src = url;
        } else {
          avatars[url] = { state: 'error', img: null };
        }
      } catch (e) {
        avatars[url] = { state: 'error', img: null };
      }
      ctx.fillStyle = '#c8cdd8';
      ctx.font = 'bold ' + Math.round(r) + 'px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      try { ctx.fillText((name || '?').slice(0, 1), x, y + 2); } catch (e) {}
    }
    ctx.restore();
  }

  // 头像 onload/onerror 可能在 draw() 中途同步触发重绘：用 drawing 标志把重绘推迟到本轮画完，避免递归中途清屏。
  var drawing = false, pendingRedraw = false;
  function draw() {
    if (drawing) { pendingRedraw = true; return; }
    drawing = true;
    try { drawNow(); } finally { drawing = false; }
    if (pendingRedraw) { pendingRedraw = false; draw(); }
  }
  function drawNow() {
    if (!ctx || !canvas) return;
    var W = canvas.width || 576;
    var H = canvas.height || 600;
    var version = state.version;
    ctx.clearRect(0, 0, W, H);
    ctx.textBaseline = 'middle';

    if (state.status === 'loading') {
      ctx.fillStyle = '#c8cdd8';
      ctx.font = '28px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('加载中…', W / 2, H / 2);
      return;
    }
    if (state.status === 'error') {
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 30px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('好友榜加载失败', W / 2, H / 2 - 30);
      ctx.fillStyle = '#c8cdd8';
      ctx.font = '24px sans-serif';
      ctx.fillText('请确认好友信息授权后，点刷新重试', W / 2, H / 2 + 16);
      return;
    }
    if (state.status === 'ok' && state.rows.length === 0) {
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 30px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('暂无好友上榜', W / 2, H / 2 - 24);
      ctx.fillStyle = '#c8cdd8';
      ctx.font = '24px sans-serif';
      ctx.fillText('好友通关上传成绩后会出现在这里', W / 2, H / 2 + 22);
      return;
    }

    var footerH = 64;
    var top = state.rows.slice(0, 5);
    var rowH = Math.max(60, (H - footerH - 8) / 5);
    for (var i = 0; i < top.length; i++) {
      var row = top[i];
      var cy = 8 + rowH * i + rowH / 2;
      // 名次
      ctx.fillStyle = i === 0 ? '#ffb020' : '#c8cdd8';
      ctx.font = 'bold 30px sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(String(i + 1), 30, cy);
      // 头像
      drawAvatar(row.avatarUrl, row.nickname, 84, cy, 22, version);
      // 昵称（过长截断）
      ctx.fillStyle = '#ffffff';
      ctx.font = '26px sans-serif';
      ctx.textAlign = 'left';
      var maxNameW = W - 84 - 28 - 150;
      ctx.fillText(truncate(row.nickname, maxNameW), 118, cy);
      // 用时，右对齐
      ctx.fillStyle = '#ffb020';
      ctx.font = 'bold 28px sans-serif';
      ctx.textAlign = 'right';
      ctx.fillText(fmtCs(row.cs), W - 20, cy);
      // 分隔线
      if (i < top.length - 1) {
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(20, 8 + rowH * (i + 1), W - 40, 1);
      }
    }
    // 底部：自己的名次 + 上榜好友总数（自己不靠 openid 识别，用主域发来的本地最佳算名次）
    var footerY = H - footerH + 14;
    ctx.textAlign = 'center';
    var myCs = toCs(state.myScore);
    if (myCs != null) {
      var rank = 1;
      for (var j = 0; j < state.rows.length; j++) if (state.rows[j].cs < myCs) rank++;
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 26px sans-serif';
      ctx.fillText('我 · ' + fmtCs(myCs) + ' · 第 ' + rank + ' 名', W / 2, footerY + 10);
    }
    ctx.fillStyle = '#8a90a0';
    ctx.font = '22px sans-serif';
    ctx.fillText('共 ' + state.rows.length + ' 位好友上榜', W / 2, footerY + 40);
  }

  function load() {
    var version = state.version;
    state.status = 'loading';
    draw();
    if (!wx.getFriendCloudStorage) {
      state.status = 'error';
      draw();
      return;
    }
    try {
      wx.getFriendCloudStorage({
        keyList: [state.key],
        success: function (res) {
          if (version !== state.version) return;
          var rows = [];
          var list = (res && res.data) || [];
          for (var i = 0; i < list.length; i++) {
            var item = list[i];
            var kvList = item.KVDataList || [];
            var cs = null;
            for (var k = 0; k < kvList.length; k++) {
              if (kvList[k].key === state.key) { cs = toCs(kvList[k].value); break; }
            }
            if (cs == null) continue; // 没有本关成绩的好友不上榜
            rows.push({
              avatarUrl: item.avatarUrl || '',
              nickname: item.nickname || '微信用户',
              cs: cs
            });
          }
          rows.sort(function (a, b) { return a.cs - b.cs; });
          state.rows = rows;
          state.status = 'ok';
          draw();
        },
        fail: function () {
          if (version !== state.version) return;
          state.status = 'error';
          draw();
        }
      });
    } catch (e) {
      state.status = 'error';
      draw();
    }
  }

  try {
    wx.onMessage(function (data) {
      if (!data || data.cmd !== 'load') return;
      state.key = data.key || '';
      state.myScore = data.myScore || '';
      state.level = data.level || '';
      state.version++;
      load();
    });
  } catch (e) {}
  draw();
})();
