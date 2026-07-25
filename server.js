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
      imgSrc: ["'self'", 'data:', 'blob:', 'https://res.cloudinary.com'], // blob: = miniatura local antes do envio
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
// cadastro público (sign up): evita criação de conta em massa por IP
const signupLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 20,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Muitos cadastros deste endereço. Tente de novo mais tarde.' },
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
// permissão granular de admin: '*' (crachá/acesso total) passa em tudo
const requirePerm = (perm) => (req, res, next) => {
  if (req.user.role !== 'admin' || !db.temPerm(req.user, perm))
    return res.status(403).json({ error: 'Você não tem permissão pra isso. Peça a um admin com acesso total (ou valide um crachá).' });
  next();
};

// ---------- auth ----------
app.post('/api/login', loginLimiter, ah(async (req, res) => {
  const { email, password } = req.body;
  const u = await db.findUserByEmail(email || '');
  if (!u || !(await db.checkPassword(u, password || '')))
    return res.status(401).json({ error: 'E-mail ou senha incorretos' });
  // cadastro público ainda não aprovado: avisa (só DEPOIS de conferir a senha, pra não vazar nada)
  if (u.pendingApproval)
    return res.status(403).json({ error: 'Sua conta ainda está aguardando aprovação de um administrador. Você será avisado quando liberar.' });
  if (!u.active) return res.status(401).json({ error: 'E-mail ou senha incorretos' }); // banido: resposta genérica
  setAuthCookie(res, u);
  res.json({ role: u.role, name: u.name, mustChangePassword: !!u.mustChangePassword });
}));

// ---------- cadastro público (sign up) ----------
// dados fixos que a tela de cadastro precisa antes do login (só constantes de domínio)
app.get('/api/signup-info', (req, res) => res.json({ regioes: db.REGIOES }));

