// Camada de dados em MongoDB. Mesmas funções de antes, agora assíncronas.
// (substituiu o antigo banco em arquivo JSON do protótipo)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const cidades = require('./cities');
const { getDb } = require('./mongo');

// ---- constantes do domínio ----
const REGIOES = [
  { sigla: 'NE', nome: 'Nordeste' },
  { sigla: 'CN', nome: 'Centro Norte' },
  { sigla: 'SP', nome: 'São Paulo' },
  { sigla: 'SE', nome: 'Sudeste' },
  { sigla: 'SUL', nome: 'Sul' },
];
const PONTOS_EXTRA = ['Ilha de produtos', 'Display Exclusivo', 'Gôndola de caixa', 'Cross-merchandising', 'Antes e depois', 'Grande volume de produtos'];
const PRE_AVALIACOES = ['REGULAR', 'BOM', 'EXCELENTE'];
// permissões de conta admin. '*' = acesso total (crachá).
const PERMISSOES = [
  { id: 'fotos', nome: 'Fotos — avaliar, baixar, exportar, excluir' },
  { id: 'aprovar', nome: 'Aprovar promotores e grupos novos' },
  { id: 'contas', nome: 'Contas — criar e editar usuários' },
  { id: 'listas', nome: 'Listas e senhas — grupos, banco de promotores, config' },
  { id: 'aderencia', nome: 'Aderência — números de participação da campanha' },
];
const LIMITE_SEMANAL = 1;       // 1 foto por semana por promotor
const LIMITE_MENSAL = 4;        // 4 fotos por mês por promotor
const IMAGENS_POR_FOTO = 2;     // "antes e depois" = 1 foto com até 2 imagens

const nowISO = () => new Date().toISOString();
// normaliza p/ comparar e buscar: minúsculo, sem acento, espaços colapsados
const norm = (s) =>
  String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// telefone: no banco só dígitos; o front formata "(00) 00000 0000"
const soDigitos = (s) => String(s || '').replace(/\D/g, '').slice(0, 13);
// matrícula: INT (> 0) ou null quando vazia.
// "0" também vale como SEM matrícula (promotor não tem — aceita e não trava duplicado)
function parseMatricula(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(String(v).trim());
  if (!Number.isInteger(n) || n < 0) throw new Error('Matrícula precisa ser um número inteiro');
  return n === 0 ? null : n;
}
// filtra a lista de permissões pra só ids válidos ('*' = acesso total)
function permsValidadas(perms) {
  if (!Array.isArray(perms)) return [];
  if (perms.includes('*')) return ['*'];
  const ok = new Set(PERMISSOES.map((p) => p.id));
  return [...new Set(perms.filter((p) => ok.has(p)))];
}
// permissões efetivas: admin antigo (sem o campo) = acesso total, pra não travar ninguém no deploy
function permissoesDe(u) {
  if (!u || u.role !== 'admin') return [];
  if (!Array.isArray(u.permissions)) return ['*'];
  return u.permissions;
}
const temPerm = (u, p) => { const ps = permissoesDe(u); return ps.includes('*') || ps.includes(p); };

// chave da semana ISO (ex: "2026-W25") e do mês ("2026-06") a partir de "YYYY-MM-DD"
function semanaISO(dateStr) {
  const d = new Date(String(dateStr) + 'T00:00:00Z');
  if (isNaN(d)) return '';
  const dow = (d.getUTCDay() + 6) % 7;           // seg=0..dom=6
  d.setUTCDate(d.getUTCDate() - dow + 3);         // quinta desta semana
  const primeiraQui = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const semana = 1 + Math.round((d - primeiraQui) / 604800000);
  return `${d.getUTCFullYear()}-W${String(semana).padStart(2, '0')}`;
}
const mesDe = (dateStr) => String(dateStr || '').slice(0, 7); // "YYYY-MM"

function loadSeed() {
  const f = path.join(__dirname, '..', 'data', 'seed.json');
  if (fs.existsSync(f)) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch {} }
  return { promotores: [], grupos: [], clientes: [] };
}

// coleções (cacheadas)
let _cols = null;
async function cols() {
  if (_cols) return _cols;
  const db = await getDb();
  _cols = {
    users: db.collection('users'),
    submissions: db.collection('submissions'),
    promotores: db.collection('promotores'),
    pendentes: db.collection('pendentes'),
    refdata: db.collection('refdata'),
    config: db.collection('config'),
  };
  return _cols;
}

