// One-off: measure what dominates _ds_bundle.js so scope decisions use real
// numbers. Reuses the converter's own resolution (reactShim + tsconfig paths)
// so the graph matches the real build, then sums bytesInOutput per top-level
// npm package and per component-source subdir.
import { build } from 'esbuild';
import { reactShim, tsconfigPathsPlugin } from '../../.ds-sync/lib/bundle.mjs';
import { readFileSync } from 'node:fs';

const ENTRY = './ds-bundle/.pkg-entry.mjs';
const NM = './frontend/node_modules';
const TSCONFIG = './.design-sync/tsconfig.dssync.json';

const pathsPlugin = tsconfigPathsPlugin(TSCONFIG);
const plugins = [reactShim];
if (pathsPlugin) plugins.unshift(pathsPlugin);

const r = await build({
  entryPoints: [ENTRY],
  bundle: true,
  platform: 'browser',
  target: 'es2020',
  format: 'iife',
  globalName: 'MailAgent',
  nodePaths: [NM],
  plugins,
  metafile: true,
  write: false,
  outfile: './ds-bundle/_analyze.js',
  minify: false,
  loader: { '.svg': 'dataurl', '.png': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.url': '"https://x.invalid/"', 'import.meta.env': '{"MODE":"development","DEV":true,"PROD":false,"SSR":false,"BASE_URL":"/"}' },
});

const out = Object.values(r.metafile.outputs).find((o) => o.entryPoint);
const inputs = out.inputs; // { path: { bytesInOutput } }

const pkgBytes = {};   // node_modules package → bytes
const dirBytes = {};   // component subdir → bytes (own source only)
let total = 0;
for (const [p, info] of Object.entries(inputs)) {
  const b = info.bytesInOutput || 0;
  total += b;
  const m = p.match(/node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)\//);
  if (m) {
    const pkg = m[2];
    pkgBytes[pkg] = (pkgBytes[pkg] || 0) + b;
  } else {
    const dm = p.match(/shared\/components\/([^/]+)\//);
    const dir = dm ? dm[1] : '(root)';
    dirBytes[dir] = (dirBytes[dir] || 0) + b;
  }
}

const fmt = (b) => (b / 1024).toFixed(0) + ' KB';
const top = (obj, n) => Object.entries(obj).sort((a, b) => b[1] - a[1]).slice(0, n);

console.log(`TOTAL bytesInOutput: ${fmt(total)} (${(total/1024/1024).toFixed(1)} MB)\n`);
console.log('=== TOP npm packages (bundled bytes) ===');
for (const [pkg, b] of top(pkgBytes, 30)) console.log(`  ${fmt(b).padStart(9)}  ${pkg}`);
console.log('\n=== component subdir (own source bytes) ===');
for (const [dir, b] of top(dirBytes, 25)) console.log(`  ${fmt(b).padStart(9)}  ${dir}`);

// Heavy-dep grouping for the scope decision
const groups = {
  'assistant-ui': /@assistant-ui/,
  'lexical': /(^|\/)(@?lexical|@lexical)/,
  'tiptap+prosemirror': /(@tiptap|prosemirror)/,
  'gsap': /gsap/,
  'rrule': /rrule/,
  'radix': /@radix-ui/,
};
console.log('\n=== heavy-dep groups ===');
for (const [name, re] of Object.entries(groups)) {
  let sum = 0;
  for (const [pkg, b] of Object.entries(pkgBytes)) if (re.test(pkg)) sum += b;
  console.log(`  ${fmt(sum).padStart(9)}  ${name}`);
}
