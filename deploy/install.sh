#!/usr/bin/env bash
# 离线安装入口只在操作员明确指定的新目录创建 Python3.12 虚拟环境，并从已校验发行目录的 wheelhouse 安装依赖；已有环境拒绝覆盖，外置配置、数据库和制品不会被安装器修改。
set -euo pipefail
release_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
target="${1:?Usage: install.sh /absolute/new/venv}"
case "$target" in
    /*) ;;
    *) echo "Installation target must be absolute" >&2; exit 2 ;;
esac
if [[ -e "$target" ]]; then
    echo "Installation target already exists" >&2
    exit 1
fi
cd -- "$release_dir"
sha256sum --check sha256sums
python3.12 -m venv "$target"
"$target/bin/python" -m pip install --no-index --find-links "$release_dir/wheelhouse" "$release_dir"/veriq_server-*.whl
echo "VeriQ installed. Initialize external configuration before starting."
