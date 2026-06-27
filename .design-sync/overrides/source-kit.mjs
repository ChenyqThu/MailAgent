// forked from design-sync lib/source-kit.mjs — exclude pure re-export/glue files
// (.design-sync/bundle-exclude.json) from the synth entry. MailAgent is an
// Electron app synth-bundled as a DS; `agents/primitives.tsx` is an assistant-ui
// primitives barrel (stubbed) whose `Switch` export collides with the real
// `ui/switch.tsx` Switch — an ESM ambiguous star re-export drops Switch from
// window.MailAgent. Excluding the barrel resolves the collision (and trims dead
// stubbed glue). Only the srcFiles filter is added; discovery/enrichment is
// byte-identical to upstream.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { Project, Node, ts } from 'ts-morph';
import { leadingJsdoc, readText, slash, walk } from '../../.ds-sync/lib/common.mjs';
import { resolveDistEntry } from '../../.ds-sync/lib/bundle.mjs';
import { exportedNames, isComponentName } from '../../.ds-sync/lib/dts.mjs';

const NON_IMPL_RX = /\.(stories|test|spec)\./;
const SRC_IMPL_RX = /\.(tsx|jsx)$/;
const GENERIC_DIR = new Set(['components', 'component', 'src', 'lib', 'ui', 'packages', 'react']);
const slug = (s) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'general';

function loadExcludeSet() {
  const p = resolve('.design-sync', 'bundle-exclude.json');
  if (!existsSync(p)) return new Set();
  try { return new Set((JSON.parse(readFileSync(p, 'utf8')).excludeRelPaths ?? []).map((s) => slash(s))); }
  catch (e) { console.error(`[BUNDLE_EXCLUDE] failed to read ${p}: ${e.message}`); return new Set(); }
}

function deriveComponentsFromSrc(srcFiles) {
  const project = new Project({
    skipAddingFilesFromTsConfig: true,
    compilerOptions: { jsx: ts.JsxEmit.Preserve, allowJs: true, skipLibCheck: true },
  });
  const seen = new Set();
  for (const p of srcFiles) {
    if (NON_IMPL_RX.test(p) || !SRC_IMPL_RX.test(p)) continue;
    const sf = project.addSourceFileAtPathIfExists(p);
    if (!sf) continue;
    for (const [name, decls] of sf.getExportedDeclarations()) {
      const real = name === 'default'
        ? decls.map((d) => d.getName?.()).find((n) => n && n !== 'default')
        : name;
      if (!real || !/^[A-Z][A-Za-z0-9]*$/.test(real)) continue;
      if (decls.some((d) => Node.isVariableDeclaration(d) || Node.isFunctionDeclaration(d) || Node.isClassDeclaration(d))) {
        seen.add(real);
      }
    }
  }
  return [...seen].sort().map((name) => ({ name, group: 'general' }));
}

