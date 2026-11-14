#!/usr/bin/env bash
# 发行入口只定位当前源码根并交给冻结 Python 环境执行，参数完整传递给构建器；不在用户 HOME 安装工具，也不通过 shell 拼接动态路径执行未经校验的清理命令。
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
exec uv run --project apps/srv --frozen --all-groups python scripts/build_release.py "$@"
