// Acha e apaga imagens ÓRFÃS no Cloudinary — as que estão lá mas nenhuma foto do banco usa.
//
// Por que elas existem: o navegador sobe a imagem DIRETO no Cloudinary e só depois registra
// os metadados no servidor. Se o envio for interrompido no meio (aba fechada, internet caiu,
// limite semanal recusado no meio de uma rajada), o arquivo fica lá pagando espaço pra sempre.
// O servidor já limpa o que ele mesmo rejeita; o que se perde é o que nunca chegou nele.
//
//   node tools/limpar-orfas.js              (só lista — não apaga nada)
//   node tools/limpar-orfas.js --apagar     (apaga de verdade)
//   node tools/limpar-orfas.js --apagar --horas 48
//
// Opções:
//   --apagar     sem isso, é só relatório (o padrão é não apagar)
//   --horas N    ignora imagens com menos de N horas (padrão 24) — protege envio em andamento
//   --forcar     ignora a trava de segurança abaixo (use sabendo o que está fazendo)
//
// ⚠️ ATENÇÃO — A CONTA DO CLOUDINARY É COMPARTILHADA ENTRE OS BANCOS.
// A pasta é a mesma pro banco de produção e pro de teste (memphis_pdv / memphis_pdv_test).
// "Órfã" aqui quer dizer "nenhuma foto DESTE banco usa". Rodar com o MONGO_DB errado, então,
// marcaria como órfãs as imagens do OUTRO banco. Por isso: confira o banco que aparece no
// cabeçalho da saída antes de usar --apagar, e a trava exige --forcar quando o quadro é
// suspeito (banco quase vazio e nuvem cheia).

require('dotenv').config({ quiet: true });
const db = require('../lib/db');
const store = require('../lib/storage');
const { getDb } = require('../lib/mongo');

const APAGAR = process.argv.includes('--apagar');
const iH = process.argv.indexOf('--horas');
const HORAS = iH > -1 ? Number(process.argv[iH + 1]) || 24 : 24;
const PASTA = 'memphis-pdv/fotos';
const LOTE = 12;

async function emLotes(itens, tamanho, fn) {
  for (let i = 0; i < itens.length; i += tamanho) {
    await Promise.all(itens.slice(i, i + tamanho).map(fn));
    process.stdout.write(`\r  ${Math.min(i + tamanho, itens.length)}/${itens.length}   `);
  }
  process.stdout.write('\n');
}

(async () => {
  await db.init();
  const mdb = await getDb();

  // 1) tudo que o BANCO conhece (inclusive o formato antigo de campo único)
  const usados = new Set();
  const subs = await mdb.collection('submissions')
    .find({}, { projection: { _id: 0, imagens: 1, storedFile: 1 } }).toArray();
  for (const s of subs) {
    for (const img of s.imagens || []) if (img.storedFile) usados.add(img.storedFile);
    if (s.storedFile) usados.add(s.storedFile);
  }
  console.log(`banco: ${process.env.MONGO_DB || 'memphis_pdv'} — ${subs.length} fotos usando ${usados.size} imagem(ns).`);

  // 2) tudo que está no Cloudinary (a API pagina de 500 em 500)
  const naNuvem = [];
  let cursor;
  do {
    const r = await store.cloudinary.api.resources({
      type: 'authenticated', prefix: PASTA, max_results: 500, next_cursor: cursor,
    });
    naNuvem.push(...r.resources);
    cursor = r.next_cursor;
  } while (cursor);
  console.log(`${naNuvem.length} imagem(ns) na pasta ${PASTA}.`);

  // 3) órfã = está na nuvem, ninguém referencia, e já passou da janela de segurança
  const limite = Date.now() - HORAS * 3600 * 1000;
  const orfas = [], recentes = [];
  for (const r of naNuvem) {
    if (usados.has(r.public_id)) continue;
    (new Date(r.created_at).getTime() > limite ? recentes : orfas).push(r);
  }

  const mb = (lista) => (lista.reduce((s, r) => s + (r.bytes || 0), 0) / 1048576).toFixed(2);
  console.log(`\n  órfãs com mais de ${HORAS}h: ${orfas.length}  (${mb(orfas)} MB)`);
  if (recentes.length) console.log(`  recentes (poupadas — pode ser envio em andamento): ${recentes.length}`);
  for (const r of orfas.slice(0, 15)) {
    console.log(`    ${r.created_at}  ${String(Math.round((r.bytes || 0) / 1024)).padStart(5)} KB  ${r.width}x${r.height}  ${r.public_id}`);
  }
  if (orfas.length > 15) console.log(`    ...e mais ${orfas.length - 15}`);

  if (!orfas.length) { console.log('\nNada a apagar.'); process.exit(0); }
  if (!APAGAR) {
    console.log(`\n(nada foi apagado — rode com --apagar pra remover as ${orfas.length})`);
    process.exit(0);
  }
  // Trava: banco quase vazio + nuvem cheia é a assinatura de "apontei pro banco errado".
  // Como a conta do Cloudinary é a mesma dos dois bancos, esse engano apagaria as imagens
  // do outro banco — e não há como desfazer.
  const suspeito = usados.size * 4 < naNuvem.length && naNuvem.length > 50;
  if (suspeito && !process.argv.includes('--forcar')) {
    console.error(`\n⚠️  PAREI POR SEGURANÇA.`);
    console.error(`   O banco "${process.env.MONGO_DB || 'memphis_pdv'}" usa ${usados.size} imagem(ns), mas a pasta tem ${naNuvem.length}.`);
    console.error(`   Isso costuma significar MONGO_DB apontando pro banco errado — e a conta do`);
    console.error(`   Cloudinary é a mesma dos dois. Confirme o banco e rode com --forcar se estiver certo.`);
    process.exit(1);
  }
  console.log(`\nApagando ${orfas.length}...`);
  let erros = 0;
  await emLotes(orfas, LOTE, async (r) => {
    try { await store.remove(r.public_id, r.resource_type || 'image'); }
    catch { erros++; }
  });
  console.log(`Pronto: ${orfas.length - erros} apagada(s)${erros ? `, ${erros} falharam` : ''}.`);
  process.exit(0);
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
