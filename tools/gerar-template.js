// Gera data/modelo-registro.xlsx a partir do "Registro de clientes recebidos" original.
// Mantém TUDO (fórmulas, formatação, larguras, bloco-resumo, lookup AB:AC) e só limpa
// os VALORES literais das linhas de dados (remove os dados reais/PII).
//   node tools/gerar-template.js "C:/caminho/Registro de clientes recebidos.xlsx"
const ExcelJS = require('exceljs');
const path = require('path');

const SRC = process.argv[2] || 'C:/Users/Pichau/Downloads/3. Registro de clientes recebidos JUNHO (1).xlsx';
const REGIOES = ['SUL', 'SÃO PAULO', 'SUDESTE', 'NORDESTE', 'CENTRO NORTE'];

(async () => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(SRC);
  for (const name of REGIOES) {
    const ws = wb.getWorksheet(name);
    if (!ws) { console.log('  aba não encontrada:', name); continue; }
    const last = Math.max(ws.actualRowCount, 8);
    let limpas = 0;
    for (let r = 8; r <= last; r++) {
      const row = ws.getRow(r);
      row.eachCell({ includeEmpty: false }, (cell) => {
        const v = cell.value;
        const isFormula = v && typeof v === 'object' && (v.formula || v.sharedFormula);
        if (isFormula) {
          cell.value = { formula: cell.formula }; // des-compartilha: fórmula independente por célula
        } else {
          cell.value = null; // limpa valor literal (dados/PII)
        }
      });
      limpas++;
    }
    console.log(`  ${name}: limpou ${limpas} linhas (8..${last})`);
  }
  wb.calcProperties = wb.calcProperties || {};
  wb.calcProperties.fullCalcOnLoad = true; // recalcula fórmulas ao abrir
  const out = path.join(__dirname, '..', 'data', 'modelo-registro.xlsx');
  await wb.xlsx.writeFile(out);
  console.log('OK ->', out);
})().catch((e) => console.error('ERRO', e.message));
