#!/usr/bin/env node
// ============================================================
// Build the common-foods seed migration from USDA FoodData Central
// ============================================================
//
// Why this is a script and not a hand-written migration:
//
// kiro-algorithm-spec.md §0.2 says any macro figure reaching the database must
// come from a food-database lookup, never from model prose. A seed migration
// full of typed-in numbers is the most durable possible way to violate that —
// it would be re-applied on every fresh setup, and every portion logged
// against a wrong figure scales linearly off it. So the numbers in the
// generated migration come from USDA, and the only thing written by hand is
// the list of search terms below.
//
// Usage:
//   USDA_API_KEY=... node scripts/build-food-seed.mjs
//
// The key is the same one in Supabase Edge Function secrets (Project Settings
// → Edge Functions → Secrets → USDA_API_KEY). Pass it in the environment; it
// must not end up in this repo. Without one the script falls back to
// api.data.gov's DEMO_KEY, which is capped at roughly 30 requests an hour and
// is only useful for a smoke test with --limit.
//
// Flags:
//   --limit N   only process the first N foods (for testing)
//   --out PATH  where to write the migration
// ============================================================

import { writeFile } from 'node:fs/promises';
import { argv, env, exit } from 'node:process';

const API_KEY = env.USDA_API_KEY || 'DEMO_KEY';
const SEARCH_URL = 'https://api.nal.usda.gov/fdc/v1/foods/search';

// Foundation is the modern, directly-measured dataset; SR Legacy is the older
// one but has far broader coverage of plain ingredients. Branded is excluded
// on purpose — barcode lookup already covers packaged goods, and a seed full
// of one supermarket's own-brand items ages badly.
const DATA_TYPES = 'Foundation,SR Legacy';

/**
 * The foods worth having before you have logged anything.
 *
 * Search terms only — deliberately no numbers here. USDA descriptions are
 * American ("courgette" is "squash, zucchini"), so each entry carries the term
 * to search and the name to store.
 */