// ---------- init / seed (chamar uma vez no boot) ----------
async function init() {
  const c = await cols();
  await Promise.all([
    c.users.createIndex({ emailLower: 1 }, { unique: true }),
    c.promotores.createIndex({ nomeNorm: 1 }, { unique: true }),
    c.submissions.createIndex({ id: 1 }, { unique: true }),
    c.submissions.createIndex({ regiao: 1 }),
    c.submissions.createIndex({ baixado: 1 }),
    c.submissions.createIndex({ searchBlob: 1 }),
    c.submissions.createIndex({ createdAt: -1 }),
    c.submissions.createIndex({ dataExposicao: 1 }), // filtros de período + agregação da aderência
  ]);

  // pendentes agora tem "tipo" (promotor | grupo): migra os antigos e troca o índice único
  await c.pendentes.updateMany({ tipo: { $exists: false } }, { $set: { tipo: 'promotor' } });
  await c.pendentes.dropIndex('nomeNorm_1').catch(() => {}); // índice antigo, se existir
  await c.pendentes.createIndex({ tipo: 1, nomeNorm: 1 }, { unique: true });

  const seed = loadSeed();
  // admin
  if (!(await c.users.findOne({ role: 'admin' }))) {
    await c.users.insertOne({
      id: crypto.randomUUID(), email: 'admin@local', emailLower: 'admin@local',
      name: 'Administrador', role: 'admin', passwordHash: bcrypt.hashSync('admin123', 10),
      active: true, createdAt: nowISO(),
      setor: 'Administração', matricula: null, telefone: '', permissions: ['*'],
    });
    console.log('>>> Admin criado: admin@local / admin123');
  }
  // banco de promotores
  if ((await c.promotores.estimatedDocumentCount()) === 0 && seed.promotores.length) {
    const docs = [...new Set(seed.promotores.map((p) => p.toUpperCase()))]
      .map((nome) => ({ id: crypto.randomUUID(), nome, nomeNorm: norm(nome) }));
    // dedup por nomeNorm
    const seen = new Set(); const uniq = [];
    for (const d of docs) if (!seen.has(d.nomeNorm)) { seen.add(d.nomeNorm); uniq.push(d); }
    await c.promotores.insertMany(uniq, { ordered: false }).catch(() => {});
    console.log(`>>> ${uniq.length} promotores seedados`);
  }
  // listas (grupos/clientes)
  if (!(await c.refdata.findOne({ _id: 'singleton' }))) {
    await c.refdata.insertOne({ _id: 'singleton', grupos: seed.grupos || [], clientes: seed.clientes || [] });
  }
  // config (senhas)
  if (!(await c.config.findOne({ _id: 'singleton' }))) {
    await c.config.insertOne({ _id: 'singleton', senhaMensal: 'FEIJÃO', senhaSemanal: 'PIPOCA' });
  }
}

// ---------- usuários ----------
// cache curto do usuário autenticado: TODA requisição logada busca o usuário no banco
// (requireAuth); sem cache, uma rajada de acessos vira milhares de idas ao Atlas.
// TTL de 20s e limpeza em qualquer mutação de usuário — ban/troca de senha valem em até 20s.
const USER_TTL = 20 * 1000;
const userCache = new Map(); // id -> { u, exp }
const limpaCacheUsers = () => userCache.clear();

