const { builderConfig } = require('./scripts/release/config.cjs')

// Development packaging is deliberately unsigned, even on a signing machine.
// Signed distribution must go through build-release.mjs and its preflight.
module.exports = builderConfig(process.env)
