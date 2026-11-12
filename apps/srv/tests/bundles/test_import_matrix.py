"""Bounded matrix arithmetic; real signed composition lives in test_import_physical."""

import pytest
from veriq_server.contracts import canonical_bytes
from veriq_server.service import Problem
from veriq_server.services.import_result import expected_variants


def selected(rows):
    return {
        "snapshot": {
            "entryCaseVersionIds": ["case"],
            "assets": [
                {"versionId": "case", "kind": "CASE", "document": {"roleKey": "reader"}},
                {"versionId": "data", "kind": "DATASET", "document": {"rows": rows}},
                {
                    "versionId": "suite",
                    "kind": "SUITE",
                    "document": {
                        "cases": [
                            {
                                "versionId": "case",
                                "roleKeys": ["auditor"],
                                "datasetVersionId": "data",
                                "browsers": ["chromium", "webkit"],
                            }
                        ]
                    },
                },
            ],
        },
        "selection": {"suiteVersionId": "suite"},
        "files": {"provenance/suite/source.json": canonical_bytes({"sourceHash": "a" * 64})},
    }


def test_signed_browsers_and_dataset_rows_cannot_be_trimmed_by_fallback_choices():
    checked = selected([{"key": "one", "values": {}}, {"key": "two", "values": {}}])
    rows = list(
        expected_variants(checked, {"executionChoices": {"browsers": ["firefox"]}}).values()
    )
    assert len(rows) == 4
    assert {r["selection"]["browser"] for r in rows} == {"chromium", "webkit"}
    assert all(r["selection"]["roleKey"] == "auditor" for r in rows)
    assert all(r["outcome"] == "INCOMPLETE" and r["attempts"] == [] for r in rows)


def test_matrix_limit_counts_all_selected_browsers_and_rows_before_attempt_validation():
    checked = selected([{"key": str(i), "values": {}} for i in range(500)])
    assert len(expected_variants(checked, {})) == 1000
    checked["snapshot"]["assets"][1]["document"]["rows"].append({"key": "overflow", "values": {}})
    with pytest.raises(Problem) as rejected:
        expected_variants(checked, {})
    assert rejected.value.code == "MATRIX_LIMIT"


def test_direct_cases_preserve_selected_order_and_default_chromium():
    checked = selected([])
    checked["selection"] = {"caseVersionIds": ["second", "case"]}
    checked["snapshot"]["entryCaseVersionIds"] = ["case", "second"]
    checked["snapshot"]["assets"].append(
        {"versionId": "second", "kind": "CASE", "document": {"roleKey": "reader"}}
    )
    for case in ["case", "second"]:
        checked["files"][f"provenance/{case}/source.json"] = canonical_bytes({"sourceHash": case})
    rows = list(expected_variants(checked, {}).values())
    assert [(r["caseVersionId"], r["selection"]["suiteEntryIndex"]) for r in rows] == [
        ("second", 0),
        ("case", 1),
    ]
    assert all(r["selection"]["browser"] == "chromium" for r in rows)
