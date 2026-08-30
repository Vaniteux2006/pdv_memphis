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
// Motivos de recusa: viram botão na avaliação (antes o motivo era só texto livre na observação,
// que não dava pra somar). São os 14 motivos do capítulo 10 do Manual de Execução de PDV
// (D1 a D14, nesta ordem), reescritos curtos porque o mesmo texto é o botão do avaliador E a
// explicação que o promotor lê na tela dele. Os códigos ficam fora do rótulo de propósito:
// quem lê é quem está na loja, não quem está com o manual aberto.
// "Outros" é o escape — quem escolhe explica no campo de observação.
const MOTIVOS_RECUSA = [
  'Sem senha, ou senha ilegível',              // D1
  'Sem produto Memphis na foto',               // D2
  'Foto fora do formato panorâmico',           // D3
  'Não se enquadra em nenhum formato',         // D4
  'Menos de 9 frentes (6 em farmácia)',        // D5
  'Só abastecimento, sem ganho de espaço',     // D6
  'Concorrência onde o formato não admite',    // D7
  'Antes e depois sem mudança visível',        // D8
  'Gôndola comum sem a foto do antes',         // D9
  'Foto fora da semana da senha',              // D10
  'Execução já contabilizada antes',           // D11
  'Indício de uso indevido',                   // D12
  'Puxada de frente, sem aumento real',        // D13
  'Imagem gerada ou alterada por IA',          // D14
  'Outros',
];
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

// Força mínima da senha. Não é política de banco: é o piso pra uma senha não cair na
// primeira lista de tentativas. Continua 6 caracteres, mas barra o que é só sequência
// óbvia ou uma repetição — que era o que passava antes ("123456", "000000", "senha").
const SENHAS_OBVIAS = new Set(['123456', '1234567', '12345678', '123456789', 'senha1', 'senha123',
  'password', 'memphis', 'promotor', 'abcdef', 'qwerty', 'admin123', 'mudar123', '654321']);
/**
 * @param {unknown} pw
 * @returns {string} a senha já coagida a string — use o RETORNO, não o argumento
 * @throws {Error} com a mensagem que o usuário vai ler
 */
function validaSenha(pw) {
  const senha = String(pw || '');
  if (senha.length < 6) throw new Error('A senha precisa de ao menos 6 caracteres');
  const n = senha.toLowerCase();
  if (SENHAS_OBVIAS.has(n)) throw new Error('Essa senha é fácil demais de adivinhar — escolha outra');
  if (/^(.)\1+$/.test(senha)) throw new Error('Senha com um caractere só repetido não vale — escolha outra');
  // sequência corrida de dígitos, pra cima ou pra baixo ("456789", "87654321")
  if (/^\d+$/.test(senha) && ('01234567890'.includes(senha) || '09876543210'.includes(senha)))
    throw new Error('Sequência de números não vale — escolha outra');
  return senha;
}

// telefone: no banco só dígitos; o front formata "(00) 00000 0000"
const soDigitos = (s) => String(s || '').replace(/\D/g, '').slice(0, 13);
// matrícula: INT (> 0) ou null quando vazia.
// "0" também vale como SEM matrícula (promotor não tem — aceita e não trava duplicado)
/**
 * @param {unknown} v vem do corpo da requisição ou de célula de planilha: string, número ou nada
 * @returns {number|null} inteiro > 0, ou `null`. **`0` também vira `null`** — senão dois
 *   promotores sem matrícula colidiriam no índice único
 */
function parseMatricula(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const n = Number(String(v).trim());
  if (!Number.isInteger(n) || n < 0) throw new Error('Matrícula precisa ser um número inteiro');
  return n === 0 ? null : n;
}
// filtra a lista de permissões pra só ids válidos ('*' = acesso total)
/**
 * @param {unknown} perms vem do corpo da requisição — pode ser qualquer coisa
 * @returns {import('./tipos').Permissao[]}
 */
function permsValidadas(perms) {
  if (!Array.isArray(perms)) return [];
  if (perms.includes('*')) return ['*'];
  const ok = new Set(PERMISSOES.map((p) => p.id));
  return [...new Set(perms.filter((p) => ok.has(p)))];
}
// permissões efetivas: admin antigo (sem o campo) = acesso total, pra não travar ninguém no deploy
/**
 * @param {Partial<import('./tipos').User>|null|undefined} u
 * @returns {import('./tipos').Permissao[]} `['*']` para admin SEM o campo `permissions` —
 *   o caso legado é acesso total, não acesso nenhum
 */
function permissoesDe(u) {
  if (!u || u.role !== 'admin') return [];
  if (!Array.isArray(u.permissions)) return ['*'];
  return u.permissions;
}
const temPerm = (u, p) => { const ps = permissoesDe(u); return ps.includes('*') || ps.includes(p); };

// chave da semana ISO (ex: "2026-W25") e do mês ("2026-06") a partir de "YYYY-MM-DD"
/**
 * @param {string} dateStr `'YYYY-MM-DD'`
 * @returns {string} `'YYYY-Wnn'`, ou `''` se a data for inválida — o caller TRATA o vazio
 *   (o envio recusa a foto, e é assim que "data de exposição inválida" vira 400)
 */
function semanaISO(dateStr) {
  const d = new Date(String(dateStr) + 'T00:00:00Z');
  if (isNaN(d.getTime())) return '';
  const dow = (d.getUTCDay() + 6) % 7;           // seg=0..dom=6
  d.setUTCDate(d.getUTCDate() - dow + 3);         // quinta desta semana
  const primeiraQui = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const semana = 1 + Math.round((d.getTime() - primeiraQui.getTime()) / 604800000);
  return `${d.getUTCFullYear()}-W${String(semana).padStart(2, '0')}`;
}
/** @type {(dateStr?: string) => string} `'YYYY-MM'` */
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
    presenca: db.collection('presenca'),
    auditoria: db.collection('auditoria'),
    retorno: db.collection('retorno'),
    ranking: db.collection('ranking'),
    correcoes: db.collection('correcoes'),
  };
  return _cols;
}

