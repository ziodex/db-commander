# Db Commander architecture

Db Commander keeps the desktop interface, native capabilities and database execution in separate runtime layers. Feature modules share typed contracts and pure SQL utilities. The beta scope and release gates remain in [the product roadmap](../PLAN.md).

## Runtime boundaries

| Layer | Owns | Dependencies |
| --- | --- | --- |
| `renderer` | React views, editor models, volatile tab state and recovery coordination | `shared`, browser language services and frontend libraries |
| `preload` | The narrow `DesktopApi` bridge and event subscriptions | Electron IPC and `shared` |
| `main` | Windows, native dialogs, credentials, validated IPC and host supervision | Backend services and `shared` |
| `driver` | Physical sessions, query identity, execution routing and exclusive session operations | Engine adapters, feature services and `shared` |
| `backup`, `transfer`, `activity`, `schema`, `catalog` | Their bounded database workflows | Driver interfaces, the session owner and `shared` |
| `storage`, `files`, `credentials` | Recovery data, file publication and secret storage | Node APIs, narrow native dependencies and `shared` |
| `language` | Browser worker completion, formatting and execution-source analysis | `shared` and browser-compatible language libraries |
| `shared` | Runtime-neutral types, validation, policies and pure SQL utilities | Runtime-neutral libraries |

Database execution and backend services do not import React or Electron. The renderer has no generic filesystem, shell, database-driver or credential-reading API. Main validates IPC input and sender ownership; host handlers validate their requests independently. `HostContract` checks method names, request shapes and results across the internal transport. `DesktopApi` checks public handler results. Native capability checks remain at the boundary where the operation occurs.

`pnpm lint` enforces static import boundaries, Hook ordering and effect dependencies. `pnpm typecheck` checks the whole project and separately checks the renderer without global Node types. Builds include these checks. Architecture regression tests exercise forbidden imports and Hook violations. [GitHub Actions](../GITHUB_ACTIONS.md) runs on pushes to `development` and `main`, and on pull requests targeting either branch. Signed releases remain explicit, main-only runs after all validation passes.

## Frontend ownership

`App` composes the workspace and coordinates commands that cross features. `ConnectionDialog` owns connection form state and credential-store status. `useWorkspaceRecovery` owns loading, the serialized save queue, autosave and save-status announcements. Persisted workspaces contain buffers and non-secret settings; live connections, results and transactions remain volatile.

`query-tabs` owns pure database-event transitions. Session and execution identities determine event ownership. `useJobFeed` combines the initial job list with subsequent events so an older list cannot replace a newer event. Effect Events read the current callback state without repeatedly replacing subscriptions. Cleanup closes the exact dialog element opened by that effect.

`UpdateBanner` subscribes to the application-wide metadata status and owns its transient presentation/focus state. Main owns the startup/daily/resume schedule, version comparison and per-version dismissal. Only fixed GitHub release pages can be opened, and installation stays manual. The sandboxed preload validates update status without importing external runtime packages.

Keep state with its feature. Extract a controller or hook when a feature has its own asynchronous lifecycle, rather than adding independent flags and effects to the workspace root. Keep SQL buffer changes in Monaco's existing edit/undo path.

The explorer derives its catalog tree only when catalog/filter inputs change. Its memoized tree does not rebuild thousands of rows for SQL edits. Visible object collections consume current inspection actions and busy state through context; collapsed collections are created when expanded. Catalog actions still validate the current session before inspecting or changing anything.

## Renderer workflow ownership — 28 October 2026

The workspace root previously owned connection, execution, tab-closing, table-editing and schema-tool lifecycles in one component. These workflows now have explicit owners while `App` keeps workspace recovery, editor/layout coordination, commands and view composition.

| Module | Owns |
| --- | --- |
| `use-tab-runtime` | Volatile tab state, synchronous state references and the existing shared-session reconciliation path |
| `use-workspace-sessions` | Connection generations, lost-session cleanup, saved-profile/password operations, catalog loading and database switching |
| `use-query-execution` | Execution source, parameters, plans, history, event subscription and cached preview export |
| `use-workspace-tabs` | Shared/independent tab creation, pinning, close confirmation and sequential view release |
| `use-table-data` | Table loading, staged edits, inspection/navigation and saved column layouts |
| `use-schema-tools` | Object inspection and reviewed schema changes |

`WorkspaceRuntime` is the narrow shared mutation interface, not another feature controller. It exposes the existing workspace reference/save path and tab mutations; each feature keeps its own asynchronous operations and presentation state. Feature dependencies are explicit, with type-only imports for their contracts. The existing `query-tabs` transitions, `shared-sessions` policies, profile-library and SQL-file hooks remain authoritative.

Connection generation checks still reject late connections after host loss. Session/query/view identities still determine where asynchronous responses belong. Closing one shared tab releases its view; the last owner disconnects the physical session. Persisting a profile still precedes password storage. No SQL is replayed by recovery, preview export or these extractions. W3 result exploration, snapshot storage and pane presentation remain owned by the existing result components.

