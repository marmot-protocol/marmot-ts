---
schema_version: 1
open_count: 1
waived_count: 0
fixed_count: 0
total_count: 1
last_updated: 2026-09-02T14:52:14.235Z
---

# Broken Windows Ledger

> Cross-phase defect register. `/gsd-ship` blocks while `open_count > 0`.
> Waive with `gsd-tools windows waive <id> "<reason>"` (reason required).
> Mark fixed with `gsd-tools windows fixed <id>`.

| id | phase | kind | file | line | description | status | reason | recorded_at | resolved_at |
|----|-------|------|------|------|-------------|--------|--------|-------------|-------------|
| 1 | 03.1 | unrun-verify | src/__tests__/exports.test.ts |  | Full suite otherwise passed; pre-existing export snapshot drift remains assigned to plan 03.1-08 | open |  | 2026-09-02T14:52:14.235Z |  |

````json
[
  {
    "id": 1,
    "kind": "unrun-verify",
    "phase": "03.1",
    "file": "src/__tests__/exports.test.ts",
    "line": null,
    "description": "Full suite otherwise passed; pre-existing export snapshot drift remains assigned to plan 03.1-08",
    "status": "open",
    "reason": "",
    "recorded_at": "2026-09-02T14:52:14.235Z",
    "resolved_at": null
  }
]
````
