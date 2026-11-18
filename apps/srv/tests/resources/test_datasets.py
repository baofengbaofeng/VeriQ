"""使用与编译器相同的数据夹具确认服务端草稿入口接受合法结构，并将行值与树关系的业务验证留给现有可信编译环节。"""

import json
from pathlib import Path

import pytest

from veriq_server.service import Problem
from veriq_server.services.resource import check_document

ROOT = Path(__file__).resolve().parents[4]
FIXTURES = json.loads(
    (ROOT / "packages/contracts/fixtures/datasets.json").read_text(encoding="utf-8")
)


@pytest.mark.parametrize("fixture", FIXTURES, ids=[fixture["name"] for fixture in FIXTURES])
def test_dataset_document_structure(fixture):
    """标准资源校验应识别新版表格、树及空集合，但树行缺少序号或在表格附带树属性时须拒绝保存。"""
    content = {"kind": "DATASET", "document": fixture["document"]}
    if fixture.get("invalidStructure"):
        with pytest.raises(Problem) as error:
            check_document("DATASET", content)
        assert error.value.code == "INVALID_RESOURCE_DOCUMENT"
    else:
        check_document("DATASET", content)


def test_legacy_dataset_document():
    """上一个契约版本的正式示例依旧经过原资源入口验证，列声明和行仍保留在同一层级以兼容已发布资产。"""
    sample = ROOT / "fixtures/sample-workspace/assets/dataset.json"
    check_document("DATASET", json.loads(sample.read_text(encoding="utf-8")))
