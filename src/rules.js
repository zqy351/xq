/* ===================================================================
 * rules.js —— 中国象棋规则（纯逻辑，不碰 DOM）
 * ---------------------------------------------------------------
 * 棋盘 board[col][row]
 *   col = 0..8   （红方视角从左到右）
 *   row = 9      （红方底线，屏幕下方）
 *   row = 0      （黑方底线，屏幕上方）
 * 棋子编码：红方大写 K A B N R C P，黑方小写 k a b n r c p
 *
 * 所有函数挂在 Chess.Rules（内部别名 R）上，并且写成"命名函数表达式"：
 * 这样 AI 的 Worker 可以通过 toString() 注入同一份规则源码，
 * 保证走法生成 / 搜索 / 胜负判定共用同一个实现，不会写岔。
 * =================================================================== */
(function (global) {
  'use strict';

  var Chess = global.Chess;
  var R = Chess.Rules = {};

  /* 阵营标识 */
  R.RED = 'r';
  R.BLACK = 'b';

  /* ==================== 基础工具 ==================== */

  /** 是否红方棋子 */
  R.isRed = function isRed(p) { return !!p && p === p.toUpperCase(); };

  /** 棋子类型（统一大写） */
  R.typeOf = function typeOf(p) { return p ? p.toUpperCase() : null; };

  /** 棋子所属阵营：'r' / 'b' / null */
  R.sideOf = function sideOf(p) {
    if (!p) { return null; }
    return p === p.toUpperCase() ? 'r' : 'b';
  };

  /** 对方阵营 */
  R.other = function other(side) { return side === 'r' ? 'b' : 'r'; };

  /** 是否落在九宫内 */
  R.inPalace = function inPalace(col, row, side) {
    if (col < 3 || col > 5) { return false; }
    return side === 'r' ? (row >= 7 && row <= 9) : (row >= 0 && row <= 2);
  };

  /** 空棋盘 */
  R.emptyBoard = function emptyBoard() {
    var b = [], c, r;
    for (c = 0; c < 9; c++) {
      b[c] = [];
      for (r = 0; r < 10; r++) { b[c][r] = null; }
    }
    return b;
  };

  /** 初始布局（红黑严格镜像） */
  R.initialBoard = function initialBoard() {
    var b = R.emptyBoard();
    /* 底线车马象士将士象马车 */
    var back = ['R', 'N', 'B', 'A', 'K', 'A', 'B', 'N', 'R'];
    var c;
    for (c = 0; c < 9; c++) {
      b[c][0] = back[c].toLowerCase();   /* 黑方 row0 */
      b[c][9] = back[c];                 /* 红方 row9 */
    }
    /* 炮：col 1、7，黑 row2 / 红 row7 */
    b[1][2] = 'c'; b[7][2] = 'c';
    b[1][7] = 'C'; b[7][7] = 'C';
    /* 卒/兵：col 0,2,4,6,8，黑 row3 / 红 row6 */
    var pawnCols = [0, 2, 4, 6, 8];
    for (var i = 0; i < pawnCols.length; i++) {
      b[pawnCols[i]][3] = 'p';
      b[pawnCols[i]][6] = 'P';
    }
    return b;
  };

  /** 复制棋盘（9×10 二维，仅供非热点路径使用） */
  R.cloneBoard = function cloneBoard(board) {
    var b = [], c, r;
    for (c = 0; c < 9; c++) {
      b[c] = [];
      for (r = 0; r < 10; r++) { b[c][r] = board[c][r]; }
    }
    return b;
  };
  /* 兼容别名 */
  R.copyBoard = R.cloneBoard;

  /** 找到某方将/帅位置 */
  R.findKing = function findKing(board, side) {
    var target = side === 'r' ? 'K' : 'k';
    for (var c = 3; c <= 5; c++) {
      for (var r = side === 'r' ? 7 : 0, end = side === 'r' ? 9 : 2; r <= end; r++) {
        if (board[c][r] === target) { return { c: c, r: r }; }
      }
    }
    /* 兜底：全盘搜索（理论上不会走到这里） */
    for (var c2 = 0; c2 < 9; c2++) {
      for (var r2 = 0; r2 < 10; r2++) {
        if (board[c2][r2] === target) { return { c: c2, r: r2 }; }
      }
    }
    return null;
  };

  /* ==================== 走法生成（伪合法） ==================== */

  /* 方向常量挂到命名空间上：AI 的 Worker 通过 toString() 注入规则源码时，
     闭包内的局部变量无法搬运，只有挂在 R 上的数据才会被序列化。 */
  R.DIRS = {
    KNIGHT: [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]],
    DIAG: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
    ORTHO: [[1, 0], [-1, 0], [0, 1], [0, -1]]
  };

  /**
   * 生成某一格棋子的全部伪合法走法（不检查自将与照面）
   * @returns {Array<Array<number>>} [[fc, fr, tc, tr], ...]
   */
  R.pseudoMoves = function pseudoMoves(board, col, row) {
    var p = board[col] ? board[col][row] : null;
    if (!p) { return []; }
    var side = R.sideOf(p);
    var type = R.typeOf(p);
    var out = [];
    var tc, tr, t, d, c2, r2;

    var add = function (c, r) {
      if (c < 0 || c > 8 || r < 0 || r > 9) { return; }
      t = board[c][r];
      if (t && R.sideOf(t) === side) { return; }   /* 不能吃己方子 */
      out.push([col, row, c, r]);
    };

    switch (type) {
      /* ---- 将 / 帅：九宫内直走一格 ---- */
      case 'K':
        for (d = 0; d < 4; d++) {
          c2 = col + R.DIRS.ORTHO[d][0];
          r2 = row + R.DIRS.ORTHO[d][1];
          if (R.inPalace(c2, r2, side)) { add(c2, r2); }
        }
        break;

      /* ---- 士 / 仕：九宫内斜走一格 ---- */
      case 'A':
        for (d = 0; d < 4; d++) {
          c2 = col + R.DIRS.DIAG[d][0];
          r2 = row + R.DIRS.DIAG[d][1];
          if (R.inPalace(c2, r2, side)) { add(c2, r2); }
        }
        break;

      /* ---- 象 / 相：田字对角，塞象眼则不可走，不得过河 ---- */
      case 'B':
        for (d = 0; d < 4; d++) {
          c2 = col + R.DIRS.DIAG[d][0] * 2;
          r2 = row + R.DIRS.DIAG[d][1] * 2;
          if (c2 < 0 || c2 > 8 || r2 < 0 || r2 > 9) { continue; }
          /* 不得过河：红象 row>=5，黑象 row<=4 */
          if (side === 'r' && r2 < 5) { continue; }
          if (side === 'b' && r2 > 4) { continue; }
          /* 象眼 */
          if (board[col + R.DIRS.DIAG[d][0]][row + R.DIRS.DIAG[d][1]]) { continue; }
          add(c2, r2);
        }
        break;

      /* ---- 马：日字，蹩马腿则该方向不可走 ---- */
      case 'N':
        for (d = 0; d < 8; d++) {
          var dc = R.DIRS.KNIGHT[d][0];
          var dr = R.DIRS.KNIGHT[d][1];
          c2 = col + dc;
          r2 = row + dr;
          if (c2 < 0 || c2 > 8 || r2 < 0 || r2 > 9) { continue; }
          /* 马腿：直走两步方向上的相邻格 */
          var legC = Math.abs(dc) === 2 ? col + dc / 2 : col;
          var legR = Math.abs(dr) === 2 ? row + dr / 2 : row;
          if (board[legC] && board[legC][legR]) { continue; }
          add(c2, r2);
        }
        break;

      /* ---- 车：直线任意格，路径无子 ---- */
      case 'R':
        for (d = 0; d < 4; d++) {
          c2 = col + R.DIRS.ORTHO[d][0];
          r2 = row + R.DIRS.ORTHO[d][1];
          while (c2 >= 0 && c2 <= 8 && r2 >= 0 && r2 <= 9) {
            t = board[c2][r2];
            if (!t) {
              out.push([col, row, c2, r2]);
            } else {
              if (R.sideOf(t) !== side) { out.push([col, row, c2, r2]); }
              break;
            }
            c2 += R.DIRS.ORTHO[d][0];
            r2 += R.DIRS.ORTHO[d][1];
          }
        }
        break;

      /* ---- 炮：不吃子同车；吃子须隔且仅隔一子 ---- */
      case 'C':
        for (d = 0; d < 4; d++) {
          var jumped = false;
          c2 = col + R.DIRS.ORTHO[d][0];
          r2 = row + R.DIRS.ORTHO[d][1];
          while (c2 >= 0 && c2 <= 8 && r2 >= 0 && r2 <= 9) {
            t = board[c2][r2];
            if (!jumped) {
              if (!t) {
                out.push([col, row, c2, r2]);
              } else {
                jumped = true;                 /* 找到炮架 */
              }
            } else {
              if (t) {
                if (R.sideOf(t) !== side) { out.push([col, row, c2, r2]); }
                break;                          /* 越过第一个子后必须立即结束 */
              }
            }
            c2 += R.DIRS.ORTHO[d][0];
            r2 += R.DIRS.ORTHO[d][1];
          }
        }
        break;

      /* ---- 兵 / 卒：未过河只能前进；过河后可前进或横走；永不后退 ---- */
      case 'P':
        var forward = side === 'r' ? -1 : 1;
        var crossed = side === 'r' ? (row <= 4) : (row >= 5);
        add(col, row + forward);
        if (crossed) {
          add(col - 1, row);
          add(col + 1, row);
        }
        break;

      default:
        break;
    }
    return out;
  };

  /* ==================== 走后模拟 ==================== */

  /** 就地落子，返回被吃掉的棋子（可能为 null） */
  R.makeMove = function makeMove(board, mv) {
    var cap = board[mv[2]][mv[3]];
    board[mv[2]][mv[3]] = board[mv[0]][mv[1]];
    board[mv[0]][mv[1]] = null;
    return cap || null;
  };

  /** 撤回 makeMove */
  R.unmakeMove = function unmakeMove(board, mv, cap) {
    board[mv[0]][mv[1]] = board[mv[2]][mv[3]];
    board[mv[2]][mv[3]] = cap || null;
  };

  /* ==================== 将军 / 照面 判定 ==================== */

  /**
   * 将帅是否照面（同列且中间无子）
   */
  R.kingsFace = function kingsFace(board) {
    var rk = R.findKing(board, 'r');
    var bk = R.findKing(board, 'b');
    if (!rk || !bk) { return false; }
    if (rk.c !== bk.c) { return false; }
    var lo = Math.min(rk.r, bk.r);
    var hi = Math.max(rk.r, bk.r);
    for (var r = lo + 1; r < hi; r++) {
      if (board[rk.c][r]) { return false; }
    }
    return true;
  };

  /** 某个兵/卒能否攻击到目标格（用于反向检查） */
  R.pawnAttacks = function pawnAttacks(piece, fromC, fromR, toC, toR) {
    var side = R.sideOf(piece);
    var forward = side === 'r' ? -1 : 1;
    var crossed = side === 'r' ? (fromR <= 4) : (fromR >= 5);
    if (fromC === toC && fromR + forward === toR) { return true; }
    if (crossed && fromR === toR && Math.abs(fromC - toC) === 1) { return true; }
    return false;
  };

  /**
   * 反向攻击检测：side 方的将/帅是否正被对方攻击（不含"照面"，照面单独判）
   * 比"枚举对方全部伪走法"快得多，AI 搜索里每个节点都会调用。
   */
  R.inCheck = function inCheck(board, side) {
    var kp = R.findKing(board, side);
    if (!kp) { return true; }
    var kc = kp.c, kr = kp.r;
    var opp = R.other(side);
    var d, c2, r2, t, blocked, p;

    /* 1) 车 / 炮：四条射线 */
    for (d = 0; d < 4; d++) {
      c2 = kc + R.DIRS.ORTHO[d][0];
      r2 = kr + R.DIRS.ORTHO[d][1];
      blocked = false;
      while (c2 >= 0 && c2 <= 8 && r2 >= 0 && r2 <= 9) {
        t = board[c2][r2];
        if (t) {
          if (!blocked) {
            /* 第一个子若是对方车 → 被将军 */
            if (R.sideOf(t) === opp && R.typeOf(t) === 'R') { return true; }
            blocked = true;
          } else {
            /* 炮架之后第一个子若是对方炮 → 被将军 */
            if (R.sideOf(t) === opp && R.typeOf(t) === 'C') { return true; }
            break;
          }
        }
        c2 += R.DIRS.ORTHO[d][0];
        r2 += R.DIRS.ORTHO[d][1];
      }
    }

    /* 2) 马：八个可能攻击点 */
    for (d = 0; d < 8; d++) {
      var mc = kc + R.DIRS.KNIGHT[d][0];
      var mr = kr + R.DIRS.KNIGHT[d][1];
      if (mc < 0 || mc > 8 || mr < 0 || mr > 9) { continue; }
      p = board[mc][mr];
      if (!p || R.sideOf(p) !== opp || R.typeOf(p) !== 'N') { continue; }
      /* 马腿：从马位出发朝将位先直走的那一步 */
      var legC, legR;
      if (Math.abs(mc - kc) === 1) {
        legC = mc;
        legR = mr + (kr - mr > 0 ? 1 : -1);
      } else {
        legC = mc + (kc - mc > 0 ? 1 : -1);
        legR = mr;
      }
      if (legC >= 0 && legC <= 8 && legR >= 0 && legR <= 9 && !board[legC][legR]) { return true; }
    }

    /* 3) 兵 / 卒：将周围四个相邻格 */
    for (d = 0; d < 4; d++) {
      c2 = kc + R.DIRS.ORTHO[d][0];
      r2 = kr + R.DIRS.ORTHO[d][1];
      if (c2 < 0 || c2 > 8 || r2 < 0 || r2 > 9) { continue; }
      p = board[c2][r2];
      if (!p || R.sideOf(p) !== opp || R.typeOf(p) !== 'P') { continue; }
      if (R.pawnAttacks(p, c2, r2, kc, kr)) { return true; }
    }

    /* 4) 对方将/帅贴脸（同行相邻时可吃） */
    var ok = R.findKing(board, opp);
    if (ok && Math.abs(ok.c - kc) + Math.abs(ok.r - kr) === 1) { return true; }

    return false;
  };

  /**
   * 统一合法性过滤（唯一入口）：
   * 就地走后模拟 → 检查(1)己方将是否被攻击 (2)双方将帅是否照面 → 撤回
   */
  R.isLegal = function isLegal(board, mv, side) {
    var cap = R.makeMove(board, mv);
    var bad = R.inCheck(board, side) || R.kingsFace(board);
    R.unmakeMove(board, mv, cap);
    return !bad;
  };

  /** 某格棋子的全部合法走法 */
  R.legalMovesOf = function legalMovesOf(board, col, row) {
    var p = board[col] ? board[col][row] : null;
    if (!p) { return []; }
    var side = R.sideOf(p);
    var raw = R.pseudoMoves(board, col, row);
    var out = [];
    for (var i = 0; i < raw.length; i++) {
      if (R.isLegal(board, raw[i], side)) { out.push(raw[i]); }
    }
    return out;
  };

  /** 某方全部合法走法 */
  R.allLegalMoves = function allLegalMoves(board, side) {
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

  /** 某方是否还有合法走法 */
  R.hasLegalMove = function hasLegalMove(board, side) {
    var c, r, p, raw, i;
    for (c = 0; c < 9; c++) {
      for (r = 0; r < 10; r++) {
        p = board[c][r];
        if (!p || R.sideOf(p) !== side) { continue; }
        raw = R.pseudoMoves(board, c, r);
        for (i = 0; i < raw.length; i++) {
          if (R.isLegal(board, raw[i], side)) { return true; }
        }
      }
    }
    return false;
  };

  /**
   * 局面字符串（三次重复判定用，含走子方）
   */
  R.positionKey = function positionKey(board, side) {
    var parts = [side];
    for (var c = 0; c < 9; c++) {
      var seg = '';
      for (var r = 0; r < 10; r++) {
        seg += (board[c][r] || '.');
      }
      parts.push(seg);
    }
    return parts.join('|');
  };

  /** 简易 Zobrist 键（AI 置换表用，64 位数值近似：两个 32 位拼接为串） */
  R.zobristKey = function zobristKey(board, side) {
    var key = 0;
    for (var c = 0; c < 9; c++) {
      for (var r = 0; r < 10; r++) {
        var p = board[c][r];
        if (!p) { continue; }
        var idx = (c * 10 + r) * 32 + (p.charCodeAt(0) % 32);
        key = (key ^ Math.imul(idx + 0x9e3779b9, 0x85ebca6b)) >>> 0;
        key = (key + Math.imul(idx ^ 0xc2b2ae35, 0x27d4eb2f)) >>> 0;
      }
    }
    if (side === 'b') { key ^= 0x5bf03635; }
    return key.toString(36) + ':' + key;
  };

  /* ==================== 走法文字（中文记谱） ==================== */
  R.CN_NUM = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
  R.AR_NUM = ['1', '2', '3', '4', '5', '6', '7', '8', '9'];
  R.CN_PIECE = { K: '帅', A: '仕', B: '相', N: '马', R: '车', C: '炮', P: '兵' };
  R.CN_PIECE_B = { K: '将', A: '士', B: '象', N: '马', R: '车', C: '炮', P: '卒' };

  /** 列号：红方从右到左 1..9 用汉字；黑方从左到右 1..9 用数字 */
  R.fileLabel = function fileLabel(col, side) {
    if (side === 'r') { return R.CN_NUM[8 - col]; }
    return R.AR_NUM[col];
  };

  /**
   * 生成中文记谱（须在走子之前调用，board 为走子前局面）
   * 例：炮二平五、马8进7、前车进三
   */
  R.notation = function notation(board, mv) {
    var p = board[mv[0]][mv[1]];
    if (!p) { return '（无子）'; }
    var side = R.sideOf(p);
    var type = R.typeOf(p);
    var name = side === 'r' ? R.CN_PIECE[type] : R.CN_PIECE_B[type];
    var fromC = mv[0], fromR = mv[1], toC = mv[2], toR = mv[3];

    /* 同列同类多子：用 前/后 修饰（红方 row 小者为前） */
    var sameCol = [];
    for (var r = 0; r < 10; r++) {
      var q = board[fromC][r];
      if (q && R.sideOf(q) === side && R.typeOf(q) === type) { sameCol.push(r); }
    }
    var prefix = '';
    if (sameCol.length >= 2 && (type === 'R' || type === 'N' || type === 'C' || type === 'P')) {
      var idx = sameCol.indexOf(fromR);
      var isFront = side === 'r' ? (idx === 0) : (idx === sameCol.length - 1);
      if (sameCol.length === 2) {
        prefix = isFront ? '前' : '后';
      } else if (sameCol.length >= 3) {
        if (idx === 0 || idx === sameCol.length - 1) {
          prefix = isFront ? '前' : '后';
        } else {
          prefix = '中';
        }
      }
      name = prefix + name;
    } else {
      name = name + R.fileLabel(fromC, side);
    }

    /* 动作 */
    var action, target;
    if (type === 'N' || type === 'B' || type === 'A') {
      action = toR < fromR ? '进' : '退';
      target = R.fileLabel(toC, side);
    } else if (fromC === toC) {
      action = toR < fromR ? '进' : '退';
      var steps = Math.abs(toR - fromR);
      target = side === 'r' ? R.CN_NUM[steps - 1] : R.AR_NUM[steps - 1];
    } else {
      action = '平';
      target = R.fileLabel(toC, side);
    }
    return name + action + target;
  };

  /** 兵/卒等是否已过河（AI 评估用） */
  R.isCrossedPawn = function isCrossedPawn(p, row) {
    var side = R.sideOf(p);
    return side === 'r' ? row <= 4 : row >= 5;
  };

})(typeof window !== 'undefined' ? window : this);
