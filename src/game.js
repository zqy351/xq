/* ===================================================================
 * game.js —— 棋局状态机
 * ---------------------------------------------------------------
 * 职责：走子、悔棋、历史栈、重复局面计数、无吃子计数、胜负判定、
 *       可选的双人计时。不碰 DOM，渲染与 UI 都通过回调读取状态。
 * =================================================================== */
(function (global) {
  'use strict';

  var Chess = global.Chess;
  var R = Chess.Rules;
  var G = Chess.Game = {};

  /** 结果常量 */
  G.PLAYING = 'playing';
  G.RED_WIN = 'red_win';
  G.BLACK_WIN = 'black_win';
  G.DRAW = 'draw';

  /** 自然限着：连续 120 个半回合（60 回合）无吃子判和 */
  G.MAX_NO_CAPTURE = 120;

  /**
   * 创建一局棋
   * @param {Object} [opts]
   * @param {boolean} [opts.clockOn] 是否启用双人计时
   * @param {number} [opts.clockMs] 每方初始毫秒（默认 10 分钟）
   */
  function Game(opts) {
    opts = opts || {};
    this.clockOn = !!opts.clockOn;
    this.clockInitMs = opts.clockMs || 10 * 60 * 1000;
    this.reset();
  }

  Game.prototype.reset = function reset() {
    this.board = R.initialBoard();
    this.side = 'r';
    this.status = G.PLAYING;
    this.winner = null;
    this.reason = '';
    this.history = [];            /* 每步前的完整快照 */
    this.moves = [];              /* 走法记录（含吃子、将军标记） */
    this.lastMove = null;         /* [fc,fr,tc,tr] */
    this.positionCounts = {};     /* 局面字符串 -> 出现次数 */
    this.positionFirst = {};      /* 局面字符串 -> 首次出现时的半回合数（长将判定用） */
    this.noCaptureHalf = 0;       /* 连续无吃子半回合数 */
    this.redTime = this.clockInitMs;
    this.blackTime = this.clockInitMs;
    this.clockRunningSince = 0;   /* 时间戳，0 表示停 */
    this.clockSide = 'r';
    this._seedCount();
    return this;
  };

  /** 录入初始局面 */
  Game.prototype._seedCount = function _seedCount() {
    var key = R.positionKey(this.board, this.side);
    this.positionCounts[key] = 1;
    this.positionFirst[key] = 0;
  };

  /** 当前局面键 */
  Game.prototype.key = function key() {
    return R.positionKey(this.board, this.side);
  };

  /** 深层快照（悔棋/重复局面恢复用） */
  Game.prototype.snapshot = function snapshot() {
    var counts = {};
    for (var k in this.positionCounts) {
      if (Object.prototype.hasOwnProperty.call(this.positionCounts, k)) {
        counts[k] = this.positionCounts[k];
      }
    }
    var firsts = {};
    for (var fk in this.positionFirst) {
      if (Object.prototype.hasOwnProperty.call(this.positionFirst, fk)) {
        firsts[fk] = this.positionFirst[fk];
      }
    }
    return {
      positionFirst: firsts,
      board: R.cloneBoard(this.board),
      side: this.side,
      status: this.status,
      winner: this.winner,
      reason: this.reason,
      moves: this.moves.slice(),
      lastMove: this.lastMove ? this.lastMove.slice() : null,
      positionCounts: counts,
      noCaptureHalf: this.noCaptureHalf,
      redTime: this.redTime,
      blackTime: this.blackTime,
      clockSide: this.clockSide
    };
  };

  /** 恢复快照 */
  Game.prototype.restore = function restore(snap) {
    this.board = R.cloneBoard(snap.board);
    this.side = snap.side;
    this.status = snap.status;
    this.winner = snap.winner;
    this.reason = snap.reason;
    this.moves = snap.moves.slice();
    this.lastMove = snap.lastMove ? snap.lastMove.slice() : null;
    this.positionCounts = {};
    for (var k in snap.positionCounts) {
      if (Object.prototype.hasOwnProperty.call(snap.positionCounts, k)) {
        this.positionCounts[k] = snap.positionCounts[k];
      }
    }
    this.positionFirst = {};
    var pf = snap.positionFirst || {};
    for (var k2 in pf) {
      if (Object.prototype.hasOwnProperty.call(pf, k2)) {
        this.positionFirst[k2] = pf[k2];
      }
    }
    this.noCaptureHalf = snap.noCaptureHalf;
    this.redTime = snap.redTime;
    this.blackTime = snap.blackTime;
    this.clockSide = snap.clockSide;
  };

  /** 某格棋子的合法走法（当前走子方） */
  Game.prototype.legalMovesAt = function legalMovesAt(col, row) {
    var p = this.board[col] ? this.board[col][row] : null;
    if (!p || R.sideOf(p) !== this.side || this.status !== G.PLAYING) { return []; }
    return R.legalMovesOf(this.board, col, row);
  };

  /** 某方全部合法走法 */
  Game.prototype.allMoves = function allMoves(side) {
    return R.allLegalMoves(this.board, side || this.side);
  };

  /**
   * 走一步棋
   * @param {Array<number>} mv [fc,fr,tc,tr]
   * @returns {Object} {ok, reason, notation, captured, check, mate, result}
   */
  Game.prototype.applyMove = function applyMove(mv) {
    if (this.status !== G.PLAYING) {
      return { ok: false, reason: 'over' };
    }
    if (!mv || mv.length !== 4) {
      return { ok: false, reason: 'bad' };
    }
    var piece = this.board[mv[0]][mv[1]];
    if (!piece) { return { ok: false, reason: 'empty' }; }
    if (R.sideOf(piece) !== this.side) { return { ok: false, reason: 'side' }; }
    if (!R.isLegal(this.board, mv, this.side)) { return { ok: false, reason: 'illegal' }; }

    /* 先存快照：悔棋能完整回到这一步之前 */
    this.history.push(this.snapshot());

    var notation = R.notation(this.board, mv);
    var cap = this.board[mv[2]][mv[3]];
    var mover = this.side;
    var opp = R.other(mover);

    R.makeMove(this.board, mv);
    this.lastMove = mv.slice();
    this.side = opp;

    /* 计时：切换计时方 */
    this.clockSide = opp;

    /* 记录 */
    var rec = {
      side: mover,
      notation: notation,
      mv: mv.slice(),
      captured: cap ? R.typeOf(cap) : null,
      capturedPiece: cap || null,
      check: false,
      mate: false
    };
    this.moves.push(rec);

    /* 无吃子计数 */
    if (cap) { this.noCaptureHalf = 0; }
    else { this.noCaptureHalf += 1; }

    /* 重复局面计数（走后新局面的出现次数） */
    var nk = R.positionKey(this.board, this.side);
    var seen = this.positionCounts[nk] || 0;
    this.positionCounts[nk] = seen + 1;
    if (seen === 0) { this.positionFirst[nk] = this.moves.length; }

    var result = {
      ok: true,
      notation: notation,
      captured: cap || null,
      check: false,
      mate: false,
      result: G.PLAYING
    };

    /* ---- 胜负：绝杀 / 困毙 ---- */
    var oppInCheck = R.inCheck(this.board, opp);
    var oppHasMove = R.hasLegalMove(this.board, opp);
    rec.check = oppInCheck;

    if (!oppHasMove) {
      if (oppInCheck) {
        rec.mate = true;
        this.status = mover === 'r' ? G.RED_WIN : G.BLACK_WIN;
        this.winner = mover;
        this.reason = '绝杀';
        result.mate = true;
      } else {
        this.status = mover === 'r' ? G.RED_WIN : G.BLACK_WIN;
        this.winner = mover;
        this.reason = '困毙';
      }
      result.result = this.status;
      result.check = oppInCheck;
      this._stopClock();
      return result;
    }

    /* ---- 三次重复：先判长将（长将方负），否则判和 ---- */
    if (this.positionCounts[nk] >= 3) {
      var longSide = this._detectLongCheck(nk);
      if (longSide) {
        this.status = longSide === 'r' ? G.BLACK_WIN : G.RED_WIN;
        this.winner = R.other(longSide);
        this.reason = (longSide === 'r' ? '红方' : '黑方') + '长将判负';
        result.longCheck = longSide;
      } else {
        this.status = G.DRAW;
        this.winner = null;
        this.reason = '三次重复局面';
      }
      result.result = this.status;
      result.check = oppInCheck;
      this._stopClock();
      return result;
    }

    /* ---- 自然限着判和 ---- */
    if (this.noCaptureHalf >= G.MAX_NO_CAPTURE) {
      this.status = G.DRAW;
      this.winner = null;
      this.reason = '60 回合无吃子';
      result.result = this.status;
      result.check = oppInCheck;
      this._stopClock();
      return result;
    }

    result.check = oppInCheck;
    result.result = this.status;
    return result;
  };

  /**
   * 长将判定：三次重复的周期内，某一方每一步都在将军 → 该方长将
   * @returns {'r'|'b'|null} 长将方；双方都长将或都不长将则为 null（判和）
   */
  Game.prototype._detectLongCheck = function _detectLongCheck(key) {
    var start = this.positionFirst[key];
    if (start === undefined) { return null; }
    var rTotal = 0, rChk = 0, bTotal = 0, bChk = 0;
    for (var i = start; i < this.moves.length; i++) {
      var m = this.moves[i];
      if (m.side === 'r') {
        rTotal += 1;
        if (m.check) { rChk += 1; }
      } else {
        bTotal += 1;
        if (m.check) { bChk += 1; }
      }
    }
    var rLong = rTotal >= 2 && rChk === rTotal;
    var bLong = bTotal >= 2 && bChk === bTotal;
    if (rLong && !bLong) { return 'r'; }
    if (bLong && !rLong) { return 'b'; }
    return null;
  };

  /**
   * 悔棋：回退 steps 步（默认 1）
   * @returns {boolean} 是否成功
   */
  Game.prototype.undo = function undo(steps) {
    var n = steps || 1;
    var done = 0;
    while (n > 0 && this.history.length > 0) {
      var snap = this.history.pop();
      this.restore(snap);
      n -= 1;
      done += 1;
    }
    if (done > 0) {
      this.clockSide = this.side;
      return true;
    }
    return false;
  };

  /** 是否已结束 */
  Game.prototype.isOver = function isOver() {
    return this.status !== G.PLAYING;
  };

  /** 当前是否轮到某方 */
  Game.prototype.isTurn = function isTurn(side) {
    return this.side === side && this.status === G.PLAYING;
  };

  /* ==================== 双人计时 ==================== */

  Game.prototype._stopClock = function _stopClock() {
    if (this.clockRunningSince) {
      this._accumulateClock();
      this.clockRunningSince = 0;
    }
  };

  Game.prototype._accumulateClock = function _accumulateClock() {
    if (!this.clockRunningSince) { return; }
    var elapsed = Date.now() - this.clockRunningSince;
    if (this.clockSide === 'r') {
      this.redTime = Math.max(0, this.redTime - elapsed);
    } else {
      this.blackTime = Math.max(0, this.blackTime - elapsed);
    }
    this.clockRunningSince = Date.now();
  };

  /** 开始计时（走子方开始走时钟） */
  Game.prototype.startClock = function startClock() {
    if (!this.clockOn || this.status !== G.PLAYING) { return; }
    this.clockRunningSince = Date.now();
  };

  /** 停止计时（暂停/重开/结束） */
  Game.prototype.stopClock = function stopClock() {
    this._stopClock();
  };

  /** 每帧/定时调用：检查超时 */
  Game.prototype.tickClock = function tickClock() {
    if (!this.clockOn || this.status !== G.PLAYING) { return null; }
    if (!this.clockRunningSince) { this.clockRunningSince = Date.now(); }
    var now = Date.now();
    var left = this.clockSide === 'r'
      ? this.redTime - (now - this.clockRunningSince)
      : this.blackTime - (now - this.clockRunningSince);
    if (left <= 0) {
      if (this.clockSide === 'r') {
        this.redTime = 0;
        this.status = G.BLACK_WIN;
        this.winner = 'b';
      } else {
        this.blackTime = 0;
        this.status = G.RED_WIN;
        this.winner = 'r';
      }
      this.reason = '超时判负';
      this.clockRunningSince = 0;
      return this.status;
    }
    return null;
  };

  /** 剩余时间（毫秒），用于显示 */
  Game.prototype.remainMs = function remainMs(side) {
    if (!this.clockOn) { return null; }
    var base = side === 'r' ? this.redTime : this.blackTime;
    if (this.clockRunningSince && this.clockSide === side && this.status === G.PLAYING) {
      base = Math.max(0, base - (Date.now() - this.clockRunningSince));
    }
    return base;
  };

  Chess.GameClass = Game;
  Chess.createGame = function (opts) { return new Game(opts); };

})(typeof window !== 'undefined' ? window : this);
