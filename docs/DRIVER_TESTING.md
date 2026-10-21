# SQL driver testing

Current beta status is tracked only in the [frozen scope and release checklist](PLAN.md#beta-release-checklist). Sections below retain dated evidence and prepared test descriptions; older pending/deferred labels are historical and are superseded where a later regression report records completion. In particular, the 16 October Workspace/editor pass closes the earlier deferred editor/tab/column/settings workflows within its stated local scope.

Every supported SQL driver must be tested against a real engine using Docker. Mock drivers alone do not verify transaction, wire-protocol, authentication, or cancellation behavior.

## Paginated table browsing

`tests/integration/browsing-contract.ts` runs the same workflow on all eight profiles through the production registry and adapters. It reads 305 rows across pages, verifies composite-key tie breakers, native numeric and multi-column sorting, NULL predicates, literal wildcard/quote/Unicode filters, exact values, empty/final pages, invalid columns, session isolation and original-value conflicts beyond the old 200-row limit. It also exercises views, keyless tables, binary placeholders versus NULL and read-only SQLite/DuckDB files. SQL Server and Azure profiles use the native x64 Docker SQL Server fixture; these tests do not certify live Azure authentication.

`tests/desktop/browsing.spec.ts` uses real Electron connections to verify page navigation, page-size resets, filter/sort application and cancellation, tab isolation, staged-edit navigation guards, conflicts, rollback with retained filters, small windows, views and recovery from failed edit eligibility. The packaged smoke runner includes the DuckDB workflow on each OS.

For focused development checks, the Docker runner accepts explicit test-name filters. Omitting them runs the full suite, including in CI:

```sh
pnpm test:desktop --driver postgres,mysql,mariadb,sqlite,oracle,duckdb \
  --integration-filter 'pages, filters|edits rows' \
  --desktop-filter 'browsing|staged grid|layout|saved profiles'
pnpm test:desktop --driver sqlserver \
  --integration-filter 'pages, filters|edits rows|browses Azure' \
  --desktop-filter 'browsing|staged grid'
```

Filters are passed directly to test CLIs, preserving regex pipes on Windows. Embedded contracts still run inside Docker, with the selected filter applied there too. Desktop test cases for unselected engines remain explicitly skipped. Linux desktop runs still need the private keyring and Xvfb setup described below.

## Reusing Docker images

The test runner uses stable local `dbcommander-fixture-<engine>:<docker-architecture>` tags instead of a new image name per test project. It fingerprints Dockerfiles, build arguments/platform configuration and copied files in an image label. Unchanged images are reused without building or contacting a registry. Server images survive application/test-source changes; SQLite and DuckDB runner images rebuild when copied application/tests/dependency files change so they never test stale code. Mounted PostgreSQL/MySQL fixture SQL is read by each new container and does not require an image rebuild.

Containers, volumes, credentials and ports remain isolated per run and are cleaned up afterward. Keep the stable images and recent build cache locally; remove only superseded/dangling images and old unused cache during routine cleanup. `--refresh-images` is an explicit opt-in to rebuild selected fixtures with `--pull`, for example when updating mutable base-image tags. CI may still download images on a fresh hosted worker.

## Run the contracts

```sh
pnpm test:integration                  # All seven engine fixtures (SQL Server requires Docker x64)
pnpm test:integration --driver mysql  # Only the MySQL fixture and contracts
pnpm test:integration --driver mariadb
pnpm test:integration --driver postgres
pnpm test:integration --driver sqlserver # Requires Docker x86-64
pnpm test:integration --driver oracle   # Oracle Free, native ARM64 or x64
pnpm test:integration --driver sqlite   # SQLite contracts execute inside Docker
pnpm test:integration --driver duckdb   # Native DuckDB contracts inside Docker
pnpm test:desktop --driver duckdb       # Docker contracts, then native Electron
pnpm test:desktop --driver sqlite       # Docker contracts, then native Electron
pnpm test:desktop                      # All driver contracts, then Electron workflows
pnpm test:desktop --driver mariadb     # One driver and its Electron workflow
```

The runner `scripts/test-drivers.mjs` creates a unique Compose project, allocates distinct free loopback ports, builds the selected server engines with test certificates, waits for their health checks, initializes the SQL Server database with sqlcmd, reads CA certificates into an ignored temporary directory, and runs the contracts. A finally block removes that project's containers and volumes on success or failure. A forcibly killed runner may require manual cleanup with `docker compose -p <printed-project-name> down --volumes`. Development containers use a different project and are left alone. Images remain cached for the next run.

| Driver | Client dependency | Docker engine family | Environment provided by runner |
| --- | --- | --- | --- |
| PostgreSQL | pg 8.23.1, pg-cursor 2.22.1 | postgres:17-alpine | SQLCOMMANDER_PG_PORT / SQLCOMMANDER_PG_CA |
| MySQL | mysql2 3.24.5 | mysql:8.4 | SQLCOMMANDER_MYSQL_PORT / SQLCOMMANDER_MYSQL_CA |
| MariaDB | mariadb 3.5.4 | mariadb:11.4 | SQLCOMMANDER_MARIADB_PORT / SQLCOMMANDER_MARIADB_CA |
| SQL Server / Azure SQL shared transport | tedious 20.3.7 | mcr.microsoft.com/mssql/server:2022-latest (linux/amd64) | SQLCOMMANDER_SQLSERVER_PORT / SQLCOMMANDER_SQLSERVER_CA |
| Oracle Database | oracledb 26.0.0 (Thin) | gvenzl/oracle-free:23.26.3-slim, wallet build stage :23.26.3-full | SQLCOMMANDER_ORACLE_PORT / SQLCOMMANDER_ORACLE_TCP_PORT / SQLCOMMANDER_ORACLE_CA / NODE_EXTRA_CA_CERTS |
| DuckDB | @duckdb/node-api 1.5.6-r.1 (native engine 1.5.6) | node:24.21.0-bookworm-slim | Real temporary files inside the container; no port or CA |
| SQLite | Node bundled node:sqlite | node:24.21.0-bookworm-slim (SQLite 3.53.4) | Real temporary files inside the container; no port or CA |

Client versions are pinned in the lockfile. Most Docker tags pin release families and receive patch updates. The Oracle fixture pins both image digests as well as 23.26.3 tags. `SQLCOMMANDER_TEST_DRIVERS` identifies the selected engines to the test suite. Direct integration runs without runner-provided configuration fail instead of silently replacing a database with a mock.

The fixture passwords and certificates are disposable local-test data. MySQL/MariaDB contracts use a database-scoped user, including cancellation/termination of its own sessions; the root account initializes the fixture only. The PostgreSQL fixture user is privileged for backend fault injection. SQL Server contracts use a database-scoped login; an sa connection initializes the fixture and injects the connection-kill fault only. SQL Server uses password `Local-Test-Only!2026` for that scoped login and `Local-SA-Only!2026` for the disposable sa account. Do not use these accounts or privileges for real data. Ports bind only to loopback.

## Shared behavior

Contracts cover verified TLS, rejection of unknown CAs, retained sessions and temporary tables, exact numeric/date values, NULL versus empty strings, duplicate column names, ordered scripts, multiple results, transactions and disconnect protection, bounded previews, cancellation (separate connections for PostgreSQL/MySQL/MariaDB, native ATTENTION for SQL Server), metadata isolation, fetched-row CSV exports without SQL replay, and connection loss with an unknown outcome.

PostgreSQL adds dollar-quoted bodies, notices, failed transactions, COPY rejection, and a ten-million-row source with a capped cursor. Its existing desktop test covers security preferences, connection/TLS, explorer, editor, CSV save dialog, transactions, cancellation, truncation, history, renderer-crash recovery, application restart, and exclusion of passwords from workspace storage.

## MySQL and MariaDB specifics

The same behavioral suite runs independently against **both** engines through the production driver registry and their distinct native client transports. It covers:

- CA and hostname checks (a trusted localhost certificate must fail for `127.0.0.1`), incorrect passwords, and explicit plaintext local mode.
- Unsigned 64-bit integers, fixed-point decimal, microsecond timestamps, JSON containing large numbers, hexadecimal binary bytes, Unicode including emoji, and ordinal duplicate aliases.
- DELIMITER routines and CALL results that cross stream backpressure boundaries.
- Statement errors inside transactions, stop-on-error scripts, savepoints, commit/rollback, and refused disconnect while busy or in a transaction.
- Implicit DDL commits and `SET autocommit=0`, including idle manual mode and actual active transaction state.
- ROW_COUNT() and SHOW WARNINGS after successful queries, without hidden SQL probes.
- 100,000 streamed rows capped at 275 retained rows, the 8 MiB retained-byte limit, and subsequent reuse.
- Stop during SLEEP, concurrent-run rejection, independent metadata reads, and no execution of the remaining script after cancellation.
- USE and current-database catalog discovery, SQL_MODE changes between executions, NO_BACKSLASH_ESCAPES and ANSI_QUOTES, and refusal of ambiguous mid-script mode changes.
- CSV escaping/precision/NULL handling, no re-execution of side effects, and stale-result rejection.
- Disabled LOCAL INFILE and physical connection termination without replay.

`tests/desktop/mysql.spec.ts` exercises both through the real Electron renderer, preload and utility host. It selects the engine, verifies the default port and TLS, loads catalog objects, generates backtick identifiers, runs queries, exports through a native save dialog, tracks implicit commits/manual mode, cancels work, displays truncated results, and persists the selected engine without the password. Screenshots are saved under `test-results/`.

COM_PING is used to recover authoritative state after errors because error packets have no transaction-status flags. It resets ROW_COUNT(); after successful queries the adapters use their own EOF/OK flags instead. Tests should remain in place when upgrading either client. SQL_MODE/USE context refreshes also affect diagnostics, as documented in the implementation notes.

## SQL Server and Azure SQL specifics

The SQL Server fixture uses a generated self-signed TLS certificate for `localhost`, SQL Server 2022 Developer, and a database containing relational, precision, temporal, Unicode, binary, JSON-text and large-result fixtures. The runner initializes it after the health check with `sqlcmd -b`; seed failures fail the run. `-C` is confined to fixture health/initialization, while the application tests require proper CA/hostname validation. `ACCEPT_EULA=Y` is set for this disposable Developer test image.

`tests/integration/sqlserver.test.ts` contains 42 contracts covering:

- Verified TLS, missing CA, hostname mismatch, invalid login and explicitly disabled local TLS.
- Azure-profile routing with SQL login against the same local TDS engine; driver rejection of disabled Azure TLS.
- Physical session ownership, local temporary tables and T-SQL variable scope.
- Exact bigint/decimal(38,18)/money, seven-digit temporal fractions, original datetimeoffset, early dates, SQL_VARIANT, Unicode, binary, JSON text, NULL and duplicate aliases.
- GO batches/repeat counts, procedures, ordered and empty result sets, NOCOUNT and PRINT, including backpressure.
- Nested transactions, savepoints, rollback/commit, transactional DDL, implicit transactions and batch-end rollback of uncommittable transactions.
- SQL and aggregate errors, stop before subsequent GO batches, and safe session reuse after acknowledged errors.
- 100,000-row and 8 MiB retained-data caps while draining responses.
- WAITFOR cancellation through ATTENTION, concurrent-run/disconnect rejection, and independent metadata discovery.
- USE/current-database metadata, fetched-row CSV without re-executing side effects, stale exports and forced connection loss.
- Safe database switching, transactional grid editing with optimistic conflicts, native backup/restore, and session transaction sampling outside metadata/RPC execution scope.

`tests/desktop/sqlserver.spec.ts` runs connected SQL Server and Azure-profile workflows through the real Electron bridge. `tests/desktop/connections.spec.ts` separately verifies default ports, mandatory Azure TLS, switching authentication, and secret isolation without requiring a database. Unit tests verify GO lexing, Azure authentication configuration, profile validation and the pinned exact-value parser contract.

**Hosted verification:** all 24 SQL Server integration contracts and all 18 selected desktop workflows pass on native Linux x64 in [Azure run 278](https://dev.azure.com/detegoprojects/SQL%20Commander/_build/results?buildId=278), including the connected SQL Server and Azure-profile workflows. The self-signed fixture CA explicitly permits certificate signing, as required by Electron's BoringSSL. A local TLS regression also confirms rejection of an untrusted certificate and a hostname mismatch. The local ARM Docker daemon cannot run SQL Server reliably under QEMU, so native x64 CI remains necessary. Microsoft documents x86-64 Linux support and does not support ARM emulation; the desktop client itself can still run on ARM.

The status probe runs after a submitted execution and affects `@@ROWCOUNT` / `@@ERROR`; inspect those diagnostics inside the same execution. T-SQL error behavior within a batch belongs to the server, while a failed batch stops later GO batches. Keep the TDS numeric/temporal compatibility tests when updating Tedious. Neither Docker nor these tests certify live Azure token acquisition, expiry/reconnection, firewall/private endpoints, redirects, managed identity or interactive Entra login. No live service credentials are available in this test fixture.

## SQLite specifics

SQLite is embedded, so `tests/docker/Dockerfile.sqlite` builds an isolated **test runner**, not a server facade. It installs the lockfile without downloading Electron, builds the same SQLite worker source, and runs `tests/integration/sqlite.test.ts` through the production driver registry on Node 24.21.0. SQLite 3.53.4 matches the current Electron runtime. Temporary files exist only in that disposable container. The `sqlite` Compose profile is opt-in and does not run during `pnpm db:up`.

The 18 contracts cover real file headers, exclusive creation/no overwrite, missing/invalid files, read-only enforcement, exact int64/text/blob/Unicode/NULL values, duplicate aliases, retained temp tables, native trigger/script parsing, RETURNING, transaction/savepoint/DDL rollback, deferred constraints and automatic rollback, attached catalogs, row/byte caps, competing writers and busy errors, cached CSV without replay, placeholder/extension rejection, persistent reconnects, isolated in-memory databases and stopping a CPU-bound native query with rollback/no replay.

`tests/desktop/sqlite.spec.ts` exercises the file picker and mode controls, exact results, catalog previews, CSV, transactions, read-only protection, Stop/reconnect and restart. It also crashes the renderer with an open write transaction and a CPU-bound query; a subsequent writer must succeed, proving the old worker's lock was released. `scripts/smoke-package.mjs` verifies the shipped child executable and worker paths by creating and querying a database in the packaged application.

Node's synchronous SQLite API does not expose an interrupt method. Stop therefore kills the isolated session; tests require an unknown in-flight outcome, explicit reconnect and no automatic SQL replay. An independent watchdog terminates orphaned children after host crashes even when the SQLite execution thread is blocked. This is a documented preview limitation, not session-preserving cancellation. Metadata refresh is rejected while a query is active. Ordinary standalone worker execution requires Node 24.10+; the Docker command and Electron app provide the required runtime even when the development shell uses Node 22.

## Oracle specifics

`tests/docker/Dockerfile.oracle` generates an auto-login server wallet with `orapki` in a full Oracle image build stage, then runs the slim 26ai Free 23.26.3 database with that wallet. Both images have pinned multiarchitecture digests for native Linux ARM64 and x64. No x64 emulation is required on Apple Silicon. Initial downloads are large; allow several GB of disk and at least 2 GB of available Docker RAM for Oracle. Startup can take several minutes, so the runner waits up to 360 seconds. Health requires both the database and the successful seed-script completion marker.

The server exposes TCPS 2484 and TCP 1521 on two independently allocated loopback ports. Its test certificate matches `localhost` only. The runner passes the exported public certificate through `NODE_EXTRA_CA_CERTS` to its test processes and Electron; it does not install a CA into the developer's OS. A fresh child without that trust must reject the server, and the trusted client must still reject `127.0.0.1`. This accommodates the Thin driver's launch-time trust model without weakening certificate validation.

The login is `dbcommander` / `local-test-only`, service `FREEPDB1`. Only the connection-kill fault uses `system` / `Local-Admin-Only2026`; ordinary queries use the scoped application user. The init script exits on any SQL error. Containers and data are removed in the runner's finally block. Oracle's database terms apply to these test images; they are not redistributed with Db Commander.

`tests/integration/oracle.test.ts` contains 20 contracts covering:

- Real TCPS/TCP, missing trust, hostname mismatch and incorrect login.
- Retained physical sessions and session-local rows in a global temporary table.
- Exact NUMBER(38,18), large integers, nine-digit timestamps and original offsets, early dates, Unicode, RAW, CLOB and native JSON with large integers; NULL/empty-string semantics and duplicate aliases.
- Slash-delimited stored procedures, implicit cursors, empty result sets and DBMS_OUTPUT.
- Manual transactions, savepoints, rollback/commit, guarded disconnect and DDL commits (including commits before failing DDL).
- Statement errors, script preflight, no execution of a failed/cancelled script's tail, and continued use of the retained session.
- Independent metadata queries, quoted tables and views, bounded rows/LOBs, closed cursors and cached CSV without replay.
- Native break cancellation, concurrent request rejection, async consumer failure/backpressure and server-killed sessions with unknown outcome.

Set `SQLCOMMANDER_TEST_EXECUTABLE` to the absolute path of a built application executable when running `node scripts/test-drivers.mjs --desktop --driver oracle` to exercise packaged Oracle instead of the development build. The normal runner needs no override.

The Electron workflow selects the Oracle engine and service, connects over TCPS through the utility process, explores tables, executes SQL/PLSQL, checks exact values, exports CSV, uses transaction controls, cancels work and checks truncation and secret-free profile storage. Screenshots go to `test-results/`.

Thin mode’s STRING conversion still passes timestamps through JavaScript Date. A version-checked hook on each selected connection’s read buffer preserves raw temporal precision; it does not patch global prototypes. Tests also verify that ordinary native connections are unaffected. Fixed offsets are retained; named-zone timestamps and LTZ display exact UTC instants. A named DBTIMEZONE for LTZ requires explicit TO_CHAR conversion. Native cancellation is tested during active SQL work; server calls that do not poll in-band breaks (including DBMS_SESSION.SLEEP in this fixture) may delay acknowledgement until they return. Queries stop fetching at the preview cap, so the total row count is unknown. SQL*Plus commands, client binds, inline WITH PL/SQL declarations, wallet/mTLS, SID/TNS aliases, privileged roles and live cloud identity are not certified. The fixture certifies this Oracle Free version; older server versions and additional operating systems need their own compatibility runs.

Oracle references: [Thin connections and TLS](https://node-oracledb.readthedocs.io/en/latest/user_guide/connection_handling.html), [connection state and cancellation](https://node-oracledb.readthedocs.io/en/latest/api_manual/connection.html), [fetch conversion and result sets](https://node-oracledb.readthedocs.io/en/latest/user_guide/sql_execution.html), [fixture initialization](https://github.com/gvenzl/oci-oracle-free), [Oracle TLS wallets](https://docs.oracle.com/en/database/oracle/oracle-database/26/dbseg/configuring-transport-layer-security-encryption.html).

## DuckDB specifics

`tests/docker/Dockerfile.duckdb` runs the production driver registry against the actual native DuckDB engine and temporary files inside Node 24.21.0. It installs the frozen lockfile and platform binary without downloading Electron. The `duckdb-tests` Compose profile is opt-in and does not start during `pnpm db:up`. There is no network server or substitute engine. Linux ARM64 is verified locally; the CI job uses native Linux x64.

`tests/integration/duckdb.test.ts` contains 21 contracts covering:

- Native version/file header, exclusive creation, missing/invalid paths and no overwrite.
- Native script parsing, macros, dollar quotes, nested comments, syntax preflight and statement limits.
- UBIGINT/HUGEINT, exact decimals, nanosecond/early dates, nested values, blobs, Unicode, NULL/empty strings and duplicate column names.
- Retained temporary tables/variables, ordered results, DML counts, RETURNING and transactional DDL.
- Native transaction-ID observations, binder errors versus aborted transactions, rollback recovery and shadow-resistant probes.
- Catalog/schema/table quoting, attached databases, `USE`, temporary objects and views.
- Row/byte preview caps, full draining of RETURNING, reusable sessions and fetched-row CSV without replay.
- Shared native file instances, hard-link aliases, transaction isolation, conflicting writers and access-mode conflicts.
- Real cross-process writer locks, explicit read-only behavior, independent memory databases and persistent reconnects.
- Local CSV/Parquet access with automatic extension downloads disabled.
- Unbound parameters, CPU-bound native interruption, skipped script tails, renderer backpressure, shutdown rollback and lock release.

Inspect database file headers only after closing all engine handles. Opening and closing an unrelated file descriptor to a live database in the same process can release POSIX advisory locks; test instrumentation must not change the locking behavior under test.

`tests/desktop/duckdb.spec.ts` exercises native file dialogs, connection modes, catalog previews, exact decimals, cached export, transaction controls, cancellation without reconnect, preview truncation, profile recovery and restart. It crashes the renderer during an open write transaction and a CPU-bound query, then verifies that reconnect releases the old file lock and recovers the committed data without replay. To run this workflow against the packaged application:

```sh
SQLCOMMANDER_TEST_EXECUTABLE=/absolute/path/to/DbCommander node scripts/test-drivers.mjs --desktop --driver duckdb
```

`scripts/smoke-package.mjs` checks both embedded engines in the packaged app. DuckDB's addon and companion shared library must be shipped together outside ASAR; electron-builder detects the native package automatically. The native package's upstream LICENSE is included. CI runs this smoke on macOS, Windows and Linux after a native build. Keep optional dependencies installed; building for an architecture other than the installed native addon is not configured.

The Neo API lacks a public transaction-state flag. After each execution, two fully consumed, system-qualified `current_transaction_id()` queries distinguish an open transaction (same ID) from autocommit (different IDs). An aborted-transaction error means rollback is required; other probe failures report unknown state. This uses no private native hooks. The probes become the connection's most recent queries and advance transaction IDs in autocommit mode; query diagnostics should be read inside the submitted script. Tests must be revalidated when upgrading DuckDB.

Read-only applies to the selected catalog, not all local filesystem access. `COPY`, attachment and explicit signed extensions remain available. The 8 MiB limit bounds retained preview text, not individual native chunks/values or total engine memory; SQL can change the initial 512 MB/four-thread engine settings. Streams are drained rather than capped by rewriting SQL. Parameter prompts, extension management UI, MotherDuck/remote credentials and additional engine-version certification remain future work.

DuckDB references: [Node Neo API and platform support](https://duckdb.org/docs/current/clients/node_neo/overview), [native client source](https://github.com/duckdb/duckdb-node-neo), [concurrency](https://duckdb.org/docs/current/connect/concurrency), [utility functions](https://duckdb.org/docs/current/sql/functions/utility), [embedding security](https://duckdb.org/docs/current/operations_manual/securing_duckdb/embedding_duckdb).

## Profiles and independent tab sessions

Every driver suite invokes `tests/integration/session-isolation.ts` through the production registry and its real Docker engine. It opens two sessions, starts a transaction in only one, executes concurrently using distinct client execution IDs, exports each session's cached results, then reruns/disconnects one without affecting the other's state or export. SQLite and DuckDB use separate in-memory connections for this common contract; their additional native-file contracts cover sharing and writer locks. SQL Server includes the contract but still requires native x64 validation.

`tests/desktop/tabs.spec.ts` runs against PostgreSQL and DuckDB. It verifies saved-profile creation/editing/deletion/reopening; separate temporary tables and transactions; background execution/cancellation; independent SQL, result selection and exports; close and global quit guards; immediate-quit save flushing; secret-free persistence; and recovery of all buffers without reconnecting or replaying after a renderer crash. PostgreSQL uses the runner's verified TLS fixture. DuckDB tests use an actual native file and also run in the packaged application via `scripts/smoke-package.mjs`.

```sh
pnpm test:desktop --driver postgres
pnpm test:desktop --driver duckdb
pnpm package
node scripts/smoke-package.mjs
```

The unit suite covers event ownership/stale execution IDs, close guards and session-scoped cache eviction. Storage tests cover the ordered workspace schema, credential rejection, limits and invalid references, a real v1 migration with a WAL-aware backup, preserved history, idempotence and refusal to alter invalid/newer files. Migration backups intentionally contain the previous SQL/history and are not encrypted.

## SQL autocomplete and formatting

`tests/integration/language-contract.ts` is invoked by every driver's real Docker suite. It creates a table with a quoted column name and a view, reads metadata through the new schema API, generates table/alias-column completions, and executes the inserted SQL. It compares actual result values before and after dialect-specific formatting, executes a formatted CTE, verifies transaction state is unchanged by metadata reads, refreshes after ADD COLUMN and DROP, and checks independent embedded-session metadata. SQL Server additionally runs the same contract through the Azure SQL profile and checks formatted GO repeat batches. Neither this nor other Docker checks certifies live Azure authentication.

`tests/unit/language.test.ts` covers incomplete lexical input, alias/CTE/subquery boundaries, dialect quoting, connection isolation, metadata/result limits, comments and literals, offline suggestions, all eight formatter selections, token preservation, idempotence, GO repeats and unsupported formatting failures.

`tests/desktop/language.spec.ts` is selected by the normal Docker runner for all eight profiles. It accepts a real Monaco suggestion, executes the completed query, formats and undoes a document, formats a selection without changing the preceding statement, checks that formatting does not execute SQL, and verifies failure leaves the buffer intact. Embedded cases also switch to an independent empty tab. The packaged smoke script runs this workflow for DuckDB alongside the saved-profile/tabs tests.

Use `pnpm test:desktop --driver <engine>` to run the driver contracts and selected Electron workflows together. Use `pnpm package` then `node scripts/smoke-package.mjs` for native packaging checks. Tests use generated fixtures and unique object names; no production metadata or credentials are required.

## CI and release coverage

Azure DevOps uses [`azure-pipelines.yml`](../azure-pipelines.yml) for independent native macOS/Linux/Windows desktop builds and a seven-driver Linux x64 Docker/Electron matrix. It publishes JUnit results, failure diagnostics and unsigned desktop build archives. See [Azure pipeline setup and coverage](AZURE_PIPELINES.md) for registration, Azure Repos branch-policy validation, hosted-agent requirements and report settings. The existing GitHub Actions workflow remains available for mirrors.

The native x64 Ubuntu CI matrix runs one job per server engine and separate SQLite and DuckDB container jobs, with unit/integration tests and selected Electron workflows under Xvfb. This lets existing drivers run independently when another fixture fails. Separate macOS, Windows, and Linux jobs build unsigned desktop packages and launch packaged SQLite/DuckDB smoke checks plus the saved-profile/multiple-tab and SQL language-tool DuckDB workflows. A local macOS run does not certify those other OS builds.

The current matrix covers PostgreSQL 17, MySQL 8.4, MariaDB 11.4 and SQL Server 2022 (validation pending) , SQLite 3.53.4, Oracle Free 23.26.3 and DuckDB 1.5.6, including each tag's installed patch level. Additional minimum/current server versions, native packaged application workflows on every platform, long-running memory measurements, and cloud-only authentication remain release work. Local containers cannot certify Azure-specific authentication or networking.

## Adding another engine

1. Add an engine transport and register its capabilities without exposing credentials or unrestricted options to the renderer.
2. Add a Docker fixture and deterministic data for keys, precision, Unicode, binary, NULLs, and engine-specific types. Bind ports only to loopback.
3. Extend the runner's selected-engine list, TLS fixtures, environment and test-file mapping.
4. Reuse behavioral contracts and add engine-specific transaction, cancellation, batch-separator, authentication and catalog cases. Do not silently skip unsupported behavior.
5. Add an Electron workflow and document tested versions and deliberate limitations.
6. Add controlled service tests for cloud-only features. Embedded SQLite/DuckDB need containerized contract runners plus native packaging tests.

Never expose service credentials to untrusted pull-request jobs.

References: [mysql2 TLS options](https://sidorares.github.io/node-mysql2/docs/documentation/ssl), [MariaDB connector options](https://mariadb.com/docs/connectors/mariadb-connector-nodejs/node-js-connection-options), [MySQL implicit commits](https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html).

SQL Server references: [Tedious connection options](https://tediousjs.github.io/tedious/api-connection.html), [Tedious requests](https://tediousjs.github.io/tedious/api-request.html), [Microsoft SQL Server container requirements](https://learn.microsoft.com/en-us/sql/linux/install-upgrade/quickstart-install-docker?view=sql-server-ver17), [Linux TLS configuration](https://learn.microsoft.com/en-us/sql/linux/sql-server-linux-encrypted-connections?view=sql-server-ver17).

SQLite references: [Node SQLite API](https://nodejs.org/download/release/v24.21.0/docs/api/sqlite.html), [SQLite data types](https://sqlite.org/datatype3.html), [SQLite transactions](https://sqlite.org/lang_transaction.html).

## Editable result grids

`tests/integration/grid-contract.ts` runs through the real registry in every Docker driver suite, including a second SQL Server run with the Azure SQL profile. It verifies quoted identifiers and bound hostile-looking values, composite keys, generated columns and defaults, NULL/empty text, mixed insert/update/delete, explicit Commit/Rollback, whole-batch rollback after constraint failures, stale updates/deletes from a second physical session, case-sensitive original comparisons, schema drift, expired/cross-session snapshots, forged UI originals, invalid row/column requests and read-only/keyless/view rejection. Exact int64/decimal writes and JSON precision are checked where supported. MySQL/MariaDB additionally cover NO_BACKSLASH_ESCAPES, MyISAM rejection and temporary tables shadowing permanent tables; SQLite covers storage-class/binary rejection and adjacent representable floating values. Oracle covers BC/AD distinction and nanosecond timestamps with named time zones, including exact bound round trips. Tests create unique objects/files in disposable fixtures.

`tests/desktop/grid.spec.ts` drives the actual editor and IPC for all eight profiles: it stages cells and new/deleted rows, blocks execution/close with drafts, switches tabs without losing drafts, applies and rolls back/commits, detects another tab's update, preserves conflicted drafts, discards/reloads, and executes a selected SELECT without executing the preceding DELETE. It captures a staged-grid screenshot. The normal Docker desktop runner includes these tests automatically. Packaged smoke checks include the DuckDB grid workflow on each OS alongside the existing tabs and language tools.

`tests/unit/grid.test.ts` checks edit payload boundaries, identifier/parameter separation, generated-column detection and draft loss/close guards. Use the existing `pnpm test:desktop --driver <engine>` and packaging commands; no production database or cloud credentials are needed. SQL Server and Azure-profile cases require a native x64 Docker host, and the local fixture does not certify live Azure authentication or service recovery features.

Concurrency references: [DuckDB concurrency](https://duckdb.org/docs/current/connect/concurrency), [SQL Server locking hints](https://learn.microsoft.com/en-us/sql/t-sql/queries/hints-transact-sql-table), [SQLite transaction behavior](https://sqlite.org/lang_transaction.html), [mysql2 prepared statements](https://sidorares.github.io/node-mysql2/docs/documentation/prepared-statements).

## Server browsing and database switching

Run `pnpm test:desktop --driver postgres`, `--driver mysql`, `--driver mariadb`, or `--driver sqlserver` (native x64) to run the Docker integration contract and Electron workflows. `pnpm test:integration --driver <engine>` runs just the driver suite. Existing CI jobs include the new tests automatically. No production or cloud credentials are used.

`tests/integration/database-contract.ts` runs through the production registry with restricted fixture logins. It checks omitted/default database context, inaccessible databases, names containing quotes/spaces, unchanged context after discovery, schema refresh after switching, independent temporary tables in another tab, target failure recovery, serialized switching versus execution/disconnect, open transaction/manual commit guards, running-query rejection and cancellation. SQL Server and Azure profiles share the local TDS fixture; the latter exercises the master-plus-connection-probe path, not live Azure authorization or contained-user semantics.

`tests/desktop/databases.spec.ts` checks blank database input, sidebar selection/confirmation, clearing old results and schema, preserving SQL, refusing switches with drafts/transactions, independent tabs and unchanged saved server profiles. Existing engine workflows continue to exercise schema previews, language tools, editing and recovery. `tests/unit/databases.test.ts` covers validation, engine defaults, tab-capacity accounting after failed replacements, cleanup after a refused retirement, concurrent operations and renderer state guards. Use Refresh databases after grants, creates or drops made by another client.

## Panel layout desktop tests

Run `pnpm test:layout` in a graphical session (`xvfb-run -a pnpm test:layout` on Linux). It builds the app and runs `tests/desktop/layout.spec.ts` without Docker or external credentials. The data-preservation workflow uses the bundled native DuckDB engine. The existing Docker desktop runner also includes these tests, and `node scripts/smoke-package.mjs` runs them against packaged binaries in the macOS/Linux/Windows CI matrix.

The three workflows cover pointer drag/cancellation, accessible divider keyboard controls and bounds, visibility/maximization/reset from header/menu/palette, native shortcuts with editor and grid focus, immediate-quit saves, renderer recovery, smaller-window clamping without preference loss, and Monaco/virtualized-grid resizing. A real DuckDB session verifies that hidden panels retain fetched results and staged edits across tab changes, keep transactions open, and let a running query continue until Stop is requested. Shortcut tests use Electron `sendInputEvent`: Playwright's Chromium keyboard API bypasses Electron's native accelerator and `before-input-event` path.

Unit tests cover layout validation/transitions, platform shortcut matching, viewport clamping, storage round trips, existing version 2 workspaces without layout, and malformed layout recovery without losing SQL or profiles. Layout persistence reuses workspace shutdown flushing; these tests do not imply that sessions, results or unapplied edits survive application shutdown.

## Native credential-store tests

`pnpm test:credentials` builds the app and runs `tests/desktop/credentials.spec.ts`. Two standalone workflows require an unlocked native OS credential store and a graphical desktop, but no database. They write synthetic sentinel passwords to a namespace derived from a temporary workspace path, verify entries through the same native library in Electron's main process, and delete their own entries during cleanup. They test opt-in, restart, rename, replacement, changed endpoints, removal/deletion, missing entries, unavailable/locked stores and failed writes/deletes. Ordinary workspace/WAL files and history are checked for sentinel absence. Fault injection patches the native binding from Playwright's privileged test debugger; no production mock switch exists.

`pnpm test:desktop --driver postgres` also runs the third credential workflow against the existing TLS Docker fixture. It verifies real saved-password authentication after restart, separate sessions when opening new tabs, retained live credentials after removing a saved password, and explicit reconnection after renderer recovery. Existing tab/database tests exercise the new main-process credential cache with session context changes. No production database or user password is used.

For Linux CI, install `dbus-x11 gnome-keyring libglib2.0-bin`, then use `bash scripts/with-test-keyring.sh xvfb-run -a pnpm test:credentials` (or the normal `test:desktop` command). The wrapper starts a private D-Bus session, isolates XDG data/runtime directories, creates a password-protected disposable keyring, and removes it afterward. It never opens the developer's login keyring. Missing Secret Service is a test setup failure for positive native tests; failure-path tests assert that production refuses fallback. The application deliberately requires Secret Service rather than the binding's default transient Linux keyring fallback.

The packaged runner includes both standalone workflows on macOS/Linux/Windows, exercising the shipped native binary. Use `pnpm package` followed by `node scripts/smoke-package.mjs`; on Linux wrap the smoke command with the same keyring/Xvfb setup. Windows and macOS CI accounts need access to their native stores. Credential entries are local to the OS user and workspace path, so workspace copying is not a password migration mechanism.

## Backup and restore

`tests/integration/backup-contract.ts` runs through the production registry and adapters. It creates an isolated source, relationships, views and representative exact values; backs up; restores to a separate target; verifies values/counts/constraints and independent views; and rejects existing destinations, active transactions and conflicting operations. It covers schema-only mode where offered, malformed files, cancellation before execution, SQLite cancellation during copying, restricted restore accounts and partial MySQL-family imports. The last two failure cases remain visible for manual inspection rather than being replayed or automatically dropped by production code. Test teardown owns and removes only its random fixture targets.

For PostgreSQL/MySQL/MariaDB, the real dump/restore executables run in the Docker fixture image via an injected test launcher. The production subprocess runner still streams data, writes the protected authentication files and processes actual tool errors. The launcher only mounts the test's private files and maps the host loopback port to the fixture's container loopback. Desktop tests instead select a test-only executable shim as the native tools directory, exercising ordinary production IPC and process launch. No production Docker integration or mock backup format is used. SQLite and DuckDB execute their native backup implementations in the existing Node 24 Docker runners. Oracle uses the actual Data Pump API and server DIRECTORY. SQL Server's `.bak` tests require native Linux x86-64, covered by the existing CI matrix.

```sh
pnpm test:integration --driver postgres
pnpm test:integration --driver mysql,mariadb
pnpm test:integration --driver oracle
pnpm test:integration --driver sqlite,duckdb
pnpm test:integration --driver sqlserver  # native x86-64 Docker host
pnpm test:desktop --driver postgres,mysql,mariadb,oracle,sqlite,duckdb
pnpm test:backup                         # standalone local desktop workflows
```

The runner also accepts a comma-separated driver selection, provisions unique Docker projects/ports, and cleans up its containers and volumes. POSIX desktop jobs can use the native-tool shims; Windows packaged tests exercise SQLite/DuckDB without external tools. The full suite uses native OS credential storage too, so Linux runs must use the private keyring/Xvfb wrapper described above.

`tests/desktop/backup.spec.ts` covers native file dialogs, review/confirmation, transaction guards, new-target round trips, refusal to overwrite, persistent diagnostics and unknown-outcome recovery. Network cases perform actual Docker server backups/restores through the UI. Packaged smoke tests include both embedded engines and interrupted-job recovery on macOS/Linux/Windows. Unit tests cover strict inputs, private/atomic artifact publication, symlink/race protection, subprocess streaming/cancellation, missing tools, bounded errors and job-journal recovery.

Azure SQL recovery copies cannot be tested by SQL Server in Docker. The explicit service contract `tests/integration/azure-backup.test.ts` is skipped unless `SQLCOMMANDER_AZURE_BACKUP_TEST=1`. Run it only against a disposable, seeded Azure SQL source and supply `SQLCOMMANDER_AZURE_HOST`, `SQLCOMMANDER_AZURE_DATABASE`, `SQLCOMMANDER_AZURE_USER`, and `SQLCOMMANDER_AZURE_PASSWORD` or `SQLCOMMANDER_AZURE_TOKEN` in the process environment. It creates **two billed databases**, validates copy/restore/catalog isolation and target protection, and attempts cleanup of only its generated names. Inspect Azure for remaining copies if the process is interrupted. Invoke with `pnpm exec vitest run tests/integration/azure-backup.test.ts`; this is deliberately outside ordinary CI and has not been validated with a live Azure account here.

## Data import and full-result export

The shared `transfer-contract.ts` runs against all seven adapters plus the Azure SQL profile on the SQL Server fixture. It imports 3,205 rows, rolls back and reimports/commits, then verifies CSV, TSV and JSON exports larger than 8 MiB without renderer row events. It checks exact text/Unicode/quoting/NULLs, omitted defaults, keyless targets, preview-cache preservation, independent sessions, changed source files, late parse/type/constraint failures, cancellation and no-overwrite publication. SQLite and DuckDB contracts execute inside Docker with real database files. SQL Server requires Linux x64; Azure uses the same fixture, not a billed live service.

```sh
pnpm build
node scripts/test-drivers.mjs --driver postgres,mysql,mariadb,sqlite,oracle,duckdb --desktop \
  --integration-filter 'imports data|imports and exports Azure' --desktop-filter 'data transfer'
# Native Linux x64:
node scripts/test-drivers.mjs --driver sqlserver --desktop \
  --integration-filter 'imports data|imports and exports Azure' --desktop-filter 'data transfer'
```

The desktop workflow uses real IPC and driver sessions, with only native file dialogs stubbed to temporary test paths. It previews/maps 1,205 rows, verifies rollback then commit, exports beyond the preview, preserves an existing file, exports only the editor selection and cancels a 50,000-row import. All tests use disposable targets; no production credentials or files are required. The packaged smoke runner includes the DuckDB transfer case on macOS, Linux and Windows. Unit tests separately exercise CSV chunk boundaries, malformed/oversized records, invalid UTF-8, query review and atomic file publication. The unfiltered CI jobs automatically include these tests after a merge to main.

## Rich schema exploration and object definitions

`catalog-contract.ts` exercises real catalog and definition reads across every adapter, including the Azure SQL profile against the TDS fixture. It creates quoted table names, defaults, primary/check/foreign keys, indexes, views, routines/macros, triggers and sequences where available. PostgreSQL/Oracle include materialized views; Oracle also checks package/type specifications; PostgreSQL checks overload signatures and restricted visibility; SQL Server checks encrypted-module behavior. Reads preserve transaction state, reject forged or removed identities, refresh after DDL, and isolate embedded temporary objects.

```sh
pnpm build
node scripts/test-drivers.mjs --driver postgres,mysql,mariadb,sqlite,oracle,duckdb --desktop \
  --integration-filter 'explores rich catalog' --desktop-filter 'catalog .*:'
# Native Linux x64:
node scripts/test-drivers.mjs --driver sqlserver --desktop \
  --integration-filter 'explores (rich|Azure) catalog' --desktop-filter 'catalog .*:'
```

`tests/desktop/catalog.spec.ts` uses real database sessions and main/preload IPC. It filters object kinds, inspects columns/indexes and native/generated SQL, copies via the actual native clipboard, saves using a stubbed native file selection, opens a separate query tab without executing DDL, preserves the original transaction/buffer, and refreshes altered columns. The packaged smoke runner includes its DuckDB workflow. The native clipboard receives the test definition during these desktop checks. Unit tests cover strict inputs, display limits, missing definitions and canonical identity checks.

Unfiltered main-branch CI includes both integration and desktop cases. The MySQL/MariaDB fixture starts with `--log-bin-trust-function-creators=1` for deterministic routine creation; this is a test-server setting, not an application change to user servers. Oracle's test login has materialized-view and type creation privileges. No additional dependencies or CI trigger changes are required.

## Schema creation and alteration

The shared `schema-change-contract.ts` exercises the production registry, retained plans and native adapters. It creates tables with quoted identifiers and literal defaults, proves review does not execute SQL, checks retained result exports, verifies transactional rollback versus implicit commits, adds/renames/drops columns, creates/drops indexes, renames/drops tables and creates namespaces where supported. It checks destructive/implicit acknowledgments, replay rejection, active-transaction/manual-mode guards, stale metadata, failed unique indexes and independent sessions. PostgreSQL additionally covers a restricted login and cancellation while another session holds a table lock.

```sh
pnpm build
node scripts/test-drivers.mjs --driver postgres,mysql,mariadb,sqlite,oracle,duckdb --desktop \
  --integration-filter 'reviews and applies schema' --desktop-filter 'schema changes .*:'
# Native Linux x64:
node scripts/test-drivers.mjs --driver sqlserver --desktop \
  --integration-filter 'reviews and applies.*schema' --desktop-filter 'schema changes .*:'
```

`tests/desktop/schema-changes.spec.ts` uses real Electron IPC and database sessions. It dismisses a review without executing, invalidates previews after edits, saves SQL through a stubbed native file selection, checks required acknowledgments, applies/rolls back/commits changes, preserves buffers/results/history semantics, inspects fresh column metadata and removes a table. PostgreSQL exercises native cancellation with a second query tab holding the lock. Screenshots capture the review. The packaged runner includes the DuckDB workflow on all three desktop platforms.

Unit tests cover strict inputs, quoting and native SQL generation, metadata/identifier limits, retained-plan immutability and one-use behavior, cancellation between statements and unknown outcomes after failed rollback or unexpected transaction termination. Existing main-only CI automatically discovers the integration/desktop cases. No dependencies, database credentials, fixture privileges or pipeline triggers are added by this milestone.

## SSH and protected profiles

Network test selections now start a disposable Alpine/OpenSSH bastion alongside the selected engines. Fresh host and encrypted client keys are generated per fixture container; the runner copies only required material to a temporary directory with restrictive permissions and removes it on completion. SSH is published only on a random loopback port. Test-only authentication penalties are disabled so deliberately bad fingerprints/passwords cannot temporarily ban subsequent test cases. This changes no user SSH-server settings.

```sh
pnpm build
node scripts/test-drivers.mjs --driver postgres,mysql,mariadb,oracle,sqlite,duckdb --desktop \
  --integration-filter 'protects production|reports SSH loss|authenticates SSH|through SSH with native' \
  --desktop-filter 'connections .*:|credentials postgres SSH'
# Native Linux x64:
node scripts/test-drivers.mjs --driver sqlserver --desktop \
  --integration-filter 'protects .*profiles|protects production' \
  --desktop-filter 'connections .*:'
```

The shared connection contract checks locked production sessions across all eight profiles, schema/grid/import/export/restore guards, explicit unlock, per-session isolation, transaction settlement after relocking and database-switch relocking. Network engines additionally use real SSH with database TLS, password and encrypted-key authentication, rejected pins/passwords/certificates, inaccessible destinations and native cancellation. PostgreSQL tests a separate disposable local SSH agent and kills/restarts only the owned bastion during an in-flight query to check unknown outcomes and no replay. Agent setup requires OpenSSH client tools on the test host (included in native Linux CI). An additional PostgreSQL contract runs native `pg_dump`/`pg_restore` through the tunnel with verified TLS and inspects the restored database. Its Docker client uses Linux host networking or Docker Desktop's host gateway to reach the host-owned loopback listener.

Desktop tests use real Electron/main/preload calls and native drivers to verify folders, favorites, environment labels, wrong SSH fingerprints, protected SQL, typed unlock, independent cloned tabs, lock/rollback, restart persistence, moved profiles and absence of SSH/password secrets from workspace files. The credential workflow additionally combines an encrypted SSH key with a saved database password, restart, tab cloning and renderer recovery. The packaged smoke runner includes the DuckDB profile workflow; setting `SQLCOMMANDER_TEST_EXECUTABLE` to a packaged executable also runs the network workflows against that package. Unit tests cover strict public/secret separation, backwards-compatible vault bindings, host-owned routing, redirected SQL Server rejection and timed unlock expiry. Unfiltered main-only CI discovers all cases.

## Query plans

```sh
pnpm build
node scripts/test-drivers.mjs --driver postgres,mysql,mariadb,oracle,sqlite,duckdb --desktop \
  --integration-filter 'captures engine-specific plans' --desktop-filter 'explain .*:'
# Native Linux x64 includes both SQL Server and Azure-profile contracts:
node scripts/test-drivers.mjs --driver sqlserver --desktop \
  --integration-filter 'captures .*plans' --desktop-filter 'explain .*:'
```

The shared contract captures real native plans, rejects scripts and unconfirmed Analyze, verifies estimated DML does not modify rows, preserves transactions and cached CSV exports, recovers from native errors, enforces protected profiles and repeats network planning through managed SSH. PostgreSQL additionally verifies actual DML within an explicit transaction, rollback, session-local temporary objects, failed transaction reporting, cancellation of `pg_sleep` and rejection of concurrent work. SQL Server/Azure verify XML and a subsequent real query to catch leaked SHOWPLAN state; Oracle exercises plan-table cleanup without changing an existing transaction.

Desktop tests use real Electron IPC and database drivers. They select SQL after an unselected DELETE, obtain a plan without executing that DELETE, expand/select PostgreSQL operators, copy/save native output, preserve the editor and prior results, record history, handle errors and explicitly confirm/cancel PostgreSQL Analyze. Native file dialogs are stubbed only for deterministic save destinations. The packaged smoke runner includes DuckDB Explain. Unit tests exercise conservative dialect boundaries, injection-shaped scripts, JSON shape/depth limits, per-loop metrics and output budgets. Existing main-only CI discovers the new cases automatically; SQL Server has 36 integration contracts.


## Value inspection and navigation

```sh
pnpm build
node scripts/test-drivers.mjs --driver postgres,mysql,mariadb,oracle,sqlite,duckdb --desktop \
  --integration-filter 'inspects large values' --desktop-filter 'inspection .*:'
# Native Linux x64 covers both SQL Server and Azure-profile paths:
node scripts/test-drivers.mjs --driver sqlserver --desktop \
  --integration-filter 'inspects .*values' --desktop-filter 'inspection .*:'
```

The shared contract uses real large text/BLOB/XML values, quoted identifiers, composite foreign keys and injection-shaped literal keys. Every engine reads 300,000-character text and 160,000-byte binary fixtures through the bounded inspector. It checks output budgets, NULL values, source/cached-result preservation, live reads after concurrent updates, deleted rows, stale snapshots, reference fingerprints, NULL keys, browser-versus-edit authorization, protected sessions and embedded read-only connections. Desktop tests cover text/JSON/XML/hex, exact JSON numbers and duplicate keys, XML declaration rejection, duplicate column aliases, clipboard/file output, keyboard inspection, visibility/order/pinning/width controls, navigation/back, source-buffer preservation and applying hidden/reordered drafts followed by rollback. SQL Server fixtures use Unicode literals/columns explicitly. Only native file dialogs are stubbed to select deterministic destinations.

The packaged smoke runner includes DuckDB inspection. Set SQLCOMMANDER_TEST_EXECUTABLE to the packaged executable to exercise every network workflow against it. Unit tests cover strict ordinal-only requests, SQL conversion boundaries, precision-preserving JSON, bounded depth, hexadecimal offsets and Unicode truncation. Unfiltered main-only CI discovers all cases; SQL Server now has 38 integration contracts.

## Query library and bound parameters

The shared `parameters-contract.ts` runs on every adapter and both TDS profiles. It verifies injection-shaped Unicode text, repeated markers, exact signed 64-bit bounds and decimals, binary/NULL/boolean values, missing/excess bindings, multi-statement preflight, unchanged result SQL, cached CSV, rollback, independent sessions, native errors, protected/read-only profiles, SQL modes and prepared-query cancellation where supported. Existing cancellation tests cover the remaining native paths.

```sh
pnpm build
pnpm test
node scripts/test-drivers.mjs --driver postgres,mysql,mariadb,oracle,sqlite,duckdb --desktop --integration-filter 'binds query parameters' --desktop-filter 'library '
# Native Linux x64 Docker host:
node scripts/test-drivers.mjs --driver sqlserver --desktop --integration-filter 'binds query parameters' --desktop-filter 'library '
```

`library.spec.ts` exercises selected SQL, cancel/validation, bound values, history metadata/search/pagination/favorites, snippets, retention, global/profile recording controls, independent tabs and restart. It checks persistence without storing bound values. Native packaged smoke coverage includes this workflow on DuckDB. Unfiltered Linux x64 CI continues to run all driver contracts, including SQL Server/Azure profiles; live Azure tests remain separate. Development pushes do not trigger the main-only pipeline.


## ER diagrams

`tests/integration/diagram-contract.ts` runs through the production registry for every adapter and the Azure SQL profile against the local SQL Server fixture. It verifies ordered composite keys, multiple keys to the same target, self-references, quoted identifiers, keyless tables, selected/outside-scope references, primary-key/nullability metadata, protected profiles, native transactions, cached result preservation, exclusive session ownership, wide-column bounds, stale/dropped objects and refresh after DDL. PostgreSQL adds restricted metadata visibility; embedded engines add temporary/session isolation and same-name tables in separate namespaces, and SQLite adds implicit parent-primary-key mapping.

`tests/desktop/diagram.spec.ts` exercises actual connections and the Electron bridge: table selection, adding targets, relationship details, search, keyboard/pointer movement, zoom/fit, column controls, refresh preserving layout, native SVG save/cancel, safe XML serialization, narrow windows, unchanged editor/results/history/transactions and changed metadata. DuckDB additionally exercises a genuine busy-session failure followed by cancellation and successful retry from the retained table picker. Packaged smoke tests include the DuckDB diagram on each desktop OS.

```sh
pnpm test:desktop --driver postgres,mysql,mariadb,oracle,sqlite,duckdb \
  --integration-filter 'reads ER diagrams' --desktop-filter 'ER diagram '
# Native Linux x64 (SQL Server and Azure-profile routing, not live Azure):
pnpm test:desktop --driver sqlserver \
  --integration-filter 'reads ER diagrams' --desktop-filter 'ER diagram '
```

Omit the filters for the full regression suite. Keep reusable fixture images between runs. The runner removes its own containers and volumes; `docker image prune --force` removes dangling superseded images. Prune old unused build cache with `docker builder prune --all --force --filter until=168h` while retaining recent useful cache. To reclaim all unused build cache, omit the age filter; unchanged fixture images still reuse, although later image rebuilds may take longer. Avoid `docker image prune --all` for routine cleanup because it removes the reusable fixtures and forces new downloads.

## Schema comparison and context menus

```sh
pnpm build
node scripts/test-drivers.mjs --driver postgres,mysql,mariadb,oracle,sqlite,duckdb --integration-filter 'compares same-engine' --desktop --desktop-filter 'schema comparison|catalog|schema changes|staged grid|browsing|backup|server discovery'
# Native Linux x64 includes SQL Server and Azure-profile cases:
node scripts/test-drivers.mjs --driver sqlserver --integration-filter 'compares' --desktop --desktop-filter 'schema comparison'
```

The shared comparison contract uses independent source/target namespaces or files, including a dedicated MySQL/MariaDB target database and Oracle target user created by disposable fixtures. It checks source/target-only and changed objects, quoted identifiers, read-only collection, both session locks, transaction guards, production-profile reads, retained CSV results, exclusion of destructive statements, target-qualified additions and execution/reinspection on each native engine. SQL Server and Azure profiles share the local TDS fixture, not a live Azure account.

Desktop cases verify context-menu keyboard navigation and dismissal, object details, database backup access, comparison selection/scope invalidation, destructive opt-in, native clipboard contents, saving SQL, window-edge positioning, opening the target connection without execution and preservation of source buffers/results. Existing catalog, browsing, editing, schema change, backup and layout tests use the context menus. The packaged smoke runner includes the DuckDB comparison workflow.


## Keyed data comparison

The shared `data-compare-contract.ts` runs through the production registry on each engine and the Azure profile against local SQL Server. It verifies reordered/composite keys, exact large integers, changed/missing/matching rows, quote-shaped identifiers, literal bound filters, row/value limits, NULL/duplicate keys, transaction and operation guards, protected/read-only sessions, retained CSV results and retained edit snapshots. Unit tests also cover column/type mismatch, UTF-8 byte limits, strict IPC boundaries and native paging SQL. Desktop tests cover context menus, transaction guards, incomplete-scope errors, key selection, changed-cell review, JSON saving, scope invalidation, filters/search, narrow windows and preserved source buffers/results.

```sh
pnpm build
node scripts/test-drivers.mjs --driver postgres,mysql,mariadb,oracle --integration-filter 'compares keyed bounded' --desktop --desktop-filter 'data comparison'
# Native Linux x64, using the SQL Server fixture for both profiles:
node scripts/test-drivers.mjs --driver sqlserver --integration-filter 'compares keyed bounded' --desktop --desktop-filter 'data comparison'
```

To reuse the existing embedded images after changing only application/tests, first ensure their package/lock/configuration files match the workspace. Mount current code into disposable containers instead of rebuilding or pulling images. Set `SQLCOMMANDER_DOCKER_ARCH` to Docker’s reported architecture (for example `aarch64` or `x86_64`):

```sh
SQLCOMMANDER_DOCKER_ARCH="$(docker info --format '{{.Architecture}}')"
docker run --rm --pull never \
  --mount "type=bind,source=$PWD/src,target=/workspace/src,readonly" \
  --mount "type=bind,source=$PWD/tests,target=/workspace/tests,readonly" \
  "dbcommander-fixture-sqlite:$SQLCOMMANDER_DOCKER_ARCH" \
  sh -c 'node scripts/build-sqlite-worker.mjs && pnpm exec vitest run tests/integration/sqlite.test.ts'
docker run --rm --pull never \
  --mount "type=bind,source=$PWD/src,target=/workspace/src,readonly" \
  --mount "type=bind,source=$PWD/tests,target=/workspace/tests,readonly" \
  "dbcommander-fixture-duckdb:$SQLCOMMANDER_DOCKER_ARCH" \
  pnpm exec vitest run tests/integration/duckdb.test.ts
```

Changed dependencies, configuration or runtime/Dockerfiles require rebuilding the affected fixture using the normal runner. The packaged smoke suite includes the DuckDB comparison workflow. Main-only CI remains unchanged and discovers all new tests automatically.


## Migration-file export

`migration-contract.ts` runs for all eight profiles and verifies native execution of exported create/alter/drop statements, exact UTF-8 file/checksum contents, quoted names and literal defaults, caller-owned versus wrapped transactions, protected-profile exports, destructive acknowledgment, disconnect invalidation, no execution during export and preserved result caches. The schema-comparison contract now executes an exported migration instead of an isolated suggestion. SQL Server and Azure profiles share the local SQL Server fixture; live Azure is separate.

```sh
pnpm test
pnpm package
node scripts/test-drivers.mjs --driver postgres,mysql,mariadb,oracle \
  --integration-filter 'exports reviewed|compares same-engine' \
  --desktop --desktop-filter 'schema changes|schema comparison'
# Native Linux x64:
node scripts/test-drivers.mjs --driver sqlserver \
  --integration-filter 'exports reviewed|compares' \
  --desktop --desktop-filter 'schema changes|schema comparison'
```

For SQLite/DuckDB, use the existing-image read-only source/test mounts documented under [keyed data comparison](#keyed-data-comparison); no fixture rebuild is required when cached dependencies/runtime/configuration match. Network fixtures continue to use their matching cached image IDs with pulls disabled. Preserve reusable images after tests.

Schema-change and schema-comparison desktop workflows now include the shared `migration-export.ts` checks: name validation, native transaction options, preview/acknowledgment invalidation, destructive gating, cancellation, refusal to replace files, suggested filenames, checksums, exact saved contents, unchanged history and narrow-window screenshots. Comparison workflows execute the saved file deliberately and reinspect the target. The packaged smoke runner already includes both DuckDB workflows. Unit tests cover snapshot tampering, strict IPC, commented metadata, expiration/retention/byte limits, partial selections and exclusive file creation. CI remains main-only.

## Visual query builder

`query-builder-contract.ts` runs for all eight profiles. It executes generated SELECTs for quoted table names, composite INNER/LEFT joins, self joins, views, aggregates/GROUP BY/HAVING, NULL/LIKE/OR predicates, DISTINCT, sorting and native row limits. It also verifies exact 64-bit integer binding, injection-looking text values, fresh metadata after a dropped column, exclusive session ownership, transaction guards, preserved result caches and protected-profile review without unlocking execution. SQL Server and Azure profiles share the local TDS fixture; live Azure is separate.

```sh
pnpm test
pnpm package
node scripts/test-drivers.mjs --driver postgres,mysql,mariadb,oracle \
  --integration-filter 'builds visual SELECT' \
  --desktop --desktop-filter 'visual query builder'
# Native Linux x64, including the Azure profile against the same fixture:
node scripts/test-drivers.mjs --driver sqlserver \
  --integration-filter 'builds .*visual SELECT' \
  --desktop --desktop-filter 'visual query builder'
```

Use the existing-image source/test mounts under [keyed data comparison](#keyed-data-comparison) for SQLite/DuckDB after confirming matching cached dependencies and configuration. These mounts exercise current source without downloading or rebuilding images; SQLite's worker builds inside the disposable container. Network fixtures reuse matching immutable image IDs with pulls disabled. Preserve the reusable images when cleaning up.

For packaged desktop execution, set `SQLCOMMANDER_TEST_EXECUTABLE` to the built app executable before running the commands above. Run embedded builder workflows with `SQLCOMMANDER_TEST_DRIVERS=sqlite,duckdb pnpm exec playwright test tests/desktop/query-builder.spec.ts`. The shared desktop case covers context menu/Commands entry, a blocked source transaction, design controls, fresh review, invalidation, copy/save, unchanged history, a new independently connected tab and explicit parameterized execution. Screenshots include the designer, SQL review and a narrow window. `node scripts/smoke-package.mjs` includes the DuckDB builder workflow. Unit tests cover every dialect, strict limits, stale/ambiguous metadata, invalid joins, aliases, aggregates, ordering and parameters. Main-only CI discovers the new integration/desktop tests automatically.

## Session and lock inspection

`activity-contract.ts` covers all eight profiles. Network cases hold a transaction and block another session on a real row update, inspect the native owner relationship and waiting lock, verify optional SQL text, then release the blocker and observe the relationship disappear. They verify ordinary-user permission limits, a locked production observer, inspection from the blocked session itself, duplicate-request bounds, unchanged source transactions, no execution events from inspection and retained CSV result caches. SQLite/DuckDB verify local application session scope and explicit unsupported lock catalogs, including inspection during an open transaction.

```sh
pnpm test
pnpm package
node scripts/test-drivers.mjs --driver postgres,mysql,mariadb,oracle \
  --integration-filter 'inspects sessions and real' \
  --desktop --desktop-filter 'session inspection'
# Native Linux x64, including the Azure profile against the SQL Server fixture:
node scripts/test-drivers.mjs --driver sqlserver \
  --integration-filter 'inspects .*sessions and' \
  --desktop --desktop-filter 'session inspection'
```

`tests/activity-fixture.ts` provisions an isolated monitoring account inside the runner's existing MySQL/MariaDB, Oracle or SQL Server container, grants only the monitoring access needed by the test and drops the account after closing connections. It requires the runner's disposable project label and loopback fixture configuration. Existing application accounts remain unchanged. These grants do not alter Dockerfiles or require image builds. PostgreSQL uses its existing privileged fixture account; all non-PostgreSQL network contracts also check the ordinary fixture account's restricted view. Tests settle the blocker first during teardown, avoiding dependence on cancellation of an indefinitely blocked Oracle row update. MariaDB wait-table disappearance is polled because its native diagnostic data can lag transaction settlement.

Reuse embedded images using the read-only source/test mounts documented under [keyed data comparison](#keyed-data-comparison), after verifying that dependency manifests and configuration match. The normal network runner reuses matching cached image IDs and disables pulls. No `--refresh-images` flag is needed. Preserve the cached fixture images after the tests.

Set `SQLCOMMANDER_TEST_EXECUTABLE` to the packaged executable for packaged UI checks. Run local embedded workflows with `SQLCOMMANDER_TEST_DRIVERS=sqlite,duckdb pnpm exec playwright test tests/desktop/activity.spec.ts`. The native network desktop case creates a real blocking pair, follows its waiter to session details/locks, toggles SQL visibility, checks clipboard/report contents, cancellation and overwrite refusal, searches the capture and verifies the original buffer/results/transaction/history. Embedded cases verify unsupported lock notices and the narrow-window layout. The packaged smoke runner includes the DuckDB workflow. Unit tests cover fixed bounded SQL for all dialects, partial permission failures, limits, privacy invariants and embedded-engine distinctions. CI stays main-only.


## Reviewed session controls

`activity-control-contract.ts` is registered for every engine profile. Network fixtures create a real blocked row update, check permission rejection before granting administration to a disposable account, refuse protected issuing/target profiles, cancel the blocked statement, refuse a review after its query completes and terminate a session with uncommitted work. The test verifies rollback from another connection, unchanged source transactions/results, refresh invalidation and single-use replay refusal. SQL Server/Azure cases verify remote cancellation is unsupported and exercise termination. Embedded contracts verify explicit refusal without changing local sessions.

```sh
pnpm test
pnpm package
node scripts/test-drivers.mjs --driver postgres,mysql,mariadb,oracle \
  --integration-filter 'reviews cancellation' \
  --desktop --desktop-filter 'session controls'
# Native Linux x64, including the Azure profile:
node scripts/test-drivers.mjs --driver sqlserver \
  --integration-filter 'reviews .*cancellation' \
  --desktop --desktop-filter 'session controls'
```

The optional administrative grants in `tests/activity-fixture.ts` exist only inside labeled disposable test containers. No image definitions change: the existing monitor account receives the engine-specific control privilege for these cases and is dropped afterward. Production code never grants privileges. Preserve cached images, use the existing read-only source/test mounts for embedded tests after dependency/configuration verification, and do not pass `--refresh-images`.

Set `SQLCOMMANDER_TEST_EXECUTABLE` to test the package. For embedded UI cases, run `SQLCOMMANDER_TEST_DRIVERS=sqlite,duckdb pnpm exec playwright test tests/desktop/activity-control.spec.ts`. Desktop tests exercise the real native blocked statements, separate review, acknowledgment and typed confirmation, Escape without execution, stale-query refusal, one-shot controls, rollback impact and preserved source buffers/results/transactions. Unit tests simulate identity reuse and dispatch ambiguity and cover strict requests, expiry, wrong-source tickets, immutable retention and final protection refusal. The packaged smoke runner includes the DuckDB capability-boundary workflow. Main-only CI discovers the new tests without changing triggers.

## Rollback-progress inspection

`tests/integration/rollback-contract.ts` is registered for every driver and both SQL Server/Azure profiles. It observes a real open transaction through a locked production source, checks counters and retained results/events, rolls back and opens another transaction on the same connection, proves refresh still follows the first capture, explicitly replaces the capture, and inspects the handoff after reviewed termination. Oracle tests first demonstrate missing transaction-view privileges, then grant them only to the disposable monitoring account. Embedded adapters return unsupported without probes. Fast rollback can finish before a refresh; the contract verifies row restoration separately and never treats diagnostic absence as proof of completion.

`tests/unit/rollback.test.ts` covers native percentage parsing, Oracle parallel versus serial evidence, permission errors/partial visibility, no SQL/control commands, malformed IDs, ambiguous transactions, immutable source/database-bound captures, expiry/replacement and missing identities. Long-running rollback is intentionally not forced by generating enormous test data. Native live intermediate percentages depend on workload and server version; deterministic counter/state transitions are covered by these unit contracts.

`tests/desktop/rollback.spec.ts` covers real packaged Electron inspection, manual refresh, transaction replacement, list-refresh retention, unsupported embedded engines, small windows, results visibility/keyboard focus, dismissal, and preservation of editor, history, results and source transaction. The reviewed-controls desktop suite also checks post-termination inspection. The packaged smoke suite includes the DuckDB workflow.

```sh
node scripts/test-drivers.mjs --driver postgres,mysql,mariadb,oracle --integration-filter 'rollback progress|reviews cancellation' --desktop --desktop-filter 'rollback inspection|session controls'
```

On native Linux x64, include `sqlserver` to exercise SQL Server and Azure-profile contracts. On this macOS ARM host there is no cached SQL Server image; do not pull one or claim native validation. Main-only CI remains unchanged.

Reuse network images with the normal runner (no `--refresh-images`). For changed embedded source, use the already cached image with read-only source/test mounts after confirming dependency and configuration hashes match, as described in the reviewed-controls section above. Never rebuild an embedded fixture just to copy source into it when the task requires reuse. No dependency, image or fixture configuration changes are required for this milestone.

Historical verification caveat (14 October 2026, before the repair below): the new rollback contracts pass on all six locally runnable engines, while the existing Oracle rich-catalog contract repeatedly encounters native catalog/GET_DDL timeouts on the cached fixture. An isolated full Oracle run passes 37 of 38 contracts; the earlier backup/data-comparison timeouts clear on that isolated run. The catalog failure was recorded as an open regression-test limitation, not a skipped success; the follow-up repair and passing verification are documented below. Native metadata deadlines remain unchanged. See the implementation verification section for the complete results.

## Oracle catalog timeout regression

The materialized-view inspector uses Oracle's stored query/settings to produce an explicitly labeled generated summary; other object kinds still use native definitions. The previous catalog timeout caveat above describes the historical native `GET_DDL` path. The repair does not prewarm metadata, modify the Oracle image or raise application/test deadlines.

Run the focused cold-fixture regression with the normal image-reusing runner:

```sh
node scripts/test-drivers.mjs --driver oracle --integration-filter 'explores rich catalog'
```

The contract creates a materialized view with an explicit quoted column alias, deferred build and complete on-demand refresh. It checks the generated summary and settings, executes that summary under a new name, then re-inspects and queries the copy. Existing coverage for tables, indexes, constraints, packages, types, views, functions, triggers, sequences, visibility and transaction preservation remains active. The Oracle case additionally checks that owner-specific reads exclude another login’s same-named table while preserving foreign-key references to it.

The Oracle case in `tests/desktop/catalog.spec.ts` creates and inspects a materialized view, checks the generated-summary label and omission notice, refreshes its definition and captures a screenshot. It also waits for automatic schema refresh after SQL/transaction operations before opening the inspector. Use `SQLCOMMANDER_TEST_EXECUTABLE` for packaged checks and run the full Oracle integration suite with related desktop regressions:

```sh
node scripts/test-drivers.mjs --driver oracle --desktop \
  --desktop-filter 'catalog oracle|schema comparison oracle|ER diagram oracle|rollback inspection oracle'
```

Unit coverage verifies quoting/binding, supported refresh/build modes, query-only fallback, metadata permission failures, incomplete columns and unchanged native definitions for other Oracle objects. All Docker runs must reuse the cached Oracle/SSH images without `--refresh-images`; the runner removes its temporary containers and volumes afterward.

Verified on 14 October 2026, macOS ARM64: the fresh-fixture catalog regression passes, all **38 Oracle integration tests** pass unfiltered, and all **four packaged desktop workflows** above pass. TypeScript, packaging and **264 unit tests** pass. The materialized-view screenshot was reviewed. All nine cached image IDs are unchanged; the runner left zero containers and zero build cache. No timeout limits, pipeline triggers or PR policies were changed.

## Current-statement execution and error navigation

`execution-contract.ts` runs through the production registry for each engine, including the Azure SQL profile against the SQL Server fixture. It checks that adjacent statements remain unexecuted, current requests reject multiple units before mutations, the same session retains its transaction, rollback undoes current writes, failed scripts stop at the right source range, and rewritten bound queries use the submitted-range fallback. Native cases cover PostgreSQL DO blocks, MySQL/MariaDB DELIMITER routines, Oracle PL/SQL, SQLite triggers/prepare-time PRAGMAs, DuckDB macros and T-SQL variable scope/GO repeats.

With a current build, run the focused network and desktop workflows using:

```sh
pnpm build
node scripts/test-drivers.mjs --driver postgres,mysql,mariadb,oracle --integration-filter 'executes current statements' --desktop --desktop-filter 'execution (postgres|mysql|mariadb|oracle)'
# Native Linux x64 worker:
node scripts/test-drivers.mjs --driver sqlserver --integration-filter 'executes current statements' --desktop --desktop-filter 'execution (sqlserver|azure-sql)'
```

The desktop suite is `tests/desktop/execution.spec.ts`. It verifies shortcuts and menus, selection versus script execution, parameter prompts, failed-unit selection, disabled links after edits, undo back to the executed SQL, and tab isolation. The packaged smoke runner includes its DuckDB case. Unit coverage includes UTF-16 offsets, CRLF/Unicode, repeated identical SQL, delimiter-prefix mapping, ambiguous syntax and stale execution events.

For local embedded tests, an existing image with matching runtime/dependencies can run the latest source without rebuilding it. Mount `src` and `tests` read-only into `/workspace`, use `--pull never --network none`, rebuild the SQLite worker inside the disposable container, and run the installed Vitest CLI. Do not relabel an old image with a new fixture fingerprint. The standard runner still builds an embedded fixture when its copied inputs change; use the mounted-source workflow when image reuse is required.

## Parameterized full-result export

`parameter-export-contract.ts` exercises all production adapters, including the Azure profile through the SQL Server fixture. It validates exact typed values in CSV/TSV/JSON, full streaming beyond the preview, duplicate columns/repeated names, preserved cached results, preflight refusal before jobs/files, session isolation, transaction/protection guards, server-error privacy, quoting modes and cancelled-file cleanup. The ordinary parameter contract also checks binary inserts after the standalone binary-type correction.

```sh
pnpm build
node scripts/test-drivers.mjs --driver postgres,mysql,mariadb,oracle --integration-filter 'exports bound parameters|binds query parameters' --desktop --desktop-filter 'parameter export (postgres|mysql|mariadb|oracle)'
# On a native Linux x64 host:
node scripts/test-drivers.mjs --driver sqlserver --integration-filter 'exports bound parameters|binds query parameters' --desktop --desktop-filter 'parameter export (sqlserver|azure-sql)'
```

Use the mounted-source cached-image workflow above for SQLite/DuckDB with the filter `exports bound parameters|imports data atomically`. The desktop suite is `tests/desktop/parameter-export.spec.ts`; select engines through `SQLCOMMANDER_TEST_DRIVERS`. The packaged smoke runner includes DuckDB, and `SQLCOMMANDER_TEST_EXECUTABLE` selects a packaged application for additional native cases. No fixture image refresh is required.


## Parameterized EXPLAIN and editor actions

`explain-contract.ts` extends each engine's existing plan contract with native parameters, exact integer/text/boolean/NULL/binary types, repeated and keyword names, preflight refusal, transaction preservation, estimate-only writes, private diagnostics and SQL modes. PostgreSQL additionally proves confirmed ANALYZE changes data within the active transaction, rollback restores it, and a parameterized long-running plan can be cancelled. SQL Server and Azure-profile cases are included in the SQL Server suite; a sequence-backed SELECT proves parameterized estimates do not execute the query. Unit tests cover temporary-procedure cleanup, SHOWPLAN setup failure, cancellation before invocation, zero-bind arrays and rejection of missing XML output.

```sh
pnpm build
node scripts/test-drivers.mjs --driver postgres,mysql,mariadb,oracle --integration-filter 'captures engine-specific plans' --desktop --desktop-filter 'explain |execution '
# Native Linux x64:
node scripts/test-drivers.mjs --driver sqlserver --integration-filter 'captures engine-specific plans|captures Azure estimated plans' --desktop --desktop-filter 'explain (sqlserver|azure-sql)|execution (sqlserver|azure-sql)'
```

For SQLite/DuckDB, use the mounted-source cached-image workflow above with `captures engine-specific plans`. Run desktop tests with `SQLCOMMANDER_TEST_DRIVERS=sqlite,duckdb` and the same desktop filter. `parameter-explain.spec.ts` verifies prompt cancellation, validation, fresh values, ANALYZE acknowledgment, unchanged results/buffers and no value persistence. `execution.spec.ts` right-clicks a selected range and validates date/time in the history sidebar. Its mouse click allows Monaco's documented-in-source 100 ms menu activation delay. Packaged smoke includes the DuckDB cases; additional packaged cases can use `SQLCOMMANDER_TEST_EXECUTABLE`.


## Snippet import and export

`tests/integration/snippet-contract.ts` exercises a portable-file round trip with a live connection and open transaction for each engine. It asserts no automatic SQL execution or session/cache changes, preserves engine/favorite/description and parameters, skips duplicates, regenerates local IDs, and executes the imported query only when explicitly requested. SQL Server includes a separate Azure-profile case.

```sh
pnpm build
node scripts/test-drivers.mjs --driver postgres,mysql,mariadb,oracle --integration-filter 'imports and exports snippets' --desktop --desktop-filter 'snippet files'
# Native Linux x64:
node scripts/test-drivers.mjs --driver sqlserver --integration-filter 'imports and exports snippets|round trips Azure snippets' --desktop --desktop-filter 'snippet files'
```

Use the mounted-source cached-image workflow above for SQLite and DuckDB, filtering `imports and exports snippets`. Their desktop workflows can run with `SQLCOMMANDER_TEST_DRIVERS=sqlite,duckdb` against `tests/desktop/snippet-files.spec.ts`; `SQLCOMMANDER_TEST_EXECUTABLE` selects a packaged app. The existing query-library desktop tests remain regression coverage. Unit tests in `snippet-files.test.ts` include malformed and oversized inputs, private metadata exclusion, deterministic duplicate choices, atomic rollback on limits/write errors, stale/expired/cancelled reviews, source snapshot immutability and no-overwrite file handling.


## Decimal, date and timestamp parameters

`typed-parameters-contract.ts` runs the production registry through decimal/date/timestamp queries, DML/rollback, cached results, full export and EXPLAIN. It checks precision beyond binary64, maximum precision/scale, repeated values, non-UTC session settings and Oracle NLS changes. Invalid values must fail before queries, plans or export jobs start. SQL Server includes a separate Azure-profile case.

```sh
pnpm build
node scripts/test-drivers.mjs --driver postgres,mysql,mariadb,oracle --integration-filter 'binds decimal date and timestamp|binds query parameters|exports bound parameters|captures engine-specific plans' --desktop --desktop-filter 'typed parameters'
# Native Linux x64:
node scripts/test-drivers.mjs --driver sqlserver --integration-filter 'binds decimal date and timestamp|binds query parameters' --desktop --desktop-filter 'typed parameters'
```

Use the mounted-source cached-image workflow above for SQLite/DuckDB with the same integration filter. Run `tests/desktop/typed-parameters.spec.ts` with `SQLCOMMANDER_TEST_DRIVERS=sqlite,duckdb` for embedded desktop checks. The desktop suite sets a non-UTC process timezone and checks validation, cancel/fresh prompts, exact results, export, plans and persisted-value privacy. `SQLCOMMANDER_TEST_EXECUTABLE` selects a packaged app; packaged smoke includes DuckDB. No image refresh is needed when the installed runtime/dependencies still match.


## Timezone-aware timestamp parameters

`timezone-parameters-contract.ts` verifies the production registry's instant binding, native timezone columns or documented UTC fallbacks, calendar rollovers, microsecond distinctions, DST overlaps, UTC range bounds, preflight rejection, DML/rollback, retained results, full export and EXPLAIN. Oracle runs with a non-Gregorian calendar; PostgreSQL/MySQL/MariaDB/Oracle use non-UTC sessions, and TDS uses a non-default date format. SQL Server includes an Azure-profile case.

```sh
node scripts/test-drivers.mjs --driver postgres,mysql,mariadb,oracle \
  --integration-filter 'timezone-aware timestamp|decimal date and timestamp' \
  --desktop --desktop-filter 'timezone parameters|typed parameters'
# On native Linux x64 with a cached SQL Server fixture:
node scripts/test-drivers.mjs --driver sqlserver \
  --integration-filter 'timezone-aware timestamp' --desktop --desktop-filter 'timezone parameters'
```

Reuse the mounted-source cached-image workflow above for SQLite/DuckDB, selecting `timezone-aware timestamp`. `tests/desktop/timezone-parameters.spec.ts` runs on every profile and sets a non-UTC process timezone; select `SQLCOMMANDER_TEST_DRIVERS=sqlite,duckdb` for embedded desktop checks. Packaged smoke includes DuckDB; `SQLCOMMANDER_TEST_EXECUTABLE` can select the packaged app for additional engines. Do not refresh or pull fixture images merely to change test/application source.


## Array query parameters

`array-parameters-contract.ts` exercises portable IN/NOT IN on every engine and native arrays/lists on PostgreSQL/DuckDB. It checks every scalar element type, empty/all-NULL arrays, duplicate/order retention, exact integers/decimals/temporal/binary values, the expanded bind budget, DML/rollback, preflight refusals, EXPLAIN and full export without replacing cached results. The SQL Server suite includes a separate Azure-profile case.

```sh
pnpm build
node scripts/test-drivers.mjs --driver postgres,mysql,mariadb,oracle \
  --integration-filter 'binds array parameters|binds query parameters|exports bound parameters|captures engine-specific plans' \
  --desktop --desktop-filter 'array parameters'
# On native Linux x64 with a cached SQL Server fixture:
node scripts/test-drivers.mjs --driver sqlserver \
  --integration-filter 'binds array parameters' --desktop --desktop-filter 'array parameters'
```

Reuse the mounted-source cached-image workflow above for SQLite/DuckDB, selecting `binds array parameters`. This mounts current source/tests into the installed runtime without rebuilding or downloading an image. `tests/desktop/array-parameters.spec.ts` covers validation, fresh prompts, cancellation, exact values, empty/NULL lists, export, plans and persistence privacy. Use `SQLCOMMANDER_TEST_DRIVERS=sqlite,duckdb` for embedded desktop checks and `SQLCOMMANDER_TEST_EXECUTABLE` for a packaged app. Packaged smoke includes DuckDB. Fixture cleanup removes only the run's containers/volumes; cached images remain available for reuse.

## Streaming JSON data import

`json-import-contract.ts` verifies exact scalar values, mapped/skipped columns, defaults, independent sessions, retained results and real full-export/import round trips. It also checks errors after the ten-row preview, changed files, replacement of the selected path during reading, cancellation, empty inputs and changed target definitions. Every failure must leave the original row count intact. The SQL Server suite includes a separate Azure-profile case.

```sh
pnpm build
node scripts/test-drivers.mjs --driver postgres,mysql,mariadb,oracle \
  --integration-filter 'imports JSON exports|imports data atomically' \
  --desktop --desktop-filter 'JSON import|data transfer'
# Native Linux x64, with an existing SQL Server fixture:
node scripts/test-drivers.mjs --driver sqlserver \
  --integration-filter 'imports JSON exports|imports data atomically|imports and exports Azure' \
  --desktop --desktop-filter 'JSON import|data transfer'
```

For SQLite/DuckDB, mount current source/tests into the cached runtime without downloading or rebuilding images. The commands below use this host's existing ARM64 tags; use the corresponding installed tag on x64.

```sh
docker run --rm --pull never --network none \
  --volume "$PWD/src:/workspace/src:ro" --volume "$PWD/tests:/workspace/tests:ro" \
  dbcommander-fixture-duckdb:aarch64 \
  pnpm exec vitest run tests/integration/duckdb.test.ts \
  --testNamePattern 'imports JSON exports|imports data atomically'
docker run --rm --pull never --network none \
  --volume "$PWD/src:/workspace/src:ro" --volume "$PWD/tests:/workspace/tests:ro" \
  dbcommander-fixture-sqlite:aarch64 sh -c \
  'node scripts/build-sqlite-worker.mjs && pnpm exec vitest run tests/integration/sqlite.test.ts --testNamePattern "imports JSON exports|imports data atomically"'
```

`tests/desktop/json-import.spec.ts` covers native chooser cancellation, invalid previews, mapping review, exact values, changed-file refusal, commit/rollback, full JSON round trips, late errors, cancellation and persistence privacy. Select `SQLCOMMANDER_TEST_DRIVERS=sqlite,duckdb` for embedded workflows; `SQLCOMMANDER_TEST_EXECUTABLE` selects a packaged app. Packaged smoke includes DuckDB. Run desktop suites sequentially to avoid native-window focus contention. Fixture cleanup removes only the run's containers/volumes and retains cached images. Unfiltered main CI picks up the new contracts; development does not queue a pipeline.

## Pending validation: SQL INSERT export and tab ordering

The following coverage is prepared but **not executed**, at the user's request to test at a later stage. Do not use earlier milestone pass counts as evidence for these changes. No Docker containers, images, desktop test apps or package builds were used for this implementation.

`insert-export-contract.ts` covers all profiles with exact numeric/text/binary/temporal rows, full export beyond preview limits, native replay and rollback, source-cache preservation, parameterized export, SQL modes, duplicate-name refusal, cancellation and no-overwrite publication. `insert-export.test.ts` covers the serializer and file/IPC boundaries. `tab-order.test.ts` covers move/drop semantics. Existing transfer desktop workflows now include SQL INSERT export and explicit replay; profiles/tabs workflows cover reordering during independent queries/transactions and restart persistence.

Run later, reusing existing fixture images:

```sh
pnpm test
pnpm build
node scripts/test-drivers.mjs --driver postgres,mysql,mariadb,oracle \
  --integration-filter 'exports SQL INSERT|imports data atomically|imports JSON exports' \
  --desktop --desktop-filter 'data transfer|saved profiles and independent query tabs'
# Native Linux x64, using a cached SQL Server fixture:
node scripts/test-drivers.mjs --driver sqlserver \
  --integration-filter 'exports SQL INSERT|exports Azure SQL INSERT|imports data atomically|imports JSON exports' \
  --desktop --desktop-filter 'data transfer'
```

For embedded Docker contracts, use the mounted-source, `--pull never --network none` SQLite/DuckDB commands above with the INSERT/transfer integration filter. For desktop tests, select `SQLCOMMANDER_TEST_DRIVERS=sqlite,duckdb` and run `tests/desktop/transfer.spec.ts` and `tests/desktop/tabs.spec.ts` sequentially in one Playwright invocation. Rebuild the package before packaged checks; its existing smoke selection includes both changed suites. Do not pull or rebuild cached Docker runtimes just to pick up source/test edits. Native Windows/Linux/macOS behavior, particularly drag gestures and literal replay across server settings, remains to be verified.

## Pending validation: Editor and formatting preferences

Coverage is prepared but **not run**. Earlier milestone pass counts do not validate these changes. Run the unit suite and build first, then the standalone settings workflows:

```sh
pnpm test
pnpm build
pnpm exec playwright test tests/desktop/editor-settings.spec.ts
```

The two settings scenarios run disconnected and against native in-memory DuckDB; they do not need a Docker server. They exercise native modal controls, cancel/reset/apply, input validation, formatting/undo, inactive and new models, typed indentation, restart persistence and independent sessions/results/transactions. The existing language desktop workflows cover custom formatting and manual completion for every selected engine.

For network drivers, reuse the existing fixture images and run the shared contract:

```sh
node scripts/test-drivers.mjs --driver postgres,mysql,mariadb,oracle \
  --integration-filter 'completes real schema objects' \
  --desktop --desktop-filter 'schema autocomplete'
# On native Linux x64, including the Azure-profile contract:
node scripts/test-drivers.mjs --driver sqlserver \
  --integration-filter 'completes real schema objects|completes and formats Azure SQL' \
  --desktop --desktop-filter 'schema autocomplete'
```

For SQLite/DuckDB Docker contracts, use the mounted-source, `--pull never --network none` commands in the JSON-import section with `--testNamePattern 'completes real schema objects'`; rebuild the SQLite worker inside that disposable container as shown there. Do not pull or rebuild cached runtime images to pick up source/test edits. For embedded desktop language tests, select `SQLCOMMANDER_TEST_DRIVERS=sqlite,duckdb` and run `tests/desktop/language.spec.ts`. Rebuild the package before running `node scripts/smoke-package.mjs`; its selection includes the settings workflows and DuckDB language regression. Windows/Linux/macOS native behavior and all runtime assertions remain pending.

## Pending validation: Direct column resizing

These changes are implemented but **runtime tests are not run**. Prior milestone results do not validate the new controls. Prepared coverage consists of `tests/unit/column-sizing.test.ts`, the native DuckDB `tests/desktop/column-sizing.spec.ts` workflow and additions to the all-engine inspection desktop suite.

Run later:

```sh
pnpm test
pnpm build
pnpm exec playwright test tests/desktop/column-sizing.spec.ts
```

The standalone sizing workflow uses in-memory DuckDB and needs no Docker server. It checks native drag completion/cancellation, keyboard access and limits, sampled fitting, hidden/pinned/duplicate columns, export invariants, tab isolation, staged values and rollback. Packaged smoke includes it after rebuilding the package.

For all-engine regressions, reuse cached images and the existing inspection contract/desktop workflows:

```sh
node scripts/test-drivers.mjs --driver postgres,mysql,mariadb,oracle \
  --integration-filter 'inspects large values' --desktop --desktop-filter 'inspection'
# Native Linux x64, including the Azure profile:
node scripts/test-drivers.mjs --driver sqlserver \
  --integration-filter 'inspects large values|inspects Azure values' --desktop --desktop-filter 'inspection'
```

For embedded Docker regressions, use the mounted-source `--pull never --network none` commands in the JSON-import section with the inspection test filter, including the SQLite worker rebuild inside that disposable container. For embedded inspection desktop workflows, select `SQLCOMMANDER_TEST_DRIVERS=sqlite,duckdb` and run `tests/desktop/inspection.spec.ts`. Do not pull or rebuild cached runtime images merely for source changes. Native Windows, Linux and macOS interaction/rendering checks remain pending; no pipeline was queued on development.


## Pending validation: Query tab pinning

Coverage is prepared but **not executed**. Earlier milestone pass counts do not validate pinning. No database drivers or SQL contracts changed, and no Docker images or containers were used. Run the unit suite and build before exercising the new standalone desktop workflow:

```sh
pnpm test
pnpm build
pnpm exec playwright test tests/desktop/tab-pinning.spec.ts
SQLCOMMANDER_TEST_DRIVERS=duckdb pnpm exec playwright test tests/desktop/tabs.spec.ts
```

The standalone workflow needs no database. It covers pin/unpin access, group ordering and drag boundaries, all-pinned/new-tab behavior, close protection, file associations and unsaved recovery. The DuckDB/PostgreSQL workflow adds pinning during independent transactions and a running query, then checks close safeguards, restart and renderer recovery. Run desktop suites sequentially to avoid native-window focus contention. On Windows, set `SQLCOMMANDER_TEST_DRIVERS` using the shell's environment syntax.

For the PostgreSQL Docker session regression and connected pinning workflow, reuse the cached fixture:

```sh
node scripts/test-drivers.mjs --driver postgres --desktop \
  --desktop-filter 'saved profiles and independent query tabs'
```

For DuckDB Docker session regressions, use the mounted-source `--pull never --network none` command in the JSON-import section with `pnpm exec vitest run tests/integration/duckdb.test.ts`. Do not pull or rebuild cached runtime images for source-only changes. Rebuild the app package before `node scripts/smoke-package.mjs`; its explicit selection now includes query tab pinning and the existing DuckDB tabs workflow. Native macOS, Linux and Windows interaction checks remain pending. Main-only pipeline triggers are unchanged.


## Pending validation: Persistent table column layouts

Prepared coverage is **not executed**. Older pass counts do not validate this milestone. Start with the unit suite and build, then run the new native SQLite/DuckDB desktop workflows:

```sh
pnpm test
pnpm build
pnpm exec playwright test tests/desktop/table-layouts.spec.ts
```

The standalone workflows use disposable local database files, need no Docker server and cover save/update/remove, metadata mismatch, separate tabs, staged-edit preservation, restart and memory exclusion. Unit tests exercise connection keys for all eight profiles, stored ordinals/widths, limits, recovery and credential/value exclusion.

The existing all-engine inspection desktop suite now saves a table layout with a hidden staged edit before applying and rolling back. Reuse cached images for its driver regressions:

```sh
node scripts/test-drivers.mjs --driver postgres,mysql,mariadb,oracle \
  --integration-filter 'inspects large values' --desktop --desktop-filter 'inspection'
# Native Linux x64, including the Azure SQL profile:
node scripts/test-drivers.mjs --driver sqlserver \
  --integration-filter 'inspects large values|inspects Azure values' --desktop --desktop-filter 'inspection'
```

For embedded Docker regressions, use the mounted-source `--pull never --network none` commands in the JSON-import section with the inspection filter and its SQLite-worker rebuild inside the disposable container. Select `SQLCOMMANDER_TEST_DRIVERS=sqlite,duckdb` for `tests/desktop/inspection.spec.ts`. Do not pull or rebuild cached images merely for source changes. Rebuild the package before `node scripts/smoke-package.mjs`; its explicit file/filter selection now includes both standalone table-layout workflows. Run desktop workflows sequentially. Native macOS/Linux/Windows interaction checks remain pending, and development still does not trigger CI.

## Pending validation: Per-engine SQL formatting

Prepared coverage is **not executed**. Earlier pass counts do not validate these settings. No Docker images or containers were used. Start with the unit suite and build, followed by the editor preferences desktop suite:

```sh
pnpm test
pnpm build
pnpm exec playwright test tests/desktop/editor-settings.spec.ts
```

The new standalone workflow uses a disconnected PostgreSQL tab and an in-memory DuckDB session. It covers per-engine document/selection formatting, native context menu and shortcut actions, preserved results/transaction state, invalid drafts in hidden scopes, inherited/custom defaults, cancel/reset, global typed indentation and restart. Unit tests cover strict validation, damaged preference recovery and independent SQL Server/Azure styles. Existing formatting token and parameter cases now resolve engine overrides.

The shared Docker language contract and all-engine language desktop suite also use overrides. Reuse cached fixtures:

```sh
node scripts/test-drivers.mjs --driver postgres,mysql,mariadb,oracle \
  --integration-filter 'completes real schema objects' \
  --desktop --desktop-filter 'schema autocomplete'
# Native Linux x64, including the Azure SQL profile:
node scripts/test-drivers.mjs --driver sqlserver \
  --integration-filter 'completes real schema objects|completes and formats Azure SQL' \
  --desktop --desktop-filter 'schema autocomplete'
```

For SQLite/DuckDB Docker contracts, reuse the mounted-source `--pull never --network none` commands in the JSON-import section with `--testNamePattern 'completes real schema objects'`, including the SQLite worker rebuild inside the disposable container. Do not pull or rebuild cached runtime images for these source changes. For embedded desktop language tests, select `SQLCOMMANDER_TEST_DRIVERS=sqlite,duckdb` and run `tests/desktop/language.spec.ts`. Rebuild the app package before `node scripts/smoke-package.mjs`; its existing file/filter selection includes the new editor-settings workflow. Run desktop suites sequentially. Native macOS, Linux and Windows checks and all runtime assertions remain pending; development still does not trigger CI.


## Pending validation: Editor settings import and export

Runtime validation is **not executed**. Prepared coverage lives in `tests/unit/editor-settings-files.test.ts` and `tests/desktop/editor-settings.spec.ts`; earlier milestone pass counts do not validate this feature. Run later:

```sh
pnpm test
pnpm build
pnpm exec playwright test tests/desktop/editor-settings.spec.ts
```

The file tests check versioned round trips for all eight formatting styles, invalid/extra data, size/encoding limits, private file permissions, existing destinations and cleanup. Desktop tests cover native file-dialog cancellation and ownership, applied-versus-draft export, invalid-file refusal, review/cancel/apply, restart and unaffected SQL/results/transactions. No driver SQL changed. Reuse the cached Docker language contracts listed in the per-engine formatting section for the wider deferred regression run; no new fixture or image download is needed. Packaged smoke already selects editor-settings workflows. Native macOS, Linux and Windows runtime checks remain pending.


## Pending validation: Split query editors

Runtime assertions have not yet run. Prepared coverage is in `tests/unit/editor-views.test.ts`, `tests/unit/storage.test.ts` and `tests/desktop/editor-views.spec.ts`. Run the full unit suite, build, then the split-editor desktop suite and existing SQL-file, tab, execution, layout and settings suites sequentially. The new connected workflow uses two independent in-memory DuckDB sessions and checks selected/current execution routing, retained results, close guards and rollback after hiding a view. The offline workflow checks drag ordering, models/undo, four-view limits, keyboard/pointer resizing and restart. Existing all-engine language/execution/session regressions should run against cached Docker fixtures in the extensive pass; SQL Server/Azure contracts require Linux x64. Rebuild the package before packaged smoke.

## Workspace/editor extensive regression pass — 2026-10-16

This pass validates the daily-use scope confirmed by the user: settings exchange, split views, separate workspace windows, appearance and editor shortcuts, plus the earlier deferred editor/tab/column/export milestones. The new `workspace-editor.spec.ts` covers window-local sessions, profiles, history, saving, close cancellation, reopening, renderer-crash recovery and restart, as well as live theme changes, custom bindings, duplicate-key rejection, undo, transaction preservation and old-binding removal. `editor-views.spec.ts` covers split layouts and session-correct selection/current-statement execution. The package smoke selection includes both files.

The local host is macOS ARM64 with Docker Linux ARM64. PostgreSQL, MySQL, MariaDB, Oracle and SSH used the existing fixture tags with no refresh, pull or build. SQLite/DuckDB used cached runtimes with current `src` and `tests` mounted read-only and `--pull never --network none`; SQLite rebuilt its worker only inside the disposable container. Cached runtime/driver versions and test configuration match; package/lockfile differences are release-tool scripts, semver and YAML tooling, which these driver contracts do not use. No image fingerprints were changed. Each runner removes its own containers and volumes while retaining cached images.

The full driver run found reentrant transfer cancellation: a progress listener could request cancellation again while processing its cancellation notification, resulting in recursive calls and a failed job. Cancellation is now idempotent. The INSERT export contract also explicitly reconnects the SQLite file session after a metadata-format error cancels the worker, matching the driver's documented cancellation behavior. Deferred desktop cases were corrected to await persisted state, select the intended statement's result, clear empty buffers explicitly and observe Monaco's 100 ms context-menu activation delay. Settings selects now expose stable accessible labels. Appearance tests use Chromium media emulation without changing the user's OS settings.

Validation results:

- Full unit suite: **464 passed across 49 files**. Type checking, application build and unsigned macOS ARM64 directory packaging passed.
- Docker SQLite: **44 passed**; Docker DuckDB: **47 passed**, using current source in cached containers.
- Docker PostgreSQL/MySQL/MariaDB/Oracle: the full run produced **171 passes and four INSERT-export cancellation failures**. After the idempotent-cancellation fix, all **16 selected transfer/export contracts passed**, including those four cases. This gives passing evidence for all **266 unique contracts** across the six engines, with the final transfer code covered by the focused rerun.
- Full server-enabled desktop run: **141 passed, 108 skipped, three failed**. The failures were stale assumptions about tab selection after reordering, the last Query tools menu item, and forced-exit persistence. Tests now select the intended tab/menu action and exercise normal application close. The focused rerun passed all **three affected workflows**, plus the PostgreSQL INSERT-export integration check. Unselected-engine cases were skipped intentionally.
- Packaged macOS ARM64 smoke: native SQLite/DuckDB loading, exact integers, persistent files and renderer isolation passed. The desktop selection produced **52 passes, seven intentional skips and one native-menu failure**. The package exposed menu dispatch's reliance on live OS focus. Native actions now prefer Electron's supplied window identity, and desktop coverage deliberately makes current focus point at another window to verify the owner still receives the command.
- Packaged SQLite desktop: **all 28 SQLite workflows passed**. The included native-menu recheck failed because the packaged app's OS focus remained unavailable under automation; the follow-up correction uses the real menu callback contract and tests window routing directly.

- Rebuilt macOS ARM64 package after the menu-routing fix: **all 11 layout, SQL-file and workspace-window/theme/shortcut tests passed**, including the failed menu workflow and the new wrong-focus ownership case. The final application build/type check and patch whitespace check passed. All observed failures have passing follow-up evidence; unchanged suites were not repeated after these focused corrections.

Across the server-enabled run, packaged run and focused reruns, **196 distinct desktop workflows have passing evidence**; duplicate reruns are counted once. The final results in this section supersede the earlier deferred-validation notes for the cases exercised here. Native Linux x64 SQL Server/Azure SQL, Windows/Linux desktop behavior, signed installers and notarization are not certified by this Mac run. No main merge or main CI run is part of this task. Cached Docker image IDs are unchanged and the test runners removed their temporary containers and volumes.

## Packaged startup and native-library fault isolation

`tests/desktop/startup.spec.ts` copies a native package into a path containing spaces, percent/hash characters and Unicode, then launches it through a symlink (a directory junction on Windows). It saves an unexecuted SQL buffer, closes the app and makes only the copy's DuckDB addon unloadable. Restart must recover that buffer without executing SQL, report a DuckDB connection error without losing the database host, and still connect to SQLite and execute a query. The test never modifies the source package or a user's workspace.

Run `pnpm package`, followed by `SQLCOMMANDER_STARTUP_ONLY=true node scripts/smoke-package.mjs` on macOS, or `$env:SQLCOMMANDER_STARTUP_ONLY='true'; node scripts/smoke-package.mjs` in Windows PowerShell. The ordinary smoke runner includes this regression too. Both modes first require the unmodified package's real SQLite and DuckDB startup/exact-value checks to pass; fault isolation does not make a missing production binary acceptable. Linux still requires the private-keyring/Xvfb wrapper.

When JUnit reporting is enabled, the fault regression writes `packaged-startup.xml` beside the configured desktop report so subsequent desktop suites do not overwrite its evidence.

`tests/unit/driver-startup.test.ts` injects a native-load exception and verifies registry initialization and repeated explicit connection failures beyond the session limit, catching both eager imports and leaked connection reservations. No Docker engine is required for these startup checks. Native Windows installer lifecycle tests continue to require a disposable Windows worker.

The same desktop file also tests a synchronous database-host fork failure and a real host whose readiness message is withheld until the normal 15-second deadline. It verifies that the timed-out host is killed and exits, then an explicit renderer reload recovers the saved SQL without reconnecting or adding history. An explicit SQLite connection/query proves the replacement host is usable. These two cases run against development Electron with `pnpm build && pnpm exec playwright test tests/desktop/startup.spec.ts --grep 'database host startup'`, and automatically against native packages in both smoke modes. Fault injection stays inside the test process; no production test flags or alternate timeout were added.

## SQL file registry write failures

`tests/unit/sql-files.test.ts` blocks registry replacement using a directory at the JSON registry path. Failed open, duplicate-open/recent ordering, restore, forget, clear-recent and reload operations must leave committed metadata intact. Save and Save As deliberately reach the partial-success case where SQL is on disk but the registry cannot be replaced: the previous association and saved-buffer baseline must remain authoritative, the buffer stays dirty, and retry still requires review of the destination. Tests repair the filesystem fault, retry and reload a fresh registry instance to verify persistence.

The Electron case **SQL files retain their association and dirty buffer when registry publication fails** performs the same Save As failure through the real main/preload API and native-dialog hooks, checks both disk files and the editor, then retries with explicit replacement review and restarts. A separate newer-format registry fixture must remain byte-for-byte intact across startup and blocked file operations, while saved SQL buffers recover and SQLite queries still work. Run `pnpm build && pnpm exec playwright test tests/desktop/sql-files.spec.ts` for the eight file workflows. The packaged smoke selection includes both new cases automatically. These checks require no Docker or production data; only dedicated temporary registries are obstructed or replaced with fixtures.

## Workspace save failures and edits during close

`tests/desktop/workspace-recovery.spec.ts` covers two recovery faults through real Electron main/preload/storage paths. The delayed-close case wraps a fresh database host's workspace-save messages and pauses renderer timers, preventing the normal 250 ms autosave from concealing a stale close acknowledgment. It makes successive edits during pending saves and requires each newer buffer to be saved before closure; restart must restore the latest SQL without connecting or adding history. The normal five-second native close deadline is unchanged.

The storage-failure case installs a SQLite trigger in its private workspace fixture that rejects workspace writes. The last committed buffer must remain on disk, the current editor text must remain in memory, the footer must report **Workspace not saved**, and choosing **Keep working** must cancel closure. After removing the trigger, **Retry workspace save** must persist the buffer without another edit and survive restart. The fixture exercises a real SQLite write failure, not actual disk exhaustion or power loss. A screenshot records the failure status and retry control.

Run `pnpm build && pnpm exec playwright test tests/desktop/workspace-recovery.spec.ts`. Both cases are included in the regular packaged smoke selection and require no Docker or external database credentials. Native Windows/Linux qualification still requires those platforms.

## Local soak and keyboard focus checks

Run `pnpm test:keyboard` for connection/confirmation focus loops, Escape cancellation, trigger restoration, menu navigation past disabled actions, command-to-dialog handoff and suppression of background tab shortcuts. The tests retain SQL/profiles and verify that navigation adds no history. Connection, close-tab, delete-profile, database-switch confirmations and backup dialogs use native modality so background controls are inert. Trigger restoration waits for controls disabled by a confirmation to become available again. Native file shortcuts also remain blocked while another dialog is open. These checks do not certify screen readers or complete accessibility compliance.

Run `pnpm test:soak` for two short DuckDB/Electron resource regressions. The first warms up four cycles, then repeatedly executes a 100,000-row query with a 1,000-row preview and opens/closes a scratch tab. It checks virtualization (fewer than 80 rendered rows), persistence and post-GC retained growth below 16 MiB of renderer JavaScript heap, 1,500 DOM nodes and 300 listeners. These are regression ceilings, not hardware-independent performance targets. Process working sets and per-cycle timings are recorded as observations, with no native-memory leak guarantee inferred from a short run.

The second streams exports of N and 2N rows, verifies row counts and boundary values with a streaming file reader, types into Monaco during export (two-second responsiveness guard), cancels an active export and verifies no partial file remains. The earlier exact-integer preview cache must export identically afterward. It records bytes, timings, renderer heap and process working sets. Defaults are 64 cycles and N=100,000; the default run is long enough to catch the editor-action retention regression. Increase them without changing production settings:

```sh
SQLCOMMANDER_SOAK_CYCLES=600 SQLCOMMANDER_SOAK_EXPORT_ROWS=1000000 pnpm test:soak
```

Cycles accept 12–1,000 and N accepts 10,000–10,000,000; the second export contains 2N rows, so allow disk space and time accordingly. JSON evidence is written to each Playwright test output directory as `soak-resources.json` and `soak-exports.json` and attached to reports. The ordinary packaged smoke includes both suites at their short defaults. Run GUI suites sequentially. Fixtures are private temporary workspaces/in-memory databases and exports; no Docker or external credentials are required. The [completed eight-hour macOS run](#completed-eight-hour-run--19-october-2026) is recorded below; these short regressions alone do not qualify endurance. Reference-hardware throughput, larger catalogs, system-volume/power-loss faults and other native platforms remain separate qualification work.

## Local screen-reader accessibility checks

Run `pnpm test:screen-reader` for five Electron workflows in private workspaces with in-memory SQLite. The suite enables Chromium accessibility through CDP, checks exposed names, descriptions, read-only/pressed/modal properties and live-region properties, and attaches compact `*-accessibility.json` snapshots. DOM assertions supplement the tree for virtual row/column indices, which CDP does not expose as AX properties. The suite also retains value-inspector and command-palette screenshots. The ordinary packaged smoke includes all five cases.

Coverage includes SQL NULL versus literal NULL text and empty strings, truncated values, duplicate aliases after hiding/reordering, column names without resize-width contamination, keyboard scrolling through a 1,000-row bounded preview, editable keys/generated columns/default values/deletion/staged values, and page-two browse ranges. A table represents its loaded page and displayed columns; ARIA positions follow that representation, while descriptions retain source column ordinals and absolute browse ranges. Header rows have index 1, and every rendered data row has its position within that loaded page. This follows the [ARIA table position guidance](https://www.w3.org/WAI/ARIA/apg/practices/grid-and-table-properties/).

Other checks cover named connection fields and Monaco's multiline editor, selected result/message controls, dirty/pinned/transaction tab descriptions, polite execution/transaction feedback, assertive application errors, and native modal exclusion of background controls. Escape from the value inspector restores its invoking cell; palette cancellation restores Commands, while existing keyboard tests cover command-to-dialog handoff. A real rejected workspace write verifies failure/recovery announcements. A mutation observer verifies that successful routine autosaves do not change the dedicated save live region.

These are automated Chromium semantics and keyboard checks on macOS ARM64. They do not exercise VoiceOver or NVDA speech output, the native platform accessibility bridge, or complete table navigation with a screen reader as virtual rows change. Those assistive-technology sessions, Windows/Linux runs, contrast and a full accessibility audit remain qualification work. No Docker or external credentials are needed for the local suite.

## Export publication and disk-full checks

Run `pnpm test:export-safety` for SQLite/DuckDB fetched-CSV destination protection and retry, plus a macOS-only real ENOSPC workflow. The ordinary packaged smoke includes all three cases; the disk-image case is explicitly skipped on other platforms. No Docker or external credentials are needed. Fetched CSV now requires a new filename, matching full-result export's no-overwrite policy; choosing an existing destination reports an error and preserves its bytes.

The macOS fixture creates and mounts a private **32 MiB HFS+ image**, fills only that volume until ENOSPC, then releases 128 KiB for directory/file metadata. A DuckDB fetched-preview export and a full-result transfer must both encounter actual ENOSPC, leave no destination or temporary export directories, and preserve the original preview, exact-integer data, SQL buffer and query history. After deleting the private filler, explicit retries must succeed with full row counts and boundary values; a subsequent SQL query proves the tab remains usable. The application workspace and host filesystem stay outside the full volume. The test closes Electron, unmounts its image and removes its fixture, retaining a failure-status screenshot and `export-disk-full.json` evidence.

`tests/unit/file-publication.test.ts` supplements this with deterministic ENOSPC write, EIO sync and EIO publication failures for both preview and streamed exports. Each failure must clean temporary work, preserve its input result and allow an explicit retry. Other cases cover existing files/symlinks, concurrent destination creation, unavailable results and cancellation during final sync. Publication is the commit point: cancellation observed before the atomic link starts prevents publication; cancellation arriving after a successful link leaves the completed file as a successful outcome.

This validates destination exhaustion and publication boundaries on the local HFS+ fixture and portable fault-injection paths. Exhaustion of the workspace/system volume, other native filesystems, native Windows/Linux behavior, physical device I/O faults and power-loss durability remain separate qualification work. Earlier workspace-save tests continue to simulate rejected SQLite writes rather than exhaust the system disk.

## Workspace disk-full recovery checks

Run `pnpm test:workspace-safety` for nine workflows: two existing save/close recovery cases, six real disk-full cases and one healthy-disk large-buffer workflow. The six disk-image cases require macOS and `hdiutil` and are explicitly skipped on other platforms. Ordinary packaged smoke includes all nine. No Docker or external credentials are required. Portable coverage is in `tests/unit/storage-full.test.ts` and `tests/unit/storage-startup.test.ts`: maintenance FULL versus permission/corruption errors, actual SQLite page-budget exhaustion, committed-buffer preservation and retry, and precise startup-error classification.

The native fixture mounts a private **32 MiB HFS+ image** and fills only that image until ENOSPC. Database-only cases put `workspace.sqlite` and SQLite's WAL/control files there through a symlink in a private profile on the healthy host. Whole-profile cases put the entire application profile on the image, including the database, SQL-file registry and Chromium runtime data; both Electron `userData` and `sessionData` paths must match that directory. Rescue SQL destinations and test reports remain on the healthy host. The fixture closes Electron, unmounts its own image and removes its files after each case.

- While the app is running, bounded edits of roughly 8.7 KiB exhaust any remaining allocated WAL space in both database-only and whole-profile cases. A third case uses native clipboard paste to replace a 256 KiB committed line with about 960 KiB of multiline SQL in a full profile. A failed autosave must preserve the last committed SQL, display **Workspace not saved**, cancel closure, export the latest buffer to a rescue SQL file, then save successfully on explicit retry after deleting the private filler. Restart must recover the latest buffer without SQL replay, and `PRAGMA quick_check` must return `ok`. Whole-profile rescue also checks that the SQL file was written despite registry ENOSPC, with unchanged registry bytes and no advanced file association.
- Startup with 200 expired history rows (about 1.6 MiB of SQL) and only 128 KiB released for SQLite control files must encounter FULL during pruning yet recover the committed editor and readable history. Freeing space must permit saving a profile while recovery metadata exists; a later history operation must finish cleanup and clear the deferred-maintenance notice.
- Database-only and whole-profile startup with exactly zero available bytes and no WAL/control files must give the **workspace disk is full** / **reload** guidance, show **Workspace not loaded**, keep the editor read-only and Run disabled, and preserve database bytes. After freeing space, reloading must recover the saved, editable buffer without reconnecting or replaying SQL. The whole-profile case retains about 960 KiB of saved SQL through this blocked startup.

The healthy-disk workflow pastes a **262,157-character single line** and **960,010-character multiline buffer** through the native clipboard command. It checks exact autosave contents, ordinary typing, undo/redo and restart recovery, with ten-second paste-and-save and five-second edit-and-save ceilings. These are local regression guards, not throughput promises. The prior stall came from using Playwright `keyboard.insertText` for a huge paste: Monaco treats that IME input as character-by-character typing and recomputes line wrapping after individual edits. A debugger pause captured `createLineBreaks` inside that typing loop. Real clipboard paste uses one bulk edit and passes on the existing application build. The fixture materializes previous clipboard items and MIME payloads inside Electron main and restores them after each paste, awaiting the asynchronous native clipboard API. Private clipboard data is never returned into test traces.

Screenshots and `workspace-disk-full.json`, `workspace-full-restart.json`, `workspace-zero-space-startup.json` and `large-buffer.json` retain volume sizes, available/reserved bytes, recovery outcomes and input timings in Playwright output. Run GUI suites sequentially. This validates the bounded SQLite-only and whole-profile HFS+ fixtures, plus the specified large-buffer interactions. The host/system disk is never filled. System-volume exhaustion, other native filesystems/platforms, physical-device faults, power-loss durability, prolonged endurance and larger aggregate workspaces remain separate qualification work.


## Workspace capacity and clipboard completion

Run `pnpm test:capacity` for three native Electron workflows at the existing limits of **20 tabs, 1,000,000 characters per query and 5,000,000 total SQL characters**. Fixtures use a private SQLite workspace with five maximum-size SQL buffers and 15 empty tabs; there are no database connections or executed queries. The main case switches all tabs, uses four editor views and F6 focus cycling, then checks exact SQL/tab digests and restored views after restart. It records `workspace-capacity.json` with counts, a digest and tab-switch timings, with a five-second switch ceiling as a local regression guard.

The other cases type one character beyond the per-query or aggregate limit. They require explicit limit/undo guidance and **Workspace not saved**, unchanged committed SQL, exact clipboard copying of the retained editor text, undo recovery, successful autosave and restart with all committed buffers intact. The renderer preflight does not truncate or reject editor input: unsupported text stays in memory until the user shortens/undoes it. It cannot be recovered from workspace storage after a discard or crash. File save/execution limits remain unchanged; oversized individual buffers can be copied before undoing. Portable boundary tests compare this preflight with authoritative workspace schema validation at and beyond both limits.

Run `pnpm test:clipboard` for two native Electron cases. A deferred clipboard write must keep the public Copy promise pending until real native publication completes. A rejected write must reach the caller, preserve prior clipboard bytes and allow an explicit retry. A separate nested fixture verifies restoration of text, HTML and an empty clipboard after successful and failed actions. The helper snapshots every reported clipboard item/MIME payload in Electron main, awaits the asynchronous API, and restores the snapshot without serializing user clipboard contents into traces. All five new cases are included in ordinary packaged smoke. Run GUI suites sequentially; neither suite needs Docker or external credentials.

These checks validate local macOS ARM64 capacity and clipboard behavior. Native Windows/Linux clipboard and editor behavior, wider performance/endurance measurements, system-volume exhaustion and power-loss durability remain separate gates. The fixture budgets are regression limits, not supported-hardware throughput guarantees.

## Database-host loss and staged-edit recovery

Run `pnpm test:host-recovery` for four native Electron workflows, also included in ordinary packaged smoke. Each engine has a running-transaction case and a staged-edit case. They require no Docker or external credentials and use only private SQLite/DuckDB files and the test application's database-host process.

The running cases save a baseline, open a write transaction, run a CPU-bound query and change the editor buffer while autosave is delayed. They send SIGKILL to the real database host, require safe disconnection with an unknown-outcome warning, and verify the unsaved SQL stays in the live editor. Reading the saved workspace starts a replacement host without reconnecting or replaying SQL. Explicit reconnect must release the native database's ownership, allow a new writer and return the original committed value. Query history excludes the interrupted and unsent SQL. A normal close/restart must restore the retained buffer with no connection or execution. JSON reports retain the killed host PID, history counts, committed value and renderer errors; SQL uses fixed test literals only.

The staged-edit cases reproduce the former deadlock: connection loss left local drafts visible, disabled Discard edits, and then rejected reconnect because staged edits remained. Connection availability and operations in progress are now separate grid inputs. Disconnected cells remain read-only; Apply, Insert, Reload and pagination stay blocked, while explicit local discard and close are available once active operations have settled. The draft remains visible for review until discarded. Tests discard it, close the stale snapshot, reconnect and verify the committed value and unchanged history before executing new SQL. Retained screenshots show the disconnected draft and recovery guidance.

Run GUI suites sequentially. These are abrupt database-host termination checks on macOS ARM64, including SQLite's independent blocked-worker watchdog. They do not simulate OS power loss or physical device faults and do not complete native Windows/Linux or prolonged-endurance qualification.


## Windows startup and NSIS dependency collection — 17 October 2026

The standalone release builder must retain pnpm dependency collection even when Git's Windows `pwd` returns a POSIX workspace path. Native Azure run 291 passed the ordinary packaged startup checks, but its separately built 0.0.0 NSIS baseline could not load DuckDB because `@duckdb/node-bindings-win32-x64/duckdb.node` was absent. The build log showed npm fallback; the same collector selection reproduced locally with Git's Unix tools on PATH. `releaseBuildEnvironment` now supplies the pinned pnpm context. A real builder-consumer regression covers fallback with an unreadable workspace path, and an `afterPack` audit blocks missing/empty native addons, DuckDB shared libraries and credential backends across all four release targets.

`tests/unit/release.test.mjs` also covers actual processor qualification independently of Node's process architecture. Windows ARM64 can report AMD64 to an emulated x64 process, so release scripts now verify the processor with CIM and fail closed on ARM64, mixed/unknown results or probe errors. The old acceptance and the corrected refusal both reproduced on the available Windows ARM64 VM. Do not disable this check to produce release manifests from emulation.

For native Windows validation, use `pnpm test`, `pnpm package`, then `$env:SQLCOMMANDER_STARTUP_ONLY='true'; node scripts/smoke-package.mjs`, followed by the native baseline/build/lifecycle commands in [RELEASING.md](RELEASING.md). Run GUI suites sequentially. The startup smoke cleanup now uses asynchronous recursive removal with bounded retries: Node 25 on Windows reproduced EPERM with synchronous removal of an otherwise removable fixture, while asynchronous removal succeeded. The native fault-copy cleanup also permits brief Windows handle-release delays.

The Windows lifecycle diagnostic then reproduced uninstall returning success while leaving `DbCommander.exe` behind. A deletion-denying file handle reproduced the same false success deterministically on the original installer. Normal uninstall now retries executable deletion for about ten seconds and returns code 3 before touching other application files or registration if deletion remains blocked. The running-app refusal still returns code 2, and upgrade replacement retains builder's atomic rename/restore path. `tests/installers/windows-uninstall-lock.ps1` is now part of the normal Windows lifecycle: it holds a persistent delete lock, requires code 3 and unchanged executable/resources/registration, then releases a short-lived lock and requires complete executable removal and registration cleanup. It runs only with the existing disposable-worker opt-in.

Local results: **530/530 macOS ARM64 unit tests**, **529 Windows unit passes plus one intentional platform skip**, three packaged startup workflows on macOS, and the same three Windows workflows using both Node 22.23.3 and 25.9.0 passed. Both macOS DMG/ZIP lifecycles passed. The unsigned 0.0.0 → 0.1.0 NSIS diagnostic passed install, running-app refusal, upgrade, persistent/transient lock checks, uninstall, reinstall, workspace/credential retention and native SQLite/DuckDB queries. This used Windows 11 ARM64 x64 emulation in an isolated disposable VM with a fresh standard account and the actual default APPDATA location. A short private checkout resolved an NSIS compiler include-path failure from the deeper temporary checkout. The diagnostic used cached Electron/tool binaries and shared lifecycle helpers directly, produced no release manifest, and explicitly marked its hash-bound report as emulated and ineligible for release qualification. Native Windows x64 validation still requires the corrected source's normal main CI run; signing, historical migrations and other platform gates remain open.


## Profile ownership and main-process crash recovery — 17 October 2026

`tests/desktop/profile-ownership.spec.ts` starts a raw second executable against an already open private profile. It must exit successfully, activate the existing workspace window and preserve SQL/history without creating another owner. The alias case starts the owner through a symlink (a junction on Windows) and verifies that its original `userData` and `sessionData` paths are preserved. The ordinary path case retains a secondary workspace window and checks focus routing. A separate workflow keeps two independent profiles open and verifies that one can close/reopen without affecting the other, including private permissions on newly created POSIX profile directories. A before-fix probe confirmed two live process IDs and the second writer's SQL appearing in the first writer's workspace.

Ownership uses [Electron's native instance-lock API](https://www.electronjs.org/docs/latest/api/app#apprequestsingleinstancelockadditionaldata). The resolved profile path determines a hashed coordination directory under OS application data; SQLite, Chromium runtime data and credential namespaces retain their configured profile paths. Keeping coordination outside the configured profile is necessary for the existing whole-profile zero-free-byte recovery case. Do not remove another running instance's coordination files to force a second writer.

Two `application crash` workflows in `tests/desktop/host-recovery.spec.ts` open real SQLite/DuckDB files, commit a baseline, hold an uncommitted update, start a CPU-bound query and save an unexecuted INSERT buffer. They kill only the actual Electron main PID, observe its database host/SQLite worker exiting before cleanup, then relaunch the same profile without manually clearing ownership files. They require saved SQL, unchanged prior history, no replay/reconnect, successful SQLite workspace integrity, released native write locks and the original committed value. Process inventories use numeric PID/parent-PID relationships; the Windows main PID comes from Electron rather than Playwright's command shell. Reports retain `profile-owner.json`, `sqlite-main-crash.json` and `duckdb-main-crash.json`.

Run `pnpm build`, then `pnpm exec playwright test tests/desktop/profile-ownership.spec.ts tests/desktop/host-recovery.spec.ts tests/desktop/workspace-editor.spec.ts tests/desktop/workspace-disk-full.spec.ts`. These 18 workflows run sequentially; six real volume-exhaustion cases require macOS and skip elsewhere. Rebuild with `pnpm package` before `node scripts/smoke-package.mjs`; its explicit selection includes all five new cases. No Docker images, external databases or production profiles are needed. Abrupt main-process termination does not certify OS power loss, physical-device faults or native Windows/Linux behavior.


Local evidence: 530 unit tests, 18 focused development workflows and 94 distinct packaged workflows passed on macOS ARM64, with seven intentional unselected-engine skips in the broader package run. A final rebuilt-package rerun passed all seven ownership/main-crash/zero-space cases after preserving new-profile permissions; fresh POSIX profiles expose no group/other permission bits. Both final DMG/ZIP lifecycles passed with workspace/OS-credential/native-database retention against the synthetic older-version fixture. JUnit and focused JSON reports are retained under `.test-artifacts/profile-hardening`; this is local qualification and does not certify native Windows/Linux, physical power loss or signed distribution.


## Backup job history and disk-full recovery

Run `pnpm build`, then `pnpm exec playwright test tests/desktop/backup-recovery.spec.ts tests/desktop/backup.spec.ts --grep 'backup recovery|backup sqlite|backup duckdb'`. The seven selected workflows need no Docker services or production profiles. Run GUI suites sequentially; on macOS, `caffeinate -dims` can keep the system awake. `pnpm test` also covers queued history status, warning retention/clearing, metadata-only retry, damaged/unsupported/oversized journal preservation, failed publication/retry, interrupted temporary files and POSIX permissions/symlink refusal. The symlink unit check skips Windows because ordinary Windows users may lack symlink privileges.

The delayed-write workflow intercepts only journal rename calls in a private Electron process. It holds the first save until the native SQLite backup completes, rejects that stale write, and requires the UI to remain completed while later saves are pending. Further failures produce an accessible warning that survives renderer reload. After releasing the fault, the dialog's history-save retry must retain the original artifact bytes, persist the same job ID/status and survive application restart without reconnecting or executing SQL.

Two preservation workflows seed damaged/unsupported history, complete a new native backup and require a warning plus byte-identical original history across restart. A separate whole-profile test uses the shared bounded macOS disk-image fixture to reach real ENOSPC. A completed backup written outside the full volume must pass SQLite `quick_check` and retain its committed row; its prior journal remains unchanged. Freeing space and retrying metadata persistence must recover both job records without making another backup. The report records the private volume's space measurements, artifact integrity and recovered statuses.

Rebuild with `pnpm package` before `node scripts/smoke-package.mjs`; all four new recovery cases are included by its explicit file/filter selection. The real-volume case skips outside macOS; injected journal failures and native SQLite/DuckDB round trips are portable. These checks cover application-level recovery on local macOS ARM64. They do not certify power loss, native Windows/Linux filesystems, remote backup tools or signed distribution.

Local evidence: **539 unit tests**, **seven focused source desktop workflows**, and **98 distinct packaged workflows** passed on macOS ARM64. The final package passed three startup cases plus 95 broader workflows; seven intentionally unselected engine cases skipped. Typecheck, build and native-payload packaging passed. JUnit, screenshots, the original stale-status reproduction and the zero-free-byte volume report are retained under `.test-artifacts/backup-hardening`. This is local unsigned-package validation; the remaining platform and release gates above still apply.


## Native backup tool stream failures and cancellation

Run `pnpm test:backup-tools` for the original seven subprocess lifecycle cases, the [four helper-process regressions](#native-backup-tool-helper-process-recovery), two Darwin reaping cases and two real-volume cases. The original unit cases use actual controlled Node child processes to test missing input/output paths, failed output with a SIGTERM-resistant child, cancellation of blocked stdin, native stderr when an early exit also breaks stdin, 4 MiB binary streaming under backpressure, and failed-dump cleanup followed by explicit publication retry. POSIX signal-resistance cases skip Windows, whose process termination semantics differ; Darwin reaping cases skip other systems. `pnpm test` includes all 13 unit cases.

The real ENOSPC case uses the shared bounded 32 MiB HFS+ disk-image fixture and skips outside macOS. It first opens an unpublished output file and waits for the owned child to register its signal handlers. Only then does it fill the private volume and enable streaming. The runner must return the original ENOSPC after its termination escalation, with the child already gone and no destination or scratch directory left. Freeing space permits an explicit retry to the same destination, producing exactly the expected binary bytes. Set `SQLCOMMANDER_TOOL_FAULT_REPORT=.test-artifacts/tool-hardening/disk-full.json` to retain space, stop-latency, exit, cleanup and retry measurements. The before-fix unit/volume reports demonstrate the original hang and error masking.

These are subprocess transport and publication checks with controlled CLI fixtures, not PostgreSQL/MySQL/MariaDB server round trips. Helpers escaping the owned process group, owner crashes, remote jobs, other native operating systems/filesystems and physical power loss need separate qualification. Existing backup/restore desktop regressions still cover native SQLite/DuckDB round trips and job-history recovery; run GUI suites sequentially.

Local evidence on macOS ARM64: **546 unit tests**, **seven source desktop backup workflows**, and **ten packaged startup/backup workflows** passed. All **eight lifecycle/real-volume checks** also passed with the packaged Electron 44.7.0 executable running its Node 24.21.0 runtime; the ordinary unit/volume runs used Node 25.9.0. The ENOSPC report records zero free bytes, owned-child exit before cleanup in about three seconds, no published failed artifact, no scratch directory and a successful explicit binary retry. Typecheck, build and native-payload packaging passed. Before/after JUnit, screenshots and the bounded-volume JSON are retained under `.test-artifacts/tool-hardening`. No Docker services or external database clients were needed; native Windows/Linux and real server-tool qualification remain open.


## Import finalization and rollback recovery

Run `pnpm test:import-safety` for 24 file-backed native SQLite/DuckDB cases across CSV and JSON. The suite uses real source files and native catalog/DML execution, wrapping final source checks/closure to inject late cancellation or cleanup failure. It also simulates a failed rollback after a real constraint failure and requires the unknown-outcome warning to survive a secondary cleanup error. Invalid mapping must remain a pre-transaction error even when cleanup fails.

After confirmed rollback, the connection must be idle. After unconfirmed rollback, SQLite retains the active transaction and DuckDB's aborted transaction makes its normal state probe unknown. Tests explicitly close/reopen those private databases, verify only the committed baseline remains, then preview and retry the import, commit explicitly, reopen again and require the imported Unicode row exactly once. Successful controls leave the import pending until explicit commit. These are application-level fault injections; they do not simulate physical device failure or certify remote engine rollback behavior.

For the native desktop adapters, run `pnpm build`, then `SQLCOMMANDER_TEST_DRIVERS=sqlite,duckdb pnpm exec playwright test tests/desktop/transfer.spec.ts tests/desktop/json-import.spec.ts --grep '(data transfer|JSON import) (sqlite|duckdb)'`. Rebuild with `pnpm package` and set `SQLCOMMANDER_TEST_EXECUTABLE` to repeat against the packaged app. Run GUI suites sequentially; no Docker services, external clients or production profiles are needed. Native Windows/Linux, remote engines and physical power loss remain separate qualification gates.

Local evidence on macOS ARM64: **546 unit tests**, **24 native import recovery cases**, **four source desktop workflows**, and **nine packaged workflows** passed. All 24 recovery cases also passed using the packaged Electron executable's Node runtime. The final package passed three startup checks plus six SQLite/DuckDB grid, CSV-transfer and JSON-import workflows. Typecheck, build and native-payload packaging passed. Before/after JUnit and desktop screenshots are retained under `.test-artifacts/import-hardening`; the original reproduction contains eight failures across both engines. The recovery cases use injected finalization faults with real native databases and private files, so physical-device faults and native Windows/Linux or remote-engine behavior remain unqualified.

## Generated file publication and disk-full recovery

Run `pnpm test:export-safety` for the existing fetched/full CSV protection checks plus three generated-file disk-full workflows. The latter call the real plan, displayed-value and session-report IPC handlers through the isolated renderer API and stub only the native destination chooser. Each fills a private 32 MiB HFS+ image, attempts output larger than its remaining space, requires ENOSPC with byte-identical prior output or no failed new report, and verifies temporary-file cleanup. Freeing space and explicitly retrying must save the complete UTF-8 text or validated JSON. Repeated report publication must refuse replacement. Saved SQL and empty query history remain unchanged. The profile and host volumes are never filled; the private image is removed after each test. Real-volume cases skip outside macOS.

`pnpm test` includes 14 generated-file fault cases and the existing migration tests. Wrappers inject write, sync, close and publication errors while retaining real file I/O. They verify that failed preparation cannot publish a file, prior content survives replacement failure, competing destinations are preserved, retry succeeds and POSIX output is private. Symlink checks skip Windows; read-only mode checks skip Windows and root. New destinations require filesystem hard-link support, as with existing streaming exports; unsupported publication reports failure instead of falling back to a partial copy. Existing-file replacement uses same-directory rename. Metadata revalidation detects changes during preparation but does not guarantee an atomic compare-and-swap against concurrent writers. Directory/power-loss durability is not claimed.

For positive UI regressions of all five entry points, run `SQLCOMMANDER_TEST_DRIVERS=duckdb pnpm exec playwright test tests/desktop/explain.spec.ts tests/desktop/inspection.spec.ts tests/desktop/diagram.spec.ts tests/desktop/activity.spec.ts tests/desktop/schema-changes.spec.ts --grep 'duckdb'` after `pnpm build`. Rebuild with `pnpm package`, then set `SQLCOMMANDER_TEST_EXECUTABLE` to repeat against the packaged executable. Ordinary packaged smoke also includes the three new disk-full cases. Run GUI suites sequentially, with `caffeinate -dims` on macOS if needed. No Docker services, external credentials or production profiles are required. Native Windows/Linux, other filesystems and physical-device/power-loss behavior remain separate qualification gates.

Local evidence on macOS ARM64: **560 unit tests across 61 files**, **11 source desktop workflows** and **14 packaged workflows** passed. The focused desktop selection comprises three generated-file ENOSPC cases, three existing export protection cases and five DuckDB feature workflows. The package also passed three startup fault/recovery cases and healthy native SQLite/DuckDB checks. All **27 generated-file/migration tests** passed under Electron 44.7.0's Node 24.21.0 runtime; ordinary unit tests used Node 25.9.0. Typecheck, build and native-payload packaging passed. Before/after JUnit and JSON reports are retained under `.test-artifacts/generated-hardening`. Package reports confirm exact 1,000,000-byte plan/value retries and an 869,536-byte validated report, with prior-file preservation or failed-new-file absence and no SQL replay. Installer lifecycles, Docker and live Azure were not rerun.

## Native backup tool helper process recovery

`pnpm test:backup-tools` selects 15 checks: seven original subprocess cases, four POSIX helper cases, two Darwin reaping cases and two macOS real-volume cases. The helper fixtures cover a live parent, an already exited parent, ignored stdio and an output failure. Every helper ignores SIGTERM. The runner must finish its group escalation, preserve the cancellation/ENOSPC cause and remove unpublished output; a separate bystander process must survive. An output failure also requires a successful explicit retry. All four failed before the process-group fix. They skip Windows, where direct-child termination remains unchanged. The reaping cases cover transient versus persistent group EPERM and skip outside macOS.

The second volume workflow lets the direct child exit before it fills the private 32 MiB HFS+ image. The helper retains stdout/stderr and produces backup bytes only after the test reaches zero available bytes. The real ENOSPC must terminate that helper, retain the filesystem error, leave no final file or scratch directory and allow exact binary retry after space is freed. Set `SQLCOMMANDER_TOOL_FAULT_REPORT=.test-artifacts/tool-group-hardening/disk-full.json` to retain the original report plus `disk-full-helpers.json`. Parent/helper PIDs are checked before fixture cleanup. No server clients, database servers, production profiles or host-volume exhaustion are involved.

To check the packaged Node runtime, run the same three Vitest files with `ELECTRON_RUN_AS_NODE=1` using the packaged executable to invoke `node_modules/vitest/vitest.mjs`. Positive native application regressions remain `pnpm build`, then `pnpm exec playwright test tests/desktop/backup.spec.ts tests/desktop/backup-recovery.spec.ts --grep 'backup sqlite|backup duckdb|backup recovery'`. Rebuild with `pnpm package` before repeating with `SQLCOMMANDER_TEST_EXECUTABLE`. Run GUI suites sequentially. Helpers starting their own session/group, cancellation of remote server jobs, abrupt owner death, native Windows/Linux and physical-device faults remain outside this local qualification.

Local evidence on macOS ARM64: **564 unit tests across 62 files**, **two real-volume checks**, **seven source desktop workflows** and **ten packaged startup/backup workflows** passed. All **13 lifecycle/volume checks** also passed under Electron 44.7.0's Node 24.21.0 runtime; ordinary runs used Node 25.9.0. The package passed healthy native SQLite/DuckDB checks, three startup faults and seven backup/recovery workflows. Typecheck, build and native-payload packaging passed. Reports under `.test-artifacts/tool-group-hardening` retain all four original failures and the passing results. The exited-parent volume case confirms zero available bytes, helper exit before cleanup after about three seconds, no published failed output or scratch directory, and an exact four-byte binary retry in both runtimes. Installer lifecycles, Docker and live Azure were not rerun.

## Window-list and snippet read recovery

`pnpm test` includes 11 cases in `tests/unit/file-read-recovery.test.ts`. Real files shrink, grow or change at wrapped metadata/read boundaries. Both the window list and snippet reader must reject detected changes without changing source bytes, and a stable explicit retry must succeed. Other cases verify exact 32 KiB window-list acceptance, preservation of invalid UTF-8 and nonblocking refusal of a FIFO. The FIFO test skips Windows; its baseline cleanup opens the private pipe briefly so the old blocking reader cannot strand a worker. Nine original cases failed before the fix. Existing window identities, snippet review/import and editor-settings file tests remain covered.

Run `pnpm build`, then `SQLCOMMANDER_TEST_DRIVERS=sqlite,duckdb pnpm exec playwright test tests/desktop/workspace-registry.spec.ts tests/desktop/workspace-editor.spec.ts tests/desktop/snippet-files.spec.ts --grep 'workspace registry recovery|workspace windows|workspace editor appearance|snippet files (sqlite|duckdb)'` for six local desktop workflows. The two new recovery cases seed private Primary/secondary stores, replace only `windows.json` with a FIFO or invalid UTF-8, and require Primary to open with retained SQL. The window manager must report preservation, disable creation and refuse other-window opens while the list is unreadable. The registry bytes/type and unopened secondary database must remain unchanged. Explicitly repairing the list and restarting must recover both saved buffers, without connections or SQL replay. Reports and screenshots retain the failure guidance and recovery outcome. Both new cases failed on the old app.

`pnpm test:workspace-safety` and ordinary packaged smoke now include the two new registry cases. Rebuild with `pnpm package`, then repeat with `SQLCOMMANDER_TEST_EXECUTABLE` set to its executable. The same four focused unit files can run through packaged Electron with `ELECTRON_RUN_AS_NODE=1`. Run GUI suites sequentially; no Docker services, credentials or production profiles are needed. POSIX FIFO behavior is locally qualified on macOS ARM64; native Windows/Linux, other filesystems and physical-device/power-loss faults remain separate gates. Metadata checks detect ordinary concurrent changes but do not provide filesystem snapshot isolation. A valid retained snippet review remains usable after subsequent source-file changes.

Local evidence on macOS ARM64: **575 unit tests across 63 files**, **six source desktop workflows** and **nine packaged workflows** passed. The package passed healthy native SQLite/DuckDB checks, three startup faults, the two registry recoveries, two workspace/editor cases and native SQLite/DuckDB snippet round trips. All **25 focused file/window tests** passed under Electron 44.7.0's Node 24.21.0 runtime and ordinary Node 25.9.0. Typecheck, build and native-payload packaging passed. Before/after JUnit and JSON reports under `.test-artifacts/read-hardening` retain the original nine unit failures and both desktop failures, including the first-window timeout. The inspected recovery screenshot shows the saved Primary SQL, disabled creation and preservation guidance. Installer lifecycles, Docker and live Azure were not rerun.

## SQL reload acceptance and native tool reaping

`pnpm test:files` now selects the eight existing SQL-file workflows plus three reload recovery cases. Run GUI suites sequentially. The new cases seed private files and recovery stores, then reject a reload using aggregate workspace capacity, a real SQLite write-refusal trigger or an obstructed association registry. Failed capacity/workspace saves must retain the previous registry bytes; Save after capacity rejection must still ask to review the external file and cancellation must preserve its bytes. Loaded text remains in the editor after a later persistence failure. Repairing storage and explicitly retrying must recover the accepted SQL after restart, without connections or history. The three cases failed on the old app; eight new unit cases also cover bounded previews, discard, expired/superseded tokens, persisted-buffer proof, changed associations and failed publication/retry.

The full unit regression also reproduced Darwin EPERM while an early-exiting native client was a zombie awaiting reaping. The runner now retries that condition briefly and preserves the useful native failure, while continuing to report persistent permission errors. The two reaping tests wrap only signalling failures around real subprocess I/O. An additional 200-run controlled early-exit probe reproduced the kernel state and passed with the fix. `pnpm test:backup-tools` includes these cases plus the existing helper and real-volume regressions. Windows termination semantics are unchanged; independently detached helpers, owner crashes and remote server-job cancellation remain separate work.

Rebuild with `pnpm package` before repeating the SQL-file workflows using `SQLCOMMANDER_TEST_EXECUTABLE`. Ordinary packaged smoke includes all three new reload cases. Run the two SQL-file unit suites and the three native-tool unit/integration suites through the packaged executable with `ELECTRON_RUN_AS_NODE=1` to check its Node runtime. No Docker services, external client tools, production profiles or credentials are needed. These are macOS ARM64 checks with controlled storage/process faults; native Windows/Linux, physical-device/power-loss faults and release certification remain open.

Final local evidence on macOS ARM64: **585 unit tests across 64 files**, **two real-volume tool checks**, **11 source desktop workflows** and **14 packaged workflows** passed. All **46 focused file/tool checks** passed under Electron 44.7.0's Node 24.21.0 runtime; ordinary runs used Node 25.9.0. The package passed healthy native SQLite/DuckDB checks, three startup fault cases and all 11 SQL-file/reload workflows. Typecheck, build and native-payload packaging passed. `.test-artifacts/reload-hardening` retains the three original reload failures, the full-suite native-error failure, the kernel-zombie probe, the passing 200-run probe, final JUnit, volume reports and reload recovery screenshots/JSON. The partial-association screenshot was inspected. Installer lifecycles, Docker and live Azure were not rerun.

## Backup and export finalization

`pnpm test` now includes 23 shared publication/export cases in `tests/unit/file-publication.test.ts`. Thirteen additional cases exercise mandatory writer/sync closure, combined primary and cleanup failures, completed destinations surviving cleanup failure, query/cancellation causes and failed warning delivery. The original build failed nine of these cases. Existing no-overwrite, cancellation-race, retry and partial-output checks remain covered.

After `pnpm build`, run `pnpm exec vitest run tests/integration/backup-finalization.test.ts` for seven real native checks. Six SQLite/DuckDB cases make only the fixture's owned scratch folder read-only, provoking actual cleanup EACCES after successful copying, a native query error or explicit cancellation. They verify the original outcome, private retained folders, byte-preserved completed destinations, repaired-folder retry, reopened snapshot data and SQLite integrity. The seventh wraps only a real SQLite worker's removal boundary to change folder permissions, then requires its cleanup warning through the production IPC callback and a usable completed snapshot. Permission cases skip Windows and root. The worker case uses the current built `out/main/sqlite-worker.cjs`, so rebuild first.

For desktop coverage, run `SQLCOMMANDER_TEST_DRIVERS=sqlite,duckdb pnpm exec playwright test tests/desktop/backup.spec.ts tests/desktop/backup-recovery.spec.ts tests/desktop/export-faults.spec.ts tests/desktop/transfer.spec.ts --grep 'backup (sqlite|duckdb)|backup recovery|export (safety|disk full)|data transfer (sqlite|duckdb)'`. This selects 12 workflows covering native round trips, interrupted restore, journal recovery, existing destinations, fetched/full-result exports and real private-volume exhaustion. Rebuild with `pnpm package`, then repeat with `SQLCOMMANDER_TEST_EXECUTABLE` set to the packaged executable. Run GUI suites sequentially. Repeat the three focused unit files plus the new integration file under packaged Electron with `ELECTRON_RUN_AS_NODE=1` for 52 checks of its Node runtime.

These are local application-level permission, close and storage-failure checks. Persistent removal failures may retain private scratch data; backup logs give its location, while export APIs retain their existing output contract. Native Windows/Linux, other filesystems, physical power loss and signed-release certification remain separate gates. Docker, external native clients and live Azure are not needed for this selection.

Local evidence on macOS ARM64: **598 unit tests across 64 files**, **seven native permission/worker cases**, **12 source desktop workflows** and **15 packaged workflows** passed. All **52 focused cases** also passed under Electron 44.7.0's Node 24.21.0 runtime; ordinary runs used Node 25.9.0. The package passed healthy native SQLite/DuckDB checks, three startup faults and the same 12 backup/export/transfer cases. Typecheck, build and native-payload packaging passed. `.test-artifacts/finalization-hardening` retains the original nine outcome-reporting failures, passing JUnit, desktop screenshots and real private-volume ENOSPC reports. Installer lifecycles, Docker and live Azure were not rerun.

## Multiple saved connections and profile capacity

After `pnpm build`, run `SQLCOMMANDER_TEST_DRIVERS=sqlite,duckdb pnpm exec playwright test tests/desktop/saved-connections.spec.ts tests/desktop/profiles.spec.ts tests/desktop/credentials.spec.ts tests/desktop/accessibility.spec.ts tests/desktop/screen-reader.spec.ts --grep 'saved connections|connections (sqlite|duckdb)|credentials native|credentials unavailable|keyboard focus|screen reader sees named connection fields'` for 12 focused desktop workflows. Rebuild with `pnpm package` and repeat with `SQLCOMMANDER_TEST_EXECUTABLE` pointing to the packaged executable. Run GUI suites sequentially. Ordinary packaged smoke now selects all three saved-connection cases and the additional native credential case.

The new native SQLite/DuckDB cases create three separate file-backed connections through **New connection** and changed **Connection settings** in the same tab. Earlier IDs/configuration and database data must survive. Explicit editing must retain its ID; folders/favorites must show the intended subset; unchanged reconnects must not duplicate profiles. Restart must recover all entries and saved SQL without reconnecting or replaying queries. The capacity case seeds 100 profiles, verifies scrolling and keyboard reachability at a smaller window size, reuses an existing profile at capacity, then requires a changed-profile save to fail before disconnecting the source session. An explicit session-only connection must still succeed. The original app failed all three cases.

The new native credential workflow creates an isolated Keychain entry without contacting a server. A changed-profile connection must require explicit password input before remembering a separate entry. Validation and a fresh **New connection** dialog must preserve the original secret/profile and avoid SQL history or plaintext workspace secrets. Test-owned credentials are removed afterward. Existing native opt-in/restart/replacement/removal and unavailable-store checks remain selected; server/SSH credential round trips are not required for this local selection.

`pnpm test` includes 27 profile-equivalence/secrecy cases plus a new multiple-profile credential-reference case. Comparisons cover defaults/order, all eight engines, changed endpoints/organization/trust policy, embedded file/mode identity, SSH routing and incomplete dialog drafts. Run those suites plus `tests/unit/connection-options.test.ts` and `tests/unit/storage.test.ts` through packaged Electron with `ELECTRON_RUN_AS_NODE=1` for 53 focused checks. Existing overwritten entries are not reconstructed automatically. Native Windows/Linux, remote-engine reconnects, longer endurance, physical faults and release qualification remain separate gates.

Local evidence on macOS ARM64: **626 unit tests across 65 files**, **12 source desktop workflows** and **15 packaged workflows** passed. All **53 focused cases** passed under Electron 44.7.0's Node 24.21.0 runtime; ordinary unit tests used Node 25.9.0. Typecheck, build, unsigned native-payload packaging, healthy SQLite/DuckDB checks and three startup fault/recovery cases passed. `.test-artifacts/saved-connections-hardening` retains all three original failures, final JUnit, restart JSON and screenshots of multiple saved entries, capacity rejection and retained-password guidance. The sidebar and password screenshots were inspected. Installer lifecycles, Docker and live Azure were not rerun.

## Server saved connections and application icons

`tests/desktop/server-saved-connections.spec.ts` adds two real-server workflows selected by `SQLCOMMANDER_TEST_DRIVERS=mariadb,sqlserver`. The Azure SQL profile uses the local SQL Server fixture and requires verified TLS. Each uses private application storage and three separate native credential entries. Tests cover profile creation without replacement, stored-password reconnect, failed-password redaction and recovery, unchanged-profile reuse, SQL/history preservation through restart, no automatic replay and a successful reconnect to another saved profile after restart. Cleanup uses the creating Electron identity, preserving the primary failure if cleanup also fails.

With the usual fixture images available, run `pnpm build`, then `node scripts/test-drivers.mjs --driver mariadb,sqlserver --desktop --integration-filter 'protects (production sessions|Azure profiles)' --desktop-filter 'saved server connections'`. The ordinary driver runner selects these tests automatically when running the whole desktop directory. For already running isolated fixtures, set the existing `SQLCOMMANDER_MARIADB_PORT`, `SQLCOMMANDER_MARIADB_CA`, `SQLCOMMANDER_SQLSERVER_PORT` and `SQLCOMMANDER_SQLSERVER_CA` variables and run `pnpm exec playwright test tests/desktop/server-saved-connections.spec.ts`. Credentials are the existing disposable fixture credentials in `compose.yaml`. Rebuild with `pnpm package` and set `SQLCOMMANDER_TEST_EXECUTABLE` to repeat against the packaged app. Do not use these fixture credentials against a production server. Live Azure SQL was skipped by explicit user request; these tests do not create billed resources or certify Azure-specific redirects, Entra authentication or service behavior.

`pnpm icons` regenerates the committed icon assets from `build/icons/icon.svg` using the installed Electron version. `pnpm test` includes five asset/configuration checks, and `pnpm exec playwright test tests/desktop/icon.spec.ts` checks the runtime image after `pnpm build`. Repeat against the packaged executable to validate its actual macOS bundle icon and Finder-resolved artwork. The native helper exports `finder-icon.png` and the report records a mint-color fraction; the icon must also be visually inspected. Icon tests avoid Electron's file-icon loader, which trapped during the initial probe on macOS 27, and use AppKit directly after application closure. Ordinary packaged smoke includes this test. Native Windows/Linux icon display and installer behavior still require their platform qualification.

Local evidence on macOS ARM64: **630 unit tests across 66 files**, **six source desktop workflows**, **nine packaged workflows** and **23 packaged-runtime icon/release checks** passed. The desktop cases comprise MariaDB and Azure-profile saved/reconnect checks, the application icon and three existing SQLite/DuckDB profile/capacity cases; the package also passed three startup faults and healthy native engines. Typecheck, build and unsigned packaging passed without the previous default-Electron-icon warning. The macOS bundle declares `icon.icns`; native `iconutil` accepts it, and the Finder-resolved image was inspected and measured about 49.6% mint pixels. Reports under `.test-artifacts/server-connections-hardening` bind the real-server results to cached MariaDB 11.4 and SQL Server 2025 image IDs, record SQL Server emulation and explicitly exclude live Azure service qualification. Test-owned containers/volumes, credentials and the private TLS key were cleaned up. Existing running services were untouched. Installer lifecycle, signing and native Windows/Linux display checks were not rerun.

## Minimize to system tray

`pnpm build`, then `pnpm exec playwright test tests/desktop/system-tray.spec.ts` runs three native Electron workflows using private profiles. They check default OS minimization, opt-in persistence, session/result retention, restoration after restart without SQL replay, application activation, restoring on disable, individual/all-window actions, renderer replacement and ordinary close. Tray and OS Quit both honor an open transaction's Keep working choice. Failed setting writes keep the prior tray behavior and permit retry. These tests observe the real Tray/menu objects in the main process without adding production test IPC.

Repeat with `SQLCOMMANDER_TEST_EXECUTABLE` pointing to the packaged executable after `pnpm package`. Ordinary packaged smoke includes these cases. `tests/unit/desktop-settings.test.ts` checks missing/damaged/oversized/non-regular settings and failed atomic publication; `tests/unit/icons.test.ts` verifies both template image sizes and package resources. `pnpm icons` regenerates app and tray images through a hidden Chromium canvas.

Native Windows and Linux tray/shell display still require platform runs. Linux desktop environments must support a tray/status notifier; Wayland compositor minimization can differ from Electron's minimize event. Local macOS results do not certify those behaviors or signed installers.

Local macOS ARM64 evidence under `.test-artifacts/system-tray`: **634 unit checks / 67 files**, **12 source desktop checks**, **12 packaged desktop checks**, **27 checks under packaged Electron Node**, typecheck/build and unsigned packaging passed. The desktop selection is `system tray|workspace windows|workspace recovery|profile ownership|application icon|SQL files retain dirty buffers|layout mouse` across the corresponding seven spec files. The restored SQLite result screenshot and regenerated app artwork were inspected.

`SQLCOMMANDER_STARTUP_ONLY=true node scripts/smoke-package.mjs` also passed healthy packaged SQLite/DuckDB probes and three startup regressions, giving **15 packaged desktop checks in total**. The packaged Finder icon measured about 49.6% mint pixels. Source and packaged runs used private profiles; native platform certification was not expanded.

## Packaged multi-window endurance

`pnpm test:endurance` runs the opt-in packaged endurance test for eight hours. Build the package first with `pnpm package`. To leave it running independently of the terminal, use:

```sh
pnpm test:endurance --detach --output .test-artifacts/endurance-eight-hour
```

The runner copies the package to a private snapshot, preserving relative framework symlinks, and records its SHA-256, source revision, native platform, hardware, PID and expected finish time in `run.json`. Later builds cannot replace that running package. On macOS, a test-owned `caffeinate` process keeps the machine/display awake until the runner finishes. The test repeatedly restores/minimizes its own windows, so allow for window/focus activity while it runs. No Docker, cloud databases, production profiles or saved credentials are used.

Three workspaces use separate in-memory DuckDB/SQLite sessions. Two retain uncommitted updates across repeated read queries; a third runs expensive DuckDB SQL, hides in the tray, cancels through the production bridge, and verifies that its session remains usable. SQLite cancellation is intentionally not used for that retention assertion: its current cancellation contract terminates the worker/session. Every cycle verifies workspace isolation and exact integers. Periodic full-result exports check every line count and boundary values, typing responsiveness and restored windows; scratch tabs exercise cloned-session closure. Export files are removed after checking, keeping disk use bounded. The final checks roll back retained transactions, save distinct buffers, restart the packaged app, reopen all workspaces and verify no automatic connection or SQL replay.

The default cadence pauses 30 seconds between cycles, exports 100,000 rows every tenth cycle and samples all renderer heaps/DOM/listeners and native process working sets after three warmup cycles, then every fifth cycle. Post-GC regression ceilings per renderer are 32 MiB heap growth, 2,000 DOM nodes and 400 listeners. Cancellation must settle within five seconds and editor input within two seconds on the current host. On POSIX, OS descendant sampling also includes SQLite workers omitted from Electron metrics. The owned tree must stay within 1 GiB RSS growth and two extra processes after warmup; summed RSS includes shared pages. These screening budgets are not a native-memory leak guarantee or universal hardware benchmark. Check `progress.json` for live cycles, timings, exports, resources and failures; final `run.json` plus `junit.xml` determine the result. A started/healthy run is not an eight-hour pass.

For a quick harness pilot, use `pnpm test:endurance --seconds 60 --interval 1 --output .test-artifacts/endurance-pilot`; a minimum of six cycles plus restart verification can extend a short pilot beyond its requested duration. Options accept 30–86,400 seconds, 1–60 second intervals and `--rows` from 10,000–10,000,000. Ordinary desktop smoke does not select this test; directly running the desktop directory without the explicit endurance environment skips it. Native Windows/Linux, large catalog throughput, physical faults and platform release certification remain separate work.

Preflight evidence on macOS ARM64 under `.test-artifacts/endurance-hardening` includes 634 passing unit checks across 67 files, typecheck/build/unsigned packaging, three passing packaged pilots and both existing soak cases with `SQLCOMMANDER_SOAK_CYCLES=64 SQLCOMMANDER_SOAK_EXPORT_ROWS=5000000`. Those two export sizes are 5,000,000 and 10,000,000 rows. The final pilot measured a full 30-second workload, sampled all ten owned processes, and passed rollback/restart checks. Earlier pilots completed 11 cycles each with less than 1 MiB retained renderer growth per window. Eight-hour completion requires the full workload duration and final recovery checks; its result is separate from these pilots.

### Completed eight-hour run — 19 October 2026

`node scripts/run-endurance.mjs --detach --seconds 28800 --interval 30 --output .test-artifacts/endurance-hardening/eight-hour-2026-10-19` passed on macOS ARM64 (64 GiB RAM, 18 logical CPUs). The recorded source revision is `2340461a4cedc24ecba07aed0a370b30c9524da4`; the package `app.asar` SHA-256 is `3378a66ad124850d50c57ac08f7c0652cbd9d055107d388da852ae30cce09fff`, verified again after completion. Workload ran from 09:50:43 to 17:50:43 CEST for **28,800.001 seconds**; final rollback/restart checks finished at **17:50:49 CEST**. Both status reports say passed, runner exit code is zero, and JUnit has one test with zero failures/errors/skips.

The run completed **843 cycles**, **85 exports / 8,500,000 verified rows / 645,056,925 bytes**, and **170 resource samples**. Each export checked row count and boundary values before removal. Both retained transactions rolled back to their original values. All three saved buffers and histories recovered after restart, with Run disabled until an explicit connection, proving no automatic query replay. The last screenshot shows the original rolled-back value and the saved, unexecuted Primary buffer.

| Workspace | Post-GC heap growth (MiB) | DOM node growth | Listener growth |
| --- | ---: | ---: | ---: |
| Primary DuckDB | 5.885 | 2 | 0 |
| SQLite | 3.776 | 842 | 0 |
| Query-cancellation DuckDB | 5.362 | 1,004 | 1 |

Heap growth stayed below 32 MiB per window; the largest sampled growth for SQLite was 4.126 MiB before later collection. DOM/listener growth stayed below 2,000/400. The complete owned POSIX tree stayed at ten processes throughout sampling. Its summed RSS was **1,533.547 → 1,344.078 MiB**, peaking at **1,565.750 MiB**; summed RSS includes shared pages. Cancellation latency was **8.424 ms median / 105.445 ms p95 / 107.911 ms maximum**. Automated Monaco input was **26.526 / 41.145 / 45.570 ms** respectively. Median cycle time was **3.805 seconds** for the first 100 cycles and **3.950 seconds** for the last 100, with every tenth cycle also doing export/tab work. All guards passed; no runtime fix was required by this run.

Retained renderer heap and DOM did not fully plateau, so this closes the configured local eight-hour regression gate without claiming leak-free steady state. Longer steady-state profiling, larger catalogs and native Windows/Linux remain follow-up work. Final cleanup removed the private profile and all observed application/worker PIDs and runner exited. `.test-artifacts/endurance-hardening/eight-hour-2026-10-19` retains `run.json`, `progress.json`, `summary.json`, `junit.xml`, `runner.log`, the immutable package snapshot and the final screenshot. No production profiles, credentials, Docker fixtures or cloud databases were used. Main-only CI and release qualification gates are unchanged.

## Retained editor heap and DOM

`pnpm test:soak` now builds and runs both existing query/export soak cases and two focused editor-retention cases. For the focused selection alone, run `pnpm build`, then `pnpm exec playwright test tests/desktop/editor-retention.spec.ts`. Rebuild with `pnpm package` and repeat with `SQLCOMMANDER_TEST_EXECUTABLE` pointing to the packaged executable. Run GUI suites sequentially. The focused cases use a private profile without a database connection or SQL execution. Heap snapshots contain the private fixture's SQL and are retained with the test output, outside version control.

The first case warms four scratch-tab closures and captures a post-GC heap snapshot, then closes 40 more and captures another. It counts objects with Monaco's public `cursorState`, `viewState` and `contributionsState` properties, independently of minified names. Growth must stay within two records instead of one per closure. DOM/listeners must remain bounded, and the original 300-line buffer must recover its selection, scroll position and formatting undo without SQL history. The original eight-hour package fails with 41 extra records; heap retainer analysis locates its wrapper's global URI-keyed map. The application now uses a weak model-keyed cache so closed tabs can be collected.

The second case performs 1,500 full-buffer replacements without remounting the editor. It records post-GC heap/DOM/listeners at edits 100, 1,100 and 1,500, then recovers the preceding SQL through Monaco's undo groups. Between the last two samples it permits less than 100 additional nodes, 10 listeners and 4 MiB of heap. Profiling the original package found exactly 1,000 Blink native textarea undo steps at both later samples, constant total DOM counts, and release when the editor view was replaced. That native history explains the eight-hour DOM trend; it is separate from the closed-tab cache leak. Model undo and compiled code legitimately retain heap. These accelerated comparisons do not establish constant heap under arbitrary editing or substitute for another eight-hour run on the changed runtime.

For related behavior, run `pnpm exec playwright test tests/desktop/editor-retention.spec.ts tests/desktop/soak.spec.ts tests/desktop/editor-views.spec.ts tests/desktop/editor-settings.spec.ts tests/desktop/workspace-editor.spec.ts` after building, then repeat against the package. This selects 12 workflows covering query/export resources, split views, selection/undo, settings, independent sessions/transactions, window recovery and restart. A short packaged endurance pilot additionally checks all three workspaces and final rollback/restart without replay. Native Windows/Linux, larger catalogs, physical faults and release qualification remain separate gates; main-only CI is unchanged.

Local macOS ARM64 results: **634 unit tests / 67 files**, **12 source desktop workflows** and **12 packaged workflows** passed, together with typecheck/build and unsigned packaging. The original package failed the closed-tab regression with view-state counts 5 → 46; source and fixed package both recorded 1 → 2 with unchanged DOM/listeners. Across edits 1,100 → 1,500, the packaged app added 14 nodes, no listeners and 0.621 MiB post-GC heap; source added 32 nodes, no listeners and 0.649 MiB. `.test-artifacts/retention-hardening` retains the original snapshots, direct retainer paths, before/after JUnit, final heap snapshots/resource JSON and `summary.json`. The original eight-hour package hash was verified unchanged; the new package's SHA-256 is `ac53dbb97fdd5072db62168e140e6e84f6fa13de8a1375aea4eef7262e6aa26f`.

`node scripts/run-endurance.mjs --seconds 60 --interval 1 --output .test-artifacts/retention-hardening/pilot` also passed: 63.119 measured workload seconds, 12 cycles, two verified exports totaling 200,000 rows, final rollback and three-window buffer/history recovery without replay. Per-window heap growth was 0.850 / 0.815 / 0.688 MiB, DOM growth −1 / 9 / 18 and listener growth zero. Four samples accounted for ten owned POSIX processes each; summed RSS was 1,605.734 → 1,575.359 MiB. Cancellation peaked at 104.794 ms and typing at 15.494 ms. Runner exit/JUnit passed without skips, the snapshot hash matched, the private profile was removed and all observed PIDs exited. The receipt records the pre-commit base revision; `runtime-working-tree.diff` and the package hash bind this pilot to the working changes. This short pilot does not repeat the eight-hour qualification.

## Visual design and result keyboard refinement — 19 October 2026

`pnpm test:design` checks both themes at 1440×940 and 1024×700, full saved-profile identity and protection, SQL token/gutter contrast, focused input boundaries, settings-footer visibility while scrolling and at 150% native zoom, profile-menu keyboard return, and renderer errors. A second local DuckDB case checks one cell Tab entry, directional navigation across 1,000 virtual rows, Home/End/page movement, exact-integer inspection/focus return, hidden/pinned columns, manual scrolling and row-number fit without executing additional SQL. Set `SQLCOMMANDER_TEST_EXECUTABLE` to repeat against the package. These cases also join the ordinary packaged smoke selection.

The related regression selection covers dialog/command focus, Chromium accessibility trees, settings import/export and restart, split editors, named workspace isolation/recovery, multiple saved profiles and capacity, native credentials and failure handling, SQLite/DuckDB language/inspection, panel layout and editor retention. GUI runs remain sequential. The retained-resource fixture now waits for a full editor layout and explicitly initializes suggestion controls before each snapshot; otherwise a just-remounted 5px editor and an initialized suggestion widget can differ by 103 listeners. Heap evidence identified those listeners on the active suggestion list/sashes. This fixture correction preserves the original listener/node/view-state limits and open-buffer selection/undo assertions.

Rendered measurements from the representative SQL fixture meet the configured thresholds: minimum token contrast **5.64:1 dark / 4.60:1 light**, line numbers **5.14 / 5.51**, focus indicators **9.57 / 5.89**, and input boundaries **3.64 / 3.36** against their adjacent input/dialog surfaces. Screenshots and keyboard checks verify the settings actions, complete identity and visible navigation targets. These are measured sample states, not a claim of exhaustive WCAG or human screen-reader certification.

The final source detector reports three warnings: the pinned-tab group separator (`.editor-tab.pinned-end`) and before/after tab-drop markers (`.editor-tab.drop-before` / `.editor-tab.drop-after`). They communicate grouping or insertion position and are retained intentionally. The decorative builder-card accent was removed. The installed detector's CDP flags remain unsupported; rendered verification uses Playwright geometry/computed colors and native captures at non-default zoom.

Local macOS ARM64 verification passed **634 unit tests across 67 files**, typecheck, production build, unsigned native packaging, **41 source desktop workflows** and **44 packaged workflows** (the same selection plus three startup/recovery cases), with no skipped cases in the final reports. Three consecutive source retention repeats and the final packaged case recorded exactly 737 nodes and 372 listeners before and after 40 scratch-tab closures, with view states 1 → 2 and selection/scroll/undo preserved. Final screenshots were inspected in both themes, at both window sizes, and at 150% native zoom. Before/after JUnit, heap evidence, computed contrast, menu/footer/grid screenshots and `summary.json` are retained under `.test-artifacts/design-polish-2026-10-19`. The tested package's ASAR SHA-256 is `2105fbe8e9397fe5f76876fd1b117ee158edc3001cc3352177c56660ef85423c`. Main-only CI is unchanged. Native Windows/Linux, live Azure, installers, signing and a new eight-hour qualification of this runtime were not run in this refinement pass and remain separate gates.

## Second design and accessibility pass — 19 October 2026

`pnpm test:design` now includes seven workflows. New cases check native 200% zoom in both themes at 1440×940 and 1024×700; editing, result inspection/navigation and sidebar controls must remain reachable without document horizontal overflow or changed layout preferences. Table navigation must preserve authored SQL/results/history, explicit SELECT append must quote the object and undo in one step, and a maximum-sized buffer must survive rejected generation. Library checks cover fixed heading/close access, compact action geometry, filter reset, empty snippets, selected-section semantics and opening without execution. Inspector checks retain the original value through invalid JSON/Text recovery, preserve the specific limit message for valid but deeply nested JSON, and return focus; failure status must use the danger color. Token checks measure normal/active/selected surfaces in both themes and the object-filter boundary.

Run GUI suites sequentially under `caffeinate -dims` on macOS. The related local selection covers accessibility/AX trees, SQLite/DuckDB browsing/catalog/grid/inspection, column sizing/layouts, library and snippet-file import/export, settings/files, split editors, named workspace recovery, panel resizing and editor retention. Set `SQLCOMMANDER_TEST_DRIVERS=sqlite,duckdb`, select the corresponding specs and exclude server-engine cases with `--grep-invert 'mysql|mariadb|postgres|sqlserver|azure-sql|oracle'`. Repeat with `SQLCOMMANDER_TEST_EXECUTABLE` pointing to the rebuilt package; packaged startup/recovery is checked separately. Exact commands and output are retained in `.test-artifacts/impeccable-follow-up-2026-10-19`.

Use real clipboard paste for the million-character buffer fixture, with `withClipboard` restoring every pre-existing format inside main. Playwright's synthetic bulk `Input.insertText` stalled even for a multi-line million-character value; native paste of the same single-line size completed and the append guard passed. This distinguishes the automation input path from a reproduced native-paste defect. Monaco also replaces token spans asynchronously: the contrast fixture waits for function tokenization and queries/measures the current DOM in one evaluation. Neither correction weakens contrast, SQL-retention or capacity assertions.

The final source detector retains only three functional tab markers: the pinned-tab separator and before/after drag insertion cues. Its installed CDP flags are unsupported, so live detector scanning is unavailable. Computed style/geometry, keyboard interaction, Chromium accessibility trees and native full-window captures at zoom provide the runtime evidence. No overlay or live server is needed for this Electron path. These checks do not replace human screen-reader or native Windows/Linux qualification.

Local macOS ARM64 validation passed **634 unit tests / 67 files**, typecheck/build and unsigned native packaging. **46 unique source workflows** were validated across the broad run and focused reruns: 45 passed initially; the contrast fixture's detached-node measurement failure is retained in `source.xml`, and the corrected case passed repeated checks. The final nine design/inspection workflows also passed. The rebuilt package passed the full **46-workflow** selection plus **three startup/recovery cases** (**49 unique packaged workflows**), with no failures/errors/skips in the final reports. Explicit active/inactive overlay-state checks passed three additional consecutive runs on each build. Healthy packaged SQLite/DuckDB file/exact-integer/preload probes passed as well.

At native 200% zoom, all four theme/window combinations retain a **160px** editor and a scrollable 406px pane stack; document widths equal their **512px / 720px** viewports. Minimum measured text contrast across normal/active/selected states is **4.687:1 dark / 4.600:1 light**; inactive selection measures **4.825 / 4.683**, and object-filter boundaries **3.986 / 3.815**. Native library/action and workbench screenshots were inspected. Raw review evidence, failed and passing test reports, corrected-fixture repeats, metrics, logs and `summary.json` are retained under `.test-artifacts/impeccable-follow-up-2026-10-19`. The final tested ASAR SHA-256 is `40e30875045888f9a6ea696e716677b660f41a7b946d8757c7e2bd5c1f31427e`, unchanged after testing.

Main-only CI is unchanged. Native Windows/Linux, human screen-reader sessions, live Azure, physical faults, installers/signing and a fresh eight-hour qualification of this runtime remain separate gates. The disposable review app and test profiles were cleaned up; retained local critique archives are excluded from the code commit.

## Large embedded catalogs — 19 October 2026

Run `pnpm test:catalog-scale` for the native SQLite/DuckDB driver and Electron cases. Fixtures use synthetic private files or in-memory databases, never production profiles or external services. Scripts sent through the driver are seeded in batches below the 200-statement limit; desktop files are seeded and closed before the app opens them.

Each catalog starts with 1,300 tables containing eight columns, unique indexes, a self-referencing foreign key and a check constraint. This exceeds the 10,000-column preview and the 2,000-object rich-catalog limit. Driver cases add a later attached table/view, require all parent relations to remain inspectable, inspect a parent outside the column preview, retain an uncommitted row through metadata reads and verify its explicit rollback. Growing to 2,105 tables must return exactly 2,000 catalog relations with truthful truncation. A unit boundary case also verifies SQLite's combined bounded merge when an early database fills its entire read with children.

Desktop checks measure connection, refresh, three filter cycles, details, typing and alias completion with 1,300 displayed tables. They require intact SQL/history and both partial-preview notices. Local screening ceilings are 10 seconds for connect/refresh, five seconds for details and two seconds for each filter/typing/completion check; typing includes simulated key delays and recovery-save observation. These are automation end-to-end timings on this machine, not reference-hardware throughput guarantees.

Run GUI suites sequentially under `caffeinate -dims` on macOS. Rebuild with `pnpm package`, set `SQLCOMMANDER_TEST_EXECUTABLE` to the packaged executable, and rerun `tests/desktop/large-catalog.spec.ts`. Ordinary packaged smoke also includes both cases. Related regressions cover SQLite/DuckDB catalog definitions/keys, browsing, inspection, language tools, diagrams and schema comparison/changes. Native Windows/Linux, server catalogs, much larger schemas, catalog pagination, physical faults and broader release qualification remain separate work; this pass does not qualify another eight-hour workload or change main-only CI.

Local macOS ARM64 results: **635 unit tests / 67 files**, typecheck/build, unsigned packaging, **four focused native driver checks**, **16 unique source desktop workflows**, **19 packaged desktop workflows** and **28 focused packaged-Node-runtime checks** passed. The native driver selection deliberately excludes 89 unrelated cases. The initial source run passed 14 workflows; two schema-comparison fixtures still expected Browse immediately after Object details. They now verify the existing Append SELECT stop as well as Browse and focus return; both corrected workflows passed. The final packaged report has no failures/errors/skips. Earlier catalog failures, fixture corrections, JUnit, screenshots, timings and `summary.json` remain under `.test-artifacts/large-catalog-hardening-2026-10-19`.

Measured packaged desktop timings, rounded to milliseconds:

| Interaction | SQLite | DuckDB |
| --- | ---: | ---: |
| Connect and render catalog | 259 | 287 |
| Refresh schema | 138 | 119 |
| Slowest of three filters | 22 | 19 |
| Open final table details | 63 | 117 |
| Type and observe saved SQL | 820 | 771 |
| Alias-column completion | 194 | 271 |

Native driver refreshes measured about 26 / 55 ms at 1,300 tables and 26 / 63 ms at 2,105 tables (SQLite / DuckDB). The final package's ASAR SHA-256 is `54d6bce78f7700e4c2240025335e6f49cf6d2c1c9455d3e6ecb55cfdafe74ed5`, verified unchanged after testing. Details/explorer screenshots were inspected. Private databases and profiles were removed by test cleanup.

## Large server catalogs — 19 October 2026

Run `pnpm test:server-catalog-scale` for disposable PostgreSQL/MySQL/MariaDB/SQL Server fixtures, nine selected driver/catalog contracts and nine desktop workflows (four new scale cases plus existing catalog checks for five profiles). The standard runner builds the worker/app, trusts only its fixture certificates, uses isolated Compose projects and removes their containers/volumes. Its normal SQL Server fixture remains 2022; the local diagnostic below used the cached 2025 image and is version-scoped accordingly. Rebuild with `pnpm package` and set `SQLCOMMANDER_TEST_EXECUTABLE` to repeat the desktop checks with the package. Run GUI suites sequentially under `caffeinate -dims` on macOS.

The four new driver cases use random table prefixes and 150-statement seed batches within the public script budget. At 1,300 eight-column tables, unique/primary/foreign keys and checks fill the rich catalog while columns exceed its separate preview. Every parent plus a view must be retained; PostgreSQL includes a materialized view as well. Details must load all eight columns for a table outside the column preview. Metadata reads must emit no query events or disturb an uncommitted row, and explicit rollback must restore its committed value. At 2,105 tables the catalog must retain exactly 2,000 parent relations and report both truncation boundaries. Cleanup explicitly rolls back and removes only the fixture's generated objects.

The four new desktop cases cover PostgreSQL, MySQL, MariaDB and SQL Server, with a second private Azure-profile app session sharing the SQL Server fixture. They require the last table/view, both truncation notices, on-demand details, intact SQL and empty history. Timings cover connect/render, refresh, three filter cycles, details, typing and alias-column completion. Screening budgets remain 10 seconds for connect/refresh, five seconds for details and two seconds for each filter/typing/completion observation. These include automation/renderer/save delays and are not reference-hardware benchmarks.

Local fixtures use PostgreSQL 17.11, MySQL 8.4.11 and MariaDB 11.4.13 on Linux ARM64, plus SQL Server 2025 RTM-CU4 (17.0.4035.5) on Linux x64 under emulation. All connections use verified TLS with a private fixture CA. Azure-profile results cover this local TDS server only; live Azure remains skipped at the user's request. Existing running services are excluded. Oracle, native Windows/Linux clients, native x64 SQL Server/2022 qualification, larger/reference-hardware datasets, pagination and broader beta/release gates remain separate work.

Local validation passed **635 unit tests / 67 files**, typecheck/build, unsigned packaging, **nine focused catalog contracts**, **24 unique source desktop workflows**, **27 packaged desktop workflows** and **36 focused packaged-Node-runtime checks**. The final runtime selection contains ten server cases (including the isolated GO guard) and 26 catalog/release unit cases; 197 unrelated cases were excluded by name. The final packaged desktop report has no failures/errors/skips.

The initial source run passed 23 cases; the new SQL Server fixture's direct TypeScript import encountered Playwright's private CommonJS decoder interop difference before launching the app. Its setup now uses unmodified Tedious for synthetic DDL, while Electron still exercises the actual application transport/decoder. The corrected SQL Server/Azure case passed. An overly broad runtime filter also exposed an existing GO-batch test's dependency on a prior case's temporary table. It now creates/cleans its own guard table and passes both alone and in the final runtime selection. Neither correction relaxes application assertions or timing budgets. The dedicated command's discovery check selects all nine intended desktop cases.

Packaged desktop measurements, rounded to milliseconds:

| Profile | Refresh | Details | Slowest filter | Typing/save | Completion |
| --- | ---: | ---: | ---: | ---: | ---: |
| PostgreSQL | 179 | 118 | 21 | 772 | 178 |
| MySQL | 203 | 115 | 22 | 820 | 196 |
| MariaDB | 966 | 117 | 25 | 820 | 196 |
| SQL Server (emulated) | 431 | 828 | 25 | 813 | 203 |
| Azure profile (local TDS) | 436 | 318 | 24 | 817 | 196 |

Packaged Node 24.21.0 driver refreshes at 2,105 tables measured about 111 ms PostgreSQL, 94 ms MySQL, 1,563 ms MariaDB and 534 ms SQL Server. The complete 1,300-table refreshes were about 90 / 61 / 627 / 574 ms respectively. Native driver and desktop runs preserve their separate timing scopes. Raw baseline failures, corrected-fixture reruns, setup logs, JUnit, inspected details/explorer screenshots, immutable fixture image IDs, timings and `summary.json` are retained under `.test-artifacts/server-catalog-hardening-2026-10-19`. The final ASAR SHA-256 is `ca08e6071a1261a3d030d2a3fc5057773cffd1eb962018cac218fd2fbac1d86b`, verified unchanged after testing. Main-only CI remains unchanged; no cloud databases, installers, signed release or fresh eight-hour workload were exercised.

Cleanup verified each container's project label and immutable image against the receipt, then removed the owned containers, volumes, diagnostic images and loose private key. Private application profiles were removed. The pre-existing MariaDB service and CI runner remain running.

## Large Oracle catalogs — 20 October 2026

Run the Oracle catalog regression with its existing wallet/TLS Docker fixture:

```sh
caffeinate -dims pnpm test:oracle-catalog-scale

# Build and test the unsigned local macOS package against a fresh fixture:
pnpm package
SQLCOMMANDER_TEST_EXECUTABLE="$PWD/release/mac-arm64/DbCommander.app/Contents/MacOS/DbCommander" caffeinate -dims pnpm test:oracle-catalog-scale
```

`caffeinate` is macOS-specific; other hosts can run the pnpm command directly. The driver runner scopes the fixture CA through `NODE_EXTRA_CA_CERTS` before starting test/application children. Oracle uses the runtime trust store; the connection form does not accept a custom PEM. No system trust settings or external databases are changed. The dedicated command selects two driver contracts and two desktop workflows; its desktop discovery was checked explicitly.

The fixture runs native Linux ARM64 Oracle Free 26ai 23.26.3.0.0, with Thin-mode clients on macOS ARM64 and verified TCPS. At 1,300 eight-column tables, every fixture table, view and materialized view must remain visible despite the 10,000-column and 2,000-object caps. Checks inspect the final table outside the column preview, preserve an uncommitted write through metadata reads and then explicitly roll back, reject another-owner inspection, and verify materialized-view deduplication and generated-summary labeling. At 2,105 tables, the catalog must retain exactly 2,000 parent relations and report truncation. DDL setup uses bounded batches; Oracle cleanup purges only the test's named tables.

Desktop checks use private profiles and measure connect/refresh below ten seconds, table/materialized-view details below five seconds, and filtering, typing/save and alias completion below two seconds. They preserve SQL/history and never execute the editor's authored buffer. The original failing baseline, native/packaged runtime reports, desktop results, screenshots, setup log and immutable fixture receipt are retained under `.test-artifacts/oracle-catalog-hardening-2026-10-20`.

Validation passed **635 unit tests / 67 files**, typecheck/build, unsigned packaging, **eight focused driver contracts**, **nine unique source desktop workflows**, **12 packaged desktop workflows**, and **49 focused packaged-Node-runtime checks** (eight driver contracts plus 41 unit cases). Each focused integration report excludes 39 unrelated cases by name. The final packaged desktop report contains no failures, errors or skipped cases. The source run passed eight cases and exposed the Oracle smoke test's stale table-click replacement expectation; its corrected explicit-append workflow passed separately and again in the package. The application behavior and performance budgets were preserved.

Packaged desktop measurements, rounded to milliseconds:

| Connect | Refresh | Table details | Materialized-view details | Slowest filter | Typing/save | Completion |
| ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 1,444 | 930 | 2,841 | 1,835 | 18 | 789 | 291 |

Separate driver checks on packaged Node 24.21.0 measured 1,003 ms for the 1,300-table refresh, 701 ms for the 2,105-table overflow refresh, 2,339 ms for table details and 114 ms for the generated materialized-view summary. These are single-run local responsiveness measurements, not reference-hardware throughput benchmarks. The tested ASAR SHA-256 is `18d1b55324f9f5c8eb7f0f5ead796ec13a77669d2519c00f3c25ee059e4391bb`, verified unchanged after testing; inspected source/packaged screenshots and `summary.json` retain the underlying evidence.

Cleanup verifies the container ID, project/service labels and immutable image against the fixture receipt before removing its container and volumes. Private application profiles are removed by the tests; existing MariaDB/CI services remain outside the project. Main-only CI is unchanged. Native Windows/Linux clients, other Oracle versions, larger datasets, pagination, signing/installers, live Azure and the remaining beta/release gates are separate qualification work; no fresh eight-hour workload or cloud database was used.

## Larger catalog performance — 20 October 2026

These opt-in fixtures use 10,000 and 20,000 empty tables with eight columns, primary/unique/check/foreign-key constraints. They keep the application limits intact and repeat refresh plus inspection three times at each size. A retained table outside the column preview must remain inspectable; metadata reads must preserve pending writes through explicit rollback. SQL Server includes a local Azure-profile pass at 20,000 tables.

```sh
# Native embedded drivers and source desktop; no Docker required:
caffeinate -dims pnpm test:catalog-performance

# Disposable server databases, one at a time to bound Docker memory:
pnpm test:server-catalog-performance
pnpm test:server-catalog-performance --driver postgres,mysql,mariadb,oracle

# MariaDB driver and desktop workload:
caffeinate -dims pnpm test:server-catalog-performance --driver mariadb --desktop

# Packaged desktop against the same opt-in workloads:
pnpm package
SQLCOMMANDER_TEST_EXECUTABLE="$PWD/release/mac-arm64/DbCommander.app/Contents/MacOS/DbCommander" caffeinate -dims pnpm test:catalog-performance
SQLCOMMANDER_TEST_EXECUTABLE="$PWD/release/mac-arm64/DbCommander.app/Contents/MacOS/DbCommander" caffeinate -dims pnpm test:server-catalog-performance --driver mariadb --desktop
```

`caffeinate` and the shown package path are macOS-specific. Server fixtures use the existing TLS/ownership/cleanup runner; Oracle's fixture trust is scoped to child processes. Commands print their retained evidence directory under `.test-artifacts/catalog-performance-<pid>`; `SQLCOMMANDER_CATALOG_EVIDENCE` can select an explicit destination. Source/packaged desktop checks measure connect/refresh below ten seconds, details below five seconds, and filtering, typing/save and completion below two seconds. Post-GC growth over three refreshes uses the existing soak limits of 16 MiB heap, 1,500 DOM nodes and 300 listeners; owned POSIX process-tree growth uses the endurance limits of 1 GiB RSS and two processes. RSS is a settled client-tree snapshot, excludes Docker server memory, and is not a peak measurement. Heavy cases are skipped by ordinary test runs unless explicitly opted in; the normal main-only pipeline and packaged smoke selection are unchanged.

Local hardware was an Apple M5 Pro with 18 logical CPUs and 64 GiB RAM; Docker reported ARM64, 18 vCPUs and 7.75 GiB RAM. Source driver checks used Node 25.9.0; packaged runtime checks used Node 24.21.0. The servers were PostgreSQL 17.11, MySQL 8.4.11, MariaDB 11.4.13 and Oracle Free 26ai 23.26.3 on native ARM64, plus SQL Server 2022 CU27-GDR 16.0.4305.5 on Linux x64 under emulation. Azure-profile probes use that same local TDS server; no cloud database was used.

Native driver measurements at 20,000 tables, rounded to milliseconds. Each cell shows median / maximum of three reads; first reads can include cold metadata work:

| Engine/profile | Refresh | Table details |
| --- | ---: | ---: |
| SQLite | 151 / 153 | 61 / 62 |
| DuckDB | 411 / 416 | 524 / 530 |
| PostgreSQL | 648 / 660 | 590 / 600 |
| MySQL | 611 / 658 | 553 / 561 |
| MariaDB | 1,164 / 1,177 | 1,083 / 1,086 |
| Oracle | 1,195 / 2,034 | 649 / 2,738 |
| SQL Server 2022 (emulated) | 1,012 / 4,087 | 621 / 2,864 |
| Azure profile (local TDS) | 983 / 985 | 611 / 626 |

The initial MariaDB 10,000-table refresh hit the application's ten-second metadata timeout. A retained query comparison timed out the original and constant-schema joins after eleven seconds, measured about 3,772 ms for a bounded-parent join and 108 ms for the direct bounded column read. The final full driver refresh, including the separate rich catalog read, measured 545–640 ms at 10,000 tables and 1,162–1,177 ms at 20,000. The existing timeout was not increased. Five unit regressions verify empty schemas, safely bound names, no-column objects, accurate object/column truncation and error propagation.

Packaged desktop results at 20,000 tables, rounded up to milliseconds. Refresh is measured independently while the editor receives input; typing includes autosave observation:

| Engine | Slowest refresh | Details | Slowest typing during refresh | Slowest filter | Completion |
| --- | ---: | ---: | ---: | ---: | ---: |
| SQLite | 348 | 127 | 633 | 26 | 249 |
| DuckDB | 991 | 818 | 636 | 25 | 239 |
| MariaDB | 1,483 | 1,332 | 626 | 26 | 232 |

Typing began while refresh was active in all nine packaged samples. Across three refreshes, post-GC heap growth was about 0.04 / 0.37 / 0.38 MiB (SQLite / DuckDB / MariaDB), with zero DOM-node, listener or process-count growth. Complete owned process-tree RSS grew about 15.7 / 13.8 / 19.4 MiB respectively. These short repeated-refresh checks passed the existing budgets; they are not a new endurance run or a statistically qualified hardware benchmark.

Validation passed **640 unit tests / 68 files**, build/typecheck, unsigned packaging, **seven scale cases**, local Azure-profile probes, **eight focused MariaDB driver controls**, **nine unique source desktop workflows**, **12 packaged desktop workflows** and **59 packaged-Node-runtime checks** (13 integration cases plus 46 unit cases). The final GUI reports contain no failures, errors or skips; unrelated integration cases were excluded by name. Default-run checks verify that the new heavy cases stay skipped unless opted in. Retained harness failures cover the corrected duplicate unique seed value and server-view fallback expectation; neither correction changes the caps or budgets.

Before/after JUnit, query comparisons, host configuration, raw stage/resource measurements, immutable fixture identities, inspected screenshots and `summary.json` are retained under `.test-artifacts/catalog-performance-2026-10-20`. The tested ASAR SHA-256 is `b126d9862eddd0697fe0feb39c967a7ac3a64559a4272cee547b5c056cfd99fa`, verified unchanged after testing. Disposable runner fixtures were removed; the diagnostic MariaDB container was checked against its exact ID/image/project/service receipt before removal. Existing MariaDB/CI services and unrelated app processes were preserved. Native Windows/Linux clients, larger/more varied datasets, lower/reference hardware, catalog pagination, live Azure and the remaining release gates remain open.

## Beta scope freeze and local qualification — 20 October 2026

The [beta plan](PLAN.md#beta-release-checklist) now holds one current checklist with stable B01–B17 IDs. [Plan history](PLAN_HISTORY.md) preserves the original roadmap and all dated milestone reports; its old pending/deferred statements are not a second backlog. [Beta notes](BETA_NOTES.md) freeze the existing workflows, bounded previews, experimental Azure profile and manual-update policy. Older README claims that tested editor/tab/layout/settings workflows and full-result exports were unfinished have been reconciled with their passing reports. This pass changes documentation and a contrast-test fixture, not runtime behavior or CI/release gates.

Evidence is retained under `.test-artifacts/beta-freeze-2026-10-20`. The runtime base is development `5395b1f883ec4ee5d25bb836473b158427f4dcee`. Rebuilding produced the same ASAR SHA-256 as the preceding catalog performance run: `b126d9862eddd0697fe0feb39c967a7ac3a64559a4272cee547b5c056cfd99fa`. This binds earlier relevant runtime evidence to unchanged application bytes; native installer results still bind their own exact artifact hashes.

Commands used for this pass:

```sh
pnpm test --reporter=default --reporter=junit --outputFile.junit=.test-artifacts/beta-freeze-2026-10-20/unit.xml
pnpm package
ELECTRON_RUN_AS_NODE=1 release/mac-arm64/DbCommander.app/Contents/MacOS/DbCommander node_modules/vitest/vitest.mjs run tests/unit --reporter=default --reporter=junit --outputFile.junit=.test-artifacts/beta-freeze-2026-10-20/packaged-runtime-unit.xml
PLAYWRIGHT_JUNIT_OUTPUT_FILE="$PWD/.test-artifacts/beta-freeze-2026-10-20/packaged.xml" caffeinate -dims node scripts/smoke-package.mjs
node scripts/build-release.mjs --fixture --output release/beta-freeze-2026-10-20-baseline
node scripts/build-release.mjs --output release/beta-freeze-2026-10-20-candidate
caffeinate -dims node scripts/test-installers.mjs --baseline release/beta-freeze-2026-10-20-baseline --candidate release/beta-freeze-2026-10-20-candidate --report .test-artifacts/beta-freeze-2026-10-20/lifecycle.json
pnpm licenses list --prod --long --json
```

The full unit suite passed **640 tests / 68 files** under development Node 25.9.0, followed by typecheck/build and unsigned native packaging. The same **640 tests / 68 files** also passed under the packaged Electron 44.7.0 Node 24.21.0 runtime. The host is macOS 27.0.1 ARM64, Apple M5 Pro with 18 logical CPUs and 64 GiB RAM. Final typecheck and whitespace checks passed after the fixture correction.

Packaged startup passed all **three** native-library/host-recovery cases. The complete ordinary packaged selection then produced **121 passes, seven intentional unselected-engine diagram skips and one error**. The error came from the contrast fixture reading an empty computed gutter color through a locator-resolved node list after Monaco's resize/theme replacement; no below-threshold rendered color was reported. The test now queries and measures live token/gutter nodes in a single browser evaluation, waits for the three numbered lines and resolved colors, and gives an explicit diagnostic for invalid RGB input. All 4.5:1 text/gutter and 3:1 boundary/focus thresholds remain unchanged; an empty gutter cannot pass silently.

The corrected case passed **five consecutive packaged repeats**. The complete **seven-workflow design suite passed on both source and package**, covering themes, identity, native zoom, keyboard results, library reflow, JSON/error recovery and selected-token contrast. Together with the unchanged passing cases, this provides passing evidence for **125 unique packaged workflows**; it is combined broad-run/focused-rerun evidence, not a claim that the initial broad report was entirely green. Original error/JUnit/screenshots, final reports and `summary.json` are retained. The rebuilt and installer-candidate ASAR hashes still match the package identity above.

Both **DMG and ZIP** passed install, version upgrade, uninstall/reinstall, SQL/workspace/profile/history/layout retention, native credential recovery and SQLite/DuckDB exact-value/file checks. `lifecycle.json` binds the results to each candidate installer hash and records `mode: unsigned` and `syntheticBaseline: true`. These passes close only the local ARM64 lifecycle gate, not signing, first-download quarantine or historical migration qualification.

Short packaged retention checks also passed: after 40 scratch-tab closures, DOM/listeners stayed at **737/372** and view-state records changed **1 → 2**. Between edits 1,100 and 1,500, nodes/listeners stayed at **1,381/366** and post-GC heap grew about **0.48 MiB**, with undo preserved. The 64-cycle query/tab soak and 100,000/200,000-row export/cancellation checks passed. These remain accelerated controls; B09 requires a fresh eight-hour result on the immutable package.

The installed production Node dependency inventory contains 130 name/version entries in 11 declared license categories. Normalized inventory and raw CLI output are retained locally, together with the packaged license/notice paths. The application license/notices, MariaDB, Oracle, DuckDB and keyring wrapper license files are present in the current ASAR. This is an installed-dependency and selected packaged-notice check, not an artifact-wide SBOM or redistribution approval; Electron/Chromium/native notices and every target's final release bytes still require B16 sign-off.

Local Markdown link checks cover the current plan, beta notes, README, release guide and implementation/testing documents. The original historical plan body is preserved and the current checklist has 17 unique gate IDs. Native x64 clients, signing/notarization, clean-OS first download, minimum/reference hardware, human screen-reader workflows and real daily-use pilot feedback remain open. No cloud databases, external signing resources or main CI jobs were used.

After the short checks, the frozen package was launched for another eight-hour run:

```sh
node scripts/run-endurance.mjs --detach --seconds 28800 --interval 30 --output .test-artifacts/beta-freeze-2026-10-20/eight-hour
```

The receipt records freeze commit `0c8874b021b2f0a67535ff6e13aba4f190e03436` and the same ASAR hash above, with the immutable snapshot inside that exact output directory. Workload started at **2026-10-20 07:01:45.090 UTC / 09:01:45 CEST**; 28,800 workload seconds elapse at approximately **17:01:45 CEST**, with rollback/restart verification afterward. Initial runner/worker process identity, snapshot path/hash and advancing progress were checked. A completion follow-up watches this one run and stays quiet while it is healthy. **Launch/progress is not an endurance pass:** B09 stays unchecked until the final receipts, JUnit, duration, resource/timing trends and rollback/restart/no-replay checks are reviewed. Later documentation commits do not change the frozen application or endurance workload.


## Release inventory and endurance readiness — 20 October 2026

Evidence: `.test-artifacts/beta-release-readiness-2026-10-20`; earlier freeze/failed endurance evidence remains in `.test-artifacts/beta-freeze-2026-10-20`. These are local unsigned macOS ARM64 results, not signed/native matrix qualification.

The packaged application omitted the upstream Electron license and Chromium notice bundle present in the pinned Electron distribution. Packaging now copies both into `resources/licenses/` and fails if the distribution version or exact notice bytes do not match. Installer builds generate a schema-validated offline CycloneDX 1.6 inventory from actual production ASAR manifests, resolved dependency references, the ASAR hash, separate native binary hashes and installer hashes. A notice sidecar retains exact UTF-8 license texts and hashes. Candidate staging and four-target promotion require matching sidecars and lifecycle evidence; installed upgrade/reinstall verification checks the actual ASAR/native/notice bytes. The older lifecycle baseline alone may predate inventory metadata.

Final review also tightened the older-baseline exception: missing legacy inventory is allowed only explicitly, while damaged inventory that is present is always rejected. The packaged SSH2 manifest declares MIT through npm's legacy `licenses` array; generation now retains that declaration, with regression coverage. Both full 649-test suites passed again after these corrections. The manifest declares MariaDB as `LGPL-2.1-or-later` and Oracle as `(Apache-2.0 OR UPL-1.0)`; those declarations and native/vendor contents remain explicit redistribution-review inputs, not an approval inferred from hashes.

The local candidate contains **128 packaged npm instances, seven native binaries and 133 license/notice files**. Initial DMG/ZIP output passed offline installed payload checks (`payload.json`). The final candidate, `release/beta-release-readiness-2026-10-20-qualified-candidate`, was built from committed source `785477ae0dffe2cfe2457a0212cc90179d875bb8`. Both final formats passed full GUI install, synthetic upgrade, uninstall/reinstall, workspace/credential recovery and native SQLite/DuckDB checks, plus exact installed ASAR/native/notice verification and whitelist staging. `qualified-validation.json`, `qualified-lifecycle.log`, candidate `lifecycle.json` and `.test-artifacts/ci-results/installers/darwin-arm64.xml` bind those checks to the actual installer and sidecar hashes. All 128 npm instances retain a declared license, including SSH2's legacy declaration. The final sidecars are 115,776 and 20,775,505 bytes respectively. Native/runtime vendor internals are explicitly declared incomplete; retaining upstream notices is not an exhaustive SBOM or completed redistribution review.

Validation: **33 focused tests / three files**, **649 full unit tests / 69 files** under Node 25.9.0, and **649 / 69** under packaged Node 24.21.0 all passed. Typecheck/build and native unsigned directory/DMG/ZIP builds passed. A real build first exposed electron-builder pruning `devDependencies` from the production package manifest; generation now accepts that normal production shape while the afterPack audit and pinned manifest establish the Electron version. The fixture also uses that production shape. The initial bundled-Node CLI unit attempt hit Electron's virtual-ASAR filesystem (10 fixture errors); the corrected raw-filesystem CLI command below passed all tests. This flag applies only to the unit-test process and changes no application configuration.

```sh
ELECTRON_RUN_AS_NODE=1 ELECTRON_NO_ASAR=1 \
  release/mac-arm64/DbCommander.app/Contents/MacOS/DbCommander \
  node_modules/vitest/vitest.mjs run tests/unit
```

The new package's ASAR SHA-256 remains `b126d9862eddd0697fe0feb39c967a7ac3a64559a4272cee547b5c056cfd99fa`; all seven native binaries, the main executable and Electron Framework executable also match the immutable freeze snapshot. The new legal resources change installer bytes; the final candidate's own complete lifecycle report now closes local B08 again.

The fresh eight-hour run **failed**, with runner exit 1 and a failing, non-skipped JUnit case, at cycle 70 / **2,427.933 workload seconds**. It timed out waiting for `Close query tab` after creating a connected scratch tab. Source review found the endurance fixture waited for the Connected label but omitted the existing shorter-soak readiness check: database/schema discovery continues asynchronously and deliberately blocks closing. The fixture now waits for Run SQL to become enabled before requesting close, without weakening the application guard or resource budgets. Failures also retain each workspace's accessible state. The accelerated packaged run passed **117 cycles / 603.179 workload seconds**, runner exit zero and one passing JUnit case with **no skips**, including final rollback, three saved buffers, restart and no automatic reconnect/replay. Evidence: `endurance-accelerated/summary.json`. Its twelve 100,000-row exports passed in **2.500–2.543 s**; cancellation stayed below **107 ms**, typing below **26 ms**, the owned process count stayed at ten and RSS increased **61.0 MiB**. Post-GC heap increases were **3.47, 2.48 and 1.91 MiB**, DOM increases **2, 114 and 228**, and listeners stayed flat. This validates the fixture correction; neither this short pass nor the stopped run meets the eight-hour gate.

The stopped run retained 15 post-GC samples across three windows. First-to-last heap increases were **2.21, 2.07 and 1.52 MiB**; DOM nodes increased **5, 67 and 134**; listener counts remained **380, 380 and 379**. The complete owned process tree stayed at ten processes with an RSS increase of **116.5 MiB** (peak increase 117.3 MiB). Seventy completed cycles recorded cancellation below **107 ms** and typing below **24 ms**. Eight 100,000-row / 7,588,905-byte exports passed content checks in **2.504–2.546 s**. These short-duration trends met the configured budgets, but no final rollback/restart/no-replay pass occurred in this failed run.

Support/private reporting is confirmed as `post@detego.no`; `detego.no` is the selected website, with no qualified beta download path yet. The maintainer confirmed Apple/Windows signing resources and the native Apple Silicon Azure pool are not configured. [Qualification procedures](QUALIFICATION.md) and the [unreleased changelog](../CHANGELOG.md) prepare the remaining human/release work without claiming completion.


The replacement eight-hour run uses that final candidate and the corrected harness from source `785477a`. It started **20 October at 10:08:16 CEST**; eight workload hours elapse at **18:08:16 CEST**, followed by final recovery checks. Its immutable snapshot, receipts and progress are in `.test-artifacts/beta-release-readiness-2026-10-20/eight-hour-retry`. Receipt runner/worker/application processes were verified against this exact path. The existing follow-up now watches only this retry and stays quiet while it is healthy. B09 remains open until the complete duration, successful JUnit/recovery checks and resource/timing trends have actually been reviewed.


## Dependency README notice retention — 20 October 2026

The per-package notice audit (`.test-artifacts/beta-release-readiness-2026-10-20/package-notice-audit.json`) found four npm instances without their own retained notice file. Three keep their licensing text in READMEs that electron-builder 26.15.3 deliberately excludes from copied node modules:

| Dependency | Notice source in the pinned installed package | Retained resource |
| --- | --- | --- |
| `pg-types` 2.2.0 | `README.md`, including Brian M. Carlson's MIT notice | `licenses/pg-types-2.2.0.README.md` |
| `pgpass` 1.0.5 | `README.md`, including Hannes Hörl's MIT notice | `licenses/pgpass-1.0.5.README.md` |
| `railroad-diagrams` 1.0.0 | `README.md`, including its CC0 declaration | `licenses/railroad-diagrams-1.0.0.README.md` |

The fourth, `@napi-rs/keyring-darwin-arm64` 2.1.1, ships no separate license file in its platform npm package. The version-matched `@napi-rs/keyring` wrapper's MIT notice is already retained. This establishes where the declared package notice is carried; native Rust/vendor composition and redistribution review remain open.

Packaging now resolves each README through its actual parent dependency chain, verifies the pinned package name/version, copies the whole file without rewriting it and audits exact source/payload bytes. Inventory generation, staging/promotion verification and installed-payload checks include these resources. A missing mandatory README or changed notice text is rejected. The initial package-copy check preserved all three source files exactly (3,831 / 3,294 / 6,172 bytes); their hashes and runtime equivalence are retained with the generated evidence. The ASAR remains `b126d9862eddd0697fe0feb39c967a7ac3a64559a4272cee547b5c056cfd99fa`, so the independent eight-hour snapshot is not restarted.

**34 focused tests / three files**, **650 full unit tests / 69 files** under development Node 25.9.0 and **650 / 69** under bundled Node 24.21.0 passed. `pnpm package` passed typecheck/build and the actual afterPack audit. The first bundled-Node attempt raced replacement of its executable in `release/mac-arm64` during packaging and failed with worker-spawn ENOENT errors; the corrected run used the immutable `785477a` candidate and passed all 650 tests (`dependency-notices-packaged-unit-final.xml`). This was test orchestration, not a product failure or a waived test.

The new candidate was built from committed source `b3f756fc005d54dd093ac7d026ae2a1048c40e4e` at `release/beta-notice-coverage-2026-10-20-candidate`. Both DMG and ZIP passed actual mount/extract and installed ASAR/native/notice hash checks, without launching a GUI (`dependency-notices-payload.json`). A complete bundle comparison found **all 428 existing file/symlink entries unchanged**, with only the three README resources added. All **128 npm instances** have an identified retained notice source: 124 carry their own, three use the supplemental READMEs and the native keyring package uses the version-matched wrapper notice. The sidecar now retains **136 notice files**; BOM/notice sizes are **115,776 / 20,789,599 bytes**. This is notice coverage for this Mac ARM64 payload, not exhaustive native/vendor composition or redistribution approval.

Full GUI lifecycle tests still wait until the endurance processes have settled. `post-soak-installer-job.json` records the exact candidate/manifest identity, older baseline and test/stage arguments. The follow-up is responsible for running those checks after the soak, then updating B08/B09 with actual results. The older `785477a` lifecycle reports remain valid only for those older installer/sidecar hashes. No local result closes signing or other-platform qualification.

A separate metadata check found the ARM64 app's `LSMinimumSystemVersion` and the actual Electron Framework Mach-O `LC_BUILD_VERSION` both specify **13.0**. This confirms bundle/runtime consistency only: the tested host is macOS 27.0.1, and macOS 13 installation, Intel metadata and supported OS floors still need native qualification.

## Approved security policy and native CI kickoff — 20 October 2026

The maintainer approved the exact root `SECURITY.md` proposal and merging development through PR 131. The policy was committed as `35c6288f57a3f478c85820432a12ad05ce3cbd97`; its SHA-256 is `f3128873314575ecd9b18d577b4fbd49adb8eb59c652d17a1f201178ef0774ce`. It matches the reviewed proposal byte for byte, resolves as the root policy for `src`, and links to the existing support guidance and beta checklist. It introduces no exclusions or severity suppressions. Local policy/link checks passed; this documentation-only change does not alter the packaged runtime or repeat the earlier 650-test qualification.

PR 131 was marked ready and completed through the normal Azure pull-request merge without bypassing policies or deleting development. Main commit **`4e534174e647bd68f831985af265e16a067f0338`** triggered **[CI run 292 / 20261020.1](https://dev.azure.com/detegoprojects/SQL%20Commander/_build/results?buildId=292)** at 10:49 CEST. The authenticated run summary confirms all three available native x64 desktop jobs and the downstream Docker driver stage were selected. Results remain pending; the missing native Apple Silicon pool and signing resources remain independent release gates. No signed release or beta publication was requested. Development was fast-forwarded to the completed merge before recording this evidence.

Receipts are retained under `.test-artifacts/beta-release-readiness-2026-10-20`, including `main-pr-ready.json` and `main-pr-completion.json`. The existing follow-up now monitors this same CI run as well as the single eight-hour retry and deferred installer job. The local soak continues in its immutable snapshot; no competing GUI test or second endurance run was started.

## Embedded runtime inventory — 20 October 2026

The earlier BOM named Electron but omitted its reported embedded library versions and native runtime files outside `app.asar`. Inventory descriptor schema 2 now captures a bounded version probe from the packaged executable, records recognized library components and hashes the actual Mach-O/PE/ELF executable, helpers, frameworks and shared libraries. Installed verification checks those bytes and refuses symlink redirection. Empty/zero version placeholders and ABI/data revisions remain reported properties, not invented software-library identities. Signed qualification/promotion requires the new descriptor; older unsigned schema-1 candidates remain verifiable for their own diagnostic lifecycles.

**656 unit tests / 69 files passed under development Node 25.9.0 and bundled Node 24.21.0.** Regression cases cover all four target layouts, changed/missing runtime libraries, main-executable omission, unsafe paths, symlink aliases/redirection, embedded-version omissions/mismatches, probe environment isolation and legacy/downgrade behavior. The four-layout tests use synthetic files; they do not certify native execution on other platforms.

A real offline audit of the unchanged `b3f756f` Mac ARM64 payload reported Electron **44.7.0**, Node **24.21.0**, Chromium **152.0.7977.130** and SQLite **3.53.4**, with **22 identified embedded library components** and **13 native runtime files**. All installed ASAR/native/runtime/notice hashes verified. Electron reports OpenSSL as `0.0.0` and nghttp3/ngtcp2 as empty; no actual version or absence of an affected implementation is inferred from those placeholders. Evidence is `.test-artifacts/beta-release-readiness-2026-10-20/runtime-inventory-real-payload/audit.json`. The original candidate and its schema-1 sidecars were not modified; a separate compatibility check still verifies them (`runtime-inventory-legacy.json`).

This improves B16 evidence while retaining the BOM's incomplete composition declaration. Native vendor dependencies, exact unavailable versions and redistribution review remain open, as do the signing/native/clean-OS/human/pilot gates. The single live eight-hour snapshot remains unchanged. No competing GUI tests or cloud services were used.

A fresh unsigned DMG/ZIP set built successfully from committed tooling **`c9af97521e077130220ebdb24cbd0ca915ec9613`**, at `release/beta-runtime-inventory-2026-10-20-candidate`. Both formats passed actual mount/extract and installed ASAR/native/runtime/notice verification (`runtime-inventory-payload.json`); no GUI lifecycle was run during the soak. The manifest SHA-256 is `317ab28531b38bdc09c9a06e1188481bcc425ab6f5e36e76c3b837c20eef7fec`. The BOM/notice sidecars contain **136,719 / 20,789,599 bytes**. Complete bundle comparison confirms **all 431 entries unchanged** against the preceding notice candidate, and **all 428 existing entries unchanged** against the live endurance snapshot, with only the three legal README resources added. ASAR remains `b126d9862eddd0697fe0feb39c967a7ac3a64559a4272cee547b5c056cfd99fa` (`runtime-inventory-bundle-comparison.json`).

The deferred `post-soak-installer-job.json` now targets this latest candidate and schema-2 sidecars. The superseded notice-only job is retained separately; it was not falsely marked passed. After the endurance run and its owned processes settle, the follow-up must run the complete DMG/ZIP GUI lifecycles and staging for this exact candidate. Current main CI run 292 predates this tooling change; its results cannot certify the new inventory code on other native hosts.

## Mac framework notice retention — 20 October 2026

Review of the actual Mac bundle identified a further notice gap for Mantle and ReactiveObjC. Their frameworks are present, but the retained Electron `LICENSES.chromium.html` contains neither their named notices nor Mantle's Proton/Bitswift notice. Its Squirrel section already retains Squirrel, Sparkle and bsdiff notices. Framework Info.plist versions include placeholders, so they were not treated as authoritative source versions.

[Electron 44.7.0's DEPS](https://github.com/electron/electron/blob/v44.7.0/DEPS) pins Mantle to `2a8e2123a3931038179ee06105c9e6ec336b12ea` and ReactiveObjC to `74ab5baccc6f7202c8ac69a8d1e152c29dc1ea76`. Their complete upstream `LICENSE.md` files are now vendored without rewriting them, with sizes **2,445 / 1,093 bytes** and SHA-256/source provenance in [the notice mapping](../build/vendor-notices/README.md). Mac packaging copies both under `Resources/licenses/`; the afterPack audit checks pinned source hashes, exact payload bytes and Electron version. Schema-2 Mac notice sidecars require both exact hashes even if an outer checksum is refreshed. An Electron upgrade requires reviewing the new source mapping. Native/vendor composition and redistribution sign-off remain incomplete.

**658 unit tests / 69 files passed under development Node 25.9.0 and bundled Node 24.21.0.** The new cases reject missing/altered payload/source notices, stale Electron mappings and omitted notice records. Source evidence and JUnit/logs are retained under `.test-artifacts/beta-release-readiness-2026-10-20/framework-notice-audit` and `framework-notices-*`. This is a packaging-resource correction, with no source/runtime feature change. The previous schema-2 candidate requires rebuilding to include the notices; its older offline pass does not certify the corrected legal resources.

The rebuilt unsigned Mac ARM64 candidate from **`b9d6ea3d9f5696baaf5c50f3185a7ad8fbf7fd64`** is `release/beta-framework-notices-2026-10-20-candidate`. Its actual afterPack audit, DMG/ZIP build and both mount/extract installed ASAR/native/runtime/notice checks passed (`framework-notices-candidate.log`, `framework-notices-payload.json`). It retains **138 notice files**; BOM/notice sizes are **136,719 / 20,793,529 bytes**. The manifest SHA-256 is `8ef3d949adba7029285419842cbf2ec8193287ab6661f0321d4e14691f8a10f5`.

All **431 previous bundle entries remain unchanged**, with only `Mantle-LICENSE.md` and `ReactiveObjC-LICENSE.md` added under `Resources/licenses/`. Against the live endurance snapshot, all **428 original entries remain unchanged** and only the five legal notice resources differ. The ASAR hash remains `b126d9862eddd0697fe0feb39c967a7ac3a64559a4272cee547b5c056cfd99fa` (`framework-notices-bundle-comparison.json`). The updated deferred installer job targets this exact candidate; the two superseded jobs/reports remain retained as historical evidence. Complete GUI lifecycles and staging still wait until the live soak settles. Main CI run 292 predates these changes and cannot close current cross-platform release qualification.

During that native macOS x64 CI run, the first tray/restart workflow (`system-tray.spec.ts:47`) timed out after 60 seconds, followed by a 60-second worker teardown timeout. The subsequent two tray workflows passed (12.7 / 8.7 seconds). The run is still executing; the retained detailed error and other job outcomes must be inspected before attributing a cause or claiming a fix. No competing local GUI reproduction was started during the live eight-hour run.

## Native Mac fixture cleanup — 20 October 2026

The completed Mac desktop selection in run 292 reports **120 passes, seven unselected diagram skips, two failures and one worker teardown error**, in addition to three passing startup cases. The retained [raw log](https://dev.azure.com/detegoprojects/5a1672e1-a15e-478b-b84d-88638c58f55f/_apis/build/builds/292/logs/20) identifies the whole-profile disk-full failure as `hdiutil detach` refusing a busy private test volume in final cleanup. Its final JSON report was already attached, so the recovery/integrity assertions completed before cleanup failed.

The disk-image helper now retries only an explicit busy refusal, for at most six normal detach attempts with bounded command deadlines and five 500 ms pauses. It never forces eject or hides unrelated/terminal errors; a failed detach still preserves the fixture. Three unit cases cover transient success, bounded exhaustion and immediate propagation of other errors. A real local 32 MiB private image, with a separately owned child holding an open file for two seconds, produced **four busy refusals followed by a successful fifth detach**; the child exited normally and the fixture root was removed. The complete experiment took **2,664 ms** (`detach-retry-real.json`/`.log`). No app GUI or shared host filesystem was exhausted.

All **661 unit tests / 70 files passed under Node 25.9.0 and bundled Node 24.21.0**, and typecheck passed (`native-ci-fixtures-*`, `detach-retry-typecheck.log`). The application and candidate bytes are unchanged. The full GUI disk-full repeat still waits until the live soak settles; this local helper reproduction is not a new native CI pass.

The tray diagnostics artifact includes `restored-workspace.png`, proving the test reached its first restored-workspace screenshot before the timeout, plus a 406-byte error-context file. Its exact stall and any required fix remain under investigation; the screenshot alone does not distinguish normal quit, relaunch or subsequent assertions. The maintainer approved marking PR 132 ready and merging it **after the entire run 292 finishes**, with no signing or beta publication. A failed Mac job alone does not satisfy that timing condition while other jobs remain queued/running.


## Native CI inventory and fixture follow-up — 20 October 2026

The Windows x64 unit job in run 292 found that ASAR reads used portable slash paths directly. The pinned `@electron/asar` reader splits directory names with the host's native `path.sep`; nested dependency manifests therefore failed lookup on Windows. Generation and installed verification now normalize paths at every ASAR read boundary while retaining canonical `/` paths in the sidecars. The existing dependency/notice test also verifies the installed payload, and native fixtures now include a nested path containing spaces, `%`, `#` and Unicode. A local reproduction loaded the pinned ASAR Filesystem implementation with `node:path.win32`: the three portable nested package/notice/native paths failed before conversion and resolved after conversion (`windows-asar-reader-repro.json`). This is a Windows path-semantics reproduction, not native Windows qualification. The unchanged real Mac candidate also passed current installed ASAR/native/runtime/notice verification (`windows-asar-mac-payload.json`).

MySQL and PostgreSQL CI each passed 43 integration cases and failed the shared plan contract because it exported twice to the same existing filename. The application correctly refuses replacement. The test now exports to a second destination, compares complete CSV bytes before/after parameterized plan requests, and retains the value assertions. SQLite and DuckDB reproduced the same original refusal locally and both focused cases pass after the correction (`plan-export-before.xml`, `plan-export-after.xml`; 89 unrelated cases were unselected). Focused real local Docker PostgreSQL, MySQL and MariaDB plan cases also pass (three cases, 129 unselected; `plan-export-server.log`). Only that run's private containers/network were removed; no app GUI, cloud database or unrelated service was used.

The tray restart regression now quits through the real tray menu, which the next two passing native Mac tray cases already exercise, rather than using Playwright's close helper. Quit and relaunch have named steps, quit has a ten-second event deadline, and failure cleanup has bounded debugger-independent fallback for only its owned child process. These changes prevent an unavailable debugger from indefinitely blocking cleanup; they do not yet establish the exact cause or a qualified fix for the original native Mac timeout. The corrected tray GUI test is pending the post-soak fixture run and subsequent native CI.

The Linux native startup test reported `The SQLite worker closed` after the intentionally unavailable DuckDB library. It remains unresolved. On failure only, the fixture now probes a standalone in-memory SQLite worker from its private installation alias and retains bounded stderr, IPC open/close results, timeout and exit status. It never opens the workspace or a user database. Four real child-process unit cases cover success, loader failure, explicit rejection and a stalled diagnostic. A non-GUI probe against the unchanged packaged Mac worker through an alias containing spaces, `%`, `#` and Unicode opened, closed and exited zero (`startup-worker-probe-real.json`); that is not a reproduction or fix of the Linux failure.

All **665 unit tests / 71 files passed under Node 25.9.0 and bundled Node 24.21.0**, and typecheck passed (`native-ci-diagnostics-*`). An initial bundled-Node invocation omitted the previously documented `ELECTRON_NO_ASAR=1` fixture flag and stalled in the virtual-ASAR inventory tests. Its two verified owned CLI processes were stopped and its log retained as `native-ci-diagnostics-packaged-unit-virtual-asar-aborted.log`; the corrected raw-filesystem invocation passed all tests. The independent endurance processes were untouched. Application source, ASAR and candidate bytes remain unchanged.

The exact deferred fixture job now includes startup, tray and disk-full cases, with failure traces, before the full Mac DMG/ZIP lifecycles and staging. It must wait for the single eight-hour retry and its owned processes to settle. Run 292 still has driver jobs queued/running; its failures and pending outcomes keep B11 open. The explicit approval to mark PR 132 ready and merge applies after the **entire** run finishes, through the normal merge path; it does not waive native reruns, signing, the remaining beta gates or authorize publication.


The remaining focused plan cases also pass against real local Docker Oracle and SQL Server, including the experimental Azure profile against the same disposable local TDS fixture (**three cases / two files**, 119 unselected; `plan-export-sqlserver-oracle/integration.xml`). Combined with the embedded and PostgreSQL/MySQL/MariaDB checks above, **eight selected cases cover all seven engines plus the local Azure profile**. The SQL Server container runs under x64 emulation on this ARM64 host; this is contract validation, not native desktop/platform qualification. No live Azure database was used. Native run 292's SQL Server cases (73 pass, two fail) and SQLite case (43 pass, one fail) show the same retained-CSV destination refusal in the shared helper; no additional product defect is inferred from those failures. Their retained step logs are build 292 logs 144 and 128.


## Native Oracle inspection and run 292 completion — 20 October 2026

Run 292 completed failed after **1h 20m 56s**. All three selected desktop and seven selected driver jobs are terminal (`run292-terminal.json`); the maintainer's explicit PR 132 timing condition is satisfied. The remaining MariaDB and DuckDB driver failures are the same retained-plan-export fixture refusal already corrected locally. Oracle reports **45 passes / two failures**: that fixture and a new **8,130.725 ms** large-catalog table inspection against the unchanged **5,000 ms** guard (retained raw log 176). No installer or native-platform pass is inferred from failed jobs.

A fresh local Oracle 23.26.3 fixture reproduced the expensive work, while passing its timing guard: cold inspection took **2,464.181 ms**, including **851.972 ms** for the broad foreign-key dictionary join. Metadata already returned complete constraints and key positions for the selected table. Inspection now reuses that metadata for self-referencing primary/unique keys, preserving exact composite-key order, referenced owner/table/column and delete behavior. A complete empty reference list also avoids the join. References to other tables/owners, missing/mismatched positions or truncated metadata retain the original bound native lookup. The optimization adds no persistent cache or extra connection and changes no privilege scope, transaction or preview limits.

The same cold 1,300-table / 2,105-overflow fixture on this Mac ARM64 host now inspects in **1,509.998 ms**, approximately **39% lower**. Refresh and overflow refresh took **1,009.726 / 708.239 ms**, with the existing catalog bounds and transaction assertions intact (`oracle-catalog-profile`, `oracle-catalog-self-after`). Optional test-only query tracing was loaded from an ignored local fixture; it changes no packaged code and records no bind values. Native x64 timing remains unqualified until CI repeats the unchanged five-second guard.

Eight new unit cases cover complete empty reference lists, exact quoted/composite self-reference metadata, other owners/tables, missing positions and both constraint/key truncation. All **673 unit tests / 71 files pass under Node 25.9.0 and bundled Node 24.21.0**, and typecheck/build pass (`oracle-self-final-*`). All **47 final Oracle integration contracts pass with no skipped cases**, including rich/cross-owner metadata, the large catalog, plans, native backup/restore, TLS/SSH refusal paths, cancellation and transaction preservation (`oracle-self-final-full/integration.xml`). Its table inspection took **1,576.033 ms**. Intermediate owned-view experiments are retained only as diagnostics; the final implementation reuses already loaded self-reference metadata and keeps the original lookup for other references.

The application ASAR must now change. The running `785477a` eight-hour snapshot is deliberately untouched and remains useful evidence for its original runtime; it cannot close B09 for this correction. B07–B09 have been reopened as applicable. The former deferred installer job is marked `doNotExecute` pending an immutable rebuilt candidate and replacement manifest/ASAR identity. Current and historical lifecycle/soak reports must not be reused to certify changed runtime bytes. No competing local GUI or second endurance run was started.


The corrected runtime was committed/pushed as **`8cb9a7da219be9a42c941707ceda3723d67db260`** and rebuilt at `release/beta-oracle-inspection-2026-10-20-candidate`. The unsigned DMG/ZIP build, afterPack audit and both actual mount/extract installed ASAR/native/runtime/notice checks pass (`oracle-self-candidate.log`, `oracle-self-payload.json`). Its manifest SHA-256 is **`206a035df504af31b6235b078229d512153388dc22363be2d00fbbf25f504f33`**; ASAR SHA-256 is **`f00fcb82815fbe0f1716e126efcc6a737fcb937defdf1661e23b2993bf5e0edb`**.

Of 433 bundle entries, 431 remain unchanged against the prior framework-notice candidate. Only `app.asar` and its generated `Info.plist` ElectronAsarIntegrity field differ; the new integrity value was independently checked against the ASAR header hash. All executable/native/library/notice bytes are unchanged (`oracle-self-bundle-comparison.json`). This closes the rebuilt local packaging part of B06, with **B07–B09 still open**. The replacement deferred job runs the full packaged regression selection, preserves its results before the Oracle GUI runner clears its output, checks the affected packaged Oracle catalog workflows, then runs exact DMG/ZIP lifecycles and staging. It waits for the existing soak and owned processes to settle. A successor eight-hour run on these new bytes requires authorization under the earlier explicit instruction not to start a second run; none was started.


After all ten selected jobs in run 292 were terminal, approved **PR 132** was marked ready and completed through the normal merge path into main **`a49bc454f116ed2d8d744f6f223f55deffdb8b37`**, with source **`f41071633a6b72333619ae65a0f67ce856a73ea5`**. The completion receipt records `succeeded` at **12:33:09 CEST**, with no policy bypass or development deletion. Development was then fast-forwarded/pushed to that merge. Authenticated Azure UI confirms **[main CI run 293 / 20261020.2](https://dev.azure.com/detegoprojects/SQL%20Commander/_build/results?buildId=293)** is running on that exact main commit. Native desktop and seven-driver results remain pending; missing native Apple Silicon/signing/human/reference-hardware/pilot gates are independent. Receipts are `runtime-pr-ready.json`, `runtime-pr-completion.json` and `ci293-start.json` under the retained readiness evidence. No signing or beta publication was enabled.

The maintainer answered **“Finish current run only”** to the proposed successor eight-hour qualification. The job is now explicitly declined; no successor is authorized or will be launched under this instruction. The existing old-runtime run continues unchanged, and B09 for the rebuilt runtime remains open. Native CI, full packaged/Oracle GUI and installer checks continue within their existing scope.

### Native package provenance — 20 October 2026

An isolated installation of the current Mac ARM64 candidate's three native npm packages, with lifecycle scripts disabled and no project dependency changes, passed `npm audit signatures --json --include-attestations` under npm 11.18.0 / Node 25.9.0. The result contains no invalid or missing registry signatures. All **seven unpacked native files** match both their fresh registry payload and current candidate SBOM SHA-256 values: DuckDB's addon/library, keyring's addon and the four platform binaries distributed in `oracledb@26.0.0`. This compares the files actually shipped in this Mac candidate; it does not qualify other target packages.

Verified SLSA provenance identifies `@duckdb/node-bindings-darwin-arm64@1.5.6-r.1` with source commit **`289ed744f72010122b4eb35f7abb8bb2d376f4ba`** and `@napi-rs/keyring-darwin-arm64@2.1.1` with **`97aa4e0412a0ba8a0d47541cebe0474eea5efe02`**. The pinned upstream [DuckDB workflow](https://github.com/duckdb/duckdb-node-neo/blob/289ed744f72010122b4eb35f7abb8bb2d376f4ba/.github/workflows/DuckDBNodeBindingsAndAPI.yml) and [keyring workflow](https://github.com/Brooooooklyn/keyring-node/blob/97aa4e0412a0ba8a0d47541cebe0474eea5efe02/.github/workflows/CI.yml) are retained with hashes. Oracle's package has a verified registry signature; no provenance attestation was returned for it. Verification uses npm's [signature/provenance audit](https://docs.npmjs.com/cli/commands/npm-audit/), rather than treating the presence of an attestation URL as verification.

A fixed CLI probe loaded DuckDB from the actual candidate ASAR into an isolated in-memory database with extension autoload and autoinstall disabled. It reports **DuckDB v1.5.6, source ID `069cc9f9b5`**, with five statically linked extensions (`autocomplete`, `core_functions`, `icu`, `json`, `parquet`, each reporting v1.5.6). Those are DuckDB extension versions, not the underlying vendor library versions. No Cargo-auditable dependency section was found in keyring's Mach-O sections, and its pinned source has no committed Cargo lockfile. Neither package provenance nor these observations establish the complete Rust/C++ vendor graph or redistribution approval; **B16 remains open**.

Evidence is retained under `.test-artifacts/beta-release-readiness-2026-10-20/native-provenance-audit/`: the isolated lockfile and command receipt, complete verification output, seven-file comparison in `summary.json`, pinned upstream source receipts, Mach-O load commands and actual packaged DuckDB probe. The candidate ASAR remains **`f00fcb82815fbe0f1716e126efcc6a737fcb937defdf1661e23b2993bf5e0edb`**. No packaged bytes, credentials or running GUI tests were changed.


### Native CI 293 follow-up — 20 October 2026

Native main run 293 (`a49bc454`) reports **120 Mac desktop passes / two failures / seven unselected-engine skips**. The formerly failing tray restart passes (16.7 seconds). Guarded OS/application Quit reaches the transaction prompt but leaves its window invisible/minimized after cancellation. Restoration now runs at `before-quit`, before native window closing begins; tray Quit uses that same path. Two unit cases cover early restoration across workspaces and closed-window exclusion. The unchanged five-second native visibility guard still requires a GUI repeat; this is not yet a native-qualified fix.

The large whole-profile disk-full case completed its recovery assertions and attached its report, then cleanup failed because the mount was already absent. Cleanup now accepts that specific error only after bounded `hdiutil info`/`plutil` inspection proves both the exact owned image and mount absent. Busy retries remain bounded, other errors propagate, and no forced eject is used. A real private 32 MiB image verified attached identity, was detached normally, then passed already-absent cleanup and private-root removal (`detach-absent-real.json`). Raw Mac log: build 293 / log 20; receipt `ci293-mac-failures.json`.

Windows run 293 units report **650 passes / ten failures / 13 intentional skips**, before packaging/startup/NSIS. Their common failure is a pinned Mantle notice hash mismatch. A real Git checkout with `core.autocrlf=true` reproduces changed bytes for the three vendored notice texts. The new `.gitattributes` rule preserves exact upstream bytes; the regression proves identical checkout bytes with the rule, without relaxing hashes. Native Windows repetition is pending. Raw Windows log: build 293 / log 44; receipt `ci293-windows-failures.json`.

Binary source paths also identify `anyhow 1.0.104`, `apple-native-keyring-store 1.0.2`, `core-foundation 0.10.1`, `keyring-core 1.0.0`, `napi 3.14.2` and `security-framework 3.7.0` in the current Mac ARM64 credential binding. Versioned crate archives were checked against registry checksums. Complete upstream license texts are vendored with source/hash provenance; napi's omitted license comes from its archive's precise VCS commit and retains both copyright notices. Package-version, binary-hash and notice-hash guards require review after changes. The supplemental notice is copied outside ASAR, included in the sidecar, required by current schema-2 verification, and checked in the installed payload. Earlier schema-2 Mac ARM64 candidates lacking it remain historical evidence. This is a partial inventory for the inspected target; full vendor composition and redistribution review remain B16. See [pinned sources](../build/vendor-notices/README.md).

All **682 unit tests / 74 files pass under Node 25.9.0 and bundled Node 24.21.0**, with typecheck/build passing (`native-beta-verified-*`, `tray-guard-build.log`). Full packaged GUI, affected Oracle catalog GUI and exact installer lifecycles must wait for the existing soak to settle. The new runtime cannot inherit the old eight-hour result; the maintainer's **“Finish current run only”** decision remains binding, so B09 stays open and no successor will launch.

The current immutable candidate is `release/beta-native-ci-2026-10-20-candidate`, source **`19018e5e93726fed150fd0aedd283e48cb5df1c1`**, manifest SHA-256 **`dada52ddfce9dc97930c0485ba272541457c91b4ee7c30e41a15a0fa4514cb5b`**, ASAR SHA-256 **`cc508ad546f182255d9a7929b882e970baffed4dc8e7dc10d9a769d8f216d7fc`**. Actual DMG mount/copy and ZIP extraction both pass installed ASAR/native/runtime/notice verification, including the new supplemental notice and **139 indexed notices** (`native-beta-payload.json`). All 434 bundle entries match the preceding tray-fix build; the final inventory/checkout correction changes no packaged application bytes (`native-beta-candidate-identity.json`). The replacement deferred job targets these exact hashes and retains regression results before the Oracle runner clears its output. It must not execute superseded jobs or start a successor soak.


### Native target attribution and Linux CI follow-up — 20 October 2026

Static inspection now covers the exact pinned credential packages for Intel Mac, Linux x64 GNU and Windows x64 MSVC as well as the earlier Apple Silicon package. All additional registry signature/provenance checks pass, their package integrities match the project lockfile, and each provenance claim identifies source `97aa4e0412a0ba8a0d47541cebe0474eea5efe02`. Foreign-platform packages were inspected only in ignored evidence trees with scripts disabled; their native code was not executed. Evidence is under `native-provenance-targets/`.

Versioned binary source paths identify **six crates on each Mac architecture, 39 on Linux and ten on Windows: 49 distinct crate versions**. Complete versioned crate license texts are now retained per target. This includes both AES versions on Linux, the extra `UNLICENSE` texts, and napi-sys's omitted license from its precise VCS commit. Package-version, original-native-binary and notice hashes still require exact matches; the real builder hook keeps every audit enabled. Test fixtures isolate unrelated audits explicitly and verify that the default hook refuses a missing native notice source. The CRLF checkout regression verifies exact bytes for all six vendored notice files, including mixed-newline source texts. This is positive partial Rust identification, not a complete feature graph, statically linked C-library inventory, legal approval or native platform pass. B16 remains open.

All **684 unit tests / 74 files pass under Node 25.9.0 and bundled Node 24.21.0**, and typecheck passes (`native-vendors-*`). The application source is unchanged. Fresh unsigned Mac ARM64 packaging and both actual DMG/ZIP installed payload checks pass, with **all 434 bundle entries byte-identical** to the preceding candidate and the same ASAR `cc508ad546f182255d9a7929b882e970baffed4dc8e7dc10d9a769d8f216d7fc` / 139 notices. The deferred job is rebound to the latest exact manifest; no competing GUI run or new soak was launched.

Native run 293 MySQL integration now passes **all 44 contracts**. Its desktop selection has **111 passes / eight failures / 215 intentional unselected-engine/platform skips** (raw log 69; `ci293-mysql-failures.json`). Failures are connection-dialog backward focus, the old single-click table-SQL expectation, two duplicate-launch cases with null exitCode (signals/stderr unobserved), typing at **2,067.781 ms against the unchanged 2,000 ms guard**, and three minimize/tray cases. The first tray failure cannot minimize even with tray disabled. The CI command starts Xvfb without a window manager; native minimize/focus prerequisites are the first investigation. Other failures need separate contract/diagnostic review; no product or fixture cause is assumed from these results, and the timing budget is not relaxed. The separate packaged Linux startup/installer job and remaining drivers are still pending/running.

Latest candidate: `release/beta-native-vendors-2026-10-20-candidate`, source **`e39d8db00f8caacd33d7fd22a67038251b2f10f4`**, manifest SHA-256 **`e900836fdf54628d63b8f2c02cc4854986e3677f419fd55e08e7f8ad906245d8`** (`native-vendors-candidate-identity.json`, `native-vendors-payload.json`). The existing b126 eight-hour snapshot remains untouched. Its result cannot certify the cc508 runtime, and the explicit **“Finish current run only”** decision still prohibits a successor.


### Linux Unicode startup and desktop harness — 20 October 2026

Native Linux run 293 passes basic packaged SQLite/DuckDB checks, then reports **two startup passes / one failure**. Its retained worker probe exits 1 with MODULE_NOT_FOUND below `Application with spaces % # é/resources/app.asar/out/main/sqlite-worker.cjs` (raw log 89; `ci293-linux-failures.json`). A CLI reproduction using the checksum-verified pinned Linux x64 Electron 44.7.0 payload confirms plain, spaces, percent and hash paths pass; non-ASCII paths fail both direct ASAR entry and require. This is x64 emulation on Mac ARM64, with no display server: diagnostic evidence, not native Linux qualification.

Release builds now generate a self-contained SQLite child worker at physical `resources/workers/sqlite-worker.cjs`, with only Node builtin requires. Packaged path resolution selects that file; development and explicit integration worker overrides remain supported. All six physical-path variants open/close in-memory SQLite and exit 0 under normal Electron ASAR behavior. Schema-3 inventory binds its size/hash and application dependency; installed verification rejects missing/altered code and parent/leaf symlinks. afterPack checks the copy against the build output. Historical unsigned schema-1/2 evidence remains readable, while signed qualification/promotion requires schema 3.

Native PostgreSQL run 293 passes **44 integration contracts**, then **116 desktop passes / six failures / 212 intentional unselected/platform skips** (log 112; `ci293-postgres-failures.json`). These share the MySQL backward-focus, two duplicate-launch and three minimize/tray failures; PostgreSQL has no typing failure. Linux CI now starts Openbox on its owned private Xvfb display and waits for readiness. CLI unit fixtures verify exit propagation, refusal of an existing manager, interruption and owned-child cleanup; actual Linux GUI repeats remain pending. The duplicate launcher mirrors only the owner's actual sandbox switch, drops NODE_OPTIONS like Playwright, and retains bounded stderr/signals/spawn errors. The connection-dialog fixture waits for engine discovery; MySQL chooses the existing Append SELECT menu item after its table click. Large-catalog tests retain the 2,000 ms typing budget and separate input/persistence diagnostics. No native performance pass is inferred.

Installed launch tests now explicitly request Chromium sandboxing and verify the actual launch switch. Earlier Playwright defaults silently added no-sandbox on Linux despite empty arguments. The existing disposable Fedora RPM exception requires both CI and disposable-container markers and is reported explicitly; host sandbox settings are untouched. Correct native installed sandbox qualification remains open.

All **698 unit tests / 78 files pass under Node 25.9.0 and bundled Node 24.21.0**, with typecheck/build and **44/44 full SQLite Docker contracts** passing. The initial bundled unit invocation was stopped after Electron's virtual ASAR layer stalled a raw-archive fixture; the complete repeat uses ELECTRON_NO_ASAR=1 and passes. The separate six Linux physical-worker probes use normal ASAR behavior. Evidence: `physical-worker-*`, `linux-asar-cli/results.json`, `linux-asar-cli/physical-results.json` under the retained readiness directory. Fresh packaging/offline checks now pass as recorded below. Full packaged/affected-driver GUI and lifecycles wait for the sole historical b126 soak to settle. Its result cannot certify the new runtime; **Finish current run only** still prohibits a successor. No later main merge was authorized.


Fresh unsigned Mac ARM64 candidate: `release/beta-physical-worker-2026-10-20-candidate`, source **`5483564dc178df4b21535d5efce4c819b73a28ea`**, manifest SHA-256 **`4179af33882d2271fe3abbd485674bd7ed735618b582ebf9ec56f46b0eafcafc`**, ASAR **`0a64deada2f06125878c26d2d6af5eb9dea985448c815ef84177e1d0e1a052e8`**. Both actual DMG mount/copy and ZIP extraction pass all schema-3 installed payload checks, native notice audit and worker IPC open/close from `Application with spaces % # é`. The physical worker is **303,692 bytes**, SHA-256 **`5b73467b0ff31e1eb8532019e05fc3edd1bd73ebdd84c383dc7b42e90a345c01`** (`physical-worker-payload.json`, `physical-worker-candidate-identity.json`). This is offline/CLI validation; full GUI/lifecycles remain pending.

The superseded `e39d8db` job is retained with doNotExecute set. The replacement deferred job binds the above candidate and retains each report before the next Playwright run clears output. In addition to full packaged regression and Oracle catalogs, it schedules the affected MySQL/MariaDB connection, rich-catalog and large-catalog workflows before DMG/ZIP lifecycles/staging. The MySQL/MariaDB connection fixture now honors SQLCOMMANDER_TEST_EXECUTABLE, so the repeat exercises these exact packaged bytes. The job must wait for the historical soak and owned processes to settle; successor endurance remains explicitly disabled.


### SQL Server native contracts and table-action fixture review — 20 October 2026

Native x64 run 293 SQL Server/local Azure-profile integration passes **75/75 contracts**. Desktop reports **139 passes / eight failures / 187 intentional unselected/platform skips** in 19 minutes (raw log 128; `ci293-sqlserver-failures.json`). Six failures repeat the known focus, duplicate-launch and minimize/tray cases. The two engine-specific failures expect clicking a table to replace the SQL buffer; current UI correctly opens its action menu and preserves the welcome SQL. This is local TDS/profile coverage, with no live Azure database or cloud certification.

The connection fixtures now explicitly clear only their own sample/setup buffer and choose Append SELECT from the table menu. Reviewing the same pattern also corrected SQLite/DuckDB fixtures, where appending to setup DDL would otherwise replay CREATE TABLE, and strengthened the earlier MySQL/MariaDB fixture correction. Oracle already clears its fixture buffer and checks that a table click preserves authored SQL. SQL Server and SQLite launchers now honor the exact packaged-executable option. No application runtime or installer bytes changed; the verified `5483564` / `0a64dea` candidate remains current.

Typecheck passes and Playwright discovery confirms **13 intended connection/catalog workflows** across the affected fixtures. GUI execution remains deferred until the sole historical soak and its owned processes settle. The bound job additionally schedules two embedded SQLite/DuckDB workflows and five SQL Server/local Azure-profile workflows, with separate reports and retained results. Existing full-unit/SQLite-contract/offline payload evidence remains applicable to unchanged runtime bytes; this fixture review does not claim a GUI pass or relax any guard.


### Lifecycle evidence gates — 20 October 2026

CLI regression fixtures reproduced **six failures** in the release tools: staging accepted failed, incomplete, wrong-identity, wrong-artifact or sandbox-unproven lifecycle reports when their inventory matched; a failed rerun also retained an earlier passing report. Staging now shares promotion's exact identity/artifact/inventory/upgrade/complete-format validation. Both require explicit recorded sandbox policy: enforced for Linux DEB/AppImage, enforced or the existing disposable-container exception for RPM, and platform-default on Mac/Windows. Current candidate staging requires schema 3; unsigned historical inventories remain available for baseline diagnostics. A new installer attempt invalidates its prior report before installation, so a failure cannot leave that previous pass as current evidence.

All **704 unit tests / 79 files pass under Node 25.9.0 and bundled Node 24.21.0**, with zero failures/errors/skips, and typecheck passes. The 44 focused release tests cover actual sidecar staging, all four synthetic target promotions, the malformed/failed report cases, Linux sandbox mode combinations and an injected installer failure before any application launch. Evidence is `lifecycle-gate-before.log`, `lifecycle-gate-after.log`, both `lifecycle-gate-unit-node*.xml` and `lifecycle-gate-summary.json` under the retained readiness directory. These are CLI/report regressions; they do not claim native installer qualification.

Application source and installer bytes are unchanged: the verified `5483564` candidate still has manifest `4179af33882d2271fe3abbd485674bd7ed735618b582ebf9ec56f46b0eafcafc` and ASAR `0a64deada2f06125878c26d2d6af5eb9dea985448c815ef84177e1d0e1a052e8`. Deferred GUI/lifecycles use the strengthened tools after the sole historical soak settles. No additional desktop/endurance run or main merge was started.


### Native review package and MariaDB result — 20 October 2026

[Draft PR 133](https://dev.azure.com/detegoprojects/SQL%20Commander/_git/SQL%20Commander/pullrequest/133) now collects development's native startup/guarded-Quit fixes, installed sandbox and release-evidence gates, managed Linux test prerequisites, corrected connection fixtures and pinned native notices. Its creation was verified against source `685336a2dc882ada24f69da54841ce986bd0ea47` and main `a49bc454f116ed2d8d744f6f223f55deffdb8b37`: active, draft, auto-completion unset. It is not merged and does not authorize a new main merge. Full pending local GUI/lifecycles and a separate maintainer approval remain required. Receipts are `native-fixes-pr*.json`.

Run 293 native MariaDB integration passes **44/44 contracts**. Its desktop selection reports **114 passes / six failures / 213 intentional unselected/platform skips** in 14.5 minutes; the job completed failed in 17m13s (raw log 144; `ci293-mariadb-failures.json`). Failures are the known table-action expectation, two duplicate launches and three minimize/tray cases. The dialog-focus and large-catalog typing checks pass in this selection. These results predate the fixes and do not qualify current development; affected local packaged and native repeats remain pending. Refreshing Azure's page was necessary to discard a stale Running counter after the job had completed. SQLite is the next running native driver, with Oracle/DuckDB queued. The existing soak is still progressing on its unchanged historical snapshot; no successor was started.


### Managed desktop process-group cleanup — 20 October 2026

Two real CLI regressions reproduced inherited helpers surviving a test-runner exit or cancellation. The wrapper had treated the parent exit as complete cleanup, even when a helper ignored TERM with no inherited pipes. Cleanup now waits for the captured detached child's private POSIX group, escalates after a bounded grace period, and verifies termination; persistent permission errors remain failures. The outer Linux wrapper allows the inner command/manager cleanup to finish before escalating its own group. Deadlines use a monotonic clock.

Seven focused CLI cases pass, including the two formerly failing helper cases, an unaffected bystander and nested cleanup. Executable shell/Node stand-ins exercise the actual nested wrapper without an X server, real window manager or GUI. Failed-regression cleanup checks the helper receipt PID and canonical unique script path before signalling it; all fixture helpers are removed. The initial receipt comparison needed macOS /var → /private/var canonicalization; that fixture error is retained separately from the two actual helper-survival failures.

All **707 unit tests / 79 files pass under Node 25.9.0 and bundled Node 24.21.0**, with zero failures/errors/skips; typecheck passes. Evidence: `desktop-groups-before.log`, `desktop-groups-after.log`, both `desktop-groups-unit-node*.xml` and `desktop-groups-summary.json` under the retained readiness directory. Expected synthetic cancellation output is not a stopped product run. App/installer bytes remain the verified `5483564` / `0a64dea` candidate. Native Linux GUI qualification is still pending. The sole existing historical soak remains unchanged; no successor was started.


### Linux credential C-vendor notices — 20 October 2026

Static inspection of the exact registry-signed/provenance-verified Linux keyring binary finds the embedded `libdbus 1.14.4` string and vendored C implementation paths; its ELF dependency list has no external libdbus. The pinned keyring source enables the vendored DBus feature. These observations support identification of a statically included C library, without executing the foreign binary or querying any credential service.

The checksum-verified `libdbus-sys 0.2.7` reference archive pins DBus 1.14.4. Its 47 reference C build files, 71 library headers and COPYING match the official DBus 1.14.4 archive byte for byte. That carrier version is not asserted as the Rust wrapper version in the native build. The Linux notice bundle now retains the complete official COPYING/AUTHORS and all 118 original leading notice headers, with per-file/hash provenance. The full COPYING's alternative terms and per-file qualifications remain intact; no license choice, complete vendor graph or redistribution approval is implied. Verbatim upstream whitespace is intentionally retained.

All **708 unit tests / 79 files pass under Node 25.9.0 and bundled Node 24.21.0**, with zero failures/errors/skips; typecheck passes. Thirty focused notice/inventory/real-Git-CRLF cases pass, including exact retained C notice/header hashes. Static evidence, registry/source receipts, comparison, JUnit and `summary.json` are under `native-c-vendor-audit/` in the retained readiness directory. Linux's complete notice file is **572,064 bytes**, SHA-256 **`a9deb315df0fc1ed00b0d93c6d965da959d3044eef71510491225c58d4ba9010`**, still bound to native binary **`7d84b249ad5092a251f374e89f79844e662009f7df5b43d4ce4298e47c351b03`**.

Only Linux legal resources change. Current Mac ARM64 candidate `5483564` remains byte-identical and passes actual installed inventory verification under the updated mapping (`mac-payload-unchanged.json`): manifest `4179af33882d2271fe3abbd485674bd7ed735618b582ebf9ec56f46b0eafcafc`, ASAR `0a64deada2f06125878c26d2d6af5eb9dea985448c815ef84177e1d0e1a052e8`. New Linux packaging/native execution, full vendor composition and redistribution review remain open. The sole historical soak is untouched and no successor/GUI run was started.


### Oracle metadata overlap and completed native matrix — 20 October 2026

Native run 293 has finished. SQLite integration passes **44/44**; its desktop selection has **109 passes / seven failures / 218 intentional unselected/platform skips** (log 160). DuckDB integration passes **47/47**, with **110 desktop passes / seven failures / 217 selected skips** (log 192). Both share the known focus, duplicate-launch, table-action and minimize/tray cases. Their table failures precede later transaction assertions and are addressed by the existing explicit Append SELECT fixture correction; they are not evidence of a transaction-engine failure. Current native repetition remains pending.

Oracle integration reports **46 passes / one failure**, with no desktop execution (log 176). Large-catalog inspection took **5,677.608 ms against the unchanged 5,000 ms guard**. Local profiling identified independent cold native DDL and constraint-query costs. SQL/PLSQL and row-limiting variants did not eliminate cold initialization; their apparent repeated-query speedups were cache effects. The selected correction overlaps the full native definition with required metadata sections on one optional temporary connection, separate from both the original catalog reader and console session. Owner validation, query/output bounds, all detail sections, native DDL and transaction isolation remain intact. Catalog-only, constraint and materialized-view paths retain one metadata reader. A server connection/session-limit or initialization failure retains serial inspection. A shared deadline, pending-query drain and all-reader cleanup bound the additional resource, including section failures and synchronous close errors. There is no query replay or new connection pool.

| Local Oracle 23.26.3.0.0 fixture | Inspection | Refresh | Overflow refresh |
| --- | ---: | ---: | ---: |
| Fresh serial baseline | 1,650.982 ms | 1,051.989 ms | 716.497 ms |
| Fresh focused parallel run | 1,189.975 ms | 991.341 ms | 670.708 ms |
| Full 47-contract parallel run | 1,230.797 ms | 1,050.968 ms | 698.462 ms |

These independently created local fixtures retain 1,300 initially visible tables and the bounded 1,994-table overflow preview. The full run improves inspection by **25.45%** relative to the fresh baseline and passes all **47 contracts** with no failures/errors/skips, including rich metadata, transactions, exact values, cancellation and recovery. These M5 Pro/64 GiB measurements do not qualify the failed native x64 worker or B10 minimum hardware. Eleven new unit regressions exercise read overlap, bounded LOB draining, optional-reader connection/initialization fallback, the common deadline, metadata/definition failures, forged owner rejection, unchanged serial object paths and all-reader cleanup.

All **719 unit tests / 80 files pass under Node 25.9.0 and bundled Node 24.21.0**, with zero failures/errors/skips; typecheck/build pass. The bundled CLI suite uses ELECTRON_NO_ASAR=1 for raw-archive fixtures; actual installed worker probes retain normal ASAR behavior. An initial bundled unit invocation without raw-archive mode was stopped and is not counted as a pass. Evidence is `oracle-native-followup-before/`, `oracle-native-parallel-after/`, `oracle-parallel-full/`, `oracle-parallel-unit-node25-final.xml`, `oracle-parallel-unit-node24-raw.xml` and `oracle-parallel-summary.json` under the retained readiness directory.

Fresh immutable unsigned Mac ARM64 candidate: `release/beta-oracle-parallel-2026-10-20-candidate`, source **`2e386b5768b066c99deedec336464d0392a8fdb6`**, manifest SHA-256 **`f7f0a18255b635d5eadf699b2e64bd3a9a4210c1d7bf91f34e6fb960542abfa0`**, ASAR SHA-256 **`1722c1dca64020f44d2f874ae6b543d532421363e2c7646d5cfbfa18b14abbb9`**. DMG mount/copy and ZIP extraction both pass installed schema-3/native/runtime/notice/physical-worker verification, plus native SQLite worker open/close from a path containing spaces, percent, hash and non-ASCII text (`oracle-parallel-payload.json`). These are offline/CLI checks, not full GUI/lifecycle qualification.

The deferred job now targets these exact hashes and a fresh `oracle-parallel-post-soak/` evidence tree; the older physical-worker job is archived with execution disabled. GUI/driver/lifecycle checks must wait until the existing b126 soak and its verified owned processes settle. No competing desktop test, successor soak or main merge has started. The maintainer's **“Finish current run only”** decision remains binding; B09 stays open for the changed runtime. Draft PR 133 requires local qualification and separate maintainer approval before any later main merge.


### DuckDB native source notices — 20 October 2026

Static inspection now covers both DuckDB binaries in all four release-target packages. All four `@duckdb/node-bindings-*` 1.5.6-r.1 packages and `node-addon-api` 8.8.0 pass registry signature/provenance verification, with no invalid or missing signatures. Native package integrities match this project's lockfile; the header dependency matches the verified binding source lockfile. Binding provenance resolves to `289ed744f72010122b4eb35f7abb8bb2d376f4ba`, whose fetch/build rules use the official DuckDB 1.5.6 archives and pinned addon headers. The Mac universal, Linux x64 and Windows x64 library bytes match those official archives exactly, including release asset digest checks. Foreign native code was never executed; collection used an isolated ignored project with lifecycle scripts disabled.

The matching DuckDB source revision `069cc9f9b5be802405797faecc284961b07c70ef` also matches the version/source ID previously reported by the actual packaged Mac library. Its **32 complete standalone notice files** are retained verbatim, including the multi-part ICU license, RE2 AUTHORS and tdigest NOTICES. The combined **135,830-byte** source-notice resource has SHA-256 **`f74ccfe507ed83f5d2f49773f2945243dfc0a9a2abaa7a0d8ddfe8f02a5f4a09`**. The separate full **1,150-byte** node-addon-api 8.8.0 license has SHA-256 **`89024017b88a9f2b763f79b941a4f2db3b4428edfcacdc0b23866b2da633ad0c`**. [Provenance and scope](../build/vendor-notices/README.md#duckdb-library-and-node-binding-header-notices) include source/archive/per-file digests and eight target-specific native binary bindings. These are conservative source notices, not an assertion that every named component is linked on every target. Complete compiled features, embedded per-file notice coverage and redistribution approval remain B16.

Packaging copies both resources outside ASAR and requires exact native package versions, both reviewed binary hashes and notice bytes. The installed sidecar and existing afterPack checks cover them. A new source-byte regression covers all eight mappings; the inventory corruption/removal test now exercises every required target notice, including both DuckDB files. The real Git checkout regression also checks their bytes with Windows CRLF conversion enabled. All **41 focused tests** pass.

All **720 unit tests / 80 files pass under Node 25.9.0 and bundled Node 24.21.0**, with zero failures/errors/skips; typecheck passes. Application code is unchanged, so the preceding build and full 47 Oracle contract results remain applicable to the identical ASAR. Fresh unsigned Mac ARM64 candidate `release/beta-duckdb-notices-2026-10-20-candidate` is from **`a1fa4097f4d3a15ab0050926bcb6e5bd82ba4334`**: manifest SHA-256 **`10129c491650f0526cd1a19690b8823bd459f33359f56e478307e281a7e38ef7`**, unchanged application ASAR **`1722c1dca64020f44d2f874ae6b543d532421363e2c7646d5cfbfa18b14abbb9`**. Actual DMG mount/copy and ZIP extraction both pass schema-3/native/runtime/all-notice/physical-worker verification and native worker open/close from the Unicode path. This is offline/CLI qualification, not native GUI or installer lifecycle certification.

Receipts, official/source archives, decoded registry source claims, lockfile comparison, eight-file hashes, unit JUnit, `summary.json`, `payload.json` and `candidate-identity.json` are under `.test-artifacts/beta-release-readiness-2026-10-20/duckdb-vendor-audit/`. The deferred job targets the new exact manifest and fresh `duckdb-notices-post-soak/` results. Its superseded Oracle-parallel job is archived with execution disabled. The single historical soak remains untouched; no competing GUI, successor endurance run or main merge has started.


### Native software evidence inventories — 20 October 2026

The release SBOM previously retained native file hashes and complete reviewed notices without exposing the positively identified native libraries as software components. Schema **4** now records known Rust crate, libdbus, DuckDB and addon-header identities, Cargo/npm/generic package URLs, source archive digests, original native source digests and notice paths. It connects those constituents to actual native-file references, the owning packaged npm instance and ASAR references. Target counts are **eight on each Mac architecture, 42 on Linux x64 and 12 on Windows x64**. DuckDB's source-notice superset is not converted into inferred ICU/RE2 versions, and the Linux reference carrier does not become an asserted libdbus-sys wrapper version. Unreviewed native bytes remain hashed file components, with unknown software identities unclaimed.

Verification rejects missing/altered identities or source hashes, omitted native files, missing constituent/package/ASAR links and contradictory complete-composition claims. Flat constituent links do not reconstruct the unresolved Cargo/C++ transitive graph. Application, native files and known native constituents explicitly retain incomplete composition. Unsigned reviewed native files must match pinned source bytes exactly. For signed Mac/Windows output, the source audit precedes signing and the build verifies actual signed output; the SBOM separately retains original and final file digests and labels signed payloads without asserting byte identity or the cause of each changed byte. This signing-path behavior has schema/unit coverage only; actual signing/native qualification remains open.

Current staging and signed promotion require schema 4. Earlier unsigned profiles remain eligible for diagnostic reading under their existing checks, while changing only the manifest's schema number fails the BOM profile check. An actual old schema-3 Mac candidate is refused before staging. All **58 focused release tests** pass, including official vendored CycloneDX 1.6 schema validation for each target, source/hash/graph/composition failures, unsigned-versus-signed identity handling and historical schema-2/3 compatibility. The signing-verification receipt is a required build input for changed signed native payloads; it does not select licenses or replace distribution approval.

All **735 unit tests / 81 files pass under Node 25.9.0 and bundled Node 24.21.0**, with zero failures/errors/skips; typecheck passes. The actual Mac package generates eight identified software components and passes the schema plus all evidence/notice checks. Fresh immutable unsigned candidate `release/beta-native-inventory-2026-10-20-candidate` is from **`1a05d4da9d1d8cf8100b2a0fb85680d003a6197d`**: manifest SHA-256 **`9ce03799fca04f8356d3992680d626d853e3f6ab79e69982622f243ca9c96753`**, unchanged ASAR **`1722c1dca64020f44d2f874ae6b543d532421363e2c7646d5cfbfa18b14abbb9`**. Actual DMG mount/copy and ZIP extraction both pass installed schema-4/native/software/notice/runtime/physical-worker verification and Unicode-path SQLite worker open/close. The preceding build and full 47 Oracle contracts remain applicable to the identical application ASAR.

Evidence is under `.test-artifacts/beta-release-readiness-2026-10-20/native-library-inventory/`: both final unit XML/logs, focused XML, `actual-probe.json`, `summary.json`, `payload.json` and `candidate-identity.json`. Deferred GUI/lifecycles target the new exact candidate and fresh `native-inventory-post-soak/` results; the older DuckDB-notice job is archived with execution disabled. No competing GUI, successor soak or main merge has started. Full compiled vendor composition, embedded notice coverage, legal review and native/signing qualification remain open.


### Oracle Thin-only package boundary — 20 October 2026

The preceding Mac package retained four unused Oracle Thick native addons plus five build-info files despite the frozen Thin-only scope and per-connection Thin compatibility check. [Oracle documents removing these optional binaries for Thin-only applications](https://node-oracledb.readthedocs.io/en/latest/user_guide/installation.html#install-node-oracledb). Release collection now excludes the Oracle build payload without changing the developer's installed dependency cache. Actual afterPack checks reject packed/nested native or build payloads, orphaned physical copies, absent required JavaScript/Thin entries and a wrong pinned version. Installed verification inspects the actual archive independently of the SBOM, rejecting even fully inventoried unsupported Thick addons. Oracle's JavaScript package and full license notices remain included.

The actual package comparison removes **nine files / 2,524,862 bytes** and adds none. All **12,965 retained ASAR files are byte-identical**, including the compiled application code. All 138 retained Oracle module files now use ordinary ASAR packing after builder no longer detects a native addon in that package; their contents are unchanged, and the actual packaged-host probe covers the new Mac loading layout. Remaining npm-native files are the DuckDB addon/library and credential binding: **three files**, all reviewed against their source mappings. The schema-4 SBOM still records eight positively identified native software constituents; complete compiled vendor/legal review remains open.

All **47 unchanged Oracle contracts pass** against an exact 138-file copy extracted from the pruned package. The retained config/setup asserts module identity and Thin mode; child-process requires are redirected to the same copy, including the untrusted-CA refusal. The actual packaged Electron **44.7.0 / Node 24.21.0** then loads its own ASAR module without aliases and runs the compiled database host against local Oracle **23.26.3.0.0**. Verified TLS, exact large decimals/nanosecond timestamps, separate physical transactions, full native metadata, cancellation without a following DELETE, explicit rollback/reconnect data preservation and final cleanup pass. An independent child exit receipt records **0**. The host uses a headless parentPort stand-in; real utility-process transport and GUI qualification remain B07/B11.

All **745 unit tests / 81 files pass under Node 25.9.0 and bundled Node 24.21.0**, with zero failures/errors/skips; typecheck and all **45 focused afterPack/installed inventory cases** pass. Eight new boundary cases exercise missing/retained package code, and two installed cases prove that inventory hashes cannot override the Thin-only policy. The fresh unsigned candidate `release/beta-oracle-thin-2026-10-20-candidate`, source **`e32bfff578226e89c1b83baec84fcb168451ca50`**, has manifest SHA-256 **`ad616c1217dc62b4d94341ef087e320560889a2fbffa78554f920a9fc178f6b4`** and ASAR **`70e9d3e1feb6b29d1dfca91caca18b2925ac112aeb347c53f75a98e7ab25cbbf`**, identical to the validated probe ASAR. Both actual DMG mount/copy and ZIP extraction pass installed schema-4/native/software/notice/Thin-boundary/runtime/physical-worker checks and Unicode-path SQLite worker open/close.

Evidence is under `.test-artifacts/beta-release-readiness-2026-10-20/oracle-thin/`: final unit XML/logs, focused XML, exact module extraction/config/runner, full-contract JUnit/log, `host-probe.json` and its exit receipt, `package-comparison.json`, `summary.json`, `payload.json` and `candidate-identity.json`. Deferred GUI/lifecycles now target these exact bytes and fresh `oracle-thin-post-soak/` results. The old native-inventory job is archived with execution disabled. The sole b126 soak remains untouched; its result cannot certify this candidate, and the maintainer's “Finish current run only” instruction prohibits a successor. No competing GUI or main merge has started.


### Complete unpacked payload integrity — 20 October 2026

Installed verification previously hashed native addons and retained notices outside `app.asar`, but did not compare the actual unpacked package metadata or arbitrary JavaScript/assets. Six regression cases demonstrated acceptance of changed unpacked metadata, JavaScript, binary and empty assets, an unindexed physical file and a redirected native parent directory. These bytes are outside the ASAR digest. The real Mac candidate had six unpacked files, including two previously unchecked package manifests.

Inventory profile **5** records every indexed unpacked regular file, including zero-byte files, with SHA-256, final physical size and an archive dependency reference. Native file records retain their existing software/source/ownership relationships. Final native sizes can differ from the pre-signing ASAR index and are checked against the final physical payload. Installed verification compares coverage with the actual ASAR index, checks hashes/sizes, rejects unindexed physical files and refuses symlink/junction redirects in unpacked roots, parents and leaves. Generation checks the same physical tree. Historical unsigned profiles remain readable for diagnosis; they cannot qualify a current candidate. Current staging and signed promotion require profile 5. This adds file-integrity coverage without asserting complete native/vendor composition.

All **762 unit tests / 81 files pass under Node 25.9.0 and bundled Node 24.21.0**, with no failures/errors/skips; typecheck/build pass. The 17 added cases include same-size corruption, valid empty assets, missing/disconnected/malformed sidecars, native-file omission, falsely claimed unpacking, directory/leaf redirects, extra files and historical profile-4 refusal for current qualification. Actual mounted DMG/copy and ZIP extraction pass installed profile-5 verification, existing Thin/native/software/runtime/notice checks and native SQLite worker open/close from a path containing spaces, `%`, `#` and `é`. A separate disposable copy rejects changes to all three non-native unpacked files, an unindexed JavaScript file and a redirected native package directory, then passes after restoration.

Fresh unsigned candidate `release/beta-unpacked-integrity-2026-10-20-candidate` comes from **`2a2a3bde763040c1fee4fc3ff3559649324e0314`**. Manifest SHA-256 is **`3667a992cab4cc52ff382af59c69829d59b25dc338ee354f6d7d6171d14a3711`**; ASAR remains **`70e9d3e1feb6b29d1dfca91caca18b2925ac112aeb347c53f75a98e7ab25cbbf`**. All six unpacked files and all 17 native/runtime/worker hash records exactly match the preceding `e32bfff` candidate. Its full 47 Oracle contracts and actual compiled Node24/ASAR host proof therefore remain applicable to identical payloads. The Mac SBOM still exposes eight positively identified native software constituents. Native platform execution, full vendor/legal review and signing remain open.

Evidence is under `.test-artifacts/beta-release-readiness-2026-10-20/unpacked-integrity/`: pre-fix six-failure log, final dual-runtime unit XML/logs, typecheck/build and release-build logs, `payload.json`, `tamper-probe.json`, `package-comparison.json`, `candidate-identity.json` and `summary.json`. Deferred full packaged/affected-driver GUI checks, exact DMG/ZIP lifecycles and staging are rebound to this immutable candidate and fresh `unpacked-integrity-post-soak/` results. The preceding Oracle-Thin job is archived with execution disabled. The single historical b126 soak remains unchanged and progressing; no competing GUI or successor soak has started. The maintainer's “Finish current run only” instruction remains binding, so changed-runtime B09 stays open. No main merge is authorized.


### Release guidance and packaged notice audit — 20 October 2026

The release guide now consistently requires inventory profile 5 for current staging/signed promotion, documents complete unpacked-file coverage and presents profile evolution in order. The root Oracle attribution now accurately distinguishes the unmodified JavaScript implementation from excluded optional Thick build payloads. This is a notice correction; application code is unchanged.

Fresh unsigned Mac ARM64 candidate `release/beta-notice-audit-2026-10-20-candidate` comes from **`ec5e8dae77be94af43441e3b3bcc10f9923d75f4`**. Manifest SHA-256 is **`d5f23b8989ac45680859a783b9de478a59ca105ddd14b18e81f9a8e795d293a3`** and ASAR SHA-256 **`4b083eb478d3887a1209aa388815901e00bf20847fb90b8158197b9ba3c7955a`**. A complete archive comparison finds exactly one changed regular file, `THIRD_PARTY_NOTICES.md`; all **12,964 other regular files**, all **six unpacked files** and all **17 native/runtime/worker hash records** match the preceding candidate. Its passing 762 dual-runtime unit cases, five real-payload corruption refusals, full 47 Oracle contracts and actual compiled Node24/ASAR host proof remain scoped to unchanged code. All **62 focused afterPack/installed inventory cases pass**, with no failures/errors/skips. Actual DMG mount/copy and ZIP extraction pass current installed verification and Unicode-path native SQLite worker open/close.

The actual package has **128 npm instances**, each with a retained license declaration, and **141 retained notice files**. Of the npm instances, **124** have their own packaged notice files and **three** use the already verified supplemental README resources (`pg-types`, `pgpass`, `railroad-diagrams`). The selected native keyring package contains no standalone license file. The wrapper project's full MIT notice is retained at `app.asar/node_modules/@napi-rs/keyring/LICENSE`; the audit records it as related evidence **requiring license-scope review**, not as a proven replacement for that native package's obligations. Native/vendor composition, per-file obligations, license choices and redistribution approval remain open under B16. Declaration/notice presence alone does not close that gate.

Evidence is under `.test-artifacts/beta-release-readiness-2026-10-20/package-notice-audit/`: complete per-instance `audit.json`, `package-comparison.json`, `candidate-identity.json`, `payload.json`, focused JUnit/log and `summary.json`. Deferred GUI/lifecycles/staging use this exact candidate and fresh `notice-audit-post-soak/` results. The superseded unpacked-integrity job is archived with execution disabled. The historical b126 soak remains untouched and live, with no competing GUI or successor run; current-runtime B09 stays open under the maintainer's explicit refusal of a successor. No main merge or release publishing has occurred.


### Historical eight-hour retention rerun — 20 October 2026

The sole authorized historical snapshot, source **`785477ae0dffe2cfe2457a0212cc90179d875bb8`**, ASAR **`b126d9862eddd0697fe0feb39c967a7ac3a64559a4272cee547b5c056cfd99fa`**, passed on macOS **27.0.1 / ARM64**, Apple **M5 Pro / 64 GiB**. The workload ran from **10:08:16 to 18:08:16 CEST** for **28,800.002 seconds**; recovery finished at **18:08:22 CEST**. Runner exit was **0**; JUnit has **one pass, no failures/errors/skips**. The immutable ASAR was rehashed unchanged and the endurance test's Git blob matches the source at launch.

There were **838 cycles**, **169 post-GC samples** and **84 exports**, each with 100,000 rows / 7,588,905 bytes. Export assertions check line count and exact first/last records. Aggregate output was 8.4 million rows / 637,468,020 bytes. Three independent workspace windows remained in use, including hidden work, cancellation, saved SQL and scratch-tab churn. Final checks rolled back both open transactions, preserved committed exact values, restored all three saved SQL buffers and unchanged history after restart, and verified disabled Run controls with no automatic connection or SQL replay.

| Window | Post-GC heap baseline → final | DOM baseline → final (peak) | Listeners baseline → final (peak) | Last-quarter heap slope |
| --- | --- | --- | --- | --- |
| 1 | 15.922 → 21.796 MiB | 641 → 648 (651) | 380 → 380 (415) | +0.200 MiB/hour |
| 2 | 15.432 → 19.192 MiB | 636 → 1,473 (1,473) | 380 → 380 (415) | +0.214 MiB/hour |
| 3 | 15.771 → 21.074 MiB | 636 → 1,629 (1,629) | 379 → 379 (413) | +0.393 MiB/hour |

All samples pass the unchanged +32 MiB heap / +2,000 DOM / +400 listener guards. The second window's DOM still rises in the last quarter (1,263–1,473); the third is nearly flat (1,627–1,629). Heap retains small positive late slopes. Earlier retained-heap profiling and the 1,500-edit native-input control found Blink's bounded textarea undo history and preserved model undo, but this run did not capture fresh retainer snapshots. These observations are **not proof of zero retention or indefinite leak freedom**.

The complete owned POSIX tree stays at **10 processes** in every sample, including the ordinary SQLite child omitted by Electron's nine-process metrics. Tree RSS is **1,529.844 MiB baseline**, **1,703.500 MiB peak** and **1,344.344 MiB final**; its last-quarter fitted slope is +31.219 MiB/hour despite ending below baseline. The unchanged +1 GiB/two-process guards pass. All original/restarted snapshot processes, runner and worker were independently confirmed gone before other GUI checks began.

Cancellation median/p95/maximum is **9.865 / 105.664 / 107.379 ms**; typing is **31.651 / 43.868 / 47.058 ms**. Work-cycle median/p95/maximum, excluding the intentional 30-second sleep, is **3.848 / 7.067 / 9.099 seconds**. Export median/maximum is **2.556 / 2.618 seconds**; first/last-quarter export medians are **2.527 / 2.588 seconds**, a roughly 2.4% increase. Final-quarter cancellation median/p95 is **13.189 / 15.714 ms**. No existing latency threshold was relaxed.

Evidence is retained in `.test-artifacts/beta-release-readiness-2026-10-20/eight-hour-retry/`: run/progress JSON, runner log, passing JUnit, final screenshot/test attachments, `completion-analysis.json`/log, analysis script and `harness-identity.json`. The queued current-candidate packaged regression began only after this historical run and all owned processes settled. **B09 remains open:** the Oracle-fixed/Thin-only current runtime is different, and the maintainer declined a successor. This pass closes only the authorized historical run; native platform, reference-hardware and pilot qualification remain separate.


### Native Quit cancellation recovery — 20 October 2026

After the historical soak and all owned processes settled, the first full current-package regression ran against `ec5e8da` / `4b083eb`. Its three startup cases pass. The main selection records **121 passes, one failure and seven intentionally unselected-engine diagram skips**. The failure is precise: after a tray-hidden SQLite transaction's first Quit is cancelled successfully, a second application `app.quit()` shows the transaction guard but leaves its workspace invisible. SQL/transaction state survives, but the recovery UI is unreachable. The five-second visibility guard was retained; no threshold was relaxed.

Restoring synchronously in `before-quit` was insufficient on this actual Mac package. The replacement uses [Electron's documented Quit cancellation](https://www.electronjs.org/docs/latest/api/app#event-before-quit): while tracked workspaces remain, prevent native Quit and coalesce a queued request to restore each workspace and invoke its existing guarded `close()`. The queue runs after native Quit cancellation returns, instead of continuing native window shutdown while asynchronous transaction/save checks run. Final Quit is permitted once no workspace remains; normal `window-all-closed` handling completes exit. The [pinned runtime's Quit path](https://github.com/electron/electron/blob/v44.7.0/shell/browser/browser.cc#L112-L123) is retained as implementation context. The fix does not bypass save or transaction decisions.

The protocol's focused unit cases fail **three of five** before the fix and pass afterward. They cover deferred guarded closes, restoration order, repeated Quit requests, already closed/destroyed workspaces and final exit. All **765 unit tests / 81 files pass under Node 25.9.0 and bundled Node 24.21.0**, with zero failures/errors/skips; typecheck/build pass. The rebuilt actual package passes **all three tray workflows repeated three times: nine passes, no failures/skips**, including the previously failing cancellation case, renderer recovery, multiple windows, failed preference writes and normal exit.

Fresh unsigned final candidate `release/beta-quit-guard-2026-10-20-candidate`, source **`ae053557a417345b9e394bacd0dd14d0337761be`**, has manifest SHA-256 **`a403812b0ad9f57df39e6c82344f74bb2d80144020fefe11a139b7ade8e1d2f5`** and ASAR **`b580b77676645dfd69ce95f0b1cc9430f93cc079579c7f09d80d6491f3e6e1cf`**. Its ASAR exactly matches the tested probe. Actual mounted DMG/copy and ZIP extraction pass installed profile-5/Thin/native/runtime/software/notice checks and Unicode-path native SQLite worker open/close. Only `out/main/index.cjs` changes: **12,964 other regular files**, all **six unpacked files** and all **17 native/runtime/worker hash records** match the preceding package. Earlier 47 Oracle contracts and compiled database-host proof remain evidence for the unchanged driver payload, while current application/GUI qualification is being repeated.

The failed full selection's JUnit/log and complete copied results are retained under `notice-audit-post-soak/regression/`. New unit/build/probe/installer payload results, `package-comparison.json`, `candidate-identity.json` and `summary.json` are under `.test-artifacts/beta-release-readiness-2026-10-20/guarded-quit/`. The failed job is archived with execution disabled; current full packaged/affected-driver GUI, DMG/ZIP lifecycles and staging are rebound to exact `ae05355` bytes and fresh `quit-guard-post-soak/` results. Focused passes do not close B07/B08 or native CI. Historical eight-hour evidence remains scoped to b126; the successor is still declined and B09 remains open.

### Architecture and code-quality review — 20 October 2026

Applied the requested `thermo-nuclear-code-quality-review` skill from `cursor/plugins`, pinned to `a66a8931c2dd71f1ed6abf6a52b1898a9f389ae4` and installed in the local Codex skills directory. The review and fixes cover frontend lifecycle ownership, backend orchestration, internal transport types and runtime-layer imports. [Architecture guidance](architecture/README.md) now documents these boundaries and the deliberate beta choice of one database/storage host per workspace. A host failure disconnects all profiles in that workspace; separating hosts by profile or storage is a future architecture decision requiring its own qualification.

`App` now composes a separate connection dialog, workspace recovery/save queue and job feeds. Its size falls from 976 to 835 lines. Effect Events read current callbacks without renewing subscriptions on each state change, dialog cleanup closes the actual opened element, and initial job lists cannot overwrite newer events. Duplicate complete busy-condition chains use the existing tab-state layer. `DatabaseHostClient` owns startup, request correlation, acknowledgements and confirmed shutdown. Typed host contracts and checked endpoint results replace the string/`any` transport. `BackupJobs` and `TransferJobs` own feature state while `DriverRegistry` retains the single session-reservation and query-routing owner; the registry falls from 595 to 480 lines. Pure SQL helpers and the lexer move to `shared/sql`, preserving their implementation; consumers no longer import frontend language code or backend adapters for pure SQL functions.

Three regression cases fail before their fixes and pass afterward: publishing a backup's running event before reserving its session allowed reentrant SQL; host exit between readiness and the awaiting request produced a `TypeError`; a failed synchronous transport send retained its pending entry/timer. Backup reservations now precede publication, and failed host requests cleanly report conservative failure without replay. Existing transaction, cancellation and timeout policies remain intact.

Builds now enforce static runtime import boundaries, Hook ordering/dependencies and a separate renderer TypeScript environment without configured global Node types. The pinned ESLint release requires development Node 22.13 or later; the documented minimum is updated. The DOM test dependency is pinned to jsdom 29.1.1 to match that minimum, rather than jsdom 30's higher runtime floor. Eight architecture regressions exercise the rules. Seven real React/jsdom lifecycle tests cover Strict Mode recovery disposal/current callbacks, failed-load overwrite prevention, serialized saves with newer edits, disk-full retry, autosave cancellation, initial/live job ordering and unmount cleanup. Final full suites pass **803 tests / 86 files under both Node 25.9.0 and standalone Node 24.21.0**, with no failures/errors/skips. Lint, both typechecks, Vite and physical SQLite worker builds pass.

On the confirmed unlocked Mac, the updated **development-source** GUI selection passes **118 cases**, with zero failures/errors and seven intentional unselected-engine diagram skips. It covers keyboard/focus, accessibility trees, native zoom, profile ownership, files/undo, transactions, transfers, workspace capacity/disk-full/crash recovery and all three guarded tray/Quit workflows. The two profile-focus failures observed on the locked desktop do not recur. No speculative application-focus override is included. New GUI preflights refuse a locked/uninspectable Mac console before testing; installer reruns invalidate any old passing report before that check. Dedicated soak/retention files were excluded; no additional endurance run was started.

Evidence is retained under `.test-artifacts/beta-release-readiness-2026-10-20/architecture-audit/`: before-fix failure logs, final dual-runtime unit JUnit/logs, Hook tests, build logs, `source-run.json`, source GUI JUnit and complete `source-results/`. The source runner exited successfully, its runner/worker settled, and the compiled main digest was unchanged during execution.

SQLite and DuckDB Docker contracts pass 44 and 47 cases respectively. A separate complete server run passes **254 contracts**: PostgreSQL 44, MySQL 44, MariaDB 44, SQL Server/local Azure-profile 75 and Oracle 47, with no failures/errors/skips. Together these are **345 passing contracts across seven local engines**. The isolated projects `dbcommander-test-99244` and `dbcommander-test-3197` remove their containers, volumes and networks after successful completion. This does not qualify a live Azure service.

The fresh unsigned Mac ARM64 candidate `92fef85683e0806f3c471eba39f94e58bbc4c508` is in `release/beta-code-quality-2026-10-20-candidate`: manifest SHA-256 `bd46a09907175f8c87df4e1e3b44cc83577d0c8e01d0269b376943ac3ead4e3b`, ASAR `78b6c2ef1df78ce0c3d75f1cc13f51bdb3429f6ec3a1313c2d668aea15a31202`, inventory schema 5. Both actual DMG/ZIP installations pass complete installed ASAR/unpacked/native/runtime/software/notice verification and the physical SQLite worker opens/closes successfully from a Unicode, space-containing installation path. These are unsigned local payload checks, not signed distribution or clean-OS qualification. `candidate-identity.json`, `release-build.log`, `payload.json` and `payload.log` retain the evidence.

The exact new candidate also passes **17 focused packaged GUI cases**, with no failures/errors/skips: three startup/native-library/host-timeout cases, six application/host recovery cases, three profile ownership/focus cases, three tray/Quit cases and two workspace save-recovery cases. `packaged-focused-run.json` records executable, source, hashes, arguments, PIDs and runner exit 0; JUnit/log and complete results are retained beside it. The manifest, ASAR and complete installed inventory are reverified unchanged afterward, with runner/worker and original candidate processes settled. This focused selection does not replace the full packaged regression, affected-driver GUI or installer lifecycle/staging requirements. No endurance case was selected.

An initial attempt to run Vitest through packaged Electron's Node mode stalled after three files. Its process sample/log and verified owned-process stop receipt are retained as `unit-electron-node24-interrupted.*` and `node24-electron-*`; no passing result is claimed for that harness. The complete standalone suite uses the same Node 24.21.0 version and passes. These unit results do not substitute for native packaged execution.

The prior `b580b77` deferred job is held with execution disabled because the review changes runtime bytes. Source GUI results do not close B07 or B08; current packaged/affected-driver GUI, exact installer lifecycles and staging require a newly bound candidate. The historical eight-hour result remains scoped to `b126d986`, with measured retention and unchanged limits; the maintainer declined a successor, so B09 remains open. Native CI, signing, clean-OS, minimum-hardware, human-reader, vendor redistribution and pilot gates remain open. CI stays main-only, and draft PR 133 has no main-merge approval.

### Packaged regression and lifecycle requalification — 20 October 2026

The first complete `92fef85` / `78b6c2ef` packaged selection passed all three startup cases and 121 main cases, with one disk-full retry test failure and seven intentional unselected-engine diagram skips. The app's retry button disappears while Playwright is trying to click it after freeing the disk. The rescue-file action changes the tab name and schedules a workspace autosave; once space is available, that queued save can succeed and remove the error/button. The test had assumed the button would remain until its click.

The fixture now pauses renderer timers before the rescue action, waits for the real file operation to finish, verifies committed SQL and the visible retry action while the volume remains full, then frees space and clicks Retry. Native IPC and actual SQLite/ENOSPC writes remain live. It asserts the saved buffer and removal of the retry button, resumes timers, restarts and retains the existing integrity/no-replay checks. All three actual disk-full scenarios repeated three times pass **9/9**, with no failures/errors/skips; whole-project and renderer typechecks pass. The change is confined to `tests/desktop/workspace-disk-full.spec.ts`, commit `ebb9d06`; application bytes and resource/timing thresholds are unchanged.

The failed complete run and all results are retained under `.test-artifacts/beta-release-readiness-2026-10-20/code-quality-post-review/regression/`; the nine focused cases and JUnit/log are alongside that directory. Its journal is archived with execution disabled. The corrected complete run uses fresh `code-quality-final/` output and the same immutable candidate. It passes **3 startup cases and 122 main cases**, with **zero failures/errors and seven intentional unselected-engine diagram skips**. Existing short retention/resource checks ran with unchanged defaults; this qualification does not start or authorize a successor eight-hour endurance run.

The PostgreSQL basic desktop test previously always launched the development entry point. Commit `89748a0` makes it honor the selected packaged executable and assert `app.isPackaged`, including its crash/restart path. Whole-project and renderer typechecks pass. The exact package passes both embedded-engine workflows, all three PostgreSQL cases, all three Oracle cases and all six MySQL/MariaDB cases. Server selections include the basic desktop workflow plus rich and large catalogs; their selected integration cases pass (PostgreSQL 2, Oracle 2, MySQL/MariaDB 4), with the other contracts intentionally filtered. These targeted selections supplement the earlier full 345-contract result; they are not a new full contract run.

SQL Server and the local Azure profile pass all **five packaged GUI cases**, and both selected SQL Server catalog integration cases pass. Together with the embedded and other server selections, this completes **19 packaged driver GUI cases with zero failures/errors/skips** and **10 selected server integration cases**. All runner exits are zero; complete JUnit, logs and copied per-phase results are retained in `code-quality-final/`, with verified summaries for the regression and each driver selection. This closes local B07 for these exact unsigned Mac ARM64 bytes; it does not qualify live Azure or native CI on other platforms.

Both actual **DMG and ZIP lifecycle cases pass**, with zero JUnit failures/errors/skips and runner exit 0. Each format installs the synthetic 0.0.0 baseline, seeds workspace/SQL/history/native SQLite and DuckDB/OS credentials, upgrades to the exact candidate without changing the closed workspace bytes, verifies the complete installed inventory, uninstalls while retaining data, reinstalls and verifies data/credentials again, then removes its credential and owned installation. Both retain platform-default Chromium sandbox evidence. Measured lifecycle durations are **13.226 s (DMG)** and **11.698 s (ZIP)**. The synthetic baseline tests the mechanics; it does not prove migration from a published historical release.

Staging succeeds into `.test-artifacts/beta-release-readiness-2026-10-20/code-quality-qualified-staged-candidate/`. Its seven regular files are exactly the whitelist (manifest, checksums, DMG, ZIP, SBOM, notices and lifecycle report), with every SHA-256 matching the original candidate. Final complete installed inventory verification passes after all GUI/lifecycle work. Immutable identity remains:

- Runtime source: `92fef85683e0806f3c471eba39f94e58bbc4c508`; validation tooling: `89748a0c77bd1fccdc5808b1d23d57f85971daa6`.
- Manifest SHA-256: `bd46a09907175f8c87df4e1e3b44cc83577d0c8e01d0269b376943ac3ead4e3b`.
- ASAR SHA-256: `78b6c2ef1df78ce0c3d75f1cc13f51bdb3429f6ec3a1313c2d668aea15a31202`; inventory schema 5.
- DMG SHA-256: `bc4a87e0d3aad6773032ed593738be8f03b779e40cbf00e82b3a0d1a13144a04`.
- ZIP SHA-256: `3f68fe28eedfd6f100955d432b28dd22cf7da12665a3e0ece713e3b1fe11a208`.

The canonical execution journal contains all 15 ordered phases with exit 0. Final process inspection finds no candidate/installer processes and no retained PostgreSQL, Oracle, MySQL/MariaDB or SQL Server fixture containers from these runs. `code-quality-final/completion-summary.json` and `completion-verification.log` retain identity, phase results, lifecycle durations, staged file hashes and settlement checks; `lifecycle.xml`, each driver's `verified-summary.json` and copied results preserve the actual tests. This closes **local B07/B08** for the unsigned Mac ARM64 candidate. B09 stays open under the declined successor decision; native main CI, signing, clean OS, minimum hardware, human screen-reader, vendor redistribution and pilot gates remain open. No main merge or publishing occurred.

### Native main qualification — 21 October 2026

The maintainer explicitly authorized marking PR 133 ready, merging it into main and monitoring native CI. The PR was verified conflict-free at source `3814abf55a3e0d46c05a1835ea2f74a90a03a578`, marked ready and completed with an ordinary merge commit, without bypassing or changing policy. Main is now `7c127a7a29b62b054aceaa5eff1a2df29dcbc535`. Development is retained; no successor main merge is included in this approval.

[Native run 294 / 20261021.1](https://dev.azure.com/detegoprojects/SQL%20Commander/_build/results?buildId=294) started automatically on that exact main commit at **07:27:29 CEST on 21 October**, with `validationScope=all`, `createRelease=false` and no native Apple Silicon pool configured. It contains three Desktop and seven driver jobs. At the initial observation the run was still in progress; launch and early task success did not close B11. The terminal outcome is recorded below. The earlier run 293's terminal failures remain historical evidence above and must be checked against the new actual results. Main-only CI and existing assertions, thresholds and release/signing boundaries are unchanged.

Receipts under `.test-artifacts/native-ci-2026-10-21/` retain the PR state, ready/completion request, verified merge and current run identity/progress. The Git credential can access repository/PR operations but receives 401 for the build REST API; the existing signed-in browser reads the actual CI API/UI without creating or expanding credentials. A quiet follow-up monitors this single run for failures, actionable stalls or completion and is authorized to validate fixes locally and push them to development. No new endurance run or cloud-database test is authorized; the historical-only B09 limit remains.

#### Run 294 Linux retention investigation

The native Linux x64 job passes units, packaging, embedded SQLite/DuckDB probes and all three startup cases, then records **110 main passes, one failure and 18 intentional platform/engine skips**. `editor-retention.spec.ts` fails its unchanged listener-growth guard: **27 additional listeners**, where the limit is fewer than 10 between edits 1,100 and 1,500. Installer stages are skipped after that failure. Native macOS x64 separately passes **3 startup + 122 main cases**, with seven intentional engine-selection skips, including both original retention cases; its complete job is now successful. Actual DMG and ZIP install → version upgrade → uninstall → reinstall checks both pass, including workspace, OS credentials and native SQLite/DuckDB preservation, and tested installer staging succeeds. The subsequent Windows investigation below records its seven terminal failures. Current driver outcomes are tracked in B11; no complete native matrix pass is claimed.

The original native counter file is listed in the retained Linux diagnostic artifact, but browser download attempts did not produce a local file. The exact assertion and totals were read from run 294 log 19; the original 27-listener source is not established from a retainer snapshot. Unchanged repetitions pass **3/3 on the Mac ARM64 package**, **3/3 on local Linux ARM64 source**, and **3/3 on an actual Linux x64 package under ARM-host emulation**. All keep 366 listeners. Three Linux ARM64 controls under CDP CPU throttling also pass. These observations do not certify native Linux x64 or dismiss its failure.

A controlled probe invokes the existing completion-readiness helper only after edit 1,100. That changes the same live editor from **1,363 → 1,625 DOM nodes** and **366 → 403 listeners**, and deliberately fails the unmodified growth budget. This reproduces a fixture-state mismatch from one-time completion control creation, rather than repeated-edit retention. It does not prove that all 27 listeners in the native failure came from that control.

The input-retention fixture now reuses the existing `readyForSnapshot` preparation before the 1,500-edit workload, just as the scratch-tab case already does. Sample edit counts, node/listener/heap limits, prior-buffer undo and empty SQL history assertions are unchanged. Both fixtures print complete counter JSON and attach a real file path, allowing JUnit to publish individual counters without requiring the full heap archive. Cleanup still runs if attachment publication fails. Application code and the immutable Mac candidate are unchanged.

The amended two-case Linux ARM64 selection passes. Both amended cases also pass against the actual **Linux x64 diagnostic package under emulation**, with two verified JUnit attachment references, zero failures/errors/skips and runner exit 0. After 40 scratch-tab closures, nodes/listeners stay **717/372** and view-state records change **1 → 2**. Between edits 1,100 and 1,500, nodes/listeners stay **1,645/402** and heap grows **503,628 bytes (0.480 MiB)**; undo/history checks pass. The diagnostic ASAR is `63b43c8b19074ec58fbeb96c2697abb7e76286b12bb3bab32e5b99b1189cefeb`. Whole-project/renderer typechecks pass. A final Mac attempt is refused by the locked-console preflight before any case runs; no pass is claimed for that attempt and no GUI guard is bypassed.

Evidence is retained under `.test-artifacts/native-ci-2026-10-21/`: `linux-failure-summary.json`, original Mac/Linux repeat logs/XML/results, `linux-retention-throttled/`, the intentionally failing `linux-retention-late-controls/` probe, `linux-retention-final/`, `linux-x64-retention-before/`, `linux-x64-retention-final/`, diagnostic Docker build logs, final typecheck logs and the refused Mac preflight log. Initial cross-architecture Docker setup attempts failed before testing; a fresh x64 dependency installation fixes that diagnostic setup. Emulation and controlled probes are local diagnostic evidence, not native qualification. No new endurance run, resource-budget relaxation, main merge or release publication is included. Native repetition of the amended fixture remains required after a separately approved main merge.

#### Run 294 Windows investigation

Native Windows x64 log 74 records **three startup passes**, then **103 main passes, seven failures and 19 intentional platform/engine skips**. NSIS checks are skipped after the main selection fails. The failures are: a DuckDB database owner surviving main-process death; SQLite/DuckDB catalog typing at **2,777.747/2,125.148 ms** against the unchanged 2,000 ms limit; renderer-recovery startup not reaching Saved locally; an 8.3/long-path comparison; a reload retry button disappearing before its click; and an exact clipboard comparison for an oversized buffer. These failures are distinct from the Linux retention finding.

A private current-user fixture in the existing Windows 11 ARM64 VM reproduces the orphaned DuckDB host and clipboard assertion with the unchanged package: **five passes/two failures**. This is x64 emulation, not native x64 hardware qualification. A controlled delayed old-window close also stalls recovery with the old Linux x64 package. Actual Windows path probes show ordinary `realpathSync` retaining an 8.3 alias where `fs/promises.realpath` and `realpathSync.native` expand it. Clipboard counters show the entire SQL preserved, with 142,856 LF characters published as CRLF; normalized equality is true. No user clipboard content is logged, and fixture clipboard formats are restored.

The Windows database host now waits for an app-owned external C# ownership guard before opening storage/adapters. It uses validated main-process creation time and retained Windows kernel handles, terminates only the captured host after main death, and exits when that host ends. A failed guard fails host startup. A same-process Node worker proved insufficient in actual Electron: its trace stops during teardown while native DuckDB work remains. That attempt is retained as a failure, not qualified. The external helper is built with the OS .NET Framework compiler as a hidden GUI-subsystem executable and uses the Windows .NET Framework runtime; no PowerShell/compiler runs at application startup. The physical helper has strict platform-specific inventory/hash/size/redirect checks and is excluded from ASAR. Clean-OS/runtime-floor and future signing qualification remain open.

Renderer recovery detaches its original window before destruction, and delayed callbacks can no longer clear or close the replacement. The explorer memoizes catalog derivation and its rendered tree, keeping 1,300 rows out of SQL keystroke work. Visible child actions still receive current callbacks and busy state; collapsed collections mount on expansion. A real React regression verifies current callbacks and disabled actions, and actual catalog GUI cases retain keyboard expansion, filtering and inspection coverage.

Fixture corrections compare the full clipboard in native Windows CRLF format, use native canonical path resolution, and hold only the queued 250 ms autosave in the explicit reload-retry scenario. Whole-buffer, undo, saved-history, transaction, restart/no-replay and timing assertions remain. Vitest excludes ignored `.test-artifacts` snapshots while retaining its default exclusions; an initial broad run had incorrectly discovered an archived source copy, whose failure is retained.

Controlled CPU-rate-2 catalog measurements initially fail at **3,428.322 ms (SQLite)** and **3,005.285 ms (DuckDB)**. Memoizing only relation headers leaves SQLite at 2,305.623 ms and is not accepted as the final performance fix. With the full tree correction, the same unchanged diagnostic passes **4/4 cases**, two per engine: typing **1,595.126/1,671.675 ms (SQLite)** and **1,588.443/1,712.669 ms (DuckDB)**. Filtering, completion, inspection, saved SQL and unchanged history guards pass. An earlier attempt with the full correction misses the initial five-second Saved locally assertion before SQLite connects; its evidence is retained. The identical four-case confirmation includes successful startup in each case. These CPU controls are diagnostic evidence, not minimum-hardware certification.

The full final unit selections contain **808 tests / 88 files**: Mac Node 25.9.0 has **806 passes/two intentional Windows-only skips**; Windows Node 22.23.3 has **792 passes/16 intentional platform skips**; both have zero failures/errors. The two actual Windows kernel-handle tests exercise a blocked host, owner death, a surviving unrelated process, normal host termination and a Unicode/space-containing helper path. Lint, both typechecks, Vite/physical-worker builds and Windows packaging pass. The earlier corrected eight-case package selection passes, including exact rollback to committed value 7, saved never-submitted SQL, unchanged history and no replay; the final catalog revision receives a fresh broader packaged selection below.

Evidence remains under `.test-artifacts/native-ci-2026-10-21/windows-local/`: original failure summary, baseline and controlled probes, rejected thread traces, native-owner smoke, source-input hashes, build logs, full units, CPU before/intermediate/final/confirmation results and complete per-phase GUI JUnit/results. All timings and budgets remain unchanged. No new endurance run, successor main merge, native CI retry or release publication is included. B07/B08 are reopened for the changed runtime; prior Mac ARM64 DMG/ZIP qualification remains scoped to `92fef85` / `78b6c2ef`. B09 and native/signing/clean-OS/hardware/human-reader/vendor/pilot gates remain open.

The final unsigned unpacked Windows package passes **42 packaged cases**, with **zero failures/errors and six intentional unselected server-engine skips**, runner exit 0. This fresh 5.4-minute selection includes all seven original failure cases, the controlled late-close regression, three packaged startup/native-library/host-timeout cases, both engines' main/host crash and staged-edit recovery, both rich/large catalogs, layout, three profile-ownership cases, three keyboard/focus cases, three tray/Quit cases, complete SQL files/reload selections, twenty-tab/five-million-character capacity and workspace save recovery. The earlier CPU-limited initial-readiness miss does not recur in the four confirmation cases or these actual startup cases. All assertions keep their existing limits. `windows-regression-final/` retains the complete JUnit/results and `windows-regression-final-run.json` records its actual runner completion.

The current native matrix separately has successful Mac Intel Desktop, PostgreSQL, SQL Server, MariaDB and SQLite jobs. Linux/Windows Desktop and MySQL/Oracle remain failed; DuckDB is still running at timeline 08:51:15.95 UTC. MySQL log 128 records 118 desktop passes/one scratch-tab retention failure/215 intentional skips, with +27 listeners against <10. Oracle log 144 records 46 contract passes/one large-catalog inspection failure: 5,823.537 ms against <5,000 ms. Those additional failures remain for the authorized native follow-up; these Windows fixes do not establish their causes or close B11.

After GUI testing, the actual unpacked Windows payload passes complete **schema-5 installed inventory verification**, including ASAR, all indexed unpacked files, native/runtime/software/notices and the physical ownership helper. Its 23 recorded build-input hashes match committed source `1fbea4f3535a596a55b7992fdae7316db4be1dde`; the private diagnostic checkout is based on `aa5b8de` with those verified changes, rather than a published installer. ASAR SHA-256 is `07fd420cae9f8cc4cb93f32a34ed7e6b8e3c37945cbe6e2af90511abb3520c48`, helper SHA-256 is `88267d839a55427b6d8f26f2a9c2b683534fcb586aeba7cfb48c6d52d3abddd6`, and diagnostic manifest SHA-256 is `a5edc2a56c8c677531a68321464d95f5258d4865f198781ca3112b7293adf5da`. Both package hashes remain unchanged. Final CIM inspection finds **zero processes with executable paths in the unique private fixture tree**; no manual test-process stop was needed. `inventory-final/verification.json`, `settlement-final.json` and phase receipts retain the actual evidence. This does not qualify NSIS, native x64 hardware, signing or a release candidate on other platforms.

#### Run 294 terminal outcome and remaining investigation

The exact main `7c127a7a29b62b054aceaa5eff1a2df29dcbc535` run finishes **failed at 09:07:47.106 UTC / 11:07:47 CEST on 21 October**, with all ten target jobs terminal. Parameters remain `validationScope=all`, `createRelease=false`, with no Apple Silicon pool configured. No duplicate or successor run is queued.

| Target job | Actual result |
| --- | --- |
| Mac Intel Desktop | Pass; full packaged regression, actual DMG/ZIP lifecycles and staging |
| Linux Desktop | Fail; input-retention listeners +27, required <10; installers not reached |
| Windows Desktop | Fail; seven original failures documented above; NSIS not reached |
| PostgreSQL | Pass |
| SQL Server / local Azure profile | Pass; no live Azure service qualification |
| MySQL | Fail; scratch-tab retention listeners +27, required <10 |
| MariaDB | Pass |
| Oracle | Fail; large-catalog inspection 5,823.537 ms, required <5,000 ms |
| SQLite | Pass |
| DuckDB | Pass; 47 integration contracts and 117 desktop passes/217 intentional engine/platform skips |

The final DuckDB task log is 192. Exact build/timeline identity and job-log references are retained in `.test-artifacts/native-ci-2026-10-21/terminal-build.json` and `terminal-matrix.json`. The terminal result remains failed despite development corrections; no native gate is closed from local evidence.

**MySQL scratch retention:** the unchanged scratch case passes three repetitions against the actual unsigned Linux x64 diagnostic package under ARM-host emulation and CPU-rate-3 throttling. Each repetition keeps **717 nodes / 372 listeners** before and after 40 closed scratch tabs; retained Monaco view-state records change **1 → 2**, with selection/scroll/undo/history guards passing. The package remains ASAR `63b43c8b`. A separate controlled probe fully populates suggestions only after the baseline: its immediate count rises to 989 nodes / 432 listeners, then returns to 717 nodes / 378 listeners after the 40-tab workload, still passing the unchanged growth limit. This does **not** reproduce the native +27 failure or establish its cause. No new readiness delay, resource-budget change or product fix is inferred from these passing probes. The original native counter file remains unavailable; the already-pushed counter logging/JUnit file attachments will help a future native repetition. Evidence is in `scratch-retention-before/` and `scratch-retention-late-suggestions/`, including both heap snapshots per case, control metadata, complete results, JUnit and runner receipts.

**Oracle inspection:** a private source snapshot with timing-only wrappers around connection opens, metadata execution and LOB reads runs against disposable local Oracle **23.26.3.0.0**, with the existing Thin driver and all original budgets. The selected large-catalog contract passes at **1,245.852 ms** inspection. Its local trace records approximately **1,050.645 ms** for native GET_DDL, overlapped with required sections; this does not identify the native host's critical path. The complete original-order **47-contract Oracle selection** then passes with zero failures/errors/skips, including native backup/restore, TLS/SSH refusal paths, catalog scope, transactions, cancellation and exact values. Large-catalog inspection is **1,171.999 ms**, materialized-view inspection **121.817 ms**, and schema refresh/overflow refresh **1,011.722/709.880 ms**. These runs use Mac ARM64 Node 25.9.0 and a local ARM64 Oracle container; they do not certify or reproduce the slower native Linux x64 result. No speculative Oracle runtime change or 5,000 ms threshold increase is made. `oracle-inspection-before/` and `oracle-inspection-full/` retain exact snapshot identity, diagnostic wrapper, query timings, measurements, full logs, JUnit and runner receipts. The first selection intentionally filters the other 46 cases; the full selection passes all 47.

**SQLite fixture regression corrected:** the new Windows helper import in `build-sqlite-worker.mjs` also has to exist when that script runs in Linux Docker. A fresh current fixture build fails with `ERR_MODULE_NOT_FOUND` because `Dockerfile.sqlite` copied only the SQLite entry script. The Dockerfile now explicitly copies both build modules, and the fixture fingerprint hashes both, preventing stale image reuse after helper changes. A new fingerprint regression fails before the correction and passes afterward; all **five cache tests** pass. The actual rebuilt Node **24.21.0** Docker fixture passes **all 44 SQLite contracts**, including physical worker startup, transactions, cancellation, rollback, native-session isolation and no replay. Evidence is retained in `sqlite-fixture-before.log`, `sqlite-fixture-unit-before.*`, `sqlite-fixture-unit-final.*` and `sqlite-fixture-final/` with its build/test log. This correction changes test-build inputs, not the application bytes already validated in the Windows diagnostic.

`post-monitor-validation-summary.json` verifies the actual JUnit totals. Final inspection finds no processes from the unique Oracle diagnostic snapshot and no containers from the owned scratch/SQLite/Oracle projects; all fixture networks are removed by their runners. `post-monitor-settlement.json` records the checks; no manual process stop is needed and unrelated services remain untouched. Native MySQL/Oracle causes remain unproven and require retained native evidence and/or a separately approved main CI repetition. B07/B08 current-byte qualification, B09 under the declined successor decision, B11 native CI and all signing/clean-OS/hardware/human-reader/vendor/pilot gates remain open. Main-only CI, all budgets, no-cloud and no-new-endurance boundaries are preserved.
