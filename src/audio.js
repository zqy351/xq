/* ===================================================================
 * audio.js —— Web Audio 合成音效（落子 / 吃子）
 * ---------------------------------------------------------------
 * 首次用户交互后才创建 AudioContext，规避浏览器自动播放限制。
 * 关闭开关后不再创建任何节点，也不会残留振荡器。
 * ================================================================== */
(function (global) {
  'use strict';

  var Chess = global.Chess;
  var AU = Chess.Audio = {
    enabled: true,
    _ctx: null,
    _master: null,
    _broken: false
  };

  /** 延迟创建 AudioContext（必须由用户手势触发） */
  AU.ensure = function ensure() {
    if (AU._broken) { return null; }
    if (AU._ctx) {
      if (AU._ctx.state === 'suspended' && AU._ctx.resume) {
        try { AU._ctx.resume(); } catch (e) { }
      }
      return AU._ctx;
    }
    var Ctor = global.AudioContext || global.webkitAudioContext;
    if (!Ctor) { AU._broken = true; return null; }
    try {
      AU._ctx = new Ctor();
      AU._master = AU._ctx.createGain();
      AU._master.gain.value = 0.9;
      AU._master.connect(AU._ctx.destination);
    } catch (err) {
      AU._broken = true;
      AU._ctx = null;
      return null;
    }
    return AU._ctx;
  };

  AU.setEnabled = function setEnabled(on) {
    AU.enabled = !!on;
  };

  AU.isEnabled = function isEnabled() { return AU.enabled; };

  /**
   * 合成一次敲击
   * @param {Object} cfg {freq, type, dur, gain, sweep}
   */
  function strike(cfg) {
    if (!AU.enabled) { return; }
    var ctx = AU.ensure();
    if (!ctx) { return; }
    try {
      var now = ctx.currentTime;
      var osc = ctx.createOscillator();
      var gain = ctx.createGain();

      osc.type = cfg.type || 'triangle';
      osc.frequency.setValueAtTime(cfg.freq, now);
      if (cfg.sweep) {
        osc.frequency.exponentialRampToValueAtTime(cfg.freq * cfg.sweep, now + cfg.dur);
      }

      /* 短促包络：快速起振 + 指数衰减 */
      gain.gain.setValueAtTime(0, now);
      gain.gain.linearRampToValueAtTime(cfg.gain, now + 0.006);
      gain.gain.exponentialRampToValueAtTime(0.0008, now + cfg.dur);

      osc.connect(gain);
      gain.connect(AU._master);
      osc.start(now);
      osc.stop(now + cfg.dur + 0.02);

      /* 结束后断开，避免节点堆积 */
      osc.onended = function () {
        try { gain.disconnect(); } catch (e) { }
        try { osc.disconnect(); } catch (e) { }
      };
    } catch (err) {
      /* 音频失败不影响游戏 */
    }
  }

  /** 落子：短促高频衰减「啪」 */
  AU.drop = function drop() {
    strike({ freq: 1800, type: 'triangle', dur: 0.08, gain: 0.22, sweep: 0.55 });
  };

  /** 吃子：落子声 + 低频木质撞击 */
  AU.capture = function capture() {
    strike({ freq: 1800, type: 'triangle', dur: 0.08, gain: 0.24, sweep: 0.5 });
    strike({ freq: 240, type: 'square', dur: 0.15, gain: 0.16, sweep: 0.62 });
  };

  /** 将军 / 胜负提示音（补充，不影响主体音效） */
  AU.alert = function alert() {
    strike({ freq: 660, type: 'triangle', dur: 0.14, gain: 0.16, sweep: 1.4 });
  };

  AU.win = function win() {
    strike({ freq: 520, type: 'triangle', dur: 0.26, gain: 0.18, sweep: 1.6 });
    global.setTimeout(function () {
      strike({ freq: 780, type: 'triangle', dur: 0.30, gain: 0.16, sweep: 1.2 });
    }, 180);
  };

})(typeof window !== 'undefined' ? window : this);
