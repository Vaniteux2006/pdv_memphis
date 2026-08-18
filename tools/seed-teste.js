// Popula o banco com DADOS DE TESTE: contas de promotor + fotos reais no Cloudinary,
// espalhadas por região, grupo, cliente, cidade e data — pra testar volume e ver a
// aderência/ranking com números de verdade.
//
// Tudo que este script cria fica marcado com { teste: true } (contas e fotos), então
// dá pra apagar depois sem tocar em nada real.
//
// O tamanho da carga é o --fotos; as contas saem da conta inversa (cada promotor manda
// de 1 a 8 fotos, respeitando as travas de 1/semana e 4/mês). Quando as fotos passam do
// número de imagens da pasta, os personagens se repetem — mas só depois que a pasta
// inteira já rodou uma vez, e cada foto tem sempre a SUA cópia no Cloudinary.
//
//   node tools/seed-teste.js --fotos 1000
//   node tools/seed-teste.js --exclusivo                    (1 personagem = 1 foto = 1 promotor)
//   node tools/seed-teste.js --limpar                       (apaga TUDO que foi semeado)
//
// Opções:
//   --dir PATH      pasta com as imagens (.jpg/.jpeg/.png/.webp). Padrão: Downloads/rostinho
//   --fotos N       quantas fotos criar (padrão 100)
//   --semanas N     janela de datas de exposição, em semanas (padrão 14). Abrir a janela
//                   é o que permite mais fotos por promotor sem furar 1/semana e 4/mês.
//   --exclusivo     nenhum personagem se repete: 1 foto por promotor, teto = nº de imagens
//   --duplas P      fração de envios "antes e depois" com 2 imagens distintas (padrão 0.2)
//   --senha X       senha das contas de teste (padrão "teste123")
//   --limpar        remove contas e fotos de teste (inclusive do Cloudinary)

require('dotenv').config({ quiet: true });
const fs = require('fs');
const path = require('path');
const db = require('../lib/db');
const store = require('../lib/storage');
const { getDb } = require('../lib/mongo');
const cidades = require('../lib/cities');

// ---- argumentos ----
const arg = (nome, padrao) => {
  const i = process.argv.indexOf('--' + nome);
  return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : padrao;
};
const LIMPAR = process.argv.includes('--limpar');
const DIR = arg('dir', 'C:/Users/Pichau/Downloads/rostinho');
const EXCLUSIVO = process.argv.includes('--exclusivo'); // 1 personagem = 1 foto = 1 promotor
const N_FOTOS = Number(arg('fotos', 100));
const P_DUPLAS = Number(arg('duplas', 0.2));    // envios "antes e depois" (2 imagens distintas)
const N_GRUPOS = Number(arg('grupos', 12));     // quantos grupos a carga usa
const P_INATIVOS = Number(arg('inativos', 0.6)); // cadastrados no grupo que NÃO mandam foto
const SENHA = arg('senha', 'teste123');
const PASTA_CLOUD = 'memphis-pdv/fotos'; // a MESMA que a API aceita (o resto ela rejeita)
const LOTE_CLOUD = 12; // uploads/deletes simultâneos no Cloudinary

// ---- sorteio ----
const rnd = (n) => Math.floor(Math.random() * n);
const pick = (arr) => arr[rnd(arr.length)];
const chance = (p) => Math.random() < p;
const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

// cidade coerente com a região (o UF vem no fim do texto: "Recife - PE")
const UF_POR_REGIAO = {
  NE: ['BA', 'PE', 'CE', 'MA', 'PI', 'RN', 'PB', 'AL', 'SE'],
  CN: ['GO', 'DF', 'MT', 'MS', 'PA', 'AM', 'TO', 'RO', 'AC', 'AP', 'RR'],
  SP: ['SP'],
  SE: ['RJ', 'MG', 'ES'],
  SUL: ['PR', 'SC', 'RS'],
};
const cidadesPorRegiao = {};
for (const [sigla, ufs] of Object.entries(UF_POR_REGIAO)) {
  cidadesPorRegiao[sigla] = cidades.filter((c) => ufs.includes(c.slice(-2)));
}
const RUAS = ['Av. Brasil', 'Rua das Flores', 'Av. Getúlio Vargas', 'Rua XV de Novembro', 'Av. Central',
  'Rua do Comércio', 'Av. Santos Dumont', 'Rua São João', 'Av. Presidente Vargas', 'Rua Sete de Setembro'];
