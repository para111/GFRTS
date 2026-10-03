// ============================================================
// wg_game 模块化拆分 —— zones.js
// 职责: 红绿屏蔽区与碰撞区域：净空判定/纠正/缓存/网格
// 来源: wg_game.js 语句区间 349-8585（自动拆分，勿手工重排语句顺序）
// ============================================================

import { S } from './S.js';
import { distanceToSegment, getOutwardNormal, pointInPolygon, samplePolygonBoundaryOrdered, segmentsIntersect } from './geometry.js';
import { drawMapGuides } from './hud.js';
import { isRedZoneCrossedByPath, isRedZonePathCrossed } from './pathfind.js';
import { GREEN_SHIELD_RING, PLAYER_GREEN_ZONE_CLEARANCE, PLAYER_RED_ARC_STEP, PLAYER_RED_CONTOUR_REPAIR_DEPTH, PLAYER_RED_CONTOUR_STEP, PLAYER_RED_CORRECTION_ITERATIONS, PLAYER_RED_ROUTE_RANGE, PLAYER_RED_STEER_BIAS, PLAYER_RED_WALKABLE_SAMPLE_MAX, PLAYER_RED_WALKABLE_SAMPLE_STEP, PLAYER_RED_ZONE_CLEARANCE, PLAYER_SQUAD_EDGE_RANGE, POINT_QUERY_AXIS_MAX, POINT_QUERY_AXIS_MIN, POINT_QUERY_RESULT_SHIFT, POINT_QUERY_SCALE, POINT_QUERY_WALKABLE, POINT_QUERY_WALKABLE_RESULT, RED_CLEARANCE_PATH_SLACK, RED_CLEARANCE_TOLERANCE, RED_CONTOUR_MARGIN, RED_SHIELD_RING, RED_SHIELD_SCAN_STEP, RED_ZONE_GRID_CELL, WALKABLE_SHIELD_SCAN_STEP, WORLD_HEIGHT, WORLD_WIDTH, clearanceQueryBits, collisionCrossProbeEnd, collisionCrossProbeStart, collisionGraphics, collisionRegions, greenSegmentMemos, mapOverlayLayer, playerSquads, pointQueryCache, redContourCache, redContourNodeCache, redZoneBoundsCache, routeGraphics, segmentZoneMemos } from './state.js';


  // 坐标 → 整数键：x 放高位、y 放低 16 位，两个轴都夹取到 16 位有符号范围。
  // 夹取只会把 ±4096 像素以外的点并到同一个键上，而那些点必然在地图外（不可行走、不净空），
  // 共用一条记录不会改变结论，键却能始终压在 SMI 范围内
  function getPointQueryKey(x, y) {
    const qx = Math.min(POINT_QUERY_AXIS_MAX, Math.max(POINT_QUERY_AXIS_MIN, Math.round(x * POINT_QUERY_SCALE)));
    const qy = Math.min(POINT_QUERY_AXIS_MAX, Math.max(POINT_QUERY_AXIS_MIN, Math.round(y * POINT_QUERY_SCALE)));
    return qx * 65536 + qy;
  }


  // 净空宽度只有固定几种取值（安全带、安全带 + 亚像素转向偏置等），惰性各分配一位；
  // 位用尽时返回 0，调用方据此跳过缓存（直接计算），结论不受影响。
  // kind 区分红区/绿区两类净空查询（见上），键拼成字符串以免两类互相覆盖
  function getClearanceQueryBit(clearance, kind = 'red') {
    const cacheKey = kind + clearance;
    let bit = clearanceQueryBits.get(cacheKey);
    if (bit === undefined) {
      if (S.nextClearanceQueryBit > 1 << 14) return 0;
      bit = S.nextClearanceQueryBit;
      S.nextClearanceQueryBit <<= 1;
      clearanceQueryBits.set(cacheKey, bit);
    }
    return bit;
  }


  function getCollisionSegmentBounds() {
    if (S.collisionSegmentBoundsCache && S.collisionSegmentBoundsVersion === S.collisionRegionVersion) {
      return S.collisionSegmentBoundsCache;
    }
    S.collisionSegmentBoundsCache = collisionRegions.lineSegments.map(segment => ({
      minX: Math.min(segment.start.x, segment.end.x),
      maxX: Math.max(segment.start.x, segment.end.x),
      minY: Math.min(segment.start.y, segment.end.y),
      maxY: Math.max(segment.start.y, segment.end.y)
    }));
    S.collisionSegmentBoundsVersion = S.collisionRegionVersion;
    return S.collisionSegmentBoundsCache;
  }

  function clearRedQueryCaches() {
    pointQueryCache.clear();
    S.redQueryFrame += 1;
  }

  function isRedClearanceZonesSatisfied(from, to, clearance, slack) {
    let bySlack = segmentZoneMemos.get(clearance);
    if (!bySlack) {
      bySlack = new Map();
      segmentZoneMemos.set(clearance, bySlack);
    }
    let memo = bySlack.get(slack);
    if (!memo) {
      memo = new WeakMap();
      bySlack.set(slack, memo);
    }
    let byTo = memo.get(from);
    if (byTo) {
      const cached = byTo.get(to);
      if (cached !== undefined) return cached;
    } else {
      byTo = new WeakMap();
      memo.set(from, byTo);
    }
    const satisfied = collisionRegions.redForbiddenZones.every(zone => {
      // 线段到红区包围盒的间距是真实间距的下界：整块红区不可能更近时直接跳过
      if (getSegmentDistanceLowerBound(from, to, getZoneBounds(zone)) > clearance) return true;
      return getZoneSegmentDistance(zone, from, to) >= clearance - slack;
    });
    byTo.set(to, satisfied);
    return satisfied;
  }

  function isGreenClearanceSatisfied(from, to, clearance, slack) {
    let bySlack = greenSegmentMemos.get(clearance);
    if (!bySlack) {
      bySlack = new Map();
      greenSegmentMemos.set(clearance, bySlack);
    }
    let memo = bySlack.get(slack);
    if (!memo) {
      memo = new WeakMap();
      bySlack.set(slack, memo);
    }
    let byTo = memo.get(from);
    if (byTo) {
      const cached = byTo.get(to);
      if (cached !== undefined) return cached;
    } else {
      byTo = new WeakMap();
      memo.set(from, byTo);
    }
    // 与红区相反：绿边界禁的是「多边形外侧」，所以只要线段到边界折线的距离不小于净空即可。
    // 注意该距离是无符号的——线段两端在外侧时它同样是正数，因此「在内侧」必须由调用方
    // 用 isWalkable（内含 pointInPolygon）另行保证；两端在内、中间穿出凹口的弦会在
    // 交点处距离降到 0，这里能正确判否。
    //
    // 先用「线段包围盒到每条绿边界边包围盒」的最小距离做充分条件：包围盒距离是真实距离的
    // 下界，它已经大于净空时线段必然安全。绿多边形占全图一半、内部线段离边界可达数百像素，
    // 这一支把它们从「逐边精确求距 + 两次昂贵的端点最近边查询」里摘出来；贴着绿边界的线段
    // 通常在头几次比较就退出循环，代价只有一两次比较。这一段是盾判定的性能命门：
    // 逐帧转向、贴边滑动、A* 松弛都会调用它，而调用方的坐标对象每帧都是新建的，
    // 记忆化在这些场合基本不命中
    const boundary = collisionRegions.walkableBoundary;
    const edges = getZoneEdgeGrid(boundary).edges;
    const minX = Math.min(from.x, to.x);
    const maxX = Math.max(from.x, to.x);
    const minY = Math.min(from.y, to.y);
    const maxY = Math.max(from.y, to.y);
    let lowerBound = Infinity;
    for (let i = 0; i < boundary.length; i++) {
      const offsetX = Math.max(0, Math.max(edges[i * 4] - maxX, minX - edges[i * 4 + 2]));
      const offsetY = Math.max(0, Math.max(edges[i * 4 + 1] - maxY, minY - edges[i * 4 + 3]));
      const distance = Math.hypot(offsetX, offsetY);
      if (distance < lowerBound) lowerBound = distance;
      if (lowerBound <= clearance) break;
    }
    const satisfied = lowerBound > clearance
      ? true
      : getZoneSegmentDistance(boundary, from, to) >= clearance - slack;
    byTo.set(to, satisfied);
    return satisfied;
  }


  function editCollisionRegion(regionName, points) {
    const region = collisionRegions[regionName];
    if (!region || !Array.isArray(points)) {
      throw new Error('碰撞区域必须使用已知名称，并提供数组数据');
    }
    if (regionName === 'lineSegments') {
      if (points.some(segment =>
        !segment ||
        !segment.start ||
        !segment.end ||
        !Number.isFinite(segment.start.x) ||
        !Number.isFinite(segment.start.y) ||
        !Number.isFinite(segment.end.x) ||
        !Number.isFinite(segment.end.y)
      )) {
        throw new Error('线段碰撞区必须包含 start、end 坐标');
      }
    } else if (points.length < 3) {
      throw new Error('多边形碰撞区域至少需要 3 个坐标点');
    }
    if (regionName !== 'lineSegments' && Array.isArray(points[0]) && points.some(polygon => !Array.isArray(polygon) || polygon.length < 3)) {
      throw new Error('多个碰撞区域必须是由多边形坐标数组组成');
    }
    region.splice(0, region.length, ...points);
    invalidateRedZoneCaches();
    playerSquads.forEach(squad => {
      squad.replanKey = null;
    });
    if (mapOverlayLayer && collisionGraphics && routeGraphics) drawMapGuides();
  }


  function isZoneBlocked(x, y) {
    // 红色屏蔽区：先按包围盒 O(1) 排除（点不可能落在包围盒之外的多边形里），再做射线法
    const zones = collisionRegions.redForbiddenZones;
    for (let i = 0; i < zones.length; i++) {
      const zone = zones[i];
      const bounds = getZoneBounds(zone);
      if (x < bounds.minX || x > bounds.maxX || y < bounds.minY || y > bounds.maxY) continue;
      if (pointInPolygon(x, y, zone)) return true;
    }
    // 橙色隔离线：点到线段的距离不小于点到「线段包围盒外扩半厚」的距离，因此可以同样快速排除
    const segments = collisionRegions.lineSegments;
    const segmentBounds = getCollisionSegmentBounds();
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      const thickness = segment.thickness || 10;
      const radius = thickness / 2;
      const box = segmentBounds[i];
      if (x < box.minX - radius || x > box.maxX + radius ||
          y < box.minY - radius || y > box.maxY + radius) continue;
      if (distanceToSegment(x, y, segment.start, segment.end) <= radius) return true;
    }
    return false;
  }


  // 橙色隔离线的穿越判定：与红区无关，红区净空判定也要单独用到它
  function isCollisionLineSegmentCrossed(startX, startY, endX, endY) {
    const segments = collisionRegions.lineSegments;
    if (!segments.length) return false;
    collisionCrossProbeStart.x = startX;
    collisionCrossProbeStart.y = startY;
    collisionCrossProbeEnd.x = endX;
    collisionCrossProbeEnd.y = endY;
    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      if (segmentsIntersect(collisionCrossProbeStart, collisionCrossProbeEnd, segment.start, segment.end)) {
        return true;
      }
    }
    return false;
  }


  function isCollisionLineCrossed(startX, startY, endX, endY) {
    if (isCollisionLineSegmentCrossed(startX, startY, endX, endY)) return true;
    return isRedZonePathCrossed(startX, startY, endX, endY);
  }


  // --------------------------------------------------
  // 红区绕行几何：38 像素等距轮廓、净空判定、推离与沿红区滑动
  // --------------------------------------------------
  // 包围盒 / 轮廓缓存与版本号已在文件前部的碰撞查询缓存区声明

  // 碰撞区域被改写后失效，保证轮廓、包围盒与边格子桶不会残留旧数据
  function invalidateRedZoneCaches() {
    S.collisionRegionVersion += 1;
    redContourCache.clear();
    // redContourNodeCache 是 WeakMap（无 clear，原版同款潜伏笔误）：
    // 键为 zone 多边形对象，editCollisionRegion 整体替换后旧条目自动 GC；
    // 内层 Map 键含 collisionRegionVersion，版本自增后旧条目自然失配，无需也不可 clear
    segmentZoneMemos.clear();
    greenSegmentMemos.clear();
    S.walkableSegmentMemos = new WeakMap();
    S.redZoneEdgeGridCache = new WeakMap();
    S.collisionSegmentBoundsCache = null;
  }


  // 追加一块红色屏蔽区（WG2 大桥坍塌专用；WG 流程不调用，行为无变化）。
  // 与 editCollisionRegion 相同的失效与重规划逻辑，只是增量追加而不是整体替换
  function appendRedForbiddenZone(polygon) {
    if (!Array.isArray(polygon) || polygon.length < 3) {
      throw new Error('追加屏蔽区至少需要 3 个坐标点');
    }
    collisionRegions.redForbiddenZones.push(polygon);
    invalidateRedZoneCaches();
    playerSquads.forEach(squad => {
      squad.replanKey = null;
    });
    if (mapOverlayLayer && collisionGraphics && routeGraphics) drawMapGuides();
  }


  function getZoneBounds(zone) {
    const cached = redZoneBoundsCache.get(zone);
    if (cached && cached.version === S.collisionRegionVersion) return cached.bounds;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    zone.forEach(point => {
      if (point.x < minX) minX = point.x;
      if (point.y < minY) minY = point.y;
      if (point.x > maxX) maxX = point.x;
      if (point.y > maxY) maxY = point.y;
    });
    const bounds = { minX, minY, maxX, maxY };
    redZoneBoundsCache.set(zone, { version: S.collisionRegionVersion, bounds });
    return bounds;
  }


  // 包围盒间距是真实间距的下界，可安全地用于快速排除不相干的红区
  function getSegmentDistanceLowerBound(from, to, bounds) {
    const minX = Math.min(from.x, to.x);
    const maxX = Math.max(from.x, to.x);
    const minY = Math.min(from.y, to.y);
    const maxY = Math.max(from.y, to.y);
    const dx = Math.max(0, Math.max(bounds.minX - maxX, minX - bounds.maxX));
    const dy = Math.max(0, Math.max(bounds.minY - maxY, minY - bounds.maxY));
    return Math.hypot(dx, dy);
  }


  // 点到包围盒的间距同样是点到该区域真实间距的下界，用于跳过不可能更近的区域
  function getPointBoundsLowerBound(x, y, bounds) {
    const dx = Math.max(0, Math.max(bounds.minX - x, x - bounds.maxX));
    const dy = Math.max(0, Math.max(bounds.minY - y, y - bounds.maxY));
    return Math.hypot(dx, dy);
  }


  // 红区边的格子桶：每条边登记到其包围盒覆盖的格子里，点查询先扫自身格子拿到一个很小的
  // 上界，再按格方框逐圈外扩，用「点到格方框之外」的距离作下界收尾。剪枝只跳过距离必然
  // 更大的边，因此最近距离、最近边号与逐边暴力逐位一致（并列最小值的取舍用边号兜底，
  // 与暴力的「先到先得」结果相同），只是把参与计算的边从全量降到个位数。
  // 同时缓存每条边的包围盒，供线段查询/穿越判定做 O(1) 的快速排除。
  function getZoneEdgeGrid(zone) {
    const cached = S.redZoneEdgeGridCache.get(zone);
    if (cached) return cached;

    const count = zone.length;
    const edges = new Float64Array(count * 4);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < count; i++) {
      const start = zone[i];
      const end = zone[(i + 1) % count];
      const edgeMinX = Math.min(start.x, end.x);
      const edgeMaxX = Math.max(start.x, end.x);
      const edgeMinY = Math.min(start.y, end.y);
      const edgeMaxY = Math.max(start.y, end.y);
      edges[i * 4] = edgeMinX;
      edges[i * 4 + 1] = edgeMinY;
      edges[i * 4 + 2] = edgeMaxX;
      edges[i * 4 + 3] = edgeMaxY;
      if (edgeMinX < minX) minX = edgeMinX;
      if (edgeMinY < minY) minY = edgeMinY;
      if (edgeMaxX > maxX) maxX = edgeMaxX;
      if (edgeMaxY > maxY) maxY = edgeMaxY;
    }

    const baseCx = Math.floor(minX / RED_ZONE_GRID_CELL);
    const baseCy = Math.floor(minY / RED_ZONE_GRID_CELL);
    const columns = Math.floor(maxX / RED_ZONE_GRID_CELL) - baseCx + 1;
    const rows = Math.floor(maxY / RED_ZONE_GRID_CELL) - baseCy + 1;
    const cells = new Array(columns * rows);
    for (let i = 0; i < count; i++) {
      const cellMinX = Math.floor(edges[i * 4] / RED_ZONE_GRID_CELL) - baseCx;
      const cellMaxX = Math.floor(edges[i * 4 + 2] / RED_ZONE_GRID_CELL) - baseCx;
      const cellMinY = Math.floor(edges[i * 4 + 1] / RED_ZONE_GRID_CELL) - baseCy;
      const cellMaxY = Math.floor(edges[i * 4 + 3] / RED_ZONE_GRID_CELL) - baseCy;
      for (let cy = cellMinY; cy <= cellMaxY; cy++) {
        for (let cx = cellMinX; cx <= cellMaxX; cx++) {
          const bucket = cells[cy * columns + cx];
          if (bucket) bucket.push(i);
          else cells[cy * columns + cx] = [i];
        }
      }
    }

    const grid = {
      edges, baseCx, baseCy, columns, rows, cells,
      stamps: new Int32Array(columns * rows),
      stamp: 0
    };
    S.redZoneEdgeGridCache.set(zone, grid);
    return grid;
  }


  function beginZoneGridQuery(grid) {
    grid.stamp += 1;
    if (grid.stamp >= 2000000000) {
      grid.stamps.fill(0);
      grid.stamp = 1;
    }
    return grid.stamp;
  }


  // 只有真正更近的边才会写入坐标对象，避免每次查询都为全部条目分配内存
  function scanZoneGridCellForPoint(grid, zone, x, y, cx, cy, best) {
    if (cx < 0 || cx >= grid.columns || cy < 0 || cy >= grid.rows) return;
    const index = cy * grid.columns + cx;
    if (grid.stamps[index] === grid.stamp) return;
    grid.stamps[index] = grid.stamp;
    const bucket = grid.cells[index];
    if (!bucket) return;
    for (let n = 0; n < bucket.length; n++) {
      const i = bucket[n];
      const start = zone[i];
      const end = zone[(i + 1) % zone.length];
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const lengthSquared = dx * dx + dy * dy;
      let closestX = start.x;
      let closestY = start.y;
      if (lengthSquared !== 0) {
        const ratio = Phaser.Math.Clamp(
          ((x - start.x) * dx + (y - start.y) * dy) / lengthSquared,
          0,
          1
        );
        closestX = start.x + dx * ratio;
        closestY = start.y + dy * ratio;
      }
      const offsetX = x - closestX;
      const offsetY = y - closestY;
      const distance = Math.sqrt(offsetX * offsetX + offsetY * offsetY);
      if (distance < best.distance || (distance === best.distance && i < best.edgeIndex)) {
        best.distance = distance;
        best.edgeIndex = i;
        if (best.point) {
          best.point.x = closestX;
          best.point.y = closestY;
        } else {
          best.point = { x: closestX, y: closestY };
        }
      }
    }
  }


  // 线段到红区的最短距离。两条线段的最短距离必定出现在「某一条的端点到另一条线段」上，
  // 于是只需取「线段两端点到红区各边」与「红区各顶点到线段」的最小值：取值集合与「线段
  // 对线段的暴力最短距离」完全相同（相交仍然单独判 0），因此结果与暴力实现逐位一致，
  // 但没有随线段变长而膨胀的格子扫描开销（长对角线弦是 A* 里的常态）。
  function getZoneSegmentDistance(zone, from, to) {
    const edges = getZoneEdgeGrid(zone).edges;
    const minX = Math.min(from.x, to.x);
    const maxX = Math.max(from.x, to.x);
    const minY = Math.min(from.y, to.y);
    const maxY = Math.max(from.y, to.y);
    for (let i = 0; i < zone.length; i++) {
      if (edges[i * 4] > maxX || edges[i * 4 + 2] < minX || edges[i * 4 + 1] > maxY || edges[i * 4 + 3] < minY) continue;
      if (segmentsIntersect(from, to, zone[i], zone[(i + 1) % zone.length])) return 0;
    }
    // 先算「红区顶点 -> 线段」：顶点本身就在红区边界上，所以这一步的结果已是真实间距的上界，
    // 有了上界，下面两次昂贵的「端点点查询」只在确实可能更近时才需要做
    let nearest = Infinity;
    for (let i = 0; i < zone.length; i++) {
      const px = zone[i].x;
      const py = zone[i].y;
      // 顶点到线段的距离不小于顶点到线段包围盒的距离，先用它把不可能更近的顶点排除掉
      const offsetX = px < minX ? minX - px : px > maxX ? px - maxX : 0;
      const offsetY = py < minY ? minY - py : py > maxY ? py - maxY : 0;
      if (offsetX * offsetX + offsetY * offsetY >= nearest * nearest) continue;
      const distance = distanceToSegment(px, py, from, to);
      if (distance < nearest) nearest = distance;
    }
    // 两条线段的最短距离还可能出现在「线段端点到红区各边」上：先用端点到红区包围盒的
    // 间距（真实间距的下界）筛一遍，下界已不小于当前最优的端点直接跳过
    const bounds = getZoneBounds(zone);
    if (getPointBoundsLowerBound(from.x, from.y, bounds) < nearest) {
      const fromDistance = getZonePointDistance(zone, from.x, from.y);
      if (fromDistance < nearest) nearest = fromDistance;
    }
    if (getPointBoundsLowerBound(to.x, to.y, bounds) < nearest) {
      const toDistance = getZonePointDistance(zone, to.x, to.y);
      if (toDistance < nearest) nearest = toDistance;
    }
    return nearest;
  }


  // 红区内离给定点最近的一条边（含最近点坐标），用于推离与逐帧净空判定。
  // limit 是可选的「距离上界」：调用方只关心「距离是否达到 limit」时（绿区净空判定），
  // 一旦已经确定结论就立刻收工。绿多边形面积占全图一半、内部点到边界可达近千像素，
  // 不加这个上界时环形扫描会退化成数百次格子探测——这是绿区判定唯一的性能热点。
  // limit 为默认的 Infinity 时必须彻底关闭两个提前退出，返回的一定是精确最近边；
  // 否则「best.distance < Infinity」恒成立，中心格一扫完就返回一个被高估的距离，
  // 净空判定会整体放松（实测会让 3 个采样点由不安全翻转为安全）
  function getZoneNearestEdge(zone, x, y, limit = Infinity) {
    const grid = getZoneEdgeGrid(zone);
    beginZoneGridQuery(grid);
    const bounded = limit !== Infinity;
    const cell = RED_ZONE_GRID_CELL;
    const cx = Math.floor(x / cell) - grid.baseCx;
    const cy = Math.floor(y / cell) - grid.baseCy;
    const best = { distance: Infinity, point: null, edgeIndex: -1 };
    scanZoneGridCellForPoint(grid, zone, x, y, cx, cy, best);
    // 中心格就已经找到比 limit 更近的点：结论（距离 < limit）已确定
    if (bounded && best.distance < limit) return best;

    const lastRing = Math.max(cx, grid.columns - 1 - cx, cy, grid.rows - 1 - cy, 0);
    // 圈从「第一个真正碰到格子表」的那一圈开始：查询点落在格子表之外时，前面的圈里
    // 一个格子都没有，扫也是空转（否则远处查询会退化成 O(圈数²) 的空调用）
    const startRing = Math.max(-cx, cx - (grid.columns - 1), -cy, cy - (grid.rows - 1), 0);
    const lastColumn = grid.columns - 1;
    const lastRow = grid.rows - 1;
    let lowerBound = 0;
    for (let ring = startRing; ring <= lastRing; ring++) {
      if (lowerBound > best.distance) break;
      if (bounded) {
        // 已扫到的最小距离比 limit 更近：结论（距离 < limit）已确定
        if (best.distance < limit) break;
        // 未扫描部分到查询点的距离下界已不小于 limit：无论后面还藏着什么，
        // 真实最近距离都必然 >= limit，结论已确定（best.distance 保持不小于 limit 的值）
        if (lowerBound >= limit) break;
      }
      const ringMinX = cx - ring;
      const ringMaxX = cx + ring;
      const ringMinY = cy - ring;
      const ringMaxY = cy + ring;
      // 只扫圈方框与格子表的交集，同样是为了让不相交的部分不产生调用开销
      const columnStart = Math.max(0, ringMinX);
      const columnEnd = Math.min(lastColumn, ringMaxX);
      const rowStart = Math.max(0, ringMinY + 1);
      const rowEnd = Math.min(lastRow, ringMaxY - 1);
      for (let column = columnStart; column <= columnEnd; column++) {
        scanZoneGridCellForPoint(grid, zone, x, y, column, ringMinY, best);
        scanZoneGridCellForPoint(grid, zone, x, y, column, ringMaxY, best);
      }
      for (let row = rowStart; row <= rowEnd; row++) {
        scanZoneGridCellForPoint(grid, zone, x, y, ringMinX, row, best);
        scanZoneGridCellForPoint(grid, zone, x, y, ringMaxX, row, best);
      }
      // 已扫过的格子是以查询点格为中心的方形圈（切比雪夫格距 ≤ ring），圈外任何格子到
      // 查询点至少还有 ring 格的间距，于是 ring * 格宽就是剩余部分的距离下界。查询点
      // 必然落在自己格的内部，所以「点到圈方框」的距离恒为 0，用它当界永远剪不掉东西，
      // 远处点查询会退化成整张格子表的完全扫描（贴边绕行时最贵的一处）
      lowerBound = ring * cell;
    }
    return best;
  }


  function getZonePointDistance(zone, x, y) {
    return getZoneNearestEdge(zone, x, y).distance;
  }


  function getZoneOrientation(zone) {
    let area = 0;
    for (let i = 0; i < zone.length; i++) {
      const current = zone[i];
      const next = zone[(i + 1) % zone.length];
      area += current.x * next.y - next.x * current.y;
    }
    return area >= 0 ? 1 : -1;
  }


  // 轮廓缓存项：points 为等距偏移后的采样折线；arcPrefix 是环绕折线的前缀弧长，
  // 用于把「沿轮廓的弧长」查询从 O(轮廓点数) 降到 O(1)（见 getContourArcLength）。
  // 前缀弧长由 points 派生、下标一一对应（corrected 用 map 生成，保序保长），因此可与轮廓同缓存。
  // offsetSign：+1 = 向外扩（红色屏蔽区，禁区在多边形内部，安全侧在外）；
  //             -1 = 向内推（绿色屏蔽区，禁区在多边形外侧，安全侧在内）。
  // 两种环的几何、采样、弧长前缀完全一致，唯一差别就是这个符号。
  // pointSafe / correct 是该环对应的「点是否带足额净空」与「把点推回净空之外」两个操作
  function getRedZoneContourEntry(
    zone,
    clearance = PLAYER_RED_ZONE_CLEARANCE,
    offsetSign = 1,
    pointSafe = isRedClearanceSafePoint,
    correct = correctPointOutOfRedClearance
  ) {
    let zoneCache = redContourCache.get(zone);
    if (!zoneCache) {
      zoneCache = new Map();
      redContourCache.set(zone, zoneCache);
    }
    const cacheKey = `${S.collisionRegionVersion}:${clearance}:${offsetSign}`;
    const cached = zoneCache.get(cacheKey);
    if (cached) return cached;

    const orientation = getZoneOrientation(zone);
    const count = zone.length;
    const normals = [];
    for (let i = 0; i < count; i++) normals.push(getOutwardNormal(zone, i));

    // 轮廓按 安全带宽度 + 亚像素余量 偏移生成：圆角连接的弦长会略微内凹，
    // 留出余量可避免相邻采样点连线的实际净空跌破安全带宽度。
    // 偏移量带符号（内推为负），净空宽度取正值供判定与圆弧使用
    const clearanceWidth = clearance + RED_CONTOUR_MARGIN;
    const signedOffset = clearanceWidth * offsetSign;
    const contour = [];
    const pushPoint = point => {
      const last = contour[contour.length - 1];
      if (last && Phaser.Math.Distance.Between(last.x, last.y, point.x, point.y) < 0.0001) return;
      contour.push(point);
    };

    for (let i = 0; i < count; i++) {
      const vertex = zone[i];
      const nextVertex = zone[(i + 1) % count];
      const normal = normals[i];
      const nextNormal = normals[(i + 1) % count];
      const offsetStart = { x: vertex.x + normal.x * signedOffset, y: vertex.y + normal.y * signedOffset };
      const offsetEnd = { x: nextVertex.x + normal.x * signedOffset, y: nextVertex.y + normal.y * signedOffset };
      const edgeLength = Phaser.Math.Distance.Between(offsetStart.x, offsetStart.y, offsetEnd.x, offsetEnd.y);
      const samples = Math.max(1, Math.ceil(edgeLength / PLAYER_RED_CONTOUR_STEP));
      for (let step = 0; step < samples; step++) {
        const ratio = step / samples;
        pushPoint({
          x: offsetStart.x + (offsetEnd.x - offsetStart.x) * ratio,
          y: offsetStart.y + (offsetEnd.y - offsetStart.y) * ratio
        });
      }

      const cross = normal.x * nextNormal.y - normal.y * nextNormal.x;
      if (Math.abs(cross) <= 0.000001) continue;
      // 圆弧只用于向外扩：膨胀时凸角处两条偏移边会张开，需要用圆弧补足。
      // 向内推（腐蚀）时不能发圆弧——cross 在法线整体取反后不变，凸角处发圆弧只会得到
      // 0.707 倍净空；腐蚀的精确解是两条偏移边的交点，即下面的斜接点
      if (offsetSign > 0 && cross * orientation > 0) {
        const startAngle = Math.atan2(normal.y, normal.x);
        const endAngle = Math.atan2(nextNormal.y, nextNormal.x);
        let sweep = (endAngle - startAngle) * orientation;
        sweep = ((sweep % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        const arcSteps = Math.max(1, Math.ceil(sweep / PLAYER_RED_ARC_STEP));
        for (let step = 1; step <= arcSteps; step++) {
          const angle = startAngle + orientation * sweep * (step / arcSteps);
          pushPoint({
            x: nextVertex.x + Math.cos(angle) * clearanceWidth,
            y: nextVertex.y + Math.sin(angle) * clearanceWidth
          });
        }
        continue;
      }
      const denominator = 1 + (normal.x * nextNormal.x + normal.y * nextNormal.y);
      if (denominator < 0.05) continue;
      pushPoint({
        x: nextVertex.x + (normal.x + nextNormal.x) / denominator * signedOffset,
        y: nextVertex.y + (normal.y + nextNormal.y) / denominator * signedOffset
      });
    }

    // 二次修正：任何仍落在安全带（含余量）内的采样点都推回到安全距离之外，
    // 保证轮廓点本身自带足额净空，环上相邻点连线才不会割进安全带。
    // 等距偏移本身已经保证轮廓点在安全带之外，这里先用带缓存的点判定筛一遍，
    // 只有数值退化导致点真的落进安全带以内时才走昂贵的推离流程
    const corrected = contour.map(point => (
      pointSafe(point.x, point.y, clearanceWidth)
        ? point
        : correct(point, clearanceWidth)
    ));

    // 环绕前缀弧长：arcPrefix[k] 为 contour[0] → contour[k] 的折线长度，
    // 末位 arcPrefix[n] 为整圈长度（含收尾那条 contour[n-1] → contour[0] 的弦）
    const pointCount = corrected.length;
    const arcPrefix = new Float64Array(pointCount + 1);
    for (let i = 0; i < pointCount; i++) {
      const next = corrected[(i + 1) % pointCount];
      arcPrefix[i + 1] = arcPrefix[i] + Phaser.Math.Distance.Between(
        corrected[i].x, corrected[i].y, next.x, next.y
      );
    }

    const entry = { points: corrected, arcPrefix };
    zoneCache.set(cacheKey, entry);
    return entry;
  }


  // 红区外沿的等距轮廓（多边形外扩）：凸角用等距圆弧、凹角用两条偏移线的交点
  function getRedZoneContour(zone, clearance = PLAYER_RED_ZONE_CLEARANCE) {
    return getRedZoneContourEntry(zone, clearance).points;
  }


  // 轮廓采样点中自身仍带足额净空的那一批（A* 的候选节点）：
  // 结论只由静态几何决定，因此与轮廓同样按「版本号 + 净空宽度 + 偏移符号」缓存，
  // 不必每次规划都重新对数百个采样点跑一遍点到红区的距离查询。
  // ring 缺省即红环，因此原有调用点逐位不变
  function getRedZoneContourNodes(zone, clearance = PLAYER_RED_ZONE_CLEARANCE, ring = RED_SHIELD_RING) {
    let zoneCache = redContourNodeCache.get(zone);
    if (!zoneCache) {
      zoneCache = new Map();
      redContourNodeCache.set(zone, zoneCache);
    }
    const cacheKey = `${S.collisionRegionVersion}:${clearance}:${ring.offsetSign}`;
    const cached = zoneCache.get(cacheKey);
    if (cached) return cached;
    const raw = getRedZoneContourEntry(zone, clearance, ring.offsetSign, ring.pointSafe, ring.correct).points
      .filter(point => ring.pointSafe(point.x, point.y, clearance));
    // 采样点之间的弦会切掉弧线（实测最深内凹约 0.5 像素，超过 RED_CONTOUR_MARGIN），
    // 这些弦交给净空判定会失败，轮廓环随之断裂成几段，A* 图失去连通性，
    // 长距离绕行只能判「无法绕行」。这里对过近的弦递归补插中点并推到安全距离，
    // 保证环上任意相邻两点都是可判为安全的连线。
    const nodes = [];
    const append = (from, to, depth) => {
      if (ring.segmentSafe(from, to, clearance) || depth >= PLAYER_RED_CONTOUR_REPAIR_DEPTH) {
        nodes.push(to);
        return;
      }
      const middle = ring.correct(
        { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 },
        clearance + RED_CONTOUR_MARGIN
      );
      const usable = Phaser.Math.Distance.Between(from.x, from.y, middle.x, middle.y) > 0.5
        && Phaser.Math.Distance.Between(middle.x, middle.y, to.x, to.y) > 0.5
        && ring.pointSafe(middle.x, middle.y, clearance);
      if (!usable) {
        nodes.push(to);
        return;
      }
      append(from, middle, depth + 1);
      append(middle, to, depth + 1);
    };
    if (raw.length) {
      nodes.push(raw[0]);
      for (let index = 1; index < raw.length; index++) append(raw[index - 1], raw[index], 0);
    }
    // 采样点密度只决定「贴边时拐点有多细」，对绕行结果没有贡献，却是 A* 松弛次数的主因：
    // 相邻两点连线本身就安全时，中间那个采样点对任何可行解都是多余的（直连更短），
    // 直接丢掉。实测红区环从 466 点压到 74 点，单次远距离规划的松弛次数下降一个数量级，
    // 而最短路长度完全不变（保留下来的都是绕行必须的拐点）。
    const kept = [];
    for (let index = 0; index < nodes.length; index++) {
      const previous = kept[kept.length - 1];
      const next = nodes[index + 1];
      if (previous && next && ring.segmentSafe(previous, next, clearance)) continue;
      kept.push(nodes[index]);
    }
    zoneCache.set(cacheKey, kept);
    return kept;
  }


  // 开局预热红区几何缓存：等距轮廓与轮廓节点环都是纯静态几何（只由地图屏蔽区决定），
  // 若等到第一次跨红区移动指令才构建，会把上百毫秒的计算压在那一帧上，表现为明显卡顿。
  // 开局一次性算完，交互时刻只读缓存；碰撞区域被编辑时 invalidateRedZoneCaches 会整体重建。
  // 绿边界同样预热：它的轮廓有数百个采样点，不预热就会把首次贴绿边行走顶出明显卡顿
  function prewarmRedContourCache() {
    collisionRegions.redForbiddenZones.forEach(zone => {
      getRedZoneContour(zone, PLAYER_RED_ZONE_CLEARANCE);
      getRedZoneContourNodes(zone, PLAYER_RED_ZONE_CLEARANCE);
      // 沿红区滑动用的转向轮廓（安全带 + 亚像素偏置）也在开局算好，
      // 否则第一次贴边转向会临时多付一次轮廓构建
      getRedZoneContour(zone, PLAYER_RED_ZONE_CLEARANCE + PLAYER_RED_STEER_BIAS);
    });
    // 绿环：净空轮廓、净空节点环、转向轮廓（安全带 + 亚像素偏置）
    const boundary = collisionRegions.walkableBoundary;
    getRedZoneContourNodes(boundary, PLAYER_GREEN_ZONE_CLEARANCE, GREEN_SHIELD_RING);
    getRedZoneContourEntry(
      boundary,
      PLAYER_GREEN_ZONE_CLEARANCE + PLAYER_RED_STEER_BIAS,
      GREEN_SHIELD_RING.offsetSign,
      GREEN_SHIELD_RING.pointSafe,
      GREEN_SHIELD_RING.correct
    );
  }


  function getNearestRedFeature(x, y) {
    let nearest = null;
    collisionRegions.redForbiddenZones.forEach(zone => {
      // 点到红区包围盒的间距是真实间距的下界：不可能更近的红区整块跳过，不做逐边查询
      if (nearest && getPointBoundsLowerBound(x, y, getZoneBounds(zone)) >= nearest.distance) return;
      const feature = getZoneNearestEdge(zone, x, y);
      if (feature.edgeIndex < 0 || !Number.isFinite(feature.distance)) return;
      if (!nearest || feature.distance < nearest.distance) {
        nearest = { zone, point: feature.point, distance: feature.distance, edgeIndex: feature.edgeIndex };
      }
    });
    return nearest;
  }


  // 把落在屏蔽环「禁区一侧」或净空带内的点推到安全一侧并补足净空。
  // 红环（offsetSign = +1，禁区在多边形内部）与绿环（offsetSign = -1，禁区在外侧）
  // 只差两个符号：哪一侧算「错误一侧」，以及退化时沿法线的推离方向。
  // nearestFeature(x, y) 负责给出「当前位置最近的环特征」（红环要跨多块红区取最近者）
  function correctPointOutOfRingClearance(point, clearance, nearestFeature, offsetSign) {
    let current = { x: point.x, y: point.y };
    for (let iteration = 0; iteration < PLAYER_RED_CORRECTION_ITERATIONS; iteration++) {
      const feature = nearestFeature(current.x, current.y);
      if (!feature || feature.edgeIndex < 0 || !Number.isFinite(feature.distance)) break;
      const zone = feature.zone;
      const wrongSide = pointInPolygon(current.x, current.y, zone) === (offsetSign > 0);
      // 终止条件：净空已足额，且红环不额外判侧（逐位保持既有行为），
      // 绿环必须判「确实落在可行动区内侧」——到边界折线的距离是无符号的，
      // 屏蔽区深处的点距离同样充足，不判就会被当成安全点放行
      const clearanceEnough = feature.distance >= clearance - RED_CLEARANCE_TOLERANCE;
      if (clearanceEnough && (offsetSign > 0 || !wrongSide)) break;
      let directionX;
      let directionY;
      let push;
      if (feature.distance < 0.0001) {
        // 正落在边界折线上：无法由「点到最近点」定方向，沿安全一侧的法线推足额净空
        const normal = getOutwardNormal(zone, feature.edgeIndex);
        directionX = normal.x * offsetSign;
        directionY = normal.y * offsetSign;
        push = clearance;
      } else if (wrongSide) {
        // 已经进入禁区一侧：先沿最近边穿回安全侧，再补足净空
        directionX = (feature.point.x - current.x) / feature.distance;
        directionY = (feature.point.y - current.y) / feature.distance;
        push = feature.distance + clearance;
      } else {
        directionX = (current.x - feature.point.x) / feature.distance;
        directionY = (current.y - feature.point.y) / feature.distance;
        push = clearance - feature.distance;
      }
      current = {
        x: current.x + directionX * push,
        y: current.y + directionY * push
      };
    }
    return current;
  }


  // 绿色屏蔽区的「最近环特征」：只有一条绿边界，直接取该点的最近边
  function getNearestGreenFeature(x, y) {
    const boundary = collisionRegions.walkableBoundary;
    const feature = getZoneNearestEdge(boundary, x, y);
    if (feature.edgeIndex < 0 || !Number.isFinite(feature.distance)) return null;
    return { zone: boundary, point: feature.point, distance: feature.distance, edgeIndex: feature.edgeIndex };
  }


  // 把落在红区内部或 38 像素安全带内的点推回到刚好 38 像素之外
  function correctPointOutOfRedClearance(point, clearance = PLAYER_RED_ZONE_CLEARANCE) {
    return correctPointOutOfRingClearance(point, clearance, getNearestRedFeature, 1);
  }


  // 把落在绿色屏蔽区（可行动区轮廓外侧）或绿边界净空带内的点推到「内侧且距边界足额净空」处。
  // 先用带距离上界的点判定筛一遍：已经满足净空的点原样返回（推离函数对这种情况同样会立即收工），
  // 但精确推离需要无限上界的最近边查询，绿多边形内部深处会退化成数百次格子探测，
  // 而这个函数在阵型摆放里是逐帧逐队员调用的
  function correctPointIntoGreenClearance(point, clearance = PLAYER_GREEN_ZONE_CLEARANCE) {
    if (isGreenClearanceSafePoint(point.x, point.y, clearance)) return { x: point.x, y: point.y };
    return correctPointOutOfRingClearance(point, clearance, getNearestGreenFeature, -1);
  }


  // 盾推离：我方单位的点要同时离开绿净空带与红净空带。
  // 两步都是「净空修正」，多数情况下只有一步真正生效（点要么只挨着绿边、要么只挨着红区）；
  // 两者都违例的位置（绿边界与红区 2 东沿重合的那条带）本就不存在安全站位，
  // 这里不做反复迭代，交回上层用盾判定复核、走贴边或重新规划
  function correctPointIntoShieldClearance(point, clearance = PLAYER_RED_ZONE_CLEARANCE) {
    return correctPointOutOfRedClearance(
      correctPointIntoGreenClearance(point, PLAYER_GREEN_ZONE_CLEARANCE), clearance
    );
  }


  // 沿线抽样检查可行动性，避免长连线切出绿色边界（结论按 walkableSegmentMemos 记忆化）
  function isSegmentWalkable(from, to) {
    let byTo = S.walkableSegmentMemos.get(from);
    if (byTo) {
      const cached = byTo.get(to);
      if (cached !== undefined) return cached;
    } else {
      byTo = new WeakMap();
      S.walkableSegmentMemos.set(from, byTo);
    }
    const length = Phaser.Math.Distance.Between(from.x, from.y, to.x, to.y);
    const steps = Math.max(1, Math.min(
      PLAYER_RED_WALKABLE_SAMPLE_MAX,
      Math.ceil(length / PLAYER_RED_WALKABLE_SAMPLE_STEP)
    ));
    let walkable = true;
    for (let index = 1; index < steps; index++) {
      const ratio = index / steps;
      if (!isWalkable(from.x + (to.x - from.x) * ratio, from.y + (to.y - from.y) * ratio)) {
        walkable = false;
        break;
      }
    }
    byTo.set(to, walkable);
    return walkable;
  }


  // 红区净空判定：线段到每个红区的最短距离都必须不小于安全带宽度
  // slack 是路径搜索的浮点松弛量；敌方落点判定传 0，保证单位不会真的贴进安全带以内。
  // 橙线穿越必须单独判：橙线只是不可跨越的隔断、并不属于红区，
  // 与红区边的最短距离远大于安全带，只靠净空判定挡不住穿线。
  // 昂贵的「到各红区的最短距离」这一段交给带缓存的 isRedClearanceZonesSatisfied，
  // 它也是整段规划里调用量最大的一处
  function isRedClearanceSafeSegment(
    from,
    to,
    clearance = PLAYER_RED_ZONE_CLEARANCE,
    strict = false,
    slack = RED_CLEARANCE_PATH_SLACK
  ) {
    if (!isWalkable(from.x, from.y) || !isWalkable(to.x, to.y)) return false;
    if (isCollisionLineSegmentCrossed(from.x, from.y, to.x, to.y)) return false;
    if (strict && !isSegmentWalkable(from, to)) return false;
    return isRedClearanceZonesSatisfied(from, to, clearance, slack);
  }


  function isRedClearanceSafePoint(x, y, clearance = PLAYER_RED_ZONE_CLEARANCE) {
    const bit = getClearanceQueryBit(clearance);
    const key = bit === 0 ? 0 : getPointQueryKey(x, y);
    if (bit !== 0) {
      const entry = pointQueryCache.get(key);
      if (entry !== undefined && (entry & bit) !== 0) {
        return (entry & bit << POINT_QUERY_RESULT_SHIFT) !== 0;
      }
    }
    let safe = isWalkable(x, y);
    if (safe) {
      safe = collisionRegions.redForbiddenZones.every(zone => {
        // 点到包围盒的距离是点到红区距离的下界：下界已经安全就不必再算精确最近边
        const bounds = getZoneBounds(zone);
        const needed = clearance - RED_CLEARANCE_TOLERANCE;
        if (getPointBoundsLowerBound(x, y, bounds) > needed) return true;
        return getZonePointDistance(zone, x, y) >= needed;
      });
    }
    if (bit !== 0) {
      // isWalkable 可能刚往同一个键写入可行走位，重新取一次再合并净空结论
      const entry = pointQueryCache.get(key);
      pointQueryCache.set(key, (entry || 0) | bit | (safe ? bit << POINT_QUERY_RESULT_SHIFT : 0));
    }
    return safe;
  }


  // --------------------------------------------------
  // 绿色屏蔽区（可行动区轮廓外侧）净空判定：与红区共用同一套结构、同一个净空数值，
  // 差别只在「禁的是多边形外侧」——所以这里额外要求点/线段落在可行动区内侧，
  // 并沿用同一个无符号距离（到边界折线的距离）与同一套容差/松弛量。
  // 只有我方单位使用这两个判定；敌军路线首个图内节点距绿边界仅 18.8 像素，
  // 套上 19 像素绿净空会使其失效，因此敌军保持「仅红区」口径
  // --------------------------------------------------
  function isGreenClearanceSafePoint(x, y, clearance = PLAYER_GREEN_ZONE_CLEARANCE) {
    const bit = getClearanceQueryBit(clearance, 'green');
    const key = bit === 0 ? 0 : getPointQueryKey(x, y);
    if (bit !== 0) {
      const entry = pointQueryCache.get(key);
      if (entry !== undefined && (entry & bit) !== 0) {
        return (entry & bit << POINT_QUERY_RESULT_SHIFT) !== 0;
      }
    }
    // 必须先判可行走：到边界折线的距离是无符号的，落在屏蔽区深处的点距离同样是正数，
    // 只有 isWalkable（内含 pointInPolygon）才能把「在外侧」挡下来
    let safe = isWalkable(x, y);
    if (safe) {
      const boundary = collisionRegions.walkableBoundary;
      const needed = clearance - RED_CLEARANCE_TOLERANCE;
      // 点到包围盒的距离是下界：下界已经安全就不必再算精确最近边。
      // limit 传 needed：绿多边形很大，只关心「是否达到净空」时无需扫到精确最近点
      safe = getPointBoundsLowerBound(x, y, getZoneBounds(boundary)) > needed ||
        getZoneNearestEdge(boundary, x, y, needed).distance >= needed;
    }
    if (bit !== 0) {
      // isWalkable 可能刚往同一个键写入可行走位，重新取一次再合并净空结论
      const entry = pointQueryCache.get(key);
      pointQueryCache.set(key, (entry || 0) | bit | (safe ? bit << POINT_QUERY_RESULT_SHIFT : 0));
    }
    return safe;
  }


  // 盾判定：我方单位必须同时满足红色与绿色两种屏蔽区的净空。
  // 线段版直接复用红区版的全部前置检查（可行走、橙线、严格抽样），只再叠一条绿区距离
  function isShieldClearanceSafePoint(x, y, clearance = PLAYER_RED_ZONE_CLEARANCE) {
    return isRedClearanceSafePoint(x, y, clearance) &&
      isGreenClearanceSafePoint(x, y, PLAYER_GREEN_ZONE_CLEARANCE);
  }


  function isShieldClearanceSafeSegment(
    from,
    to,
    clearance = PLAYER_RED_ZONE_CLEARANCE,
    strict = false,
    slack = RED_CLEARANCE_PATH_SLACK
  ) {
    if (!isRedClearanceSafeSegment(from, to, clearance, strict, slack)) return false;
    return isGreenClearanceSatisfied(from, to, PLAYER_GREEN_ZONE_CLEARANCE, slack);
  }


  function getNearestEdgeCandidates(start, end) {
    const candidates = [];
    const polygons = collisionRegions.redForbiddenZones.concat([collisionRegions.walkableBoundary]);
    polygons.forEach(polygon => {
      const center = polygon.reduce((sum, point) => ({
        x: sum.x + point.x / polygon.length,
        y: sum.y + point.y / polygon.length
      }), { x: 0, y: 0 });
      for (let i = 0; i < polygon.length; i++) {
        const edgeStart = polygon[i];
        const edgeEnd = polygon[(i + 1) % polygon.length];
        const edgeX = edgeEnd.x - edgeStart.x;
        const edgeY = edgeEnd.y - edgeStart.y;
        const edgeLengthSquared = edgeX * edgeX + edgeY * edgeY;
        const projection = Phaser.Math.Clamp(
          ((start.x - edgeStart.x) * edgeX + (start.y - edgeStart.y) * edgeY) /
            Math.max(1, edgeLengthSquared),
          0,
          1
        );
        const nearest = {
          x: edgeStart.x + edgeX * projection,
          y: edgeStart.y + edgeY * projection
        };
        const isWalkableEdge = polygon === collisionRegions.walkableBoundary;
        const offsetX = (nearest.x - center.x) * (isWalkableEdge ? -1 : 1);
        const offsetY = (nearest.y - center.y) * (isWalkableEdge ? -1 : 1);
        const offsetLength = Math.max(1, Math.hypot(offsetX, offsetY));
        const candidate = {
          x: Phaser.Math.Clamp(nearest.x + offsetX / offsetLength * 28, 0, WORLD_WIDTH),
          y: Phaser.Math.Clamp(nearest.y + offsetY / offsetLength * 28, 0, WORLD_HEIGHT)
        };
        if (isWalkable(candidate.x, candidate.y)) candidates.push(candidate);
      }
    });
    return candidates;
  }


  // 移动路线范围内的红区：直线穿越的红区，或与直线距离不超过 PLAYER_RED_ROUTE_RANGE 的红区
  function getRedRouteZones(start, end) {
    return collisionRegions.redForbiddenZones.filter(zone => {
      if (isRedZoneCrossedByPath(start.x, start.y, end.x, end.y, zone)) return true;
      if (getSegmentDistanceLowerBound(start, end, getZoneBounds(zone)) > PLAYER_RED_ROUTE_RANGE) return false;
      return getZoneSegmentDistance(zone, start, end) <= PLAYER_RED_ROUTE_RANGE;
    });
  }


  function isWalkable(x, y) {
    const key = getPointQueryKey(x, y);
    const entry = pointQueryCache.get(key);
    if (entry !== undefined && (entry & POINT_QUERY_WALKABLE) !== 0) {
      return (entry & POINT_QUERY_WALKABLE_RESULT) !== 0;
    }
    const walkable = pointInPolygon(x, y, collisionRegions.mapBoundary) &&
      pointInPolygon(x, y, collisionRegions.walkableBoundary) &&
      !isZoneBlocked(x, y);
    pointQueryCache.set(key, (entry || 0) | POINT_QUERY_WALKABLE |
      (walkable ? POINT_QUERY_WALKABLE_RESULT : 0));
    return walkable;
  }


  // 「可行走 + 红区净空」的组合判定：两种结论共用同一条缓存记录，键与查表都只做一次。
  // 满编时这里是每帧数百次的调用（隔离放行、巡逻落点校验），比连着调用两个函数少一次键构造
  function isPointSafelyWalkable(x, y, clearance) {
    const bit = getClearanceQueryBit(clearance);
    if (bit !== 0) {
      const entry = pointQueryCache.get(getPointQueryKey(x, y));
      const knownMask = POINT_QUERY_WALKABLE | bit;
      if (entry !== undefined && (entry & knownMask) === knownMask) {
        const resultMask = POINT_QUERY_WALKABLE_RESULT | bit << POINT_QUERY_RESULT_SHIFT;
        return (entry & resultMask) === resultMask;
      }
    }
    return isWalkable(x, y) && isRedClearanceSafePoint(x, y, clearance);
  }


  // 红区边缘上「外推安全带后仍站得住」的最近落点。正常的点击用最近边缘点就够，
  // 只有红区一段贴到地图或可行动区边界（外推点落到地图外、外推方向完全没有可站空间）
  // 时才需要沿同一圈边缘继续找：否则点击屏蔽区会被误判成无法绕行
  function findRedShieldSeat(zone, x, y, offset) {
    const samples = samplePolygonBoundaryOrdered(zone, x, y, RED_SHIELD_SCAN_STEP);
    for (let index = 0; index < samples.length; index++) {
      const point = correctPointOutOfRedClearance(samples[index], offset);
      if (isWalkable(point.x, point.y) && isRedClearanceSafePoint(point.x, point.y)) return point;
    }
    return null;
  }


  // 可行动区轮廓内侧的最近落点：轮廓上的点落在边界上（pointInPolygon 的结论二义），
  // 沿外法线反向推一点即为区内。推进深度必须越过绿净空带，否则落点仍然落在净空带里、
  // 会被盾判定否决，点击绿屏蔽区就变成「走到了但站不住」
  function findWalkableShieldSeat(x, y) {
    const boundary = collisionRegions.walkableBoundary;
    const samples = samplePolygonBoundaryOrdered(boundary, x, y, WALKABLE_SHIELD_SCAN_STEP);
    for (let index = 0; index < samples.length; index++) {
      const sample = samples[index];
      const normal = getOutwardNormal(boundary, sample.edgeIndex);
      for (let depth = 2; depth <= PLAYER_GREEN_ZONE_CLEARANCE + 16; depth += 2) {
        const point = { x: sample.x - normal.x * depth, y: sample.y - normal.y * depth };
        if (isGreenClearanceSafePoint(point.x, point.y)) return point;
      }
    }
    return null;
  }


  // 小队是否已贴到屏蔽区边缘（红区或绿色屏蔽区）：以净空宽度为基准再放宽给定范围。
  // 进入与退出传入不同的范围即可形成迟滞，贴边行走时判定不会来回抖动。
  // 绿边界查询带上界：绿多边形内部点距边界可达数百像素，带上界的查询命中即提前退出
  function isPointAtShieldEdge(x, y, extraRange) {
    const range = extraRange === undefined ? PLAYER_SQUAD_EDGE_RANGE : extraRange;
    let nearest = Infinity;
    collisionRegions.redForbiddenZones.forEach(zone => {
      const distance = getZonePointDistance(zone, x, y);
      if (distance < nearest) nearest = distance;
    });
    if (nearest <= PLAYER_RED_ZONE_CLEARANCE + range) return true;
    const limit = PLAYER_GREEN_ZONE_CLEARANCE + range;
    return getZoneNearestEdge(collisionRegions.walkableBoundary, x, y, limit).distance <= limit;
  }


  // 把落到不可行走区域的点推回可行走区域：先试「朝队形中心收缩」的方向（队形中心一定在
  // 可行走区域内，这个方向最不容易再次撞到边界），再按递增半径做环形搜索，取最近的可走落点；
  // 四周都被挡住时原样返回，不硬塞到非法位置
  function correctPointIntoWalkable(point, anchor, maxRadius = 72) {
    if (isWalkable(point.x, point.y)) return { x: point.x, y: point.y };
    const directions = [];
    const toAnchorX = anchor.x - point.x;
    const toAnchorY = anchor.y - point.y;
    const toAnchorLength = Math.hypot(toAnchorX, toAnchorY);
    if (toAnchorLength > 0.001) {
      directions.push({ x: toAnchorX / toAnchorLength, y: toAnchorY / toAnchorLength });
    }
    for (let i = 0; i < 8; i++) {
      const angle = i * Math.PI / 4;
      directions.push({ x: Math.cos(angle), y: Math.sin(angle) });
    }
    for (let distance = 2; distance <= maxRadius; distance = distance < 8 ? distance + 2 : distance * 1.5) {
      for (let d = 0; d < directions.length; d++) {
        const x = point.x + directions[d].x * distance;
        const y = point.y + directions[d].y * distance;
        if (isWalkable(x, y)) return { x, y };
      }
    }
    return { x: point.x, y: point.y };
  }

export { getPointQueryKey, getClearanceQueryBit, getCollisionSegmentBounds, clearRedQueryCaches, isRedClearanceZonesSatisfied, isGreenClearanceSatisfied, editCollisionRegion, appendRedForbiddenZone, isZoneBlocked, isCollisionLineSegmentCrossed, isCollisionLineCrossed, invalidateRedZoneCaches, getZoneBounds, getSegmentDistanceLowerBound, getPointBoundsLowerBound, getZoneEdgeGrid, beginZoneGridQuery, scanZoneGridCellForPoint, getZoneSegmentDistance, getZoneNearestEdge, getZonePointDistance, getZoneOrientation, getRedZoneContourEntry, getRedZoneContour, getRedZoneContourNodes, prewarmRedContourCache, getNearestRedFeature, correctPointOutOfRingClearance, getNearestGreenFeature, correctPointOutOfRedClearance, correctPointIntoGreenClearance, correctPointIntoShieldClearance, isSegmentWalkable, isRedClearanceSafeSegment, isRedClearanceSafePoint, isGreenClearanceSafePoint, isShieldClearanceSafePoint, isShieldClearanceSafeSegment, getNearestEdgeCandidates, getRedRouteZones, isWalkable, isPointSafelyWalkable, findRedShieldSeat, findWalkableShieldSeat, isPointAtShieldEdge, correctPointIntoWalkable };
