// Cria contas de promotor a partir de uma planilha com Nome + Email.
// Senha provisória = NOME (maiúsculo) + 2026, com troca obrigatória no 1º login.
//   node tools/criar-promotores.js "C:/.../PROMOTORES.xlsx"        (cria de verdade)
//   node tools/criar-promotores.js "C:/.../PROMOTORES.xlsx" --dry  (só mostra, não cria)
require('dotenv').config({ quiet: true });
const ExcelJS = require('exceljs');
const db = require('../lib/db');

const FILE = process.argv[2] || 'C:/Users/Pichau/Downloads/PROMOTORES NÃO PAGOS - junho.xlsx';
const DRY = process.argv.includes('--dry');

function txt(v) {
  if (v == null) return '';
  if (typeof v === 'object') return v.text || (v.result !== undefined ? String(v.result) : (v.richText ? v.richText.map((t) => t.text).join('') : ''));
  return String(v);
}

(async () => {
  if (!DRY) await db.init();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(FILE);

  const byEmail = new Map();
  for (const ws of wb.worksheets) {
    // acha as colunas Nome e Email pelo cabeçalho (nas 3 primeiras linhas)
    let nomeCol, emailCol, headerRow;
    for (let r = 1; r <= 3 && !emailCol; r++) {
      const row = ws.getRow(r);
      for (let c = 1; c <= 15; c++) {
        const h = txt(row.getCell(c).value).toLowerCase().trim();
        if (!nomeCol && h.includes('nome')) nomeCol = c;
        if (!emailCol && (h.includes('email') || h.includes('e-mail'))) emailCol = c;
      }
      if (emailCol) headerRow = r;
    }
    if (!nomeCol || !emailCol) { console.log(`  aba "${ws.name}": sem colunas Nome/Email — pulando`); continue; }
    for (let r = headerRow + 1; r <= ws.actualRowCount; r++) {
      const name = txt(ws.getRow(r).getCell(nomeCol).value).replace(/\s+/g, ' ').trim();
      const email = txt(ws.getRow(r).getCell(emailCol).value).trim().toLowerCase();
      if (name && email && /\S+@\S+\.\S+/.test(email) && !byEmail.has(email)) byEmail.set(email, { name, email });
    }
  }

  console.log(`\n${byEmail.size} promotores únicos encontrados.${DRY ? '  (DRY-RUN — nada será criado)' : ''}\n`);
  let i = 0, criados = 0, jaExistiam = 0, erros = 0;
  for (const { name, email } of byEmail.values()) {
    const senha = name.toUpperCase() + '2026';
    if (DRY) { if (i++ < 5) console.log(`  ex: ${email}  ->  senha: "${senha}"`); continue; }
    try {
      await db.createUser({ email, name, password: senha, role: 'promotor', mustChangePassword: true });
      criados++;
    } catch (e) {
      if (/já cadastrado/.test(e.message)) jaExistiam++;
      else { erros++; console.log('  ERRO', email, '-', e.message); }
    }
  }
  if (DRY) console.log(`\n(amostra acima) — total a criar: ${byEmail.size}`);
  else console.log(`\nCriados: ${criados} | já existiam: ${jaExistiam} | erros: ${erros}`);
  process.exit(0);
})().catch((e) => { console.error('ERRO:', e.message); process.exit(1); });
