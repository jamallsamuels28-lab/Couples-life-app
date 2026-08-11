#!/usr/bin/env node
// ============================================================
// Build the exercise library seed from wger's open database
// ============================================================
//
// Why wger and not ExRx: ExRx.net is copyrighted commercial content and
// returns 403 to automated requests. Its taxonomy — browse by body part, then
// narrow by equipment — is a structure, and structures are not copyrightable,
// so that is what was borrowed. Its writing was not.
//
// wger publishes its exercise database under open licences (CC-BY-SA 4,
// CC-BY 4, CC0, ODbL). Each row carries its own licence and author into the
// database so attribution survives with the data.
//
// No API key. Usage:
//   node scripts/build-exercise-seed.mjs
//
// Flags:
//   --limit N   stop after N exercises (for a quick check)
//   --out PATH  where to write the migration
// ============================================================

import { writeFile } from 'node:fs/promises';
import { argv, exit } from 'node:process';

const API = 'https://wger.de/api/v2/exerciseinfo/';
const ENGLISH = 2;
const PAGE_SIZE = 100;

// Licences we are willing to redistribute. Anything else is skipped rather
// than imported and quietly relicensed.
const ALLOWED_LICENCES = new Set(['CC-BY-SA 4', 'CC-BY-SA 3', 'CC-BY 4', 'CC0', 'ODbL']);

const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const LIMIT = Number(flag('--limit', '0')) || Infinity;
const OUT = flag('--out', 'supabase/migrations/20250101000014_seed_exercise_library.sql');
// The Supabase SQL editor is a browser textarea. A single 390 kB insert gets
// truncated on paste, and a cut inside a description leaves an unterminated
// string literal — after which the next ordinary word is read as a table name
// ("relation \"the\" does not exist"). Split output into parts small enough
// to paste whole. 0 disables splitting.
const CHUNK = Number(flag('--chunk', '120'));

/** wger's category names, mapped to the movement patterns §4.3 already uses. */
const CATEGORY_TO_PATTERN = {
  Chest: 'push_h',
  Shoulders: 'push_v',
  Back: 'pull_h',
  Legs: 'squat',
  Arms: 'isolation',
  Calves: 'isolation',
  Abs: 'isolation',
  Cardio: null,
};

const LOWER_BODY_CATEGORIES = new Set(['Legs', 'Calves']);

/**
 * Refines the pattern from the exercise name.
 *
 * The category alone is too coarse and gets it actively wrong: wger files
 * deadlifts under Legs, so the category map calls them a squat. Pattern is not
 * cosmetic — §4.3 picks the load increment from it and §4.4 totals volume by
 * it — so a hinge counted as a squat misreports both. First match wins, so the
 * more specific tests come first.
 */
const PATTERN_HINTS = [
  [/\b(deadlift|rdl|romanian|good.?morning|hip.?thrust|glute.?bridge|swing|back extension|hyperextension|pull.?through)\b/i, 'hinge'],
  [/\b(squat|lunge|leg press|step.?up|split squat|hack|sissy|pistol)\b/i, 'squat'],
  [/\b(overhead press|shoulder press|military|push press|handstand|arnold press|landmine press)\b/i, 'push_v'],
  [/\b(bench|chest press|push.?up|press.?up|dip|fly|flye|pec deck)\b/i, 'push_h'],
  [/\b(pull.?up|chin.?up|pulldown|pull.?down|lat pull)\b/i, 'pull_v'],
  [/\b(row|face pull|rear delt)\b/i, 'pull_h'],
  [/\b(carry|farmer|suitcase|waiter)\b/i, 'carry'],
];

/** Names that mean the movement is trained one side at a time (§4.1). */
const UNILATERAL_HINTS =
  /\b(single.?(arm|leg|sided)|one.?(arm|leg)|unilateral|bulgarian|split squat|lunge|step.?up|pistol|suitcase)\b/i;

function inferPattern(name, category) {
  for (const [test, pattern] of PATTERN_HINTS) {
    if (test.test(name)) return pattern;
  }
  return CATEGORY_TO_PATTERN[category] ?? null;
}

