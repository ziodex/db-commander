# GitHub Actions

[CI](../.github/workflows/ci.yml) is the build and test entry point. It runs on pushes to `development` and `main`, pull requests targeting either branch, and manual dispatch. Azure DevOps pipeline files and registration instructions have been removed. Historical reports elsewhere in `docs/` retain their original provider and commit references; they do not qualify the current GitHub build.

## Use CI in a fork

1. Fork all branches, including `development`, and enable workflows in your fork's **Actions** tab if GitHub asks.
2. Push a feature branch and open a pull request targeting `development`. The upstream `development` and `main` branches require pull requests and owner review. Ordinary validation requires no repository secrets or cloud service connections.
3. Open the run in **Actions → CI**. First-time external contributors may need a maintainer to approve their run under the repository's Actions policy.
4. Download reports and tested unsigned installers from the run's **Artifacts** section. These builds are developer test output, not signed public releases.

The workflow uses `pull_request`, not `pull_request_target`, has only `contents: read`, and checks out code without persisting Git credentials. Signing secrets are referenced only in the protected release job. External actions are pinned to full commit SHAs. Shared steps live under [`.github/actions`](../.github/actions), including the toolchain, Linux desktop, installer lifecycle and report collection.

Node.js 22, the pnpm version in `package.json`, and `pnpm install --frozen-lockfile` are used throughout. The pnpm store is cached; `node_modules` is installed for each native host, including optional native dependencies. Do not disable optional dependencies or reuse another architecture's `node_modules`.

## Jobs and coverage

| Job | Native runner | Validation |
| --- | --- | --- |
| Desktop / macOS Intel | `macos-15-intel`, x64 | Unit tests, build, packaged Electron, DMG/ZIP lifecycle and artifact staging |
| Desktop / Apple Silicon | `macos-15`, arm64 | Same checks natively on Apple Silicon |
| Desktop / Windows | `windows-2025`, x64 | Unit tests, packaged Electron, NSIS lifecycle and staging |
| Desktop / Linux | `ubuntu-24.04`, x64 | Unit tests, packaged Electron, DEB/AppImage lifecycle, Fedora RPM lifecycle and staging |
| Driver, seven matrix entries | `ubuntu-24.04`, x64 | Real PostgreSQL, MySQL, MariaDB, SQL Server, SQLite, Oracle and DuckDB contracts, then selected Electron workflows |

Host preflight refuses emulated or mismatched architectures. Driver concurrency is capped at three, with each fixture isolated to its job. Oracle alone removes unused hosted SDK directories to make room for its images. Linux Docker must report native x64; the SQL Server fixture also exercises Azure SQL profile paths, without claiming live Azure service qualification.

Windows and macOS prepare a display of at least 1920×1080 for native resizing tests. The macOS display script is restricted to disposable GitHub-hosted runners. macOS uses the hosted console and keychain; the tests still require the logged-in, unlocked desktop and real focus behavior. Job limits remain 90 minutes for desktop/installer validation, 60 for drivers and 120 for signed release targets. Ordinary validation jobs run independently and retain other targets' results after one fails.

### Linux desktop tests

The [Linux setup action](../.github/actions/linux-desktop/action.yml) installs Xvfb, Openbox, D-Bus, GNOME Keyring, Playwright's Chromium system libraries, and packaging tools where needed. Run Electron under both existing isolation wrappers:

```sh
bash scripts/with-test-keyring.sh node scripts/with-test-desktop.mjs pnpm test:desktop --driver postgres
```

The outer wrapper creates a disposable credential store. The desktop wrapper owns a private Xvfb display and window manager, waits for readiness, preserves the command's exit status and cleans up its children. Bare `xvfb-run` does not provide the window-manager behavior required by minimize/focus tests.

For installer qualification, the Linux setup action verifies `unshare -Ur true`. When Ubuntu's AppArmor restriction blocks it, the action permits unprivileged user namespaces on the disposable GitHub-hosted worker only. It refuses to make that change on a developer or self-hosted machine. This allows AppRun's namespace probe to succeed without adding `--no-sandbox`. The AppImage desktop entry also omits electron-builder's legacy sandbox-disabling default argument. DEB/AppImage lifecycle tests still require the actual installed application to run with Chromium sandboxing enabled; the separate Fedora RPM exception remains explicit in lifecycle reports.

## Reports and artifacts

- `test-results-desktop-<platform>-<arch>` and `test-results-driver-<driver>` contain JUnit XML from `.test-artifacts/ci-results` and diagnostics/screenshots from `test-results`, on success or failure. A build failure before tests start may produce no XML; the failed step's logs show that failure.
- `dbcommander-unsigned-<platform>-<arch>` contains only staged, tested installers, inventory/notices, checksums, manifest and lifecycle reports.
- `release-<platform>-<arch>` contains a verified signed-release candidate for promotion, when explicitly requested.
- `dbcommander-release-<run ID>-<attempt>` is the complete promoted bundle with all four targets and eight installer/archive formats.

Reports and per-target packages are retained for 14 days, and the promoted bundle for 30 days. Download and archive evidence before expiry. Uploads never include the raw `release/` directory, signing files, unpacked applications or upgrade fixtures. There is no automatic release publication, tag creation or installation.

Manifest `buildId` is `<GITHUB_RUN_ID>.<GITHUB_RUN_ATTEMPT>`, with `GITHUB_SHA` binding signed output to the checked-out main commit. Promotion downloads only this run's release candidates and verifies all targets, version, source, run/attempt, checksums, signatures, inventories and installer lifecycle evidence. Rerunning only failed release jobs can leave older-attempt artifacts; promotion deliberately rejects a mixed set. For a release, rerun **all jobs** or start a new manual run.

## Manual Windows diagnostics

[Windows diagnostics](../.github/workflows/windows-diagnostics.yml) replaces the old Windows-only pipeline scopes. After that workflow exists on the repository's default branch, select **Actions → Windows diagnostics → Run workflow**, choose the source branch, and optionally enable **installers**.

It always checks native x64, runs unit/build/package checks and packaged startup/native-library recovery tests. With installers enabled it also builds the unsigned baseline and current NSIS package, runs their complete lifecycle and uploads the staged installers. It skips the full interaction and driver matrix, uses no signing secrets and cannot qualify a signed release.

## Signed releases

In **Actions → CI → Run workflow**, choose **main** and enable **create_release**. The full ordinary matrix runs first. Signed targets require successful desktop and driver jobs in that same run, an explicit main-branch dispatch, and access to the `release` environment. A release request from any other branch fails preflight without loading signing credentials. Promotion runs only after every signed target succeeds.

Create and protect the `release` environment before configuring its signing secrets. Normal pushes and fork pull requests do not use it. See [release setup](RELEASING.md#github-actions-release-setup) for the Apple and Windows credentials and manual publishing process.

GitHub requires a workflow to be present on the default branch before it can be manually dispatched. The current active source is `development`; the bootstrap `main` has an independent initial history. Before the first manual release, a maintainer must establish the reviewed source/workflows on `main` and the default branch. Updating `development` does not rewrite `main` or publish a release.

References: [GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners), [fork pull-request workflows](https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#workflows-in-forked-repositories), [manual dispatch](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow), and [deployment environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).
