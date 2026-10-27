# Db Commander support

Contact **post@detego.no** for support and private security reports. Source and contributions are on [GitHub](https://github.com/ziodex/db-commander); the active branch is `development`. The project website is [detego.no](https://detego.no), and public version metadata/release notes will be listed under [GitHub Releases](https://github.com/ziodex/db-commander/releases). A public beta download path has not been published or qualified; development installers are unsigned test output. There is no published response-time or security-maintenance commitment yet.

For a bug report, include the app version, OS version/architecture, database engine/server version, authentication mode, expected and actual behavior, and steps using a disposable database. Include an error message or a carefully redacted screenshot when useful. Say whether the problem occurs after a fresh launch, explicit reconnect or manual update.

Do not send passwords, tokens, SSH keys, production connection strings, private SQL/results, entire profiles or unreviewed heap snapshots. Workspace/history files and diagnostics may contain private data. Ask before transferring sensitive evidence. Report suspected vulnerabilities privately with the subject `DbCommander security report`; see the [security policy](SECURITY.md) for scope and trust boundaries.

If a query, connection or write has an ambiguous outcome, inspect its state before repeating it. Cancellation and disconnection do not prove rollback. Save recoverable SQL and preserve a backup of the closed profile before changing installations or attempting recovery; see [beta limitations and manual updates](docs/BETA_NOTES.md).

The [single beta checklist](docs/PLAN.md#beta-release-checklist) tracks readiness. [Driver testing](docs/DRIVER_TESTING.md) records tested versions and environments; protocol compatibility is not a support guarantee. Live Azure SQL remains experimental. Named platform/driver owners, supported OS floors and the final engine/authentication support matrix still need release sign-off.
