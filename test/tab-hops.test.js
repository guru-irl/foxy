import { test } from "node:test";
import assert from "node:assert/strict";

for (const url of [
  "https://login.example.com/", "https://logon.example.com/",
  "https://signin.example.com/", "https://sso.example.com/",
  "https://auth.example.com/", "https://accounts.example.com/",
  "https://safelinks.example.com/", "https://device.login.example.net/",
  "https://eu.safelinks.example.net/", "https://LOGIN.example.com/",
  "https://cdn.example.net/evergreen-assets/safelinks/2/atp-safelinks.html",
  "https://example.com/safelinks/", "https://example.net/SAFElinks/hop",
  "https://example.com/login", "https://example.com/logon/",
  "https://example.com/signin", "https://example.com/sign-in",
  "https://example.com/session?return_to=%2F", "https://example.com/sessions",
  "https://example.com/sessions/two-factor", "https://example.com/oauth",
  "https://example.com/oauth2/authorize", "https://example.com/saml",
  "https://example.com/saml2/authorize", "https://example.com/sso",
  "https://example.com/LoGiN/", "https://example.com/SeSsIoNs/two-factor",
]) {
  test(`hop URL: ${url}`, async () => {
    const { isHop } = await import("../extension/src/tabs/hops.js");
    assert.equal(isHop(url), true);
  });
}

for (const url of [
  "https://example.com/", "https://example.net/project",
  "https://notlogin.example.com/", "https://login-extra.example.net/",
  "https://notaccounts.example.com/", "https://notsafelinks.example.net/",
  "https://example.com/login-extra", "https://example.com/sessions-extra/x",
  "https://example.com/oauth20", "https://example.com/saml20",
  "https://example.com/project/login", "https://example.com/project/oauth2",
  "https://example.com/safelinks", "https://example.com/notsafelinks/hop",
  "https://example.com/?next=/safelinks/hop",
  "https://example.com/#/safelinks/hop", "https://example.com/?next=/login",
  "https://example.com/#/sessions", "about:blank", "not a URL", "", null, undefined,
]) {
  test(`not a hop URL: ${url}`, async () => {
    const { isHop } = await import("../extension/src/tabs/hops.js");
    assert.equal(isHop(url), false);
  });
}
