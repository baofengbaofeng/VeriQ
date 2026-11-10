# ADR 0004: React Router 7.18.5

- Status: accepted by the user on 2026-11-10.
- Decision: use exact react-router/react-router-dom7.18.5, keep React18/Vite6 and CSR Declarative Mode.
- Context: latest6.x6.30.6 is still in the maintainer affected range for navigation mixed-slash handling; patched range starts7.18.0. SSR advisory does not apply to the planned Declarative CSR design.
- Evidence: https://github.com/advisories/GHSA-wrjc-x8rr-h8h6 and upstream release/backport analysis retained in dependency audit evidence.
- Consequences: upgrade deps/locks/generated documentation, rerun routing compatibility and relevant tests. This approval is not permission to change unrelated product scope or accept all audit findings indiscriminately.
