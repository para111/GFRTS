"""从 unit_database.sql 生成 unit_db.js（兼容旧命令入口）。

生成器已合并到 backend/tools/build_unit_db.py：它以 FB/unit_database.sql 为唯一真源，
一次性同步产出 backend/data/units.json、FB/unit_db.js 与 backend/data/unit_database.sql 镜像。
本文件只是转发壳，逻辑一律在后端工具目录维护：

    python build_unit_db.py            # 等价于 python backend/tools/build_unit_db.py
    python build_unit_db.py --check    # 校验 units.json / unit_db.js / 镜像 SQL 与真源同步
"""

import os
import runpy
import sys

_TARGET = os.path.normpath(os.path.join(
    os.path.dirname(os.path.abspath(__file__)),
    "..", "backend", "tools", "build_unit_db.py"))

if not os.path.exists(_TARGET):
    sys.exit(f"生成器不存在：{_TARGET}（请检查 backend/tools/build_unit_db.py 是否被移动）")

runpy.run_path(_TARGET, run_name="__main__")
