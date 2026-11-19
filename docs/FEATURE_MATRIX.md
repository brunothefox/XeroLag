# Feature support and reversal

All original module groups are implemented. Availability is detected from the installed Windows edition and drivers. Status: local unsigned development build; elevated end-to-end VM validation remains outstanding.

| Module | Implemented scope | Recovery and limits |
| --- | --- | --- |
| Overview | Live usage/history, inventory and storage | Read-only; missing counters stay unavailable |
| Profiles | Gaming, Competitive and Quiet | Typed originals and original power plan |
| Caches | TEMP, Windows Temp, Prefetch, update downloads, thumbnails/icons, shader caches, Discord/Steam/Epic/Riot/Roblox, Chrome/Edge/Firefox caches | Permanent cache removal after review; locked/changed files skipped; browser logins excluded |
| File finder | Large files, SHA-256 duplicates, empty folders | Recycle Bin; unchanged duplicate keeper required |
| Gaming | Clock/tick, MMCSS, MSI/priority, core parking, Ultimate, Game Mode/HAGS | Original boot/registry/power settings; restart may be needed |
| Memory/input | Standby purge, paging executive, SysMain, acceleration/MarkC, keyboard and USB suspend | Original registry/service settings; purge is transient |
| Games | Steam/Epic/Riot/Roblox and manual executable, profile launch, search/filter, real covers and app icons | Local metadata; optional cached official Steam artwork; imported covers supported |
| Booster | Selected-game detection, High priority, plan, optional suspension, timer | Parent watchdog, journal and next-launch recovery |
| Startup/services | Run keys/folders, non-Microsoft tasks, search, bulk review, recorded boot/application time and curated services | Original values/files, task state and service mode/running state; event timing may be unavailable |
| Network | DNS lookup/ICMP tests, route samples/loss/jitter, adapter details/restart, MTU, Nagle, delivery sharing, flush/resets | Original IPv4/IPv6 DNS, MTU policy stores and registry; resets use System Restore |
| Debloat | Allowlisted Appx, Recall, OneDrive | Retained manifests/signed installer; reinstall may be necessary |
| Shell | Context menu, suffix, visibility, Sticky Keys, diagnostics/ads, animations | Typed originals; some require sign-out |
| Repair | Combined DISM/SFC, SSD TRIM, SMART/health, winget, Delivery Optimization cleanup and folder permission verification | Live logs; permission verification is read-only; native repairs have no universal JSON undo |
| Processes | Current-session memory/CPU time/priority and normal application close | Close restricted to owned GUI apps; no forced termination |
| Registry/tools | Read-only app-managed registry values, Windows diagnostics, backup and recovery shortcuts | Fixed utility allowlist; Windows wizards control their actions |
| Interface | Expanded sidebar, Ctrl+K navigation, density/motion/artwork preferences, review dialogs, notifications and lazy artwork | Preferences stored locally; reduced motion supported |
| Safety | Restore-point gate, protected snapshots, rollback and reverse restoration | Identity and corruption checks |
| Distribution | Rounded offline x64 installer, embedded NSIS upgrade/uninstall engine and SHA-256 | Unsigned local build; public GitHub release not yet published |

Remaining release work: disposable Windows verification of real UAC cancellation, restore points, every elevated mutation/reversal, interrupted helpers, reboot effects and installer/uninstaller. Automated tests isolate writes and use live read-only Windows discovery.

