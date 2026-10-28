# Contributing to PIDM

Thank you for helping improve PIDM. Small fixes, clear bug reports and focused pull requests are welcome.

## Development setup

Use Windows x64 and Node.js 24.x. From the project root:

```powershell
npm ci
npm run setup:media
npm run setup:ffmpeg
npm start
```

See the [README](README.md#run-from-source) for details and packaging commands.

## Reporting a bug

Include:

- PIDM version, Windows version, and browser/extension version if relevant.
- Whether the app was installed from an EXE or run from source.
- Steps to reproduce, expected behavior and the exact error text.
- Whether the same URL works when pasted directly into the desktop app.
- A public reproduction URL if it is safe to share, or a local fixture.

Remove credentials, private or signed URLs, internal connection tokens and personal download history from screenshots and logs. For a video problem, report whether it is a watch page, embedded player or preview. A source site's 403/429 response can have a different cause from an application bug.

## Making a change

1. Keep the change focused and explain the observed problem.
2. Add a regression test when changing download integrity, resume behavior, media parsing or browser source selection.
3. Run checks relevant to the change:

```powershell
npm test
```

For UI changes, also run `npm run test:ui`. For real local video integration, enable `TEST_REAL_MEDIA` as described in the README. For packaging changes, build and exercise the packaged app after closing other PIDM instances.

`web/style.css`, `web/theme.js` and `web/icons.svg` own the shared visual assets. Run `npm run assets` to regenerate extension copies and the PNG/ICO icons from `assets/pidm.svg`.

Do not commit downloaded tools, installers, `node_modules/`, caches, private tokens, personal history or test-run output. Keep the lockfile with dependency changes.

## Pull requests

Describe the trigger, resulting behavior, tests actually run and any verification limits. Distinguish local fixture results from real website checks. Use a descriptive title such as `fix: use the current YouTube video URL after navigation`.

Contributions to PIDM's own code are made under the project's [MIT License](LICENSE). Retain third-party notices when including external material. Changes to bundled binaries must also update their pinned checksums, notices and distribution documentation.