const BAIRROS = ['Centro', 'Jardim América', 'Vila Nova', 'Boa Vista', 'Santa Luzia', 'São José', 'Bela Vista'];
const endereco = (regiao) =>
  `${pick(RUAS)}, ${100 + rnd(1800)} - ${pick(BAIRROS)}, ${pick(cidadesPorRegiao[regiao] || cidades)}`;

const OBS_RECUSA = [
  'Foto fora de foco, não dá pra ler o preço.',
  'Exposição não é da marca — refazer.',
  'Falta a etiqueta de preço na imagem.',
  'Foto repetida da semana anterior.',
];

// ---------- limpeza ----------
async function limpar() {
  const mdb = await getDb();
  const subs = await mdb.collection('submissions').find({ teste: true }).toArray();
  const todas = subs.flatMap((s) => s.imagens || []);
  console.log(`Apagando ${subs.length} fotos de teste e ${todas.length} imagens do Cloudinary...`);
  // em paralelo: apagar mil imagens uma a uma levaria uns 10 minutos
  await emLotes(todas, LOTE_CLOUD, (img) => store.remove(img.storedFile, img.resourceType || 'image'), 'imagens ');
  const imgs = todas.length;
  const rs = await mdb.collection('submissions').deleteMany({ teste: true });
  const ru = await mdb.collection('users').deleteMany({ teste: true });
  // desfaz só o grupo que o SEED escreveu no banco de promotores (marcado com grupoTeste).
  // Cadastro feito pela tela ou por planilha não tem essa marca e fica onde está.
  const rg = await mdb.collection('promotores').updateMany(
    { grupoTeste: true }, { $set: { grupo: '' }, $unset: { grupoTeste: '' } }
  );
  console.log(`Pronto: ${rs.deletedCount} fotos, ${imgs} imagens no Cloudinary, ${ru.deletedCount} contas, ` +
    `${rg.modifiedCount} grupo(s) de promotor desfeito(s).`);
}

// ---------- datas: semanas distintas, respeitando 1/semana e 4/mês ----------
// Gera até k datas de exposição pro promotor nas últimas SEMANAS_ATRAS semanas, sem
// repetir semana ISO e sem passar de 4 no mesmo mês — as mesmas travas do envio real.
// Por isso um promotor não passa de ~14 fotos por mais que se peça.
const SEMANAS_ATRAS = Number(arg('semanas', 14));
function datasDoPromotor(k) {
  const hoje = new Date();
  const semanas = embaralha([...Array(SEMANAS_ATRAS).keys()]);
  const escolhidas = [], porMes = {}, semanasUsadas = new Set();
  for (const s of semanas) {
    if (escolhidas.length >= k) break;
    const d = new Date(hoje);
    d.setDate(d.getDate() - s * 7 - rnd(6));
    const iso = d.toISOString().slice(0, 10);
    const sem = db.semanaISO(iso), mes = db.mesDe(iso);
    if (semanasUsadas.has(sem)) continue;
    if ((porMes[mes] || 0) >= db.LIMITE_MENSAL) continue;
    semanasUsadas.add(sem); porMes[mes] = (porMes[mes] || 0) + 1;
    escolhidas.push(iso);
  }
  return escolhidas.sort();
}

