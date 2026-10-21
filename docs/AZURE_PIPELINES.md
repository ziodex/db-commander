# Azure DevOps CI

[`azure-pipelines.yml`](../azure-pipelines.yml) is the Azure Repos CI entry point. Work is pushed to `development` and merged into `main` through a pull request. Only updates to `main` trigger CI. All stages also require `refs/heads/main`, so manually queued development/feature branches and PR merge refs cannot run build/test jobs. The independent Desktop and Drivers stages let packaging proceed even when a database fixture fails. The x64 jobs use fresh Microsoft-hosted agents; the optional Apple Silicon jobs use a configured native pool. Jobs use Node.js 22, the pinned pnpm 11.25.0 release and a frozen lockfile. Package-store caches are separated by OS, architecture, Node version and pnpm version; native optional dependencies remain enabled.

## Jobs and coverage

| Stage | Hosted image / matrix | Validation |
| --- | --- | --- |
| Desktop | `macOS-15` Intel, `ubuntu-24.04`, `windows-2025`; optional `macArmPool` | Unit tests, TypeScript, native packages, packaged desktop workflows, unsigned installers and install/upgrade/uninstall/reinstall tests. |
| Drivers | `ubuntu-24.04`, one job each for PostgreSQL, MySQL, MariaDB, SQL Server, SQLite, Oracle and DuckDB | Native x64 Docker checks, real integration contracts, production build and the driver's selected Electron workflows. |
| Release (opt-in) | The same four native targets | Runs only after successful Desktop and Drivers stages on main. Signing/notarization, installer lifecycle tests and complete-set artifact promotion. |

The desktop smoke runner checks both embedded native engines, exact integers, persistent files, isolated preload/Monaco startup, DuckDB profiles/tabs/language tools/editable grids, panel layout, native credential storage, SQLite/DuckDB backup/restore and interrupted-job recovery. The driver runner includes schema, session, browsing, SQL language, editing, transaction, concurrency and backup/restore contracts alongside the selected server desktop flows. SQL Server also exercises the Azure SQL profile against the local TDS fixture.

The Linux driver job checks both the agent and Docker daemon architecture before starting containers. SQL Server requires native Linux x86-64. SQLite and DuckDB contracts execute in their real Node 24 Docker runners. Fixtures use unique Compose projects and free loopback ports, and the runner removes its own containers and volumes in `finally`. Failure logs are printed before teardown. The hosted VM is discarded after the job, including when a timeout interrupts normal cleanup. To leave enough space for Oracle's full/slim images, its job removes unused Android, Haskell and .NET SDK directories from the disposable hosted agent. This expensive cleanup is limited to Oracle.

Linux desktop tests run under Xvfb and a private D-Bus session with a disposable GNOME keyring. Windows and macOS use their native credential stores with isolated test namespaces. Windows sets its disposable hosted display to 1920×1080 through the built-in Windows PowerShell `Set-DisplayResolution` command, so the native window tests can exercise both large and small sizes. The default 1024×768 hosted display clamps the initial window before those tests start. The desktop matrix includes a native macOS ARM64 job when `macArmPool` is supplied. That pool is mandatory for signed releases. Driver concurrency is capped at three; other jobs are subject to the organization's parallel-job entitlement. Driver jobs allow 60 minutes, desktop/installer jobs 90 minutes and signed release jobs 120 minutes. See [release setup](RELEASING.md) for the Apple Silicon worker and signing resources.

## Enable the pipeline

