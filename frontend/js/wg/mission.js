// ============================================================
// 任务系统 —— mission.js（WG / WG2 共用）
// 职责: 右上角任务清单 UI + 任务完成度判定（供结算接入）
// 隔离原则: WG 的任务清单与既有胜负条件严格等价（坚持 8 分钟 + 番茄 > 0），
//           WG2 追加 10 分钟时长与大桥任务；大桥状态只由 wg2/bridge.js 写入
// UI 位置: 屏幕右上角设置齿轮与音乐按钮的正下方，不遮挡任何按键
// 注意: 本模块被 scene.js 静态导入，处于 state ⇄ 领域模块的循环导入环内，
//       顶层禁止读取 state.js 的任何导出（TDZ），全部惰性到函数运行时（引导完成后才被调用）
// ============================================================

import { S } from './S.js';
import { IS_WG2, MATCH_DURATION_MS } from './state.js';

// 各模式的任务定义（顺序即展示顺序）：
//   WG  —— 与既有胜负判定完全一致：8 分钟存活 + 番茄 > 0
//   WG2 —— 10 分钟存活 + 番茄 > 0 + 破坏大桥
// 任务项: id / 标题 / 进度文本函数（每秒刷新，返回 null 表示不显示进度）
let taskCache = null;

function getTasks() {
  if (taskCache) return taskCache;
  const surviveTask = {
    id: 'survive',
    title: IS_WG2 ? '坚持 10 分钟' : '坚持 8 分钟',
    progress: () => {
      const remain = Math.max(0, MATCH_DURATION_MS - S.matchElapsedMs);
      const m = Math.floor(remain / 60000);
      const sec = Math.floor((remain % 60000) / 1000);
      return '剩余 ' + m + ':' + String(sec).padStart(2, '0');
    }
  };
  const tomatoTask = {
    id: 'tomato',
    title: '番茄点数大于 0',
    progress: () => '当前 ' + S.tomatoCount
  };
  const bridgeTask = {
    id: 'bridge',
    title: '破坏大桥（点击锁定），阻止敌方攻势',
    progress: () => {
      if (S.bridgeDestroyed) return null;
      const hp = typeof S.bridgeHp === 'number' ? Math.ceil(S.bridgeHp) : 50000;
      return '大桥耐久 ' + hp + '/50000';
    }
  };
  taskCache = IS_WG2 ? [surviveTask, tomatoTask, bridgeTask] : [surviveTask, tomatoTask];
  return taskCache;
}

// 单个任务的完成判定
function isTaskComplete(task) {
  if (task.id === 'survive') return S.matchElapsedMs >= MATCH_DURATION_MS;
  if (task.id === 'tomato') return S.tomatoCount > 0;
  if (task.id === 'bridge') return !!S.bridgeDestroyed;
  return false;
}

// 全部任务是否完成（结算入口：WG 模式下与旧 endMatch(S.tomatoCount > 0) 严格等价——
// survive 在超时判定时刻必为 true，tomato 同值）
function allTasksComplete() {
  return getTasks().every(task => isTaskComplete(task));
}

// ------------------------------------------------------------
// UI：容器 + 圆角底板 + 标题 + 每任务一行（状态圆点 + 标题 + 进度）
// 创建一次，位置逐帧跟随相机（与设置齿轮同一套反向补偿），文本按秒去重刷新
// ------------------------------------------------------------
// 布局：每个任务占两行——标题一行、进度独立一行（初版进度拼在标题同行显得拥挤，已拆开）
const PANEL_LINE_H = 48;   // 单个任务行块高度（标题 ~20px + 进度 ~16px + 行间距）
const PANEL_PAD_X = 12;
const PANEL_TITLE_H = 36;

let panel = null;          // { container, bg, titleText, rows, closeBtn, width }
let lastRenderKey = '';    // 内容去重：没有变化就不重写文本
let panelCollapsed = false; // 「—」按钮收起状态：收起时只留「+」按钮，整块面板隐藏

