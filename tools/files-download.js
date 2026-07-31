/* export-kit: attachment DOWNLOADER - fetch bytes of ALIVE files only (run the
   liveness census first; feed this runner only ids the census marked alive).
   GENERIC TEMPLATE - contains NO account ids and NO file ids.

   Before starting, the page must already hold (seeded by the operator):
     window.__kitAcc     REQUIRED. Workspace account id ('' for personal space).
     window.__dlList     Array of {fid, name} - alive files to download.
                         name is optional (used for the saved filename).
     window.__dlExpect   REQUIRED: {n: <count>, sha: '<sha256 hex of
                         JSON.stringify(list)>'}. Runner refuses on mismatch.

   Route: /backend-api/files/download/{fid}?inline=false (id AFTER 'download';
   the mirror /files/{fid}/download returns permission_error even for the
   owner - never use it). A JSON body with download_url is followed once.
   A 200 with no bytes is recorded as dead (the download route can lie).

   Each file is saved to ~/Downloads as '<fid>__<name>' - the fid prefix makes
   names unique, so Chrome never appends ' (1)'. Verify content, not filename.
   ASCII only. Sequential, base gap 1500 ms. On 429: raise gap FOREVER
   (+1500 ms), back off (attempt+1)*5000 ms, max 3 attempts, then skip.
   Resume-safe: progress in localStorage key kit_dl_done. Final report saved
   as kit-files-report.json (sha256 per file for disk-side verification).
   Keep the tab foregrounded. Poll: window.__dlSt. Soft stop: __dlStop().  */
