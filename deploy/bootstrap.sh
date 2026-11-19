#!/usr/bin/env bash
# 初始化只操作已经安装的独立环境与明确外置的配置，先准备私有制品目录再调用既有迁移和一次性管理员创建；
# 数据库地址通过受保护环境或交互输入提供，脚本不输出任何密钥也不替换现有配置。
set -euo pipefail
umask 077
venv="${1:?Usage: bootstrap.sh /absolute/venv /absolute/config.json /absolute/artifact-root admin-email display-name}"
config="${2:?External configuration is required}"
artifact_root="${3:?Artifact directory is required}"
email="${4:?Administrator email is required}"
display_name="${5:?Administrator display name is required}"
for path in "$venv" "$config" "$artifact_root"; do
    case "$path" in
        /*) ;;
        *) echo "Bootstrap paths must be absolute" >&2; exit 2 ;;
    esac
done
if [[ -L "$artifact_root" ]]; then
    echo "Artifact root must not be a symbolic link" >&2
    exit 2
fi
mkdir -p -- "$artifact_root"
chmod 700 -- "$artifact_root"
export VERIQ_ARTIFACT_DIRECTORY="$artifact_root"
"$venv/bin/python" -B -m veriq_server --config "$config" init
"$venv/bin/python" -B -m veriq_server --config "$config" create-admin --email "$email" --display-name "$display_name"
echo "VeriQ bootstrap complete. Install the explicit migration and control service units before enabling traffic."