async function findUserByEmail(email) {
  const c = await cols();
  return c.users.findOne({ emailLower: String(email || '').toLowerCase().trim() });
}
async function findUserById(id) {
  const hit = userCache.get(id);
  if (hit && hit.exp > Date.now()) return hit.u;
  const c = await cols();
  const u = await c.users.findOne({ id });
  if (u) {
    if (userCache.size > 20000) userCache.clear(); // teto de segurança
    userCache.set(id, { u, exp: Date.now() + USER_TTL });
  }
  return u;
}
function checkPassword(user, pw) {
  // assíncrono: compareSync travaria o event loop ~80ms por login — numa rajada de
  // logins simultâneos isso paralisa o servidor inteiro por vários segundos
  return bcrypt.compare(pw, user.passwordHash);
}
async function listUsers() {
  const c = await cols();
  // admins primeiro, depois promotores, em ordem alfabética
  return c.users.find({}, { projection: { passwordHash: 0, _id: 0 } }).sort({ role: 1, name: 1 }).toArray();
}
// quantos cadastros públicos (sign up) aguardam aprovação — alimenta o badge do painel
async function countPendingSignups() {
  const c = await cols();
  return c.users.countDocuments({ pendingApproval: true });
}
// pendingApproval: conta criada pelo cadastro público (sign up) — nasce inativa e
// só passa a logar depois que um admin aprovar (setUserActive true limpa a flag)
async function createUser({ email, name, password, role, mustChangePassword, grupo, regiao, telefone, setor, matricula, permissions, pendingApproval }) {
  role = role === 'admin' ? 'admin' : 'promotor';
  const c = await cols();
  const emailLower = String(email).toLowerCase().trim();
  if (await c.users.findOne({ emailLower })) throw new Error('E-mail já cadastrado');
  const mat = parseMatricula(matricula);
  if (mat !== null && (await c.users.findOne({ matricula: mat }))) throw new Error('Matrícula já cadastrada');
  const user = {
    id: crypto.randomUUID(), email: email.trim(), emailLower, name: name.trim(),
    role, passwordHash: bcrypt.hashSync(password, 10), active: !pendingApproval,
    ...(pendingApproval ? { pendingApproval: true } : {}),
    mustChangePassword: !!mustChangePassword, createdAt: nowISO(),
    grupo: String(grupo || '').trim(), regiao: String(regiao || '').trim(), telefone: soDigitos(telefone),
    setor: String(setor || '').trim(), matricula: mat,
    // admin novo nasce SEM permissão nenhuma — quem tem acesso total configura (ou ele valida um crachá)
    ...(role === 'admin' ? { permissions: permsValidadas(permissions) } : {}),
  };
  await c.users.insertOne(user);
  const { passwordHash, _id, ...safe } = user;
  return safe;
}
// admin edita o perfil de uma conta (nome, email, grupo, região, telefone)
async function updateUser(id, fields) {
  const c = await cols();
  const u = await c.users.findOne({ id });
  if (!u) throw new Error('Usuário não encontrado');
  const set = {};
  for (const k of ['name', 'grupo', 'regiao', 'telefone', 'setor']) {
    if (fields[k] !== undefined) set[k] = String(fields[k]).trim();
  }
  if (set.telefone !== undefined) set.telefone = soDigitos(set.telefone);
  if (fields.matricula !== undefined) {
    const mat = parseMatricula(fields.matricula);
    if (mat !== null && (await c.users.findOne({ matricula: mat, id: { $ne: id } }))) throw new Error('Matrícula já cadastrada');
    set.matricula = mat;
  }
  if (set.name === '') throw new Error('O nome não pode ficar vazio');
  if (set.regiao && !REGIOES.some((r) => r.sigla === set.regiao)) throw new Error('Região inválida');
  if (fields.email !== undefined) {
    const email = String(fields.email).trim();
    if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new Error('E-mail inválido');
    const emailLower = email.toLowerCase();
    if (emailLower !== u.emailLower && (await c.users.findOne({ emailLower }))) throw new Error('E-mail já cadastrado');
    set.email = email; set.emailLower = emailLower;
  }
  if (Object.keys(set).length) { await c.users.updateOne({ id }, { $set: set }); limpaCacheUsers(); }
  const { passwordHash, _id, ...safe } = await c.users.findOne({ id });
  return safe;
}
// define senha provisória (por email) + exige troca no 1º login — usado no onboarding em massa
async function setProvisionalPassword(email, password) {
  const c = await cols();
  const r = await c.users.updateOne(
    { emailLower: String(email || '').toLowerCase().trim() },
    { $set: { passwordHash: bcrypt.hashSync(password, 10), mustChangePassword: true } }
  );
  limpaCacheUsers();
  return r.matchedCount > 0;
}
// promotor troca a própria senha (no 1º login obrigatório ou quando quiser)
async function changeOwnPassword(id, currentPassword, newPassword) {
  if (String(newPassword || '').length < 6) throw new Error('A nova senha precisa de ao menos 6 caracteres');
  const c = await cols();
  const u = await c.users.findOne({ id });
  if (!u) throw new Error('Usuário não encontrado');
  if (!bcrypt.compareSync(currentPassword || '', u.passwordHash)) throw new Error('Senha atual incorreta');
  await c.users.updateOne({ id }, { $set: { passwordHash: bcrypt.hashSync(newPassword, 10), mustChangePassword: false } });
  limpaCacheUsers();
}
async function setPassword(id, pw) {
  const c = await cols();
  const r = await c.users.updateOne({ id }, { $set: { passwordHash: bcrypt.hashSync(pw, 10) } });
  if (!r.matchedCount) throw new Error('Usuário não encontrado');
  limpaCacheUsers();
}
async function setUserActive(id, active) {
  const c = await cols();
  const u = await c.users.findOne({ id });
  if (!u) throw new Error('Usuário não encontrado');
  if (u.role === 'admin') throw new Error('Não dá pra banir o admin');
  // ativar também aprova cadastro pendente (sign up) — a mesma ação serve pros dois casos
  await c.users.updateOne({ id }, { $set: { active: !!active }, ...(active ? { $unset: { pendingApproval: '' } } : {}) });
  limpaCacheUsers();
}
async function deleteUser(id) {
  const c = await cols();
  const u = await c.users.findOne({ id });
  if (u && u.role === 'admin') throw new Error('Não dá pra apagar o admin');
  await c.users.deleteOne({ id });
  limpaCacheUsers();
}
// define as permissões de um admin (rota exige acesso total de quem chama)
async function setPermissions(id, perms) {
  const c = await cols();
  const u = await c.users.findOne({ id });
  if (!u) throw new Error('Usuário não encontrado');
  if (u.role !== 'admin') throw new Error('Permissões valem só pra contas de admin');
  await c.users.updateOne({ id }, { $set: { permissions: permsValidadas(perms) } });
  limpaCacheUsers();
  const { passwordHash, _id, ...safe } = await c.users.findOne({ id });
  return safe;
}

// ---------- recuperação de senha (link de redefinição) ----------
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

async function createResetToken(email) {
  const c = await cols();
  const u = await c.users.findOne({ emailLower: String(email || '').toLowerCase().trim() });
  if (!u || !u.active) return null; // não revela se o email existe
  const token = crypto.randomBytes(32).toString('hex'); // 256 bits
  await c.users.updateOne({ id: u.id }, { $set: { resetTokenHash: sha256(token), resetTokenExp: Date.now() + 60 * 60 * 1000 } });
  return { token, name: u.name, email: u.email };
}

async function resetPasswordWithToken(token, newPassword) {
  if (!token) throw new Error('Token ausente');
  if (String(newPassword || '').length < 6) throw new Error('A senha precisa de ao menos 6 caracteres');
  const c = await cols();
  const u = await c.users.findOne({ resetTokenHash: sha256(token), resetTokenExp: { $gt: Date.now() } });
  if (!u) throw new Error('Link inválido ou expirado');
  await c.users.updateOne(
    { id: u.id },
    { $set: { passwordHash: bcrypt.hashSync(newPassword, 10) }, $unset: { resetTokenHash: '', resetTokenExp: '' } } // uso único
  );
  limpaCacheUsers();
  return true;
}

