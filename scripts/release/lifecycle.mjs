import semver from 'semver'

/** Shared by staging and promotion: an inventory match alone says nothing
 * about whether the installed lifecycle completed or enforced its sandbox. */
export function validateLifecycleReports(manifest, reports) {
  const formats = manifest.platform === 'darwin' ? ['dmg', 'zip'] : manifest.platform === 'win32' ? ['exe'] : ['deb', 'AppImage', 'rpm']
  const covered = new Set()
  for (const report of reports) {
    if (!report || JSON.stringify(report.inventory) !== JSON.stringify(manifest.inventory)) throw new Error('Installer lifecycle report does not match the release inventory.')
    for (const field of ['version', 'commit', 'buildId', 'mode', 'platform', 'arch']) if (report[field] !== manifest[field]) throw new Error('Installer lifecycle report does not match the release candidate.')
    if (JSON.stringify(report.files) !== JSON.stringify(manifest.files)) throw new Error('Installer lifecycle tests did not validate these exact artifacts.')
    if (!semver.valid(report.previousVersion) || !semver.gt(manifest.version, report.previousVersion)) throw new Error('Missing lifecycle upgrade from an older version.')
    for (const test of report.tests || []) {
      if (test.status !== 'passed' || !formats.includes(test.format) || covered.has(test.format)) throw new Error('Invalid, duplicate or failed installer lifecycle test.')
      const sandbox = manifest.platform !== 'linux' ? ['platform-default'] : test.format === 'rpm' ? ['enforced', 'disabled-disposable-container'] : ['enforced']
      if (!sandbox.includes(test.chromiumSandbox)) throw new Error('Missing or invalid installed Chromium sandbox evidence.')
      covered.add(test.format)
    }
  }
  if (formats.some(format => !covered.has(format))) throw new Error('Installer lifecycle coverage is incomplete.')
}
