#!/usr/bin/env node
/**
 * CREDITS.md, generated sections (PLAN_A10.md §3.1, docs/a10/ARCHITECTURE.md §9).
 *
 *   node scripts/a10/convert-credits.mjs     rewrite the Sounds table from
 *                                            scripts/a10/sounds-credits.json (written by
 *                                            scripts/a10/sounds.mjs); run it after the sounds
 *                                            change. The models and textures table is written
 *                                            by scripts/a10/convert-ac3d.mjs, which also calls
 *                                            this module.
 *
 * Each generated table sits between `<!-- BEGIN <id> … -->` and `<!-- END <id> -->`; the rest of
 * CREDITS.md is written by hand. Every row has the same columns and the same wording for the
 * same source, author and licence, whichever kind of file it credits.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Wording shared by every row whose file comes from the FlightGear A-10 package. */
export const FG_AUTHOR = 'FlightGear A-10 contributors';
export const FG_LICENCE = 'GPL-2.0 (package COPYING)';
const FG_COPY = 'third_party/flightgear-a10/';

const bt = (x) => '`' + x + '`';
const esc = (x) => String(x).replace(/\|/g, '\\|');

/** Markdown table: rows of { file, source, author, licence, changes }. */
export function creditsTable(rows, sourceHeading = 'Source') {
  return [
    `| File | ${sourceHeading} | Author | Licence | Changes |`,
    '|---|---|---|---|---|',
    ...rows.map(
      (c) =>
        `| ${bt(c.file)} | ${esc(c.source)} | ${esc(c.author)} | ${esc(c.licence)} | ${esc(c.changes)} |`,
    ),
  ].join('\n');
}

/** Replace the body of the generated block `id` in CREDITS.md text. */
export function replaceBlock(text, id, body) {
  const begin = new RegExp(`<!-- BEGIN ${id}\\b[^>]*-->`);
  const m = begin.exec(text);
  const endMark = `<!-- END ${id} -->`;
  const b = text.indexOf(endMark);
  if (!m || b < m.index)
    throw new Error(`CREDITS.md: markers of the generated block "${id}" missing`);
  const a = m.index + m[0].length;
  return text.slice(0, a) + '\n\n' + body + '\n\n' + text.slice(b);
}

/** One row per file of public/a10/sounds, from the audio module's sounds-credits.json. */
export function soundRows(repo) {
  const json = JSON.parse(readFileSync(join(repo, 'scripts/a10/sounds-credits.json'), 'utf8'));
  const rows = [];
  for (const [file, s] of Object.entries(json.files).sort(([a], [b]) => a.localeCompare(b))) {
    const what = `${s.title}: ${s.changes}`;
    if (s.original?.startsWith(FG_COPY)) {
      const rel = s.original.slice(FG_COPY.length);
      const abs = join(repo, s.original);
      if (existsSync(abs)) {
        const sha = createHash('sha256').update(readFileSync(abs)).digest('hex');
        if (s.originalSha256 && sha !== s.originalSha256)
          throw new Error(`${s.original}: SHA-256 ${sha} differs from sounds-credits.json`);
      }
      rows.push({
        file: `public/a10/sounds/${file}`,
        source: `${bt(rel)} (SHA-256 ${bt(s.originalSha256)})`,
        author: FG_AUTHOR,
        licence: FG_LICENCE,
        changes: what,
      });
    } else {
      // made for this project (the voice warning); the licence cell names the tools' licences
      const gen = /^Generated for this project with /i;
      rows.push({
        file: `public/a10/sounds/${file}`,
        source: s.source.replace('scripts/a10/sounds.mjs', bt('scripts/a10/sounds.mjs')),
        author: gen.test(s.author)
          ? s.author.replace(gen, 'this project, generated with ')
          : `this project (${s.author})`,
        licence: s.licence.replace(/ \(this project\)/, ''),
        changes: what,
      });
    }
  }
  return rows;
}

/** Rewrite the Sounds block of CREDITS.md. Returns the number of rows. */
export function writeSoundCredits(repo) {
  const path = join(repo, 'CREDITS.md');
  const rows = soundRows(repo);
  const text = readFileSync(path, 'utf8');
  writeFileSync(path, replaceBlock(text, 'sounds', creditsTable(rows, 'Source (package path)')));
  return rows.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const repo = resolve(import.meta.dirname, '../..');
  const n = writeSoundCredits(repo);
  console.log(`CREDITS.md: ${n} sound files`);
}