// ---------- config (senhas) ----------
// As senhas mensal/semanal vivem numa TABELA PROGRAMADA {inicio -> senha} (uma por tipo):
// o servidor escolhe sozinho a vigente pela data (fuso de Brasília). O "trocar agora" da
// aba Listas vira uma entrada com inicio=hoje — o histórico fica registrado de graça.
// Os campos antigos senhaMensal/senhaSemanal seguem como fallback de dados pré-tabela.
const hojeBR = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' }); // YYYY-MM-DD
// vigente = entrada com o MAIOR inicio que já começou (inicio <= hoje)
function senhaVigente(lista, hoje = hojeBR()) {
  const v = (lista || []).filter((e) => e.inicio <= hoje).sort((a, b) => (a.inicio < b.inicio ? 1 : -1))[0];
  return v ? v.senha : null;
}
const CAMPO_PROG = { mensal: 'senhasProgMensal', semanal: 'senhasProgSemanal' };

// cache de 30s: o config é lido a cada envio de foto e a cada referência
let cfgCache = null, cfgCacheExp = 0, cfgEmVoo = null;
async function getConfig() {
  if (cfgCache && cfgCacheExp > Date.now()) return cfgCache;
  if (cfgEmVoo) return cfgEmVoo; // single-flight (mesma ideia da referência)
  cfgEmVoo = (async () => {
    const c = await cols();
    const doc = (await c.config.findOne({ _id: 'singleton' })) || {};
    cfgCache = {
      ...doc,
      // efetivas: a programada vigente ganha; sem nenhuma vigente, vale o campo manual antigo
      senhaMensal: senhaVigente(doc.senhasProgMensal) ?? doc.senhaMensal ?? '',
      senhaSemanal: senhaVigente(doc.senhasProgSemanal) ?? doc.senhaSemanal ?? '',
    };
    cfgCacheExp = Date.now() + 30 * 1000;
    return cfgCache;
  })().finally(() => { cfgEmVoo = null; });
  return cfgEmVoo;
}
async function setConfig({ senhaMensal, senhaSemanal }) {
  // "salvar senhas" = programar a partir de hoje (campo vazio é ignorado; pra apagar, remova a entrada)
  const hoje = hojeBR();
  if (String(senhaMensal || '').trim()) await addSenhaProg('mensal', hoje, senhaMensal);
  if (String(senhaSemanal || '').trim()) await addSenhaProg('semanal', hoje, senhaSemanal);
  return getConfig();
}
async function listSenhasProg() {
  const c = await cols();
  const doc = (await c.config.findOne({ _id: 'singleton' })) || {};
  const desc = (l) => (l || []).slice().sort((a, b) => (a.inicio < b.inicio ? 1 : -1));
  const cfg = await getConfig();
  return {
    hoje: hojeBR(),
    mensal: desc(doc.senhasProgMensal), semanal: desc(doc.senhasProgSemanal),
    vigentes: { senhaMensal: cfg.senhaMensal, senhaSemanal: cfg.senhaSemanal },
  };
}
async function addSenhaProg(tipo, inicio, senha) {
  const campo = CAMPO_PROG[tipo];
  if (!campo) throw new Error('Tipo inválido (mensal ou semanal)');
  inicio = String(inicio || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inicio) || isNaN(new Date(inicio + 'T00:00'))) throw new Error('Data de início inválida');
  senha = String(senha || '').trim();
  if (!senha) throw new Error('Informe a senha');
  const c = await cols();
  // mesma data = substitui (uma senha por data de início)
  await c.config.updateOne({ _id: 'singleton' }, { $pull: { [campo]: { inicio } } }, { upsert: true });
  await c.config.updateOne({ _id: 'singleton' }, { $push: { [campo]: { inicio, senha } } });
  cfgCache = null; cfgCacheExp = 0;
  limpaCacheRef();
}
async function delSenhaProg(tipo, inicio) {
  const campo = CAMPO_PROG[tipo];
  if (!campo) throw new Error('Tipo inválido (mensal ou semanal)');
  const c = await cols();
  await c.config.updateOne({ _id: 'singleton' }, { $pull: { [campo]: { inicio: String(inicio) } } });
  cfgCache = null; cfgCacheExp = 0;
  limpaCacheRef();
}

// ---------- crachá (acesso total) ----------
// Um código único vale pra empresa toda; no banco fica só o hash (como senha).
// Gerar um crachá novo invalida o anterior. Validar o crachá dá acesso total à conta admin.
async function gerarCracha() {
  const c = await cols();
  const codigo = 'MPDV-' + crypto.randomBytes(16).toString('hex').toUpperCase();
  await c.config.updateOne(
    { _id: 'singleton' },
    { $set: { crachaHash: sha256(codigo), crachaGeradoEm: nowISO() } },
    { upsert: true }
  );
  cfgCache = null; cfgCacheExp = 0;
  return codigo; // mostrado UMA vez — não dá pra recuperar depois
}
async function validarCracha(userId, codigo) {
  const c = await cols();
  const cfg = await c.config.findOne({ _id: 'singleton' });
  if (!cfg || !cfg.crachaHash) throw new Error('Nenhum crachá foi gerado ainda');
  if (sha256(String(codigo || '').trim()) !== cfg.crachaHash) throw new Error('Crachá inválido');
  const u = await c.users.findOne({ id: userId });
  if (!u || u.role !== 'admin') throw new Error('O crachá vale só pra contas de admin');
  await c.users.updateOne({ id: userId }, { $set: { permissions: ['*'] } });
  limpaCacheUsers();
}

