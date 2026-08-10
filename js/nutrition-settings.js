// ============================================================
// Nutrition settings — the inputs the target maths needs
// kiro-algorithm-spec.md §3.3, §3.4
// ============================================================
//
// Height, sex, date of birth and goal weight have no home anywhere else in the
// app, and without them setTargets refuses to produce a figure at all. This
// replaces the SQL that go-live previously asked people to paste.
// ============================================================

import { supabase, withAuthGuard } from './supabase-client.js';
import { getCurrentUser } from './app-shell.js';
import { escapeHtml } from './ui-helpers.js';
import { bmr, setTargets, currentSmoothedWeight } from './nutrition-engine.js';

/**
 * Validates the profile. Bounds are generous but real — the point is to catch
 * a slipped decimal before it reaches a calorie target, not to police anybody.
 */
export function validateProfile(input = {}) {
  const errors = {};

  if (!['male', 'female'].includes(input.sex)) {
    errors.sex = 'Pick one — the BMR formula differs by about 166 kcal.';
  }

  const height = Number(input.height_cm);
  if (!Number.isFinite(height) || height <= 100 || height >= 250) {
    errors.height_cm = 'Height should be between 100 and 250 cm.';
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.birth_date || '')) {
    errors.birth_date = 'Give a date of birth.';
  } else {
    const age = (Date.now() - new Date(input.birth_date)) / (365.25 * 86400000);
    if (!Number.isFinite(age) || age < 13 || age > 120) {
      errors.birth_date = 'That date of birth does not look right.';
    }
  }

  if (input.goal_weight_kg !== '' && input.goal_weight_kg !== null && input.goal_weight_kg !== undefined) {
    const goal = Number(input.goal_weight_kg);
    if (!Number.isFinite(goal) || goal <= 20 || goal >= 400) {
      errors.goal_weight_kg = 'Goal weight should be between 20 and 400 kg.';
    }
  }

  const rate = Number(input.goal_rate_kg_per_week);
  if (!Number.isFinite(rate) || rate < -1.5 || rate > 1.5) {
    errors.goal_rate_kg_per_week = 'Pick a rate between -1.5 and 1.5 kg per week.';
  }

  return { valid: Object.keys(errors).length === 0, errors };
}

