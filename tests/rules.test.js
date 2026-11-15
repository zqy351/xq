/* rules.test.js —— 规则层自测（node 直接跑，不进浏览器） */
'use strict';
global.window = global;
require('/home/user/Doubao/chats/38443854060331010/chinese-chess/src/namespace.js');
require('/home/user/Doubao/chats/38443854060331010/chinese-chess/src/rules.js');

var R = global.Chess.Rules;
var pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; console.log('  ✗ FAIL: ' + name + (extra ? '  ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'got=' + a + ' want=' + b); }

/* ---------- 1. 初始布局 ---------- */
var b = R.initialBoard();
eq(b[0][0], 'r', '黑车 col0');
eq(b[4][0], 'k', '黑将 col4');
eq(b[0][9], 'R', '红车 col0');
eq(b[4][9], 'K', '红帅 col4');
eq(b[1][2], 'c', '黑炮');
eq(b[7][7], 'C', '红炮');
eq(b[0][3], 'p', '黑卒 col0');
eq(b[4][6], 'P', '红兵 col4');
eq(b[3][6], null, '空位');
// 棋子总数 32
var cnt = 0;
for (var c = 0; c < 9; c++) for (var r = 0; r < 10; r++) if (b[c][r]) cnt++;
eq(cnt, 32, '棋子总数 32');

/* ---------- 2. 初始局面走法数 ---------- */
// 红方开局：车2、马2、炮2、兵5 各有走法；总合法走法 44 步（中国象棋标准）
var redMoves = R.allLegalMoves(b, 'r');
eq(redMoves.length, 44, '红方开局合法走法 44');
var blackMoves = R.allLegalMoves(b, 'b');
eq(blackMoves.length, 44, '黑方开局合法走法 44');

// 车：开局 col0 row9 的车可上 1 格（马挡）→ 合法 1 步（row8）
var carMoves = R.legalMovesOf(b, 0, 9);
eq(carMoves.length, 2, '角车开局 2 步（row8、row7）');

// 马：开局 col1 row9 的马可走 2 个方向
var horseMoves = R.legalMovesOf(b, 1, 9);
eq(horseMoves.length, 2, '开局马 2 步');

// 炮：col1 row7 可前进（row6 是兵挡？col1 row6 无兵）→ 沿列可走 row3..row6 共 4 格
var cannonMoves = R.legalMovesOf(b, 1, 7);
ok(cannonMoves.length >= 4, '开局炮至少 4 步', 'got=' + cannonMoves.length);

// 兵：col0 row6 只能前进一格
var pawnMoves = R.legalMovesOf(b, 0, 6);
eq(pawnMoves.length, 1, '兵未过河只能前进');

/* ---------- 3. 马腿 / 象眼 / 炮架 / 兵过河 ---------- */
var t = R.emptyBoard();
t[4][9] = 'K'; t[3][0] = 'k';        /* 黑将放 col3，避免中路照面干扰 */
t[4][5] = 'N';
var noLeg = R.legalMovesOf(t, 4, 5);
eq(noLeg.length, 8, '马中心无蹩腿时 8 步');
var canUpLeft = noLeg.some(function (m) { return m[2] === 3 && m[3] === 3; });
var canUpRight = noLeg.some(function (m) { return m[2] === 5 && m[3] === 3; });
ok(canUpLeft && canUpRight, '马可向上两个日字');
t[4][4] = 'p';                       /* 蹩住正上方马腿 */
var legBlocked = R.legalMovesOf(t, 4, 5);
var upNow = legBlocked.some(function (m) { return (m[2] === 3 || m[2] === 5) && m[3] === 3; });
ok(!upNow, '马腿被塞后向上的两个日字不可走');
ok(legBlocked.length === 6, '蹩一条腿后剩 6 步', 'got=' + legBlocked.length);

// 象眼：象在 (2,9)？红象在 (3,9)... 用 (4,7) 中心 田字 (2,9)
var e = R.emptyBoard();
e[4][9] = 'K'; e[3][0] = 'k';
e[2][7] = 'B';                       // 红象
var elephant = R.legalMovesOf(e, 2, 7);
ok(elephant.every(function (m) { return m[3] >= 5; }), '象不过河（所有目标 row>=5）');
var eyeBlocked = R.legalMovesOf(e, 2, 7).some(function (m) { return m[2] === 0 && m[3] === 5; });
ok(eyeBlocked, '象眼空时可走 (0,5)');
e[1][6] = 'p';                       // 塞象眼
var eye2 = R.legalMovesOf(e, 2, 7).some(function (m) { return m[2] === 0 && m[3] === 5; });
ok(!eye2, '塞象眼后不可走 (0,5)');

// 炮架：炮 (4,5)，目标 (4,1) 有黑将；中间无子 → 不能吃
var p2 = R.emptyBoard();
p2[4][9] = 'K'; p2[4][1] = 'k';
p2[4][5] = 'C';
var noScreen = R.legalMovesOf(p2, 4, 5).some(function (m) { return m[2] === 4 && m[3] === 1; });
ok(!noScreen, '炮无炮架不能吃将');
p2[4][3] = 'p';                      // 一个炮架
var screen1 = R.legalMovesOf(p2, 4, 5).some(function (m) { return m[2] === 4 && m[3] === 1; });
ok(screen1, '炮隔一子可吃将');
p2[4][2] = 'p';                      // 两个炮架
var screen2 = R.legalMovesOf(p2, 4, 5).some(function (m) { return m[2] === 4 && m[3] === 1; });
ok(!screen2, '炮隔两子不能吃');

// 兵过河：红兵 row4 可横走；row5 不可横走
var pw = R.emptyBoard();
pw[4][9] = 'K'; pw[3][0] = 'k';
pw[4][4] = 'P';
var crossMoves = R.legalMovesOf(pw, 4, 4);
ok(crossMoves.some(function (m) { return m[2] === 3 && m[3] === 4; }), '红兵过河后可左移');
ok(crossMoves.some(function (m) { return m[2] === 4 && m[3] === 3; }), '红兵可前进');
ok(!crossMoves.some(function (m) { return m[3] === 5; }), '红兵永不后退');
pw[4][4] = null; pw[4][5] = 'P';
var notCrossed = R.legalMovesOf(pw, 4, 5);
ok(!notCrossed.some(function (m) { return m[2] === 3; }), '未过河红兵不能横走');

/* ---------- 4. 照面与自将 ---------- */
var f = R.emptyBoard();
f[4][9] = 'K'; f[4][0] = 'k';
ok(R.kingsFace(f) === true, '空盘中路照面');
f[4][5] = 'p';
ok(R.kingsFace(f) === false, '中间有子不照面');
// 自将：红帅在 (4,9)，黑车在 (4,0)，中间空 → 红帅被攻击
var chk = R.emptyBoard();
chk[4][9] = 'K'; chk[4][0] = 'r';
ok(R.inCheck(chk, 'r') === true, '黑车直线攻击红帅');
// 中间挡子
chk[4][5] = 'P';
ok(R.inCheck(chk, 'r') === false, '有挡子不被将军');

/* ---------- 5. inCheck 反向检测 vs 暴力枚举（交叉验证，随机局面） ---------- */
function bruteCheck(board, side) {
  var opp = R.other(side);
  var kp = R.findKing(board, side);
  if (!kp) return true;
  for (var c = 0; c < 9; c++) {
    for (var r = 0; r < 10; r++) {
      var p = board[c][r];
      if (!p || R.sideOf(p) !== opp) continue;
      var ms = R.pseudoMoves(board, c, r);
      for (var i = 0; i < ms.length; i++) {
        if (ms[i][2] === kp.c && ms[i][3] === kp.r) return true;
      }
    }
  }
  return false;
}

var seed = 12345;
function rnd() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
var mismatch = 0, tested = 0;
var pieceChars = ['R', 'N', 'B', 'A', 'C', 'P', 'r', 'n', 'b', 'a', 'c', 'p'];
for (var iter = 0; iter < 3000; iter++) {
  var rb = R.emptyBoard();
  // 双方将帅固定在合法九宫格内随机
  rb[3 + Math.floor(rnd() * 3)][7 + Math.floor(rnd() * 3)] = 'K';
  rb[3 + Math.floor(rnd() * 3)][Math.floor(rnd() * 3)] = 'k';
  // 随机撒 0~14 个子
  var n = Math.floor(rnd() * 15);
  for (var k = 0; k < n; k++) {
    var cc = Math.floor(rnd() * 9), rr = Math.floor(rnd() * 10);
    if (rb[cc][rr]) continue;
    rb[cc][rr] = pieceChars[Math.floor(rnd() * pieceChars.length)];
  }
  ['r', 'b'].forEach(function (side) {
    tested++;
    var a = !!R.inCheck(rb, side);
    var b2 = bruteCheck(rb, side);
    if (a !== b2) {
      mismatch++;
      if (mismatch <= 3) {
        console.log('  ✗ 将军检测不一致 side=' + side + ' reverse=' + a + ' brute=' + b2);
        var rows = [];
        for (var rr2 = 0; rr2 < 10; rr2++) {
          var line = '';
          for (var cc2 = 0; cc2 < 9; cc2++) line += (rb[cc2][rr2] || '.') + ' ';
          rows.push(line);
        }
        console.log(rows.join('\n'));
      }
    }
  });
}
eq(mismatch, 0, '反向将军检测与暴力枚举一致（' + tested + ' 次）');

/* ---------- 6. 合法性过滤：被将时必须应将 ---------- */
var g = R.emptyBoard();
g[4][9] = 'K'; g[4][0] = 'k'; g[4][2] = 'r';   // 黑车将军红帅
g[0][9] = 'R';
var gm = R.allLegalMoves(g, 'r');
// 红方只能用帅躲或车挡
ok(gm.length > 0, '被将时仍有合法走法（可解将）');
ok(gm.every(function (m) {
  var cap = R.makeMove(g, m);
  var bad = R.inCheck(g, 'r') || R.kingsFace(g);
  R.unmakeMove(g, m, cap);
  return !bad;
}), '所有返回的合法走法都确实解除了将军');

/* ---------- 7. 绝杀（闷杀）判定素材 ---------- */
var mate = R.emptyBoard();
mate[4][9] = 'K';                 // 红帅（九宫中心底线）
mate[4][2] = 'k';                 // 黑将
mate[4][0] = 'r';                 // 黑车：col4 直线将军红帅
mate[0][9] = 'r';                 // 黑车：封锁 row9
mate[0][8] = 'r';                 // 黑车：封锁 row8
ok(R.inCheck(mate, 'r') === true, '绝杀局面：红帅被将军');
eq(R.allLegalMoves(mate, 'r').length, 0, '绝杀局面：红方无任何合法走法');
ok(R.hasLegalMove(mate, 'r') === false, '绝杀局面：hasLegalMove 为 false');

/* ---------- 8. 记谱 ---------- */
var nb = R.initialBoard();
eq(R.notation(nb, [7, 7, 4, 7]), '炮二平五', '红炮二平五记谱');
eq(R.notation(nb, [1, 7, 4, 7]), '炮八平五', '红炮八平五记谱');
eq(R.notation(nb, [1, 9, 2, 7]), '马八进七', '红马八进七记谱');
eq(R.notation(nb, [1, 2, 4, 2]), '炮2平5', '黑炮2平5记谱');

/* ---------- 9. Zobrist 稳定性 ---------- */
var z1 = R.zobristKey(nb, 'r');
var z2 = R.zobristKey(R.cloneBoard(nb), 'r');
eq(z1, z2, 'Zobrist 对相同局面稳定');
var z3 = R.zobristKey(nb, 'b');
ok(z1 !== z3, 'Zobrist 区分走子方');

console.log('\n==== 规则自测：通过 ' + pass + ' 项，失败 ' + fail + ' 项 ====');
process.exit(fail ? 1 : 0);
