# App screenshots

These PNGs show the running Db Commander developer preview, version 0.2.0, with a synthetic shop database. The capture uses a separate temporary profile and in-memory DuckDB connection. It does not open existing workspaces, save credentials or use production data. Screenshots preserve the application's interface and are not mockups or edited composites.

| Image | What it shows |
| --- | --- |
| [Query workbench, dark](query-workbench-dark.png) | A revenue-by-market query, a selected range of result cells, the database explorer and active saved connection |
| [Table browser, light](table-browser-light.png) | Keyed product data, column types and table browsing/edit actions |
| [ER diagram, light](schema-diagram-light.png) | Four related tables and their live catalog columns, primary keys and foreign keys |

## Regenerate

Install the dependencies from the lockfile, then run from the repository root with an unlocked graphical desktop:

```sh
pnpm install --frozen-lockfile
pnpm screenshots
```

This builds the current source, launches an isolated Electron instance, creates deterministic demo data, exercises the UI and writes three 1440×960 PNGs plus [capture metadata](capture.json). Review every image at full size before committing it. The capture closes its own app instance and removes its temporary profile; generated PNGs and metadata remain in this directory. It does not replace an existing packaged app or alter another running instance.

For an already-built app on Linux, use the same private display and keyring wrappers as CI:

```sh
pnpm build
bash scripts/with-test-keyring.sh node scripts/with-test-desktop.mjs node scripts/capture-screenshots.mjs
```

The generator is [scripts/capture-screenshots.mjs](../../scripts/capture-screenshots.mjs). `capture.json` records the app-source commit, version, platform, dimensions and capture time. The app's runtime source is unchanged by documentation maintenance; this record identifies the source used for the images, not a signed installer qualification.
