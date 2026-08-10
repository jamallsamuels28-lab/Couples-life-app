// Supabase Edge Function: generate-recipe
//
// kiro-algorithm-spec.md §2.2 (Claude call), §2.3 (ingredient resolution),
// §2.4 (macro-fit score).
//
// THE IMPORTANT PART, and the reason this was rewritten:
//
// The model is never asked for a calorie or macronutrient figure. It returns
// ingredients in grams and nothing else nutritional. Every macro on the way
// out is summed from a real per-100g lookup — the local cache first, then USDA
// FoodData Central, then Open Food Facts. §0.2 is explicit: any macro figure
// that reaches the database must come from a food-database lookup, never from
// prose the model wrote.
//
// A language model's nutrition estimates are not wildly wrong, they are about
// 15–20% wrong, which is exactly the error that ruins a deficit while looking
// entirely plausible.

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const CLAUDE_URL = 'https://api.anthropic.com/v1/messages';
const USDA_URL = 'https://api.nal.usda.gov/fdc/v1/foods/search';
const OFF_SEARCH_URL = 'https://world.openfoodfacts.org/cgi/search.pl';

// The spec names claude-sonnet-4-6, which no longer exists. Sonnet 5 is the
// current equivalent. Override with CLAUDE_MODEL if you want Haiku for cost.
const DEFAULT_MODEL = 'claude-sonnet-5';

/** Below this token overlap a match is refused. A wrong match is worse than none. */
const MIN_MATCH = 0.5;

const SYSTEM_PROMPT = `You generate recipes. Respond with ONLY a JSON object, no preamble, no markdown fences.
Schema:
{
  "title": string,
  "servings": number,
  "prep_minutes": number,
  "cook_minutes": number,
  "ingredients": [
    { "item": string,        // plain searchable food name, e.g. "chicken thigh, skinless"
      "grams": number,       // ALWAYS grams. Convert cups/tbsp yourself.
      "note": string|null }  // e.g. "diced"
  ],
  "method": [string],        // numbered steps, one per array element
  "tags": [string]
}
Rules:
- Do NOT include calorie or macronutrient values. They are computed downstream.
- "item" must be a generic ingredient name suitable for a nutrition database lookup,
  not a brand name and not a compound phrase.
- All quantities in grams, including liquids (use grams, assume 1ml=1g for water-based).`;

interface Ingredient { item: string; grams: number; note: string | null }
interface Recipe {
  title: string;
  servings: number;
  prep_minutes: number;
  cook_minutes: number;
  ingredients: Ingredient[];
  method: string[];
  tags: string[];
}

const MACRO_KEYS = ['kcal', 'protein', 'carbs', 'fat', 'fibre', 'sugar', 'salt'] as const;

// ------------------------------------------------------------
// Helpers
// ------------------------------------------------------------

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}

function requireEnv(name: string): string {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function adminClient() {
  return createClient(
    requireEnv('SUPABASE_URL'),
    requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { persistSession: false } }
  );
}

