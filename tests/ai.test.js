/* ai.test.js —— AI 层自测 */
'use strict';
global.window = global;
require('/home/user/Doubao/chats/38443854060331010/chinese-chess/src/namespace.js');
require('/home/user/Doubao/chats/38443854060331010/chinese-chess/src/rules.js');
require('/home/user/Doubao/chats/38443854060331010/chinese-chess/src/game.js');
require('/home/user/Doubao/chats/38443854060331010/chinese-chess/src/ai.js');

var R = Chess.Rules, A = Chess.AI;
var pass = 0, fail = 0;
function ok(c, n, extra) { if (c) pass++; else { fail++; console.log('  ✗ ' + n + (extra ? '  ' + extra : '')); } }

/* 1. 评估对称性：同一局面红黑视角分数应互为相反数 */
var b = R.initialBoard();
var er = A.evaluate(b, 'r');
var eb = A.evaluate(b, 'b');
ok(Math.abs(er + eb) < 1e-6, '初始局面评估红黑对称 (r=' + er + ', b=' + eb + ')');
ok(Math.abs(er) < 30, '初始局面评估接近 0 (r=' + er + ')');

/* 2. 搜索能返回合法走法 */
var res = A.searchRoot(R.cloneBoard(b), 'r', { maxDepth: 3, deadline: Date.now() + 600, nodeLimit: 400000 });
ok(res && Array.isArray(res.mv) && res.mv.length === 4, '搜索返回 4 元走法');
ok(R.isLegal(R.cloneBoard(b), res.mv, 'r'), '搜索返回的走法合法');
console.log('  搜索: ' + R.notation(b, res.mv) + '  分数=' + res.score + '  节点=' + res.nodes);

/* 3. 必吃局面：AI 应吃掉无保护的车 */
var t = R.emptyBoard();
t[4][9] = 'K'; t[3][0] = 'k';   /* 黑将放 col3，避免中路照面 */
t[0][5] = 'R';            /* 红车 */
t[0][1] = 'r';            /* 黑车，孤子无保护，应被白吃 */
t[8][1] = 'c';            /* 黑炮在远处（row1 上有炮架才够得着，此处够不着） */
var eat = A.searchRoot(R.cloneBoard(t), 'r', { maxDepth: 3, deadline: Date.now() + 500, nodeLimit: 300000 });
ok(eat && eat.mv[0] === 0 && eat.mv[1] === 5 && eat.mv[2] === 0 && eat.mv[3] === 1,
  'AI 会吃掉无保护的黑车', JSON.stringify(eat && eat.mv));

/* 4. 不能白送子：AI 不应把车送到对方车口里 */
var t2 = R.emptyBoard();
t2[4][9] = 'K'; t2[3][0] = 'k';
t2[4][5] = 'N';           /* 红马 */
t2[4][3] = 'r';           /* 黑车控制 col4 与 row3：马走到 (3,3)/(5,3) 会被白吃 */
var mv = A.searchRoot(R.cloneBoard(t2), 'r', { maxDepth: 4, deadline: Date.now() + 600, nodeLimit: 400000 });
var losesHorse = false;
if (mv) {
  var hangsHorse = (mv.mv[2] === 3 || mv.mv[2] === 5) && mv.mv[3] === 3;
  if (hangsHorse) {
    var capT = R.makeMove(t2, mv.mv);
    var blackMoves = R.allLegalMoves(t2, 'b');
    for (var i = 0; i < blackMoves.length; i++) {
      var m = blackMoves[i];
      if (t2[m[0]][m[1]] === 'r' && t2[m[2]][m[3]] === 'N') { losesHorse = true; }
    }
    R.unmakeMove(t2, mv.mv, capT);
  }
  console.log('  （参考）该局面 AI 走 ' + R.notation(R.cloneBoard(t2), mv.mv));
}
ok(!losesHorse, 'AI 不会把马主动送到对方车口下');

/* 5. 一步杀：AI 应找到绝杀 */
var mate = R.emptyBoard();
mate[4][9] = 'K'; mate[3][0] = 'k';
mate[4][4] = 'R';         /* 红车 */
mate[0][1] = 'R';         /* 红车 */
/* 黑将在 (3,0)，红车 (4,4)->(4,0) 将军，另一车 (0,1) 控制 row... 用一个简单的一步杀：
   (4,4) 车走到 (3,4) 将军？黑将可逃。改用经典：双车错 */
var mate2 = R.emptyBoard();
mate2[4][9] = 'K'; mate2[3][0] = 'k';
mate2[4][3] = 'R';        /* 红车控制 col4 第3行 */
mate2[0][0] = 'R';        /* 红车 */
var mres = A.searchRoot(R.cloneBoard(mate2), 'r', { maxDepth: 4, deadline: Date.now() + 700, nodeLimit: 400000 });
if (mres) {
  var g2 = new Chess.GameClass();
  g2.board = R.cloneBoard(mate2);
  g2.side = 'r';
  var r2 = g2.applyMove(mres.mv);
  ok(r2 && r2.mate === true, 'AI 找到一步绝杀 ' + (r2 && r2.notation));
} else {
  ok(false, '未找到绝杀走法');
}

/* 6. AI 自对弈 20 回合：不应出现非法走法、不应崩溃 */
var g = new Chess.GameClass();
var turns = 0;
while (!g.isOver() && turns < 40) {
  var r3 = A.searchRoot(R.cloneBoard(g.board), g.side, { maxDepth: 2, deadline: Date.now() + 150, nodeLimit: 60000, randomize: true });
  if (!r3) { break; }
  var applied = g.applyMove(r3.mv);
  if (!applied.ok) { ok(false, '自对弈出现非法走法'); break; }
  turns++;
}
ok(true, 'AI 自对弈 ' + turns + ' 步无异常，状态=' + g.status + ' 手数=' + g.moves.length);
ok(g.moves.length === turns, '记录步数与实际走子数一致');

/* 7. Worker 源码可构造（不实际运行） */
var src = A.buildWorkerSource();
ok(typeof src === 'string' && src.length > 1000, 'Worker 源码可生成（长度 ' + src.length + '）');
ok(src.indexOf('A.searchRoot') >= 0, 'Worker 源码含 searchRoot');
ok(src.indexOf('R.pseudoMoves') >= 0, 'Worker 源码含规则实现');
ok(src.indexOf('R.isLegal') >= 0, 'Worker 源码含统一合法性过滤');

/* 8. 时间上限：困难档也应在 1.5 秒内返回 */
var t0 = Date.now();
A.searchRoot(R.cloneBoard(R.initialBoard()), 'r', { maxDepth: 6, deadline: Date.now() + 900, nodeLimit: 3000000 });
var dt = Date.now() - t0;
ok(dt < 1500, '困难档搜索耗时 ' + dt + 'ms < 1500ms');

console.log('\n==== AI 自测：通过 ' + pass + ' 项，失败 ' + fail + ' 项 ====');
process.exit(fail ? 1 : 0);
