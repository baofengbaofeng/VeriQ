# Reuse the guarded real-MySQL/HTTP fixture; no second test database harness.
import sys
import shutil
import pytest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parents[1] / "auth"))
import runpy

site = runpy.run_path(str(Path(__file__).parents[1] / "auth" / "conftest.py"))["site"]
sys.path.insert(0, str(Path(__file__).parents[1] / "resources"))


@pytest.fixture(autouse=True)
def clean_task_archives(tmp_path):
    """Real engine archives are transient test data, not retained build evidence."""
    yield
    shutil.rmtree(tmp_path)
