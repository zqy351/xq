/* ===================================================================
 * namespace.js —— 全局命名空间 window.Chess
 * ---------------------------------------------------------------
 * 所有模块挂在 window.Chess 下，用传统 <script> 顺序引入即可，
 * 不依赖 ES Module，因此 file:// 双击打开也能正常运行。
 * =================================================================== */
(function (global) {
  'use strict';

  var Chess = global.Chess = global.Chess || {};

  /* 模块登记表：避免重复初始化 */
  Chess.modules = Chess.modules || {};

  /**
   * 登记一个模块工厂。同名模块只执行一次。
   * @param {string} name 模块名
   * @param {Function} factory 接收 Chess，返回模块对象（可为空）
   */
  Chess.register = function (name, factory) {
    if (Chess.modules[name]) { return Chess.modules[name]; }
    var mod = null;
    try {
      mod = factory(Chess) || {};
    } catch (err) {
      if (global.console && console.error) { console.error('[Chess] 模块初始化失败: ' + name, err); }
      mod = {};
    }
    Chess.modules[name] = mod;
    return mod;
  };

  /* ---------------- 通用工具 ---------------- */

  Chess.util = {
    /** 限制取值范围 */
    clamp: function (v, lo, hi) {
      return v < lo ? lo : (v > hi ? hi : v);
    },

    /** 线性插值，用于动画 */
    lerp: function (a, b, t) {
      return a + (b - a) * t;
    },

    /** 缓出曲线，落子动画用 */
    easeOutCubic: function (t) {
      var p = 1 - t;
      return 1 - p * p * p;
    },

    /** 缓入缓出曲线，棋盘翻转用 */
    easeInOutCubic: function (t) {
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    },

    /** 缓出回弹，落子回弹用 */
    easeOutBack: function (t) {
      var c1 = 1.70158, c3 = c1 + 1;
      var p = t - 1;
      return 1 + c3 * p * p * p + c1 * p * p;
    },

    /** 生成固定种子的伪随机数发生器（纹理用，保证不闪烁） */
    mulberry32: function (seed) {
      var a = seed >>> 0;
      return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        var t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    },

    /** 创建离屏 canvas（纹理预渲染用） */
    offscreen: function (w, h) {
      var c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(w));
      c.height = Math.max(1, Math.round(h));
      return c;
    },

    /** 是否支持 backdrop-filter */
    supportsBackdrop: function () {
      return typeof document !== 'undefined' &&
        !!(document.body && (document.body.style.backdropFilter !== undefined ||
          document.body.style.webkitBackdropFilter !== undefined));
    },

    /** 简单节流 rAF */
    raf: function (fn) {
      if (typeof global.requestAnimationFrame === 'function') {
        return global.requestAnimationFrame(fn);
      }
      return global.setTimeout(function () { fn(Date.now()); }, 16);
    }
  };

  Chess.VERSION = '1.0.0';
})(typeof window !== 'undefined' ? window : this);
