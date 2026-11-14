#!/usr/bin/env bash
# 启动脚本仅接受已经安装的虚拟环境和外置配置路径，以 exec 保留生产进程的信号与退出语义；不会在每个实例启动时自动迁移数据库，也不会把运行数据写回 Python 安装目录。
set -euo pipefail
venv="${1:?Usage: start.sh /absolute/venv /absolute/config.json}"
config="${2:?External configuration is required}"
exec "$venv/bin/python" -B -m veriq_server --config "$config" serve
