#!/bin/sh
# 卸载只移除包管理器登记的应用文件并默认保留配置、设备凭据和报告，操作前拒绝仍运行的产品角色；秘密退役必须在卸载前由用户通过现有显式流程处理，不能把删除目录误称为介质擦除。
set -eu
for veriq_name in veriq veriq_agent veriq_runner veriq_cli; do
    if pgrep -x "$veriq_name" >/dev/null 2>&1; then
        echo "VeriQ removal blocked: stop VeriQ processes first. User data is retained." >&2
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
