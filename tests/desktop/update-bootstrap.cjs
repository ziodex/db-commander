// Private Electron test entry. Production has no fixture hooks or feed overrides.
const { net, shell } = require('electron')
const control = globalThis.updateFixture = {
  release: { tag_name: 'v0.2.0', draft: false, prerelease: false },
  status: Number(process.env.DBCOMMANDER_UPDATE_TEST_STATUS || 200),
  offline: false, requests: [], opened: [], elapsed: 0, daily: undefined
}
const now = Date.now
Date.now = () => now() + control.elapsed
const schedule = global.setTimeout
global.setTimeout = Object.assign((callback, delay, ...args) => {
  if (delay === 24 * 60 * 60 * 1000) control.daily = callback
  return schedule(callback, delay, ...args)
}, schedule)
net.fetch = async (url, options) => {
  control.requests.push({ url, credentials: options.credentials, redirect: options.redirect })
  if (url !== 'https://api.github.com/repos/ziodex/db-commander/releases/latest') throw new Error('Unexpected network request')
  if (control.offline) throw new Error('Offline fixture')
  return new Response(JSON.stringify(control.release), { status: control.status, headers: { 'content-type': 'application/json' } })
}
shell.openExternal = async url => { control.opened.push(url) }
require(process.env.DBCOMMANDER_UPDATE_TEST_MAIN)
