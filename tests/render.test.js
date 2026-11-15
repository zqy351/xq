/**
 * 渲染层契约自测（Node 直接读源码做静态断言）
 * 背景：曾因 findKing 返回 {c,r} 而渲染层误用 kp.col/kp.row，
 *      导致坐标 NaN、createRadialGradient 每帧抛异常、整块棋盘被清屏。
 * 这里把"接口契约 + 异常隔离 + 缓存破坏"三件事钉死，防止再次回归。
 */
var fs = require('fs');
var path = require('path');

var ROOT = path.join(__dirname, '..');
var pass = 0, fail = 0;

function ok(cond, name, extra) {
  if (cond) { pass += 1; console.log('  ✓ ' + name); }
  else { fail += 1; console.log('  ✗ ' + name + (extra ? '  -> ' + extra : '')); }
}

var render = fs.readFileSync(path.join(ROOT, 'src/render.js'), 'utf8');
var rules = fs.readFileSync(path.join(ROOT, 'src/rules.js'), 'utf8');
var html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

console.log('\n[1] findKing 契约');
ok(/return \{ c: c, r: r \}/.test(rules), 'rules.findKing 返回 {c, r}');
ok(!/kp\.col|kp\.row/.test(render), '渲染层不得按 col/row 读取 findKing 结果');
ok(/kp\.c/.test(render) && /kp\.r/.test(render), '渲染层按 c/r 读取将帅坐标');

console.log('\n[2] 渲染异常隔离');
ok(/isFinite\(kx\.x\)/.test(render), '红闪坐标绘制前校验有限值');
ok(/check glow skipped/.test(render), '红闪绘制有 try/catch 兜底');
ok(/legal targets skipped/.test(render), '落点提示绘制有 try/catch 兜底');
ok(/piece skipped/.test(render), '单子绘制失败被隔离');
ok(/ctx\.clearRect\(0, 0, this\.W, this\.H\)/.test(render), '每帧先清屏再绘制');

console.log('\n[3] 资源缓存破坏');
var jsTags = html.match(/<script src="src\/[a-z]+\.js[^"]*"><\/script>/g) || [];
ok(jsTags.length === 7, 'index.html 引入 7 个模块脚本', jsTags.length + ' 个');
var allVersioned = jsTags.every(function (tag) { return /\.js\?v=\d+/.test(tag); });
ok(allVersioned, '所有模块脚本带版本参数（避免旧缓存导致白屏）');
ok(/style\.css\?v=\d+/.test(html), 'style.css 带版本参数');

console.log('\n==== 渲染层自测：通过 ' + pass + ' 项，失败 ' + fail + ' 项 ====');
process.exit(fail === 0 ? 0 : 1);
