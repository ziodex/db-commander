# Beta qualification evidence protocol

This document describes how to collect the remaining evidence. Completion is recorded only in the [single beta checklist](PLAN.md#beta-release-checklist); an empty record or a prepared procedure is not a pass. Use disposable databases and test accounts. Keep private SQL, credentials and personal profiles out of retained reports.

Each qualification record must identify the tester/date, candidate version, full source commit, build ID, platform/OS/architecture, installer SHA-256, hardware, relevant engine/authentication/tool versions, steps, actual outcomes and retained evidence paths. Failures need a reproduction, resolution and a repeat against the fixed bytes. Follow [release setup](RELEASING.md) for signing and native CI.

## Reference hardware — B10

The existing M5 Pro/64 GiB runs are a baseline. Select and record representative lower-memory hardware and the proposed support floor before claiming minimum-hardware support. Repeat large/wide result previews, catalog discovery/filtering, typing during streaming export, cancellation, multiple workspaces and sustained use. Record elapsed times, per-window post-GC heap/DOM/listeners, complete owned process-tree RSS/count and responsiveness trends. Preserve the existing regression budgets; a faster workstation's result does not certify another machine. Document any revised product budget with its measured basis.

## Clean OS installation — B14

Publish the intended OS floors after native qualification. Test each offered format on a clean end-user OS at the floor and a current version, using the exact promoted bytes downloaded from the final website. Record the browser/download URL and quarantine or SmartScreen behavior. Verify the published checksum and expected Mac/Windows signer before launch.

Exercise first launch, icon, menus, tray hide/restore/quit, a saved connection, optional OS credential storage, native SQLite/DuckDB values, restart with saved SQL and no automatic reconnect/replay. Check manual replacement/upgrade, uninstall/reinstall, profile retention and paths with spaces where supported. Include Windows running-app/locked-executable refusal and native Linux package-manager behavior. Preserve the signed installer and reports as the next real upgrade baseline. Local copying from DMG/ZIP does not establish browser-quarantine behavior.

## Human assistive technology — B15

Use VoiceOver on macOS, NVDA on Windows and the intended Linux reader/desktop. Record exact OS, reader, browser engine/application and input-device versions. A human tester must listen to the spoken result; accessibility-tree or keyboard automation alone does not close this gate.

| Workflow | Outcome to record |
| --- | --- |
| Launch and navigate | Landmarks, headings and toolbar names identify the workspace; keyboard order and visible focus follow the interface. |
| Save several profiles and reconnect | Every profile is discoverable and distinguishable; folder menus, engine choice, validation and password-state descriptions are announced. Reconnect is explicit. |
| Edit and execute SQL | Editor instructions, tab names/selection, running/completion/error states and Stop are understandable without vision. |
| Inspect results | Headers, row/column positions, exact values, NULL/empty distinctions, value dialogs and large-value truncation are announced accurately. |
| Edit and settle a transaction | Staged edits, review/confirmation, transaction state and rollback outcome are distinguishable. Use only a disposable table. |
| Open and dismiss dialogs/menus | Focus enters the appropriate control, stays in a modal, and returns to its owner; Escape and keyboard menu navigation work. |
| Recover from an error/restart | Errors are announced without an announcement loop; saved SQL returns with no silent reconnection or execution. |
| Change theme/zoom and tray state | Both themes and 200% zoom remain usable; hiding/restoring a workspace recovers useful focus and reader context. |

Record verbatim short announcements where needed to demonstrate a defect, with expected meaning, affected control and resolution. Retest the full affected workflow after a fix.

## Daily-use pilot — B17

Use the intended platforms and engine/authentication combinations for real development work with a safe test data set. Record participant/maintainer sign-off, duration, workflows, interruptions, resource trends and issue disposition. Include files/recovery, several saved profiles, query/transaction work, exports, explicit reconnect and manual update. Collect actual observations; an unattended soak is separate evidence. Correctness, data recovery, installation and accessibility blockers must be resolved and retested before release acceptance. Release owners must agree the supported combinations and pilot coverage; no pilot sign-off exists merely because this protocol is written.

## Publishing and evidence retention — B16

Use [detego.no](https://detego.no) as the selected website and [post@detego.no](mailto:post@detego.no) for support/private reporting. The exact download path, uploaded bytes and receipt of downloads are still unverified. Before publication, retain the promoted installer set, inventory/notice sidecars, checksums, manifests, lifecycle reports, source commit and successful Azure run outside temporary test output. Apply explicit retention to the Azure run before exposing links; verify the retention setting and record its owner. Preserve each published version while offered for download and keep the previous signed installer set for the next real upgrade qualification. Do not substitute regenerated bytes for a published baseline.

The final release record must name accountable platform/driver owners and the tested OS, engine, native-client and authentication versions. A source implementation or local fixture is not sufficient to claim a supported combination. Complete dependency/redistribution review, including the explicitly incomplete native/vendor composition in generated inventories, before offering public packages.
