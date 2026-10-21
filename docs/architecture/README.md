# Db Commander architecture

Db Commander keeps the desktop interface, native capabilities and database execution in separate runtime layers. Feature modules share typed contracts and pure SQL utilities. The beta scope and release gates remain in [the frozen plan](../PLAN.md).

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

`pnpm lint` enforces static import boundaries, Hook ordering and effect dependencies. `pnpm typecheck` checks the whole project and separately checks the renderer without global Node types. Builds include these checks. Architecture regression tests exercise forbidden imports and Hook violations. CI triggers remain restricted to `main`.

## Frontend ownership

`App` composes the workspace and coordinates commands that cross features. `ConnectionDialog` owns connection form state and credential-store status. `useWorkspaceRecovery` owns loading, the serialized save queue, autosave and save-status announcements. Persisted workspaces contain buffers and non-secret settings; live connections, results and transactions remain volatile.

`query-tabs` owns pure database-event transitions. Session and execution identities determine event ownership. `useJobFeed` combines the initial job list with subsequent events so an older list cannot replace a newer event. Effect Events read the current callback state without repeatedly replacing subscriptions. Cleanup closes the exact dialog element opened by that effect.

Keep state with its feature. Extract a controller or hook when a feature has its own asynchronous lifecycle, rather than adding independent flags and effects to the workspace root. Keep SQL buffer changes in Monaco's existing edit/undo path.

The explorer derives its catalog tree only when catalog/filter inputs change. Its memoized tree does not rebuild thousands of rows for SQL edits. Visible object collections consume current inspection actions and busy state through context; collapsed collections are created when expanded. Catalog actions still validate the current session before inspecting or changing anything.

## Backend ownership

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
