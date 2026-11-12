
import importlib.util
import importlib
import json
from base64 import b64encode
from urllib.parse import quote


def test_report_projection_masks_values_and_authentication_headers():
    assert importlib.util.find_spec("veriq_server.services.report") is not None, (
        "Missing scoped report service"
    )
    module = importlib.import_module("veriq_server.services.report")
    secret = "synthetic/private credential!"
    payload = {
        "expected": {"present": True, "value": "visible"},
        "actual": {"present": True, "value": secret},
        "headers": {"Authorization": "Bearer " + secret, "Cookie": "session=" + secret},
        "encoded": quote(secret, safe=""),
        "base64": b64encode(secret.encode()).decode(),
    }
    projected = module.redact(payload, {secret})
    assert projected["expected"] == payload["expected"]
    assert projected["actual"]["value"] == "[REDACTED]"
    assert projected["headers"] == {"Authorization": "[REDACTED]", "Cookie": "[REDACTED]"}
    assert secret not in json.dumps(projected)
    assert projected["encoded"] == projected["base64"] == "[REDACTED]"
