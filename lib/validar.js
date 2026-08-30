// Validação de FRONTEIRA: o que chega em `req.body` e `req.query`.
//
// Por que isto vale mais que a tipagem estática (Bloco 4 do PLANO.md): tipo some em
// runtime, e `req.body` é hostil por definição — o cliente manda o que quiser. Nenhum dos
// bugs que este projeto teve de fato teria sido pego pelo compilador; todos vieram de
// dado inesperado atravessando uma fronteira.
//
// Sem dependência nova. `zod` faria o mesmo, mas nesta escala não paga o peso — e o
// projeto inteiro roda sem build justamente para o deploy no Discloud continuar sendo
// "sobe a pasta".
//
// As três ameaças que isto fecha, na ordem em que mordem:
//   1. Operador do Mongo no lugar de um valor. `{"email": {"$ne": null}}` num corpo JSON,
//      ou `?promotor[$regex]=.*` numa query (o parser do Express faz virar OBJETO). Toda
//      função aqui EXIGE escalar e recusa objeto/array — não coage, recusa.
//   2. Mass assignment: campo que o cliente não deveria poder mandar. `objeto()` devolve
//      só o que está no esquema; o resto é descartado em silêncio.
//   3. Corpo grande demais / texto sem teto, que vira documento inchado no M0.
//
// Uso, dentro de qualquer rota embrulhada em `ah()`:
//   const { cliente, dataExposicao } = v.objeto(req.body, {
//     cliente: v.texto({ obrigatorio: true, max: 120 }),
//     dataExposicao: v.dataISO({ obrigatorio: true }),
//   });
// O erro sobe como 400 com a mensagem para o usuário — o handler de erro de `server.js`
// já honra `err.status`, então não é preciso try/catch em cada rota.

/** Erro de entrada do cliente. `status: 400` faz o handler de `server.js` responder certo. */
class ErroDeEntrada extends Error {
  /** @param {string} mensagem escrita para quem está na tela, não para o log */
  constructor(mensagem) {
    super(mensagem);
    this.name = 'ErroDeEntrada';
    this.status = 400;
  }
}

/** @param {string} m @returns {never} */
const recusa = (m) => { throw new ErroDeEntrada(m); };

/** ausente = `undefined`, `null` ou string vazia. `false` e `0` NÃO são ausentes. */
const ausente = (v) => v === undefined || v === null || v === '';

/**
 * O portão de verdade: qualquer coisa que não seja escalar é recusada.
 * É aqui que `{$ne: ...}` e `?x[$regex]=` morrem — antes de virar filtro do Mongo.
 * @param {unknown} v
 * @param {string} campo
 */
function exigeEscalar(v, campo) {
  if (v !== null && typeof v === 'object') recusa(`O campo "${campo}" veio num formato que não aceitamos.`);
  return v;
}

/**
 * @typedef {(valor: unknown, campo: string) => any} Regra
 */

/**
 * Texto. Sempre `trim`, sempre com teto — sem `max`, um POST de 1 MB vira um documento
 * de 1 MB no banco.
 * @param {{ obrigatorio?: boolean, max?: number, min?: number, padrao?: string, rotulo?: string }} [opcoes]
 * @returns {Regra}
 */
const texto = ({ obrigatorio = false, max = 200, min = 0, padrao = '', rotulo } = {}) => (v, campo) => {
  const nome = rotulo || campo;
  exigeEscalar(v, nome);
  if (ausente(v)) {
    if (obrigatorio) recusa(`Informe ${nome}.`);
    return padrao;
  }
  const s = String(v).trim();
  if (obrigatorio && !s) recusa(`Informe ${nome}.`);
  if (s.length < min) recusa(`${nome} precisa de ao menos ${min} caracteres.`);
  if (s.length > max) recusa(`${nome} passou de ${max} caracteres.`);
  return s;
};

/**
 * Um valor de uma lista fechada. É o que impede categoria fantasma nos gráficos —
 * o mesmo problema que o `pontosExtra` do Bloco 0 já resolve dentro do `db`.
 * @param {readonly string[]} valores
 * @param {{ obrigatorio?: boolean, padrao?: string, rotulo?: string }} [opcoes]
 * @returns {Regra}
 */
