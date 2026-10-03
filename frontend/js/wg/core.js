// ============================================================
// wg_game 模块化拆分 —— core.js
// 职责: 其余通用工具
// 来源: wg_game.js 语句区间 2985-9260（自动拆分，勿手工重排语句顺序）
// ============================================================

import { S } from './S.js';
import { computeArmorDamage } from './combat.js';
import { applyPlayerMemberAnimationSpeed } from './player-member.js';
import { applyPlayerPathOrder } from './player-squad.js';
import { ACTIVE_PLAYER_RECORD, ENEMY_RED_ZONE_CLEARANCE, PLAYER_EXPLOSION_CENTER_DAMAGE, PLAYER_EXPLOSION_DAMAGE_FALLOFF, PLAYER_EXPLOSION_FALLOFF_STEP, PLAYER_PATH_FRAME_BUDGET, WORLD_HEIGHT, WORLD_WIDTH, playerPathQueue } from './state.js';
import { forEachMemberPart } from './units-visual.js';
import { isRedClearanceSafeSegment } from './zones.js';


  function isRedZoneClearanceSafePath(start, end, clearance = ENEMY_RED_ZONE_CLEARANCE) {
    return isRedClearanceSafeSegment(start, end, clearance);
  }


  // ----------------------------------------------------
  // 战斗数值 / 血条 / 阵亡自爆
  // 双方通用：血条耗尽 -> 以柔和的速度逐渐泛红 25% ->
  //   我方：脱离队伍冲向最近的敌人（冲锋全程保留移动动画）-> 满 5 秒自爆 / 贴上目标即刻自爆，
  //         40 像素圆范围伤害（爆心 20 点，每向外扩 10 像素递减 20%），命中者被击退
  //   敌方：原地不动 -> 满 3 秒原地自爆，5 点范围伤害
  // ----------------------------------------------------

  // 我方自爆的伤害递减：爆心 10 像素内为中心伤害，之后每向外扩一档伤害按递减比例降低
  // （距离一律取爆心到目标的直线距离）。数值按引爆队员所属兵种的记录
  // （JF：爆心 20 点/档距 10/递减 20%；TankM1：爆心 60 点）
  function getPlayerExplosionDamage(distance, record) {
    const unitRecord = record || ACTIVE_PLAYER_RECORD;
    const bands = Math.floor(Math.max(0, distance) / (unitRecord.detonate_falloff_step || PLAYER_EXPLOSION_FALLOFF_STEP));
    return (unitRecord.detonate_damage || PLAYER_EXPLOSION_CENTER_DAMAGE) *
      Math.pow(1 - (unitRecord.detonate_damage_falloff || PLAYER_EXPLOSION_DAMAGE_FALLOFF), bands);
  }


  // 相机可视范围夹取：可视范围在地图内时按地图边界限制（与原来的相机边界等效）；
  // 可视范围一旦大于地图（正常不会发生，最小缩放已保证地图宽度铺满视野宽度），
  // 就把地图居中摆好，而不是像 Phaser 自带边界那样把地图顶到左上角
  function clampCameraToWorld() {
    const cam = S.gameScene.cameras.main;
    const viewWidth = cam.width / cam.zoom;
    const viewHeight = cam.height / cam.zoom;
    // 相机 scrollX/Y 与「可视区域左上角世界坐标」之间的偏移（缩放不为 1 时存在，来自 Phaser 的原点补偿）
    const offsetX = (viewWidth - cam.width) / 2;
    const offsetY = (viewHeight - cam.height) / 2;
    const minLeft = Math.min(0, (WORLD_WIDTH - viewWidth) / 2);
    const maxLeft = Math.max(0, WORLD_WIDTH - viewWidth);
    const minTop = Math.min(0, (WORLD_HEIGHT - viewHeight) / 2);
    const maxTop = Math.max(0, WORLD_HEIGHT - viewHeight);
    cam.scrollX = Phaser.Math.Clamp(cam.scrollX - offsetX, minLeft, maxLeft) + offsetX;
    cam.scrollY = Phaser.Math.Clamp(cam.scrollY - offsetY, minTop, maxTop) + offsetY;
  }


  // 溅射伤害：与齐射、自爆共用同一套破甲公式，再按爆心距离分档递减
  function getPlayerAttackBlastDamage(distance, record, defenderRecord, memberCount) {
    const falloffStep = record.attack_blast_falloff_step || PLAYER_EXPLOSION_FALLOFF_STEP;
    const bands = Math.floor(Math.max(0, distance) / falloffStep);
    const centerDamage = (memberCount || 1) * computeArmorDamage(record, defenderRecord);
    return centerDamage * Math.pow(1 - (record.attack_blast_falloff || 0), bands);
  }


  // 按帧时间预算推进规划队列，返回本帧完成的规划条数。
  // 预算按帧共享：一次框选会在同一帧里反复调用本函数，各自持有一份独立预算会让限流形同虚设。
  // 每帧至少推进一条，保证排队的小队不会一直站着不动
  function processPlayerPathQueue(scene, time, budget = PLAYER_PATH_FRAME_BUDGET) {
    if (!playerPathQueue.length) return 0;
    if (time !== S.playerPathBudgetFrame) {
      S.playerPathBudgetFrame = time;
      S.playerPathBudgetUsed = 0;
      S.playerPathPlannedInFrame = 0;
    }
    let planned = 0;
    while (playerPathQueue.length &&
      (S.playerPathPlannedInFrame === 0 || S.playerPathBudgetUsed < budget)) {
      const order = playerPathQueue.shift();
      const startedAt = performance.now();
      const squad = order.squad;
      // 过期任务（指令已被新指令覆盖、小队已阵亡或已抵达）直接丢弃，不占预算
      if (squad.unit && squad.unit.isSpawned && squad.moveTarget === order.destination) {
        S.playerPathPlannedInFrame += 1;
        planned += 1;
        applyPlayerPathOrder(scene, squad, order.destination, time);
      }
      S.playerPathBudgetUsed += performance.now() - startedAt;
    }
    return planned;
  }


  // 附加层与主体逐帧对齐：主体在本帧被移动逻辑、归队、冲锋、出生动画、朝向翻转改过的
  // 位置 / 缩放 / 透明度 / 可见性，统一在帧末抄给附加层，各处逻辑不必再逐个部件处理
  function syncPlayerMemberParts(member) {
    const parts = member.extraParts;
    if (!parts || !parts.length) return;
    const main = member.character;
    if (!main || main.active === false) return;
    parts.forEach(part => {
      if (!part || part.active === false) return;
      part.setPosition(main.x, main.y);
      part.setScale(main.scaleX, main.scaleY);
      part.setAlpha(main.alpha);
      part.setVisible(main.visible);
    });
  }


  // 掉队归队队员的独立动画与朝向：小队其余成员的动作由全队移动状态决定，
  // 而归队队员是自己走自己的，所以单独播 move 并朝自己的前进方向转身。
  // 必须在 setPlayerFacing 之后调用（全队朝向会覆盖单个队员的朝向），
  // 且攻击等一次性动画播放期间整体跳过，让攻击动画能完整播完
  // 给单个队员下发循环动画：正在播同一条时既不下发也不改标记。
  // Spine 重建 TrackEntry 会把 trackTime 归零，重复下发同名动画会让走路循环定格在第一帧，
  // 因此「归队状态反复进出」和「进入归队时本来就在走路」都必须走这条同名跳过逻辑。
  // timeScale 用于把脚步速率对齐实际移动速度（加速追赶时不下滑）
  function setPlayerMemberAnimation(member, name, timeScale = 1) {
    const scale = timeScale > 0.05 ? timeScale : 1;
    if (member.animOverride === name) {
      applyPlayerMemberAnimationSpeed(member, scale);
      return;
    }
    member.animOverride = name;
    const main = member.character;
    const current = main && main.active !== false ? main.state.getCurrent(0) : null;
    if (!current || current.animation.name !== name) {
      forEachMemberPart(member, part => part.setAnimation(0, name, true));
    }
    applyPlayerMemberAnimationSpeed(member, scale);
  }

export { isRedZoneClearanceSafePath, getPlayerExplosionDamage, clampCameraToWorld, getPlayerAttackBlastDamage, processPlayerPathQueue, syncPlayerMemberParts, setPlayerMemberAnimation };