/** Strips wger's HTML descriptions to plain text. */
function toPlainText(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Title-cases a name that arrives shouting or inconsistently cased. */
function tidyName(name) {
  const trimmed = String(name || '').trim().replace(/\s+/g, ' ');
  if (!trimmed) return '';
  // Leave sensible mixed case alone; only fix ALL CAPS and all-lowercase.
  if (trimmed === trimmed.toUpperCase() || trimmed === trimmed.toLowerCase()) {
    return trimmed.charAt(0).toUpperCase() + trimmed.slice(1).toLowerCase();
  }
  return trimmed;
}

const sqlString = (v) =>
  v === null || v === undefined || v === '' ? 'null' : `'${String(v).replace(/'/g, "''")}'`;

const sqlArray = (values) => {
  const items = (values || []).filter(Boolean).map(v => `"${String(v).replace(/(["\\])/g, '\\$1')}"`);
  return items.length ? `'{${items.join(',')}}'` : `'{}'`;
};

async function fetchAll() {
  const rows = [];
  let url = `${API}?limit=${PAGE_SIZE}&language=${ENGLISH}&format=json`;
  let page = 0;

  while (url && rows.length < LIMIT) {
    const response = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`wger returned HTTP ${response.status}`);
    const body = await response.json();

    rows.push(...(body.results || []));
    url = body.next;
    page += 1;
    process.stdout.write(`\r  fetched page ${page} (${rows.length} raw entries)…`);
  }
  process.stdout.write('\n');
  return rows.slice(0, LIMIT === Infinity ? rows.length : LIMIT);
}

function normalise(entry) {
  const translation = (entry.translations || []).find(t => t.language === ENGLISH && t.name);
  const name = tidyName(translation?.name);

  // wger is community-contributed and quality is uneven. An entry with no
  // English name, no category or no muscle mapping cannot be browsed by body
  // part, which is the entire point of the library — so it is dropped rather
  // than imported as a mystery row.
  if (!name || name.length < 2 || name.length > 120) return { skip: 'no usable name' };
  if (!entry.category?.name) return { skip: 'no category' };

  const primary = (entry.muscles || []).map(m => m.name_en || m.name).filter(Boolean);
  const secondary = (entry.muscles_secondary || []).map(m => m.name_en || m.name).filter(Boolean);
  if (primary.length === 0) return { skip: 'no primary muscle' };

  const licence = entry.license?.short_name || translation?.license?.short_name;
  if (licence && !ALLOWED_LICENCES.has(licence)) return { skip: `licence ${licence}` };

  const equipment = (entry.equipment || [])
    .map(e => e.name)
    .filter(Boolean)
    // "none (bodyweight exercise)" reads badly in a filter chip.
    .map(e => (/^none/i.test(e) ? 'Bodyweight' : e));

  const category = entry.category.name;
  const description = toPlainText(translation?.description);

  return {
    name,
    category,
    pattern: inferPattern(name, category),
    // §4.1: a unilateral set must stay out of bilateral PR comparisons, or a
    // rehab block reads as a regression across every metric. wger does not
    // record this, so it is inferred from the name — conservatively, since a
    // false positive quietly removes a lift from its own PR history.
    unilateral: UNILATERAL_HINTS.test(name),
    lowerBody: LOWER_BODY_CATEGORIES.has(category),
    // wger has no compound/isolation flag. Treating a single-muscle exercise
    // as isolation is a heuristic, not a fact — it only affects the size of
    // the suggested load increment (§4.3), never a recorded number.
    compound: primary.length + secondary.length > 2,
    primary,
    secondary,
    equipment,
    description: description.length > 4000 ? `${description.slice(0, 3997)}...` : description,
    imageUrl: (entry.images || []).find(i => i.is_main)?.image || (entry.images || [])[0]?.image || null,
    videoUrl: (entry.videos || [])[0]?.video || null,
    license: licence || null,
    licenseAuthor: entry.license_author || translation?.license_author || null,
    sourceId: entry.uuid || String(entry.id),
  };
}

