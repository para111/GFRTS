// ============================================================
// wg_game 模块化拆分 —— pathfind.js
// 职责: 路径规划：A*/轮廓路由/贴边滑行/绕行候选
// 来源: wg_game.js 语句区间 538-7773（自动拆分，勿手工重排语句顺序）
// ============================================================

import { S } from './S.js';
import { getContourArcLength, getCurvedEdgePaths, getNearestContourIndex, getPolygonNearestEdgePoint, getRingNearestDistance, pointInPolygon, projectPointOnContour, segmentsIntersect } from './geometry.js';
import { ENEMY_RED_ZONE_CLEARANCE, GREEN_SHIELD_RING, PLAYER_RED_ROUTE_RANGE, PLAYER_RED_SLIDE_HYSTERESIS, PLAYER_RED_SLIDE_RANGE, PLAYER_RED_STEER_BIAS, PLAYER_RED_WALK_LEG_CANDIDATE_LIMIT, PLAYER_RED_ZONE_CLEARANCE, RED_CLEARANCE_PATH_SLACK, RED_CLEARANCE_TOLERANCE, RED_CONTOUR_MARGIN, RED_SHIELD_RING, WORLD_HEIGHT, WORLD_WIDTH, collisionRegions, redCrossProbeEnd, redCrossProbeStart, redPathStats } from './state.js';
import { correctPointIntoGreenClearance, correctPointIntoShieldClearance, correctPointOutOfRedClearance, findRedShieldSeat, findWalkableShieldSeat, getNearestEdgeCandidates, getRedRouteZones, getRedZoneContourEntry, getRedZoneContourNodes, getZoneBounds, getZoneEdgeGrid, getZoneNearestEdge, getZoneSegmentDistance, isCollisionLineCrossed, isGreenClearanceSafePoint, isGreenClearanceSatisfied, isRedClearanceSafePoint, isRedClearanceSafeSegment, isShieldClearanceSafePoint, isShieldClearanceSafeSegment, isWalkable } from './zones.js';

  function resetRedPathStats() {
    redPathStats.planMs = 0;
    redPathStats.planCount = 0;
    redPathStats.maxPlanMs = 0;
    redPathStats.slideMs = 0;
    redPathStats.slideCalls = 0;
    redPathStats.slideHits = 0;
    redPathStats.lastNodes = 0;
    redPathStats.lastPathLen = 0;
    redPathStats.lastGreedyLen = 0;
    redPathStats.lastStraightLen = 0;
    redPathStats.noRouteCount = 0;
    redPathStats.lastGreenNodes = 0;
    redPathStats.greenRouteCount = 0;
  }

  // 记录一次整段规划的结果（耗时、节点数、路径长度、直线下界）
  function recordRedPlan(start, end, path, startedAt) {
    const elapsed = performance.now() - startedAt;
    redPathStats.planMs += elapsed;
    redPathStats.planCount += 1;
    if (elapsed > redPathStats.maxPlanMs) redPathStats.maxPlanMs = elapsed;
    if (!path || !path.length) {
      redPathStats.noRouteCount += 1;
      return;
    }
    redPathStats.lastNodes = path.length;
    redPathStats.lastPathLen = getClearancePathCost(start, path);
    redPathStats.lastStraightLen = Phaser.Math.Distance.Between(start.x, start.y, end.x, end.y);
  }


  function isRedZonePathCrossed(startX, startY, endX, endY) {
    const zones = collisionRegions.redForbiddenZones;
    for (let i = 0; i < zones.length; i++) {
      if (isRedZoneCrossedByPath(startX, startY, endX, endY, zones[i])) return true;
    }
    return false;
  }


  // 路径是否穿入红区：先用边的包围盒筛掉不可能相交的边，再做精确相交测试；
  // 最后用线段中点补一次内部判定，覆盖「整段都落在红区内部、不与任何边相交」的情形。
  // 与旧的「逐边相交 + 24 像素抽样 pointInPolygon」判定等价（内→外、外→内、内→外→内
  // 都必须穿越边界，必然被相交测试命中），但不再有抽样点量级的内存分配。
  function isRedZoneCrossedByPath(startX, startY, endX, endY, zone) {
      const edges = getZoneEdgeGrid(zone).edges;
      const minX = Math.min(startX, endX);
      const maxX = Math.max(startX, endX);
      const minY = Math.min(startY, endY);
      const maxY = Math.max(startY, endY);
      // 连线的包围盒与红区包围盒完全分离时既不可能相交，中点也必然在区外，直接判定未穿越
      const bounds = getZoneBounds(zone);
      if (maxX < bounds.minX || minX > bounds.maxX || maxY < bounds.minY || minY > bounds.maxY) return false;
      redCrossProbeStart.x = startX;
      redCrossProbeStart.y = startY;
      redCrossProbeEnd.x = endX;
      redCrossProbeEnd.y = endY;
      for (let i = 0; i < zone.length; i++) {
        if (edges[i * 4] > maxX || edges[i * 4 + 2] < minX || edges[i * 4 + 1] > maxY || edges[i * 4 + 3] < minY) continue;
        if (segmentsIntersect(redCrossProbeStart, redCrossProbeEnd, zone[i], zone[(i + 1) % zone.length])) return true;
      }
      return pointInPolygon((startX + endX) / 2, (startY + endY) / 2, zone);
  }


  function isSafePath(start, end) {
    return isWalkable(start.x, start.y) &&
      isWalkable(end.x, end.y) &&
      !isCollisionLineCrossed(start.x, start.y, end.x, end.y);
  }


  // segmentSafe 供盾判定复用：默认仍是红区判定，因此现有调用点逐位不变
  function isClearancePathSafe(
    start,
    path,
    clearance = PLAYER_RED_ZONE_CLEARANCE,
    strict = false,
    segmentSafe = isRedClearanceSafeSegment
  ) {
    if (!path || !path.length) return false;
    let previous = start;
    return path.every(point => {
      const safe = segmentSafe(previous, point, clearance, strict);
      previous = point;
      return safe;
    });
  }


  function getDetourCandidates() {
    if (S.detourCandidatesVersion === S.collisionRegionVersion) return S.detourCandidatesCache;
    const candidates = [];
    const addCandidate = (point, center, direction = 1) => {
      const dx = (point.x - center.x) * direction;
      const dy = (point.y - center.y) * direction;
      const length = Math.max(1, Math.hypot(dx, dy));
      const candidate = {
        x: Phaser.Math.Clamp(point.x + (dx / length) * 22, 0, WORLD_WIDTH),
        y: Phaser.Math.Clamp(point.y + (dy / length) * 22, 0, WORLD_HEIGHT)
      };
      if (isWalkable(candidate.x, candidate.y)) candidates.push(candidate);
    };
    collisionRegions.redForbiddenZones.forEach(zone => {
      const center = zone.reduce((sum, point) => ({
        x: sum.x + point.x / zone.length,
        y: sum.y + point.y / zone.length
      }), { x: 0, y: 0 });
      zone.forEach(point => addCandidate(point, center));
    });
    const boundaryCenter = collisionRegions.walkableBoundary.reduce((sum, point) => ({
      x: sum.x + point.x / collisionRegions.walkableBoundary.length,
      y: sum.y + point.y / collisionRegions.walkableBoundary.length
    }), { x: 0, y: 0 });
    collisionRegions.walkableBoundary.forEach(point => addCandidate(point, boundaryCenter, -1));
    S.detourCandidatesCache = candidates;
    S.detourCandidatesVersion = S.collisionRegionVersion;
    return candidates;
  }


  // 候选点配对（O(n²)）是满编时最大的性能热点：新地图 12px 重采样后约有 280 个候选点，
  // 原先每个候选点都要重复判定「起点能否直达」，每一对候选点还要做两次 isSafePath
  // （内部是逐红区线段相交 + 多边形判定），单次调用最多产生数万次几何判定，每帧数十毫秒。
  // 现在改成「先算便宜的长度，再做昂贵的安全判定」，并让每个候选点的判定结果全程复用：
  //   1. 两个候选点方向的判定都惰性、按需记忆化，每个候选点最多判定一次（原来要重复 2~3 次）；
  //   2. 两跳路径长度 ≥ (起点→第一跳) + (第二跳→终点)，用这个下界剪掉不可能更优的组合；
  //   3. 剪枝只丢弃「确定无法严格优于当前最优」的路径，而长度比较与求和顺序都和原实现一致，
  //      因此返回的路径（含同长度时保留先出现者）与原实现完全等价。
  function getReplannedPath(start, end, preferLongest, additionalCandidates = [], edgeOnly = false) {
    const startWalkable = isWalkable(start.x, start.y);
    const rawCandidates = edgeOnly ? additionalCandidates : getDetourCandidates().concat(additionalCandidates);
    const preferGreater = preferLongest === true;
    const count = rawCandidates.length;
    const fromStart = new Float64Array(count);
    const toEnd = new Float64Array(count);
    // 最短语义下需要「除自身外最近的终点距离」作为第二跳的下界，故记录最小与次小值
    let minEnd = Infinity;
    let secondMinEnd = Infinity;
    let minEndIndex = -1;
    for (let i = 0; i < count; i++) {
      const candidate = rawCandidates[i];
      fromStart[i] = Phaser.Math.Distance.Between(start.x, start.y, candidate.x, candidate.y);
      toEnd[i] = Phaser.Math.Distance.Between(candidate.x, candidate.y, end.x, end.y);
      if (toEnd[i] < minEnd) {
        secondMinEnd = minEnd;
        minEnd = toEnd[i];
        minEndIndex = i;
      } else if (toEnd[i] < secondMinEnd) {
        secondMinEnd = toEnd[i];
      }
    }
    const minEndExcept = index => (index === minEndIndex ? secondMinEnd : minEnd);
    const reachFlag = new Int8Array(count).fill(-1);
    const endFlag = new Int8Array(count).fill(-1);
    const canReach = index => {
      if (reachFlag[index] < 0) {
        reachFlag[index] = (
          startWalkable ? isSafePath(start, rawCandidates[index]) : canReachDetourPoint(start, rawCandidates[index])
        ) ? 1 : 0;
      }
      return reachFlag[index] === 1;
    };
    const isEndSafe = index => {
      if (endFlag[index] < 0) endFlag[index] = isSafePath(rawCandidates[index], end) ? 1 : 0;
      return endFlag[index] === 1;
    };
    let bestPath = null;
    let bestLength = 0;
    if (startWalkable && isSafePath(start, end)) {
      bestPath = [end];
      bestLength = Phaser.Math.Distance.Between(start.x, start.y, end.x, end.y);
    }
    for (let i = 0; i < count; i++) {
      const oneHopLength = fromStart[i] + toEnd[i];
      const canImproveOneHop = bestPath === null || (preferGreater ? oneHopLength > bestLength : oneHopLength < bestLength);
      if (canImproveOneHop && canReach(i) && isEndSafe(i)) {
        bestPath = [rawCandidates[i], end];
        bestLength = oneHopLength;
      }
      if (bestPath && !preferGreater && fromStart[i] + minEndExcept(i) >= bestLength) continue;
      if (!canReach(i)) continue;
      for (let j = 0; j < count; j++) {
        if (j === i) continue;
        if (bestPath && !preferGreater && fromStart[i] + toEnd[j] >= bestLength) continue;
        const legLength = Phaser.Math.Distance.Between(
          rawCandidates[i].x, rawCandidates[i].y, rawCandidates[j].x, rawCandidates[j].y
        );
        const pathLength = fromStart[i] + legLength + toEnd[j];
        if (bestPath && (preferGreater ? pathLength <= bestLength : pathLength >= bestLength)) continue;
        if (!isEndSafe(j) || !isSafePath(rawCandidates[i], rawCandidates[j])) continue;
        bestPath = [rawCandidates[i], rawCandidates[j], end];
        bestLength = pathLength;
      }
    }
    return bestPath;
  }


  function canReachDetourPoint(start, end) {
    return isWalkable(end.x, end.y) &&
      !isCollisionLineCrossed(start.x, start.y, end.x, end.y);
  }


  // 盾路由的环集合：全部红环，外加「确实需要」时才纳入的绿环。
  // 绿环纳入的两个条件：直线本身就会贴住/切出绿边界（必须绕），或直线绕不开红区
  // 且离绿边界已在 PLAYER_RED_ROUTE_RANGE 之内（绕行时很可能顺势贴到绿边）。
  // 这是一次格子加速的线段查询，绝大多数指令不会把绿环（100+ 节点）塞进图里
  function getShieldRouteRings(start, end, clearance = PLAYER_RED_ZONE_CLEARANCE) {
    const rings = collisionRegions.redForbiddenZones.map(zone => ({ ...RED_SHIELD_RING, zone }));
    const boundary = collisionRegions.walkableBoundary;
    // 直线贴住/切出绿边界（到边界折线的距离不足净空）时必须把绿环纳入图。
    // 这一判定与「绿区线段净空判定」完全同值，直接复用它的记忆化结果，省掉一次逐边求距
    const greenUnsafe = !isGreenClearanceSatisfied(start, end, clearance, RED_CLEARANCE_PATH_SLACK);
    const nearBoundary = greenUnsafe ||
      (!isRedClearanceSafeSegment(start, end, clearance) &&
        getZoneSegmentDistance(boundary, start, end) <= PLAYER_RED_ROUTE_RANGE);
    if (nearBoundary) {
      rings.push({ ...GREEN_SHIELD_RING, zone: boundary });
      redPathStats.greenRouteCount += 1;
      redPathStats.lastGreenNodes = getRedZoneContourNodes(boundary, clearance, GREEN_SHIELD_RING).length;
    }
    return rings;
  }


  // A* 最短路：启发式取「到终点的直线距离」，可采纳且一致，因此结果与朴素 Dijkstra 完全一致
  // （同长度最优解之间的并列取舍可能不同）。节点数增长到 300+ 后，朴素 O(n²) 全图松弛会成为
  // 单次移动指令的主要卡顿来源，A* 只展开真正落在贴边绕行走廊内的节点，并利用已找到的完整路径
  // 长度作为上界剪掉不可能更优的分支，开销随之下降一个量级。
  // segmentSafe 供盾判定复用：默认仍是红区判定，因此现有调用点逐位不变
  function findShortestClearancePath(
    nodes,
    clearance = PLAYER_RED_ZONE_CLEARANCE,
    strict = false,
    upperBound = Infinity,
    segmentSafe = isRedClearanceSafeSegment
  ) {
    const count = nodes.length;
    const endIndex = count - 1;
    const end = nodes[endIndex];
    const heuristic = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const dx = nodes[i].x - end.x;
      const dy = nodes[i].y - end.y;
      heuristic[i] = Math.sqrt(dx * dx + dy * dy);
    }
    const distances = new Array(count).fill(Infinity);
    const previous = new Array(count).fill(-1);
    const visited = new Array(count).fill(false);
    distances[0] = 0;
    // 已找到的完整路径长度上界：任何 f = g + h 超过它的节点都不可能出现在最优解里。
    // 调用方若能先给出一条可行路线（沿红区轮廓行走的那条），就用它作为初始上界；否则这个上界
    // 在终点被松弛之前一直是无穷，剪枝完全失效，几乎每对节点都要跑一次线段净空判定。
    let best = upperBound;

    for (let step = 0; step < count; step++) {
      let current = -1;
      let currentScore = Infinity;
      for (let i = 0; i < count; i++) {
        if (visited[i]) continue;
        const score = distances[i] + heuristic[i];
        if (score < currentScore) {
          currentScore = score;
          current = i;
        }
      }
      if (current < 0 || currentScore > best || !Number.isFinite(distances[current])) break;
      visited[current] = true;
      if (current === endIndex) break;

      const currentDistance = distances[current];
      const currentX = nodes[current].x;
      const currentY = nodes[current].y;
      for (let next = 0; next < count; next++) {
        if (visited[next] || next === current) continue;
        // 先用平方距离做无开方的前置排除，绝大多数节点对在这里就被挡掉
        const limit = distances[next] - currentDistance;
        if (limit <= 0) continue;
        const dx = nodes[next].x - currentX;
        const dy = nodes[next].y - currentY;
        const squared = dx * dx + dy * dy;
        if (squared >= limit * limit) continue;
        const distance = currentDistance + Math.sqrt(squared);
        if (distance + heuristic[next] > best) continue;
        if (!segmentSafe(nodes[current], nodes[next], clearance, strict)) continue;
        distances[next] = distance;
        previous[next] = current;
        if (next === endIndex && distance < best) best = distance;
      }
    }

    if (!Number.isFinite(distances[endIndex])) return null;
    const path = [];
    for (let index = endIndex; index > 0; index = previous[index]) {
      if (index < 0) return null;
      path.unshift(nodes[index]);
    }
    return path.length ? path : null;
  }


  // 单个红区环上的一段贴边行走：在环上挑一对「起点可安全直达」「终点可安全直达」的采样点，
  // 取 起点连线 + 沿环弧长 + 终点连线 最小的一对，返回途中经过的环上节点。
  // 环上相邻采样点之间的弦基本已由轮廓节点生成过程修复为安全，行走段只对实际走过的那几段
  // 复用（带记忆化的）净空判定兜底，遇到断口直接放弃这个环。
  // 候选点按「起点到该点 + 该点到终点」的直线距离升序评估：任意含该点的方案得分都不小于这个
  // 下界（弧长不短于弦长），一旦下界追平当前最优就无需再看后面的候选点——实测把每环上千次
  // 线段净空查询压到几十次。
  function getRingWalkLeg(start, end, clearance, ring, segmentSafe = isRedClearanceSafeSegment) {
    const count = ring.length;
    if (count < 2) return null;
    const order = new Array(count);
    for (let i = 0; i < count; i++) {
      const point = ring[i];
      order[i] = {
        index: i,
        lowerBound: Phaser.Math.Distance.Between(start.x, start.y, point.x, point.y) +
          Phaser.Math.Distance.Between(point.x, point.y, end.x, end.y)
      };
    }
    order.sort((a, b) => a.lowerBound - b.lowerBound);
    const enter = [];
    const exit = [];
    let bestScore = Infinity;
    const candidateLimit = Math.min(count, PLAYER_RED_WALK_LEG_CANDIDATE_LIMIT);
    for (let n = 0; n < candidateLimit; n++) {
      const candidate = order[n];
      // 弧长不短于弦长：任何用到这个候选点的方案得分都不小于它的直线下界，
      // 一旦下界追平当前最优，后面的候选点都不可能更优
      if (candidate.lowerBound >= bestScore) break;
      const point = ring[candidate.index];
      const enterCost = segmentSafe(start, point, clearance)
        ? Phaser.Math.Distance.Between(start.x, start.y, point.x, point.y)
        : Infinity;
      const exitCost = segmentSafe(point, end, clearance)
        ? Phaser.Math.Distance.Between(end.x, end.y, point.x, point.y)
        : Infinity;
      if (Number.isFinite(enterCost)) enter.push({ index: candidate.index, cost: enterCost });
      if (Number.isFinite(exitCost)) exit.push({ index: candidate.index, cost: exitCost });
      if (enterCost + exitCost < bestScore) bestScore = enterCost + exitCost;
    }
    if (!enter.length || !exit.length) return null;
    const prefix = new Float64Array(count + 1);
    for (let i = 0; i < count; i++) {
      const next = ring[(i + 1) % count];
      prefix[i + 1] = prefix[i] + Phaser.Math.Distance.Between(ring[i].x, ring[i].y, next.x, next.y);
    }
    const total = prefix[count];
    let best = null;
    for (let a = 0; a < enter.length; a++) {
      for (let b = 0; b < exit.length; b++) {
        let forward = prefix[exit[b].index] - prefix[enter[a].index];
        if (forward < 0) forward += total;
        const score = enter[a].cost + Math.min(forward, total - forward) + exit[b].cost;
        if (!best || score < best.score) best = { score, a, b, forward };
      }
    }
    const from = enter[best.a].index;
    const to = exit[best.b].index;
    const direction = best.forward <= total - best.forward ? 1 : -1;
    // 环上相邻点之间的弦绝大多数已由轮廓生成过程修复为安全，但地图边界会把轮廓切成断口：
    // 红区贴到可行走区域外沿时，那一段轮廓整个落在可行走区域之外，会被滤掉并留下一条
    // 横穿红区的长弦。断口必须当成绕行的墙——走不过去的环不能拿来贴边，否则这条「贴边路线」
    // 会被当成可行路线直接返回，或当成上界误剪掉真正的最优解。
    const nodes = [];
    for (let index = from; ; index = (index + direction + count) % count) {
      const previous = nodes[nodes.length - 1];
      if (previous && !segmentSafe(previous, ring[index], clearance)) return null;
      nodes.push(ring[index]);
      if (index === to || nodes.length >= count) break;
    }
    return { nodes };
  }


  // 沿所有路线范围内红区轮廓行走的曲线路线：多个红区按离起点的远近依次贴边，
  // 每段都以最终终点为目标挑选入/出环点（所以每条使用的弦都经过安全校验，路径必然可行），
  // 行走段只走环上相邻采样点之间的安全弦。
  function getRedContourWalkPath(start, end, clearance, rings, segmentSafe = isRedClearanceSafeSegment) {
    if (!rings.length) return null;
    const ordered = rings.slice().sort((a, b) => getRingNearestDistance(a, start) - getRingNearestDistance(b, start));
    const path = [];
    let cursor = start;
    for (let n = 0; n < ordered.length; n++) {
      // 剩余这段直线本身已经净空安全时，再贴后面任何一个环都不可能更短：
      // 两块红区同时落在 PLAYER_RED_ROUTE_RANGE 内时，小环本可省去，这里直接收尾
      if (segmentSafe(cursor, end, clearance)) break;
      const leg = getRingWalkLeg(cursor, end, clearance, ordered[n], segmentSafe);
      if (!leg) continue;
      for (let i = 0; i < leg.nodes.length; i++) path.push(leg.nodes[i]);
      cursor = leg.nodes[leg.nodes.length - 1];
    }
    if (!path.length) return null;
    path.push(end);
    return path;
  }


  function getClearancePathCost(start, path) {
    let cost = 0;
    let previous = start;
    for (let i = 0; i < path.length; i++) {
      cost += Phaser.Math.Distance.Between(previous.x, previous.y, path[i].x, path[i].y);
      previous = path[i];
    }
    return cost;
  }


  // 曲线绕行路径：节点取所有路线范围内屏蔽环的等距轮廓采样点，
  // 任意两节点之间必须保持安全净空，用最短路保证沿轮廓安全侧抵达终点。
  // 红环与绿环共用这一份实现：routeRings 是环描述符数组，segmentSafe 是该环组合的线段判定
  function getContourRoutePath(start, end, clearance, routeRings, segmentSafe) {
    if (!isWalkable(start.x, start.y) || !isWalkable(end.x, end.y)) return null;
    if (!routeRings.length) return null;
    // 不按直线走廊裁剪节点：绕行所需的关键节点往往落在直线走廊之外
    // （例如贴着红区下沿绕过时，节点会超出直线 563 像素），裁剪会导致图断裂。
    const rings = [];
    const nodes = [];
    const seen = new Set();
    routeRings.forEach(ring => {
      const contour = getRedZoneContourNodes(ring.zone, clearance, ring);
      if (!contour.length) return;
      rings.push(contour);
      contour.forEach(point => {
        const key = `${Math.round(point.x * 4)}:${Math.round(point.y * 4)}`;
        if (seen.has(key)) return;
        seen.add(key);
        nodes.push(point);
      });
    });
    if (!nodes.length) return null;
    // 先按「沿所有绕行范围内轮廓贴边行走」给出一条可行路线：
    // 它是曲线绕行的直接答案，同时给出最优路径长度的上界，交给下面的搜索剪枝。
    const walkPath = getRedContourWalkPath(start, end, clearance, rings, segmentSafe);
    let upperBound = Infinity;
    if (walkPath && walkPath.length) {
      // 度量：贪心贴边路径长度（0 表示该路径不可用，即整环作废或存在断口）
      redPathStats.lastGreedyLen = getClearancePathCost(start, walkPath);
      if (isClearancePathSafe(start, walkPath, clearance, true, segmentSafe)) return walkPath;
      // 严格校验没过时，只要松弛口径下成立就仍可作为搜索上界（上界必须来自真实可行路径）
      if (isClearancePathSafe(start, walkPath, clearance, false, segmentSafe)) {
        upperBound = getClearancePathCost(start, walkPath);
      }
    } else {
      redPathStats.lastGreedyLen = 0;
    }
    const graph = [start, ...nodes, end];
    const relaxedPath = findShortestClearancePath(graph, clearance, false, upperBound, segmentSafe);
    if (relaxedPath && relaxedPath.length) {
      if (isClearancePathSafe(start, relaxedPath, clearance, true, segmentSafe)) return relaxedPath;
      const strictPath = findShortestClearancePath(graph, clearance, true, Infinity, segmentSafe);
      if (strictPath && strictPath.length) return strictPath;
      return relaxedPath;
    }
    return null;
  }


  // 红区曲线绕行路径（敌军与既有我方兜底路径在用）
  function getRedContourRoutePath(start, end, clearance = PLAYER_RED_ZONE_CLEARANCE) {
    return getContourRoutePath(
      start, end, clearance,
      getRedRouteZones(start, end).map(zone => ({ ...RED_SHIELD_RING, zone })),
      isRedClearanceSafeSegment
    );
  }


  // 盾曲线绕行路径（我方单位）：同时绕红区与绿屏蔽区
  function getShieldContourRoutePath(start, end, clearance = PLAYER_RED_ZONE_CLEARANCE) {
    return getContourRoutePath(
      start, end, clearance, getShieldRouteRings(start, end, clearance), isShieldClearanceSafeSegment
    );
  }


  // 我方单位寻路：全程用「盾」口径——同时判定红区与绿色屏蔽区的净空。
  // 结构沿用原有红区版本：脱离安全带 → 直线 → 沿轮廓绕行 → 兜底重规划。
  // 轮廓绕行分两段走：先按纯红区口径跑一遍（与改动前逐位一致），只有它确实切进绿屏蔽区时
  // 才升级到「红环 + 绿环」的盾路由。纯红区场景因此逐位保持既有路径，
  // 绿环（一百多个节点）也只在真正需要时才进入 A* 图
  function getShortestPlayerPath(start, end, allowEscape = true) {
    if (!isWalkable(start.x, start.y) || !isWalkable(end.x, end.y)) return null;
    // 起点已被安全带包住（例如屏蔽区被改到脚下）：先脱离安全带，再从脱离点重新规划
    if (allowEscape && !isShieldClearanceSafePoint(start.x, start.y, PLAYER_RED_ZONE_CLEARANCE)) {
      const escape = correctPointIntoShieldClearance(start, PLAYER_RED_ZONE_CLEARANCE);
      if (Phaser.Math.Distance.Between(start.x, start.y, escape.x, escape.y) <= 0.05) return null;
      const remaining = getShortestPlayerPath(escape, end, false);
      return remaining && remaining.length ? [escape, ...remaining] : [escape];
    }
    // 终点本身不满足盾净空时直接判无路：线段到边界的距离不会超过端点到边界的距离，
    // 因此任何以它为末端的线段都不可能安全。少了这一步，注定失败的规划仍会在
    // 两百多个候选节点上跑一遍完整的 A*（贴绿边的图规模最大时单次可达数十毫秒）
    if (!isShieldClearanceSafePoint(end.x, end.y, PLAYER_RED_ZONE_CLEARANCE - RED_CLEARANCE_PATH_SLACK)) {
      return null;
    }
    // 直线既不穿越红区、也不侵入安全带、又不切进绿屏蔽区时，直线本身就是最短路径
    if (isShieldClearanceSafeSegment(start, end, PLAYER_RED_ZONE_CLEARANCE, true)) return [end];
    // 第一段：纯红区口径的轮廓绕行。它同时满足盾净空时直接采用（纯红区场景与改动前逐位一致）
    const redPath = getRedContourRoutePath(start, end, PLAYER_RED_ZONE_CLEARANCE);
    if (redPath && redPath.length &&
      isClearancePathSafe(start, redPath, PLAYER_RED_ZONE_CLEARANCE, true, isShieldClearanceSafeSegment)) {
      return redPath;
    }
    // 第二段：红区口径的路线会切进绿屏蔽区，改用盾路由（红环 + 绿环，能沿绿边界绕行）
    const contourPath = getShieldContourRoutePath(start, end, PLAYER_RED_ZONE_CLEARANCE);
    if (contourPath && contourPath.length) return contourPath;
    // 两条轮廓路线都跑过了，兜底方案跳过重复的那一遍
    const fallbackPath = getShortestShieldedPath(start, end, false, PLAYER_RED_ZONE_CLEARANCE, true);
    if (fallbackPath && fallbackPath.length &&
      isClearancePathSafe(start, fallbackPath, PLAYER_RED_ZONE_CLEARANCE, true, isShieldClearanceSafeSegment)) {
      return fallbackPath;
    }
    return null;
  }

  function getShieldSlideRings(includeGreen) {
    if (S.shieldSlideRingsCache.version !== S.collisionRegionVersion) {
      S.shieldSlideRingsCache = { version: S.collisionRegionVersion, red: null, shield: null };
    }
    const key = includeGreen ? 'shield' : 'red';
    let rings = S.shieldSlideRingsCache[key];
    if (!rings) {
      rings = collisionRegions.redForbiddenZones.map(zone => ({ ...RED_SHIELD_RING, zone }));
      if (includeGreen) {
        rings.push({ ...GREEN_SHIELD_RING, zone: collisionRegions.walkableBoundary, gated: true });
      }
      S.shieldSlideRingsCache[key] = rings;
    }
    return rings;
  }


  // 沿屏蔽环等距轮廓滑动：以环的安全侧外沿作为最终判断依据，只朝更靠近目标的一侧前进。
  // 转向点比安全带再外扩 PLAYER_RED_STEER_BIAS，抵消轮廓折线弦长带来的亚像素内切，
  // 保证贴边行走时的实际净空不会跌破安全带宽度。
  // 红环与绿环共用这一份实现：环描述符给出多边形、偏移符号与净空判定，其余几何完全一致
  function slideAlongShieldContour(origin, waypoint, budget, clearance, rings, segmentSafe) {
    // 度量：本函数是逐帧逐单位调用量最大的一处，单独统计调用次数与耗时
    const slideStartedAt = performance.now();
    redPathStats.slideCalls += 1;
    const walkClearance = clearance + PLAYER_RED_STEER_BIAS;
    const slideRange = clearance + PLAYER_RED_SLIDE_RANGE;
    let best = null;
    rings.forEach(ring => {
      // 前置门：环轮廓点到原点的距离恒不小于「原点到环多边形的距离 − 偏移宽度」，
      // 所以原点到环多边形已超过 偏移宽度 + 滑动范围 时，最近轮廓点必然落在滑动范围之外。
      // 查询带上界，命中即提前退出，代价远低于对数百个轮廓点逐一求距离
      if (ring.gated &&
        getZoneNearestEdge(ring.zone, origin.x, origin.y, walkClearance + slideRange).distance >
          walkClearance + slideRange) return;
      const entry = getRedZoneContourEntry(ring.zone, walkClearance, ring.offsetSign, ring.pointSafe, ring.correct);
      const contour = entry.points;
      if (contour.length < 2) return;
      let nearestIndex = -1;
      let nearestDistance = Infinity;
      contour.forEach((point, index) => {
        const distance = Phaser.Math.Distance.Between(origin.x, origin.y, point.x, point.y);
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestIndex = index;
        }
      });
      if (nearestIndex < 0 || nearestDistance > slideRange) return;
      // 起点只要求满足真实安全带宽度：轮廓点本身按 walkClearance（再外扩一个偏置）生成，
      // 弦长误差由该偏置抵消。若这里也用 walkClearance 判定，站位刚好落在安全带边界上时
      // 会被误判为不安全，单位只能逐帧空转、蹭着红区慢慢挪动
      if (!segmentSafe(
        origin, contour[nearestIndex], walkClearance, false, PLAYER_RED_STEER_BIAS + RED_CLEARANCE_TOLERANCE
      )) return;
      if (!best || nearestDistance < best.distance) {
        best = { entry, contour, nearestIndex, distance: nearestDistance };
      }
    });
    if (!best) {
      redPathStats.slideMs += performance.now() - slideStartedAt;
      return null;
    }

    const contour = best.contour;
    const arcPrefix = best.entry.arcPrefix;
    const count = contour.length;
    // 起点投影到轮廓折线上（而不是吸附到最近的采样点）：采样间距 24 像素，
    // 若每帧都吸附回采样点，本帧的沿边推进量会被吸附位移抵消，单位只会在采样点附近来回抖动
    const projection = projectPointOnContour(origin, contour);
    // 绕行方向按「沿轮廓走到离终点最近的那一点，哪边弧长更短」判定：
    // 只看相邻采样点会随单位越过目标垂足来回翻转，同样会让单位贴边原地踏步
    const targetIndex = getNearestContourIndex(contour, waypoint);
    const forwardLength = getContourArcLength(contour, projection.index, targetIndex, 1, arcPrefix);
    const backwardLength = getContourArcLength(contour, projection.index, targetIndex, -1, arcPrefix);
    const direction = backwardLength < forwardLength * (1 - PLAYER_RED_SLIDE_HYSTERESIS) ? -1 : 1;

    let index = direction > 0 ? (projection.index + 1) % count : projection.index;
    let current = { x: projection.x, y: projection.y };
    let remaining = budget;
    for (let step = 0; step <= count && remaining > 0.0001; step++) {
      const target = contour[index];
      const distance = Phaser.Math.Distance.Between(current.x, current.y, target.x, target.y);
      if (distance > remaining) {
        const ratio = remaining / distance;
        current = {
          x: current.x + (target.x - current.x) * ratio,
          y: current.y + (target.y - current.y) * ratio
        };
        break;
      }
      if (!segmentSafe(current, target, walkClearance)) break;
      current = target;
      remaining -= distance;
      index = (index + direction + count) % count;
    }
    if (Phaser.Math.Distance.Between(origin.x, origin.y, current.x, current.y) < 0.2) {
      redPathStats.slideMs += performance.now() - slideStartedAt;
      return null;
    }
    const slid = segmentSafe(
      origin, current, walkClearance, false, PLAYER_RED_STEER_BIAS + RED_CLEARANCE_TOLERANCE
    ) ? current : null;
    redPathStats.slideMs += performance.now() - slideStartedAt;
    if (slid) redPathStats.slideHits += 1;
    return slid;
  }


  // 红区贴边滑动：既有行为，环列表只含红环
  function slideAlongRedContour(origin, waypoint, budget, clearance = PLAYER_RED_ZONE_CLEARANCE) {
    return slideAlongShieldContour(
      origin, waypoint, budget, clearance, getShieldSlideRings(false), isRedClearanceSafeSegment
    );
  }


  // 盾贴边滑动：同时沿红环与绿环贴边（我方单位用）
  function slideAlongShieldRing(origin, waypoint, budget, clearance = PLAYER_RED_ZONE_CLEARANCE) {
    return slideAlongShieldContour(
      origin, waypoint, budget, clearance, getShieldSlideRings(true), isShieldClearanceSafeSegment
    );
  }


  // 逐帧转向：先直行，其次推离到安全带之外，最后沿轮廓滑动；都不行则交给上层重新规划。
  // 红区与绿区共用这一份实现，差别全部收进四个策略参数（点判定 / 推离 / 线段判定 / 贴边滑动）
  function getSteeringTargetWithin(origin, waypoint, budget, clearance, pointSafe, correct, segmentSafe, slide) {
    if (!pointSafe(origin.x, origin.y, clearance)) {
      // 自身已在安全带内：优先朝安全带外脱离，避免任意朝向都被判定为不安全而永久卡住
      const escape = correct(origin, clearance + PLAYER_RED_STEER_BIAS);
      const distance = Phaser.Math.Distance.Between(origin.x, origin.y, escape.x, escape.y);
      if (distance > 0.05) {
        const ratio = Math.min(1, budget / distance);
        return {
          x: origin.x + (escape.x - origin.x) * ratio,
          y: origin.y + (escape.y - origin.y) * ratio
        };
      }
    }
    const totalDistance = Phaser.Math.Distance.Between(origin.x, origin.y, waypoint.x, waypoint.y);
    if (totalDistance <= budget) {
      const arrival = { x: waypoint.x, y: waypoint.y };
      if (segmentSafe(origin, arrival, clearance)) return arrival;
    }
    const ratio = totalDistance > 0 ? Math.min(1, budget / totalDistance) : 0;
    const desired = {
      x: origin.x + (waypoint.x - origin.x) * ratio,
      y: origin.y + (waypoint.y - origin.y) * ratio
    };
    if (segmentSafe(origin, desired, clearance)) return desired;
    const corrected = correct(desired, clearance);
    if (Phaser.Math.Distance.Between(desired.x, desired.y, corrected.x, corrected.y) > 0.05 &&
      segmentSafe(origin, corrected, clearance)) {
      return corrected;
    }
    return slide(origin, waypoint, budget, clearance);
  }


  // 盾转向：我方单位用，同时判定红、绿两种屏蔽区并沿两者的轮廓贴边
  function getShieldSteeringTarget(origin, waypoint, budget, clearance = PLAYER_RED_ZONE_CLEARANCE) {
    return getSteeringTargetWithin(
      origin, waypoint, budget, clearance,
      isShieldClearanceSafePoint, correctPointIntoShieldClearance, isShieldClearanceSafeSegment, slideAlongShieldRing
    );
  }


  function getShortestShieldedPath(
    start,
    end,
    redZoneRequired = false,
    clearance = ENEMY_RED_ZONE_CLEARANCE,
    skipContourRoute = false
  ) {
    // 红区等距轮廓是首选绕行曲线；沿红区无法通行时才退回绿色边界方案。
    // skipContourRoute 供已经用同样参数跑过一遍轮廓规划的调用方使用：
    // 该函数是纯函数，同参数必然得到同一个结论，重跑一次（两轮 A* + 整路径复核）没有意义
    if (!skipContourRoute) {
      const contourPath = getRedContourRoutePath(start, end, clearance);
      if (contourPath && contourPath.length && isClearancePathSafe(start, contourPath, clearance)) {
        return contourPath;
      }
    }
    if (redZoneRequired) {
      // 命中任意红色区域时，禁止退回直线路径或绿色边界路径。
      return null;
    }
    const fallbackPaths = [
      getReplannedPath(start, end, false, getNearestEdgeCandidates(start, end)),
      ...getCurvedEdgePaths(start, end, [collisionRegions.walkableBoundary], 30, clearance)
    ].filter(Boolean);
    if (!fallbackPaths.length) return null;
    return getShortestPathByLength(fallbackPaths, start);
  }


  function getShortestPathByLength(paths, start) {
    const lengthOf = path => path.reduce((sum, point, index) => {
      const previous = index === 0 ? start : path[index - 1];
      return sum + Phaser.Math.Distance.Between(previous.x, previous.y, point.x, point.y);
    }, 0);
    return paths.reduce((shortest, path) =>
      !shortest || lengthOf(path) < lengthOf(shortest) ? path : shortest, null);
  }


  // 路线节点的可行走结论：节点坐标在初始化后就固定不变，只有碰撞区域被编辑（版本号变化）
  // 时才需要重算。推进判定每帧都要顺着路线找第一个可走节点，这里能省掉绝大部分重复查询
  function isRouteNodeWalkable(node) {
    if (node.walkableVersion !== S.collisionRegionVersion) {
      node.walkableVersion = S.collisionRegionVersion;
      node.walkableValue = isWalkable(node.x, node.y);
    }
    return node.walkableValue;
  }


  // 点击屏蔽区时的终点判定：把行动终点定在「离点击点最近的那条屏蔽区边缘」上。
  // 红色屏蔽区取自身边缘外推 38 像素（结果是贴边行走但不卡进屏蔽区），
  // 绿色隔离区取可行动区轮廓内侧（轮廓内侧就是可站立的地面）。
  // 点到哪块屏蔽区就贴哪块：点进红区时只在该红区边缘上找落点，不再和可行动区轮廓混选
  function getShieldEdgeDestination(x, y) {
    const offset = PLAYER_RED_ZONE_CLEARANCE + RED_CONTOUR_MARGIN;
    let best = null;
    collisionRegions.redForbiddenZones.forEach(zone => {
      if (!pointInPolygon(x, y, zone)) return;
      const feature = getPolygonNearestEdgePoint(zone, x, y);
      let seat = null;
      if (feature) {
        const point = correctPointOutOfRedClearance(feature.point, offset);
        if (isWalkable(point.x, point.y) && isRedClearanceSafePoint(point.x, point.y)) {
          seat = { point, distance: Math.hypot(point.x - x, point.y - y) };
        }
      }
      if (!seat) {
        const fallback = findRedShieldSeat(zone, x, y, offset);
        if (fallback) seat = { point: fallback, distance: Math.hypot(fallback.x - x, fallback.y - y) };
      }
      if (seat && (!best || seat.distance < best.distance)) best = seat;
    });
    if (best) return best.point;
    // 点击绿色隔离区（可行动区轮廓之外）：终点定在轮廓内侧、且离边界留足绿净空的最近落点
    const walkedEdge = getPolygonNearestEdgePoint(collisionRegions.walkableBoundary, x, y);
    if (walkedEdge) {
      const point = correctPointIntoGreenClearance(walkedEdge.point, offset);
      if (isWalkable(point.x, point.y) && isGreenClearanceSafePoint(point.x, point.y)) return point;
    }
    return findWalkableShieldSeat(x, y);
  }


  // 执行期的路径节点收敛：从路径尾部往前找第一个「当前位置可安全直达」的节点，
  // 丢掉它之前的全部节点并返回它（路径末节点就是最终终点，因此最坏情况收敛到终点）。
  // 用于转向失败时的兜底：原先直接改为朝最终终点求转向，而绕行途中最终终点位于轮廓的另一侧，
  // 方向与当前拐点相反，会把单位往回拽、形成贴边来回横跳；改为先收敛到可直达的路径节点，
  // 方向始终沿路径前进。返回 null 表示路径为空或没有任何可直达节点
  function getReachablePathNode(squad, origin, clearance = PLAYER_RED_ZONE_CLEARANCE) {
    const path = squad.detourPath;
    for (let index = path.length - 1; index >= 0; index--) {
      if (isShieldClearanceSafeSegment(origin, path[index], clearance)) {
        if (index > 0) path.splice(0, index);
        return path[0];
      }
    }
    return null;
  }

export { resetRedPathStats, recordRedPlan, isRedZonePathCrossed, isRedZoneCrossedByPath, isSafePath, isClearancePathSafe, getDetourCandidates, getReplannedPath, canReachDetourPoint, getShieldRouteRings, findShortestClearancePath, getRingWalkLeg, getRedContourWalkPath, getClearancePathCost, getContourRoutePath, getRedContourRoutePath, getShieldContourRoutePath, getShortestPlayerPath, getShieldSlideRings, slideAlongShieldContour, slideAlongRedContour, slideAlongShieldRing, getSteeringTargetWithin, getShieldSteeringTarget, getShortestShieldedPath, getShortestPathByLength, isRouteNodeWalkable, getShieldEdgeDestination, getReachablePathNode };
