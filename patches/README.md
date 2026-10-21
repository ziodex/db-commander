# Dependency fixes

pnpm applies these version-specific patches during installation. Keep this directory in Docker build inputs and fixture fingerprints. Review the patches when upgrading either dependency; remove a patch once an upstream release provides the same fix.

- `zod@4.6.7.patch` changes two explanatory comments so Rollup does not interpret their prose as misplaced pure annotations. Actual optimization annotations and runtime code are unchanged.
- `app-builder-lib@26.15.3.patch` skips optional native packages whose names identify another OS, CPU or Linux C library. pnpm's dependency listing includes these locked packages even when they are correctly absent from disk. Missing compatible or unrecognized packages retain the existing diagnostics. Release packaging remains native to the host, and the after-pack audits still require the target's DuckDB and credential binaries.

The packager's duplicate-reference summaries and messages about deliberately skipped code signing are informational. Unsigned development builds continue to report that signing was skipped.
