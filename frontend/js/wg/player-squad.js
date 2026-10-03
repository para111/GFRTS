// ============================================================
// wg_game 模块化拆分 —— player-squad.js
// 职责: 我方小队：编队/命令/阵型/推挤/整体更新
// 来源: wg_game.js 语句区间 919-8934（自动拆分，勿手工重排语句顺序）
// ============================================================

import { S } from './S.js';
import { applyDeathTint, showCombatText } from './combat.js';
import { processPlayerPathQueue } from './core.js';
import { separatePlayerMembersFromEnemies, separatePlayerMembersFromGustaf } from './enemy.js';
import { smoothStep01 } from './geometry.js';
import { getShieldEdgeDestination, getShieldSteeringTarget, getShortestPlayerPath, getSteeringTargetWithin, recordRedPlan, slideAlongRedContour, slideAlongShieldRing } from './pathfind.js';
import { beginPlayerMemberDeath, configurePlayerAnimationMixing, createPlayerMember, getAllLivingPlayerMembers, getLivingPlayerMembers, interruptPlayerAttackAnimation, isPlayerMemberDirectRouteSafe, resetPlayerMemberReturn, setPlayerAnimation, setPlayerFacing, stepPlayerMemberReturn } from './player-member.js';
import { getPlayerUnitRecord } from './records.js';
import { PLAYER_CHARACTER_SCALE, PLAYER_CROSS_SQUAD_LERP, PLAYER_CROSS_SQUAD_MAX_SHIFT, PLAYER_CROSS_SQUAD_SEPARATION, PLAYER_MEMBER_ANIM_IDLE_DELAY, PLAYER_MEMBER_ANIM_MAX_STEP, PLAYER_MEMBER_ANIM_MOVE_EPSILON, PLAYER_MEMBER_COLLISION_RADIUS, PLAYER_MEMBER_RETURN_DISTANCE, PLAYER_MEMBER_RETURN_EXIT_CLEARANCE, PLAYER_MEMBER_RETURN_EXIT_RATIO, PLAYER_MEMBER_RETURN_SPEED, PLAYER_MEMBER_VISUAL_RADIUS, PLAYER_MOVE_PROGRESS_EPSILON, PLAYER_MOVE_STALL_RETRIES, PLAYER_MOVE_STALL_TIMEOUT, PLAYER_RED_REPLAN_COOLDOWN, PLAYER_RED_ZONE_CLEARANCE, PLAYER_SELL_REFUND_RATIO, PLAYER_SQUAD_BUILD_TIME, PLAYER_SQUAD_COLUMN_SLOT_ORDER, PLAYER_SQUAD_EDGE_EXIT_RANGE, PLAYER_SQUAD_EDGE_RANGE, PLAYER_SQUAD_FORMATION_LERP, PLAYER_SQUAD_FORMATION_SIDE, PLAYER_SQUAD_FREE_MAX_DISTANCE, PLAYER_SQUAD_FREE_OFFSETS, PLAYER_SQUAD_FREE_RETURN_RATIO, PLAYER_SQUAD_MORPH_DURATION, PLAYER_SQUAD_ORDER_SEARCH_DIRECTIONS, PLAYER_SQUAD_ORDER_SEARCH_RINGS, PLAYER_SQUAD_ORDER_SPREAD, PLAYER_SQUAD_REGROUP_ARRIVE, PLAYER_SQUAD_REGROUP_CATCHUP_DISTANCE, PLAYER_SQUAD_REGROUP_STALL_FRAMES, PLAYER_SQUAD_REGROUP_STALL_RATIO, PLAYER_SQUAD_ROW_FREE_OFFSETS, PLAYER_SQUAD_ROW_SLOT_OFFSETS, PLAYER_SQUAD_SEPARATION, PLAYER_SQUAD_SEPARATION_BUFFER, PLAYER_SQUAD_SEPARATION_PASSES, PLAYER_SQUAD_SEPARATION_TARGET, PLAYER_SQUAD_SLOT_OFFSETS, PLAYER_SQUAD_SLOT_ORDER, PLAYER_SQUAD_SLOT_SWAP_BLEND, RED_CLEARANCE_TOLERANCE, RED_CONTOUR_MARGIN, SHADOW_ALPHA, SHADOW_OFFSET_Y, SPAWN_ANIMATION_MIN_SCALE, SPAWN_BUTTON_RECRUIT_COST, UNIT_SPEED, modulePerf, playerPathQueue, playerSquads, trainingSquads } from './state.js';
import { applyFacingScale, forEachMemberPart, isMemberFacingLeft } from './units-visual.js';
// WG2 全局修正：渲染缩放 -0.1（WG.html 恒为 0，见 state.js）
import { WG2_PLAYER_SCALE_DELTA } from './state.js';
import { correctPointIntoShieldClearance, correctPointIntoWalkable, correctPointOutOfRedClearance, isPointAtShieldEdge, isRedClearanceSafePoint, isRedClearanceSafeSegment, isShieldClearanceSafePoint, isWalkable } from './zones.js';


  function createSquadState(x, y) {
    return {
      id: ++S.squadSerial,
      unit: null,
      character: null,
      members: [],
      forward: { x: 0, y: -1 },
      freeBlend: 0,
      morphProgress: 0,
      squeezed: false,
      freeActive: false,
      slotAssignment: {},
      slotSwapped: true,
      moveTarget: null,
      detourPath: [],
      replanKey: null,
      replanAt: 0,
      // 出售面板（黄色圆环 + 六边形「$」按钮）是否展开：双击单位才呼出
      sellPanelOpen: false,
      // 跨小队挤压的持久阵型偏移：多支小队汇聚/擦肩时整队平移避让，向 0 平滑收敛，
      // 避免不同小队的队员互相压进（与队内隔离 separatePlayerSquadPairs 互补）
      crowdX: 0,
      crowdY: 0,
      // 进度看门狗：途经点进度（nodes / distance）与「到终点的最近距离记录」两个通道，
      // 贴边绕行时途经点可能长时间不推进，靠 closestDistance 区分「真的卡住」与「绕远路中」
      moveProgress: {
        nodes: Infinity,
        distance: Infinity,
        closestDistance: Infinity,
        stalledSince: 0,
        retries: 0
      },
      animName: null,
      animLockName: null,
      animLockUntil: 0,
      spawnAnimation: null,
      spawnX: x,
      spawnY: y
    };
  }


  function hasSpawnedPlayerSquad() {
    return playerSquads.some(squad => squad.unit && squad.unit.isSpawned);
  }


  function getSpawnedPlayerSquads() {
    return playerSquads.filter(squad => squad.unit && squad.unit.isSpawned);
  }


  // 多小队同点移动时的落点散布半径：随小队数量自适应增大。落点按正 N 边形分布时，
  // 相邻两支小队的锚点间距 = 2·r·sin(π/N)。要保证两支小队的三角阵型（单边
  // formation_side 像素）在落点上不互相压进、不同小队的队员间距不低于跨队最小间距，
  // 相邻锚点间距至少要有 formation_side + PLAYER_CROSS_SQUAD_SEPARATION：
  //   r = (formation_side + cross) / (2·sin(π/N))
  // 小队越多 N 越大 r 越大（N=2 时两队分居圆环两端，r 取所需间距的一半）。
  // 下限保留 PLAYER_SQUAD_ORDER_SPREAD，避免两三支小队也把落点铺得过大。
  // 少了这一步，多队点到同一处时各队阵型会互相压进、队员叠在一起
  function getPlayerSquadOrderSpread(total) {
    if (total <= 1) return 0;
    const minAnchorGap = PLAYER_SQUAD_FORMATION_SIDE + PLAYER_CROSS_SQUAD_SEPARATION;
    const needed = minAnchorGap / (2 * Math.sin(Math.PI / total));
    return Math.max(PLAYER_SQUAD_ORDER_SPREAD, needed);
  }


  // 多小队同点移动时的落点散布：n 支小队在终点周围的正 n 边形顶点上各占一个落点，
  // 第一支从正上方开始排，顺序稳定（不会因为选中顺序抖动而互相换位）。
  // 圆环半径取 getPlayerSquadOrderSpread：随小队数放大到阵型互不压入，
  // 全部小队因此都落在点击点周围的一小圈内，而不是散在点外
  function getPlayerSquadOrderOffset(index, total) {
    if (total <= 1) return { x: 0, y: 0 };
    const spread = getPlayerSquadOrderSpread(total);
    const angle = -Math.PI / 2 + (Math.PI * 2 * index) / total;
    return { x: Math.cos(angle) * spread, y: Math.sin(angle) * spread };
  }


  // 多小队同点移动的最终落点分配：先按圆环给每支小队分一个落点，
  // 落点若压在红色屏蔽区、屏蔽区安全带或可行动区之外，就从理想落点向外做「最小挪动」搜索：
  // 一圈一圈加大挪动距离，每圈按 PLAYER_SQUAD_ORDER_SEARCH_DIRECTIONS 的顺序换方向；
  // 每个候选还要与已定落点保持 squad_order_spread 的间距，站不下就继续换。
  // 少了这一步，各队终点的红区吸附会独立生效，把相邻两个落点挤到同一块地面上，
  // 多支小队叠在一起（队员互相压住），而被挤进不可行动区的落点根本走不到，
  // 看起来像只有一支队伍抵达
  function resolvePlayerSquadOrderGoals(centerX, centerY, total) {
    if (total <= 1) return [{ x: centerX, y: centerY }];
    const spread = getPlayerSquadOrderSpread(total);
    // 落点必须同时离开红区与绿屏蔽区：小队指令的终点也走「盾」口径
    const safe = (x, y) => isShieldClearanceSafePoint(x, y, PLAYER_RED_ZONE_CLEARANCE);
    // 正 N 边形理想落点的相邻间距恰好等于 spread，浮点误差会让它差出亚像素而误判为「过近」，
    // 把本来站得下的理想落点整批挪走、落点间距被压小。这里留 1 像素容差：间距低于
    // spread - 1 才算真正过近，理想落点只有在真实被挡时才进入挪动搜索
    const spaced = (x, y, placed) => placed.every(goal => Math.hypot(goal.x - x, goal.y - y) >= spread - 1);
    const goals = [];
    for (let index = 0; index < total; index++) {
      const offset = getPlayerSquadOrderOffset(index, total);
      const idealX = centerX + offset.x;
      const idealY = centerY + offset.y;
      let chosen = null;
      let fallback = null;
      if (safe(idealX, idealY) && spaced(idealX, idealY, goals)) {
        chosen = { x: idealX, y: idealY };
      } else {
        const heading = Math.atan2(offset.y, offset.x);
        for (let ring = 1; ring <= PLAYER_SQUAD_ORDER_SEARCH_RINGS && !chosen; ring++) {
          const distance = ring * spread * 0.5;
          for (let i = 0; i < PLAYER_SQUAD_ORDER_SEARCH_DIRECTIONS.length && !chosen; i++) {
            const angle = heading + (PLAYER_SQUAD_ORDER_SEARCH_DIRECTIONS[i] * Math.PI) / 180;
            const x = idealX + Math.cos(angle) * distance;
            const y = idealY + Math.sin(angle) * distance;
            if (!safe(x, y)) continue;
            // 先记住「第一个站得住脚」的位置：整圈都排不下时至少不会退回不可行动区
            if (!fallback) fallback = { x, y };
            if (spaced(x, y, goals)) chosen = { x, y };
          }
        }
      }
      goals.push(chosen || fallback || { x: idealX, y: idealY });
    }
    return goals;
  }


  // 红区转向：既有行为（敌军与本阶段尚未切换的我方调用点仍在用）
  function getPlayerSteeringTarget(origin, waypoint, budget, clearance = PLAYER_RED_ZONE_CLEARANCE) {
    return getSteeringTargetWithin(
      origin, waypoint, budget, clearance,
      isRedClearanceSafePoint, correctPointOutOfRedClearance, isRedClearanceSafeSegment, slideAlongRedContour
    );
  }


  // 小队全灭：清空该小队的出战状态并让它退役（销毁锚点、腾出出兵名额）。
  // 步兵小队阵亡后进入训练冷却：需要 PLAYER_SQUAD_BUILD_TIME 才能训练完成补充回队列，
  // 期间出兵按钮显示逆时针填充的训练进度（见 updateSpawnHud）
  function handlePlayerSquadWipe(squad) {
    if (!squad.unit || !squad.unit.isSpawned) return;
    const scene = squad.unit.scene;
    squad.unit.isSpawned = false;
    squad.unit.isSelected = false;
    squad.unit.isMoving = false;
    squad.unit.body.stop();
    squad.moveTarget = null;
    squad.detourPath = [];
    squad.replanKey = null;
    resetPlayerMoveProgress(squad);
    // 单位级训练：只把这一支阵亡的小队压入训练队列，不影响其他存活单位，
    // 也不让整个兵种按钮进入训练态；训练条目带上兵种键，供各兵种按钮分别计数与显示进度
    trainingSquads.push({ readyAt: scene.time.now + PLAYER_SQUAD_BUILD_TIME, unitKey: squad.unitKey || 'jf' });
    removePlayerSquad(squad);
  }


  // 小队整体外沿半径：以锚点为中心，取所有存活队员到锚点的最大距离，
  // 再加上队员自身的视觉半径，得到「整个单位」的外沿（出售圆环按它外扩 5 像素）
  function getPlayerSquadOuterRadius(squad) {
    let maxDistance = 0;
    // 队员实际视觉半径：读 Spine 显示宽度的一半（TankM1 坦克显示 226×106，半径约 113；
    // 步兵 50×50，半径 25），再与固定下限取大。出售圆环按「锚点距 + 视觉半径」取外沿，
    // 大型单位的圆环因此能完整包围坦克而不压在车身上
    let maxVisualRadius = PLAYER_MEMBER_VISUAL_RADIUS;
    getLivingPlayerMembers(squad).forEach(member => {
      const distance = Math.hypot(
        member.character.x - squad.unit.x,
        member.character.y - squad.unit.y
      );
      if (distance > maxDistance) maxDistance = distance;
      const displayWidth = member.character && member.character.displayWidth
        ? Math.abs(member.character.displayWidth)
        : 0;
      if (displayWidth / 2 > maxVisualRadius) maxVisualRadius = displayWidth / 2;
    });
    return maxDistance + maxVisualRadius;
  }


  // 出售一支我方小队：把招募点数返还到总点数，并让该小队立刻进入自爆流程。
  // 自爆走的是与「血条耗尽」完全相同的既有链路：每名队员立刻进入
  // 「索敌最近敌方 → 冲锋 → 自爆」流程（beginPlayerMemberDeath），
  // 因此动画、特效、伤害判定与震屏都与血条为 0 时一致。
  // 队员全部自爆落地后，小队由 finishPlayerMemberCharge 自动退役并进入单位训练队列
  function sellPlayerSquad(squad) {
    if (!squad || !squad.unit || !squad.unit.isSpawned) return false;
    // 按该小队实际兵种返还招募点数
    S.playerPoints += Math.floor((SPAWN_BUTTON_RECRUIT_COST[squad.unitKey || 'jf'] || 0) *
      PLAYER_SELL_REFUND_RATIO);   // 主动出售只返还招募点数的 80%（向下取整）
    squad.sellPanelOpen = false;
    squad.unit.isSelected = false;
    squad.unit.isMoving = false;
    squad.unit.body.stop();
    squad.moveTarget = null;
    squad.detourPath = [];
    squad.replanKey = null;
    resetPlayerMoveProgress(squad);
    getLivingPlayerMembers(squad).forEach(member => {
      beginPlayerMemberDeath(member);
    });
    return true;
  }


  // 我方队员自然回血：距上次受击满该兵种记录的 regen_delay 后，
  // 每秒恢复最大生命值的 regen_per_second 比例（各兵种不同），
  // 回满即停止（血条随之隐藏）；期间再次受击会由 damagePlayerMember 重新计时。
  // 阵亡冲锋中的队员不参与回血
  function updatePlayerSquadRegen(time, delta) {
    getAllLivingPlayerMembers().forEach(member => {
      const record = getPlayerUnitRecord(member.squad ? member.squad.unitKey : 'jf');
      if (member.hp >= member.maxHp) return;
      if (time - member.lastDamagedAt < record.regen_delay) return;
      member.hp = Math.min(member.maxHp, member.hp + member.maxHp * record.regen_per_second * delta / 1000);
    });
  }


  // 场上已有（含出生动画中的）小队数量，用于全局上限与进度显示。
  // 已全灭退役的小队会从注册表移除，不占名额
  function spawnedSquadCount() {
    return playerSquads.filter(squad => squad.unit).length;
  }


  // 某兵种当前占用的名额：已出场 + 训练中（阵亡进入训练冷却的单位在训练完成前仍占名额）
  function countPlayerSquadsOf(unitKey) {
    return playerSquads.filter(squad => squad.unit && squad.unitKey === unitKey).length +
      trainingSquads.filter(entry => entry.unitKey === unitKey).length;
  }


  // 某个第二层分类（grf1 / tasa_air / rs）当前占用的名额：
  // 只累加该分类自己下属的第三层出兵按钮，分类按钮本身不占名额。
  // 死亡退役进入训练冷却的单位不再占用分类名额（分类上限只数场上存活单位），
  // 兵种按钮自己的上限仍按「存活 + 训练中」计算（见 countPlayerSquadsOf）
  function countPlayerSquadsInCategory(category) {
    if (!category) return 0;
    let count = 0;
    S.spawnHudButtons.forEach(button => {
      if (button.isCategory || button.category !== category) return;
      count += playerSquads.filter(squad => squad.unit && squad.unitKey === button.key).length;
    });
    return count;
  }


  // 重置移动进度看门狗：下达新指令、到达终点或结束移动时都要复位
  function resetPlayerMoveProgress(squad, now) {
    // 状态必须是对象：一旦被外部覆盖成数字，下面这些赋值会被静默丢弃，
    // stalledSince 变成 undefined 会让停滞判定恒为「未超时」，看门狗退化成每帧全量重规划
    if (!squad.moveProgress || typeof squad.moveProgress !== 'object') squad.moveProgress = {};
    squad.moveProgress.nodes = Infinity;
    squad.moveProgress.distance = Infinity;
    squad.moveProgress.closestDistance = Infinity;
    squad.moveProgress.stalledSince = Number.isFinite(now) ? now : 0;
    squad.moveProgress.retries = 0;
    // replanKey / replanAt 是成对的限流状态，必须一起清：
    // 只清 replanKey 时，上一段移动留下的冷却会拖到下一次移动指令上（最多挡住 260ms 的重规划）
    squad.replanAt = 0;
  }


  // 结束当前移动指令：曲线路径一并清空，队伍就地停下（不瞬移）。
  // 目标点标记不在这里清除：由每帧按「正在移动的小队数」统一同步显示
  function finishPlayerMoveOrder(squad) {
    squad.moveTarget = null;
    squad.detourPath = [];
    squad.replanKey = null;
    squad.replanAt = 0;
    squad.unit.isMoving = false;
    squad.unit.body.stop();
    resetPlayerMoveProgress(squad);
  }


  // 路径进度标记：剩余节点数 + 到当前节点的距离
  function getPlayerMoveProgressMark(squad) {
    const waypoint = squad.detourPath[0] || squad.moveTarget;
    return {
      nodes: squad.detourPath.length,
      distance: waypoint ? Math.hypot(waypoint.x - squad.unit.x, waypoint.y - squad.unit.y) : 0
    };
  }


  // 移动进度看门狗：返回 true 表示本次移动已按「无法再靠近终点」结束。
  // 终点落在安全带与地图边界夹出的死角里时，直线逼近会被净空判定挡下，
  // 队长会一直沿着红区边缘来回滑动而永远到不了终点；这里先重规划（最多
  // PLAYER_MOVE_STALL_RETRIES 次，每次重规划重新获得一个停滞判定窗口），
  // 连续多次仍然毫无进展就认为队伍已经站到离终点最近的可站位置，就地收队。
  // 「毫无进展」必须同时看两个通道：途经点进度，以及到终点的最近距离记录。
  // 只看途经点时，绕远路（沿屏蔽区走曲线）会被误判成卡住；只看终点距离时，
  // 沿轮廓原地来回滑动又会一直被刷新的途经点距离掩盖，所以两个通道都停摆才重规划
  function updatePlayerMoveProgress(squad, time) {
    const mark = getPlayerMoveProgressMark(squad);
    const toTarget = squad.moveTarget
      ? Math.hypot(squad.moveTarget.x - squad.unit.x, squad.moveTarget.y - squad.unit.y)
      : 0;
    const advanced = mark.nodes < squad.moveProgress.nodes ||
      mark.distance < squad.moveProgress.distance - PLAYER_MOVE_PROGRESS_EPSILON ||
      toTarget < squad.moveProgress.closestDistance - PLAYER_MOVE_PROGRESS_EPSILON;
    if (advanced) {
      squad.moveProgress.nodes = mark.nodes;
      squad.moveProgress.distance = mark.distance;
      if (toTarget < squad.moveProgress.closestDistance) squad.moveProgress.closestDistance = toTarget;
      squad.moveProgress.stalledSince = time;
      squad.moveProgress.retries = 0;
      return false;
    }
    // stalledSince 必须是有效时间戳：非有限值会让下式恒为 false，停滞判定彻底失效
    if (!Number.isFinite(squad.moveProgress.stalledSince)) squad.moveProgress.stalledSince = time;
    if (time - squad.moveProgress.stalledSince < PLAYER_MOVE_STALL_TIMEOUT) return false;
    if (squad.moveProgress.retries < PLAYER_MOVE_STALL_RETRIES) {
      squad.moveProgress.retries += 1;
      squad.moveProgress.stalledSince = time;
      const replanOrigin = { x: squad.unit.x, y: squad.unit.y };
      const replanStartedAt = performance.now();
      const replanned = getShortestPlayerPath(replanOrigin, squad.moveTarget);
      recordRedPlan(replanOrigin, squad.moveTarget, replanned, replanStartedAt);
      if (replanned && replanned.length) {
        squad.detourPath = replanned;
        squad.replanKey = null;
        squad.replanAt = time + PLAYER_RED_REPLAN_COOLDOWN;
        squad.moveProgress.nodes = replanned.length;
        squad.moveProgress.distance = Math.hypot(
          replanned[0].x - squad.unit.x,
          replanned[0].y - squad.unit.y
        );
        squad.moveProgress.closestDistance = Infinity;
      }
      return false;
    }
    finishPlayerMoveOrder(squad);
    return true;
  }


  function queuePlayerPathOrder(squad, destination) {
    for (let index = playerPathQueue.length - 1; index >= 0; index--) {
      if (playerPathQueue[index].squad === squad) playerPathQueue.splice(index, 1);
    }
    playerPathQueue.push({ squad, destination });
  }


  // 完成一条排队的规划：路径为空说明直线与轮廓绕行都走不通，按「无法绕行」收队
  function applyPlayerPathOrder(scene, squad, destination, time) {
    const planOrigin = { x: squad.unit.x, y: squad.unit.y };
    const planStartedAt = performance.now();
    const planned = getShortestPlayerPath(planOrigin, destination);
    recordRedPlan(planOrigin, destination, planned, planStartedAt);
    if (!planned || !planned.length) {
      showCombatText(scene, destination.x, destination.y, '红色屏蔽区无法安全绕行', '#ff6666');
      finishPlayerMoveOrder(squad);
      return;
    }
    squad.detourPath = planned;
    squad.replanKey = null;
    squad.replanAt = 0;
    resetPlayerMoveProgress(squad, time);
    squad.unit.isMoving = true;
    scene.physics.moveToObject(squad.unit, squad.detourPath[0], UNIT_SPEED);
  }


  // 下发一次移动指令：屏蔽区终点判定 -> 可通行校验 -> 红区安全带吸附 -> 沿红区轮廓的最短曲线路径规划
  // 右键移动与出生后自动前出共用这一套逻辑，动画由动画状态机统一下发不会被打断
  function issuePlayerMoveOrder(squad, scene, x, y) {
    let destination = new Phaser.Math.Vector2(x, y);
    if (!isWalkable(destination.x, destination.y)) {
      // 点到红色屏蔽区或绿色隔离区：不再提示无法进入、也不再拒绝指令，
      // 而是做一次判定，把终点定在离点击点最近的那条屏蔽区边缘上
      const edge = getShieldEdgeDestination(x, y);
      if (!edge) {
        showCombatText(scene, destination.x, destination.y, '无法进入该区域', '#ff6666');
        return false;
      }
      destination.set(edge.x, edge.y);
    }
    // 终点落在安全带或绿净空带内时，把终点吸附到屏蔽区外沿的安全位置，
    // 而不是把可到达的点击误判为无法绕行
    if (!isShieldClearanceSafePoint(destination.x, destination.y, PLAYER_RED_ZONE_CLEARANCE)) {
      const snapped = correctPointIntoShieldClearance(
        destination,
        PLAYER_RED_ZONE_CLEARANCE + RED_CONTOUR_MARGIN
      );
      if (!isWalkable(snapped.x, snapped.y)) {
        showCombatText(scene, destination.x, destination.y, '无法进入该区域', '#ff6666');
        return false;
      }
      destination = new Phaser.Math.Vector2(snapped.x, snapped.y);
    }
    squad.moveTarget = destination;
    squad.detourPath = [];
    squad.replanKey = null;
    squad.replanAt = 0;
    // 看门狗从指令下达时刻起算：规划排队期间小队已在按直接转向前进
    resetPlayerMoveProgress(squad, scene.time.now);
    // 每次更改终点：队形回到默认站位（Qiongjiu 最上、Daiyan 最右、Jiangyu 最左）
    resetPlayerSquadFormation(squad);
    squad.unit.isMoving = true;
    setPlayerFacing(squad, destination.x < squad.unit.x);
    // 点击即走：先解除攻击动画的一次性锁，再交叉淡化切到 move，
    // 避免攻击动画播完才起步造成的延迟
    interruptPlayerAttackAnimation(squad);
    setPlayerAnimation(squad, 'move');
    // 曲线路径规划交给本帧的规划队列：单条指令仍在这一帧内完成，
    // 多支小队于同一帧下达时按帧预算顺延，避免一次框选把整帧卡住
    queuePlayerPathOrder(squad, destination);
    processPlayerPathQueue(scene, scene.time.now);
    return true;
  }


  // 读取小队当前实际朝向：取一名正在出战的队员（存活、有骨架、不在归队/归位中——
  // 与 setPlayerFacing 的下发范围同一口径），用 isMemberFacingLeft 反推实际朝向，
  // 结果与 setPlayerFacing 的 isLeft 同一口径（art_facing_left 兵种已换算）；找不到队员时按朝右兜底
  function isPlayerSquadFacingLeft(squad) {
    const member = squad.members.find(entry =>
      entry.alive !== false &&
      entry.character && entry.character.active !== false &&
      !entry.returning && !entry.regrouping
    );
    return member ? isMemberFacingLeft(member) : true;
  }


  // 组建一支新的步兵小队：隐藏的物理锚点（整队移动/索敌结算）+ 按花名册展开的独立队员，
  // 完成后注册进 playerSquads 注册表。每支小队的队员 uid 带小队序号，多队间花名册键可重复。
  // 花名册与生命值按该兵种的数据库记录读取：JF -> Jiangyu/Qiongjiu/Daiyan，
  // ELMO1 -> Biyoca/Andoris/Groza，GK -> Centaureissi/Sharkry/Tololo，ELMO2 -> Cheeta/Lenna/Soumi，
  // coffee -> Macqiato/Nemesis 与 404 -> Clukay/Mishty（双人纵队，只区分头尾）、
  // SF -> Agent（单人，开局按召唤配置生成两个分身补成三角阵）
  function createPlayerSquad(scene, x, y, unitKey) {
    const squad = createSquadState(x, y);
    squad.unitKey = unitKey || 'jf';   // 标记兵种（roster / hp / 伤害按各自记录读取）
    const unitRecord = getPlayerUnitRecord(squad.unitKey);
    // 攻击动画名按记录（TankM1 的美术攻击动作是 skill1，Ares / Warjack 是 attack）
    squad.attackAnimation = unitRecord.attack_animation_name || 'attack';
    // 近战攻击（Warjack）：动作名与判定距离按记录读取，未登记的兵种没有近战逻辑
    squad.meleeAnimation = unitRecord.melee_animation_name || null;
    squad.meleeRange = Number.isFinite(unitRecord.melee_range) ? unitRecord.melee_range : null;
    // 素材朝向按记录读取：绝大多数兵种的素材原图朝右，向左移动时镜像即可；
    // Ares 的原图本身朝左（art_facing_left = 1），镜像方向要反过来，否则机甲会「倒着走」
    squad.artFacingLeft = unitRecord.art_facing_left === 1;
    // 渲染缩放按记录（TankM1_1001 骨架 428×201，按 0.528 实际显示约 226×106；
    // 步兵骨架 50×50 用 0.5625）
    const visualScale = (unitRecord.character_scale || PLAYER_CHARACTER_SCALE) + WG2_PLAYER_SCALE_DELTA;
    // 站位表按花名册人数选择：2 人 = 双人横队（head / tail 左右并排，coffee 与 404 统一配置），
    // 其余人数沿用三角阵（apex / left / right）
    if (unitRecord.roster.length === 2) {
      squad.slotOffsets = PLAYER_SQUAD_ROW_SLOT_OFFSETS;
      squad.freeOffsets = PLAYER_SQUAD_ROW_FREE_OFFSETS;
      squad.slotOrder = PLAYER_SQUAD_COLUMN_SLOT_ORDER;
    } else {
      squad.slotOffsets = PLAYER_SQUAD_SLOT_OFFSETS;
      squad.freeOffsets = PLAYER_SQUAD_FREE_OFFSETS;
      squad.slotOrder = PLAYER_SQUAD_SLOT_ORDER;
    }
    const roster = unitRecord.roster.map((key, index, list) => ({
      key,
      slot: squad.slotOrder[index] || 'apex',
      isLeader: index === list.length - 1
    }));
    const unit = scene.physics.add.sprite(x, y, 'playerTexture');
    unit.setVisible(false);
    unit.setCollideWorldBounds(true);
    unit.setDepth(1);
    unit.isSpawned = false;
    unit.isSelected = false;
    unit.isMoving = false;
    unit.nextAttackAt = 0;
    squad.unit = unit;
    squad.members = roster.map(member => createPlayerMember(scene, squad, member, x, y, ''));
    const leader = squad.members.find(member => member.isLeader);
    if (leader) squad.character = leader.character;
    resetPlayerSquadSlotAssignment(squad);
    configurePlayerAnimationMixing(squad);
    updatePlayerSquad(squad);
    playerSquads.push(squad);
    return squad;
  }


  // 清除小队残留对象（阵亡冲锋尚未落地的队员），用于全灭后重新组建满编小队
  function disposePlayerSquad(squad) {
    squad.members.forEach(member => {
      if (member.shadow) {
        member.shadow.destroy();
        member.shadow = null;
      }
      // 主体与附加渲染层都要销毁（多部件单位）
      forEachMemberPart(member, part => part.destroy());
      member.character = null;
      member.extraParts = [];
    });
    squad.members = [];
  }


  // 退役一支小队：清掉残留对象、销毁隐藏锚点并从注册表移除，为后续出兵腾出名额
  function removePlayerSquad(squad) {
    const index = playerSquads.indexOf(squad);
    if (index >= 0) playerSquads.splice(index, 1);
    disposePlayerSquad(squad);
    // 兵牌随小队退役销毁，防止游离的容器滞留场景
    if (squad.tag) {
      squad.tag.container.destroy();
      squad.tag = null;
    }
    if (squad.spawnAnimation && squad.spawnAnimation === S.spawnFlashAnimation) {
      S.spawnFlashAnimation = null;
      S.spawnFlashGraphics.clear();
      S.spawnFlashGraphics.setVisible(false);
    }
    squad.spawnAnimation = null;
    if (squad.unit) {
      squad.unit.destroy();
      squad.unit = null;
    }
    squad.character = null;
  }


  // 复活时把三名队员的属性与状态全部复位（血条、染色、阵型过渡状态）
  function setPlayerSquadVisible(squad, visible) {
    squad.members.forEach(member => {
      forEachMemberPart(member, part => part.setVisible(visible));
      if (member.shadow) member.shadow.setVisible(visible);
    });
  }


  function isPlayerSquadAtShieldEdge(squad, extraRange) {
    return isPointAtShieldEdge(squad.unit.x, squad.unit.y, extraRange);
  }


  // 行进方向：朝当前行进目标平滑转向；平滑过程中朝向反转会退化到零向量，此时直接取目标朝向
  function updatePlayerSquadForward(squad, target) {
    if (!target) return;
    const dx = target.x - squad.unit.x;
    const dy = target.y - squad.unit.y;
    const length = Math.hypot(dx, dy);
    if (length < 0.001) return;
    const desiredX = dx / length;
    const desiredY = dy / length;
    squad.forward.x += (desiredX - squad.forward.x) * PLAYER_SQUAD_FORMATION_LERP;
    squad.forward.y += (desiredY - squad.forward.y) * PLAYER_SQUAD_FORMATION_LERP;
    const blended = Math.hypot(squad.forward.x, squad.forward.y);
    if (blended < 0.0001) {
      squad.forward.x = desiredX;
      squad.forward.y = desiredY;
      return;
    }
    squad.forward.x /= blended;
    squad.forward.y /= blended;
  }


  // 队员当前占用的三角站位（未分配时退回花名册里的默认站位）
  function getPlayerSquadSlotOf(member) {
    return member.squad.slotAssignment[member.uid] || member.slot;
  }


  // 出兵 / 复位时：站位分配回到花名册的默认顺序
  function resetPlayerSquadSlotAssignment(squad) {
    squad.slotAssignment = {};
    squad.members.forEach(member => {
      squad.slotAssignment[member.uid] = member.slot;
    });
  }


  // 只固定「队形形状」，不固定谁站哪个位置：按距离把站位就近分给存活队员。
  // 站位表按兵种选择（双人纵队 head/tail，其余三角阵 apex/left/right），
  // 队员与站位数量都不大，直接枚举全排列取总位移最小的一种即可（带剪枝）
  function reassignPlayerSquadSlots(squad, living) {
    const offsets = squad.slotOffsets || PLAYER_SQUAD_SLOT_OFFSETS;
    const slots = Object.keys(offsets);
    if (!living.length || living.length > slots.length) return;
    let bestOrder = null;
    let bestCost = Infinity;
    const used = new Array(slots.length).fill(false);
    const order = new Array(living.length);
    const walk = (index, cost) => {
      if (cost >= bestCost) return;
      if (index === living.length) {
        bestCost = cost;
        bestOrder = order.slice();
        return;
      }
      const character = living[index].character;
      for (let s = 0; s < slots.length; s++) {
        if (used[s]) continue;
        const slot = offsets[slots[s]];
        used[s] = true;
        order[index] = slots[s];
        walk(index + 1, cost + Math.hypot(character.x - (squad.unit.x + slot.x), character.y - (squad.unit.y + slot.y)));
        used[s] = false;
      }
    };
    walk(0, 0);
    if (!bestOrder) return;
    living.forEach((member, index) => {
      squad.slotAssignment[member.uid] = bestOrder[index];
    });
  }


  // 阵型站位：按各兵种的站位表取偏移（三角阵按屏幕坐标摆放，与行进方向无关；
  // 双人纵队队长站排头、另一名队员站排尾）
  function getPlayerSquadFormationPositions(squad, living) {
    const offsets = squad.slotOffsets || PLAYER_SQUAD_SLOT_OFFSETS;
    return living.map(member => {
      const slot = offsets[getPlayerSquadSlotOf(member)] || { x: 0, y: 0 };
      return { x: squad.unit.x + slot.x, y: squad.unit.y + slot.y };
    });
  }


  // 自由散开时的位置修正：逐点推回红区安全带之外，再用 38 像素最小间距分开队员。
  // 与三角阵型的整体平移不同，这里允许队员各自贴着安全带绕行，最后仍以红区净空收尾
  function settlePlayerSquadFreePoints(squad, positions) {
    for (let pass = 0; pass < PLAYER_SQUAD_SEPARATION_PASSES; pass++) {
      clampPlayerSquadPoints(squad, positions);
      if (!separatePlayerSquadPairs(squad, positions)) return;
    }
    // 红区安全优先于队员间距，收尾再推一次保证没有人卡进屏蔽区
    clampPlayerSquadPoints(squad, positions);
  }


  // 自由移动：贴红区时队员不再排成一路纵队，而是各自朝自己那份松散站位前进
  // （相对「当前行进目标点」的横向展开 + 前后错位），彼此只用最小间距隔离，
  // 因此三个人可以各走各的、各自贴着安全带绕行
  function updatePlayerSquadFreeMove(squad, living, step) {
    const aim = squad.detourPath[0] || squad.moveTarget;
    if (!aim) return;
    const forward = squad.forward;
    const sideX = -forward.y;
    const sideY = forward.x;
    const advance = UNIT_SPEED * step / 1000;
    const freeOffsets = squad.freeOffsets || PLAYER_SQUAD_FREE_OFFSETS;
    living.forEach(member => {
      const loose = freeOffsets[getPlayerSquadSlotOf(member)] || { side: 0, back: 0 };
      const goalX = aim.x + sideX * loose.side + forward.x * loose.back;
      const goalY = aim.y + sideY * loose.side + forward.y * loose.back;
      const dx = goalX - member.freeX;
      const dy = goalY - member.freeY;
      const distance = Math.hypot(dx, dy);
      if (distance > 0.001) {
        const move = Math.min(advance, distance);
        member.freeX += dx / distance * move;
        member.freeY += dy / distance * move;
      }
      // 与队形中心（共用碰撞体）的距离上限：队员自由行走也不会脱离队伍太远，
      // 脱离红区后收拢回三角阵型的位移也就控制在合理范围内
      const outX = member.freeX - squad.unit.x;
      const outY = member.freeY - squad.unit.y;
      const outLength = Math.hypot(outX, outY);
      if (outLength > PLAYER_SQUAD_FREE_MAX_DISTANCE) {
        // 超出上限后按行军速度的若干倍逐步回收，而不是一帧夹回上限：
        // 队员被拉回队伍的过程是匀速收拢，不会突然一顿
        const returnStep = advance * PLAYER_SQUAD_FREE_RETURN_RATIO;
        const allowed = Math.max(PLAYER_SQUAD_FREE_MAX_DISTANCE, outLength - returnStep);
        const scale = allowed / outLength;
        member.freeX = squad.unit.x + outX * scale;
        member.freeY = squad.unit.y + outY * scale;
      }
    });
    // 先做队员隔离与红区净空，再把结果写回各自的自由位置，下一帧从这里继续前进
    const points = living.map(member => ({ x: member.freeX, y: member.freeY }));
    settlePlayerSquadFreePoints(squad, points);
    living.forEach((member, index) => {
      member.freeX = points[index].x;
      member.freeY = points[index].y;
    });
  }


  // 离开红色屏蔽区后的归队：不再用形态混合把队员插值回站位（那是每秒数百像素的「吸」回），
  // 而是保留每名队员当前所在位置，让它按单位速度自己走回自己的站位；与站位拉得越开速度越高
  // （上限是归队速度），队伍一边继续行军时也追得上，不会永远拖在队尾。
  // 走向站位用的是与队伍同源的逐帧转向（红区净空 + 贴着轮廓滑动），因此既不取直线穿过屏蔽区，
  // 也不会为了归队卡进屏蔽区。返回 true 表示全员都已站回自己的站位
  function updatePlayerSquadRegroup(squad, living, step) {
    const formation = getPlayerSquadFormationPositions(squad, living);
    let allHome = true;
    living.forEach((member, index) => {
      const goal = formation[index];
      const dx = goal.x - member.freeX;
      const dy = goal.y - member.freeY;
      const distance = Math.hypot(dx, dy);
      if (member.regroupHome || distance <= PLAYER_SQUAD_REGROUP_ARRIVE) {
        // 已经到位：自由位置直接对齐站位（后续由隔离与净空收尾），动画交回全队层
        member.regroupHome = true;
        member.regrouping = false;
        member.regroupStall = 0;
        member.freeX = goal.x;
        member.freeY = goal.y;
        return;
      }
      // 起步就是行军速度，与站位拉得越开越快（在 PLAYER_SQUAD_REGROUP_CATCHUP_DISTANCE 处到顶）：
      // 队员被甩开十几像素时不会用比队伍还慢的速度去追，小落差则保持正常行军速度
      const speed = UNIT_SPEED + (PLAYER_MEMBER_RETURN_SPEED - UNIT_SPEED) *
        Phaser.Math.Clamp(distance / PLAYER_SQUAD_REGROUP_CATCHUP_DISTANCE, 0, 1);
      const budget = speed * step / 1000;
      const origin = { x: member.freeX, y: member.freeY };
      const steered = getShieldSteeringTarget(origin, goal, budget);
      if (steered) {
        member.freeX = steered.x;
        member.freeY = steered.y;
      }
      const progress = distance - Math.hypot(goal.x - member.freeX, goal.y - member.freeY);
      // 连续多帧都没能朝站位靠近（站位落在不可行走处、被安全带与地形夹住等）：
      // 认定已经走到最接近站位的位置，交给阵型层收尾，避免在这里原地空转
      member.regroupStall = progress < budget * PLAYER_SQUAD_REGROUP_STALL_RATIO
        ? (member.regroupStall || 0) + 1
        : 0;
      if (member.regroupStall >= PLAYER_SQUAD_REGROUP_STALL_FRAMES) member.regroupHome = true;
      if (member.regroupHome) {
        // 看门狗判定为「已经站到最接近站位的位置」：动画立即交回全队层
        member.regrouping = false;
      } else {
        // 归队途中朝向自己的前进方向（全队朝向在帧末统一写，会被覆盖，
        // 所以只记录，最终由 applyPlayerMemberReturnVisuals 单独下发）
        if (Math.abs(member.freeX - origin.x) > 0.02) member.returnFacingLeft = member.freeX < origin.x;
        member.regrouping = true;
        // 脚步速率跟随实际移动速度：加速追赶时动画同步加快，不会出现打滑或原地踏步
        member.regroupSpeedRatio = speed / UNIT_SPEED;
      }
      allHome = false;
    });
    return allHome;
  }


  // 每次更改终点时调用：阵型目标回到默认站位（Qiongjiu 最上、Daiyan 最右、Jiangyu 最左）。
  // 这里不硬切形态，而是把行进方向对齐到新目标后交给逐帧缓动，
  // 否则三角阵型与自由散开之间会瞬间跳变，看起来像卡顿。
  // 队形重排交给本帧主循环统一执行（指令在场景 update 之前处理，主循环随后就会更新全部小队）：
  // 指令处理器里再算一遍等于每支小队每帧多解一次阵型，框选 n 支小队就是 n 次额外求解，
  // 这正是「一次框选把下单那一帧顶到十几毫秒」的主要开销
  function resetPlayerSquadFormation(squad) {
    const target = squad.detourPath[0] || squad.moveTarget;
    if (target) {
      const dx = target.x - squad.unit.x;
      const dy = target.y - squad.unit.y;
      const length = Math.hypot(dx, dy);
      if (length > 0.001) {
        squad.forward.x = dx / length;
        squad.forward.y = dy / length;
      }
    }
  }


  // 人员隔离：任意两名队员的距离不得小于 38 像素，一旦不足就沿连线方向对称推开，
  // 恢复目标为 56 像素（隔离要求 38~56 像素），返回是否发生了调整
  function separatePlayerSquadPairs(squad, positions) {
    const target = PLAYER_SQUAD_SEPARATION_TARGET + PLAYER_SQUAD_SEPARATION_BUFFER;
    let adjusted = false;
    for (let i = 0; i < positions.length; i++) {
      for (let j = i + 1; j < positions.length; j++) {
        const dx = positions[j].x - positions[i].x;
        const dy = positions[j].y - positions[i].y;
        let distance = Math.hypot(dx, dy);
        if (distance >= PLAYER_SQUAD_SEPARATION - RED_CLEARANCE_TOLERANCE) continue;
        let normalX;
        let normalY;
        if (distance < 0.0001) {
          // 完全重合时无法由连线确定分离方向，退回沿阵型横向分离
          normalX = -squad.forward.y;
          normalY = squad.forward.x;
          distance = 0;
        } else {
          normalX = dx / distance;
          normalY = dy / distance;
        }
        const push = (target - distance) / 2;
        positions[i].x -= normalX * push;
        positions[i].y -= normalY * push;
        positions[j].x += normalX * push;
        positions[j].y += normalY * push;
        adjusted = true;
      }
    }
    return adjusted;
  }


  // 位置修正：把队员推回屏蔽区（红区与绿屏蔽区）的净空带之外，并保证各自仍落在可行走区域内。
  // 这是「每名队员的独立碰撞体」的判定核心：三人各自过自己的净空与地形，互不代劳
  function clampPlayerSquadPoints(squad, positions) {
    const anchor = { x: squad.unit.x, y: squad.unit.y };
    positions.forEach(point => {
      const outOfShield = correctPointIntoShieldClearance(point, PLAYER_RED_ZONE_CLEARANCE);
      const corrected = correctPointIntoWalkable(outOfShield, anchor);
      point.x = corrected.x;
      point.y = corrected.y;
    });
  }


  // 单个队员越出屏蔽区净空带的深度：0 表示已在净空带之外
  function getPlayerSquadShieldViolation(point) {
    const corrected = correctPointIntoShieldClearance(point, PLAYER_RED_ZONE_CLEARANCE);
    return Math.hypot(corrected.x - point.x, corrected.y - point.y);
  }


  function getWorstPlayerSquadShieldViolation(positions) {
    let worst = 0;
    positions.forEach(point => {
      const violation = getPlayerSquadShieldViolation(point);
      if (violation > worst) worst = violation;
    });
    return worst;
  }


  // 队员与屏蔽区边缘保持净空时优先整体平移：刚体平移不改变队员间距，
  // 因此自由行走时的横向展开量、纵队时队员之间的最小隔离距离都能严格保持；
  // 只有在整体平移不收敛时才退回到逐点推回（此时屏蔽区安全优先于间距）。
  // 对红环与绿环一起求违例：贴绿边时同样整队刚性平移，正是沿绿边界行走想要的形态
  function fitPlayerSquadToShieldClearance(squad, positions) {
    let best = positions.map(point => ({ x: point.x, y: point.y }));
    let bestViolation = getWorstPlayerSquadShieldViolation(positions);
    for (let pass = 0; pass < PLAYER_SQUAD_SEPARATION_PASSES && bestViolation > RED_CLEARANCE_TOLERANCE; pass++) {
      // 以需要修正幅度最大的队员为准，整队一起平移
      let shiftX = 0;
      let shiftY = 0;
      let shiftLength = 0;
      positions.forEach(point => {
        const corrected = correctPointIntoShieldClearance(point, PLAYER_RED_ZONE_CLEARANCE);
        const dx = corrected.x - point.x;
        const dy = corrected.y - point.y;
        const length = Math.hypot(dx, dy);
        if (length <= shiftLength) return;
        shiftLength = length;
        shiftX = dx;
        shiftY = dy;
      });
      if (shiftLength <= RED_CLEARANCE_TOLERANCE) break;
      positions.forEach(point => {
        point.x += shiftX;
        point.y += shiftY;
      });
      const violation = getWorstPlayerSquadShieldViolation(positions);
      if (violation < bestViolation) {
        bestViolation = violation;
        best = positions.map(point => ({ x: point.x, y: point.y }));
      }
    }
    positions.forEach((point, index) => {
      point.x = best[index].x;
      point.y = best[index].y;
    });
    if (bestViolation > RED_CLEARANCE_TOLERANCE) clampPlayerSquadPoints(squad, positions);
  }


  // 队员隔离与红区净空会互相冲突，交替迭代求解，且每轮都以红区净空收尾：
  // 最终的阵型一定在安全带上，队员间距也满足 38 像素隔离要求
  function resolvePlayerSquadOverlap(squad, positions) {
    for (let pass = 0; pass < PLAYER_SQUAD_SEPARATION_PASSES; pass++) {
      if (!separatePlayerSquadPairs(squad, positions)) break;
      clampPlayerSquadPoints(squad, positions);
    }
  }


  // 跨小队挤压的持久阵型偏移：多支小队同时向同一目标点汇聚（或行进途中擦肩而过）时，
  // 不同小队的队员之间也必须保持最小间距，否则各队阵型会互相压进、队员叠在一起。
  // 队内隔离（separatePlayerSquadPairs）只约束本队三人，这里补上队与队之间的约束。
  // 每帧用「本队阵型位置 vs 其他小队上一帧渲染位置」求一次整队需要的平移量（各让一半），
  // 再把它低通滤波写入 squad.crowdX/crowdY 并应用到阵型：偏移是持久状态，不会像
  // 只推瞬时位置那样被下一帧的阵型重算拉回、来回震荡；附近没有别的队伍时向 0 平滑收敛。
  // 平移量按重叠数量取平均（多个方向都被挤时取合力方向），并限幅，不会把整队推飞；
  // 平移后的阵型仍会经过 clampPlayerSquadPoints 的红区净空与可行走校验
  function updatePlayerSquadCrowdShift(squad, formation) {
    const living = getLivingPlayerMembers(squad);
    let pushX = 0;
    let pushY = 0;
    let count = 0;
    playerSquads.forEach(other => {
      if (other === squad || !other.unit || !other.unit.isSpawned) return;
      other.members.forEach(otherMember => {
        if (!otherMember.alive || !otherMember.character || otherMember.character.active === false) return;
        const ox = otherMember.character.x;
        const oy = otherMember.character.y;
        const otherRadius = otherMember.body ? otherMember.body.radius : PLAYER_MEMBER_COLLISION_RADIUS;
        for (let index = 0; index < formation.length; index++) {
          const point = formation[index];
          // 最小圆心距按双方各自碰撞体半径之和计算（TankM1 90 + 步兵 17 = 107），
          // 大型单位与其他小队擦肩时同样不会被压进对方阵型
          const selfRadius = living[index] && living[index].body
            ? living[index].body.radius
            : PLAYER_MEMBER_COLLISION_RADIUS;
          const minDistance = selfRadius + otherRadius;
          const minDistanceSquared = minDistance * minDistance;
          const dx = point.x - ox;
          const dy = point.y - oy;
          const distanceSquared = dx * dx + dy * dy;
          if (distanceSquared >= minDistanceSquared) continue;
          const distance = Math.sqrt(distanceSquared);
          let normalX;
          let normalY;
          if (distance < 0.0001) {
            normalX = -squad.forward.y;
            normalY = squad.forward.x;
          } else {
            normalX = dx / distance;
            normalY = dy / distance;
          }
          const push = (minDistance - distance) * 0.5;
          pushX += normalX * push;
          pushY += normalY * push;
          count += 1;
        }
      });
    });
    let targetX = 0;
    let targetY = 0;
    if (count > 0) {
      targetX = pushX / count;
      targetY = pushY / count;
      const length = Math.hypot(targetX, targetY);
      if (length > PLAYER_CROSS_SQUAD_MAX_SHIFT) {
        targetX = targetX / length * PLAYER_CROSS_SQUAD_MAX_SHIFT;
        targetY = targetY / length * PLAYER_CROSS_SQUAD_MAX_SHIFT;
      }
    }
    squad.crowdX += (targetX - squad.crowdX) * PLAYER_CROSS_SQUAD_LERP;
    squad.crowdY += (targetY - squad.crowdY) * PLAYER_CROSS_SQUAD_LERP;
  }


  // 每帧按阵型摆放三名队员：位置只由碰撞体位置与阵型形态推导，移动本身仍由碰撞体驱动；
  // 每名队员各自持有独立碰撞体，最终位置再过一遍「与敌方的单位隔离」与「红区 + 可行走」判定，
  // 并以限速缓动写入渲染位置，因此进出红色屏蔽区时既安全又平滑
  function updatePlayerSquad(squad, delta) {
    // 阵亡冲锋中的队员已经脱离阵型，只有存活队员参与队形摆放
    const living = getLivingPlayerMembers(squad);
    if (!living.length) return;
    const step = delta === undefined ? 16.667 : delta;
    // 开局召唤分身（SF / Agent）：召唤动画播到记录登记的延时分身落地，
    // 数值与机制完全继承本体（同一条记录、同一套攻击 / 阵亡 / 齐射逻辑），
    // 落点在本体两侧，随后由阵型站位与队员间距自动收拢
    if (squad.cloneSummon && S.gameScene.time.now >= squad.cloneSummon.startedAt + squad.cloneSummon.delay) {
      const summon = squad.cloneSummon;
      squad.cloneSummon = null;
      const body = squad.members.find(member => member.isLeader && member.alive !== false) || null;
      if (body) {
        const appearMembers = [];
        for (let index = 0; index < summon.count; index++) {
          squad.cloneSeq = (squad.cloneSeq || 0) + 1;
          const clone = createPlayerMember(
            S.gameScene,
            squad,
            { key: body.key, slot: index === 0 ? 'apex' : 'right', isLeader: false },
            body.character.x + (index === 0 ? -24 : 24),
            body.character.y,
            '#clone' + squad.cloneSeq
          );
          clone.character.setAlpha(0);
          if (clone.shadow) clone.shadow.setAlpha(0);
          // 分身常驻 25% 红色覆盖：按槽位基础色向正红插值（与死亡染色同一套机制），
          // 保留明暗细节；死亡泛红会从这个叠加程度继续往上走
          forEachMemberPart(clone, part => {
            part.__baseRedAmount = 0.25;
            applyDeathTint(part, 0);
          });
          squad.members.push(clone);
          appearMembers.push(clone);
        }
        resetPlayerSquadSlotAssignment(squad);
        squad.cloneAppear = { startedAt: S.gameScene.time.now, members: appearMembers };
      }
    }
    // 分身落地淡入：300ms 内体型与透明度从出生动画的起始值过渡到正常，避免硬闪现
    if (squad.cloneAppear) {
      const appearProgress = Phaser.Math.Clamp((S.gameScene.time.now - squad.cloneAppear.startedAt) / 300, 0, 1);
      squad.cloneAppear.members.forEach(member => {
        if (!member.character) return;
        const scale = member.visualScale * (SPAWN_ANIMATION_MIN_SCALE + (1 - SPAWN_ANIMATION_MIN_SCALE) * appearProgress);
        const facing = member.character.scaleX < 0 ? -1 : 1;
        applyFacingScale(member.character, facing * scale, scale);
        member.character.setAlpha(appearProgress);
        if (member.shadow) member.shadow.setAlpha(SHADOW_ALPHA * appearProgress);
      });
      if (appearProgress >= 1) squad.cloneAppear = null;
    }
    // 贴到红区边缘时整队脱离队列自由移动；
    // 进入与退出使用两个不同范围形成迟滞，避免安全带附近形态反复收放。
    // 「整个队伍脱离红区」以每名队员的实际位置为准：只要还有人贴着安全带，
    // 就继续自由移动，不会提前把队伍收回三角阵型
    const edgeRange = squad.squeezed ? PLAYER_SQUAD_EDGE_EXIT_RANGE : PLAYER_SQUAD_EDGE_RANGE;
    const atRedEdge = !!squad.moveTarget && (
      isPlayerSquadAtShieldEdge(squad, edgeRange) ||
      living.some(member => isPointAtShieldEdge(member.character.x, member.character.y, edgeRange))
    );
    squad.squeezed = atRedEdge;
    updatePlayerSquadForward(squad, squad.detourPath[0] || squad.moveTarget);
    // 形态进度按时间线性推进，再做 smoothstep 缓动：过渡时长固定，起步收尾都平顺。
    // 只有「贴到红区」会把形态推满；脱离红区后不再把形态放回去，而是交给下面
    // updatePlayerSquadRegroup 让队员各自按单位速度走回站位，全部到位后再切回纯三角阵型
    const morphStep = step / PLAYER_SQUAD_MORPH_DURATION;
    if (atRedEdge) {
      squad.regrouping = false;
      squad.morphProgress = Math.min(1, squad.morphProgress + morphStep);
    } else if (squad.freeActive) {
      squad.regrouping = true;
      squad.morphProgress = Math.min(1, squad.morphProgress + morphStep);
    } else {
      squad.regrouping = false;
      squad.morphProgress = 0;
    }
    squad.freeBlend = smoothStep01(squad.morphProgress);
    // 【细分埋点】阵型摆放 + 跨队挤压：6 队以上同屏时的 nav 段嫌疑之一
    const formationStartedAt = performance.now();
    const formation = getPlayerSquadFormationPositions(squad, living);
    // 跨小队挤压：整队阵型带一个持久偏移，向挤过来的其他小队让开（多队汇聚时队员
    // 不会互相压进）；偏移量向 0 平滑收敛，附近队伍离开后阵型自动回到锚点正上方
    updatePlayerSquadCrowdShift(squad, formation);
    modulePerf.sub.formationMs += performance.now() - formationStartedAt;
    if (squad.crowdX !== 0 || squad.crowdY !== 0) {
      formation.forEach(point => {
        point.x += squad.crowdX;
        point.y += squad.crowdY;
      });
    }
    if (atRedEdge) {
      if (!squad.freeActive) {
        // 刚贴到红区：以当前三角阵型站位作为自由移动的起点，散开过程不会出现瞬移
        living.forEach((member, index) => {
          member.freeX = formation[index].x;
          member.freeY = formation[index].y;
          member.regroupHome = false;
          member.regroupStall = 0;
          member.regrouping = false;
        });
        squad.freeActive = true;
        squad.slotSwapped = false;
      }
      const freeMoveStartedAt = performance.now();
      updatePlayerSquadFreeMove(squad, living, step);
      modulePerf.sub.freeMoveMs += performance.now() - freeMoveStartedAt;
    } else if (squad.freeActive) {
      if (!squad.slotSwapped && squad.freeBlend >= PLAYER_SQUAD_SLOT_SWAP_BLEND) {
        // 整个队伍已脱离红区、且基本完全散开（此时可视位置由自由位置决定、与站位无关）：
        // 按“谁离哪个站位近”重新分配三角站位。换站位不产生任何瞬移，
        // 之后的归队只是各自就近走回站位，不会再出现横穿队伍去抢固定站位导致的生硬动画。
        // 只在本次绕行里换一次（squad.slotSwapped），避免边缘反复进出时站位来回抖动
        reassignPlayerSquadSlots(squad, living);
        squad.slotSwapped = true;
      }
      const regroupStartedAt = performance.now();
      const regrouped = updatePlayerSquadRegroup(squad, living, step);
      modulePerf.sub.regroupMs += performance.now() - regroupStartedAt;
      if (regrouped) {
        // 全员已各自走回站位：此刻自由位置与站位完全重合，
        // 切回纯三角阵型不会产生任何位移，也没有动画跳变
        squad.freeActive = false;
        squad.regrouping = false;
        squad.morphProgress = 0;
        squad.freeBlend = 0;
      }
    }
    const positions = living.map((member, index) => {
      const base = formation[index];
      if (squad.freeBlend <= 0) return { x: base.x, y: base.y };
      return {
        x: base.x + (member.freeX - base.x) * squad.freeBlend,
        y: base.y + (member.freeY - base.y) * squad.freeBlend
      };
    });
    if (squad.freeBlend <= 0) {
      // 纯三角阵型：整体平移避让红区，阵型间距严格保持；再处理队员间距兜底
      fitPlayerSquadToShieldClearance(squad, positions);
      resolvePlayerSquadOverlap(squad, positions);
    } else {
      // 自由散开（或正在收回阵型）：逐点修正，队员可以各自贴着安全带绕行
      settlePlayerSquadFreePoints(squad, positions);
    }
    // 各队员的独立碰撞体先与敌方单位做一次隔离，再被 Gustaf 的静态碰撞区推出互动区，
    // 最后以红区净空与可行走收尾（地形安全优先）
    separatePlayerMembersFromEnemies(squad, living, positions);
    separatePlayerMembersFromGustaf(squad, living, positions);
    clampPlayerSquadPoints(squad, positions);
    // 渲染位置朝目标位置限速缓动：修正量再大也会摊到若干帧里，不会出现跳变。
    // 掉队的队员（拉开太远，或直线回位会穿进红区安全带）改为自动寻路归队：
    // 沿红区轮廓曲线走回自己的站位并播放移动动画，而不是从远处直线飘/穿过屏蔽区过来
    const maxStep = PLAYER_MEMBER_ANIM_MAX_STEP * Math.max(0.5, step / 16.667);
    const returnBudget = PLAYER_MEMBER_RETURN_SPEED * step / 1000;
    const returnExitDistance = PLAYER_MEMBER_RETURN_DISTANCE * PLAYER_MEMBER_RETURN_EXIT_RATIO;
    living.forEach((member, index) => {
      const target = positions[index];
      const startX = member.renderX === undefined ? target.x : member.renderX;
      const startY = member.renderY === undefined ? target.y : member.renderY;
      let renderX = startX;
      let renderY = startY;
      const dx = target.x - renderX;
      const dy = target.y - renderY;
      const distance = Math.hypot(dx, dy);
      if (distance <= maxStep) {
        // 已经到位：直接吸附并结束归队状态
        renderX = target.x;
        renderY = target.y;
        member.returning = false;
        resetPlayerMemberReturn(member);
      } else {
        // 直线回位是否安全只在短距离时才判定（归队完成条件用得到，长距离已经直接判定为掉队）：
        // 「收进半个触发距离 + 直线已经安全」才算归位，避免在阈值附近反复进出归队状态
        if (member.returning) {
          if (distance <= returnExitDistance &&
            isPlayerMemberDirectRouteSafe(renderX, renderY, target, PLAYER_MEMBER_RETURN_EXIT_CLEARANCE)) {
            member.returning = false;
            resetPlayerMemberReturn(member);
          }
        } else if (distance > PLAYER_MEMBER_RETURN_DISTANCE ||
          !isPlayerMemberDirectRouteSafe(renderX, renderY, target)) {
          member.returning = true;
          resetPlayerMemberReturn(member);
        }
        if (member.returning) {
          const steered = stepPlayerMemberReturn(member, target, returnBudget, step);
          if (steered) {
            // 归队途中朝向自己的前进方向（全队朝向在帧末由 setPlayerFacing 统一写，会被覆盖，
            // 所以这里只记录，最终由 applyPlayerMemberReturnVisuals 在帧末单独下发）
            if (Math.abs(steered.x - renderX) > 0.02) member.returnFacingLeft = steered.x < renderX;
            renderX = steered.x;
            renderY = steered.y;
          } else {
            // 规划失败：能沿屏蔽区轮廓滑动就沿轮廓走（这正是「沿屏蔽区移动」的形态），
            // 否则只沿已验证安全的直线回位方向靠近，两条路都不通就本帧原地不动。
            // 绝不允许为了靠近站位而直接穿进屏蔽区
            const slide = slideAlongShieldRing({ x: renderX, y: renderY }, target, maxStep);
            if (slide) {
              if (Math.abs(slide.x - renderX) > 0.02) member.returnFacingLeft = slide.x < renderX;
              renderX = slide.x;
              renderY = slide.y;
            } else if (isPlayerMemberDirectRouteSafe(renderX, renderY, target)) {
              renderX += dx / distance * maxStep;
              renderY += dy / distance * maxStep;
            }
          }
        } else {
          renderX += dx / distance * maxStep;
          renderY += dy / distance * maxStep;
        }
      }
      member.renderX = renderX;
      member.renderY = renderY;
      // 「本帧是否真的移动了」按渲染位置位移统计：贴边被安全带夹住时上层只会原地返回，
      // 累计到阈值后由动画层把走路循环换成待机（否则会一直原地踏步）
      if (Math.hypot(renderX - startX, renderY - startY) > PLAYER_MEMBER_ANIM_MOVE_EPSILON) {
        member.renderIdleMs = 0;
      } else {
        member.renderIdleMs = Math.min(member.renderIdleMs + step, PLAYER_MEMBER_ANIM_IDLE_DELAY * 4);
      }
      member.character.setPosition(renderX, renderY);
      if (member.shadow) {
        member.shadow.setPosition(renderX, renderY + SHADOW_OFFSET_Y);
      }
      // 碰撞体跟随实际渲染位置：判定位置与看到的画面永远是同一个位置
      if (member.body) {
        member.body.x = renderX;
        member.body.y = renderY;
      }
    });
  }