const umDe = (valores, { obrigatorio = false, padrao = '', rotulo } = {}) => (v, campo) => {
  const nome = rotulo || campo;
  exigeEscalar(v, nome);
  if (ausente(v)) {
    if (obrigatorio) recusa(`Escolha ${nome}.`);
    return padrao;
  }
  const s = String(v);
  if (!valores.includes(s)) recusa(`Valor fora da lista em "${nome}".`);
  return s;
};

/**
 * Booleano tolerante: o front às vezes manda `"true"` de um input, às vezes `true` de JSON.
 * @param {{ padrao?: boolean }} [opcoes]
 * @returns {Regra}
 */
const booleano = ({ padrao = false } = {}) => (v, campo) => {
  exigeEscalar(v, campo);
  if (ausente(v)) return padrao;
  if (v === true || v === 'true' || v === 1 || v === '1') return true;
  if (v === false || v === 'false' || v === 0 || v === '0') return false;
  recusa(`O campo "${campo}" precisa ser sim ou não.`);
};

/**
 * Inteiro dentro de uma faixa.
 * @param {{ obrigatorio?: boolean, min?: number, max?: number, padrao?: number|null, rotulo?: string }} [opcoes]
 * @returns {Regra}
 */
const inteiro = ({ obrigatorio = false, min = -Infinity, max = Infinity, padrao = null, rotulo } = {}) => (v, campo) => {
  const nome = rotulo || campo;
  exigeEscalar(v, nome);
  if (ausente(v)) {
    if (obrigatorio) recusa(`Informe ${nome}.`);
    return padrao;
  }
  const n = Number(String(v).trim());
  if (!Number.isInteger(n)) recusa(`${nome} precisa ser um número inteiro.`);
  if (n < min || n > max) recusa(`${nome} precisa estar entre ${min} e ${max}.`);
  return n;
};

const RE_DATA = /^\d{4}-\d{2}-\d{2}$/;
/**
 * Data `'YYYY-MM-DD'` que EXISTE de verdade — o formato sozinho aceitaria `2026-02-31`,
 * e uma data impossível vira `semanaKey` vazia lá na frente, longe daqui.
 * @param {{ obrigatorio?: boolean, padrao?: string, rotulo?: string }} [opcoes]
 * @returns {Regra}
 */
const dataISO = ({ obrigatorio = false, padrao = '', rotulo } = {}) => (v, campo) => {
  const nome = rotulo || campo;
  exigeEscalar(v, nome);
  if (ausente(v)) {
    if (obrigatorio) recusa(`Informe ${nome}.`);
    return padrao;
  }
  const s = String(v).trim();
  if (!RE_DATA.test(s)) recusa(`${nome} precisa estar no formato AAAA-MM-DD.`);
  const d = new Date(s + 'T00:00:00Z');
  if (isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) recusa(`${nome} não é uma data que existe.`);
  return s;
};

// Duas réguas, de propósito — e a diferença NÃO é descuido:
// o cadastro público exige domínio completo (é gente de fora digitando o e-mail dela),
// enquanto o painel precisa aceitar login interno sem ponto no domínio: `admin@local` e
// `mat97561@sem-email.memphis.local` (o caminho de quem não tem e-mail, do 1.7.2).
// Apertar a régua do painel tranca a operação do lado de fora do próprio sistema.
const RE_EMAIL_INTERNO = /^[^\s@]+@[^\s@]+$/;
const RE_EMAIL_COMPLETO = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/**
 * @param {{ obrigatorio?: boolean, dominioCompleto?: boolean, rotulo?: string }} [opcoes]
 *   `dominioCompleto` só para e-mail que uma pessoa de fora digitou (cadastro público)
 * @returns {Regra}
 */