async function resolveUser(request: Request) {
  const token = (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const client = createClient(
    requireEnv('SUPABASE_URL'),
    requireEnv('SUPABASE_ANON_KEY'),
    { global: { headers: { Authorization: `Bearer ${token}` } }, auth: { persistSession: false } }
  );
  const { data, error } = await client.auth.getUser();
  return error || !data?.user ? null : data.user;
}

/** lowercase, punctuation stripped, crudely singularised (§2.3). */
function normalise(name: string): string {
  return String(name)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .map(word => (word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word))
    .join(' ');
}

/** Fraction of query tokens present in the candidate. */
function tokenOverlap(query: string, candidate: string): number {
  const left = new Set(normalise(query).split(' ').filter(Boolean));
  const right = new Set(normalise(candidate).split(' ').filter(Boolean));
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return shared / left.size;
}

const num = (value: unknown) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

// ------------------------------------------------------------
// §2.2 Claude call
// ------------------------------------------------------------

function buildUserMessage(body: Record<string, unknown>): string {
  const parts: string[] = [];

  const remaining = body.remainingMacros as Record<string, number> | undefined;
  if (remaining?.kcal) {
    // A hint, not a constraint. The real fit is scored afterwards from
    // resolved macros, so the model is not asked to hit a number it cannot see.
    parts.push(
      `Aim for roughly ${Math.round(remaining.kcal)} kcal and ${Math.round(remaining.protein || 0)} g protein per serving.`
    );
  }

  const pantry = body.pantry as string[] | undefined;
  if (pantry?.length) parts.push(`Use what is in: ${pantry.join(', ')}.`);

  const allergies = body.allergies as string[] | undefined;
  if (allergies?.length) parts.push(`Must not contain: ${allergies.join(', ')}. This is an allergy, not a preference.`);

  const dietType = body.dietType as string | undefined;
  if (dietType && dietType !== 'none') parts.push(`Diet: ${dietType}.`);

  const constraints = (body.constraints || {}) as Record<string, unknown>;
  if (constraints.mealType) parts.push(`Meal: ${constraints.mealType}.`);
  if (constraints.maxPrepTime) parts.push(`Ready in ${constraints.maxPrepTime} minutes or less.`);
  parts.push(`Servings: ${constraints.servings || 2}.`);

  const dislikes = body.dislikes as string[] | undefined;
  if (dislikes?.length) parts.push(`Avoid: ${dislikes.join(', ')}.`);

  if (typeof body.prompt === 'string' && body.prompt.trim()) parts.push(body.prompt.trim());

  return parts.join('\n');
}

/** Strips fences and parses. Returns null rather than throwing. */
function parseRecipe(text: string): Recipe | null {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    if (!parsed || typeof parsed !== 'object') return null;
    if (typeof parsed.title !== 'string') return null;
    if (!Array.isArray(parsed.ingredients) || parsed.ingredients.length === 0) return null;
    if (!Array.isArray(parsed.method) || parsed.method.length === 0) return null;

    const ingredients = parsed.ingredients
      .filter((i: unknown) => i && typeof (i as Ingredient).item === 'string')
      .map((i: Ingredient) => ({
        item: String(i.item).slice(0, 120),
        grams: Math.max(0, num(i.grams)),
        note: i.note ? String(i.note).slice(0, 80) : null,
      }))
      .filter((i: Ingredient) => i.grams > 0);

    if (ingredients.length === 0) return null;

    return {
      title: String(parsed.title).slice(0, 120),
      servings: Math.max(1, Math.round(num(parsed.servings) || 2)),
      prep_minutes: Math.max(0, Math.round(num(parsed.prep_minutes))),
      cook_minutes: Math.max(0, Math.round(num(parsed.cook_minutes))),
      ingredients,
      method: parsed.method.map((s: unknown) => String(s).slice(0, 500)).slice(0, 30),
      tags: Array.isArray(parsed.tags) ? parsed.tags.map((t: unknown) => String(t).slice(0, 40)).slice(0, 10) : [],
    };
  } catch {
    return null;
  }
}

async function callClaude(userMessage: string, retryNote?: string): Promise<{ recipe: Recipe | null, raw: string }> {
  const response = await fetch(CLAUDE_URL, {
    method: 'POST',
    headers: {
      'x-api-key': requireEnv('ANTHROPIC_API_KEY'),
      'anthropic-version': '2023-06-01',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: Deno.env.get('CLAUDE_MODEL') || DEFAULT_MODEL,
      max_tokens: 2000,
      system: SYSTEM_PROMPT,
      messages: [{
        role: 'user',
        content: retryNote ? `${userMessage}\n\nYour previous reply could not be parsed: ${retryNote}. Return only the JSON object.` : userMessage,
      }],
    }),
  });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`Claude returned ${response.status}: ${detail.slice(0, 200)}`);
  }

  const payload = await response.json();
  const raw = (payload.content || []).map((block: { text?: string }) => block.text || '').join('');
  return { recipe: parseRecipe(raw), raw };
}

// ------------------------------------------------------------
// §2.3 Ingredient resolution
// ------------------------------------------------------------

type Resolution = {
  item: string;
  grams: number;
  note: string | null;
  resolved: boolean;
  source: string | null;
  matched_name: string | null;
  match_score: number | null;
  per_100g: Record<string, number> | null;
  macros: Record<string, number> | null;
};

