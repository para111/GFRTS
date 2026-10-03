// ============================================================
// wg_game 模块化拆分 —— sandbox.js
// 职责: 调试沙盒面板
// 来源: wg_game.js 语句区间 6932-6932（自动拆分，勿手工重排语句顺序）
// ============================================================

import { getPlayerStatRatings, getPlayerUnitRecord } from './records.js';
import { PLAYER_CHARACTER_SCALE, PLAYER_STAT_COLUMNS, PLAYER_STAT_RATING_COLORS, PLAYER_STAT_RATING_LABELS, SANDBOX_PANEL_HEIGHT, SANDBOX_PANEL_MARGIN, SANDBOX_PANEL_WIDTH, SANDBOX_UNIT_ZONE_WIDTH, SPAWN_HUD_DEPTH, playerSquads } from './state.js';
import { resolveUnitRenderParts } from './units-visual.js';

  function createSandboxPanel(scene) {
    const halfW = SANDBOX_PANEL_WIDTH / 2;
    const halfH = SANDBOX_PANEL_HEIGHT / 2;
    const root = scene.add.container(0, 0).setDepth(SPAWN_HUD_DEPTH).setVisible(false);
    const bg = scene.add.graphics();
    bg.fillStyle(0x0d1117, 0.92);
    bg.fillRoundedRect(-halfW, -halfH, SANDBOX_PANEL_WIDTH, SANDBOX_PANEL_HEIGHT, 10);
    bg.lineStyle(2, 0x9fe3ff, 0.9);
    bg.strokeRoundedRect(-halfW, -halfH, SANDBOX_PANEL_WIDTH, SANDBOX_PANEL_HEIGHT, 10);
    // 左右分区的分隔竖线
    const dividerX = -halfW + SANDBOX_UNIT_ZONE_WIDTH;
    bg.lineStyle(1, 0x9fe3ff, 0.35);
    bg.lineBetween(dividerX, -halfH + 8, dividerX, halfH - 8);
    root.add(bg);
    // 左区：队形骨架容器（show 时按兵种重建）
    const unitZone = scene.add.container(dividerX - SANDBOX_UNIT_ZONE_WIDTH / 2, 0);
    root.add(unitZone);
    // 右区：实时血量条（固定长度、不显示数值）+ 六维评级（评级口径与出兵预览格完全一致）
    const SANDBOX_HP_BAR_WIDTH = 160;     // 血条固定长度（面板内部像素，所有单位统一）
    const SANDBOX_HP_BAR_HEIGHT = 10;
    const colLabelX = [dividerX + 14, dividerX + 92];
    const hpBar = scene.add.graphics();
    root.add(hpBar);
    const ratingTexts = PLAYER_STAT_COLUMNS.map(([label], index) => {
      const column = Math.floor(index / 3);
      const row = index % 3;
      const cellX = colLabelX[column];
      const cellY = -halfH + 38 + row * 26;
      const labelText = scene.add.text(cellX, cellY, label, {
        fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
        fontSize: '13px', color: '#c9d6e5', resolution: 2
      });
      const ratingText = scene.add.text(cellX + 62, cellY - 1, '', {
        fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
        fontSize: '14px', fontStyle: 'bold', color: '#ffffff', resolution: 2
      }).setOrigin(1, 0);
      root.add(labelText);
      root.add(ratingText);
      return ratingText;
    });
    // 左区队形骨架：与出兵预览格同一套摆位与越界缩进（只缩一次，不逐帧）
    function buildSkeleton(unitKey) {
      unitZone.removeAll(true);
      const record = getPlayerUnitRecord(unitKey);
      const roster = Array.isArray(record.roster) && record.roster.length ? record.roster : ['JF'];
      const scale = record.character_scale || PLAYER_CHARACTER_SCALE;
      const side = record.formation_side || 56;
      const slots = roster.length === 3
        ? [[0, -side * 0.55], [-side * 0.58, side * 0.45], [side * 0.58, side * 0.45]]
        : roster.length === 2 ? [[-34, 0], [38, 0]] : [[0, 0]];
      const formation = scene.add.container(0, 0);
      unitZone.add(formation);
      roster.forEach((name, index) => {
        const slot = slots[index] || slots[0];
        resolveUnitRenderParts(record, name).forEach(partKey => {
          try {
            const part = scene.add.spine(slot[0], slot[1], partKey, 'wait', true);
            part.setScale(scale);
            formation.add(part);
          } catch (error) { /* 骨架缺失时跳过该部件，其余部件照常展示 */ }
        });
      });
      let mainPart = null;
      for (const part of formation.list) {
        if (part.getBounds) mainPart = part;
      }
      if (mainPart) {
        try {
          const bounds = mainPart.getBounds();
          if (bounds.height > 0 && bounds.width > 0) {
            const fit = Math.min(1,
              (SANDBOX_PANEL_HEIGHT - 24) / bounds.height,
              (SANDBOX_UNIT_ZONE_WIDTH - 14) / bounds.width);
            formation.setScale(fit);
          }
        } catch (error) { /* 包围盒异常时保持原缩放，不影响显示 */ }
      }
    }
    return {
      // 每帧调用：有选中的出战小队就贴着屏幕右下角显示并刷新血量；
      // 无选中 / 出战结束即隐藏并释放骨架。多队同时选中时展示第一支
      update() {
        const camera = scene.cameras.main;
        const squad = playerSquads.find(entry =>
          entry.unit && entry.unit.isSpawned && entry.unit.isSelected) || null;
        if (!squad) {
          if (root.visible) {
            root.setVisible(false);
            unitZone.removeAll(true);
          }
          return;
        }
        // 固定大小：按相机缩放反向补偿，任何缩放级别下面板都是恒定屏幕尺寸
        const zoom = camera.zoom || 1;
        const inverse = 1 / zoom;
        root.setScale(inverse);
        root.setPosition(
          camera.worldView.right - (SANDBOX_PANEL_MARGIN + halfW) * inverse,
          camera.worldView.bottom - (SANDBOX_PANEL_MARGIN + halfH) * inverse
        );
        const key = squad.unitKey || 'jf';
        if (!root.visible || unitZone.__unitKey !== key) {
          unitZone.__unitKey = key;
          buildSkeleton(key);
          const ratings = getPlayerStatRatings();
          PLAYER_STAT_COLUMNS.forEach(([, column], index) => {
            const level = ratings[key + '.' + column];
            ratingTexts[index].setText(PLAYER_STAT_RATING_LABELS[level === undefined ? 1 : level]);
            ratingTexts[index].setColor(PLAYER_STAT_RATING_COLORS[level === undefined ? 1 : level]);
          });
        }
        // 逐队员血条：该兵种有几个基础单位就画几条（JF 三条 / 404 两条 / 单人单位一条），
        // 血条显示区按条数**横向（左右）等分**，每条占一段等宽区间；阵亡离场的队员对应条
        // 保持空底，条数始终与兵种构成一致
        const sandboxRecord = getPlayerUnitRecord(key);
        const rosterCount = Array.isArray(sandboxRecord.roster) && sandboxRecord.roster.length
          ? sandboxRecord.roster.length : 1;
        const barCount = Math.max(rosterCount, squad.members.length) || 1;
        const barY = -halfH + 12;            // 血条区纵向位置（与旧单条位置一致）
        const barAreaWidth = SANDBOX_HP_BAR_WIDTH;
        const segmentWidth = barAreaWidth / barCount;
        const barWidth = segmentWidth - 4;   // 段间留 4px 间隙
        const barHeight = Math.min(SANDBOX_HP_BAR_HEIGHT, 26 / barCount - 3);
        hpBar.clear();
        for (let barIndex = 0; barIndex < barCount; barIndex += 1) {
          const member = squad.members[barIndex];
          const ratio = member && member.maxHp > 0
            ? Phaser.Math.Clamp((member.hp || 0) / member.maxHp, 0, 1)
            : 0;
          const barX = dividerX + 14 + barIndex * segmentWidth;
          hpBar.fillStyle(0x000000, 0.55);
          hpBar.fillRect(barX, barY, barWidth, barHeight);
          hpBar.fillStyle(0x39d353, 0.95);
          hpBar.fillRect(barX, barY, barWidth * ratio, barHeight);
        }
        root.setVisible(true);
      }
    };
  }

export { createSandboxPanel };
