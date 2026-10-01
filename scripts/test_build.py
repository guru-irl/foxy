import json
import pathlib
import sys
import tempfile
import unittest
import zipfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import build  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
SCRATCH = ROOT / ".spider" / "scratch" / "tests"
OUT_DIR = SCRATCH / "test-build"


class BuildTest(unittest.TestCase):
    def test_package_has_only_addon_files(self):
        names = build.package_files()
        for required in [
            "manifest.json", "newtab.html", "newtab.css", "background.js",
            "src/close.js", "src/main.js", "src/model.js", "src/actions.js",
            "src/board/model.js", "src/board/targets.js", "src/board/moves.js", "src/board/render.js",
            "fonts/GoogleSansFlex.ttf", "fonts/GoogleSansFlex-OFL.txt",
            "fonts/GoogleSansFlex-TRADEMARKS.md",
            "fonts/CascadiaMono.ttf", "fonts/CascadiaMono-OFL.txt",
            "fonts/EBGaramond.ttf", "fonts/EBGaramond-OFL.txt",
            "icons/globe.svg",
        ]:
            self.assertIn(required, names)
        self.assertEqual(
            sorted(name for name in names if name.startswith("fonts/")),
            ["fonts/CascadiaMono-OFL.txt", "fonts/CascadiaMono.ttf",
             "fonts/EBGaramond-OFL.txt", "fonts/EBGaramond.ttf",
             "fonts/GoogleSansFlex-OFL.txt", "fonts/GoogleSansFlex-TRADEMARKS.md",
             "fonts/GoogleSansFlex.ttf"],
        )
        for name in names:
            self.assertFalse(
                name.startswith(("extension/", "theme/", "test/", "preview/", "docs/", "scripts/", "dist/", ".")),
                name,
            )
            self.assertNotIn("/.", name)

    def test_zip_is_named_after_the_version_and_holds_the_package_files(self):
        out = build.build(out_dir=OUT_DIR)
        version = json.loads((ROOT / "extension" / "manifest.json").read_text())["version"]
        self.assertEqual(out.name, f"foxy-{version}.zip")
        with zipfile.ZipFile(out) as zf:
            self.assertEqual(sorted(zf.namelist()), build.package_files())
            self.assertIn("manifest.json", zf.namelist())
            self.assertFalse(any(name.startswith("extension/") for name in zf.namelist()))
            self.assertEqual(zf.read("manifest.json"), (ROOT / "extension" / "manifest.json").read_bytes())

    def test_build_uses_extension_under_the_supplied_repository_root(self):
        SCRATCH.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=SCRATCH) as directory:
            root = pathlib.Path(directory)
            extension = root / "extension"
            (extension / "src" / "board").mkdir(parents=True)
            (extension / "manifest.json").write_text('{"version": "2.3.4"}')
            (extension / "src" / "main.js").write_text('// page module\n')
            (extension / "src" / "board" / "render.js").write_text('// board module\n')
            (extension / ".preview.html").write_text('preview only')
            (root / "manifest.json").write_text('{"version": "0.0.0"}')
            (root / "theme").mkdir()
            (root / "theme" / "userChrome.css").write_text('theme only')
            self.assertEqual(build.package_files(root), ["manifest.json", "src/board/render.js", "src/main.js"])
            out = build.build(root)
            self.assertEqual(out, root / "dist" / "foxy-2.3.4.zip")
            with zipfile.ZipFile(out) as zf:
                self.assertEqual(zf.namelist(), ["manifest.json", "src/board/render.js", "src/main.js"])
                self.assertEqual(zf.read("manifest.json"), b'{"version": "2.3.4"}')
                self.assertEqual(zf.read("src/main.js"), b'// page module\n')
                self.assertEqual(zf.read("src/board/render.js"), b'// board module\n')

    def test_zip_is_reproducible(self):
        first = build.build(out_dir=OUT_DIR).read_bytes()
        second = build.build(out_dir=OUT_DIR).read_bytes()
        self.assertEqual(first, second)


if __name__ == "__main__":
    unittest.main()
