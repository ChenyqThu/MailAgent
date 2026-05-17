// REVIEW-LOG H-08 / DESIGN.md §14 + §16 + §17. Sprint 0 = skeleton with one
// demo rule + fixture. Sprint 1 expands to the full 10 non-negotiables (§14
// items 1-8 + §16 i18n item 9 + §17 theme item 10) and CI gates on `pnpm lint`.

const noRawHex = require('./rules/no-raw-hex.cjs')

module.exports = {
  rules: {
    'no-raw-hex': noRawHex
  }
}
