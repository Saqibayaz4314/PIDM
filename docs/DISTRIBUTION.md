# Publishing source and Windows releases

## Source repository

PIDM's own source is MIT-licensed. Publish the source tree, lockfile, logo, documentation and [LICENSE](../LICENSE). The `private` field in `package.json` prevents accidental npm publication; it does not prevent a public GitHub repository.

Keep these local-only directories out of Git: `node_modules/`, `bin/`, `release/`, `.cache/`, `.backups/` and `ui-preview/`. Curated sample screenshots live in `docs/images/` and can be committed. Never include a personal `.api-token`, download history, cookies or private source URLs.

If starting a new GitHub repository, create an empty repository, initialize/push this project using GitHub's instructions, and check the staged file list before pushing:

```powershell
git status --short
git diff --cached --stat
```

Use GitHub Releases for installer assets instead of committing generated EXEs into the source tree.

## Third-party components

| Component | Current pinned version | Licensing information |
| --- | --- | --- |
| Electron | 45.0.0 | Electron's MIT license plus Chromium and other component notices shipped with its runtime |
| yt-dlp Windows executable | 2026.10.21 | The project's source is Unlicense; its PyInstaller release executable contains GPLv3+ code and has separate redistribution requirements |
| FFmpeg / FFprobe, Gyan essentials build | 9.0.2 | The selected build identifies itself as GPLv3; its source revision is `946fcce07b` |

The installers are configured to retain Electron's runtime notices and the Gyan build's `LICENSE` and `README.txt`. [THIRD-PARTY-NOTICES.txt](../distribution/THIRD-PARTY-NOTICES.txt) records component links. `prepare-release.cjs` copies PIDM's MIT license into the installer distribution resources for new builds.

PIDM's MIT license applies to its own code. It does not replace licenses of executables, dependencies, fonts or codecs included with a release.

## Before publishing a bundled installer

1. Build from the intended source revision with `npm ci`, the pinned tool setup scripts, `npm run assets` and `npm run dist`.
2. Run the appropriate source, UI, real local media and packaged checks. Record what actually ran and which Windows/browser versions were checked.
3. Preserve the applicable license texts, copyright notices and dependency notices for the exact binaries. The yt-dlp release's third-party notice file must be considered alongside its own source license.
4. Prepare a corresponding third-party source distribution for the GPL-covered binaries, including the sources, modifications and scripts/build information required by the licenses for the exact shipped artifacts. This includes applicable bundled libraries, not just the PIDM wrapper or FFmpeg's top-level source checkout.
5. Provide that source with the public binary release using a distribution method permitted by the applicable license. For a GitHub download release, publishing equivalent source access alongside the binary is the intended approach. An upstream homepage or a source revision link alone is not a prepared corresponding-source bundle.
6. Publish the installer, `START-HERE.txt`, the current component notices, PIDM's MIT license and `SHA256SUMS.txt`. Link the source materials and state that the current installer is unsigned and requires manual extension loading once per browser profile.

**Current repository scope:** the source license and component references are documented; an audited corresponding-source bundle for the current third-party binary combination has not been assembled here. Do not describe a public bundled-binary release as licensing-complete on the strength of the README or notices alone. Publishing PIDM's source and publishing an installer that aggregates third-party binaries are separate steps.

If a selected binary's corresponding source/build materials cannot be obtained and provided as required, resolve that component's distribution before publishing an installer that includes it.

## Checksums

After a successful build, from the project root:

```powershell
$setup = Get-Item .\release\PIDM-Setup-0.3.0-x64.exe
$hash = (Get-FileHash -LiteralPath $setup.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
"$hash  $($setup.Name)" | Set-Content .\release\SHA256SUMS.txt -Encoding utf8
```

Use the filename matching the version you built. Do not reuse the checksum of an older build, including when rebuilding the same version.

## License references

- [MIT license](https://opensource.org/license/mit).
- [yt-dlp release-file licensing](https://github.com/yt-dlp/yt-dlp#licensing) and [third-party notices](https://github.com/yt-dlp/yt-dlp/blob/master/THIRD_PARTY_LICENSES.txt).
- [FFmpeg license and legal information](https://ffmpeg.org/legal.html).
- [GNU GPLv3, including corresponding-source and object-code distribution terms](https://www.gnu.org/licenses/gpl-3.0.html).
- [Gyan's FFmpeg builds](https://www.gyan.dev/ffmpeg/builds/).
