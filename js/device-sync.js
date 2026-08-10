// ============================================================
// Device step sync — iOS Shortcuts (kiro-algorithm-spec.md §5.1)
// ============================================================
//
// A PWA cannot read Apple Health. The honest workaround is a daily Shortcuts
// automation on the phone that POSTs the step count to an Edge Function. This
// file issues the token that automation needs and shows the setup steps.
// ============================================================

import { supabase, SUPABASE_URL } from './supabase-client.js';
import { getCurrentUser } from './app-shell.js';
import { escapeHtml } from './ui-helpers.js';

const functionUrl = () => `${SUPABASE_URL}/functions/v1/ingest-steps`;

async function callFunction(action, payload = {}) {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return { success: false, error: 'Sign in first.' };

  try {
    const response = await fetch(functionUrl(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${session.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action, ...payload }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) return { success: false, error: body.error || 'Request failed.' };
    return body;
  } catch {
    return { success: false, error: 'Could not reach the sync service.' };
  }
}

export const listDevices = () => callFunction('list');
export const issueDeviceToken = (label) => callFunction('issue', { label });
export const revokeDeviceToken = (id) => callFunction('revoke', { id });

/** Steps recorded by the phone, newest first. */
export async function fetchStepDays(userId, days = 30) {
  if (!userId) return { success: true, days: [] };
  const since = new Date();
  since.setDate(since.getDate() - days);
  const key = `${since.getFullYear()}-${String(since.getMonth() + 1).padStart(2, '0')}-${String(since.getDate()).padStart(2, '0')}`;

  const { data, error } = await supabase
    .from('step_days').select('*')
    .eq('user_id', userId).gte('date', key)
    .order('date', { ascending: false });

  if (error) return { success: false, error: 'Could not load step history.' };
  return { success: true, days: data || [] };
}

// ------------------------------------------------------------
// View
// ------------------------------------------------------------

export async function renderDeviceSyncPanel(container) {
  if (!container) return;
  const user = getCurrentUser();
  if (!user) {
    container.innerHTML = `<div class="empty-state">Sign in to connect your phone.</div>`;
    return;
  }

  container.innerHTML = `<p class="view-placeholder-text">Checking…</p>`;
  const result = await listDevices();
  const devices = (result.devices || []).filter(d => !d.revoked);

  container.innerHTML = `
    <p class="field-hint">
      A phone cannot hand step data to a web app on its own, so this works the
      other way round: a daily automation on your phone posts the count here.
      No app store, nothing running in the background.
    </p>

    ${devices.length ? `
      <div class="device-list">
        ${devices.map(device => `
          <div class="device-row">
            <div class="device-main">
              <span class="device-label">${escapeHtml(device.label)}</span>
              <span class="device-meta">
                ${device.last_used_at
                  ? `Last posted ${escapeHtml(String(device.last_used_at).slice(0, 10))}`
                  : 'Never used yet'}
              </span>
            </div>
            <button type="button" class="btn btn-secondary btn-sm" data-revoke="${escapeHtml(device.id)}">Revoke</button>
          </div>
        `).join('')}
      </div>
    ` : ''}

    <div class="form-actions">
      <button type="button" class="btn btn-primary" id="issue-token">
        ${devices.length ? 'Add another phone' : 'Connect a phone'}
      </button>
      <span class="form-status num" id="device-status" aria-live="polite"></span>
    </div>

    <div id="token-reveal" hidden></div>
  `;

  wireDevicePanel(container);
}

function wireDevicePanel(container) {
  const status = container.querySelector('#device-status');
  const reveal = container.querySelector('#token-reveal');

  container.querySelector('#issue-token')?.addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    status.textContent = 'Creating…';

    const result = await issueDeviceToken('iPhone');
    button.disabled = false;

    if (!result.success) {
      status.textContent = result.error;
      return;
    }

    status.textContent = '';
    reveal.hidden = false;
    reveal.innerHTML = renderShortcutInstructions(result.token);
    reveal.querySelector('[data-copy]')?.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(result.token);
        reveal.querySelector('[data-copy]').textContent = 'Copied';
      } catch {
        reveal.querySelector('[data-copy]').textContent = 'Select it manually';
      }
    });
  });

  container.querySelectorAll('[data-revoke]').forEach((button) => {
    button.addEventListener('click', async () => {
      button.disabled = true;
      const result = await revokeDeviceToken(button.dataset.revoke);
      if (!result.success) {
        button.disabled = false;
        status.textContent = result.error;
        return;
      }
      renderDeviceSyncPanel(container);
    });
  });
}

/**
 * The token is shown exactly once — it is stored only as a digest, so there is
 * no way to display it again later. Say so plainly rather than letting someone
 * close the panel and lose it.
 */
function renderShortcutInstructions(token) {
  return `
    <div class="notice notice--warning">
      <p>Copy this now. It is stored as a one-way digest, so it cannot be shown again.</p>
    </div>
    <div class="token-box">
      <code class="token-value">${escapeHtml(token)}</code>
      <button type="button" class="btn btn-secondary btn-sm" data-copy>Copy</button>
    </div>

    <div class="shortcut-steps">
      <p class="field-hint">On your iPhone, in the Shortcuts app:</p>
      <ol class="shortcut-list">
        <li>Automation tab → <strong>+</strong> → Time of Day → <span class="num">23:50</span>, Daily.</li>
        <li>Choose <strong>Run Immediately</strong> and turn off <strong>Notify When Run</strong>.</li>
        <li>Add action <strong>Find Health Samples</strong>: type Steps, today, calculate Sum.</li>
        <li>Add action <strong>Get Contents of URL</strong>, set to <strong>POST</strong>, JSON body:</li>
      </ol>
      <pre class="token-body">URL: ${escapeHtml(functionUrl())}

Method: POST
Headers:
  Content-Type: application/json
Body (JSON):
  token   ${escapeHtml(token)}
  date    (Current Date, formatted yyyy-MM-dd)
  steps   (the Health sample sum)</pre>
      <p class="field-hint">
        Set the date field with a Format Date action, custom format
        <span class="num">yyyy-MM-dd</span>. Running it twice in a day is
        harmless — the day is overwritten, not duplicated.
      </p>
    </div>
  `;
}
