// ============================================================
// wg_game 模块化拆分 —— player-member.js
// 职责: 我方队员：生成/索敌/归队/死亡冲锋/动画
// 来源: wg_game.js 语句区间 567-9323（自动拆分，勿手工重排语句顺序）
// ============================================================

import { S } from './S.js';
import { applyDeathTint, detonateUnit } from './combat.js';
import { setPlayerMemberAnimation } from './core.js';
import { isEnemyPoseWalkable, isEnemySightClear } from './enemy.js';
import { getShieldSteeringTarget, getShortestPlayerPath } from './pathfind.js';
import { createPlayerSquad, getPlayerSquadOrderOffset, handlePlayerSquadWipe, issuePlayerMoveOrder, removePlayerSquad, resetPlayerMoveProgress, setPlayerSquadVisible, updatePlayerSquad } from './player-squad.js';
import { getPlayerUnitRecord } from './records.js';
import { DEATH_CHARGE_ANIM_LOOP_MS, DEATH_CHARGE_PLAN_BUDGET_MS, DEATH_CHARGE_RETARGET_INTERVAL, DEATH_CHARGE_TRIGGER_DISTANCE, DEATH_TINT_DURATION, DEATH_TINT_STRENGTH, ENEMY_ATTACK_CONTACT_TOLERANCE, ENEMY_ATTACK_RELEASE_MARGIN, ENEMY_TRACK_RELEASE_MARGIN, PLAYER_ANIMATION_LOCK_GRACE, PLAYER_ANIMATION_MIX_ATTACK, PLAYER_ANIMATION_MIX_LOOP, PLAYER_ATTACK_ANIMATION_FALLBACK, PLAYER_CHARACTER_SCALE, PLAYER_DETONATE_DELAY, PLAYER_MEMBER_ANIM_IDLE_DELAY, PLAYER_MEMBER_BACK_PART_DEPTH, PLAYER_MEMBER_COLLISION_RADIUS, PLAYER_MEMBER_RETURN_PLANS_PER_FRAME, PLAYER_MEMBER_RETURN_REPLAN_COOLDOWN, PLAYER_MEMBER_RETURN_REPLAN_DISTANCE, PLAYER_MEMBER_RETURN_WAYPOINT_RADIUS, PLAYER_RED_ARRIVE_DISTANCE, PLAYER_RED_STEER_BIAS, PLAYER_RED_ZONE_CLEARANCE, PLAYER_SQUAD_LIMIT, RED_CLEARANCE_PATH_SLACK, SHADOW_ALPHA, SHADOW_OFFSET_Y, SPAWN_ANIMATION_DURATION, SPAWN_ANIMATION_MIN_SCALE, SPAWN_BADGE_ICON_SCALE, SPAWN_BADGE_RADIUS, SPAWN_GLOW_BASE_SCALE, SPAWN_POINT_X, SPAWN_POINT_Y, SPAWN_RALLY_OFFSET_X, SPAWN_RALLY_SPREAD, SPAWN_RING_COLOR, SPAWN_RING_RADIUS, deathChargePlanQueue, deathChargePlanStats, memberScanDistances, memberScanList, memberScanOrder, modulePerf, playerSquads, sightTestMemo } from './state.js';
import { applyFacingScale, createUnitShadow, forEachMemberPart, forEachPlayerCharacter, getMemberFacingScaleX, getMemberParts, isMemberFacingLeft, resolveUnitRenderParts } from './units-visual.js';
// WG2 全局修正：渲染缩放 -0.1 / 移速 ×0.9 / 出生集合点上移 100px（WG.html 恒为 0 / 1 / 0）
import { WG2_SPAWN_RALLY_LIFT, WG2_SPEED_FACTOR, WG2_PLAYER_SCALE_DELTA, WG2_PLAYER_BASE_SCALE_OVERRIDES } from './state.js';
import { correctPointIntoShieldClearance, isShieldClearanceSafePoint, isShieldClearanceSafeSegment } from './zones.js';


  function takeMemberReturnPlanSlot() {
    if (S.memberReturnPlanFrame !== S.redQueryFrame) {
      S.memberReturnPlanFrame = S.redQueryFrame;
      S.memberReturnPlanCount = 0;
    }
    if (S.memberReturnPlanCount >= PLAYER_MEMBER_RETURN_PLANS_PER_FRAME) return false;
    S.memberReturnPlanCount += 1;
    return true;
  }


  // 全部小队的存活队员：敌方索敌、自爆结算、隔离判定都以它为准
  function getAllLivingPlayerMembers() {
    const living = [];
    playerSquads.forEach(squad => {
      squad.members.forEach(member => {
        if (member.alive && member.character) living.push(member);
      });
    });
    return living;
  }


  // 单名队员是否可被该敌人看到：存活、有角色对象、且直线未被红色屏蔽区遮挡。
  // 视线判定走坐标键记忆化（isEnemySightClearCached），静止对峙时跨帧零重算
  function isPlayerMemberVisibleTo(enemy, member) {
    if (!member || !member.alive || !member.character) return false;
    return isEnemySightClearCached(enemy, member.character);
  }


  // 视线判定记忆化：键 = 敌方/队员双端坐标量化 1px 后打包的数字（2^53 内，无字符串分配）。
  // 红区几何版本（S.collisionRegionVersion，appendRedForbiddenZone 等会递增）变化时
  // 整表作废；容量超 16384 整体清空（行军中的敌人每帧产生新键，重建成本可忽略）。
  // 1px 量化对贴边 grazing 情形可能给出与精确几何差一帧的结果，游戏所有判定口径
  // 本身带有像素级容差，视觉与结算均无感知
  function getEnemySightMemoKey(enemy, target) {
    const ex = (Math.round(enemy.x) + 512) * 8192 + (Math.round(enemy.y) + 512);
    const tx = (Math.round(target.x) + 512) * 8192 + (Math.round(target.y) + 512);
    return ex * 33554432 + tx;
  }

  function isEnemySightClearCached(enemy, target) {
    if (S.sightTestMemoVersion !== S.collisionRegionVersion) {
      sightTestMemo.clear();
      S.sightTestMemoVersion = S.collisionRegionVersion;
    }
    const key = getEnemySightMemoKey(enemy, target);
    const cached = sightTestMemo.get(key);
    if (cached !== undefined) return cached;
    const clear = isEnemySightClear(enemy, target);
    if (sightTestMemo.size >= 16384) sightTestMemo.clear();
    sightTestMemo.set(key, clear);
    return clear;
  }


  // 选人扫描的距离门控：所有消费方（追踪激活/退出、交火圈、开火结算）的判定距离
  // 都不会超过这三个上界，取最大值后，门外的队员不可能影响任何结论——
  // 却能让远离战斗的敌人（行军/绕行中）一次视线判定都不做：
  //   ① 激活与退出迟滞带：trackRange + track_release_margin
  //   ② 交火圈（远程兵）：attackRange + 接触容差 + 释放迟滞
  //   ③ 交火圈（重甲补偿）：collisionRadius + 4 + 最重队员 body.radius(90, TankM1) + 释放迟滞
  function getEnemyTargetScanGate(enemy) {
    return Math.max(
      enemy.trackRange + ENEMY_TRACK_RELEASE_MARGIN,
      enemy.attackRange + ENEMY_ATTACK_CONTACT_TOLERANCE + ENEMY_ATTACK_RELEASE_MARGIN,
      enemy.collisionRadius + 4 + 96 + ENEMY_ATTACK_RELEASE_MARGIN
    );
  }


  // 进入追踪时锁定的队员：只在 beginEnemyTrack / endEnemyTrack 改写，
  // 追踪期间一直沿用，不再每帧重新比较三名队员的距离
  function getLockedPlayerMember(enemy) {
    if (!enemy.lockedTargetKey) return null;
    for (let s = 0; s < playerSquads.length; s++) {
      const members = playerSquads[s].members;
      for (let i = 0; i < members.length; i++) {
        const member = members[i];
        if (member.uid !== enemy.lockedTargetKey) continue;
        return member.alive && member.character ? member : null;
      }
    }
    return null;
  }

  function ensureMemberScanList() {
    if (S.memberScanListFrame === S.redQueryFrame) return;
    S.memberScanListFrame = S.redQueryFrame;
    memberScanList.length = 0;
    let ordinal = 0;
    for (let s = 0; s < playerSquads.length; s++) {
      const members = playerSquads[s].members;
      for (let i = 0; i < members.length; i++) {
        const member = members[i];
        member.scanOrdinal = ordinal++;
        if (!member.alive || !member.character) continue;
        memberScanList.push(member);
      }
    }
  }


  // 计时埋点：所有「最近可见队员」扫描（追踪选人/换目标/伤害结算重选）统一归入
  // modulePerf.sub.targetingMs，把敌方战斗段的选人成本从总账里拆出来归因。
  // maxRange 为距离门控（undefined = 不设门控）：门控半径必须 ≥ 消费方全部判定距离
  // 上界（见 getEnemyTargetScanGate），门外的队员按 Infinity 排除——凡消费方判定
  // 可能选中的队员必然在门内，选人结论与不设门控严格一致
  function findNearestVisiblePlayerMember(enemy, maxRange) {
    const startedAt = performance.now();
    const member = findNearestVisiblePlayerMemberScan(enemy, maxRange);
    modulePerf.sub.targetingMs += performance.now() - startedAt;
    return member;
  }


  function findNearestVisiblePlayerMemberScan(enemy, maxRange) {
    const locked = getLockedPlayerMember(enemy);
    if (isPlayerMemberVisibleTo(enemy, locked)) return locked;
    // 视线判定要跑一次红区相交测试，比距离计算贵得多（每帧每名敌人要检查全部存活队员）。
    // 改成「由近到远」逐个检查视线，视线畅通就立即返回，被挡住才继续看下一名；
    // 排序键为（距离, 出现顺序），与「按小队/队员数组顺序整体扫一遍、取最近的可见者」
    // 的结果严格一致。
    // 性能：旧实现在多名队员同时被屏蔽区挡住时（正是交火贴墙的场景），每次「找下一名
    // -> 试视线」都要整表重扫，最坏 O(M²) 距离计算 × O(M) 次视线判定；这里改为每帧
    // 一次性构建存活队员清单（全场共享），单次调用只做 O(M) 距离计算 + O(M log M) 排序，
    // 视线判定次数不变，距离计算量从 O(M²) 降到 O(M)。
    // 距离门控：门外队员按 Infinity 排除（与帧内阵亡队员同一条通道），远离战斗的敌人
    // 门内候选人通常为 0——排序近乎空转、视线判定零次，这正是「大量敌军在场 + 我方
    // 队员在敌方面前」时每帧性能损耗的主要来源
    ensureMemberScanList();
    const list = memberScanList;
    const count = list.length;
    if (!count) return null;
    const enemyX = enemy.x;
    const enemyY = enemy.y;
    const gate = maxRange === undefined ? Infinity : maxRange;
    let candidates = 0;
    for (let i = 0; i < count; i++) {
      const member = list[i];
      // 帧内阵亡的队员：不参与距离排序（与旧实现在扫描时跳过等价），由清单顺序占位
      memberScanDistances[i] = member.alive && member.character
        ? Phaser.Math.Distance.Between(enemyX, enemyY, member.character.x, member.character.y)
        : Infinity;
      if (memberScanDistances[i] > gate) memberScanDistances[i] = Infinity;
      else candidates++;
      memberScanOrder[i] = i;
    }
    if (!candidates) return null;
    memberScanOrder.length = count;
    memberScanOrder.sort((a, b) => {
      const byDistance = memberScanDistances[a] - memberScanDistances[b];
      if (byDistance !== 0) return byDistance;
      return list[a].scanOrdinal - list[b].scanOrdinal;
    });
    for (let i = 0; i < candidates; i++) {
      const member = list[memberScanOrder[i]];
      if (isPlayerMemberVisibleTo(enemy, member)) return member;
    }
    return null;
  }


  // 血条耗尽即触发死亡攻击：不再等待泛红完成，立刻进入移动动画并开始索敌，
  // 以 488 像素/秒冲向「移动逻辑规范内」最近的敌方单位。
  // 最长 5 秒必定自爆；期间一旦成功索敌并贴上目标（距离 ≤ 75 像素）就立即自爆、跳过剩余延迟
  function beginPlayerMemberDeath(member) {
    if (!member.alive) return;
    member.alive = false;
    // 冲锋自爆中的队员交出独立碰撞体：单位隔离不再把它算作需要保持距离的单位，
    // 否则它会被敌方单位一路顶开、贴不到 75 像素的引爆距离
    member.body = null;
    member.charging = {
      startedAt: null,
      x: member.character.x,
      y: member.character.y,
      target: null,
      path: [],
      nextRetargetAt: 0,
      // 起始朝向沿用阵型里的朝向（按素材朝向换算后才是真正的朝向），冲锋第一帧不会突然扭头
      facingLeft: member.character ? isMemberFacingLeft(member) : true
    };
    // 触发死亡攻击的瞬间就切进移动动画，泛红的 900ms 与冲锋并行，不再原地等待；
    // 记录已下发的姿态，冲锋期间不再重复下发（重复下发会让移动动画帧被重置）
    // （多部件单位的每个部件各有一条轨道，逐个下发）
    member.charging.animation = 'move';
    forEachMemberPart(member, part => part.setAnimation(0, 'move', true));
    // 队长阵亡后不再让该小队的共享动画状态机引用已销毁的骨架
    if (member.isLeader && member.squad) member.squad.character = null;
  }


  // 死亡攻击的索敌：只在「移动逻辑规范」内取最近的可达敌方单位。
  // 可达性直接复用点击移动用的最短安全曲线路径（不穿越红色屏蔽区、不侵入 38 像素安全带），
  // 因此够不到的目标（例如隔着一整片屏蔽区）不会被锁定，冲锋路线也不会越过屏蔽区
  function acquireDeathChargeTarget(charge) {
    const start = { x: charge.x, y: charge.y };
    // 算量优先级优化（P1 我方自爆）：先按距离升序排好候选，再逐个做完整可达性验证，
    // 命中第一个可攻击目标立即返回。与旧实现（按组顺序乱序扫描、每个比当前最优更近的
    // 候选都要跑一次完整寻路）的选人结论严格一致——都是「距离最近且可达」的那一个，
    // 距离并列时按稳定排序沿用组内先后顺序；但完整寻路次数从「最坏 N 次」降到「通常 1~2 次」。
    // 单次寻路（红区轮廓 -> 盾轮廓 -> A*）最坏可达数十毫秒，这是自爆算量的最大单点
    const candidates = [];
    const enemyList = S.enemiesGroup.getChildren();
    for (let i = 0; i < enemyList.length; i++) {
      const enemy = enemyList[i];
      if (!enemy.active || enemy.charging) continue;
      candidates.push({
        enemy,
        distance: Phaser.Math.Distance.Between(start.x, start.y, enemy.x, enemy.y)
      });
    }
    candidates.sort((a, b) => a.distance - b.distance);
    for (let i = 0; i < candidates.length; i++) {
      const enemy = candidates[i].enemy;
      if (!isEnemyPoseWalkable(enemy)) continue;
      const path = getShortestPlayerPath(start, { x: enemy.x, y: enemy.y });
      if (!path || !path.length) continue;
      // 规划失败时 getShortestPlayerPath 只返回「脱离安全带」的那一步，端点必须贴近目标才作数
      const last = path[path.length - 1];
      if (Phaser.Math.Distance.Between(last.x, last.y, enemy.x, enemy.y) > 0.5) continue;
      return { target: enemy, path };
    }
    return null;
  }


  function enqueueDeathChargePlan(member, priority) {
    const charge = member.charging;
    if (!charge || charge.planQueued) return;
    charge.planQueued = true;
    deathChargePlanQueue.push({ member, priority });
  }


  function processDeathChargePlanQueue(time) {
    deathChargePlanStats.lastFramePlans = 0;
    deathChargePlanStats.lastFrameDeferred = 0;
    if (!deathChargePlanQueue.length) {
      deathChargePlanStats.queued = 0;
      return;
    }
    // 优先级分层：0（首发）先于 1（周期重规划）；稳定排序保持同层 FIFO
    if (deathChargePlanQueue.length > 1) {
      deathChargePlanQueue.sort((a, b) => a.priority - b.priority);
    }
    const budgetEnd = performance.now() + DEATH_CHARGE_PLAN_BUDGET_MS;
    while (deathChargePlanQueue.length) {
      const request = deathChargePlanQueue.shift();
      const member = request.member;
      const charge = member.charging;
      // 等待期间队员可能已经自爆落地（charging 置空）：过期请求直接丢弃
      if (!charge) continue;
      charge.planQueued = false;
      // 预算检查放在出队之后：每帧至少执行一个请求，避免极端单帧下队列饿死；
      // 单次规划超过预算时由下一帧继续消化剩余队列
      if (deathChargePlanStats.lastFramePlans > 0 && performance.now() >= budgetEnd) {
        deathChargePlanQueue.unshift(request);
        charge.planQueued = true;
        break;
      }
      // 与旧同步路径完全相同的索敌与结果应用（updatePlayerMemberCharge 里只余入队）
      const targetAlive = charge.target && charge.target.active;
      // 【细分埋点】单个冲锋请求内的索敌 + 逐候选寻路：预算只在请求之间检查，
      // 请求内部可能连续多次全量寻路，是 nav 段尖峰的另一嫌疑
      const dcStartedAt = performance.now();
      const acquired = acquireDeathChargeTarget(charge);
      modulePerf.sub.dcMs += performance.now() - dcStartedAt;
      modulePerf.sub.dcPlans += 1;
      charge.nextRetargetAt = time + DEATH_CHARGE_RETARGET_INTERVAL;
      if (acquired) {
        charge.target = acquired.target;
        charge.path = acquired.path;
      } else if (!targetAlive) {
        charge.target = null;
        charge.path = [];
      }
      deathChargePlanStats.lastFramePlans += 1;
    }
    deathChargePlanStats.queued = deathChargePlanQueue.length;
    deathChargePlanStats.lastFrameDeferred = deathChargePlanStats.queued;
  }


  function updatePlayerMemberCharge(member, time, delta) {
    const charge = member.charging;
    const character = member.character;
    if (!charge || !character) return;
    // 引爆计时与主循环共用同一个时间源，染色与冲锋全程按真实时间线性推进
    if (charge.startedAt === null) charge.startedAt = time;
    const elapsed = time - charge.startedAt;
    const tintProgress = Phaser.Math.Clamp(elapsed / DEATH_TINT_DURATION, 0, 1);
    // 多部件单位的每个部件各自有一套槽位颜色，泛红要逐个部件下发
    forEachMemberPart(member, part => applyDeathTint(part, tintProgress * DEATH_TINT_STRENGTH));
    if (member.shadow) {
      member.shadow.setPosition(charge.x, charge.y + SHADOW_OFFSET_Y);
      member.shadow.setAlpha(SHADOW_ALPHA * (1 - 0.35 * tintProgress));
    }
    // 索敌：目标阵亡、目标不在场、或者到了重新索敌间隔就再算一次，
    // 保证「最近的敌人」随着战场变化始终成立。
    // 完整寻路不再同步执行（最坏数十毫秒会炸穿帧预算）：入队交给
    // processDeathChargePlanQueue 按优先级 + 帧预算调度，等待期间沿用现有目标与路径
    const targetAlive = charge.target && charge.target.active;
    if (!targetAlive || time >= charge.nextRetargetAt) {
      enqueueDeathChargePlan(member, targetAlive ? 1 : 0);
    }
    // 冲锋：沿与点击移动同一条最短安全曲线以 488 像素/秒推进，全程保留移动动画
    const chargeRecord = getPlayerUnitRecord(member.squad ? member.squad.unitKey : 'jf');
    let reached = false;
    if (charge.target) {
      const path = charge.path;
      while (path.length > 1 &&
             Phaser.Math.Distance.Between(charge.x, charge.y, path[0].x, path[0].y) < PLAYER_RED_ARRIVE_DISTANCE) {
        path.shift();
      }
      const waypoint = path.length ? path[0] : { x: charge.target.x, y: charge.target.y };
      // 冲锋速度按该队员所属兵种记录的 charge_speed（ELMO2 为 260，其余 244）；WG2 乘 0.9 与缩放同步
      const budget = chargeRecord.charge_speed * WG2_SPEED_FACTOR *
        Math.max(0, delta) / 1000;
      // 与点击移动用同一套净空标准（红区 + 绿屏蔽区）：冲锋过程同样不会切进屏蔽区
      const steered = getShieldSteeringTarget({ x: charge.x, y: charge.y }, waypoint, budget);
      if (steered) {
        // 曲线行走时朝向上取「本帧实际落点」而不是路径点，避免贴红区绕行时朝向乱甩
        if (Math.abs(steered.x - charge.x) > 0.01) charge.facingLeft = steered.x < charge.x;
        charge.x = steered.x;
        charge.y = steered.y;
      }
      // 触发距离按该队员所属兵种记录读取（TankM1 为 90 = 自爆半径，贴到目标边缘引爆，
      // 保证目标一定在自爆圆内；JF 等步兵按各自记录），缺省回退到全局基线
      const chargeTriggerDistance = chargeRecord.charge_trigger_distance || DEATH_CHARGE_TRIGGER_DISTANCE;
      reached = Phaser.Math.Distance.Between(charge.x, charge.y, charge.target.x, charge.target.y)
        <= chargeTriggerDistance;
    }
    applyFacingScale(character, getMemberFacingScaleX(member, charge.facingLeft), member.visualScale);
    // 冲锋姿态（只在变化时下发一次，重复下发会把动画帧重置）：
    // 默认全程保留移动动画；登记了死亡冲锋动画的兵种（Ares 的 skill3）在冲锋满
    // death_charge_animation_delay 毫秒后切过去，直到贴上敌人自爆消失为止。
    // Ares 的 delay = 0：一进入自爆状态就直接从头播 skill3（第一秒起）直到爆炸
    const chargeAnimation = chargeRecord.death_charge_animation &&
      elapsed >= (chargeRecord.death_charge_animation_delay || 0)
      ? chargeRecord.death_charge_animation
      : 'move';
    if (charge.animation !== chargeAnimation) {
      charge.animation = chargeAnimation;
      // chargeAnimStartedAt 记录本段冲锋动画的起始时刻，供下方按周期重播计时
      charge.chargeAnimStartedAt = time;
      forEachMemberPart(member, part => part.setAnimation(0, chargeAnimation, chargeAnimation === 'move'));
    } else if (chargeAnimation !== 'move' &&
        time - (charge.chargeAnimStartedAt || time) >= DEATH_CHARGE_ANIM_LOOP_MS) {
      // 冲锋动画每满 1 秒从头重播一次（反复调用前 1 秒的起手动作）：
      // skill3 非循环播放，播完会停在尾帧，与「冲锋全程保持起手姿态」的表现要求不符。
      // 重播只对当前处于冲锋动画的队员生效（未登记冲锋动画的兵种停在 'move' 永不进入本分支），
      // 每队员每秒最多一次 setAnimation、无逐帧轮询与额外分配，不影响帧预算
      charge.chargeAnimStartedAt = time;
      forEachMemberPart(member, part => part.setAnimation(0, chargeAnimation, false));
    }
    character.setPosition(charge.x, charge.y);
    // 提前自爆（贴上目标触发距离）跳过剩余延迟；死亡延迟到点同样自爆。
    // 半径与伤害按该队员所属兵种的记录（JF 50 圆 / TankM1 90 圆），伤害在结算时按爆心距离递减
    if (reached && elapsed < PLAYER_DETONATE_DELAY) {
      detonateUnit(member.squad.unit.scene, charge.x, charge.y, 'player', chargeRecord.detonate_radius, chargeRecord);
      finishPlayerMemberCharge(member);
    } else if (elapsed >= PLAYER_DETONATE_DELAY) {
      detonateUnit(member.squad.unit.scene, charge.x, charge.y, 'player', chargeRecord.detonate_radius, chargeRecord);
      finishPlayerMemberCharge(member);
    }
  }


  // 队员自爆后移除：自爆动画一开始我方单位就消失——不做淡出残影，直接销毁骨骼与阴影，
  // 画面里从此只剩下覆盖整个爆炸区域的自爆特效
  function finishPlayerMemberCharge(member) {
    if (member.shadow) {
      member.shadow.destroy();
      member.shadow = null;
    }
    const parts = getMemberParts(member);
    member.character = null;
    member.extraParts = [];
    member.charging = null;
    // 主体与附加渲染层一起销毁（多部件单位）
    parts.forEach(part => {
      part.setVisible(false);
      part.destroy();
    });
    const squad = member.squad;
    if (squad) {
      const index = squad.members.indexOf(member);
      if (index >= 0) squad.members.splice(index, 1);
      if (!squad.members.length) handlePlayerSquadWipe(squad);
    }
  }


  // 大桥坍塌专用（WG2 bridge.js 调用）：桥上队员立即死亡消失，不进入自爆冲锋。
  // 复用自爆收尾 finishPlayerMemberCharge 的全部清理（阴影/骨骼/多部件/小队移除/团灭退役），
  // 但不做任何爆炸结算——视觉由桥体连环爆炸覆盖；先落 alive/body 标记，
  // 敌方锁定与瞄准（依赖 body 存活性）同帧感知其死亡
  function killPlayerMemberInstantly(member) {
    if (!member || (!member.alive && !member.charging)) return;
    member.alive = false;
    member.body = null;
    if (member.isLeader && member.squad) member.squad.character = null;
    finishPlayerMemberCharge(member);
  }


  // 出生流程第一步：在出生点组建一支新小队并开始播放出生动画（动画期间还不能行动）。
  // unitKey 是出兵按钮键（jf / TankM1 / ...），用来标记小队的兵种（占位阶段共用步兵外观）
  function beginPlayerSpawn(unitKey) {
    const scene = S.gameScene;
    if (!scene) return;
    // 全灭的小队会在退役时从注册表移除，这里只清掉可能残留的空壳
    playerSquads.slice().forEach(squad => {
      if (!squad.members.length && !squad.spawnAnimation) removePlayerSquad(squad);
    });
    const squad = createPlayerSquad(scene, SPAWN_POINT_X, SPAWN_POINT_Y, unitKey);
    const unit = squad.unit;
    unit.body.reset(SPAWN_POINT_X, SPAWN_POINT_Y);
    unit.setPosition(SPAWN_POINT_X, SPAWN_POINT_Y);
    unit.isMoving = false;
    unit.isSelected = false;
    squad.moveTarget = null;
    squad.detourPath = [];
    squad.replanKey = null;
    resetPlayerMoveProgress(squad);
    squad.freeBlend = 0;
    squad.morphProgress = 0;
    squad.squeezed = false;
    squad.freeActive = false;
    squad.slotSwapped = true;
    squad.forward.x = 0;
    squad.forward.y = -1;
    updatePlayerSquad(squad);
    // 出生动画：体型由小到大、透明度由 0 到 1，队员依次淡入
    squad.members.forEach(member => {
      member.character.setScale(member.visualScale * SPAWN_ANIMATION_MIN_SCALE);
      member.character.setAlpha(0);
      if (member.shadow) member.shadow.setAlpha(0);
    });
    squad.spawnAnimation = { startedAt: scene.time.now };
    S.spawnFlashAnimation = squad.spawnAnimation;
    S.spawnFlashGraphics.clear();
    S.spawnFlashGraphics.setVisible(true);
    S.spawnBadge.setScale(SPAWN_BADGE_ICON_SCALE);
  }


  // 是否还有小队正在播放出生动画（决定 update 里走出生分支还是待机呼吸分支）
  function hasActivePlayerSpawnAnimation() {
    return playerSquads.some(squad => squad.spawnAnimation) || S.spawnFlashAnimation !== null;
  }


  // 出生动画逐帧更新：体型与透明度插值 + 落地光环向外扩散（多支小队可同时出生，光环取最近一次）
  function updatePlayerSpawnAnimation(time) {
    playerSquads.slice().forEach(squad => {
      const animation = squad.spawnAnimation;
      if (!animation) return;
      const progress = Phaser.Math.Clamp((time - animation.startedAt) / SPAWN_ANIMATION_DURATION, 0, 1);
      const appear = Phaser.Math.Easing.Cubic.Out(progress);
      squad.members.forEach(member => {
        const scale = member.visualScale * (SPAWN_ANIMATION_MIN_SCALE + (1 - SPAWN_ANIMATION_MIN_SCALE) * appear);
        // 保留 setPlayerFacing 的朝向（scaleX 为负表示朝左）
        member.character.setScale(member.character.scaleX < 0 ? -scale : scale, scale);
        member.character.setAlpha(appear);
        // 脚下阴影跟随出生动画一起淡入
        if (member.shadow) member.shadow.setAlpha(SHADOW_ALPHA * appear);
      });
      if (progress >= 1) finishPlayerSpawn(squad, time);
    });

    // 共享的扩散光环只由最近一次出生驱动，避免多支小队同时出兵时反复抢同一张 graphics
    if (!S.spawnFlashAnimation) {
      S.spawnFlashGraphics.clear();
      S.spawnFlashGraphics.setVisible(false);
      return;
    }
    const progress = Phaser.Math.Clamp(
      (time - S.spawnFlashAnimation.startedAt) / SPAWN_ANIMATION_DURATION,
      0,
      1
    );
    const flash = Phaser.Math.Clamp(progress / 0.8, 0, 1);
    const easedFlash = Phaser.Math.Easing.Cubic.Out(flash);
    const radius = SPAWN_BADGE_RADIUS * 0.35 + (SPAWN_RING_RADIUS - SPAWN_BADGE_RADIUS * 0.35) * easedFlash;
    S.spawnFlashGraphics.clear();
    S.spawnFlashGraphics.lineStyle(1 + 3 * (1 - flash), SPAWN_RING_COLOR, 0.95 * (1 - flash));
    S.spawnFlashGraphics.strokeCircle(SPAWN_POINT_X, SPAWN_POINT_Y, radius);
    S.spawnFlashGraphics.lineStyle(1 + 2 * (1 - flash), 0xffffff, 0.55 * (1 - flash));
    S.spawnFlashGraphics.strokeCircle(SPAWN_POINT_X, SPAWN_POINT_Y, radius * 0.6);
    S.spawnGlow.setScale(SPAWN_GLOW_BASE_SCALE * (0.6 + 1.15 * Phaser.Math.Easing.Cubic.Out(progress)));
    S.spawnGlow.setAlpha(0.3 + 0.55 * (1 - flash));
    if (progress >= 1) {
      S.spawnFlashAnimation = null;
      S.spawnFlashGraphics.clear();
      S.spawnFlashGraphics.setVisible(false);
      S.spawnGlow.setScale(SPAWN_GLOW_BASE_SCALE).setAlpha(0.22);
    }
  }


  // 出生动画结束：恢复体型，这一支小队正式进场，并自动执行第一个移动指令
  function finishPlayerSpawn(squad, time) {
    const scene = S.gameScene;
    squad.spawnAnimation = null;
    squad.members.forEach(member => {
      const facing = member.character.scaleX < 0 ? -1 : 1;
      applyFacingScale(member.character, facing * member.visualScale, member.visualScale);
      member.character.setAlpha(1);
      if (member.shadow) member.shadow.setAlpha(SHADOW_ALPHA);
    });
    squad.unit.isSpawned = true;
    // 开局召唤（SF / Agent）：出生动画播完先不召唤——本体先走移动动画去待机位置
    // （出生后的自动集合点），到位后才触发召唤动画（见移动到达分支的 pendingSummon）
    const unitRecord = getPlayerUnitRecord(squad.unitKey);
    if ((unitRecord.summon_clone_count || 0) > 0 && squad.members.length === 1) {
      squad.pendingSummon = {
        delay: unitRecord.summon_clone_delay || 0,
        count: unitRecord.summon_clone_count,
        animation: unitRecord.summon_animation_name || 'skill2'
      };
    }
    // 出生后不自动接管控制：交给玩家自己点选，这里只让它自动走位到集合点。
    // 玩家在出生动画期间已经下达过移动指令时不覆盖（那条指令会在动画结束后直接执行）
    squad.unit.isSelected = false;
    setPlayerSquadVisible(squad, true);
    // 出生后自动前往集合点（按小队序号错开落点，连续出多支小队时不会挤在同一处）。
    // WG2：集合点改为出生点右上方 100px（45° 对角：x+≈71 / y-≈71，实际位移 100px），
    // 保留小队序号散布；WG.html 维持原「出生点右侧 150px」行为
    if (!squad.moveTarget) {
      const offset = getPlayerSquadOrderOffset(squad.id % PLAYER_SQUAD_LIMIT, PLAYER_SQUAD_LIMIT);
      const diag = WG2_SPAWN_RALLY_LIFT * 0.7071;
      issuePlayerMoveOrder(
        squad,
        scene,
        WG2_SPAWN_RALLY_LIFT
          ? SPAWN_POINT_X + diag + offset.x * SPAWN_RALLY_SPREAD
          : SPAWN_POINT_X + SPAWN_RALLY_OFFSET_X + offset.x * SPAWN_RALLY_SPREAD,
        SPAWN_POINT_Y - diag + offset.y * SPAWN_RALLY_SPREAD
      );
    }
  }


  // 生成一名队员（主体 + 附加层 + 阴影 + 独立碰撞体）：createPlayerSquad 与
  // SF 的开局召唤共用（分身数值与机制完全继承本体，只是各自独立一套骨架实例与碰撞体）
  function createPlayerMember(scene, squad, entry, x, y, uidSuffix) {
    const unitRecord = getPlayerUnitRecord(squad.unitKey);
    // WG2 专用覆盖（state.js）：个别兵种（Agent 骨架原生尺寸偏大）按实测标定的基础缩放
    // 替代 unit_db 的 character_scale，使渲染大小与步兵一致；WG.html 该表为 null，行为不变
    const baseScale = (WG2_PLAYER_BASE_SCALE_OVERRIDES && WG2_PLAYER_BASE_SCALE_OVERRIDES[entry.key])
      || unitRecord.character_scale
      || PLAYER_CHARACTER_SCALE;
    const visualScale = baseScale + WG2_PLAYER_SCALE_DELTA;
    // 该队员的渲染部件（后 -> 前）：最后一项是主体，其余作为附加层压在主体之下
    // （Warjack 登记 render_parts = 'Warjack_1009_Part2, Warjack_1009_Part1'，
    //  Part2 显示在后方、Part1 显示在前方）
    const partKeys = resolveUnitRenderParts(unitRecord, entry.key);
    const parts = partKeys.map((partKey, index) => {
      const part = scene.add.spine(x, y, partKey, 'wait', true);
      part.setScale(visualScale);
      part.setDepth(index === partKeys.length - 1 ? 2 : PLAYER_MEMBER_BACK_PART_DEPTH);
      return part;
    });
    const character = parts[parts.length - 1];
    return {
      key: entry.key,
      uid: entry.key + '#' + squad.id + uidSuffix,
      squad,
      slot: entry.slot,
      isLeader: entry.isLeader === true,
      character,
      // 附加渲染层（多部件单位）：逐帧跟随主体的位置 / 朝向 / 缩放，动画与染色与主体同步
      extraParts: parts.slice(0, -1),
      // 该队员的渲染缩放（按兵种记录；朝向翻转 / 出生动画 / 冲锋都读它）
      visualScale,
      // 每名队员都是独立单位：各自持有血条、攻击力与防御力（生命值取该兵种记录）
      hp: unitRecord.max_hp,
      maxHp: unitRecord.max_hp,
      // 上次受击时间：用于判定「5 秒未被攻击」后开始回血（-Infinity 表示从未受伤）
      lastDamagedAt: -Infinity,
      alive: true,
      charging: null,
      // 贴红区自由移动时的独立位置：脱离队列期间由各自的目标点驱动
      freeX: x,
      freeY: y,
      // 每名队员各自的独立碰撞体：用于红区净空、可行走与单位隔离判定，位置跟随实际渲染位置。
      // 半径按兵种记录（TankM1 单兵 90，步兵 17）：按实际渲染像素标定，
      // 与坦克 226×106 的显示尺寸一致，单位隔离与敌方停火距离都按它结算
      body: { x, y, radius: unitRecord.member_collision_radius || PLAYER_MEMBER_COLLISION_RADIUS },
      // 实际渲染位置：逐帧朝阵型算出的目标位置限速缓动，修正量较大时也不会跳变
      renderX: x,
      renderY: y,
      // 掉队自动归队：returning 为真时按 returnPath 逐帧寻路走回自己的站位，
      // 由 animOverride 标记自己单独播着的动画，returnFacingLeft 记录自己的朝向。
      // returnReplanIn 是重新规划冷却（毫秒，逐帧用 delta 递减）：贴边转向失败时
      // 不冷却就会逐帧全量寻路，这里限流后改由上层沿红区轮廓滑动把人带出去；
      // renderIdleMs 累计「本帧没有位移」的时长，用于卡住时把走路循环换成待机，避免原地踏步
      returning: false,
      returnPath: [],
      returnGoal: null,
      returnReplanIn: 0,
      renderIdleMs: 0,
      animOverride: null,
      returnFacingLeft: false,
      shadow: createUnitShadow(scene, character)
    };
  }


  // 存活队员数量：我方齐射伤害与「全灭后重新出兵」都以它为准
  function getLivingPlayerMembers(squad) {
    return squad.members.filter(member => member.alive && member.character && member.character.active !== false);
  }


  // 队员能否直接沿直线走回自己的站位：直线不侵入屏蔽区净空带、且整条直线都在可行走区域内才算安全。
  // 净空判定用 slack = 0，和运行时「绝不贴进净空带以内」的要求保持一致。
  // clearance 允许调用方收紧要求（归位判定用更宽的通道形成迟滞死区）
  function isPlayerMemberDirectRouteSafe(originX, originY, target, clearance = PLAYER_RED_ZONE_CLEARANCE) {
    if (!isShieldClearanceSafePoint(target.x, target.y)) return false;
    return isShieldClearanceSafeSegment(
      { x: originX, y: originY },
      target,
      clearance,
      true,
      0
    );
  }


  // 复位队员的归队状态：清空路径与目标，同时解除重新规划冷却，
  // 下次进入归队状态时能立刻规划一次（各处「退出归队 / 重新进入归队」都走这里，避免漏字段）
  function resetPlayerMemberReturn(member) {
    member.returnPath = [];
    member.returnGoal = null;
    member.returnReplanIn = 0;
  }


  // 掉队队员的自动寻路归队：规划用的是队伍同一套寻路逻辑（红区净空 + 可行走 + 沿红区等距轮廓
  // 绕行的曲线路径），前进用的是同一套逐帧转向函数，因此归队途中同样不取直线、不卡进屏蔽区，
  // 贴到红区时与队伍一样沿轮廓滑动。返回 null 表示本帧无法前进（目标暂时不可达），由上层退回避让
  function stepPlayerMemberReturn(member, target, budget, step) {
    const originX = member.renderX === undefined ? target.x : member.renderX;
    const originY = member.renderY === undefined ? target.y : member.renderY;
    const origin = { x: originX, y: originY };
    // 重新规划冷却：逐帧递减，只有冷却结束才允许再次全量寻路。
    // 队员被安全带夹住时，「转向失败 -> 清空路径 -> 下一帧再规划」会变成逐帧寻路，
    // 冷却期间本函数直接返回 null，由上层改为沿红区轮廓滑动 / 沿安全直线靠近
    member.returnReplanIn = Math.max(0, (member.returnReplanIn || 0) - (step || 0));
    // 「站位移到了需要换路径」的判定：还没规划过、或阵型站位移动超过阈值（站位随队伍前进一直在动）。
    // 逐帧寻路既浪费性能，也会让队员在拐点附近来回摇摆；真需要换路径时也优先走下面的「只挪末端点」
    const goalMoved = !member.returnGoal ||
      Phaser.Math.Distance.Between(member.returnGoal.x, member.returnGoal.y, target.x, target.y) >
      PLAYER_MEMBER_RETURN_REPLAN_DISTANCE;
    // 站位只挪动了一点：只要最后一段换成新站位后仍然净空，就沿用已经规划好的绕行曲线，
    // 只把末点挪过去。队员的站位随队伍前进一直在动，若每次都重跑整段规划，
    // 贴边归队时就成了每秒数十次全量寻路（首次 A* 展开要判定全部轮廓节点），
    // 这是移动卡顿最大的一处来源
    const tailFrom = member.returnPath.length > 1
      ? member.returnPath[member.returnPath.length - 2]
      : origin;
    if (goalMoved && member.returnPath.length &&
      isShieldClearanceSafePoint(target.x, target.y) &&
      isShieldClearanceSafeSegment(tailFrom, target, PLAYER_RED_ZONE_CLEARANCE, true)) {
      member.returnPath[member.returnPath.length - 1] = { x: target.x, y: target.y };
      member.returnGoal = { x: target.x, y: target.y };
    } else if ((goalMoved || !member.returnPath.length) && member.returnReplanIn <= 0 &&
      takeMemberReturnPlanSlot()) {
      // 【细分埋点】归队全量寻路是 playerNav 段的主要尖峰嫌疑：单独计量
      const memberPlanStartedAt = performance.now();
      const path = getShortestPlayerPath(origin, target);
      modulePerf.sub.memberPlanMs += performance.now() - memberPlanStartedAt;
      modulePerf.sub.memberPlans += 1;
      if (!path || !path.length) {
        // 规划失败（起点本身落在安全带里、站位暂时不可达等）：同样限流，
        // 否则每一帧都会重试一次全量寻路
        member.returnReplanIn = PLAYER_MEMBER_RETURN_REPLAN_COOLDOWN;
        return null;
      }
      member.returnPath = path;
      member.returnGoal = { x: target.x, y: target.y };
    }
    if (!member.returnPath.length) return null;
    // 已经经过的路径点直接丢弃，避免在旧拐点上原地停一帧
    while (member.returnPath.length > 1 &&
      Phaser.Math.Distance.Between(origin.x, origin.y, member.returnPath[0].x, member.returnPath[0].y) <=
      PLAYER_MEMBER_RETURN_WAYPOINT_RADIUS) {
      member.returnPath.shift();
    }
    const waypoint = member.returnPath[0];
    const steered = getShieldSteeringTarget(origin, waypoint, budget);
    if (!steered) {
      // 朝向被净空带挡住：丢掉当前路径并进入冷却，交给上层沿屏蔽区轮廓滑动带出去
      resetPlayerMemberReturn(member);
      member.returnReplanIn = PLAYER_MEMBER_RETURN_REPLAN_COOLDOWN;
      return null;
    }
    if (member.returnPath.length > 1 &&
      Phaser.Math.Distance.Between(origin.x, origin.y, waypoint.x, waypoint.y) <=
      PLAYER_MEMBER_RETURN_WAYPOINT_RADIUS) {
      member.returnPath.shift();
    }
    // 落点净空：轮廓折线的弦长误差会让转向落点比净空带略微贴里一点，
    // 所以先按「推到净空带之外」修正（修正后是足额净空），修正结果再过一次
    // 与转向函数一致的线段判定，避免推离方向把落点甩到屏蔽区另一侧。
    // 这里不能只用严格判定否决落点：一旦否决，上层会退回直行，队员就会穿进屏蔽区
    const landing = isShieldClearanceSafePoint(steered.x, steered.y)
      ? steered
      : correctPointIntoShieldClearance(steered, PLAYER_RED_ZONE_CLEARANCE + PLAYER_RED_STEER_BIAS);
    if (isShieldClearanceSafePoint(landing.x, landing.y) &&
      isShieldClearanceSafeSegment(origin, landing, PLAYER_RED_ZONE_CLEARANCE, false, RED_CLEARANCE_PATH_SLACK)) {
      return landing;
    }
    // 连半步都推不出安全落点：本帧不动，并让旧路径失效（同样限流），
    // 避免留下一条永远转不动的路径把队员钉在原地
    const half = correctPointIntoShieldClearance(
      { x: (origin.x + steered.x) / 2, y: (origin.y + steered.y) / 2 },
      PLAYER_RED_ZONE_CLEARANCE + PLAYER_RED_STEER_BIAS
    );
    resetPlayerMemberReturn(member);
    member.returnReplanIn = PLAYER_MEMBER_RETURN_REPLAN_COOLDOWN;
    return isShieldClearanceSafePoint(half.x, half.y) ? half : null;
  }


  // ----------------------------------------------------
  // 我方单位行动动画流程（状态 -> 动画）
  // 目标动画只由移动状态推导，且同名动画只下发一次：Spine 的 setAnimation 会
  // 重建 TrackEntry 并把 trackTime 归零，逐帧重复下发同一条动画会让角色
  // 永远停在第一帧。一次性动画（攻击）播放期间加锁，锁结束后自动接回
  // move / wait，因此绕行红区的整个过程动画不会被移动逻辑打断。
  // 小队三名角色共用同一份动画状态，动作始终同步。
  // ----------------------------------------------------
  function getPlayerAnimationDurationMs(squad, name) {
    // 锁定时间取三名角色中最长的一条，保证全员播完再切回循环动画
    let duration = 0;
    forEachPlayerCharacter(squad, character => {
      const animation = character && character.findAnimation
        ? character.findAnimation(name)
        : null;
      const current = animation && animation.duration > 0 ? animation.duration * 1000 : 0;
      if (current > duration) duration = current;
    });
    return duration > 0 ? duration : PLAYER_ATTACK_ANIMATION_FALLBACK;
  }


  // 循环动画（move / wait）：状态未变化时不下发，避免打断正在播放的动画
  function setPlayerAnimation(squad, name) {
    if (!squad.members.length) return;
    if (squad.animLockName && performance.now() < squad.animLockUntil) return;
    squad.animLockName = null;
    if (squad.animName === name) return;
    squad.animName = name;
    squad.members.forEach(member => {
      // 正在归队/归位的队员自己走自己的：动画交给 applyPlayerMemberReturnVisuals 单独维护，
      // 这里既不下发也不清除它的标记，避免把它的走路循环重置到第一帧
      if (member.returning || member.regrouping) return;
      if (member.alive === false) return;
      member.animOverride = null;
      forEachMemberPart(member, part => part.setAnimation(0, name, true));
    });
  }


  // 一次性动画（攻击）：允许重新触发，并在播放期间加锁，防止被 move / wait 截断。
  // 动画名按兵种记录（TankM1 的攻击动作是 skill1、Warjack 的近战是 attack_SP，其余默认 attack）。
  // 同一条动画还在播时不再重复下发：动作时长可能长于攻击间隔（Warjack 的 attack_SP 2 秒
  // 而攻击间隔只有 0.2 秒），重复下发会把 trackTime 反复归零、看起来定格在首帧
  function playPlayerAttackAnimation(squad, name) {
    if (!squad.members.length) return;
    const attackName = name || squad.attackAnimation || 'attack';
    if (squad.animLockName === attackName && performance.now() < squad.animLockUntil) return;
    squad.animName = attackName;
    squad.animLockName = attackName;
    squad.animLockUntil = performance.now() + getPlayerAnimationDurationMs(squad, attackName) +
      PLAYER_ANIMATION_LOCK_GRACE;
    // 攻击接管全队动画（归队队员也要开火）：标记归队队员的独立动画已失效，
    // 锁结束后由 applyPlayerMemberReturnVisuals 重新下发移动动画
    squad.members.forEach(member => {
      if (member.returning) member.animOverride = attackName;
    });
    forEachPlayerCharacter(squad, character => character.setAnimation(0, attackName, false));
  }


  // 小队动画交叉淡化配置：攻击与移动/待机互相淡入淡出，
  // 状态切换时姿势平滑过渡，不会出现硬切造成的跳帧感。
  // 美术资源缺少某条动画时 setMix 会抛错，忽略该条即可，其余交叉淡化仍然生效
  function configurePlayerAnimationMixing(squad) {
    const attackNames = [squad.attackAnimation || 'attack'];
    // 近战动画（Warjack 的 attack_SP）与移动/待机之间同样要交叉淡化
    if (squad.meleeAnimation && attackNames.indexOf(squad.meleeAnimation) < 0) {
      attackNames.push(squad.meleeAnimation);
    }
    const mixes = [];
    attackNames.forEach(attackName => {
      mixes.push(
        [attackName, 'move', PLAYER_ANIMATION_MIX_ATTACK],
        [attackName, 'wait', PLAYER_ANIMATION_MIX_ATTACK],
        ['move', attackName, PLAYER_ANIMATION_MIX_ATTACK],
        ['wait', attackName, PLAYER_ANIMATION_MIX_ATTACK]
      );
    });
    mixes.push(
      ['move', 'wait', PLAYER_ANIMATION_MIX_LOOP],
      ['wait', 'move', PLAYER_ANIMATION_MIX_LOOP]
    );
    forEachPlayerCharacter(squad, character => {
      if (!character || typeof character.setMix !== 'function') return;
      mixes.forEach(pair => {
        try {
          character.setMix(pair[0], pair[1], pair[2]);
        } catch (error) {
          // 该角色没有这对动画，跳过
        }
      });
    });
  }


  // 攻击中下达移动指令：立即解除一次性动画锁。
  // 锁不清除的话 move 动画要等攻击播完才切得过去，点击后会有明显延迟
  function interruptPlayerAttackAnimation(squad) {
    squad.animLockName = null;
    squad.animLockUntil = 0;
  }


  // 同步单条动画的播放速率：差异很小时不写回，避免逐帧赋值与由此产生的抖动
  function applyPlayerMemberAnimationSpeed(member, scale) {
    const previous = member.animSpeed === undefined ? 1 : member.animSpeed;
    if (Math.abs(previous - scale) < 0.02) return;
    member.animSpeed = scale;
    // 多部件单位的每个部件各有一条同名轨道，播放速率要逐部件写回
    forEachMemberPart(member, part => {
      const track = part.state ? part.state.getCurrent(0) : null;
      if (track) track.timeScale = scale;
    });
  }


  function applyPlayerMemberReturnVisuals(squad) {
    if (!squad.members.length) return;
    if (squad.animLockName && performance.now() < squad.animLockUntil) return;
    const name = squad.unit.isMoving ? 'move' : 'wait';
    squad.members.forEach(member => {
      if (member.alive === false || !member.character || member.character.active === false) return;
      if (member.returning || member.regrouping) {
        // 归队/归位中的队员自己走自己的：播 move 并朝自己的前进方向转身，
        // 播放速率对齐自己的实际移动速度（队伍行军时也不会打滑或原地踏步）。
        // 被安全带夹住而这一帧真的没有位移时改播待机，动画与实际移动始终一致
        const moving = member.renderIdleMs < PLAYER_MEMBER_ANIM_IDLE_DELAY;
        let scale = 1;
        if (moving && !member.returning) scale = member.regroupSpeedRatio || 1;
        setPlayerMemberAnimation(member, moving ? 'move' : 'wait', scale);
        applyFacingScale(member.character, getMemberFacingScaleX(member, member.returnFacingLeft), member.visualScale);
        return;
      }
      // 归队结束：交回全队动画（同名跳过，反复进出归队状态不会来回重置走路循环）
      setPlayerMemberAnimation(member, name);
    });
  }


  // 每帧根据移动状态同步动画，保证动画与移动状态一致
  function refreshPlayerAnimation(squad) {
    setPlayerAnimation(squad, squad.unit.isMoving ? 'move' : 'wait');
    applyPlayerMemberReturnVisuals(squad);
  }


  function setPlayerFacing(squad, isLeft) {
    if (!squad.members.length) {
      // 无队员的空壳小队：按 JF 缩放兜底（正常情况下不会走到）
      forEachPlayerCharacter(squad, character => character.setScale(
        isLeft ? -PLAYER_CHARACTER_SCALE : PLAYER_CHARACTER_SCALE,
        PLAYER_CHARACTER_SCALE
      ));
      return;
    }
    // 归队/归位中的队员朝向自己的前进方向，由 applyPlayerMemberReturnVisuals 单独下发。
    // 这里跳过它们，否则帧末的攻击等一次性朝向会把它们的朝向改回全队朝向
    squad.members.forEach(member => {
      if (member.alive === false || !member.character || member.character.active === false) return;
      if (member.returning || member.regrouping) return;
      const facingScale = getMemberFacingScaleX(member, isLeft);
      applyFacingScale(member.character, facingScale, member.visualScale);
    });
  }

export { takeMemberReturnPlanSlot, getAllLivingPlayerMembers, isPlayerMemberVisibleTo, getEnemyTargetScanGate, getLockedPlayerMember, ensureMemberScanList, findNearestVisiblePlayerMember, beginPlayerMemberDeath, acquireDeathChargeTarget, enqueueDeathChargePlan, processDeathChargePlanQueue, updatePlayerMemberCharge, finishPlayerMemberCharge, killPlayerMemberInstantly, beginPlayerSpawn, hasActivePlayerSpawnAnimation, updatePlayerSpawnAnimation, finishPlayerSpawn, createPlayerMember, getLivingPlayerMembers, isPlayerMemberDirectRouteSafe, resetPlayerMemberReturn, stepPlayerMemberReturn, getPlayerAnimationDurationMs, setPlayerAnimation, playPlayerAttackAnimation, configurePlayerAnimationMixing, interruptPlayerAttackAnimation, applyPlayerMemberAnimationSpeed, applyPlayerMemberReturnVisuals, refreshPlayerAnimation, setPlayerFacing };
