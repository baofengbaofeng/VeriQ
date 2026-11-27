"""同一安装的多个请求和不同组件共享规范；源码与 wheel 布局使用相同的引用解析。"""

import shutil
from collections import Counter
from pathlib import Path

import pytest
from jsonschema import ValidationError

from veriq_server import validation


@pytest.mark.parametrize("installed", [False, True], ids=["source", "wheel-layout"])
def test_repeated_validation_loads_each_resource_once(tmp_path, monkeypatch, installed):
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
        monkeypatch.setattr(validation, "__file__", str(tmp_path / "a/b/c/d/validation.py"))
        monkeypatch.setattr(validation, "files", lambda unused: package)

    def count(path, *args, **kwargs):
        counts[path.name] += 1
        return read(path, *args, **kwargs)

    caches = (validation.api_document, validation._schema_registry, validation._component_validator)
    for cached in caches:
        cached.cache_clear()
    try:
        monkeypatch.setattr(Path, "read_text", count)
        for _ in range(3):
            validation.validate_api("ReportStreamRequest", {})
            with pytest.raises(ValidationError):
                validation.validate_api("SetupRequest", {})
        assert counts == {
            "_openapi.json" if installed else "platform.yaml": 1,
            "platform-v1.schema.json": 1,
        }
        assert validation._component_validator.cache_info().misses == 2
    finally:
        for cached in caches:
            cached.cache_clear()
