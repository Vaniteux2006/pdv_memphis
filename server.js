require('dotenv').config();
const path = require('path');
const zlib = require('zlib');
const express = require('express');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const ExcelJS = require('exceljs');
const db = require('./lib/db');
const store = require('./lib/storage'); // Cloudinary
const mailer = require('./lib/mailer'); // envio de email (reset de senha)

const app = express();
app.set('trust proxy', 1); // atrás de proxy (Vercel/Discloud) — IP real via X-Forwarded-For
// Discloud exige porta 8080 + host 0.0.0.0. PORT pode ser sobrescrita por env (ex: testes locais).
const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';
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

// ---- portão de concorrência: protege a memória em rajadas ----
// Processa no máximo GATE_MAX requisições de API ao mesmo tempo; as demais esperam numa
// fila leve (quase sem custo de memória). Acima do teto da fila, responde 503 na hora —
// degradar com aviso é melhor que estourar a RAM e derrubar o servidor pra todo mundo.
const GATE_MAX = 300, GATE_FILA_MAX = 8000;
let gateAtivos = 0; const gateFila = [];
function gateLibera() {
  for (;;) {
    const prox = gateFila.shift();
    if (!prox) { gateAtivos--; return; }
    if (prox.res.destroyed) continue; // cliente desistiu enquanto esperava — pula sem gastar a vaga
    prox.entra(); return;
  }
}
app.use('/api', (req, res, next) => {
  const entra = () => {
    let feito = false;
    const fim = () => { if (!feito) { feito = true; gateLibera(); } };
    res.on('finish', fim); res.on('close', fim);
    next();
  };
  if (gateAtivos < GATE_MAX) { gateAtivos++; entra(); }
  else if (gateFila.length < GATE_FILA_MAX) gateFila.push({ entra, res });
  else res.status(503).json({ error: 'Servidor ocupado. Tente novamente em instantes.' });
});

app.use(compression()); // gzip: o JSON da referência (2 mil promotores) cai de ~60KB pra ~10KB
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
  if (!u || !u.active || !(await db.checkPassword(u, password || '')))
    return res.status(401).json({ error: 'E-mail ou senha incorretos' });
  setAuthCookie(res, u);
  res.json({ role: u.role, name: u.name, mustChangePassword: !!u.mustChangePassword });
}));
app.post('/api/logout', (req, res) => { res.clearCookie(COOKIE, { path: '/' }); res.json({ ok: true }); });

// promotor troca a própria senha (obrigatório no 1º login)
app.post('/api/change-password', requireAuth, ah(async (req, res) => {
  try {
    await db.changeOwnPassword(req.user.id, req.body.currentPassword, req.body.newPassword);
    setAuthCookie(res, req.user); // renova o token
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
}));

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
  res.json({
    id: req.user.id, email: req.user.email, name: req.user.name, role: req.user.role,
    mustChangePassword: !!req.user.mustChangePassword,
    grupo: req.user.grupo || '', regiao: req.user.regiao || '', telefone: req.user.telefone || '',
  }));

