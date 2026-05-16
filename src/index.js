// ─── HMAC Session Auth ───────────────────────────────────────────────────────

const SESSION_DURATION = 7 * 24 * 3600 * 1000;

async function importHmacKey(secret) {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

function ab2b64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

async function createSessionToken(secret) {
  const ts = Date.now();
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`session:${ts}`));
  return `${btoa(String(ts))}.${ab2b64(sig)}`;
}

async function verifySessionToken(token, secret) {
  const dot = token.indexOf('.');
  if (dot === -1) return false;

  let ts;
  try {
    ts = parseInt(atob(token.slice(0, dot)), 10);
    if (!Number.isFinite(ts)) return false;
  } catch {
    return false;
  }

  if (Date.now() - ts > SESSION_DURATION) return false;

  let provided;
  try {
    provided = Uint8Array.from(atob(token.slice(dot + 1)), (c) => c.charCodeAt(0));
  } catch {
    return false;
  }

  const key = await importHmacKey(secret);
  const expected = new Uint8Array(
    await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`session:${ts}`)),
  );

  if (expected.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ provided[i];
  return diff === 0;
}

function getCookie(request, name) {
  const header = request.headers.get('Cookie') ?? '';
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

async function isAuthenticated(request, env) {
  const token = getCookie(request, 'session');
  if (!token) return false;
  return verifySessionToken(token, env.SECRET_KEY);
}

function sessionCookieHeader(token) {
  const exp = new Date(Date.now() + SESSION_DURATION).toUTCString();
  return `session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Expires=${exp}`;
}

function clearCookieHeader() {
  return 'session=; HttpOnly; Secure; SameSite=Strict; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT';
}

// ─── KV Helpers ──────────────────────────────────────────────────────────────

async function getMonitorIds(kv) {
  const v = await kv.get('monitors:list');
  return v ? JSON.parse(v) : [];
}

async function saveMonitorIds(kv, ids) {
  await kv.put('monitors:list', JSON.stringify(ids));
}

async function getMonitor(kv, id) {
  const v = await kv.get(`monitor:${id}`);
  return v ? JSON.parse(v) : null;
}

async function getStatus(kv, id) {
  const v = await kv.get(`status:${id}`);
  return v ? JSON.parse(v) : null;
}

async function getHistory(kv, id) {
  const v = await kv.get(`history:${id}`);
  return v ? JSON.parse(v) : [];
}

async function getTelegramConfig(kv) {
  const v = await kv.get('config:telegram');
  return v ? JSON.parse(v) : null;
}

// ─── Telegram ────────────────────────────────────────────────────────────────

async function sendTelegramMessage(config, text) {
  if (!config.botToken || !config.chatIds.length) return;
  await Promise.allSettled(
    config.chatIds.map((chatId) =>
      fetch(`https://api.telegram.org/bot${config.botToken}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      }),
    ),
  );
}

// ─── Scheduled Checks ────────────────────────────────────────────────────────

async function runChecks(env) {
  const ids = await getMonitorIds(env.KV);
  if (!ids.length) return;

  const now = Date.now();

  await Promise.allSettled(
    ids.map(async (id) => {
      const [monitor, prevStatus] = await Promise.all([
        getMonitor(env.KV, id),
        getStatus(env.KV, id),
      ]);

      if (!monitor || !monitor.enabled) return;

      // Skip if checked more recently than the monitor's interval
      if (now - (prevStatus?.lastCheck ?? 0) < monitor.interval * 1000) return;

      const start = Date.now();
      let newStatusVal = 'down';
      let responseTime = 0;

      try {
        const res = await fetch(monitor.url, {
          signal: AbortSignal.timeout(10_000),
          redirect: 'follow',
          headers: { 'User-Agent': 'UptimeMonitor/1.0' },
        });
        responseTime = Date.now() - start;
        newStatusVal = res.status < 400 ? 'up' : 'down';
      } catch {
        responseTime = Date.now() - start;
        newStatusVal = 'down';
      }

      const prevStatusVal = prevStatus?.status;
      const statusChanged = prevStatusVal && prevStatusVal !== 'paused' && prevStatusVal !== newStatusVal;

      // since = timestamp when current status started; reset on state change
      const since = statusChanged ? now : (prevStatus?.since ?? now);

      const newStatusObj = {
        status: newStatusVal,
        since,
        lastCheck: now,
        lastResponseTime: responseTime,
      };

      const history = await getHistory(env.KV, id);
      history.push({ t: now, ms: responseTime, status: newStatusVal });
      if (history.length > 24) history.shift();

      await Promise.all([
        env.KV.put(`status:${id}`, JSON.stringify(newStatusObj)),
        env.KV.put(`history:${id}`, JSON.stringify(history)),
      ]);

      if (statusChanged) {
        const config = await getTelegramConfig(env.KV);
        if (config?.botToken && config.chatIds.length) {
          const utc = new Date(now).toUTCString();
          let msg;
          if (newStatusVal === 'down') {
            msg = `🔴 ${monitor.name} is DOWN\n${monitor.url}\nAt: ${utc}`;
          } else {
            const sec = Math.floor((now - (prevStatus?.since ?? now)) / 1000);
            const m = Math.floor(sec / 60);
            const s = sec % 60;
            msg = `🟢 ${monitor.name} recovered\n${monitor.url}\nDowntime: ${m}m ${s}s`;
          }
          await sendTelegramMessage(config, msg);
        }
      }
    }),
  );
}

// ─── Response Helpers ────────────────────────────────────────────────────────

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html;charset=UTF-8' },
  });
}

function esc(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── API Handlers ────────────────────────────────────────────────────────────

async function apiListMonitors(env) {
  const ids = await getMonitorIds(env.KV);
  const rows = await Promise.all(
    ids.map(async (id) => {
      const [monitor, status, history] = await Promise.all([
        getMonitor(env.KV, id),
        getStatus(env.KV, id),
        getHistory(env.KV, id),
      ]);
      if (!monitor) return null;
      const upCount = history.filter((h) => h.status === 'up').length;
      const uptime = history.length ? (upCount / history.length) * 100 : null;
      return {
        ...monitor,
        status: monitor.enabled ? (status?.status ?? 'unknown') : 'paused',
        since: status?.since,
        lastCheck: status?.lastCheck,
        lastResponseTime: status?.lastResponseTime,
        uptime,
        history,
      };
    }),
  );
  return json(rows.filter(Boolean));
}

async function apiAddMonitor(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  if (!body.name?.trim() || !body.url?.trim()) {
    return json({ error: 'name and url are required' }, 400);
  }

  let parsed;
  try {
    parsed = new URL(body.url.trim());
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error();
  } catch {
    return json({ error: 'url must be a valid http/https URL' }, 400);
  }

  const interval = Math.max(30, Math.round(Number(body.interval) || 60));
  const id = crypto.randomUUID();
  const monitor = {
    id,
    name: String(body.name).trim().slice(0, 100),
    url: parsed.toString(),
    interval,
    enabled: true,
    createdAt: Date.now(),
  };

  const ids = await getMonitorIds(env.KV);
  ids.push(id);
  await Promise.all([
    env.KV.put(`monitor:${id}`, JSON.stringify(monitor)),
    saveMonitorIds(env.KV, ids),
  ]);

  return json(monitor, 201);
}

async function apiDeleteMonitor(id, env) {
  const ids = await getMonitorIds(env.KV);
  if (!ids.includes(id)) return json({ error: 'Not found' }, 404);
  await Promise.all([
    saveMonitorIds(env.KV, ids.filter((i) => i !== id)),
    env.KV.delete(`monitor:${id}`),
    env.KV.delete(`status:${id}`),
    env.KV.delete(`history:${id}`),
  ]);
  return json({ ok: true });
}

async function apiUpdateMonitor(id, request, env) {
  const monitor = await getMonitor(env.KV, id);
  if (!monitor) return json({ error: 'Not found' }, 404);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }

  if (typeof body.enabled === 'boolean') {
    monitor.enabled = body.enabled;
  }

  const status = await getStatus(env.KV, id);
  if (status && !monitor.enabled) {
    status.status = 'paused';
    await env.KV.put(`status:${id}`, JSON.stringify(status));
  }

  await env.KV.put(`monitor:${id}`, JSON.stringify(monitor));
  return json(monitor);
}

async function apiGetStatus(env) {
  const ids = await getMonitorIds(env.KV);
  const [monitors, statuses] = await Promise.all([
    Promise.all(ids.map((id) => getMonitor(env.KV, id))),
    Promise.all(ids.map((id) => getStatus(env.KV, id))),
  ]);
  let up = 0, down = 0, paused = 0;
  for (let i = 0; i < ids.length; i++) {
    const m = monitors[i];
    const s = statuses[i];
    if (!m) continue;
    if (!m.enabled) { paused++; continue; }
    if (s?.status === 'up') up++;
    else if (s?.status === 'down') down++;
    else paused++;
  }
  return json({ total: ids.length, up, down, paused });
}

async function apiSaveTelegram(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: 'Invalid JSON' }, 400);
  }
  const config = {
    botToken: String(body.botToken ?? '').trim(),
    chatIds: String(body.chatIds ?? '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean),
  };
  await env.KV.put('config:telegram', JSON.stringify(config));
  return json({ ok: true });
}

async function apiTestTelegram(env) {
  const config = await getTelegramConfig(env.KV);
  if (!config?.botToken) return json({ error: 'Bot token not configured' }, 400);
  if (!config.chatIds.length) return json({ error: 'No chat IDs configured' }, 400);
  await sendTelegramMessage(config, '✅ Uptime Monitor — Telegram alerts are working correctly!');
  return json({ ok: true });
}

// ─── CSS ─────────────────────────────────────────────────────────────────────

const CSS = `
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --bg:#0a0a0a;--surface:#111111;--surface2:#161616;
  --border:#1f1f1f;--text:#ededed;--muted:#777777;
  --green:#22c55e;--red:#ef4444;--blue:#3b82f6
}
body{background:var(--bg);color:var(--text);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;font-size:14px;line-height:1.5;min-height:100vh}
a{color:var(--blue);text-decoration:none}
a:hover{text-decoration:underline}
button{cursor:pointer;border:none;border-radius:6px;font-size:13px;font-family:inherit;padding:6px 12px;transition:opacity .15s}
button:hover{opacity:.82}
button:disabled{opacity:.4;cursor:not-allowed}
input,select,textarea{background:var(--surface2);border:1px solid var(--border);border-radius:6px;color:var(--text);font-family:inherit;font-size:13px;padding:7px 10px;outline:none;width:100%}
input:focus,select:focus,textarea:focus{border-color:var(--blue)}
label{color:var(--muted);font-size:12px;display:block;margin-bottom:4px}
.hdr{border-bottom:1px solid var(--border);padding:13px 24px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;background:var(--bg);z-index:10}
.hdr h1{font-size:15px;font-weight:600;letter-spacing:-.3px;display:flex;align-items:center;gap:8px}
.hdr-nav{display:flex;align-items:center;gap:8px}
.btn-ghost{background:transparent;color:var(--muted);border:1px solid var(--border);padding:5px 12px}
.btn-ghost:hover{color:var(--text);border-color:#333}
.btn-primary{background:var(--blue);color:#fff}
.btn-danger{background:var(--red);color:#fff;padding:4px 10px;font-size:12px}
.btn-sm{padding:4px 10px;font-size:12px}
.wrap{max-width:1120px;margin:0 auto;padding:28px 24px}
.summary{display:flex;gap:12px;margin-bottom:24px}
.stat{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:14px 20px;flex:1}
.stat .lbl{color:var(--muted);font-size:11px;text-transform:uppercase;letter-spacing:.6px}
.stat .val{font-size:26px;font-weight:700;margin-top:2px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:8px;overflow:hidden;margin-bottom:20px}
table{width:100%;border-collapse:collapse}
th{text-align:left;padding:9px 16px;color:var(--muted);font-size:11px;font-weight:500;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid var(--border);background:var(--surface2)}
td{padding:12px 16px;border-bottom:1px solid var(--border);vertical-align:middle}
tr:last-child td{border-bottom:none}
tr:hover td{background:var(--surface2)}
.dot{width:8px;height:8px;border-radius:50%;display:inline-block;margin-right:6px;flex-shrink:0}
.badge{display:inline-flex;align-items:center;font-size:12px;font-weight:500}
.up .dot{background:var(--green);box-shadow:0 0 6px var(--green)}
.up .lbl2{color:var(--green)}
.down .dot{background:var(--red);box-shadow:0 0 6px var(--red)}
.down .lbl2{color:var(--red)}
.paused .dot,.unknown .dot{background:var(--muted)}
.paused .lbl2,.unknown .lbl2{color:var(--muted)}
.mn{font-weight:500}
.mu{color:var(--muted);font-size:12px;margin-top:1px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.acts{display:flex;gap:6px}
.add-card{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:20px}
.add-card h2{font-size:14px;font-weight:600;margin-bottom:14px}
.form-row{display:flex;gap:12px;align-items:flex-end;flex-wrap:wrap}
.fg{flex:1;min-width:130px}
.fg0{flex:0 0 auto}
.empty{text-align:center;padding:48px;color:var(--muted)}
.pg{color:var(--muted);font-size:13px}
.pg:hover{color:var(--text);text-decoration:none}
.err-msg{font-size:13px;color:var(--red);margin-bottom:10px;display:none}
`;

// ─── HTML Templates ───────────────────────────────────────────────────────────

function loginPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Login — Uptime Monitor</title>
<style>
${CSS}
.lw{display:flex;align-items:center;justify-content:center;min-height:100vh}
.lc{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:32px;width:320px}
.lc h1{font-size:18px;font-weight:700;margin-bottom:6px}
.lc p{color:var(--muted);font-size:13px;margin-bottom:22px}
.fg{margin-bottom:14px}
.lerr{color:var(--red);font-size:13px;margin-bottom:10px;display:none}
</style>
</head>
<body>
<div class="lw">
  <div class="lc">
    <h1>Uptime Monitor</h1>
    <p>Enter admin password to continue.</p>
    <div id="err" class="lerr"></div>
    <div class="fg">
      <label>Password</label>
      <input type="password" id="pw" placeholder="••••••••" autofocus autocomplete="current-password">
    </div>
    <button class="btn-primary" style="width:100%" id="btn">Sign in</button>
  </div>
</div>
<script>
const btn=document.getElementById('btn'),pw=document.getElementById('pw'),err=document.getElementById('err');
async function login(){
  if(!pw.value)return;
  btn.disabled=true;btn.textContent='Signing in…';err.style.display='none';
  const r=await fetch('/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw.value})});
  if(r.ok){location.href='/';}
  else{
    const d=await r.json().catch(()=>({}));
    err.textContent=d.error||'Invalid password';err.style.display='block';
    btn.disabled=false;btn.textContent='Sign in';pw.value='';pw.focus();
  }
}
btn.addEventListener('click',login);
pw.addEventListener('keydown',e=>{if(e.key==='Enter')login();});
</script>
</body>
</html>`;
}

function dashboardPage() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Uptime Monitor</title>
<style>${CSS}</style>
</head>
<body>
<header class="hdr">
  <h1><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>Uptime Monitor</h1>
  <nav class="hdr-nav">
    <a href="/settings" class="pg">Settings</a>
    <form action="/logout" method="post" style="margin:0">
      <button class="btn-ghost" type="submit">Logout</button>
    </form>
  </nav>
</header>
<main class="wrap">
  <div class="summary">
    <div class="stat"><div class="lbl">Total</div><div class="val" id="sTotal">—</div></div>
    <div class="stat"><div class="lbl">Up</div><div class="val" id="sUp" style="color:var(--green)">—</div></div>
    <div class="stat"><div class="lbl">Down</div><div class="val" id="sDown" style="color:var(--red)">—</div></div>
    <div class="stat"><div class="lbl">Paused</div><div class="val" id="sPaused" style="color:var(--muted)">—</div></div>
  </div>

  <div class="card">
    <table>
      <thead>
        <tr>
          <th>Monitor</th>
          <th>Status</th>
          <th>Uptime</th>
          <th>Response</th>
          <th style="width:88px">Last 24</th>
          <th>Checked</th>
          <th style="width:140px"></th>
        </tr>
      </thead>
      <tbody id="rows">
        <tr><td colspan="7" class="empty">Loading…</td></tr>
      </tbody>
    </table>
  </div>

  <div class="add-card">
    <h2>Add Monitor</h2>
    <div id="addErr" class="err-msg"></div>
    <div class="form-row">
      <div class="fg"><label>Name</label><input id="newName" placeholder="My API" maxlength="100"></div>
      <div class="fg" style="flex:2"><label>URL</label><input id="newUrl" type="url" placeholder="https://example.com"></div>
      <div class="fg0"><label>Interval <span style="cursor:help;color:var(--muted)" title="CF cron minimum is 1 min. Intervals ≤60s run every cron cycle (~60s).">ⓘ</span></label>
        <select id="newInterval" style="width:auto">
          <option value="30">~30s</option>
          <option value="60" selected>1 min</option>
          <option value="120">2 min</option>
          <option value="300">5 min</option>
          <option value="600">10 min</option>
          <option value="1800">30 min</option>
          <option value="3600">1 hour</option>
        </select>
      </div>
      <div class="fg0" style="padding-top:16px"><button class="btn-primary" id="addBtn">Add Monitor</button></div>
    </div>
  </div>
</main>

<script>
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;')}
function relTime(ms){
  if(!ms)return'—';
  const d=Date.now()-ms;
  if(d<5000)return'just now';
  if(d<60000)return Math.floor(d/1000)+'s ago';
  if(d<3600000)return Math.floor(d/60000)+'m ago';
  if(d<86400000)return Math.floor(d/3600000)+'h ago';
  return Math.floor(d/86400000)+'d ago';
}
function sparkline(history){
  if(!history||history.length<2)return'<span style="color:var(--muted);font-size:11px">—</span>';
  const vals=history.map(h=>h.ms);
  const max=Math.max(...vals),min=Math.min(...vals),range=max-min||1;
  const W=80,H=24;
  const pts=vals.map((v,i)=>{
    const x=(i/(vals.length-1))*W;
    const y=H-((v-min)/range)*(H-4)-2;
    return x.toFixed(1)+','+y.toFixed(1);
  }).join(' ');
  const last=history[history.length-1];
  const color=last&&last.status==='down'?'#ef4444':'#22c55e';
  return '<svg width="'+W+'" height="'+H+'" viewBox="0 0 '+W+' '+H+'"><polyline points="'+pts+'" fill="none" stroke="'+color+'" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>';
}
function renderRow(m){
  const st=m.status||'unknown';
  const stLabel=st.charAt(0).toUpperCase()+st.slice(1);
  const uptime=m.uptime!=null?m.uptime.toFixed(1)+'%':'—';
  const rt=m.lastResponseTime?m.lastResponseTime+'ms':'—';
  const toggleLabel=m.enabled?'Pause':'Resume';
  return'<tr>'+
    '<td><div class="mn">'+esc(m.name)+'</div><div class="mu">'+esc(m.url)+'</div></td>'+
    '<td><span class="badge '+st+'"><span class="dot"></span><span class="lbl2">'+stLabel+'</span></span></td>'+
    '<td>'+uptime+'</td>'+
    '<td>'+rt+'</td>'+
    '<td>'+sparkline(m.history)+'</td>'+
    '<td style="color:var(--muted);font-size:12px;white-space:nowrap">'+relTime(m.lastCheck)+'</td>'+
    '<td><div class="acts">'+
      '<button class="btn-ghost btn-sm btn-toggle" data-id="'+m.id+'" data-enabled="'+(m.enabled?'1':'0')+'">'+toggleLabel+'</button>'+
      '<button class="btn-danger btn-delete" data-id="'+m.id+'" data-name="'+esc(m.name)+'">Delete</button>'+
    '</div></td>'+
  '</tr>';
}

async function load(){
  const r=await fetch('/api/monitors').catch(()=>null);
  if(!r||!r.ok)return;
  const data=await r.json();
  const tbody=document.getElementById('rows');
  if(!data.length){
    tbody.innerHTML='<tr><td colspan="7" class="empty">No monitors yet — add one below.</td></tr>';
  } else {
    tbody.innerHTML=data.map(renderRow).join('');
  }
  tbody.querySelectorAll('.btn-toggle').forEach(b=>{
    b.addEventListener('click',()=>toggle(b.dataset.id, b.dataset.enabled!=='1'));
  });
  tbody.querySelectorAll('.btn-delete').forEach(b=>{
    b.addEventListener('click',()=>del(b.dataset.id, b.dataset.name));
  });
  let up=0,down=0,paused=0;
  for(const m of data){
    if(m.status==='up')up++;else if(m.status==='down')down++;else paused++;
  }
  document.getElementById('sTotal').textContent=data.length;
  document.getElementById('sUp').textContent=up;
  document.getElementById('sDown').textContent=down;
  document.getElementById('sPaused').textContent=paused;
}

async function toggle(id,enabled){
  await fetch('/api/monitors/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled})});
  load();
}

async function del(id,name){
  if(!confirm('Delete monitor "'+name+'"?'))return;
  await fetch('/api/monitors/'+id,{method:'DELETE'});
  load();
}

document.getElementById('addBtn').addEventListener('click',async()=>{
  const name=document.getElementById('newName').value.trim();
  const url=document.getElementById('newUrl').value.trim();
  const interval=parseInt(document.getElementById('newInterval').value);
  const errEl=document.getElementById('addErr');
  errEl.style.display='none';
  if(!name||!url){errEl.textContent='Name and URL are required';errEl.style.display='block';return;}
  const btn=document.getElementById('addBtn');
  btn.disabled=true;
  const r=await fetch('/api/monitors',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,url,interval})});
  btn.disabled=false;
  if(r.ok){
    document.getElementById('newName').value='';
    document.getElementById('newUrl').value='';
    document.getElementById('newInterval').value='60';
    load();
  } else {
    const d=await r.json().catch(()=>({}));
    errEl.textContent=d.error||'Failed to add monitor';
    errEl.style.display='block';
  }
});

load();
setInterval(load,30000);
</script>
</body>
</html>`;
}

function settingsPage(config) {
  const botToken = config?.botToken ?? '';
  const chatIds = (config?.chatIds ?? []).join('\n');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Settings — Uptime Monitor</title>
<style>
${CSS}
.sc{background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:24px;margin-bottom:20px}
.sc h2{font-size:14px;font-weight:600;margin-bottom:4px}
.sc p{color:var(--muted);font-size:13px;margin-bottom:18px}
.fg2{margin-bottom:14px}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.toast{font-size:13px;margin-top:10px;display:none}
.toast.ok{color:var(--green)}.toast.err{color:var(--red)}
</style>
</head>
<body>
<header class="hdr">
  <h1><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>Uptime Monitor</h1>
  <nav class="hdr-nav">
    <a href="/" class="pg">Dashboard</a>
    <form action="/logout" method="post" style="margin:0">
      <button class="btn-ghost" type="submit">Logout</button>
    </form>
  </nav>
</header>
<main class="wrap">
  <div class="sc">
    <h2>Telegram Alerts</h2>
    <p>Get notified when monitors go up or down. Create a bot with <a href="https://t.me/BotFather" target="_blank">@BotFather</a>, add it to your chats, then enter the token and chat IDs below.</p>
    <div class="fg2">
      <label>Bot Token</label>
      <input type="password" id="botToken" value="${esc(botToken)}" placeholder="1234567890:AAAA…" autocomplete="off">
    </div>
    <div class="fg2">
      <label>Chat IDs (one per line — use negative IDs for groups/channels)</label>
      <textarea id="chatIds" rows="4" placeholder="-1001234567890&#10;987654321">${esc(chatIds)}</textarea>
    </div>
    <div class="row">
      <button class="btn-primary" id="saveBtn">Save</button>
      <button class="btn-ghost" id="testBtn">Send Test Alert</button>
    </div>
    <div id="toast" class="toast"></div>
  </div>
</main>
<script>
const toast=document.getElementById('toast');
function showToast(msg,ok){
  toast.textContent=msg;toast.className='toast '+(ok?'ok':'err');toast.style.display='block';
  clearTimeout(toast._t);toast._t=setTimeout(()=>toast.style.display='none',4000);
}
document.getElementById('saveBtn').addEventListener('click',async()=>{
  const r=await fetch('/api/settings/telegram',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({botToken:document.getElementById('botToken').value,chatIds:document.getElementById('chatIds').value})});
  const d=await r.json().catch(()=>({}));
  showToast(r.ok?'Settings saved.':d.error||'Failed to save.',r.ok);
});
document.getElementById('testBtn').addEventListener('click',async()=>{
  const btn=document.getElementById('testBtn');btn.disabled=true;
  const r=await fetch('/api/settings/telegram/test',{method:'POST'});
  const d=await r.json().catch(()=>({}));
  showToast(r.ok?'Test message sent!':d.error||'Failed to send.',r.ok);
  btn.disabled=false;
});
</script>
</body>
</html>`;
}

// ─── Main Request Handler ────────────────────────────────────────────────────

async function handleRequest(request, env) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // ── Public routes ──
  if (path === '/login') {
    if (method === 'GET') return html(loginPage());
    if (method === 'POST') {
      let body;
      try {
        body = await request.json();
      } catch {
        return json({ error: 'Invalid request' }, 400);
      }
      if (!env.ADMIN_PASSWORD || body.password !== env.ADMIN_PASSWORD) {
        return json({ error: 'Invalid password' }, 401);
      }
      const token = await createSessionToken(env.SECRET_KEY);
      return json({ ok: true }, 200, { 'Set-Cookie': sessionCookieHeader(token) });
    }
    return new Response('Method Not Allowed', { status: 405 });
  }

  if (path === '/logout' && method === 'POST') {
    return new Response(null, {
      status: 302,
      headers: {
        Location: new URL('/login', request.url).toString(),
        'Set-Cookie': clearCookieHeader(),
      },
    });
  }

  // ── Auth gate ──
  if (!(await isAuthenticated(request, env))) {
    if (path.startsWith('/api/')) return json({ error: 'Unauthorized' }, 401);
    return new Response(null, {
      status: 302,
      headers: { Location: new URL('/login', request.url).toString() },
    });
  }

  // ── Protected routes ──
  if (path === '/' && method === 'GET') return html(dashboardPage());

  if (path === '/settings' && method === 'GET') {
    const config = await getTelegramConfig(env.KV);
    return html(settingsPage(config));
  }

  // API
  if (path === '/api/monitors' && method === 'GET') return apiListMonitors(env);
  if (path === '/api/monitors' && method === 'POST') return apiAddMonitor(request, env);
  if (path === '/api/status' && method === 'GET') return apiGetStatus(env);
  if (path === '/api/settings/telegram' && method === 'POST') return apiSaveTelegram(request, env);
  if (path === '/api/settings/telegram/test' && method === 'POST') return apiTestTelegram(env);

  const m = path.match(/^\/api\/monitors\/([^/]+)$/);
  if (m) {
    const id = m[1];
    if (method === 'DELETE') return apiDeleteMonitor(id, env);
    if (method === 'PATCH') return apiUpdateMonitor(id, request, env);
  }

  return new Response('Not Found', { status: 404 });
}

// ─── Export ───────────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (err) {
      console.error('Unhandled error:', err);
      return new Response('Internal Server Error', { status: 500 });
    }
  },

  async scheduled(_event, env, ctx) {
    ctx.waitUntil(runChecks(env));
  },
};
