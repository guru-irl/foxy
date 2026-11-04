# Release Foxy

The `release` environment and AMO secrets are already set up for `guru-irl/foxy`.
For a fork, create a GitHub Actions environment named `release` in repository settings.
Create an [AMO API key](https://addons.mozilla.org/developers/addon/api/key/) and add `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` as environment secrets.

1. Fetch the latest `main` and tags: `git checkout main && git pull --ff-only && git fetch --tags origin`.
2. Run `python3 scripts/release.py X.Y.Z` with a version higher than the manifest and all local release tags.
3. Push the commit and tag: `git push origin main && git push origin vX.Y.Z`.
4. Check the Release workflow and the published XPI and `updates.json` in GitHub Releases.

For local signing, export `AMO_JWT_ISSUER` and `AMO_JWT_SECRET` before running the build and sign scripts.
`release.py` runs `npm test`, commits the version changes, and creates an annotated tag. It never pushes.
If tests fail, inspect and undo or fix the uncommitted changes before retrying.
Install the first pipeline release, 4.1.0, by hand. Later releases update automatically.
