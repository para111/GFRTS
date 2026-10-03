// ============================================================
// wg_game 模块化拆分 —— geometry.js
// 职责: 纯几何基元：距离/投影/多边形/轮廓采样/平滑
// 来源: wg_game.js 语句区间 2014-8314（自动拆分，勿手工重排语句顺序）
// ============================================================

import { isSafePath } from './pathfind.js';
import { ENEMY_RED_ZONE_CLEARANCE, WORLD_HEIGHT, WORLD_WIDTH, collisionRegions } from './state.js';
import { isRedClearanceSafeSegment, isWalkable } from './zones.js';


  // 手绘轮廓的采样间距很不均匀（最短 3 像素、最长 497 像素），直接做样条会在长短边
  // 交界处向外鼓出 30 像素以上。这里先把长边等距细分（原始控制点全部保留），
  // 再做闭曲线插值，外凸量就压到 1 像素级，绘制结果与判定用的控制点折线基本重合。
  function resampleClosedPath(points, spacing) {
    const result = [];
    for (let i = 0; i < points.length; i++) {
      const a = points[i];
      const b = points[(i + 1) % points.length];
      result.push({ x: a.x, y: a.y });
      const length = Math.hypot(b.x - a.x, b.y - a.y);
      if (length <= spacing) continue;
      for (let s = 1; s * spacing < length - 1e-6; s++) {
        const t = s * spacing / length;
        result.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
      }
    }
    return result;
  }


  // 闭合 Catmull-Rom 采样：把控制点折线转成逐点顺滑的曲线。仅用于绘制，
  // 碰撞判定一律使用原始控制点折线，保证视觉与判定不产生偏差。
  function getSmoothClosedPath(points, samplesPerEdge = 4) {
    const resampled = points.length < 4 ? points.slice() : resampleClosedPath(points, 12);
    const count = resampled.length;
    if (count < 4) return resampled;
    const result = [];
    for (let i = 0; i < count; i++) {
      const p0 = resampled[(i - 1 + count) % count];
      const p1 = resampled[i];
      const p2 = resampled[(i + 1) % count];
      const p3 = resampled[(i + 2) % count];
      for (let s = 0; s < samplesPerEdge; s++) {
        const t = s / samplesPerEdge;
        const t2 = t * t;
        const t3 = t2 * t;
        result.push({
          x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * t + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
          y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * t + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3)
        });
      }
    }
    return result;
  }


  function drawPolygon(graphics, points, fillColor, lineColor, fillAlpha, lineWidth) {
    graphics.fillStyle(fillColor, fillAlpha);
    graphics.fillPoints(points, true);
    graphics.lineStyle(lineWidth, lineColor, 0.95);
    graphics.strokePoints(points, true);
  }


  function pointInPolygon(x, y, polygonPoints) {
    let inside = false;
    for (let i = 0, j = polygonPoints.length - 1; i < polygonPoints.length; j = i++) {
      const xi = polygonPoints[i].x;
      const yi = polygonPoints[i].y;
      const xj = polygonPoints[j].x;
      const yj = polygonPoints[j].y;
      const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi + 0.000001) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }


  function distanceToSegment(x, y, start, end) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) {
      return Phaser.Math.Distance.Between(x, y, start.x, start.y);
    }
    const projection = Phaser.Math.Clamp(
      ((x - start.x) * dx + (y - start.y) * dy) / lengthSquared,
      0,
      1
    );
    const closestX = start.x + projection * dx;
    const closestY = start.y + projection * dy;
    return Phaser.Math.Distance.Between(x, y, closestX, closestY);
  }


  function getClosestPointOnSegment(x, y, start, end) {
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const lengthSquared = dx * dx + dy * dy;
    if (lengthSquared === 0) return { x: start.x, y: start.y };
    const ratio = Phaser.Math.Clamp(
      ((x - start.x) * dx + (y - start.y) * dy) / lengthSquared,
      0,
      1
    );
    return { x: start.x + dx * ratio, y: start.y + dy * ratio };
  }


  // 闭合多边形上离给定点最近的边缘落点：逐条边求最近点后取最近的一条。
  // 只在点击这类低频操作里用（两三个红区 + 一条可行动区轮廓，共两百条边左右），
  // 没必要像逐帧判定那样给它建空间索引
  function getPolygonNearestEdgePoint(polygon, x, y) {
    if (!polygon || polygon.length < 2) return null;
    let best = null;
    for (let index = 0; index < polygon.length; index++) {
      const point = getClosestPointOnSegment(
        x,
        y,
        polygon[index],
        polygon[(index + 1) % polygon.length]
      );
      const distance = Math.hypot(point.x - x, point.y - y);
      if (!best || distance < best.distance) best = { distance, point, edgeIndex: index };
    }
    return best;
  }


  // 红区外法线：候选法线外推 1.5 像素后仍落在多边形内部时取反向
  function getOutwardNormal(zone, edgeIndex) {
    const start = zone[edgeIndex];
    const end = zone[(edgeIndex + 1) % zone.length];
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length = Math.max(0.0001, Math.hypot(dx, dy));
    const normal = { x: dy / length, y: -dx / length };
    const midpointX = (start.x + end.x) / 2;
    const midpointY = (start.y + end.y) / 2;
    if (pointInPolygon(midpointX + normal.x * 1.5, midpointY + normal.y * 1.5, zone)) {
      return { x: -normal.x, y: -normal.y };
    }
    return normal;
  }


  function getRingNearestDistance(ring, point) {
    let best = Infinity;
    for (let i = 0; i < ring.length; i++) {
      const distance = Phaser.Math.Distance.Between(point.x, point.y, ring[i].x, ring[i].y);
      if (distance < best) best = distance;
    }
    return best;
  }


  // 把点投影到闭合轮廓折线上，返回投影坐标与所在弦的起始索引。
  // 逐段只用标量运算、不新建临时对象：轮廓折线动辄数百条弦，逐帧调用时这里是 GC 的一处来源
  function projectPointOnContour(point, contour) {
    const count = contour.length;
    const pointX = point.x;
    const pointY = point.y;
    let bestIndex = -1;
    let bestRatio = 0;
    let bestDistanceSquared = Infinity;
    for (let index = 0; index < count; index++) {
      const start = contour[index];
      const end = contour[(index + 1) % count];
      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const lengthSquared = dx * dx + dy * dy;
      let ratio = 0;
      if (lengthSquared !== 0) {
        ratio = Phaser.Math.Clamp(
          ((pointX - start.x) * dx + (pointY - start.y) * dy) / lengthSquared,
          0,
          1
        );
      }
      const offsetX = pointX - (start.x + dx * ratio);
      const offsetY = pointY - (start.y + dy * ratio);
      const distanceSquared = offsetX * offsetX + offsetY * offsetY;
      if (distanceSquared < bestDistanceSquared) {
        bestDistanceSquared = distanceSquared;
        bestIndex = index;
        bestRatio = ratio;
      }
    }
    if (bestIndex < 0) return { x: pointX, y: pointY, index: 0 };
    const bestStart = contour[bestIndex];
    const bestEnd = contour[(bestIndex + 1) % count];
    return {
      x: bestStart.x + (bestEnd.x - bestStart.x) * bestRatio,
      y: bestStart.y + (bestEnd.y - bestStart.y) * bestRatio,
      index: bestIndex,
      distance: Math.sqrt(bestDistanceSquared)
    };
  }


  // 轮廓上离某点最近的采样索引
  function getNearestContourIndex(contour, point) {
    let bestIndex = 0;
    let bestDistance = Infinity;
    contour.forEach((vertex, index) => {
      const distance = Phaser.Math.Distance.Between(point.x, point.y, vertex.x, vertex.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    return bestIndex;
  }


  // 沿轮廓按给定方向从一个索引绕到另一个索引的折线长度。
  // 用环绕前缀弧长 O(1) 求出：原先要逐段累加，每次贴边滑动都要跑两遍全环（数百段），
  // 是逐帧逐单位调用量较大的一处。fromIndex === toIndex 时与旧实现一致返回整圈长度
  function getContourArcLength(contour, fromIndex, toIndex, direction, arcPrefix) {
    const count = contour.length;
    const total = arcPrefix[count];
    if (!(total > 0)) return 0;
    if (fromIndex === toIndex) return total;
    const span = direction > 0
      ? arcPrefix[toIndex] - arcPrefix[fromIndex]
      : arcPrefix[fromIndex] - arcPrefix[toIndex];
    return ((span % total) + total) % total;
  }


  function getCurvedEdgePaths(start, end, polygons, edgeClearance = 30, redClearance = ENEMY_RED_ZONE_CLEARANCE) {
    const paths = [];
    const requiresRedClearance = polygons === collisionRegions.redForbiddenZones;
    polygons.forEach(polygon => {
      const center = polygon.reduce((sum, point) => ({
        x: sum.x + point.x / polygon.length,
        y: sum.y + point.y / polygon.length
      }), { x: 0, y: 0 });
      const edgePoints = [];
      for (let i = 0; i < polygon.length; i++) {
        const a = polygon[i];
        const b = polygon[(i + 1) % polygon.length];
        [0, 0.25, 0.5, 0.75].forEach(ratio => {
          const point = { x: a.x + (b.x - a.x) * ratio, y: a.y + (b.y - a.y) * ratio };
          const isWalkableEdge = polygon === collisionRegions.walkableBoundary;
          const offsetX = (point.x - center.x) * (isWalkableEdge ? -1 : 1);
          const offsetY = (point.y - center.y) * (isWalkableEdge ? -1 : 1);
          const length = Math.max(1, Math.hypot(offsetX, offsetY));
          const safePoint = {
            x: Phaser.Math.Clamp(point.x + offsetX / length * edgeClearance, 0, WORLD_WIDTH),
            y: Phaser.Math.Clamp(point.y + offsetY / length * edgeClearance, 0, WORLD_HEIGHT)
          };
          if (isWalkable(safePoint.x, safePoint.y)) edgePoints.push(safePoint);
        });
      }
      if (edgePoints.length < 2) return;
      const nearestStart = edgePoints.reduce((index, point, i) =>
        Phaser.Math.Distance.Between(start.x, start.y, point.x, point.y) <
        Phaser.Math.Distance.Between(start.x, start.y, edgePoints[index].x, edgePoints[index].y) ? i : index, 0);
      const nearestEnd = edgePoints.reduce((index, point, i) =>
        Phaser.Math.Distance.Between(end.x, end.y, point.x, point.y) <
        Phaser.Math.Distance.Between(end.x, end.y, edgePoints[index].x, edgePoints[index].y) ? i : index, 0);
      [1, -1].forEach(direction => {
        const edgePath = [];
        let index = nearestStart;
        for (let count = 0; count <= edgePoints.length; count++) {
          edgePath.push(edgePoints[index]);
          if (index === nearestEnd) break;
          index = (index + direction + edgePoints.length) % edgePoints.length;
        }
        const path = [edgePath, [end]].flat();
        let previous = start;
        if (path.every(point => {
          const safe = requiresRedClearance
            ? isRedClearanceSafeSegment(previous, point, redClearance)
            : isSafePath(previous, point);
          previous = point;
          return safe;
        }) && isWalkable(end.x, end.y)) {
          paths.push(path);
        }
      });
    });
    return paths;
  }


  // 把点限制在以 origin 为圆心、maxDistance 为半径的范围内，保证单帧位移不超过预算
  function limitPointTowards(origin, point, maxDistance) {
    const dx = point.x - origin.x;
    const dy = point.y - origin.y;
    const distance = Math.hypot(dx, dy);
    if (!(distance > maxDistance) || distance <= 0) return point;
    const ratio = maxDistance / distance;
    return { x: origin.x + dx * ratio, y: origin.y + dy * ratio };
  }


  function segmentOrientation(p, q, r) {
    const value = (q.y - p.y) * (r.x - q.x) - (q.x - p.x) * (r.y - q.y);
    if (Math.abs(value) < 0.000001) return 0;
    return value > 0 ? 1 : 2;
  }


  function pointOnSegment(p, q, r) {
    return q.x >= Math.min(p.x, r.x) &&
      q.x <= Math.max(p.x, r.x) &&
      q.y >= Math.min(p.y, r.y) &&
      q.y <= Math.max(p.y, r.y);
  }


  // 相交判定：原先把 orientation / onSegment 写在函数体内，每次调用都要新建闭包，
  // 而红区穿越判定单次查询就要调用上百次，因此提到外层复用
  function segmentsIntersect(a, b, c, d) {
    const first = segmentOrientation(a, b, c);
    const second = segmentOrientation(a, b, d);
    const third = segmentOrientation(c, d, a);
    const fourth = segmentOrientation(c, d, b);
    if (first !== second && third !== fourth) return true;
    if (first === 0 && pointOnSegment(a, c, b)) return true;
    if (second === 0 && pointOnSegment(a, d, b)) return true;
    if (third === 0 && pointOnSegment(c, a, d)) return true;
    return fourth === 0 && pointOnSegment(c, b, d);
  }


  // 沿闭合多边形边缘按固定步长均匀采样，返回按「到查询点距离升序」排好的采样点，
  // 便于「从最近的边缘点开始往外找，找到第一个合法落点就停」
  function samplePolygonBoundaryOrdered(polygon, x, y, step) {
    const samples = [];
    for (let index = 0; index < polygon.length; index++) {
      const start = polygon[index];
      const end = polygon[(index + 1) % polygon.length];
      const length = Math.hypot(end.x - start.x, end.y - start.y);
      const count = Math.max(1, Math.round(length / step));
      for (let k = 0; k < count; k++) {
        const ratio = k / count;
        const point = {
          x: start.x + (end.x - start.x) * ratio,
          y: start.y + (end.y - start.y) * ratio,
          edgeIndex: index
        };
        point.distance = Math.hypot(point.x - x, point.y - y);
        samples.push(point);
      }
    }
    samples.sort((a, b) => a.distance - b.distance);
    return samples;
  }


  // 0..1 的平滑过渡曲线（首尾速度均为 0）：阵型形态与队形旋转都用它缓动，
  // 起步与收尾都不会出现速度突变，观感上比线性插值自然
  function smoothStep01(value) {
    const t = Phaser.Math.Clamp(value, 0, 1);
    return t * t * (3 - 2 * t);
  }

export { resampleClosedPath, getSmoothClosedPath, drawPolygon, pointInPolygon, distanceToSegment, getClosestPointOnSegment, getPolygonNearestEdgePoint, getOutwardNormal, getRingNearestDistance, projectPointOnContour, getNearestContourIndex, getContourArcLength, getCurvedEdgePaths, limitPointTowards, segmentOrientation, pointOnSegment, segmentsIntersect, samplePolygonBoundaryOrdered, smoothStep01 };