async function fromUSDA(query: string) {
  const key = Deno.env.get('USDA_API_KEY');
  if (!key) return null;

  const params = new URLSearchParams({
    api_key: key,
    query,
    // Foundation and SR Legacy are the authoritative generic-ingredient sets.
    // Branded is deliberately excluded: it is full of near-miss own-brand items.
    dataType: 'Foundation,SR Legacy',
    pageSize: '5',
  });

  const response = await fetch(`${USDA_URL}?${params}`);
  if (!response.ok) return null;

  const body = await response.json();
  const foods = body.foods || [];
  if (!foods.length) return null;

  let best = null;
  let bestScore = 0;
  for (const food of foods) {
    const score = tokenOverlap(query, food.description || '');
    if (score > bestScore) { bestScore = score; best = food; }
  }
  if (!best || bestScore < MIN_MATCH) return null;

  const byId: Record<number, number> = {};
  for (const nutrient of best.foodNutrients || []) {
    byId[nutrient.nutrientId] = num(nutrient.value);
  }

  return {
    source: 'usda',
    source_id: String(best.fdcId),
    display_name: best.description,
    match_score: bestScore,
    per_100g: {
      kcal: byId[1008] || 0,
      protein: byId[1003] || 0,
      carbs: byId[1005] || 0,
      fat: byId[1004] || 0,
      fibre: byId[1079] || 0,
      sugar: byId[2000] || 0,
      salt: (byId[1093] || 0) * 2.5 / 1000,
    },
  };
}

async function fromOpenFoodFacts(query: string) {
  const params = new URLSearchParams({
    search_terms: query,
    search_simple: '1',
    action: 'process',
    json: '1',
    page_size: '5',
  });

  const response = await fetch(`${OFF_SEARCH_URL}?${params}`);
  if (!response.ok) return null;

  const body = await response.json();
  const products = body.products || [];

  let best = null;
  let bestScore = 0;
  for (const product of products) {
    const name = product.product_name || '';
    if (!name) continue;
    const score = tokenOverlap(query, name);
    if (score > bestScore) { bestScore = score; best = product; }
  }
  if (!best || bestScore < MIN_MATCH) return null;

  const n = best.nutriments || {};
  const kcal = num(n['energy-kcal_100g']);
  if (kcal <= 0) return null;

  return {
    source: 'off',
    source_id: String(best.code || ''),
    display_name: best.product_name,
    match_score: bestScore,
    per_100g: {
      kcal,
      protein: num(n.proteins_100g),
      carbs: num(n.carbohydrates_100g),
      fat: num(n.fat_100g),
      fibre: num(n.fiber_100g),
      sugar: num(n.sugars_100g),
      salt: num(n.salt_100g),
    },
  };
}

/**
 * Cache first, then USDA, then Open Food Facts. Misses are cached too, so the
 * same unmatched ingredient does not re-query the network on every recipe.
 */
async function resolveIngredient(
  admin: ReturnType<typeof adminClient>,
  ingredient: Ingredient,
): Promise<Resolution> {
  const key = normalise(ingredient.item);

  const base = {
    item: ingredient.item,
    grams: ingredient.grams,
    note: ingredient.note,
  };

  const { data: cached } = await admin
    .from('food_cache').select('*').eq('normalised_name', key).maybeSingle();

  if (cached) {
    await admin.from('food_cache').update({ hits: (cached.hits || 0) + 1 }).eq('id', cached.id);
    if (!cached.resolved) {
      return { ...base, resolved: false, source: null, matched_name: null, match_score: null, per_100g: null, macros: null };
    }
    return {
      ...base,
      resolved: true,
      source: cached.source,
      matched_name: cached.display_name,
      match_score: cached.match_score,
      per_100g: cached.per_100g,
      macros: scale(cached.per_100g, ingredient.grams),
    };
  }

  const found = (await fromUSDA(ingredient.item)) || (await fromOpenFoodFacts(ingredient.item));

  if (!found) {
    await admin.from('food_cache').insert({
      normalised_name: key,
      display_name: ingredient.item,
      source: 'unresolved',
      resolved: false,
    });
    return { ...base, resolved: false, source: null, matched_name: null, match_score: null, per_100g: null, macros: null };
  }

  await admin.from('food_cache').insert({
    normalised_name: key,
    display_name: found.display_name,
    source: found.source,
    source_id: found.source_id,
    per_100g: found.per_100g,
    match_score: found.match_score,
    resolved: true,
  });

  return {
    ...base,
    resolved: true,
    source: found.source,
    matched_name: found.display_name,
    match_score: found.match_score,
    per_100g: found.per_100g,
    macros: scale(found.per_100g, ingredient.grams),
  };
}

