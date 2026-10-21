# Release foundations

The [frozen beta plan](PLAN.md#beta-release-checklist) is the single current release checklist. This guide describes the build/signing mechanisms; [beta notes](BETA_NOTES.md) define initial scope, accepted limits and manual updates.

This milestone prepares the release path; it does not declare Db Commander production-ready. The maintainer confirmed on 20 October 2026 that Apple/Windows signing resources and the native Apple Silicon Azure pool are not configured. Ordinary main CI builds unsigned installers without loading signing resources. Signed releases are explicitly requested and require successful Desktop and Drivers stages for the same main commit.

## Native targets and installers

| Target | Installer formats | Lifecycle test host |
| --- | --- | --- |
| macOS Intel x64 | DMG, ZIP | Native Intel Mac |
| macOS Apple Silicon arm64 | DMG, ZIP | Native Apple Silicon Mac |
| Windows x64 | Assisted NSIS EXE | Disposable native Windows worker, current-user installation |
| Linux x64 | Debian DEB, RPM, AppImage | Ubuntu for DEB/AppImage; Fedora 43 container on the same native x64 worker for RPM |

Each job checks the host and Node architecture. Windows also verifies the processor through CIM: an emulated x64 Node process reporting AMD64 on Windows ARM64 cannot qualify a release, and unavailable processor information fails closed. Cross-compilation and Rosetta are refused by the release scripts. Linux/Windows ARM64, universal Mac binaries, MSI, Store packages and automatic updates are outside this milestone. The matrix defines tested build targets, not certification of every OS version.

Standalone release builds explicitly supply the pinned pnpm context to electron-builder. On Windows, Git's `pwd` can produce a POSIX workspace path that causes builder to fall back to environment-based package-manager detection; falling back to npm can omit pnpm's optional native dependencies. An `afterPack` audit now requires nonempty regular files for the target's DuckDB addon, DuckDB shared library and native credential backend before installer creation. The same audit requires the pinned Electron distribution version and exact, nonempty `LICENSE` and `LICENSES.chromium.html` bytes in `resources/licenses/`. The audit also preserves the exact version-matched READMEs for `pg-types` 2.2.0, `pgpass` 1.0.5 and `railroad-diagrams` 1.0.0 under `resources/licenses/`: their upstream license text lives in documentation that builder normally removes. Source resolution follows the installed dependency chain instead of hard-coding pnpm store paths; a version change requires reviewing the notice mapping. Healthy startup and lifecycle tests still have to load and exercise those binaries.

Oracle support is Thin-only. Release collection excludes node-oracledb’s optional `build/` payload, following [Oracle’s Thin-only installation guidance](https://node-oracledb.readthedocs.io/en/latest/user_guide/installation.html#install-node-oracledb), without pruning the developer’s dependency cache. Both afterPack and installed inventory verification reject retained Thick addons/build payloads, including nested or orphaned physical copies, and require the pinned pure JavaScript entry and Thin implementation. Oracle package/license metadata stays in the SBOM/notices. This does not add Thick mode or Oracle Client support.

Mac packages additionally retain the complete Mantle and ReactiveObjC license files from the source revisions pinned by Electron 44.7.0's DEPS. Mantle's file includes its Proton notice. The retained Chromium notice bundle covers Squirrel/Sparkle/bsdiff but omits these two framework notices. [Source provenance and hashes](../build/vendor-notices/README.md) are vendored for offline packaging; source/payload changes and a new Electron version fail the audit until reviewed. Schema-2 Mac inventory also requires both exact notice hashes. Earlier unsigned schema-1 diagnostics retain their historical compatibility; a schema-2 candidate missing these notices requires rebuilding.

Application identity is `org.dbcommander.desktop`, with display name `Db Commander`, executable name `DbCommander` (`dbcommander` on Linux), and package name `dbcommander`. Fresh installs use the `Db Commander` application-data folder. Existing `SQLCommander` profiles stay in place, retain their lock namespace, and can read their path-bound legacy OS credentials. New credentials use `org.dbcommander.passwords`. Existing snippet, editor-settings and SQL-dump exports remain importable. The renamed application has a new installer identity; close the old application before installing and remove its old app bundle or package separately once the new app is verified. Keep release versions in `package.json` as semantic versions without build metadata.

Windows defaults to a current-user installation, permits choosing the destination and retains application data on uninstall. Its installer and uninstaller refuse to proceed while Db Commander is running (exit code 2 for silent callers); they never force-close database sessions. Normal uninstall retries a locked executable for about ten seconds; a persistent deletion failure returns exit code 3 before removing other application files or installer registration, so the installation can be retried. Upgrade replacement retains builder's atomic rename/restore behavior. Close the application after settling transactions before an upgrade. Mac applications are replaced by copying the new app bundle. Linux DEB/RPM upgrades use the package manager; AppImage replacement is manual. Close the application before any replacement.

## Azure setup

### Apple Silicon agent

Create a dedicated native ARM64 macOS agent pool and authorize **SQLCommander CI** to use it. Supply its exact name as the `macArmPool` runtime parameter. The pool demands `Agent.OS=Darwin` and `Agent.OSArchitecture=ARM64`. Use an ARM64 Azure agent and native ARM64 Node; install PowerShell 7, Xcode command-line tools (including `notarytool`/`stapler`) and an interactive desktop/login keychain suitable for Electron and credential-store tests. Run under a dedicated test user, with no personal profiles or credentials. Restore a clean worker between jobs; a successful test removes its temporary fixtures, but failed runs intentionally retain diagnostics.

As of 15 October 2026, Microsoft's hosted macOS ARM64 preview is paused for new organizations. The configurable pool avoids assuming access to that preview. With an empty pool parameter ordinary Azure CI covers the three x64 hosts; signed releases refuse to proceed without the fourth native target. Once the pool exists, set the YAML parameter default to its name if ARM64 should run on every main push. [Microsoft-hosted agent availability](https://learn.microsoft.com/en-us/azure/devops/pipelines/agents/hosted?view=azure-devops).

The GitHub workflow also defines explicit Intel and Apple Silicon jobs, but signing/promotion is managed by Azure. Do not use a developer workstation as a Windows/Linux system-installer test worker.

### Signing resources

In **Pipelines → Library**, create the variable group **SQLCommander-Release**. Authorize this pipeline only. Upload the two Apple files under **Secure files**, and authorize this pipeline to read them. Do not commit certificates, keys, secrets or filled-in environment files. Restrict editing/queuing of the release pipeline and access to these resources to release maintainers; apply resource branch checks for `refs/heads/main` where available. YAML conditions prevent accidental runs, while Azure permissions protect the credentials.

| Variable group entry | Value | Secret |
| --- | --- | --- |
| `APPLE_CERTIFICATE_FILE` | Secure-file name of the exported Developer ID Application `.p12`, including its private key | No; filename only |
| `APPLE_CERTIFICATE_PASSWORD` | Password protecting that export | **Yes** |
| `APPLE_API_KEY_FILE` | Secure-file name of the App Store Connect API `.p8` key | No; filename only |
| `APPLE_API_KEY_ID` | API key ID | No |
| `APPLE_API_ISSUER` | Issuer ID for the team API key | No |
| `SQLCOMMANDER_APPLE_IDENTITY` | Full identity, e.g. `Developer ID Application: Your Organization (TEAMID)` | No |
| `SQLCOMMANDER_APPLE_TEAM_ID` | Expected Apple developer team ID | No |
| `AZURE_TENANT_ID` | Entra tenant ID used for Windows signing | No |
| `AZURE_CLIENT_ID` | Signing service principal's application/client ID | No |
| `AZURE_CLIENT_SECRET` | Service principal secret **value**, not its ID | **Yes** |
| `SQLCOMMANDER_SIGN_ENDPOINT` | Account's HTTPS regional `*.codesigning.azure.net` endpoint | No |
| `SQLCOMMANDER_SIGN_ACCOUNT` | Windows signing account name | No |
| `SQLCOMMANDER_SIGN_PROFILE` | Public Trust certificate profile name | No |
| `SQLCOMMANDER_SIGN_PUBLISHER` | Exact certificate subject Common Name | No |

For Apple, use an active Developer ID Application certificate and a team App Store Connect API key authorized for notarization. The build enables hardened runtime, applies the JIT entitlement, verifies the expected identity/team, checks the app with `codesign` and Gatekeeper, and validates its stapled ticket. It separately submits and staples the signed DMG. The ZIP contains the stapled app bundle. Missing credentials, rejected notarization or a mismatched signer fail the build. [Apple notarization](https://developer.apple.com/documentation/security/notarizing-macos-software-before-distribution).

For Windows, configure an Azure Artifact Signing account (formerly Trusted Signing), complete identity validation, and create a **Public Trust** profile. Grant the service principal the **Artifact Signing Certificate Profile Signer** role on the intended profile. An Owner/Contributor role alone does not grant signing. See Microsoft's [account setup](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart) and [signing roles](https://learn.microsoft.com/en-us/azure/artifact-signing/concept-resources-roles).

The pinned electron-builder 26 integration uses `win.azureSignOptions` and the three `AZURE_*` authentication values. The verifier checks both installed executable and installer for a valid Authenticode signature, expected publisher and timestamp. This does not certify SmartScreen reputation. Other HSM/certificate providers require a separate adapter. [electron-builder 26 Windows signing](https://www.electron.build/v26/docs/features/code-signing/code-signing-win/).

Signing values are mapped only into the signing step. Apple files are downloaded with Azure's Secure Files task; builder uses its temporary signing keychain. Ordinary builds explicitly disable signing and strip credential environment variables before invoking builder. Do not publish the raw `release/` directory or builder debug configuration. Release staging copies only known installers, manifests, checksums and test reports.

Linux packages receive SHA-256 checksums; they are not GPG-signed DEB/RPM repositories. The manifest's `mode: signed` denotes the release pipeline policy; Linux explicitly records `codeSignature: false`. Repository signing, a public download host and automatic installation remain separate work. The app checks public GitHub release metadata for notifications and keeps installation manual.

### Running a release

1. Finish and review the development changes, choose a new version, then merge into main through the existing workflow. Main-only CI and disabled automatic PR build validation remain unchanged.
2. First run ordinary main CI with `createRelease=false`, supplying `macArmPool` to validate all four hosts. All seven Docker driver jobs must pass, including SQL Server and Azure SQL profile contracts on Linux x64.
3. In **Db Commander CI → Run pipeline**, select **main**, enable `createRelease`, and supply the ARM64 pool. This run repeats the entire Desktop and Drivers stages; a previous green run alone cannot authorize a different source commit.
4. Both stages must report **Succeeded**, not skipped or partially successful. The Release stage builds and verifies signed installers on Mac/Windows and release packages on Linux, then runs the installer lifecycle suite against those exact bytes. The initial upgrade fixture is signed too, keeping signer identity consistent across upgrades.
5. **PromoteRelease** downloads only candidate artifacts from the current run and checks all four architectures, source commit, build ID, version, checksums, signatures/notarization and every installer format's lifecycle result. It rejects unsigned or fixture manifests and missing/mismatched evidence.
6. Download **SQLCommander-release-<build number>** from that run. It includes eight installer/archive files, eight inventory/notice sidecars, `SHA256SUMS`, `release.json` and per-target manifests/reports. Keep the Azure run and release bundle; apply long-term retention before publishing externally. No public publishing or release tag is created automatically.
7. When approved for public distribution, publish a stable release at [ziodex/db-commander](https://github.com/ziodex/db-commander/releases), tagged `v<package version>` (for example `v0.2.0`). Include release notes and the final qualified installers, checksums and notices, or links to those official downloads. The app uses GitHub's latest-release endpoint, ignores drafts/prereleases and only notifies when the semantic version is newer than the installed application. No credentials are shipped with the checker. Replacing CI artifacts or pushing a Git tag alone does not notify users.

The Release stage and its secure-file references are excluded at template expansion when `createRelease=false`. A missing signing group therefore does not block ordinary main CI. Enabling release before resources are configured will fail resource authorization or preflight; it will never fall back to unsigned output. A missing ARM pool blocks promotion even when the three x64 jobs are available.

## Local build and lifecycle tests

Install the pinned dependencies, then run on a supported native host:

```sh
pnpm install --frozen-lockfile
pnpm package
node scripts/smoke-package.mjs
pnpm release:baseline
pnpm release:build
pnpm test:installers
```

`pnpm package` typechecks/builds the application and creates an unpacked native application. `release:baseline` and `release:build` package the current `out/` into separate versioned installer sets; run `pnpm build` after source changes. `pnpm dist` builds source and creates only the candidate. Output defaults to `release/baseline` and `release/candidate`; existing output is refused to avoid mixing stale artifacts. Archive/remove only your previous generated directories before rebuilding, or use `--output` and matching `--baseline`/`--candidate` test arguments.

Mac lifecycle tests install into an owned temporary directory and can run locally. Windows EXE and Linux DEB/RPM tests perform real system installation/uninstallation and require **both** `CI=true` and `SQLCOMMANDER_DISPOSABLE_INSTALL_TEST=1` on a disposable worker. They refuse existing installations and existing default data directories. They preserve data on application uninstall, then remove their own synthetic data after successful verification. Failures retain the test fixture for investigation.

On Linux run desktop/lifecycle commands through `bash scripts/with-test-keyring.sh node scripts/with-test-desktop.mjs`. The CI worker additionally installs RPM build tooling. `pnpm test:installers:rpm` runs the actual RPM lifecycle in Fedora, with a separate private keyring. Its image is reused by Dockerfile/UID hash if present; a fresh CI host builds it once with `--pull=false`. Runtime networking is disabled. This container alone disables Chromium's namespace sandbox because it is unavailable there; Ubuntu's installed tests use the normal sandbox. Database fixture images and their reuse policy are unchanged.

Tests verify installation in a path with spaces (where the format supports custom paths), actual application version and architecture, Monaco/preload isolation, two saved SQL buffers, layout, profiles, snippets, history, OS-stored passwords and native SQLite/DuckDB persistence with exact 64-bit values. They check an upgrade leaves workspace bytes unchanged before launch, never reconnects/replays saved SQL, and preserves the same data/credentials through uninstall and reinstall. Windows also tests refusal of upgrade/uninstall while the app is running, refusal of uninstall while an executable lock persists, unchanged files/registration on refusal, and successful uninstall after a temporary lock is released. Reports bind results to the exact installer hashes and inventory descriptor. Each upgraded/reinstalled candidate is checked against its ASAR, physical SQLite worker, every indexed unpacked file, runtime and packaged notice hashes. Chromium sandboxing is requested explicitly and the actual switch is verified; the disposable Fedora exception is recorded in the report.

### Dependency inventories and redistribution notices

Each installer set includes `DbCommander-<version>-<os>-<arch>-sbom.cdx.json` and `DbCommander-<version>-<os>-<arch>-notices.json`. The CycloneDX 1.6 inventory reads the actual production ASAR, enumerates packaged npm instances and resolved dependency references, and records the pinned Electron version, ASAR hash, each native binary hash and installer hashes. Separate unpacked-file hashes matter because every physical file under `app.asar.unpacked`, including native binaries and package metadata, is outside the ASAR digest. The notice JSON preserves packaged license/notice texts, including Electron's upstream license, Chromium notice bundle and the three supplemental dependency READMEs, with per-file hashes. Generation and verification reject a missing required README even if the sidecar's outer checksum was updated. Electron's upstream notice files are also shipped in the installed application's `resources/licenses/` directory.

Inventory descriptor **schema 2** also probes the just-built executable with a fixed `ELECTRON_RUN_AS_NODE` expression. It requires the expected target/Electron identity and reported Node, Chromium and SQLite versions; signing credentials and inherited Node/Electron launch overrides are excluded from the probe environment. Recognized embedded library versions become BOM components linked to Electron. All reported values remain properties, while empty/zero placeholders, ABI numbers and data revisions do not become invented software-library versions. A bounded scan hashes regular Mach-O/PE/ELF files throughout the app bundle, including executable, helpers, frameworks and shared libraries outside the ASAR. It skips symlink aliases and inventories ASAR-unpacked native files separately. Installed checks verify every recorded runtime file's size/hash and refuse symlink redirection; installer-created extra files such as the NSIS uninstaller do not substitute for recorded application files.

Generation validates against pinned, vendored official schemas without a network request. [Schema provenance](../scripts/release/schemas/README.md) records the source commit and checksums. The BOM explicitly declares **incomplete** native/runtime composition: reported embedded versions and native-file hashes improve identification, but transitive vendor dependencies, unavailable versions and redistribution obligations still require review. This is inventory evidence, not a completed redistribution or vulnerability review. The remaining review is B16 in the beta plan.

Schema 3 additionally binds the self-contained `resources/workers/sqlite-worker.cjs` by exact size/hash and application dependency reference. The worker is outside ASAR because the Linux child loader fails to resolve ASAR entries beneath non-ASCII installation paths. The build bundles all worker imports except Node builtins; afterPack compares the physical copy to that build output. Installed verification rejects changed/missing files and redirected parent/leaf paths. Historical unsigned schema-1/2 evidence remains readable but cannot qualify a signed release or current promotion.

Schema 4 adds identified native software constituents, their Cargo/npm/generic package URLs, version/source archive digests, notice references, and links to the actual native file and owning npm instance. It retains positively identified Rust crates, libdbus, DuckDB and the addon header dependency; DuckDB's conservative source-notice superset does not become a claim that all its vendors are linked. Flat constituent links do not reconstruct the transitive Cargo/C++ graph. The BOM explicitly marks the application, native files and identified libraries as incomplete. Missing/altered software records, source hashes, constituent/ownership links and contradictory complete-composition claims fail verification.

Unsigned identified native payloads must match their reviewed source hashes exactly. For Mac/Windows signing, afterPack checks those original bytes before signing and the release builder verifies actual signed output before generating the inventory. The SBOM retains the reviewed source digest separately from the final native-file digest and labels changed signed payloads accordingly; it does not assert byte identity with the unsigned registry payload. This build evidence does not replace native/signing qualification. Earlier unsigned inventory formats remain diagnostic inputs within their existing checks; current candidate staging and signed promotion require schema 5. Changing only a current manifest's schema number fails the BOM profile check.


Schema 5 covers **every ASAR-indexed unpacked regular file**, including package manifests, JavaScript, assets and empty files. Each file has a SHA-256 digest, final physical size and archive dependency reference. Native-file records keep their software/source/ownership links. Generation rejects unindexed physical files and redirected unpacked paths. Installed verification checks coverage against the actual ASAR index and rejects missing/extra records, changed bytes/sizes and symlink/junction redirects in roots, parents or leaves. Final signed native files may differ in size from the pre-signing ASAR index, so their recorded final physical size is used. Installer-created files outside `app.asar.unpacked`, such as the NSIS uninstaller, remain separate from this archive coverage. This file-integrity profile does not establish complete vendor composition or redistribution approval.

`manifest.json` binds both sidecars by name, size and SHA-256, plus the ASAR identity. `SHA256SUMS` covers installers and sidecars. Staging accepts only its explicit artifact/report whitelist, requires the current candidate inventory and matching lifecycle evidence, and excludes unpacked/debug/signing files. Promotion verifies all four targets before creating output; `release.json` lists eight installers in `files` and eight sidecars in `inventory`, with all sixteen payload digests in `SHA256SUMS`. A missing, modified, stale or unresolved inventory fails validation. Checksums establish consistency; Mac/Windows signature checks and the trusted release channel remain separate requirements.

Only the lifecycle runner's **older baseline** may predate inventory metadata. A new candidate, newly staged baseline or promoted set must carry verified inventory. The earlier unsigned schema-1 diagnostic candidates remain readable against their own evidence; schema downgrade of a current BOM is rejected, and signed qualification/promotion requires schema 5. Never attach an old lifecycle report to a new sidecar/installer set; run the installed checks on those exact bytes. Refer to [publishing and retention](QUALIFICATION.md#publishing-and-evidence-retention--b16) before exposing public downloads.

### Upgrade baseline limitation

There is no previous published release yet. The automatic suite builds current source as **0.0.0** and upgrades it to the candidate version. This verifies installer replacement and persistence across different application versions; it does **not** validate historical workspace migrations. The report records `syntheticBaseline: true`, and fixture installers cannot be promoted.

For the next public release, retain the previous signed per-platform installer sets and `manifest.json` from the candidate artifacts, and extend the pipeline to download those as the baseline. The runner already accepts `--baseline /path/to/previous-release` and requires a strictly older semantic version with matching platform/architecture and valid checksums. Historical baselines may also need a version-specific workspace seed if IPC contracts change. Do not count the synthetic fixture as previous-release migration coverage.

## Remaining release qualification

Before public distribution, configure the credentials/pool above and complete a fully signed four-target main run, including the Windows running-app refusal tests and Linux package-manager tests. Perform native first-download/Gatekeeper/SmartScreen checks on clean end-user OS installations, establish minimum OS support, and complete current accessibility, crash-recovery and sustained-workload qualification. The application icon was replaced and locally validated on 19 October; it is not unfinished release work. The automated Mac tests copy the bundle from a DMG/ZIP; they do not simulate browser quarantine or every Finder interaction.

Further work includes completing the native/vendor inventory and dependency/redistribution review, selecting the beta version, approving the final changelog/support matrix and evidence retention, historical workspace migration/recovery tests, and qualifying the download channel at detego.no. Support/private reporting uses post@detego.no; see [support guidance](../SUPPORT.md). [Qualification procedures](QUALIFICATION.md) describe the human, clean-OS, reference-hardware and pilot evidence still needed. Linux repository signing, if a repository is offered, remains separate work. Initial beta updates are manual; no downgrade or data-loss rollback guarantee is made by installer replacement tests.


Staging and promotion share the same lifecycle-report validation: exact source/build/version/target, artifact and inventory identities, a strictly older upgrade baseline, and each required format passing exactly once. Linux DEB/AppImage reports must record `chromiumSandbox: enforced`; RPM accepts that or the explicit `disabled-disposable-container` exception. Mac/Windows record `platform-default`. Missing or invalid sandbox evidence is rejected. Before a lifecycle rerun starts installation, its previous passing report is removed; a failed attempt cannot silently leave that old pass available for staging. Logs/JUnit and failed test fixtures retain the failure evidence. These validation rules do not replace actual native execution.
