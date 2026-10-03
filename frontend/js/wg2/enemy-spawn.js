// ============================================================================
// WG2 子基地出兵逻辑（仅 WG2.html 加载本模块，WG.html 不受影响）
//
// 设计（用户指令）：
//   出兵点 = map2_data.spawnBases 的两个子基地，共同出兵；每波每个基地随机出
//   2 个单位；出兵时间 / 兵种池 / 在场上限完全沿用绿线（green 路线）配置：
//   开局立即第一波 → 每 10 秒一波；上限开局 capBase=4，每 capGrowthMs=30s +1，
//   封顶 capMax=8（与 spawnRouteWave 的「本线在场单位上限」同语义，此处为两基地共享）。
//
// 生成动画：复刻我方小队出生动画（updatePlayerSpawnAnimation 同款参数）——
//   体型 spawn_animation_min_scale(0.3) → 1、透明度 0 → 1（Cubic.Out，720ms），
//   落地淡蓝色（0x9fe3ff）扩散光环 + 白色内环（0.8 进度内扩散完）。
//
// 落地单位完全复用敌方路线推进引擎：route = [基地落点, 我方出生点]，
// 红区转向 / 绕行 A* / 卡顿兜底 / 追击交火 / 终点待机全部走 enemy.js 既有逻辑，
// 终点汇聚区 = 我方出生点（与其它路线语义一致）。
//
// 挂载方式：WG2.html 在 main.js 之前以 ES Module 引入本文件 →
//   注册 window.__WG2_BASE_SPAWN__；scene.js create() 检测到
//   MAP_DATA.spawnBases 且钩子存在且 setup 成功后接管出兵，否则回退路线波次。
//   本模块加载失败不影响主游戏（模块报错只让钩子缺失，走回退分支）。
// ============================================================================

import { S } from '../wg/S.js';
import { spawnEnemyRouteUnit } from '../wg/enemy.js';
import { getRouteUnitCap, getPlayerUnitRecord } from '../wg/records.js';

const ROUTE_NAME = 'green';      // 时间 / 兵种 / 上限的配置来源路线
const WAVE_INTERVAL_MS = 10000;  // 子基地波次间隔（每 10 秒一波）
const BASE_PER_WAVE = 2;         // 每波每个基地随机出 2 个单位
const FALLBACK_POOL = ['Vespid', 'Guard', 'Striker', 'Ripper', 'Prowler'];

// 出生动画兜底参数：与 unit_db spawn_animation_duration/min_scale（720 / 0.3）及
// state.js SPAWN_RING_*（146.5 / 49 / 0x9fe3ff）同源同值；setup 时按我方数值记录覆盖
const SPAWN_ANIMATION_DURATION_FALLBACK = 720;
const SPAWN_ANIMATION_MIN_SCALE_FALLBACK = 0.3;
const SPAWN_RING_RADIUS = 146.5;
const SPAWN_BADGE_RADIUS = 49;
const SPAWN_RING_COLOR = 0x9fe3ff;

let ringGraphics = null;
let activeAnims = [];            // 正在播放出生动画的单位 { enemy, startedAt, x, y }
let baseCursor = 0;              // 波次轮转游标：上限不足 4 个时让各基地轮流出兵
let animDuration = SPAWN_ANIMATION_DURATION_FALLBACK;
let animMinScale = SPAWN_ANIMATION_MIN_SCALE_FALLBACK;
let sceneUpdateHandler = null;   // 持有注册引用，shutdown 时成对注销（防监听器泄漏）

// 一波出兵：受四基地共享的绿线上限约束，差额部分按基地轮转各出 BASE_PER_WAVE 个随机兵种
function spawnWave(scene, mapData, config) {
  if (!scene || !scene.sys || !scene.sys.isActive()) return;
  const now = scene.time.now;
  if (now < config.startAt) return;
  const alive = S.enemiesGroup.getChildren()
    .filter(enemy => enemy.active && !enemy.independentHeavy && enemy.baseSpawned).length;
  const slots = Math.min(config.bases.length * BASE_PER_WAVE, config.waveSize, getRouteUnitCap(config, now) - alive);
  for (let index = 0; index < slots; index++) {
    const base = config.bases[(baseCursor + index) % config.bases.length];
    const unitKey = config.waveKeys[Phaser.Math.Between(0, config.waveKeys.length - 1)];
    spawnBaseUnit(scene, mapData, base, unitKey, config.routeData);
  }
  baseCursor = (baseCursor + Math.max(0, slots)) % Math.max(1, config.bases.length);
}

