#!/bin/bash
# 游戏后端守护循环：node 进程退出后 2 秒自动重启。
# 幂等：通过 pidfile 防止重复拉起（startup.sh 钩子与 bashrc 钩子都会调用本脚本）。
PIDFILE=/tmp/fb-supervisor.pid
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then
    exit 0  # 已有守护在跑
fi
echo $$ > "$PIDFILE"

# node 可能不在非交互 shell 的 PATH 里（nvm 环境），做一次解析
NODE_BIN="$(command -v node 2>/dev/null || true)"
if [ -z "$NODE_BIN" ]; then
    NODE_BIN="$(ls -t /home/devbox/.nvm/versions/node/*/bin/node 2>/dev/null | head -1)"
fi
if [ -z "$NODE_BIN" ]; then
    echo "[supervisor] 找不到 node，退出" >&2
    exit 1
fi

cd /home/devbox/project || exit 1
LOG=/tmp/fb-server.log
echo "[supervisor] 守护启动 pid=$$ node=$NODE_BIN $(date '+%F %T')" >> "$LOG"
while true; do
    "$NODE_BIN" hello_world.js >> "$LOG" 2>&1
    echo "[supervisor] node 退出(代码 $?)，2 秒后重启 $(date '+%F %T')" >> "$LOG"
    sleep 2
done
