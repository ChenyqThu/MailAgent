// Taint attribution: for every component that transitively reaches the heavy
// stack, find the shortest path and record the "bridge edge" = the repo file
// that directly imports the first heavy node_modules package. Tally bridges:
// if a few dominate, stubbing those edges frees most components.
import { build } from 'esbuild';
import { reactShim, tsconfigPathsPlugin } from '../../.ds-sync/lib/bundle.mjs';

const HEAVY = /(@assistant-ui|assistant-stream|lexical|@lexical|@tiptap|prosemirror|streamdown|micromark|(^|\/)marked(\/|$)|(^|\/)mdast|(^|\/)ai($|\/)|@ai-sdk|(^|\/)zod($|\/))/;
const isHeavy = (p) => p.includes('node_modules') && HEAVY.test(p);
const rel = (p) => p.replace(/.*shared\//, '@shared/').replace(/.*node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?/, 'npm:');

const pathsPlugin = tsconfigPathsPlugin('./.design-sync/tsconfig.dssync.json');
const plugins = [reactShim]; if (pathsPlugin) plugins.unshift(pathsPlugin);
const r = await build({
  entryPoints: ['./ds-bundle/.pkg-entry.mjs'], bundle: true, platform: 'browser', target: 'es2020',
  format: 'iife', globalName: 'MailAgent', nodePaths: ['./frontend/node_modules'], plugins,
  metafile: true, write: false, outfile: './ds-bundle/_analyze.js',
  loader: { '.svg': 'dataurl', '.png': 'dataurl', '.woff': 'dataurl', '.woff2': 'dataurl' },
  define: { 'process.env.NODE_ENV': '"development"', 'import.meta.url': '"https://x.invalid/"', 'import.meta.env': '{"MODE":"development"}' },
});
const inputs = r.metafile.inputs;
const graph = new Map();
for (const [p, info] of Object.entries(inputs)) graph.set(p, (info.imports || []).map((i) => i.path));

// BFS shortest path from root to nearest heavy node; return the bridge edge (repoFile -> heavyPkg)
function bridgeFor(root) {
  const q = [[root]]; const seen = new Set([root]);
  while (q.length) {
    const path = q.shift(); const n = path[path.length - 1];
    for (const dep of (graph.get(n) || [])) {
      if (isHeavy(dep)) return [n, dep]; // n is the bridge file (repo file importing heavy)
      if (!seen.has(dep)) { seen.add(dep); q.push([...path, dep]); }
    }
  }
  return null;
}
const roots = [...graph.keys()].filter((p) => /shared\/components\/.*\.(tsx|jsx)$/.test(p) && !/\.(stories|test|spec)\./.test(p));
const bridgeCount = {}; // bridgeFile -> #components freed if cut
const bridgeDep = {};
for (const root of roots) {
  const b = bridgeFor(root);
  if (!b) continue;
  const key = rel(b[0]);
  bridgeCount[key] = (bridgeCount[key] || 0) + 1;
  (bridgeDep[key] ||= new Set()).add(rel(b[1]));
}
console.log('=== bridge edges (repo file importing heavy dep) ranked by #components tainted ===');
for (const [f, n] of Object.entries(bridgeCount).sort((a, b) => b[1] - a[1]).slice(0, 25))
  console.log(`  ${String(n).padStart(3)}  ${f}  ->  ${[...bridgeDep[f]].slice(0,3).join(', ')}`);