const FOODS = [
  // Meat and poultry
  ['chicken breast boneless skinless raw', 'Chicken breast, raw'],
  ['chicken thigh boneless skinless raw', 'Chicken thigh, raw'],
  ['turkey breast raw', 'Turkey breast, raw'],
  ['beef mince 5% fat raw', 'Beef mince, lean, raw'],
  ['beef steak sirloin raw', 'Beef sirloin steak, raw'],
  ['pork loin chop raw', 'Pork loin chop, raw'],
  ['bacon raw', 'Bacon, raw'],
  ['lamb leg raw', 'Lamb leg, raw'],
  ['sausage pork raw', 'Pork sausage, raw'],
  ['ham sliced', 'Ham, sliced'],

  // Fish
  ['salmon atlantic farmed raw', 'Salmon, raw'],
  ['cod atlantic raw', 'Cod, raw'],
  ['tuna light canned in water', 'Tuna, canned in water'],
  ['haddock raw', 'Haddock, raw'],
  ['mackerel atlantic raw', 'Mackerel, raw'],
  ['prawns raw', 'Prawns, raw'],
  ['sardines canned in oil', 'Sardines, canned in oil'],

  // Eggs and dairy
  ['egg whole raw fresh', 'Egg, whole, raw'],
  ['egg white raw', 'Egg white, raw'],
  ['milk whole 3.25% milkfat', 'Whole milk'],
  ['milk reduced fat 2%', 'Semi-skimmed milk'],
  ['milk nonfat skim', 'Skimmed milk'],
  ['yogurt greek plain nonfat', 'Greek yoghurt, fat free'],
  ['yogurt greek plain whole milk', 'Greek yoghurt, full fat'],
  ['cheese cheddar', 'Cheddar cheese'],
  ['cheese mozzarella part skim', 'Mozzarella'],
  ['cheese cottage lowfat 2%', 'Cottage cheese'],
  ['cheese cream', 'Cream cheese'],
  ['butter without salt', 'Butter'],
  ['cream heavy whipping', 'Double cream'],

  // Grains, bread, pasta
  ['rice white long grain raw', 'White rice, dry'],
  ['rice brown long grain raw', 'Brown rice, dry'],
  ['pasta dry enriched', 'Pasta, dry'],
  ['pasta whole wheat dry', 'Wholewheat pasta, dry'],
  ['bread white commercially prepared', 'White bread'],
  ['bread whole wheat commercially prepared', 'Wholemeal bread'],
  ['oats raw', 'Porridge oats'],
  ['couscous dry', 'Couscous, dry'],
  ['quinoa uncooked', 'Quinoa, dry'],
  ['noodles egg dry', 'Egg noodles, dry'],
  ['tortilla flour', 'Flour tortilla'],
  ['flour wheat all purpose', 'Plain flour'],
  ['cornflakes cereal', 'Cornflakes'],
  ['granola cereal', 'Granola'],

  // Legumes, nuts, seeds
  ['lentils raw', 'Lentils, dry'],
  ['chickpeas garbanzo canned', 'Chickpeas, canned'],
  ['beans black canned', 'Black beans, canned'],
  ['beans kidney canned', 'Kidney beans, canned'],
  ['baked beans canned', 'Baked beans'],
  ['peanut butter smooth', 'Peanut butter'],
  ['almonds raw', 'Almonds'],
  ['walnuts raw', 'Walnuts'],
  ['cashews raw', 'Cashews'],
  ['peanuts raw', 'Peanuts'],
  ['chia seeds dried', 'Chia seeds'],
  ['sunflower seeds kernels dried', 'Sunflower seeds'],
  ['tofu firm', 'Tofu, firm'],

  // Vegetables
  ['potato flesh and skin raw', 'Potato, raw'],
  ['sweet potato raw', 'Sweet potato, raw'],
  ['broccoli raw', 'Broccoli, raw'],
  ['carrots raw', 'Carrot, raw'],
  ['onions raw', 'Onion, raw'],
  ['tomatoes red ripe raw', 'Tomato, raw'],
  ['spinach raw', 'Spinach, raw'],
  ['peppers sweet red raw', 'Red pepper, raw'],
  ['cucumber with peel raw', 'Cucumber, raw'],
  ['lettuce iceberg raw', 'Iceberg lettuce'],
  ['mushrooms white raw', 'Mushrooms, raw'],
  ['squash zucchini raw', 'Courgette, raw'],
  ['aubergine eggplant raw', 'Aubergine, raw'],
  ['cauliflower raw', 'Cauliflower, raw'],
  ['peas green frozen', 'Peas, frozen'],
  ['sweetcorn kernels canned', 'Sweetcorn, canned'],
  ['green beans raw', 'Green beans, raw'],
  ['cabbage raw', 'Cabbage, raw'],
  ['garlic raw', 'Garlic, raw'],
  ['avocado raw', 'Avocado'],
  ['celery raw', 'Celery, raw'],
  ['asparagus raw', 'Asparagus, raw'],
  ['beetroot beets raw', 'Beetroot, raw'],
  ['leeks raw', 'Leek, raw'],
  ['butternut squash raw', 'Butternut squash, raw'],

  // Fruit
  ['banana raw', 'Banana'],
  ['apple with skin raw', 'Apple'],
  ['orange raw', 'Orange'],
  ['strawberries raw', 'Strawberries'],
  ['blueberries raw', 'Blueberries'],
  ['raspberries raw', 'Raspberries'],
  ['grapes raw', 'Grapes'],
  ['pineapple raw', 'Pineapple'],
  ['mango raw', 'Mango'],
  ['melon cantaloupe raw', 'Melon'],
  ['pear raw', 'Pear'],
  ['peach raw', 'Peach'],
  ['kiwifruit green raw', 'Kiwi'],
  ['lemon raw', 'Lemon'],
  ['dates medjool', 'Dates'],
  ['raisins seedless', 'Raisins'],

  // Fats and oils
  ['olive oil', 'Olive oil'],
  ['rapeseed canola oil', 'Rapeseed oil'],
  ['coconut oil', 'Coconut oil'],
  ['mayonnaise regular', 'Mayonnaise'],

  // Store cupboard
  ['sugar granulated', 'Sugar'],
  ['honey', 'Honey'],
  ['tomatoes canned crushed', 'Chopped tomatoes, canned'],
  ['coconut milk canned', 'Coconut milk, canned'],
  ['soy sauce', 'Soy sauce'],
  ['tomato ketchup', 'Ketchup'],
  ['mustard prepared yellow', 'Mustard'],
  ['vinegar balsamic', 'Balsamic vinegar'],
  ['stock chicken', 'Chicken stock'],

  // Drinks
  ['coffee brewed', 'Coffee, black'],
  ['tea brewed', 'Tea, black'],
  ['orange juice raw', 'Orange juice'],
  ['beer regular', 'Beer'],
  ['wine table red', 'Red wine'],

  // Occasional
  ['chocolate dark 70-85% cacao', 'Dark chocolate'],
  ['chocolate milk bar', 'Milk chocolate'],
  ['potato crisps chips plain salted', 'Crisps, ready salted'],
  ['ice cream vanilla', 'Vanilla ice cream'],
  ['biscuits digestive', 'Digestive biscuits'],
];

const flag = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
};

const LIMIT = Number(flag('--limit', String(FOODS.length)));
const OUT = flag('--out', 'supabase/migrations/20250101000012_seed_common_foods.sql');

/**
 * Pulls one nutrient out of a USDA food record.
 *
 * Energy is the awkward one: Foundation records often carry it only in
 * kilojoules, or under "Energy (Atwater General Factors)", so a naive lookup
 * for name === 'Energy' && unit === 'KCAL' silently yields undefined and the
 * food seeds as zero calories.
 */