async function main() {
  console.log('Fetching the wger exercise database (no key required)…');
  const raw = await fetchAll();

  const kept = [];
  const skipped = new Map();
  const seenNames = new Set();

  for (const entry of raw) {
    const result = normalise(entry);
    if (result.skip) {
      skipped.set(result.skip, (skipped.get(result.skip) || 0) + 1);
      continue;
    }
    // The existing table has a unique constraint on name.
    const key = result.name.toLowerCase();
    if (seenNames.has(key)) {
      skipped.set('duplicate name', (skipped.get('duplicate name') || 0) + 1);
      continue;
    }
    seenNames.add(key);
    kept.push(result);
  }

  if (kept.length === 0) {
    console.error('Nothing usable came back. Not writing a migration.');
    exit(1);
  }

  const byCategory = kept.reduce((acc, e) => {
    acc[e.category] = (acc[e.category] || 0) + 1;
    return acc;
  }, {});

  const withImage = kept.filter(e => e.imageUrl).length;
  const withVideo = kept.filter(e => e.videoUrl).length;
  const withDescription = kept.filter(e => e.description).length;
  const licences = [...new Set(kept.map(e => e.license).filter(Boolean))];

  const renderRow = (e) => '  ('
    + [
      sqlString(e.name),
      sqlString(e.pattern),
      e.unilateral ? 'true' : 'false',
      e.lowerBody ? 'true' : 'false',
      e.compound ? 'true' : 'false',
      sqlString(e.category),
      sqlArray(e.primary),
      sqlArray(e.secondary),
      sqlArray(e.equipment),
      sqlString(e.description),
      sqlString(e.imageUrl),
      sqlString(e.videoUrl),
      `'wger'`,
      sqlString(e.sourceId),
      sqlString(e.license),
      sqlString(e.licenseAuthor),
    ].join(', ')
    + ')';

  const chunks = [];
  const size = CHUNK > 0 ? CHUNK : kept.length;
  for (let i = 0; i < kept.length; i += size) chunks.push(kept.slice(i, i + size));

  const header = (partNo, partCount, rowCount) => `-- Migration: seed the exercise library from wger${partCount > 1 ? ` (part ${partNo} of ${partCount})` : ''}
--
-- GENERATED by scripts/build-exercise-seed.mjs — do not hand-edit. Re-run the
-- script to regenerate.
--
-- Source: https://wger.de (open exercise database, fetched via its public API)
-- Licences present: ${licences.join(', ') || 'unspecified'}
-- Each row carries its own license and license_author, which must be honoured
-- wherever its description or image is displayed. CC-BY-SA in particular
-- requires attribution and share-alike on the text.
--
-- NOT sourced from ExRx.net: that content is copyrighted and the site refuses
-- automated access. Its taxonomy — browse by body part, narrow by equipment —
-- is a structure rather than an expression, and is what this follows.
--
${partCount > 1 ? `-- Split into ${partCount} parts because the Supabase SQL editor truncates a
-- very large paste, and a cut inside a description leaves an unterminated
-- string literal. Run the parts in order; each is independent and re-runnable.
-- This part: ${rowCount} exercises.
--` : ''}
-- Exercises kept: ${kept.length} of ${raw.length} fetched
-- With a description: ${withDescription} · with an image: ${withImage} · with a video: ${withVideo}
-- By category: ${Object.entries(byCategory).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${n}`).join(', ')}
${[...skipped.entries()].map(([reason, n]) => `-- Skipped ${n}: ${reason}`).join('\n')}
--
-- pattern and unilateral are INFERRED from the exercise name, because wger
-- records neither. Both feed real maths — §4.3 picks the load increment from
-- pattern, §4.4 totals volume by it, and §4.1 keeps unilateral sets out of
-- bilateral PR comparisons — so check the ones you actually train. They are
-- heuristics over names, not facts from the source.
-- Inferred unilateral: ${kept.filter(e => e.unilateral).length}

insert into public.exercises
  (name, pattern, unilateral, lower_body, compound,
   category, primary_muscles, secondary_muscles, equipment,
   description, image_url, video_url, source, source_id, license, license_author)
values
`;

  const CONFLICT = `
on conflict (name) do update set
  category          = excluded.category,
  primary_muscles   = excluded.primary_muscles,
  secondary_muscles = excluded.secondary_muscles,
  equipment         = excluded.equipment,
  description       = excluded.description,
  image_url         = excluded.image_url,
  video_url         = excluded.video_url,
  source            = excluded.source,
  source_id         = excluded.source_id,
  license           = excluded.license,
  license_author    = excluded.license_author;
`;

  const written = [];
  for (const [index, chunk] of chunks.entries()) {
    const path = chunks.length > 1
      ? OUT.replace(/\.sql$/, `_part${String(index + 1).padStart(2, '0')}.sql`)
      : OUT;
    const body = header(index + 1, chunks.length, chunk.length)
      + chunk.map(renderRow).join(',\n')
      + CONFLICT;
    await writeFile(path, body, 'utf8');
    written.push({ path, rows: chunk.length, kb: Math.round(Buffer.byteLength(body) / 1024) });
  }

  console.log(`\nKept ${kept.length} of ${raw.length} fetched.`);
  for (const [reason, n] of [...skipped.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  skipped ${String(n).padStart(4)} — ${reason}`);
  }
  console.log(`\nDescriptions: ${withDescription}  Images: ${withImage}  Videos: ${withVideo}`);
  console.log(`Licences: ${licences.join(', ')}`);
  console.log('');
  for (const w of written) console.log(`  wrote ${w.path}  (${w.rows} rows, ${w.kb} kB)`);
}

main().catch((error) => {
  console.error(error);
  exit(1);
});
