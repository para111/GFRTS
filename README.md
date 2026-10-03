守护番茄镇

这是一个追放同人网页小游戏，有很多未完善的功能，还请见谅

## 目录结构（前后端分离）

    fb/
    ├── frontend/                 前端（静态资源，唯一服务根）
    │   ├── WG.html               游戏对局页
    │   ├── first_in.html         开始界面
    │   ├── index.html            落地页
    │   ├── css/                  样式（tailwind.css，未被页面引用，仅留存）
    │   ├── js/                   客户端脚本（wg_game.js / map_data.js / unit_db.js /
    │   │                         phaser.min.js / SpinePlugin.min.js）
    │   ├── RTS/                  音乐素材
    │   ├── art -> （不在此处）    美术素材按约定保留在项目根 fb/art/
    │   └── bg.jpg 等图片资源
    ├── backend/                  后端（业务逻辑 / API / 服务器配置）
    │   ├── server.js             零依赖 Node 服务器：静态服务（gzip+ETag/304）+ 数据 API
    │   ├── data/                 API 下发数据（units.json / map.json）与镜像
    │   ├── source/               手工维护的真源（unit_database.sql / .xlsx / RTS.xlsx）
    │   ├── tools/                构建工具（build_unit_db.py / build_map_data.py /
    │   │                         unit_db_excel.py / perf_bench_130.js）
    │   └── supervisor.sh         沙箱环境守护脚本（本地运行无需理会）
    └── art/                      美术素材（Spine 骨架等，服务端对 /art/* 回退映射到此）

## 本地运行

    cd backend
    node server.js                # 默认 http://127.0.0.1:8080/（仅本机可访问）
    PORT=8090 方式：PowerShell 下 $env:PORT=8090; node server.js

游戏入口：http://127.0.0.1:8080/WG.html （或从 index.html / first_in.html 进入）
注意：本机 8080 被其他进程占用时用 PORT 换端口。

## API（前端数据接口，保持兼容）

    GET /api/health   健康检查
    GET /api/units    单位数值（真源 backend/source/unit_database.sql → data/units.json）
    GET /api/map      地图数据（真源 backend/data/map.json）

前端引导器 http 下优先取 API，失败回退 js/unit_db.js、js/map_data.js。

## 数据修改流程（只改真源，工具再生成）

    单位数值：编辑 backend/source/unit_database.sql → python backend/tools/build_unit_db.py
    地图数据：编辑 backend/data/map.json            → python backend/tools/build_map_data.py
    Excel 互转：python backend/tools/unit_db_excel.py --export / --import
    同步校验：两个 build 工具均支持 --check

## file:// 说明

双击 WG.html 可启动游戏逻辑（计时/布防/性能面板可用），但 Phaser 资源加载
走 XHR，浏览器对 file:// 强制 CORS 拦截（背景图/Spine 骨架加载失败，画面黑屏）。
本地游玩请一律通过上面的 HTTP 服务进入。