// 单个子基地出兵：优先走提取器写入的用户标注出生线（base.route：基地→交汇点），
// 之后接绿线干线（交汇点→出生点）；无标注线时回退「就近接入干线」合成走廊；
// 合成 per-base routeData（variants=[走廊] 长度 1 → rerollEnemyRoute 空转），
// 单位创建/数值/骨骼/碰撞全部复用 spawnEnemyRouteUnit
function spawnBaseUnit(scene, mapData, base, unitKey, routeData) {
  const points = routeData.points || [];
  const spawn = mapData.world.spawnPoint;
  // 要求2：出兵落点钳制在地图内部（留 8px 边距），杜绝边界外生成
  const bx = Phaser.Math.Clamp(base.x, 8, mapData.world.width - 8);
  const by = Phaser.Math.Clamp(base.y, 8, mapData.world.height - 8);
  let corridor;
  if (Array.isArray(base.route) && base.route.length >= 2) {
    corridor = [{ x: bx, y: by }];
    for (const p of base.route) corridor.push({ x: p.x, y: p.y });
    // 要求3/4：按并入点拼接主干线——从主干线上距 join 最近的点接续，
    // 避免回到主干线起点的回头路/重叠；join 偏离主干线 >160px 视为无效回退全程
    let fromIdx = 0;
    if (base.join) {
      let bestD = Infinity;
      for (let i = 0; i < points.length; i++) {
        const d = (points[i].x - base.join.x) ** 2 + (points[i].y - base.join.y) ** 2;
        if (d < bestD) { bestD = d; fromIdx = i; }
      }
      if (bestD > 160 * 160) fromIdx = 0;
    }
    for (let i = fromIdx; i < points.length; i++) {
      const last = corridor[corridor.length - 1];
      if (Math.hypot(points[i].x - last.x, points[i].y - last.y) > 0.5) corridor.push({ x: points[i].x, y: points[i].y });
    }
  } else {
    let nearestIndex = 0, bestD = Infinity;
    for (let i = 0; i < points.length; i++) {
      const d = (points[i].x - bx) ** 2 + (points[i].y - by) ** 2;
      if (d < bestD) { bestD = d; nearestIndex = i; }
    }
    corridor = [{ x: bx, y: by }, ...points.slice(nearestIndex).map(p => ({ x: p.x, y: p.y }))];
  }
  const tail = corridor[corridor.length - 1];
  if (Math.hypot(tail.x - spawn.x, tail.y - spawn.y) > 24) corridor.push({ x: spawn.x, y: spawn.y });
  const baseRouteData = Object.assign({}, routeData, { points: corridor, variants: [corridor] });
  const enemy = spawnEnemyRouteUnit(scene, baseRouteData, unitKey, { at: { x: bx, y: by }, route: corridor });
  if (!enemy) return;
  enemy.baseSpawned = true;
  // 我方同款出生动画：先摆到起始体型 + 全透明，update 钩子逐帧插值；
  // scaleX 符号保留 setEnemyFacing 的朝向镜像（与我方 member.character 同处理）
  const minScale = enemy.characterScale * animMinScale;
  enemy.character.setScale(enemy.character.scaleX < 0 ? -minScale : minScale, minScale);
  enemy.character.setAlpha(0);
  enemy.spawnAnim = { startedAt: scene.time.now };
  activeAnims.push({ enemy, startedAt: scene.time.now, x: bx, y: by });
}

// 出生动画逐帧更新：体型与透明度插值（Cubic.Out）+ 落地扩散光环。
// 挂在 scene.events 的 update 事件上（场景 update 之后执行），
// 每帧最终改写体型/透明度，不会被引擎本帧的 setEnemyFacing / 动画切换覆盖
function updateSpawnAnims(time) {
  if (!activeAnims.length) return;
  activeAnims = activeAnims.filter(a => {
    const enemy = a.enemy;
    // 单位在动画期间阵亡 / 被销毁：立即结束它的动画（spawnAnim 标记一并清理）
    if (!enemy.active || !enemy.character) {
      delete enemy.spawnAnim;
      return false;
    }
    const progress = Phaser.Math.Clamp((time - a.startedAt) / animDuration, 0, 1);
    const appear = Phaser.Math.Easing.Cubic.Out(progress);
    const scale = enemy.characterScale * (animMinScale + (1 - animMinScale) * appear);
    enemy.character.setScale(enemy.character.scaleX < 0 ? -scale : scale, scale);
    enemy.character.setAlpha(appear);
    if (progress >= 1) {
      delete enemy.spawnAnim;
      return false;
    }
    return true;
  });
  drawSpawnRings(time);
}