// embaralha no lugar (Fisher-Yates)
function embaralha(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = rnd(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// Sorteia imagens sem repetir enquanto a pasta não acabar: dá uma volta completa na
// pasta embaralhada antes de qualquer personagem aparecer de novo.
function baralhoDeImagens(arquivos) {
  let pilha = [];
  return () => {
    if (!pilha.length) pilha = embaralha(arquivos.slice());
    return pilha.pop();
  };
}

// ---------- execução em lotes, com barra de progresso e ETA ----------
async function emLotes(itens, tamanho, fn, rotulo = '') {
  const out = [];
  const t0 = Date.now();
  for (let i = 0; i < itens.length; i += tamanho) {
    out.push(...await Promise.all(itens.slice(i, i + tamanho).map(fn)));
    const feitos = Math.min(i + tamanho, itens.length);
    const seg = (Date.now() - t0) / 1000;
    const falta = Math.round((seg / feitos) * (itens.length - feitos));
    process.stdout.write(`\r  ${rotulo}${feitos}/${itens.length}  (${Math.round(feitos / seg)}/s, faltam ~${falta}s)   `);
  }
  process.stdout.write('\n');
  return out;
}

// tenta de novo quando o Cloudinary recusa por rajada/rede — 1 falha não derruba a carga
async function comRetry(fn, tentativas = 3) {
  for (let i = 1; ; i++) {
    try { return await fn(); }
    catch (e) {
      if (i >= tentativas) throw e;
      await new Promise((r) => setTimeout(r, 400 * i * i));
    }
  }
}

// ---------- semeadura ----------
async function semear() {
  const arquivos = fs.readdirSync(DIR)
    .filter((f) => /\.(jpe?g|png|webp)$/i.test(f))
    .map((f) => path.join(DIR, f));
  if (!arquivos.length) throw new Error(`Nenhuma imagem em ${DIR}`);
  console.log(`${arquivos.length} imagens em ${DIR}`);

  const mdb = await getDb();
  const ref = await db.reference();
  const { senhaMensal, senhaSemanal } = await db.getConfig();
  const regioes = ref.regioes.map((r) => r.sigla);
  // poucos grupos de propósito: espalhar 40 promotores em 37 grupos daria 1 pessoa por
  // grupo, e todo % de participação sairia 0% ou 100%. Menos grupos = grupos de verdade.
  const grupos = (ref.grupos.length ? ref.grupos : ['PDV NE', 'PDV SP', 'PDV SUL']).slice(0, N_GRUPOS);
  const clientes = ref.clientes.length ? ref.clientes : ['SUPERMERCADO CENTRAL'];

  // ---- quantas contas, quantas fotos cada uma? ----
  // Teto real por promotor: 1 foto/semana E 4/mês dentro da janela — em 14 semanas dá ~12.
  // O nº de contas vem do banco de promotores (só nomes reais, pra promotorNoBanco = true),
  // então a média por conta é o que sobra da divisão: 5000 fotos / 731 nomes ≈ 7 cada.
  const MAX_POR_CONTA = Math.min(SEMANAS_ATRAS, db.LIMITE_MENSAL * Math.ceil(SEMANAS_ATRAS / 4.345));
  const MEDIA_PADRAO = 4.5; // quando sobra nome no banco, um promotor típico manda ~4-5
  const disponiveis = await mdb.collection('promotores').countDocuments({});
  const contasAlvo = EXCLUSIVO
    ? Math.min(disponiveis, N_FOTOS)
    : Math.min(disponiveis, Math.ceil(N_FOTOS / MEDIA_PADRAO));
  const mediaNecessaria = EXCLUSIVO ? 1 : N_FOTOS / contasAlvo;
  if (mediaNecessaria > MAX_POR_CONTA)
    throw new Error(
      `${N_FOTOS} fotos em ${disponiveis} nomes dariam ${mediaNecessaria.toFixed(1)} fotos por promotor, ` +
      `mas 1/semana + ${db.LIMITE_MENSAL}/mês limitam a ${MAX_POR_CONTA} em ${SEMANAS_ATRAS} semanas. ` +
      `Use --semanas pra abrir a janela, ou no máximo --fotos ${disponiveis * MAX_POR_CONTA}.`);

  const banco = await mdb.collection('promotores').aggregate([{ $sample: { size: contasAlvo } }]).toArray();
  const nomes = [...new Set(banco.map((p) => p.nome))];

  // ---- contas + o plano de fotos de cada uma ----
  console.log(`\nCriando até ${nomes.length} contas (~${mediaNecessaria.toFixed(1)} fotos cada, senha "${SENHA}")...`);
  const proximaImagem = baralhoDeImagens(arquivos);
  const plano = [];
  const contas = [];
  for (let i = 0; i < nomes.length && plano.length < N_FOTOS; i++) {
    const nome = nomes[i];
    const regiao = pick(regioes);
    const grupo = pick(grupos);
    const primeiro = norm(nome).split(' ')[0].replace(/[^a-z]/g, '') || 'promotor';
    const email = `${primeiro}.${String(i + 1).padStart(4, '0')}@teste.local`;
    let user;
    try {
      user = await db.createUser({
        email, name: nome, password: SENHA, role: 'promotor',
        grupo, regiao, telefone: `11${9}${String(10000000 + rnd(89999999))}`,
      });
    } catch (e) {
      console.log(`  pulei ${email}: ${e.message}`);
      continue;
    }
    await mdb.collection('users').updateOne({ id: user.id }, { $set: { teste: true } }); // marca pra limpeza
    // o nome também é cadastrado no GRUPO dentro do banco de promotores — é esse cadastro
    // que vira o denominador do "% de participação do grupo" na aderência
    // grupoTeste marca o que foi mexido: o banco de promotores é dado REAL, e o --limpar
    // precisa saber o que desfazer. O filtro por grupo vazio é a outra metade da proteção —
    // quem já tem grupo cadastrado de verdade não é tocado (e nem entra no que será apagado).
    await mdb.collection('promotores').updateOne(
      { nomeNorm: norm(nome), grupo: { $in: ['', null] } }, { $set: { grupo, grupoTeste: true } });
    const conta = { ...user, nome };
    contas.push(conta);

    // alvo dinâmico: reparte o que falta entre as contas que ainda faltam, com uma
    // variação de ±40% pra não ficar todo mundo com o mesmo número de fotos.
    // Se uma conta rende menos (as travas de semana/mês cortam), as próximas compensam.
    const restamFotos = N_FOTOS - plano.length;
    const restamContas = nomes.length - i;
    const alvo = restamFotos / restamContas;
    const quantas = EXCLUSIVO ? 1
      : Math.min(restamFotos, MAX_POR_CONTA, Math.max(1, Math.round(alvo * (0.6 + Math.random() * 0.8))));
    for (const data of datasDoPromotor(quantas)) {
      const reg = chance(0.15) ? pick(regioes) : regiao;      // um pouco de itinerância
      plano.push({
        conta, regiao: reg,
        grupo: chance(0.15) ? pick(grupos) : grupo,           // grupos variados por foto
        cliente: pick(clientes),
        endereco: endereco(reg),
        dataExposicao: data,
        // "antes e depois": 2 imagens SEMPRE de personagens diferentes
        arquivos: chance(P_DUPLAS) ? [proximaImagem(), proximaImagem()] : [proximaImagem()],
      });
    }
    if (contas.length % 50 === 0) process.stdout.write(`\r  ${contas.length} contas, ${plano.length} fotos planejadas   `);
  }
  console.log(`\n  ${contas.length} contas criadas, ${plano.length} fotos planejadas.`);

  // ---- cadastro de quem NÃO participa ----
  // Sem isso todo grupo teria só participantes e a aderência daria 100% em tudo. Aqui
  // outros nomes do banco entram nos mesmos grupos sem conta e sem foto — é a parcela
  // que a campanha quer descobrir que não está mandando nada.
  const jaUsados = new Set(contas.map((c) => norm(c.nome)));
  const alvoInativos = Math.round(contas.length * (P_INATIVOS / Math.max(0.0001, 1 - P_INATIVOS)));
  const candidatos = (await mdb.collection('promotores')
    .aggregate([{ $sample: { size: alvoInativos * 3 } }, { $project: { _id: 0, nome: 1, nomeNorm: 1 } }]).toArray())
    .filter((p) => !jaUsados.has(p.nomeNorm)).slice(0, alvoInativos);
  if (candidatos.length) {
    await mdb.collection('promotores').bulkWrite(candidatos.map((p) => ({
      updateOne: {
        filter: { nomeNorm: p.nomeNorm, grupo: { $in: ['', null] } }, // nunca por cima de cadastro real
        update: { $set: { grupo: pick(grupos), grupoTeste: true } },
      },
    })));
  }
  console.log(`  ${candidatos.length} nomes cadastrados nos grupos SEM mandar foto (os inativos).`);
  const totalImagens = plano.reduce((s, p) => s + p.arquivos.length, 0);

  // ---- upload das imagens (as mesmas que o navegador mandaria) ----
  console.log(`\nSubindo ${totalImagens} imagens pro Cloudinary (${plano.length} fotos)...`);
  const falhas = [];
  const enviados = (await emLotes(plano, LOTE_CLOUD, async (p) => {
    try {
      return {
        ...p,
        imagens: await Promise.all(p.arquivos.map(async (f) => {
          const r = await comRetry(() => store.uploadBuffer(fs.readFileSync(f), { folder: PASTA_CLOUD, resourceType: 'image' }));
          return { storedFile: r.id, resourceType: r.resourceType, originalName: path.basename(f) };
        })),
      };
    } catch (e) { falhas.push(e.message); return null; } // 1 imagem ruim não derruba a carga
  }, 'envios ')).filter(Boolean);
  if (falhas.length) console.log(`  ${falhas.length} upload(s) falharam: ${[...new Set(falhas)].slice(0, 3).join(' | ')}`);

  // ---- registros ----
  console.log(`\nGravando ${enviados.length} fotos...`);
  const criadas = await emLotes(enviados, 25, (p) => db.addSubmission({
    imagens: p.imagens,
    uploadedBy: p.conta.id, uploadedByEmail: p.conta.email,
    senhaMensal, senhaSemanal,
    cliente: p.cliente, endereco: p.endereco, regiao: p.regiao,
    promotor: p.conta.nome, grupo: p.grupo, dataExposicao: p.dataExposicao,
    promotorNoBanco: true,
    teste: true, // marca pra limpeza
  }), 'fotos ');

  // ---- avaliação: mistura de aprovadas, recusadas e pendentes (pra aderência ter o que mostrar) ----
  console.log('Avaliando (aprovadas / recusadas / pendentes)...');
  const contagem = { validadas: 0, recusadas: 0, pendentes: 0, pagas: 0, baixadas: 0 };
  const avaliacoes = [];
  // uma fatia dos promotores manda foto ruim SEMPRE. Sem isso quase todo mundo acaba com
  // ao menos uma aprovada e a "assertividade" do grupo sai colada na "participação" —
  // justamente a diferença que a campanha quer enxergar.
  const ruins = new Set(contas.filter(() => chance(0.25)).map((c) => c.id));
  // ponto extra é escolhido ANTES da decisão (o avaliador marca o que vê na foto), então
  // foto recusada também leva ponto — é isso que permite medir "ponto menos aprovado"
  const sorteiaPontos = () => {
    const p = chance(0.6) ? [pick(ref.pontosExtra)] : [];
    if (p.length && chance(0.25)) p.push(pick(ref.pontosExtra));
    return [...new Set(p)];
  };
  // um ponto extra "problemático" por rodada: as fotos que o levam são reprovadas mais.
  // É o que permite conferir se o "ponto menos aprovado" da aderência realmente o encontra.
  const pontoProblema = pick(ref.pontosExtra);
  console.log(`  (ponto plantado como problemático: "${pontoProblema}")`);
  for (const s of criadas) {
    const patch = { pontosExtra: sorteiaPontos() };
    const ruim = ruins.has(s.uploadedBy);
    const sorte = Math.random();
    const problema = patch.pontosExtra.includes(pontoProblema);
    const limiteAprovar = ruim ? 0.10 : problema ? 0.25 : 0.70; // promotor ruim quase nunca é aprovado
    const limiteRecusar = ruim ? 0.90 : problema ? 0.92 : 0.86;
    if (sorte < limiteAprovar) {
      patch.validado = true;
      patch.preAvaliacao = pick(['REGULAR', 'BOM', 'BOM', 'EXCELENTE']);
      patch.pago = chance(0.7); if (patch.pago) contagem.pagas++;
      patch.baixado = chance(0.5); if (patch.baixado) contagem.baixadas++;
      contagem.validadas++;
    } else if (sorte < limiteRecusar) {
      patch.validado = false;
      patch.preAvaliacao = 'REGULAR';
      // motivo é obrigatório ao recusar desde que o promotor passou a vê-lo (plano LGPD 1.5.2),
      // então a carga sempre escolhe um da lista oficial — é o que a aderência soma
      patch.motivoRecusa = pick(ref.motivosRecusa);
      patch.observacao = pick(OBS_RECUSA);
      contagem.recusadas++;
    } else {
      contagem.pendentes++;
      if (chance(0.4)) patch.preAvaliacao = pick(['BOM', 'EXCELENTE']); // avaliada, ainda sem decisão
    }
    avaliacoes.push({ id: s.id, patch });
  }
  await emLotes(avaliacoes, 25, (a) => db.updateSubmission(a.id, a.patch), 'avaliadas ');

  // ---- ranking da edição mais recente (1º/2º/3º entre as EXCELENTE aprovadas) ----
  const todas = await db.listSubmissions({});
  const elegiveis = todas.filter((s) => s.teste && s.validado === true && s.preAvaliacao === 'EXCELENTE');
  const mesMaisRecente = elegiveis.map((s) => s.mesKey).sort().pop();
  const podio = elegiveis.filter((s) => s.mesKey === mesMaisRecente).slice(0, 3);
  for (let i = 0; i < podio.length; i++) await db.setRanking(podio[i].id, i + 1);

  // ---- resumo ----
  const personagens = new Set(criadas.flatMap((s) => s.imagens.map((i) => i.originalName))).size;
  const ade = await db.aderencia({});
  console.log(`
──────────────────────────────────────────────
  Contas de promotor:  ${contas.length}   (senha "${SENHA}", e-mails @teste.local)
  Fotos:               ${criadas.length}   (${totalImagens} imagens no Cloudinary, ${personagens} personagens distintos)
  Antes e depois:      ${criadas.filter((s) => s.imagens.length === 2).length} envios com 2 imagens
  Aprovadas:           ${contagem.validadas}  (pagas: ${contagem.pagas}, baixadas: ${contagem.baixadas})
  Recusadas:           ${contagem.recusadas}
  Pendentes:           ${contagem.pendentes}
  Pódio da edição:     ${podio.length} foto(s) em ${mesMaisRecente || '—'}
──────────────────────────────────────────────
  Aderência (últimos 3 meses): ${ade.promotores.participantes} promotores participantes
  de ${ade.base.contasAtivas} contas ativas / ${ade.base.banco} no banco
  Regiões com movimento: ${ade.regioes.map((r) => `${r.sigla}(${r.promotores})`).join(' ')}

  Login de exemplo: ${contas[0] ? contas[0].email : '—'} / ${SENHA}
  Pra desfazer:     node tools/seed-teste.js --limpar
`);
}

(async () => {
  await db.init();
  if (LIMPAR) await limpar();
  else await semear();
  process.exit(0);
})().catch((e) => { console.error('\nERRO:', e.message); process.exit(1); });
