# Db Commander product roadmap

Updated **4 November 2026** against development and the A1 work. Qualification remains scoped to the evidence below.

## Product goal

Build a fully functional, open-source desktop database workbench for SQL development, data work and database administration, with DataGrip, HeidiSQL and SQL Server Management Studio as workflow benchmarks. Essential workflows remain open source, local-first and usable without an account. Deliver on macOS, Windows and Linux.

Success means completing everyday work in Db Commander: connect, find objects, write and diagnose SQL, inspect results, edit data and schemas, move data, administer databases, and recover unfinished work. Measure completion by engine and operating system, with observable acceptance criteria and current test evidence.

This roadmap replaces the frozen beta backlog. The [previous beta plan](PLAN_BETA_ARCHIVE.md) and [earlier plan history](PLAN_HISTORY.md) preserve dated decisions and evidence. Their pending items and old CI run descriptions are historical; they do not define current product priorities or qualify changed application bytes.

## Current foundation

Version 0.2.4 is a developer preview. The implementation includes saved profiles and OS-stored passwords, TLS/SSH, SQL Server Windows Authentication on Windows, query tabs sharing connections, transactions/cancellation, SQL files and recovery, snippets/history/parameters, completion/formatting, split editors, themes, paginated table browsing and conservative editing, object inspection and basic schema changes, diagrams/comparisons, migration export, import/full-result export, backup/restore, plans, and session/lock tools.

Adapters exist for PostgreSQL, MySQL, MariaDB, SQL Server, Azure SQL, SQLite, DuckDB and Oracle Thin mode. Capability, authentication and qualification differ by engine. Azure SQL remains experimental; local TDS coverage does not qualify the cloud service.

The review found that workflow depth and consistency are the priority. Existing features should be extended where possible. Keep [user-facing limits](USER_GUIDE.md), [architecture](architecture/README.md) and [engine validation](DRIVER_TESTING.md) aligned with the implementation.

## Milestone 1 — Reliable daily workbench

Complete the confirmed correctness fixes first, then improve daily navigation and result handling.

| ID | Deliverable | Acceptance criteria | Status |
| --- | --- | --- | --- |
| R1 | Preserve passwords when profile persistence fails | Rejected profile edits, deletions and password removals leave existing credentials usable. Successful saves record cleanup durably before deleting credentials; interrupted cleanup is retryable without deleting a replacement password. | Complete · local validation |
| R2 | Make protection scope explicit | Confirmation names all tabs sharing the connection, including subsequently opened tabs. Shared unlock/relock propagates; separate physical connections stay locked; reconnects start locked. | Complete · local validation |
| R3 | Report edited-profile connection status truthfully | A live connection using previous settings is identified. The updated profile can connect independently, old tabs retain their actual engine/context, and disconnect remains available subject to transaction safeguards. Cosmetic profile edits do not imply an endpoint change. | Complete · local validation |
| W1 | Clarify sessions and connection navigation | Expose shared versus independent connection choices, visible session ownership, connection search/quick switching, duplication, and secret-free profile import/export. Verify temporary objects, transactions and closing behavior. | Complete · local validation |
| W2 | Improve result navigation and exports | Select a row-bearing result after a script; label result sets with statement/count context. Distinguish Export preview from Export all rows, preserving the existing explicit re-execution review. | Complete · local validation |
| W3 | Add result exploration | Find/filter/sort loaded query results with explicit preview scope; add useful copy formats, pinned result snapshots and independent result panes. Existing server-side table filters/sorting remain available. | Complete · local validation |

## Milestone 2 — Complete schema and data workflows

| ID | Deliverable | Acceptance criteria | Status |
| --- | --- | --- | --- |
| S1 | Expand table and object designers | Create/alter native types, nullability, literal/expression defaults, identities/generated columns, foreign/check/unique constraints and engine-specific indexes. Preview exact SQL and transaction behavior; cover supported operations against each real engine. | Complete · merged; documented engine limits apply |
| S2 | Edit database object source | Load, edit, compare and apply views, routines and triggers; show definition origin and stale-source conflicts. Provide useful create/alter/drop scripting and routine execution with discovered parameters. | Complete · merged; documented engine limits apply |
| D1 | Broaden safe grid editing | Add SQL change previews, row duplication/bulk paste, supported large/binary/complex-value editors and eligible simple-query editing. Preserve exact values and concurrency checks; define safe behavior for tables containing unsupported columns or triggers. | Complete · merged; documented engine limits apply |
| D2 | Complete transfer workflows | Extend existing streaming import/export with saved mappings, new-table import with reviewed type inference, richer formats and reviewed database-to-database transfers. Verify cancellation, partial outcomes and large inputs. | Complete · merged; documented engine limits apply |

