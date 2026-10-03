// ============================================================
// WG2 大桥 —— bridge.js（仅 WG2 加载，注册 window.__WG2_BRIDGE__ 钩子）
// 职责: 中央峡谷大桥对象
//   - 位置与大小：模板匹配 art/build/fri/map_3_sp19.png 在 Map_3_11 - 副本.png
//     中的落点（图像 6400x4992 → 世界 2560x1996，比例 2.5），与标注图完全一致
//   - 生命值 50000；只能被我方单位「集火攻击」（点击桥体标记后射程内单位自动开火）
//   - 不做碰撞体：敌我双方都可以在桥面上正常移动（纯视觉对象）
//   - 被摧毁：全桥范围爆炸 → 桥体从中心向外渐变透明化消失 → 原位置添加红色屏蔽区
//     （敌我双方均无法通行）；桥上的敌我单位随桥立即消亡（不进入自爆流程）；
//     消失动画播完后本局立即结束（击毁大桥 = 达成主要目标，结算为胜利）
// 隔离原则: WG.html 不加载本模块，window.__WG2_BRIDGE__ 不存在，全部钩子自动跳过
// ============================================================

import { S } from '../wg/S.js';
import { ACTIVE_ENEMY_RECORD, ATTACK_BLAST_TEXTURE_KEY, IS_WG2 } from '../wg/state.js';
import { computeArmorDamage, shakeCameraForExplosion, spawnExplosion } from '../wg/combat.js';
import { destroyEnemy } from '../wg/enemy.js';
import { fireAttackShell } from '../wg/artillery.js';
import { endMatch } from '../wg/match.js';
import { getPlayerAttackBlastDamage } from '../wg/core.js';
import { killPlayerMemberInstantly, playPlayerAttackAnimation, setPlayerFacing } from '../wg/player-member.js';
import { getSpawnedPlayerSquads, isPlayerSquadFacingLeft } from '../wg/player-squad.js';
import { appendRedForbiddenZone } from '../wg/zones.js';

// 桥体世界坐标（模板匹配结果，与 Map_3_11 - 副本.png 完全一致）
const BRIDGE_X = 973.6;
const BRIDGE_Y = 1209.5;
const BRIDGE_W = 612.8;
const BRIDGE_H = 286.0;
const BRIDGE_CENTER_X = BRIDGE_X + BRIDGE_W / 2;
const BRIDGE_CENTER_Y = BRIDGE_Y + BRIDGE_H / 2;

const BRIDGE_MAX_HP = 50000;
const BRIDGE_DEPTH = -8;        // 背景(-10)之上、单位(0)之下：单位从桥面上走过时被桥面遮住脚部不穿帮
const BRIDGE_TEXTURE_KEY = 'bridgeTexture';
const HP_BAR_WIDTH = 260;
const HP_BAR_HEIGHT = 10;

// 桥体命中矩形（世界坐标）
const BRIDGE_RECT = { minX: BRIDGE_X, minY: BRIDGE_Y, maxX: BRIDGE_X + BRIDGE_W, maxY: BRIDGE_Y + BRIDGE_H };

// 集火目标的静态代理对象：与敌方单位同构的最小接口（fireAttackShell 只读写
// active / charging / x / y），桥体位置固定，弹丸落点不再逐帧变化
const bridgeProxy = { x: BRIDGE_CENTER_X, y: BRIDGE_CENTER_Y, active: true, charging: false, isBridge: true };

let sceneRef = null;
let bridgeImage = null;
let barGraphics = null;
let ringGraphics = null;
let updateHandler = null;

// 点到桥体矩形的最近距离（用于射程判定：桥是大目标，打到桥面任意位置都算覆盖）
function distanceToBridgeRect(x, y) {
  const dx = Math.max(BRIDGE_RECT.minX - x, 0, x - BRIDGE_RECT.maxX);
  const dy = Math.max(BRIDGE_RECT.minY - y, 0, y - BRIDGE_RECT.maxY);
  return Math.hypot(dx, dy);
}

