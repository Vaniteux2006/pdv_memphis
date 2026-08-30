// Portão do aceite da LGPD — caso obrigatório nº 1 do plano ("aceite pendente bloqueia
// a API; aceite dado libera"). Precisa do servidor COM o bloqueio ligado, por isso é um
// arquivo separado do smoke (que roda com o bloqueio desligado, como em produção no piloto):
//
//   node test/lgpd-portao.js
//
// Ele mesmo sobe o servidor com LGPD_BLOQUEIA=1 numa porta própria e derruba no fim.
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 3099;
/**
 * @param {string} method
 * @param {string} p
 * @param {{ body?: any, cookie?: string }} [opcoes]
 */
function req(method, p, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const headers = {};
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = data.length; }
    if (cookie) headers['Cookie'] = cookie;
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers }, (res) => {
      const c = []; res.on('data', (b) => c.push(b));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c), cookie: (res.headers['set-cookie'] || [])[0] }));
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const J = (b) => { try { return JSON.parse(b.toString() || '{}'); } catch { return {}; } };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0, fail = 0;
const ck = (n, ok, e = '') => { console.log((ok ? '✓' : '✗') + ' ' + n + (e ? ' — ' + e : '')); ok ? pass++ : fail++; };

(async () => {
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: {
      ...process.env,
      MONGO_DB: 'memphis_pdv_test', NODE_ENV: 'development',
      PORT: String(PORT), HOST: '127.0.0.1',
      LGPD_BLOQUEIA: '1',
      ADMIN_EMAIL: 'admin@local', ADMIN_SENHA: 'admin123',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const encerra = () => { try { server.kill(); } catch {} };
  process.on('exit', encerra);

  try {
    // espera subir
    for (let i = 0; i < 40; i++) {
      try { if ((await req('GET', '/api/signup-info')).status === 200) break; } catch {}
      await espera(500);
    }

    const ac = (await req('POST', '/api/login', { body: { email: 'admin@local', password: 'admin123' } })).cookie;
    if (!ac) throw new Error('não consegui logar como admin — o banco de teste está semeado?');
    // o portão vale pra TODO MUNDO, inclusive admin (ele também é titular de dados).
    // Sem aceitar aqui, o próprio admin não conseguiria criar a conta de teste.
    ck('admin também é barrado antes de aceitar',
      (await req('GET', '/api/admin/users', { cookie: ac })).status === 403);
    await req('POST', '/api/aceitar-politica', { cookie: ac });
    ck('admin passa depois de aceitar', (await req('GET', '/api/admin/users', { cookie: ac })).status === 200);

    // conta criada pelo painel = nasce SEM aceite (é o caso das contas do Valoo)
    const email = 'portao_' + Date.now() + '@local';
    await req('POST', '/api/admin/users', { cookie: ac, body: { name: 'Portão', email, password: 'portao123' } });
    const login = await req('POST', '/api/login', { body: { email, password: 'portao123' } });
    const pc = login.cookie;
    ck('login funciona mesmo sem aceite', !!pc && J(login.body).precisaAceitar === true);

    // ---- com o bloqueio LIGADO, a API fica trancada ----
    const barrado = await req('GET', '/api/my/submissions', { cookie: pc });
    ck('API bloqueada antes do aceite (403 + precisaAceitar)',
      barrado.status === 403 && J(barrado.body).precisaAceitar === true, 'HTTP ' + barrado.status);
    ck('envio de foto também é bloqueado',
      (await req('POST', '/api/submissions', { cookie: pc, body: { cliente: 'X' } })).status === 403);

    // ...mas o mínimo pra conseguir aceitar continua livre
    ck('/api/me continua liberado (senão não dá pra saber o que falta)', (await req('GET', '/api/me', { cookie: pc })).status === 200);
    ck('/api/contato continua liberado (a política precisa ser lida)', (await req('GET', '/api/contato', { cookie: pc })).status === 200);

    // ---- aceitar libera ----
    ck('POST /api/aceitar-politica passa pelo portão', (await req('POST', '/api/aceitar-politica', { cookie: pc })).status === 200);
    ck('API liberada depois do aceite', (await req('GET', '/api/my/submissions', { cookie: pc })).status === 200);

    // ---- política nova volta a trancar ----
    await req('PATCH', '/api/admin/institucionais', { cookie: ac, body: { politicaVersao: '2099-12' } });
    ck('versão nova da política tranca de novo', (await req('GET', '/api/my/submissions', { cookie: pc })).status === 403);
    await req('POST', '/api/aceitar-politica', { cookie: pc });
    ck('aceitar a versão nova destranca', (await req('GET', '/api/my/submissions', { cookie: pc })).status === 200);
    await req('PATCH', '/api/admin/institucionais', { cookie: ac, body: { politicaVersao: '2026-08' } });

    console.log(`\n=== ${pass} passou, ${fail} falhou ===`);
  } catch (e) {
    console.error('ERRO', e);
    fail++;
  } finally {
    encerra();
  }
  process.exit(fail ? 1 : 0);
})();
