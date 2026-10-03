// ============================================================
// wg_game 模块化拆分 —— main.js（入口）
// 动态 import 保留原 IIFE .catch 的启动错误日志行为；
// 页面经 <script type="module" src="js/wg/main.js"> 加载。
// ============================================================
import('./state.js').catch(function (error) {
  console.error('[WG] 启动失败', error);
});
