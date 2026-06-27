// Decisive scope test: (1) classify component files by whether they transitively
// reach the BIG bloat stack (assistant-ui/lexical/tiptap/zod/ai-sdk/markdown),
// (2) actually build a light-only bundle and measure its real size.
import { build } from 'esbuild';
import { reactShim, tsconfigPathsPlugin } from '../../.ds-sync/lib/bundle.mjs';
import { writeFileSync, statSync } from 'node:fs';

const ENTRY = './ds-bundle/.pkg-entry.mjs';
const NM = './frontend/node_modules';
const TSCONFIG = './.design-sync/tsconfig.dssync.json';

// The real multi-hundred-KB bloat only (NOT @tanstack/parse5/gsap/radix — those stay).
const HEAVY = /(@assistant-ui|assistant-stream|lexical|@lexical|@tiptap|prosemirror|streamdown|micromark|(^|\/)marked(\/|$)|(^|\/)mdast|(^|\/)ai($|\/)|@ai-sdk|(^|\/)zod($|\/))/;

const pathsPlugin = tsconfigPathsPlugin(TSCONFIG);
const plugins = [reactShim];
if (pathsPlugin) plugins.unshift(pathsPlugin);
const opts = {
  bundle: true, platform: 'browser', target: 'es2020', format: 'iife',
  globalName: 'MailAgent', nodePaths: [NM], plugins, metafile: true,
  loader: { '.svg': 'dataurl', '.png': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.url': '"https://x.invalid/"', 'import.meta.env': '{"MODE":"development"}' },
};

const r = await build({ ...opts, entryPoints: [ENTRY], write: false, outfile: './ds-bundle/_analyze.js' });
const inputs = r.metafile.inputs;
const graph = new Map();
for (const [p, info] of Object.entries(inputs)) graph.set(p, (info.imports || []).map((i) => i.path));
function reachesHeavy(start) {
  const stack = [start]; const seen = new Set();
  while (stack.length) {
    const n = stack.pop(); if (seen.has(n)) continue; seen.add(n);
    if (n.includes('node_modules') && HEAVY.test(n)) return true;
    for (const dep of (graph.get(n) || [])) stack.push(dep);
  }
  return false;
}
const roots = [...graph.keys()].filter((p) => /shared\/components\/.*\.(tsx|jsx)$/.test(p) && !/\.(stories|test|spec)\./.test(p));
const lightFiles = [], heavy = [];
for (const f of roots) (reachesHeavy(f) ? heavy : lightFiles).push(f);
const bySub = (arr) => { const m = {}; for (const f of arr) { const d = f.replace(/.*shared\/components\//, ''); const k = d.includes('/') ? d.split('/')[0] : '(root)'; m[k] = (m[k] || 0) + 1; } return Object.entries(m).sort((a, b) => b[1] - a[1]); };
console.log(`component files: ${roots.length} | LIGHT ${lightFiles.length} | HEAVY ${heavy.length}`);
console.log('LIGHT by subdir:', JSON.stringify(Object.fromEntries(bySub(lightFiles))));
console.log('HEAVY by subdir:', JSON.stringify(Object.fromEntries(bySub(heavy))));

// Build a light-only bundle and measure.
const lightEntry = './ds-bundle/.light-entry.mjs';
writeFileSync(lightEntry, lightFiles.map((p) => `export * from ${JSON.stringify('../' + p)};`).join('\n') + '\n');
const lr = await build({ ...opts, entryPoints: [lightEntry], outfile: './ds-bundle/.light-bundle.js', write: true });
const kb = (statSync('./ds-bundle/.light-bundle.js').size / 1024).toFixed(0);
console.log(`\n>>> LIGHT-ONLY bundle: ${kb} KB (${(kb/1024).toFixed(1)} MB)  [5MB cap]`);
