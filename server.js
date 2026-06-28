require('dotenv').config();
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const ExcelJS = require('exceljs');
const db = require('./lib/db');
const store = require('./lib/storage'); // Cloudinary
const mailer = require('./lib/mailer'); // envio de email (reset de senha)

const app = express();
app.set('trust proxy', 1); // atrás de proxy (Vercel/Discloud) — IP real via X-Forwarded-For
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.SESSION_SECRET || 'dev-secret-troque';
const COOKIE = 'mp_token';
const isProd = process.env.NODE_ENV === 'production';

// pastas permitidas pra upload direto (o navegador sobe a foto direto no Cloudinary)
const PASTAS = {
  fotos: 'memphis-pdv/fotos',
};

// headers de segurança (helmet) + CSP liberando só as origens que usamos (Cloudinary, Google Fonts)
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"], // a UI usa <script> inline
      scriptSrcAttr: ["'unsafe-inline'"], // e handlers inline (onclick/onchange/onload)
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com'],
      imgSrc: ["'self'", 'data:', 'https://res.cloudinary.com'],
      connectSrc: ["'self'", 'https://api.cloudinary.com', 'https://res.cloudinary.com'],
      objectSrc: ["'none'"],
      frameAncestors: ["'self'"],
      upgradeInsecureRequests: isProd ? [] : null,
    },
  },
}));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());

// anti-força-bruta: limita tentativas de login por IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 10,
  skipSuccessfulRequests: true, // só conta tentativas que FALHAM (não pune login certo de IP compartilhado)
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Muitas tentativas. Tente de novo em alguns minutos.' },
});
// recuperação de senha: anti-spam de email + anti-abuso
const resetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Muitas solicitações. Tente de novo em alguns minutos.' },
});

// ---------- JWT (cookie httpOnly, sem sessão em memória — serverless-ready) ----------
function setAuthCookie(res, user) {
  const token = jwt.sign({ uid: user.id, role: user.role }, JWT_SECRET, { expiresIn: '8h' });
  res.cookie(COOKIE, token, {
    httpOnly: true, sameSite: 'lax', secure: isProd, maxAge: 8 * 60 * 60 * 1000, path: '/',
  });
}

// wrapper p/ handlers async: encaminha erros pro middleware de erro
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// garante que o Mongo conectou/seedou antes de qualquer rota.
// lazy + cacheado: roda 1x por instância (ideal pra serverless e pra rodar local).
let _ready;
const ready = () => (_ready ||= db.init());
app.use(ah(async (req, res, next) => { await ready(); next(); }));

const requireAuth = ah(async (req, res, next) => {
  const token = req.cookies[COOKIE];
  if (!token) return res.status(401).json({ error: 'Não autenticado' });
  let payload;
  try { payload = jwt.verify(token, JWT_SECRET); }
  catch { return res.status(401).json({ error: 'Sessão expirada' }); }
  const u = await db.findUserById(payload.uid);
  if (!u || !u.active) return res.status(401).json({ error: 'Sessão inválida' });
  req.user = u;
  next();
});
function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Acesso restrito' });
  next();
}

// ---------- auth ----------
app.post('/api/login', loginLimiter, ah(async (req, res) => {
  const { email, password } = req.body;
  const u = await db.findUserByEmail(email || '');
  if (!u || !u.active || !db.checkPassword(u, password || ''))
    return res.status(401).json({ error: 'E-mail ou senha incorretos' });
  setAuthCookie(res, u);
  res.json({ role: u.role, name: u.name });
}));
app.post('/api/logout', (req, res) => { res.clearCookie(COOKIE, { path: '/' }); res.json({ ok: true }); });

// ---------- recuperação de senha (link de redefinição) ----------
app.post('/api/forgot-password', resetLimiter, ah(async (req, res) => {
  const info = await db.createResetToken(req.body.email);
  if (info) {
    const base = process.env.APP_URL || `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers.host}`;
    const link = `${base}/redefinir.html?token=${info.token}`;
    await mailer.sendResetEmail(info.email, link, info.name);
    // dev (fora de produção e sem SMTP): devolve o link pra dar pra testar
    if (!isProd && !mailer.configured) return res.json({ ok: true, devLink: link });
  }
  res.json({ ok: true }); // resposta sempre genérica (anti-enumeração de emails)
}));

