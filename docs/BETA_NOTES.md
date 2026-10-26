# Initial beta scope and known limitations

These notes describe the scope frozen on 20 October 2026. **No beta release has been declared.** Package metadata is developer-preview version 0.2.0; a release candidate has not been selected. The [product roadmap and delivery checklist](PLAN.md) now guide development. The [archived beta checklist](PLAN_BETA_ARCHIVE.md#beta-release-checklist) preserves the original freeze; these notes describe that preview baseline and are not a second backlog.

## Included workflows

The beta keeps the existing SQL workbench: saved connections and optional native password storage, TLS/SSH, query tabs with shared connections, SQL files and recovery, tabs/splits/windows, themes and shortcuts, formatting/completion, snippets/parameters, precise result values, explicit transactions/cancellation, browsing and conservative keyed editing, schema tools, diagrams/comparisons, plans, import/export, engine-specific backup/restore, session/lock tools and opt-in minimize to tray. See the [user guide](USER_GUIDE.md) for usage and engine-specific restrictions, and the [README](../README.md) for fork/development setup and current app screenshots.

Candidate engines are PostgreSQL, MySQL, MariaDB, SQL Server, SQLite, DuckDB and Oracle Thin mode. Local scale fixtures currently cover PostgreSQL 17, MySQL 8.4, MariaDB 11.4, SQL Server 2022, Oracle Free 26ai, DuckDB 1.5.6 and the SQLite versions bundled with tested runtimes. This is tested-version evidence, not a guarantee for every patch, deployment or authentication mode. Native platform and supported-version sign-off is still pending.

Azure SQL is **experimental**. Local SQL Server fixtures exercise its profile/shared TDS paths; they do not qualify the Azure service. Live login, token expiry, firewall/redirect/private endpoints and recovery-copy workflows have not been validated. SQL login and manually supplied Entra tokens are implemented; token acquisition/renewal, interactive login, managed identity and Windows integrated authentication are excluded. Do not interpret the profile's presence as cloud qualification.

## Limits to expect

- Explorer/completion previews retain approximately 2,000 catalog objects and 10,000 column rows. Object filters search only what was loaded. A database with 20,000 tables can pass performance checks while most tables remain outside the preview. Use explicitly named SQL for omitted objects; catalog pagination/server-side search is deferred.
- Query results retain up to 1,000 rows per result set and 8 MiB of text per execution. **Export CSV** exports fetched rows without rerunning SQL; the separate full-result export executes the reviewed query and streams its output. Preview limits do not cap database work or network traffic.
- SQL buffers allow 1,000,000 characters each, with 20 tabs and 5,000,000 SQL characters per workspace. Formatting/completion have smaller per-request bounds. Recovery never automatically reconnects or executes saved SQL.
- Table editing requires an eligible keyed base table and supported values. Arbitrary query results, views, keyless tables and unsupported types remain read-only. Comparisons, diagrams, imports, native tools and generated changes retain documented bounds and permission requirements.
- Stop may end a physical session on engines that cannot preserve it. Reconnect is explicit; temporary objects and session state can be lost. Cancellation or a dropped connection is not proof that all prior changes rolled back.
- Workspace/history files can contain private SQL and are not encrypted. Remembered passwords are opt-in and remain in the OS store; tokens are session-only. Copies of workspace files do not transfer OS-stored credentials.
- Local crash/disk-full tests do not certify physical power loss, damaged devices or every filesystem. Automated keyboard/contrast/accessibility-tree tests do not constitute human screen-reader certification.

## Installation and manual updates

Planned packages are macOS Intel/Apple Silicon DMG/ZIP, Windows x64 NSIS and Linux x64 DEB/RPM/AppImage. Only native qualified packages will be listed as supported. Windows/Linux ARM64, universal Mac binaries, MSI and Store packages are excluded from the initial beta.

Use only final published artifacts and their accompanying SHA-256 manifest when a beta is released. The selected website is [detego.no](https://detego.no); a beta download path and uploaded release bytes are not yet published or qualified. Signing/notarization are also pending. Development packages are unsigned test output.

The app checks the latest public stable [GitHub Release](https://github.com/ziodex/db-commander/releases) at startup and every 24 hours while running, with an overdue check after sleep. A newer version appears in a dismissible banner. Dismissal is remembered per version; **Help → Check for updates** explicitly checks again and can show a dismissed release. Background connectivity failures stay quiet, and manual checks report failures or a repository without published releases. The release-page action opens your browser; it does not download or install a package inside the app.

Before updating, apply or discard staged edits, explicitly commit or roll back transactions, save SQL files, and close every application window/quit from the tray. Preserve a backup of the closed application's profile directory and important SQL/database files. OS-stored passwords are separate from that backup. Follow [platform replacement instructions](RELEASING.md#native-targets-and-installers): Mac bundle replacement, Windows assisted installer, Linux package-manager upgrade or manual AppImage replacement. Automatic installation and forced restart are excluded.

Default profile directories are `~/Library/Application Support/Db Commander` on macOS, `%APPDATA%\Db Commander` on Windows, and `$XDG_CONFIG_HOME/Db Commander` (normally `~/.config/Db Commander`) on Linux. Existing `SQLCommander` profiles are reused in place when the new default folder does not exist, preserving saved workspaces and path-bound OS credentials. A configured `SQLCOMMANDER_USER_DATA` overrides this location. Copy the entire closed profile, including SQLite sidecar files if present; do not copy only the main workspace database while the app is running. Database files opened from elsewhere and SQL files need their own backups.

Installer tests currently upgrade a synthetic 0.0.0 build to 0.1.0. This checks replacement and persistence, not historical workspace migrations. Retain the first published signed package as the next release's baseline. There is no downgrade guarantee: an older application may not read a newer profile format. Keep the closed-profile backup and compatible installer for recovery; do not point an older app at the only copy of a newer profile.

Uninstall normally retains application data and does not promise deletion of OS-store passwords. Remove remembered credentials explicitly before discarding a profile if desired. Report support requests and suspected vulnerabilities privately to **post@detego.no**; see [support guidance](../SUPPORT.md). Omit production credentials, private SQL/results and unreviewed heap snapshots from reports.

## Evidence and remaining qualification

Detailed measurements and tests live in [driver testing](DRIVER_TESTING.md). Public beta still requires the unchecked [release gates](PLAN.md#beta-release-checklist), including current native CI, signed packages, first-download/minimum-OS checks, human screen-reader workflows and daily-use pilot feedback. Live Azure stays experimental until separately authorized service tests qualify it.
