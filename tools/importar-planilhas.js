const ExcelJS = require('exceljs');
const fs = require('fs');
function cv(v) {
  if (v == null) return '';
  if (typeof v === 'object') {
    if (v.text) return v.text;
    if (v.result !== undefined) return String(v.result);
    if (v.richText) return v.richText.map((t) => t.text).join('');
    return '';
  }
  return String(v);
}
const norm = (s) => cv(s).trim().replace(/\s+/g, ' ');

(async () => {
  const promotores = new Set();
  const grupos = new Set();
  const clientes = new Set();

  // ----- clientes file (abas por região) -----
  const wc = new ExcelJS.Workbook();
  await wc.xlsx.readFile('C:/Users/Pichau/Downloads/Registro de clientes recebidos JUNHO.xlsx');
  const regionSheets = ['SUL', 'SÃO PAULO', 'SUDESTE', 'NORDESTE', 'CENTRO NORTE'];
  for (const name of regionSheets) {
    const ws = wc.getWorksheet(name);
    if (!ws) continue;
    // header na linha 7; dados a partir de 8 — eachRow só passa nas preenchidas
    ws.eachRow({ includeEmpty: false }, (row, r) => {
      if (r < 8) return;
      const cliente = norm(row.getCell(6).value);
      const promotor = norm(row.getCell(7).value);
      const grupo = norm(row.getCell(8).value);
      if (cliente) clientes.add(cliente);
      if (promotor) promotores.add(promotor.toUpperCase());
      if (grupo) grupos.add(grupo);
    });
  }

  // ----- cadastro promotores (banco da empresa) -----
  const wp = new ExcelJS.Workbook();
  await wp.xlsx.readFile('C:/Users/Pichau/Downloads/2.Cadastro Promotores - JUNHO.xlsm');
  for (const shName of ['Cadastro TOTAL', 'Cadastro Atual']) {
    const ws = wp.getWorksheet(shName);
    if (!ws) continue;
    // achar a coluna cujo header é "Promotor"
    let promCol = null,
      headerRow = null;
    for (let r = 1; r <= 12 && !promCol; r++) {
      const row = ws.getRow(r);
      for (let c = 1; c <= 50; c++) {
        if (norm(row.getCell(c).value).toLowerCase() === 'promotor') {
          promCol = c;
          headerRow = r;
          break;
        }
      }
    }
    if (!promCol) continue;
    ws.eachRow({ includeEmpty: false }, (row, r) => {
      if (r <= headerRow) return;
      const v = norm(row.getCell(promCol).value).toUpperCase();
      if (v && v.length > 2 && !/^\d+$/.test(v)) promotores.add(v);
    });
  }

  const out = {
    promotores: [...promotores].sort(),
    grupos: [...grupos].sort(),
    clientes: [...clientes].sort(),
  };
  fs.writeFileSync('data/seed.json', JSON.stringify(out, null, 2));
  console.log('promotores:', out.promotores.length);
  console.log('grupos:', out.grupos.length, '->', out.grupos.slice(0, 15).join(' | '));
  console.log('clientes:', out.clientes.length);
  console.log('\namostra promotores:', out.promotores.slice(0, 10).join(' | '));
})().catch((e) => console.error(e));
