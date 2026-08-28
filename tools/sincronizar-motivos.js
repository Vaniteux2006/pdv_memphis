// Põe a lista de MOTIVOS DE RECUSA do banco igual à constante MOTIVOS_RECUSA do código
// (os 14 motivos do capítulo 10 do Manual de Execução de PDV + "Outros").
//
// Por que este script existe: `motivosRecusa` só vale a constante do código ENQUANTO
// ninguém editou a lista pela aba Listas. Na primeira edição ela é gravada no refdata e
// daí em diante o banco é a fonte da verdade — trocar a constante deixa de ter efeito.
// Num banco nesse estado, alinhar pela tela seria remover um a um e adicionar catorze.
//
//   node tools/sincronizar-motivos.js              (só mostra o que mudaria)
//   node tools/sincronizar-motivos.js --aplicar    (grava de verdade)
//
// Remover um motivo NÃO mexe nas fotos já recusadas com ele: a tela de avaliação continua
// mostrando o motivo antigo na foto que o tem, e a Aderência segue contando esse motivo no
// histórico. O que muda é só o que a equipe pode escolher daqui pra frente.
require('dotenv').config({ quiet: true });
const db = require('../lib/db');

const APLICAR = process.argv.includes('--aplicar');
const norm = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

(async () => {
  await db.init();
  console.log(`\nBanco: ${process.env.MONGO_DB || 'memphis_pdv'}\n`);

  const atual = (await db.reference()).motivosRecusa;
  const alvo = db.MOTIVOS_RECUSA;

  const saem = atual.filter((m) => !alvo.some((a) => norm(a) === norm(m)));
  const entram = alvo.filter((a) => !atual.some((m) => norm(m) === norm(a)));

  console.log(`Hoje no banco (${atual.length}):`);
  atual.forEach((m) => console.log(`   ${saem.includes(m) ? '−' : ' '} ${m}`));
  console.log(`\nEntram (${entram.length}):`);
  entram.forEach((m) => console.log(`   + ${m}`));

  if (!saem.length && !entram.length) {
    console.log('\nA lista já está igual à do código. Nada a fazer.');
    process.exit(0);
  }
  if (!APLICAR) {
    console.log('\n(nada foi gravado — rode com --aplicar pra valer)');
    process.exit(0);
  }

  // remove tudo e readiciona na ordem da constante: o refdata guarda a ordem, e é ela que
  // define a ordem dos botões na tela de avaliação
  for (const m of atual) await db.removeRefItem('motivosRecusa', m);
  for (const m of alvo) await db.addRefItem('motivosRecusa', m);

  const final = (await db.reference()).motivosRecusa;
  console.log(`\nPronto: ${final.length} motivo(s) na lista.`);
  final.forEach((m, i) => console.log(`   ${String(i + 1).padStart(2)}. ${m}`));
  console.log('\nFotos já recusadas mantêm o motivo que receberam.');
  process.exit(0);
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