// ---------- referência ----------
// cache de 30s: a referência carrega o banco inteiro de promotores (2 mil nomes) e é
// pedida por TODO usuário ao abrir o app — sem cache, uma rajada derruba o servidor.
// mutações de lista/config/pendente limpam o cache na hora.
let refCache = null, refCacheExp = 0, refEmVoo = null;
const limpaCacheRef = () => { refCache = null; refCacheExp = 0; };

async function reference() {
  if (refCache && refCacheExp > Date.now()) return refCache;
  // single-flight: se mil usuários pedem ao mesmo tempo com o cache vencido,
  // UMA busca vai ao banco e todo mundo espera a mesma promise (evita a "manada")
  if (refEmVoo) return refEmVoo;
  refEmVoo = (async () => {
    const c = await cols();
    const [rd, cfg, proms] = await Promise.all([
      c.refdata.findOne({ _id: 'singleton' }),
      getConfig(),
      c.promotores.find({}, { projection: { nome: 1, _id: 0 } }).sort({ nome: 1 }).toArray(),
    ]);
    const cmp = (a, b) => a.localeCompare(b, 'pt-BR');
    refCache = {
      // pontos extra: lista editável (aba Listas); enquanto ninguém mexeu, vale a padrão
      regioes: REGIOES, pontosExtra: Array.isArray(rd?.pontosExtra) ? rd.pontosExtra : PONTOS_EXTRA,
      preAvaliacoes: PRE_AVALIACOES, cidades,
      permissoes: PERMISSOES,
      grupos: (rd?.grupos || []).slice().sort(cmp),
      clientes: (rd?.clientes || []).slice().sort(cmp),
      promotores: proms.map((p) => p.nome),
      limiteSemanal: LIMITE_SEMANAL, limiteMensal: LIMITE_MENSAL, imagensPorFoto: IMAGENS_POR_FOTO,
      senhas: { senhaMensal: cfg.senhaMensal, senhaSemanal: cfg.senhaSemanal },
    };
    refCacheExp = Date.now() + 30 * 1000;
    return refCache;
  })().finally(() => { refEmVoo = null; });
  return refEmVoo;
}

async function promotorExiste(nome) {
  const c = await cols();
  return !!(await c.promotores.findOne({ nomeNorm: norm(nome) }));
}
async function sugerirPromotores(nome, limit = 8) {
  const n = norm(nome);
  if (n.length < 2) return [];
  const c = await cols();
  const rows = await c.promotores.find({ nomeNorm: { $regex: escRe(n) } }, { projection: { nome: 1, nomeNorm: 1, _id: 0 } }).limit(40).toArray();
  // prefixo primeiro, depois "contém"
  rows.sort((a, b) => (b.nomeNorm.startsWith(n) ? 1 : 0) - (a.nomeNorm.startsWith(n) ? 1 : 0));
  return rows.slice(0, limit).map((r) => r.nome);
}