(() => {
  if (window.__dlRun) return 'ALREADY_RUNNING';
  if (location.host.indexOf('chatgpt.com') < 0) return 'WRONG_HOST';
  const ACC = window.__kitAcc;
  if (typeof ACC !== 'string') return 'NO_ACC set window.__kitAcc (empty string for personal space)';
  const EXP = window.__dlExpect;
  if (!EXP || typeof EXP.n !== 'number' || typeof EXP.sha !== 'string') return 'NO_EXPECT set window.__dlExpect {n, sha}';
  const LIST = window.__dlList;
  if (!Array.isArray(LIST) || LIST.length !== EXP.n) return 'NO_LIST or count mismatch';
  const LS_KEY = 'kit_dl_done';
  window.__dlRun = true;
  let GAP = 1500;

  const sha256buf = async buf => {
    const h = await crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(h)).map(b => b.toString(16).padStart(2, '0')).join('');
  };
  const sha256str = async s => sha256buf(new TextEncoder().encode(s));

  let done = {};
  try { done = JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch (e) { done = {}; }
  const isFinal = r => r && (r.ok === 1 || r.dead === 1);
  const todo = LIST.filter(f => !isFinal(done[f.fid]));

  const st = window.__dlSt = {
    i: 0, todo: todo.length, total: LIST.length, prior: LIST.length - todo.length,
    ok: 0, dead: 0, other: 0, r429: 0, bytes: 0, gap: GAP, state: 'init', last: ''
  };
  window.__dlStop = () => { st.stopReq = true; };
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const save = () => { try { localStorage.setItem(LS_KEY, JSON.stringify(done)); } catch (e) { st.last = 'ls-save-fail'; } };
  const hdr = tok => {
    const h = { Authorization: 'Bearer ' + tok };
    if (ACC) h['ChatGPT-Account-ID'] = ACC;
    return h;
  };
  const safeName = s => String(s || 'file').replace(/[\/\\:*?"<>|]/g, '-').slice(0, 120);
  const saveBlob = (name, buf, mime) => {
    const u = URL.createObjectURL(new Blob([buf], { type: mime || 'application/octet-stream' }));
    const a = Object.assign(document.createElement('a'), { href: u, download: name });
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 60000);
  };

  const fetchOne = async (fid, tok) => {
    const ctl = new AbortController();
    const kill = setTimeout(() => ctl.abort(), 120000);
    try {
      const r = await fetch('/backend-api/files/download/' + fid + '?inline=false',
        { headers: hdr(tok), signal: ctl.signal });
      if (!r.ok) return { s: r.status };
      const ct = r.headers.get('content-type') || '';
      if (ct.indexOf('json') >= 0) {
        const b = await r.json();
        if (b && b.download_url) {
          const r2 = await fetch(b.download_url, { signal: ctl.signal });
          if (!r2.ok) return { s: r.status, sub: r2.status };
          const buf = await r2.arrayBuffer();
          return { s: r.status, buf: buf, ct: r2.headers.get('content-type') || '' };
        }
        return { s: r.status, empty: 1 };
      }
      const buf = await r.arrayBuffer();
      if (!buf.byteLength) return { s: r.status, empty: 1 };
      return { s: r.status, buf: buf, ct: ct };
    } catch (e) {
      return { s: 0, err: String(e.name || e).slice(0, 40) };
    } finally { clearTimeout(kill); }
  };

  (async () => {
    const gotSha = await sha256str(JSON.stringify(LIST));
    if (gotSha !== EXP.sha) {
      st.state = 'list-sha-mismatch'; st.last = gotSha;
      window.__dlRun = false; return;
    }
    let tok = (await fetch('/api/auth/session').then(r => r.json())).accessToken;
    if (!tok) { st.state = 'no-auth'; window.__dlRun = false; return; }
    st.state = 'run';

    for (const f of todo) {
      if (st.stopReq) { st.state = 'stopped'; break; }
      st.i++;
      let res = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        st.gap = GAP;
        await sleep(GAP);
        res = await fetchOne(f.fid, tok);
        if (res.s === 401) {
          tok = (await fetch('/api/auth/session').then(r => r.json())).accessToken;
          await sleep(1000);
          res = await fetchOne(f.fid, tok);
        }
        if (res.s !== 429) break;
        st.r429++;
        GAP += 1500;
        await sleep((attempt + 1) * 5000);
      }
      const rec = { s: res.s };
      if (res.buf && res.buf.byteLength) {
        rec.ok = 1; rec.bytes = res.buf.byteLength;
        rec.sha256 = await sha256buf(res.buf);
        rec.saved = f.fid + '__' + safeName(f.name);
        saveBlob(rec.saved, res.buf, res.ct);
        st.ok++; st.bytes += rec.bytes;
      } else if (res.s === 404 || res.empty) {
        rec.dead = 1; st.dead++;
      } else {
        if (res.err) rec.err = res.err;
        st.other++;
      }
      done[f.fid] = rec;
      if (st.i % 10 === 0) save();
      if (st.i % 25 === 0) console.log('[dl] ' + st.i + '/' + st.todo +
        ' ok=' + st.ok + ' dead=' + st.dead + ' other=' + st.other +
        ' r429=' + st.r429 + ' bytes=' + st.bytes + ' gap=' + GAP);
    }
    save();

    const report = {
      when: new Date().toISOString(),
      route: '/backend-api/files/download/{fid}?inline=false',
      list_sha256: EXP.sha, gap_final: GAP,
      total: LIST.length, ok: st.ok, dead: st.dead, other: st.other,
      bytes: st.bytes, r429: st.r429, items: done
    };
    saveBlob('kit-files-report.json',
      new TextEncoder().encode(JSON.stringify(report, null, 1)), 'application/json');
    if (!st.stopReq) st.state = 'done';
    console.log('[dl] DONE ok=' + st.ok + ' dead=' + st.dead + ' other=' + st.other +
      ' bytes=' + st.bytes + ' r429=' + st.r429);
    window.__dlRun = false;
  })().catch(e => { st.state = 'crash'; st.last = String(e.message || e); save(); window.__dlRun = false; });
  return 'STARTED ' + todo.length + ' of ' + LIST.length;
})();
