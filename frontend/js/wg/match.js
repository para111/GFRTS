// ============================================================
// wg_game 模块化拆分 —— match.js
// 职责: 对局：计时/番茄泄漏/结算
// 来源: wg_game.js 语句区间 9342-9366（自动拆分，勿手工重排语句顺序）
// ============================================================

import { S } from './S.js';
import { showCombatText } from './combat.js';
import { destroyEnemy } from './enemy.js';
import { SPAWN_POINT_X, SPAWN_POINT_Y } from './state.js';


  // ----------------------------------------------------
  // 4. 逐帧主循环
  // ----------------------------------------------------
  // ---- 番茄防线与胜负判定 ----
  // 敌方单位突破出生点：番茄 -1 并红闪提示，突破的敌军当场消失（不播死亡动画），
  // 归零即落败。每个敌方单位一生只计一次（leaked 标记在敌方主循环里判定与登记）
  function registerTomatoLeak(enemy) {
    if (S.gameEnded) return;
    S.tomatoCount = Math.max(0, S.tomatoCount - 1);
    if (S.tomatoHudText) S.tomatoHudText.setText('×' + S.tomatoCount);
    if (S.tomatoHud && S.gameScene) {
      S.gameScene.tweens.add({
        targets: S.tomatoHud,
        alpha: { from: 0.2, to: 1 },
        duration: 280,
        ease: 'Quad.easeOut'
      });
    }
    showCombatText(S.gameScene, SPAWN_POINT_X, SPAWN_POINT_Y - 90, '番茄 -1', '#ff6b52');
    // 突破的敌军立刻消失：走 destroyEnemy 的即时移除路径（骨架与本体一并销毁）
    destroyEnemy(enemy, false);
    if (S.tomatoCount <= 0) endMatch(false);
  }


  // 一局结束：番茄归零 = 落败；8 分钟截止且番茄有剩余 = 胜利。
  // 暂停游戏进程并弹出结算界面（按需求两种结果都用「游戏结束」四个字）
  function endMatch(victory) {
    if (S.gameEnded) return;
    S.gameEnded = true;
    if (S.gameScene) S.gameScene.scene.pause();
    const overlay = document.getElementById('gameOverOverlay');
    if (overlay) {
      overlay.dataset.result = victory ? 'win' : 'lose';
      overlay.style.display = 'flex';
    }
  }

export { registerTomatoLeak, endMatch };