export { createSquadState, hasSpawnedPlayerSquad, getSpawnedPlayerSquads, getPlayerSquadOrderSpread, getPlayerSquadOrderOffset, resolvePlayerSquadOrderGoals, getPlayerSteeringTarget, handlePlayerSquadWipe, getPlayerSquadOuterRadius, sellPlayerSquad, updatePlayerSquadRegen, spawnedSquadCount, countPlayerSquadsOf, countPlayerSquadsInCategory, resetPlayerMoveProgress, finishPlayerMoveOrder, getPlayerMoveProgressMark, updatePlayerMoveProgress, queuePlayerPathOrder, applyPlayerPathOrder, issuePlayerMoveOrder, isPlayerSquadFacingLeft, createPlayerSquad, disposePlayerSquad, removePlayerSquad, setPlayerSquadVisible, isPlayerSquadAtShieldEdge, updatePlayerSquadForward, getPlayerSquadSlotOf, resetPlayerSquadSlotAssignment, reassignPlayerSquadSlots, getPlayerSquadFormationPositions, settlePlayerSquadFreePoints, updatePlayerSquadFreeMove, updatePlayerSquadRegroup, resetPlayerSquadFormation, separatePlayerSquadPairs, clampPlayerSquadPoints, getPlayerSquadShieldViolation, getWorstPlayerSquadShieldViolation, fitPlayerSquadToShieldClearance, resolvePlayerSquadOverlap, updatePlayerSquadCrowdShift, updatePlayerSquad };
