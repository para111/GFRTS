// ============================================================
// wg_game 模块化拆分 —— enemy.js
// 职责: 敌军：行军/追击/攻击/自爆/碰撞隔离
// 来源: wg_game.js 语句区间 577-8733（自动拆分，勿手工重排语句顺序）
// ============================================================

import { S } from './S.js';
import { applyDeathTint, computeArmorDamage, damagePlayerMember, detonateUnit, showCombatText } from './combat.js';
import { isRedZoneClearanceSafePath } from './core.js';
import { limitPointTowards, pointInPolygon } from './geometry.js';
import { getShortestShieldedPath, isRedZonePathCrossed, isRouteNodeWalkable, slideAlongRedContour } from './pathfind.js';
import { findNearestVisiblePlayerMember, getEnemyTargetScanGate, getLockedPlayerMember, isPlayerMemberVisibleTo } from './player-member.js';
import { getPlayerSteeringTarget, hasSpawnedPlayerSquad } from './player-squad.js';
import { getEnemyUnitRecord, getPlayerUnitRecord, getRouteUnitCap } from './records.js';
import { DEATH_TINT_DURATION, DEATH_TINT_STRENGTH, ENEMY_ATTACK_CONTACT_TOLERANCE, ENEMY_ATTACK_LOOP, ENEMY_ATTACK_RELEASE_MARGIN, ENEMY_BAR_WIDTH, ENEMY_CHARACTER_SCALE, ENEMY_CHARGE_TIMEOUT, ENEMY_COLLISION_RADIUS, ENEMY_DETONATE_DELAY, ENEMY_ENDPOINT_IDLE_MAX, ENEMY_ENDPOINT_IDLE_MIN, ENEMY_ENDPOINT_RETURN_DISTANCE, ENEMY_ENDPOINT_ROAM_RADIUS, ENEMY_EXPLOSION_RADIUS, ENEMY_HOLD_DURATION, ENEMY_KNOCKBACK_DISTANCE, ENEMY_KNOCKBACK_DURATION, ENEMY_MAX_COUNT, ENEMY_PATROL_MIN_RADIUS, ENEMY_PATROL_RADIUS, ENEMY_RED_ZONE_CLEARANCE, ENEMY_REPLANS_PER_FRAME, ENEMY_REPLAN_COOLDOWN, ENEMY_SEPARATION_CELL, ENEMY_SEPARATION_DISTANCE, ENEMY_SEPARATION_MAX_PUSH, ENEMY_SEPARATION_STRENGTH, ENEMY_STUCK_DISTANCE, ENEMY_STUCK_TIME, ENEMY_TRACK_RANGE, ENEMY_TRACK_RELEASE_MARGIN, GUSTAF_BODY_RADIUS, GUSTAF_X, GUSTAF_Y, PLAYER_MEMBER_SEPARATION_MAX_PUSH, PLAYER_RED_STEER_BIAS, RED_CLEARANCE_TOLERANCE, collisionRegions, enemySeparationGrid, enemyTrackAimPoint, modulePerf, playerSquads } from './state.js';
import { applyFacingScale } from './units-visual.js';
// WG2 全局修正：渲染缩放 -0.1 / 移速 ×0.9（WG.html 恒为 0 / 1，见 state.js）
import { WG2_UNIT_SCALE_DELTA, WG2_SPEED_FACTOR } from './state.js';
import { correctPointOutOfRedClearance, isPointSafelyWalkable, isRedClearanceSafePoint, isRedClearanceSafeSegment, isWalkable, isZoneBlocked } from './zones.js';


  function takeEnemyReplanSlot() {
    if (S.enemyReplanFrame !== S.redQueryFrame) {
      S.enemyReplanFrame = S.redQueryFrame;
      S.enemyReplanCount = 0;
    }
    if (S.enemyReplanCount >= ENEMY_REPLANS_PER_FRAME) return false;
    S.enemyReplanCount += 1;
    return true;
  }


  function getEnemyNextRoutePoint(enemy) {
    for (let i = enemy.waypointIndex; i < enemy.route.length; i++) {
      if (isRouteNodeWalkable(enemy.route[i])) return enemy.route[i];
    }
    return null;
  }


  function replanEnemyToNextPointImpl(enemy, target, time, priority = false) {
    if (!target) return false;
    const targetKey = `${Math.round(target.x)}:${Math.round(target.y)}`;
    if (enemy.replanAttemptedKey === targetKey && time < enemy.replanRetryAt) {
      return enemy.detourPath.length > 0;
    }
    // 本帧的整段绕行名额已用完：不写重试键、不记冷却，下一帧再排队，
    // 本帧继续沿既有绕行路径前进（没有路径时由逐帧安全转向兜底）。
    // 卡死兜底必须传 priority：那条路径会按返回值为假跳过当前路线点，
    // 若把「排队中」也当成失败，被卡住的单位会在几帧内连跳多个点位
    if (!priority && !takeEnemyReplanSlot()) return enemy.detourPath.length > 0;
    enemy.replanAttemptedKey = targetKey;
    enemy.replanRetryAt = time + ENEMY_REPLAN_COOLDOWN;
    const start = { x: enemy.x, y: enemy.y };
    const path = getShortestShieldedPath(
      start,
      target,
      isRedZonePathCrossed(start.x, start.y, target.x, target.y),
      ENEMY_RED_ZONE_CLEARANCE
    );
    enemy.replanTargetKey = targetKey;
    enemy.detourPath = path && path.every((point, index) => {
      const previous = index === 0 ? start : path[index - 1];
      return isRedClearanceSafeSegment(previous, point, ENEMY_RED_ZONE_CLEARANCE, false, RED_CLEARANCE_TOLERANCE);
    }) ? path : [];
    return enemy.detourPath.length > 0;
  }


  // 计时埋点：敌方整段重规划（绕行/卡死兜底）耗时归入 modulePerf.sub.replanMs。
  // 包装器保持原签名；priority 未传时由 Impl 的默认参数生效
  function replanEnemyToNextPoint(enemy, target, time, priority) {
    const startedAt = performance.now();
    const result = replanEnemyToNextPointImpl(enemy, target, time, priority);
    modulePerf.sub.replanMs += performance.now() - startedAt;
    return result;
  }


  // 敌军共用的安全转向：直线净空就直接走该点，接近屏蔽区时改走沿红区外沿的滑动点。
  // 这样每帧只做净空与滑动判定，不会为绕行反复整段重规划，也不会撞上红区急停
  // speed 缺省取行军速度，智能追踪时传入 300 像素/秒的追踪速度：
  // 转向与推进共用同一份「每帧预算」，任何帧率下速度都严格等于传入值
  function steerEnemyTowardsImpl(enemy, target, delta, maxStep, speed = enemy.speed) {
    if (!target) return null;
    const origin = { x: enemy.x, y: enemy.y };
    const stepBudget = Math.max(0.6, speed * delta / 1000);
    const budget = maxStep === undefined ? stepBudget : Math.min(stepBudget, maxStep);
    // 转向与净空判定都用「安全带 + 转向偏置」作为目标净空：直接按 38 像素做推离修正时，
    // 落点会正好停在 9.999，下一帧任何步进都会被判为不净空而丢弃，单位就再也走不动了
    const safeClearance = ENEMY_RED_ZONE_CLEARANCE + PLAYER_RED_STEER_BIAS;
    let point = null;
    if (isRedClearanceSafeSegment(origin, target, safeClearance, false, RED_CLEARANCE_TOLERANCE)) {
      point = limitPointTowards(origin, target, budget);
    } else {
      const steered = getPlayerSteeringTarget(origin, target, budget, safeClearance);
      // 单帧步长同样受预算限制：追击时用它把位移严格卡在行动点牵引半径以内
      point = steered ? limitPointTowards(origin, steered, budget) : null;
      // 贴边兜底：转向点位移不足整帧预算时（贴边脱离与推离修正互相抵消，几乎原地不动），
      // 再算一次「沿红区外沿滑动」的推进点；贴边时只要不比你差就用它，
      // 保证沿屏蔽区行走时始终以红区轮廓为最终判断依据、按设定速度前进而不抖动
      const advanced = point ? Phaser.Math.Distance.Between(origin.x, origin.y, point.x, point.y) : 0;
      if (advanced < budget - RED_CLEARANCE_TOLERANCE) {
        const contourStep = getEnemyContourStep(origin, target, budget, safeClearance);
        if (contourStep) {
          const contourAdvance = Phaser.Math.Distance.Between(origin.x, origin.y, contourStep.x, contourStep.y);
          const hugging = !isRedClearanceSafePoint(origin.x, origin.y, safeClearance);
          if (contourAdvance > advanced || (hugging && contourAdvance > advanced - RED_CLEARANCE_TOLERANCE)) {
            point = contourStep;
          }
        }
      }
    }
    // 转向点可能落在路径松弛量之内，这里再收紧一次，避免单位实际贴进安全带
    return point ? enforceEnemyRedClearanceStep(origin, point) : null;
  }


  // 计时埋点：敌方追踪/行军的安全转向步（净空判定 + 贴边滑动）归入 modulePerf.sub.steerMs。
  // 包装器保持原签名；speed 未传时由 Impl 的默认参数 enemy.speed 生效
  function steerEnemyTowards(enemy, target, delta, maxStep, speed) {
    const startedAt = performance.now();
    const result = steerEnemyTowardsImpl(enemy, target, delta, maxStep, speed);
    modulePerf.sub.steerMs += performance.now() - startedAt;
    return result;
  }


  // 敌军沿红区外沿的组合步：站位已在安全带以内时，先把这一步用于脱离，
  // 余量再沿红区外沿滑动，两段合成为一个本帧可直连的落点（贴边时不再逐帧空转）。
  // 返回 null 表示当前没有任何可用的沿边推进点
  function getEnemyContourStep(origin, target, budget, clearance = ENEMY_RED_ZONE_CLEARANCE + PLAYER_RED_STEER_BIAS) {
    const walkClearance = clearance + PLAYER_RED_STEER_BIAS;
    let base = origin;
    let remaining = budget;
    if (!isRedClearanceSafePoint(origin.x, origin.y, walkClearance)) {
      const escape = correctPointOutOfRedClearance(origin, walkClearance);
      const escapeDistance = Phaser.Math.Distance.Between(origin.x, origin.y, escape.x, escape.y);
      if (!(escapeDistance > 0.0001)) return null;
      if (escapeDistance >= remaining) {
        const ratio = remaining / escapeDistance;
        return { x: origin.x + (escape.x - origin.x) * ratio, y: origin.y + (escape.y - origin.y) * ratio };
      }
      base = escape;
      remaining -= escapeDistance;
    }
    const slide = remaining > 0.0001
      ? slideAlongRedContour(base, target, remaining, clearance)
      : null;
    return slide || (base === origin ? null : base);
  }


  // 敌方落点净空（只留亚像素容差）：起点在安全带内时放行，交给上层走脱离逻辑，避免被判死卡住。
  // 容差必不可少——单位站位可能正好压净空边界上，严格比较会否掉整段沿边推进步
  function enforceEnemyRedClearanceStep(origin, point) {
    if (!point) return null;
    if (isRedClearanceSafeSegment(origin, point, ENEMY_RED_ZONE_CLEARANCE, false, RED_CLEARANCE_TOLERANCE)) {
      return point;
    }
    const corrected = correctPointOutOfRedClearance(point, ENEMY_RED_ZONE_CLEARANCE + RED_CLEARANCE_TOLERANCE);
    if (isRedClearanceSafeSegment(origin, corrected, ENEMY_RED_ZONE_CLEARANCE, false, RED_CLEARANCE_TOLERANCE)) {
      return corrected;
    }
    // 起点或落点已经压进安全带（含亚像素）时，先把两者一起外推到安全带 + 转向偏置再按原方向推进：
    // 实测单位正好停在净空 9.999 的站位上，从那里出发的任何一步都会被判为不净空，
    // 若不先脱离，这一帧就会被整段丢弃，单位就会永远原地不动
    const standoff = ENEMY_RED_ZONE_CLEARANCE + PLAYER_RED_STEER_BIAS;
    const paddedOrigin = correctPointOutOfRedClearance(origin, standoff);
    const paddedPoint = correctPointOutOfRedClearance(point, standoff);
    if (!isRedClearanceSafeSegment(paddedOrigin, paddedPoint, ENEMY_RED_ZONE_CLEARANCE, false, RED_CLEARANCE_TOLERANCE)) {
      return null;
    }
    let safeRatio = 0;
    let unsafeRatio = 1;
    let best = paddedOrigin;
    for (let index = 0; index < 8; index += 1) {
      const ratio = (safeRatio + unsafeRatio) / 2;
      const probe = {
        x: paddedOrigin.x + (paddedPoint.x - paddedOrigin.x) * ratio,
        y: paddedOrigin.y + (paddedPoint.y - paddedOrigin.y) * ratio
      };
      if (isRedClearanceSafeSegment(paddedOrigin, probe, ENEMY_RED_ZONE_CLEARANCE, false, RED_CLEARANCE_TOLERANCE)) {
        best = probe;
        safeRatio = ratio;
      } else {
        unsafeRatio = ratio;
      }
    }
    return best;
  }


  // 本帧位移直接积分：把单位沿目标方向推进「速度 × 帧长」（不越过目标点），
  // 再用 body.reset 落地。Arcade 物理是按 60Hz 固定步长推进的，而本作渲染帧率远高于 60fps，
  // 交给 moveToObject 换算速度时会出现「好几帧完全不动、动一下跳一小步」的迟滞感，
  // 实测速度也只有 300 像素/秒的一半左右；改成按渲染帧长积分后，任何帧率下速度都严格等于设定值
  function advanceEnemyTowards(enemy, point, delta, speed) {
    if (!point || !enemy.body) return false;
    const dx = point.x - enemy.x;
    const dy = point.y - enemy.y;
    const distance = Math.hypot(dx, dy);
    const travel = Math.min(
      distance,
      Math.max(0, (speed === undefined ? enemy.speed : speed) * delta / 1000)
    );
    if (!(travel > 0.0001)) {
      enemy.body.stop();
      return false;
    }
    const ratio = travel / distance;
    enemy.body.reset(enemy.x + dx * ratio, enemy.y + dy * ratio);
    return true;
  }


  // 起点落在不可行走区域（被隔离推挤顶到世界边界、地形缺口）时的兜底：
  // 所有以非法起点开头的线段都会被 isSafePath 否掉，转向 / 绕行 / 沿边滑动会全部返回空，
  // 单位就会永久空转。这里退化成入场行军那套纯积分推进——朝路线上最近的可行走节点
  // 直线走一步（同样受速度限制，不会瞬移），走出非法区域后常规判定自动接管
  function stepEnemyOutOfUnwalkable(enemy, delta) {
    if (!delta || isEnemyPoseWalkable(enemy)) return false;
    const route = enemy.route || [];
    let target = null;
    let bestDistance = Infinity;
    for (let i = 0; i < route.length; i++) {
      const node = route[i];
      if (!isRouteNodeWalkable(node)) continue;
      const distance = Phaser.Math.Distance.Between(enemy.x, enemy.y, node.x, node.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        target = node;
      }
    }
    if (!target || !advanceEnemyTowards(enemy, target, delta)) return false;
    syncEnemyFacing(enemy, target);
    setEnemyAnimation(enemy, 'move', true);
    return true;
  }


  // 红色屏蔽区视线判定：敌方与我方单位之间的直线只要穿过红色屏蔽区，
  // 敌方就既看不到、也打不到该单位。与我方攻击用的是同一套判定（isRedZonePathCrossed），
  // 攻守双方规则一致
  function isEnemySightClear(enemy, point) {
    if (!point) return false;
    return !isRedZonePathCrossed(enemy.x, enemy.y, point.x, point.y);
  }

  function getEnemyTrackTargetPoint(enemy) {
    // 同一帧内敌我位置都不会再变，而本函数在敌方主循环与追踪逻辑里各调用一次；
    // 按「敌人 + 帧号」复用一次选人结论，视线判定（含红区相交测试）每帧每人只做一次
    if (enemy.aimFrame !== S.redQueryFrame) {
      // 选人带距离门控：trackRange 之外的队员不可能通过任何激活/交火/结算判定，
      // 门控让远离战斗的敌人零视线判定（见 getEnemyTargetScanGate）
      const member = findNearestVisiblePlayerMember(enemy, getEnemyTargetScanGate(enemy));
      const visible = member && member.character ? member.character : null;
      enemy.aimX = visible ? visible.x : null;
      enemy.aimY = visible ? visible.y : null;
      // 同步缓存锁定队员本体：交火圈需要按目标队员的实际碰撞体积做动态补偿
      enemy.aimMember = visible ? member : null;
      enemy.aimFrame = S.redQueryFrame;
    }
    if (enemy.aimX === null) return null;
    enemyTrackAimPoint.x = enemy.aimX;
    enemyTrackAimPoint.y = enemy.aimY;
    return enemyTrackAimPoint;
  }


  // 追踪与交火的距离参照：同样取「直线畅通的最近存活队员」，与追踪目标点是同一个点。
  // 激活追踪、退出追踪、判断是否进入攻击范围都用它，不会出现
  // 「按小队中心判定射程、却朝着另一名队员开枪」的错位；
  // 目标不可见（直线被红色屏蔽区遮挡）时返回 Infinity，等价于「已超出追踪范围」，
  // 追踪与开火都会立刻停止，直到视线重新畅通
  function getEnemyTrackGap(enemy) {
    const aimPoint = getEnemyTrackTargetPoint(enemy);
    if (!aimPoint) return Infinity;
    return Phaser.Math.Distance.Between(enemy.x, enemy.y, aimPoint.x, aimPoint.y);
  }


  // 进入追踪：我方单位进入追踪范围（160 像素）即激活，随即由 updateEnemyTracking 立即开火。
  // 追踪位移不再受「行动点牵引半径」限制，而是由追踪范围约束：追击期间不会突然折返，
  // 也不会出现「明明在射程内却站着不动」的迟滞
  function beginEnemyTrack(enemy, time) {
    if (!hasSpawnedPlayerSquad()) return false;
    if (enemy.routeState === 'tracking') return true;
    enemy.routeState = 'tracking';
    enemy.engaging = false;
    // 锁定目标：原锁定对象仍存活且直线畅通就继续用，否则重选最近的可见队员。
    // 追踪期间目标固定，不会被队友挤位抢走焦点
    if (!isPlayerMemberVisibleTo(enemy, getLockedPlayerMember(enemy))) {
      const locked = findNearestVisiblePlayerMember(enemy, getEnemyTargetScanGate(enemy));
      enemy.lockedTargetKey = locked ? locked.uid : null;
    }
    enemy.holdUntil = 0;
    enemy.detourPath = [];
    enemy.replanAttemptedKey = null;
    enemy.stuckAt = 0;
    // 进入追踪时重排开火节奏：很早就冷却完毕的计时不会让敌军一进入射程就连开数枪
    if (!(enemy.nextAttackAt > time)) enemy.nextAttackAt = time;
    return true;
  }


  // 放弃追踪：立刻折返原路线继续推进。是否重新追踪完全由「进入攻击范围」决定，
  // 不设任何时间冷却，不会出现「冷却期内站在射程内却不追」的迟滞
  function endEnemyTrack(enemy) {
    enemy.routeState = 'following';
    // 放弃追踪即解除目标锁定与交火姿态：下次进入追踪重新选人、重新从移动姿态起步；
    // 未落地的半程伤害一并作废
    enemy.lockedTargetKey = null;
    enemy.engaging = false;
    enemy.pendingStrikeAt = null;
    enemy.detourPath = [];
    enemy.replanAttemptedKey = null;
    enemy.stuckAt = 0;
    // 冲锋中途中断（目标拉出迟滞带 / 视线被挡 / 我方全灭）必须作废本次冲刺：
    // 否则残留的 dash 会在重新进入追踪时带着旧 startedAt 复活，冲锋窗口跨追踪会话延续
    enemy.dash = null;
  }


  // 追踪中的每帧行为：速度恒定为 ENEMY_TRACK_SPEED（300 像素/秒），按帧长积分，
  // 任何帧率下每帧位移都严格等于 80 × 帧长，不会出现移动迟滞；
  // 逼近到停火距离（= 默认攻击范围，100 像素）就停下交火，
  // 只有拉开到追踪范围之外才放弃追踪，随即从当前位置走向下一个行动点。
  // 攻击与追踪都要过红色屏蔽区判定：目标取「直线畅通的锁定队员」，
  // 视线被屏蔽区挡住时目标为空（等价于超出追踪范围），追踪与开火立刻停止。
  // 姿态与距离状态同步：我方人形在交火带内姿态恒为攻击动作（包含重新进入），
  // 拉出交火带立刻打断攻击动画转入移动动画，不做任何排队等待，也不经过等待动作。
  // 两条阈值都带迟滞，防止边界抖动：
  //   1. 进入交火 = 攻击范围 + 4 像素容差（ENEMY_ATTACK_CONTACT_TOLERANCE，见下），
  //      维持交火 = 进入交火 + ENEMY_ATTACK_RELEASE_MARGIN（12 像素）；
  //   2. 退出追踪 = 追踪范围 + ENEMY_TRACK_RELEASE_MARGIN（16 像素）。
  // 判断是否「已在攻击距离上」带 4 像素容差：敌军站定后可能正好停在停火距离外
  // 零点几个像素处，严格比较会把它挡在攻击逻辑之外，
  // 出现「我方单位明明已经贴到攻击距离、敌军却一直待机不开火」的错误
  function updateEnemyTracking(enemy, time, trackGap, delta) {
    // 退出追踪的门限是追踪范围 + 迟滞带（160 + 16 = 176 像素）：拉开到这么远才放弃追踪，
    // 这一帧不再改姿态，下一帧由常规路线逻辑接着从当前位置走向下一个行动点
    // 追踪激活 / 释放按「该兵种自己的追踪范围」判定（Jaeger 射程 450，全局 240 的
    // 激活门限会让狙击手在 240~450 距离内白挨打不还手——系统性缺陷）
    if (!hasSpawnedPlayerSquad() ||
        trackGap > enemy.trackRange + (enemy.record.track_release_margin || ENEMY_TRACK_RELEASE_MARGIN)) {
      enemy.body.stop();
      endEnemyTrack(enemy);
      return;
    }
    // 本帧位移上限同时受「帧长」与「停在交火距离」两个条件约束，
    // 因此逼近速度恒定 300 像素/秒，也不会冲进交火距离之内把我方单位挤开
    const aimPoint = getEnemyTrackTargetPoint(enemy);
    // 目标直线被红色屏蔽区挡住（或我方已无存活队员）：立刻放弃追踪，避免越区开火
    if (!aimPoint) {
      enemy.body.stop();
      endEnemyTrack(enemy);
      return;
    }
    const gap = Phaser.Math.Distance.Between(enemy.x, enemy.y, aimPoint.x, aimPoint.y);
    // 锁定对象阵亡或直线被红色屏蔽区挡住时，上面的取点已自动改选最近的可见队员，
    // 这里同步把锁定刷新到同一人，保证后续帧的目标点不再漂移。
    // 性能：getEnemyTrackTargetPoint 本帧已按同一口径（锁定可见则沿用，否则取最近可见者）
    // 做过一次选人，enemy.aimMember 就是该结论，且此时本帧敌我位置尚未变化——
    // 直接复用即可省去第二次 O(队员数) 扫描 + 红区视线判定，也不再出现同帧第二次全量重扫
    if (enemy.aimMember) {
      if (enemy.lockedTargetKey !== enemy.aimMember.uid) {
        enemy.lockedTargetKey = enemy.aimMember.uid;
      }
    } else if (enemy.lockedTargetKey) {
      enemy.lockedTargetKey = null;
    }
    const frameStep = enemy.trackSpeed * Math.max(0, delta) / 1000;
    // 交火圈按「当前锁定目标的实际碰撞体积」动态补偿：我方重装（TankM1 / Warjack / Ares，
    // body.radius 90）的队员-敌方碰撞隔离距离 = 90 + 20.5 = 110.5，远大于按步兵标定的
    // attackRange（自身碰撞半径 + 40 = 60.5）——不补偿的话，近战兵（含冲刺撞完后的站位）
    // 会被隔离推挤永久顶在交火圈外（实测稳定卡在 109.5），原地踏步永远进不了攻击逻辑。
    // 补偿值 = 双方碰撞半径之和 + 4，与冲刺接触距离同一公式，保证撞到哪里就在哪里开打；
    // 步兵目标（半径 17，补偿值 41.5 < 60.5）与远射程兵种取 max 后行为完全不变
    const aimMember = enemy.aimMember;
    const targetRadius = aimMember && aimMember.body ? aimMember.body.radius : 0;
    const effectiveAttackRange = Math.max(
      enemy.attackRange,
      enemy.collisionRadius + targetRadius + 4
    );
    // 「已在交火带内」用带容差 + 迟滞的判定：交火姿态一旦建立，容许多出 12 像素的
    // 迟滞带才退出，这样我方单位在停火距离附近上下微动时姿态不会每帧翻来覆去；
    // 同时站位停在停火距离外零点几个像素时位移预算会小到迈不动一步，
    // 必须按「已到位」站定开火，不能继续等位移
    const contactRange = effectiveAttackRange + ENEMY_ATTACK_CONTACT_TOLERANCE +
      (enemy.engaging ? ENEMY_ATTACK_RELEASE_MARGIN : 0);
    // 冲刺近战（Guard / Aegis / Smasher / Kratos）：登记了 charge_stun_duration 的单位
    // 在追踪中直接向我方发动冲刺——高速逼近，撞到锁定目标即结算一次攻击伤害并令其
    // 小队陷入待机（步兵 1 秒 / 重甲 3 秒），随后原地进入常规交火逻辑（站位攻击）。
    // 冲刺一生只能使用一次（出生到死亡）：发动即消耗掉本次机会；
    // 撞不到人超时或被地形挡死同样作废，之后转为常规逼近，不再冲刺
    if ((enemy.record.charge_stun_duration || 0) > 0 && !enemy.dash && !enemy.chargeUsed &&
        gap > contactRange) {
      enemy.dash = { startedAt: time };
      enemy.chargeUsed = true;
      setEnemyAnimation(enemy, 'move', true);
    }
    if (enemy.dash) {
      // 冲锋速度：记录 charge_speed 原值需乘 WG2 修正；回退分支的 trackSpeed 已含修正不再重乘
      const dashSpeed = enemy.record.charge_speed
        ? enemy.record.charge_speed * WG2_SPEED_FACTOR
        : enemy.trackSpeed * 2;
      // 【性能】冲刺受害者直接复用本帧瞄准结论 aimMember：本函数开头已把 lockedTargetKey
      // 同步为 aimMember.uid，getLockedPlayerMember 此刻必然返回同一名队员（同一帧、
      // 状态未变、同一存活口径），省掉每帧一次 O(队员数) 全表扫描；锁定丢失时才回退重选
      const victim = enemy.aimMember || getLockedPlayerMember(enemy) || findNearestVisiblePlayerMember(enemy, getEnemyTargetScanGate(enemy));
      const contactDistance = victim && victim.body
        ? enemy.collisionRadius + victim.body.radius + 4
        : 0;
      if (!victim || !contactDistance) {
        enemy.dash = null;                       // 没有可撞的目标：转回常规追踪
      } else if (gap <= contactDistance) {
        // 撞到我方单位：撞击伤害等同一次攻击伤害 + 目标小队陷入待机，
        // 随后进入站位攻击逻辑（本次撞击计入正常攻击周期，间隔后继续开火）
        const defenderRecord = getPlayerUnitRecord(victim.squad ? victim.squad.unitKey : 'jf');
        damagePlayerMember(enemy.scene, victim, computeArmorDamage(enemy.record, defenderRecord));
        victim.squad.stunUntil = Math.max(victim.squad.stunUntil || 0, time + enemy.record.charge_stun_duration);
        showCombatText(enemy.scene, victim.character.x, victim.character.y - 46, '眩晕', '#ff8866');
        enemy.dash = null;
        enemy.body.stop();
        enemy.engaging = true;
        setEnemyFacing(enemy, aimPoint.x < enemy.x);
        setEnemyAnimation(enemy, enemy.attackAnim, ENEMY_ATTACK_LOOP);
        enemy.nextAttackAt = time + enemy.attackInterval;
        return;
      } else if (time - enemy.dash.startedAt >= ENEMY_CHARGE_TIMEOUT) {
        enemy.dash = null;                       // 冲刺超时（目标走位躲开）：转为常规逼近
        enemy.body.stop();
      } else if (advanceEnemyTowards(enemy, aimPoint, delta, dashSpeed)) {
        syncEnemyFacing(enemy, aimPoint);
        return;
      } else {
        enemy.dash = null;                       // 被地形完全挡住走不动：转回常规追踪
        enemy.body.stop();
      }
    }
    const inAttackRange = gap <= contactRange;
    // 位移预算同样按补偿后的交火圈收紧：站到「双方碰撞半径之和 + 4」就停，
    // 不会试图挤进碰撞隔离距离之内再被顶出来
    const stepBudget = inAttackRange ? 0 : Math.min(frameStep, gap - effectiveAttackRange);
    const steered = stepBudget > 0
      ? steerEnemyTowards(enemy, aimPoint, delta, stepBudget, enemy.trackSpeed)
      : null;
    if (steered && advanceEnemyTowards(enemy, steered, delta, enemy.trackSpeed)) {
      syncEnemyFacing(enemy, aimPoint);
      // 拉出交火带：立即打断正在播放的攻击动画，换成移动动画，并解除交火姿态；
      // 未落地的半程伤害一并作废（狙击兵重新进入交火时会重新起手）
      enemy.engaging = false;
      enemy.pendingStrikeAt = null;
      setEnemyAnimation(enemy, 'move', true);
      return;
    }
    // 站定后的交火阶段
    enemy.body.stop();
    setEnemyFacing(enemy, aimPoint.x < enemy.x);
    if (!inAttackRange) {
      // 还没进交火带却无法位移（被红区挡住走不动）：先待机等路径打开。
      // 这里不强制重播：每帧重播会把等待动作一直按回第一帧，看上去像卡住不动
      enemy.engaging = false;
      setEnemyAnimation(enemy, 'wait');
      return;
    }
    // 我方人形在交火带内：姿态恒为攻击动作（循环播放，一直打到我方单位拉出交火带为止）。
    // 首次进入与重新进入都直接进攻击动作，中途不会退回等待动作，因此不会出现
    // 「人在射程内、敌方却在待机」或「重新进入时先播一次等待动作」的错觉
    enemy.engaging = true;
    // 【伤害结算规则】所有敌方「射程 > 400」的兵种（如 Jaeger 450）：攻击伤害在
    // 「攻击动画播放到一半」时计算——攻击动画单次播放，动画过半瞬间对当前直线畅通的
    // 最近队员结算伤害，结算后按攻击间隔进入下一轮。其余兵种保持原逻辑：
    // 攻击姿态循环播放，伤害按固定间隔节流
    if ((enemy.record.action_range || 0) > 400) {
      if (enemy.pendingStrikeAt === null || enemy.pendingStrikeAt === undefined) {
        // 新一轮攻击：单次播放攻击动画，预约「动画过半」的伤害结算点
        if (time < enemy.nextAttackAt) return;
        const attack = enemy.character && enemy.character.findAnimation
          ? enemy.character.findAnimation(enemy.attackAnim)
          : null;
        const attackDuration = attack && attack.duration > 0 ? attack.duration * 1000 : 600;
        setEnemyAnimation(enemy, enemy.attackAnim, false, true);
        enemy.pendingStrikeAt = time + attackDuration / 2;
        enemy.nextAttackAt = time + Math.max(enemy.attackInterval, attackDuration);
        return;
      }
      if (time < enemy.pendingStrikeAt) return;
      // 动画过半：计算伤害（门控与激活/交火判定同口径，门外队员本就不可能被交火圈选中）
      enemy.pendingStrikeAt = null;
      const victim = findNearestVisiblePlayerMember(enemy, getEnemyTargetScanGate(enemy));
      if (victim) {
        const defenderRecord = getPlayerUnitRecord(victim.squad ? victim.squad.unitKey : 'jf');
        damagePlayerMember(enemy.scene, victim, computeArmorDamage(enemy.record, defenderRecord));
      }
      return;
    }
    // 常规兵种：攻击姿态循环播放，伤害按固定间隔节流
    setEnemyAnimation(enemy, enemy.attackAnim, ENEMY_ATTACK_LOOP);
    if (time < enemy.nextAttackAt) return;
    enemy.nextAttackAt = time + enemy.attackInterval;
    // 命中锁定的队员：伤害按「敌方记录 vs 受击队员所属兵种记录」实时结算（各兵种护甲不同）
    const victim = findNearestVisiblePlayerMember(enemy, getEnemyTargetScanGate(enemy));
    if (victim) {
      const defenderRecord = getPlayerUnitRecord(victim.squad ? victim.squad.unitKey : 'jf');
      damagePlayerMember(enemy.scene, victim, computeArmorDamage(enemy.record, defenderRecord));
    }
  }


  // 行动点待机判定：每次待机只判定一次——
  // 玩家已进入追踪范围就转入追踪；下一路线节点被红区挡住就提前改走沿红区外沿的绕行曲线
  function decideEnemyActionPoint(enemy, time, trackGap) {
    if (enemy.decisionDone) return;
    enemy.decisionDone = true;
    if (hasSpawnedPlayerSquad() && trackGap <= enemy.trackRange) {
      beginEnemyTrack(enemy, time);
      return;
    }
    const nextRoutePoint = getEnemyNextRoutePoint(enemy);
    if (!nextRoutePoint) return;
    if (isRedClearanceSafeSegment({ x: enemy.x, y: enemy.y }, nextRoutePoint, ENEMY_RED_ZONE_CLEARANCE)) {
      return;
    }
    if (replanEnemyToNextPoint(enemy, nextRoutePoint, time)) enemy.routeState = 'detouring';
  }


  // 卡顿兜底：想走却长时间几乎没有位移，说明被屏蔽区或边界卡住，
  // 清除绕行缓存强制重规划一次；仍然无解就跳过当前路线点，保证敌军不会永久停在原地
  function isEnemyStuck(enemy, time, wantsMove) {
    if (!wantsMove) {
      enemy.stuckAt = 0;
      return false;
    }
    if (!enemy.stuckAt) {
      enemy.stuckAt = time;
      enemy.stuckX = enemy.x;
      enemy.stuckY = enemy.y;
      return false;
    }
    if (time - enemy.stuckAt < ENEMY_STUCK_TIME) return false;
    const moved = Phaser.Math.Distance.Between(enemy.stuckX, enemy.stuckY, enemy.x, enemy.y);
    enemy.stuckAt = time;
    enemy.stuckX = enemy.x;
    enemy.stuckY = enemy.y;
    return moved < ENEMY_STUCK_DISTANCE;
  }


  // 敌方姿态切换：姿态完全跟随距离状态即时切换——我方单位一移出攻击范围，
  // 正在播放的攻击动画立刻被打断、换成追踪的移动动画；重新进入攻击范围又立刻
  // 打断移动动画换回来，中途不排队、不等动作播完。
  // 这里只负责把动作下发到骨骼，currentAnimation 由调用方维护；
  // 唯一保留的约束是「同名姿态不重复下发」，避免每帧重新 setAnimation
  // 让动作从第一帧重播而卡在起始帧
  function setEnemyAnimation(enemy, animationName, loop, force = false) {
    if (!enemy.character || enemy.character.active === false) return;
    // 同一次攻击不重复下发：重复 setAnimation 会让动作从第一帧重播，看起来像被打断。
    // force = true 时不做去重（半程结算的狙击兵每轮攻击都要重新启动动画）
    if (!force) {
      if (animationName === 'attack' && enemy.currentAnimation === 'attack') return;
      if (enemy.currentAnimation === animationName) return;
    }
    enemy.currentAnimation = animationName;
    enemy.character.setAnimation(0, animationName, loop);
  }


  function setEnemyFacing(enemy, isLeft) {
    if (!enemy.character) return;
    enemy.facingLeft = isLeft;
    // 缩放按该兵种记录（Smasher / Kratos 等有独立 character_scale，
    // 不能用全局 0.272 覆盖——否则转向瞬间会把放大后的体型打回原形）
    const scale = enemy.characterScale || ENEMY_CHARACTER_SCALE;
    // 敌方单位默认朝左；向左使用负 X 缩放，向右恢复正 X。
    const scaleX = isLeft ? Math.abs(scale) : -Math.abs(scale);
    applyFacingScale(enemy.character, scaleX, scale);
    enemy.character.scaleX = scaleX;
    enemy.character.scaleY = scale;
  }


  function syncEnemyFacing(enemy, fallbackTarget) {
    // Waypoint 方向优先于上一帧速度，避免 moveToObject 更新前出现一帧反向。
    if (fallbackTarget && Math.abs(fallbackTarget.x - enemy.x) > 0.01) {
      setEnemyFacing(enemy, fallbackTarget.x < enemy.x);
      return;
    }
    const horizontalVelocity = enemy.body && enemy.body.velocity.x;
    if (Math.abs(horizontalVelocity) > 0.01) {
      setEnemyFacing(enemy, horizontalVelocity < 0);
    }
  }


  function destroyEnemy(enemy, playDeathAnimation = false) {
    if (!enemy || !enemy.active || enemy.deathStarted) return;
    const scene = enemy.scene;
    enemy.deathStarted = true;
    enemy.body.stop();
    enemy.body.enable = false;
    enemy.setActive(false);
    enemy.setVisible(false);
    if (S.focusTarget === enemy) S.focusTarget = null;
    if (playDeathAnimation && enemy.character) {
      const deathX = enemy.x;
      const deathY = enemy.y;
      const deathWidth = enemy.character.displayWidth || ENEMY_CHARACTER_SCALE * 130;
      const deathHeight = enemy.character.displayHeight || ENEMY_CHARACTER_SCALE * 187;
      const sinkDistance = Math.max(deathWidth, deathHeight) / 4;
      enemy.character.setPosition(deathX, deathY);
      enemy.character.setVisible(true);
      enemy.character.setAnimation(0, 'die', false);
      enemy.character.removeInteractive();
      enemy.character.setDepth(2);
      // 单位已从物理组移除，死亡动画单独播放，避免死亡单位继续参与逐帧逻辑。
      scene.time.delayedCall(3000, () => {
        if (!enemy.character || !scene.sys.isActive()) return;
        scene.tweens.add({
          targets: enemy.character,
          y: deathY + sinkDistance,
          alpha: 0,
          duration: 500,
          ease: 'Quad.easeIn',
          onComplete: () => {
            if (enemy.character) {
              enemy.character.destroy();
              enemy.character = null;
            }
          }
        });
      });
    } else if (enemy.character) {
      enemy.character.destroy();
      enemy.character = null;
    }
    enemy.destroy();
  }


  // 自爆击退：被命中的敌方单位沿「爆心 -> 单位」连心线被推开 ENEMY_KNOCKBACK_DISTANCE 像素，
  // 在 ENEMY_KNOCKBACK_DURATION 毫秒内匀速走完（10px / 0.5s ≈ 20 像素/秒）。
  // 爆心与单位重合时方向会退化，这里随机取一个方向，避免击退失效
  function applyEnemyKnockback(enemy, fromX, fromY) {
    if (!enemy || !enemy.active || !enemy.body) return;
    let dx = enemy.x - fromX;
    let dy = enemy.y - fromY;
    let length = Math.hypot(dx, dy);
    if (length < 0.0001) {
      const angle = Phaser.Math.FloatBetween(0, Math.PI * 2);
      dx = Math.cos(angle);
      dy = Math.sin(angle);
      length = 1;
    }
    enemy.knockback = {
      dirX: dx / length,
      dirY: dy / length,
      speed: ENEMY_KNOCKBACK_DISTANCE / (ENEMY_KNOCKBACK_DURATION / 1000),
      remaining: ENEMY_KNOCKBACK_DURATION
    };
  }


  // 击退位移逐帧结算：落点照旧走 pushEnemyAway 的可行走 + 红区安全带校验，
  // 贴在墙边或红区边缘的单位会被挡下（不会被打进屏蔽区），被挡下即提前结束击退。
  // 击退在本帧路线逻辑之前完成，之后的追踪/行军会从这个新位置继续
  function updateEnemyKnockback(enemy, delta) {
    const knockback = enemy.knockback;
    if (!knockback) return false;
    const dt = Math.max(0, delta);
    knockback.remaining -= dt;
    const step = knockback.speed * dt / 1000;
    // 先走位移再判断是否结束：否则最后一段步长会因为 remaining 归零而被吞掉（全程不足 10 像素）
    if (!pushEnemyAway(enemy, knockback.dirX * step, knockback.dirY * step)) {
      enemy.knockback = null;
      return false;
    }
    if (knockback.remaining <= 0) {
      enemy.knockback = null;
      return false;
    }
    return true;
  }


  // 敌方阵亡：原地不动，泛红 25% 后继续原地等待，满 3 秒原地自爆
  function beginEnemyDeath(enemy) {
    if (!enemy.active || enemy.charging || enemy.deathStarted) return;
    if (S.focusTarget === enemy) S.focusTarget = null;
    if (enemy.body) enemy.body.stop();
    // 引爆前由代码直接写坐标，关闭物理体避免被 arcade 每帧覆盖
    if (enemy.body) enemy.body.enable = false;
    enemy.charging = {
      startedAt: null,
      x: enemy.x,
      y: enemy.y
    };
    // 阵亡必须立刻换姿：打断正在播放的攻击动画，直接切到待机（随后进入死亡动作）
    setEnemyAnimation(enemy, 'wait', true, true);
  }


  function updateEnemyDeath(enemy, time) {
    const charge = enemy.charging;
    const character = enemy.character;
    // 引爆计时与主循环共用同一个时间源，染色全程按真实时间线性推进
    if (charge.startedAt === null) charge.startedAt = time;
    const elapsed = time - charge.startedAt;
    // 【性能】染色按 30Hz 下发（33ms）：900ms 渐变最多 28 次写全槽位，肉眼无法分辨
    // 与逐帧染色的差别；大面积同帧阵亡（AOE 团灭）时把 130 单位 × 全槽位的逐帧重写
    // 压到三分之一。饱和段（progress 到 1 后）applyDeathTint 内部量化早退会直接停写
    if (charge.lastTintAt === undefined || time - charge.lastTintAt >= 33) {
      charge.lastTintAt = time;
      applyDeathTint(character, Phaser.Math.Clamp(elapsed / DEATH_TINT_DURATION, 0, 1) * DEATH_TINT_STRENGTH);
    }
    if (!character) return;
    // 原地自爆：位置锁定在阵亡点，不做任何位移；泛红完成后继续原地待爆。
    // 等值早退：位置不变时不再触发 Phaser 变换脏化（阵亡单位在待爆期是纯静止状态）
    if (enemy.x !== charge.x || enemy.y !== charge.y) {
      enemy.setPosition(charge.x, charge.y);
      character.setPosition(charge.x, charge.y);
    }
    if (elapsed >= ENEMY_DETONATE_DELAY) {
      detonateUnit(enemy.scene, charge.x, charge.y, 'enemy', ENEMY_EXPLOSION_RADIUS);
      destroyEnemy(enemy, false);
    }
  }


  // 一波出兵：从本线的随机兵种池（不含独立计算的重甲）随机挑兵种，
  // 受「本线在场单位上限」约束——超过上限的差额才会生成，阵亡后名额自动腾出
  function spawnRouteWave(scene, route) {
    if (!scene || !scene.sys || !scene.sys.isActive()) return;
    const now = scene.time.now;
    if (now < (route.startAt || 0)) return;               // 红线开局 30 秒内不出兵
    const alive = S.enemiesGroup.getChildren()
      .filter(enemy => enemy.active && !enemy.independentHeavy && enemy.routeData === route).length;
    const slots = Math.min(route.waveSize, getRouteUnitCap(route, now) - alive);
    for (let index = 0; index < slots; index++) {
      const unitKey = route.waveKeys[Phaser.Math.Between(0, route.waveKeys.length - 1)];
      spawnEnemyRouteUnit(scene, route, unitKey);
    }
  }


  // Smasher / Kratos 独立增援：白线 / 红线各自每 2 分钟随机生成一个，
  // 标记 independentHeavy 不占用所在路线的出兵上限
  function spawnHeavyReinforcement(scene, route) {
    if (!scene || !scene.sys || !scene.sys.isActive()) return;
    const heavyKeys = ['Smasher', 'Kratos'];
    const unitKey = heavyKeys[Phaser.Math.Between(0, heavyKeys.length - 1)];
    const enemy = spawnEnemyRouteUnit(scene, route, unitKey);
    if (enemy) enemy.independentHeavy = true;
  }


  function spawnEnemyRouteUnit(scene, routeData, unitKey, options) {
    // 地图数据边界守卫：路线缺失时放弃本次生成（记录告警），不让单个坏数据炸掉整个 Tick
    if (!routeData) {
      console.warn('[enemy] spawnEnemyRouteUnit: routeData 缺失，跳过本次生成');
      return null;
    }
    // 兵力上限：地图内敌军数量达到上限就不再生成（阵亡后数量回落，各波次的定时器会自动补充）
    if (S.enemiesGroup.getChildren().length >= ENEMY_MAX_COUNT) return null;
    const routeVariants = routeData.variants || [routeData.points];
    // options.route（WG2 子基地出兵）：跳过变体随机抽取，直接使用调用方给定的路线与落点；
    // 未传 options 时行为与原先完全一致（WG.html 不受影响）
    let routeIndex = 0;
    let route;
    if (options && options.route) {
      route = options.route;
    } else {
      routeIndex = Phaser.Math.Between(0, routeVariants.length - 1);
      route = routeVariants[routeIndex];
    }
    const start = (options && options.at) || route[0];
    // 兵种由调用方指定（波次随机挑池 / 重甲独立增援），
    // 移速 / 射程 / 生命 / 攻击动画 / 冲刺配置等全部按该兵种记录读取
    const record = getEnemyUnitRecord(unitKey);
    const enemy = S.enemiesGroup.create(start.x, start.y, 'enemyTexture');
    enemy.setVisible(false);
    enemy.route = route;
    enemy.routeData = routeData;
    // 本次采用的走廊变体编号：每次从行动点出发前会重新随机挑一条（见 rerollEnemyRoute）
    enemy.routeVariantIndex = routeIndex;
    enemy.waypointIndex = 1;
    // 出生点在地图外：先用 entering 状态沿入场线走进地图，再转入 following；
    // 指定 options.route 的单位出生点就在地图内（WG2 子基地），直接进入常规路线推进
    enemy.routeState = (options && options.route) ? 'following' : 'entering';
    enemy.holdUntil = 0;
    enemy.roamTarget = null;
    // 被自爆命中后的击退状态（null = 不在击退中）
    enemy.knockback = null;
    enemy.holdCycles = 0;
    enemy.routeFinished = false;
    // 路线终点（变体末节点）：抵达后转入「终点 375 像素范围自由待机」，不再钉死在这一点上
    const terminal = route[route.length - 1];
    enemy.terminalX = terminal.x;
    enemy.terminalY = terminal.y;
    enemy.idleUntil = 0;
    enemy.detourPath = [];
    enemy.replanTargetKey = null;
    enemy.replanAttemptedKey = null;
    enemy.replanRetryAt = 0;
    // 智能追踪与卡顿兜底所需的状态：待机判定标记、卡住计时
    enemy.decisionDone = false;
    // 追踪的目标锁定与交火姿态：进入追踪时锁定队员，交火姿态带 12 像素迟滞带防抖
    enemy.lockedTargetKey = null;
    enemy.engaging = false;
    // 待机巡逻的行动点：每次进入待机时刷新为当前位置，巡逻范围受 ENEMY_PATROL_RADIUS 限制
    enemy.actionPointX = start.x;
    enemy.actionPointY = start.y;
    enemy.stuckAt = 0;
    enemy.stuckX = start.x;
    enemy.stuckY = start.y;
    enemy.unitKey = unitKey;
    enemy.record = record;
    enemy.hp = record.max_hp;
    enemy.maxHp = record.max_hp;
    const unitScale = (record.character_scale || ENEMY_CHARACTER_SCALE) + WG2_UNIT_SCALE_DELTA;
    // 行军与追踪速度按兵种移速；追踪范围 / 攻击间隔 / 攻击动画同样按记录。
    // 近战兵（action_range 5~20）的交火圈必须大于「队员-敌方碰撞隔离距离」，
    // 否则隔离推挤会把队员顶在交火圈外，冲刺撞完永远进不了交火逻辑——
    // 因此攻击范围至少取「自身碰撞半径 + 40」（≥ 步兵队员碰撞半径 17 + 敌方 20.5 + 余量）。
    // 我方重装队员（TankM1 / Warjack / Ares，碰撞半径 90）的隔离距离 110.5 超出这里，
    // 由 updateEnemyTracking 按当前锁定目标的实际体积动态补偿（见 effectiveAttackRange）
    enemy.speed = record.move_speed * WG2_SPEED_FACTOR;
    enemy.trackSpeed = record.move_speed * WG2_SPEED_FACTOR;
    enemy.collisionRadius = record.collision_radius || ENEMY_COLLISION_RADIUS;
    enemy.attackRange = Math.max(record.action_range || 0, enemy.collisionRadius + 40);
    enemy.trackRange = record.track_range || ENEMY_TRACK_RANGE;
    enemy.attackInterval = (record.action_cd || 1) * 1000;
    enemy.attackAnim = record.attack_animation_name || 'attack';
    enemy.characterScale = unitScale;   // 朝向镜像时的缩放来源（setEnemyFacing 读它）
    enemy.nextAttackAt = 0;
    enemy.currentAnimation = null;
    enemy.facingLeft = true;
    enemy.dying = null;
    // 阵亡引爆状态：血条耗尽后原地泛红，满 3 秒原地自爆
    enemy.charging = null;
    // 碰撞隔离的帧内累计推挤量（先累计、后统一校验落点）
    enemy.separationPushX = 0;
    enemy.separationPushY = 0;
    // 渲染骨架取该兵种花名册首项（敌方单位均为单兵编队）
    const skeletonKey = Array.isArray(record.roster) && record.roster.length ? record.roster[0] : 'Vespid';
    enemy.character = scene.add.spine(start.x, start.y, skeletonKey, 'wait', true);
    // 记录 Spine 原型 update（视野剔除时恢复骨骼动画推进用）
    if (!S.spineUpdateOriginal) S.spineUpdateOriginal = Object.getPrototypeOf(enemy.character).update;
    // 素材默认朝右，出生时先镜像为朝左（与 Vespid 同款约定）。
    enemy.character.setScale(-Math.abs(unitScale), unitScale);
    enemy.character.setDepth(2);
    enemy.barWidth = record.bar_width || ENEMY_BAR_WIDTH;
    setEnemyFacing(enemy, route[1].x < start.x);
    setEnemyAnimation(enemy, 'move', true);
    return enemy;   // 返回生成的单位：压测补兵与独立重甲增援依赖它判断是否真的生成
  }


  function beginEnemyHold(enemy, time, resetCycles = false) {
    enemy.body.stop();
    enemy.routeState = 'holding';
    enemy.holdUntil = time + ENEMY_HOLD_DURATION;
    enemy.roamTarget = null;
    // 当前行动点：本次待机的位置，接下来的巡逻只在这个点的 ENEMY_PATROL_RADIUS 范围内进行
    enemy.actionPointX = enemy.x;
    enemy.actionPointY = enemy.y;
    // 每次在行动点待机开始时重置一次判定标记，待机期间只判定一次
    enemy.decisionDone = false;
    if (resetCycles) enemy.holdCycles = 0;
    setEnemyAnimation(enemy, 'wait', true);
  }


  // 巡逻落点是否与其它敌方单位保持隔离距离：多支敌军在同一个行动点巡逻时，
  // 优先挑不与人重叠的落点，避免大家往同一个位置挤
  function isRoamSpotClearOfEnemies(self, spot) {
    const list = S.enemiesGroup.getChildren();
    for (let i = 0; i < list.length; i++) {
      const other = list[i];
      if (other === self || !other.active || other.charging) continue;
      if (Phaser.Math.Distance.Between(spot.x, spot.y, other.x, other.y) < ENEMY_SEPARATION_DISTANCE) {
        return false;
      }
    }
    return true;
  }


  // 路线点是否已被友军占住（友军踩在点上、且比本单位更靠近该点）。
  // 用于抵达判定：单位被隔离推挤顶在点时，永远进不了「6 像素」的抵达阈值，
  // 两队敌军在同一条走廊上迎面顶住就会永久互相抵消位移、原地抖动，队伍彻底堵死
  function isRoutePointClaimed(enemy, target) {
    const mine = Phaser.Math.Distance.Between(enemy.x, enemy.y, target.x, target.y);
    const list = S.enemiesGroup.getChildren();
    for (let i = 0; i < list.length; i++) {
      const other = list[i];
      if (other === enemy || !other.active || other.charging) continue;
      const their = Phaser.Math.Distance.Between(other.x, other.y, target.x, target.y);
      if (their < ENEMY_SEPARATION_DISTANCE * 0.5 && their < mine) return true;
    }
    return false;
  }


  // 候选落点到最近友军的距离：终点区域挑点时用它把人群摊开
  function getNearestEnemyGap(self, spot) {
    let nearest = Infinity;
    const list = S.enemiesGroup.getChildren();
    for (let i = 0; i < list.length; i++) {
      const other = list[i];
      if (other === self || !other.active || other.charging) continue;
      const gap = Phaser.Math.Distance.Between(spot.x, spot.y, other.x, other.y);
      if (gap < nearest) nearest = gap;
    }
    return nearest;
  }


  // 巡逻落点的通用实现：以指定锚点为圆心，在 [minRadius, maxRadius] 内随机取点。
  // 落点必须先站得住（可行走 + 与红区保持安全带），再要求整段路径不闯入红区，
  // 最后尽量挑不与其它单位重叠的位置；全都取不到时返回 null（原地待机），
  // 不会把单位推向边界或屏蔽区，也就不会出现撞墙后原地打转的反复移动。
  // spaced 为真时（终点待机）：区域已经挤满时不再随便塞一个点，而是取「离最近友军最远」
  // 的候选点，把人群往空处摊开，避免所有人叠在一处被隔离推挤推来推去
  function chooseEnemyRoamTargetAt(enemy, anchorX, anchorY, minRadius, maxRadius, spaced = false) {
    const origin = { x: enemy.x, y: enemy.y };
    let fallback = null;
    let spacedBest = null;
    let spacedBestGap = -1;
    for (let attempt = 0; attempt < 16; attempt++) {
      const angle = Phaser.Math.FloatBetween(0, Math.PI * 2);
      const distance = Phaser.Math.FloatBetween(minRadius, maxRadius);
      const candidate = {
        x: anchorX + Math.cos(angle) * distance,
        y: anchorY + Math.sin(angle) * distance
      };
      if (!isPointSafelyWalkable(candidate.x, candidate.y, ENEMY_RED_ZONE_CLEARANCE)) {
        continue;
      }
      if (!isRedZoneClearanceSafePath(origin, candidate)) continue;
      if (isRoamSpotClearOfEnemies(enemy, candidate)) return candidate;
      if (spaced) {
        const gap = getNearestEnemyGap(enemy, candidate);
        if (gap > spacedBestGap) {
          spacedBestGap = gap;
          spacedBest = candidate;
        }
      }
      if (!fallback) fallback = candidate;
    }
    return spaced && spacedBest ? spacedBest : fallback;
  }


  // 待机巡逻目标：在当前行动点的 ENEMY_PATROL_RADIUS 像素范围内随机取点，
  // 同时要求整段巡逻路径不闯入红区安全带，取不到时原地待机
  function chooseEnemyRoamTarget(enemy) {
    const anchorX = enemy.actionPointX == null ? enemy.x : enemy.actionPointX;
    const anchorY = enemy.actionPointY == null ? enemy.y : enemy.actionPointY;
    return chooseEnemyRoamTargetAt(enemy, anchorX, anchorY, ENEMY_PATROL_MIN_RADIUS, ENEMY_PATROL_RADIUS);
  }


  // 终点自由待机的落点：以路线终点为圆心、ENEMY_ENDPOINT_ROAM_RADIUS 为半径随机取点。
  // 已经被推挤或追踪带到待机区域之外时先走回终点，队伍才会重新聚在终点区域里
  function chooseEnemyEndpointRoamTarget(enemy) {
    const fromTerminal = Phaser.Math.Distance.Between(enemy.x, enemy.y, enemy.terminalX, enemy.terminalY);
    if (fromTerminal > ENEMY_ENDPOINT_ROAM_RADIUS) {
      return { x: enemy.terminalX, y: enemy.terminalY };
    }
    return chooseEnemyRoamTargetAt(
      enemy,
      enemy.terminalX,
      enemy.terminalY,
      ENEMY_PATROL_MIN_RADIUS,
      ENEMY_ENDPOINT_ROAM_RADIUS,
      true
    );
  }


  // 终点待机的静止阶段：到位后随机静止一小段时间（只站桩、不做任何移动计算）再挑下一个落点。
  // 大批单位不会每帧都在移动或转向，终点区域的开销与画面抖动都明显下降
  function beginEnemyEndpointIdle(enemy, time) {
    enemy.body.stop();
    enemy.roamTarget = null;
    enemy.routeState = 'endpoint';
    enemy.idleUntil = time + Phaser.Math.Between(ENEMY_ENDPOINT_IDLE_MIN, ENEMY_ENDPOINT_IDLE_MAX);
    setEnemyAnimation(enemy, 'wait', true);
  }


  // 抵达路线终点：转入「终点 375 像素范围内自由待机」，起步先静止一小段，
  // 避免整批同时到达的单位在同一帧一起开动
  function beginEnemyEndpointRoam(enemy, time) {
    enemy.routeFinished = true;
    enemy.holdCycles = 0;
    enemy.detourPath = [];
    enemy.replanTargetKey = null;
    enemy.replanAttemptedKey = null;
    const last = enemy.route && enemy.route.length ? enemy.route[enemy.route.length - 1] : null;
    enemy.terminalX = last ? last.x : enemy.x;
    enemy.terminalY = last ? last.y : enemy.y;
    enemy.actionPointX = enemy.terminalX;
    enemy.actionPointY = enemy.terminalY;
    beginEnemyEndpointIdle(enemy, time);
  }


  function getSafeRouteTarget(enemy) {
    for (let i = enemy.waypointIndex; i < enemy.route.length; i++) {
      const target = enemy.route[i];
      if (isRouteNodeWalkable(target)) return { target, index: i };
    }
    return null;
  }


  // 终点单位被隔离推挤或追踪带到待机区域之外（例如被挤到地图边缘的死角）时，
  // 把它交回常规路线推进逻辑：路线指针回退到离它最近的可走节点，
  // 沿「沿路线推进 + 红区绕行 + 卡顿兜底」走回终点。
  // 直接朝终点直线插过去会被红区挡住，而从不可行走的死角出发时转向判定会一直返回空，
  // 单位就会在终点待机状态里永久空转（既不移动也不推进，白白消耗每帧的几何计算）
  function resumeEnemyRouteToTerminal(enemy) {
    const route = enemy.route || [];
    let nearestIndex = -1;
    let nearestDistance = Infinity;
    for (let i = route.length - 1; i >= 0; i--) {
      const node = route[i];
      if (!isRouteNodeWalkable(node)) continue;
      const distance = Phaser.Math.Distance.Between(enemy.x, enemy.y, node.x, node.y);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestIndex = i;
      }
    }
    if (nearestIndex < 0) return false;
    enemy.waypointIndex = nearestIndex;
    enemy.routeState = 'following';
    // 还没真正走到终点，撤销「路线已完成」标记，回到正常的推进 / 行动点待机循环
    enemy.routeFinished = false;
    enemy.holdCycles = 0;
    enemy.roamTarget = null;
    enemy.detourPath = [];
    enemy.replanTargetKey = null;
    enemy.replanAttemptedKey = null;
    enemy.stuckAt = 0;
    return true;
  }


  // 终点单位是否已经被带到待机区域之外（留 4 倍隔离余量，避免边缘单位在回位与静止之间抖动）
  function isEnemyFarFromTerminal(enemy) {
    if (enemy.terminalX == null || enemy.terminalY == null) return false;
    return Phaser.Math.Distance.Between(enemy.x, enemy.y, enemy.terminalX, enemy.terminalY) >
      ENEMY_ENDPOINT_RETURN_DISTANCE;
  }


  // 从行动点出发前的随机判定：重新随机挑一条走廊变体（尽量与出发前不同），
  // 本次「前往下一个行动点」的落点连同后续节点一起换成新车道。
  // 各变体的节点数量与顺序严格一致，所以换路线不影响 waypointIndex 的含义。
  function rerollEnemyRoute(enemy) {
    const variants = enemy.routeData && enemy.routeData.variants;
    if (!variants || variants.length < 2) return;
    let index = enemy.routeVariantIndex == null ? 0 : enemy.routeVariantIndex;
    for (let attempt = 0; attempt < 8 && index === enemy.routeVariantIndex; attempt++) {
      index = Phaser.Math.Between(0, variants.length - 1);
    }
    enemy.routeVariantIndex = index;
    enemy.route = variants[index];
  }


  // 单次推挤落点校验：从「累计推挤方向」开始尝试，正推落点不可用就分别试两个单轴方向，
  // 让贴着墙或红区行走的单位也能沿切线滑开。落点必须既可行走、又满足红区安全带要求。
  // 位移积分不校验落点，单位可能已经贴出可行走边界（例如贴着地图边缘卡住），
  // 这种情况下放宽一档：只要求落点仍在地图内、不进入红区，保证隔离在任何情况下都能生效。
  // 每个单位每帧只调用一次（推挤量已在本帧全部重叠对中累计完毕）。
  function pushEnemyAway(enemy, offsetX, offsetY) {
    if (!enemy.body || !enemy.character) return false;
    const offMap = !pointInPolygon(enemy.x, enemy.y, collisionRegions.mapBoundary);
    const relaxed = offMap || !isEnemyPoseWalkable(enemy) || !isEnemyPoseClear(enemy);
    const attempts = [[offsetX, offsetY], [offsetX, 0], [0, offsetY]];
    for (let i = 0; i < attempts.length; i++) {
      const x = enemy.x + attempts[i][0];
      const y = enemy.y + attempts[i][1];
      if (x === enemy.x && y === enemy.y) continue;
      if (offMap) {
        // 入场阶段的单位在地图外：只要求落点仍在地图外，避免被推进地图边界的死角
        if (pointInPolygon(x, y, collisionRegions.mapBoundary)) continue;
      } else if (relaxed) {
        if (!pointInPolygon(x, y, collisionRegions.mapBoundary) || isZoneBlocked(x, y)) continue;
      } else if (!isPointSafelyWalkable(x, y, ENEMY_RED_ZONE_CLEARANCE)) {
        continue;
      }
      enemy.body.reset(x, y);
      enemy.character.setPosition(x, y);
      return true;
    }
    return false;
  }


  // 敌方单位之间的碰撞隔离：两个单位贴近到 ENEMY_SEPARATION_DISTANCE 以内时，
  // 各沿连心线推开一半重叠量（乘一个阻尼比例，避免推挤来回弹跳）。
  // 敌方单位的位移是逐帧直接积分（body.reset）的，Arcade 物理的碰撞体分离会被下一帧的
  // 位移覆盖，所以隔离在单位全部完成本帧移动之后单独做一遍。
  // 性能：① 用 ENEMY_SEPARATION_CELL 边长的空间哈希取 3×3 邻域，代替两两全比
  // （100 单位从 4950 对降到每单位 3~9 对）；② 先把所有重叠对的推挤量累加到单位上，
  // 累加完再按单位统一做一次落点几何校验（原实现是每对的两个单位各校验一次）。
  // 推挤量本身仍是「沿连心线各推开一半重叠量、单对不超过 MAX_PUSH」，行为与改造前一致。
  function separateEnemies() {
    const list = S.enemiesGroup.getChildren();
    const movers = [];
    for (let i = 0; i < list.length; i++) {
      const enemy = list[i];
      if (!enemy.active || !enemy.body || enemy.charging) continue;
      enemy.separationPushX = 0;
      enemy.separationPushY = 0;
      movers.push(enemy);
    }
    if (!movers.length) return;

    enemySeparationGrid.clear();
    for (let i = 0; i < movers.length; i++) {
      const enemy = movers[i];
      const cellKey = Math.floor(enemy.x / ENEMY_SEPARATION_CELL) + ':' +
        Math.floor(enemy.y / ENEMY_SEPARATION_CELL);
      const bucket = enemySeparationGrid.get(cellKey);
      if (bucket) bucket.push(i);
      else enemySeparationGrid.set(cellKey, [i]);
    }

    for (let i = 0; i < movers.length; i++) {
      const first = movers[i];
      const cellX = Math.floor(first.x / ENEMY_SEPARATION_CELL);
      const cellY = Math.floor(first.y / ENEMY_SEPARATION_CELL);
      for (let gridX = cellX - 1; gridX <= cellX + 1; gridX++) {
        for (let gridY = cellY - 1; gridY <= cellY + 1; gridY++) {
          const bucket = enemySeparationGrid.get(gridX + ':' + gridY);
          if (!bucket) continue;
          for (let k = 0; k < bucket.length; k++) {
            const j = bucket[k];
            if (j <= i) continue;                 // 同一对只处理一次（邻域查询会双向命中）
            const second = movers[j];
            let dx = second.x - first.x;
            let dy = second.y - first.y;
            const distanceSquared = dx * dx + dy * dy;
            if (distanceSquared >= ENEMY_SEPARATION_DISTANCE * ENEMY_SEPARATION_DISTANCE) continue;
            let distance = Math.sqrt(distanceSquared);
            if (distance < 0.0001) {
              dx = 1;
              dy = 0;
              distance = 1;
            }
            const push = Math.min(
              (ENEMY_SEPARATION_DISTANCE - distance) * 0.5 * ENEMY_SEPARATION_STRENGTH,
              ENEMY_SEPARATION_MAX_PUSH
            );
            const normalX = dx / distance;
            const normalY = dy / distance;
            first.separationPushX -= normalX * push;
            first.separationPushY -= normalY * push;
            second.separationPushX += normalX * push;
            second.separationPushY += normalY * push;
          }
        }
      }
    }

    for (let i = 0; i < movers.length; i++) {
      const enemy = movers[i];
      let pushX = enemy.separationPushX;
      let pushY = enemy.separationPushY;
      enemy.separationPushX = 0;
      enemy.separationPushY = 0;
      if (pushX === 0 && pushY === 0) continue;
      // 密集堆叠时一个单位会与多个邻居重叠，累计位移需要按 MAX_PUSH 收口：
      // 否则多对推挤量之和会让单位瞬移（该常量原本的语义就是「每帧每个单位」的上限）
      const length = Math.sqrt(pushX * pushX + pushY * pushY);
      if (length > ENEMY_SEPARATION_MAX_PUSH) {
        pushX = pushX / length * ENEMY_SEPARATION_MAX_PUSH;
        pushY = pushY / length * ENEMY_SEPARATION_MAX_PUSH;
      }
      pushEnemyAway(enemy, pushX, pushY);
    }
    // 队员的独立碰撞体同样参与隔离：敌方单位与队员碰撞体重叠时，敌方这一半在这一步推开
    //（队员那一半已在 updatePlayerSquad 里生效）。冲锋自爆中的队员不参与，必须能贴到目标引爆
    separateEnemiesFromPlayerMembers(movers);
  }


  // 敌方单位这一侧的推挤量：与队员碰撞体（半径圆）重叠时，敌方让出自己那一半
  function separateEnemiesFromPlayerMembers(movers) {
    const members = [];
    playerSquads.forEach(squad => {
      squad.members.forEach(member => {
        if (member.body && member.alive) members.push({ body: member.body, squad });
      });
    });
    if (!members.length) return;
    for (let i = 0; i < movers.length; i++) {
      const enemy = movers[i];
      let pushX = 0;
      let pushY = 0;
      for (let m = 0; m < members.length; m++) {
        const body = members[m].body;
        // 最小圆心距按该队员自己的碰撞体半径计算（TankM1 坦克 90 + 敌方 20.5 = 110.5；
        // 步兵 17 + 20.5 = 37.5），大型单位的独立碰撞体因此同样生效，
        // 敌方单位不会被允许站进坦克身体里
        const minDistance = body.radius + ENEMY_COLLISION_RADIUS;
        const minDistanceSquared = minDistance * minDistance;
        const dx = enemy.x - body.x;
        const dy = enemy.y - body.y;
        const distanceSquared = dx * dx + dy * dy;
        if (distanceSquared >= minDistanceSquared) continue;
        const distance = Math.sqrt(distanceSquared);
        let normalX;
        let normalY;
        if (distance < 0.0001) {
          normalX = -members[m].squad.forward.x;
          normalY = -members[m].squad.forward.y;
        } else {
          normalX = dx / distance;
          normalY = dy / distance;
        }
        const push = (minDistance - distance) * 0.5;
        pushX += normalX * push;
        pushY += normalY * push;
      }
      const length = Math.hypot(pushX, pushY);
      if (length <= 0.0001) continue;
      const scale = Math.min(length, PLAYER_MEMBER_SEPARATION_MAX_PUSH) / length;
      pushEnemyAway(enemy, pushX * scale, pushY * scale);
    }
  }


  // 单位自身站位的记忆化：坐标没变就复用上一次的结论（终点待机的人堆、被隔离推挤
  // 相互抵消位移的单位整帧不动），坐标一有变化立即重算，因此结论永远对应当前坐标
  function isEnemyPoseWalkable(enemy) {
    if (enemy.poseWalkableX !== enemy.x || enemy.poseWalkableY !== enemy.y) {
      enemy.poseWalkableX = enemy.x;
      enemy.poseWalkableY = enemy.y;
      enemy.poseWalkable = isWalkable(enemy.x, enemy.y);
    }
    return enemy.poseWalkable;
  }


  function isEnemyPoseClear(enemy) {
    if (enemy.poseClearX !== enemy.x || enemy.poseClearY !== enemy.y) {
      enemy.poseClearX = enemy.x;
      enemy.poseClearY = enemy.y;
      enemy.poseClear = isRedClearanceSafePoint(enemy.x, enemy.y, ENEMY_RED_ZONE_CLEARANCE);
    }
    return enemy.poseClear;
  }


  // 每名队员的独立碰撞体与敌方碰撞体的单位隔离：重叠时队员这一半直接推开本帧的阵型位置，
  // 另一半由同一帧稍后的 separateEnemies 推给敌方单位（双方各让一半，贴墙时不会把队员挤进红区）。
  // 冲锋自爆中的队员不参与：它必须能贴到敌方单位身边才引爆
  function separatePlayerMembersFromEnemies(squad, living, positions) {
    const enemies = S.enemiesGroup.getChildren();
    if (!enemies.length) return;
    living.forEach((member, index) => {
      if (!member.body) return;
      const point = positions[index];
      // 最小圆心距按该队员自己的碰撞体半径计算（TankM1 坦克 90 + 敌方 20.5 = 110.5；
      // 步兵 17 + 20.5 = 37.5），大型单位的独立碰撞体因此同样生效，
      // 敌方单位不会被允许站进坦克身体里
      const minDistance = member.body.radius + ENEMY_COLLISION_RADIUS;
      const minDistanceSquared = minDistance * minDistance;
      let pushX = 0;
      let pushY = 0;
      for (let i = 0; i < enemies.length; i++) {
        const enemy = enemies[i];
        if (!enemy.active || enemy.charging) continue;
        const dx = point.x - enemy.x;
        const dy = point.y - enemy.y;
        const distanceSquared = dx * dx + dy * dy;
        if (distanceSquared >= minDistanceSquared) continue;
        const distance = Math.sqrt(distanceSquared);
        let normalX;
        let normalY;
        if (distance < 0.0001) {
          // 完全重合：沿行进方向错开，避免除零后推向随机方向
          normalX = squad.forward.x;
          normalY = squad.forward.y;
        } else {
          normalX = dx / distance;
          normalY = dy / distance;
        }
        const push = (minDistance - distance) * 0.5;
        pushX += normalX * push;
        pushY += normalY * push;
      }
      const length = Math.hypot(pushX, pushY);
      if (length <= 0.0001) return;
      const scale = Math.min(length, PLAYER_MEMBER_SEPARATION_MAX_PUSH) / length;
      point.x += pushX * scale;
      point.y += pushY * scale;
    });
  }


  // GustafAssist2 的静态碰撞隔离：互动区扩大到超出记录碰撞半径时，碰撞区随之扩大
  // （GUSTAF_BODY_RADIUS = max(记录值, 互动区)）。我方队员的阵型/自由位置一旦进入
  // 「碰撞区 + 队员自身碰撞半径」内，就沿径向推回边界（限幅与敌方隔离同一档），
  // 保证队员永远停留在互动区之外——点击 Gustaf 与点击小队互不抢判定。
  // Gustaf 是固定建筑型单位只推不挪；冲锋自爆中的队员不参与（body 已交出）
  function separatePlayerMembersFromGustaf(squad, living, positions) {
    if (!S.gustafCharacter || !S.gustafCharacter.active) return;
    living.forEach((member, index) => {
      if (!member.body) return;
      const point = positions[index];
      const minDistance = GUSTAF_BODY_RADIUS + member.body.radius;
      const dx = point.x - GUSTAF_X;
      const dy = point.y - GUSTAF_Y;
      const distanceSquared = dx * dx + dy * dy;
      if (distanceSquared >= minDistance * minDistance) return;
      const distance = Math.sqrt(distanceSquared);
      let normalX;
      let normalY;
      if (distance < 0.0001) {
        // 完全重合：沿小队行进方向错开，避免除零后推向随机方向
        normalX = squad.forward.x;
        normalY = squad.forward.y;
      } else {
        normalX = dx / distance;
        normalY = dy / distance;
      }
      const push = Math.min(minDistance - distance, PLAYER_MEMBER_SEPARATION_MAX_PUSH);
      point.x += normalX * push;
      point.y += normalY * push;
    });
  }

