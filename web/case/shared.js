/* Token stays in the URL fragment, never a query parameter or persistent browser storage. */
const status = document.getElementById('status');
const sources = document.getElementById('sources');
async function load() {
  const token = location.hash.slice(1);
  history.replaceState(null, '', location.pathname);
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) { status.textContent = 'This share is unavailable.'; return; }
  try {
    const response = await fetch(`/api/case-shares/${encodeURIComponent(token)}`, { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!response.ok) throw new Error('unavailable');
    const data = await response.json();
    status.textContent = `Expires ${data.expiresAt}. Snapshot SHA-256: ${data.snapshotHash}`;
    for (const source of data.snapshot.sources) {
      const article = document.createElement('article');
      const title = document.createElement('h2'); title.textContent = source.referenceId;
      const details = document.createElement('p'); details.textContent = `${source.actor} · ${source.kind} · ${source.epistemicStatus} · day ${source.inGameDay} · ${source.sourceCreatedAt}${source.retracted ? ' · retracted original retained' : ''}`;
      const quote = document.createElement('blockquote'); quote.textContent = source.quote;
      const hash = document.createElement('small'); hash.textContent = `Original canonical SHA-256: ${source.sourceCanonicalHash}`;
      article.append(title, details, quote, hash); sources.append(article);
    }
  } catch { sources.replaceChildren(); status.textContent = 'This share is unavailable, expired, or revoked.'; }
}
load();
