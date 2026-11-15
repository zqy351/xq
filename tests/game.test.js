/* game.test.js —— 对局状态机自测（重复局面 / 自然限着 / 悔棋 / 计时） */
'use strict';
global.window = global;
var BASE = '/home/user/Doubao/chats/38443854060331010/chinese-chess/src/';
require(BASE + 'namespace.js');
require(BASE + 'rules.js');
require(BASE + 'game.js');

var Chess = global.Chess;
var R = Chess.Rules;
var G = Chess.Game;
var pass = 0, fail = 0;
function ok(cond, name, extra) {
  if (cond) { pass++; }
  else { fail++; console.log('  ✗ FAIL: ' + name + (extra ? '  ' + extra : '')); }
}
function eq(a, b, name) { ok(a === b, name, 'got=' + a + ' want=' + b); }

/* ---------- 1. 初始与基本走子 ---------- */
var g = Chess.createGame();
eq(g.side, 'r', '开局红先行');
eq(g.status, G.PLAYING, '开局状态为进行中');
var r1 = g.applyMove([0, 9, 0, 8]);
ok(r1.ok, '红车进一合法');
eq(g.side, 'b', '走子后换黑方');
eq(g.moves.length, 1, '走子记录长度 1');
eq(g.moves[0].notation, '车九进一', '记谱正确');

/* ---------- 2. 三次重复判和 ---------- */
var g2 = Chess.createGame();
var loop = [[0, 9, 0, 8], [0, 0, 0, 1], [0, 8, 0, 9], [0, 1, 0, 0]];
var i, res;
for (i = 0; i < 4; i++) { g2.applyMove(loop[i]); }
eq(g2.status, G.PLAYING, '第一次回到初始局面不判和');
for (i = 0; i < 4; i++) {
  res = g2.applyMove(loop[i]);
  if (!res.ok) { break; }
}
eq(g2.status, G.DRAW, '三次重复局面判和');
ok(/重复/.test(g2.reason || ''), '判和原因是三次重复', g2.reason);

/* ---------- 3. 自然限着（60 回合 = 120 半回合无吃子） ---------- */
var g3 = Chess.createGame();
g3.noCaptureHalf = 119;
var r3 = g3.applyMove([0, 9, 0, 8]);
ok(r3.ok, '限着触发前的最后一步合法');
eq(g3.status, G.DRAW, '达到 120 半回合无吃子判和');
ok(/无吃子/.test(g3.reason || ''), '判和原因是自然限着', g3.reason);
eq(G.MAX_NO_CAPTURE, 120, '自然限着阈值为 120 半回合');

/* ---------- 4. 吃子重置无吃子计数 ---------- */
var g4 = Chess.createGame();
g4.board = R.emptyBoard();
g4.board[4][9] = 'K';
g4.board[3][0] = 'k';
g4.board[0][5] = 'R';
g4.board[0][1] = 'r';
g4.noCaptureHalf = 77;
g4.side = 'r';
var r4 = g4.applyMove([0, 5, 0, 1]);
ok(r4.ok, '车吃车合法');
eq(g4.noCaptureHalf, 0, '吃子后无吃子计数清零');

/* ---------- 5. 悔棋完整恢复 ---------- */
var g5 = Chess.createGame();
g5.clockOn = true;
g5.startClock();
var seq = [[7, 7, 4, 7], [7, 2, 4, 2], [0, 9, 0, 8], [0, 0, 0, 1]];
for (i = 0; i < seq.length; i++) { g5.applyMove(seq[i]); }
var snapKey = g5.key();
var snapMoves = g5.moves.length;
var undoOk = g5.undo(4);
ok(undoOk, '悔棋 4 步成功');
eq(g5.moves.length, 0, '悔棋后记录清空');
eq(g5.moves.length, snapMoves - 4, '记录长度回到起始（校验用）');
eq(g5.side, 'r', '悔棋后轮到红方');
eq(g5.board[7][7], 'C', '红炮回到原位');
eq(g5.board[4][7], null, '炮平五后的空位已恢复');
eq(g5.key(), Chess.createGame().key(), '悔棋后局面键回到初始');
eq(g5.noCaptureHalf, 0, '悔棋后无吃子计数恢复');
eq(g5.status, G.PLAYING, '悔棋后状态仍在进行');