// ---------- listas editáveis ----------
async function addRefItem(type, value) {
  const c = await cols();
  value = String(value).trim();
  if (!value) throw new Error('Valor vazio');
  if (type === 'promotores') {
    const nomeNorm = norm(value);
    if (!(await c.promotores.findOne({ nomeNorm })))
      await c.promotores.insertOne({ id: crypto.randomUUID(), nome: value.toUpperCase(), nomeNorm });
    limpaCacheRef();
    return (await reference()).promotores;
  }
  if (type === 'grupos' || type === 'clientes') {
    await c.refdata.updateOne({ _id: 'singleton' }, { $addToSet: { [type]: value } }, { upsert: true });
    limpaCacheRef();
    return (await reference())[type];
  }
  if (type === 'pontosExtra') {
    await materializaPontosExtra(c);
    // dupe sem acento/maiúscula: "ilha de produtos" não vira um segundo "Ilha de produtos"
    const atual = (await reference()).pontosExtra;
    if (!atual.some((p) => norm(p) === norm(value))) {
      await c.refdata.updateOne({ _id: 'singleton' }, { $push: { pontosExtra: value } });
      limpaCacheRef();
    }
    return (await reference()).pontosExtra;
  }
  throw new Error('Lista inválida');
}
// a lista de pontos extra nasce como a constante padrão; na PRIMEIRA edição ela é
// gravada no refdata e daí em diante o banco é a fonte da verdade
async function materializaPontosExtra(c) {
  const rd = await c.refdata.findOne({ _id: 'singleton' }, { projection: { pontosExtra: 1 } });
  if (!rd || !Array.isArray(rd.pontosExtra)) {
    await c.refdata.updateOne({ _id: 'singleton' }, { $set: { pontosExtra: PONTOS_EXTRA } }, { upsert: true });
    limpaCacheRef();
  }
}
// import em massa (planilha da aba Listas): adiciona numa passada só o que ainda não existe
// (comparação sem acento/maiúscula) — sem bater no banco item a item como o addRefItem.
// Só ADICIONA, nunca remove. Nome importado sai da fila de aprovação (mesmo efeito de aprovar).
async function importRefItems({ grupos = [], promotores = [] }) {
  const c = await cols();
  const resultado = { grupos: { novos: 0, jaExistiam: 0 }, promotores: { novos: 0, jaExistiam: 0 } };
  if (grupos.length) {
    const rd = await c.refdata.findOne({ _id: 'singleton' });
    const vistos = new Set((rd?.grupos || []).map(norm));
    const novos = [];
    for (const v of grupos) {
      const n = norm(v);
      if (!n) continue;
      if (vistos.has(n)) { resultado.grupos.jaExistiam++; continue; }
      vistos.add(n); novos.push(String(v).trim());
    }
    resultado.grupos.novos = novos.length;
    if (novos.length) {
      await c.refdata.updateOne({ _id: 'singleton' }, { $addToSet: { grupos: { $each: novos } } }, { upsert: true });
      await c.pendentes.deleteMany({ tipo: 'grupo', nomeNorm: { $in: novos.map(norm) } });
    }
  }
  if (promotores.length) {
    const vistos = new Set((await c.promotores.find({}, { projection: { nomeNorm: 1, _id: 0 } }).toArray()).map((p) => p.nomeNorm));
    const docs = [];
    for (const v of promotores) {
      const n = norm(v);
      if (!n) continue;
      if (vistos.has(n)) { resultado.promotores.jaExistiam++; continue; }
      vistos.add(n);
      docs.push({ id: crypto.randomUUID(), nome: String(v).trim().toUpperCase(), nomeNorm: n });
    }
    resultado.promotores.novos = docs.length;
    if (docs.length) {
      await c.promotores.insertMany(docs);
      await c.pendentes.deleteMany({ tipo: 'promotor', nomeNorm: { $in: docs.map((d) => d.nomeNorm) } });
    }
  }
  limpaCacheRef();
  return resultado;
}
// apaga o banco de promotores INTEIRO (botão "limpar banco" da aba Listas).
// Os pendentes de aprovação ficam — continuam esperando a decisão do admin.
async function clearPromotores() {
  const c = await cols();
  const { deletedCount } = await c.promotores.deleteMany({});
  limpaCacheRef();
  return { apagados: deletedCount };
}
async function removeRefItem(type, value) {
  const c = await cols();
  if (type === 'promotores') {
    await c.promotores.deleteOne({ nomeNorm: norm(value) });
    limpaCacheRef();
    return (await reference()).promotores;
  }
  if (type === 'grupos' || type === 'clientes') {
    await c.refdata.updateOne({ _id: 'singleton' }, { $pull: { [type]: value } });
    limpaCacheRef();
    return (await reference())[type];
  }
  if (type === 'pontosExtra') {
    // remover NÃO mexe nas fotos já avaliadas com esse ponto — só sai das opções novas
    await materializaPontosExtra(c);
    await c.refdata.updateOne({ _id: 'singleton' }, { $pull: { pontosExtra: value } });
    limpaCacheRef();
    return (await reference()).pontosExtra;
  }
  throw new Error('Lista inválida');
}

// ---------- pendentes (promotores E grupos aguardando aprovação do admin) ----------
async function grupoExiste(nome) {
  const c = await cols();
  const rd = await c.refdata.findOne({ _id: 'singleton' });
  const n = norm(nome);
  return (rd?.grupos || []).some((g) => norm(g) === n);
}
async function addPendente(nome, criadoPor, tipo = 'promotor') {
  nome = String(nome || '').trim();
  if (!nome) throw new Error('Nome vazio');
  tipo = tipo === 'grupo' ? 'grupo' : 'promotor';
  if (tipo === 'promotor' && (await promotorExiste(nome))) return { jaExiste: true };
  if (tipo === 'grupo' && (await grupoExiste(nome))) return { jaExiste: true };
  const c = await cols();
  const nomeNorm = norm(nome);
  if (await c.pendentes.findOne({ tipo, nomeNorm })) return { jaPendente: true };
  const rec = { id: crypto.randomUUID(), tipo, nome, nomeNorm, criadoPor: criadoPor || '', criadoEm: nowISO() };
  await c.pendentes.insertOne(rec);
  const { _id, nomeNorm: _n, ...safe } = rec;
  return { ok: true, pendente: safe };
}
async function listPendentes() {
  const c = await cols();
  return c.pendentes.find({}, { projection: { _id: 0, nomeNorm: 0 } }).sort({ criadoEm: 1 }).toArray();
}
async function aprovarPendente(id) {
  const c = await cols();
  const rec = await c.pendentes.findOne({ id });
  if (!rec) throw new Error('Pendência não encontrada');
  await addRefItem(rec.tipo === 'grupo' ? 'grupos' : 'promotores', rec.nome);
  await c.pendentes.deleteOne({ id });
  return rec.nome;
}
async function rejeitarPendente(id) {
  const c = await cols();
  await c.pendentes.deleteOne({ id });
}

