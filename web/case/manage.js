const el = id => document.getElementById(id);
let csrfToken = '', preview = null, busy = false, catalogVersion = 0, selectionVersion = 0;
async function request(path, body) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store', headers: body === undefined ? {} : { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || 'Request unavailable'); return data;
}
const route = suffix => `/v2/runs/${encodeURIComponent(el('run').value)}${suffix}`;
function invalidate() { selectionVersion++; preview = null; el('review').hidden = true; el('public').checked = false; el('create').disabled = true; el('link').replaceChildren(); }
function action(id, fn) { el(id).addEventListener('click', async () => { if (busy) return; busy = true; try { await fn(); } catch (error) { el('status').textContent = error.message; } finally { busy = false; } }); }
function renderSnapshot(snapshot, target) {
  target.replaceChildren();
  for (const source of snapshot.sources) {
    const article = document.createElement('article'), title = document.createElement('h3'), quote = document.createElement('blockquote'), details = document.createElement('small');
    title.textContent = `${source.actor} · ${source.kind} · ${source.epistemicStatus}`; quote.textContent = source.quote;
    details.textContent = `${source.referenceId} · ${source.sourceCreatedAt} · Original canonical SHA-256: ${source.sourceCanonicalHash}`;
    article.append(title, quote, details); target.append(article);
  }
}
async function listShares() {
  el('shares').replaceChildren(); if (!el('run').value) return;
  const data = await request(route('/shares'));
  for (const share of data.shares) {
    const article = document.createElement('article'), info = document.createElement('p'), button = document.createElement('button');
    info.textContent = `${share.id} · Expires ${share.expiresAt}${share.revokedAt ? ' · Revoked' : ''}${share.includesPrivate ? ' · Includes private content' : ''}`;
    button.type = 'button'; button.textContent = 'Revoke link'; button.disabled = !!share.revokedAt;
    button.addEventListener('click', async () => { if (busy) return; busy = true; button.disabled = true; try { await request(route(`/shares/${encodeURIComponent(share.id)}/revoke`), {}); el('status').textContent = 'Link revoked. Saved copies cannot be recalled.'; await listShares(); } catch (error) { el('status').textContent = error.message; button.disabled = false; } finally { busy = false; } });
    article.append(info, button); el('shares').append(article);
  }
}
async function loadCatalog() {
  const version = ++catalogVersion; invalidate(); el('catalog').replaceChildren(); el('shares').replaceChildren();
  if (!el('run').value) return;
  try {
    const data = await request(route('/journal')); if (version !== catalogVersion) return;
    for (const source of data.records) {
      const label = document.createElement('label'), checkbox = document.createElement('input'), text = document.createElement('span');
      label.className = 'check'; checkbox.type = 'checkbox'; checkbox.value = source.id; checkbox.checked = false; checkbox.addEventListener('change', invalidate);
      text.textContent = `${source.actor} · ${source.kind}\n${source.text}`; label.append(checkbox, text); el('catalog').append(label);
    }
    el('status').textContent = 'Select individual sources. Private content requires explicit opt-in.'; await listShares();
  } catch (error) { el('status').textContent = error.message; }
}
el('run').addEventListener('change', loadCatalog); el('private').addEventListener('change', invalidate); el('expiry').addEventListener('change', invalidate);
el('public').addEventListener('change', () => { el('create').disabled = !preview || !el('public').checked; });
action('preview', async () => {
  invalidate(); if (!el('run').value) throw new Error('Select a saved run.');
  const selectedIds = [...el('catalog').querySelectorAll('input:checked')].map(item => item.value);
  if (!selectedIds.length) throw new Error('Select at least one source.');
  const runId = el('run').value, version = catalogVersion, selectedVersion = selectionVersion;
  const selection = { selectedIds, includePrivate: el('private').checked, expiresAt: new Date(Date.now() + Number(el('expiry').value)).toISOString() };
  const result = await request(route('/shares/preview'), selection);
  if (version !== catalogVersion || selectedVersion !== selectionVersion || runId !== el('run').value) return;
  preview = { selection, result, runId, clientActionId: crypto.randomUUID() };
  renderSnapshot(result.snapshot, el('snapshot')); el('review').hidden = false;
  el('status').textContent = `Review exactly these quotes. Expires ${result.expiresAt}. Snapshot SHA-256: ${result.snapshotHash}`;
});
action('create', async () => {
  if (!preview || !el('public').checked || preview.runId !== el('run').value) throw new Error('Review and confirm the current snapshot.');
  el('create').disabled = true;
  const result = await request(route('/shares'), { ...preview.selection, confirmationHash: preview.result.confirmationHash, publicSharingConfirmed: true, clientActionId: preview.clientActionId });
  el('link').replaceChildren();
  if (result.token) { const link = document.createElement('a'); link.href = `/case/shared.html#${result.token}`; link.textContent = new URL(link.href, location.origin).href; el('link').append('Save this link now; the server stores only its hash. ', link); }
  else el('link').textContent = 'This request already created a share. Its token was issued once. Revoke it and create a new share if the link was lost.';
  preview = null; el('review').hidden = true; el('public').checked = false;
  el('status').textContent = 'Share created.'; await listShares();
});
action('refresh', listShares);
async function initialize() {
  try { const account = await request('/v1/auth/me'); csrfToken = account.csrfToken || ''; if (!csrfToken) throw new Error('Sign in through the account page to manage shares.');
    const data = await request('/v2/runs');
    for (const run of data.runs) { const option = document.createElement('option'); option.value = run.id; option.textContent = run.id; el('run').append(option); }
    el('manager').hidden = false; el('status').textContent = 'Select a saved run.';
  } catch (error) { el('status').textContent = error.message; }
}
initialize();