The **SQL Commander** project is registered as [SQLCommander CI (pipeline 19)](https://dev.azure.com/detegoprojects/SQL%20Commander/_build?definitionId=19). Keep automatic PR build validation disabled in its [main branch policy](https://dev.azure.com/detegoprojects/SQL%20Commander/_settings/repositories?_a=policiesMid&repo=72450959-c88b-49d8-beb3-77260398c0a4&refs=refs/heads/main): this workflow validates the resulting `main` commit after merge. Use the following steps when recreating this setup in another project:

1. In the **SQL Commander** Azure DevOps project, open **Pipelines → New pipeline → Azure Repos Git** and select the **SQL Commander** repository.
2. Choose **Existing Azure Pipelines YAML file**, branch `main`, and path `/azure-pipelines.yml`. Name the pipeline **SQLCommander CI**, then save and run it. No application secrets or service connections are required for these local fixtures.
3. Ensure the project can use the **Azure Pipelines** hosted pool and the organization has hosted parallel-job capacity. Grant any first-run pipeline resource authorization requested by Azure DevOps.
4. Open **Repos → Branches → main → Branch policies → Build validation** and disable any **SQLCommander CI** PR build policy. Azure Repos branch policies can queue PR builds independently of YAML `pr: none`, so the policy must not remain automatic. Other review policies can remain enabled.

The YAML and GitHub Actions workflow coexist. Register this existing YAML rather than allowing the setup wizard to generate a second pipeline file. The root CI trigger batches updates to `main`. A development push or open pull request does not trigger a pipeline. To rerun validation manually, choose **Run pipeline** and select `main`; every eligible run covers the three x64 desktop jobs and all seven drivers, plus Apple Silicon when `macArmPool` is supplied. Leave `createRelease=false` for ordinary CI. The signing stage and its secure-file references are excluded entirely until that parameter is enabled.

## Results and artifacts

For a focused native Windows startup diagnosis, manually run `main` with `validationScope=windows-startup` and `createRelease=false`. It builds the Windows package and runs its workspace/native-engine startup checks from a temporary installation-style directory, including spaces and the Windows TEMP short-path alias. It also runs the packaged native-library fault regression: a private copy launched through a directory junction must recover saved SQL and remain usable with SQLite when its DuckDB addon cannot load. Failures include bounded process output and a separately piped database-host probe. This diagnostic scope skips the remaining desktop, installer and driver suites and cannot run the signed Release stage. Ordinary CI keeps the default `all` scope and requires the full matrix.

Use `validationScope=windows-installers` to additionally build the installer pair and run the full Windows installer lifecycle (including persistent executable-lock refusal and transient-lock recovery), without repeating the other platform/driver jobs or the desktop interaction suite. This is also a diagnostic scope and cannot run the signed Release stage. The Azure manual-run form requires a nonempty Apple Silicon pool field; for these Windows-only scopes, `unused-for-windows-diagnostics` is sufficient because no Apple Silicon job is included.

[Windows diagnostic run 291](https://dev.azure.com/detegoprojects/SQL%20Commander/_build/results?buildId=291) passed packaged startup but failed installed baseline startup because the NSIS payload lacked DuckDB's native addon. Its standalone builder invocation selected npm after the Windows workspace probe returned a POSIX path. Development now supplies pinned pnpm context and audits required native binaries before installers are emitted. The corrected development source still needs a native Windows run after the normal main merge; the earlier main run does not certify it. Local Windows ARM64 emulation diagnostics cannot qualify a release.

Both Windows diagnostic scopes also exercise a failed database-host fork and a host that misses its normal startup deadline. The timed-out process must exit, and an explicit renderer reload must recover saved SQL without reconnecting or replaying it.

Vitest and Playwright publish JUnit reports in the Azure run's **Tests** tab, including failed tests. Missing reports fail the publication step, so a test command that never starts is visible. Reports live under `.test-artifacts/ci-results`, outside Playwright's automatically cleared `test-results` directory and the runner's temporary fixture directories. SQLite/DuckDB reports are written through a bind mount from the contract containers. Existing console reporters remain enabled.

Successful desktop jobs publish `SQLCommander-unsigned-<Agent.OS>-<arch>` artifacts containing tested installers, source/architecture manifests, SHA-256 checksums and lifecycle reports. These are unsigned test builds. The opt-in Release stage publishes per-target `release-<platform>-<arch>` candidates and, only after all four targets pass verification, `SQLCommander-release-<build number>`. Raw unpacked apps, debug configuration and upgrade fixtures are excluded. Failed jobs publish `test-diagnostics-desktop-<OS>-<arch>` or `test-diagnostics-driver-<driver>` from `test-results`, which contains screenshots and other output generated by the desktop tests. Build/test and Docker failure logs remain in the job logs.

The report settings also work outside Azure:

```sh
pnpm exec vitest run tests/unit --reporter=default --reporter=junit --outputFile.junit=.test-artifacts/ci-results/unit.xml
SQLCOMMANDER_TEST_REPORT_DIR=.test-artifacts/ci-results/integration pnpm test:integration --driver sqlite,duckdb
PLAYWRIGHT_JUNIT_OUTPUT_FILE=.test-artifacts/ci-results/desktop.xml node scripts/smoke-package.mjs
```

On Linux, wrap desktop commands with `bash scripts/with-test-keyring.sh node scripts/with-test-desktop.mjs`. The default local test commands keep their normal console-only reporting when these settings are absent. See [driver testing](DRIVER_TESTING.md) for fixture versions and test selection.

[Run 283](https://dev.azure.com/detegoprojects/SQL%20Commander/_build/results?buildId=283) passed all ten jobs on 15 October 2026 before this installer milestone. All three native desktop packages passed their unit, typecheck, build and packaged workflow checks, and all seven Docker driver jobs passed their integration and selected Electron workflows. That run validates the prior unpacked-package pipeline; it does not validate the new installer/release jobs. The new jobs require the next main run, with credentials/pool configured separately for signing. Development pushes and PR creation do not trigger runs.

Live Azure authentication, networking and billed recovery-copy tests are deliberately outside this pipeline; SQL Server Docker tests cannot certify Azure service behavior. Pipeline jobs use disposable fixtures without production credentials.

References: [Microsoft-hosted agent images and capacity](https://learn.microsoft.com/en-us/azure/devops/pipelines/agents/hosted?view=azure-devops), [Azure Repos triggers and build validation](https://learn.microsoft.com/en-us/azure/devops/pipelines/repos/azure-repos-git?view=azure-devops), and [JUnit result publishing](https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/reference/publish-test-results-v2?view=azure-pipelines).

The Linux wrapper creates a private Xvfb display and starts Openbox only after confirming no window manager owns it. It waits for the manager before running tests, preserves failures, and cleans up its owned children on interruption. Native minimize/focus checks require a window manager; bare Xvfb cannot qualify them. Installed tests explicitly request Chromium sandboxing and verify the actual launch switch. The existing disposable Fedora RPM exception remains explicit in lifecycle reports. No host sandbox policy is changed.

The wrapper also waits for the inherited process group after its runner exits, escalates TERM to KILL for stubborn helpers, and reports an unconfirmed stop as failure. The outer Xvfb wrapper gives bounded inner command/manager cleanup time before escalation. CLI regressions cover normal parent exit, cancellation, survival of an unrelated bystander, and nested cleanup without starting a display server. This covers inherited groups; native GUI, tray and credential behavior still needs native execution.
