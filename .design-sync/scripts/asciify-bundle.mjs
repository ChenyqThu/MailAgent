// Post-build: escape every non-ASCII code unit in _ds_bundle.js to \uXXXX, then
// refresh _ds_sync.json's bundleSha12. Why: the synced UI has CJK in regex
// literals (e.g. /[一-鿿]/) and Chinese comments (bundle is not
// minified). Served as a classic <script src> without an HTTP/document charset,
// a browser decodes those multi-byte UTF-8 chars wrong -> the regex becomes a
// syntax error -> the IIFE throws -> window.<global> never populates. \uXXXX
// escapes are byte-for-byte ASCII and semantically identical in strings AND
// regex, so the bundle becomes charset-independent. Behavior is unchanged ->
// preview renderHashes stay valid; only the bundle bytes change, so only
// bundleSha12 is updated.
//
// Re-run after EVERY package-build (the converter re-emits raw UTF-8), before
// validate/upload: node .ds-sync/asciify-bundle.mjs
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const BUNDLE = 'ds-bundle/_ds_bundle.js';
const SYNC = 'ds-bundle/_ds_sync.json';
const NON_ASCII = new RegExp('[\\u0080-\\uFFFF]', 'g');

const raw = readFileSync(BUNDLE, 'utf8');
const ascii = raw.replace(NON_ASCII, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
writeFileSync(BUNDLE, ascii, 'latin1'); // pure-ASCII after escaping; latin1 = 1 byte/char, no re-encoding

const left = readFileSync(BUNDLE).filter((b) => b > 127).length;
const sha = createHash('sha256').update(readFileSync(BUNDLE)).digest('hex').slice(0, 12);

const sync = JSON.parse(readFileSync(SYNC, 'utf8'));
const prev = sync.bundleSha12;
sync.bundleSha12 = sha;
writeFileSync(SYNC, JSON.stringify(sync));

console.error(`asciify: escaped ${(ascii.length - raw.length)} char(s) of \\u expansion; non-ASCII bytes left: ${left}; bundleSha12 ${prev} -> ${sha}`);
if (left !== 0) { console.error('non-ASCII bytes remain — investigate'); process.exit(1); }
