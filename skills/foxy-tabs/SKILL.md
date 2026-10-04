---
name: foxy-tabs
description: Use when an agent needs to list Firefox tab groups, inspect their URLs, or add review links and dev servers to Foxy groups.
---

# Foxy tabs

Foxy 3.2.0 or newer provides `agent/foxy` in this repository (called `foxy`
below). It talks to the running Firefox through the installed native host.
It lists open and saved closed groups, and adds URLs without changing the
active tab or focusing a window. Adding to a saved group leaves it closed.

## Commands

```sh
foxy groups --json
foxy tabs "To be reviewed" --json
foxy add "To be reviewed" https://example.com/review
foxy add "Dev server" http://localhost:3000
foxy new "Release notes" https://example.com/release --color blue
# Only if the user explicitly named the group to create:
foxy add "Research" https://example.com/article --create --color green
```

Every command accepts `--json`. Use the repository's `agent/foxy` path if
`foxy` is not on PATH. Names are trimmed and case-insensitive; ambiguous open
names prefer the last focused normal window, then the lowest window ID.
Duplicates ignore URL fragments. Requests allow 1 to 50 http/https URLs,
200-character group titles, and Firefox group colours: blue, purple, cyan,
orange, yellow, pink, green, grey, red. Omitting colour uses Firefox's default.

## Exit codes and safety

- **0:** done. Check `added` and `skipped` in JSON replies.
- **1:** refused, with a message. A missing group returns the available names.
  Ask before creating a group the user did not name; do not silently retry
  with `--create` or invent a group.
- **2:** Foxy is not reachable. Explain that Firefox must be running with
  Foxy 3.2.0 or newer and the native host installed. Do not attempt a restart.

Never edit `places.sqlite` or any other Firefox profile files. Never quit or
restart Firefox. The bridge only lists and adds; it does not remove tabs or
groups. Do not work around a refusal by modifying profile data.
