#!/usr/bin/env python3
"""Back up a Firefox profile's theme files and link it to this repository."""

import argparse
import configparser
import os
from datetime import datetime
from pathlib import Path


def find_profile(firefox_dir: Path) -> Path:
    """Prefer an installation default, then a profile marked Default=1."""
    firefox_dir = firefox_dir.expanduser().resolve()
    ini = firefox_dir / "profiles.ini"
    if not ini.is_file():
        raise SystemExit(f"Missing {ini}; choose a profile with --profile PATH.")

    profiles = configparser.ConfigParser(interpolation=None)
    profiles.read(ini, encoding="utf-8")
    for section in profiles.sections():
        if section.startswith("Install"):
            default = profiles.get(section, "Default", fallback="")
            if default:
                return firefox_dir / default

    for section in profiles.sections():
        if section.startswith("Profile") and profiles.get(section, "Default", fallback="0") == "1":
            path = profiles.get(section, "Path", fallback="")
            if path:
                if profiles.get(section, "IsRelative", fallback="1") == "0":
                    return Path(path)
                return firefox_dir / path

    raise SystemExit(f"No default profile in {ini}; choose one with --profile PATH.")


def install(repo: Path, profile: Path, now: datetime) -> list[str]:
    """Back up replaced entries without following links; return the actions."""
    repo = repo.expanduser().resolve()
    profile = profile.expanduser().resolve()
    if not profile.is_dir():
        raise SystemExit(f"Profile directory does not exist: {profile}")

    chrome = profile / "chrome"
    chrome.mkdir(exist_ok=True)
    links = [
        (chrome / "userChrome.css", repo / "theme" / "userChrome.css"),
        (chrome / "userContent.css", repo / "theme" / "userContent.css"),
        (chrome / "fonts", repo / "extension" / "fonts"),
        (profile / "user.js", repo / "theme" / "user.js"),
    ]
    lines = []
    backup = None
    for source, target in links:
        if source.is_symlink() and os.readlink(source) == str(target):
            continue
        if source.is_symlink() or source.exists():
            if backup is None:
                name = f"backup-{now:%Y%m%d-%H%M%S}"
                backup = chrome / name
                suffix = 0
                while True:
                    try:
                        backup.mkdir()
                        break
                    except FileExistsError:
                        suffix += 1
                        backup = chrome / f"{name}-{suffix}"
            saved = backup / source.name
            source.rename(saved)
            lines.append(f"Backed up {source} -> {saved}")
        source.symlink_to(target, target_is_directory=source.name == "fonts")
        lines.append(f"Linked {source} -> {target}")
    return lines


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--profile", type=Path, help="Firefox profile directory (overrides profiles.ini)")
    parser.add_argument(
        "--firefox-dir", type=Path,
        default=Path.home() / "Library" / "Application Support" / "Firefox",
        help="Firefox directory containing profiles.ini",
    )
    args = parser.parse_args()
    profile = args.profile if args.profile is not None else find_profile(args.firefox_dir)
    repo = Path(__file__).resolve().parent.parent
    for line in install(repo, profile, datetime.now()):
        print(line)
    print("Restart Firefox (quit with Cmd+Q and reopen) to load the theme.")


if __name__ == "__main__":
    main()