// ---------- submissões ----------
// quantas FOTOS (submissões) o promotor já tem na semana / no mês da data de exposição
async function contarNaSemana(promotor, semanaKey) {
  const c = await cols();
  return c.submissions.countDocuments({ promotorNorm: norm(promotor), semanaKey });
}
async function contarNoMes(promotor, mesKey) {
  const c = await cols();
  return c.submissions.countDocuments({ promotorNorm: norm(promotor), mesKey });
}
async function addSubmission(sub) {
  const c = await cols();
  const rec = {
    id: crypto.randomUUID(),
    baixado: false, grupo: '', preAvaliacao: '', pontosExtra: [], validado: null,
    observacao: '', pago: false, createdAt: nowISO(),
    imagens: [], // 1 ou 2 imagens (2 = "antes e depois"), mas conta como 1 foto
    ...sub,
    promotorNorm: norm(sub.promotor), clienteNorm: norm(sub.cliente),
    semanaKey: semanaISO(sub.dataExposicao), mesKey: mesDe(sub.dataExposicao),
    searchBlob: norm([sub.cliente, sub.promotor, sub.endereco, sub.grupo].join(' ')),
  };
  await c.submissions.insertOne(rec);
  const { _id, ...clean } = rec;
  return clean;
}
async function getSubmission(id) {
  const c = await cols();
  return c.submissions.findOne({ id }, { projection: { _id: 0 } });
}
async function listSubmissions(filter = {}) {
  const c = await cols();
  const q = {};
  if (filter.uploadedBy) q.uploadedBy = filter.uploadedBy;
  if (filter.regiao) q.regiao = filter.regiao;
  if (filter.grupo) q.grupo = filter.grupo;
  if (filter.status === 'novos') q.baixado = false;
  if (filter.status === 'baixados') q.baixado = true;
  if (filter.status === 'validados') q.validado = true;
  if (filter.status === 'recusados') q.validado = false;
  if (filter.status === 'pendentes') q.validado = null; // null no Mongo casa null E campo ausente
  if (filter.preAvaliacao === 'sem') q.preAvaliacao = { $in: ['', null] };
  else if (filter.preAvaliacao) q.preAvaliacao = filter.preAvaliacao;
  if (filter.promotor) q.promotorNorm = { $regex: escRe(norm(filter.promotor)) };
  // dataExposicao é 'YYYY-MM-DD' — comparação de string já ordena por data
  if (filter.dataDe || filter.dataAte) {
    q.dataExposicao = {};
    if (filter.dataDe) q.dataExposicao.$gte = String(filter.dataDe);
    if (filter.dataAte) q.dataExposicao.$lte = String(filter.dataAte);
  }
  if (filter.q) q.searchBlob = { $regex: escRe(norm(filter.q)) };
  return c.submissions.find(q, { projection: { _id: 0 } }).sort({ createdAt: -1 }).toArray();
}
async function updateSubmission(id, patch) {
  const c = await cols();
  const allowed = ['baixado', 'preAvaliacao', 'pontosExtra', 'validado', 'observacao', 'pago'];
  const set = {};
  for (const k of allowed) if (k in patch) set[k] = patch[k];
  const r = await c.submissions.findOneAndUpdate({ id }, { $set: set }, { returnDocument: 'after', projection: { _id: 0 } });
  const doc = r && (r.value || r); // compat versões do driver
  if (!doc) throw new Error('Foto não encontrada');
  return doc;
}
async function deleteSubmission(id) {
  const c = await cols();
  const s = await c.submissions.findOne({ id }, { projection: { _id: 0 } });
  if (!s) return null;
  await c.submissions.deleteOne({ id });
  return s; // devolve p/ o caller apagar o arquivo no storage
}
async function markDownloaded(ids) {
  const c = await cols();
  await c.submissions.updateMany({ id: { $in: ids } }, { $set: { baixado: true } });
}
async function purgeDownloaded() {
  const c = await cols();
  // vencedora de ranking NÃO entra no purge — as edições passadas precisam das fotos
  const filtro = { baixado: true, rankingPos: null }; // null casa null E campo ausente
  const removed = await c.submissions.find(filtro, { projection: { _id: 0 } }).toArray();
  await c.submissions.deleteMany(filtro);
  return removed;
}

