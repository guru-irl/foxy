const HOST_LABELS = new Set(["login", "logon", "signin", "sso", "auth", "accounts", "safelinks"]);
const PATH_SEGMENTS = new Set([
  "login", "logon", "signin", "sign-in", "session", "sessions",
  "oauth", "oauth2", "saml", "saml2", "sso",
]);

/** Redirect and sign-in pages are watched, but never duplicate matches. */
export function isHop(url) {
  try {
    const { hostname, pathname } = new URL(url);
    const path = pathname.toLowerCase();
    return hostname.toLowerCase().split(".").some(label => HOST_LABELS.has(label))
      || path.includes("/safelinks/") || PATH_SEGMENTS.has(path.split("/")[1]);
  } catch { return false; }
}
