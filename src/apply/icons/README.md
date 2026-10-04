# Site icons

Put the generated icon set here (for example from realfavicongenerator.net or favicon.io), with these exact names:

- `favicon.ico`
- `favicon-16x16.png`
- `favicon-32x32.png`
- `apple-touch-icon.png`
- `android-chrome-192x192.png`
- `android-chrome-512x512.png`
- `site.webmanifest`

They are served at the site root (`/favicon.ico`, `/apple-touch-icon.png`, ...) and linked from the applicant pages, the
legal pages, the operations page, the debug page and the sign-in page. Nothing else in this folder is served. In
`site.webmanifest`, set `name` and `short_name` to the company name; the icon paths it contains (`/android-chrome-192x192.png`
and `/android-chrome-512x512.png`) already match.