export { takeEnemyReplanSlot, getEnemyNextRoutePoint, replanEnemyToNextPoint, steerEnemyTowards, getEnemyContourStep, enforceEnemyRedClearanceStep, advanceEnemyTowards, stepEnemyOutOfUnwalkable, isEnemySightClear, getEnemyTrackTargetPoint, getEnemyTrackGap, beginEnemyTrack, endEnemyTrack, updateEnemyTracking, decideEnemyActionPoint, isEnemyStuck, setEnemyAnimation, setEnemyFacing, syncEnemyFacing, destroyEnemy, applyEnemyKnockback, updateEnemyKnockback, beginEnemyDeath, updateEnemyDeath, spawnRouteWave, spawnHeavyReinforcement, spawnEnemyRouteUnit, beginEnemyHold, isRoamSpotClearOfEnemies, isRoutePointClaimed, getNearestEnemyGap, chooseEnemyRoamTargetAt, chooseEnemyRoamTarget, chooseEnemyEndpointRoamTarget, beginEnemyEndpointIdle, beginEnemyEndpointRoam, getSafeRouteTarget, resumeEnemyRouteToTerminal, isEnemyFarFromTerminal, rerollEnemyRoute, pushEnemyAway, separateEnemies, separateEnemiesFromPlayerMembers, isEnemyPoseWalkable, isEnemyPoseClear, separatePlayerMembersFromEnemies, separatePlayerMembersFromGustaf };
