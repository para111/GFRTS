// ============================================================
// wg_game 模块化拆分 —— perf.js
// 职责: 性能监控：分段帧耗时
// 来源: wg_game.js 语句区间 9399-9399（自动拆分，勿手工重排语句顺序）
// ============================================================

import { S } from './S.js';
import { MODULE_PERF_WINDOW_MS, modulePerf } from './state.js';


  function recordModulePerfWindow(time) {
    modulePerf.frames += 1;
    // 帧内细分耗时归档：拷贝为只读快照（外部经 frameStats().last.sub 读取），
    // 折算进窗口累计与窗口峰值后清零累加器，下一帧从零开始
    const sub = modulePerf.sub;
    const subSnapshot = {};
    for (const key in sub) {
      const value = sub[key];
      subSnapshot[key] = value;
      sub[key] = 0;
      modulePerf.acc[key] = (modulePerf.acc[key] || 0) + value;
      if ((modulePerf.max[key] || 0) < value) modulePerf.max[key] = value;
    }
    modulePerf.last.sub = subSnapshot;
    modulePerf.acc.playerNavMs += modulePerf.last.playerNavMs;
    modulePerf.acc.enemyCombatMs += modulePerf.last.enemyCombatMs;
    modulePerf.acc.updateMs += modulePerf.last.updateMs;
    if (modulePerf.max.playerNavMs < modulePerf.last.playerNavMs) {
      modulePerf.max.playerNavMs = modulePerf.last.playerNavMs;
    }
    if (modulePerf.max.enemyCombatMs < modulePerf.last.enemyCombatMs) {
      modulePerf.max.enemyCombatMs = modulePerf.last.enemyCombatMs;
    }
    if (modulePerf.max.updateMs < modulePerf.last.updateMs) {
      modulePerf.max.updateMs = modulePerf.last.updateMs;
    }
    if (!modulePerf.windowStartedAt) {
      modulePerf.windowStartedAt = time;
      return;
    }
    if (time - modulePerf.windowStartedAt < MODULE_PERF_WINDOW_MS) return;
    const frames = modulePerf.frames || 1;
    modulePerf.avg.playerNavMs = modulePerf.acc.playerNavMs / frames;
    modulePerf.avg.enemyCombatMs = modulePerf.acc.enemyCombatMs / frames;
    modulePerf.avg.updateMs = modulePerf.acc.updateMs / frames;
    const avgSub = {};
    const maxSub = {};
    for (const key in modulePerf.acc) {
      if (key === 'playerNavMs' || key === 'enemyCombatMs' || key === 'updateMs') continue;
      avgSub[key] = (modulePerf.acc[key] || 0) / frames;
      maxSub[key] = modulePerf.max[key] || 0;
      delete modulePerf.acc[key];
    }
    modulePerf.avg.sub = avgSub;
    modulePerf.max.sub = maxSub;
    const loop = S.gameScene && S.gameScene.game ? S.gameScene.game.loop : null;
    modulePerf.avg.fps = loop ? Math.round(loop.actualFps * 10) / 10 : 0;
    modulePerf.windowStartedAt = time;
    modulePerf.frames = 0;
    modulePerf.acc.playerNavMs = 0;
    modulePerf.acc.enemyCombatMs = 0;
    modulePerf.acc.updateMs = 0;
    // 峰值按窗口归零：max 语义是「最近 1 秒窗口内的峰值」，
    // 跨窗口累计会把很久以前的一次尖峰永久顶在峰值上，无法归因当前场景
    modulePerf.max.playerNavMs = 0;
    modulePerf.max.enemyCombatMs = 0;
    modulePerf.max.updateMs = 0;
    for (const key in modulePerf.max) {
      if (key === 'sub' || key === 'playerNavMs' || key === 'enemyCombatMs' || key === 'updateMs') continue;
      modulePerf.max[key] = 0;
    }
  }

export { recordModulePerfWindow };