## Milestone 3 — Database development tools and scale

| ID | Deliverable | Acceptance criteria | Status |
| --- | --- | --- | --- |
| Q1 | Develop SQL intelligence | Add dialect-aware diagnostics, richer derived/correlated-query completion, routine signatures, definition/reference navigation and previewed rename refactoring. Analyze without executing the SQL being edited. | Complete · merged |
| C1 | Navigate large catalogs | Replace preview-only discovery with lazy loading, paging and server-side object search. Find objects beyond the current 2,000-object preview while retaining bounded memory and responsive navigation. | Complete · merged |
| C2 | Deepen comparison and migrations | Scale schema and data comparison beyond small captured sets. Generate dependency-aware migration scripts and reviewed synchronization plans. Show scope, consistency and destructive operations. Refuse partial captures. | Complete · merged |
| Q2 | Improve analysis workspaces | Extend graphical execution plans beyond PostgreSQL, add useful plan comparison and performance context, persist diagram layouts, and support projects/SQL directories suited to source control. | Complete · merged |

## Milestone 4 — Administration depth

| ID | Deliverable | Acceptance criteria | Status |
| --- | --- | --- | --- |
| A1 | Manage security principals | Inspect and manage users/logins/roles/grants using each engine's privilege model. Preview changes and surface inherited/effective permissions and visibility limits. | Complete · locally qualified |
| A2 | Manage database lifecycle and maintenance | Add reviewed database create/rename/drop operations, supported maintenance/statistics/index tools, and richer backup/restore workflows. Use engine-specific capabilities and accurate transaction/permission reporting. | Partial · guided backup/restore merged; lifecycle and maintenance remain |
| A3 | Add operational diagnostics | Extend existing sessions/locks tooling with performance diagnostics, engine-specific job/schedule management where supported, and a unified operation/progress history. | Planned |
| A4 | Complete authentication workflows | Add interactive Entra sign-in and renewal, Windows integrated authentication where supported, and separately qualified cloud/network paths. Document each supported authentication/platform combination. | Partial · Windows SQL Server authentication exists; Entra and cloud qualification remain |


The PostgreSQL slice covers cluster roles, direct and indirect memberships, and effective database and selected-relation privileges. MySQL and MariaDB add host-qualified account identities, visible role chains and their table grants, and the roles enabled on the separate catalog connection. All three provide copyable manual SQL previews for role creation, membership changes and table privilege grants or revokes. SQL Server and Azure SQL separate database users and roles from server logins and roles, distinguish grants from denials, and report effective permissions for the catalog connection where the engine exposes them. Oracle scopes dictionary visibility, role and system privileges to the current container. These engines also provide manual SQL previews. SQLite and DuckDB file connections have no server principal catalog. PostgreSQL supports reviewed role and login changes in a separate transaction. MySQL and MariaDB support reviewed account and role creation, account rename and login locking, direct grants, and dependency-checked removal. Their reviewed statements commit on a separate connection. SQL Server and Azure SQL support reviewed database roles and users, server logins and role memberships, and direct grants and denials. SQL Server checks cross-database login mappings before removal. Logical Azure SQL login removal is outside the app’s reviewed workflow. Oracle supports reviewed local roles and users, account locks, CREATE SESSION, memberships and relation grants. Oracle removal and revocation check local dictionary dependencies and use the engine’s automatic commit semantics.

Final local qualification passed **1,171 unit tests with three platform skips**, **11 focused server contracts**, **six packaged Apple Silicon workflows** and **three startup checks**. The packaged workflows cover exact scope and SQL at confirmation, keyboard focus and 200% zoom. Before the UI review corrections, **99 embedded driver contracts** and **176 packaged desktop workflows** passed, with ten platform or fixture skips in the desktop suite. The Azure SQL profile uses the local TDS fixture. Logical Azure metadata, role planning and guards have unit coverage. Independent UI and documentation reviews are complete. Live Azure and cross-platform CI qualification remain separate.

