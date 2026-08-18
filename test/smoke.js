// Teste de regração end-to-end. Requer o servidor rodando (de preferência com
// MONGO_DB=memphis_pdv_test) + Mongo + Cloudinary configurados no .env.
//   node test/smoke.js
const http = require('http');
const https = require('https');
function req(method, path, { body, cookie, raw } = {}) {
  return new Promise((resolve, reject) => {
    const data = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const headers = {};
    if (data && !raw) headers['Content-Type'] = 'application/json';
    if (raw) headers['Content-Type'] = raw;
    if (data) headers['Content-Length'] = data.length;
    if (cookie) headers['Cookie'] = cookie;
    const r = http.request({ host: 'localhost', port: 3000, method, path, headers }, (res) => {
      let c = []; res.on('data', (b) => c.push(b));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c), cookie: (res.headers['set-cookie'] || [])[0], loc: res.headers.location }));
    });
    r.on('error', reject); if (data) r.write(data); r.end();
  });
}
const getUrl = (url) => new Promise((res) => { https.get(url, (r) => { r.resume(); res(r.statusCode); }).on('error', () => res('err')); });
const J = (b) => JSON.parse(b.toString() || '{}');
const jpeg = Buffer.from('/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAAv/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AfwD/2Q==', 'base64');
const pdf = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF', 'latin1');
// POST multipart pra um host externo (Cloudinary)
function httpsPostMultipart(host, p, parts) {
  return new Promise((resolve, reject) => {
    const b = '----t' + Date.now() + Math.random().toString(36).slice(2); const out = [];
    for (const x of parts) {
      if (x.file) { out.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${x.name}"; filename="${x.filename}"\r\nContent-Type: ${x.ct}\r\n\r\n`)); out.push(x.file); out.push(Buffer.from('\r\n')); }
      else out.push(Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="${x.name}"\r\n\r\n${x.value}\r\n`));
    }
    out.push(Buffer.from(`--${b}--\r\n`));
    const body = Buffer.concat(out);
    const r = https.request({ host, path: p, method: 'POST', headers: { 'Content-Type': `multipart/form-data; boundary=${b}`, 'Content-Length': body.length } }, (res) => { let c = []; res.on('data', (d) => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(c) })); });
    r.on('error', reject); r.write(body); r.end();
  });
}
// replica o fluxo do navegador: pega assinatura -> sobe direto no Cloudinary
async function uploadCloud(cookie, tipo, file, filename, ct) {
  const sig = J((await req('GET', '/api/upload-signature?tipo=' + tipo, { cookie })).body);
  const endpoint = tipo === 'comprovantes' ? 'raw' : 'image';
  const r = await httpsPostMultipart('api.cloudinary.com', `/v1_1/${sig.cloudName}/${endpoint}/upload`, [
    { name: 'file', file, filename, ct },
    { name: 'api_key', value: sig.apiKey }, { name: 'timestamp', value: String(sig.timestamp) },
    { name: 'signature', value: sig.signature }, { name: 'folder', value: sig.folder }, { name: 'type', value: sig.type },
  ]);
  const d = J(r.body);
  if (d.error) throw new Error(d.error.message);
  return { publicId: d.public_id, resourceType: d.resource_type, bytes: d.bytes };
}
(async () => {
  let pass = 0, fail = 0;
  const ck = (n, ok, e = '') => { console.log((ok ? '✓' : '✗') + ' ' + n + (e ? ' — ' + e : '')); ok ? pass++ : fail++; };

  // ---- auth JWT ----
  ck('sem cookie = 401', (await req('GET', '/api/me')).status === 401);
  ck('cookie inválido = 401', (await req('GET', '/api/me', { cookie: 'mp_token=lixo' })).status === 401);
  ck('login errado = 401', (await req('POST', '/api/login', { body: { email: 'admin@local', password: 'X' } })).status === 401);

  const adminLogin = await req('POST', '/api/login', { body: { email: 'admin@local', password: 'admin123' } });
  const ac = adminLogin.cookie;
  ck('login admin seta cookie JWT', !!ac && /mp_token=/.test(ac) && /HttpOnly/i.test(ac));
  ck('admin autenticado em /me', (await req('GET', '/api/me', { cookie: ac })).status === 200);

  // logout limpa o cookie
  const lo = await req('POST', '/api/logout', { cookie: ac });
  ck('logout limpa cookie', /mp_token=;/.test(lo.cookie || ''));

  await req('POST', '/api/admin/users', { cookie: ac, body: { name: 'João Ninguém', email: 'joao@local', password: 'joao123' } });
  const pc = (await req('POST', '/api/login', { body: { email: 'joao@local', password: 'joao123' } })).cookie;
  const ref = J((await req('GET', '/api/reference', { cookie: pc })).body);
  ck('reference', ref.promotores.length > 1000 && ref.regioes.length === 5);
  ck('ponto extra "Grande volume de produtos" disponível', ref.pontosExtra.includes('Grande volume de produtos'));

  // ---- upload direto + envio ----
  ck('assinatura só pra tipo válido (400)', (await req('GET', '/api/upload-signature?tipo=comprovantes', { cookie: pc })).status === 400);
  const foto1 = await uploadCloud(pc, 'fotos', jpeg, 'a.jpg', 'image/jpeg');
  ck('upload direto no Cloudinary', /memphis-pdv\/fotos\//.test(foto1.publicId), foto1.publicId);
  const up = await req('POST', '/api/submissions', { cookie: pc, body: {
    cliente: 'NOVO SURUBIM', endereco: 'Av. Brasil 100', dataExposicao: '2026-06-21',
    regiao: 'NE', grupo: 'CALMON', promotor: ref.promotores[0], fotos: [foto1],
  } });
  ck('registra metadados', up.status === 200 && J(up.body).count === 1, J(up.body).error || '');
  // trava: 1 foto por semana por promotor (mesma semana da exposição)
  const dupImg = await uploadCloud(pc, 'fotos', jpeg, 'dup.jpg', 'image/jpeg');
  const dup = await req('POST', '/api/submissions', { cookie: pc, body: { cliente: 'OUTRA', endereco: 'X', dataExposicao: '2026-06-21', regiao: 'NE', grupo: '', promotor: ref.promotores[0], fotos: [dupImg] } });
  ck('trava 1 foto/semana por promotor', dup.status === 400 && /semana/i.test(J(dup.body).error), J(dup.body).error);
  const mine = J((await req('GET', '/api/my/submissions', { cookie: pc })).body)[0];
  ck('foto guarda a imagem no Cloudinary', /memphis-pdv\/fotos\//.test((mine.imagens && mine.imagens[0] && mine.imagens[0].storedFile) || ''));
  const id = mine.id;

  const fileR = await req('GET', '/api/file/' + id, { cookie: pc });
  ck('/api/file 302 -> Cloudinary 200', fileR.status === 302 && (await getUrl(fileR.loc)) === 200);

  // ---- avaliação ----
  await req('PATCH', '/api/admin/submissions/' + id, { cookie: ac, body: { preAvaliacao: 'EXCELENTE', validado: true, pontosExtra: ['Ilha de produtos'] } });
  const s1 = J((await req('GET', '/api/admin/submissions', { cookie: ac })).body).itens.find((x) => x.id === id);
  ck('avaliação salva', s1.preAvaliacao === 'EXCELENTE' && s1.validado === true);

  // ---- pendente ----
  const novo = 'FULANO SMOKE ' + Date.now();
  await req('POST', '/api/promotor-pendente', { cookie: pc, body: { nome: novo } });
  const lista = J((await req('GET', '/api/admin/pendentes', { cookie: ac })).body);
  await req('POST', '/api/admin/pendentes/' + lista.find((p) => p.nome === novo).id + '/aprovar', { cookie: ac });
  ck('pendente aprovado entra no banco', J((await req('GET', '/api/check-promotor?nome=' + encodeURIComponent(novo), { cookie: pc })).body).existe === true);

  // ---- admin cria outro admin ----
  const adminEmail = 'admin2_' + Date.now() + '@local';
  // admin novo nasce SEM permissões (modelo granular) — pro teste de acesso, já cria com 'aprovar'
  const na = await req('POST', '/api/admin/users', { cookie: ac, body: { name: 'Admin 2', email: adminEmail, password: 'admin2pass', role: 'admin', permissions: ['aprovar'] } });
  ck('admin cria novo admin', na.status === 200 && J(na.body).role === 'admin', J(na.body).error || '');
  const ac2 = (await req('POST', '/api/login', { body: { email: adminEmail, password: 'admin2pass' } })).cookie;
  ck('novo admin loga e acessa o painel', !!ac2 && (await req('GET', '/api/admin/pendentes', { cookie: ac2 })).status === 200);
  ck('lista de contas inclui admins', J((await req('GET', '/api/admin/users', { cookie: ac })).body).some((u) => u.role === 'admin'));

  // ---- perfil (admin edita nome/email/grupo/região/telefone) ----
  const ju = J((await req('GET', '/api/admin/users', { cookie: ac })).body).find((u) => u.email === 'joao@local');
  const up1 = await req('PATCH', '/api/admin/users/' + ju.id, { cookie: ac, body: { grupo: 'CALMON', regiao: 'NE', telefone: '(81) 99999-0000' } });
  const up1b = J(up1.body);
  // telefone é normalizado pra só dígitos no banco (o front formata na exibição)
  ck('admin edita perfil (grupo/região/telefone)', up1.status === 200 && up1b.grupo === 'CALMON' && up1b.regiao === 'NE' && up1b.telefone === '81999990000', up1b.error || '');
  const meP = J((await req('GET', '/api/me', { cookie: pc })).body);
  ck('promotor vê o próprio perfil no /api/me', meP.grupo === 'CALMON' && meP.regiao === 'NE');
  ck('região inválida é recusada', (await req('PATCH', '/api/admin/users/' + ju.id, { cookie: ac, body: { regiao: 'XX' } })).status === 400);
  ck('email duplicado é recusado', (await req('PATCH', '/api/admin/users/' + ju.id, { cookie: ac, body: { email: adminEmail } })).status === 400);
  const up2 = await req('PATCH', '/api/admin/users/' + ju.id, { cookie: ac, body: { email: 'joao.novo@local', name: 'João Editado' } });
  ck('admin troca email e nome', up2.status === 200 && J(up2.body).email === 'joao.novo@local' && J(up2.body).name === 'João Editado', J(up2.body).error || '');
  ck('promotor loga com o email novo', !!(await req('POST', '/api/login', { body: { email: 'joao.novo@local', password: 'joao123' } })).cookie);
  ck('email antigo não loga mais', (await req('POST', '/api/login', { body: { email: 'joao@local', password: 'joao123' } })).status === 401);
  await req('PATCH', '/api/admin/users/' + ju.id, { cookie: ac, body: { email: 'joao@local', name: 'João Ninguém' } }); // restaura pros testes seguintes
  ck('promotor comum não edita perfil (403)', (await req('PATCH', '/api/admin/users/' + ju.id, { cookie: pc, body: { name: 'hack' } })).status === 403);

  // ---- marcar pago ----
  await req('PATCH', '/api/admin/submissions/' + id, { cookie: ac, body: { pago: true } });
  ck('admin marca pago, promotor vê', J((await req('GET', '/api/my/submissions', { cookie: pc })).body)[0].pago === true);

  // ---- banir promotor ----
  const joao = J((await req('GET', '/api/admin/users', { cookie: ac })).body).find((u) => u.email === 'joao@local');
  await req('POST', '/api/admin/users/' + joao.id + '/active', { cookie: ac, body: { active: false } });
  ck('promotor banido não acessa (401)', (await req('GET', '/api/me', { cookie: pc })).status === 401);
  ck('promotor banido não loga', (await req('POST', '/api/login', { body: { email: 'joao@local', password: 'joao123' } })).status === 401);
  await req('POST', '/api/admin/users/' + joao.id + '/active', { cookie: ac, body: { active: true } });
  ck('desbanido loga de novo', !!(await req('POST', '/api/login', { body: { email: 'joao@local', password: 'joao123' } })).cookie);

  // ---- manifesto do ZIP (montado no navegador) + excel ----
  const man = J((await req('GET', '/api/admin/download-manifest?onlyNew=1', { cookie: ac })).body);
  ck('manifesto: 1 item com pasta certa', man.count === 1 && /^NE\/NE1 - NOVO SURUBIM - .+\/foto\.jpg$/.test(man.items[0].path), man.items[0] && man.items[0].path);
  ck('URL do manifesto baixa do Cloudinary (200)', (await getUrl(man.items[0].url)) === 200);
  await req('POST', '/api/admin/mark-downloaded', { cookie: ac, body: { ids: man.items.map((i) => i.id) } });
  ck('marcadas como baixadas', J((await req('GET', '/api/admin/submissions?status=baixados', { cookie: ac })).body).itens.length === 1);
  ck('excel', (await req('GET', '/api/admin/export.xlsx', { cookie: ac })).status === 200);

  // ---- purge ----
  ck('purge', J((await req('POST', '/api/admin/purge', { cookie: ac })).body).removed === 1);
  ck('foto some após purge (404)', (await req('GET', '/api/file/' + id, { cookie: ac })).status === 404);

  // ---- foto recusada NÃO é baixada ----
  const fotoR = await uploadCloud(pc, 'fotos', jpeg, 'r.jpg', 'image/jpeg');
  await req('POST', '/api/submissions', { cookie: pc, body: { cliente: 'LOJA RECUSADA', endereco: 'R', dataExposicao: '2026-06-20', regiao: 'CN', grupo: '', promotor: ref.promotores[1], fotos: [fotoR] } });
  const subR = J((await req('GET', '/api/admin/submissions?status=novos', { cookie: ac })).body).itens[0];
  // recusar sem motivo não passa mais — o promotor vê o motivo, então "Recusada" sozinho seria a queixa antiga
  const semMotivo = await req('PATCH', '/api/admin/submissions/' + subR.id, { cookie: ac, body: { validado: false } });
  ck('recusar sem motivo é recusado (400)', semMotivo.status === 400 && /motivo/i.test(J(semMotivo.body).error || ''), J(semMotivo.body).error || '');
  const comMotivo = await req('PATCH', '/api/admin/submissions/' + subR.id, { cookie: ac, body: { validado: false, motivoRecusa: 'Foto fora de foco' } });
  ck('recusar com motivo grava o motivo', comMotivo.status === 200 && J(comMotivo.body).motivoRecusa === 'Foto fora de foco', J(comMotivo.body).error || '');
  ck('promotor enxerga o motivo da recusa', J((await req('GET', '/api/my/submissions', { cookie: pc })).body).find((x) => x.id === subR.id).motivoRecusa === 'Foto fora de foco');
  const manR = J((await req('GET', '/api/admin/download-manifest?onlyNew=0', { cookie: ac })).body);
  ck('foto recusada não entra no download', manR.count === 0 && manR.items.every((i) => i.id !== subR.id), 'count=' + manR.count);
  // ao validar, volta a ser baixável
  await req('PATCH', '/api/admin/submissions/' + subR.id, { cookie: ac, body: { validado: true } });
  const manOk = J((await req('GET', '/api/admin/download-manifest?onlyNew=0', { cookie: ac })).body);
  ck('ao validar, volta pro download', manOk.count === 1);
  // excluir a foto de vez (testa exclusão individual + limpa)
  await req('DELETE', '/api/admin/submissions/' + subR.id, { cookie: ac });
  ck('excluir foto remove do banco', J((await req('GET', '/api/admin/submissions', { cookie: ac })).body).itens.length === 0);

  // ---- foto com 2 imagens ("antes e depois") = 1 foto, 2 arquivos no ZIP ----
  const im1 = await uploadCloud(pc, 'fotos', jpeg, 'a1.jpg', 'image/jpeg');
  const im2 = await uploadCloud(pc, 'fotos', jpeg, 'a2.jpg', 'image/jpeg');
  const dois = await req('POST', '/api/submissions', { cookie: pc, body: { cliente: 'ANTES E DEPOIS', endereco: 'X', dataExposicao: '2026-07-05', regiao: 'SE', grupo: '', promotor: 'FULANO 2IMG', fotos: [im1, im2] } });
  ck('2 imagens = 1 foto (count 1)', dois.status === 200 && J(dois.body).count === 1, J(dois.body).error || '');
  const subAD = J((await req('GET', '/api/admin/submissions?status=novos', { cookie: ac })).body).itens[0];
  await req('PATCH', '/api/admin/submissions/' + subAD.id, { cookie: ac, body: { validado: true } });
  const manAD = J((await req('GET', '/api/admin/download-manifest?onlyNew=0', { cookie: ac })).body);
  ck('2 imagens = 2 arquivos no ZIP', manAD.count === 2 && manAD.items.filter((i) => i.id === subAD.id).length === 2, 'count=' + manAD.count);
  await req('DELETE', '/api/admin/submissions/' + subAD.id, { cookie: ac });

  // ---- troca de senha obrigatória no 1º login ----
  await req('POST', '/api/admin/users', { cookie: ac, body: { name: 'Novato', email: 'novato@local', password: 'prov123', role: 'promotor', mustChangePassword: true } });
  ck('login sinaliza troca obrigatória', J((await req('POST', '/api/login', { body: { email: 'novato@local', password: 'prov123' } })).body).mustChangePassword === true);
  const nc = (await req('POST', '/api/login', { body: { email: 'novato@local', password: 'prov123' } })).cookie;
  ck('/me sinaliza troca', J((await req('GET', '/api/me', { cookie: nc })).body).mustChangePassword === true);
  ck('troca com senha atual errada falha', (await req('POST', '/api/change-password', { cookie: nc, body: { currentPassword: 'errada', newPassword: 'novasenha9' } })).status === 400);
  ck('troca senha ok', (await req('POST', '/api/change-password', { cookie: nc, body: { currentPassword: 'prov123', newPassword: 'novasenha9' } })).status === 200);
  ck('após troca, /me não pede mais', J((await req('GET', '/api/me', { cookie: (await req('POST', '/api/login', { body: { email: 'novato@local', password: 'novasenha9' } })).cookie })).body).mustChangePassword === false);
  ck('senha provisória não loga mais', (await req('POST', '/api/login', { body: { email: 'novato@local', password: 'prov123' } })).status === 401);

  // ---- LGPD 1.0: dados institucionais no config, com permissão graduada ----
  const contatoPub = await req('GET', '/api/contato'); // SEM cookie: a política tem que ser legível deslogado
  const cp = J(contatoPub.body);
  ck('/api/contato é público e traz o encarregado', contatoPub.status === 200 && !!cp.encarregadoEmail && !!cp.contatoTelefone, cp.error || '');
  ck('/api/contato traz razão social, CNPJ e versão da política', !!cp.razaoSocial && !!cp.cnpj && !!cp.politicaVersao);
  // admin com acesso total edita contato E identificação
  const instOk = await req('PATCH', '/api/admin/institucionais', { cookie: ac, body: { contatoTelefone: '+55 51 91111-2222', razaoSocial: 'Memphis S.A. Industrial' } });
  ck('acesso total edita contato e razão social', instOk.status === 200 && J(instOk.body).contatoTelefone === '+55 51 91111-2222', J(instOk.body).error || '');
  ck('e-mail de encarregado inválido é recusado', (await req('PATCH', '/api/admin/institucionais', { cookie: ac, body: { encarregadoEmail: 'nao-e-email' } })).status === 400);
  ck('campo institucional vazio é recusado', (await req('PATCH', '/api/admin/institucionais', { cookie: ac, body: { contatoTelefone: '  ' } })).status === 400);
  // admin só com 'listas' mexe no contato, mas NÃO na identificação da empresa
  const listaEmail = 'listeiro_' + Date.now() + '@local';
  await req('POST', '/api/admin/users', { cookie: ac, body: { name: 'Só Listas', email: listaEmail, password: 'listas123', role: 'admin', permissions: ['listas'] } });
  const lc = (await req('POST', '/api/login', { body: { email: listaEmail, password: 'listas123' } })).cookie;
  ck('admin de listas edita o contato', (await req('PATCH', '/api/admin/institucionais', { cookie: lc, body: { contatoTelefone: '+55 51 93333-4444' } })).status === 200);
  const barrado = await req('PATCH', '/api/admin/institucionais', { cookie: lc, body: { razaoSocial: 'Empresa Falsa Ltda' } });
  ck('admin de listas NÃO altera a razão social (400)', barrado.status === 400 && /acesso total/i.test(J(barrado.body).error || ''), J(barrado.body).error || '');
  ck('razão social continua a original após a tentativa', J((await req('GET', '/api/contato')).body).razaoSocial === 'Memphis S.A. Industrial');
  ck('promotor não acessa os institucionais (403)', (await req('PATCH', '/api/admin/institucionais', { cookie: pc, body: { contatoTelefone: '+55 11 90000-0000' } })).status === 403);
  ck('política de privacidade é servida na raiz', (await req('GET', '/politica-de-privacidade.html')).status === 200);

  // ---- LGPD 1.2: aceite registrado ----
  // o cadastro público exige o aceite NO SERVIDOR (marcar a caixa no front não prova nada)
  // (o signup público exige e-mail com domínio completo, diferente do painel)
  const semAceite = await req('POST', '/api/signup', { body: { name: 'Sem Aceite', email: 'semaceite_' + Date.now() + '@teste.com', password: 'senha1234' } });
  ck('signup sem aceite é recusado (400)', semAceite.status === 400 && /polít/i.test(J(semAceite.body).error || ''), J(semAceite.body).error || '');
  const emailAceite = 'comaceite_' + Date.now() + '@teste.com';
  const comAceite = await req('POST', '/api/signup', { body: { name: 'Com Aceite', email: emailAceite, password: 'senha1234', aceitePolitica: true } });
  ck('signup com aceite cria a conta', comAceite.status === 200, J(comAceite.body).error || '');
  const versaoAtual = J((await req('GET', '/api/contato')).body).politicaVersao;
  const criado = J((await req('GET', '/api/admin/users', { cookie: ac })).body).find((u) => u.email === emailAceite);
  ck('aceite fica gravado no usuário com versão e data', criado && criado.aceiteVersao === versaoAtual && !!criado.aceiteEm,
    criado ? 'versao=' + criado.aceiteVersao : 'conta não encontrada');
  // quem nasce por importação NÃO tem aceite e o /api/me sinaliza isso
  const meJoao = J((await req('GET', '/api/me', { cookie: pc })).body);
  ck('conta criada pelo painel nasce sem aceite e /me pede', meJoao.precisaAceitar === true && meJoao.aceiteVersao === null);
  ck('/me informa a versão vigente da política', meJoao.politicaVersao === versaoAtual);
  // aceitar carimba a versão VIGENTE (o cliente não escolhe qual)
  ck('POST /api/aceitar-politica registra', J((await req('POST', '/api/aceitar-politica', { cookie: pc, body: { versao: '1999-01' } })).body).aceiteVersao === versaoAtual);
  const meDepois = J((await req('GET', '/api/me', { cookie: pc })).body);
  ck('depois de aceitar, /me não pede mais', meDepois.precisaAceitar === false && meDepois.aceiteVersao === versaoAtual);
  // mudar a versão da política faz todo mundo aceitar de novo — de graça
  await req('PATCH', '/api/admin/institucionais', { cookie: ac, body: { politicaVersao: '2027-01' } });
  ck('política nova volta a pedir aceite', J((await req('GET', '/api/me', { cookie: pc })).body).precisaAceitar === true);
  await req('POST', '/api/aceitar-politica', { cookie: pc });
  ck('aceite da versão nova libera', J((await req('GET', '/api/me', { cookie: pc })).body).precisaAceitar === false);
  await req('PATCH', '/api/admin/institucionais', { cookie: ac, body: { politicaVersao: versaoAtual } }); // restaura
  ck('tela de aceite existe', (await req('GET', '/pdv/aceitar-politica.html')).status === 200);


  // ---- LGPD 1.4: auditoria de acesso a dado pessoal (Art. 37) ----
  const audAntes = J((await req('GET', '/api/admin/auditoria?limit=200', { cookie: ac })).body);
  ck('auditoria é legível por quem tem acesso total', Array.isArray(audAntes.itens), audAntes.error || '');
  ck('promotor não lê a auditoria (403)', (await req('GET', '/api/admin/auditoria', { cookie: pc })).status === 403);
  // criar conta é evento auditável — e o registro tem que dizer QUEM fez
  const emailAud = 'auditado_' + Date.now() + '@local';
  const novoAud = J((await req('POST', '/api/admin/users', { cookie: ac, body: { name: 'Auditado', email: emailAud, password: 'auditado123' } })).body);
  const audDepois = J((await req('GET', '/api/admin/auditoria?acao=criou_conta&limit=50', { cookie: ac })).body);
  const evt = audDepois.itens.find((e) => (e.detalhe || '').includes(emailAud));
  ck('criar conta grava na auditoria com autor e alvo', !!evt && evt.alvo === novoAud.id && !!evt.userNome && !!evt.ts,
    evt ? 'autor=' + evt.userNome : 'evento não encontrado');
  // banir e excluir também
  await req('POST', '/api/admin/users/' + novoAud.id + '/active', { cookie: ac, body: { active: false } });
  ck('banir grava na auditoria', J((await req('GET', '/api/admin/auditoria?acao=baniu_conta&limit=50', { cookie: ac })).body).itens.some((e) => e.alvo === novoAud.id));
  await req('DELETE', '/api/admin/users/' + novoAud.id, { cookie: ac });
  ck('excluir conta grava na auditoria', J((await req('GET', '/api/admin/auditoria?acao=excluiu_conta&limit=50', { cookie: ac })).body).itens.some((e) => e.alvo === novoAud.id));
  ck('filtro por ação devolve só aquela ação', J((await req('GET', '/api/admin/auditoria?acao=criou_conta&limit=50', { cookie: ac })).body).itens.every((e) => e.acao === 'criou_conta'));


  // ---- LGPD 1.5: cota da recusada, alertas e retenção em modo só-relatório ----
  // foto recusada NÃO consome cota — na prática é como se não tivesse mandado nada
  const semanaImg = await uploadCloud(pc, 'fotos', jpeg, 'cota1.jpg', 'image/jpeg');
  const env1 = await req('POST', '/api/submissions', { cookie: pc, body: { cliente: 'COTA A', endereco: 'X', dataExposicao: '2026-05-04', regiao: 'NE', grupo: '', promotor: ref.promotores[3], fotos: [semanaImg] } });
  ck('1ª foto da semana entra', env1.status === 200, J(env1.body).error || '');
  const bloq = await req('POST', '/api/submissions', { cookie: pc, body: { cliente: 'COTA B', endereco: 'X', dataExposicao: '2026-05-05', regiao: 'NE', grupo: '', promotor: ref.promotores[3], fotos: [await uploadCloud(pc, 'fotos', jpeg, 'cota2.jpg', 'image/jpeg')] } });
  ck('2ª na mesma semana é barrada', bloq.status === 400 && /semana/i.test(J(bloq.body).error));
  const idCota = J((await req('GET', '/api/admin/submissions?q=' + encodeURIComponent('COTA A'), { cookie: ac })).body).itens[0].id;
  await req('PATCH', '/api/admin/submissions/' + idCota, { cookie: ac, body: { validado: false, motivoRecusa: 'Foto fora de foco' } });
  const reenvio = await req('POST', '/api/submissions', { cookie: pc, body: { cliente: 'COTA C', endereco: 'X', dataExposicao: '2026-05-06', regiao: 'NE', grupo: '', promotor: ref.promotores[3], fotos: [await uploadCloud(pc, 'fotos', jpeg, 'cota3.jpg', 'image/jpeg')] } });
  ck('recusar devolve a vaga na hora (recusada não consome cota)', reenvio.status === 200, J(reenvio.body).error || '');
  // o retorno da recusa fica numa coleção própria, que sobrevive à anonimização da foto
  ck('promotor lê o retorno da recusa', J((await req('GET', '/api/my/retornos', { cookie: pc })).body).some((r) => r.motivoRecusa === 'Foto fora de foco'));

  // alertas: uma requisição só, com os cadastros pendentes junto (não somar polling no M0)
  const al = J((await req('GET', '/api/admin/alertas', { cookie: ac })).body);
  ck('/api/admin/alertas traz as duas listas + cadastros numa requisição',
    typeof al.naoAvaliadas === 'number' && typeof al.naoBaixadas === 'number' && typeof al.cadastrosPendentes === 'number', al.error || '');
  ck('alertas trazem os degraus 30/45/53', al.dias.destaque === 30 && al.dias.critico === 45 && al.dias.ultima === 53);
  ck('promotor não lê alertas (403)', (await req('GET', '/api/admin/alertas', { cookie: pc })).status === 403);

  // retenção sob demanda: nasce em modo só-relatório e NÃO apaga nada
  const ret = J((await req('POST', '/api/admin/retencao/rodar', { cookie: ac })).body);
  ck('retenção roda em modo só-relatório por padrão', ret.modo === 'so-relatorio', 'modo=' + ret.modo);
  ck('modo só-relatório não apaga nada', ret.imagensApagadas === 0 && ret.anonimizadas === 0);
  ck('retenção fica registrada na auditoria', J((await req('GET', '/api/admin/auditoria?acao=retencao_automatica', { cookie: ac })).body).total >= 1);


  // ---- LGPD 1.6: direitos do titular (Art. 18) ----
  // uma conta com foto + recusa (pra ter o que exportar e o que anonimizar)
  const emailTit = 'titular_' + Date.now() + '@local';
  const tit = J((await req('POST', '/api/admin/users', { cookie: ac, body: { name: 'TITULAR TESTE', email: emailTit, password: 'titular123', grupo: 'G-TIT', regiao: 'NE' } })).body);
  const tc = (await req('POST', '/api/login', { body: { email: emailTit, password: 'titular123' } })).cookie;
  await req('POST', '/api/submissions', { cookie: tc, body: { cliente: 'LOJA TITULAR', endereco: 'Rua Sigilo, 9', dataExposicao: '2026-04-06', regiao: 'NE', grupo: 'G-TIT', promotor: ref.promotores[5], fotos: [await uploadCloud(tc, 'fotos', jpeg, 'tit.jpg', 'image/jpeg')] } });
  const subTit = J((await req('GET', '/api/my/submissions', { cookie: tc })).body)[0];
  await req('PATCH', '/api/admin/submissions/' + subTit.id, { cookie: ac, body: { validado: false, motivoRecusa: 'Produto errado' } });

  // exportar
  const exp = await req('GET', '/api/admin/users/' + tit.id + '/dados', { cookie: ac });
  const dados = J(exp.body);
  ck('exporta os dados do titular em JSON', exp.status === 200 && !!dados.cadastro && Array.isArray(dados.submissoes), dados.error || '');
  ck('exportação traz submissões e retornos da pessoa', dados.submissoes.length === 1 && dados.retornos.length === 1);
  ck('exportação NÃO vaza o hash da senha', !dados.cadastro.passwordHash && !dados.cadastro.resetTokenHash);
  ck('exportar fica registrado na auditoria', J((await req('GET', '/api/admin/auditoria?acao=exportou_dados_titular', { cookie: ac })).body).total >= 1);

  // anonimizar (padrão: preserva os números)
  const anon = await req('POST', '/api/admin/users/' + tit.id + '/anonimizar', { cookie: ac, body: { motivo: 'pedido do titular' } });
  ck('anonimiza o titular preservando os números', anon.status === 200 && J(anon.body).modo === 'anonimizado', J(anon.body).error || '');
  // busca por texto não acha mais: a anonimização remove o searchBlob (que concatenava
  // nome + endereço). É o comportamento correto — por isso a foto é buscada pelo id.
  ck('anonimizada some da busca por texto (searchBlob foi limpo)',
    J((await req('GET', '/api/admin/submissions?q=' + encodeURIComponent('LOJA TITULAR'), { cookie: ac })).body).itens.length === 0);
  const subDepois = J((await req('GET', '/api/admin/submissions?limit=200', { cookie: ac })).body).itens.find((x) => x.id === subTit.id);
  ck('a foto continua existindo (alimenta os gráficos)', !!subDepois);
  ck('nome vira [removido] e endereço some', subDepois.promotor === '[removido]' && !subDepois.endereco);
  ck('o vínculo uploadedBy foi cortado', !subDepois.uploadedBy);
  // CASO OBRIGATÓRIO 6: o retorno some junto, senão sobra dado pessoal órfão
  ck('excluir/anonimizar titular apaga os retornos dele junto', J((await req('GET', '/api/my/retornos', { cookie: tc })).body).length === 0);
  ck('anonimização fica registrada na auditoria', J((await req('GET', '/api/admin/auditoria?acao=anonimizou_titular', { cookie: ac })).body).total >= 1);
  // exclusão completa exige acesso total
  const admLim = 'limitado_' + Date.now() + '@local';
  await req('POST', '/api/admin/users', { cookie: ac, body: { name: 'Só Contas', email: admLim, password: 'contas123', role: 'admin', permissions: ['contas'] } });
  const clc = (await req('POST', '/api/login', { body: { email: admLim, password: 'contas123' } })).cookie;
  ck('exclusão completa exige acesso total (403 sem crachá)',
    (await req('POST', '/api/admin/users/' + tit.id + '/anonimizar?completo=1', { cookie: clc })).status === 403);

  // ---- recuperação de senha (link de redefinição) ----
  const fp = J((await req('POST', '/api/forgot-password', { body: { email: 'joao@local' } })).body);
  ck('forgot-password responde genérico + devLink', fp.ok === true && !!fp.devLink, fp.devLink && fp.devLink.slice(0, 40));
  const token = new URL(fp.devLink).searchParams.get('token');
  ck('token curto/inválido recusado', (await req('POST', '/api/reset-password', { body: { token: 'errado', password: 'novaSenha1' } })).status === 400);
  ck('senha curta recusada', (await req('POST', '/api/reset-password', { body: { token, password: '123' } })).status === 400);
  ck('reset com token válido', (await req('POST', '/api/reset-password', { body: { token, password: 'novaSenha1' } })).status === 200);
  ck('loga com a senha nova', !!(await req('POST', '/api/login', { body: { email: 'joao@local', password: 'novaSenha1' } })).cookie);
  ck('senha antiga não loga mais', (await req('POST', '/api/login', { body: { email: 'joao@local', password: 'joao123' } })).status === 401);
  ck('token é de uso único', (await req('POST', '/api/reset-password', { body: { token, password: 'outra123' } })).status === 400);
  const fp2 = J((await req('POST', '/api/forgot-password', { body: { email: 'naoexiste@x.com' } })).body);
  ck('email inexistente: genérico e SEM link (anti-enumeração)', fp2.ok === true && !fp2.devLink);

  console.log(`\n=== ${pass} passou, ${fail} falhou ===`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ERRO', e); process.exit(1); });
