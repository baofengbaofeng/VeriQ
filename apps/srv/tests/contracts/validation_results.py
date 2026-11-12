import json
from pathlib import Path
from veriq_server.contracts import validate_schema

root = Path(__file__).resolve().parents[4]
fixtures = json.loads((root / "packages/contracts/fixtures/compatibility.json").read_text())
print(
    json.dumps(
        [
            {"name": row["name"], "valid": not validate_schema(row["schema"], row["value"])}
            for row in fixtures
        ]
    )
)
