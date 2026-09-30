#!/usr/bin/env python3
"""Headless screenshots of the new tab page with fake tabs (preview/fixtures.js).

Uses a throwaway Firefox profile in .spider/scratch/preview-profile/, never your own profile.
Writes dist/preview/<name>.png.

Usage: python3 scripts/preview.py [name ...]   (no names: all scenarios)
"""
import pathlib
import subprocess
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
FIREFOX = "/Applications/Firefox.app/Contents/MacOS/firefox"
PROFILE = ROOT / ".spider" / "scratch" / "preview-profile"
OUT = ROOT / "dist" / "preview"
PAGE = ROOT / "extension" / ".preview.html"
MAIN_SCRIPT = '<script type="module" src="src/main.js"></script>'
INJECT = (
    '<link rel="stylesheet" href="../preview/preview.css">\n'
    '<script type="module" src="../preview/fake-browser.js"></script>\n'
)

# name: (query string, window width, window height)
SCENARIOS = {
    "empty": ("scenario=empty", 1600, 1000),
    "one-window": ("scenario=one-window", 1600, 1000),
    "two-windows": ("scenario=two-windows", 1600, 1000),
    "many-groups": ("scenario=many-groups", 1600, 1000),
    "light": ("scenario=light&scheme=light", 1600, 1000),
    "narrow": ("scenario=one-window", 900, 900),
}


def build_page():
    """Copy newtab.html next to itself with the fake API loaded before main.js."""
    html = (ROOT / "extension" / "newtab.html").read_text()
    if MAIN_SCRIPT not in html:
        sys.exit("newtab.html no longer loads src/main.js as expected; update scripts/preview.py")
    PAGE.write_text(html.replace(MAIN_SCRIPT, INJECT + MAIN_SCRIPT))


def ensure_profile():
    PROFILE.mkdir(parents=True, exist_ok=True)
    (PROFILE / "user.js").write_text(
        # file:// pages may import sibling ES modules only with this off.
        'user_pref("security.fileuri.strict_origin_policy", false);\n'
        'user_pref("browser.shell.checkDefaultBrowser", false);\n'
        'user_pref("datareporting.policy.dataSubmissionEnabled", false);\n'
    )


def shoot(name, query, width, height):
    OUT.mkdir(parents=True, exist_ok=True)
    out = OUT / f"{name}.png"
    out.unlink(missing_ok=True)
    result = subprocess.run(
        [
            FIREFOX, "--headless", "--no-remote", "-profile", str(PROFILE),
            f"--window-size={width},{height}", "--screenshot", str(out),
            f"{PAGE.as_uri()}?{query}",
        ],
        capture_output=True, text=True, timeout=180,
    )
    if result.returncode != 0 or not out.exists():
        sys.exit(f"Screenshot failed for {name} (exit {result.returncode}):\n{result.stderr[-2000:]}")
    print(out)


def main(names):
    unknown = [n for n in names if n not in SCENARIOS]
    if unknown:
        sys.exit(f"Unknown scenario(s): {', '.join(unknown)}. Known: {', '.join(SCENARIOS)}")
    build_page()
    ensure_profile()
    for name in names or SCENARIOS:
        shoot(name, *SCENARIOS[name])


if __name__ == "__main__":
    main(sys.argv[1:])