// ---------- ranking (vencedores por edição = mês da exposição) ----------
// só foto APROVADA com nota EXCELENTE entra; cada posição (1º/2º/3º) é única na edição
async function setRanking(id, pos) {
  const c = await cols();
  const s = await c.submissions.findOne({ id }, { projection: { _id: 0 } });
  if (!s) throw new Error('Foto não encontrada');
  if (!pos) {
    await c.submissions.updateOne({ id }, { $unset: { rankingPos: '' } });
    return { ok: true };
  }
  pos = Number(pos);
  if (![1, 2, 3].includes(pos)) throw new Error('Posição inválida (1, 2 ou 3)');
  if (s.validado !== true || s.preAvaliacao !== 'EXCELENTE')
    throw new Error('Só foto aprovada com nota EXCELENTE pode entrar no ranking');
  // tira a posição de quem estava com ela nesta edição
  await c.submissions.updateMany({ mesKey: s.mesKey, rankingPos: pos }, { $unset: { rankingPos: '' } });
  await c.submissions.updateOne({ id }, { $set: { rankingPos: pos } });
  return { ok: true };
}
// edições com vencedores, da mais recente pra mais antiga (alimenta a página /ranking.html)
async function listRanking() {
  const c = await cols();
  const rows = await c.submissions.find(
    { rankingPos: { $gte: 1 } },
    { projection: { _id: 0, id: 1, rankingPos: 1, mesKey: 1, promotor: 1, cliente: 1, regiao: 1, grupo: 1, imagens: 1 } }
  ).sort({ mesKey: -1, rankingPos: 1 }).toArray();
  const porMes = new Map();
  for (const r of rows) {
    if (!porMes.has(r.mesKey)) porMes.set(r.mesKey, []);
    porMes.get(r.mesKey).push({ ...r, imagens: (r.imagens || []).length || 1 }); // só a contagem — sem IDs de storage
  }
  return [...porMes.entries()].map(([mes, fotos]) => ({ mes, fotos }));
}
// ---------- aderência (quem participou de verdade no período) ----------
// Conta PROMOTORES distintos (pelo nome normalizado — a mesma identidade usada nos
// limites de 1/semana e 4/mês), não fotos. O período filtra pela DATA DA EXPOSIÇÃO,
// que é a data que a campanha enxerga (não a data do upload).
async function aderencia({ de, ate } = {}) {
  const c = await cols();
  const match = {};
  if (de || ate) {
    match.dataExposicao = {};
    if (de) match.dataExposicao.$gte = String(de);
    if (ate) match.dataExposicao.$lte = String(ate);
  }
  // por foto: 1 = sim, 0 = não (reaproveitado nos três recortes)
  const somaSe = (cond) => ({ $sum: { $cond: [cond, 1, 0] } });
  const porFoto = {
    fotos: { $sum: 1 },
    validadas: somaSe({ $eq: ['$validado', true] }),
    recusadas: somaSe({ $eq: ['$validado', false] }),
    pagas: somaSe({ $eq: ['$pago', true] }),
  };
  // um promotor "conta" no recorte se tem ao menos 1 foto naquele estado
  const porPromotor = {
    promotores: { $sum: 1 },
    comValidada: somaSe({ $gt: ['$validadas', 0] }),
    pagos: somaSe({ $gt: ['$pagas', 0] }),
    fotos: { $sum: '$fotos' },
    fotosValidadas: { $sum: '$validadas' },
    fotosRecusadas: { $sum: '$recusadas' },
    fotosPagas: { $sum: '$pagas' },
  };
  // agrupa por (recorte, promotor) e depois consolida o recorte — assim o mesmo
  // promotor com 4 fotos na região conta como 1 promotor, não 4
  const porChave = (campo, extraMatch) => [
    { $match: { ...match, ...(extraMatch || {}) } },
    { $group: { _id: { k: campo, p: '$promotorNorm' }, ...porFoto } },
    { $group: { _id: '$_id.k', ...porPromotor } },
    { $sort: { promotores: -1, fotos: -1, _id: 1 } },
  ];

  const [totalBanco, contasAtivas, geral, porRegiao, porGrupo, semGrupo] = await Promise.all([
    c.promotores.countDocuments({}),
    c.users.countDocuments({ role: 'promotor', active: true }),
    c.submissions.aggregate([
      { $match: match },
      { $group: { _id: '$promotorNorm', ...porFoto } },
      { $group: { _id: null, ...porPromotor } },
    ]).toArray(),
    c.submissions.aggregate(porChave('$regiao')).toArray(),
    // grupo em branco não disputa "grupo mais ativo" (vira a nota de rodapé abaixo)
    c.submissions.aggregate(porChave('$grupo', { grupo: { $nin: ['', null] } })).toArray(),
    c.submissions.countDocuments({ ...match, grupo: { $in: ['', null] } }),
  ]);

  const g = geral[0] || {};
  const linha = (r) => ({
    chave: r._id || '', promotores: r.promotores, fotos: r.fotos,
    validadas: r.fotosValidadas, pagas: r.fotosPagas,
  });
  const nomeRegiao = (s) => (REGIOES.find((r) => r.sigla === s) || {}).nome || s || '—';

  return {
    periodo: { de: de || null, ate: ate || null },
    base: { banco: totalBanco, contasAtivas },
    promotores: {
      participantes: g.promotores || 0,   // mandaram ao menos 1 foto no período
      comFotoValidada: g.comValidada || 0, // e tiveram ao menos 1 aprovada
      pagos: g.pagos || 0,
    },
    fotos: {
      total: g.fotos || 0,
      validadas: g.fotosValidadas || 0,
      recusadas: g.fotosRecusadas || 0,
      pendentes: (g.fotos || 0) - (g.fotosValidadas || 0) - (g.fotosRecusadas || 0),
      pagas: g.fotosPagas || 0,
      semGrupo,
    },
    regioes: porRegiao.map((r) => ({ ...linha(r), sigla: r._id || '', nome: nomeRegiao(r._id) })),
    grupos: porGrupo.map((r) => ({ ...linha(r), grupo: r._id })),
  };
}

module.exports = {
  init,
  REGIOES, PONTOS_EXTRA, PRE_AVALIACOES, PERMISSOES,
  LIMITE_SEMANAL, LIMITE_MENSAL, IMAGENS_POR_FOTO, semanaISO, mesDe,
  findUserByEmail, findUserById, checkPassword, listUsers, countPendingSignups, createUser, updateUser, changeOwnPassword, setProvisionalPassword, setPassword, setUserActive, deleteUser,
  setPermissions, permissoesDe, temPerm, gerarCracha, validarCracha,
  createResetToken, resetPasswordWithToken,
  getConfig, setConfig, listSenhasProg, addSenhaProg, delSenhaProg, hojeBR,
  reference, promotorExiste, grupoExiste, sugerirPromotores,
  addRefItem, removeRefItem, importRefItems, clearPromotores, addPendente, listPendentes, aprovarPendente, rejeitarPendente,
  contarNaSemana, contarNoMes, addSubmission, getSubmission, listSubmissions, updateSubmission,
  deleteSubmission, markDownloaded, purgeDownloaded, setRanking, listRanking, aderencia,
};
