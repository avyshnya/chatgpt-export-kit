/* export-kit: conversation fetcher (ASCII-only, resume-safe, sequential).
   GENERIC TEMPLATE - contains NO account ids and NO conversation ids.
   Before starting, the page must already hold (seeded by the operator):

     window.__kitAcc      REQUIRED. Workspace account id string taken from
                          /backend-api/accounts/check/v4-2023-04-27 at runtime.
                          Use '' (empty string) for the personal space
                          (the ChatGPT-Account-ID header is then omitted).
     window.__kitPrefix   REQUIRED. ASCII prefix for output files and for the
                          localStorage namespace, e.g. 'chats' or 'proj-alpha'.
                          Output: <prefix>-01.ndjson, <prefix>-02.ndjson, ...
     window.__kitList     Array of {id, title, gizmo_id, is_archived} to fetch.
                          Seed ONCE per branch; it is persisted to localStorage
                          and reused on resume (then __kitList may be absent).
     window.__kitListSha  REQUIRED when __kitList is provided: sha256 hex of
                          JSON.stringify(list). The runner refuses to start on
                          mismatch - a corrupted id list can never run silently.
     window.__kitSkipProjects  Optional, default false. When true, entries
                          whose gizmo_id starts with 'g-p-' are skipped (use
                          for the no-project branch built from /conversations).

   Rate limits: base gap 1500 ms between requests. Every 429 raises the gap
   FOREVER (+1500 ms, cap 60000) and backs off (attempt+1)*5000 ms (or
   Retry-After if larger); max 3 attempts per conversation, then it is
   deferred and the run moves on. NEVER lower the gap mid-run.
   Progress is committed to localStorage ONLY after the NDJSON file has been
   handed to the browser for download (flush every 25 conversations).
   Keep the tab in the FOREGROUND: Chrome throttles background timers.
   Soft stop: __kitStop().  Poll progress: window.__kitSt  */
(() => {
  if (window.__kitRun) return 'ALREADY_RUNNING';
  if (location.host.indexOf('chatgpt.com') < 0) return 'WRONG_HOST';
  const ACC = window.__kitAcc;
  if (typeof ACC !== 'string') return 'NO_ACC set window.__kitAcc (empty string for personal space)';
  const PREFIX = window.__kitPrefix;
  if (!PREFIX || /[^a-zA-Z0-9_-]/.test(PREFIX)) return 'NO_PREFIX set window.__kitPrefix (ascii letters, digits, - _)';
  const K = k => 'kit_' + PREFIX + '_' + k;
  const CHUNK = 25;
  const LS = {
    get: k => JSON.parse(localStorage.getItem(K(k)) || 'null'),
    set: (k, v) => localStorage.setItem(K(k), JSON.stringify(v)),
  };
  const sha256 = async s => {
    const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
  };
  if (typeof window.__kitGap !== 'number') window.__kitGap = 1500;

  const done = new Set(LS.get('done') || []);
  const deferred = LS.get('deferred') || [];
  let part = LS.get('part') || 1;
  const st = window.__kitSt = {
    state: 'init', prefix: PREFIX, n: 0, todo: 0, files: 0, r429: 0,
    deferred: deferred.length, done: done.size, gap: window.__kitGap,
    last: '', started: Date.now(),
  };
  window.__kitRun = true;
  window.__kitStop = () => { st.stopReq = true; };

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  let tok = null;
  const getTok = async () => {
    tok = (await fetch('/api/auth/session').then(r => r.json())).accessToken;
    return tok;
  };
  const hdr = () => {
    const h = { Authorization: 'Bearer ' + tok };
    if (ACC) h['ChatGPT-Account-ID'] = ACC;
    return h;
  };
  const save = (name, text) => {
    const u = URL.createObjectURL(new Blob([text], { type: 'application/x-ndjson' }));
    const a = Object.assign(document.createElement('a'), { href: u, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 60000);
  };

  (async () => {
    if (Array.isArray(window.__kitList) && window.__kitList.length) {
      const got = await sha256(JSON.stringify(window.__kitList));
      if (got !== window.__kitListSha) {
        st.state = 'list-sha-mismatch'; st.last = got;
        window.__kitRun = false; return;
      }
      LS.set('list', window.__kitList);
    }
    const list = LS.get('list') || [];
    if (!list.length) { st.state = 'no-list'; window.__kitRun = false; return; }
    await getTok();
    if (!tok) { st.state = 'no-auth'; window.__kitRun = false; return; }

    const todo = list.filter(c =>
      !(window.__kitSkipProjects && (c.gizmo_id || '').indexOf('g-p-') === 0) &&
      !done.has(c.id) &&
      !deferred.some(d => d.id === c.id));
    st.todo = todo.length;
    st.state = 'run';

    let buf = [], bufIds = [];
    const flush = () => {
      if (!buf.length) return;
      save(PREFIX + '-' + String(part).padStart(2, '0') + '.ndjson', buf.join('\n') + '\n');
      bufIds.forEach(x => done.add(x));
      LS.set('done', [...done]);
      LS.set('part', ++part);
      st.files++; st.done = done.size;
      buf = []; bufIds = [];
    };
    const one = async id => {
      const c = new AbortController(), h = setTimeout(() => c.abort(), 60000);
      try {
        const r = await fetch('/backend-api/conversation/' + id, {
          headers: hdr(), signal: c.signal,
        });
        return { status: r.status, ra: r.headers.get('retry-after'), body: r.ok ? await r.json() : null };
      } finally { clearTimeout(h); }
    };
    const defer = (c, why) => {
      deferred.push({ id: c.id, title: c.title, reason: why });
      LS.set('deferred', deferred);
      st.deferred = deferred.length;
      st.last = 'defer ' + c.id + ' ' + why;
    };

    for (const c of todo) {
      if (st.stopReq) { st.state = 'stopped'; break; }
      let res = null, err = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        st.gap = window.__kitGap;
        await sleep(window.__kitGap);
        err = null;
        try { res = await one(c.id); } catch (e) { err = String(e.message || e); res = null; }
        if (res && res.status === 401) {
          await getTok(); await sleep(1000);
          try { res = await one(c.id); } catch (e) { err = String(e.message || e); res = null; }
        }
        if (res && res.status === 429) {
          st.r429++;
          window.__kitGap = Math.min(60000, window.__kitGap + 1500);
          const ra = parseInt(res.ra || '0', 10) * 1000;
          const wait = Math.max((attempt + 1) * 5000, ra);
          st.state = 'pause429'; st.last = '429 wait ' + Math.round(wait / 1000) + 's gap=' + window.__kitGap;
          await sleep(wait);
          st.state = 'run';
          continue;
        }
        if (!res && err && attempt < 2) { await sleep(5000); continue; }
        break;
      }
      if (!res || res.status !== 200) { defer(c, res ? ('HTTP ' + res.status) : (err || 'unknown')); continue; }

      const d = res.body;
      d.conversation_id = d.conversation_id || c.id;
      d.is_archived = c.is_archived;
      d.gizmo_id = d.gizmo_id || c.gizmo_id || null;
      buf.push(JSON.stringify(d)); bufIds.push(c.id); st.n++;
      if (buf.length >= CHUNK) flush();
    }
    flush();
    if (!st.stopReq) st.state = 'done';
    window.__kitRun = false;
  })().catch(e => { st.state = 'crash'; st.last = String(e.message || e); window.__kitRun = false; });

  return 'STARTED';
})();
