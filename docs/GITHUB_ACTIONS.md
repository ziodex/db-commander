# GitHub Actions

[CI](../.github/workflows/ci.yml) is the build and test entry point. It runs on pushes to `development` and `main`, pull requests targeting either branch, and manual dispatch. Azure DevOps pipeline files and registration instructions have been removed. Historical reports elsewhere in `docs/` retain their original provider and commit references; they do not qualify the current GitHub build.

## Use CI in a fork

1. Fork all branches, including `development`, and enable workflows in your fork's **Actions** tab if GitHub asks.
2. Push to `development` or `main`, or open a pull request targeting one of those branches. Ordinary validation requires no repository secrets or cloud service connections.
3. Open the run in **Actions → CI**. First-time external contributors may need a maintainer to approve their run under the repository's Actions policy.
4. Download test reports from the run's **Artifacts** section. Installer bundles are produced by explicit release qualification or the optional Windows installer diagnostics.

The workflow uses `pull_request`, not `pull_request_target`, defaults to `contents: read`, and checks out code without persisting Git credentials. The promotion gate additionally has `actions: read` to inspect development CI. Signing secrets are referenced only in the protected release job. External actions are pinned to full commit SHAs. Shared steps live under [`.github/actions`](../.github/actions), including the toolchain, Linux desktop, installer lifecycle and report collection.

Node.js 22, the pnpm version in `package.json`, and `pnpm install --frozen-lockfile` are used throughout. The pnpm store is cached; `node_modules` is installed for each native host, including optional native dependencies. Do not disable optional dependencies or reuse another architecture's `node_modules`.

## Jobs and coverage

Full validation runs on pushes to `development` and PRs targeting it. Main pushes and PRs targeting main run only **Main build and startup**, a Linux native build with startup, native SQLite/DuckDB loading and startup recovery checks. They do not rerun the full interaction/driver matrix or build installers. A manual run without `create_release` also runs this quick check. Explicit releases run the full desktop/driver matrix before signed installer qualification.

### Promoting development to main

Open a PR from this repository's `development` branch into `main` after the latest development push CI is green. **Development CI passed** requires the exact current development commit, a completed successful `CI` push run, all four Desktop and seven Driver targets, and **Full development CI**. Pending, failed, cancelled, skipped or missing qualification fails the gate; a green feature PR is insufficient. If opened early, rerun the promotion check after development CI completes.

Development must already contain main, so promotion introduces the tested development tree without untested merge differences. After a main merge commit, bring main into development as part of the next development change and validate that combined history before its next promotion. Feature branches and forks cannot promote directly to main.

Configure required GitHub Actions checks with no CI bypass: **Full development CI** for `development`; **Development CI passed** and **Main build and startup** for `main`, with branches required to be up to date. Keep review/deletion/history protections separately. Fork maintainers must configure these rules in their own repository. Required checks are repository settings, not applied by cloning workflow YAML.

The corresponding rule definitions are versioned in [`.github/branch-rules`](../.github/branch-rules). Apply them as additional repository rulesets after the workflow is available; preserve existing review rules. They accept checks only from the GitHub Actions app and grant no bypass actors.

| Job | Native runner | Validation |
| --- | --- | --- |
| Desktop / macOS Intel | `macos-15-intel`, x64 | Unit tests, build and full packaged Electron workflows |
| Desktop / Apple Silicon | `macos-15`, arm64 | Same checks natively on Apple Silicon |
| Desktop / Windows | `windows-2025`, x64 | Unit tests and full packaged Electron workflows |
| Desktop / Linux | `ubuntu-24.04`, x64 | Unit tests and full packaged Electron workflows |
| Driver, seven matrix entries | `ubuntu-24.04`, x64 | Real PostgreSQL, MySQL, MariaDB, SQL Server, SQLite, Oracle and DuckDB contracts, then selected Electron workflows |

Host preflight refuses emulated or mismatched architectures. Driver concurrency is capped at three, with each fixture isolated to its job. Oracle alone removes unused hosted SDK directories to make room for its images. Linux Docker must report native x64; the SQL Server fixture also exercises Azure SQL profile paths, without claiming live Azure service qualification.

Windows prepares a 1920×1080 display for native resizing tests. macOS uses the hosted console and keychain; the tests still require the logged-in, unlocked desktop and real focus behavior. Job limits remain 90 minutes for desktop/installer validation, 60 for drivers and 120 for signed release targets. Ordinary validation jobs run independently and retain other targets' results after one fails.

### Linux desktop tests

The [Linux setup action](../.github/actions/linux-desktop/action.yml) installs Xvfb, Openbox, D-Bus, GNOME Keyring, Playwright's Chromium system libraries, and packaging tools where needed. Run Electron under both existing isolation wrappers:

```sh
bash scripts/with-test-keyring.sh node scripts/with-test-desktop.mjs pnpm test:desktop --driver postgres
```

The outer wrapper creates a disposable credential store. The desktop wrapper owns a private Xvfb display and window manager, waits for readiness, preserves the command's exit status and cleans up its children. Bare `xvfb-run` does not provide the window-manager behavior required by minimize/focus tests. No host sandbox policy is weakened; the documented disposable Fedora RPM exception remains explicit in lifecycle reports.

## Reports and artifacts

- `test-results-desktop-<platform>-<arch>` and `test-results-driver-<driver>` contain JUnit XML from `.test-artifacts/ci-results` and diagnostics/screenshots from `test-results`, on success or failure. A build failure before tests start may produce no XML; the failed step's logs show that failure.
- `test-results-main-startup` contains quick main build/startup reports and diagnostics.
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

GitHub requires a workflow to be present on the default branch before it can be manually dispatched. Main contains the full application and documentation. Promote reviewed, qualified development commits through the gate above before requesting a release.

References: [GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners), [fork pull-request workflows](https://docs.github.com/en/actions/using-workflows/events-that-trigger-workflows#workflows-in-forked-repositories), [manual dispatch](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/manually-run-a-workflow), and [deployment environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments).