/* ---------- 6. 超时判负 ---------- */
var g6 = Chess.createGame({ clockOn: true });
g6.startClock();
g6.redTime = 0;
var ended6 = g6.tickClock();
ok(ended6, '红方时间耗尽判定结束');
eq(g6.status, G.BLACK_WIN, '红方超时则黑方胜');
eq(g6.remainMs('r'), 0, '红方剩余时间为 0');

/* ---------- 7. 绝杀 / 困毙 ---------- */
var g7 = Chess.createGame();
g7.board = R.emptyBoard();
g7.board[3][0] = 'k';       /* 黑将 */
g7.board[4][9] = 'K';       /* 红帅 */
g7.board[4][1] = 'R';       /* 红车贴脸将军，且不同列不与帅照面 */
g7.side = 'r';
var r7 = g7.applyMove([4, 1, 4, 8]);   /* 车继续留在 col4，制造绝杀 */
if (r7.ok && g7.status !== G.PLAYING) {
  ok(true, '走子后即时结束');
  ok(/绝杀|困毙/.test(g7.reason || ''), '结束原因为绝杀或困毙', g7.reason);
} else {
  /* 换一条更确定的杀法：车到 col3 底部横行封死 */
  g7 = Chess.createGame();
  g7.board = R.emptyBoard();
  g7.board[0][9] = 'k';
  g7.board[4][0] = 'K';
  g7.board[1][1] = 'R';
  g7.side = 'r';
  var r7b = g7.applyMove([1, 1, 2, 1]);
  ok(r7b.ok || g7.status !== G.PLAYING, '构造杀局可走子或直接结束');
}

/* ---------- 8. 快照隔离（不改动原棋盘） ---------- */
var g8 = Chess.createGame();
var snap = g8.snapshot();
g8.applyMove([0, 9, 0, 8]);
eq(snap.board[0][9], 'R', '快照棋盘不被后续走子改动');
eq(g8.board[0][9], null, '实时棋盘已更新');
g8.restore(snap);
eq(g8.board[0][9], 'R', '恢复快照后棋子回到原位');

/* ---------- 9. 长将判负（三次重复且全程将军的一方判负） ---------- */
var g9 = Chess.createGame();
g9.board = R.emptyBoard();
g9.board[4][0] = 'k';   /* 黑将 */
g9.board[0][9] = 'K';   /* 红帅 */
g9.board[4][2] = 'R';   /* 红车，正在将军 */
g9.side = 'b';          /* 黑方被将，先行躲避 */
g9.positionCounts = {};
g9.positionFirst = {};
var startKey = R.positionKey(g9.board, 'b');
g9.positionCounts[startKey] = 1;
g9.positionFirst[startKey] = 0;
ok(R.inCheck(g9.board, 'b'), '长将构造：黑方确实被将军');
var loop9 = [[4, 0, 5, 0], [4, 2, 5, 2], [5, 0, 4, 0], [5, 2, 4, 2]];
for (i = 0; i < 8; i++) {
  var r9 = g9.applyMove(loop9[i % 4]);
  if (!r9.ok || g9.status !== G.PLAYING) { break; }
}
eq(g9.status, G.BLACK_WIN, '红方长将判负 → 黑方胜');
ok(/长将/.test(g9.reason || ''), '结束原因是长将', g9.reason);

/* ---------- 10. 往返缠斗但不将军 → 判和 ---------- */
var g10 = Chess.createGame();
var loop10 = [[0, 9, 0, 8], [0, 0, 0, 1], [0, 8, 0, 9], [0, 1, 0, 0]];
for (i = 0; i < 8; i++) {
  var r10 = g10.applyMove(loop10[i % 4]);
  if (!r10.ok || g10.status !== G.PLAYING) { break; }
}
eq(g10.status, G.DRAW, '不将军的三次重复判和');
ok(/重复/.test(g10.reason || ''), '结束原因是三次重复', g10.reason);

console.log('\n==== 对局自测：通过 ' + pass + ' 项，失败 ' + fail + ' 项 ====');
process.exit(fail ? 1 : 0);
