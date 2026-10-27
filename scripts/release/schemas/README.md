# CycloneDX validation schemas

Vendored without modification from [CycloneDX/specification](https://github.com/CycloneDX/specification/tree/ad83dae28b236b8760286399da4daba77592de86/schema), commit `ad83dae28b236b8760286399da4daba77592de86`. These Apache-2.0 files permit offline validation; no schema or license service is contacted by a release build. The upstream LICENSE is included. The JSF schema retains its own upstream attribution in `$comment`.

| File | SHA-256 |
| --- | --- |
| bom-1.6.schema.json | 18f57f7482593bad9f21b4feed09084640cbeff419d62ad5090c5ceccca5b37d |
| spdx.schema.json | 4b345e2329f209f34e960ae2a8e7cb46a166907e6a45e94978565925dc47b359 |
| jsf-0.82.schema.json | 8bae002c25e723db7ee1f26afde680ae1a2b1a8f6b4b4b0fd65dc3becb090aae |

The generator inventories packaged NPM manifests and binary payloads, with the actual Electron/Chromium notices. Native/runtime components may contain further vendored dependencies, so the BOM explicitly declares incomplete composition. Schema validity and matching hashes do not constitute redistribution approval or exhaustive native dependency coverage.
