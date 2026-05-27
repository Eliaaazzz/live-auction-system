#!/usr/bin/env node
// Extract design tokens from apps/web/src/styles.css :root into a
// machine-readable artifact. Mirrors PDGGK's #56 ratify (2026-05-27):
// "B's token CSS should become generated from A and CI diff-gated."
//
// Usage:
//   node scripts/extract-design-tokens.mjs           # writes both artifacts
//   node scripts/extract-design-tokens.mjs --check    # exits non-zero if artifacts drift
//
// Outputs:
//   docs/design-tokens.json — sorted JSON, one entry per CSS custom prop
//   docs/design-tokens.generated.css — re-emittable :root block for B references
//
// CI: scripts/extract-design-tokens.mjs --check in the web job catches
// any uncommitted drift between styles.css :root and the artifacts.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const STYLES_PATH = resolve(ROOT, 'src/styles.css');
const JSON_OUT   = resolve(ROOT, 'docs/design-tokens.json');
const CSS_OUT    = resolve(ROOT, 'docs/design-tokens.generated.css');

const CHECK_MODE = process.argv.includes('--check');

/**
 * Parse `:root { ... }` block(s) from CSS and return an ordered array of
 * { name, value, comment, group } where group is the trailing /* */
//   /* ─── Continuous animations ─── */
//   group on the previous comment line (best-effort).
function parseTokens(css) {
  const out = [];
  // Find every `:root { ... }` block (handles single-line and multi-line)
  const blockRe = /:root\s*\{([^}]+)\}/gs;
  let m;
  let currentGroup = null;

  while ((m = blockRe.exec(css)) !== null) {
    const body = m[1];
    // Walk body line-by-line so we can track group comments
    for (const rawLine of body.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;

      // Group comment: e.g. `/* A · Douyin-Native palette */`
      // Tracked so the JSON output groups visually related tokens.
      const groupMatch = line.match(/^\/\*\s*(.+?)\s*\*\/$/);
      if (groupMatch) {
        currentGroup = groupMatch[1];
        continue;
      }

      // Token line: `--foo: value;   /* inline-comment */`
      const tokenMatch = line.match(/^--([\w-]+)\s*:\s*([^;]+?)\s*;(?:\s*\/\*\s*(.+?)\s*\*\/)?\s*$/);
      if (tokenMatch) {
        out.push({
          name:    `--${tokenMatch[1]}`,
          value:   tokenMatch[2].trim(),
          comment: tokenMatch[3] || null,
          group:   currentGroup,
        });
      }
    }
  }
  return out;
}

function renderJson(tokens) {
  // Stable JSON: sorted by (group, name). Sorting locks the artifact so
  // re-ordering tokens in styles.css doesn't trigger a no-op diff.
  const sorted = [...tokens].sort((a, b) => {
    const ga = a.group || '';
    const gb = b.group || '';
    if (ga !== gb) return ga.localeCompare(gb);
    return a.name.localeCompare(b.name);
  });
  return JSON.stringify({
    source:    'apps/web/src/styles.css :root',
    generated: 'apps/web/scripts/extract-design-tokens.mjs',
    notice:    'AUTO-GENERATED. Do not edit by hand. Run `node scripts/extract-design-tokens.mjs` to regenerate.',
    count:     sorted.length,
    tokens:    sorted,
  }, null, 2) + '\n';
}

function renderCss(tokens) {
  // Emit a clean `:root { --foo: value; }` block grouped by section.
  // Consumers (B's design reference, future Storybook, etc.) can
  // `@import` this file as the single source of truth.
  const lines = [
    '/* AUTO-GENERATED from apps/web/src/styles.css :root',
    ' * Source of truth: A · Lumen Auction design system',
    ' * Regenerate: node apps/web/scripts/extract-design-tokens.mjs',
    ' * CI guards drift; do not edit by hand.',
    ' */',
    '',
    ':root {',
  ];
  let lastGroup = null;
  // Preserve source order (don't sort) so the CSS reads top-to-bottom
  // matching styles.css. JSON sorts for stable diffs; CSS keeps source.
  for (const tok of tokens) {
    if (tok.group !== lastGroup) {
      if (lastGroup !== null) lines.push('');
      lines.push(`  /* ${tok.group} */`);
      lastGroup = tok.group;
    }
    const decl = `  ${tok.name}: ${tok.value};`;
    lines.push(tok.comment ? `${decl.padEnd(40)} /* ${tok.comment} */` : decl);
  }
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

async function main() {
  const css = await readFile(STYLES_PATH, 'utf8');
  const tokens = parseTokens(css);
  if (tokens.length === 0) {
    console.error('extract-design-tokens: no tokens found — :root block missing or unparseable?');
    process.exit(1);
  }

  const newJson = renderJson(tokens);
  const newCss  = renderCss(tokens);

  if (CHECK_MODE) {
    // Drift gate — compare to committed artifacts. Fail if either differs.
    const errors = [];
    for (const [path, fresh] of [[JSON_OUT, newJson], [CSS_OUT, newCss]]) {
      if (!existsSync(path)) {
        errors.push(`missing artifact: ${path}`);
        continue;
      }
      const onDisk = await readFile(path, 'utf8');
      if (onDisk !== fresh) {
        errors.push(`drift in ${path} — run \`node scripts/extract-design-tokens.mjs\` and commit`);
      }
    }
    if (errors.length) {
      errors.forEach((e) => console.error('  · ' + e));
      process.exit(1);
    }
    console.log(`✓ design-tokens artifacts in sync (${tokens.length} tokens)`);
    return;
  }

  await writeFile(JSON_OUT, newJson);
  await writeFile(CSS_OUT,  newCss);
  console.log(`✓ wrote ${tokens.length} tokens to docs/design-tokens.{json,generated.css}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
