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
