# Db Commander

An open-source desktop SQL workbench for macOS, Windows and Linux, built with Electron, React, TypeScript and Monaco Editor. Work with independent query sessions, browse and edit data, inspect schemas, compare databases, and import or export data.

**Status: developer preview.** The package version is currently `0.1.0`. Signed public distribution and beta qualification are still in progress; see the [release checklist](docs/PLAN.md#beta-release-checklist). Installation of updates is manual.

| Database | Support |
| --- | --- |
| PostgreSQL, MySQL, MariaDB, SQL Server | Server connections with real-engine contract tests |
| SQLite, DuckDB | Embedded engines; no database server needed |
| Oracle Database | Thin mode; Oracle Client is not required |
| Azure SQL | Experimental; local SQL Server tests do not certify the Azure service |

For app instructions, keyboard shortcuts and database-specific limitations, read the [user guide](docs/USER_GUIDE.md).

## Fork and run locally

### Prerequisites

- **Node.js 22**, version 22.13 or newer within that major version, and Git.
- **pnpm 11.25.0**, the version pinned in `package.json`.
- A graphical desktop session to run Electron.
- Docker with Compose v2 **only if you want to run database contract tests or the supplied server fixtures**.

The application bundles its editor and uses local workspace storage. You do not need an application backend, a cloud account, signing credentials or a running database to start developing.

### Get the code

The active source branch is **`development`**. When creating your GitHub fork, uncheck **Copy the main branch only** so your fork includes it. Replace `YOUR_ACCOUNT` below with your GitHub account:

```sh
git clone --branch development https://github.com/YOUR_ACCOUNT/db-commander.git
cd db-commander
git remote add upstream https://github.com/ziodex/db-commander.git
npm install --global pnpm@11.25.0
pnpm install --frozen-lockfile
pnpm dev
```

If you are working directly in the upstream repository, clone `https://github.com/ziodex/db-commander.git` with `--branch development` and omit `git remote add upstream`.

`pnpm dev` starts Electron with live rebuilding. For a first check, open a new SQLite or DuckDB in-memory connection and run:

```sql
SELECT 1 AS ready;
```

Docker is not needed for this check. Server databases can be connected through the connection dialog. Passwords stay in memory by default; remembering them requires an explicit opt-in and a working OS credential store. Linux password storage uses Secret Service, such as GNOME Keyring.

## Everyday commands

| Command | What it does |
| --- | --- |
| `pnpm dev` | Run the app during development |
| `pnpm lint` | Check source with ESLint |
| `pnpm typecheck` | Check main/preload/shared code and the renderer |
| `pnpm test` | Run unit tests; no Docker required |
| `pnpm build` | Lint, typecheck and build the application and SQLite worker |
| `pnpm test:layout` | Build and test native window/layout behavior; no Docker required |
| `pnpm package` | Build an unpacked, unsigned app for the current OS and architecture |
| `pnpm dist` | Build unsigned native installers into `release/candidate` |
| `pnpm clean` | Remove generated builds, packages, reports and diagnostics; keep source and dependencies |

Do not omit optional dependencies during installation: DuckDB and the credential-store binding need their platform packages. Packaging is native to the target OS and architecture. Windows builds also use the .NET Framework C# compiler included with Windows for the process-ownership helper.

Archive any build or test evidence you need before `pnpm clean`. Quit a packaged app before replacing its output. Release builders refuse to reuse an existing candidate/baseline directory; see [release commands](docs/RELEASING.md#local-build-and-lifecycle-tests) for separate output directories.

## Test against real databases

Run one engine first to keep local testing manageable:

```sh
pnpm test:integration --driver postgres
pnpm test:desktop --driver postgres
```

The first command runs real database contracts. The second also builds the app and runs its Electron workflows. The runner creates isolated Docker fixtures and removes its own containers and volumes afterward; it keeps reusable images. Supported selectors are `postgres`, `mysql`, `mariadb`, `sqlserver`, `sqlite`, `oracle` and `duckdb`, including comma-separated selections. Even the SQLite/DuckDB contract suites use Docker to match the embedded runtime.

SQL Server qualification requires native Linux x64 Docker. An Apple Silicon machine cannot qualify that target through emulation. To run every driver plus desktop workflows, use `pnpm test:desktop`; `pnpm test:all` adds unit tests. A running, unlocked desktop and credential store are needed for native GUI tests.

Linux automation needs a private display, window manager and keyring. Follow the [CI setup](docs/GITHUB_ACTIONS.md#linux-desktop-tests) instead of using bare Xvfb. The [driver testing guide](docs/DRIVER_TESTING.md) documents fixture versions, test selection, failure diagnosis and qualification limits. Docker fixtures contain disposable test data; they are not production database deployments.

## Find your way around the code

| Path | Responsibility |
| --- | --- |
| `src/main/` | Electron lifecycle, IPC validation, workspaces, credentials, database hosts and file operations |
| `src/preload/` | Narrow, validated API exposed to the sandboxed renderer |
| `src/renderer/` | React workbench, Monaco editors and interface state |
| `src/shared/` | Contracts, schemas and database behavior shared across processes |
| `src/driver/` | Database adapters and engine-specific SQL behavior |
| `scripts/` | Development fixtures, native packaging, installer tests and release verification |
| `tests/unit`, `tests/integration`, `tests/desktop` | Unit tests, real-engine contracts and Electron workflows |
| `.github/` | GitHub Actions workflows and shared CI steps |

Read the [architecture guide](docs/architecture/README.md) before changing a process boundary. Keep database execution independent of React. Validate renderer input at the main-process boundary, preserve exact values and session ownership, and never automatically replay SQL after reconnecting.

## Contribute from your fork

Start a branch from the current upstream development branch:

```sh
git fetch upstream
git switch development
git merge --ff-only upstream/development
git switch -c feature/your-change
```

Before opening a pull request, run `pnpm lint`, `pnpm typecheck` and `pnpm test`, plus the real-engine or desktop tests affected by your change. Push your feature branch to your fork and open the pull request against **`ziodex/db-commander:development`**. Describe the behavior change and the checks you ran. See [CONTRIBUTING.md](CONTRIBUTING.md) for review expectations.

GitHub Actions runs on pushes to `development` and `main`, and on pull requests targeting either branch. It tests four native desktop targets and seven Linux x64 database targets, including installers and OS credential storage. Ordinary CI uses no signing secrets. First-time fork contributions may need maintainer approval before GitHub starts their workflows. [CI jobs, artifacts and manual diagnostics](docs/GITHUB_ACTIONS.md) explain what each run produces.

Signed release builds are an explicit manual run on `main`, after all checks in that same run pass. Fork maintainers can use ordinary unsigned CI immediately; publishing signed releases requires their own protected environment and credentials. See [RELEASING.md](docs/RELEASING.md).

## Distributing your own fork

Before publishing a differently branded app, review the application identity in `scripts/release/config.cjs`, package metadata, icons and profile/credential compatibility. The `SQLCOMMANDER_*` environment-variable names remain supported for existing tooling; they do not require Azure DevOps.

The update checker currently reads stable releases from `ziodex/db-commander`. A fork with its own releases must update both URLs in `src/shared/updates.ts` and the corresponding tests. Checks run at startup, every 24 hours while running, and after sleep when overdue. A dismissible banner and **Help → Check for updates** open the release page; the app does not download or install updates itself.

For isolated development data, set `SQLCOMMANDER_USER_DATA` to a separate absolute directory before launching. Workspace files can contain SQL and connection metadata and are not encrypted. Keep private SQL, credentials, generated files and real customer data out of commits and test reports.

## More documentation

- [User guide](docs/USER_GUIDE.md): app workflows and database-specific behavior.
- [Architecture](docs/architecture/README.md): process boundaries and ownership rules.
- [GitHub Actions](docs/GITHUB_ACTIONS.md): fork setup, native jobs and artifacts.
- [Driver testing](docs/DRIVER_TESTING.md): real-engine tests and dated verification evidence.
- [Beta notes](docs/BETA_NOTES.md) and [release checklist](docs/PLAN.md): scope and remaining qualification.
- [Support](SUPPORT.md) and [security reporting](SECURITY.md).

Licensed under [Apache-2.0](LICENSE). Dependencies retain their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).