function initMissionPanel(scene) {
  if (panel || !scene) return;
  const container = scene.add.container(0, 0);
  container.setDepth(902);   // 设置齿轮(901)之上、其余玩法对象之下：只覆盖自己的面板区域

  const bg = scene.add.graphics();
  container.add(bg);

  const titleText = scene.add.text(PANEL_PAD_X, 6, '任务目标', {
    fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
    fontSize: '17px',
    fontStyle: 'bold',
    color: '#ffd93d',
    stroke: '#20232a',
    strokeThickness: 3,
    resolution: 2
  });
  container.add(titleText);

  // 右上角独立框关闭按钮：圆角小方框 + 居中「—」（收起后变「+」），带悬停高亮。
  // 游戏对象事件先于场景级 pointerdown 触发，stopPropagation 同时挡住
  // 场景级框选起点与 pointerup 的世界点击，点按钮不会下发任何指令
  const closeBg = scene.add.graphics();
  const closeBtn = scene.add.text(0, 0, '—', {
    fontFamily: '"Segoe UI", sans-serif',
    fontSize: '14px',
    color: '#9fe3ff',
    resolution: 2
  });
  closeBtn.setOrigin(0.5, 0.5);
  closeBtn.setInteractive(new Phaser.Geom.Rectangle(-13, -10, 26, 20), Phaser.Geom.Rectangle.Contains);
  closeBtn.on('pointerdown', (pointer, localX, localY, event) => {
    if (pointer.button !== 0) return;
    event.stopPropagation();
    setPanelCollapsed(!panelCollapsed);
  });
  closeBtn.on('pointerover', () => drawCloseButton(true));
  closeBtn.on('pointerout', () => drawCloseButton(false));
  container.add(closeBg);
  container.add(closeBtn);

  const rows = getTasks().map((task, index) => {
    const y = PANEL_TITLE_H + index * PANEL_LINE_H;
    // 状态圆点与标题同行；进度自占一行（缩进与标题对齐，字号更小、颜色更暗）
    const dot = scene.add.circle(PANEL_PAD_X + 7, y + 10, 5, 0x2a3140);
    dot.setStrokeStyle(1.5, 0x9fe3ff, 0.9);
    const text = scene.add.text(PANEL_PAD_X + 22, y, task.title, {
      fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
      fontSize: '15px',
      color: '#e8f4ff',
      stroke: '#20232a',
      strokeThickness: 3,
      resolution: 2
    });
    const prog = scene.add.text(PANEL_PAD_X + 22, y + 24, '', {
      fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif',
      fontSize: '12px',
      color: '#9fe3ff',
      stroke: '#20232a',
      strokeThickness: 2,
      resolution: 2
    });
    container.add(dot);
    container.add(text);
    container.add(prog);
    return { task, dot, text, prog };
  });

  panel = { container, bg, titleText, rows, closeBg, closeBtn };
  redrawPanelBackground();
}

// 关闭按钮小框：26x20 圆角矩形，独立于面板底板；hover 时描边加亮、底色提亮
function drawCloseButton(hover) {
  if (!panel) return;
  panel.closeBg.clear();
  panel.closeBg.fillStyle(hover ? 0x1c2740 : 0x0a1220, 0.92);
  panel.closeBg.fillRoundedRect(-13, -10, 26, 20, 5);
  panel.closeBg.lineStyle(1.2, hover ? 0xffffff : 0x9fe3ff, hover ? 0.95 : 0.65);
  panel.closeBg.strokeRoundedRect(-13, -10, 26, 20, 5);
}

// 收起 / 展开面板：收起时隐藏底板与全部行，只留「+」按钮（位置沿用面板右上角）；
// lastRenderKey 置空让下一帧强制重刷文本内容
function setPanelCollapsed(collapsed) {
  panelCollapsed = collapsed;
  panel.bg.visible = !collapsed;
  panel.titleText.visible = !collapsed;
  panel.rows.forEach(row => {
    row.dot.visible = !collapsed;
    row.text.visible = !collapsed;
    row.prog.visible = !collapsed;
  });
  panel.closeBtn.setText(collapsed ? '+' : '—');
  drawCloseButton(false);
  lastRenderKey = '';
}

