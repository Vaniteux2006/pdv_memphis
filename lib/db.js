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
const LIMITE_FOTOS_CLIENTE = 2;

const nowISO = () => new Date().toISOString();
// normaliza p/ comparar e buscar: minúsculo, sem acento, espaços colapsados
const norm = (s) =>
  String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
const escRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

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
    c.pendentes.createIndex({ nomeNorm: 1 }, { unique: true }),
    c.submissions.createIndex({ id: 1 }, { unique: true }),
    c.submissions.createIndex({ regiao: 1 }),
    c.submissions.createIndex({ baixado: 1 }),
    c.submissions.createIndex({ searchBlob: 1 }),
    c.submissions.createIndex({ createdAt: -1 }),
  ]);

  const seed = loadSeed();
  // admin
  if (!(await c.users.findOne({ role: 'admin' }))) {
    await c.users.insertOne({
      id: crypto.randomUUID(), email: 'admin@local', emailLower: 'admin@local',
      name: 'Administrador', role: 'admin', passwordHash: bcrypt.hashSync('admin123', 10),
      active: true, createdAt: nowISO(),
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
async function findUserByEmail(email) {
  const c = await cols();
  return c.users.findOne({ emailLower: String(email || '').toLowerCase().trim() });
}
async function findUserById(id) {
  const c = await cols();
  return c.users.findOne({ id });
}
function checkPassword(user, pw) {
  return bcrypt.compareSync(pw, user.passwordHash);
}
async function listUsers() {
  const c = await cols();
  // admins primeiro, depois promotores, em ordem alfabética
  return c.users.find({}, { projection: { passwordHash: 0, _id: 0 } }).sort({ role: 1, name: 1 }).toArray();
}
async function createUser({ email, name, password, role, mustChangePassword }) {
  role = role === 'admin' ? 'admin' : 'promotor';
  const c = await cols();
  const emailLower = String(email).toLowerCase().trim();
  if (await c.users.findOne({ emailLower })) throw new Error('E-mail já cadastrado');
  const user = {
    id: crypto.randomUUID(), email: email.trim(), emailLower, name: name.trim(),
    role, passwordHash: bcrypt.hashSync(password, 10), active: true,
    mustChangePassword: !!mustChangePassword, createdAt: nowISO(),
  };
  await c.users.insertOne(user);
  const { passwordHash, _id, ...safe } = user;
  return safe;
}
// define senha provisória (por email) + exige troca no 1º login — usado no onboarding em massa
async function setProvisionalPassword(email, password) {
  const c = await cols();
  const r = await c.users.updateOne(
    { emailLower: String(email || '').toLowerCase().trim() },
    { $set: { passwordHash: bcrypt.hashSync(password, 10), mustChangePassword: true } }
  );
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
}
async function setPassword(id, pw) {
  const c = await cols();
  const r = await c.users.updateOne({ id }, { $set: { passwordHash: bcrypt.hashSync(pw, 10) } });
  if (!r.matchedCount) throw new Error('Usuário não encontrado');
}
async function setUserActive(id, active) {
  const c = await cols();
  const u = await c.users.findOne({ id });
  if (!u) throw new Error('Usuário não encontrado');
  if (u.role === 'admin') throw new Error('Não dá pra banir o admin');
  await c.users.updateOne({ id }, { $set: { active: !!active } });
}
async function deleteUser(id) {
  const c = await cols();
  const u = await c.users.findOne({ id });
  if (u && u.role === 'admin') throw new Error('Não dá pra apagar o admin');
  await c.users.deleteOne({ id });
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
  return true;
}

// ---------- config (senhas) ----------
async function getConfig() {
  const c = await cols();
  return (await c.config.findOne({ _id: 'singleton' })) || { senhaMensal: '', senhaSemanal: '' };
}
async function setConfig({ senhaMensal, senhaSemanal }) {
  const c = await cols();
  const set = {};
  if (senhaMensal !== undefined) set.senhaMensal = String(senhaMensal).trim();
  if (senhaSemanal !== undefined) set.senhaSemanal = String(senhaSemanal).trim();
  await c.config.updateOne({ _id: 'singleton' }, { $set: set }, { upsert: true });
  return getConfig();
}

// ---------- referência ----------
async function reference() {
  const c = await cols();
  const [rd, cfg, proms] = await Promise.all([
    c.refdata.findOne({ _id: 'singleton' }),
    getConfig(),
    c.promotores.find({}, { projection: { nome: 1, _id: 0 } }).sort({ nome: 1 }).toArray(),
  ]);
  const cmp = (a, b) => a.localeCompare(b, 'pt-BR');
  return {
    regioes: REGIOES, pontosExtra: PONTOS_EXTRA, preAvaliacoes: PRE_AVALIACOES, cidades,
    grupos: (rd?.grupos || []).slice().sort(cmp),
    clientes: (rd?.clientes || []).slice().sort(cmp),
    promotores: proms.map((p) => p.nome),
    limiteFotos: LIMITE_FOTOS_CLIENTE,
    senhas: { senhaMensal: cfg.senhaMensal, senhaSemanal: cfg.senhaSemanal },
  };
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
    return (await reference()).promotores;
  }
  if (type === 'grupos' || type === 'clientes') {
    await c.refdata.updateOne({ _id: 'singleton' }, { $addToSet: { [type]: value } }, { upsert: true });
    return (await reference())[type];
  }
  throw new Error('Lista inválida');
}
async function removeRefItem(type, value) {
  const c = await cols();
  if (type === 'promotores') {
    await c.promotores.deleteOne({ nomeNorm: norm(value) });
    return (await reference()).promotores;
  }
  if (type === 'grupos' || type === 'clientes') {
    await c.refdata.updateOne({ _id: 'singleton' }, { $pull: { [type]: value } });
    return (await reference())[type];
  }
  throw new Error('Lista inválida');
}

// ---------- promotores pendentes ----------
async function addPendente(nome, criadoPor) {
  nome = String(nome || '').trim();
  if (!nome) throw new Error('Nome vazio');
  if (await promotorExiste(nome)) return { jaExiste: true };
  const c = await cols();
  const nomeNorm = norm(nome);
  if (await c.pendentes.findOne({ nomeNorm })) return { jaPendente: true };
  const rec = { id: crypto.randomUUID(), nome, nomeNorm, criadoPor: criadoPor || '', criadoEm: nowISO() };
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
  await addRefItem('promotores', rec.nome);
  await c.pendentes.deleteOne({ id });
  return rec.nome;
}
async function rejeitarPendente(id) {
  const c = await cols();
  await c.pendentes.deleteOne({ id });
}

// ---------- submissões ----------
async function countByPromotorCliente(promotor, cliente) {
  const c = await cols();
  return c.submissions.countDocuments({ promotorNorm: norm(promotor), clienteNorm: norm(cliente) });
}
async function addSubmission(sub) {
  const c = await cols();
  const rec = {
    id: crypto.randomUUID(),
    baixado: false, grupo: '', preAvaliacao: '', pontosExtra: [], validado: null,
    observacao: '', pago: false, createdAt: nowISO(),
    ...sub,
    promotorNorm: norm(sub.promotor), clienteNorm: norm(sub.cliente),
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
  const removed = await c.submissions.find({ baixado: true }, { projection: { _id: 0 } }).toArray();
  await c.submissions.deleteMany({ baixado: true });
  return removed;
}
module.exports = {
  init,
  REGIOES, PONTOS_EXTRA, PRE_AVALIACOES, LIMITE_FOTOS: LIMITE_FOTOS_CLIENTE,
  findUserByEmail, findUserById, checkPassword, listUsers, createUser, changeOwnPassword, setProvisionalPassword, setPassword, setUserActive, deleteUser,
  createResetToken, resetPasswordWithToken,
  getConfig, setConfig, reference, promotorExiste, sugerirPromotores,
  addRefItem, removeRefItem, addPendente, listPendentes, aprovarPendente, rejeitarPendente,
  countByPromotorCliente, addSubmission, getSubmission, listSubmissions, updateSubmission,
  deleteSubmission, markDownloaded, purgeDownloaded,
};