// cria conta de PROMOTOR aguardando aprovação — um admin ativa na aba Contas.
// role é sempre promotor (admin só nasce pelo painel); a pessoa já define a própria senha.
app.post('/api/signup', signupLimiter, ah(async (req, res) => {
  try {
    const { name, email, password, telefone, grupo, regiao } = req.body;
    if (!String(name || '').trim()) return res.status(400).json({ error: 'Informe seu nome completo' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim())) return res.status(400).json({ error: 'E-mail inválido' });
    if (String(password || '').length < 6) return res.status(400).json({ error: 'A senha precisa de ao menos 6 caracteres' });
    if (regiao && !db.REGIOES.some((r) => r.sigla === regiao)) return res.status(400).json({ error: 'Região inválida' });
    await db.createUser({ email, name, password, role: 'promotor', telefone, grupo, regiao, pendingApproval: true });
    res.json({ ok: true, pending: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
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
    const link = `${base}/pdv/redefinir.html?token=${info.token}`;
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
    setor: req.user.setor || '', matricula: req.user.matricula ?? null,
    permissions: db.permissoesDe(req.user),
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

// admin define as senhas atuais (mensal/semanal) — vira entrada programada com início hoje
app.patch('/api/admin/config', requireAuth, requirePerm('listas'), ah(async (req, res) => {
  try { res.json(await db.setConfig(req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
}));
// senhas programadas por data: {inicio -> senha} por tipo; o servidor escolhe a vigente sozinho
app.get('/api/admin/senhas', requireAuth, requirePerm('listas'), ah(async (req, res) => res.json(await db.listSenhasProg())));
app.post('/api/admin/senhas', requireAuth, requirePerm('listas'), ah(async (req, res) => {
  try {
    await db.addSenhaProg(req.body.tipo, req.body.inicio, req.body.senha);
    res.json(await db.listSenhasProg());
  } catch (e) { res.status(400).json({ error: e.message }); }
}));
app.delete('/api/admin/senhas', requireAuth, requirePerm('listas'), ah(async (req, res) => {
  try {
    await db.delSenhaProg(req.body.tipo, req.body.inicio);
    res.json(await db.listSenhasProg());
  } catch (e) { res.status(400).json({ error: e.message }); }
}));
// importa a planilha "LISTA DE SENHAS SEMANAIS" da equipe: tabela com a coluna da senha
// (ex: "LISTA DE PRODUTOS") + "PERÍODO_INÍCIO" (data em que passa a valer). Se achar a
// célula "Senha Atual do Mês", programa a mensal valendo a partir de hoje.
app.post('/api/admin/senhas/import', requireAuth, requirePerm('listas'), ah(async (req, res) => {
  try {
    if (!req.body.file) return res.status(400).json({ error: 'Nenhum arquivo recebido' });
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(Buffer.from(String(req.body.file), 'base64')); }
    catch { return res.status(400).json({ error: 'Arquivo inválido — envie uma planilha .xlsx' }); }

    // célula -> 'YYYY-MM-DD' (aceita data do Excel ou texto dd/mm/aaaa)
    const celData = (v) => {
      if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
      const m = celTxt(v).match(/(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{2,4})/);
      if (!m) return null;
      return `${m[3].length === 2 ? '20' + m[3] : m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    };

    const semanais = [];
    let mensal = null, ignoradas = 0;
    for (const ws of wb.worksheets) {
      // cabeçalho da tabela nas 10 primeiras linhas: coluna da senha + coluna do início
      let colSenha, colInicio, headerRow = 0;
      for (let r = 1; r <= 10 && colInicio === undefined; r++) {
        colSenha = colInicio = undefined;
        const row = ws.getRow(r);
        for (let c = 1; c <= 30; c++) {
          const h = semAcento(celTxt(row.getCell(c).value)).toLowerCase();
          if (!h) continue;
          if (colInicio === undefined && /inicio/.test(h)) colInicio = c;
          if (colSenha === undefined && /produto|senha|lista/.test(h) && !/periodo|mes\b/.test(h)) colSenha = c;
        }
        headerRow = r;
      }
      if (colSenha !== undefined && colInicio !== undefined) {
        for (let r = headerRow + 1; r <= Math.min(ws.actualRowCount, headerRow + 300); r++) {
          const row = ws.getRow(r);
          const senha = celTxt(row.getCell(colSenha).value).replace(/\s+/g, ' ').trim();
          const inicio = celData(row.getCell(colInicio).value);
          if (!senha && !inicio) continue;      // linha em branco
          if (!senha || !inicio) { ignoradas++; continue; } // meia-linha (data sem senha ou vice-versa)
          semanais.push({ inicio, senha: senha.toUpperCase() });
        }
      }
      // "Senha Atual do Mês": o valor fica na célula de baixo ou ao lado do rótulo
      if (!mensal) {
        busca:
        for (let r = 1; r <= Math.min(ws.actualRowCount, 60); r++) {
          const row = ws.getRow(r);
          for (let c = 1; c <= 30; c++) {
            const h = semAcento(celTxt(row.getCell(c).value)).toLowerCase();
            if (!/senha (atual )?(do )?(mes|mensal)/.test(h)) continue;
            const v = (celTxt(ws.getRow(r + 1).getCell(c).value) || celTxt(row.getCell(c + 1).value)).trim();
            if (v) { mensal = v.toUpperCase(); break busca; }
          }
        }
      }
    }
    if (!semanais.length && !mensal) {
      return res.status(400).json({ error: 'Não achei a tabela de senhas — a planilha precisa de uma coluna com a senha ' +
        '(ex: "LISTA DE PRODUTOS") e uma coluna "PERÍODO_INÍCIO" com a data em que cada senha começa a valer.' });
    }
    for (const s of semanais) await db.addSenhaProg('semanal', s.inicio, s.senha);
    if (mensal) await db.addSenhaProg('mensal', db.hojeBR(), mensal);
    res.json({ semanais, mensal, ignoradas, tabela: await db.listSenhasProg() });
  } catch (e) { res.status(400).json({ error: e.message }); }
}));

// promotor cadastra um nome novo (não está no banco) -> fila de aprovação
app.post('/api/promotor-pendente', requireAuth, ah(async (req, res) => {
  try { res.json(await db.addPendente(req.body.nome, req.user.email)); }
  catch (e) { res.status(400).json({ error: e.message }); }
}));
app.get('/api/admin/pendentes', requireAuth, requirePerm('aprovar'), ah(async (req, res) => res.json(await db.listPendentes())));
app.post('/api/admin/pendentes/:id/aprovar', requireAuth, requirePerm('aprovar'), ah(async (req, res) => {
  try { res.json({ nome: await db.aprovarPendente(req.params.id) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
}));
app.delete('/api/admin/pendentes/:id', requireAuth, requirePerm('aprovar'), ah(async (req, res) => {
  await db.rejeitarPendente(req.params.id); res.json({ ok: true });
}));

// ---------- admin: contas de promotor ----------
app.get('/api/admin/users', requireAuth, requirePerm('contas'), ah(async (req, res) => res.json(await db.listUsers())));
// contagem leve pro badge de cadastros aguardando aprovação (evita puxar a lista inteira no polling)
app.get('/api/admin/signup-count', requireAuth, requirePerm('contas'), ah(async (req, res) => res.json({ count: await db.countPendingSignups() })));
app.post('/api/admin/users', requireAuth, requirePerm('contas'), ah(async (req, res) => {
  try {
    const { email, name, password, role, mustChangePassword, grupo, regiao, telefone, setor, matricula, permissions } = req.body;
    if (!email || !name || !password) return res.status(400).json({ error: 'Preencha email, nome e senha' });
    // só quem tem acesso total consegue já criar um admin COM permissões; senão nasce sem nenhuma
    const perms = db.temPerm(req.user, '*') ? permissions : [];
    // senha "0" = a pessoa cria a própria senha no 1º acesso (tela de boas-vindas) — troca sempre obrigatória
    res.json(await db.createUser({ email, name, password, role, mustChangePassword: mustChangePassword || password === '0',
      grupo, regiao, telefone, setor, matricula, permissions: perms }));
  } catch (e) { res.status(400).json({ error: e.message }); }
}));
// importa contas em massa a partir de uma planilha .xlsx (arquivo em base64 no JSON).
// Acha as colunas pelo cabeçalho: Nome e E-mail obrigatórias; Telefone, Grupo, Região,
// Setor, Matrícula, Tipo e Senha opcionais. E-mail novo cria a conta com senha provisória
// (troca obrigatória no 1º login); e-mail já cadastrado só tem o perfil atualizado.
const celTxt = (v) => {
  if (v == null) return '';
  if (typeof v === 'object') return v.text || (v.result !== undefined ? String(v.result) : (v.richText ? v.richText.map((t) => t.text).join('') : ''));
  return String(v);
};
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const IMPORT_MAX_LINHAS = 500; // bcrypt leva ~80ms por senha — acima disso a requisição estoura o tempo
app.post('/api/admin/users/import', requireAuth, requirePerm('contas'), ah(async (req, res) => {
  try {
    if (!req.body.file) return res.status(400).json({ error: 'Nenhum arquivo recebido' });
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(Buffer.from(String(req.body.file), 'base64')); }
    catch { return res.status(400).json({ error: 'Arquivo inválido — envie uma planilha .xlsx' }); }

    const CAMPOS = [
      ['email', /e-?mail/], ['name', /nome/], ['telefone', /telefone|celular|fone/],
      ['grupo', /grupo/], ['regiao', /regi/], ['setor', /setor/],
      ['matricula', /matr/], ['role', /tipo|perfil|cargo/], ['senha', /senha/],
    ];
    const linhas = new Map(); // email -> dados (repetido na planilha: a primeira linha vale)
    // teto de linhas VARRIDAS: sem isso, uma planilha gigante (mesmo abaixo do 1MB do corpo)
    // faria a leitura síncrona travar o event loop por dezenas de segundos antes do corte de 500
    const MAX_VARRER = IMPORT_MAX_LINHAS * 20;
    let varridas = 0, demais = false;
    for (const ws of wb.worksheets) {
      if (demais) break;
      // procura o cabeçalho nas 3 primeiras linhas da aba
      let cols = {}, headerRow = 0;
      for (let r = 1; r <= 3 && cols.email === undefined; r++) {
        cols = {};
        const row = ws.getRow(r);
        for (let c = 1; c <= 30; c++) {
          const h = semAcento(celTxt(row.getCell(c).value)).toLowerCase().trim();
          if (!h) continue;
          for (const [campo, re] of CAMPOS) if (cols[campo] === undefined && re.test(h)) cols[campo] = c;
        }
        headerRow = r;
      }
      if (cols.email === undefined || cols.name === undefined) continue; // aba sem Nome/E-mail
      for (let r = headerRow + 1; r <= ws.actualRowCount; r++) {
        // corta cedo: passou do limite de contas OU varreu linhas demais → para na hora
        if (linhas.size > IMPORT_MAX_LINHAS || ++varridas > MAX_VARRER) { demais = true; break; }
        const row = ws.getRow(r), d = { linha: `aba "${ws.name}", linha ${r}` };
        for (const [campo] of CAMPOS) if (cols[campo] !== undefined) d[campo] = celTxt(row.getCell(cols[campo]).value).replace(/\s+/g, ' ').trim();
        d.email = String(d.email || '').toLowerCase();
        if (!d.email && !d.name) continue; // linha em branco
        if (!linhas.has(d.email)) linhas.set(d.email, d);
      }
    }
    if (demais) return res.status(400).json({ error: `Planilha grande demais — o máximo é ${IMPORT_MAX_LINHAS} contas por importação. Divida em mais de um arquivo.` });
    if (!linhas.size) return res.status(400).json({ error: 'Não achei as colunas "Nome" e "E-mail" na planilha (o cabeçalho precisa estar nas 3 primeiras linhas)' });

    const regiaoDe = (v) => {
      const alvo = semAcento(v).toUpperCase().trim();
      const r = db.REGIOES.find((x) => x.sigla === alvo || semAcento(x.nome).toUpperCase() === alvo);
      return r ? r.sigla : null;
    };
    const criados = [], atualizados = [], erros = [];
    for (const d of linhas.values()) {
      try {
        if (!/^[^\s@]+@[^\s@]+$/.test(d.email)) throw new Error('e-mail inválido'); // mesma regra do resto do app
        let regiao;
        if (d.regiao) {
          regiao = regiaoDe(d.regiao);
          if (!regiao) throw new Error(`região "${d.regiao}" inválida — use ${db.REGIOES.map((x) => x.sigla).join(', ')}`);
        }
        const existente = await db.findUserByEmail(d.email);
        if (existente) {
          const fields = {};
          for (const k of ['name', 'telefone', 'grupo', 'setor', 'matricula']) if (d[k]) fields[k] = d[k];
          if (regiao) fields.regiao = regiao;
          if (Object.keys(fields).length) await db.updateUser(existente.id, fields);
          atualizados.push({ name: existente.name, email: d.email });
        } else {
          if (!d.name) throw new Error('sem nome');
          const senha = d.senha || d.name.split(/\s+/)[0].toUpperCase() + new Date().getFullYear();
          const role = /adm/i.test(d.role || '') ? 'admin' : 'promotor';
          await db.createUser({ email: d.email, name: d.name, password: senha, role, mustChangePassword: true,
            grupo: d.grupo, regiao: regiao || '', telefone: d.telefone, setor: d.setor, matricula: d.matricula });
          criados.push({ name: d.name, email: d.email, senha, role });
        }
      } catch (e) { erros.push({ linha: d.linha, email: d.email, motivo: e.message }); }
    }
    res.json({ criados, atualizados, erros });
  } catch (e) { res.status(400).json({ error: e.message }); }
}));
// modelo de planilha pro import: a planilha nasce PROTEGIDA — cabeçalho e estrutura
// travados, só as células de preenchimento liberadas — com lista suspensa em Região e Tipo
app.get('/api/admin/users/import-template.xlsx', requireAuth, requirePerm('contas'), ah(async (req, res) => {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Memphis PDV';
  const ws = wb.addWorksheet('Contas');
  const COLS = [
    { h: 'Nome', w: 34, nota: 'OBRIGATÓRIO — nome completo.' },
    { h: 'E-mail', w: 32, nota: 'OBRIGATÓRIO — se o e-mail já tem conta, só o perfil é atualizado (a senha fica como está).' },
    { h: 'Telefone', w: 18, nota: 'Opcional — (00) 00000 0000 ou só números.' },
    { h: 'Grupo', w: 24, nota: 'Opcional — ex: CALMON.' },
    { h: 'Região', w: 12, nota: 'Opcional — escolha na setinha: NE, CN, SP, SE ou SUL.' },
    { h: 'Setor', w: 22, nota: 'Opcional — ex: Trade Marketing.' },
    { h: 'Matrícula', w: 12, nota: 'Opcional — número inteiro, não pode repetir entre contas. 0 ou em branco = sem matrícula (promotor não tem).' },
    { h: 'Tipo', w: 12, nota: 'Opcional — promotor (padrão) ou admin.' },
    { h: 'Senha', w: 18, nota: 'Opcional — em branco, vira a senha provisória PRIMEIRONOME+ano (troca obrigatória no 1º acesso). "0" = a pessoa entra com 0 e CRIA a própria senha numa tela de boas-vindas.' },
  ];
  const header = ws.getRow(1);
  COLS.forEach((c, i) => {
    ws.getColumn(i + 1).width = c.w;
    const cell = header.getCell(i + 1);
    cell.value = c.h;
    cell.note = c.nota;
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1C9CC0' } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  for (let r = 2; r <= IMPORT_MAX_LINHAS + 1; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= COLS.length; c++) {
      const cell = row.getCell(c);
      cell.protection = { locked: false }; // com a planilha protegida, só estas células aceitam edição
      if (c === 3 || c === 9) cell.numFmt = '@'; // telefone/senha como texto (não vira número)
    }
    row.getCell(5).dataValidation = { type: 'list', allowBlank: true, formulae: ['"NE,CN,SP,SE,SUL"'],
      showErrorMessage: true, errorTitle: 'Região inválida', error: 'Use NE, CN, SP, SE ou SUL.' };
    row.getCell(8).dataValidation = { type: 'list', allowBlank: true, formulae: ['"promotor,admin"'],
      showErrorMessage: true, errorTitle: 'Tipo inválido', error: 'Use promotor ou admin.' };
  }
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  // sem senha: trava contra edição acidental, mas dá pra desproteger na aba Revisão se precisar
  await ws.protect('', { selectLockedCells: true, selectUnlockedCells: true, formatColumns: true, formatRows: true, sort: true });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="modelo-contas-memphis.xlsx"');
  await wb.xlsx.write(res);
  res.end();
}));
// admin edita o perfil da conta (nome, email, grupo, região, telefone, setor, matrícula)
app.patch('/api/admin/users/:id', requireAuth, requirePerm('contas'), ah(async (req, res) => {
  try {
    const { name, email, grupo, regiao, telefone, setor, matricula } = req.body;
    res.json(await db.updateUser(req.params.id, { name, email, grupo, regiao, telefone, setor, matricula }));
  } catch (e) { res.status(400).json({ error: e.message }); }
}));
// configurar as permissões de um admin — só acesso total
app.patch('/api/admin/users/:id/permissions', requireAuth, requirePerm('*'), ah(async (req, res) => {
  try { res.json(await db.setPermissions(req.params.id, req.body.permissions)); }
  catch (e) { res.status(400).json({ error: e.message }); }
}));
// crachá de acesso total: gerar (só acesso total) e validar (qualquer admin)
app.post('/api/admin/cracha', requireAuth, requirePerm('*'), ah(async (req, res) =>
  res.json({ codigo: await db.gerarCracha() })));
app.post('/api/cracha/validar', requireAuth, ah(async (req, res) => {
  try { await db.validarCracha(req.user.id, req.body.codigo); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
}));
app.post('/api/admin/users/:id/password', requireAuth, requirePerm('contas'), ah(async (req, res) => {
  try { await db.setPassword(req.params.id, req.body.password); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
}));
app.post('/api/admin/users/:id/active', requireAuth, requirePerm('contas'), ah(async (req, res) => {
  try { await db.setUserActive(req.params.id, !!req.body.active); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
}));
app.delete('/api/admin/users/:id', requireAuth, requirePerm('contas'), ah(async (req, res) => {
  try { await db.deleteUser(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
}));

// ---------- admin: listas de referência (grupos/clientes/promotores) ----------
// importa grupos/promotores em massa por planilha .xlsx (base64 no JSON, como o import de contas).
// Acha as colunas "Grupos" e "Promotores" pelo cabeçalho (3 primeiras linhas de cada aba);
// só ADICIONA nomes novos — não remove nem altera o que já está na lista.
// PRECISA vir antes de /api/admin/ref/:type, senão "import" cai na rota genérica.
const REF_IMPORT_MAX = 3000; // nomes por lista numa importação
app.post('/api/admin/ref/import', requireAuth, requirePerm('listas'), ah(async (req, res) => {
  try {
    if (!req.body.file) return res.status(400).json({ error: 'Nenhum arquivo recebido' });
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(Buffer.from(String(req.body.file), 'base64')); }
    catch { return res.status(400).json({ error: 'Arquivo inválido — envie uma planilha .xlsx' }); }
    const grupos = [], promotores = [];
    // mesmo teto de varredura do import de contas: planilha gigante não trava o event loop
    const MAX_VARRER = REF_IMPORT_MAX * 4;
    let varridas = 0, demais = false;
    for (const ws of wb.worksheets) {
      if (demais) break;
      let cols = {}, headerRow = 0;
      for (let r = 1; r <= 3 && cols.grupos === undefined && cols.promotores === undefined; r++) {
        cols = {};
        const row = ws.getRow(r);
        for (let c = 1; c <= 30; c++) {
          const h = semAcento(celTxt(row.getCell(c).value)).toLowerCase().trim();
          if (!h) continue;
          if (cols.grupos === undefined && /grupo/.test(h)) cols.grupos = c;
          if (cols.promotores === undefined && /promotor/.test(h)) cols.promotores = c;
        }
        headerRow = r;
      }
      if (cols.grupos === undefined && cols.promotores === undefined) continue; // aba sem as colunas
      for (let r = headerRow + 1; r <= ws.actualRowCount; r++) {
        if (grupos.length > REF_IMPORT_MAX || promotores.length > REF_IMPORT_MAX || ++varridas > MAX_VARRER) { demais = true; break; }
        const row = ws.getRow(r);
        const pega = (c) => celTxt(row.getCell(c).value).replace(/\s+/g, ' ').trim();
        if (cols.grupos !== undefined) { const v = pega(cols.grupos); if (v) grupos.push(v); }
        if (cols.promotores !== undefined) { const v = pega(cols.promotores); if (v) promotores.push(v); }
      }
    }
    if (demais) return res.status(400).json({ error: `Planilha grande demais — o máximo é ${REF_IMPORT_MAX} nomes por lista numa importação. Divida em mais de um arquivo.` });
    if (!grupos.length && !promotores.length) return res.status(400).json({ error: 'Não achei nomes — a planilha precisa de uma coluna "Grupos" e/ou "Promotores" no cabeçalho (3 primeiras linhas), com um nome por linha embaixo' });
    res.json(await db.importRefItems({ grupos, promotores }));
  } catch (e) { res.status(400).json({ error: e.message }); }
}));
// modelo de planilha pro import das listas: mesma pegada do modelo de contas —
// nasce PROTEGIDA, cabeçalho travado com dica, só as células de preenchimento liberadas
app.get('/api/admin/ref/import-template.xlsx', requireAuth, requirePerm('listas'), ah(async (req, res) => {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Memphis PDV';
  const ws = wb.addWorksheet('Listas');
  const COLS = [
    { h: 'Grupos', w: 30, nota: 'Um grupo por linha — ex: CALMON. O que já existe na lista é ignorado (nada é removido).' },
    { h: 'Promotores', w: 38, nota: 'Um nome por linha — no banco fica em MAIÚSCULO. O que já existe é ignorado (nada é removido).' },
  ];
  const header = ws.getRow(1);
  COLS.forEach((c, i) => {
    ws.getColumn(i + 1).width = c.w;
    const cell = header.getCell(i + 1);
    cell.value = c.h;
    cell.note = c.nota;
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1C9CC0' } };
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
  });
  for (let r = 2; r <= REF_IMPORT_MAX + 1; r++) {
    const row = ws.getRow(r);
    for (let c = 1; c <= COLS.length; c++) {
      const cell = row.getCell(c);
      cell.protection = { locked: false }; // com a planilha protegida, só estas células aceitam edição
      cell.numFmt = '@'; // nome como texto (não vira número/data)
    }
  }
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  // sem senha: trava contra edição acidental, mas dá pra desproteger na aba Revisão se precisar
  await ws.protect('', { selectLockedCells: true, selectUnlockedCells: true, formatColumns: true, formatRows: true, sort: true });
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', 'attachment; filename="modelo-listas-memphis.xlsx"');
  await wb.xlsx.write(res);
  res.end();
}));
// limpar o banco de promotores inteiro — o front confirma com texto digitado e baixa backup antes
app.delete('/api/admin/ref/promotores/tudo', requireAuth, requirePerm('listas'), ah(async (req, res) => {
  try { res.json(await db.clearPromotores()); }
  catch (e) { res.status(400).json({ error: e.message }); }
}));
app.post('/api/admin/ref/:type', requireAuth, requirePerm('listas'), ah(async (req, res) => {
  try { res.json(await db.addRefItem(req.params.type, req.body.value)); }
  catch (e) { res.status(400).json({ error: e.message }); }
}));
app.delete('/api/admin/ref/:type', requireAuth, requirePerm('listas'), ah(async (req, res) => {
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
  // grupo que ainda não está na lista oficial vai pra fila de aprovação do admin
  // (aparece na aba "Aprovar" junto com os promotores pendentes)
  if ((grupo || '').trim()) db.addPendente(grupo.trim(), req.user.email, 'grupo').catch(() => {});
  res.json({ ok: true, count: 1, promotorNoBanco: existePromotor });
}));

app.get('/api/my/submissions', requireAuth, ah(async (req, res) =>
  res.json(await db.listSubmissions({ uploadedBy: req.user.id }))));

app.get('/api/admin/submissions', requireAuth, requirePerm('fotos'), ah(async (req, res) =>
  res.json(await db.listSubmissions(req.query))));

app.patch('/api/admin/submissions/:id', requireAuth, requirePerm('fotos'), ah(async (req, res) => {
  try { res.json(await db.updateSubmission(req.params.id, req.body)); }
  catch (e) { res.status(400).json({ error: e.message }); }
}));

// imagens de uma submissão (novo formato = array; fallback p/ registros antigos com storedFile único)
const imagensDe = (s) => (s.imagens && s.imagens.length
  ? s.imagens
  : (s.storedFile ? [{ storedFile: s.storedFile, resourceType: s.resourceType || 'image', originalName: s.originalName }] : []));

// excluir uma foto de vez (Mongo + todas as imagens no Cloudinary)
app.delete('/api/admin/submissions/:id', requireAuth, requirePerm('fotos'), ah(async (req, res) => {
  const s = await db.deleteSubmission(req.params.id);
  if (s) for (const img of imagensDe(s)) await store.remove(img.storedFile, img.resourceType || 'image');
  res.json({ ok: true });
}));

// ---------- aderência ----------
// números de participação do período (padrão: últimos 3 meses até hoje)
const ISO_DATA = /^\d{4}-\d{2}-\d{2}$/;
app.get('/api/admin/aderencia', requireAuth, requirePerm('aderencia'), ah(async (req, res) => {
  const hoje = db.hojeBR();
  const ate = ISO_DATA.test(req.query.ate || '') ? req.query.ate : hoje;
  const d = new Date(ate + 'T00:00:00Z');
  d.setUTCMonth(d.getUTCMonth() - 3);
  const de = ISO_DATA.test(req.query.de || '') ? req.query.de : d.toISOString().slice(0, 10);
  if (de > ate) return res.status(400).json({ error: 'A data inicial é depois da final' });
  res.json(await db.aderencia({ de, ate }));
}));

// ---------- ranking ----------
// admin marca 1º/2º/3º da edição (a exclusividade da posição é garantida no db)
app.post('/api/admin/ranking', requireAuth, requirePerm('fotos'), ah(async (req, res) => {
  try { res.json(await db.setRanking(req.body.id, req.body.pos)); }
  catch (e) { res.status(400).json({ error: e.message }); }
}));
// página do ranking: qualquer usuário logado vê os vencedores e as edições passadas
app.get('/api/ranking', requireAuth, ah(async (req, res) => res.json(await db.listRanking())));

app.get('/api/file/:id/:idx?', requireAuth, ah(async (req, res) => {
  const s = await db.getSubmission(req.params.id);
  if (!s) return res.status(404).end();
  // foto vencedora de ranking é visível pra todo usuário logado (página do ranking)
  if (req.user.role !== 'admin' && s.uploadedBy !== req.user.id && !(s.rankingPos >= 1)) return res.status(403).end();
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
app.get('/api/admin/download-manifest', requireAuth, requirePerm('fotos'), ah(async (req, res) => {
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
app.post('/api/admin/mark-downloaded', requireAuth, requirePerm('fotos'), ah(async (req, res) => {
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

app.get('/api/admin/export.xlsx', requireAuth, requirePerm('fotos'), ah(async (req, res) => {
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

app.post('/api/admin/purge', requireAuth, requirePerm('fotos'), ah(async (req, res) => {
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