// ---------- referência ----------
// referência pré-serializada e pré-gzipada: é o maior payload do app (banco de promotores
// inteiro) e todo usuário pede ao abrir — serializar por requisição estoura a memória em rajada.
// O buffer é UM só, compartilhado por todas as respostas, e renova quando o cache do db renova.
let refSer = { src: null, plain: null, gz: null };
app.get('/api/reference', requireAuth, ah(async (req, res) => {
  const ref = await db.reference();
  if (refSer.src !== ref) {
    const plain = Buffer.from(JSON.stringify(ref));
    refSer = { src: ref, plain, gz: zlib.gzipSync(plain) };
  }
  res.set('Content-Type', 'application/json; charset=utf-8');
  res.set('Vary', 'Accept-Encoding');
  if (/\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    res.set('Content-Encoding', 'gzip');
    return res.end(refSer.gz);
  }
  res.end(refSer.plain);
}));

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
    const { email, name, password, role, mustChangePassword, grupo, regiao, telefone } = req.body;
    if (!email || !name || !password) return res.status(400).json({ error: 'Preencha email, nome e senha' });
    res.json(await db.createUser({ email, name, password, role, mustChangePassword, grupo, regiao, telefone }));
  } catch (e) { res.status(400).json({ error: e.message }); }
}));
// admin edita o perfil da conta (nome, email, grupo, região, telefone)
app.patch('/api/admin/users/:id', requireAuth, requireAdmin, ah(async (req, res) => {
  try {
    const { name, email, grupo, regiao, telefone } = req.body;
    res.json(await db.updateUser(req.params.id, { name, email, grupo, regiao, telefone }));
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
  if (validas.length === 0) return res.status(400).json({ error: 'Envie ao menos 1 imagem' });
  // 1 FOTO = 1 ou 2 imagens (2 = "antes e depois")
  if (validas.length > db.IMAGENS_POR_FOTO) {
    limparOrfas();
    return res.status(400).json({ error: `No máximo ${db.IMAGENS_POR_FOTO} imagens por foto (antes e depois).` });
  }

  // trava pela DATA DA EXPOSIÇÃO: 1 foto/semana e 4 fotos/mês por promotor
  const semanaKey = db.semanaISO(dataExposicao), mesKey = db.mesDe(dataExposicao);
  if (!semanaKey) { limparOrfas(); return res.status(400).json({ error: 'Data de exposição inválida' }); }
  if ((await db.contarNaSemana(promotor, semanaKey)) >= db.LIMITE_SEMANAL) {
    limparOrfas();
    return res.status(400).json({ error: `Você já tem uma foto na semana dessa exposição (limite: ${db.LIMITE_SEMANAL}/semana).` });
  }
  if ((await db.contarNoMes(promotor, mesKey)) >= db.LIMITE_MENSAL) {
    limparOrfas();
    return res.status(400).json({ error: `Você já atingiu ${db.LIMITE_MENSAL} fotos no mês.` });
  }

  const { senhaMensal, senhaSemanal } = await db.getConfig();
  const existePromotor = await db.promotorExiste(promotor);
  await db.addSubmission({
    imagens: validas.map((f) => ({ storedFile: f.publicId, resourceType: f.resourceType || 'image', originalName: f.originalName || 'foto.jpg' })),
    uploadedBy: req.user.id, uploadedByEmail: req.user.email,
    senhaMensal, senhaSemanal,
    cliente: cliente.trim(), endereco: endereco.trim(), regiao, promotor: promotor.trim(),
    grupo: (grupo || '').trim(), dataExposicao,
    promotorNoBanco: existePromotor,
  });
  res.json({ ok: true, count: 1, promotorNoBanco: existePromotor });
}));

app.get('/api/my/submissions', requireAuth, ah(async (req, res) =>
  res.json(await db.listSubmissions({ uploadedBy: req.user.id }))));

app.get('/api/admin/submissions', requireAuth, requireAdmin, ah(async (req, res) =>
  res.json(await db.listSubmissions(req.query))));

app.patch('/api/admin/submissions/:id', requireAuth, requireAdmin, ah(async (req, res) => {
  try { res.json(await db.updateSubmission(req.params.id, req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
}));

// imagens de uma submissão (novo formato = array; fallback p/ registros antigos com storedFile único)
const imagensDe = (s) => (s.imagens && s.imagens.length
  ? s.imagens
  : (s.storedFile ? [{ storedFile: s.storedFile, resourceType: s.resourceType || 'image', originalName: s.originalName }] : []));

// excluir uma foto de vez (Mongo + todas as imagens no Cloudinary)
app.delete('/api/admin/submissions/:id', requireAuth, requireAdmin, ah(async (req, res) => {
  const s = await db.deleteSubmission(req.params.id);
  if (s) for (const img of imagensDe(s)) await store.remove(img.storedFile, img.resourceType || 'image');
  res.json({ ok: true });
}));

app.get('/api/file/:id/:idx?', requireAuth, ah(async (req, res) => {
  const s = await db.getSubmission(req.params.id);
  if (!s) return res.status(404).end();
  if (req.user.role !== 'admin' && s.uploadedBy !== req.user.id) return res.status(403).end();
  const imgs = imagensDe(s);
  const idx = Math.min(Math.max(parseInt(req.params.idx || '0', 10) || 0, 0), imgs.length - 1);
  if (!imgs[idx]) return res.status(404).end();
  res.redirect(store.urlFor(imgs[idx].storedFile, imgs[idx].resourceType || 'image'));
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
  const items = [];
  for (const s of rows) {
    const imgs = imagensDe(s);
    imgs.forEach((img, k) => {
      const ext = path.extname(img.originalName || '') || '.jpg';
      // pasta: Região / "REF - Cliente - Promotor" / foto.jpg (com sufixo se "antes e depois")
      const base = `${sanitize(s.regiao)}/${sanitize(s.pasta)}/foto${imgs.length > 1 ? '_' + (k + 1) : ''}`;
      let pth = base + ext;
      let i = 1;
      while (used.has(pth)) pth = `${base}_${i++}${ext}`;
      used.add(pth);
      items.push({ id: s.id, idx: k, url: store.urlFor(img.storedFile, img.resourceType || 'image'), path: pth });
    });
  }
  res.json({ items, count: items.length });
}));

// marca como baixadas (o navegador chama depois de concluir o ZIP com sucesso)
app.post('/api/admin/mark-downloaded', requireAuth, requireAdmin, ah(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
  if (ids.length) await db.markDownloaded(ids);
  res.json({ ok: true, count: ids.length });
}));

// ---------- EXPORT EXCEL: gera a planilha do ZERO no molde oficial (leve, sem template pesado) ----------
const COLUNAS_MODELO = ['Seq', 'REF', 'Data', 'Contato', 'Nome', 'Cliente', 'Promotor', 'GRUPO',
  'Pré-Avaliação', '*', 'Região', 'OBS', 'COLAR EM PASTAS', 'Semanas', 'Dias da semana'];
const LARGURAS = [6, 8, 11, 15, 22, 34, 34, 22, 15, 6, 8, 40, 55, 14, 16];
const semanaDoMes = (dateStr) => {
  const d = new Date(String(dateStr) + 'T00:00:00Z');
  return isNaN(d) ? '' : `${Math.ceil(d.getUTCDate() / 7)}ª Semana`;
};

app.get('/api/admin/export.xlsx', requireAuth, requireAdmin, ah(async (req, res) => {
  const rows = await db.listSubmissions(req.query);
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Memphis PDV';

  for (const reg of db.REGIOES) {
    const ws = wb.addWorksheet(`${reg.nome} - ${reg.sigla}`);
    LARGURAS.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

    // bloco-resumo: contagem por pré-avaliação (como no modelo)
    ws.getCell('G6').value = { formula: 'COUNTA(G8:G100000)' };
    db.PRE_AVALIACOES.forEach((pa, k) => {
      const r = 2 + k;
      ws.getCell(`C${r}`).value = { formula: `COUNTIFS(I:I,D${r})` };
      ws.getCell(`D${r}`).value = pa;
      const e = ws.getCell(`E${r}`); e.value = { formula: `IFERROR(C${r}/$G$6,0)` }; e.numFmt = '0%';
    });

    // cabeçalho na linha 7
    const header = ws.getRow(7);
    COLUNAS_MODELO.forEach((h, i) => { header.getCell(i + 1).value = h; });
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.eachCell((c) => {
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1C9CC0' } };
      c.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    });

    // dados a partir da linha 8 (mesmas fórmulas do modelo)
    rows.filter((s) => s.regiao === reg.sigla).forEach((s, i) => {
      const r = 8 + i, row = ws.getRow(r);
      row.getCell(1).value = i + 1;
      row.getCell(2).value = { formula: `K${r}&A${r}` };                                     // REF
      if (s.dataExposicao) { const c = row.getCell(3); c.value = new Date(s.dataExposicao + 'T00:00'); c.numFmt = 'd-mmm'; }
      row.getCell(6).value = s.cliente;
      row.getCell(7).value = s.promotor;
      row.getCell(8).value = s.grupo || '';
      row.getCell(9).value = s.preAvaliacao || '';
      row.getCell(10).value = { formula: `COUNTIFS($G$8:G${r},G${r})` };                     // *
      row.getCell(11).value = s.regiao;
      row.getCell(12).value = s.observacao || '';
      row.getCell(13).value = { formula: `B${r}&" - "&PROPER(LOWER(F${r}&" - "&G${r}))` };    // COLAR EM PASTAS
      row.getCell(14).value = semanaDoMes(s.dataExposicao);
      row.getCell(15).value = { formula: `IF(C${r}="","",PROPER(TEXT(C${r},"[$-416]dddd")))` }; // Dias da semana
    });

    ws.autoFilter = { from: 'A7', to: { row: 7, column: COLUNAS_MODELO.length } };
    ws.views = [{ state: 'frozen', ySplit: 7 }];
  }

  wb.calcProperties = wb.calcProperties || {};
  wb.calcProperties.fullCalcOnLoad = true;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="registro-clientes-${new Date().toISOString().slice(0, 10)}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
}));

app.post('/api/admin/purge', requireAuth, requireAdmin, ah(async (req, res) => {
  const removed = await db.purgeDownloaded();
  for (const s of removed) for (const img of imagensDe(s)) await store.remove(img.storedFile, img.resourceType || 'image');
  res.json({ removed: removed.length });
}));

app.use(express.static(path.join(__dirname, 'public')));

// middleware de erro (multer, async, etc.)
app.use((err, req, res, next) => {
  console.error('ERRO:', err.message);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message || 'Erro interno' });
});

// robustez: uma rejeição/exceção solta NÃO deve derrubar o servidor inteiro (só loga)
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', (e && e.message) || e));
process.on('uncaughtException', (e) => console.error('uncaughtException:', (e && e.message) || e));

// Rodando direto (Discloud/local): conecta no Mongo e sobe o servidor HTTP em 0.0.0.0:8080.
// Na Vercel: server.js é importado como função (module.exports = app) e o
// middleware "ready" cuida da inicialização sob demanda — sem app.listen.
if (require.main === module) {
  ready()
    .then(() => app.listen(PORT, HOST, () => console.log(`\n  Memphis PDV rodando em ${HOST}:${PORT}\n`)))
    .catch((e) => { console.error('Falha ao iniciar (Mongo):', e.message); process.exit(1); });
}

module.exports = app;
