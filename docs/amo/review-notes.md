# Test Foxy Board

1. Install the add-on in desktop Firefox 140 or newer. No account is needed.
2. Open a new tab and accept the new tab change. The board works without the theme or native helper.
3. Create a tab group, drag a tab into it, and close the group. Reopen it from SAVED. Its bookmarks are in Other Bookmarks/Foxy.
4. Open settings with the gear. Show weather, select **Allow weather**, and search for a city. You do not need to grant geolocation permission.
5. Open a foreground link to a page that is already open. Foxy can switch to the existing tab. This is optional in settings.

The nativeMessaging permission is for the optional [open-source local helper](https://github.com/guru-irl/foxy#agents). It powers the agent CLI and MEMORY widget. Without it, those are unavailable. Do not install the helper to test the rest of the add-on.

The submitted build is minified with Vite. The attached source archive includes docs/amo/BUILD.md with rebuild steps.
