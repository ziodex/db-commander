# Security policy

## Private reporting

Report suspected vulnerabilities privately to **post@detego.no**, with the subject `DbCommander security report`. Include the app version, operating system, affected engine/authentication mode, impact and a minimal reproduction using synthetic data. Do not include passwords, tokens, private keys, production SQL/results, full profiles or unreviewed heap snapshots. Arrange sensitive evidence transfer with the maintainer first.

Db Commander is currently a developer preview; no beta or supported security-maintenance window has been declared. There is no published response-time commitment. The project website is [detego.no](https://detego.no); availability of a website does not establish a qualified download channel. Ordinary support uses the same address; see [support guidance](SUPPORT.md).

## System and scope

Db Commander is a desktop SQL workbench. Its main process brokers sandboxed renderer requests to database hosts, local persistence, OS credential storage and explicitly selected files/tools. It connects to user-selected database and SSH endpoints. Database access follows the credentials and privileges the user supplies. The release pipeline builds installers and handles signing/notarization credentials separately from application execution.

Repository review covers application source, native worker boundaries, preload/IPC, persistence/import/export, connections, release tooling and CI. Dependency defects matter when the shipped configuration makes them reachable; packaged and native dependency composition remains a release-review task. No finding class or component is exempted by this policy.

## Trust boundaries and expected properties

Database values/metadata/errors, remote endpoints and certificates, imported files, recovered local state and renderer input must be treated as untrusted at their relevant boundary. Assets include database contents, credentials, SQL/results, local files, independent workspace sessions and release signing material.

The following are required properties to assess, not assertions that tests prove all attacks impossible:

- Renderers remain isolated and sandboxed, with no arbitrary Node, shell or filesystem bridge. Navigation/new-window handling and display of database/file content must not create an executable-content escape.
- IPC validates the sender and request shape. Workspace/session ownership must prevent a window from accessing another window's sessions, credentials or pending reviews without the intended explicit workflow.
- Verified TLS checks the chain and intended hostname, including SSH routing. Pinned SSH fingerprints must match. A connection failure must not silently weaken the selected protection.
- Remembered passwords are opt-in, bound to the intended profile/endpoint and stored through the OS vault. Tokens and SSH authentication secrets remain session-only. No IPC method returns a remembered password to a renderer. Workspace/history/export/logging paths must not accidentally persist supplied authentication secrets or bound parameter values.
- Recovery/reconnect must not automatically replay SQL. Mutations, destructive tools and file replacement retain their documented review, identity and ownership checks. Stale or ambiguous outcomes must not be silently retried.
- Untrusted parsing and retained data obey documented bounds. File publication must preserve existing destinations on refusal/failure, and cancellation must respect ownership of sessions, jobs and child processes.
- Release signing material must stay out of application payloads, logs and staged artifacts. Promotion must require the intended main commit/build, verified signatures and matching installer/inventory/lifecycle evidence.

## Findings and limitations

Report a concrete reachable violation with its impact and prerequisites. Unauthorized code execution, credential disclosure, cross-workspace access, TLS/host-key bypass, unintended SQL replay or mutation, arbitrary file overwrite and release-integrity bypass are relevant examples. Severity depends on exposure, required access and actual effect; a local desktop deployment or experimental engine label does not by itself exclude a finding.

Db Commander intentionally executes SQL and approved native database tools under the user's authority. Distinguish that intended capability from a bypass of isolation, review, scope or protection. No new accepted-risk exception or severity suppression is established here; unresolved decisions require maintainer review.

Workspace/history/SQL files can contain private SQL and are not encrypted. The app is not a sandbox for a hostile local OS/account. These deployment limitations do not excuse unintended secret persistence or a remotely reachable compromise. Catalog/result limits constrain retained previews, not all server work. Cancellation is not proof of rollback. Azure SQL remains experimental, and native signing, clean-OS, human accessibility and pilot qualification are still open in the [beta checklist](docs/PLAN.md#beta-release-checklist).
