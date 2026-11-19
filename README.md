# XeroLag

<img src="assets/branding/HeaderLOGO.png" alt="XeroLag" width="280">

[Download for Windows](https://github.com/brunothefox/XeroLag/releases/latest) · [Installation page](https://brunothefox.github.io/XeroLag/) · [Release notes](docs/RELEASE_NOTES.md)


Windows 10/11 x64 optimizer built with Electron, Node.js, PowerShell/CIM and locally compiled Tailwind CSS.

## Use on your PC

1. Open `dist/XeroLag-Setup-0.3.1-x64.exe` and install XeroLag. Node.js is not needed.
2. Launch XeroLag from the desktop or Start menu and accept its Windows administrator prompt.
3. On Overview, choose **Create snapshot**. The app saves your original settings and verifies a Windows restore point. If Windows protection is disabled, open **System Protection** from the expanded recovery section, enable protection for the system drive, and retry.
4. Choose a gaming profile or review individual settings. Nothing is optimized automatically at startup.
5. Use **Repair > Recovery** to restore module settings, or **Gaming > Profiles > Revert all** for profile changes.

Install this update over the existing version. The application ID and recovery formats are unchanged; saved backups remain in place. This is a local unsigned personal-use build. The installer does not publish or upload anything.

The custom installer uses a rounded, frameless XeroLag interface with folder selection, a desktop-shortcut choice, verified embedded files, progress, retry and explicit launch. It installs offline using the existing NSIS upgrade/uninstall engine. See [installer details](docs/INSTALLER.md).

## Build and run

Install Node.js 24 LTS, then run from the project directory:

```powershell
npm ci
npx --no-install install-electron
npm run dev
```

If npm reports blocked install scripts, inspect them with `npm install-scripts ls` before approving specific packages. Approved versions are recorded in package.json. End users do not need Node.js.

| Command | Purpose |
| --- | --- |
| npm run check | JavaScript/PowerShell/native declaration checks and isolated tests |
| npm run test:desktop | Sandboxed UI and live read-only Windows checks |
| npm run build | Checks, supplied icon preparation and production CSS |
| npm run clean | Remove generated caches, icon and CSS; keep source, dependencies, releases and app backups |
| npm run pack | Unpacked Windows x64 app |
| npm run dist | Rounded offline installer, embedded NSIS engine and SHA-256 checksum |
| npm run test:installer | Isolated custom installer UI checks; no installation |

Development verifies administrator access and offers UAC relaunch; packaged builds request elevation through their executable manifest. Close an elevated development window before restarting it.

## Features

| Section | Tools |
| --- | --- |
| Overview | Live CPU/RAM/GPU/VRAM/disk/uptime, measured history, hardware and storage |
| Clean | Reviewed Windows/launcher caches, large files, SHA-256 duplicates and empty folders |
| Gaming | Profiles, Game Mode/HAGS, power/core parking, input/USB, clock/tick/MMCSS, MSI, game library, automatic booster and timer request |
| Network | DNS lookup/ICMP tests, route history/loss/jitter, adapter details, reversible MTU, Nagle, update sharing, flush/resets and adapter restart |
| Windows | Run keys/startup folders/non-Microsoft tasks, curated services, supported app removal and shell preferences |
| Repair | Combined DISM/SFC, SSD TRIM, health/SMART, winget, standby purge, Delivery Optimization cleanup, permission audit and recovery |
| Tools | Startup search/bulk review, services search, process viewer/normal app close, app-managed registry values, Windows diagnostic utilities |
| Settings | Saved density, reduced motion, online artwork preference and Ctrl+K navigation |

The interface groups settings by purpose and expands commands, explanations, advanced options and logs on demand. Settings show their current preference, custom/default or unavailable state; matching choices are disabled. Review shows the exact requested values, restart/sign-out requirement and recovery path before a module setting is applied. A short-lived single-use review token binds application to the inspected state; changed state requires another review. Previews do not create restore points or copy OneDrive installers. App removal uses a combined review. Missing readings stay unavailable; no optimization score or FPS gain is fabricated. See [the feature matrix](docs/FEATURE_MATRIX.md) for availability and reversal limits.

Cleanup uses a Select > Review > Results workflow with grouped caches, a selection summary and retained results. Activity in the sidebar tracks session tasks and provides live logs while you navigate. Settings place their current state next to the name, with explanations and restart requirements behind an information disclosure. All values and results come from Windows or completed operations.

## Recovery

Persistent changes first capture affected original values and verify a Windows System Restore point. If protection, policy or the Windows creation-frequency limit blocks a point, the change stops. A confirmed point for the same profile baseline may be reused for up to 24 hours. The app does not disable restore-point throttling.

Profiles preserve the original typed registry values, key/value existence and active power plan across switches. Feature records capture registry, service, boot, DNS, power, startup and package state. Reapplying a supported setting retains its first original baseline. Each change saves a journal before writing and attempts rollback on failure. Repair > Recovery restores feature records in reverse order, followed by the profile baseline. Restore means saved original settings, which may differ from factory defaults.

Recovery data normally lives under %APPDATA%\XeroLag: profile records in safety, other records in protected. These directories use administrator/SYSTEM-only permissions and a high integrity label. Records have SHA-256 corruption checks and Windows/user identity checks. Preserve the full directories; do not edit recovery files.

Limits:
- Cache deletion is permanent after review/confirmation. Locked or changed files are skipped; login databases and storage directories are excluded. If a launcher starts after scanning, its category is skipped while other caches continue. Windows Update downloads are skipped if the service helper cannot pause safely; other caches continue only after service restoration is confirmed. Failed service recovery stops cleanup and remains available under Repair > Recovery. The task log records the underlying error and skipped categories.
- Selected personal files go to the Recycle Bin. Empty folders must still be empty. Duplicate removal requires an unchanged retained copy.
- Appx removal targets allowlisted current-user packages. Restore can re-register only a retained package payload; otherwise reinstall through Microsoft Store. OneDrive uses a saved Microsoft-signed installer and may need setup/sign-in. Recall requires the installed Windows feature.
- Native repairs, application upgrades and network resets have no universal JSON undo. Windows System Restore is available separately. SFC/DISM are not forcibly cancelled.
- TRIM is offered only for identified SSD/NVMe volumes. Health/SMART counters depend on the storage driver and are not a complete hardware diagnostic.
- MSI, HAGS and boot changes may require restart; input preferences may require sign-out.
- Core parking changes actual power-plan unparked-core percentages. SystemResponsiveness values below 10 are clamped by Windows to 20; zero is not advertised as a guaranteed latency improvement.
- MarkC import accepts only whitelisted mouse preference/curve values from a user-selected preset; it never executes arbitrary .reg files. Select a preset matching your display configuration.
- DNS tests report a timed lookup and ICMP round trip separately. Route diagnostics measure four ICMP probes to 1.1.1.1 using the system route; these are not game-server ping or download-speed measurements. ICMP may be blocked.

## Game sessions

Steam, Epic, Riot and Roblox discovery uses local launcher metadata; a native executable picker adds missing games. Launch profiles are explicit choices. Steam cards use installed library artwork first, then an allowlisted official Steam CDN; other launchers use native executable icons or a user-selected PNG/JPG/WebP cover. Downloads are bounded, cached locally and can be disabled in Settings. See [artwork and measurement sources](docs/SOURCES.md).

The booster watches selected games, temporarily requests High CPU priority and a selected existing power plan, and optionally suspends only selected browsers/launchers. Their audio/downloads pause. Changes restore when the last selected game closes or the helper exits. A parent watchdog and durable journals support interruption recovery. The 1 ms timer request lasts only for the helper lifetime; the interface shows the Windows-reported effective resolution. No Realtime priority or measured performance benefit is claimed.

## Security and validation

The renderer uses sandboxing/context isolation, no Node integration, restrictive CSP, blocked navigation/downloads and denied permission requests. Preload exposes named actions only. Main validates sender/frame/document and fixed actions; no renderer-supplied commands or registry paths are executed. Native pickers issue opaque path capabilities. Commands use absolute executable paths, argument arrays, no shell, bounded output and timeouts. Bundled PowerShell scripts use terminating error handling and try/catch. Per-user changes require the Explorer desktop account.

Tests cover IPC, telemetry, snapshots, rollback, corruption, profile transitions, file identity, junctions, duplicate retention, cache exclusions and MarkC parsing using isolated fixtures. Test files stay under `.cache/tests`; desktop profile fixtures are removed after each run. The desktop test loads every module with real Windows reads, in-memory profile writes and blocked system mutation APIs. Set XEROLAG_CAPTURE_PREVIEW=1 to save previews under `.cache/previews`.

Real elevated mutations, restore-point creation, process suspension, reboot effects and installation/uninstallation still require disposable Windows VM validation before public release. Tests do not perform those actions against the development PC.

## GitHub publishing

The branded download page and Windows release workflows are included. See [publishing instructions](docs/PUBLISHING.md) to enable GitHub Pages and publish the executable/checksum through GitHub Releases. Source pushes build a draft release; publication remains a separate action.

The download page follows the latest stable GitHub release, including its actual version, size and checksum link. The installer remains unsigned. Keep credentials and signing certificates outside source control.

## Source layout

- main.js / preload.js: lifecycle, elevation and named bridge.
- assets/branding: supplied logo and original ICO.
- assets/generated: generated application icon; recreated by the build.
- src/main: telemetry, profiles, journals, jobs, cleaners, file finder, games and repair orchestration.
- src/powershell: fixed Windows reads/actions, native repair tools and lifetime-bound helpers.
- src/renderer: shell, overview, profiles, workbench and stylesheet.
- scripts / tests: packaging, checks and isolated verification.
- docs: [feature support and recovery limits](docs/FEATURE_MATRIX.md).
- DESIGN.md: interface guidelines, kept at the root for design-tool discovery.
- .cache: disposable package intermediates, test data and optional previews.
- dist: installable release and its SHA-256 checksum.

`assets/branding/HeaderLOGO.png` and `assets/branding/iconLOGO.ico` are the supplied assets. Icon preparation preserves the source and adds a 256px frame for packaging; source detail remains limited by the original resolution. Packaging stages files in `.cache/package`; the final installer and checksum are copied to `dist`. `npm run clean` never accesses `%APPDATA%` or deletes real application recovery data.