// ---------- init / seed (chamar uma vez no boot) ----------
async function init() {
  const c = await cols();
  await Promise.all([
    c.users.createIndex({ emailLower: 1 }, { unique: true }),
    c.promotores.createIndex({ nomeNorm: 1 }, { unique: true }),
    c.promotores.createIndex({ grupo: 1 }), // denominador da aderência: quantos nomes o grupo tem
    c.submissions.createIndex({ id: 1 }, { unique: true }),
    c.submissions.createIndex({ regiao: 1 }),
    c.submissions.createIndex({ baixado: 1 }),
    c.submissions.createIndex({ searchBlob: 1 }),
    c.submissions.createIndex({ createdAt: -1 }),
    c.submissions.createIndex({ dataExposicao: 1 }), // filtros de período + agregação da aderência
    // presença dos avaliadores: o TTL é só faxina (o Mongo varre a cada ~60s, tarde demais
    // pra tela) — quem decide o que ainda vale é o filtro por data na consulta
    c.presenca.createIndex({ ts: 1 }, { expireAfterSeconds: 120 }),
    // auditoria de acesso a dado pessoal (Art. 37): some sozinha aos 12 meses. Aqui o TTL
    // SERVE — ao contrário da retenção de fotos, apagar um registro de auditoria não deixa
    // arquivo órfão em lugar nenhum, é só texto.
    c.auditoria.createIndex({ ts: 1 }, { expireAfterSeconds: AUDITORIA_MESES * 30 * 24 * 3600 }),
    c.auditoria.createIndex({ ts: -1 }),   // a tela lista do mais recente pro mais antigo
    c.auditoria.createIndex({ userId: 1 }), // "o que esta pessoa acessou?"
    // retorno da recusa: indexado pelo USUÁRIO, não pela submissão — é o que permite a
    // submissão ser anonimizada no prazo normal enquanto o promotor continua vendo o motivo
    c.retorno.createIndex({ userId: 1, criadoEm: -1 }),
    c.retorno.createIndex({ submissionId: 1 }),
    // pódio: gravado na MARCAÇÃO do vencedor, não na hora de apagar. Um 1º lugar por
    // edição e escopo (o escopo abre espaço pro ranking regional do Bloco 2)
    c.ranking.createIndex({ mesKey: 1, escopo: 1, posicao: 1 }, { unique: true }),
    c.correcoes.createIndex({ resolvido: 1, criadoEm: -1 }),
  ]);

  // pendentes agora tem "tipo" (promotor | grupo): migra os antigos e troca o índice único
  await c.pendentes.updateMany({ tipo: { $exists: false } }, { $set: { tipo: 'promotor' } });
  await c.pendentes.dropIndex('nomeNorm_1').catch(() => {}); // índice antigo, se existir
  await c.pendentes.createIndex({ tipo: 1, nomeNorm: 1 }, { unique: true });

  const seed = loadSeed();
  // admin do primeiro boot. A senha vem do ambiente (ADMIN_SENHA) ou é SORTEADA e mostrada
  // uma única vez no log — nada de "admin123" fixo no código, que ficaria valendo em
  // qualquer instalação nova que ninguém revisasse.
  if (!(await c.users.findOne({ role: 'admin' }))) {
    const email = (process.env.ADMIN_EMAIL || 'admin@local').toLowerCase().trim();
    const senha = process.env.ADMIN_SENHA || crypto.randomBytes(9).toString('base64url');
    await c.users.insertOne({
      id: crypto.randomUUID(), email, emailLower: email,
      name: 'Administrador', role: 'admin', passwordHash: bcrypt.hashSync(senha, 10),
      active: true, createdAt: nowISO(),
      setor: 'Administração', matricula: null, telefone: '', permissions: ['*'],
      mustChangePassword: !process.env.ADMIN_SENHA, // senha sorteada tem que ser trocada no 1º login
    });
    console.log('\n' + '='.repeat(64));
    console.log('>>> PRIMEIRO ADMIN CRIADO');
    console.log('>>> e-mail: ' + email);
    console.log(process.env.ADMIN_SENHA ? '>>> senha: a que você definiu em ADMIN_SENHA'
      : '>>> senha (aparece só desta vez): ' + senha + '\n>>> troque no primeiro login.');
    console.log('='.repeat(64) + '\n');
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
/**
 * Cria a conta. Só `email`, `name` e `password` são obrigatórios — o resto tem caminho
 * (cadastro público, importação de planilha, painel do admin, seed) que legitimamente
 * não informa.
 * @param {object} dados
 * @param {string} dados.email
 * @param {string} dados.name
 * @param {string} dados.password
 * @param {string} [dados.role] qualquer coisa != `'admin'` vira `'promotor'`
 * @param {boolean} [dados.mustChangePassword]
 * @param {string} [dados.grupo]
 * @param {string} [dados.regiao]
 * @param {string} [dados.telefone]
 * @param {string} [dados.setor]
 * @param {string|number} [dados.matricula]
 * @param {unknown} [dados.permissions] só vale em `role: 'admin'`; passa por `permsValidadas`
 * @param {boolean} [dados.pendingApproval] cadastro público: nasce inativo e à espera de aprovação
 * @param {string} [dados.aceiteVersao] presente = já aceitou a política (cadastro público).
 *   **Ausente = cai no portão do `requireAuth`** — é o caso da importação em massa
 * @returns {Promise<import('./tipos').UserSeguro>} sem o `passwordHash`
 */
async function createUser({ email, name, password, role, mustChangePassword, grupo, regiao, telefone, setor, matricula, permissions, pendingApproval, aceiteVersao }) {
  /** @type {import('./tipos').Papel} */ // admin só nasce pelo painel: qualquer outro valor vira promotor
  const papel = role === 'admin' ? 'admin' : 'promotor';
  const c = await cols();
  const emailLower = String(email).toLowerCase().trim();
  if (await c.users.findOne({ emailLower })) throw new Error('E-mail já cadastrado');
  const mat = parseMatricula(matricula);
  if (mat !== null && (await c.users.findOne({ matricula: mat }))) throw new Error('Matrícula já cadastrada');
  // o `_id` não está aqui: quem o adiciona é o insertOne, mutando o objeto. É por isso
  // que ele é desestruturado (e descartado) lá embaixo — e por isso o tipo precisa prevê-lo
  /** @type {import('./tipos').User & { _id?: unknown }} */
  const user = {
    id: crypto.randomUUID(), email: email.trim(), emailLower, name: name.trim(),
    role: papel, passwordHash: bcrypt.hashSync(password, 10), active: !pendingApproval,
    ...(pendingApproval ? { pendingApproval: true } : {}),
    mustChangePassword: !!mustChangePassword, createdAt: nowISO(),
    grupo: String(grupo || '').trim(), regiao: String(regiao || '').trim(), telefone: soDigitos(telefone),
    setor: String(setor || '').trim(), matricula: mat,
    // aceite da política: quem passa pelo cadastro público já marca a caixa e nasce aceito.
    // Conta criada por importação nasce SEM aceite e cai no portão do requireAuth.
    ...(aceiteVersao ? { aceiteVersao: String(aceiteVersao), aceiteEm: nowISO() } : {}),
    // admin novo nasce SEM permissão nenhuma — quem tem acesso total configura (ou ele valida um crachá)
    ...(papel === 'admin' ? { permissions: permsValidadas(permissions) } : {}),
  };
  await c.users.insertOne(user);
  const { passwordHash, _id, ...safe } = user;
  return safe;
}
// registra o aceite da política de privacidade na conta (versão + quando).
// Guardar a VERSÃO, e não só um booleano, é o que permite pedir aceite de novo quando
// o texto mudar — sem isso, uma política nova valeria com o aceite da antiga.
async function registrarAceite(userId, versao) {
  const c = await cols();
  const atual = versao || (await getInstitucionais()).politicaVersao;
  const r = await c.users.updateOne({ id: userId }, { $set: { aceiteVersao: String(atual), aceiteEm: nowISO() } });
  if (!r.matchedCount) throw new Error('Usuário não encontrado');
  limpaCacheUsers(); // senão o portão do requireAuth barraria por até 20s depois de aceitar
  return { aceiteVersao: String(atual) };
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
  validaSenha(newPassword);
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
// Excluir a conta SEM tratar as submissões deixava `promotor` e `uploadedByEmail`
// espalhados pelo banco: "excluir a conta" não excluía o dado pessoal, que é o Art. 18
// na veia — e ainda explicava dado órfão. Agora a exclusão anonimiza o rastro junto.
async function deleteUser(id) {
  const c = await cols();
  const u = await c.users.findOne({ id });
  if (u && u.role === 'admin') throw new Error('Não dá pra apagar o admin');
  if (u) await anonimizarTitular(id, { motivo: 'conta excluída' });
  await c.users.deleteOne({ id });
  limpaCacheUsers();
}

// ---------- pedidos de correção de cadastro (2.5) ----------
// O promotor não digita mais nome, grupo nem região — então precisa de um caminho pra
// avisar quando estiverem errados. Um pedido por pessoa em aberto (upsert): insistir no
// botão não vira dez itens na fila da equipe.
async function abrirCorrecao(user, descricao) {
  const c = await cols();
  await c.correcoes.updateOne(
    { userId: user.id, resolvido: { $ne: true } },
    { $set: {
      userId: user.id, userNome: user.name, userEmail: user.email,
      grupoAtual: user.grupo || '', regiaoAtual: user.regiao || '',
      descricao, resolvido: false, criadoEm: nowISO(),
    } },
    { upsert: true }
  );
}
async function listCorrecoes() {
  const c = await cols();
  return c.correcoes.find({ resolvido: { $ne: true } }, { projection: { _id: 0 } }).sort({ criadoEm: -1 }).limit(200).toArray();
}
async function resolverCorrecao(userId, admin) {
  const c = await cols();
  await c.correcoes.updateOne(
    { userId: String(userId), resolvido: { $ne: true } },
    { $set: { resolvido: true, resolvidoPor: admin?.name || '', resolvidoEm: nowISO() } }
  );
}

// ---------- direitos do titular (Art. 18) ----------
// Exportação: tudo que o sistema guarda sobre a pessoa, num arquivo só.
async function exportarTitular(userId) {
  const c = await cols();
  const u = await c.users.findOne({ id: userId }, { projection: { _id: 0, passwordHash: 0, resetTokenHash: 0 } });
  if (!u) throw new Error('Usuário não encontrado');
  const [submissoes, retornos, podios] = await Promise.all([
    c.submissions.find({ uploadedBy: userId }, { projection: { _id: 0, searchBlob: 0 } }).sort({ createdAt: -1 }).toArray(),
    c.retorno.find({ userId }, { projection: { _id: 0 } }).sort({ criadoEm: -1 }).toArray(),
    c.ranking.find({ submissionId: { $in: (await c.submissions.find({ uploadedBy: userId }, { projection: { id: 1 } }).toArray()).map((x) => x.id) } },
      { projection: { _id: 0 } }).toArray(),
  ]);
  return {
    geradoEm: nowISO(),
    aviso: 'Cópia dos dados pessoais tratados nesta campanha (LGPD, Art. 18, II).',
    cadastro: u,
    submissoes, retornos, podios,
    observacao: submissoes.some((x) => x.anonimizadaEm)
      ? 'Registros marcados com anonimizadaEm já perderam a identificação pela política de retenção.' : undefined,
  };
}

// Anonimizar é o padrão, não apagar: as fotos alimentam aderência, ranking e o histórico
// da campanha. Some a PESSOA, ficam os números.
// O `retorno` sai junto — ele é indexado pelo usuário e, sem isso, sobraria dado pessoal
// órfão de alguém que pediu para ser esquecido.
async function anonimizarTitular(userId, { motivo = '' } = {}) {
  const c = await cols();
  const subs = await c.submissions.find({ uploadedBy: userId }, { projection: { _id: 0 } }).toArray();
  if (subs.length) {
    await congelarAgregados(subs); // mesma ordem obrigatória da retenção automática
    await c.submissions.updateMany(
      { uploadedBy: userId },
      { $set: { promotor: '[removido]', anonimizadoTitularEm: nowISO() },
        $unset: { promotorNorm: '', uploadedBy: '', uploadedByEmail: '', endereco: '', searchBlob: '', observacao: '' } }
    );
  }
  const r = await c.retorno.deleteMany({ userId });
  // o quadro de honra guarda o nome do vencedor: quem pede exclusão sai dele também
  await c.ranking.updateMany({ submissionId: { $in: subs.map((x) => x.id) } }, { $set: { promotor: '[removido]' } });
  return { submissoes: subs.length, retornos: r.deletedCount || 0, motivo };
}

// Exclusão COMPLETA: só quando a campanha já foi paga e encerrada — aí não há número a
// preservar. Apaga as imagens no Cloudinary por fora (o caller cuida disso).
async function excluirTitularCompleto(userId) {
  const c = await cols();
  const subs = await c.submissions.find({ uploadedBy: userId }, { projection: { _id: 0 } }).toArray();
  await c.submissions.deleteMany({ uploadedBy: userId });
  await c.retorno.deleteMany({ userId });
  await c.ranking.deleteMany({ submissionId: { $in: subs.map((x) => x.id) } });
  await c.users.deleteOne({ id: userId });
  limpaCacheUsers();
  return subs; // devolve pro caller apagar os arquivos
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

// ---------- convite de primeiro acesso (LGPD 1.7.2) ----------
// Variação pequena do reset que já existe e já está testado: em vez de "redefina sua
// senha", manda "bem-vindo, CRIE sua senha". Muda o prazo (7 dias — ninguém abre e-mail
// de onboarding em 1 hora) e o texto; a mecânica de token é a mesma (32 bytes aleatórios,
// só o sha256 no banco, uso único).
// Isso resolve o problema pela raiz em vez de mitigá-lo: a conta nasce SEM SENHA UTILIZÁVEL,
// ninguém nunca conhece a senha de ninguém, não existe CSV de senhas circulando, e a senha
// nunca é derivada de dado pessoal (era a proposta de CPF+celular, descartada).
const CONVITE_DIAS = 7;
async function criarConvite(userId) {
  const c = await cols();
  const u = await c.users.findOne({ id: userId });
  if (!u) throw new Error('Usuário não encontrado');
  const token = crypto.randomBytes(32).toString('hex');
  await c.users.updateOne({ id: userId }, {
    $set: {
      resetTokenHash: sha256(token),
      resetTokenExp: Date.now() + CONVITE_DIAS * 24 * 3600 * 1000,
      conviteEnviadoEm: nowISO(),
    },
  });
  limpaCacheUsers();
  return { token, name: u.name, email: u.email };
}

// Senha provisória ALEATÓRIA — nunca derivada de dado pessoal. É o caminho de exceção,
// para quem não tem e-mail na base do Valoo (o dono não tem acesso a ela pra medir a
// cobertura, então suportar os dois casos é mais barato que descobrir na véspera que
// centenas de pessoas ficaram trancadas do lado de fora).
function senhaProvisoriaAleatoria() {
  return crypto.randomBytes(6).toString('base64url'); // ~8 chars, sem ambiguidade de charset
}

async function resetPasswordWithToken(token, newPassword) {
  if (!token) throw new Error('Token ausente');
  validaSenha(newPassword);
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

// ---------- auditoria de acesso a dado pessoal (Art. 37) ----------
// Grava SÓ evento sensível — baixar, exportar, apagar, mexer em conta. Registrar toda
// requisição viraria o gargalo do Atlas M0 e, pior, esconderia o que importa no meio do ruído.
// Hoje `baixado = true` diz que a foto saiu, mas não diz QUEM a levou — que é exatamente a
// pergunta de uma auditoria.
const AUDITORIA_MESES = 12;
const ACOES = {
  BAIXOU_ZIP: 'baixou_zip',
  EXPORTOU_EXCEL: 'exportou_excel',
  EXCLUIU_FOTO: 'excluiu_foto',
  PURGOU_LOTE: 'purgou_lote',
  CRIOU_CONTA: 'criou_conta',
  EDITOU_CONTA: 'editou_conta',
  BANIU_CONTA: 'baniu_conta',
  REATIVOU_CONTA: 'reativou_conta',
  EXCLUIU_CONTA: 'excluiu_conta',
  TROCOU_SENHA_DE: 'trocou_senha_de',
  IMPORTOU_CONTAS: 'importou_contas',
  IMPORTOU_LISTAS: 'importou_listas',
  GEROU_CRACHA: 'gerou_cracha',
  USOU_CRACHA: 'usou_cracha',
  RETENCAO: 'retencao_automatica',
  EXPORTOU_TITULAR: 'exportou_dados_titular',
  ANONIMIZOU_TITULAR: 'anonimizou_titular',
  EXCLUIU_TITULAR: 'excluiu_titular_completo',
  REENVIOU_CONVITE: 'reenviou_convite',
  GEROU_BACKUP: 'gerou_backup',
  BAIXOU_BACKUP: 'baixou_backup',
  RESETOU_CADASTROS: 'resetou_cadastros',
  RESET_ABORTADO: 'reset_abortado_backup_falhou',
  CORRIGIU_AUTORIA: 'corrigiu_autoria_da_foto',
};

// Nunca deixa a auditoria derrubar a operação: se o Mongo falhar aqui, a foto ainda tem
// que ser baixada. O registro é importante, mas não é o serviço.
async function auditar({ user, acao, alvo = '', qtd = null, ip = '', detalhe = '' }) {
  try {
    const c = await cols();
    await c.auditoria.insertOne({
      ts: new Date(), // Date de verdade: é o campo do índice TTL
      userId: user?.id || null,
      userNome: user?.name || '',
      userEmail: user?.email || '',
      acao, alvo: String(alvo || ''),
      ...(qtd === null ? {} : { qtd: Number(qtd) || 0 }),
      ip: String(ip || ''), detalhe: String(detalhe || ''),
    });
  } catch (e) {
    console.error('auditoria falhou (operação seguiu):', e.message);
  }
}

async function listAuditoria({ limit = 100, skip = 0, acao = '', userId = '' } = {}) {
  const c = await cols();
  const q = {};
  if (acao) q.acao = String(acao);
  if (userId) q.userId = String(userId);
  const [itens, total] = await Promise.all([
    c.auditoria.find(q, { projection: { _id: 0 } }).sort({ ts: -1 })
      .skip(Math.max(0, Number(skip) || 0)).limit(Math.min(Math.max(1, Number(limit) || 100), 500)).toArray(),
    c.auditoria.countDocuments(q),
  ]);
  return { itens, total, acoes: Object.values(ACOES) };
}

// ---------- dados institucionais (LGPD) ----------
// Ficam no config, não no .env: no Discloud mexer no .env exige painel + restart + acesso
// do dono, e o e-mail do encarregado precisa ser trocável por quem assumir depois.
// Permissão graduada: contato é do dia a dia ('listas'); identificação da empresa é
// registro público mas raramente muda, então exige acesso total.
const INSTITUCIONAIS_LISTAS = ['encarregadoEmail', 'contatoTelefone', 'politicaVersao', 'avisoTransicaoWhatsapp'];
const INSTITUCIONAIS_TOTAL = ['razaoSocial', 'cnpj', 'enderecoMatriz'];
const INSTITUCIONAIS_PADRAO = {
  razaoSocial: 'Memphis S.A. Industrial',
  cnpj: '92.697.010/0001-46',
  enderecoMatriz: 'Av. João Elustondo Filho, 175',
  encarregadoEmail: 'inteligencia.mecado@gmail.com', // sem o "r" de propósito — o outro já estava tomado
  contatoTelefone: '+55 51 99732-2193',
  politicaVersao: '2026-08',
  avisoTransicaoWhatsapp: true, // some quando o WhatsApp sair de cena (coexistência de ~4 meses)
};

// o que a política e o rodapé precisam, sem exigir login (Art. 41 §1º: o contato do
// encarregado é de divulgação obrigatória — ser público é o comportamento correto)
async function getInstitucionais() {
  const cfg = await getConfig();
  const out = {};
  for (const k of [...INSTITUCIONAIS_TOTAL, ...INSTITUCIONAIS_LISTAS])
    out[k] = cfg[k] ?? INSTITUCIONAIS_PADRAO[k];
  return out;
}

async function setInstitucionais(patch, { acessoTotal = false } = {}) {
  const permitidos = acessoTotal ? [...INSTITUCIONAIS_LISTAS, ...INSTITUCIONAIS_TOTAL] : INSTITUCIONAIS_LISTAS;
  const set = {};
  for (const k of permitidos) {
    if (!(k in patch)) continue;
    if (k === 'avisoTransicaoWhatsapp') { set[k] = !!patch[k]; continue; }
    const v = String(patch[k] ?? '').trim();
    if (!v) throw new Error('Campo institucional não pode ficar vazio: ' + k);
    if (k === 'encarregadoEmail' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v))
      throw new Error('E-mail do encarregado inválido');
    set[k] = v;
  }
  // pedir campo de acesso total sem ter acesso total é erro explícito, não silêncio:
  // salvar "com sucesso" sem gravar faria a pessoa achar que mudou
  if (!acessoTotal) {
    const barrado = INSTITUCIONAIS_TOTAL.find((k) => k in patch);
    if (barrado) throw new Error('Alterar "' + barrado + '" exige acesso total (crachá)');
  }
  if (!Object.keys(set).length) return getInstitucionais();
  const c = await cols();
  await c.config.updateOne({ _id: 'singleton' }, { $set: set }, { upsert: true });
  cfgCache = null; cfgCacheExp = 0;
  return getInstitucionais();
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
  if (!/^\d{4}-\d{2}-\d{2}$/.test(inicio) || isNaN(new Date(inicio + 'T00:00').getTime())) throw new Error('Data de início inválida');
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

/**
 * Listas de apoio das telas, com cache de 30s e single-flight.
 * @returns {Promise<import('./tipos').Referencia>} **sempre com `promotores[]`** — quem
 *   decide se o promotor vê essa chave é o buffer gzip escolhido em `server.js` (Bloco 2)
 */
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
      // pontos extra e motivos de recusa: listas editáveis (aba Listas); enquanto ninguém mexeu, vale a padrão
      regioes: REGIOES, pontosExtra: Array.isArray(rd?.pontosExtra) ? rd.pontosExtra : PONTOS_EXTRA,
      motivosRecusa: Array.isArray(rd?.motivosRecusa) ? rd.motivosRecusa : MOTIVOS_RECUSA,
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
// value: string OU { nome, grupo } — o grupo é opcional e só vale pro banco de promotores.
// A forma de objeto é uma edição EXPLÍCITA de um nome só (a tela de Listas), então grupo
// vazio ali significa "tirar do grupo". O import em massa segue por outro caminho
// (importRefItems), onde branco nunca apaga o que já estava cadastrado.
async function addRefItem(type, value) {
  const c = await cols();
  const temGrupo = !!value && typeof value === 'object';
  const grupo = temGrupo ? String(value.grupo || '').trim() : '';
  value = String(temGrupo ? value.nome : value).trim();
  if (!value) throw new Error('Valor vazio');
  if (type === 'promotores') {
    const nomeNorm = norm(value);
    const existente = await c.promotores.findOne({ nomeNorm });
    if (!existente) await c.promotores.insertOne({ id: crypto.randomUUID(), nome: value.toUpperCase(), nomeNorm, grupo });
    else if (temGrupo) await c.promotores.updateOne({ nomeNorm }, { $set: { grupo } });
    limpaCacheRef();
    return (await reference()).promotores;
  }
  if (type === 'grupos' || type === 'clientes') {
    await c.refdata.updateOne({ _id: 'singleton' }, { $addToSet: { [type]: value } }, { upsert: true });
    limpaCacheRef();
    return (await reference())[type];
  }
  if (LISTAS_PADRAO[type]) {
    await materializaLista(c, type);
    // dupe sem acento/maiúscula: "ilha de produtos" não vira um segundo "Ilha de produtos"
    const atual = (await reference())[type];
    if (!atual.some((p) => norm(p) === norm(value))) {
      await c.refdata.updateOne({ _id: 'singleton' }, { $push: { [type]: value } });
      limpaCacheRef();
    }
    return (await reference())[type];
  }
  throw new Error('Lista inválida');
}
// pontos extra e motivos de recusa nascem como a constante padrão; na PRIMEIRA edição a
// lista é gravada no refdata e daí em diante o banco é a fonte da verdade
const LISTAS_PADRAO = { pontosExtra: PONTOS_EXTRA, motivosRecusa: MOTIVOS_RECUSA };
async function materializaLista(c, tipo) {
  const rd = await c.refdata.findOne({ _id: 'singleton' }, { projection: { [tipo]: 1 } });
  if (!rd || !Array.isArray(rd[tipo])) {
    await c.refdata.updateOne({ _id: 'singleton' }, { $set: { [tipo]: LISTAS_PADRAO[tipo] } }, { upsert: true });
    limpaCacheRef();
  }
}
// import em massa (planilha da aba Listas): adiciona numa passada só o que ainda não existe
// (comparação sem acento/maiúscula) — sem bater no banco item a item como o addRefItem.
// Só ADICIONA, nunca remove. Nome importado sai da fila de aprovação (mesmo efeito de aprovar).
async function importRefItems({ grupos = [], promotores = [] }) {
  const c = await cols();
  const resultado = { grupos: { novos: 0, jaExistiam: 0 }, promotores: { novos: 0, jaExistiam: 0, grupoAtualizado: 0 } };
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
  // promotores: aceita 'NOME' ou { nome, grupo }. Quem já existe não é duplicado — mas tem o
  // GRUPO atualizado quando a planilha traz um, que é como se corrige o cadastro em massa.
  if (promotores.length) {
    const vistos = new Set((await c.promotores.find({}, { projection: { nomeNorm: 1, _id: 0 } }).toArray()).map((p) => p.nomeNorm));
    const docs = [];
    const regrupar = [];
    for (const v of promotores) {
      const nome = String((v && typeof v === 'object') ? v.nome : v).trim();
      const grupo = (v && typeof v === 'object') ? String(v.grupo || '').trim() : '';
      const n = norm(nome);
      if (!n) continue;
      if (vistos.has(n)) {
        resultado.promotores.jaExistiam++;
        if (grupo) regrupar.push({ nomeNorm: n, grupo });
        continue;
      }
      vistos.add(n);
      docs.push({ id: crypto.randomUUID(), nome: nome.toUpperCase(), nomeNorm: n, grupo });
    }
    resultado.promotores.novos = docs.length;
    resultado.promotores.grupoAtualizado = regrupar.length;
    if (docs.length) {
      await c.promotores.insertMany(docs);
      await c.pendentes.deleteMany({ tipo: 'promotor', nomeNorm: { $in: docs.map((d) => d.nomeNorm) } });
    }
    if (regrupar.length) {
      await c.promotores.bulkWrite(regrupar.map((r) => ({
        updateOne: { filter: { nomeNorm: r.nomeNorm }, update: { $set: { grupo: r.grupo } } },
      })));
    }
  }
  limpaCacheRef();
  return resultado;
}
// banco de promotores COM o grupo de cada um — só pra aba Listas (permissão 'listas').
// Fica fora do reference() de propósito: aquele é pedido por todo usuário no boot e já
// carrega milhares de nomes; dobrar o payload pesaria em toda rajada de acesso.
async function listPromotoresComGrupo({ q = '', limit = 500 } = {}) {
  const c = await cols();
  const filtro = norm(q) ? { nomeNorm: { $regex: escRe(norm(q)) } } : {};
  const [total, semGrupo, rows] = await Promise.all([
    c.promotores.countDocuments(filtro),
    c.promotores.countDocuments({ ...filtro, grupo: { $in: ['', null] } }),
    c.promotores.find(filtro, { projection: { _id: 0, nome: 1, grupo: 1 } })
      // teto alto porque o backup de "limpar banco" puxa a lista inteira antes de apagar
      .sort({ nome: 1 }).limit(Math.min(Number(limit) || 500, 20000)).toArray(),
  ]);
  return { total, semGrupo, promotores: rows.map((p) => ({ nome: p.nome, grupo: p.grupo || '' })) };
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
  if (LISTAS_PADRAO[type]) {
    // remover NÃO mexe nas fotos já avaliadas com esse valor — só sai das opções novas
    await materializaLista(c, type);
    await c.refdata.updateOne({ _id: 'singleton' }, { $pull: { [type]: value } });
    limpaCacheRef();
    return (await reference())[type];
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
// Foto RECUSADA não consome cota — decisão do dono: "na prática é como se ele não
// tivesse mandado foto nenhuma". Pendente CONTINUA contando, senão daria pra encher a
// fila enquanto ninguém avalia.
// Efeito colateral que a equipe precisa saber: recusar devolve a vaga NA HORA. Recusa em
// lote no fim do mês libera todo mundo de uma vez pra reenviar.
const SEM_RECUSADA = { validado: { $ne: false } };
async function contarNaSemana(promotor, semanaKey) {
  const c = await cols();
  return c.submissions.countDocuments({ promotorNorm: norm(promotor), semanaKey, ...SEM_RECUSADA });
}
async function contarNoMes(promotor, mesKey) {
  const c = await cols();
  return c.submissions.countDocuments({ promotorNorm: norm(promotor), mesKey, ...SEM_RECUSADA });
}
/**
 * Grava a foto. O caller manda só o que veio da tela e da sessão; os campos derivados
 * (`promotorNorm`, `semanaKey`, `mesKey`, `searchBlob`) e os defaults de avaliação são
 * montados AQUI — mandá-los de fora é o caminho para dois documentos discordarem.
 * Os obrigatórios são os que a foto não significa nada sem: sem `dataExposicao` não há
 * semana nem cota, sem `regiao` a aderência não sabe onde contar. Quem valida a presença
 * deles é a rota (`POST /api/submissions`) — aqui o tipo só impede que um caller novo
 * esqueça e descubra em produção.
 * @param {Partial<import('./tipos').Submission> & Pick<import('./tipos').Submission, 'cliente'|'regiao'|'grupo'|'dataExposicao'|'imagens'>} sub
 * @returns {Promise<import('./tipos').Submission>} sem o `_id`
 */
async function addSubmission(sub) {
  const c = await cols();
  // `_id` idem createUser: entra pela mutação do insertOne, sai na desestruturação abaixo
  /** @type {import('./tipos').Submission & { _id?: unknown }} */
  const rec = {
    id: crypto.randomUUID(),
    baixado: false, grupo: '', preAvaliacao: '', pontosExtra: [], validado: null,
    motivoRecusa: '', observacao: '', pago: false, createdAt: nowISO(),
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
// monta o filtro do Mongo a partir dos parâmetros da tela.
// `semStatus` ignora o filtro de estado — é o que as CONTAGENS das sub-abas precisam
// (quantas pendentes/aprovadas/recusadas existem dentro dos MESMOS filtros de busca).
/**
 * @param {import('./tipos').FiltroSubmissions} [filter] **chega de `req.query` cru** — todo
 *   valor é string na prática, e pode ser objeto se o cliente quiser (daí o `String()` em tudo)
 * @param {{ semStatus?: boolean }} [opcoes]
 * @returns {Record<string, any>} filtro do Mongo
 */
function queryDeSubmissions(filter = {}, { semStatus = false } = {}) {
  const q = {};
  // String() em tudo que vem do cliente: o filtro chega de req.query, e o parser do Express
  // transforma ?regiao[$ne]=X num OBJETO — que iria direto pro Mongo como operador. Hoje a
  // rota que passa req.query já exige permissão de fotos (quem chama enxerga tudo mesmo,
  // então não há escalada), mas basta alguém criar depois uma rota de escopo menor pra virar
  // vazamento. Coagir aqui resolve no lugar certo, uma vez só.
  if (filter.uploadedBy) q.uploadedBy = String(filter.uploadedBy);
  if (filter.regiao) q.regiao = String(filter.regiao);
  if (filter.grupo) q.grupo = String(filter.grupo);
  if (!semStatus) {
    if (filter.status === 'novos') q.baixado = false;      // legado: o ZIP ainda pede assim
    if (filter.status === 'baixados') q.baixado = true;
    if (filter.status === 'validados') q.validado = true;
    if (filter.status === 'recusados') q.validado = false;
    if (filter.status === 'pendentes') q.validado = null;  // null no Mongo casa null E campo ausente
  }
  // "já baixada" é uma pergunta INDEPENDENTE de "aprovada/recusada" — por isso vem em
  // parâmetro próprio: a tela precisa dos dois ao mesmo tempo (aprovadas + ainda não baixadas)
  if (filter.baixado === 'sim') q.baixado = true;
  else if (filter.baixado === 'nao') q.baixado = false;
  if (filter.preAvaliacao === 'sem') q.preAvaliacao = { $in: ['', null] };
  else if (filter.preAvaliacao) q.preAvaliacao = String(filter.preAvaliacao);
  if (filter.promotor) q.promotorNorm = { $regex: escRe(norm(filter.promotor)) };
  // dataExposicao é 'YYYY-MM-DD' — comparação de string já ordena por data
  if (filter.dataDe || filter.dataAte) {
    q.dataExposicao = {};
    if (filter.dataDe) q.dataExposicao.$gte = String(filter.dataDe);
    if (filter.dataAte) q.dataExposicao.$lte = String(filter.dataAte);
  }
  if (filter.q) q.searchBlob = { $regex: escRe(norm(filter.q)) };
  return q;
}

// contagem das sub-abas numa passada só. Contar é barato (o índice resolve sem buscar
// documento: medi ~40ms em 5 mil fotos); o caro é DEVOLVER as fotos — por isso a lista
// vem paginada e os totais vêm daqui.
/**
 * @param {import('./tipos').FiltroSubmissions} [filter]
 * @returns {Promise<{ total: number, pendentes: number, aprovadas: number, recusadas: number, ranking: number }>}
 */
async function contarSubmissions(filter = {}) {
  const c = await cols();
  const somaSe = (cond) => ({ $sum: { $cond: [cond, 1, 0] } });
  const [r] = await c.submissions.aggregate([
    { $match: queryDeSubmissions(filter, { semStatus: true }) },
    { $group: {
      _id: null,
      total: { $sum: 1 },
      pendentes: somaSe({ $eq: ['$validado', null] }),
      aprovadas: somaSe({ $eq: ['$validado', true] }),
      recusadas: somaSe({ $eq: ['$validado', false] }),
      ranking: somaSe({ $and: [{ $eq: ['$validado', true] }, { $eq: ['$preAvaliacao', 'EXCELENTE'] }] }),
    } },
  ]).toArray();
  return { total: 0, pendentes: 0, aprovadas: 0, recusadas: 0, ranking: 0, ...(r || {}), _id: undefined };
}

/**
 * @param {import('./tipos').FiltroSubmissions} [filter] sem `limit`, devolve TUDO — é o que
 *   o ZIP e o Excel precisam. A tela sempre pagina (5 mil fotos passam de 5 MB)
 * @returns {Promise<import('./tipos').Submission[]>}
 */
async function listSubmissions(filter = {}) {
  const c = await cols();
  const q = {};
  Object.assign(q, queryDeSubmissions(filter));
  // ordem='antigas' = fila de atendimento: a que está esperando avaliação há mais tempo vem primeiro
  const ordem = filter.ordem === 'antigas' ? 1 : -1;
  let cur = c.submissions.find(q, { projection: { _id: 0 } }).sort({ createdAt: ordem });
  // sem limite, devolve tudo (é o que o ZIP e o Excel precisam). A TELA sempre pagina:
  // com 5 mil fotos a resposta inteira passa de 5 MB e leva ~5s.
  if (filter.skip) cur = cur.skip(Number(filter.skip) || 0);
  if (filter.limit) cur = cur.limit(Math.min(Number(filter.limit) || 50, 500));
  return cur.toArray();
}
/**
 * @param {string} id
 * @param {Partial<import('./tipos').Submission> & { promotor?: string, permitirTrocarAutor?: boolean }} patch
 *   só a whitelist `allowed` entra; `promotor` exige o `permitirTrocarAutor` explícito
 * @returns {Promise<import('./tipos').Submission>}
 */
async function updateSubmission(id, patch) {
  const c = await cols();
  const allowed = ['baixado', 'preAvaliacao', 'pontosExtra', 'validado', 'motivoRecusa', 'observacao', 'pago'];
  const set = {};
  for (const k of allowed) if (k in patch) set[k] = patch[k];
  // Correção de autoria: com o nome vindo da sessão, o promotor não consegue mais se
  // identificar como outra pessoa — mas os casos legítimos existem (um supervisor lança a
  // foto de quem está sem celular, e avisa a equipe). Antes disso a equipe era avisada e
  // NÃO tinha como consertar. Só admin, e sempre com registro na auditoria.
  if (patch.promotor !== undefined && patch.permitirTrocarAutor === true) {
    const nome = String(patch.promotor || '').trim();
    if (!nome) throw new Error('O nome do promotor não pode ficar vazio');
    set.promotor = nome;
    set.promotorNorm = norm(nome);
    set.promotorNoBanco = await promotorExiste(nome);
    // searchBlob concatena nome + endereço: sem reconstruir, a busca continuaria achando
    // a foto pelo nome ANTIGO
    const atual = await c.submissions.findOne({ id }, { projection: { endereco: 1, cliente: 1 } });
    if (atual) set.searchBlob = norm([nome, atual.cliente, atual.endereco].filter(Boolean).join(' '));
  }
  // pontosExtra vem do cliente: só entra o que está na lista vigente (aba Listas) —
  // texto solto viraria categoria fantasma nos gráficos de pontos extras
  if ('pontosExtra' in set) {
    if (!Array.isArray(set.pontosExtra)) throw new Error('Pontos extras precisam ser uma lista');
    set.pontosExtra = set.pontosExtra.map((p) => String(p));
    const validos = new Set((await reference()).pontosExtra.map(norm));
    const invalido = set.pontosExtra.find((p) => !validos.has(norm(p)));
    if (invalido !== undefined) throw new Error('Ponto extra fora da lista: ' + invalido);
  }
  // aprovar limpa o motivo de recusa — senão a foto fica aprovada carregando um motivo antigo,
  // e esse motivo entraria nas contagens da aderência como se ainda valesse
  if (set.validado === true) set.motivoRecusa = '';
  // Recusar exige motivo: agora que o promotor VÊ o motivo (promotor.html), recusar sem um
  // deixa "Recusada" e nenhuma explicação na tela dele — que é a queixa original.
  // A lista tem "Outros" como escape, então ninguém fica preso no meio de um lote.
  if (set.validado === false) {
    const motivo = String(('motivoRecusa' in set ? set.motivoRecusa : (await c.submissions.findOne({ id }, { projection: { motivoRecusa: 1 } }))?.motivoRecusa) || '').trim();
    if (!motivo) throw new Error('Escolha o motivo da recusa — o promotor precisa saber o que corrigir');
    set.motivoRecusa = motivo;
  }
  const r = await c.submissions.findOneAndUpdate({ id }, { $set: set }, { returnDocument: 'after', projection: { _id: 0 } });
  const doc = r && (r.value || r); // compat versões do driver
  if (!doc) throw new Error('Foto não encontrada');
  // Recusa gera RETORNO numa coleção separada, indexada pelo usuário. É o que permite a
  // submissão ser anonimizada no prazo normal (2 meses) sem o promotor perder a
  // justificativa: anonimizar e "mostrar o motivo pra sempre" querem coisas opostas do
  // MESMO documento, então o retorno sai de dentro dele.
  // Prazo: enquanto a conta existir (Art. 15 — a finalidade dura enquanto dura a relação).
  if (set.validado === false && doc.uploadedBy) await registrarRetorno(doc);
  return doc;
}

// ~15 recusas/ano por promotor × 1.400 ≈ 21 mil documentos de ~100 bytes = ~2 MB/ano.
// Irrelevante num M0 de 512 MB.
async function registrarRetorno(sub) {
  const c = await cols();
  await c.retorno.updateOne(
    { submissionId: sub.id },
    { $set: {
      submissionId: sub.id, userId: sub.uploadedBy,
      semanaKey: sub.semanaKey || '', mesKey: sub.mesKey || '',
      dataExposicao: sub.dataExposicao || '', cliente: sub.cliente || '',
      motivoRecusa: sub.motivoRecusa || '', observacao: sub.observacao || '',
      criadoEm: nowISO(),
    } },
    { upsert: true } // reavaliar a mesma foto atualiza o retorno, não cria um segundo
  );
}

// histórico de recusas do promotor — sobrevive à anonimização da submissão
async function listRetornos(userId) {
  const c = await cols();
  return c.retorno.find({ userId }, { projection: { _id: 0, userId: 0 } }).sort({ criadoEm: -1 }).limit(200).toArray();
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

// ---------- retenção e anonimização (LGPD 1.5) ----------
// O relógio é `createdAt` (quando a foto ENTROU), não `dataExposicao` (digitada pelo
// promotor). São dois relógios diferentes: alguém pode enviar hoje a foto de uma exposição
// de 2,5 meses atrás — contado pela exposição, esse envio NASCE VENCIDO e some antes de
// qualquer pessoa poder olhar. Contado pela entrada, todo mundo tem os mesmos 2 meses.
const RETENCAO_IMAGEM_DIAS = 60;    // imagem no Cloudinary
const RETENCAO_IDENTIDADE_DIAS = 180; // uploadedBy + observacao (o retorno vive à parte)
const BACKUP_DIAS = 150;
const ALERTA_DIAS = { destaque: 30, critico: 45, ultima: 53 };

const diasAtras = (n) => new Date(Date.now() - n * 24 * 3600 * 1000).toISOString();

// TTL do Mongo NÃO serve aqui: apagaria o documento sem avisar ninguém e deixaria a
// imagem órfã no Cloudinary — pagando armazenamento por foto que ninguém mais vê.
// Tem que ser código, e o código também precisa avisar (auditoria).
async function fotosAExpirar() {
  const c = await cols();
  return c.submissions.find(
    { createdAt: { $lt: diasAtras(RETENCAO_IMAGEM_DIAS) }, anonimizadaEm: { $exists: false } },
    { projection: { _id: 0 } }
  ).toArray();
}

// Congela o que a anonimização destruiria — RODA ANTES de limpar, sempre.
// (1) grupoOficial: o $lookup da aderência morre junto com promotorNorm.
// (2) participantesDistintos por mês×grupo: contar "quantas PESSOAS participaram" exige
//     identidade, e nenhum campo residual substitui isso. É um número por combinação,
//     não o snapshot inteiro que eu havia cogitado.
async function congelarAgregados(subs) {
  const c = await cols();
  if (!subs.length) return;
  const normNomes = [...new Set(subs.map((s) => s.promotorNorm).filter(Boolean))];
  const doBanco = await c.promotores.find({ nomeNorm: { $in: normNomes } }, { projection: { _id: 0, nomeNorm: 1, grupo: 1 } }).toArray();
  const grupoDe = new Map(doBanco.map((p) => [p.nomeNorm, p.grupo || '']));

  const ops = subs
    .filter((s) => s.grupoOficial === undefined)
    .map((s) => ({ updateOne: { filter: { id: s.id }, update: { $set: { grupoOficial: grupoDe.get(s.promotorNorm) || '' } } } }));
  if (ops.length) await c.submissions.bulkWrite(ops);

  // contador por mês × grupo, somando SÓ o que ainda não foi contado
  const chaves = new Map();
  for (const s of subs) {
    const g = s.grupoOficial !== undefined ? s.grupoOficial : (grupoDe.get(s.promotorNorm) || '');
    const k = `${s.mesKey || ''}|${g}`;
    if (!chaves.has(k)) chaves.set(k, new Set());
    if (s.promotorNorm) chaves.get(k).add(s.promotorNorm);
  }
  for (const [k, pessoas] of chaves) {
    const [mesKey, grupo] = k.split('|');
    await c.refdata.updateOne(
      { _id: 'participantes' },
      { $inc: { [`por.${mesKey.replace(/\./g, '_')}|${grupo.replace(/\./g, '_')}`]: pessoas.size } },
      { upsert: true }
    );
  }
}

// O que sai e o que fica está em docs/09-lgpd.md. O campo mais fácil de esquecer é o
// `uploadedBy`: sem removê-lo, "anonimizar" vira PSEUDOnimizar — um $lookup devolve o nome
// num passo, o dado continua pessoal e a isenção do Art. 12 não se aplica. Ele sai aos
// 6 meses (não aos 2) porque até lá é ele que liga o promotor ao histórico dele.
async function anonimizarSubmissions(subs) {
  const c = await cols();
  if (!subs.length) return 0;
  const r = await c.submissions.bulkWrite(subs.map((s) => ({
    updateOne: {
      filter: { id: s.id },
      update: {
        $set: { anonimizadaEm: nowISO(), imagens: [] },
        $unset: {
          promotor: '', promotorNorm: '', uploadedByEmail: '',
          endereco: '', searchBlob: '', clienteNorm: '', storedFile: '', resourceType: '',
        },
      },
    },
  })));
  return r.modifiedCount || 0;
}

// 6 meses: sai a identidade que sobrou. O retorno da recusa NÃO mora aqui — ele está na
// coleção `retorno`, indexada pelo usuário, e sobrevive enquanto a conta existir.
async function removerIdentidadeAntiga() {
  const c = await cols();
  const r = await c.submissions.updateMany(
    { createdAt: { $lt: diasAtras(RETENCAO_IDENTIDADE_DIAS) }, uploadedBy: { $exists: true } },
    { $unset: { uploadedBy: '', observacao: '' } }
  );
  return r.modifiedCount || 0;
}

// Contagens do escalonamento (1.5.1). Recusada NÃO entra em "não baixadas": é estado
// terminal, não pendência — se entrasse, gritaria para sempre e o alerta viraria ruído
// que a equipe aprende a ignorar, que é o oposto do pedido.
async function contarAlertas() {
  const c = await cols();
  const naoAvaliada = { validado: null, anonimizadaEm: { $exists: false } };
  const naoBaixada = { validado: true, baixado: false, anonimizadaEm: { $exists: false } };
  const [naoAvaliadas, naoBaixadas, destaque, critico, ultima, aExpirar] = await Promise.all([
    c.submissions.countDocuments(naoAvaliada),
    c.submissions.countDocuments(naoBaixada),
    c.submissions.countDocuments({ $or: [naoAvaliada, naoBaixada], createdAt: { $lt: diasAtras(ALERTA_DIAS.destaque) } }),
    c.submissions.countDocuments({ $or: [naoAvaliada, naoBaixada], createdAt: { $lt: diasAtras(ALERTA_DIAS.critico) } }),
    c.submissions.countDocuments({ $or: [naoAvaliada, naoBaixada], createdAt: { $lt: diasAtras(ALERTA_DIAS.ultima) } }),
    c.submissions.countDocuments({ createdAt: { $lt: diasAtras(RETENCAO_IMAGEM_DIAS - 7) }, anonimizadaEm: { $exists: false } }),
  ]);
  return { naoAvaliadas, naoBaixadas, destaque, critico, ultima, aExpirar, dias: ALERTA_DIAS };
}

// ---------- backup e reset de cadastros (LGPD 1.8) ----------
// ⚠️ O backup É DADO PESSOAL — não é arquivo neutro, é a base inteira de pessoas.
// Por isso entra no registro de tratamento com retenção declarada (5 meses), acesso
// restrito a acesso total e entrega sempre por URL assinada com expiração.
async function montarBackup() {
  const c = await cols();
  const [users, promotores, refdata, config] = await Promise.all([
    c.users.find({}, { projection: { _id: 0 } }).toArray(),
    c.promotores.find({}, { projection: { _id: 0 } }).toArray(),
    c.refdata.find({}, { projection: { _id: 0 } }).toArray(),
    c.config.find({}, { projection: { _id: 0 } }).toArray(),
  ]);
  return {
    geradoEm: nowISO(),
    versao: 1,
    aviso: 'CONTÉM DADOS PESSOAIS. Retenção declarada: ' + Math.round(BACKUP_DIAS / 30) + ' meses.',
    contagens: { users: users.length, promotores: promotores.length },
    // o hash da senha vai junto de propósito: sem ele a restauração deixaria todo mundo
    // sem conseguir entrar, e o backup não seria backup
    users, promotores, refdata, config,
  };
}

async function registrarBackup(doc) {
  const c = await cols();
  await c.refdata.updateOne(
    { _id: 'backups' },
    { $push: { itens: { ...doc, criadoEm: nowISO() } } },
    { upsert: true }
  );
}
async function listBackups() {
  const c = await cols();
  const d = await c.refdata.findOne({ _id: 'backups' });
  return (d?.itens || []).slice().sort((a, b) => (a.criadoEm < b.criadoEm ? 1 : -1));
}
// backups vencidos somem na mesma rotina diária da retenção — senão se acumulam pra
// sempre, que é exatamente o problema que a retenção existe pra resolver
async function backupsVencidos() {
  const limite = diasAtras(BACKUP_DIAS);
  return (await listBackups()).filter((b) => b.criadoEm < limite);
}
async function removerBackupsDoRegistro(ids) {
  const c = await cols();
  await c.refdata.updateOne({ _id: 'backups' }, { $pull: { itens: { storedFile: { $in: ids } } } });
}

// Reset de cadastros: apaga a base de PESSOAS (contas de promotor, banco de nomes, filas).
// Nunca toca em quem executou, nem em outros admins — senão o sistema fica sem
// administrador e ninguém entra.
async function resetarCadastros(executorId) {
  const c = await cols();
  const [users, promotores, pendentes] = await Promise.all([
    c.users.deleteMany({ role: { $ne: 'admin' } }),
    c.promotores.deleteMany({}),
    c.pendentes.deleteMany({}),
  ]);
  // retornos ficariam órfãos apontando pra contas que não existem mais
  const ret = await c.retorno.deleteMany({});
  limpaCacheUsers(); limpaCacheRef();
  return {
    contas: users.deletedCount || 0,
    promotores: promotores.deletedCount || 0,
    pendentes: pendentes.deletedCount || 0,
    retornos: ret.deletedCount || 0,
    executorPreservado: executorId,
  };
}

// ---------- presença dos avaliadores ----------
// Quem está com qual foto aberta agora. Serve só pra AVISAR ("Fulano está nesta foto") —
// não tranca nada, então ninguém fica com foto presa se fechar o navegador ou cair a rede.
// 1 documento por admin (o _id é o id do usuário), atualizado no polling que já existe.
const PRESENCA_VALE_MS = 30 * 1000; // sem notícia por 30s, o admin sumiu da tela

async function marcarPresenca(userId, nome, subId) {
  const c = await cols();
  const agora = new Date();
  if (subId) await c.presenca.updateOne({ _id: userId }, { $set: { nome, subId, ts: agora } }, { upsert: true });
  else await c.presenca.deleteOne({ _id: userId }); // saiu da galeria: some do aviso na hora
  // devolve só os OUTROS — ninguém precisa ser avisado de si mesmo
  const vivos = await c.presenca.find(
    { _id: { $ne: userId }, ts: { $gt: new Date(Date.now() - PRESENCA_VALE_MS) } },
    { projection: { nome: 1, subId: 1 } }
  ).toArray();
  return vivos.map((p) => ({ nome: p.nome, subId: p.subId }));
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
  // ORDEM OBRIGATÓRIA: o registro do pódio é gravado AQUI, na marcação — não na hora de
  // apagar. A foto do vencedor morre aos 2 meses como qualquer outra (sem carve-out, a
  // régua da retenção fica uma só); o que sobrevive é o quadro de honra em texto.
  // Se isto não estivesse rodando antes da 1ª exclusão, os vencedores passados sumiriam
  // e não haveria como reconstruir.
  await c.ranking.updateOne(
    { mesKey: s.mesKey, escopo: ESCOPO_NACIONAL, posicao: pos },
    { $set: {
      mesKey: s.mesKey, escopo: ESCOPO_NACIONAL, posicao: pos,
      submissionId: s.id, promotor: s.promotor || '', grupo: s.grupo || '',
      regiao: s.regiao || '', cliente: s.cliente || '', marcadoEm: nowISO(),
    } },
    { upsert: true }
  );
  return { ok: true };
}
// escopo abre espaço pro ranking regional (Bloco 2.3): a chave única é mesKey+escopo+posicao,
// então nacional e regionais convivem sem dois caminhos no código.
const ESCOPO_NACIONAL = 'NACIONAL';
// edições com vencedores, da mais recente pra mais antiga (alimenta a página /ranking.html)
// A fonte da verdade do pódio é a coleção `ranking` (texto, indefinida), não a foto.
// A foto entra QUANDO AINDA EXISTIR — daí o `temFoto`, que a página usa pra escolher entre
// pódio com imagem (edição vigente) e quadro de honra (edições passadas), em vez de
// mostrar imagem quebrada quando a retenção levar o arquivo.
async function listRanking() {
  const c = await cols();
  const regs = await c.ranking.find({}, { projection: { _id: 0 } }).sort({ mesKey: -1, posicao: 1 }).toArray();
  if (!regs.length) return [];
  const ids = regs.map((r) => r.submissionId).filter(Boolean);
  // "viva" = documento existe E ainda tem imagem. Depois da retenção o documento
  // continua lá (anonimizado, alimentando os gráficos), mas `imagens` fica vazio — se
  // olhássemos só a existência do documento, a página tentaria desenhar imagem apagada.
  const vivas = await c.submissions.find(
    { id: { $in: ids }, 'imagens.0': { $exists: true }, anonimizadaEm: { $exists: false } },
    { projection: { _id: 0, id: 1, imagens: 1 } }
  ).toArray();
  const porId = new Map(vivas.map((v) => [v.id, (v.imagens || []).length || 1]));
  const porMes = new Map();
  for (const r of regs) {
    if (!porMes.has(r.mesKey)) porMes.set(r.mesKey, []);
    porMes.get(r.mesKey).push({
      id: r.submissionId, rankingPos: r.posicao, mesKey: r.mesKey, escopo: r.escopo,
      promotor: r.promotor, cliente: r.cliente, regiao: r.regiao, grupo: r.grupo,
      temFoto: porId.has(r.submissionId),
      imagens: porId.get(r.submissionId) || 0,
    });
  }
  return [...porMes.entries()].map(([mes, fotos]) => ({ mes, fotos }));
}
// ---------- série temporal (alimenta a aba Gráficos) ----------
// Agrupa pelas chaves que a submissão JÁ grava (semanaKey / mesKey), então não precisa
// recalcular data nenhuma. O período filtra pela data da EXPOSIÇÃO, igual à aderência.
// Baldes vazios entram com zero: sem isso a semana sem foto some e a linha mente,
// ligando dois pontos distantes como se nada tivesse acontecido no meio.
/**
 * @param {string} de `'YYYY-MM-DD'`
 * @param {string} ate `'YYYY-MM-DD'`
 * @param {string} por `'mes'` ou qualquer outra coisa (= semana)
 * @returns {string[]} chaves de balde, vazias incluídas — sem elas a linha do gráfico mente
 */
function bucketsEntre(de, ate, por) {
  const chaves = [];
  const d = new Date(de + 'T00:00:00Z'), fim = new Date(ate + 'T00:00:00Z');
  if (isNaN(d.getTime()) || isNaN(fim.getTime()) || d > fim) return chaves;
  const visto = new Set();
  while (d <= fim) {
    const iso = d.toISOString().slice(0, 10);
    const k = por === 'mes' ? mesDe(iso) : semanaISO(iso);
    if (k && !visto.has(k)) { visto.add(k); chaves.push(k); }
    d.setUTCDate(d.getUTCDate() + (por === 'mes' ? 15 : 3)); // passo curto o bastante pra não pular balde
  }
  return chaves;
}

/**
 * @param {{ de?: string, ate?: string, por?: string }} [opcoes] datas `'YYYY-MM-DD'`;
 *   `por` diferente de `'mes'` vira `'semana'`
 */
async function serie({ de, ate, por = 'semana' } = {}) {
  const c = await cols();
  por = por === 'mes' ? 'mes' : 'semana';
  const campo = por === 'mes' ? '$mesKey' : '$semanaKey';
  const match = {};
  if (de || ate) {
    match.dataExposicao = {};
    if (de) match.dataExposicao.$gte = String(de);
    if (ate) match.dataExposicao.$lte = String(ate);
  }
  const somaSe = (cond) => ({ $sum: { $cond: [cond, 1, 0] } });
  const rows = await c.submissions.aggregate([
    { $match: match },
    // por (balde, promotor) primeiro: é o que permite contar PROMOTORES distintos,
    // não fotos — um promotor com 4 fotos na semana conta 1 na participação
    { $group: {
      _id: { k: campo, p: '$promotorNorm' },
      fotos: { $sum: 1 },
      validadas: somaSe({ $eq: ['$validado', true] }),
      recusadas: somaSe({ $eq: ['$validado', false] }),
      excelentes: somaSe({ $eq: ['$preAvaliacao', 'EXCELENTE'] }),
      pagas: somaSe({ $eq: ['$pago', true] }),
    } },
    { $group: {
      _id: '$_id.k',
      promotores: { $sum: 1 },
      fotos: { $sum: '$fotos' }, validadas: { $sum: '$validadas' },
      recusadas: { $sum: '$recusadas' }, excelentes: { $sum: '$excelentes' },
      pagas: { $sum: '$pagas' },
    } },
  ]).toArray();

  const porChave = new Map(rows.map((r) => [r._id, r]));
  const pontos = bucketsEntre(de, ate, por).map((k) => {
    const r = porChave.get(k) || {};
    const validadas = r.validadas || 0, recusadas = r.recusadas || 0;
    const avaliadas = validadas + recusadas;
    return {
      chave: k,
      fotos: r.fotos || 0, validadas, recusadas,
      pendentes: (r.fotos || 0) - avaliadas,
      excelentes: r.excelentes || 0, pagas: r.pagas || 0,
      promotores: r.promotores || 0,
      // aprovação só sobre o que já foi decidido; sem decisão nenhuma, null (a linha corta)
      aprovacaoPct: avaliadas ? Math.round((validadas / avaliadas) * 1000) / 10 : null,
    };
  });
  return { periodo: { de: de || null, ate: ate || null }, por, pontos };
}

// ---------- aderência (quem participou de verdade no período) ----------
// Conta PROMOTORES distintos (pelo nome normalizado — a mesma identidade usada nos
// limites de 1/semana e 4/mês), não fotos. O período filtra pela DATA DA EXPOSIÇÃO,
// que é a data que a campanha enxerga (não a data do upload).
/**
 * @param {{ de?: string, ate?: string }} [opcoes] `'YYYY-MM-DD'`; filtra pela data da
 *   EXPOSIÇÃO, não pela do upload
 */
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
    excelentes: somaSe({ $eq: ['$preAvaliacao', 'EXCELENTE'] }),
  };
  // liga a foto ao BANCO de promotores pra saber o grupo oficial de quem enviou.
  // O grupo digitado na foto é o que o promotor escreveu; o do banco é o cadastro —
  // e é o cadastro que dá o denominador do "% do grupo".
  // O grupo oficial vem do $lookup por promotorNorm — que a anonimização LIMPA. Por isso
  // ela congela `grupoOficial` no documento antes de limpar, e aqui o valor congelado tem
  // prioridade: sem isso, a participação por grupo cairia a zero em silêncio, com números
  // que PARECEM reais. Nome de grupo não é dado pessoal, então congelar não desanonimiza.
  const comGrupoDoBanco = [
    { $lookup: { from: 'promotores', localField: 'promotorNorm', foreignField: 'nomeNorm', as: '_banco' } },
    { $set: { grupoBanco: {
      $ifNull: ['$grupoOficial', { $ifNull: [{ $arrayElemAt: ['$_banco.grupo', 0] }, ''] }],
    } } },
  ];
  // um promotor "conta" no recorte se tem ao menos 1 foto naquele estado
  const porPromotor = {
    promotores: { $sum: 1 },
    comValidada: somaSe({ $gt: ['$validadas', 0] }),
    pagos: somaSe({ $gt: ['$pagas', 0] }),
    fotos: { $sum: '$fotos' },
    fotosValidadas: { $sum: '$validadas' },
    fotosRecusadas: { $sum: '$recusadas' },
    fotosPagas: { $sum: '$pagas' },
    fotosExcelentes: { $sum: '$excelentes' },
  };
  // agrupa por (recorte, promotor) e depois consolida o recorte — assim o mesmo
  // promotor com 4 fotos na região conta como 1 promotor, não 4
  const porChave = (campo, extraMatch) => [
    { $match: { ...match, ...(extraMatch || {}) } },
    { $group: { _id: { k: campo, p: '$promotorNorm' }, ...porFoto } },
    { $group: { _id: '$_id.k', ...porPromotor } },
    { $sort: { promotores: -1, fotos: -1, _id: 1 } },
  ];

  const [
    totalBanco, contasAtivas, geral, porRegiao, porGrupo, semGrupo,
    rd, rosterPorGrupo, participacaoPorGrupo, motivos, recusadasSemMotivo,
    pontos, pontoPorRegiao, pontoPorGrupo, topPromotores, topClientes,
  ] = await Promise.all([
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

    // ---- quantos grupos existem na lista oficial ----
    c.refdata.findOne({ _id: 'singleton' }, { projection: { grupos: 1 } }),
    // ---- roster: quantos nomes do banco pertencem a cada grupo (o DENOMINADOR) ----
    c.promotores.aggregate([
      { $match: { grupo: { $nin: ['', null] } } },
      { $group: { _id: '$grupo', roster: { $sum: 1 } } },
    ]).toArray(),
    // ---- participação por grupo OFICIAL (o do cadastro, não o digitado na foto) ----
    c.submissions.aggregate([
      { $match: match },
      ...comGrupoDoBanco,
      { $match: { grupoBanco: { $ne: '' } } },
      { $group: { _id: { k: '$grupoBanco', p: '$promotorNorm' }, ...porFoto } },
      { $group: { _id: '$_id.k', ...porPromotor } },
    ]).toArray(),

    // ---- motivo mais comum de recusa (só o que veio de botão) ----
    c.submissions.aggregate([
      { $match: { ...match, validado: false, motivoRecusa: { $nin: ['', null] } } },
      { $group: { _id: '$motivoRecusa', n: { $sum: 1 } } },
      { $sort: { n: -1, _id: 1 } },
    ]).toArray(),
    // recusadas SEM motivo: mede o quanto o número acima dá pra confiar
    c.submissions.countDocuments({ ...match, validado: false, motivoRecusa: { $in: ['', null] } }),

    // ---- pontos extra: o mais usado e o menos aprovado ----
    // A taxa de aprovação só olha foto JÁ DECIDIDA — foto pendente não foi reprovada,
    // e contá-la no denominador faria todo ponto parecer pior do que é.
    c.submissions.aggregate([
      { $match: match },
      { $unwind: '$pontosExtra' },
      { $group: {
        _id: '$pontosExtra',
        total: { $sum: 1 },
        avaliadas: somaSe({ $ne: ['$validado', null] }),
        validadas: somaSe({ $eq: ['$validado', true] }),
      } },
      { $sort: { total: -1, _id: 1 } },
    ]).toArray(),
    // ponto mais comum por região e por grupo oficial
    c.submissions.aggregate([
      { $match: match },
      { $unwind: '$pontosExtra' },
      { $group: { _id: { k: '$regiao', ponto: '$pontosExtra' }, n: { $sum: 1 } } },
      { $sort: { n: -1, '_id.ponto': 1 } },
    ]).toArray(),
    c.submissions.aggregate([
      { $match: match },
      ...comGrupoDoBanco,
      { $match: { grupoBanco: { $ne: '' } } },
      { $unwind: '$pontosExtra' },
      { $group: { _id: { k: '$grupoBanco', ponto: '$pontosExtra' }, n: { $sum: 1 } } },
      { $sort: { n: -1, '_id.ponto': 1 } },
    ]).toArray(),

    // ---- quem mais leva recusa ----
    // Vai junto o TOTAL de fotos: "5 recusadas" quer dizer coisas muito diferentes
    // pra quem mandou 5 e pra quem mandou 40, e sem a base o ranking engana.
    ...['$promotor', '$cliente'].map((campo) => c.submissions.aggregate([
      { $match: match },
      { $group: { _id: campo, fotos: { $sum: 1 }, recusadas: somaSe({ $eq: ['$validado', false] }) } },
      { $match: { recusadas: { $gt: 0 } } },
      { $sort: { recusadas: -1, fotos: 1, _id: 1 } }, { $limit: 10 },
    ]).toArray()),
  ]);

  const g = geral[0] || {};
  const linha = (r) => ({
    chave: r._id || '', promotores: r.promotores, fotos: r.fotos,
    validadas: r.fotosValidadas, pagas: r.fotosPagas,
  });
  const nomeRegiao = (s) => (REGIOES.find((r) => r.sigla === s) || {}).nome || s || '—';
  const pct = (n, total) => (total > 0 ? Math.round((n / total) * 1000) / 10 : null); // null = não dá pra calcular

  // ---- grupos: cruza o cadastro (denominador) com quem participou (numerador) ----
  // A lista sai do ROSTER, não das fotos: grupo inteiro que não mandou nada precisa
  // aparecer com 0% — é justamente o que a campanha quer enxergar.
  const partPorGrupo = new Map(participacaoPorGrupo.map((r) => [r._id, r]));
  const melhorPonto = (rows) => {
    const top = new Map(); // já vem ordenado por n desc, então o primeiro de cada chave ganha
    for (const r of rows) if (!top.has(r._id.k)) top.set(r._id.k, { ponto: r._id.ponto, n: r.n });
    return top;
  };
  const pontoDoGrupo = melhorPonto(pontoPorGrupo), pontoDaRegiao = melhorPonto(pontoPorRegiao);

  const gruposCadastrados = rosterPorGrupo.map((r) => {
    const p = partPorGrupo.get(r._id) || {};
    const participaram = p.promotores || 0, comValidada = p.comValidada || 0;
    return {
      grupo: r._id, roster: r.roster,
      participaram, participacaoPct: pct(participaram, r.roster),
      comValidada, assertividadePct: pct(comValidada, r.roster),
      fotos: p.fotos || 0, validadas: p.fotosValidadas || 0, recusadas: p.fotosRecusadas || 0,
      pontoMaisComum: (pontoDoGrupo.get(r._id) || {}).ponto || '',
    };
  }).sort((a, b) => (b.participacaoPct ?? -1) - (a.participacaoPct ?? -1) || b.roster - a.roster);

  // cada promotor tem UM grupo no cadastro, então somar os grupos dá quantos participantes
  // estão cadastrados; o resto ficou de fora dos % (é a "margem de erro" da tela)
  const comCadastro = participacaoPorGrupo.reduce((s, r) => s + r.promotores, 0);

  const pontosExtra = pontos.map((p) => ({
    ponto: p._id, total: p.total, avaliadas: p.avaliadas, validadas: p.validadas,
    aprovacaoPct: pct(p.validadas, p.avaliadas),
  }));
  // "menos aprovado" precisa de um mínimo de fotos decididas, senão 1 foto recusada
  // vira "0% de aprovação" e lidera o ranking de pior sem significar nada
  const MIN_PRA_RANQUEAR = 5;
  const menosAprovado = pontosExtra
    .filter((p) => p.avaliadas >= MIN_PRA_RANQUEAR)
    .sort((a, b) => a.aprovacaoPct - b.aprovacaoPct)[0] || null;

  return {
    periodo: { de: de || null, ate: ate || null },
    base: {
      banco: totalBanco, contasAtivas,
      gruposTotal: (rd?.grupos || []).length,
      gruposComCadastro: rosterPorGrupo.length,
      promotoresComGrupo: rosterPorGrupo.reduce((s, r) => s + r.roster, 0),
    },
    promotores: {
      participantes: g.promotores || 0,   // mandaram ao menos 1 foto no período
      comFotoValidada: g.comValidada || 0, // e tiveram ao menos 1 aprovada
      pagos: g.pagos || 0,
      semCadastroDeGrupo: (g.promotores || 0) - comCadastro,
    },
    fotos: {
      total: g.fotos || 0,
      validadas: g.fotosValidadas || 0,
      recusadas: g.fotosRecusadas || 0,
      pendentes: (g.fotos || 0) - (g.fotosValidadas || 0) - (g.fotosRecusadas || 0),
      pagas: g.fotosPagas || 0,
      excelentes: g.fotosExcelentes || 0,
      semGrupo,
    },
    regioes: porRegiao.map((r) => ({
      ...linha(r), sigla: r._id || '', nome: nomeRegiao(r._id),
      pontoMaisComum: (pontoDaRegiao.get(r._id) || {}).ponto || '',
    })),
    grupos: porGrupo.map((r) => ({ ...linha(r), grupo: r._id })), // atividade pelo grupo digitado
    gruposCadastrados,                                            // % pelo grupo do cadastro
    motivosRecusa: { itens: motivos.map((m) => ({ motivo: m._id, n: m.n })), semMotivo: recusadasSemMotivo },
    pontosExtra: { itens: pontosExtra, menosAprovado, minimoPraRanquear: MIN_PRA_RANQUEAR },
    topRecusados: {
      promotores: topPromotores.map((r) => ({ nome: r._id, recusadas: r.recusadas, fotos: r.fotos })),
      clientes: topClientes.map((r) => ({ nome: r._id, recusadas: r.recusadas, fotos: r.fotos })),
    },
  };
}

module.exports = {
  init,
  REGIOES, PONTOS_EXTRA, MOTIVOS_RECUSA, PRE_AVALIACOES, PERMISSOES,
  LIMITE_SEMANAL, LIMITE_MENSAL, IMAGENS_POR_FOTO, semanaISO, mesDe,
  findUserByEmail, findUserById, checkPassword, listUsers, countPendingSignups, createUser, updateUser, changeOwnPassword, setProvisionalPassword, setPassword, setUserActive, deleteUser,
  setPermissions, permissoesDe, temPerm, gerarCracha, validarCracha, registrarAceite,
  createResetToken, resetPasswordWithToken, validaSenha,
  getConfig, setConfig, listSenhasProg, addSenhaProg, delSenhaProg, hojeBR,
  auditar, listAuditoria, ACOES, AUDITORIA_MESES,
  registrarRetorno, listRetornos,
  exportarTitular, anonimizarTitular, excluirTitularCompleto,
  abrirCorrecao, listCorrecoes, resolverCorrecao,
  criarConvite, senhaProvisoriaAleatoria, CONVITE_DIAS,
  montarBackup, registrarBackup, listBackups, backupsVencidos, removerBackupsDoRegistro, resetarCadastros,
  fotosAExpirar, congelarAgregados, anonimizarSubmissions, removerIdentidadeAntiga, contarAlertas,
  RETENCAO_IMAGEM_DIAS, RETENCAO_IDENTIDADE_DIAS, BACKUP_DIAS, ALERTA_DIAS,
  getInstitucionais, setInstitucionais,
  reference, promotorExiste, grupoExiste, sugerirPromotores,
  addRefItem, removeRefItem, importRefItems, listPromotoresComGrupo, clearPromotores, addPendente, listPendentes, aprovarPendente, rejeitarPendente,
  contarNaSemana, contarNoMes, addSubmission, getSubmission, listSubmissions, contarSubmissions, updateSubmission,
  deleteSubmission, markDownloaded, purgeDownloaded, marcarPresenca, setRanking, listRanking, aderencia, serie,
};