app.post('/api/reset-password', resetLimiter, ah(async (req, res) => {
  try { await db.resetPasswordWithToken(req.body.token, req.body.password); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
}));
app.get('/api/me', requireAuth, (req, res) =>
  res.json({ id: req.user.id, email: req.user.email, name: req.user.name, role: req.user.role }));

// ---------- referência ----------
app.get('/api/reference', requireAuth, ah(async (req, res) => res.json(await db.reference())));

// checar nome do promotor contra o banco da empresa
app.get('/api/check-promotor', requireAuth, ah(async (req, res) => {
  const nome = req.query.nome || '';
  const [existe, sugestoes] = await Promise.all([db.promotorExiste(nome), db.sugerirPromotores(nome)]);
  res.json({ existe, sugestoes });
}));

// assinatura pro navegador subir arquivo DIRETO no Cloudinary
app.get('/api/upload-signature', requireAuth, ah(async (req, res) => {
  const folder = PASTAS[req.query.tipo];
  if (!folder) return res.status(400).json({ error: 'Tipo inválido' });
  res.json(store.signUpload({ folder }));
}));

// admin define as senhas atuais (mensal/semanal)
app.patch('/api/admin/config', requireAuth, requireAdmin, ah(async (req, res) => res.json(await db.setConfig(req.body))));

// promotor cadastra um nome novo (não está no banco) -> fila de aprovação
app.post('/api/promotor-pendente', requireAuth, ah(async (req, res) => {
  try { res.json(await db.addPendente(req.body.nome, req.user.email)); }
  catch (e) { res.status(400).json({ error: e.message }); }
}));
app.get('/api/admin/pendentes', requireAuth, requireAdmin, ah(async (req, res) => res.json(await db.listPendentes())));
app.post('/api/admin/pendentes/:id/aprovar', requireAuth, requireAdmin, ah(async (req, res) => {
  try { res.json({ nome: await db.aprovarPendente(req.params.id) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
}));
app.delete('/api/admin/pendentes/:id', requireAuth, requireAdmin, ah(async (req, res) => {
  await db.rejeitarPendente(req.params.id); res.json({ ok: true });
}));

// ---------- admin: contas de promotor ----------
app.get('/api/admin/users', requireAuth, requireAdmin, ah(async (req, res) => res.json(await db.listUsers())));
app.post('/api/admin/users', requireAuth, requireAdmin, ah(async (req, res) => {
  try {
    const { email, name, password, role } = req.body;
    if (!email || !name || !password) return res.status(400).json({ error: 'Preencha email, nome e senha' });
    res.json(await db.createUser({ email, name, password, role }));
  } catch (e) { res.status(400).json({ error: e.message }); }
}));
app.post('/api/admin/users/:id/password', requireAuth, requireAdmin, ah(async (req, res) => {
  try { await db.setPassword(req.params.id, req.body.password); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
}));
app.post('/api/admin/users/:id/active', requireAuth, requireAdmin, ah(async (req, res) => {
  try { await db.setUserActive(req.params.id, !!req.body.active); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
}));
app.delete('/api/admin/users/:id', requireAuth, requireAdmin, ah(async (req, res) => {
  try { await db.deleteUser(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
}));

// ---------- admin: listas de referência (grupos/clientes/promotores) ----------
app.post('/api/admin/ref/:type', requireAuth, requireAdmin, ah(async (req, res) => {
  try { res.json(await db.addRefItem(req.params.type, req.body.value)); }
  catch (e) { res.status(400).json({ error: e.message }); }
}));
app.delete('/api/admin/ref/:type', requireAuth, requireAdmin, ah(async (req, res) => {
  try { res.json(await db.removeRefItem(req.params.type, req.body.value)); }
  catch (e) { res.status(400).json({ error: e.message }); }
}));

// ---------- envio de fotos (promotor) — fotos já foram pro Cloudinary; aqui só os metadados ----------
app.post('/api/submissions', requireAuth, ah(async (req, res) => {
  const { cliente, endereco, regiao, promotor, grupo, dataExposicao } = req.body;
  const fotos = Array.isArray(req.body.fotos) ? req.body.fotos : [];
  // limpa do Cloudinary as fotos já enviadas, caso a gente rejeite o registro
  const limparOrfas = () => fotos.forEach((f) => f && f.publicId && store.remove(f.publicId, f.resourceType || 'image'));

  // só aceita IDs dentro da nossa pasta (anti-abuso)
  const validas = fotos.filter((f) => f && typeof f.publicId === 'string' && f.publicId.startsWith('memphis-pdv/fotos/'));
  if (validas.length !== fotos.length) { limparOrfas(); return res.status(400).json({ error: 'Foto inválida' }); }

  if (!cliente || !endereco || !regiao || !promotor || !dataExposicao) {
    limparOrfas();
    return res.status(400).json({ error: 'Preencha cliente, endereço, data da exposição, região e promotor' });
  }
  if (validas.length === 0) return res.status(400).json({ error: 'Envie ao menos 1 foto' });

  const jaTem = await db.countByPromotorCliente(promotor, cliente);
  if (jaTem + validas.length > db.LIMITE_FOTOS) {
    limparOrfas();
    return res.status(400).json({ error: `Limite de ${db.LIMITE_FOTOS} fotos por cliente. Esse cliente já tem ${jaTem}.` });
  }

  const { senhaMensal, senhaSemanal } = await db.getConfig();
  const existePromotor = await db.promotorExiste(promotor);
  for (const f of validas) {
    await db.addSubmission({
      storedFile: f.publicId, resourceType: f.resourceType || 'image',
      originalName: f.originalName || 'foto.jpg', mimeType: 'image/jpeg', size: f.bytes || 0,
      uploadedBy: req.user.id, uploadedByEmail: req.user.email,
      senhaMensal, senhaSemanal,
      cliente: cliente.trim(), endereco: endereco.trim(), regiao, promotor: promotor.trim(),
      grupo: (grupo || '').trim(), dataExposicao,
      promotorNoBanco: existePromotor,
    });
  }
  res.json({ ok: true, count: validas.length, promotorNoBanco: existePromotor });
}));

app.get('/api/my/submissions', requireAuth, ah(async (req, res) =>
  res.json(await db.listSubmissions({ uploadedBy: req.user.id }))));

app.get('/api/admin/submissions', requireAuth, requireAdmin, ah(async (req, res) =>
  res.json(await db.listSubmissions(req.query))));

app.patch('/api/admin/submissions/:id', requireAuth, requireAdmin, ah(async (req, res) => {
  try { res.json(await db.updateSubmission(req.params.id, req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
}));

// excluir uma foto de vez (Mongo + Cloudinary)
app.delete('/api/admin/submissions/:id', requireAuth, requireAdmin, ah(async (req, res) => {
  const s = await db.deleteSubmission(req.params.id);
  if (s && s.storedFile) await store.remove(s.storedFile, s.resourceType || 'image');
  res.json({ ok: true });
}));

app.get('/api/file/:id', requireAuth, ah(async (req, res) => {
  const s = await db.getSubmission(req.params.id);
  if (!s) return res.status(404).end();
  if (req.user.role !== 'admin' && s.uploadedBy !== req.user.id) return res.status(403).end();
  res.redirect(store.urlFor(s.storedFile, s.resourceType || 'image'));
}));

// ---------- helpers de export ----------
const sanitize = (n) => String(n).replace(/[^a-zA-Z0-9À-ÿ _.-]/g, '_').trim() || 'sem_nome';
function withRefs(rows) {
  const counters = {};
  return rows.map((s) => {
    counters[s.regiao] = (counters[s.regiao] || 0) + 1;
    const ref = `${s.regiao}${counters[s.regiao]}`;
    return { ...s, ref, pasta: `${ref} - ${s.cliente} - ${s.promotor}` };
  });
}

// ---------- ZIP no navegador (JSZip): o servidor só entrega o manifesto ----------
// (serverless-friendly: o pesado — baixar e zipar — acontece no navegador da equipe)
app.get('/api/admin/download-manifest', requireAuth, requireAdmin, ah(async (req, res) => {
  const onlyNew = req.query.onlyNew !== '0';
  // foto recusada (validado === false) não entra no download
  const lista = (await db.listSubmissions(onlyNew ? { status: 'novos' } : {})).filter((s) => s.validado !== false);
  const rows = withRefs(lista);
  const used = new Set();
  const items = rows.map((s) => {
    const ext = path.extname(s.originalName || '') || '.jpg';
    // pasta: Região / "REF - Cliente - Promotor" / foto.jpg (com dedupe)
    let pth = `${sanitize(s.regiao)}/${sanitize(s.pasta)}/foto${ext}`;
    let i = 1;
    while (used.has(pth)) pth = `${sanitize(s.regiao)}/${sanitize(s.pasta)}/foto_${i++}${ext}`;
    used.add(pth);
    return { id: s.id, url: store.urlFor(s.storedFile, s.resourceType || 'image'), path: pth };
  });
  res.json({ items, count: items.length });
}));

// marca como baixadas (o navegador chama depois de concluir o ZIP com sucesso)
app.post('/api/admin/mark-downloaded', requireAuth, requireAdmin, ah(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  if (ids.length) await db.markDownloaded(ids);
  res.json({ ok: true, count: ids.length });
}));

// ---------- EXPORT EXCEL (aba por região) ----------
app.get('/api/admin/export.xlsx', requireAuth, requireAdmin, ah(async (req, res) => {
  const rows = withRefs(await db.listSubmissions(req.query));
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Memphis PDV';

  const cols = [
    { header: 'Seq', key: 'seq', width: 6 },
    { header: 'REF', key: 'ref', width: 10 },
    { header: 'Data da Exposição', key: 'dataExp', width: 16 },
    { header: 'Cliente', key: 'cliente', width: 28 },
    { header: 'Endereço da Loja', key: 'endereco', width: 32 },
    { header: 'Promotor', key: 'promotor', width: 26 },
    { header: 'GRUPO', key: 'grupo', width: 18 },
    { header: 'Pré-Avaliação', key: 'preav', width: 14 },
    { header: 'Região', key: 'regiao', width: 8 },
    { header: 'COLAR EM PASTAS', key: 'pasta', width: 40 },
    { header: 'Ponto Extra', key: 'pontos', width: 28 },
    { header: 'Validado', key: 'validado', width: 10 },
    { header: 'Pago', key: 'pago', width: 8 },
    { header: 'Observação', key: 'obs', width: 30 },
    { header: 'Senha Mensal', key: 'sm', width: 14 },
    { header: 'Senha Semanal', key: 'ss', width: 14 },
    { header: 'Enviado em', key: 'data', width: 18 },
    { header: 'Promotor no banco?', key: 'noBanco', width: 16 },
  ];

  for (const reg of db.REGIOES) {
    const regRows = rows.filter((s) => s.regiao === reg.sigla);
    const ws = wb.addWorksheet(`${reg.nome} - ${reg.sigla}`);
    ws.columns = cols;
    ws.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
    ws.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1C9CC0' } };
    let seq = 1;
    for (const s of regRows) {
      ws.addRow({
        seq: seq++, ref: s.ref,
        dataExp: s.dataExposicao ? new Date(s.dataExposicao + 'T00:00').toLocaleDateString('pt-BR') : '',
        data: new Date(s.createdAt).toLocaleString('pt-BR'),
        cliente: s.cliente, endereco: s.endereco, promotor: s.promotor, grupo: s.grupo,
        preav: s.preAvaliacao, regiao: s.regiao, pasta: s.pasta,
        pontos: (s.pontosExtra || []).join(', '),
        validado: s.validado === true ? 'Sim' : s.validado === false ? 'Recusado' : '',
        pago: s.pago ? 'Sim' : '',
        obs: s.observacao, sm: s.senhaMensal, ss: s.senhaSemanal,
        noBanco: s.promotorNoBanco ? 'Sim' : 'NÃO',
      });
    }
    ws.autoFilter = { from: 'A1', to: { row: 1, column: cols.length } };
  }

  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="memphis-pdv-${new Date().toISOString().slice(0, 10)}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}));

app.post('/api/admin/purge', requireAuth, requireAdmin, ah(async (req, res) => {
  const removed = await db.purgeDownloaded();
  for (const s of removed) await store.remove(s.storedFile, s.resourceType || 'image');
  res.json({ removed: removed.length });
}));

app.use(express.static(path.join(__dirname, 'public')));

// middleware de erro (multer, async, etc.)
app.use((err, req, res, next) => {
  console.error('ERRO:', err.message);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message || 'Erro interno' });
});

// Rodando direto (local): conecta no Mongo e sobe o servidor HTTP.
// Na Vercel: server.js é importado como função (module.exports = app) e o
// middleware "ready" cuida da inicialização sob demanda — sem app.listen.
if (require.main === module) {
  ready()
    .then(() => app.listen(PORT, () => console.log(`\n  Memphis PDV em http://localhost:${PORT}\n`)))
    .catch((e) => { console.error('Falha ao iniciar (Mongo):', e.message); process.exit(1); });
}

module.exports = app;
