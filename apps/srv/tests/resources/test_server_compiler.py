"""服务端编译执行器在启动 Node 前核查批准发行的全部文件，失败时保留可供作业协调器处理的稳定错误码。"""

from hashlib import sha256
import json

import pytest

from veriq_server.settings import Settings, load_settings


def test_release_roots_preserve_frozen_engine_versions(tmp_path, monkeypatch):
    """明确配置多版本目录后，历史作业只读取其冻结版本的目录，当前版本还能使用单发行路径完成过渡。"""
    from veriq_server.server_compiler import ServerCompileError, configured_release_path

    current, historical = tmp_path / "current", tmp_path / "historical"
    monkeypatch.setenv("VERIQ_SERVER_COMPILER_RELEASE_DIRS", json.dumps({"0.1.0": str(historical)}))
    settings = load_settings(
        tmp_path / "unconfigured.json",
        {
            "database_url": "mysql+asyncmy://test:test@localhost/veriq_test",
            "public_url": "https://veriq.example.test",
            "master_key": "ab" * 32,
            "signing_key": "cd" * 32,
            "validation_engine_version": "0.2.0",
            "server_compiler_release_dir": str(current),
        },
    )
    assert configured_release_path(settings, "0.2.0") == current
    assert configured_release_path(settings, "0.1.0") == historical
    with pytest.raises(ServerCompileError, match="SERVER_COMPILER_NOT_CONFIGURED"):
        configured_release_path(settings, "0.3.0")


@pytest.mark.asyncio
async def test_refuses_modified_engine_before_compilation(tmp_path):
    """发行清单批准的是具体字节，替换任一成员不能借助仍合法的文件名取得编译权限或生成可发布结果。"""
    from veriq_server.server_compiler import ServerCompileError, compile_snapshot

    release = tmp_path / "release"
    release.mkdir()
    files = {}
    for name in ("package.json", "package-lock.json", "dependencies.json", "engine/compiler.tgz"):
        path = release / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b"original")
        files[name] = {"path": name, "sizeBytes": 8, "sha256": sha256(b"original").hexdigest()}
    (release / "package.json").write_bytes(b"modified")
    settings = Settings.model_validate(
        {
            "database_url": "mysql+asyncmy://test:test@localhost/veriq_test",
            "public_url": "https://veriq.example.test",
            "master_key": "ab" * 32,
            "signing_key": "cd" * 32,
            "server_compiler_release_dir": str(release),
            "server_compiler_node_path": str(tmp_path / "node"),
            "server_compiler_npm_cli_path": str(tmp_path / "npm-cli.js"),
            "server_compiler_tsx_path": str(tmp_path / "tsx" / "dist" / "loader.mjs"),
        }
    )
    with pytest.raises(ServerCompileError, match="ENGINE_RELEASE_HASH_MISMATCH"):
        await compile_snapshot(
            settings,
            {"files": list(files.values()), "engineVersion": "0.1.0"},
            {"engineVersion": "0.1.0"},
            connected=False,
        )


@pytest.mark.asyncio
async def test_refuses_local_dependencies_outside_inventory(tmp_path):
    """即使发行清单包含锁文件，离线安装也不能读取它声明的任意宿主路径，只允许读取批准的本地 vendor 归档。"""
    from veriq_server.server_compiler import ServerCompileError, compile_snapshot

    release = tmp_path / "release"
    release.mkdir()
    (release / "engine").mkdir()
    content = {
        "package.json": json.dumps({"dependencies": {"sample": "file:../elsewhere"}}).encode(),
        "package-lock.json": b'{"lockfileVersion":3,"packages":{}}',
        "dependencies.json": b"[]",
        "engine/compiler.tgz": b"unused",
    }
    for name, data in content.items():
        (release / name).write_bytes(data)
    settings = Settings.model_validate(
        {
            "database_url": "mysql+asyncmy://test:test@localhost/veriq_test",
            "public_url": "https://veriq.example.test",
            "master_key": "ab" * 32,
            "signing_key": "cd" * 32,
            "server_compiler_release_dir": str(release),
        }
    )
    engine = {
        "engineVersion": "0.1.0",
        "files": [
            {"path": name, "sizeBytes": len(data), "sha256": sha256(data).hexdigest()}
            for name, data in content.items()
        ],
    }
    with pytest.raises(ServerCompileError, match="UNSAFE_ENGINE_LOCK"):
        await compile_snapshot(settings, engine, {"engineVersion": "0.1.0"}, connected=False)
