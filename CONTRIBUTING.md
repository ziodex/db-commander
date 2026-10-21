# Contributing

Install Node.js 22.13+, pnpm 11, and Docker with Compose. Run `pnpm install`, `pnpm test`, and `pnpm dev`. Use `pnpm test:desktop` for the database contracts and native Electron workflows; select individual engines with `--driver` as described in the driver testing guide.

Run `pnpm clean` to remove generated builds, release packages, coverage, test results and local diagnostics (`out`, `release`, `coverage`, `test-results`, `playwright-report` and `.test-artifacts`). Archive any qualification evidence you need first. Source files and installed dependencies are kept. Typechecking rejects unused imports, local declarations and parameters.

Keep database execution independent of React and Electron. Validate every new renderer-facing IPC method at the main boundary and keep filesystem/credential operations narrow. Preserve exact database values and session affinity. Never automatically retry SQL after a connection failure.

Changes to execution, transaction state, cancellation, or serialization need real Docker integration coverage. New drivers require [the driver contract suite](docs/DRIVER_TESTING.md), an owner, and a documented capability matrix. Interface-only changes should include a screenshot and keyboard behavior checks.

Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, and appropriate desktop checks before proposing a change. Include the behavior changed, why it matters, relevant verification, and remaining limitations. Keep credentials, production data, and private SQL out of issues, screenshots, logs, and fixtures.

Contributions are licensed under Apache-2.0. Follow the [architecture boundaries and ownership rules](docs/architecture/README.md). Major architecture decisions belong in `docs/architecture` and should reference the product plan.
