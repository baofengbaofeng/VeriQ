"""Operator-owned approved inventory. Uploads cannot establish their own trust."""

import json
from hashlib import sha256
from pathlib import Path
from typing import Any
from ..contracts import canonical_bytes, validate_schema
from ..service import Problem
from ..settings import Settings


class ApprovedEngines:
    def __init__(self, settings: Settings):
        self.path = settings.approved_engine_inventory_path

    def require(self, version: str) -> tuple[dict[str, Any], str]:
        try:
            if not self.path:
                raise ValueError("Absent inventory")
            raw = Path(self.path).read_bytes()
            if len(raw) > 2 * 1024 * 1024:
                raise ValueError("Oversize inventory")
            document = json.loads(raw)
            if validate_schema("ApprovedEngineInventoryV1", document):
                raise ValueError("Invalid inventory")
            matches = [e for e in document["engines"] if e["engineVersion"] == version]
            if len(matches) != 1:
                raise ValueError("Engine not approved")
            engine = matches[0]
            paths = [f["path"] for f in engine["files"]]
            if len(paths) != len(set(paths)) or not {
                "package.json",
                "package-lock.json",
                "dependencies.json",
                "engine/compiler.tgz",
            } <= set(paths):
                raise ValueError("Incomplete release inventory")
            if any(
                not (
                    p
                    in {
                        "package.json",
                        "package-lock.json",
                        "dependencies.json",
                        "engine/compiler.tgz",
                    }
                    or p.startswith("vendor/")
                )
                for p in paths
            ):
                raise ValueError("Generated source cannot be release-approved")
            return engine, sha256(canonical_bytes(engine)).hexdigest()
        except (OSError, ValueError, KeyError, TypeError):
            raise Problem(
                409, "ENGINE_NOT_APPROVED", "Operator-approved engine inventory is unavailable"
            ) from None
