import json
import pathlib
import sys
import unittest
import zipfile

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import build  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "dist" / "test-build"


class BuildTest(unittest.TestCase):
    def test_package_has_only_addon_files(self):
        names = build.package_files()
        for required in [
            "manifest.json", "newtab.html", "newtab.css", "background.js",
            "src/forget.js", "src/main.js", "src/model.js", "src/actions.js", "src/render.js",
            "fonts/Danfo.ttf", "fonts/Danfo-OFL.txt",
            "fonts/BebasNeue-Regular.ttf", "fonts/BebasNeue-OFL.txt",
            "icons/globe.svg",
        ]:
            self.assertIn(required, names)
        for name in names:
            self.assertFalse(
                name.startswith(("test/", "preview/", "docs/", "scripts/", "dist/", ".")),
                name,
            )
            self.assertNotIn("/.", name)

    def test_zip_is_named_after_the_version_and_holds_the_package_files(self):
        out = build.build(out_dir=OUT_DIR)
        version = json.loads((ROOT / "manifest.json").read_text())["version"]
        self.assertEqual(out.name, f"liquidfox-newtab-{version}.zip")
        with zipfile.ZipFile(out) as zf:
            self.assertEqual(sorted(zf.namelist()), build.package_files())
            self.assertEqual(zf.read("manifest.json"), (ROOT / "manifest.json").read_bytes())

    def test_zip_is_reproducible(self):
        first = build.build(out_dir=OUT_DIR).read_bytes()
        second = build.build(out_dir=OUT_DIR).read_bytes()
        self.assertEqual(first, second)


if __name__ == "__main__":
    unittest.main()
