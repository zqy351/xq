/* ===================================================================
 * ui.js —— 面板、记录、弹层、toast、按钮状态与整体交互编排
 * ---------------------------------------------------------------
 * 这里负责把 Game / Renderer / AI / Audio 串成完整体验：
 *   双人同屏（默认）、人机对战、悔棋、翻转、计时、音效、胜负弹层。
 * 所有提示走页面内 toast / 弹层，不使用 alert / confirm / prompt。
 * ================================================================== */
(function (global) {
  'use strict';

  var Chess = global.Chess;
  var R = Chess.Rules;
  var U = Chess.util;

  function $(id) { return document.getElementById(id); }
  function $$(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  var UI = Chess.UI = {
    booted: false
  };

  /* ---------------- 运行时状态 ---------------- */
  var state = {
    game: null,
    renderer: null,
    mode: 'pvp',            /* 'pvp' 双人同屏 | 'pve' 人机 */
    aiSide: 'b',            /* AI 执哪一方 */
    level: 'normal',
    selected: null,
    legalTargets: [],
    checkSide: null,
    thinking: false,
    autoFlip: false,
    lockUntil: 0,           /* 动画期间禁止点击的时间戳 */
    clockTimer: 0,
    toastTimer: 0,
    lastNotation: '',
    busyMove: false
  };

  /* ---------------- 尺寸与资源 ---------------- */

  function measure() {
    if (!state.renderer) { return; }
    var vw = global.innerWidth;
    var vh = global.innerHeight;
    var availW, availH;

    if (vw > 900) {
      /* 桌面端：扣掉右侧面板、间距与页面内边距 */
      availW = vw - 328 - 28 - 48;
      availW = Math.min(availW, vw * 0.62);      /* 棋盘不超过视口宽 62% */
      availH = vh - 44;
    } else {
      /* 手机端：横向留 20px，纵向给棋盘约 0.64 屏高 */
      availW = vw - 20;
      availH = vh * 0.64;
    }
    availW = Math.max(160, availW);
    availH = Math.max(160, availH);

    state.renderer.resize(availW, availH);
  }

  /* ---------------- toast 与弹层 ---------------- */

  function toast(msg, type) {
    var el = $('toast');
    if (!el) { return; }
    el.textContent = msg;
    el.className = 'toast show' + (type ? ' ' + type : '');
    if (state.toastTimer) { global.clearTimeout(state.toastTimer); }
    state.toastTimer = global.setTimeout(function () {
      el.className = 'toast';
      state.toastTimer = 0;
    }, 2000);
  }

  /**
   * 打开弹层
   * @param {Object} cfg {title, body, okText, cancelText, onOk, onCancel, hideCancel}
   */
  function openModal(cfg) {
    var m = $('modal');
    if (!m) { return; }
    $('modalTitle').textContent = cfg.title || '';
    $('modalBody').innerHTML = cfg.body || '';
    var okBtn = $('modalOk');
    var cancelBtn = $('modalCancel');
    okBtn.textContent = cfg.okText || '确定';
    cancelBtn.textContent = cfg.cancelText || '取消';
    cancelBtn.style.display = cfg.hideCancel ? 'none' : '';
    m.classList.add('show');
    m.setAttribute('aria-hidden', 'false');

    var closeIt = function () {
      m.classList.remove('show');
      m.setAttribute('aria-hidden', 'true');
      okBtn.onclick = null;
      cancelBtn.onclick = null;
    };
    okBtn.onclick = function () {
      closeIt();
      if (cfg.onOk) { cfg.onOk(); }
    };
    cancelBtn.onclick = function () {
      closeIt();
      if (cfg.onCancel) { cfg.onCancel(); }
    };
    /* 键盘 ESC 关闭 */
    var onKey = function (e) {
      if (e.key === 'Escape') {
        closeIt();
        document.removeEventListener('keydown', onKey);
        if (cfg.onCancel) { cfg.onCancel(); }
      }
    };
    document.addEventListener('keydown', onKey);
  }

  /* ---------------- 渲染状态供给 ---------------- */

  function renderState() {
    var g = state.game;
    return {
      board: g.board,
      lastMove: g.lastMove,
      selected: state.selected,
      legalTargets: state.legalTargets,
      checkSide: state.checkSide,
      showLastMove: true
    };
  }

  /* ---------------- 状态栏 / 按钮刷新 ---------------- */

  function refreshTurnBar() {
    var g = state.game;
    var bar = $('turnBar');
    var txt = $('turnText');
    var dotR = $('dotRed');
    var dotB = $('dotBlack');
    if (!bar || !txt) { return; }

    bar.classList.remove('is-red', 'is-black', 'is-over');

    if (g.status !== Chess.Game.PLAYING) {
      bar.classList.add('is-over');
      var name = g.status === Chess.Game.RED_WIN ? '红方胜' :
        (g.status === Chess.Game.BLACK_WIN ? '黑方胜' : '和棋');
      txt.textContent = name + (g.reason ? ' · ' + g.reason : '');
      return;
    }

    var inCheckNow = state.checkSide === g.side;
    if (g.side === 'r') {
      bar.classList.add('is-red');
      txt.textContent = inCheckNow ? '红方行棋 · 被将军' : '红方行棋';
    } else {
      bar.classList.add('is-black');
      txt.textContent = inCheckNow ? '黑方行棋 · 被将军' : '黑方行棋';
    }
    if (inCheckNow) { bar.classList.add('is-check'); }
    if (dotR) { dotR.classList.toggle('active', g.side === 'r'); }
    if (dotB) { dotB.classList.toggle('active', g.side === 'b'); }

    /* 轮到黑方时给一个短暂高亮脉冲 */
    if (g.side === 'b') {
      bar.classList.remove('pulse-now');
      /* 触发重排以重启动画 */
      void bar.offsetWidth;
      bar.classList.add('pulse-now');
    }
  }

  function refreshClock() {
    var g = state.game;
    var row = $('clockRow');
    if (!row) { return; }
    if (!g.clockOn) {
      row.style.display = 'none';
      return;
    }
    row.style.display = '';
    var fallback = g.clockInitMs;
    var rMs = g.remainMs('r');
    var bMs = g.remainMs('b');
    $('redClock').textContent = fmtClock(rMs == null ? fallback : rMs);
    $('blackClock').textContent = fmtClock(bMs == null ? fallback : bMs);

    /* 低于 1 分钟标红 */
    $('redClock').classList.toggle('low', (rMs == null ? fallback : rMs) <= 60000);
    $('blackClock').classList.toggle('low', (bMs == null ? fallback : bMs) <= 60000);
  }

  function fmtClock(ms) {
    var total = Math.max(0, Math.ceil(ms / 1000));
    var m = Math.floor(total / 60);
    var s = total % 60;
    return (m < 10 ? '0' + m : m) + ':' + (s < 10 ? '0' + s : s);
  }

  function refreshButtons() {
    var g = state.game;
    var over = g.status !== Chess.Game.PLAYING;
    var noHistory = g.history.length === 0;

    var btnUndo = $('btnUndo');
    if (btnUndo) {
      btnUndo.disabled = over || noHistory || state.thinking;
    }
    /* 新局按钮始终可点：点击会中止正在思考的 AI */

    /* 模式 / 难度分段按钮 */
    $$('[data-mode]').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-mode') === state.mode);
    });
    $$('[data-level]').forEach(function (el) {
      el.classList.toggle('active', el.getAttribute('data-level') === state.level);
    });
    var pveOpts = $('pveOpts');
    if (pveOpts) { pveOpts.style.display = state.mode === 'pve' ? '' : 'none'; }

    var btnFlip = $('btnFlip');
    if (btnFlip) { btnFlip.classList.toggle('on', state.autoFlip); }

    var btnSound = $('btnSound');
    if (btnSound) { btnSound.classList.toggle('on', Chess.Audio.isEnabled()); }

    var btnClock = $('btnClock');
    if (btnClock) { btnClock.classList.toggle('on', g.clockOn); }

    var aiRed = $('optAiRed');
    if (aiRed) { aiRed.checked = state.aiSide === 'r'; }

    /* AI 思考指示 */
    var think = $('aiThinking');
    if (think) { think.classList.toggle('show', state.thinking); }
  }

  /* ---------------- 走棋记录 ---------------- */

  function refreshRecord() {
    var list = $('recordList');
    if (!list) { return; }
    var g = state.game;
    var moves = g.moves;
    var html = '';
    if (!moves.length) {
      html = '<li class="record-empty">尚无走子记录</li>';
    } else {
      var round = 0;
      for (var i = 0; i < moves.length; i += 2) {
        round += 1;
        var red = moves[i];
        var black = moves[i + 1];
        var redText = red ? (red.notation + (red.captured ? '×' : '') + (red.check ? ' !' : '')) : '';
        var blackText = black ? (black.notation + (black.captured ? '×' : '') + (black.check ? ' !' : '')) : '';
        html += '<li><span class="rn">' + round + '.</span>' +
          '<span class="mv red">' + redText + '</span>' +
          '<span class="mv black">' + blackText + '</span></li>';
      }
    }
    list.innerHTML = html;
    /* 自动滚到最新 */
    list.scrollTop = list.scrollHeight;
  }

  /* ---------------- 选中与落点 ---------------- */

  function clearSelection() {
    state.selected = null;
    state.legalTargets = [];
  }

  function selectPiece(col, row) {
    var g = state.game;
    var moves = g.legalMovesAt(col, row);
    if (!moves.length) {
      /* 该子无合法走法，仍可选中以显示（但不会有落点） */
      state.selected = { col: col, row: row };
      state.legalTargets = [];
      return;
    }
    state.selected = { col: col, row: row };
    state.legalTargets = moves.map(function (m) { return { col: m[2], row: m[3] }; });
  }

  /* ---------------- 走子执行 ---------------- */

  /**
   * 执行一步（含动画、音效、状态刷新）
   * @returns {boolean} 是否成功
   */
  function doMove(mv, opts) {
    opts = opts || {};
    var g = state.game;
    if (state.busyMove) { return false; }

    var fromCol = mv[0], fromRow = mv[1], toCol = mv[2], toRow = mv[3];
    var captured = g.board[toCol][toRow];

    state.busyMove = true;
    var res = g.applyMove(mv);
    if (!res.ok) {
      state.busyMove = false;
      return false;
    }

    /* 动画 + 音效 */
    if (state.renderer) {
      state.renderer.playMove(fromCol, fromRow, toCol, toRow, opts.instant ? 0 : 200);
    }
    if (Chess.Audio.isEnabled()) {
      if (captured) { Chess.Audio.capture(); } else { Chess.Audio.drop(); }
    }

    clearSelection();
    state.checkSide = res.check ? g.side : null;
    if (res.check && !res.mate && Chess.Audio.isEnabled()) { Chess.Audio.alert(); }
    if (res.check && !res.mate && g.status === Chess.Game.PLAYING) {
      toast((g.side === 'r' ? '红方' : '黑方') + '被将军，必须应将', 'error');
    }
    if (res.longCheck) {
      toast((res.longCheck === 'r' ? '红方' : '黑方') + '长将判负', 'error');
    }

    /* 锁住输入，等动画结束 */
    state.lockUntil = Date.now() + (opts.instant ? 60 : 240);

    /* 自动翻转：黑方回合翻到黑方视角 */
    if (state.autoFlip && state.renderer) {
      state.renderer.setFlip(g.side === 'b', renderState());
    }

    refreshAll();

    /* 结束处理 */
    if (g.status !== Chess.Game.PLAYING) {
      onGameOver();
    } else if (state.mode === 'pve' && g.side === state.aiSide) {
      scheduleAI();
    }

    global.setTimeout(function () {
      state.busyMove = false;
    }, opts.instant ? 80 : 260);

    return true;
  }

  function refreshAll() {
    refreshTurnBar();
    refreshClock();
    refreshButtons();
    refreshRecord();
  }

  /* ---------------- 胜负 ---------------- */

  function onGameOver() {
    var g = state.game;
    var title = '对局结束';
    var body = '';
    if (g.status === Chess.Game.RED_WIN) {
      title = '红方胜';
    } else if (g.status === Chess.Game.BLACK_WIN) {
      title = '黑方胜';
    } else if (g.status === Chess.Game.DRAW) {
      title = '和棋';
    }
    if (g.reason) {
      body += '<p class="modal-reason">' + g.reason + '</p>';
    }
    if (/长将/.test(g.reason || '')) {
      body += '<p class="modal-tip">连续将军逼成三次重复局面，按规则判长将方负。</p>';
    } else if (/绝杀/.test(g.reason || '')) {
      body += '<p class="modal-tip">被将军且无任何合法应将走法。</p>';
    } else if (/困毙/.test(g.reason || '')) {
      body += '<p class="modal-tip">未被将军，但已无合法走法。</p>';
    }
    body += '<p class="modal-tip">共 ' + g.moves.length + ' 个半回合</p>';
    if (Chess.Audio.isEnabled()) { Chess.Audio.win(); }

    global.setTimeout(function () {
      openModal({
        title: title,
        body: body,
        okText: '再来一局',
        cancelText: '查看棋盘',
        onOk: function () { newGame(); }
      });
    }, 320);
  }

  /* ---------------- AI ---------------- */

  function scheduleAI() {
    if (state.mode !== 'pve') { return; }
    if (state.game.status !== Chess.Game.PLAYING) { return; }
    if (state.game.side !== state.aiSide) { return; }

    state.thinking = true;
    refreshButtons();

    var cfg = Chess.AI.LEVELS[state.level] || Chess.AI.LEVELS.normal;
    var startedAt = Date.now();

    Chess.AI.think(state.game, {
      maxDepth: cfg.maxDepth,
      timeLimit: cfg.timeLimit,
      nodeLimit: cfg.nodeLimit,
      randomize: cfg.randomize
    }, function (mv, info) {
      state.thinking = false;
      refreshButtons();

      /* 局面已变（重开/悔棋/切模式），丢弃结果 */
      if (state.game.status !== Chess.Game.PLAYING) { return; }
      if (state.game.side !== state.aiSide) { return; }

      if (!mv) {
        /* 无合法走法：直接判负，绝不卡住 */
        if (info && info.noMove) {
          var loser = state.aiSide;
          state.game.status = (loser === 'r') ? Chess.Game.BLACK_WIN : Chess.Game.RED_WIN;
          state.game.winner = loser === 'r' ? 'b' : 'r';
          state.game.reason = R.inCheck(state.game.board, loser) ? '绝杀' : '困毙';
          refreshAll();
          onGameOver();
        } else {
          toast('AI 未能找到走法');
        }
        return;
      }

      /* 最短 220ms 的"思考感"，避免瞬秒落子 */
      var elapsed = Date.now() - startedAt;
      var wait = Math.max(0, 220 - elapsed);
      global.setTimeout(function () {
        if (state.game.status !== Chess.Game.PLAYING) { return; }
        if (state.game.side !== state.aiSide) { return; }
        doMove(mv);
      }, wait);
    });
  }

  function abortAI() {
    state.thinking = false;
    if (Chess.AI && Chess.AI.abort) { Chess.AI.abort(); }
    refreshButtons();
  }

  /* ---------------- 棋盘点击 ---------------- */

  function onBoardClick(evt) {
    if (!state.game) { return; }
    if (Date.now() < state.lockUntil) { return; }
    if (state.busyMove) { return; }
    if (state.thinking) { return; }
    if (state.game.status !== Chess.Game.PLAYING) { return; }
    if (state.mode === 'pve' && state.game.side === state.aiSide) {
      return;                 /* 不是玩家的回合 */
    }
    if (state.renderer.isAnimating()) { return; }

    var pt = null;
    if (evt.touches && evt.touches.length) {
      pt = state.renderer.hitTest(evt.touches[0].clientX, evt.touches[0].clientY);
    } else {
      pt = state.renderer.hitTest(evt.clientX, evt.clientY);
    }
    if (!pt) { return; }

    var g = state.game;
    var piece = g.board[pt.col][pt.row];

    /* 点击合法落点 → 走子 */
    for (var i = 0; i < state.legalTargets.length; i++) {
      if (state.legalTargets[i].col === pt.col && state.legalTargets[i].row === pt.row) {
        if (state.selected) {
          doMove([state.selected.col, state.selected.row, pt.col, pt.row]);
        }
        return;
      }
    }

    /* 点击己方棋子 → 选中 / 取消选中 */
    if (piece && R.sideOf(piece) === g.side) {
      if (state.selected && state.selected.col === pt.col && state.selected.row === pt.row) {
        clearSelection();
      } else {
        selectPiece(pt.col, pt.row);
        if (Chess.Audio.isEnabled()) {
          /* 选中也是一次轻交互，初始化 AudioContext */
          Chess.Audio.ensure();
        }
      }
      return;
    }

    /* 其它情况：取消选中 */
    clearSelection();
  }

  /* ---------------- 按钮行为 ---------------- */

  function newGame() {
    abortAI();
    clearSelection();
    state.checkSide = null;
    state.busyMove = false;
    state.lockUntil = 0;

    var clockOn = state.game ? state.game.clockOn : false;
    state.game = Chess.createGame({ clockOn: clockOn });
    if (state.renderer) {
      state.renderer.moveAnims.length = 0;
      /* 新局固定红方视角；自动翻转会在第一步棋后接管 */
      state.renderer.setFlip(false, renderState());
    }
    state.game.startClock();
    refreshAll();

    /* 人机模式且 AI 执红 → 让 AI 先走 */
    if (state.mode === 'pve' && state.aiSide === 'r') {
      scheduleAI();
    }
    toast('新局开始');
  }

  function undoMove() {
    var g = state.game;
    if (!g || g.history.length === 0) { return; }

    var doUndo = function () {
      abortAI();
      var steps = (state.mode === 'pve') ? 2 : 1;
      /* 人机模式若历史只有 1 步，就回退 1 步 */
      if (state.mode === 'pve' && g.history.length < 2) { steps = 1; }
      g.undo(steps);
      clearSelection();
      state.checkSide = R.inCheck(g.board, g.side) ? g.side : null;
      state.busyMove = false;
      state.lockUntil = 0;
      if (state.renderer) { state.renderer.moveAnims.length = 0; }
      if (state.autoFlip && state.renderer) {
        state.renderer.setFlip(g.side === 'b', renderState());
      }
      refreshAll();
      toast('已悔棋');
      /* 悔棋后若又轮到 AI，重新思考 */
      if (state.mode === 'pve' && g.side === state.aiSide && g.status === Chess.Game.PLAYING) {
        scheduleAI();
      }
    };

    if (state.mode === 'pvp') {
      openModal({
        title: '确认悔棋',
        body: '<p class="modal-reason">确认回退上一步？</p><p class="modal-tip">双人同屏模式需双方共同确认。</p>',
        okText: '确认回退',
        cancelText: '取消',
        onOk: doUndo
      });
    } else {
      doUndo();
    }
  }

  function switchMode(mode) {
    if (state.mode === mode) { return; }
    state.mode = mode;
    newGame();
    toast(mode === 'pvp' ? '已切换为双人同屏' : '已切换为人机对战');
  }

  function setLevel(level) {
    if (state.level === level) { return; }
    state.level = level;
    abortAI();
    refreshButtons();
    toast('难度：' + (Chess.AI.LEVELS[level] ? Chess.AI.LEVELS[level].label : level));
  }

  function toggleAiRed() {
    var el = $('optAiRed');
    state.aiSide = el && el.checked ? 'r' : 'b';
    newGame();
    toast(state.aiSide === 'r' ? 'AI 执红先行' : '玩家执红先行');
  }

  function toggleFlip() {
    state.autoFlip = !state.autoFlip;
    if (state.renderer) {
      if (state.autoFlip) {
        state.renderer.setFlip(state.game.side === 'b', renderState());
      } else {
        state.renderer.setFlip(false, renderState());
      }
    }
    refreshButtons();
    toast(state.autoFlip ? '自动翻转：已开启' : '自动翻转：已关闭');
  }

  function toggleSound() {
    var on = !Chess.Audio.isEnabled();
    Chess.Audio.setEnabled(on);
    if (on) { Chess.Audio.ensure(); Chess.Audio.drop(); }
    refreshButtons();
    toast(on ? '音效已开启' : '音效已关闭');
  }

  function toggleClock() {
    var g = state.game;
    g.clockOn = !g.clockOn;
    if (g.clockOn) {
      g.redTime = g.clockInitMs;
      g.blackTime = g.clockInitMs;
      g.startClock();
      toast('双人计时已开启（每方 10 分钟）');
    } else {
      g.stopClock();
      toast('双人计时已关闭');
    }
    refreshAll();
  }

  /* ---------------- 计时驱动 ---------------- */

  function startClockTicker() {
    if (state.clockTimer) { global.clearInterval(state.clockTimer); }
    state.clockTimer = global.setInterval(function () {
      var g = state.game;
      if (!g || !g.clockOn) { return; }
      var ended = g.tickClock();
      refreshClock();
      if (ended) {
        refreshAll();
        onGameOver();
      }
    }, 500);
  }

  /* ---------------- 尺寸监听 ---------------- */

  function watchResize() {
    var wrap = $('boardWrap');
    var pending = 0;
    var doResize = function () {
      if (pending) { return; }
      pending = global.setTimeout(function () {
        pending = 0;
        measure();
      }, 80);
    };

    if (typeof global.ResizeObserver === 'function' && wrap) {
      var ro = new global.ResizeObserver(doResize);
      ro.observe(wrap);
    }
    global.addEventListener('resize', doResize, false);
    global.addEventListener('orientationchange', doResize, false);
  }

  /* ---------------- 初始化 ---------------- */

  UI.init = function init() {
    if (UI.booted) { return; }
    UI.booted = true;

    var canvas = $('board');
    if (!canvas) { return; }

    state.game = Chess.createGame({ clockOn: false });

    /* 创建渲染器 */
    state.renderer = new Chess.Render.Renderer(canvas, {
      state: renderState
    });

    measure();
    state.renderer.startLoop();

    /* 点击 / 触摸：pointerdown 更快，回退 click */
    var pointerBound = false;
    if (global.PointerEvent) {
      canvas.addEventListener('pointerdown', function (e) {
        if (e.button !== undefined && e.button !== 0) { return; }
        Chess.Audio.ensure();
        onBoardClick(e);
      }, false);
      pointerBound = true;
    }
    if (!pointerBound) {
      canvas.addEventListener('click', function (e) {
        Chess.Audio.ensure();
        onBoardClick(e);
      }, false);
    }
    canvas.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      clearSelection();
    }, false);

    /* 按钮绑定 */
    var bind = function (id, fn) {
      var el = $(id);
      if (el) { el.addEventListener('click', fn, false); }
    };
    bind('btnNew', function () { newGame(); });
    bind('btnUndo', function () { undoMove(); });
    bind('btnFlip', function () { toggleFlip(); });
    bind('btnSound', function () { toggleSound(); });
    bind('btnClock', function () { toggleClock(); });

    $$('[data-mode]').forEach(function (el) {
      el.addEventListener('click', function () {
        switchMode(el.getAttribute('data-mode'));
      }, false);
    });
    $$('[data-level]').forEach(function (el) {
      el.addEventListener('click', function () {
        setLevel(el.getAttribute('data-level'));
      }, false);
    });

    var aiRed = $('optAiRed');
    if (aiRed) { aiRed.addEventListener('change', toggleAiRed, false); }

    /* 记录折叠 */
    var recToggle = $('recordToggle');
    if (recToggle) {
      recToggle.addEventListener('click', function () {
        var box = $('recordBox');
        if (box) {
          box.classList.toggle('collapsed');
          recToggle.textContent = box.classList.contains('collapsed') ? '展开记录' : '收起记录';
        }
      }, false);
    }

    /* 键盘快捷键（桌面端） */
    document.addEventListener('keydown', function (e) {
      if (e.key === 'u' || e.key === 'U') { undoMove(); }
      if (e.key === 'n' || e.key === 'N') { newGame(); }
      if (e.key === 'f' || e.key === 'F') { toggleFlip(); }
    }, false);

    watchResize();
    startClockTicker();
    state.game.startClock();
    refreshAll();
  };

  /* 暴露少量内部方法便于调试 */
  UI._state = state;
  UI.doMove = doMove;
  UI.newGame = newGame;

  /* DOMContentLoaded 后启动 */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { UI.init(); });
  } else {
    global.setTimeout(function () { UI.init(); }, 0);
  }

})(typeof window !== 'undefined' ? window : this);
