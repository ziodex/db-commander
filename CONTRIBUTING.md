# Contributing

Start with the [fork and development setup](README.md#fork-and-run-locally). Use Node.js 22.13 or newer (22.x matches CI), the pinned pnpm 12.14.0, and `pnpm install --frozen-lockfile`. Docker with Compose is needed only for real-engine contracts and the supplied server fixtures. Unit tests and `pnpm dev` do not require Docker. Use `pnpm test:desktop --driver <engine>` for selected contracts and native Electron workflows, as described in the [driver testing guide](docs/DRIVER_TESTING.md).

Open contribution pull requests against `development`. [GitHub Actions](docs/GITHUB_ACTIONS.md) validates development/main pushes and pull requests to either branch with no signing secrets. Signed releases remain explicit main-only runs after the complete CI matrix passes.

Run `pnpm clean` to remove generated builds, release packages, coverage, test results and local diagnostics (`out`, `release`, `coverage`, `test-results`, `playwright-report` and `.test-artifacts`). Archive any qualification evidence you need first. Source files and installed dependencies are kept. Typechecking rejects unused imports, local declarations and parameters.

Keep database execution independent of React and Electron. Validate every new renderer-facing IPC method at the main boundary and keep filesystem/credential operations narrow. Preserve exact database values and session affinity. Never automatically retry SQL after a connection failure.

Changes to execution, transaction state, cancellation, or serialization need real Docker integration coverage. New drivers require [the driver contract suite](docs/DRIVER_TESTING.md), an owner, and a documented capability matrix. Interface-only changes should include a screenshot and keyboard behavior checks.

For code changes, run `pnpm lint`, `pnpm typecheck`, `pnpm test`, and integration/desktop checks for the affected behavior. For documentation changes, check local links and command examples; regenerate changed screenshots with `pnpm screenshots` and follow the [capture guide](docs/screenshots/README.md). Include the behavior changed, why it matters, relevant verification, and remaining limitations. Keep credentials, production data, and private SQL out of issues, screenshots, logs, and fixtures.

Contributions are licensed under Apache-2.0. Follow the [architecture boundaries and ownership rules](docs/architecture/README.md). Major architecture decisions belong in `docs/architecture` and should reference the product plan.
