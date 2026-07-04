// Teste de carga: simula N usuários simultâneos usando o app de verdade.
//
// Cenário B (principal): N usuários já logados (cookie JWT válido) fazem o fluxo do promotor:
//   /api/me -> /api/reference -> /api/check-promotor -> POST /api/submissions -> /api/my/submissions
// Cenário A (pico de login): M logins simultâneos com senha certa (bcrypt é pesado de CPU).
//
// Uso:  MONGO_DB=memphis_pdv_test node test/carga.js [--vus=5000] [--logins=500] [--port=3000]
// (o servidor precisa estar rodando no MESMO banco de teste)

require('dotenv').config({ quiet: true });
const http = require('http');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { MongoClient } = require('mongodb');

const arg = (k, d) => {
  const m = process.argv.find((a) => a.startsWith(`--${k}=`));
  return m ? Number(m.split('=')[1]) : d;
};
const VUS = arg('vus', 5000);
const LOGINS = arg('logins', 500);
const PORT = arg('port', 3000);
const SECRET = process.env.SESSION_SECRET || 'dev-secret-troque';
const DB_NAME = process.env.MONGO_DB || 'memphis_pdv_test';
if (!/test/i.test(DB_NAME)) { console.error('Recuse: só roda em banco de teste (MONGO_DB deve conter "test")'); process.exit(1); }

const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity });
const ipDe = (i) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;

// estatísticas por endpoint
const stats = {};
function anota(rota, ms, status, erro) {
  const s = (stats[rota] ||= { ms: [], status: {}, erros: 0 });
  if (erro) { s.erros++; return; }
  s.ms.push(ms);
  s.status[status] = (s.status[status] || 0) + 1;
}
const pct = (a, p) => (a.length ? a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))] : 0);

function req(rota, { method = 'GET', path: p, ip, cookie, body }) {
  return new Promise((resolve) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const headers = { 'X-Forwarded-For': ip };
    if (cookie) headers.Cookie = cookie;
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    const t0 = process.hrtime.bigint();
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers, agent, timeout: 180000 }, (res) => {
      res.resume(); // descarta o corpo (só medimos)
      res.on('end', () => {
        anota(rota, Number(process.hrtime.bigint() - t0) / 1e6, res.statusCode);
        resolve(res.statusCode);
      });
    });
    r.on('timeout', () => { r.destroy(new Error('timeout')); });
    r.on('error', () => { anota(rota, 0, 0, true); resolve(0); });
    if (data) r.write(data);
    r.end();
  });
}