The controller regressions in `tests/unit/workspace-controllers.test.tsx` exercise late events and acknowledgments, stale connection/clone/switch responses, shared closes, staged-edit and transaction guards, credential save ordering/failure and partial-result provenance without rendering the whole application. Existing native workflows cover the composed application. This change preserves behavior and runtime topology; formatting and broader UI decomposition remain separate work.

## Backend ownership

Main serializes credential operations. `CredentialWorkspace` commits workspace references and a journal of credential IDs in one SQLite transaction before deleting OS-store entries. Cleanup is retried on saves and workspace opening; password replacement waits for pending removals to settle. The journal holds IDs only, stays outside renderer workspace writes, and is acknowledged only after both current and legacy credential namespaces are cleared. Failed workspace persistence never removes a credential.

`DatabaseHostClient` owns lazy process startup, readiness, pending requests, response correlation, acknowledgement tokens and confirmed shutdown. A failed startup retains ownership until the child exits. Renderer recovery waits for that exit before opening another window. Writes without a transport deadline remain owned until completion or host failure; timing out a reader never authorizes replaying SQL.

On Windows, the database host establishes an external ownership guard before opening workspace storage or adapters. The app builds this small C# executable with the Windows .NET Framework compiler and ships it as a hashed physical resource. No compiler or PowerShell runs at application startup. The helper validates the main process creation time and holds Windows kernel handles for the main and host processes. Main-process death terminates that exact host; host exit ends the helper. Kernel handles prevent a reused PID from redirecting termination. A missing or failed guard fails host startup. This separate process remains effective while Electron tears down the host's Node environment, when a thread inside that environment can no longer supervise outstanding native work. It adds one Windows process per workspace and requires affected native qualification.

Window callbacks retain the window identity that registered them. Recovery detaches a crashed window before destroying it; a delayed close notification for that old window cannot clear or shut down its replacement.

`DriverRegistry` remains the single owner of session reservations and query routing. `BackupJobs` and `TransferJobs` own their job records, cancellation controllers and terminal outcomes. They obtain session access through `SessionAccess`; they do not create independent locks. Reservations must be acquired synchronously before publishing a running event or awaiting database work. File publication, transaction and cancellation contracts stay unchanged when code moves between modules.

## Host isolation decision

The beta implementation uses one database utility process per workspace window. That process owns workspace SQLite storage and the workspace's database adapters. User SQLite connections additionally run in individual child processes, and SQL language work runs in a browser worker.

This differs from the original roadmap's usual host-per-profile design and separate storage process. The current boundary gives each workspace one owner for persisted state and session coordination, with a bounded number of open sessions. A database-host crash ends every live connection in that workspace, including connections to other profiles. Recovery restores saved buffers while leaving connections disconnected and never replays SQL. Other workspace windows have separate hosts.

Retain this topology for the beta candidate. Separating storage or grouping hosts by profile requires a new architecture decision covering physical-session ownership, credentials, operation reservations, backpressure, shutdown and fault recovery, followed by qualification of the changed runtime. [Host recovery evidence](../DRIVER_TESTING.md) and the current release checklist determine qualification; this topology decision does not close a release gate.

## Module changes

Keep pure dialect parsing, quoting and preview generation in `shared/sql`; frontend language tools and backend adapters use the same implementation. Prefer focused feature modules within `src` while the application has one consumer. Package extraction should provide a real ownership or reuse boundary.

Major architecture changes should add a dated decision here explaining the existing behavior, chosen ownership, alternatives and verification needed. Keep behavior-preserving refactors separate from changes to transaction semantics, replay policy or supported engines.


## Catalog navigation ownership — 2 November 2026

`CatalogBrowser` composes the incumbent explorer tree and one bounded lazy table-child page. `use-catalog-page` owns debounce, request identity, obsolete-response rejection and replaceable page state; `use-workspace-sessions.readCatalog` owns physical/shared connection availability and host-generation checks. The initial page reserves its owner before paint; an explicit Browse into a new shared tab settles that read and rechecks the target before using the existing guarded table-data operation. `DriverRegistry.catalogPage` validates the strict read-only request and acquires the existing session operation reservation. The existing adapters own permissions and metadata connections; `catalog/paging` supplies bound filters and deterministic keyset positions, while `catalog/common` validates targeted identities and bounds parent context. No catalog rows or cursors are persisted, and editor SQL/results are not inputs to discovery. The bounded language/feature snapshot remains a separate contract.


## Comparison and migration ownership — 3 November 2026

The registry reserves both participating physical connections before comparison. The schema comparison service uses bounded, scoped catalog reads and targeted incoming foreign-key checks. The migration store retains host-generated SQL and its dependency requirements through preview and reviewed export. Catalog filters, definition selection and synchronization review carry no mutation authority.

The data comparison service verifies base-table identities around bounded single-statement captures. For larger captures, a SQL byte total withholds oversized payloads and a row count detects an incomplete transport fetch. The renderer pages captured differences and assembles selected proposals with their expected target values. The main process saves reviewed JSON to a new file through the native dialog. Comparison values and selections stay out of workspace and history storage.
