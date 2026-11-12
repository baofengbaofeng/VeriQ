
import sys
import runpy
from pathlib import Path

root = Path(__file__).parents[1]
for directory in ["auth", "resources", "execution"]:
    sys.path.insert(0, str(root / directory))
site = runpy.run_path(str(root / "auth" / "conftest.py"))["site"]
