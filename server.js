const express = require("express");
const path = require("path");
const dns = require("dns");
const { Pool } = require("pg");

// Render is IPv4-only. Prefer IPv4 in Node 24 and resolve the database
// hostname to an A record before opening the PostgreSQL connection.
try { dns.setDefaultResultOrder("ipv4first"); } catch (_) {}

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "degistir-bu-sifre";
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("DATABASE_URL ortam değişkeni eksik. Supabase bağlantı adresini Render Environment Variables'a ekleyin.");
}

let pool;

async function createPool() {
  if (!DATABASE_URL) throw new Error("DATABASE_URL ortam değişkeni eksik.");
  const u = new URL(DATABASE_URL);
  const host = u.hostname;
  const records = await dns.promises.resolve4(host);
  if (!records.length) throw new Error(`Supabase hostname için IPv4 adresi bulunamadı: ${host}`);
  const ipv4 = records[0];

  console.log(`Supabase IPv4 bağlantısı: ${ipv4}:${u.port || 5432}`);
  return new Pool({
    host: ipv4,
    port: Number(u.port || 5432),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.replace(/^\//, "")) || "postgres",
    // Socket goes to IPv4; TLS still identifies the original Supabase hostname.
    ssl: { rejectUnauthorized: false, servername: host },
    max: 5,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
}

app.use(express.json({ limit: "8mb" }));
app.use(express.static(path.join(__dirname, "public")));

async function query(text, params = []) {
  if (!pool) throw new Error("Veritabanı bağlantısı hazır değil.");
  return pool.query(text, params);
}

async function initDb() {
  await query(`
    CREATE TABLE IF NOT EXISTS players (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT DEFAULT '',
      preference TEXT DEFAULT 'any',
      photo TEXT DEFAULT '',
      active INTEGER DEFAULT 1,
      goals INTEGER DEFAULT 0,
      assists INTEGER DEFAULT 0,
      mvp INTEGER DEFAULT 0,
      yellow INTEGER DEFAULT 0,
      red INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS weeks (
      id BIGSERIAL PRIMARY KEY,
      match_date TEXT NOT NULL,
      match_time TEXT NOT NULL,
      location TEXT NOT NULL,
      status TEXT DEFAULT 'current',
      white_score INTEGER DEFAULT 0,
      black_score INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS attendance (
      week_id BIGINT NOT NULL REFERENCES weeks(id) ON DELETE CASCADE,
      player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending',
      team TEXT DEFAULT 'any',
      selection_order INTEGER DEFAULT NULL,
      PRIMARY KEY (week_id, player_id)
    );
    CREATE TABLE IF NOT EXISTS match_players (
      week_id BIGINT NOT NULL REFERENCES weeks(id) ON DELETE CASCADE,
      player_id BIGINT NOT NULL REFERENCES players(id) ON DELETE CASCADE,
      team TEXT NOT NULL DEFAULT 'white',
      PRIMARY KEY (week_id, player_id)
    );
    CREATE INDEX IF NOT EXISTS idx_attendance_week ON attendance(week_id);
    CREATE INDEX IF NOT EXISTS idx_match_players_week ON match_players(week_id);
  `);

  // Older databases created before selection_order existed are upgraded here.
  await query(`ALTER TABLE attendance ADD COLUMN IF NOT EXISTS selection_order INTEGER DEFAULT NULL`);

  const missing = await query(`SELECT week_id, player_id FROM attendance WHERE selection_order IS NULL ORDER BY week_id, player_id`);
  const maxRows = await query(`SELECT week_id, COALESCE(MAX(selection_order),0) AS max_order FROM attendance GROUP BY week_id`);
  const nextByWeek = new Map(maxRows.rows.map(r => [String(r.week_id), Number(r.max_order)]));
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    for (const r of missing.rows) {
      const key = String(r.week_id);
      const n = (nextByWeek.get(key) || 0) + 1;
      nextByWeek.set(key, n);
      await client.query("UPDATE attendance SET selection_order=$1 WHERE week_id=$2 AND player_id=$3", [n, r.week_id, r.player_id]);
    }
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }

  await seed();
}

async function currentWeek() {
  const r = await query("SELECT * FROM weeks WHERE status='current' ORDER BY id DESC LIMIT 1");
  if (r.rows[0]) return r.rows[0];
  const old = await query("SELECT * FROM weeks ORDER BY id DESC LIMIT 1");
  return old.rows[0] || null;
}

function nextFriday(dateStr) {
  const d = new Date(`${dateStr}T12:00:00`);
  const day = d.getDay();
  let add = (5 - day + 7) % 7;
  if (add === 0) add = 7;
  d.setDate(d.getDate() + add);
  return d.toISOString().slice(0, 10);
}

async function seed() {
  if (!(await currentWeek())) {
    const now = new Date();
    const day = now.getDay();
    let add = (5 - day + 7) % 7;
    if (add === 0) add = 7;
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + add);
    const date = d.toISOString().slice(0, 10);
    await query("INSERT INTO weeks(match_date,match_time,location,status) VALUES($1,$2,$3,'current')", [date, "20:00", "Halı Saha (Merkez)"]);
  }
  const w = await currentWeek();
  if (w) {
    const d = new Date(`${w.match_date}T12:00:00`);
    if (d.getDay() !== 5 || w.match_time !== "20:00") {
      const now = new Date();
      const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      let add = (5 - today.getDay() + 7) % 7;
      if (add === 0) add = 7;
      const next = new Date(today.getFullYear(), today.getMonth(), today.getDate() + add);
      await query("UPDATE weeks SET match_date=$1, match_time='20:00' WHERE id=$2", [next.toISOString().slice(0,10), w.id]);
    }
  }
}

function normalizeName(name) { return String(name || "").trim().replace(/\s+/g, " "); }
function validTeam(team) { return ["any","white","black"].includes(team); }
function auth(req,res){ if(req.headers["x-admin-key"] !== ADMIN_KEY){ res.status(401).json({error:"Yetkisiz"}); return false;} return true; }

async function getOrCreatePlayer(name, preference="any") {
  const clean = normalizeName(name);
  if (!clean) return null;
  const existing = await query("SELECT * FROM players WHERE active=1 AND lower(name)=lower($1) ORDER BY id LIMIT 1", [clean]);
  if (existing.rows[0]) return existing.rows[0];
  const info = await query("INSERT INTO players(name,preference) VALUES($1,$2) RETURNING *", [clean, preference]);
  return info.rows[0];
}

async function publicPlayers() {
  const r = await query("SELECT id,name,phone,preference,photo,active,goals,assists,mvp,yellow,red FROM players WHERE active=1 ORDER BY lower(name), id");
  return r.rows;
}

app.get("/api/state", async (req,res)=>{
  try {
    const week=await currentWeek();
    if (!week) return res.status(500).json({error:"Aktif hafta bulunamadı"});
    const players=await publicPlayers();
    const attendance=(await query("SELECT * FROM attendance WHERE week_id=$1", [week.id])).rows;
    res.json({week,players,attendance});
  } catch(e) { console.error(e); res.status(500).json({error:"Sunucu hatası"}); }
});

app.get("/api/history", async (req,res)=>{
  try {
    const weeks=(await query("SELECT * FROM weeks WHERE status='archived' ORDER BY match_date DESC,id DESC")).rows;
    const result=[];
    for(const w of weeks){
      const players=(await query(`SELECT mp.player_id, mp.team, p.name, p.photo FROM match_players mp JOIN players p ON p.id=mp.player_id WHERE mp.week_id=$1 ORDER BY mp.team, lower(p.name), p.id`, [w.id])).rows;
      result.push({...w,players});
    }
    res.json(result);
  } catch(e) { console.error(e); res.status(500).json({error:"Sunucu hatası"}); }
});

app.post("/api/attendance", async (req,res)=>{
  try {
    const { player_id, status, team="any" }=req.body;
    if(!Number(player_id)) return res.status(400).json({error:"Oyuncu seçin"});
    if(!["yes","no"].includes(status)) return res.status(400).json({error:"Geçersiz durum"});
    if(!validTeam(team)) return res.status(400).json({error:"Geçersiz takım"});
    const player=(await query("SELECT * FROM players WHERE id=$1 AND active=1", [Number(player_id)])).rows[0];
    if(!player) return res.status(404).json({error:"Oyuncu bulunamadı"});
    const week=await currentWeek();
    const existing=(await query("SELECT status, selection_order FROM attendance WHERE week_id=$1 AND player_id=$2", [week.id, player.id])).rows[0];
    let selectionOrder = existing?.selection_order ?? null;
    if(status === "yes" && (!existing || existing.status !== "yes")) {
      const row=(await query("SELECT COALESCE(MAX(selection_order),0)+1 AS n FROM attendance WHERE week_id=$1", [week.id])).rows[0];
      selectionOrder=Number(row.n);
    }
    await query(`INSERT INTO attendance(week_id,player_id,status,team,selection_order) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT (week_id,player_id) DO UPDATE SET status=EXCLUDED.status,team=EXCLUDED.team,selection_order=EXCLUDED.selection_order`, [week.id,player.id,status,team,selectionOrder]);
    await query("UPDATE players SET preference=$1 WHERE id=$2", [team,player.id]);
    res.json({ok:true,selection_order:selectionOrder});
  } catch(e) { console.error(e); res.status(500).json({error:"Sunucu hatası"}); }
});

app.post("/api/player/photo", async (req,res)=>{
  try {
    const {player_id,photo}=req.body;
    if(!Number(player_id) || !photo || String(photo).length>7_000_000) return res.status(400).json({error:"Geçersiz fotoğraf"});
    const player=(await query("SELECT id FROM players WHERE id=$1 AND active=1", [Number(player_id)])).rows[0];
    if(!player) return res.status(404).json({error:"Oyuncu bulunamadı"});
    await query("UPDATE players SET photo=$1 WHERE id=$2", [String(photo),player.id]);
    res.json({ok:true});
  } catch(e) { console.error(e); res.status(500).json({error:"Sunucu hatası"}); }
});

app.post("/api/admin/players", async (req,res)=>{
  try {
    if(!auth(req,res)) return;
    const {name,phone="",preference="any"}=req.body;
    if(!normalizeName(name)) return res.status(400).json({error:"İsim gerekli"});
    if(!validTeam(preference)) return res.status(400).json({error:"Geçersiz takım"});
    const clean=normalizeName(name);
    const existing=(await query("SELECT * FROM players WHERE lower(name)=lower($1) LIMIT 1", [clean])).rows[0];
    if(existing){
      if(existing.active) return res.json({id:existing.id,existing:true});
      await query("UPDATE players SET active=1,preference=$1 WHERE id=$2", [preference,existing.id]);
      return res.json({id:existing.id,restored:true});
    }
    const info=await query("INSERT INTO players(name,phone,preference) VALUES($1,$2,$3) RETURNING id", [clean,phone,preference]);
    res.json({id:info.rows[0].id});
  } catch(e) { console.error(e); res.status(500).json({error:"Sunucu hatası"}); }
});

app.delete("/api/admin/players/:id", async (req,res)=>{
  try { if(!auth(req,res)) return; await query("UPDATE players SET active=0 WHERE id=$1", [Number(req.params.id)]); res.json({ok:true}); }
  catch(e) { console.error(e); res.status(500).json({error:"Sunucu hatası"}); }
});

app.post("/api/admin/stats", async (req,res)=>{
  try {
    if(!auth(req,res)) return;
    const {player_id,goals,assists,mvp,yellow,red}=req.body;
    if(!player_id) return res.status(400).json({error:"Oyuncu gerekli"});
    await query(`UPDATE players SET goals=$1,assists=$2,mvp=$3,yellow=$4,red=$5 WHERE id=$6`, [
      Math.max(0,Number(goals)||0),Math.max(0,Number(assists)||0),Math.max(0,Number(mvp)||0),Math.max(0,Number(yellow)||0),Math.max(0,Number(red)||0),Number(player_id)]);
    res.json({ok:true});
  } catch(e) { console.error(e); res.status(500).json({error:"Sunucu hatası"}); }
});

app.get("/api/stats", async (req,res)=>{
  try {
    const players=await publicPlayers();
    res.json({goals:[...players].sort((a,b)=>b.goals-a.goals||b.assists-a.assists||a.name.localeCompare(b.name)),assists:[...players].sort((a,b)=>b.assists-a.assists||b.goals-a.goals),mvp:[...players].sort((a,b)=>b.mvp-a.mvp||b.goals-a.goals),cards:[...players].sort((a,b)=>(b.yellow+b.red)-(a.yellow+a.red))});
  } catch(e) { console.error(e); res.status(500).json({error:"Sunucu hatası"}); }
});

app.get("/api/lineup", async (req,res)=>{
  try {
    const week=await currentWeek();
    const players=(await query(`SELECT p.*,COALESCE(a.status,'pending') AS status,COALESCE(a.team,'any') AS team,COALESCE(a.selection_order,999999) AS selection_order
      FROM players p LEFT JOIN attendance a ON a.player_id=p.id AND a.week_id=$1 WHERE p.active=1 ORDER BY lower(p.name), p.id`, [week.id])).rows;
    const attending=players.filter(p=>p.status==='yes');
    attending.sort((a,b)=>Number(a.selection_order)-Number(b.selection_order) || a.name.localeCompare(b.name));
    const selected=attending.slice(0,14),bench=attending.slice(14),white=[],black=[];
    for(const p of selected){ if(p.team==='white'&&white.length<7) white.push(p); else if(p.team==='black'&&black.length<7) black.push(p); }
    for(const p of selected){
      if(white.includes(p)||black.includes(p)) continue;
      if(white.length<=black.length&&white.length<7) white.push(p); else if(black.length<7) black.push(p); else white.push(p);
    }
    res.json({week,white,black,bench,notComing:players.filter(p=>p.status==='no'),pending:players.filter(p=>p.status==='pending')});
  } catch(e) { console.error(e); res.status(500).json({error:"Sunucu hatası"}); }
});

app.post("/api/admin/reset-week", async (req,res)=>{
  const client=await pool.connect();
  try {
    if(!auth(req,res)) return;
    const current=await currentWeek();
    if(!current) return res.status(400).json({error:"Aktif hafta yok"});
    const attending=(await client.query(`SELECT player_id,team FROM attendance WHERE week_id=$1 AND status='yes' ORDER BY selection_order, player_id`, [current.id])).rows;
    await client.query("BEGIN");
    for(const p of attending) await client.query("INSERT INTO match_players(week_id,player_id,team) VALUES($1,$2,$3) ON CONFLICT (week_id,player_id) DO UPDATE SET team=EXCLUDED.team", [current.id,p.player_id,p.team==='black'?'black':'white']);
    await client.query("UPDATE weeks SET status='archived' WHERE id=$1", [current.id]);
    const nextDate=nextFriday(current.match_date);
    const info=await client.query("INSERT INTO weeks(match_date,match_time,location,status) VALUES($1,$2,$3,'current') RETURNING id", [nextDate,"20:00",current.location]);
    for(let i=0;i<attending.length;i++) await client.query(`INSERT INTO attendance(week_id,player_id,status,team,selection_order) VALUES($1,$2,'yes',$3,$4) ON CONFLICT (week_id,player_id) DO UPDATE SET status='yes',team=EXCLUDED.team,selection_order=EXCLUDED.selection_order`, [info.rows[0].id,attending[i].player_id,attending[i].team||'any',i+1]);
    await client.query("COMMIT");
    res.json({ok:true,next_week_id:info.rows[0].id,next_date:nextDate,copied_players:attending.length});
  } catch(e) { await client.query("ROLLBACK").catch(()=>{}); console.error(e); res.status(500).json({error:"Hafta sıfırlanamadı"}); }
  finally { client.release(); }
});

app.post("/api/admin/history/:id", async (req,res)=>{
  try {
    if(!auth(req,res)) return;
    const id=Number(req.params.id); const {white_score,black_score}=req.body;
    await query("UPDATE weeks SET white_score=$1,black_score=$2 WHERE id=$3 AND status='archived'", [Math.max(0,Number(white_score)||0),Math.max(0,Number(black_score)||0),id]);
    if(Array.isArray(req.body.players)) for(const p of req.body.players) if(["white","black"].includes(p.team)) await query("UPDATE match_players SET team=$1 WHERE week_id=$2 AND player_id=$3", [p.team,id,Number(p.player_id)]);
    res.json({ok:true});
  } catch(e) { console.error(e); res.status(500).json({error:"Sunucu hatası"}); }
});

app.post("/api/admin/archive-current", async (req,res)=>{
  const client=await pool.connect();
  try {
    if(!auth(req,res)) return;
    const current=await currentWeek(); if(!current) return res.status(400).json({error:"Aktif hafta yok"});
    const attending=(await client.query("SELECT player_id,team FROM attendance WHERE week_id=$1 AND status='yes' ORDER BY selection_order, player_id", [current.id])).rows;
    await client.query("BEGIN");
    for(const p of attending) await client.query("INSERT INTO match_players(week_id,player_id,team) VALUES($1,$2,$3) ON CONFLICT (week_id,player_id) DO UPDATE SET team=EXCLUDED.team", [current.id,p.player_id,p.team==='black'?'black':'white']);
    await client.query("UPDATE weeks SET status='archived' WHERE id=$1", [current.id]);
    await client.query("COMMIT");
    res.json({ok:true});
  } catch(e) { await client.query("ROLLBACK").catch(()=>{}); console.error(e); res.status(500).json({error:"Sunucu hatası"}); }
  finally { client.release(); }
});

app.post("/api/admin/score", async (req,res)=>{
  try { if(!auth(req,res)) return; const {week_id,white_score,black_score}=req.body; await query("UPDATE weeks SET white_score=$1,black_score=$2 WHERE id=$3", [Math.max(0,Number(white_score)||0),Math.max(0,Number(black_score)||0),Number(week_id)]); res.json({ok:true}); }
  catch(e) { console.error(e); res.status(500).json({error:"Sunucu hatası"}); }
});

app.get("*",(req,res)=>res.sendFile(path.join(__dirname,"public","index.html")));

createPool().then((p)=>{
  pool = p;
  return initDb();
}).then(()=>{
  app.listen(PORT, "0.0.0.0", ()=>console.log(`Halı Saha Grubu ${PORT} portunda çalışıyor. Supabase/PostgreSQL aktif.`));
}).catch(err=>{
  console.error("Veritabanı başlatılamadı:", err);
  process.exit(1);
});
