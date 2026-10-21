# Changelog

## Unreleased — beta preparation

No beta release has been declared. Package version 0.1.0 remains a developer preview; signed distribution and the final beta version are pending the [release gates](docs/PLAN.md#beta-release-checklist).

- Moved CI and gated release builds to GitHub Actions, removed Azure DevOps pipeline configuration, and rewrote the README for fork-based development. Detailed application instructions now live in the user guide.

- Added startup and daily GitHub release checks, a dismissible version banner and **Help → Check for updates**. Release notes and downloads open in the browser; installation and restart remain manual.

- Renamed the app to Db Commander across its desktop identity, packages, tools and documentation, with a new database-and-command icon. Existing workspaces, saved passwords and portable exports remain accessible. CI configuration and environment-variable names are unchanged.

- Established daily SQL workflows across PostgreSQL, MySQL, MariaDB, SQL Server, SQLite, DuckDB and Oracle Thin mode, with explicit transactions, cancellation, precise result values and independent query-tab sessions. Azure SQL remains experimental with local profile coverage only.
- Added saved connection organization, optional OS password storage, verified TLS/SSH routing, SQL files and workspace recovery, multiple windows and split editors, settings, snippets and bound parameters.
- Included schema, table editing, comparison, diagram, plan, import/export and engine-specific administration workflows within their documented limits. Full-result export is separate from the bounded result preview.
- Hardened startup, native packaging, Windows installer refusal/retry behavior, workspace and whole-profile disk-full recovery, large SQL buffers and large catalogs. Fixed MariaDB metadata collection scaling with 20,000-table local benchmarks.
- Refined visual hierarchy, both themes, keyboard/focus behavior, accessibility descriptions and zoom. Automated checks do not substitute for human assistive-technology qualification.
- Added opt-in minimize to tray, replaced the default application icon and fixed retained editor state after closing scratch tabs.
- Added packaged dependency inventories, complete unpacked-file hashes and notice sidecars. Installed verification rejects missing or extra unpacked files and redirected paths. Oracle packages include the supported Thin implementation and exclude unused Thick-mode binaries. Electron's upstream license/notices are now included and verified in application payloads. Native/vendor composition and redistribution review remain open.

Catalog pagination and automatic updates are deferred. Preview, workspace, recovery, engine and authentication limits are documented in [beta notes](docs/BETA_NOTES.md). Updates are manual, and downgrade compatibility is not guaranteed. Support and private reporting use [post@detego.no](mailto:post@detego.no); see [support guidance](SUPPORT.md).
