#!/usr/bin/env python3
"""Check tracked files and Git metadata using externally stored regexes."""

import argparse
import os
from pathlib import Path
import re
import subprocess
import sys


def _git(repo: Path, *args: str) -> bytes:
    return subprocess.run(
        ["git", *args], cwd=repo, capture_output=True, check=True,
    ).stdout


def _scan_hits(repo: Path, patterns: list[re.Pattern]):
    for name in _git(repo, "ls-files", "-z").split(b"\0"):
        if not name:
            continue
        relative = os.fsdecode(name)
        path = repo / relative
        # Git tracks the link itself, not the content of its external target.
        data = os.fsencode(os.readlink(path)) if path.is_symlink() else path.read_bytes()
        if b"\0" in data[:8000]:
            continue
        for number, line in enumerate(data.decode("utf-8", errors="replace").splitlines(), 1):
            for pattern in patterns:
                if pattern.search(line):
                    yield f"{relative}:{number}", pattern.pattern

    fields = _git(repo, "log", "--all", "--format=%h%x00%B%x00").decode(
        "utf-8", errors="replace",
    ).split("\0")
    for index in range(0, len(fields) - 1, 2):
        sha, message = fields[index].strip(), fields[index + 1]
        for pattern in patterns:
            if pattern.search(message):
                yield f"commit {sha}", pattern.pattern

    branches = _git(repo, "for-each-ref", "--format=%(refname:short)",
                    "refs/heads", "refs/remotes").decode("utf-8", errors="replace")
    for branch in branches.splitlines():
        for pattern in patterns:
            if pattern.search(branch):
                yield f"branch {branch}", pattern.pattern


def scan(repo: Path, patterns: list[re.Pattern]) -> list[str]:
    """Return locations and matching regexes, without including matched content."""
    return [f"{location}: {pattern}" for location, pattern in _scan_hits(repo, patterns)]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--patterns", type=Path,
                        default=Path.home() / ".config" / "foxy" / "scan-patterns.txt")
    args = parser.parse_args()
    try:
        lines = args.patterns.read_text(encoding="utf-8").splitlines()
        patterns = [re.compile(line) for line in lines
                    if line.strip() and not line.lstrip().startswith("#")]
    except FileNotFoundError:
        print("Patterns file is missing; provide --patterns PATH.", file=sys.stderr)
        return 2
    except (OSError, UnicodeError, re.error):
        # Exception text can contain the private regex or filesystem content.
        print("Cannot read or compile patterns file.", file=sys.stderr)
        return 2

    try:
        hits = list(_scan_hits(Path.cwd(), patterns))
    except (OSError, subprocess.CalledProcessError):
        print("Cannot scan tracked files or Git metadata.", file=sys.stderr)
        return 2
    if hits:
        for location, _ in hits:
            print(f"{location}: [pattern redacted]")
        return 1
    print("clean")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
