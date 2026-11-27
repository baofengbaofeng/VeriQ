from datetime import datetime
import json
from pathlib import Path

import pytest

from veriq_server.log_format import render_log


CASES = json.loads(
    (Path(__file__).resolve().parents[4] / "packages/contracts/fixtures/log-format.json").read_text(
        encoding="utf-8"
    )
)


@pytest.mark.parametrize("case", CASES, ids=lambda case: case["name"])
def test_shared_formatter_cases(case):
    inputs = {**case["input"], "timestamp": datetime.fromisoformat(case["input"]["timestamp"])}
    assert render_log(**inputs) == case["expected"]


def test_formatter_caps_utf8_without_splitting_code_points_or_escape_sequences():
    result = render_log(
        "DEBUG",
        datetime.fromisoformat("2026-10-15T06:03:27.812Z"),
        "log.ts:42",
        fields={"event": "test", "details": "字🚀|" * 1000, "tail": "unused"},
    )

    assert 4088 < len(result.encode()) <= 4096
    assert result.endswith(("字🚀\\|…", "字…", "字🚀…"))
    assert "||tail=" not in result
