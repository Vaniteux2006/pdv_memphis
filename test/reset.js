// Reset de cadastros (plano LGPD 1.8) — a ação mais destrutiva do sistema.
// Isolado do smoke porque APAGA a base: sobe servidor próprio numa porta própria.
// Cobre o caso obrigatório nº 9 do plano: "o reset ABORTA se o backup falhar".
//   node test/reset.js
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');

const PORT = 3097;
function req(method, p, { body, cookie } = {}) {
  return new Promise((res, rej) => {
    const data = body == null ? null : Buffer.from(JSON.stringify(body));
    const h = {};
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = data.length; }
    if (cookie) h.Cookie = cookie;
    const r = http.request({ host: '127.0.0.1', port: PORT, method, path: p, headers: h }, (x) => {
      const c = []; x.on('data', (b) => c.push(b));
      x.on('end', () => res({ status: x.statusCode, body: Buffer.concat(c).toString(), cookie: (x.headers['set-cookie'] || [])[0] }));
    });
    r.on('error', rej); if (data) r.write(data); r.end();
  });
}
const J = (b) => { try { return JSON.parse(b || '{}'); } catch { return {}; } };
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const ck = (n, ok, d = '') => { console.log((ok ? '✓' : '✗') + ' ' + n + (d ? ' — ' + d : '')); ok ? pass++ : fail++; };

function subir(envExtra) {
  const s = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, MONGO_DB: 'memphis_pdv_test', NODE_ENV: 'development',
      PORT: String(PORT), HOST: '127.0.0.1', ADMIN_EMAIL: 'admin@local', ADMIN_SENHA: 'admin123', ...envExtra },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return s;
}
async function esperarNoAr() {
  for (let i = 0; i < 40; i++) {
    try { if ((await req('GET', '/api/signup-info')).status === 200) return true; } catch {}
    await espera(500);
  }
  return false;
}

(async () => {
  let srv;
  const derrubar = async () => { if (srv) { srv.kill(); srv = null; await espera(1200); } };
  process.on('exit', () => { try { srv && srv.kill(); } catch {} });

  try {
    // ---------- 1) BACKUP QUEBRADO: tem que ABORTAR sem apagar nada ----------
    console.log('\n== backup falhando (Cloudinary inválido) ==');
    srv = subir({ CLOUDINARY_API_SECRET: 'secreto-invalido-de-proposito' });
    if (!await esperarNoAr()) throw new Error('servidor não subiu');

    let ac = (await req('POST', '/api/login', { body: { email: 'admin@local', password: 'admin123' } })).cookie;
    await req('POST', '/api/admin/users', { cookie: ac, body: { name: 'Vitima', email: 'vitima@local', password: 'vitima123' } });
    const antes = J((await req('GET', '/api/admin/users', { cookie: ac })).body).length;
    const promsAntes = J((await req('GET', '/api/admin/ref/promotores?limit=1', { cookie: ac })).body).total;

    const abortou = await req('POST', '/api/admin/reset-cadastros', { cookie: ac, body: { confirmacao: 'RESETAR' } });
    ck('reset ABORTA quando o backup falha (500)', abortou.status === 500, 'HTTP ' + abortou.status);
    ck('a resposta diz que nada foi apagado', /nada foi apagado/i.test(J(abortou.body).error || ''), J(abortou.body).error || '');
    ck('as contas continuam lá', J((await req('GET', '/api/admin/users', { cookie: ac })).body).length === antes, `antes=${antes}`);
    ck('o banco de promotores continua lá', J((await req('GET', '/api/admin/ref/promotores?limit=1', { cookie: ac })).body).total === promsAntes);
    ck('o abort fica registrado na auditoria',
      J((await req('GET', '/api/admin/auditoria?acao=reset_abortado_backup_falhou', { cookie: ac })).body).total >= 1);

    // ---------- 2) BACKUP OK: reset roda e preserva o admin ----------
    console.log('\n== backup funcionando ==');
    await derrubar();
    srv = subir({});
    if (!await esperarNoAr()) throw new Error('servidor não subiu (2)');
    ac = (await req('POST', '/api/login', { body: { email: 'admin@local', password: 'admin123' } })).cookie;

    const ok = await req('POST', '/api/admin/reset-cadastros', { cookie: ac, body: { confirmacao: 'RESETAR' } });
    const r = J(ok.body);
    ck('reset roda quando o backup funciona', ok.status === 200 && r.ok === true, r.error || '');
    ck('gerou o backup ANTES de apagar', !!r.backup, 'backup=' + r.backup);
    ck('apagou as contas de promotor', r.contas >= 1, r.contas + ' conta(s)');
    ck('apagou o banco de nomes', r.promotores > 0, r.promotores + ' nome(s)');

    const restantes = J((await req('GET', '/api/admin/users', { cookie: ac })).body);
    ck('NUNCA apaga quem executou (senão ninguém entra mais)', restantes.some((u) => u.email === 'admin@local'));
    ck('só sobraram admins', restantes.every((u) => u.role === 'admin'));
    ck('quem executou continua logado e funcional', (await req('GET', '/api/me', { cookie: ac })).status === 200);
    ck('o reset fica registrado na auditoria com quem e quanto',
      J((await req('GET', '/api/admin/auditoria?acao=resetou_cadastros', { cookie: ac })).body).total >= 1);
    ck('o backup gerado fica listado pra restauração', J((await req('GET', '/api/admin/backup', { cookie: ac })).body).itens.some((b) => b.storedFile === r.backup));

    console.log(`\n=== ${pass} passou, ${fail} falhou ===`);
  } catch (e) {
    console.error('ERRO', e); fail++;
  } finally {
    await derrubar();
  }
  process.exit(fail ? 1 : 0);
})();
