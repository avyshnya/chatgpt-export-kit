/* export-kit: LIVENESS CENSUS runner - probe /backend-api/files/{id} for every
   unique file id found in chat.json attachments. META ONLY, no bytes: the meta
   endpoint is a cheap, reliable liveness detector (200 = alive, 404 = dead;
   200 with an EMPTY json also means dead - the download route can lie).
   GENERIC TEMPLATE - contains NO account ids and NO file ids.

   Before starting, the page must already hold (seeded by the operator):
     window.__kitAcc     REQUIRED. Workspace account id ('' for personal space).
     window.__livIds     Array of file id strings (canonical sorted list,
                         seeded in verified chunks - see PLAYBOOK).
     window.__livExpect  REQUIRED: {n: <count>, sha: '<sha256 hex of
                         JSON.stringify(ids)>'}. The runner refuses to start
                         unless both match - a corrupted id list never runs.

   ASCII only. Sequential, base gap 1000 ms. On 429: raise gap FOREVER
   (+1000 ms), back off (attempt+1)*5000 ms, max 3 attempts, then record and
   move on. Resume-safe: progress in localStorage key kit_liv_done. Saves ONE
   report json to Downloads: files-liveness.json. Pacing sleep runs through
   a Web Worker, so background-tab timer throttling does not slow the run
   (keeping the tab visible is still nice, not required).
   Poll progress via window.__livSt.  */
(() => {
  if (window.__livRun) return 'ALREADY_RUNNING';
  if (location.host.indexOf('chatgpt.com') < 0) return 'WRONG_HOST';
  const ACC = window.__kitAcc;
  if (typeof ACC !== 'string') return 'NO_ACC set window.__kitAcc (empty string for personal space)';
  const EXP = window.__livExpect;
  if (!EXP || typeof EXP.n !== 'number' || typeof EXP.sha !== 'string') return 'NO_EXPECT set window.__livExpect {n, sha}';
  const IDS = window.__livIds;
  if (!Array.isArray(IDS) || IDS.length !== EXP.n) return 'NO_IDS or count mismatch';
  const LS_KEY = 'kit_liv_done';
  window.__livRun = true;
  let GAP = 1000;

  const sha256 = async s => {
    const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
    return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
  };

  let done = {};
  try { done = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { done = {}; }
  const isFinal = r => r && (r.s === 200 || r.s === 404);
  const todo = IDS.filter(fid => !isFinal(done[fid]));

  const st = window.__livSt = {
    i: 0, todo: todo.length, total: IDS.length,
    prior: IDS.length - todo.length,
    ok: 0, dead: 0, other: 0, r429: 0, gap: GAP, state: 'init', last: ''
  };
  /* Worker-based sleep: background tabs throttle setTimeout (field runs saw
     pace drop from seconds to minutes per item); Web Workers are exempt.
     Short AbortController kill-timers stay on setTimeout - they do not pace
     the loop. */
  const wsrc = 'onmessage=e=>{const p=e.data;setTimeout(()=>postMessage(p[0]),p[1])}';
  const wrk = new Worker(URL.createObjectURL(new Blob([wsrc])));
  const wcb = {}; let wseq = 1;
  wrk.onmessage = e => { const cb = wcb[e.data]; delete wcb[e.data]; if (cb) cb(); };
  const sleep = ms => new Promise(r => { const id = 'w' + (wseq++); wcb[id] = r; wrk.postMessage([id, ms]); });
  const save = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(done)); } catch (e) { st.last = 'ls-save-fail'; } };
  const hdr = tok => {
    const h = { Authorization: 'Bearer ' + tok };
    if (ACC) h['ChatGPT-Account-ID'] = ACC;
    return h;
  };

  const probe = async (fid, tok) => {
    const ctl = new AbortController();
    const kill = setTimeout(() => ctl.abort(), 30000);
    try {
      const r = await fetch('/backend-api/files/' + fid, { headers: hdr(tok), signal: ctl.signal });
      const rec = { s: r.status };
      if (r.ok) {
        try {
          const b = await r.json();
          const size = b.size ?? b.file_size ?? b.file_size_bytes ?? null;
          const name = b.file_name ?? b.name ?? null;
          if (size !== null) rec.size = size;
          if (name !== null) rec.name = name;
          if (b.download_url === undefined && size === null && name === null) rec.empty = 1;
        } catch (e) { rec.empty = 1; }
      }
      return rec;
    } catch (e) {
      return { s: 0, err: String(e.name || e).slice(0, 40) };
    } finally { clearTimeout(kill); }
  };

  (async () => {
    const gotSha = await sha256(JSON.stringify(IDS));
    if (gotSha !== EXP.sha) {
      st.state = 'ids-sha-mismatch'; st.last = gotSha;
      window.__livRun = false; return;
    }
    const tok = (await fetch('/api/auth/session').then(r => r.json())).accessToken;
    if (!tok) { st.state = 'no-auth'; window.__livRun = false; return; }
    st.state = 'run';

    for (const fid of todo) {
      st.i++;
      let rec = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        await sleep(GAP);
        rec = await probe(fid, tok);
        if (rec.s !== 429) break;
        st.r429++;
        GAP += 1000; st.gap = GAP;
        await sleep((attempt + 1) * 5000);
      }
      done[fid] = rec;
      if (rec.s === 200 && !rec.empty) st.ok++;
      else if (rec.s === 404 || (rec.s === 200 && rec.empty)) st.dead++;
      else st.other++;
      if (st.i % 20 === 0) save();
      if (st.i % 25 === 0) console.log('[liv] ' + st.i + '/' + st.todo +
        ' ok=' + st.ok + ' dead=' + st.dead + ' other=' + st.other +
        ' r429=' + st.r429 + ' gap=' + GAP);
    }
    save();

    let ok = 0, dead = 0, other = 0, bytes = 0;
    for (const fid of IDS) {
      const r = done[fid] || { s: -1 };
      if (r.s === 200 && !r.empty) { ok++; if (typeof r.size === 'number') bytes += r.size; }
      else if (r.s === 404 || (r.s === 200 && r.empty)) dead++;
      else other++;
    }
    const report = {
      when: new Date().toISOString(), endpoint: '/backend-api/files/{id}',
      ids_sha256: EXP.sha, gap_final: GAP,
      total: IDS.length, alive: ok, dead: dead, other: other,
      alive_bytes_known: bytes, r429: st.r429, items: done
    };
    const blob = new Blob([JSON.stringify(report, null, 1)], { type: 'application/json' });
    const u = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: u, download: 'files-liveness.json' });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 60000);
    st.state = 'done';
    console.log('[liv] DONE alive=' + ok + ' dead=' + dead + ' other=' + other +
      ' bytes=' + bytes + ' r429=' + st.r429);
    window.__livRun = false;
  })().catch(e => { st.state = 'crash'; st.last = String(e.message || e); save(); window.__livRun = false; });
  return 'STARTED ' + todo.length + ' of ' + IDS.length;
})();