export async function saveProfile(input, userId) {
  const { valid, errors } = validateProfile(input);
  if (!valid) return { success: false, errors };

  return withAuthGuard(async () => {
    const { error } = await supabase.from('nutrition_profile').upsert({
      user_id: userId,
      sex: input.sex,
      height_cm: Number(input.height_cm),
      birth_date: input.birth_date,
      goal_weight_kg: input.goal_weight_kg === '' ? null : Number(input.goal_weight_kg),
      goal_rate_kg_per_week: Number(input.goal_rate_kg_per_week),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id' });

    if (error) return { success: false, errors: { _form: 'Could not save your profile.' } };
    return { success: true };
  });
}

export async function saveBodyWeight(weightKg, userId) {
  const value = Number(weightKg);
  if (!Number.isFinite(value) || value <= 20 || value >= 400) {
    return { success: false, error: 'Weight should be between 20 and 400 kg.' };
  }
  return withAuthGuard(async () => {
    const { error } = await supabase.from('user_settings').upsert({
      user_id: userId,
      setting_key: 'body_weight_kg',
      setting_value: String(value),
      updated_at: new Date().toISOString(),
    }, { onConflict: 'user_id,setting_key' });
    if (error) return { success: false, error: 'Could not save your weight.' };
    return { success: true };
  });
}

// ------------------------------------------------------------
// View
// ------------------------------------------------------------

export async function renderNutritionSettings(container) {
  if (!container) return;
  const user = getCurrentUser();
  if (!user) {
    container.innerHTML = `<div class="empty-state">Sign in to set your targets.</div>`;
    return;
  }

  container.innerHTML = `<p class="view-placeholder-text">Loading…</p>`;

  const [{ data: profile }, { data: weightSetting }, { data: weighIns }] = await Promise.all([
    supabase.from('nutrition_profile').select('*').eq('user_id', user.id).maybeSingle(),
    supabase.from('user_settings').select('setting_value')
      .eq('user_id', user.id).eq('setting_key', 'body_weight_kg').maybeSingle(),
    supabase.from('weigh_ins').select('*').eq('user_id', user.id).order('date'),
  ]);

  const smoothed = currentSmoothedWeight(weighIns || []);
  const bodyWeight = Number(weightSetting?.setting_value) || smoothed || '';

  container.innerHTML = `
    <form id="nutrition-profile-form" novalidate>
      <div class="field-row">
        <div class="input-group">
          <label class="input-label" for="np-sex">Sex</label>
          <select id="np-sex" class="input">
            <option value="">Choose…</option>
            <option value="male" ${profile?.sex === 'male' ? 'selected' : ''}>Male</option>
            <option value="female" ${profile?.sex === 'female' ? 'selected' : ''}>Female</option>
          </select>
          <span id="np-sex-error" class="input-error-msg" aria-live="polite"></span>
        </div>
        <div class="input-group">
          <label class="input-label" for="np-height">Height (cm)</label>
          <input type="number" id="np-height" class="input num" min="100" max="250" step="1"
            inputmode="numeric" value="${profile?.height_cm ?? ''}" />
          <span id="np-height-error" class="input-error-msg" aria-live="polite"></span>
        </div>
      </div>

      <div class="field-row">
        <div class="input-group">
          <label class="input-label" for="np-dob">Date of birth</label>
          <input type="date" id="np-dob" class="input num" value="${profile?.birth_date ?? ''}" />
          <span id="np-dob-error" class="input-error-msg" aria-live="polite"></span>
        </div>
        <div class="input-group">
          <label class="input-label" for="np-weight">Current weight (kg)</label>
          <input type="number" id="np-weight" class="input num" min="20" max="400" step="0.1"
            inputmode="decimal" value="${bodyWeight}" />
          <span id="np-weight-error" class="input-error-msg" aria-live="polite"></span>
        </div>
      </div>

      <div class="field-row">
        <div class="input-group">
          <label class="input-label" for="np-goal-weight">Goal weight (kg)</label>
          <input type="number" id="np-goal-weight" class="input num" min="20" max="400" step="0.5"
            inputmode="decimal" value="${profile?.goal_weight_kg ?? ''}" />
          <span id="np-goal-weight-error" class="input-error-msg" aria-live="polite"></span>
        </div>
        <div class="input-group">
          <label class="input-label" for="np-rate">Rate (kg/week)</label>
          <select id="np-rate" class="input num">
            ${[
              ['-1', '-1.0 fast'],
              ['-0.75', '-0.75'],
              ['-0.5', '-0.5 steady'],
              ['-0.25', '-0.25 slow'],
              ['0', '0 maintain'],
              ['0.25', '+0.25 lean gain'],
              ['0.5', '+0.5 gain'],
            ].map(([value, label]) => `
              <option value="${value}" ${String(profile?.goal_rate_kg_per_week ?? -0.5) === value ? 'selected' : ''}>${label}</option>
            `).join('')}
          </select>
          <span id="np-rate-error" class="input-error-msg" aria-live="polite"></span>
        </div>
      </div>

      <p class="field-hint">
        Goal weight is used to anchor your protein target. Anchoring it to
        current weight at higher bodyweights asks for a figure that is neither
        necessary nor achievable.
      </p>

      <span id="np-form-error" class="input-error-msg" aria-live="polite"></span>

      <div class="form-actions">
        <button type="submit" class="btn btn-primary">Save</button>
        <span class="form-status num" id="np-status" aria-live="polite"></span>
      </div>
    </form>

    <div id="np-preview" class="target-preview" aria-live="polite"></div>
  `;

  wireProfileForm(container, user.id);
  updateTargetPreview(container);
}

function readForm(container) {
  return {
    sex: container.querySelector('#np-sex').value,
    height_cm: container.querySelector('#np-height').value,
    birth_date: container.querySelector('#np-dob').value,
    goal_weight_kg: container.querySelector('#np-goal-weight').value,
    goal_rate_kg_per_week: container.querySelector('#np-rate').value,
    body_weight_kg: container.querySelector('#np-weight').value,
  };
}

/**
 * Live preview of what these inputs produce, using the predicted figure only.
 * Showing the caps and floors as they bite is the clearest way to make the
 * safety bounds visible rather than mysterious.
 */
function updateTargetPreview(container) {
  const preview = container.querySelector('#np-preview');
  const input = readForm(container);

  const weightKg = Number(input.body_weight_kg);
  const age = input.birth_date
    ? (Date.now() - new Date(input.birth_date)) / (365.25 * 86400000)
    : null;

  const bmrValue = bmr({
    weightKg, heightCm: Number(input.height_cm), age, sex: input.sex,
  });

  if (!bmrValue) {
    preview.innerHTML = `<p class="field-hint">Fill in sex, height, date of birth and weight to see what this produces.</p>`;
    return;
  }

  // Sedentary baseline only. The real figure adds measured steps and training,
  // and switches to measured expenditure after a fortnight of logging.
  const roughTDEE = Math.round(bmrValue * 1.15);
  const targets = setTargets({
    tdee: roughTDEE,
    weightKg,
    goalRateKgPerWeek: Number(input.goal_rate_kg_per_week),
    sex: input.sex,
    bmrValue,
    goalWeightKg: input.goal_weight_kg === '' ? undefined : Number(input.goal_weight_kg),
  });

  if (!targets) { preview.innerHTML = ''; return; }

  preview.innerHTML = `
    <div class="target-preview-grid">
      <div><span class="target-value num">${bmrValue}</span><span class="target-label">BMR</span></div>
      <div><span class="target-value num">${targets.targetKcal}</span><span class="target-label">kcal target</span></div>
      <div><span class="target-value num">${targets.proteinG}</span><span class="target-label">protein g</span></div>
      <div><span class="target-value num">${targets.carbsG}</span><span class="target-label">carbs g</span></div>
      <div><span class="target-value num">${targets.fatG}</span><span class="target-label">fat g</span></div>
    </div>
    ${targets.notes.length
      ? `<p class="field-hint">${targets.notes.map(escapeHtml).join(' ')}</p>`
      : ''}
    <p class="field-hint">
      Before any activity. Once you have logged for a fortnight this is replaced
      by measured expenditure, which is usually higher.
    </p>
  `;
}

function wireProfileForm(container, userId) {
  const form = container.querySelector('#nutrition-profile-form');

  form.querySelectorAll('input, select').forEach((field) => {
    field.addEventListener('input', () => updateTargetPreview(container));
    field.addEventListener('change', () => updateTargetPreview(container));
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    form.querySelectorAll('.input-error-msg').forEach(el => { el.textContent = ''; });

    const status = form.querySelector('#np-status');
    const input = readForm(container);

    const { valid, errors } = validateProfile(input);
    if (!valid) {
      showProfileErrors(form, errors);
      return;
    }

    status.textContent = 'Saving…';

    const [profileResult, weightResult] = await Promise.all([
      saveProfile(input, userId),
      saveBodyWeight(input.body_weight_kg, userId),
    ]);

    if (!profileResult.success) {
      status.textContent = '';
      showProfileErrors(form, profileResult.errors || {});
      return;
    }
    if (!weightResult.success) {
      status.textContent = '';
      form.querySelector('#np-weight-error').textContent = weightResult.error;
      return;
    }

    status.textContent = 'Saved';
    window.dispatchEvent(new CustomEvent('food:refresh'));
    window.dispatchEvent(new CustomEvent('fitness:refresh'));
  });
}

function showProfileErrors(form, errors) {
  const map = {
    sex: '#np-sex-error',
    height_cm: '#np-height-error',
    birth_date: '#np-dob-error',
    goal_weight_kg: '#np-goal-weight-error',
    goal_rate_kg_per_week: '#np-rate-error',
    _form: '#np-form-error',
  };
  for (const [field, message] of Object.entries(errors)) {
    const slot = form.querySelector(map[field] || map._form);
    if (slot) slot.textContent = message;
  }
}
