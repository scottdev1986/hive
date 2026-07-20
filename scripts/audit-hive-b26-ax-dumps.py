#!/usr/bin/env python3
"""Audit B2.6 ax-tree-*.txt dumps for shape + internal consistency.

Cross-checks flat props vs children so a torn dump (numberOfCharacters from
generation A, childCount/ranges from generation B) fails closed.

Positive control: fixtures/torn-ax-tree-alternate-screen-exit.txt must FAIL
the consistency checks (proves the audit is not vacuous).

Usage:
  audit-hive-b26-ax-dumps.py <evidence-dir>
  audit-hive-b26-ax-dumps.py --self-test <evidence-dir>
Exit 0 on PASS (and self-test RED on torn fixture), non-zero on FAIL.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path


def parse_fields(text: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    for line in text.splitlines():
        if "=" not in line or line.startswith("  "):
            continue
        key, _, value = line.partition("=")
        if key and key not in fields:
            fields[key] = value
    return fields


def parse_child_ranges(text: str) -> list[tuple[int, int]]:
    ranges: list[tuple[int, int]] = []
    for line in text.splitlines():
        if not line.strip().startswith("child["):
            continue
        m = re.search(r"range=\{(\d+),\s*(\d+)\}", line)
        if m:
            ranges.append((int(m.group(1)), int(m.group(2))))
    return ranges


def audit_dump(name: str, text: str) -> tuple[bool, dict]:
    fields = parse_fields(text)
    child_ranges = parse_child_ranges(text)
    checks: dict[str, bool] = {
        "has_role": "role" in fields,
        "has_lifecycle": "lifecycle" in fields,
        "has_numberOfCharacters": "numberOfCharacters" in fields,
        "has_childCount": "childCount" in fields,
    }
    try:
        noc = int(fields.get("numberOfCharacters", "-1"))
        child_count = int(fields.get("childCount", "-1"))
    except ValueError:
        noc, child_count = -1, -1
        checks["numeric_fields"] = False
    else:
        checks["numeric_fields"] = noc >= 0 and child_count >= 0

    checks["child_lines_match_count"] = len(child_ranges) == child_count

    is_teardown = name.endswith("teardown.txt") or name == "teardown"
    if is_teardown:
        checks["teardown_empty"] = child_count == 0 and noc == 0
        checks["teardown_lifecycle"] = "exited" in fields.get("lifecycle", "").lower() or "exited" in text
    else:
        geometry_rows = fields.get("geometryRows")
        if geometry_rows is not None:
            try:
                gr = int(geometry_rows)
                checks["childCount_eq_geometryRows"] = child_count == gr
            except ValueError:
                checks["childCount_eq_geometryRows"] = False
        else:
            # Older dumps without geometryRows: still require children present.
            checks["row_children_present"] = child_count > 0

        if child_ranges and noc >= 0:
            last_loc, last_len = child_ranges[-1]
            last_end = last_loc + last_len
            checks["last_range_within_text"] = last_end <= noc
            # Tear detector (historical: noc=45, last_end=29, childCount=16):
            # content ranges + at most one linebreak per child must cover the
            # reported text length. last_end + childCount == noc is still under-
            # cover when children are a prefix of a longer generation; require
            # last_end + childCount > noc OR exact end equality.
            checks["children_cover_text"] = (noc == 0) or (last_end == noc) or (
                last_end + child_count > noc
            )
            vis = fields.get("visibleRange", "")
            m = re.match(r"\{(\d+),\s*(\d+)\}", vis)
            if m:
                checks["visibleRange_len_eq_noc"] = int(m.group(2)) == noc
        elif not is_teardown:
            checks["has_child_ranges"] = False

    ok = all(checks.values())
    return ok, {
        "checks": checks,
        "numberOfCharacters": noc,
        "childCount": child_count,
        "child_lines": len(child_ranges),
        "geometryRows": fields.get("geometryRows"),
        "last_end": (child_ranges[-1][0] + child_ranges[-1][1]) if child_ranges else None,
    }


def run_audit(base: Path) -> tuple[int, list[str]]:
    required = [
        "ax-tree-input.txt",
        "ax-tree-alternate-screen.txt",
        "ax-tree-alternate-screen-exit.txt",
        "ax-tree-resize.txt",
        "ax-tree-replay.txt",
        "ax-tree-scroll.txt",
        "ax-tree-teardown.txt",
    ]
    lines: list[str] = [
        "inspector-audit-machine.txt",
        "STATUS=RECORDED",
        "method=parse ax-tree-*.txt + consistency cross-check (noc/visibleRange vs childCount/geometryRows/last-range)",
        "note=This is NOT a substitute for the human Accessibility Inspector audit slot.",
        "",
    ]
    failures = 0
    for name in required:
        path = base / name
        text = path.read_text() if path.exists() else ""
        ok, detail = audit_dump(name, text)
        if not path.exists():
            ok = False
            detail["checks"]["exists"] = False
        if not ok:
            failures += 1
        lines.append(
            f"file={name} ok={ok} numberOfCharacters={detail.get('numberOfCharacters')} "
            f"childCount={detail.get('childCount')} geometryRows={detail.get('geometryRows')} "
            f"last_end={detail.get('last_end')} checks={detail.get('checks')}"
        )
    lines.append("")
    lines.append(f"failures={failures}")
    lines.append("result=" + ("PASS" if failures == 0 else "FAIL"))
    return failures, lines


def run_self_test(base: Path) -> None:
    torn = base / "fixtures" / "torn-ax-tree-alternate-screen-exit.txt"
    if not torn.exists():
        raise SystemExit(f"missing torn fixture: {torn}")
    ok, detail = audit_dump("ax-tree-alternate-screen-exit.txt", torn.read_text())
    if ok:
        raise SystemExit(
            "POSITIVE CONTROL FAILED: torn fixture passed consistency audit "
            f"(checks={detail['checks']}). Audit is vacuous."
        )
    print(
        f"positive_control_torn_fixture=RED_as_expected "
        f"numberOfCharacters={detail.get('numberOfCharacters')} "
        f"childCount={detail.get('childCount')} last_end={detail.get('last_end')} "
        f"failed_checks={[k for k, v in detail['checks'].items() if not v]}"
    )


def main(argv: list[str]) -> int:
    self_test = False
    args = argv[1:]
    if args and args[0] == "--self-test":
        self_test = True
        args = args[1:]
    if len(args) != 1:
        print(__doc__, file=sys.stderr)
        return 2
    base = Path(args[0])
    if self_test:
        run_self_test(base)
    failures, lines = run_audit(base)
    out_path = base / "inspector-audit-machine.txt"
    out_path.write_text("\n".join(lines) + "\n")
    print("\n".join(lines))
    if self_test and failures == 0:
        print("self_test=PASS (torn fixture RED; live dumps GREEN)")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
