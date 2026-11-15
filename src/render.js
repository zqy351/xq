/* ===================================================================
 * render.js —— 单 Canvas 全量渲染：棋盘 + 棋子立体建模 + 动画
 * ---------------------------------------------------------------
 * 设计要点：
 *  · 棋盘底板（木纹、格线、河界文字、刻度）整张烘焙到离屏 canvas，
 *    主绘制只做一次 drawImage，稳定 60fps。
 *  · 棋子按 7 步绘制烘焙成贴图（14 种棋子各一张），主绘制用 drawImage
 *    + 变形实现选中抬起/走子动画，绝不每帧重算纹理（否则闪烁掉帧）。
 *  · 翻转只改渲染映射，逻辑坐标与 AI 完全不受影响。
 * ================================================================== */
(function (global) {
  'use strict';

  var Chess = global.Chess;
  var R = Chess.Rules;
  var U = Chess.util;
  var RD = Chess.Render = {};

  /* ---------- 主题色 ---------- */
  RD.COLOR = {
    tableTop: '#171a1e',
    tableBottom: '#232a2f',
    boardLight: '#f2dbaa',
    boardDark: '#d6ac6c',
    frameOuter: '#5c3d1e',
    frameInner: '#6b4a25',
    line: '#6b4a25',
    riverText: '#7a5427',
    tickMark: '#7a5427',
    lastMove: '#d8a44a',
    legalDot: 'rgba(46,38,26,0.42)',
    captureRing: '#c0392b',
    selectGlow: '#d8a44a'
  };

  /* ---------- 尺寸常量 ---------- */
  var BOARD_COLS = 9;
  var BOARD_ROWS = 10;

  /**
   * 渲染器
   * @param {HTMLCanvasElement} canvas
   * @param {Object} opts { state: function 返回渲染所需状态, onAnimDone }
   */
  function Renderer(canvas, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.opts = opts || {};
    this.dpr = (global.devicePixelRatio || 1);
    if (this.dpr > 2.5) { this.dpr = 2.5; }

    this.track = 44;
    this.pad = 44;
    this.W = 440;
    this.H = 484;

    this.flip = false;              /* 是否黑方视角 */
    this.flipAnim = null;           /* {t0, dur, snap} */
    this.moveAnims = [];            /* 走子动画 */
    this.pieceTextures = {};        /* 'K' -> canvas */
    this.boardTex = null;           /* 棋盘烘焙图 */
    this.assetsReady = false;
    this._rafId = 0;
    this._lastTs = 0;
    this.fps = 0;
    this._fpsAcc = 0;
    this._fpsCount = 0;
  }

  /* ==================== 尺寸与资源 ==================== */

  /**
   * 根据可用空间重算尺寸并重建资源
   * @param {number} availW 可用宽（CSS px）
   * @param {number} availH 可用高（CSS px）
   */
  Renderer.prototype.resize = function resize(availW, availH) {
    var minTrack = 26;
    var t = Math.min(availW / 10, availH / 11);
    if (!isFinite(t) || t <= 0) { t = 40; }
    t = Math.floor(t * 2) / 2;                  /* 取整避免半像素模糊 */
    if (t < minTrack) { t = minTrack; }
    /* 保底后若仍超出可用宽度，则退让，宁可小一点也绝不出现横向滚动 */
    if (t * 10 > availW + 0.5) {
      t = Math.max(18, Math.floor((availW / 10) * 2) / 2);
    }
    this.track = t;
    this.pad = this.track;
    this.W = 8 * this.track + 2 * this.pad;
    this.H = 9 * this.track + 2 * this.pad;

    var dpr = this.dpr;
    this.canvas.width = Math.round(this.W * dpr);
    this.canvas.height = Math.round(this.H * dpr);
    this.canvas.style.width = this.W + 'px';
    this.canvas.style.height = this.H + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.imageSmoothingEnabled = true;
    if (this.ctx.imageSmoothingQuality !== undefined) {
      this.ctx.imageSmoothingQuality = 'high';
    }

    this.buildAssets();
    this.render();
  };

  /** 生成棋盘底板 + 全部棋子纹理 */
  Renderer.prototype.buildAssets = function buildAssets() {
    this.buildBoardTexture();
    this.buildPieceTextures();
    this.assetsReady = true;
  };

  /* ---------- 坐标映射（含翻转） ---------- */

  /** 逻辑 (col,row) → 屏幕 (x,y) */
  Renderer.prototype.point = function point(col, row) {
    var c = this.flip ? (8 - col) : col;
    var r = this.flip ? (9 - row) : row;
    return { x: this.pad + c * this.track, y: this.pad + r * this.track };
  };

  /** 屏幕 (x,y) → 逻辑 (col,row)，返回最近交叉点与距离 */
  Renderer.prototype.unpoint = function unpoint(x, y) {
    var sc = Math.round((x - this.pad) / this.track);
    var sr = Math.round((y - this.pad) / this.track);
    if (sc < 0 || sc > 8 || sr < 0 || sr > 9) { return null; }
    var col = this.flip ? (8 - sc) : sc;
    var row = this.flip ? (9 - sr) : sr;
    var px = this.pad + sc * this.track;
    var py = this.pad + sr * this.track;
    var dist = Math.sqrt((x - px) * (x - px) + (y - py) * (y - py));
    return { col: col, row: row, dist: dist, sx: px, sy: py };
  };

  /* ==================== 棋盘烘焙 ==================== */

  Renderer.prototype.buildBoardTexture = function buildBoardTexture() {
    var dpr = this.dpr;
    var t = this.track;
    var W = this.W, H = this.H;
    var cv = U.offscreen(W * dpr, H * dpr);
    var c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);

    /* --- 桌面背景：深色渐变 + 棋盘下方极淡光晕 --- */
    var bg = c.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, RD.COLOR.tableTop);
    bg.addColorStop(1, RD.COLOR.tableBottom);
    c.fillStyle = bg;
    c.fillRect(0, 0, W, H);

    var halo = c.createRadialGradient(W / 2, H * 0.62, t * 0.6, W / 2, H * 0.62, W * 0.95);
    halo.addColorStop(0, 'rgba(255,235,190,0.075)');
    halo.addColorStop(0.55, 'rgba(255,225,170,0.030)');
    halo.addColorStop(1, 'rgba(255,220,160,0)');
    c.fillStyle = halo;
    c.fillRect(0, 0, W, H);

    /* --- 棋盘底板尺寸（含外框留白） --- */
    var bx = this.pad * 0.34;                    /* 底板左边缘 */
    var by = this.pad * 0.34;
    var bw = W - bx * 2;
    var bh = H - by * 2;
    var radius = t * 0.10;

    /* 底板外投影，落在桌面 */
    c.save();
    c.shadowColor = 'rgba(0,0,0,0.35)';
    c.shadowBlur = 24;
    c.shadowOffsetY = 6;
    this._roundRect(c, bx, by, bw, bh, radius);
    c.fillStyle = '#d6ac6c';
    c.fill();
    c.restore();

    /* 木色垂直渐变 */
    var wood = c.createLinearGradient(0, by, 0, by + bh);
    wood.addColorStop(0, RD.COLOR.boardLight);
    wood.addColorStop(0.5, '#e8cb96');
    wood.addColorStop(1, RD.COLOR.boardDark);
    c.save();
    this._roundRect(c, bx, by, bw, bh, radius);
    c.clip();
    c.fillStyle = wood;
    c.fillRect(bx, by, bw, bh);

    /* 木纹层 1：低频正弦纹理（固定种子） */
    var seed = 20260101;
    var rnd = U.mulberry32(seed);
    c.globalAlpha = 0.10;
    for (var i = 0; i < 62; i++) {
      var y0 = by + rnd() * bh;
      var amp = 2 + rnd() * 5;
      var freq = 0.008 + rnd() * 0.014;
      var phase = rnd() * Math.PI * 2;
      c.strokeStyle = rnd() > 0.5 ? '#8a5f2c' : '#f7e6c0';
      c.lineWidth = 0.7 + rnd() * 1.6;
      c.beginPath();
      for (var x = bx; x <= bx + bw; x += 6) {
        var yy = y0 + Math.sin((x - bx) * freq + phase) * amp;
        if (x === bx) { c.moveTo(x, yy); } else { c.lineTo(x, yy); }
      }
      c.stroke();
    }

    /* 木纹层 2：细噪声 */
    c.globalAlpha = 0.055;
    for (var n = 0; n < 1400; n++) {
      var nx = bx + rnd() * bw;
      var ny = by + rnd() * bh;
      c.fillStyle = rnd() > 0.5 ? '#5c3d1e' : '#fff4d8';
      c.fillRect(nx, ny, 1 + rnd(), 1);
    }
    c.globalAlpha = 1;

    /* 内侧一圈极淡内阴影，做厚度 */
    var inner = c.createLinearGradient(0, by, 0, by + bh);
    inner.addColorStop(0, 'rgba(90,60,25,0.10)');
    inner.addColorStop(0.10, 'rgba(90,60,25,0)');
    inner.addColorStop(0.90, 'rgba(90,60,25,0)');
    inner.addColorStop(1, 'rgba(90,60,25,0.12)');
    c.fillStyle = inner;
    c.fillRect(bx, by, bw, bh);
    c.restore();

    /* --- 棋盘框（双线） --- */
    var gx0 = this.pad, gy0 = this.pad;
    var gx1 = this.pad + 8 * t, gy1 = this.pad + 9 * t;
    c.strokeStyle = RD.COLOR.frameOuter;
    c.lineWidth = 1.6;
    c.strokeRect(gx0 - t * 0.20, gy0 - t * 0.20,
      (gx1 - gx0) + t * 0.40, (gy1 - gy0) + t * 0.40);
    c.strokeStyle = RD.COLOR.frameInner;
    c.lineWidth = 3;
    c.strokeRect(gx0 - t * 0.09, gy0 - t * 0.09,
      (gx1 - gx0) + t * 0.18, (gy1 - gy0) + t * 0.18);

    /* --- 内场格线 --- */
    c.strokeStyle = RD.COLOR.line;
    c.lineWidth = 1.2;
    c.lineJoin = 'miter';

    /* 竖线：9 条，河界处不断 */
    for (var col = 0; col < 9; col++) {
      var x = gx0 + col * t;
      if (col === 0 || col === 8) {
        c.beginPath();
        c.moveTo(x, gy0);
        c.lineTo(x, gy1);
        c.stroke();
      } else {
        /* 中间竖线在河界断开 */
        c.beginPath();
        c.moveTo(x, gy0);
        c.lineTo(x, gy0 + 4 * t);
        c.stroke();
        c.beginPath();
        c.moveTo(x, gy0 + 5 * t);
        c.lineTo(x, gy1);
        c.stroke();
      }
    }
    /* 横线：10 条，首末整条，中间仅在两端外延 */
    for (var row = 0; row < 10; row++) {
      var y = gy0 + row * t;
      c.beginPath();
      c.moveTo(gx0, y);
      c.lineTo(gx1, y);
      c.stroke();
    }

    /* --- 九宫斜线 --- */
    c.beginPath();
    /* 黑方九宫 row0..2, col3..5 */
    c.moveTo(gx0 + 3 * t, gy0 + 0);
    c.lineTo(gx0 + 5 * t, gy0 + 2 * t);
    c.moveTo(gx0 + 5 * t, gy0 + 0);
    c.lineTo(gx0 + 3 * t, gy0 + 2 * t);
    /* 红方九宫 row7..9 */
    c.moveTo(gx0 + 3 * t, gy0 + 7 * t);
    c.lineTo(gx0 + 5 * t, gy0 + 9 * t);
    c.moveTo(gx0 + 5 * t, gy0 + 7 * t);
    c.lineTo(gx0 + 3 * t, gy0 + 9 * t);
    c.stroke();

    /* --- 河界文字：楚河 / 漢界 --- */
    var riverY = gy0 + 4.5 * t;
    c.save();
    c.globalAlpha = 0.46;
    c.fillStyle = RD.COLOR.riverText;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    var fontSize = t * 0.66;
    c.font = 'bold ' + fontSize + 'px "KaiTi","STKaiti","楷体","Kaiti SC","Songti SC",serif';
    if (c.letterSpacing !== undefined) {
      try { c.letterSpacing = (t * 0.16) + 'px'; } catch (e) { }
    }
    c.fillText('楚  河', gx0 + 2 * t, riverY);
    c.fillText('漢  界', gx0 + 6 * t, riverY);
    c.restore();

    /* --- 兵位 / 炮位十字花刻度 --- */
    c.save();
    c.globalAlpha = 0.62;
    c.strokeStyle = RD.COLOR.tickMark;
    c.lineWidth = 1.4;
    var tickPositions = [
      /* 兵行（黑 row3 / 红 row6）与炮位（黑 row2 / 红 row7）的传统刻度 */
      [1, 2], [7, 2], [1, 7], [7, 7],
      [0, 3], [2, 3], [4, 3], [6, 3], [8, 3],
      [0, 6], [2, 6], [4, 6], [6, 6], [8, 6]
    ];
    for (var k = 0; k < tickPositions.length; k++) {
      var tc = tickPositions[k][0], tr = tickPositions[k][1];
      var cx2 = gx0 + tc * t, cy2 = gy0 + tr * t;
      var gap = t * 0.13, arm = t * 0.19;
      /* 四个角的小折线（避开棋盘外边缘） */
      var dirs = [
        [-1, -1], [1, -1], [-1, 1], [1, 1]
      ];
      for (var dd = 0; dd < 4; dd++) {
        var dx = dirs[dd][0], dy = dirs[dd][1];
        /* 外边缘不画朝外的折线，避免出界 */
        if (tc === 0 && dx < 0) { continue; }
        if (tc === 8 && dx > 0) { continue; }
        c.beginPath();
        c.moveTo(cx2 + dx * gap, cy2 + dy * gap);
        c.lineTo(cx2 + dx * (gap + arm), cy2 + dy * gap);
        c.moveTo(cx2 + dx * gap, cy2 + dy * gap);
        c.lineTo(cx2 + dx * gap, cy2 + dy * (gap + arm));
        c.stroke();
      }
    }
    c.restore();

    this.boardTex = cv;
  };

  /* ---------- 棋子纹理（7 步立体建模） ---------- */

  Renderer.prototype.buildPieceTextures = function buildPieceTextures() {
    var t = this.track;
    var r = t * 0.42;
    var wall = r * 0.20;                     /* 侧壁厚度 */
    var margin = 4;                          /* 抗锯齿留边 */
    var texW = r * 2 + margin * 2;
    var texH = r * 2 + wall + margin * 2;
    var dpr = this.dpr;

    var chars = ['K', 'A', 'B', 'N', 'R', 'C', 'P'];
    var glyph = { K: '帥', A: '仕', B: '相', N: '馬', R: '車', C: '炮', P: '兵' };
    var glyphLower = { K: '將', A: '士', B: '象', N: '馬', R: '車', C: '砲', P: '卒' };

    for (var i = 0; i < chars.length; i++) {
      var upper = chars[i];
      this.pieceTextures[upper] = this._makePieceTexture(upper, glyph[upper], true, texW, texH, dpr, r, wall, margin);
      this.pieceTextures[upper.toLowerCase()] =
        this._makePieceTexture(upper.toLowerCase(), glyphLower[upper], false, texW, texH, dpr, r, wall, margin);
    }
    this._pieceTexW = texW;
    this._pieceTexH = texH;
    this._pieceR = r;
    this._pieceWall = wall;
  };

  /**
   * 单颗棋子贴图。绘制顺序严格按规格 7 步（投影单独在主绘制里画，
   * 这里从"侧壁"开始，便于选中抬起时投影能独立变化）。
   */
  Renderer.prototype._makePieceTexture = function (key, char, isRed, texW, texH, dpr, r, wall, margin) {
    var cv = U.offscreen(texW * dpr, texH * dpr);
    var c = cv.getContext('2d');
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, texW, texH);

    var cx = margin + r;
    var cyTop = margin + r;                 /* 顶圆圆心 */
    var cyBot = cyTop + wall;               /* 底圆圆心 */

    /* 固定种子，保证每帧/每次重建纹理一致（不闪烁） */
    var rnd = U.mulberry32(isRed ? 991001 : 771177);

    var colTop1 = isRed ? '#fffdf6' : '#f4fbfb';
    var colTop2 = isRed ? '#f3e3c3' : '#d8e6e6';
    var colTop3 = isRed ? '#e0c79c' : '#b9cbcc';
    var colWallDark = isRed ? '#b98a52' : '#8a9698';
    var colWallDeep = isRed ? '#8e5f31' : '#63716f';
    var colStroke = isRed ? '#6b4a25' : '#3c4a4d';
    var colInner = isRed ? '#8a6032' : '#4b5b5e';
    var colText = isRed ? '#a5211b' : '#1d2b31';
    var colTextShadow = isRed ? '#7d1a15' : '#12202a';

    /* ---- 步骤 2：侧壁厚度 ---- */
    /* 底圆 */
    c.beginPath();
    c.arc(cx, cyBot, r, 0, Math.PI * 2);
    c.fillStyle = colWallDark;
    c.fill();

    /* 顶圆与底圆之间的侧面：用垂直渐变填充整块"柱体" */
    var wallGrad = c.createLinearGradient(cx - r, 0, cx + r, 0);
    wallGrad.addColorStop(0, colWallDeep);
    wallGrad.addColorStop(0.18, colWallDark);
    wallGrad.addColorStop(0.62, colWallDark);
    wallGrad.addColorStop(1, colWallDeep);
    c.save();
    c.beginPath();
    c.moveTo(cx - r, cyTop);
    c.lineTo(cx - r, cyBot);
    c.arc(cx, cyBot, r, Math.PI, Math.PI * 2);
    c.lineTo(cx + r, cyTop);
    c.closePath();
    c.fillStyle = wallGrad;
    c.fill();
    c.restore();

    /* 侧面右下更深的暗带（ipso 光照） */
    c.save();
    c.beginPath();
    c.moveTo(cx + r * 0.05, cyTop);
    c.lineTo(cx + r * 0.05, cyBot);
    c.arc(cx, cyBot, r, 0, Math.PI * 0.5, false);
    c.lineTo(cx + r, cyTop);
    c.closePath();
    var darkBand = c.createLinearGradient(cx + r * 0.05, 0, cx + r, 0);
    darkBand.addColorStop(0, 'rgba(0,0,0,0)');
    darkBand.addColorStop(1, 'rgba(0,0,0,0.28)');
    c.fillStyle = darkBand;
    c.fill();
    c.restore();

    /* 左上一条窄亮带 */
    c.save();
    c.beginPath();
    c.moveTo(cx - r, cyTop);
    c.lineTo(cx - r, cyBot);
    c.arc(cx, cyBot, r, Math.PI, Math.PI * 1.5, false);
    c.lineTo(cx - r * 0.55, cyTop);
    c.closePath();
    var lightBand = c.createLinearGradient(cx - r, 0, cx - r * 0.55, 0);
    lightBand.addColorStop(0, 'rgba(255,255,255,0.22)');
    lightBand.addColorStop(1, 'rgba(255,255,255,0)');
    c.fillStyle = lightBand;
    c.fill();
    c.restore();

    /* ---- 步骤 3：顶面（径向渐变，光源左上 45°） ---- */
    var topGrad = c.createRadialGradient(
      cx - r * 0.34, cyTop - r * 0.36, r * 0.10,
      cx, cyTop, r * 1.05
    );
    topGrad.addColorStop(0, colTop1);
    topGrad.addColorStop(0.52, colTop2);
    topGrad.addColorStop(1, colTop3);
    c.beginPath();
    c.arc(cx, cyTop, r, 0, Math.PI * 2);
    c.fillStyle = topGrad;
    c.fill();

    /* ---- 步骤 4：描边（外圈 + 内圈细线） ---- */
    c.beginPath();
    c.arc(cx, cyTop, r - 0.75, 0, Math.PI * 2);
    c.strokeStyle = colStroke;
    c.lineWidth = 1.5;
    c.stroke();

    c.beginPath();
    c.arc(cx, cyTop, r * 0.80, 0, Math.PI * 2);
    c.strokeStyle = colInner;
    c.lineWidth = 1;
    c.stroke();

    /* ---- 步骤 5：材质（固定种子，一次性烘焙） ---- */
    if (isRed) {
      /* 红方：3 条低透明度同心弧，模拟木纹/玉纹 */
      c.save();
      for (var a = 0; a < 3; a++) {
        var rr = r * (0.36 + a * 0.19);
        var start = rnd() * Math.PI * 2;
        var sweep = 0.9 + rnd() * 1.6;
        c.beginPath();
        c.arc(cx, cyTop, rr, start, start + sweep);
        c.strokeStyle = 'rgba(120,70,30,' + (0.05 + rnd() * 0.012) + ')';
        c.lineWidth = 1.1 + rnd() * 1.4;
        c.stroke();
      }
      c.restore();
    } else {
      /* 黑方：细碎噪声点，模拟墨玉 */
      c.save();
      for (var n = 0; n < 120; n++) {
        var ang = rnd() * Math.PI * 2;
        var rad = Math.sqrt(rnd()) * (r * 0.76);
        var px = cx + Math.cos(ang) * rad;
        var py = cyTop + Math.sin(ang) * rad;
        c.fillStyle = 'rgba(30,55,58,' + (0.03 + rnd() * 0.035) + ')';
        c.fillRect(px, py, 1 + rnd() * 1.6, 1 + rnd() * 1.6);
      }
      c.restore();
    }

    /* ---- 步骤 6：文字（先阴刻阴影，再主体） ---- */
    var fontSize = r * 0.86;
    c.textAlign = 'center';
    c.textBaseline = 'middle';
    c.font = 'bold ' + fontSize + 'px "KaiTi","STKaiti","楷体","Kaiti SC","Songti SC",serif';

    c.fillStyle = colTextShadow;
    c.fillText(char, cx, cyTop + 0.8);
    c.fillStyle = colText;
    c.fillText(char, cx, cyTop);

    /* ---- 步骤 7：高光与暗部圆弧 ---- */
    c.save();
    c.strokeStyle = 'rgba(255,255,255,0.18)';
    c.lineWidth = 2.2;
    c.beginPath();
    c.arc(cx, cyTop, r * 0.93, Math.PI * 1.06, Math.PI * 1.52);
    c.stroke();
    c.strokeStyle = 'rgba(0,0,0,0.12)';
    c.beginPath();
    c.arc(cx, cyTop, r * 0.93, Math.PI * 0.06, Math.PI * 0.52);
    c.stroke();
    c.restore();

    return cv;
  };

  /* ==================== 主绘制 ==================== */

  Renderer.prototype.render = function render() {
    var state = this.opts.state ? this.opts.state() : null;
    if (!state) { return; }
    var ctx = this.ctx;
    var t = this.track;
    var now = Date.now();

    ctx.save();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.W, this.H);

    /* 1) 棋盘（烘焙图） */
    if (this.boardTex) {
      ctx.drawImage(this.boardTex, 0, 0, this.W, this.H);
    }

    /* 2) 最后一步标记 */
    if (state.lastMove && state.showLastMove !== false) {
      this._drawLastMoveMark(ctx, state.lastMove);
    }

    /* 3) 走子动画中的棋子位置表（避免重复绘制） */
    var animMap = this._animPositions(now);

    /* 4) 被将军的将/帅位置闪红（findKing 返回 {c,r}，任何异常都不得影响后续绘制） */
    if (state.checkSide) {
      try {
        var kp = R.findKing(state.board, state.checkSide);
        if (kp) {
          var kc = kp.c;
          var kr = kp.r;
          var kx = this.point(kc, kr);
          if (isFinite(kx.x) && isFinite(kx.y)) {
            var pulse = 0.42 + Math.sin(now / 260) * 0.24;
            var gr = ctx.createRadialGradient(kx.x, kx.y, t * 0.15, kx.x, kx.y, t * 0.62);
            gr.addColorStop(0, 'rgba(200,40,30,' + (Math.min(0.85, Math.max(0, pulse)) * 0.85) + ')');
            gr.addColorStop(1, 'rgba(200,40,30,0)');
            ctx.fillStyle = gr;
            ctx.beginPath();
            ctx.arc(kx.x, kx.y, t * 0.62, 0, Math.PI * 2);
            ctx.fill();
          }
        }
      } catch (e1) {
        if (typeof console !== 'undefined') { console.warn('check glow skipped:', e1 && e1.message); }
      }
    }

    /* 5) 合法落点提示（异常隔离，避免拖垮整帧） */
    if (state.legalTargets && state.legalTargets.length) {
      try {
        this._drawLegalTargets(ctx, state.legalTargets, state.board);
      } catch (e2) {
        if (typeof console !== 'undefined') { console.warn('legal targets skipped:', e2 && e2.message); }
      }
    }

    /* 6) 棋子（按屏幕 y 排序，动画中重叠时更自然） */
    var drawList = [];
    var c, r, p;
    for (c = 0; c < 9; c++) {
      for (r = 0; r < 10; r++) {
        p = state.board[c] && state.board[c][r];
        if (!p) { continue; }
        var key = 'cell:' + c + ':' + r;
        var animPos = animMap[key];
        if (animPos) {
          drawList.push({ piece: p, x: animPos.x, y: animPos.y, lifted: true, anim: true });
        } else {
          var pt = this.point(c, r);
          drawList.push({
            piece: p, x: pt.x, y: pt.y,
            lifted: (state.selected && state.selected.col === c && state.selected.row === r),
            cell: { col: c, row: r }
          });
        }
      }
    }
    drawList.sort(function (a, b) { return a.y - b.y; });
    for (var i = 0; i < drawList.length; i++) {
      /* 单个棋子绘制失败不影响其余棋子 */
      try {
        this._drawPiece(ctx, drawList[i]);
      } catch (e3) {
        if (typeof console !== 'undefined') { console.warn('piece skipped:', e3 && e3.message); }
      }
    }

    /* 7) 选中光晕（画在棋子之上增强表现） */
    if (state.selected) {
      var sel = state.selected;
      var sp = animMap['cell:' + sel.col + ':' + sel.row];
      var sx = sp ? sp.x : this.point(sel.col, sel.row).x;
      var sy = sp ? sp.y : this.point(sel.col, sel.row).y;
      this._drawSelectGlow(ctx, sx, sy);
    }

    ctx.restore();
  };

  /** 计算当前所有动画中棋子的屏幕坐标 */
  Renderer.prototype._animPositions = function _animPositions(now) {
    var map = {};
    var t = this.track;
    var r = t * 0.42;

    /* 走子动画 */
    for (var i = this.moveAnims.length - 1; i >= 0; i--) {
      var a = this.moveAnims[i];
      var prog = (now - a.t0) / a.dur;
      if (prog >= 1) {
        this.moveAnims.splice(i, 1);
        continue;
      }
      var e = U.easeOutCubic(prog);
      var p0 = this.point(a.fromCol, a.fromRow);
      var p1 = this.point(a.toCol, a.toRow);
      var lift = Math.sin(Math.PI * Math.min(1, e)) * t * 0.55;
      var x = U.lerp(p0.x, p1.x, e);
      var y = U.lerp(p0.y, p1.y, e) - lift;
      /* 落子回弹：最后 22% 叠加纵向回弹 */
      if (prog > 0.78) {
        var bt = (prog - 0.78) / 0.22;
        y += Math.sin(Math.PI * bt) * 6;
      }
      map['cell:' + a.toCol + ':' + a.toRow] = { x: x, y: y };
    }

    /* 翻转动画：所有棋子从旧屏幕位置滑向新位置 */
    if (this.flipAnim) {
      var fprog = (now - this.flipAnim.t0) / this.flipAnim.dur;
      if (fprog >= 1) {
        this.flipAnim = null;
      } else {
        var fe = U.easeInOutCubic(fprog);
        for (var key in this.flipAnim.snap) {
          if (!Object.prototype.hasOwnProperty.call(this.flipAnim.snap, key)) { continue; }
          var oldP = this.flipAnim.snap[key];
          var cc = key.split(':');
          var col = +cc[2], row = +cc[3];
          var np = this.point(col, row);
          map['cell:' + col + ':' + row] = {
            x: U.lerp(oldP.x, np.x, fe),
            y: U.lerp(oldP.y, np.y, fe) - Math.sin(Math.PI * fe) * t * 0.28
          };
        }
      }
    }
    return map;
  };

  /** 单颗棋子：投影 + 贴图 */
  Renderer.prototype._drawPiece = function _drawPiece(ctx, item) {
    var t = this.track;
    var r = this._pieceR || (t * 0.42);
    var liftAmount = item.lifted ? r * 0.12 : 0;
    var scale = item.lifted ? 1.06 : 1;
    var cx = item.x;
    var cy = item.y - liftAmount;
    var texW = this._pieceTexW, texH = this._pieceTexH;
    var tex = this.pieceTextures[item.piece];
    if (!tex) { return; }

    /* 步骤 1：落地投影（选中/抬起时变大） */
    var shR = r * (item.lifted ? 1.02 : 0.98);
    var shR2 = r * (item.lifted ? 0.60 : 0.58);
    var shY = item.y + r * 0.30;
    ctx.save();
    ctx.translate(cx, shY);
    ctx.scale(1, 0.58);
    var sg = ctx.createRadialGradient(0, 0, r * 0.20, 0, 0, shR);
    sg.addColorStop(0, 'rgba(0,0,0,0.16)');
    sg.addColorStop(0.72, 'rgba(0,0,0,0.11)');
    sg.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.beginPath();
    ctx.arc(0, 0, shR, 0, Math.PI * 2);
    ctx.fillStyle = sg;
    ctx.fill();
    ctx.restore();

    /* 贴图（顶圆圆心对齐 cy：贴图内 top 圆心的 y 偏移为 margin + r） */
    var dx = cx - texW / 2;
    var dy = cy - (4 + r);
    if (scale !== 1) {
      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(scale, scale);
      ctx.translate(-cx, -cy);
      ctx.drawImage(tex, dx, dy, texW, texH);
      ctx.restore();
    } else {
      ctx.drawImage(tex, dx, dy, texW, texH);
    }
  };

  /** 选中金色光晕 */
  Renderer.prototype._drawSelectGlow = function _drawSelectGlow(ctx, cx, cy) {
    var r = this.track * 0.42;
    var gr = ctx.createRadialGradient(cx, cy, r * 0.72, cx, cy, r * 1.62);
    gr.addColorStop(0, 'rgba(216,164,74,0.34)');
    gr.addColorStop(0.55, 'rgba(216,164,74,0.16)');
    gr.addColorStop(1, 'rgba(216,164,74,0)');
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.62, 0, Math.PI * 2);
    ctx.fillStyle = gr;
    ctx.fill();

    ctx.strokeStyle = 'rgba(232,190,110,0.85)';
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 1.16, 0, Math.PI * 2);
    ctx.stroke();
  };

  /** 合法落点：空格实心点，吃子红环 */
  Renderer.prototype._drawLegalTargets = function _drawLegalTargets(ctx, targets, board) {
    var t = this.track;
    var r = t * 0.42;
    for (var i = 0; i < targets.length; i++) {
      var tg = targets[i];
      var p = this.point(tg.col, tg.row);
      var occupied = board[tg.col] && board[tg.col][tg.row];
      if (occupied) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 0.92, 0, Math.PI * 2);
        ctx.strokeStyle = RD.COLOR.captureRing;
        ctx.lineWidth = 2;
        ctx.stroke();
      } else {
        ctx.beginPath();
        ctx.arc(p.x, p.y, r * 0.34, 0, Math.PI * 2);
        ctx.fillStyle = RD.COLOR.legalDot;
        ctx.fill();
      }
    }
  };

  /** 最后一步四角小方框 */
  Renderer.prototype._drawLastMoveMark = function _drawLastMoveMark(ctx, lastMove) {
    var size = this.track * 0.30;
    var off = this.track * 0.20;
    var p1 = this.point(lastMove[0], lastMove[1]);
    var p2 = this.point(lastMove[2], lastMove[3]);

    ctx.strokeStyle = RD.COLOR.lastMove;
    ctx.lineWidth = 2;
    this._cornerBox(ctx, p1.x, p1.y, off, size);
    this._cornerBox(ctx, p2.x, p2.y, off, size);
  };

  Renderer.prototype._cornerBox = function _cornerBox(ctx, x, y, off, size) {
    var dirs = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
    for (var i = 0; i < 4; i++) {
      var dx = dirs[i][0], dy = dirs[i][1];
      var cx = x + dx * off;
      var cy = y + dy * off;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx, cy + dy * size);
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + dx * size, cy);
      ctx.stroke();
    }
  };

  Renderer.prototype._roundRect = function _roundRect(ctx, x, y, w, h, r) {
    if (r <= 0) { ctx.rect(x, y, w, h); return; }
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  };

  /* ==================== 动画控制 ==================== */

  /** 记录走子动画 */
  Renderer.prototype.playMove = function playMove(fromCol, fromRow, toCol, toRow, dur) {
    this.moveAnims.push({
      fromCol: fromCol, fromRow: fromRow,
      toCol: toCol, toRow: toRow,
      t0: Date.now(),
      dur: dur || 200
    });
  };

  /** 是否有走子动画进行中 */
  Renderer.prototype.isAnimating = function isAnimating() {
    return this.moveAnims.length > 0 || !!this.flipAnim;
  };

  /** 切换翻转（带动画） */
  Renderer.prototype.setFlip = function setFlip(flip, state) {
    if (this.flip === !!flip) { return; }
    var snap = {};
    if (state && state.board) {
      for (var c = 0; c < 9; c++) {
        for (var r = 0; r < 10; r++) {
          if (!state.board[c][r]) { continue; }
          var p = this.point(c, r);
          snap['cell:' + c + ':' + r] = { x: p.x, y: p.y };
        }
      }
    }
    this.flip = !!flip;
    this.flipAnim = { t0: Date.now(), dur: 600, snap: snap };
    this.render();
  };

  /** 命中检测：CSS 坐标 → 逻辑格（无效返回 null） */
  Renderer.prototype.hitTest = function hitTest(clientX, clientY, allowFlipAnim) {
    if (this.flipAnim && !allowFlipAnim) { return null; }
    var rect = this.canvas.getBoundingClientRect();
    var x = clientX - rect.left;
    var y = clientY - rect.top;
    var hit = this.unpoint(x, y);
    if (!hit) { return null; }
    if (hit.dist > this.track * 0.55) { return null; }
    return { col: hit.col, row: hit.row };
  };

  /* ==================== 动画循环 ==================== */

  Renderer.prototype.startLoop = function startLoop() {
    var self = this;
    if (this._rafId) { return; }
    var loop = function (ts) {
      self._rafId = U.raf(loop);
      self.render();
      /* 粗略 FPS 统计 */
      if (self._lastTs) {
        var dt = ts - self._lastTs;
        if (dt > 0) {
          self._fpsAcc += dt;
          self._fpsCount += 1;
          if (self._fpsAcc >= 1000) {
            self.fps = Math.round(self._fpsCount * 1000 / self._fpsAcc);
            self._fpsAcc = 0;
            self._fpsCount = 0;
          }
        }
      }
      self._lastTs = ts;
    };
    this._rafId = U.raf(loop);
  };

  Renderer.prototype.stopLoop = function stopLoop() {
    if (this._rafId) {
      if (global.cancelAnimationFrame) { global.cancelAnimationFrame(this._rafId); }
      else { global.clearTimeout(this._rafId); }
      this._rafId = 0;
    }
  };

  RD.Renderer = Renderer;
  RD.create = function (canvas, opts) { return new Renderer(canvas, opts); };

})(typeof window !== 'undefined' ? window : this);