// 桥上单位随桥殉难：中心点落在桥面矩形内的敌我单位立即死亡消失（不进入自爆流程）。
// 敌方走 destroyEnemy(立即销毁分支)，跳过染色/待爆/自爆管线；
// 我方队员走 killPlayerMemberInstantly，复用自爆收尾的清理但不做爆炸结算——
// 视觉由桥体连环爆炸覆盖。桥缘之外的单位不受影响，被新增红区的常规净空逻辑逐步推离
function killUnitsOnBridge() {
  S.enemiesGroup.getChildren().slice().forEach(enemy => {
    if (!enemy.active) return;
    if (distanceToBridgeRect(enemy.x, enemy.y) > 0) return;
    destroyEnemy(enemy, false);
  });
  getSpawnedPlayerSquads().forEach(squad => {
    (squad.members || []).slice().forEach(member => {
      const character = member.character;
      if (!character || !character.active) return;
      if (distanceToBridgeRect(character.x, character.y) > 0) return;
      killPlayerMemberInstantly(member);
    });
  });
  // GustafAssist2 不在桥区（右下角），无需处理
}

// 桥体渐变透明化消失（用户指令：从大桥中心开始）：
//   把桥面像素复制到一张 CanvasTexture 上，每帧用 destination-out 从中心挖一个
//   带羽化边缘的透明圆洞，洞径随 tween 扩大——桥面自中心向外逐渐透明直至消失。
//   画布创建失败等极端情况退回整桥 alpha 淡出，功能不缺失
const COLLAPSE_FADE_DELAY = 350;     // 等第一波爆炸起爆再开始消失
const COLLAPSE_FADE_DURATION = 1300; // 中心 → 全桥的消失时长
const COLLAPSE_EDGE_BAND = 70;       // 消失边缘的羽化带宽（贴图像素，约 28 世界像素）

function startRadialCollapse() {
  const key = 'bridgeCollapseCanvas';
  if (sceneRef.textures.exists(key)) sceneRef.textures.remove(key);
  const source = sceneRef.textures.get(BRIDGE_TEXTURE_KEY).getSourceImage();
  const width = source.width;
  const height = source.height;
  const canvasTexture = sceneRef.textures.createCanvas(key, width, height);
  if (!canvasTexture) {
    // 兜底：画布纹理创建失败时退回整桥淡出，不影响后续屏蔽区与结算
    sceneRef.tweens.add({
      targets: bridgeImage,
      alpha: 0,
      duration: 900,
      delay: COLLAPSE_FADE_DELAY,
      onComplete: () => {
        if (bridgeImage) {
          bridgeImage.destroy();
          bridgeImage = null;
        }
      }
    });
    return;
  }
  const ctx = canvasTexture.getContext();
  bridgeImage.setTexture(key);
  drawCollapseFrame(ctx, source, width, height, 0);   // 先画一帧完整桥面，延迟期不闪空
  canvasTexture.refresh();
  const progress = { radius: 0 };
  const maxRadius = Math.hypot(width / 2, height / 2) + 2;
  sceneRef.tweens.add({
    targets: progress,
    radius: maxRadius,
    duration: COLLAPSE_FADE_DURATION,
    delay: COLLAPSE_FADE_DELAY,
    ease: 'Sine.easeIn',
    onUpdate: () => {
      drawCollapseFrame(ctx, source, width, height, progress.radius);
      canvasTexture.refresh();
    },
    onComplete: () => {
      if (bridgeImage) {
        bridgeImage.destroy();
        bridgeImage = null;
      }
      if (sceneRef && sceneRef.textures.exists(key)) sceneRef.textures.remove(key);
    }
  });
}

