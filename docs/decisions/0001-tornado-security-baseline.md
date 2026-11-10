# ADR 0001: Tornado 6.6.1 baseline

- Status: accepted by the user on 2026-11-10.
- Decision: use exact Tornado6.6.1 with Python3.12; update lockfiles and all normative documentation.
- Context: prior6.4.2 is affected by published advisories, including CVE-2025-47287 fixed6.5 and GHSA-pcg2-g6cj-q92c fixed6.6. The user explicitly approved upgrading to6.6.1.
- Scope: no change to Python/SQLAlchemy/MySQL/React/Electron/Node24 architecture or full MVP scope. No repeated permission request for this decision.
- Evidence: https://pypi.org/pypi/tornado/6.4.2/json ; https://pypi.org/pypi/tornado/6.6.1/json ; https://github.com/tornadoweb/tornado/security/advisories/GHSA-7cx3-6m66-7c5m ; https://github.com/tornadoweb/tornado/security/advisories/GHSA-pcg2-g6cj-q92c .
- Consequences: redo dependency locking and relevant tests before T01 review. Future upgrades require normal compatibility/security assessment.