const email = ({ obrigatorio = false, dominioCompleto = false, rotulo } = {}) => (v, campo) => {
  const nome = rotulo || campo;
  exigeEscalar(v, nome);
  if (ausente(v)) {
    if (obrigatorio) recusa(`Informe ${nome}.`);
    return '';
  }
  const s = String(v).trim();
  if (!(dominioCompleto ? RE_EMAIL_COMPLETO : RE_EMAIL_INTERNO).test(s)) recusa(`${nome} inválido.`);
  return s;
};

/**
 * Lista de escalares, com teto de tamanho. O teto importa: sem ele, um array de 100 mil
 * itens vira 100 mil comparações antes de qualquer resposta.
 * @param {Regra} regraDoItem
 * @param {{ max?: number, rotulo?: string }} [opcoes]
 * @returns {Regra}
 */
const lista = (regraDoItem, { max = 50, rotulo } = {}) => (v, campo) => {
  const nome = rotulo || campo;
  if (ausente(v)) return [];
  if (!Array.isArray(v)) recusa(`O campo "${nome}" precisa ser uma lista.`);
  const itens = /** @type {unknown[]} */ (v);
  if (itens.length > max) recusa(`"${nome}" aceita no máximo ${max} itens.`);
  return itens.map((item, i) => regraDoItem(item, `${nome}[${i}]`));
};

/**
 * Objeto aninhado com forma conhecida (ex.: cada foto do envio).
 * @param {Record<string, Regra>} esquema
 * @param {{ rotulo?: string }} [opcoes]
 * @returns {Regra}
 */
const forma = (esquema, { rotulo } = {}) => (v, campo) => {
  const nome = rotulo || campo;
  if (v === null || typeof v !== 'object' || Array.isArray(v)) recusa(`O campo "${nome}" veio num formato que não aceitamos.`);
  return objeto(v, esquema, { rotulo: nome });
};

/**
 * Roda o esquema sobre o corpo e devolve um objeto NOVO. **Só as chaves do esquema
 * entram** — é aqui que o mass assignment morre: mandar `role: 'admin'` num corpo que
 * não prevê `role` não gera erro, gera silêncio, e o campo simplesmente não existe na
 * saída. Erro barulhento seria pior: viraria um oráculo de quais campos existem.
 *
 * @template {Record<string, Regra>} E
 * @param {unknown} corpo `req.body` cru — pode ser `undefined` num POST sem corpo
 * @param {E} esquema
 * @param {{ rotulo?: string }} [opcoes]
 * @returns {Record<string, any>}
 */
function objeto(corpo, esquema, { rotulo = 'corpo da requisição' } = {}) {
  if (corpo === undefined || corpo === null) corpo = {};
  if (typeof corpo !== 'object' || Array.isArray(corpo)) recusa(`O ${rotulo} veio num formato que não aceitamos.`);
  const fonte = /** @type {Record<string, unknown>} */ (corpo);
  /** @type {Record<string, any>} */
  const saida = {};
  for (const [campo, regra] of Object.entries(esquema)) saida[campo] = regra(fonte[campo], campo);
  return saida;
}

/**
 * Variante para PATCH: só valida (e devolve) as chaves que VIERAM. Um PATCH que não
 * menciona `grupo` não pode significar "apague o grupo" — a diferença entre ausente e
 * vazio é o contrato do PATCH, e confundi-las apaga dado sem ninguém ter pedido.
 *
 * @param {unknown} corpo
 * @param {Record<string, Regra>} esquema
 * @returns {Record<string, any>}
 */
function objetoParcial(corpo, esquema) {
  if (corpo === undefined || corpo === null) corpo = {};
  if (typeof corpo !== 'object' || Array.isArray(corpo)) recusa('O corpo da requisição veio num formato que não aceitamos.');
  const fonte = /** @type {Record<string, unknown>} */ (corpo);
  /** @type {Record<string, any>} */
  const saida = {};
  for (const [campo, regra] of Object.entries(esquema)) {
    if (!(campo in fonte)) continue;
    saida[campo] = regra(fonte[campo], campo);
  }
  return saida;
}

module.exports = {
  ErroDeEntrada,
  objeto, objetoParcial, forma,
  texto, umDe, booleano, inteiro, dataISO, email, lista,
  exigeEscalar,
};