async function main() {
  console.log(`== Teste de carga: ${VUS} usuários simultâneos + ${LOGINS} logins em pico ==`);
  console.log(`banco: ${DB_NAME} | porta: ${PORT}\n`);

  // ---- seed: cria os usuários direto no banco (1 hash bcrypt compartilhado = seed rápido) ----
  const mc = new MongoClient(process.env.MONGODB_URI, { maxPoolSize: 20 });
  await mc.connect();
  const users = mc.db(DB_NAME).collection('users');
  await users.deleteMany({ emailLower: /^carga\d+@teste\.local$/ });
  const hash = bcrypt.hashSync('senha-carga-123', 10);
  const docs = [], tokens = [];
  for (let i = 0; i < VUS; i++) {
    const id = crypto.randomUUID();
    docs.push({
      id, email: `carga${i}@teste.local`, emailLower: `carga${i}@teste.local`,
      name: `CARGA VU ${String(i).padStart(4, '0')}`, role: 'promotor',
      passwordHash: hash, active: true, mustChangePassword: false, createdAt: new Date().toISOString(),
      grupo: 'CALMON', regiao: 'NE', telefone: '',
    });
    tokens.push(jwt.sign({ uid: id, role: 'promotor' }, SECRET, { expiresIn: '8h' }));
  }
  for (let i = 0; i < docs.length; i += 1000) await users.insertMany(docs.slice(i, i + 1000));
  console.log(`seed: ${VUS} contas criadas no banco de teste`);

  // ---- Cenário B: VUS usuários logados usando o app ao mesmo tempo ----
  console.log(`\n-- Cenário B: ${VUS} usuários ativos simultâneos (${VUS * 5} requisições) --`);
  const t0 = Date.now();
  await Promise.all(docs.map(async (u, i) => {
    const cookie = `mp_token=${tokens[i]}`, ip = ipDe(i);
    await req('GET /api/me', { path: '/api/me', ip, cookie });
    await req('GET /api/reference', { path: '/api/reference', ip, cookie });
    await req('GET /api/check-promotor', { path: '/api/check-promotor?nome=' + encodeURIComponent(u.name), ip, cookie });
    await req('POST /api/submissions', {
      method: 'POST', path: '/api/submissions', ip, cookie,
      body: {
        cliente: 'NOVO SURUBIM', endereco: 'Av. Teste 100', dataExposicao: '2026-07-01',
        regiao: 'NE', grupo: 'CALMON', promotor: u.name,
        fotos: [{ publicId: `memphis-pdv/fotos/carga_${i}`, resourceType: 'image' }],
      },
    });
    await req('GET /api/my/submissions', { path: '/api/my/submissions', ip, cookie });
  }));
  const durB = (Date.now() - t0) / 1000;

  // ---- Cenário A: pico de logins (bcrypt = CPU) ----
  console.log(`-- Cenário A: ${LOGINS} logins simultâneos --`);
  const t1 = Date.now();
  await Promise.all(Array.from({ length: LOGINS }, (_, i) =>
    req('POST /api/login', {
      method: 'POST', path: '/api/login', ip: ipDe(100000 + i),
      body: { email: `carga${i}@teste.local`, password: 'senha-carga-123' },
    })));
  const durA = (Date.now() - t1) / 1000;

  // ---- relatório ----
  let totalReqs = 0, totalErros = 0;
  console.log('\nendpoint                       reqs   ok%    média   p50     p95     máx     erros');
  for (const [rota, s] of Object.entries(stats)) {
    s.ms.sort((a, b) => a - b);
    const n = s.ms.length + s.erros; totalReqs += n; totalErros += s.erros;
    const ok = Object.entries(s.status).filter(([c]) => c < 500).reduce((a, [, v]) => a + v, 0);
    const media = s.ms.reduce((a, b) => a + b, 0) / (s.ms.length || 1);
    console.log(
      rota.padEnd(30) + String(n).padStart(6) +
      ((100 * ok / n).toFixed(1) + '%').padStart(7) +
      (media.toFixed(0) + 'ms').padStart(8) + (pct(s.ms, 50).toFixed(0) + 'ms').padStart(8) +
      (pct(s.ms, 95).toFixed(0) + 'ms').padStart(8) + (pct(s.ms, 100).toFixed(0) + 'ms').padStart(8) +
      String(s.erros).padStart(7));
    const inesperados = Object.entries(s.status).filter(([c]) => c >= 500 || c === '0');
    if (inesperados.length) console.log('   status inesperados: ' + JSON.stringify(Object.fromEntries(inesperados)));
  }
  console.log(`\nCenário B: ${durB.toFixed(1)}s (${(VUS * 5 / durB).toFixed(0)} req/s) | Cenário A: ${durA.toFixed(1)}s (${(LOGINS / durA).toFixed(1)} login/s)`);
  console.log(`total: ${totalReqs} requisições, ${totalErros} erros de rede/timeout`);

  // ---- limpeza ----
  await users.deleteMany({ emailLower: /^carga\d+@teste\.local$/ });
  await mc.db(DB_NAME).collection('submissions').deleteMany({ promotor: /^CARGA VU / });
  await mc.close();
  console.log('limpeza: contas e fotos de carga removidas');
}

main().catch((e) => { console.error('FALHA:', e); process.exit(1); });
