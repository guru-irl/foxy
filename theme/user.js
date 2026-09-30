// Liquid Fox: let tab pages be transparent so the new tab page shows the
// window's glass. See chrome/userContent.css and section 5 of userChrome.css.
// To undo: delete this line (or this file) and set the pref back to false in
// about:config.
user_pref("browser.tabs.allow_transparent_browser", true);

// Liquid Fox: faster autohide sidebar slide (Firefox default 400ms).
// The fade in userChrome.css section 4 uses the same 150ms.
user_pref("sidebar.animation.expand-on-hover.duration-ms", 150);