// 重绘底板：宽度取各行文本的最大宽度 + 内边距（内容变化时调用）
function redrawPanelBackground() {
  if (!panel) return;
  let maxW = 96;
  panel.rows.forEach(row => {
    // 标题与进度各占一行：取两者较宽者（进度有 2px 额外缩进）参与宽度计算
    maxW = Math.max(maxW, row.text.width + PANEL_PAD_X * 2 + 8, row.prog.width + PANEL_PAD_X * 2 + 10);
  });
  const height = PANEL_TITLE_H + panel.rows.length * PANEL_LINE_H + 10;
  panel.width = maxW;   // 定位用：容器是左上角原点，右对齐时需要扣掉自身宽度
  // 关闭按钮（独立小框）贴面板右上角，与标题「任务目标」同行垂直居中
  panel.closeBg.setPosition(maxW - 22, 17);
  panel.closeBtn.setPosition(maxW - 22, 17);
  drawCloseButton(false);
  panel.bg.clear();
  panel.bg.fillStyle(0x060a14, 0.78);
  panel.bg.fillRoundedRect(0, 0, maxW, height, 10);
  panel.bg.lineStyle(1, 0x9fe3ff, 0.55);
  panel.bg.strokeRoundedRect(0, 0, maxW, height, 10);
}

// 逐帧刷新：位置跟随相机右上角（齿轮正下方），文本按内容去重更新
function updateMissionHud(worldScale) {
  if (!panel || !S.gameScene) return;
  const scene = S.gameScene;
  const camera = scene.cameras.main;
  if (!camera || worldScale <= 0) return;
  const margin = 8 / worldScale;
  const viewLeft = camera.scrollX + (camera.width - camera.width / camera.zoom) / 2;
  const viewTop = camera.scrollY + (camera.height - camera.height / camera.zoom) / 2;
  // 与设置齿轮同一行参考：齿轮中心在 viewTop + margin + 22/worldScale（44 屏幕像素高），
  // 面板顶部再下移 56 屏幕像素，保证不遮挡齿轮与音乐按钮。
  // x 注意：齿轮是中心原点、面板容器是左上角原点——必须再减面板自身宽度（世界单位 = width/worldScale），
  // 否则面板整体伸到屏幕右缘之外（初版正是漏了这一步导致「任务系统不显示」）
  panel.container.setScale(1 / worldScale);
  panel.container.setPosition(
    viewLeft + camera.width / camera.zoom - margin - panel.width / worldScale,
    viewTop + margin + 56 / worldScale
  );

  // 内容去重刷新（任务完成状态 / 进度文本）
  const renderKey = getTasks().map(task => (isTaskComplete(task) ? 1 : 0)).join('') +
    '|' + Math.floor(S.matchElapsedMs / 1000) +
    '|' + S.tomatoCount +
    '|' + (IS_WG2 ? (S.bridgeDestroyed ? '1' : Math.ceil(S.bridgeHp || 50000)) : '');
  if (renderKey === lastRenderKey) return;
  lastRenderKey = renderKey;
  let contentChanged = false;
  panel.rows.forEach(row => {
    const done = isTaskComplete(row.task);
    // 圆点：完成=实心绿；未完成=暗底蓝描边
    row.dot.setFillStyle(done ? 0x2ecc71 : 0x2a3140);
    const progress = done ? null : (row.task.progress ? row.task.progress() : null);
    // 进度自占一行，不再需要全角空格缩进前缀（初版与标题同行时的遗留）
    const progText = progress || '';
    if (row.prog.text !== progText) {
      row.prog.setText(progText);
      contentChanged = true;
    }
    // 完成的任务标题变绿打勾，未完成的保持白色
    const titleText = (done ? '✓ ' : '· ') + row.task.title;
    if (row.text.text !== titleText) {
      row.text.setText(titleText);
      row.text.setColor(done ? '#7be3a0' : '#e8f4ff');
      contentChanged = true;
    }
  });
  if (contentChanged) redrawPanelBackground();
}

export { initMissionPanel, updateMissionHud, allTasksComplete };
