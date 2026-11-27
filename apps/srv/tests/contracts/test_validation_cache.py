"""同一安装的多个请求和不同组件共享规范；源码与 wheel 布局使用相同的引用解析。"""

import shutil
from collections import Counter
from importlib.util import module_from_spec, spec_from_file_location
from pathlib import Path
from unittest.mock import Mock

import pytest
from jsonschema import ValidationError

from veriq_server import validation


@pytest.fixture(name="isolated_validation")
def _isolated_validation():
    """在独立模块中调用正式校验入口，使每种布局从全新的组件缓存开始，同时保留其它测试使用的进程缓存。"""
    spec = spec_from_file_location("isolated_validation", validation.__file__)
    assert spec and spec.loader
    module = module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


@pytest.mark.parametrize("installed", [False, True], ids=["source", "wheel-layout"])
def test_repeated_validation_loads_each_resource_once(
    tmp_path, monkeypatch, installed, isolated_validation
):
    """分别从源码树和安装包加载相同的契约，交替提交合法与非法请求，确认每份契约只被读取一次。"""
    original = Path(validation.__file__).resolve().parents[4] / "packages/contracts"
    counts = Counter()
    read = Path.read_text
    if installed:
        package = tmp_path / "package"
        (package / "_schemas").mkdir(parents=True)
        shutil.copyfile(original / "openapi/platform.yaml", package / "_openapi.json")
        shutil.copyfile(
            original / "schemas/platform-v1.schema.json",
            package / "_schemas/platform-v1.schema.json",
        )
        monkeypatch.setattr(
            isolated_validation, "__file__", str(tmp_path / "a/b/c/d/validation.py")
        )
        monkeypatch.setattr(isolated_validation, "files", lambda unused: package)

    def count(path, *args, **kwargs):
        counts[path.name] += 1
        return read(path, *args, **kwargs)

    construct = Mock(wraps=isolated_validation.Draft202012Validator)
    monkeypatch.setattr(isolated_validation, "Draft202012Validator", construct)
    monkeypatch.setattr(Path, "read_text", count)
    for _ in range(3):
        isolated_validation.validate_api("ReportStreamRequest", {})
        with pytest.raises(ValidationError):
            isolated_validation.validate_api("SetupRequest", {})
    assert counts == {
        "_openapi.json" if installed else "platform.yaml": 1,
        "platform-v1.schema.json": 1,
    }
    assert construct.call_count == 2
