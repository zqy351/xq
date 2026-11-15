/* ===================================================================
 * ai.js —— 迭代加深 + Alpha-Beta + 置换表 + 静止搜索
 * ---------------------------------------------------------------
 * 关键设计：
 *  1. 搜索跑在内联 Blob Worker 里，主线程永不卡顿。
 *  2. Worker 内的规则代码由 Chess.Rules / Chess.AI 的函数 toString 注入，
 *     保证规则只有一份实现（走法生成、合法性过滤完全同源）。
 *  3. 用递增 searchId 丢弃过期结果；切难度 / 悔棋 / 重开时 terminate 重建。
 *  4. 有 node 上限与时间上限，超过就用手上最好的结果，1.5 秒内必出招。
 * ================================================================== */
(function (global) {
  'use strict';

  var Chess = global.Chess;
  var R = Chess.Rules;
  var A = Chess.AI = {};

  /* ==================== 评估参数 ==================== */

  /* 子力分 */
  A.VALUES = { K: 10000, R: 900, N: 400, C: 450, A: 200, B: 200, P: 100 };

  /* 位置分表：按红方视角（row 9 为自家底线）预计算，
     黑方查表时用 9-row 镜像，保证红黑完全对称。 */
  A.POS = (function buildPos() {
    var tables = {};
    var TYPES = ['K', 'A', 'B', 'N', 'R', 'C', 'P'];
    for (var t = 0; t < TYPES.length; t++) {
      var type = TYPES[t];
      var tab = [];
      for (var c = 0; c < 9; c++) {
        tab[c] = [];
        for (var r = 0; r < 10; r++) {
          var adv = 9 - r;                       /* 推进程度：0 自家底线 → 9 对方底线 */
          var center = 4 - Math.abs(c - 4);      /* 0..4，越靠中路越大 */
          var v = 0;
          switch (type) {
            case 'P':                            /* 兵：过河后越往前越值钱 */
              v = adv <= 3 ? adv * 4 : 12 + (adv - 3) * 10 + center * 2;
              break;
            case 'N':                            /* 马：中心与推进 */
              v = adv * 2 + center * 6;
              break;
            case 'C':                            /* 炮：中路偏好 */
              v = center * 5 + (adv >= 5 ? adv * 2 : 0);
              break;
            case 'R':                            /* 车：中心与推进 */
              v = center * 4 + adv * 3;
              break;
            case 'B':                            /* 象：守家 */
              v = center * 2;
              break;
            case 'A':                            /* 士：守家 */
              v = center * 2;
              break;
            case 'K':                            /* 将：待在底线更安全 */
              v = (adv >= 7 ? (adv - 7) * 3 : 0) + (c === 4 ? 4 : 0);
              break;
            default:
              v = 0;
          }
          tab[c][r] = v;
        }
      }
      tables[type] = tab;
    }
    return tables;
  })();

  /** 单子价值（含位置） */
  A.pieceScore = function pieceScore(piece, col, row) {
    var type = R.typeOf(piece);
    var side = R.sideOf(piece);
    var v = A.VALUES[type] || 0;
    var tab = A.POS[type];
    if (tab) {
      v += side === 'r' ? tab[col][row] : tab[col][9 - row];
    }
    return v;
  };

  /* ==================== 局面评估 ==================== */

  /**
   * 从 side 视角评估局面（红黑对称）
   * 子力 + 位置 + 轻量机动性 + 将帅安全
   */
  A.evaluate = function evaluate(board, side) {
    var score = 0;
    var c, r, p, type, sd, tab;
    var mobRed = 0, mobBlack = 0;

    for (c = 0; c < 9; c++) {
      for (r = 0; r < 10; r++) {
        p = board[c][r];
        if (!p) { continue; }
        type = R.typeOf(p);
        sd = R.sideOf(p);
        tab = A.POS[type];
        var val = (A.VALUES[type] || 0);
        if (tab) { val += sd === 'r' ? tab[c][r] : tab[c][9 - r]; }

        if (sd === side) { score += val; } else { score -= val; }

        /* 轻量机动性：只统计车/马/炮的可动方向数，成本很低 */
        if (type === 'R' || type === 'C') {
          var dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
          var mcount = 0;
          for (var d = 0; d < 4; d++) {
            var nc = c + dirs[d][0], nr = r + dirs[d][1];
            if (nc >= 0 && nc <= 8 && nr >= 0 && nr <= 9) {
              var q = board[nc][nr];
              if (!q || R.sideOf(q) !== sd) { mcount += 1; }
            }
          }
          if (sd === 'r') { mobRed += mcount; } else { mobBlack += mcount; }
        } else if (type === 'N') {
          var legs = [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]];
          var mcountN = 0;
          for (var k = 0; k < 8; k++) {
            var kc = c + legs[k][0], kr = r + legs[k][1];
            if (kc < 0 || kc > 8 || kr < 0 || kr > 9) { continue; }
            var legC = Math.abs(legs[k][0]) === 2 ? c + legs[k][0] / 2 : c;
            var legR = Math.abs(legs[k][1]) === 2 ? r + legs[k][1] / 2 : r;
            if (!board[legC][legR]) { mcountN += 1; }
          }
          if (sd === 'r') { mobRed += mcountN; } else { mobBlack += mcountN; }
        }
      }
    }

    /* 机动性小权重（红方视角差） */
    var mob = mobRed - mobBlack;
    score += side === 'r' ? mob * 2 : -mob * 2;

    /* 将帅安全：被将军扣分（对称处理） */
    if (R.inCheck(board, side)) { score -= 45; }
    if (R.inCheck(board, R.other(side))) { score += 45; }

    return score;
  };

  /* ==================== 搜索核心（注入 Worker 执行） ==================== */

  /** 生成某方全部合法走法（搜索内部用） */
  A.genLegal = function genLegal(board, side) {
    var out = [];
    var c, r, p, raw, i;
    for (c = 0; c < 9; c++) {
      for (r = 0; r < 10; r++) {
        p = board[c][r];
        if (!p || R.sideOf(p) !== side) { continue; }
        raw = R.pseudoMoves(board, c, r);
        for (i = 0; i < raw.length; i++) {
          if (R.isLegal(board, raw[i], side)) { out.push(raw[i]); }
        }
      }
    }
    return out;
  };

  /** 吃子走法（静止搜索用） */
  A.genCaptures = function genCaptures(board, side) {
    var out = [];
    var c, r, p, raw, i;
    for (c = 0; c < 9; c++) {
      for (r = 0; r < 10; r++) {
        p = board[c][r];
        if (!p || R.sideOf(p) !== side) { continue; }
        raw = R.pseudoMoves(board, c, r);
        for (i = 0; i < raw.length; i++) {
          if (!board[raw[i][2]][raw[i][3]]) { continue; }
          if (R.isLegal(board, raw[i], side)) { out.push(raw[i]); }
        }
      }
    }
    return out;
  };

  /** 走法排序分：MVV-LVA + 历史启发 */
  A.moveScore = function moveScore(board, mv, history) {
    var victim = board[mv[2]][mv[3]];
    var attacker = board[mv[0]][mv[1]];
    if (victim) {
      var vv = A.VALUES[R.typeOf(victim)] || 0;
      var va = A.VALUES[R.typeOf(attacker)] || 0;
      return 100000 + vv * 10 - va;
    }
    var h = history ? (history[mv[0] * 10 + mv[1]] && history[mv[0] * 10 + mv[1]][mv[2] * 10 + mv[3]]) : 0;
    return h || 0;
  };

  /** 排序（原地） */
  A.sortMoves = function sortMoves(board, moves, history) {
    var scored = [];
    for (var i = 0; i < moves.length; i++) {
      scored.push({ mv: moves[i], s: A.moveScore(board, moves[i], history) });
    }
    scored.sort(function (a, b) { return b.s - a.s; });
    for (var k = 0; k < scored.length; k++) { moves[k] = scored[k].mv; }
    return moves;
  };

  /**
   * 根节点搜索（迭代加深）
   * @returns {Object|null} {mv, score, depth, nodes} 或 null（无合法走法）
   */
  A.searchRoot = function searchRoot(board, side, opt) {
    var maxDepth = opt.maxDepth || 4;
    var deadline = opt.deadline || (Date.now() + 400);
    var nodeLimit = opt.nodeLimit || 3000000;
    var randomize = !!opt.randomize;

    var nodes = 0;
    var history = {};
    var tt = {};                        /* 置换表：key -> {score, depth, flag} */
    var best = null;                    /* 已完成深度的最佳走法 */
    var bestScore = 0;
    var aborted = false;

    function now() { return Date.now(); }
    function timeUp() {
      if (nodes >= nodeLimit) { return true; }
      if ((nodes & 2047) === 0 && now() > deadline) { return true; }
      return false;
    }

    function addHistory(mv, depth) {
      var f = mv[0] * 10 + mv[1], t = mv[2] * 10 + mv[3];
      if (!history[f]) { history[f] = {}; }
      history[f][t] = (history[f][t] || 0) + depth * depth;
    }

    /* 静止搜索：只扩展吃子，消除地平线效应 */
    function quiesce(bd, sd, alpha, beta, qdepth) {
      nodes += 1;
      if (timeUp()) { aborted = true; return 0; }

      var stand = A.evaluate(bd, sd);
      if (stand >= beta) { return beta; }
      if (stand > alpha) { alpha = stand; }
      if (qdepth <= 0) { return alpha; }

      var caps = A.genCaptures(bd, sd);
      if (!caps.length) { return alpha; }
      A.sortMoves(bd, caps, history);

      for (var i = 0; i < caps.length; i++) {
        var mv = caps[i];
        var cap = R.makeMove(bd, mv);
        var sc = -quiesce(bd, R.other(sd), -beta, -alpha, qdepth - 1);
        R.unmakeMove(bd, mv, cap);
        if (aborted) { return alpha; }
        if (sc >= beta) { return beta; }
        if (sc > alpha) { alpha = sc; }
      }
      return alpha;
    }

    /* Alpha-Beta 主搜索（负极大） */
    function negamax(bd, sd, depth, alpha, beta, ply) {
      nodes += 1;
      if (timeUp()) { aborted = true; return 0; }

      var key = R.zobristKey(bd, sd);
      var entry = tt[key];
      if (entry && entry.depth >= depth) {
        if (entry.flag === 0) { return entry.score; }
        if (entry.flag === 1 && entry.score <= alpha) { return alpha; }
        if (entry.flag === 2 && entry.score >= beta) { return beta; }
      }

      if (depth <= 0) {
        return quiesce(bd, sd, alpha, beta, 4);
      }

      var moves = A.genLegal(bd, sd);
      if (!moves.length) {
        /* 无合法走法：被将则被绝杀，否则困毙，都是负 */
        return -20000 + ply;
      }
      A.sortMoves(bd, moves, history);

      var bestScore = -1e9;
      var flag = 1;              /* 1 = alpha 上界（fail-low）, 2 = beta 下界 */
      for (var i = 0; i < moves.length; i++) {
        var mv = moves[i];
        var cap = R.makeMove(bd, mv);
        var sc = -negamax(bd, R.other(sd), depth - 1, -beta, -alpha, ply + 1);
        R.unmakeMove(bd, mv, cap);
        if (aborted) { return bestScore === -1e9 ? alpha : bestScore; }

        if (sc > bestScore) { bestScore = sc; }
        if (sc > alpha) {
          alpha = sc;
          flag = 0;
          if (ply > 0) { addHistory(mv, depth); }
        }
        if (alpha >= beta) {
          flag = 2;
          break;
        }
      }

      tt[key] = { depth: depth, score: bestScore, flag: flag };
      return bestScore;
    }

    /* 根节点走法 */
    var rootMoves = A.genLegal(board, side);
    if (!rootMoves.length) { return null; }
    A.sortMoves(board, rootMoves, history);

    for (var d = 1; d <= maxDepth; d++) {
      var localBest = null;
      var localScore = -1e9;
      var alpha0 = -1e9, beta0 = 1e9;
      var allScores = [];

      for (var m = 0; m < rootMoves.length; m++) {
        var rmv = rootMoves[m];
        var rcap = R.makeMove(board, rmv);
        var score = -negamax(board, R.other(side), d - 1, -beta0, -alpha0, 1);
        R.unmakeMove(board, rmv, rcap);
        if (aborted) { break; }

        if (score > localScore) {
          localScore = score;
          localBest = rmv;
        }
        if (score > alpha0) { alpha0 = score; }
        allScores.push({ mv: rmv, s: score });
      }

      if (aborted) { break; }

      best = localBest;
      bestScore = localScore;

      /* 简单难度：同分走法里随机，避免每局一模一样 */
      if (randomize && allScores.length) {
        var top = [];
        for (var z = 0; z < allScores.length; z++) {
          if (Math.abs(allScores[z].s - localScore) <= 8) { top.push(allScores[z].mv); }
        }
        if (top.length > 1) {
          best = top[Math.floor(Math.random() * top.length)];
        }
      }

      /* 已找到必胜/必败，无需再深 */
      if (Math.abs(bestScore) > 18000) { break; }
      if (now() > deadline) { break; }
    }

    if (!best) { best = rootMoves[0]; }
    return { mv: best, score: bestScore, depth: maxDepth, nodes: nodes };
  };

  /* ==================== Worker 源码拼装 ==================== */

  /** 把模块上的函数/数据序列化为源码（Worker 内复用同一份实现） */
  function serializeModule(obj, prefix) {
    var parts = [];
    var keys = Object.keys(obj);
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var v = obj[k];
      if (typeof v === 'function') {
        parts.push(prefix + '.' + k + '=' + v.toString() + ';');
      } else if (v !== undefined && v !== null && typeof v !== 'object') {
        parts.push(prefix + '.' + k + '=' + JSON.stringify(v) + ';');
      } else if (v && (Array.isArray(v) || typeof v === 'object') && !(v instanceof RegExp)) {
        try {
          parts.push(prefix + '.' + k + '=' + JSON.stringify(v) + ';');
        } catch (e) { /* 跳过不可序列化对象 */ }
      }
    }
    return parts.join('\n');
  }

  A.buildWorkerSource = function buildWorkerSource() {
    var src = '';
    src += "'use strict';\n";
    src += 'var Chess={Rules:{},AI:{},util:{}};\n';
    src += 'var R=Chess.Rules,A=Chess.AI,U=Chess.util;\n';
    src += serializeModule(Chess.util, 'U') + '\n';
    src += serializeModule(R, 'R') + '\n';
    src += serializeModule(A, 'A') + '\n';
    src += ''
      + 'self.onmessage=function(e){\n'
      + '  var data=e.data||{};\n'
      + '  if(data.type!=="search"){return;}\n'
      + '  try{\n'
      + '    var board=data.board;\n'
      + '    var res=A.searchRoot(board,data.side,{maxDepth:data.maxDepth,deadline:Date.now()+(data.timeLimit||400),nodeLimit:data.nodeLimit,randomize:data.randomize});\n'
      + '    self.postMessage({type:"result",id:data.id,res:res});\n'
      + '  }catch(err){\n'
      + '    self.postMessage({type:"error",id:data.id,msg:String(err&&err.message||err)});\n'
      + '  }\n'
      + '};\n';
    return src;
  };

  /* ==================== 对外接口：异步思考 ==================== */

  var worker = null;          /* 当前 Worker */
  var workerUrl = null;       /* Blob URL */
  var searchId = 0;           /* 递增，丢弃过期结果 */
  var pendingCb = null;       /* 当前等待回调 */
  var pendingId = 0;
  var workerBroken = false;

  function makeWorker() {
    if (workerBroken) { return null; }
    if (typeof global.Worker !== 'function' || typeof global.Blob !== 'function' ||
        typeof global.URL === 'undefined' || typeof global.URL.createObjectURL !== 'function') {
      workerBroken = true;
      return null;
    }
    try {
      var blob = new global.Blob([A.buildWorkerSource()], { type: 'application/javascript' });
      if (workerUrl) { try { global.URL.revokeObjectURL(workerUrl); } catch (e) { } }
      workerUrl = global.URL.createObjectURL(blob);
      var w = new global.Worker(workerUrl);
      w.onmessage = function (e) {
        var data = e.data || {};
        if (data.id !== pendingId) { return; }     /* 丢弃过期结果 */
        var cb = pendingCb;
        pendingCb = null;
        if (data.type === 'error') {
          if (global.console) { console.error('[AI worker]', data.msg); }
          if (cb) { cb(null, { error: data.msg }); }
          return;
        }
        if (cb) { cb(data.res ? data.res.mv : null, data.res || {}); }
      };
      w.onerror = function () {
        workerBroken = true;
        var cb = pendingCb;
        pendingCb = null;
        if (cb) { cb(null, { error: 'worker-error' }); }
      };
      return w;
    } catch (err) {
      workerBroken = true;
      if (global.console) { console.error('[AI] Worker 创建失败，退回主线程搜索', err); }
      return null;
    }
  }

  /** 销毁 Worker（中止当前思考） */
  A.abort = function abort() {
    searchId += 1;
    pendingCb = null;
    pendingId = 0;
    if (worker) {
      try { worker.terminate(); } catch (e) { }
      worker = null;
    }
  };

  /**
   * 让 AI 思考下一步
   * @param {Object} game Chess.Game 实例
   * @param {Object} opt {maxDepth, timeLimit, nodeLimit, randomize}
   * @param {Function} cb 回调 (mv|null, info)
   */
  A.think = function think(game, opt, cb) {
    A.abort();                       /* 中止上一次 */
    searchId += 1;
    var myId = searchId;
    pendingId = myId;
    pendingCb = cb;

    var boardCopy = R.cloneBoard(game.board);
    var side = game.side;
    var payload = {
      type: 'search',
      id: myId,
      board: boardCopy,
      side: side,
      maxDepth: opt.maxDepth || 4,
      timeLimit: Math.min(opt.timeLimit || 400, 1500),
      nodeLimit: opt.nodeLimit || 3000000,
      randomize: !!opt.randomize
    };

    /* 先做一次本地合法性检查：无棋可走就直接判负，绝不卡住 */
    if (!R.hasLegalMove(game.board, side)) {
      pendingCb = null;
      cb(null, { noMove: true });
      return;
    }

    if (!worker) { worker = makeWorker(); }
    if (worker) {
      try {
        worker.postMessage(payload);
        return;
      } catch (err) {
        workerBroken = true;
        worker = null;
      }
    }

    /* ---- 退化路径：主线程给一个短时间预算，保证界面依旧可用 ---- */
    try {
      var res = A.searchRoot(boardCopy, side, {
        maxDepth: Math.min(payload.maxDepth, 3),
        deadline: Date.now() + Math.min(payload.timeLimit, 500),
        nodeLimit: 600000,
        randomize: payload.randomize
      });
      pendingCb = null;
      if (searchId !== myId) { return; }
      cb(res ? res.mv : null, res || {});
    } catch (err2) {
      pendingCb = null;
      if (global.console) { console.error('[AI] 主线程搜索失败', err2); }
      cb(null, { error: 'fallback-failed' });
    }
  };

  /** 难度预设 */
  A.LEVELS = {
    easy: { maxDepth: 2, timeLimit: 200, nodeLimit: 200000, randomize: true, label: '简单' },
    normal: { maxDepth: 4, timeLimit: 400, nodeLimit: 1200000, randomize: false, label: '普通' },
    hard: { maxDepth: 6, timeLimit: 900, nodeLimit: 3000000, randomize: false, label: '困难' }
  };

})(typeof window !== 'undefined' ? window : this);