function scale(per100g: Record<string, number> | null, grams: number) {
  if (!per100g) return null;
  const factor = grams / 100;
  const out: Record<string, number> = {};
  for (const key of MACRO_KEYS) out[key] = Math.round(num(per100g[key]) * factor * 10) / 10;
  return out;
}

// ------------------------------------------------------------
// §2.4 Macro-fit score
// ------------------------------------------------------------

function fitScore(perServing: Record<string, number>, remaining?: Record<string, number>) {
  if (!remaining || !num(remaining.kcal)) return null;

  const weights: Record<string, number> = { kcal: 0.40, protein: 0.35, carbs: 0.125, fat: 0.125 };
  let score = 100;

  for (const macro of Object.keys(weights)) {
    const target = Math.max(num(remaining[macro]), 1);
    const err = (num(perServing[macro]) - target) / target;
    // Overshoot hurts more than undershoot: missing protein is a shame,
    // blowing the calorie budget is what actually derails a deficit.
    const penalty = err > 0 ? err * 1.5 : Math.abs(err);
    score -= weights[macro] * Math.min(penalty, 1) * 100;
  }

  return Math.round(Math.min(Math.max(score, 0), 100));
}

// ------------------------------------------------------------
// Request handling
// ------------------------------------------------------------

serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  const user = await resolveUser(request).catch(() => null);
  if (!user) return json({ error: 'Sign in required.' }, 401);

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Expected a JSON body.' }, 400);
  }

  try {
    const userMessage = buildUserMessage(body);

    // One retry with the parse error appended, as §2.2 asks for.
    let { recipe, raw } = await callClaude(userMessage);
    if (!recipe) {
      ({ recipe } = await callClaude(userMessage, `not valid JSON matching the schema (got: ${raw.slice(0, 120)})`));
    }
    if (!recipe) return json({ error: 'Could not get a usable recipe. Try again.' }, 502);

    const admin = adminClient();

    // Sequential rather than parallel: the cache is doing most of the work
    // after the first few recipes, and hammering USDA in parallel gets rate
    // limited on the free key.
    const resolutions: Resolution[] = [];
    for (const ingredient of recipe.ingredients) {
      resolutions.push(await resolveIngredient(admin, ingredient));
    }

    const totals: Record<string, number> = Object.fromEntries(MACRO_KEYS.map(k => [k, 0]));
    for (const resolution of resolutions) {
      if (!resolution.macros) continue;
      for (const key of MACRO_KEYS) totals[key] += num(resolution.macros[key]);
    }
    for (const key of MACRO_KEYS) totals[key] = Math.round(totals[key] * 10) / 10;

    const perServing: Record<string, number> = {};
    for (const key of MACRO_KEYS) {
      perServing[key] = Math.round((totals[key] / recipe.servings) * 10) / 10;
    }

    const unresolved = resolutions.filter(r => !r.resolved);
    const resolvedGrams = resolutions.filter(r => r.resolved).reduce((sum, r) => sum + r.grams, 0);
    const totalGrams = resolutions.reduce((sum, r) => sum + r.grams, 0);
    const coverage = totalGrams > 0 ? Math.round((resolvedGrams / totalGrams) * 100) : 0;

    return json({
      success: true,
      recipe: {
        ...recipe,
        // Named to make it unmistakable these were computed, not generated.
        macros_computed: totals,
        macros_per_serving: perServing,
        total_cooked_weight_g: Math.round(totalGrams),
        ingredients_resolved: resolutions.map(r => ({
          item: r.item,
          grams: r.grams,
          note: r.note,
          resolved: r.resolved,
          matched_name: r.matched_name,
          source: r.source,
          match_score: r.match_score,
          macros: r.macros,
        })),
        coverage_pct: coverage,
        unresolved: unresolved.map(r => r.item),
        fit_score: fitScore(perServing, body.remainingMacros as Record<string, number> | undefined),
      },
      // Below about 85% by weight the totals are missing enough to be
      // misleading. The client should say so rather than showing them plainly.
      warning: coverage < 85
        ? `Only ${coverage}% of this recipe by weight could be matched to a food database, so the macros are an undercount.`
        : null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unexpected error.';
    return json({ error: message }, 500);
  }
});
