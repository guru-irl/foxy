# Release Foxy

The `release` GitHub Actions environment stores `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` from an [AMO API key](https://addons.mozilla.org/developers/addon/api/key/).
Before the first listed release, complete [the Developer Hub checks](amo/MANUAL.md).

1. Fetch `main` and tags: `git checkout main && git pull --ff-only && git fetch --tags origin`.
2. Run `python3 scripts/release.py X.Y.Z` with a version higher than the manifest and existing tags.
3. Run `python3 scripts/check_private.py` and confirm `clean`.
4. Push the commit and tag: `git push origin main && git push origin vX.Y.Z`.
5. Check the Release workflow. It runs `npm ci`, tests, builds with Vite, archives the tagged source, and verifies a byte-identical rebuild.
6. If AMO approves within 15 minutes, the workflow publishes the signed XPI, source zip, and `updates.json` pointing to AMO.
7. If review is pending, the workflow succeeds with a source-only draft and **Waiting for AMO review**. Do not resubmit it.
8. After approval, run **Publish approved AMO releases** with the tag, or wait for its daily check. It fetches the existing AMO version and publishes the release.

`release.py` bumps versions, tests, commits, and creates an annotated tag. It never pushes.
GitHub-installed 4.1.0 updates automatically through `updates.json` to the AMO version. Older GitHub installs need one manual install from AMO. After that, AMO handles updates.
For rejected versions or upload errors, inspect Developer Hub before retrying. An accepted version number cannot be submitted again. Use the publish workflow to recover it, or release a new version after a correction.
