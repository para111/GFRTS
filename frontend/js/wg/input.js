// ============================================================
// wg_game 模块化拆分 —— input.js
// 职责: 输入：世界点击与选中
// 来源: wg_game.js 语句区间 968-968（自动拆分，勿手工重排语句顺序）
// ============================================================

import { S } from './S.js';
import { exitGustafAiming } from './artillery.js';
import { getPlayerSquadOuterRadius, getSpawnedPlayerSquads } from './player-squad.js';
import { DOUBLE_CLICK_MS, ENEMY_CLICK_RADIUS, GUSTAF_CLICK_RADIUS, GUSTAF_X, GUSTAF_Y, PLAYER_SINGLE_CLICK_RADIUS } from './state.js';


  // 世界坐标上的一次单击：先判敌方（集火），再判我方（单选），都没命中就不改变选择。
  // 敌方是 Spine 对象、setInteractive 的 hit area 依赖骨架包围盒并不可靠，
  // 因此这里统一按「点击点到单位锚点的距离」做命中判定（半径见 ENEMY_CLICK_RADIUS）。
  // 返回命中结果，便于浏览器测试直接调用同一套判定
  function handleWorldClick(clickX, clickY) {
    let hitEnemy = null;
    let hitEnemyDistance = Infinity;
    if (S.enemiesGroup) {
      S.enemiesGroup.getChildren().forEach(enemy => {
        if (!enemy.active || enemy.charging) return;
        const distance = Phaser.Math.Distance.Between(clickX, clickY, enemy.x, enemy.y);
        if (distance <= ENEMY_CLICK_RADIUS && distance < hitEnemyDistance) {
          hitEnemyDistance = distance;
          hitEnemy = enemy;
        }
      });
    }
    if (hitEnemy) {
      // 点击敌方单位设为集火目标（不要求它已在我方射程内）：
      // 射程覆盖它的我方单位会立刻优先攻击它，其余单位在进入射程后也会优先打它。
      // 再次点击同一个目标则取消集火
      const cancel = S.focusTarget === hitEnemy;
      S.focusTarget = cancel ? null : hitEnemy;
      // 全局单选语义：集火敌方时退出大桥集火与 Gustaf 选中
      S.bridgeFocused = false;
      S.gustafSelected = false;
      exitGustafAiming();
      return { enemy: hitEnemy, focused: !cancel };
    }
    // WG2 大桥命中判定（优先级低于敌方单位——站在桥面上的敌人优先被点中）：
    // 点击桥体切换集火标记，桥只能被我方单位集火攻击
    if (window.__WG2_BRIDGE__ && !window.__WG2_BRIDGE__.isDestroyed() &&
        window.__WG2_BRIDGE__.hitTest(clickX, clickY)) {
      const cancel = S.bridgeFocused;
      S.bridgeFocused = !cancel;
      S.focusTarget = null;
      S.gustafSelected = false;
      exitGustafAiming();
      getSpawnedPlayerSquads().forEach(squad => {
        squad.unit.isSelected = false;
        squad.sellPanelOpen = false;
      });
      S.lastClickSquad = null;
      return { bridge: true, focused: S.bridgeFocused };
    }
    // GustafAssist2 命中判定（先于我方小队）：点击互动区（半径 GUSTAF_CLICK_RADIUS）内任意处
    // 选中炮击单位，同时取消所有小队选中。互动区超出记录碰撞半径的部分已同步扩大碰撞区
    // （GUSTAF_BODY_RADIUS），我方队员被隔离在互动区之外，点击判定不会和小队抢单位
    if (S.gustafCharacter && S.gustafCharacter.active) {
      const gustafDistance = Phaser.Math.Distance.Between(clickX, clickY, GUSTAF_X, GUSTAF_Y);
      if (gustafDistance <= GUSTAF_CLICK_RADIUS) {
        S.gustafSelected = true;
        S.bridgeFocused = false;
        exitGustafAiming();
        getSpawnedPlayerSquads().forEach(squad => {
          squad.unit.isSelected = false;
          squad.sellPanelOpen = false;
        });
        S.lastClickSquad = null;
        return { gustaf: true };
      }
    }
    // 点到别处：GustafAssist2 退出选中（瞄准由 pointerup 层先行处理，不会走到这里）
    S.gustafSelected = false;
    exitGustafAiming();
    // 未命中敌人：命中某支我方小队则单独选中该队（其余取消选中）。
    // 命中半径取略大于阵型外接半径，点击任意队员都能选中整支小队
    let hitSquad = null;
    getSpawnedPlayerSquads().forEach(squad => {
      if (hitSquad) return;
      // 命中半径取「固定半径 与 该队实际外沿半径 + 余量」中的较大值：
      // 大型单位（TankM1 坦克 226×106）点击车身任意处都能选中整队，不会只能点中锚点
      const clickRadius = Math.max(PLAYER_SINGLE_CLICK_RADIUS, getPlayerSquadOuterRadius(squad) + 8);
      if (Phaser.Math.Distance.Between(clickX, clickY, squad.unit.x, squad.unit.y) <= clickRadius) {
        hitSquad = squad;
      }
    });
    if (hitSquad) {
      const now = S.gameScene ? S.gameScene.time.now : 0;
      // 双击同一支小队即呼出 / 收起出售圆环；单击只选中，不显示出售面板
      const isDouble = hitSquad === S.lastClickSquad && now - S.lastClickAt <= DOUBLE_CLICK_MS;
      S.lastClickSquad = hitSquad;
      S.lastClickAt = now;
      const sellOpen = isDouble ? !hitSquad.sellPanelOpen : false;
      getSpawnedPlayerSquads().forEach(squad => {
        squad.unit.isSelected = squad === hitSquad;
        squad.sellPanelOpen = squad === hitSquad ? sellOpen : false;
      });
      return { squad: hitSquad, sell: sellOpen };
    }
    // 既没点到我方单位、也没点到敌方单位（点在空地上）：取消全部选中并收起出售圆环
    S.lastClickSquad = null;
    S.bridgeFocused = false;
    getSpawnedPlayerSquads().forEach(squad => {
      squad.unit.isSelected = false;
      squad.sellPanelOpen = false;
    });
    return { cleared: true };
  }

export { handleWorldClick };
