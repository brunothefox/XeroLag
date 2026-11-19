# XeroLag 0.3.1

Added a rounded, frameless XeroLag installer with branded artwork, folder and shortcut controls, offline payload verification, progress, retry and explicit launch. The existing NSIS engine continues to handle app upgrades and uninstallation. See [installer details](INSTALLER.md).

## XeroLag 0.3.0

- Expanded sidebar with Startup Manager, Services, Registry, Processes, More Tools, Activity and Settings.
- Ctrl+K navigation, saved compact layout and motion preferences, persistent errors and dismissible success notifications.
- Searchable game library with launcher filters, explicit launch profiles, installed or official Steam artwork, native app icons and imported covers.
- Startup search, status filtering, combined selection review and historical Windows boot measurements when available.
- DNS lookup testing, ICMP latency, route history, packet loss, jitter, adapter details, reversible MTU and adapter restart.
- Process memory/CPU-time viewer and normal close requests for owned desktop apps.
- App-managed registry viewer and shortcuts to installed Windows diagnostic, maintenance and recovery tools.
- Combined DISM/SFC repair, Windows Delivery Optimization cleanup and read-only folder permission verification.
- Chrome, Edge and Firefox cache categories with browser process guards and login exclusions.
- Coalesced Windows reads, brief page caching, lazy artwork and bounded image downloads.

Validation: JavaScript and PowerShell checks, 66 isolated automated tests, and Electron navigation/component/workflow checks across 19 module pages at 1200×800 and 900×620. Tests blocked real system changes; elevated mutations and reboot behavior were not exercised on this PC. The locally built unsigned x64 installer has a verified SHA-256 checksum.

Install over the previous version. Existing app identity and recovery formats are retained. The package has not been published to GitHub.
