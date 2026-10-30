# Db Commander user guide

For installation from source, tests and contributing, start with the [developer README](../README.md). This guide describes the application workflows and their limits. See the [beta notes](BETA_NOTES.md) for current release status.

## Current app and documentation

The app is **Db Commander**, developer-preview version 0.2.3. **Help → About Db Commander** shows the version of the running application. The supported profile types are PostgreSQL, MySQL, MariaDB, SQL Server, experimental Azure SQL, SQLite, Oracle Thin and DuckDB. [Screenshots of the current workbench](../README.md#screenshots) use an isolated demo database. Development, build/test commands and fork setup are in the [README](../README.md); CI is managed by [GitHub Actions](GITHUB_ACTIONS.md).

## Executing SQL

**Run SQL** (`Cmd/Ctrl+Enter`) runs the selected SQL, or the script when there is no selection. **Query tools → Run current statement** (`Cmd/Ctrl+Shift+Enter`) runs the statement at the cursor. For SQL Server/Azure SQL this is **Run current batch**, preserving the entire GO-delimited batch and executing it once. **Run entire script** ignores the selection. These actions are also available in Commands.

Highlight SQL, right-click inside the selection and choose **Run selected SQL** to execute only that range. The same menu provides **Run current statement / batch**. Existing transaction and protected-profile rules apply. Whitespace-only selections run nothing.

On a query failure, **Go to failed statement/batch** selects the affected SQL without running it. When only the submitted range is known, the action is labeled **Go to executed SQL**. Editing the buffer disables the link until it matches the executed text again. This locates the execution unit, not an exact native error column. See [execution behavior and limits](IMPLEMENTATION.md#current-statement-execution-and-error-navigation).

## SQL files

**File → Open SQL file** (`Cmd/Ctrl+O`) opens a disconnected tab without replacing the current buffer. Opening the same file again focuses its existing tab. The tab shows an unsaved marker and its file path. **Save** (`Cmd/Ctrl+S`) writes to that file; **Save As** (`Cmd/Ctrl+Shift+S`) selects a new destination. File actions never run SQL or settle database transactions.

With **Preferences → Tabs → Confirm before closing tabs** enabled, closing a tab offers **Keep tab**, **Save and close**, or explicit discard with **Close tab**. Turning this preference off closes eligible tabs immediately; pinned tabs, running operations, transactions and staged edits still prevent closing. The tab context menu also offers **Close other tabs** and **Close all tabs**, keeping pinned tabs. Quitting with edited file tabs offers to keep working, retain the buffers for recovery without writing files, or save the edited files and quit. Scratch buffers continue to recover automatically. **Saved locally** in the status bar means workspace recovery; **Saved to file** means the buffer matches the last file save/load, with disk-change warnings shown separately.

External edits and removals produce a warning without replacing the buffer. Choose **Reload from disk** (confirmed when there are edits) or **Save As**. Replacing an externally changed file requires confirmation and a fresh revision check. **Recent SQL files** retains the last 20 paths; clearing it does not delete files. UTF-8 files support up to 1,000,000 characters each, within the existing 20-tab/5,000,000-character workspace limits. See [file handling and verification](IMPLEMENTATION.md#safe-sql-file-handling).

## Query library and parameters

Open **Query tools → Query library** to search executions by SQL text or favorites. Expand **More history filters** for connection, database, engine, status and UTC dates; **Clear history filters** restores the full list. Favorite useful executions, turn them into named snippets, and open either in a new independent query tab without executing it. Snippets support descriptions, engine labels, favorites and search. The recent-history sidebar shows the execution date and local time and opens SQL in new tabs.

**Retention** controls global recording, maximum entries, age in days and whether favorites survive automatic pruning. Connection settings have a separate **Record history for this connection** option; reconnect to apply a profile edit. Clear history can preserve favorites and always keeps snippets. SQL text is stored locally without encryption, so literals may contain sensitive data. Old migration backups and SQL buffers are separate from history clearing.

Use `:name` placeholders in a single SELECT/WITH/INSERT/UPDATE/DELETE statement, select the statement if necessary, and click **Run SQL**. The prompt binds Text, signed 64-bit Integer, Decimal, Date, Timestamp, Timestamp with timezone, Boolean, NULL, Hex or typed array values using the engine's native parameter API. Repeated names share a value; names are case-sensitive. Parameters represent values, not table/column names. Bound values are never saved in history, snippets or workspace recovery, and must be entered for each run. See [limits and verification](IMPLEMENTATION.md#query-library-and-bound-parameters).

### Decimal and calendar parameters

Choose **decimal** for plain decimal notation such as `9007199254740993.12345678`: up to 38 digits of precision and 30 fractional digits, with no exponent, leading `+`, grouping separators or unnecessary leading zeros. Values stay exact through binding; the target column or SQL expression can still round or reject them.

Choose **date** for `YYYY-MM-DD`, or **timestamp** for `YYYY-MM-DD HH:mm:ss[.ffffff]` (a `T` separator is also accepted). Years 1000–9999 and valid Gregorian dates are required. Timestamps have no timezone and retain up to six fractional digits without JavaScript Date conversion. Offsets, `Z`, leap seconds and excess precision are rejected. Choose **timestamp with timezone** for instants with an explicit offset; use Text with explicit SQL conversion for other engine-specific formats.

These types work in execution, full-result export and EXPLAIN. SQLite binds them as text; use TEXT storage for exact decimals because numeric affinity or arithmetic may convert them to floating point. Other engines receive decimal/date/timestamp conversions around native bound values. See [engine mappings and verification](IMPLEMENTATION.md#decimal-date-and-timestamp-parameters).

### Timestamp parameters with timezones

Choose **timestamp with timezone** (`timestamptz`) for values such as `2026-10-25T02:30:00.123456+02:00` or `2026-10-25 00:30:00Z`. An explicit `Z` or `±HH:MM` offset is required, up to ±14:00. Values normalize to UTC with six fractional digits; the original offset is not retained. Both the supplied date and its UTC date must be within years 1000–9999. Named zones, missing offsets, unknown offset `-00:00`, leap seconds and extra precision are rejected. Supply the correct offset for daylight-saving transitions; Db Commander does not infer it.

PostgreSQL, SQL Server/Azure SQL, Oracle and DuckDB receive native timestamps with timezone semantics. MySQL/MariaDB receive **UTC DATETIME(6)**: set the session timezone to UTC or explicitly convert before assigning to a TIMESTAMP column, which uses the session timezone. SQLite receives UTC text ending in `+00:00`; use TEXT columns to retain it. Run, full-result export and EXPLAIN all use the same validation and binding. Database display formats and target-column conversions still follow engine rules. See [mappings and verification](IMPLEMENTATION.md#timezone-aware-timestamp-parameters).

### Array parameters

Use `WHERE id IN (:ids)` or `WHERE id NOT IN (:ids)`, choose **integer[]**, and enter a JSON array such as `["1", "2", null]`. The array must be the only item inside the `IN` parentheses. All eight connection types support this form for execution, full-result export and EXPLAIN. PostgreSQL and DuckDB also support native array expressions such as `id = ANY(:ids)`, `unnest(:ids)` and assignment to compatible array/list columns.

Types are `text[]`, `integer[]`, `decimal[]`, `date[]`, `timestamp[]`, `timestamptz[]`, `boolean[]` and `hex[]`. Use JSON strings for every non-NULL element except booleans: `[true, false, null]`. **Quote numbers** to preserve exact integers/decimals; JSON numbers are rejected. Temporal/hex elements use the scalar formats above. Nested arrays, objects and mixed types are not accepted.

`[]` matches no rows with `IN` and all rows with `NOT IN`, including a NULL left operand. A `null` element follows SQL NULL rules: for example, `x NOT IN (1, NULL)` is never true. Duplicates and order are retained. Decimal elements must fit a common precision/scale of at most 38/30; SQLite still binds decimals as text. Limits are 1,000 elements per array and **1,000 total scalar bindings after expansion**, including repeated arrays and ordinary parameters, plus the existing value-size limits. Multidimensional arrays, SQL Server table-valued parameters and Oracle collection/OUT parameters are outside this feature. See [details and verification](IMPLEMENTATION.md#array-query-parameters).


### Snippet files

In **Query tools → Query library → Snippets**, choose **Export saved snippet** for the selected saved entry, or **Export listed snippets** for the current filtered list. Exports use a versioned UTF-8 JSON file containing names, SQL, descriptions, engine labels and favorites. Unsaved edits, connection profiles, history and bound values are excluded. SQL literals remain readable in the file. Choose a new filename; existing files are never replaced.

**Import snippets** opens a review with SQL previews and per-snippet selection. Duplicate names match without case differences within the same engine. **Skip duplicates** is the default; **Keep both with new names** adds numbered copies. Existing snippets are never overwritten. Import commits the selected batch together or saves none if a limit or write fails. It never executes SQL or changes a database session. Reviews capture the file contents when opened and expire after ten minutes; changing saved snippets requires a new review. Open an imported snippet in a tab and explicitly run it when ready.

Files support up to 200 snippets, 100,000 characters per SQL template, 5,000,000 SQL characters in total and 32 MiB on disk. The saved library retains its existing 200-snippet / 5,000,000-character limits. Unsupported versions, extra fields and invalid entries are rejected. This format is for Db Commander snippet exchange; use SQL file handling for standalone `.sql` files. See [file format and verification](IMPLEMENTATION.md#snippet-import-and-export).


## Sessions and locks

Right-click the current database and choose **Sessions and locks**, or use Commands. Inspect visible sessions, lock requests and blocking relationships while a query is running or a transaction is open. Select a session for details, follow a waiting/blocking ID, show that session's locks, filter captured rows and refresh manually. Server reads use a separate connection and leave the query tab's results, history and transaction intact.

**Include SQL text** is off by default. Enabling it requires a new refresh; query text can contain secrets. **Save inspection report** explicitly saves the bounded snapshot as JSON, including SQL only if requested, and refuses to replace an existing file. Nothing is saved automatically. Snapshots do not change sessions. Select a session and choose **Review cancellation** or **Review termination** for a separate, single-use review of the command, native identity and transaction impact. Acknowledge the impact and type the displayed confirmation before execution. Identities are rechecked; stale reviews are refused and ambiguous outcomes are never retried automatically. Protected issuing and recognized target profiles must be unlocked.

Visibility depends on engine permissions and instrumentation. Unavailable sections are labeled; an empty view does not prove there are no locks. SQL Server/Azure support remote termination only; use the owning tab’s Stop control for query-only cancellation. SQLite and DuckDB show this application's local connections and last-known transaction state, with lock ownership/wait chains and remote administration explicitly unsupported. See [engine coverage, limits and verification](IMPLEMENTATION.md#session-and-lock-inspection).

Choose **Inspect rollback progress** for a selected session, or use the inspection shown after a reviewed cancellation/termination. **Refresh rollback progress** follows the captured transaction, even after its session disappears; it never sends a control command. Starting a new inspection explicitly replaces that capture. It expires after 30 minutes, is not restored after closing the inspector, and is excluded from the sessions/locks report.

SQL Server/Azure SQL show a native rollback-request percentage when visible. Oracle shows undo usage and, when available, a percentage for parallel transaction recovery. MySQL/MariaDB show InnoDB state and counters. PostgreSQL shows transaction/session state without a rollback percentage. SQLite/DuckDB explicitly report that progress inspection is unsupported. Counters are not a countdown, no ETA is invented, and “no longer visible” or even 100% does not prove that rollback, cleanup or lock release has finished. A target that disappeared before its transaction was captured cannot be followed. See [scope and monitoring privileges](IMPLEMENTATION.md#rollback-progress-inspection).

## Visual query builder

Right-click a table/view and choose **Build query from…**, or open **Visual query builder** from the current database menu or Commands. Choose sources, INNER/LEFT joins (including composite keys and self joins), output columns and aliases, aggregates, WHERE/HAVING conditions, sorting, DISTINCT and a returned-row limit. Non-aggregate outputs automatically form GROUP BY when aggregates are present.

Filters use named parameters such as `min_total`, not literal values. **Review builder SQL** checks fresh schema metadata and generates the engine's SQL without executing it. Copy/save the SQL or **Open SQL in new tab**, then run it deliberately and supply values in the parameter dialog. The source tab's SQL, results and transaction state are preserved; the new tab shares the source connection.

Designs support five sources, 32 outputs and up to 1,000 returned rows. Review requires a complete visible schema snapshot and an idle transaction (autocommit enabled except on Oracle). Save the generated SQL before closing the builder; the visual design is not persisted or reconstructed from SQL. Temporary tables, attached databases and session settings remain available through the shared connection. Use the SQL editor for expressions, casts, CTEs, subqueries, unions, nested predicates and other advanced SQL. See [scope and verification](IMPLEMENTATION.md#visual-query-builder).

## Schema exploration

Right-click a table and choose **Object details** or select an index, constraint, routine, trigger, sequence or other supported object in the sidebar. Filter by name and object kind, inspect metadata and definitions, then copy/save SQL or open it in a new query tab without executing it. Generated summaries and permission limitations are labeled explicitly. See [engine-specific coverage](IMPLEMENTATION.md#rich-schema-exploration-and-object-definitions).

For supported views, routines, triggers and DuckDB macros, **Object scripts** previews available create, alter and drop SQL. Opening a script does not run it. **Edit object source** compares a draft with the loaded definition. Check the current definition, review the exact SQL and its warnings, and approve the target and destructive impact before applying. If the definition has changed, the draft remains available while you compare it with the latest version. The definition is checked again immediately before execution; other sessions are not locked and dependencies can still change.

SQLite view and trigger replacements and MySQL/MariaDB routine and trigger replacements explicitly drop and recreate the object. Review dependencies, grants and the transaction warning: on MySQL/MariaDB, a failed or interrupted creation can leave the original object dropped. Transactional engines require an explicit Commit or Rollback. Oracle may commit a definition that fails compilation; its status and diagnostics are reported rather than treating that as a successful replacement. The source editor separately reviews restoration of an Oracle trigger's enabled state; if either statement fails, inspect the trigger before retrying. Generated definitions can omit properties, and DuckDB macro declarations may omit parameter types or defaults; verify them before applying.

For supported routines, **Call routine** shows discovered arguments and opens a call in a new query tab. Running it prompts for bound values, which are not inserted into the SQL text or query history. Calls can change data or session state. Incomplete or ambiguous metadata, variadic arguments, and output parameters on MySQL/MariaDB, SQL Server/Azure SQL and Oracle require explicit SQL; PostgreSQL procedure output parameters are represented in the generated call. Refresh metadata when the routine changes. Unsupported declarations can still be reviewed and executed explicitly in the SQL editor.

## Schema comparison

Right-click the **target database** and choose **Compare schemas**. Connect the source in another query tab using the same engine, then choose source and target namespaces, object kinds and an optional name filter. SQLite uses its main/attached schemas; DuckDB also selects a catalog. Each side can contain up to 40 visible objects.

The review identifies source-only, target-only, changed, matching and unknown objects, with both definitions and metadata. Select differences to copy/save a SQL review or open it in a new tab connected to the target. Comparison never executes SQL. Safe nullable scalar-column additions are qualified for the target; optional table drops require a separate destructive-SQL checkbox. Missing-table creation, type conversions, defaults, collations, keys, indexes, routines and dependencies require manual SQL using the commented reference definitions. This is a bounded review tool, not an automatic synchronization or complete migration generator.

Matching means identical exposed metadata and definition text. Permissions, omitted engine options, generated names, whitespace and namespace qualifiers affect the comparison; unknown/truncated definitions never produce SQL suggestions. See [scope and verification](IMPLEMENTATION.md#same-engine-schema-comparison-and-explorer-context-menus).

Table **Details / Browse / Edit / Alter** actions are in the table's context menu. Use right-click or focus a database/table and press **Shift+F10** (or the Menu key), then navigate with arrows and Enter; Escape dismisses the menu. Backup/restore uses the current database: select another database first to preserve switching safeguards. **Commands → Database backup and restore** also opens job history when disconnected.

**Browse data** puts a short `SELECT * FROM …` query in the new table tab, with the browser's quoted identifiers, sorting and page limit. The browser applies its own exact-value display conversions internally; running the SQL in the editor uses normal query results.

## Migration-file export

After **Review SQL** in Schema changes, choose **Export migration…**. Schema comparison has the same action for selected generated suggestions. Enter a descriptive name, choose transaction handling, prepare the preview, review the exact file contents and export through the native save dialog. Filenames include a UTC timestamp; the preview also shows a SHA-256 checksum. Existing files are never replaced, and export executes no SQL.

The default leaves transactions to your migration runner. PostgreSQL, SQL Server/Azure SQL, SQLite and DuckDB can optionally include BEGIN and COMMIT. Use an idle connection and a runner that stops on errors; explicitly roll back failures. MySQL, MariaDB and Oracle DDL commits implicitly, so transaction wrapping is unavailable. Destructive exports require a separate acknowledgment.

These are forward SQL files from captured reviews, limited to 1,000,000 UTF-8 bytes. Reviews expire after ten minutes or when a participating connection closes. Export does not revalidate the live schema. Schema-comparison exports contain only supported selected suggestions and retain their partial-scope warnings; deselect reference-only objects and excluded drops before export. No rollback script, dependency ordering, migration ledger, framework-specific format or automatic execution is generated. Files contain object definitions, defaults and target names, so review them before sharing. See [implementation and verification](IMPLEMENTATION.md#migration-file-export).

## Table data comparison

Right-click a target table and choose **Compare data**, or use **Compare table data** from the database menu or Commands. Choose another connected tab using the same engine and select its source table. By default, the comparison uses each table’s declared primary key and all columns. You can choose up to eight key columns and select a subset of columns; key columns are included automatically. Selected column names and native types must match.

Set separate bound AND filters and a row limit (1–200 per side, default 100). Both complete filtered sets must fit that limit: the app refuses partial comparisons rather than treating rows beyond a fetched page as missing. Keys must be unique and non-null within the selected rows. Captures allow 32 columns, 4,096 characters per value and 4 MiB per side; unsupported types, oversized values and changed table definitions stop the comparison. Exclude unsupported columns or narrow the filters before retrying.

The review shows source-only, target-only, changed and matching rows, highlights changed cells, supports searching/filtering the captured results and can save a JSON report containing the values and scope. Nothing is synchronized, and comparisons do not enter history or workspace recovery. The source tabs’ query results and grid snapshots remain available.

These are sequential live reads, not a shared database snapshot. Matching compares exact captured strings, with no collation, numeric/date formatting or JSON normalization; SQLite retains storage-class prefixes. Database permissions can hide rows. Limits bound captured data, not the work needed to scan a table. See [scope and verification](IMPLEMENTATION.md#keyed-and-bounded-data-comparison).

## ER diagrams

Open **ER diagram** in the database explorer to view tables, column types, primary keys and declared foreign keys. Choose up to 40 tables, find table or column names, add visible referenced tables, and inspect ordered mappings for composite keys. Self-references and multiple foreign keys between the same tables remain separate relationships. Arrows point from the referencing table to its target; they do not imply cardinality, uniqueness or active constraint enforcement.

Drag tables, move a focused table with arrow keys (Shift for larger steps), pan the background, zoom, fit or auto arrange, and toggle columns. **Save diagram SVG** exports the current layout through a native file dialog. The SVG contains inert text and shapes, including relationship tooltips, without external resources. Full identifiers and types are available in the details pane when the canvas abbreviates them. Layout and selection last while the dialog is open; reopening reads a fresh diagram.

Diagrams read metadata only and preserve the SQL buffer, results, history, grid snapshots and transaction state. Server engines use a separate catalog connection, so their diagrams show committed, visible objects; SQLite and DuckDB use this tab’s catalog, including attached and temporary objects. Existing permission and catalog limits apply. Oracle uses the current user's catalog scope; MySQL/MariaDB use the current database. Diagrams include base tables, not view lineage or inferred relationships.

Reads are bounded to 40 tables, 100 columns per table / 2,000 total columns, and 200 relationships. Partial metadata and targets outside the selected scope are explicitly labeled. Only outgoing keys of loaded tables are fetched; unseen incoming relationships are not implied absent. Metadata can change during collection, so refresh after DDL. Diagram editing never changes the database. Persistent diagram layouts, PNG/PDF exports and saved/offline diagrams remain follow-up work. Same-engine schema comparison is available separately.

## Values, columns and related rows

Double-click a result cell, focus it and press **Enter**, or use **Inspect selected value**. Inspect captured text, format JSON without rounding large numbers, explore XML structure, or view hexadecimal bytes and offsets. **Load live value** in table data reads a larger value by its captured primary key; it does not rerun your query or replace edit originals. Partial captures are labeled. Copy/save applies to the displayed capture.

In read-only query results, Tab enters the active cell and leaves the cell area on the next press. Arrow keys follow the displayed rows and columns, including pinned and hidden-column choices. Home/End move within a row, Page Up/Page Down move by a viewport, and Cmd/Ctrl+Home/End move to the first/last loaded cell. Navigation does not execute SQL or fetch additional rows.

Use **Columns** to hide, reorder, pin and set widths. Column identities remain stable when editing, and exports still include all fetched columns in their original order. Changes remain independent in each tab. Query result layouts stay in memory; table layouts can be saved explicitly as described below.

Drag the right edge of a column header to resize it in query results, table browsing or editable data. Focus an edge with Tab and use **Left/Right** for 10 px steps, **Shift+Left/Right** for 50 px, **Home/End** for the 90/800 px limits, or **Delete/Backspace** to restore the default 210 px width. **Escape** cancels an active drag.

Double-click a header edge or press **Enter** on it to fit the column to its header and a sample of loaded values. **Columns → Fit** sizes one column; **Fit visible columns** sizes the displayed columns together. Sizing samples at most 200 rows and 200 characters per value, uses staged values where present, and fetches no extra data. Long values can still need the value inspector. Widths survive tab changes and table paging during the session. Saved table layouts also restore after reconnecting or restarting. Local runtime validation passed in the [Workspace/editor regression pass](DRIVER_TESTING.md#workspaceeditor-extensive-regression-pass--2026-10-16); native platform qualification remains in the beta checklist.

For table browsing and editing, **Columns → Save table layout** remembers widths, display order, hidden columns and pinned columns. **Update saved layout** replaces that preference; **Use saved layout** applies it to the current tab. **Reset columns** resets only this tab, and **Remove saved layout** removes the preference while leaving open grids unchanged. Later changes are saved only when you choose Save/Update again.

Saved layouts apply on first opening that table in a session when column names, types and original order still match. Other open tabs keep their own columns. The connection identity includes the engine, server endpoint/login or opened file, database, table and SSH route where applicable. Profile renaming does not lose layouts; profiles for the same connection share them. In-memory databases and attached file databases are excluded. A schema mismatch uses default columns and offers an explicit update. Up to 100 recently saved layouts fit within a one-million-character metadata budget; older preferences are removed as needed. No rows, SQL, filters, sorting or credentials are saved in layouts. [Local runtime validation passed](DRIVER_TESTING.md#workspaceeditor-extensive-regression-pass--2026-10-16); native platform qualification remains separate.

In a table cell inspector, select **Find foreign keys**, then **Follow** a declared reference. Composite keys use all their columns; **Back to source table** restores the source filters and page through a fresh read. Navigation requires idle transaction state and no staged edits. See [limits and engine coverage](IMPLEMENTATION.md#value-inspection-column-controls-and-foreign-key-navigation).

## Query plans

Select a statement in the SQL editor and choose **Query tools → Explain selected SQL**, then **Get estimated plan**. Without a selection, the editor must contain one statement. Every supported engine returns its native plan format; PostgreSQL also has an expandable operator tree with costs, row estimates and node details. Copy or save the captured output without changing your SQL or fetched results.

Queries with `:name` parameters prompt for Text, Integer, Decimal, Date, Timestamp, Timestamp with timezone, Boolean, NULL, Hex or typed array values before collecting a plan. Values are bound through the driver and must be entered again for each plan. History retains parameter names/types, never their values. Captured plans can include values; review them before copying or saving. Oracle estimated plans do not peek at bind values and can differ from actual execution plans. Choose Date, Timestamp or Timestamp with timezone for temporal parameters.

PostgreSQL's **Analyze · executes SQL** mode requires explicit acknowledgment. It collects actual rows, loops, timings and buffers, and follows the tab's transaction mode: writes can commit immediately in autocommit mode, and Db Commander does not automatically roll them back. SQL Server/Azure SQL and Oracle estimated plans use separate connections, so tab-local settings and temporary objects are not included. See [coverage and transaction behavior](IMPLEMENTATION.md#query-plans).

## SSH and connection organization

Connection settings include a folder, favorite toggle and environment label. The sidebar groups profiles into collapsible folders and can show only favorites. Production profiles are always protected; protection can also be enabled for other environments. **Unlock connection** requires the connection name and enables SQL and changes for ten minutes in all tabs sharing that physical connection, including tabs opened during the unlock period. Locking any shared tab locks the connection for all of them. Separate physical connections, database switches and reconnects start locked. Browsing remains available while locked, and Commit/Rollback remain available to settle existing work.

Editing a saved profile leaves live tabs on their existing settings. When those settings differ, the sidebar says **Open tabs use previous settings**, and Connect opens the updated settings separately. Disconnect still applies to all tabs associated with that profile, subject to transaction safeguards.

Saved connection names wrap to show their complete identity, with engine, environment and protection labels below. The heading shows the visible count. Use the star to change a favorite and the connection's **Actions** (ellipsis) menu to edit or delete its saved profile.

For server databases, enable **Use SSH tunnel**, enter a trusted SHA256 host-key fingerprint, and choose password, private-key file or SSH-agent authentication. Database TLS still verifies the configured database host. SSH passwords/passphrases are session-only; saved profiles contain the key path, never its contents. Oracle requires verified TLS through SSH; Azure SQL must use a fixed endpoint/Proxy connection policy. Native MySQL/MariaDB backup tools currently require a direct connection. See [transport, safeguards and limits](IMPLEMENTATION.md#ssh-tunnels-and-profile-organization).

## Schema creation and alteration

Choose **Schema changes** in the sidebar or **Alter** beside a table. Create tables with columns, literal or SQL-expression defaults and primary keys; add, rename or drop columns; rename/drop tables; and create/drop ordinary or unique indexes. PostgreSQL, SQL Server/Azure SQL and DuckDB also support creating schema namespaces. **Review SQL** shows the exact statements and transaction behavior; editing the form requires a new review. You can copy or save the script without applying it.

To change an existing column, select **Alter column**, choose the column, then review a type, nullability or default change. Type and nullability changes require a destructive-change acknowledgment; PostgreSQL and DuckDB also accept an optional SQL conversion expression. SQL Server preserves the existing collation when it applies and reviews removal/recreation of a named default constraint. SQL Server can reject a type change while a default constraint or other object depends on the column; manage dependencies as separately reviewed changes. MySQL and MariaDB carry forward the native column definition, and refuse the change if it cannot be reconstructed safely. If a nullable MySQL column has no default, two separately committed statements restore that state; the review warns what happens if the second fails. MariaDB represents an absent default on a newly nullable column as DEFAULT NULL. Their strict modes and default rules still apply; MySQL can reject an omitted value after its default is dropped, even on a nullable column. SQLite 3.53+ supports selected NOT NULL changes here; other SQLite alterations need a separately reviewed migration. Oracle preserves `DEFAULT ON NULL` when changing its value, but removing that property requires separate SQL.

PostgreSQL can also add or remove identity, change its mode, and remove a stored generated expression. PostgreSQL 17+, MySQL and MariaDB can replace a generated expression; MySQL/MariaDB retain its existing storage and other native column attributes. MySQL and MariaDB can also add or remove AUTO_INCREMENT on a suitable indexed integer column. Oracle can change or remove identity on an existing identity column, and replace supported virtual expressions while preserving their native types. Edition-dependent virtual columns, nondefault collations and types whose definitions cannot be safely retained require separate SQL. These changes require acknowledgment and a SQL review. Adding a PostgreSQL identity does not align its new sequence with existing values; inspect the sequence and uniqueness before future inserts. Adding AUTO_INCREMENT can change existing zero values depending on SQL mode, and foreign-key dependencies can block the change. Replacing a stored expression rewrites existing values, while removing it leaves the stored values in place and stops future recalculation. MySQL virtual expressions may produce out-of-range values that fail on later reads; review data, SQL mode and dependent indexes. Oracle identity removal also removes its sequence and identity-imposed NOT NULL and NOT DEFERRABLE constraints; changing its mode may remove BY DEFAULT ON NULL behavior. Other existing generation changes require separately reviewed SQL or a migration.

For a column, **Type** offers mapped types and a list of the selected engine’s native built-in types. Native types expose their supported length, precision, scale or fractional precision. PostgreSQL and DuckDB also offer arrays. For PostgreSQL, DuckDB, SQL Server/Azure SQL and Oracle, select **Schema-qualified user-defined type** and enter its names separately; DuckDB also accepts a catalog. The database validates type availability and permissions when applying, so review user-defined type definitions separately. PostgreSQL 15+ and Oracle allow some negative scales and scales larger than precision.

An expression default is SQL evaluated by the database and can invoke functions with side effects. Enter one line without comments or statement separators and review its exact text and behavior. The database validates whether it is allowed for the selected column. SQLite does not allow expression defaults when adding a column; use a literal or a separately reviewed migration. SQL Server and Azure SQL leave existing rows NULL when a nullable column with a default is added; new rows use that default when omitted.

Choose **Generation** for an identity or a generated expression. Identity columns cannot also have a default and are not nullable. PostgreSQL and Oracle offer **Always** or **By default**; SQL Server uses an identity, MySQL/MariaDB use `AUTO_INCREMENT`, and SQLite uses `INTEGER PRIMARY KEY AUTOINCREMENT`. MySQL/MariaDB require the identity to be indexed: place it first in the primary key or select its own unique key. SQLite cannot add an identity to an existing table; DuckDB does not expose identity columns and can use a reviewed sequence default instead.

Generated expressions are evaluated by the database and cannot be edited directly. PostgreSQL supports stored generated columns and, from version 18, virtual columns. SQLite can add a virtual generated column but not a stored one; DuckDB supports virtual generated columns at table creation, not through Add column. Oracle uses virtual columns. SQL Server infers computed-column types and calls stored values **Persisted**; MySQL and MariaDB support virtual and stored columns. Generated primary keys and nullability depend on the engine and storage mode. The database validates expression dependencies and determinism; review both the expression and its effects.

Add named check, unique and foreign-key constraints when creating a table. Select composite columns in matching order; their numbers show the order selected. A foreign key may refer to the table itself or a visible table, with engine-specific delete and update actions. PostgreSQL, MySQL, MariaDB, SQL Server/Azure SQL and Oracle can also add, drop or replace these constraints on existing tables. SQLite and DuckDB require a separately reviewed migration for those alterations. SQLite foreign-key enforcement depends on each connection’s `PRAGMA foreign_keys`; DuckDB foreign keys are limited here to the active catalog.

Dropping or replacing a constraint requires a destructive-change acknowledgment. Cascading, set-null and set-default foreign-key actions also require it because future parent changes can modify or delete related rows. On Oracle, replacement runs separate implicitly committed drop and add statements: if the add fails, the original constraint is gone. Review the SQL, warnings and dependent data before applying. The editor checks both table definitions for foreign keys when reviewing and again before applying, but it does not lock them between inspection and execution.

For indexes, select column keys in order; their numbers show the selected column order. Optionally mark keys descending where supported. DuckDB does not retain descending index order. MySQL requires version 8+ and MariaDB 10.8+ for descending keys; verify that the table storage engine supports them. MySQL and MariaDB can index a prefix of a text or binary key: lengths are characters for nonbinary text and bytes for binary data. In a unique index, prefix keys compare only the specified prefixes alongside any other keys; the storage engine and character set determine length limits. PostgreSQL offers B-tree, hash, GiST, GIN and BRIN methods; the database checks operator classes and column types. PostgreSQL 11+ and SQL Server/Azure SQL can include non-key columns; PostgreSQL GiST indexes require version 12+ for included columns. PostgreSQL, SQLite and SQL Server/Azure SQL can review partial or filtered indexes using a SQL predicate. The database validates predicate restrictions.

PostgreSQL, SQLite 3.9+, DuckDB, MySQL 8.0.13+ and Oracle support expression index keys here. Place each expression before the column keys or after a selected column; expressions at the same position use the order shown. Expressions and their functions run in the database during index creation and subsequent writes. Review their effects, determinism and dependencies; function definitions are not locked by the review. MySQL implements functional keys using hidden generated columns. MariaDB and SQL Server/Azure SQL require a separately defined generated or computed column for this workflow.

PostgreSQL indexes can be created concurrently from an idle autocommit connection. This operation cannot be rolled back. If a build fails or is cancelled, inspect the database for an invalid index and remove or repair it explicitly; an invalid unique index may still enforce uniqueness. Exported migrations for this option must also run without a transaction wrapper. PostgreSQL applies its own restrictions, including restrictions on partitioned tables. Online index creation on other engines is not offered here.

Start from an idle session with staged grid edits resolved. PostgreSQL, SQL Server/Azure SQL, SQLite and DuckDB normally leave successful changes in a new transaction: close the dialog and choose **Commit** or **Rollback**. PostgreSQL concurrent index creation is the autocommit exception described above. MySQL, MariaDB and Oracle DDL commits immediately and requires a separate acknowledgment. Destructive changes require acknowledgment too. **Cancel schema change** requests cancellation; connection loss or implicit commits can leave an unknown outcome. Nothing is retried automatically. See [supported operations and limits](IMPLEMENTATION.md#schema-creation-and-alteration).

## Data import and export

Use **Query tools → Data import and export** to append CSV, TSV, Db Commander JSON or JSON Lines data to a reviewed table with a preview and column mapping. Successful imports stay in the tab's transaction for explicit **Commit** or **Rollback**; failed or cancelled imports roll back the batch.

JSON import reads the same columns-and-rows format as full-result JSON export. Keep `columns` before `rows`, give each column a unique name, and use strings or `null` for cells. Quote numbers to retain exact integer and decimal values; `typeId` and `typeName` metadata are optional and do not override the target table's types.

```json
{"columns":[{"name":"id"},{"name":"note"}],"rows":[["9223372036854775807",null],["1",""]]}
```

The preview reads ten rows; the rest is validated during import. Files are streamed, with limits of 100 columns, 16,384 characters per string and 1,048,576 raw JSON characters per header, row or separator region. Empty strings differ from NULL (except in Oracle); `"\\N"` is literal text in JSON. Alias duplicate query columns before exporting for import. Arrays of objects, nested cells and raw numeric/boolean cells are not accepted. Imports use the existing scalar-column restrictions; binary/complex values require conversion before import. Changed files require a new preview.

Choose **Export preview** in the results toolbar to save the selected result's already-fetched rows as CSV. It never runs SQL again, including when the preview is limited. **Export all rows** opens a review of that result's source SQL and connection, independently of later editor changes. Choose CSV, TSV, JSON, JSON Lines or SQL INSERT, review the single SELECT/CTE and new destination, then confirm **Run and export**. This runs the reviewed query again and streams beyond the preview limits; current data may differ. Existing files are refused. Bound parameter values must be entered again and are never recovered from an earlier run.

A result can belong to an entire SQL Server batch or have no safely mapped source SQL. In that case, review and isolate one read query explicitly; scripts and mutations cannot be exported by rerunning them. **Query tools → Data import and export** remains available for an explicit editor selection or buffer review. Both full-export entry points retain transaction/connection protections, cancellation and complete-file publication. See [formats, transaction behavior and limits](IMPLEMENTATION.md#data-import-and-full-result-export).

**SQL INSERT script** exports one INSERT per row for the connected engine. Enter a destination table and optional schema/database as separate names without quoting. Result names become quoted column names; alias duplicates and omit identity/generated columns in the SELECT. The destination need not exist yet. Export only writes the file; review it and arrange compatible table types, constraints and transaction handling before running it. No table creation, identity override or automatic COMMIT is included. Parameters, progress, cancellation and complete-file publication use the existing export flow.

INSERT export supports known scalar types with exact numeric strings, engine-specific text/binary literals and explicit temporal conversions. Unknown/complex types, ambiguous SQLite expressions/storage and excessive values fail without publishing a partial file. Limits include 100 columns, 16,384 characters per value and engine-specific identifier/literal limits. MySQL/MariaDB TIMESTAMP replay requires the intended session timezone. See [SQL INSERT export details and validation status](IMPLEMENTATION.md#sql-insert-export).

Queries containing `:name` parameters open a values prompt before export. Choose **Export with parameters** after entering typed parameter values. Cancel returns to the reviewed transfer without running SQL or creating a file. Values must be entered again for each export; history and workspace recovery never save them. Exported rows can contain the supplied values. The query-plan dialog also supports bound parameters.

### Reuse column mappings

After previewing, name and **Save mapping**. Choose a saved mapping to restore the reviewed assignments, then confirm the transfer again. Compatibility requires the same engine, exact source headers and exact destination column names/types. Update or remove the selected mapping in this dialog. Up to 50 mappings are stored in the local workspace; they contain names, column metadata and assignments only. File paths, rows, SQL and credentials are not stored in mappings. A saved mapping never bypasses file, schema, type, session or transaction checks.

### Import into a new table

Choose an import file and **Create table from file preview**. Suggestions use at most ten rows: canonical signed 64-bit integers become BIGINT, exact decimals within supported precision become DECIMAL where safe, and lowercase boolean words are suggested only on compatible engines. Leading-zero, empty-sample and ambiguous values remain text. SQLite decimals remain text to avoid affinity rounding. Oracle defaults to VARCHAR(4000); all suggested columns allow NULL. A sample cannot prove later rows fit, so review names, types and sizes. Headers that cannot be used as SQL column names receive editable `column_N` suggestions; map those source headers explicitly after creation.

**Review CREATE TABLE SQL** shows the existing schema-change review, warnings and transaction behavior. Confirm creation separately. On transactional-DDL engines, **Commit created table and continue** commits only that empty table before previewing rows. On implicit-commit engines, explicitly approve that behavior. Then preview, map and import the file normally. A failed/cancelled row import rolls back its rows; an already committed empty table remains. Drop it explicitly if unwanted. No rows are automatically imported or retried after table creation.

### JSON Lines

Db Commander JSON Lines is a streaming format with one columns object on the first nonblank line and one array of string/null cells on each later nonblank line. It uses the same optional column metadata and exact-value rules as JSON. Multiline values use JSON escapes. It is not an array-of-objects format.

```jsonl
{"columns":[{"name":"id"},{"name":"note"}]}
["9223372036854775807",null]
["1","line one\nline two"]
```

The same column/cell limits apply; each physical line is limited to 1,048,576 UTF-16 characters. Export publishes only a completed file and refuses an existing destination.

### Copy between connections

Open the dialog in the **destination** tab and choose **Copy from another connection**. Choose a distinct physical source connection, review one SELECT (and bound values if needed), and select an existing destination table. Shared tabs on the same physical connection cannot be used as both ends. Both connections must be idle, without staged edits, with autocommit enabled where required. Existing protected-connection approval remains required.

**Capture source rows** reserves both connections while streaming the full source result to a private temporary file; nothing is inserted yet. Review **captured rows**, scope, destination and mappings before **Import into transaction**. Copy imports those captured bytes once and never reruns the source query. Later source changes therefore do not alter the reviewed copy. This is the source query's normal database consistency, not a cross-database transaction or a schema/native-binary migration; destination types and constraints still apply. SELECT functions can have side effects. Parameter values are not saved, but returned rows can contain them.

At most two captures are retained for ten minutes. **Discard captured rows**, expiry, consumption and normal application shutdown remove their private temporary files. Captures do not recover after restart. An abrupt process/OS failure can leave a `dbcommander-transfer-*` folder in the OS temporary directory; remove it when the app is closed. Captures contain full returned data, with private directory/file permissions where supported by the OS. Avoid capturing data that should not be written temporarily to disk.

Capture cancellation publishes no usable capture. Copy errors/cancellation roll back the destination batch; success leaves it in a transaction for explicit **Commit** or **Rollback**. A consumed capture cannot be retried: capture and review again deliberately. If a database connection is lost and rollback cannot be verified, the outcome is reported as unknown; inspect it before any further action. No job resumes or replays SQL automatically.

## Update notifications

Db Commander checks the latest published stable [GitHub Release](https://github.com/ziodex/db-commander/releases) at startup and every 24 hours while running. After sleep it checks when overdue. A newer version appears in a dismissible banner with **Release notes & download**, which opens the release page in your browser. Dismissal is remembered for that version across workspace windows and restarts; a later version can notify you again.

Use **Help → Check for updates** for an immediate check, including a release you previously dismissed. This reports up-to-date, unavailable, and connectivity states without blocking the editor. Background failures stay quiet. Checks request only public release metadata; they do not send SQL, connection details or saved credentials.

Installation stays manual. The app does not download packages, install updates, close sessions or restart itself. Save your work, settle transactions and quit before replacing the application. Until a public stable release is published, manual checks report that no public release is available.

## Saved connections and query tabs

Right-click a query tab and choose **Pin tab**, or use **Commands → Pin query tab** for the active tab. Pinned tabs show a pin icon, stay together at the left and have no close button. Choose **Unpin tab** before closing; unpinning still leaves the normal unsaved-change, query and transaction safeguards in place. Pinning preserves SQL, file associations and active sessions, and is saved across restarts. New tabs start unpinned. Pinning does not save SQL to a file or automatically reconnect a restored tab.

Drag a query tab to reorder it, or right-click it for **Move tab left/right/to start/to end**. With a tab focused, **Ctrl/Cmd+Shift+Left/Right** moves it one place; **Ctrl/Cmd+Shift+Home/End** moves it to an edge of its pinned or unpinned group. Drag moves also stay within that group. **Shift+F10** opens the tab menu; plain arrow keys switch between all tabs. Pinning adds a tab to the end of the pinned group; unpinning places it immediately after that group. Reordering preserves the active tab, buffers, results and sessions, including running queries and transactions. The order is saved with the workspace and restored after restart. These controls have [passing local runtime coverage](DRIVER_TESTING.md#workspaceeditor-extensive-regression-pass--2026-10-16).

Use **New saved profile** in the sidebar to save connection details without connecting, or leave **Save connection profile** checked when connecting. Profiles include the engine, endpoint/file, database, user, authentication mode and TLS settings. Passwords are saved only when you explicitly choose **Remember password**; otherwise enter them again when opening a server profile. Azure access tokens are never saved. Right-click a saved connection for **Connect**, **Disconnect**, **Edit connection** and **Delete connection**. Connect uses saved credentials directly; failures show a warning with an option to edit the connection. A green dot marks connected profiles, and a row highlight identifies the saved connection associated with the active tab. Existing tabs keep their current connection and settings; edits apply when a profile is opened or reconnected.

Choose **Test connection** while creating or editing a profile to check the current form values before saving. The test opens and closes a separate temporary connection, leaving open tabs, SQL, results and saved settings unchanged. **Use saved password** is available when the endpoint and trust settings still match the saved profile; a typed password takes precedence. For Microsoft Entra authentication, enter a current token to test; the token remains optional when only saving the profile. Testing supports existing SQLite/DuckDB files and temporary in-memory databases; it never creates a new database file.

Click a saved profile to open it in a new query tab. **New query tab** or **Cmd/Ctrl+T** reuses the active tab's existing connection when connected. Browse tabs also share that connection. Each tab keeps its SQL buffer, undo/cursor state, results, messages and table snapshot. Temporary tables, session variables, in-memory databases and transactions belong to the shared connection.

The tab subtitle and connection bar identify the physical connection. **Tabs on this connection** lists its owners and switches to an existing tab. The sidebar's **Search connections** matches names, folders, engines, hosts, databases, usernames and file paths. A saved profile's **Switch to open tab** action focuses an existing tab without opening a connection. **Commands** (**Cmd/Ctrl+K**) also searches open connection/tab targets, including separate connections to the same saved profile.

Use **Connection tabs → New independent connection**, or the same action on a saved profile's context menu, to open a separate physical connection in a new tab. Authentication stays in the main process. The new connection starts with its own transaction, temporary objects and protection state; an in-memory database starts empty. Existing transactions and SQL buffers are kept. **New shared query tab** explicitly shares an open connection; clicking an already-connected profile prefers the active matching connection before another matching open connection. Connection numbers are local navigation labels, not server IDs or persisted sessions.

Choose **Duplicate connection** to review a new profile with a new name. Saving the copy keeps the original and does not copy its saved password or OS-store reference. Under **Saved connection actions**, **Export connections without credentials** exports all saved profiles; a profile's context menu can export just that profile. Import accepts a UTF-8 Db Commander connections JSON file, up to 100 profiles and 8 MiB, and previews the selected entries. Existing names are skipped by default or kept as renamed copies; existing profiles are never replaced. Capacity is checked before applying the batch. Imports assign fresh IDs, never connect or execute SQL, and exclude passwords, tokens, SSH passwords/passphrases and OS credential references. Files still contain connection details such as server names, usernames, trust certificates and local paths; review them before sharing. Exports require a new filename and never overwrite an existing file.

Queries can run concurrently on different physical connections; tabs sharing one connection serialize database work. Switching tabs never cancels work, and CSV export retains the latest fetched results separately for each tab. Transaction changes appear in all tabs sharing the connection. Closing an idle tab releases its results and disconnects only when the last tab using that connection closes. The saved-connection **Disconnect** action disconnects all its tabs while retaining their SQL. Stop, commit or roll back before closing a busy tab; the tab-close preference controls the ordinary confirmation. Save SQL to a file if you need to keep a closed tab's text. Quit checks queries and transactions across **all** tabs and flushes the workspace save.

Db Commander restores tab order, active tab, SQL buffers and non-secret profiles after restart or renderer recovery. It never reconnects or executes restored SQL automatically. Results and live sessions are not persisted. This preview allows 20 tabs, 100 saved profiles, one million SQL characters per tab and five million across the workspace. Existing single-console workspaces migrate to the version-2 JSON format with a `workspace.sqlite.v1-backup-*` snapshot. The query library upgrades the storage schema to version 3 and backs up existing version-2 databases as `workspace.sqlite.v2-backup-*`; history is retained. Workspace files and migration backups contain SQL text and are not encrypted.

## Optional saved passwords

Profile edits, deletion and explicit password removal commit workspace changes before removing stored credentials. Failed workspace saves keep the existing password. Cleanup failures are reported and retained for retry on the next save or workspace opening; unlock the OS credential store and check free disk space before retrying. Password contents are never written to the cleanup journal.

Choose **Remember password** when connecting with **Save connection profile** enabled, or in **New saved profile / Edit profile**. Storage is opt-in for each profile. **Save profile** stores the password without connecting; **Connect** remembers it only after authentication succeeds. Nonempty server passwords are supported for PostgreSQL, MySQL, MariaDB, SQL Server, Azure SQL password authentication and Oracle. SQLite/DuckDB need no password, and Entra access tokens remain session-only.

| Platform | Credential store |
| --- | --- |
| macOS | Keychain |
| Windows | Credential Manager |
| Linux | A persistent Secret Service provider, such as GNOME Keyring or compatible KWallet configuration |

When reopening a profile, **Use saved password** connects without displaying or returning the password to the editor. Leave the password field blank to keep the saved value, or type a replacement and save/connect with Remember password checked. **Remove saved password** requests removal immediately; unchecking Remember password requests removal when you save the profile or successfully connect. Deleting a profile saves its removal before clearing the stored password. If credential cleanup fails, the profile change remains saved and cleanup stays pending for retry. A replacement password waits for pending cleanup to finish. Existing live sessions are unaffected; new tabs from a live session reuse that existing connection.

Saved passwords are bound to the profile ID, engine, host, port, database/service, user, authentication mode and TLS/CA settings. Renaming a profile preserves its password. Changing connection settings requires an explicit password; saving those changes removes the previous credential. Profiles still do not reconnect automatically after restart or renderer recovery.

The OS may ask to unlock or allow access to its store. When storage is unavailable, the app explains the problem and keeps session-only connections available; it never writes a plaintext fallback. Linux requires a working Secret Service session: kernel-only keyrings and Electron's `basic_text` storage are not used. A missing saved entry prompts you to enter it again or remove its reference. Storage errors are reported; after a failed save, a non-secret reference may remain so the attempted entry can be retried or removed.

Workspace SQLite files, profile JSON and history contain no application-inserted passwords or tokens. They remain unencrypted and can contain sensitive SQL you type yourself. Credentials are local to the OS account and workspace location; copying a workspace file does not transfer its passwords. Remove remembered passwords before discarding a workspace or uninstalling if you want to delete its OS-store entries. OS store access policies and other programs running as your user still apply.

## Server connections and database switching

Leave **Database** blank when connecting or saving a server profile:

| Engine | Initial connection without a database |
| --- | --- |
| PostgreSQL | Uses the maintenance database `postgres`. Specify another accessible database if `postgres` is unavailable. |
| MySQL / MariaDB | Connects without a default database; qualified SQL and server queries still work. |
| SQL Server | Uses the login's default database. Enter an explicit fallback if that default cannot be opened. |
| Azure SQL | Uses logical-server `master`. Contained users may need an explicit database. |
| Oracle | A service/PDB endpoint remains required. Open another connection for a different service. |
| SQLite / DuckDB | Continue using local files and session-specific attached catalogs. |

The sidebar lists databases below this tab's server. Its current database expands into schemas and tables/views. **Refresh databases** reloads the list. PostgreSQL filters connection privileges and databases that allow connections. MySQL/MariaDB verify catalog-visible names with `USE` on a disposable connection. SQL Server checks online state and `HAS_DBACCESS`; Azure SQL reads `master` and attempts separate connections to its visible databases. Azure accounts without access to `master` see the current database and an explanation. Catalog visibility, host authentication rules, transient availability and changing permissions can limit discovery or make a listed target fail to open; an explicit database connection remains available.

Choose another database and confirm **Switch database**. A fresh physical connection is opened before the old one closes. Failed target connections leave the original session usable. A successful switch clears this tab's results/edit snapshot and reloads schema/autocomplete; it preserves the SQL buffer and other tabs. The confirmation explains that temporary objects and session settings are lost. Switching is refused during queries, metadata/table operations, staged edits, non-idle/unknown transactions or manual commit mode. Commit/rollback and re-enable autocommit first.

The saved profile retains its original database setting, including blank server profiles. Each tab records its selected context; new tabs opened from a live tab share its physical connection and selected context. Opening or reconnecting a saved profile still uses that profile's configured initial database. No SQL is replayed and no connections are restored automatically.

## Database backup and restore

Right-click the current database in the sidebar and choose **Database backup and restore** to create native backups or restore into a new database, schema or file. Review the source, target and scope before confirming. Jobs support cancellation, diagnostics, tab operation guards and recovery of interrupted jobs as unknown. Local files are published only after completion and never overwrite an existing destination.

PostgreSQL, MySQL and MariaDB require matching native client tools. SQL Server backups and Oracle Data Pump dumps live on the **server**; SQLite and DuckDB use consistent local snapshots. Azure SQL uses a separately billed **database recovery copy**, with restore by copying it to another new database. It does not accept SQL Server `.bak` files or implement BACPAC/PITR. See [backup formats, permissions, usage and limitations](BACKUP_RESTORE.md).

## Panel layout

Drag the sidebar edge or the divider above results to resize panels. Header buttons and the **View** menu show or hide each panel independently. Results also have **Maximize / restore results** and **Hide results** buttons. These commands are available in **Commands**.

| Action | Shortcut |
| --- | --- |
| Show/hide sidebar | Cmd/Ctrl+B |
| Show/hide results | Cmd/Ctrl+J |
| Maximize/restore results | Cmd/Ctrl+Shift+J |
| Reset layout | Cmd/Ctrl+Alt+0 |

Tab to a divider and use its arrow keys to resize by 10 pixels, or Shift+arrow for 50 pixels. Home/End select the size limits, Enter hides its panel, and double-click restores that panel's default size. Escape cancels a drag. Use the header controls or shortcuts to bring hidden panels back.

Panel visibility, preferred sizes and results maximization are saved per workspace, shared across query tabs, and restored after restart. Smaller windows temporarily constrain sizes without overwriting your preferences. **Reset layout** restores a 234-pixel sidebar and 320-pixel results panel, both visible. Hiding or resizing panels preserves editor state, results, scroll positions and staged edits; queries and transactions keep running. Sessions and unapplied edits remain subject to the normal quit/recovery rules above.

## SQL autocomplete and formatting

Press **Ctrl+Space** in the SQL editor for suggestions, or type an identifier prefix or a dot. Db Commander suggests schemas/catalogs, tables/views and columns with their data types and nullability. It resolves table aliases (including a `FROM` clause after the cursor), basic joins and CTEs with explicit columns or simple SELECT projections. Inserted database identifiers use the selected engine's quoting rules. Keywords and common functions remain available when disconnected. Suggestions use only the current tab's schema snapshot; typing never executes SQL.

Schema snapshots load on connection and refresh after schema/context-changing executions, including commit/rollback. Use **Refresh schema** to discover changes made by other clients or retry a metadata failure. Snapshots are bounded to 2,000 objects / 10,000 column rows; the sidebar reports incomplete or unavailable metadata. PostgreSQL lists accessible non-system relations, MySQL/MariaDB the current database, SQL Server/Azure SQL the current database's visible objects, and Oracle the login user's objects. These server adapters use separate catalog connections, so their snapshots exclude session-local temporary tables, uncommitted DDL and session-only namespace overrides. SQLite/DuckDB inspect the tab's idle session and include temporary/attached objects. Queries wait while a schema refresh is active in their tab.

The separate catalog preview prioritizes tables and views before indexes, constraints and other objects within its 2,000-object limit for PostgreSQL, MySQL/MariaDB, SQL Server/Azure SQL, Oracle and SQLite/DuckDB. PostgreSQL and Oracle also prioritize materialized views. SQLite checks every attached database before applying the combined limit. Column suggestions can still be incomplete at 10,000 rows; **Object details** can load columns for a table retained in the catalog even when its columns are outside that preview. Catalog pagination and broader platform/service qualification remain follow-up work. See the [embedded](DRIVER_TESTING.md#large-embedded-catalogs--19-october-2026), [local server](DRIVER_TESTING.md#large-server-catalogs--19-october-2026) and [Oracle checks](DRIVER_TESTING.md#large-oracle-catalogs--20-october-2026).

Opt-in performance checks grow private catalogs to 10,000 and 20,000 constrained tables: `pnpm test:catalog-performance` covers embedded drivers and the desktop; `pnpm test:server-catalog-performance` runs disposable server fixtures sequentially. Add `--driver mariadb --desktop` for the MariaDB desktop workload. MySQL/MariaDB column previews first bind a bounded set of visible table names, avoiding a large metadata join while retaining empty-column objects and existing limits. See [performance commands and measured scope](DRIVER_TESTING.md#larger-catalog-performance--20-october-2026).

Use **Format SQL**, **Shift+Alt+F**, or the editor context menu to format the document or selected SQL. Formatting runs locally in a Web Worker, uses the tab's dialect and preserves identifier/keyword case. It creates undoable edits without executing SQL or adding history. T-SQL `GO` lines and repeat counts are retained. A token-preservation check rejects unsafe transformations; failures keep the original text. Procedural bodies, MySQL/MariaDB `DELIMITER` scripts and unsupported syntax should be formatted as smaller ordinary SQL selections. Formatting/completion process at most 200,000 SQL characters per request; formatting has a three-second worker timeout.

The completion engine is a tolerant editor helper, not a full SQL compiler. Arbitrary derived-table projections, correlated/nested CTE inference, stored-procedure arguments and semantic error checking remain future work. Ambiguous unqualified table names should be schema-qualified.

### Split query editors

Tabs already support drag-and-drop ordering, keyboard moves and pinning. Use **Editor views → Split editor side by side / stacked**, or a tab's right-click menu, to display up to four different queries at once. A split shows another open tab, or creates an empty disconnected tab when all tabs are already visible. Each view has a query selector and a focus indicator. Click its editor or use **F6 / Shift+F6** to change the active view; shared commands, connection details and results follow that view. Tabs retain independent SQL selections and undo history. Tabs sharing a physical connection also share its transaction and protection state.

Drag separators or use their arrow keys to resize views; Shift changes sizes in larger steps, Escape cancels a drag, and Enter/double-click equalizes the adjacent views. Arrange editors changes orientation without adding views. Hide view and Single editor view retain all tabs and sessions. Selecting an already visible tab focuses it; selecting a hidden tab replaces the active view. Layout and sizes survive restart, with tabs disconnected as usual. Results have their own **Split results** comparison pane described below; cross-window tab transfers remain future work. [Local Workspace/editor validation passed](DRIVER_TESTING.md#workspaceeditor-extensive-regression-pass--2026-10-16); native platform qualification remains separate.

### Editor settings

Open the sidebar cog or **Workspace → Preferences**, or search for **preferences** in **Commands**. Set font size, line wrapping, absolute/relative/hidden line numbers, minimap visibility, automatic suggestions, indentation using spaces or tabs, inline expression width and blank lines between statements. **Ctrl+Space** still opens suggestions when automatic suggestions are disabled.

**Apply settings** saves these choices for all application windows, query tabs and future launches. **Cancel**, Escape and the close button discard the draft. **Reset defaults** changes the draft until you apply it. Defaults are 13 px text, wrapping, absolute line numbers, no minimap, automatic suggestions, two-space indentation, expression width 50 and one blank line between statements.

Preferences are grouped into **Display**, **Shortcuts**, **Tabs**, **Indentation**, **SQL formatting** and **Import / export** tabs. Fields scroll independently while Apply, Cancel and Reset defaults remain visible. **Tabs** includes confirmations for closing tabs and switching databases, both enabled by default. Disabling a confirmation retains running-query, transaction and staged-edit safeguards.

Under **SQL formatting → Formatting settings for**, choose a database type and enable **Use custom formatting** to override its indentation and spacing. Each type inherits global defaults until customized; SQL Server and Azure SQL can have different styles. Custom formatting applies to all tabs using that database type, including disconnected tabs, and to document or selection formatting from the toolbar, shortcut or editor context menu. Turn off custom formatting to follow the current defaults again. Reset defaults clears all custom styles when applied.

**Export applied settings** writes editor preferences and all custom formatting styles to a new JSON file. Unapplied edits are excluded. **Import settings** loads a file into the draft; review it, then **Apply settings** to replace your editor preferences and custom styles, or Cancel to keep the current settings. Files contain no connections, credentials, SQL, history, results or table layouts. Version-1 UTF-8 JSON exports up to 64 KiB are accepted; invalid or newer files are refused, and existing export destinations are never overwritten. See the [completed local validation](DRIVER_TESTING.md#workspaceeditor-extensive-regression-pass--2026-10-16).

Applying settings preserves SQL text, undo history, file associations, results and database sessions. Global indentation controls typing, tab display width and default SQL formatting; database-specific indentation applies only to explicit formatting. Existing whitespace is not converted automatically. Expression width controls inline expressions, not the length of every output line. Letter case remains unchanged. These controls have passing local unit, Docker and desktop coverage. See [implementation](IMPLEMENTATION.md#per-engine-sql-formatting) and [completed local validation](DRIVER_TESTING.md#workspaceeditor-extensive-regression-pass--2026-10-16).

## Browse, filter and sort table data

Click a table or view in the explorer and choose **Browse data**. This opens a new tab named after the table, using the existing connection, with the initial browse query in the SQL editor. The compact results toolbar includes paging, filters, columns and copying; **Table actions (⋯)** contains Edit this page, Reload data and Close data. First, Previous and Next fetch pages from the database; choose 25, 50, 100 or 200 rows per page. **Filters & sort** applies up to eight AND-connected filters and three sort priorities on the server. It supports typed comparisons, literal Contains/Starts with searches and explicit NULL checks. Changing filters, sorting or page size returns to the first page. Cancel leaves the applied choices unchanged.

Sorting uses native values, with NULLs last and primary-key columns as tie breakers where available. Tables without primary keys and views are browsable, with a notice that tied rows may move between pages. Pages are live reads: concurrent inserts, deletes or changes to sort/filter values can also move rows. Reload fetches the current page again. Large offsets and unindexed filters can be expensive; this is offset pagination, not a database snapshot or a full-result export. There is no automatic total-row count; one extra row determines whether Next is available. The maximum offset is one million rows.

**Table actions (⋯) → Edit this page** fetches fresh originals for eligible keyed base tables. Staged edits block page/filter changes, and each tab retains its own applied browsing choices. Commit or Rollback keeps the page and filter settings; Reload data refreshes it before further editing. Ordinary SQL execution replaces the table view. Restart does not restore table results or execute browsing requests. SQLite/DuckDB files opened read-only can still be browsed.

The browser shows up to 100 columns. Large displayed cells are limited to 16,384 characters, and pages exceeding 8 MiB are refused. Unsupported complex/binary types show an explicit placeholder; use SQL to inspect them. SQLite binary storage is displayed as hexadecimal. Value filters and sorting are disabled for unsupported types, while NULL checks remain available. Comparison, case sensitivity and text rules follow the connected database, including Oracle's empty-string-as-NULL behavior. Viewing data requires an idle tab; finish its transaction and enable autocommit first (Oracle's idle manual mode is supported).

## Explore loaded query results

**Find** searches the displayed columns of the loaded result, including captured text beyond the cell's shortened display. Focus a result cell and press **Cmd/Ctrl+F** to open it. Enter/Shift+Enter and Next/Previous move between matching cells; Escape in the search field clears the search. **Match case** controls Find and text filters. Counts describe matching cells, with navigation bounded to the first 10,000 matches. Hidden columns and rows excluded by filters are outside this search.

**Filter / sort** opens a local view editor. Add up to eight AND-connected filters and three sort priorities, then choose **Apply locally**. Contains, does not contain, starts with, comparisons and explicit NULL checks are available. Choose column type, exact number or text for comparisons and sorting; exact number is useful for untyped expressions. Numeric comparisons preserve captured decimal/scientific values and large integers without converting them to JavaScript numbers. Text sorting uses captured character order, not database collation; NULL sorts last in either direction and tied rows retain their source order. Cancel keeps the applied view; **Reset view** removes local filtering and sorting.

These controls never run SQL or fetch additional rows. Counts and preview-limit warnings remain visible; zero matching loaded rows does not prove that the database has no match. Source row numbers remain attached to their original captured rows after sorting. **Copy** follows the shown rows and columns; **Export preview** still exports the selected live result's entire fetched cache in original order, including rows excluded by local filters. **Export all rows** retains its separate reviewed execution of the original source. Table browsing's server-side filters and sorting are separate.

### Pin and compare results

**Pin snapshot** captures the full loaded result and its current view, opens a comparison pane, and keeps the capture through reruns, tab closure and disconnect. Rename it in **Snapshot name**, reopen it from the pinned shelf, or remove it. Source identity records the query tab, engine, connection and database at execution start; scripts may change context afterward. Incomplete previews and captures made during running/failed/cancelled or unknown-outcome executions retain explicit warnings. Pinning does not finish the query or guarantee a consistent database snapshot.

Pinned results are read-only captures held in this window's memory. They are excluded from workspace recovery and history and disappear when the window closes or reloads. Up to 12 captures fit within a 32 MiB estimated payload budget; exceeding either limit refuses the new capture without evicting or truncating an existing one. Removing a snapshot frees its capture budget. This is a retention bound, not a total process-memory limit.

**Split results** compares another live result set or a pinned capture beside the selected live result. Each pane has its own Find, filters, sort, columns, selection and scrolling. Compact windows stack the panes and allow scrolling. Live comparison follows that tab's current execution; pin it to retain rows before another run. **Close pane** hides the comparison without deleting pinned captures. File export buttons always refer to the selected live result; use a pane's Copy commands to copy that pane's shown data.

## Select and copy result cells

Drag across cells, Shift-click an endpoint, or hold Shift while using arrow keys, Home/End or Page Up/Page Down. **Cmd/Ctrl+A** selects all shown rows in the visible columns. **Cmd/Ctrl+C** copies the range; **Cmd/Ctrl+Shift+C** includes column headers. The Copy dropdown and cell context menu provide the same commands, plus **Copy as CSV**, **Copy as JSON** and **Copy as Markdown table**. Enter or double-click opens the value inspector.

Ranges follow the displayed column order and exclude hidden columns and row numbers. Multi-cell copies use tab-separated values with quoted tabs, line breaks and quotes; a single cell copies its captured value directly. SQL NULL copies as `NULL`, while empty text remains empty. Copy includes only loaded values, respects preview limits and refuses selections over 1,000,000 characters instead of silently truncating them.

CSV includes selected headers and quotes every captured string: SQL NULL is unquoted `NULL`, empty text is `""`, and literal text NULL is `"NULL"`. JSON uses `{ "columns": [...], "rows": [[...]] }`, preserving duplicate column names, exact strings and native JSON nulls. Markdown escapes table separators/markup and represents line breaks with `<br>`; it is a presentation format. Every copy format uses the same character budget and reports a failed native clipboard write before reporting success.

## Edit table data

Click a table in the explorer and choose **Edit data**. The editor initially loads 200 rows in primary-key order; paging, filters and sorting are also available. Change cells, choose **NULL** explicitly, mark rows with **Delete**, or use **Insert row**. Omitted insert cells use database defaults; an empty string is distinct from NULL except for Oracle's native empty-string behavior. Generated/identity columns and existing primary keys are protected. Composite primary keys are supported.

Use the plus button beside a loaded row to duplicate its editable values into a new row; primary keys and generated columns are left for you or their database defaults. Paste a rectangular spreadsheet selection into loaded or already inserted rows, starting at the focused cell. The entire paste is refused if it would cross a protected column, deleted row or the loaded page. Quoted tabs and line breaks are supported. **Edit value** opens a full text editor for line breaks and larger values. PostgreSQL `bytea` and DuckDB `BLOB` columns use hexadecimal byte pairs; other binary types still require SQL. JSON values use the same full-value editor and the database validates them.

**Review SQL** shows the parameterized statements for staged changes without exposing bound values or applying them. Additional locking and original-value checks run during Apply, and constraints and triggers can have effects beyond the preview. For an exact, explicitly qualified `SELECT * FROM schema.table` result, **Edit source table** offers a fresh editable table page. It does not replay the query or change the captured result; the fresh rows can differ from the result. The captured result remains until another query runs. Other queries remain read-only.

**Apply edits** starts one transaction on this tab's physical connection, checks every original value of each updated/deleted row, and applies the staged batch. Use the toolbar's **Commit** to save or **Rollback** to undo it. Finish any existing transaction and enable autocommit (except Oracle's normal manual mode) before opening/applying a table editor. A failed statement or stale/deleted row rolls back the entire edit batch; drafts remain visible for review. There is no automatic retry or overwrite. Discard edits and reload after a conflict. Reopen the table after Commit/Rollback to see generated values and trigger effects.

Drafts belong to their tab and survive tab switches, but stay in memory. Apply or discard them before running SQL, changing connections or closing the tab. Quit warns about unapplied drafts and open transactions. A query execution, completed apply, failed write attempt or connection loss expires its edit snapshot. CSV export continues to export fetched query results; it does not export pending grid edits.

The editor requires a declared primary key and a supported base table. Views, arbitrary joins/projections, keyless tables, virtual/external tables and read-only connections are not editable. MySQL/MariaDB require permanent InnoDB tables and reject tables with visible triggers. Supported cells include common integer/decimal, text, boolean, UUID and temporal types; JSON is supported in PostgreSQL/MySQL/MariaDB/DuckDB and hexadecimal binary values in PostgreSQL `bytea` and DuckDB `BLOB` non-key columns. SQLite preserves storage-class distinctions and exact real-value comparisons; DuckDB and SQL Server support native floating-point representations. PostgreSQL/MySQL/MariaDB/Oracle floating-point columns, other binary/LOB/spatial/array/object types and unrecognized types require SQL. Tables containing unsupported columns are refused rather than comparing incomplete originals; binary primary keys remain unsupported. Retention limits (not total process-memory caps) are 100 columns, 200 staged rows, up to 262,144 characters per editable cell and 8 MiB each for a loaded page and staged changes. The per-cell limit may be smaller for wide pages; choose a smaller page to edit larger values without increasing the server-side fetch bound. Oracle is limited to 16,384 characters, and its VARCHAR2 conversion can impose a smaller limit. Browsing previews remain limited to 16,384 characters per displayed cell. Primary-key changes require SQL.

Row locks protect the compare/write interval on server engines; SQLite uses an immediate transaction and DuckDB uses its native transaction conflict detection. SQLite rows containing text with NUL characters are refused for editing because its substring operation cannot retain their complete originals. SQL Server/Azure SQL require a session `TEXTSIZE` large enough to read the full bounded original; the editor refuses a smaller or unknown setting and explains how to restore it. These are comparisons of the fetched values, not an audit log: a value changed and later restored to exactly the same representation is not detected. Database constraints, triggers, permissions, conversion rules and transaction semantics still apply. Permissions may hide trigger metadata, and effects outside the current transaction cannot be rolled back by the grid. SQL Server/Azure SQL editing has Docker coverage defined but still requires the native x64 validation described below.

## Open a SQLite database

Choose **SQLite** in the connection dialog, then choose one of these modes:

- **Open existing database**: select a local file with the native file picker, or enter its absolute path. Missing files fail rather than being silently created.
- **Open read-only**: read the database with writes, attaching other files and disabling read-only protection blocked.
- **Create new database**: choose a new path. An existing file is never overwritten, even if selected in the save dialog. New files use private permissions where supported.
- **Temporary in-memory database**: a fresh database lasting only for that connection.

SQLite needs no server, password or TLS. Scripts, triggers, views, temporary tables, `ATTACH` (writable mode), foreign keys, transactions, savepoints, `RETURNING` and PRAGMAs use the native engine. The explorer shows `main`, `temp` and attached schemas; refresh it after schema changes. Foreign keys are enabled, native extension loading is disabled, and the initial busy-lock timeout is one second. SQLite stores REAL values as floating point and applies its own column affinities; exact stored INTEGER and TEXT values are preserved in results.

**Stop closes the SQLite session.** Reconnect explicitly afterward. Temporary/in-memory data is lost; earlier statements may already be committed and in-flight outcomes may be unknown. Uncommitted transactions recover through SQLite's journaling. Schema refresh is available when the session is idle. A crash of the database host also stops its SQLite children, releasing locks. Use the Run prompt for named parameters in a single SQL statement. Unbound native placeholders are rejected before executing scripts. SQLCipher is not supported.

## Open a DuckDB database

Choose **DuckDB** in the connection dialog. Open an existing `.duckdb` file, open read-only, create a new database with the native file picker, or use a temporary in-memory database. Missing files are not silently created in existing-file modes; creation never overwrites an existing file. No server, credentials or Docker installation is needed to use DuckDB in the app.

The bundled native DuckDB 1.5.6 engine supports scripts, macros, temporary tables, attached catalogs, transactions and local CSV/Parquet analytics. The explorer includes catalog and schema names and generates safely quoted three-part table references. Results preserve huge integers, decimals, nanosecond timestamps and nested values. **Stop interrupts the query and preserves the connection.** Earlier script statements may have committed; roll back an aborted transaction before continuing. Failed statements stop the remaining script. Use the Run prompt for named parameters in one SQL statement. Unbound native placeholders in scripts still fail when reached, without undoing earlier successful statements.

Read-only protects the selected database; it is **not a filesystem sandbox**. SQL can still export files, attach other databases and explicitly load signed extensions. Automatic extension installation/loading is disabled by default; opt in explicitly with SQL if required. Initial limits are 512 MB of engine memory and four execution threads per database instance (configurable with `SET`); the engine memory setting is not a total process-memory cap. File instances are shared across connections inside Db Commander. Changing access mode requires closing that file's connections, and another process holding the file for writing produces a native lock error.

```sql
SELECT * FROM read_csv('/absolute/path/data.csv') LIMIT 1000;
SELECT * FROM read_parquet('/absolute/path/data.parquet') LIMIT 1000;
```

DuckDB previews drain remaining rows to finish statements and report row counts; the preview cap does not limit query work. Use SQL `LIMIT` or **Stop** for expensive analytics. CSV export uses cached preview rows and never reruns the query.

## Connect to Oracle Database

Choose **Oracle Database**, enter the host, listener port, **Service name** (for example `FREEPDB1`), username and password. The pinned `oracledb` driver uses Thin mode: Oracle Client/Instant Client is not required. Db Commander currently exposes service-name connections with password authentication. SID/TNS aliases, SYSDBA, wallets/mTLS, IAM and OS authentication are future work.

TLS verifies the certificate chain and hostname. Enter the server's TCPS port (often 2484; the general Oracle port default is 1521). Oracle uses Node's trusted roots. For a private CA, set `NODE_EXTRA_CA_CERTS` to a PEM file **before launching** Db Commander; launch from that environment. The per-profile custom-CA field is unavailable for this adapter because the upstream wallet option also requires client credentials. Explicit TCP is available for local development.

Oracle uses manual commit mode: DML opens a transaction; use **Commit** or **Rollback**. **Begin** establishes a savepoint. Oracle DDL can commit existing work even when the DDL fails. The badge uses the driver's server-reported transaction state. Stop cancels the current database call and skips the rest of the script without automatically rolling back earlier changes. Server calls that do not poll for cancellation may delay acknowledgement until they return.

Ordinary SQL statements use semicolons. End PL/SQL blocks and stored-unit definitions with `/` on its own line; the final PL/SQL unit can omit it. For example:

```sql
BEGIN
  DBMS_OUTPUT.PUT_LINE('Hello from Oracle');
END;
/
SELECT SYSTIMESTAMP FROM dual;
```

PL/SQL implicit result sets and bounded DBMS_OUTPUT messages appear in the workbench. SQL*Plus commands and bind prompts are not supported. Results preserve NUMBER precision, nine-digit timestamps, offsets, JSON text and LOB values that fit the preview budget. Fixed timestamp offsets are retained; named-zone timestamps and local-time-zone timestamps display UTC. Oracle treats empty strings as NULL. Truncated cursors are closed; total row counts then remain unknown. The explorer lists the login user's tables/views, not every accessible schema.

## Try the Docker databases

```sh
pnpm db:up # Includes SQL Server: requires a Docker x86-64 host
# Print the certificate for the engine you want to connect to:
docker compose exec -T postgres cat /etc/postgresql/tls/server.crt
docker compose exec -T mysql cat /etc/dbcommander/tls/server.crt
docker compose exec -T mariadb cat /etc/dbcommander/tls/server.crt
docker compose exec -T sqlserver cat /etc/dbcommander/tls/server.crt
```

Choose **Database engine** in the connection dialog:

| Engine | Docker version family | Local port | Port override |
| --- | --- | --- | --- |
| PostgreSQL | 17 | 55432 | `SQLCOMMANDER_PG_PORT` |
| MySQL | 8.4 LTS | 53306 | `SQLCOMMANDER_MYSQL_PORT` |
| MariaDB | 11.4 LTS | 53307 | `SQLCOMMANDER_MARIADB_PORT` |
| SQL Server | 2022 Developer (x64) | 51433 | `SQLCOMMANDER_SQLSERVER_PORT` |
| Oracle Database | 26ai Free (23.26.3, native ARM64/x64) | 52484 TCPS / 51521 TCP | `SQLCOMMANDER_ORACLE_PORT` / `SQLCOMMANDER_ORACLE_TCP_PORT` |

Except for Oracle (see below), all fixtures use host `localhost`, database and user `dbcommander`, and password `local-test-only`, except SQL Server, whose password is `Local-Test-Only!2026`. Keep **TLS · verify certificate and hostname** selected and paste that engine's printed certificate into **Custom CA certificate**. These credentials and certificates are only for local tests. SQL Server startup accepts the Microsoft Developer image EULA for this disposable test fixture. You can start one engine with `docker compose up --build -d --wait mysql` (or `mariadb` / `postgres`). To start SQL Server alone, use `docker compose up --build -d --wait sqlserver` followed by `pnpm db:init-sqlserver`. Microsoft supports SQL Server containers on x86-64 Linux hosts only; ARM emulation is unsupported. Earlier local ARM runs crashed in QEMU; later SQL Server 2022 scale checks ran under emulation, which remains diagnostic evidence rather than native qualification. This does not prevent the desktop app on an ARM Mac from connecting to a remote SQL Server.

Start just the Oracle fixture with `docker compose up --build -d --wait --wait-timeout 360 oracle`. Its service is `FREEPDB1`, user `dbcommander`, password `local-test-only`. For verified TLS in development:

```sh
mkdir -p .test-artifacts
docker compose exec -T oracle cat /etc/dbcommander/tls/server.crt > .test-artifacts/oracle.crt
NODE_EXTRA_CA_CERTS="$PWD/.test-artifacts/oracle.crt" pnpm dev
# Connect to localhost:52484, service FREEPDB1, with verified TLS.
```

The first Oracle build downloads a full image for wallet generation and a slim image for the server. Allow several GB of disk and at least 2 GB of available Docker memory for Oracle. The database image has Oracle's own license; it is test infrastructure, not part of the open-source application distribution.

Containers bind only to loopback. Each initializes customers, projects, and a view; MySQL/MariaDB/SQL Server also include precision, Unicode, JSON, binary, and large-result fixtures. Set the corresponding port override before starting if its default is occupied.

Click a table to open its actions. **Append SELECT SQL** adds a safely quoted SELECT to the current buffer for review, preserving existing SQL and supporting one-step Undo. It does not execute SQL. Then click **Run SQL** or press **Cmd/Ctrl+Enter**. A selection runs instead of the whole script. New query and browse tabs share the source physical session, while explicitly separate connections remain independent. Use **Begin**, **Commit**, and **Rollback** or ordinary SQL transaction statements.

MySQL/MariaDB support sequential scripts and `DELIMITER` for routines. DDL can commit implicitly, and nontransactional tables cannot be rolled back. The transaction indicator uses server status and distinguishes manual commit mode. Run changes to `SQL_MODE` separately from other statements.

SQL Server and Azure SQL use T-SQL batches: a standalone `GO` or `GO <count>` line separates batches; semicolons remain within the same batch. Variables, procedure definitions, multiple result sets, temporary tables, notices, and transactions retain normal server semantics. The first failed batch stops later batches; SQL Server itself decides whether to continue statements within a batch. `GO` is a client separator, not SQL sent to the server. SQLCMD file/shell commands are unsupported.

On Windows, choose **SQL Server → Authentication → Windows Authentication** to sign in with the account running Db Commander, as with Windows Authentication in SQL Server Management Studio. No database user or password is needed or saved. That Windows account must have access to the server and database. This mode uses the Windows SQL client and supports direct TCP connections. Verified TLS uses the Windows certificate store; install private CAs there instead of pasting a custom CA. SSH tunnels and Windows Authentication on macOS/Linux are not supported. SQL logins continue to work on all supported platforms. Named instances must be addressed by their TCP hostname and port.

To run the optional native Windows checks against a SQL Server accessible to your current account, build the app, set `SQLCOMMANDER_WINDOWS_AUTH_TEST=1`, and run `pnpm exec vitest run tests/integration/windows-auth.test.ts` and `pnpm exec playwright test tests/desktop/windows-auth.spec.ts`. These default to localhost:1433; `SQLCOMMANDER_WINDOWS_AUTH_HOST` and `SQLCOMMANDER_WINDOWS_AUTH_PORT` override the endpoint. The test connection disables TLS for local testing; integration writes use only a private temporary table.

For Azure SQL, choose **Azure SQL**, enter the server hostname (for example `your-server.database.windows.net`), port 1433 and an optional target database (see server browsing above). TLS certificate and hostname verification is mandatory. Choose a SQL login or paste a current **Microsoft Entra access token** for `https://database.windows.net/`; the account label is for the profile only. Token acquisition/renewal, interactive login, managed identity and Windows integrated authentication are not implemented. No live Azure authentication, firewall, redirect or private-endpoint validation has been performed. The Docker Azure-profile test covers only the shared SQL-login path.

After a script, results select the first set with fetched rows. If all tabular sets are empty, the first empty SELECT remains available; count-only statements do not hide it. A result or Messages selection you make during execution stays selected through later results, failure or cancellation. Result buttons show the command and fetched/affected count; their descriptions and tooltips identify the source SQL. “Limited” describes an incomplete preview, not an affected-row count.

Results retain up to 1,000 rows per result set and 8 MiB of text per execution in the UI. Truncation is explicit. MySQL/MariaDB/SQL Server/SQLite/DuckDB drain remaining rows with backpressure to preserve the session; use **Stop** to cancel expensive work. The preview limit bounds retained data, not server work or network traffic. **Export preview exports only fetched rows and never reruns the query.** Arbitrary query results remain read-only; right-click a table and choose **Edit data** for a verified table editor. Use the separate full-result export workflow to stream larger outputs from an explicitly reviewed query.

```sh
pnpm db:down
```

This removes the development containers and their data. Test runners use separate projects and ports so they do not remove the development database.

## Workspace windows and system tray

Workspace/editor controls include draggable and pinned tabs, up to four split editors, separate named workspace windows, Dark/Light/System appearance, configurable execution/formatting shortcuts and settings import/export. Use **Editor views** for splits and **Workspace → Workspace windows / Preferences** for windows and preferences. F6/Shift+F6 moves between split editors; shared results follow the active editor. Windows own separate sessions and saved workspaces. Reopening a window restores its editors without connecting.

Enable **Window → Minimize to system tray** to hide minimized workspace windows behind the Db Commander tray icon (the menu bar on macOS). The option is off by default and saved for all workspace windows. Use the tray menu to restore an individual workspace, show all windows, or quit. Sessions and queries keep running while hidden. Turning the option off restores windows hidden in the tray. Close and Quit retain the usual save, running-query and transaction checks.