function nutrient(food, names, { unit = null } = {}) {
  for (const wanted of names) {
    const match = (food.foodNutrients || []).find(n => {
      const name = n.nutrientName || n.nutrient?.name || '';
      const u = (n.unitName || n.nutrient?.unitName || '').toUpperCase();
      return name === wanted && (!unit || u === unit);
    });
    const value = match?.value ?? match?.amount;
    if (Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function energyKcal(food) {
  const kcal = nutrient(food, ['Energy', 'Energy (Atwater General Factors)'], { unit: 'KCAL' });
  if (kcal !== null) return kcal;

  // Fall back to kilojoules and convert, rather than seeding a zero.
  const kj = nutrient(food, ['Energy'], { unit: 'KJ' });
  return kj !== null ? Math.round((kj / 4.184) * 10) / 10 : null;
}

/** §0.4 — floors are not optional. Carbs "by difference" can come back below zero. */
const floor = (value) => (Number.isFinite(value) && value > 0 ? Math.round(value * 100) / 100 : 0);

async function lookup(term) {
  const url = `${SEARCH_URL}?api_key=${encodeURIComponent(API_KEY)}`
    + `&query=${encodeURIComponent(term)}`
    + `&dataType=${encodeURIComponent(DATA_TYPES)}`
    + '&pageSize=5';

  const response = await fetch(url);
  if (response.status === 429) throw new Error('RATE_LIMIT');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);

  const body = await response.json();
  // Foundation before SR Legacy: directly measured beats the older tables.
  const candidates = (body.foods || []).sort((a, b) =>
    (a.dataType === 'Foundation' ? 0 : 1) - (b.dataType === 'Foundation' ? 0 : 1)
  );

  for (const food of candidates) {
    const kcal = energyKcal(food);
    const protein = nutrient(food, ['Protein']);
    if (kcal === null || protein === null) continue;

    return {
      fdcId: String(food.fdcId),
      description: food.description,
      dataType: food.dataType,
      per100g: {
        kcal: floor(kcal),
        protein: floor(protein),
        carbs: floor(nutrient(food, ['Carbohydrate, by difference'])),
        fat: floor(nutrient(food, ['Total lipid (fat)'])),
        fibre: floor(nutrient(food, ['Fiber, total dietary'])),
        sugar: floor(nutrient(food, ['Sugars, total including NLEA', 'Total Sugars'])),
        salt: floor((nutrient(food, ['Sodium, Na']) || 0) * 2.5 / 1000), // mg Na → g salt
      },
    };
  }
  return null;
}

const sqlString = (value) =>
  value === null || value === undefined ? 'null' : `'${String(value).replace(/'/g, "''")}'`;

async function main() {
  if (API_KEY === 'DEMO_KEY') {
    console.warn('! No USDA_API_KEY set — using DEMO_KEY (about 30 requests/hour).');
    console.warn('  Run with --limit 5 to smoke test, or set the key for a full build.\n');
  }

  const list = FOODS.slice(0, LIMIT);
  const rows = [];
  const missing = [];

  for (const [term, name] of list) {
    try {
      const hit = await lookup(term);
      if (!hit) {
        missing.push([name, 'no usable record']);
        console.log(`  -- ${name}: no usable record`);
        continue;
      }
      rows.push({ name, ...hit });
      console.log(`  ok ${name.padEnd(32)} ${String(hit.per100g.kcal).padStart(5)} kcal  (${hit.dataType} ${hit.fdcId})`);
    } catch (error) {
      if (error.message === 'RATE_LIMIT') {
        console.error(`\n! Rate limited after ${rows.length} foods. Set USDA_API_KEY for a full run.`);
        break;
      }
      missing.push([name, error.message]);
      console.log(`  -- ${name}: ${error.message}`);
    }
  }

  if (rows.length === 0) {
    console.error('\nNothing resolved. Not writing a migration.');
    exit(1);
  }

  const values = rows.map(r =>
    `  (${sqlString(r.name)}, 'usda', ${sqlString(r.fdcId)}, `
    + `'${JSON.stringify(r.per100g)}'::jsonb, true)`
  ).join(',\n');

  const sql = `-- Migration: seed the shared food table with common foods
--
-- GENERATED by scripts/build-food-seed.mjs — do not hand-edit. Re-run the
-- script to regenerate.
--
-- Every figure below came from a USDA FoodData Central lookup, recorded with
-- its fdcId in source_id so any value can be traced back. Per §0.2 no macro
-- here was written by hand or produced by a model.
--
-- Source datasets: ${DATA_TYPES}
-- Foods resolved: ${rows.length} of ${list.length} attempted
${missing.length ? `-- Unresolved: ${missing.map(([n]) => n).join(', ')}\n` : ''}
-- setup-complete.sql is documented as re-runnable, and \`foods\` has no unique
-- constraint on name or source_id — so without this index a second run inserts
-- a duplicate of every food below, and the search box fills with pairs.
create unique index if not exists foods_source_ref_idx
  on public.foods(source, source_id)
  where source_id is not null;

insert into public.foods (name, source, source_id, per_100g, verified) values
${values}
on conflict (source, source_id) where source_id is not null do nothing;
`;

  await writeFile(OUT, sql, 'utf8');
  console.log(`\nWrote ${rows.length} foods to ${OUT}`);
  if (missing.length) console.log(`${missing.length} unresolved: ${missing.map(([n]) => n).join(', ')}`);
}

main().catch((error) => {
  console.error(error);
  exit(1);
});
