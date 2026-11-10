# Build Foxy

Use Ubuntu 24.04 or macOS, Node 22.12 or newer with npm, and Python 3.10 or newer.

From the unpacked source archive, run:

```sh
npm ci
python3 scripts/build.py
```

The build uses Vite 8, Rolldown, Oxc, and Lightning CSS.
It writes `dist/foxy-<version>.zip`, byte-identical to the submitted file.
The unpacked zip matches `build/extension/`. Readable source is in `extension/`.
The repository is https://github.com/guru-irl/foxy.
