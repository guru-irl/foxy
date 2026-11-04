---
name: foxy-tabs
description: Use when an agent needs to list Firefox tab groups, inspect their URLs, add or remove tabs, or create or delete groups.
---

# Foxy tabs

The CLI `/Users/guru/src/foxy/agent/foxy` talks to running Firefox with Foxy
3.2.0 or newer through the installed native host. It lists open and saved
closed groups and adds URLs without changing the active tab or focusing a
window. Adding to a saved group writes bookmarks and leaves it closed. Remove
and delete require Foxy 3.4.0 or newer.

## Commands

```sh
/Users/guru/src/foxy/agent/foxy groups --json
/Users/guru/src/foxy/agent/foxy tabs "To be reviewed" --json
/Users/guru/src/foxy/agent/foxy add "To be reviewed" https://example.com/review
/Users/guru/src/foxy/agent/foxy add "Dev server" http://localhost:3000
# Both creation forms below require a group name explicitly given by the user:
/Users/guru/src/foxy/agent/foxy new "Release notes" https://example.com/release --color blue
/Users/guru/src/foxy/agent/foxy add "Research" https://example.com/article --create --color green
/Users/guru/src/foxy/agent/foxy remove "To be reviewed" https://example.com/review --json
/Users/guru/src/foxy/agent/foxy remove "To be reviewed" https://example.com/review --close --json
/Users/guru/src/foxy/agent/foxy delete "Old work" --close-tabs --json
```

Every command accepts `--json` and `--help`. Names are trimmed and
case-insensitive; ambiguous open names prefer the last focused normal window,
then the lowest window ID. Use `add` for existing groups; `new` refuses a name
that matches an open group. Duplicates ignore URL fragments. Requests allow
1 to 50 http/https URLs, 200-character group titles, and Firefox group colours:
blue, purple, cyan, orange, yellow, pink, green, grey, red. Omitting colour uses
Firefox's default. `remove` ungroups matching tabs by default; `--close` closes
inactive matches. Removing the last tab is refused. `delete` removes a saved
folder everywhere; for an open group, `--close-tabs` closes its inactive tabs
first. Both refuse to close an active tab. Firefox may move an ungrouped tab
to the edge of its group to keep the remaining group contiguous. A group open
on another synced device may reappear there.

## Exit codes and safety

- **0:** done. Check `added` and `skipped` in JSON replies. `closed: true`
  means bookmarks were added to a saved group, not tabs opened.
- **1:** refused, with a message. A missing group returns the available names.
  For both `new` and `add --create`, only create groups the user explicitly
  named. Ask before creating an unnamed group; do not silently retry with
  `--create` or invent a group.
- **2:** Foxy is not reachable. Explain that Firefox must be running with
  Foxy 3.2.0 or newer and the native host installed. Do not attempt a restart.

Remove or delete only when the user asked for that group or those URLs. Never
tidy up on your own. Prefer remove (ungroup) over --close. Report deleted URLs
back to the user.

Never edit `places.sqlite` or any other Firefox profile files. Never quit or
restart Firefox. Do not work around a refusal by modifying profile data.