## Engineering and open-source delivery — continuous

- Keep connection/session, query-execution, tab-lifecycle, table-data and schema-tool workflows with their feature controllers (see [renderer ownership](architecture/README.md#renderer-workflow-ownership--28-october-2026)). Extend those owners as workflows change; avoid growing the workspace root or introducing unrelated broad refactors.
- Maintain a capability matrix by engine, server version, authentication mode and desktop OS. Distinguish implemented, verified, partial and unsupported behavior; record exact source/package identity for validation.
- Require targeted regressions for correctness fixes, lint/typechecks/unit tests, affected real-engine contracts and native desktop workflows. Improve packaged-test selection using explicit tags/projects instead of duplicated file/regular-expression lists.
- Keep contribution setup reproducible, dependencies/notices traceable, and feature ownership/contribution areas clear. Public core functionality remains available without proprietary services.
- Publish reproducible platform packages with accurate installation/update instructions, documented support floors and qualified upgrades. Preserve keyboard/accessibility, crash/disk-full recovery and exact-value behavior throughout feature expansion.

## Beta release checklist

This is a delivery checklist alongside the product roadmap, not a feature freeze. Dated B01–B17 records remain in the [archived beta plan](PLAN_BETA_ARCHIVE.md#beta-release-checklist).

- [ ] Select a release commit/version and publish its actual capability/known-issue matrix.
- [ ] Pass the affected engine contracts and native desktop/build/installer matrix for that candidate.
- [ ] Verify supported install/upgrade/recovery paths and performance on reference hardware.
- [ ] Validate representative assistive-technology and daily-use pilot workflows.
- [ ] Complete signing/notarization, notices/SBOM/checksum review and public release materials for the distributed bytes.

Release qualification stays tied to its exact candidate and tested scope. Updates are currently manual. This roadmap does not schedule a release, long-running soak, publication or branch merge.

## Review and completion

Q1 and Q2 add offline editor assistance, reviewed alias changes, native plan trees and baseline comparisons, durable diagram layouts and a local SQL folder browser. Local validation includes **1,154 unit tests with three platform skips**, focused contracts across all seven engines, and **30 focused packaged workflows** on Apple Silicon. The combined C1, C2, Q1 and Q2 changes passed all 12 development CI checks and merged as developer preview 0.2.4. See [Milestone 3 validation](DRIVER_TESTING.md#milestone-3-sql-intelligence-and-analysis-workspaces--3-november-2026).

C2 compares scoped inventories of up to 1,000 objects per side, with detailed review for up to 40 per side. It compares up to 2,000 rows per side within the existing 4 MiB limit, orders supported table drops by visible foreign-key dependencies and exports reviewed synchronization plans for manual use. Local macOS Apple Silicon validation passed **1,140 unit tests with three platform skips**, **23 focused contracts across seven engines**, **two embedded 2,105-table contracts**, and **174 packaged workflows and three startup checks with ten platform or fixture skips**. Independent UI and documentation reviews are complete. Cross-platform CI and release qualification remain separate. See [C2 qualification](DRIVER_TESTING.md#c2-comparison-and-migrations--3-november-2026).

C1 now provides server-side search beyond the old preview, 100-object forward/backward pages, lazy table children and targeted inspection while preserving physical-owner locks and SQL buffers/results. Local macOS Apple Silicon qualification passes **1,134 unit tests / three platform skips**, **173 packaged workflows and three startup checks**, focused catalog checks on all seven engines, five server overflow contracts, five native server explorer cases, embedded driver checks at 10,000/20,000 tables and native checks at 20,000 tables. Independent UI review resolved the single contrast finding; the existing visual system is retained. Completion and feature snapshots retain their documented limits; cross-platform CI and release gates remain separate. See [C1 qualification](DRIVER_TESTING.md#c1-catalog-navigation--2-november-2026).

The backup/restore portion of A2 now has a guided configure/check/review/run workflow, native local-file and tools-folder choices, bounded advisory metadata checks, searchable job history and explicit connection to a successful restore in an empty independent tab. Existing new-target, no-overwrite, transaction, credential and unknown-outcome protections remain authoritative. This implements the backup/restore slice only; the other A2 lifecycle and maintenance work remains on the roadmap. Qualification and limitations are recorded in [backup testing](DRIVER_TESTING.md#backup-and-restore).

D2 transfer implementation passed local macOS Apple Silicon qualification on 30 October 2026: lint, both TypeScript projects, production/unpacked packaging, **1,095 unit tests / three platform skips**, **99 full embedded-engine contracts**, and focused new/existing transfer contracts across all seven database engines. A late-invalid-record case verifies that row rollback leaves the explicitly committed empty table in place. The Mac package passed **166 workflows and three startup checks** (ten platform/fixture skips), followed by **four final packaged D2 cases**, including unusual-header suggestions, bound capture without source replay and native actionability at 125%/200% zoom. Independent UI review resolved two copy labels; documentation review retained the incumbent design system. [Transfer tests](../tests/desktop/transfer-workflows.spec.ts) and [workflow contracts](../tests/integration/transfer-workflows-contract.ts) cover saved mappings, reviewed table creation, exact JSON Lines and bounded one-shot database copies. Cross-platform CI is qualified separately on the PR head.

W3 passed local macOS Apple Silicon validation on 28 October 2026: lint, both TypeScript projects, production/unpacked packaging, **964 unit/controller tests passed / three platform skips**, **91 embedded-engine contracts** (44 SQLite; 47 DuckDB in UTC), and **19 focused packaged scenarios** (15 W3 and four result-selection regressions). The final package passed **159 desktop workflows and three startup/recovery checks**. [Result exploration tests](../tests/desktop/result-exploration.spec.ts) cover loaded-only scope, exact numeric/filter/sort/copy behavior, independent virtual panes, bounded window-only captures through reruns/tab closure/disconnect/Stop, partial warnings after export, and dark/light/compact/zoom layouts. Independent UI review resolved keyboard focus after Apply/Cancel; documentation review confirmed incumbent design-system continuity. Cross-platform CI and release qualification remain separate.

W2 passed local macOS Apple Silicon validation on 28 October 2026: lint, both TypeScript projects, production/unpacked packaging, **932 unit/controller tests passed / three platform skips**, **91 embedded-engine contracts** (44 SQLite; 47 DuckDB in UTC), **nine W2 Electron scenarios**, and **17 existing grid/accessibility/export/session regressions**. The packaged app passed **143 desktop workflows and three startup/recovery checks**. [Result navigation tests](../tests/desktop/result-navigation.spec.ts) verify mixed and empty results, affected/preview counts, preserved manual choices, partial failure/native Stop, 1,000-row cached versus 1,205-row reviewed export, no script/editor-mutation replay, fresh parameters, and compact/125% layouts including fractional scroll offsets. A separate UI review resolved selected-tab visibility and truthful source excerpts while preserving the existing dark/light system. Cross-platform CI and release qualification remain separate.

W1 passed local Windows x64 validation on 27 October 2026: lint, both TypeScript projects, production/native packaging, 911 unit/controller tests with 17 platform skips, and 11 targeted desktop scenarios. The packaged 0.2.2 app also passed native startup smoke checks and seven startup, connection-navigation and About scenarios. [Connection-navigation tests](../tests/desktop/connection-navigation.spec.ts) cover shared defaults, independent temporary objects/transactions, owner closing, switching, duplication and reviewed credential-free files. Dark/light and minimum-window layouts were inspected. Cross-platform CI and release qualification remain separate.

R1–R3 passed validation on the 26 October 2026 development worktree on macOS Apple Silicon: lint, both TypeScript projects, production build, **899 unit tests passed / three platform skips**, and **12 targeted Electron workflows passed**. Regression coverage includes rejected workspace writes, durable credential cleanup/reopening/replacement, edited-profile engine identity, and shared unlock/relock with independently locked connections. See [credential persistence tests](../tests/unit/credential-workspace.test.ts), [profile-state tests](../tests/unit/profile-connections.test.ts), [native credential workflows](../tests/desktop/credentials.spec.ts), [saved-connection workflows](../tests/desktop/saved-connections.spec.ts) and [protected-profile workflows](../tests/desktop/profiles.spec.ts). These results cover the local worktree; Windows/Linux and release qualification remain separate.

Mark work complete only after its acceptance criteria and relevant checks pass. Keep concise outcomes here and detailed evidence in test reports or the driver-testing record. Reassess priorities after daily-use feedback; move completed implementation diaries into history rather than growing this roadmap into a log.
