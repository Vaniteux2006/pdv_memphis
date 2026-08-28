// Retenção e anonimização (plano LGPD 1.5). Fotos são ENVELHECIDAS na marra — createdAt
// no passado — porque é a única forma de provar os prazos sem esperar 2 meses.
// Cobre os casos obrigatórios 3, 4, 5 e 7 do plano.
// Fala direto com o banco de TESTE (não precisa de servidor no ar):
//   node test/retencao.js
process.env.MONGO_DB = 'memphis_pdv_test';
process.env.RETENCAO_APAGA = '1';
require('dotenv').config({ quiet: true });
const db = require('../lib/db');
const { getDb } = require('../lib/mongo');

let pass = 0, fail = 0;
const ck = (n, ok, d = '') => { console.log((ok ? '✓' : '✗') + ' ' + n + (d ? ' — ' + d : '')); ok ? pass++ : fail++; };
const diasAtras = (n) => new Date(Date.now() - n * 864e5).toISOString();

(async () => {
  await db.init();
  const mdb = await getDb();

  const u = await db.createUser({ email: 'ret' + Date.now() + '@local', name: 'PROMOTOR RETENCAO', password: 'ret12345', role: 'promotor', grupo: 'G-RET', regiao: 'NE' });
  // o grupo OFICIAL vem do banco de promotores (é o denominador da aderência)
  await mdb.collection('promotores').updateOne(
    { nomeNorm: 'promotor retencao' },
    { $set: { id: 'ret-' + Date.now(), nome: 'PROMOTOR RETENCAO', nomeNorm: 'promotor retencao', grupo: 'G-OFICIAL' } },
    { upsert: true });

  const mk = async (dias, extra = {}) => {
    const s = await db.addSubmission({
      imagens: [{ storedFile: 'memphis-pdv/fotos/falsa-' + Math.random().toString(36).slice(2), resourceType: 'image' }],
      uploadedBy: u.id, uploadedByEmail: u.email, senhaMensal: 'A', senhaSemanal: 'B',
      cliente: 'LOJA RET', endereco: 'Rua Secreta, 42', regiao: 'NE',
      promotor: u.name, grupo: 'G-RET', dataExposicao: '2026-06-0' + (1 + (dias % 8)),
      promotorNoBanco: true, ...extra,
    });
    await mdb.collection('submissions').updateOne({ id: s.id }, { $set: { createdAt: diasAtras(dias) } });
    return s;
  };

  const velha = await mk(70);                 // passou dos 2 meses
  const nova = await mk(5);                   // recente
  const recusada = await mk(80);
  await db.updateSubmission(recusada.id, { validado: false, motivoRecusa: 'Sem senha, ou senha ilegível', observacao: 'canto escuro' });
  const vencedora = await mk(75);
  await db.updateSubmission(vencedora.id, { validado: true, preAvaliacao: 'EXCELENTE' });
  await db.setRanking(vencedora.id, 1);

  console.log('\n== antes da retenção ==');
  ck('pódio foi gravado como REGISTRO na marcação', (await mdb.collection('ranking').countDocuments({ submissionId: vencedora.id })) === 1);
  ck('recusa gerou retorno na coleção própria', (await db.listRetornos(u.id)).length === 1);

  const antesAderencia = await db.aderencia({});
  const grupoAntes = antesAderencia.gruposCadastrados.find((g) => g.grupo === 'G-OFICIAL');

  console.log('\n== rodando a retenção ==');
  const subs = await db.fotosAExpirar();
  ck('só as fotos com mais de 60 dias entram', subs.length === 3 && !subs.some((s) => s.id === nova.id), subs.length + ' candidata(s)');
  ck('recusada expira igual às outras (régua por IDADE, não status)', subs.some((s) => s.id === recusada.id));
  ck('vencedora de ranking NÃO é exceção', subs.some((s) => s.id === vencedora.id));

  await db.congelarAgregados(subs);
  await db.anonimizarSubmissions(subs);

  console.log('\n== depois ==');
  const doc = await mdb.collection('submissions').findOne({ id: velha.id });
  ck('nome, endereço e searchBlob foram limpos', !doc.promotor && !doc.promotorNorm && !doc.endereco && !doc.searchBlob);
  ck('uploadedBy AINDA existe aos 2 meses (o promotor precisa do histórico)', !!doc.uploadedBy);
  ck('grupoOficial foi congelado antes de limpar', doc.grupoOficial === 'G-OFICIAL', 'grupoOficial=' + doc.grupoOficial);
  ck('dados agregáveis sobrevivem', !!doc.mesKey && !!doc.regiao && !!doc.dataExposicao);

  // $lookup não pode mais devolver o nome
  const viaLookup = await mdb.collection('submissions').aggregate([
    { $match: { id: velha.id } },
    { $lookup: { from: 'promotores', localField: 'promotorNorm', foreignField: 'nomeNorm', as: 'b' } },
  ]).toArray();
  ck('um $lookup NÃO devolve o nome (anonimizou de verdade, não pseudonimizou)', (viaLookup[0].b || []).length === 0);

  const depoisAderencia = await db.aderencia({});
  const grupoDepois = depoisAderencia.gruposCadastrados.find((g) => g.grupo === 'G-OFICIAL');
  ck('aderência por grupo continua batendo após anonimizar',
    !!grupoDepois && grupoDepois.fotos === (grupoAntes ? grupoAntes.fotos : 0),
    `antes=${grupoAntes ? grupoAntes.fotos : 0} depois=${grupoDepois ? grupoDepois.fotos : 0}`);

  ck('promotor ainda vê a recusa com a imagem já apagada', (await db.listRetornos(u.id)).length === 1);
  const rk = await db.listRanking();
  const ed = rk.find((e) => e.fotos.some((f) => f.id === vencedora.id));
  ck('ranking de edição passada renderiza sem imagem quebrada (temFoto=false)',
    !!ed && ed.fotos.find((f) => f.id === vencedora.id).temFoto === false);
  ck('nome do vencedor sobrevive no quadro de honra', !!ed.fotos.find((f) => f.id === vencedora.id).promotor);

  // 6 meses: sai a identidade
  await mdb.collection('submissions').updateOne({ id: velha.id }, { $set: { createdAt: diasAtras(200) } });
  await db.removerIdentidadeAntiga();
  const doc6 = await mdb.collection('submissions').findOne({ id: velha.id });
  ck('aos 6 meses o uploadedBy sai (senão é pseudonimização)', !doc6.uploadedBy);
  ck('mesmo assim o retorno da recusa continua de pé', (await db.listRetornos(u.id)).length === 1);

  console.log(`\n=== ${pass} passou, ${fail} falhou ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERRO', e); process.exit(1); });
