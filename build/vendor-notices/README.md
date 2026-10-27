# Native framework notice sources

These are unmodified upstream license files for the Mantle and ReactiveObjC
frameworks shipped in Electron 44.7.0's Mac bundles. Mantle's file also retains
its notice for code from Proton. The complete files are copied to the installed
app's `Resources/licenses/` and included in the notice sidecar.

[`provenance.json`](provenance.json) records the source URLs, exact dependency
revisions from [Electron's DEPS](https://github.com/electron/electron/blob/v44.7.0/DEPS),
the DEPS digest, and each license file's size/SHA-256. The version strings in
framework Info.plists include placeholders and are not used to select upstream
source revisions. Squirrel and its Sparkle/bsdiff notices are already in the
pinned Electron distribution's retained `LICENSES.chromium.html`.

Packaging verifies the vendored source hashes, exact installed notice bytes and
expected Electron version without requesting the network. When upgrading
Electron, review its actual new dependency pins and the matching upstream
notices before updating this mapping. Do not copy a current branch's license
and assume it matches the shipped revision. This mapping does not establish
complete native/vendor composition or redistribution sign-off.

## Known Rust dependencies in the credential binding

`native-dependency-provenance.json` and the four target-specific
`keyring-*-2.1.1-THIRD-PARTY-NOTICES.txt` files retain complete license texts for
crates identified by versioned source paths in the exact registry-signed native
packages: six on each Mac architecture, 39 on Linux x64 GNU and ten on Windows
x64 MSVC (49 distinct crate versions). Registry signature and source/build
provenance verification passed, and the three additional package integrities
match the project lockfile. Static inspection executes no native code and does
not qualify those platforms' application behavior. The versioned crates.io archives were
checked against registry checksums. Each archive/license hash and source is
recorded. The `napi` and `napi-sys` crate archives omit their license files, so
their complete upstream files, including the GitHub notice, come from the
precise commits in each archive's `.cargo_vcs_info.json`. Additional `UNLICENSE`
texts are retained, as are both positively identified AES versions on Linux.

Packaging checks the native package version, original binary hash and the
complete notice file hash before copying the notice outside the ASAR. The
afterPack audit requires both the notice and the reviewed native binary.
Review each target's mapping whenever its package or binary changes. The
mapping must not imply a complete Cargo feature/dependency graph. In particular,
Rust source paths do not establish the composition of statically linked C
libraries. The complete native/vendor composition and redistribution review
remain open.

## Known vendored C dependency in the Linux credential binding

The exact pinned Linux x64 GNU binary retains `libdbus 1.14.4` and vendored C
implementation paths, with no external libdbus in its ELF dependency list. The
verified keyring source enables its vendored DBus feature. This identifies a
statically included C dependency by binary/source evidence; it is not inferred
from a similarly named Rust crate.

The Linux notice file now also retains the complete upstream `COPYING`,
`AUTHORS`, and original leading notice headers from 47 reference C build files
and 71 library headers. Their source bytes and COPYING match the official
[dbus 1.14.4 archive](https://dbus.freedesktop.org/releases/dbus/dbus-1.14.4.tar.xz).
The archive's size/SHA-256 and each retained text/header digest are recorded in
`nativeLibraries` in the provenance mapping. Upstream whitespace is deliberately
preserved, including trailing spaces, so the copied notice hashes stay exact.
The existing binary/version/notice guards bind these texts to the inspected
Linux artifact and generated installed inventory.

The checksum-verified `libdbus-sys 0.2.7` archive is a reference source carrier,
not proof of the Rust wrapper version resolved by the upstream native build.
Full Cargo resolution/build features remain incomplete. The complete upstream
COPYING retains its alternative terms and per-file qualifications; this mapping
does not select a license option or constitute redistribution approval. Other
platforms' notice bytes are unchanged.


## DuckDB library and Node binding header notices

`duckdb-dependency-provenance.json` binds two additional notice resources to
both native binaries in each of the four supported release targets. All four
`@duckdb/node-bindings-*` 1.5.6-r.1 packages pass registry signature/provenance
verification and match this project's lockfile integrities. Their verified
binding source revision is `289ed744f72010122b4eb35f7abb8bb2d376f4ba`.
Its fetch scripts select the official DuckDB 1.5.6 platform archives; each
library matches those archive bytes, whose release asset digests were checked.
The same universal Mac library appears in both Mac architecture packages.
Foreign native code was inspected, never executed.

`duckdb-1.5.6-THIRD-PARTY-NOTICES.txt` retains 32 complete standalone notice
files from [DuckDB revision 069cc9f9b5be802405797faecc284961b07c70ef](https://github.com/duckdb/duckdb/tree/069cc9f9b5be802405797faecc284961b07c70ef),
matching the version/source ID reported by the actual Mac library. This
includes ICU's complete multi-part license, RE2's AUTHORS and tdigest's
NOTICES as well as the third-party LICENSE files. Per-file paths, sizes,
hashes and source URLs are retained in the mapping, alongside source and
binary archive receipts. These texts form a conservative source-notice
superset. They do not imply that every named library is compiled into every
target, or that embedded per-file notices and the complete feature/vendor
composition have been reviewed.

`node-addon-api-8.8.0-LICENSE.md` retains the complete license of the header
dependency pinned by the verified binding source's lockfile and build rules.
Its registry signature/provenance and integrity check passed independently.
The source lockfile, source revision and exact notice digest are recorded.
This notice is bound to `duckdb.node`; the DuckDB source notice is separately
bound to the actual shared library. Changes to either binary, native package
version or notice text require renewed review before packaging.

Both resources are copied outside ASAR and included in the installed notice
sidecar, with the existing afterPack and inventory hash checks. Full compiled
vendor composition, license-choice review and redistribution approval remain
open under B16. Retaining upstream notices does not close that release gate.


## Identified software in the release inventory

Schema-4 and schema-5 release inventories use these binary/source mappings to expose known
native constituents as software components, with source archive digests,
package URLs and notice references. They link each identified component to its
actual native file and owning npm instance. Target totals currently are eight
on either Mac architecture, 42 on Linux x64 and 12 on Windows x64. The Linux
count includes positively identified libdbus, with no inferred libdbus-sys
wrapper version. Unreviewed native files still appear as files with hashes;
unknown versions and relationships are not invented.

These flat links express identified constituents of the reviewed binary, not a
complete Cargo/C++ transitive graph. In particular, the DuckDB source-notice
superset does not imply that every source vendor is linked. The BOM explicitly
retains incomplete composition for the application, native files and known
constituents. Signed payload hashes remain separate from reviewed unsigned
source hashes; the existing source audit and actual signing verification
precede inventory creation. Native execution and redistribution approval
remain separate release gates.