// 落地扩散光环：淡蓝外环 + 白色内环，0.8 进度内扩散完并淡出（我方同款双环样式）
function drawSpawnRings(time) {
  if (!ringGraphics) return;
  if (!activeAnims.length) {
    ringGraphics.clear();
    ringGraphics.setVisible(false);
    return;
  }
  ringGraphics.clear();
  ringGraphics.setVisible(true);
  for (const a of activeAnims) {
    const progress = Phaser.Math.Clamp((time - a.startedAt) / animDuration, 0, 1);
    const flash = Phaser.Math.Clamp(progress / 0.8, 0, 1);
    const easedFlash = Phaser.Math.Easing.Cubic.Out(flash);
    const radius = SPAWN_BADGE_RADIUS * 0.35 + (SPAWN_RING_RADIUS - SPAWN_BADGE_RADIUS * 0.35) * easedFlash;
    ringGraphics.lineStyle(1 + 3 * (1 - flash), SPAWN_RING_COLOR, 0.95 * (1 - flash));
    ringGraphics.strokeCircle(a.x, a.y, radius);
    ringGraphics.lineStyle(1 + 2 * (1 - flash), 0xffffff, 0.55 * (1 - flash));
    ringGraphics.strokeCircle(a.x, a.y, radius * 0.6);
  }
}

// 场景装配：由 scene.js create() 在检测到 MAP_DATA.spawnBases 时调用。
// 返回 false 表示配置不满足（调用方回退到路线波次出兵），true 表示已接管
function setup(scene, mapData) {
  const bases = Array.isArray(mapData.spawnBases) ? mapData.spawnBases : [];
  const routeData = (mapData.enemyRoutes || []).find(route => route.name === ROUTE_NAME) || null;
  if (bases.length < 2) {
    console.warn('[wg2] spawnBases 缺失或不足 2 个子基地，回退路线波次出兵');
    return false;
  }
  if (!routeData) {
    console.warn('[wg2] 找不到绿线（green）路线配置，回退路线波次出兵');
    return false;
  }
  // 时间 / 上限 / 兵种池全部读绿线配置（缺失字段用绿线默认值兜底）
  const config = {
    routeData,
    bases,
    startAt: routeData.startAt || 0,
    waveSize: routeData.waveSize || bases.length,
    capBase: routeData.capBase != null ? routeData.capBase : 4,
    capGrowthMs: routeData.capGrowthMs || 30000,
    capMax: routeData.capMax || 7,
    waveKeys: routeData.waveKeys && routeData.waveKeys.length ? routeData.waveKeys : FALLBACK_POOL
  };
  // 出生动画时长/起始体型按我方单位数值记录（spawn_animation_*），缺省 720ms / 0.3
  const playerRecord = getPlayerUnitRecord();
  animDuration = playerRecord && playerRecord.spawn_animation_duration > 0
    ? playerRecord.spawn_animation_duration
    : SPAWN_ANIMATION_DURATION_FALLBACK;
  animMinScale = playerRecord && playerRecord.spawn_animation_min_scale > 0
    ? playerRecord.spawn_animation_min_scale
    : SPAWN_ANIMATION_MIN_SCALE_FALLBACK;

  baseCursor = 0;
  activeAnims = [];
  ringGraphics = scene.add.graphics().setDepth(3).setVisible(false);
  sceneUpdateHandler = time => updateSpawnAnims(time);
  scene.events.on('update', sceneUpdateHandler);
  scene.events.once('shutdown', () => {
    if (sceneUpdateHandler) {
      scene.events.off('update', sceneUpdateHandler);
      sceneUpdateHandler = null;
    }
    if (ringGraphics) {
      ringGraphics.destroy();
      ringGraphics = null;
    }
    activeAnims = [];
  });

  spawnWave(scene, mapData, config);   // 绿线语义：开局立即出第一波
  scene.time.addEvent({
    delay: WAVE_INTERVAL_MS,
    loop: true,
    callback: () => spawnWave(scene, mapData, config)
  });
  return true;
}

window.__WG2_BASE_SPAWN__ = { setup };