export async function resolvePackage(ctx) {
  const { PKG_DIR, pkgJson, ENTRY_OVERRIDE, PKG, OUT, cfg } = ctx;
  const srcMap = cfg.componentSrcMap ?? {};

  const srcRoot = [cfg.srcDir, 'src', 'lib', 'components']
    .map((d) => d && resolve(PKG_DIR, d))
    .find((d) => d && existsSync(d));
  let srcFiles = srcRoot ? walk(srcRoot, (n) => /\.(tsx|jsx|mdx?)$/.test(n)) : [];

  const excludeSet = loadExcludeSet();
  if (srcRoot && excludeSet.size) {
    const before = srcFiles.length;
    srcFiles = srcFiles.filter((p) => !excludeSet.has(slash(relative(srcRoot, p))));
    console.error(`[BUNDLE_EXCLUDE] dropped ${before - srcFiles.length}/${excludeSet.size} file(s) from synth bundle (kept ${srcFiles.length})`);
  }

  let entry = resolveDistEntry({ pkgDir: PKG_DIR, pkgJson, override: ENTRY_OVERRIDE, pkgName: PKG, soft: true });
  let synthEntry = false;
  if (!entry) {
    if (!srcRoot) {
      console.error(`[NO_DIST] ${PKG} has no built entry and no src/ to synthesize from — run its build.`);
      process.exit(1);
    }
    const comps = srcFiles.filter((p) => SRC_IMPL_RX.test(p) && !NON_IMPL_RX.test(p));
    entry = join(OUT, '.pkg-entry.mjs');
    writeFileSync(entry, comps.map((p) => `export * from ${JSON.stringify(p)};`).join('\n') + '\n');
    synthEntry = true;
    console.error(`[NO_DIST] no built entry — synthesizing from ${comps.length} src files (run the package's build for best results)`);
  }

  const exported = exportedNames(PKG_DIR, pkgJson);
  const names = new Set([...exported].filter(isComponentName));
  for (const [k, v] of Object.entries(srcMap)) {
    if (v === null) { names.delete(k); continue; }
    if (!/^[A-Z][A-Za-z0-9]*$/.test(k)) {
      console.error(`[CONFIG] componentSrcMap: "${k}" is not a valid component name (PascalCase identifiers only)`);
      continue;
    }
    names.add(k);
  }
  let components = [...names].sort().map((name) => ({ name, group: 'general' }));
  if (synthEntry) {
    // FORK: synth mode derives the real component set from src files (the
    // package ships no exports/types — exportedNames is ~empty). A non-null
    // componentSrcMap entry injects an EXTRA root that lives OUTSIDE srcDir
    // (design-sync foundation cards), which would otherwise make names[]
    // non-empty and short-circuit the derive (losing all 170 real ones).
    // Union instead of either/or.
    const derived = deriveComponentsFromSrc(srcFiles).filter((c) => srcMap[c.name] !== null);
    const have = new Set(components.map((c) => c.name));
    for (const c of derived) if (!have.has(c.name)) components.push(c);
    components.sort((a, b) => a.name.localeCompare(b.name));
  }
  if (!components.length) {
    if (cfg.cssEntry || existsSync(join(PKG_DIR, 'styles.css'))) {
      console.error('[ZERO_MATCH] no component exports — treating as tokens-only DS');
      return { shape: 'package', entry, components: [], tokensOnly: true };
    }
    console.error(`[ZERO_MATCH] no PascalCase exports in ${PKG} and no styles — nothing to sync`);
    process.exit(1);
  }

  if (srcRoot) {
    for (const c of components) {
      let hit = typeof srcMap[c.name] === 'string' ? slash(resolve(PKG_DIR, srcMap[c.name])) : null;
      if (!hit) {
        const kebab = c.name.replace(/([a-z0-9])([A-Z])/g, '$1-$2');
        const nameRx = new RegExp(
          `(?:^|/)(?:${c.name}/(?:index|${c.name})\\.(tsx|jsx)|(?:${c.name}|${kebab})\\.(tsx|jsx))$`,
          'i',
        );
        const hits = srcFiles
          .filter((p) => nameRx.test(p) && !NON_IMPL_RX.test(p))
          .sort(
            (a, b) =>
              (b.toLowerCase().includes(`/${c.name.toLowerCase()}/`) ? 1 : 0) -
              (a.toLowerCase().includes(`/${c.name.toLowerCase()}/`) ? 1 : 0),
          );
        const exportRx = new RegExp(`export\\s+(?:default\\s+)?(?:const|let|var|function|class)\\s+${c.name}\\b`);
        hit = hits.find((p) => exportRx.test(readText(p))) ?? hits[0];
      }
      if (!hit || !existsSync(hit)) continue;
      c.srcPath = hit;
      c.doc = leadingJsdoc(readText(hit), c.name) || undefined;
      c.group = slug(
        slash(relative(srcRoot, dirname(hit)))
          .split('/')
          .filter((s) => s && s.toLowerCase() !== c.name.toLowerCase() && !GENERIC_DIR.has(s.toLowerCase()))
          .at(-1)
        || (c.doc && /@category\s+(\S+)/.exec(c.doc)?.[1])
        || 'general',
      );
    }
  }

  console.error(
    `  package: ${components.length} components` +
      (srcRoot ? ` (${components.filter((c) => c.srcPath).length} src-matched)` : ' (no src/ — dist-only)'),
  );
  return { shape: 'package', entry, components, synthEntry, exported };
}