// 重绘桥面画布：整桥像素 + 从中心挖出的羽化透明圆洞（destination-out），洞径随进度扩大
function drawCollapseFrame(ctx, source, width, height, radius) {
  ctx.globalCompositeOperation = 'source-over';
  ctx.clearRect(0, 0, width, height);
  ctx.drawImage(source, 0, 0, width, height);
  if (radius <= 0) return;
  ctx.globalCompositeOperation = 'destination-out';
  const inner = Math.max(0, radius - COLLAPSE_EDGE_BAND);
  const gradient = ctx.createRadialGradient(width / 2, height / 2, inner, width / 2, height / 2, radius);
  gradient.addColorStop(0, 'rgba(0,0,0,1)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(width / 2, height / 2, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
}


// 桥体被摧毁：集火标识同帧消失 → 全桥范围连环爆炸 → 桥面自中心向外渐变透明化 →
// 原位置添加红色屏蔽区、桥上单位立即消亡 → 动画播完后本局结束（胜利）
function collapseBridge() {
  if (S.bridgeDestroyed) return;
  S.bridgeDestroyed = true;
  S.bridgeFocused = false;
  // 集火红框 / 耐久条同帧清空：onSceneUpdate 在销毁后直接早退，不清理会残留最后一帧描边
  if (ringGraphics) ringGraphics.clear();
  if (barGraphics) barGraphics.clear();
  shakeCameraForExplosion(sceneRef, Math.max(BRIDGE_W, BRIDGE_H));
  // 三段连环爆炸沿桥轴铺开，单发半径覆盖桥宽的一半，视觉上整桥同时炸开
  const radius = Math.max(BRIDGE_W, BRIDGE_H) * 0.5;
  [0, 0.35, 0.7].forEach((ratio, index) => {
    sceneRef.time.delayedCall(index * 160, () => {
      if (!sceneRef || !sceneRef.sys) return;
      spawnExplosion(
        sceneRef,
        BRIDGE_X + BRIDGE_W * ratio + BRIDGE_W * 0.15,
        BRIDGE_CENTER_Y,
        radius,
        ATTACK_BLAST_TEXTURE_KEY
      );
    });
  });
  startRadialCollapse();
  // 原位置添加屏蔽区：敌我双方均无法移动（ zones 会自动失效全部几何缓存并重规划）
  appendRedForbiddenZone([
    { x: BRIDGE_RECT.minX, y: BRIDGE_RECT.minY },
    { x: BRIDGE_RECT.maxX, y: BRIDGE_RECT.minY },
    { x: BRIDGE_RECT.maxX, y: BRIDGE_RECT.maxY },
    { x: BRIDGE_RECT.minX, y: BRIDGE_RECT.maxY }
  ]);
  killUnitsOnBridge();
  // 消失动画（350ms 延迟 + 1300ms 扩散）播完后再结算，让玩家看完坍塌：
  // 击毁大桥 = 达成主要目标，本局立即结束并判定胜利（endMatch 自带 gameEnded 幂等护栏）
  sceneRef.time.delayedCall(COLLAPSE_FADE_DELAY + COLLAPSE_FADE_DURATION + 150, () => {
    endMatch(true);
  });
}


// 我方伤害入口（炮弹落点 / 齐射 / Gustaf 炮弹共用）
function damageBridge(amount) {
  if (S.bridgeDestroyed || !(amount > 0) || !sceneRef) return;
  S.bridgeHp = Math.max(0, S.bridgeHp - amount);
  if (S.bridgeHp <= 0) collapseBridge();
}


// 集火攻击桥体：与攻击敌方单位同一套射程 / 面向 / 攻击间隔 / 动画规则。
// 返回 true 表示本次攻击槽位已被消耗（调用方无需再处理）
function tryAttack(scene, squad, unit, unitRecord, living, memberJudgment, time) {
  if (S.bridgeDestroyed || !bridgeImage || !bridgeImage.active) return false;
  // 射程判定：任一队员的判定圈罩住桥面（点到矩形距离）即可开火。
  // Warjack 虽带近战挥砍分支（melee_animation_name），但本体是 350 射程双炮口
  // 弹丸单位，正常走下方弹丸分支炮击桥体，不再按近战排除
  let bestMember = null;
  let bestDist = Infinity;
  memberJudgment.forEach(entry => {
    const dist = distanceToBridgeRect(entry.x, entry.y);
    if (dist < entry.radius && dist < bestDist) {
      bestDist = dist;
      bestMember = entry.member;
    }
  });
  if (!bestMember) return false;
  // 面向判定（登记了 attack_facing_required 的兵种）：与打敌方单位同一套——
  // 不在面向方向时先转身，等一个完整攻击间隔再打
  const bridgeIsLeft = BRIDGE_CENTER_X < unit.x;
  if ((unitRecord.attack_facing_required || 0) === 1 &&
      isPlayerSquadFacingLeft(squad) !== bridgeIsLeft) {
    setPlayerFacing(squad, bridgeIsLeft);
    unit.nextAttackAt = time + unitRecord.action_cd * 1000;
    return true;
  }
  if (!unit.isMoving) setPlayerFacing(squad, bridgeIsLeft);
  // 攻击方式按兵种记录分流：弹丸兵种发炮（落地时由 artillery 的桥体分支结算），
  // 其余兵种齐射即时结算；伤害公式与打敌方完全一致
  if ((unitRecord.attack_projectile_size || 0) > 0) {
    fireAttackShell(scene, squad, bridgeProxy, unitRecord, bestMember);
  } else {
    const volleyDamage = living.length * computeArmorDamage(unitRecord, ACTIVE_ENEMY_RECORD);
    damageBridge(volleyDamage);
  }
  unit.nextAttackAt = time + unitRecord.action_cd * 1000;
  if (!unit.isMoving) playPlayerAttackAnimation(squad);
  return true;
}


// 每帧绘制：集火红框（脉冲）+ 耐久条（受损后才显示）。对象销毁后自动不再绘制
function onSceneUpdate(time) {
  if (!sceneRef || !sceneRef.sys || !sceneRef.sys.isActive()) return;
  if (S.bridgeDestroyed || !bridgeImage || !bridgeImage.active) return;
  // 集火标记：桥体四周红色圆角框，呼吸式内外移动（与敌方集火括号同语义）
  ringGraphics.clear();
  if (S.bridgeFocused) {
    const off = Math.sin(time * 0.006) * 3;
    ringGraphics.lineStyle(3, 0xff3333, 0.95);
    ringGraphics.strokeRoundedRect(
      BRIDGE_RECT.minX - 6 - off,
      BRIDGE_RECT.minY - 6 - off,
      BRIDGE_W + 12 + off * 2,
      BRIDGE_H + 12 + off * 2,
      10
    );
  }
  // 耐久条：满血不显示；受损后常驻显示在桥体上沿
  barGraphics.clear();
  if (S.bridgeHp < BRIDGE_MAX_HP) {
    const cx = BRIDGE_CENTER_X;
    const y = BRIDGE_RECT.minY - 22;
    const ratio = Math.max(0, S.bridgeHp / BRIDGE_MAX_HP);
    barGraphics.fillStyle(0x20232a, 0.85);
    barGraphics.fillRoundedRect(cx - HP_BAR_WIDTH / 2 - 2, y - 2, HP_BAR_WIDTH + 4, HP_BAR_HEIGHT + 4, 4);
    barGraphics.fillStyle(ratio > 0.5 ? 0x2ecc71 : ratio > 0.25 ? 0xf5a623 : 0xff4d4d, 1);
    if (ratio > 0) {
      barGraphics.fillRoundedRect(cx - HP_BAR_WIDTH / 2, y, HP_BAR_WIDTH * ratio, HP_BAR_HEIGHT, 3);
    }
  }
}


// 场景装配（scene.js create 末尾调用一次；仅 WG2 且钩子存在时才会执行）
function setupBridge(scene) {
  if (!IS_WG2 || sceneRef) return false;
  if (!scene.textures.exists(BRIDGE_TEXTURE_KEY)) return false;   // 预加载缺失时静默跳过，不影响游戏
  sceneRef = scene;
  S.bridgeHp = BRIDGE_MAX_HP;
  S.bridgeDestroyed = false;
  S.bridgeFocused = false;
  bridgeImage = scene.add.image(BRIDGE_CENTER_X, BRIDGE_CENTER_Y, BRIDGE_TEXTURE_KEY)
    .setDisplaySize(BRIDGE_W, BRIDGE_H)
    .setDepth(BRIDGE_DEPTH);
  barGraphics = scene.add.graphics().setDepth(4);      // 与敌方血条同层
  ringGraphics = scene.add.graphics().setDepth(3);
  updateHandler = time => onSceneUpdate(time);
  scene.events.on('update', updateHandler);
  scene.events.once('shutdown', () => {
    if (updateHandler) scene.events.off('update', updateHandler);
    sceneRef = null;
    bridgeImage = null;
    barGraphics = null;
    ringGraphics = null;
  });
  return true;
}

// 对外钩子：WG2.html 加载本模块后注册，WG.html 不加载 → 场景层判定自动跳过
window.__WG2_BRIDGE__ = {
  setup: setupBridge,
  hitTest: (x, y) => !S.bridgeDestroyed && !!bridgeImage &&
    x >= BRIDGE_RECT.minX && x <= BRIDGE_RECT.maxX &&
    y >= BRIDGE_RECT.minY && y <= BRIDGE_RECT.maxY,
  isDestroyed: () => S.bridgeDestroyed,
  tryAttack,
  damage: damageBridge,
  getRect: () => BRIDGE_RECT
};

export { setupBridge, distanceToBridgeRect, damageBridge, tryAttack };
