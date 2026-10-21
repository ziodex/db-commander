# Third-party software

Db Commander source is licensed under Apache-2.0. Its dependencies retain their own licenses; the package manifest and lockfile identify the exact versions used. Packaged applications include dependency packages and their license files.

## SQL client libraries

- **ssh2** 1.17.0: MIT, Brian White and contributors. Source: https://github.com/mscdex/ssh2. Distributed unmodified for SSH transport with its upstream license. Its native acceleration build script is disabled and optional `cpu-features`/`nan` dependencies are omitted; the application uses the supported pure JavaScript fallback. The OpenSSH/Alpine container is disposable test infrastructure, not part of the desktop distribution.

- **pg** and **pg-cursor**: MIT, Brian M. Carlson and contributors. Source: https://github.com/brianc/node-postgres and https://github.com/brianc/node-pg-cursor.
- **mysql2**: MIT, Andrey Sidorov and contributors. Source: https://github.com/sidorares/node-mysql2. Distributed unmodified as a separate runtime dependency.
- **MariaDB Connector/Node.js** (`mariadb`): LGPL-2.1-or-later, MariaDB Corporation Ab and contributors. Source and releases: https://github.com/mariadb-corporation/mariadb-connector-nodejs. Version 3.5.4 is distributed unmodified as a separate runtime dependency, with its upstream LICENSE. The connector remains under its own license; Db Commander's Apache-2.0 license does not replace it. The connector's source is included in the dependency package alongside its CommonJS build. Users may inspect and replace it in a source build using the normal dependency installation/build workflow in README.md. Do not remove upstream notices when packaging or redistributing the application.

- **Tedious**: MIT, Tedious contributors. Source: https://github.com/tediousjs/tedious. Version 20.3.7 is distributed with its upstream license. Db Commander installs an opt-in runtime value-decoder hook from its own source to preserve SQL Server numeric/temporal precision; dependency files are not edited.

**node-oracledb** 26.0.0: Oracle Corporation and contributors; dual licensed under Apache-2.0 or UPL-1.0. Source: https://github.com/oracle/node-oracledb. The JavaScript implementation is distributed unmodified for Thin mode, with upstream notices; unused optional Thick-mode `build/` payloads are excluded from application packages. Db Commander installs a version-checked per-connection date-decoder hook from its own source to preserve temporal precision; dependency files and global prototypes are not edited. Oracle Client libraries and database binaries are not bundled.

The Oracle Free Docker images are test infrastructure under Oracle’s database terms; the image build/entrypoint project https://github.com/gvenzl/oci-oracle-free has its own Apache-2.0 license. Db Commander’s license does not relicense the database.

SQLite for user databases and workspace storage comes from Electron/Node’s bundled `node:sqlite`; the application adds no separate SQLite library or native addon. The matching Node Docker image is test infrastructure. Retain the bundled Electron/Node notices in distributions.

**DuckDB Node Neo** (`@duckdb/node-api`, `@duckdb/node-bindings`, and the selected platform binding package), version 1.5.6-r.1: MIT, Stichting DuckDB Foundation and contributors. Sources: https://github.com/duckdb/duckdb-node-neo and https://github.com/duckdb/duckdb. The unmodified platform package includes the native DuckDB 1.5.6 engine, its Node addon and its upstream LICENSE. Keep the addon and companion shared library together in packaged distributions. Unlike the server fixtures, this embedded engine is part of the application distribution. Explicitly installed extensions retain their own licenses.

**SQL Formatter** (`sql-formatter`) 15.9.0: MIT, SQL Formatter contributors. Source: https://github.com/sql-formatter-org/sql-formatter. The application bundles the supported dialects in its local language worker; the installed dependency retains its upstream LICENSE.

**node-semver** (`semver`) 7.8.5: ISC, Isaac Z. Schlueter and contributors. Source: https://github.com/npm/node-semver. Distributed unmodified with its upstream LICENSE for release version comparisons.

**OS credential-store binding** (`@napi-rs/keyring` and its selected native platform package), version 2.1.1: MIT, Brooooooklyn and contributors. Source: https://github.com/Brooooooklyn/keyring-node. Distributed unmodified with upstream notices; wraps native credential APIs through Rust keyring libraries. The application explicitly requires Secret Service on Linux. Retain native package license files when distributing.

Other runtime components include Electron, React, Monaco Editor, Zod, Lucide, and TanStack Virtual. Consult their installed package license files for the applicable terms. The Docker database images are test infrastructure, not bundled database servers.

Release engineering should generate a complete dependency inventory/SBOM and verify source/license availability for all redistributed components before publishing signed installers.
