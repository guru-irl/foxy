"""Theme typography contracts; pixel centring is verified by the headless replica."""

import pathlib
import re
import unittest

ROOT = pathlib.Path(__file__).resolve().parent.parent
THEME_FILES = (ROOT / "theme" / "userChrome.css", ROOT / "theme" / "userContent.css")
BROWSER_DOCUMENT = '@-moz-document url("chrome://browser/content/browser.xhtml")'
SANS = '"Foxy Sans", system-ui, sans-serif'
MONO = '"Foxy Mono", "Cascadia Mono", ui-monospace, monospace'
GROUP = ':root:not(#lf) #tabbrowser-tabs .tab-group-label'
PINNED = ':root:not(#lf) #pinned-tabs-container[orient="vertical"] .tabbrowser-tab .tab-label'
SEARCH = '#urlbar .urlbar-input-box:has(> .urlbar-input:placeholder-shown)::after'


def strip_comments(css):
    stripped = re.sub(r"/\*.*?\*/", "", css, flags=re.S)
    if "/*" in stripped or "*/" in stripped:
        raise AssertionError("Stray CSS comment delimiter")
    return stripped


def check_balance(css):
    css = strip_comments(css)
    for opening, closing in (("{", "}"), ("(", ")")):
        depth = 0
        for char in css:
            if char == opening:
                depth += 1
            elif char == closing:
                depth -= 1
            if depth < 0:
                raise AssertionError(f"Unmatched {closing}")
        if depth:
            raise AssertionError(f"Unbalanced {opening}{closing}: {depth}")
    if css.count('"') % 2:
        raise AssertionError("Odd double quote count")


def blocks(css):
    """Yield (header, body) for each balanced block, including nested rules."""
    css = strip_comments(css)
    start = 0
    while start < len(css):
        opening = css.find("{", start)
        if opening < 0:
            return
        depth = 1
        end = opening + 1
        while depth and end < len(css):
            depth += (css[end] == "{") - (css[end] == "}")
            end += 1
        if depth:
            raise AssertionError("Unclosed CSS block")
        header = css[start:opening].rsplit(";", 1)[-1].strip()
        body = css[opening + 1:end - 1]
        yield header, body
        yield from blocks(body)
        start = end


def declarations(body):
    """Only declarations of this rule, not those of nested child rules."""
    own = body.split("{", 1)[0]
    return dict(re.findall(r'([\w-]+)\s*:\s*([^;{}]+);', own))


def matching_rule(css, selector):
    found = [declarations(body) for header, body in blocks(css)
             if header == selector or selector in [part.strip() for part in header.split(",")]]
    if not found:
        raise AssertionError(f"Missing selector: {selector}")
    result = {}
    for rule in found:
        result.update({key: value.strip() for key, value in rule.items()})
    return result


class ThemeTypographyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.chrome, cls.content = (p.read_text() for p in THEME_FILES)

    def test_no_legacy_font_references(self):
        for path, css in zip(THEME_FILES, (self.chrome, self.content)):
            with self.subTest(path=path.name):
                self.assertNotRegex(css.lower(), "bebas")

    def test_both_stylesheets_load_bundled_variable_fonts(self):
        for path, css in zip(THEME_FILES, (self.chrome, self.content)):
            with self.subTest(path=path.name):
                faces = [declarations(body) for header, body in blocks(css)
                         if header == "@font-face"]
                families = {face.get("font-family", "").strip(): face for face in faces}
                self.assertEqual(set(families), {'"Foxy Sans"', '"Foxy Mono"'})
                sans = {key: value.strip() for key, value in families['"Foxy Sans"'].items()}
                mono = {key: value.strip() for key, value in families['"Foxy Mono"'].items()}
                self.assertEqual(sans["src"], 'url("fonts/GoogleSansFlex.ttf") format("truetype")')
                self.assertEqual(sans["font-weight"], "1 1000")
                self.assertEqual(sans["font-stretch"], "25% 151%")
                self.assertEqual(sans["font-style"], "oblique 0deg 10deg")
                self.assertEqual(mono["src"], 'url("fonts/CascadiaMono.ttf") format("truetype")')
                self.assertEqual(mono["font-weight"], "200 700")

    def test_stylesheets_balance(self):
        for path, css in zip(THEME_FILES, (self.chrome, self.content)):
            with self.subTest(path=path.name):
                check_balance(css)

    def test_zero_specificity_default_is_only_in_browser_document(self):
        documents = [body for header, body in blocks(self.chrome)
                     if header == BROWSER_DOCUMENT]
        self.assertEqual(len(documents), 1)
        default = matching_rule(documents[0], ":where(*)")
        self.assertEqual(default["font-family"], SANS + " !important")
        self.assertEqual(default["font-variation-settings"], '"ROND" 0 !important')
        # A second global default would leak into DevTools or about: documents.
        all_defaults = [header for header, _ in blocks(self.chrome) if header == ":where(*)"]
        self.assertEqual(len(all_defaults), 1)
        self.assertNotIn(":where(*)", strip_comments(self.content))

    def test_monospace_urls_and_status_keep_ligatures_off(self):
        selectors = [
            '#urlbar[pageproxystate="valid"]:not([usertyping]) .urlbar-input:not(:placeholder-shown)',
            ".urlbarView-url", ".urlbarView-title[is-url]", "#statuspanel-label",
        ]
        for selector in selectors:
            with self.subTest(selector=selector):
                rule = matching_rule(self.chrome, selector)
                self.assertEqual(rule["font-family"], MONO + " !important")
                self.assertEqual(rule["font-variant-ligatures"], "none !important")
                self.assertEqual(rule["font-feature-settings"], '"calt" 0, "liga" 0 !important')

    def test_highlighted_url_descendants_override_default_sans(self):
        # Firefox wraps typed-match segments in strong elements. The global
        # :where(*) rule styles those directly, so inheriting mono is not enough.
        for selector in (".urlbarView-url *", ".urlbarView-title[is-url] *"):
            with self.subTest(selector=selector):
                rule = matching_rule(self.chrome, selector)
                self.assertEqual(rule["font-family"], MONO + " !important")
                self.assertEqual(rule["font-variant-ligatures"], "none !important")
                self.assertEqual(rule["font-feature-settings"], '"calt" 0, "liga" 0 !important')

    def assert_condensed_role(self, rule, style):
        for key, value in {
            "font-family": SANS, "font-weight": "700", "font-stretch": "50%",
            "font-style": style, "letter-spacing": "0", 'font-variation-settings': '"ROND" 0',
        }.items():
            self.assertEqual(rule.get(key), value + " !important", key)

    def test_group_titles_are_condensed_heavy_and_slanted(self):
        self.assert_condensed_role(matching_rule(self.chrome, GROUP), "oblique 10deg")

    def test_pinned_names_are_condensed_heavy_and_upright(self):
        rule = matching_rule(self.chrome, PINNED)
        self.assert_condensed_role(rule, "normal")
        self.assertNotIn("oblique", " ".join(rule.values()))
        # The named-site labels inherit font axes but need a nonzero important size.
        named = ':root:not(#lf) #pinned-tabs-container[orient="vertical"] .tabbrowser-tab:is([label$="YouTube"], [label$="Gmail"]) .tab-label'
        bodies = [body for header, body in blocks(self.chrome) if header == named]
        self.assertEqual(len(bodies), 1)
        before = matching_rule(bodies[0], "&::before")
        self.assertEqual(before["font-size"], "var(--lf-label-size) !important")

    def test_pinned_label_container_does_not_dim_the_name_again(self):
        # Firefox browser.css dims this parent to 0.7 for unselected tabs.
        # Changing the label colour alone cannot undo ancestor compositing.
        selector = ':root:not(#lf) #pinned-tabs-container[orient="vertical"] .tab-label-container'
        rule = matching_rule(self.chrome, selector)
        self.assertEqual(rule.get("opacity"), "1 !important")
        self.assertEqual(matching_rule(self.chrome, PINNED)["color"],
                         matching_rule(self.chrome, GROUP)["color"])

    def test_vertical_scroll_fades_follow_each_scrollbox_edge_state(self):
        # Removing the overflow guard or reversing either edge condition would
        # fade an edge with no offscreen tabs. Both independent viewports need it.
        for host in ("#tabbrowser-arrowscrollbox", "#pinned-tabs-container"):
            with self.subTest(host=host):
                selector = host + '[orient="vertical"]'
                base = matching_rule(self.chrome, selector)
                self.assertEqual(base.get("--lf-scroll-fade-start"), "0px !important")
                self.assertEqual(base.get("--lf-scroll-fade-end"), "0px !important")
                self.assertEqual(base.get("mask-image"), "none !important")
                overflow = matching_rule(self.chrome, selector + '[overflowing]')
                mask = re.sub(r"\s+", " ", overflow.get("mask-image", ""))
                self.assertEqual(mask, "linear-gradient(to bottom, transparent, "
                                 "black var(--lf-scroll-fade-start), "
                                 "black calc(100% - var(--lf-scroll-fade-end)), "
                                 "transparent) !important")
                start = matching_rule(self.chrome, selector + '[overflowing]:not([scrolledtostart])')
                end = matching_rule(self.chrome, selector + '[overflowing]:not([scrolledtoend])')
                self.assertEqual(start.get("--lf-scroll-fade-start"), "20px !important")
                self.assertEqual(end.get("--lf-scroll-fade-end"), "20px !important")
                for rule in (base, overflow, start, end):
                    self.assertFalse(set(rule) & {"box-shadow", "background-image", "content"})
        for part in ("overflow-start-indicator", "overflow-end-indicator"):
            self.assertEqual(matching_rule(self.chrome, f'spacer[part~="{part}"]')["display"],
                             "none !important")

    def test_search_placeholders_are_condensed_heavy_and_upright(self):
        for css, selector in [(self.chrome, SEARCH), (self.content, ".search-handoff-button::after")]:
            with self.subTest(selector=selector):
                self.assert_condensed_role(matching_rule(css, selector), "normal")

    def test_group_and_pinned_names_keep_capitals_for_mixed_case_titles(self):
        for selector in (GROUP, PINNED):
            with self.subTest(selector=selector):
                self.assertEqual(matching_rule(self.chrome, selector).get("text-transform"),
                                 "uppercase !important")

    def test_font_roundness_never_positive(self):
        for path, css in zip(THEME_FILES, (self.chrome, self.content)):
            for header, body in blocks(css):
                axes = declarations(body).get("font-variation-settings", "")
                for value in re.findall(r'["\']ROND["\']\s+([^,;!]+)', axes, flags=re.I):
                    with self.subTest(path=path.name, selector=header):
                        self.assertEqual(float(value.strip()), 0)


class BalanceCheckerTest(unittest.TestCase):
    def test_rejects_unbalanced_syntax(self):
        for css in ["}{", "a {", "a { x: )(; }", "a { x: (; }", 'a { x: "odd; }', "/* stray", "*/"]:
            with self.subTest(css=css), self.assertRaises(AssertionError):
                check_balance(css)

    def test_ignores_comments(self):
        check_balance('/* }(\" */ a { x: "even"; y: calc(1 + 2); }')


if __name__ == "__main__":
    unittest.main()
