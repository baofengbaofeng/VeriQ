#!/bin/sh
# 软件包升级与回滚必须先停止 VeriQ 的全部自有角色，脚本不终止同名或未知进程、不修改桌面全局沙箱限制；安装目录和用户档案分离，任何失败均保留原有证据供显式恢复。
set -eu
for veriq_name in veriq veriq_agent veriq_runner veriq_cli; do
    if pgrep -x "$veriq_name" >/dev/null 2>&1; then
        echo "VeriQ package operation blocked: stop VeriQ processes first." >&2
        exit 1
    else
        veriq_status=$?
        if [ "$veriq_status" -ne 1 ]; then
            echo "VeriQ process status is unconfirmed; package operation refused." >&2
            exit 1
        fi
    fi
done
exit 0
