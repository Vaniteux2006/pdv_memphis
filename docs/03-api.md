# 03 — Referência da API

Base: `/api`. Respostas em JSON. Autenticação por **cookie JWT** (`mp_token`, httpOnly) —
enviado automaticamente pelo navegador. Erros retornam `{ "error": "mensagem" }`.

**Níveis de acesso:**
- 🔓 público
- 🔑 autenticado (qualquer logado)
- 👑 admin com a **permissão** indicada (`fotos` · `aprovar` · `contas` · `listas` · `aderencia`)
- 🪪 admin com **acesso total** (`*` — via crachá)

> Desde a v1.3, admin não é tudo-ou-nada: cada conta admin tem uma lista de
> `permissions`, e cada rota `/api/admin/*` exige uma permissão específica
> (middleware `requirePerm`). Sem a permissão → **403**. A permissão `*`
> (acesso total) libera tudo, inclusive configurar as permissões dos outros —
> e só se obtém validando o **crachá**. Ver [07 — Segurança](07-seguranca.md).

## Autenticação e senha

| Método | Rota | Acesso | Corpo | Resposta |
|--------|------|--------|-------|----------|
| POST | `/api/login` | 🔓 | `{ email, password }` | `{ role, name, mustChangePassword }` + `Set-Cookie: mp_token` · 401 se inválido · **rate-limit** 10 falhas/15min (sucesso não conta) |
| POST | `/api/logout` | 🔓 | — | `{ ok: true }` + limpa o cookie |
| GET | `/api/me` | 🔑 | — | `{ id, email, name, role, mustChangePassword, grupo, regiao, telefone, setor, matricula, permissions }` |
| POST | `/api/change-password` | 🔑 | `{ currentPassword, newPassword }` | Troca a **própria** senha (obrigatória no 1º login quando `mustChangePassword=true` — o front redireciona pra `trocar-senha.html`). Renova o token. |
| POST | `/api/forgot-password` | 🔓 | `{ email }` | Sempre `{ ok: true }` (anti-enumeração). Gera token (hash + 1h) e **envia link** por email (`redefinir.html?token=`). Rate-limit 20/15min. Em dev sem SMTP devolve `devLink`. |
| POST | `/api/reset-password` | 🔓 | `{ token, password }` | Redefine a senha se o token for válido/não expirado/uso único. 400 se inválido. |

## Dados de referência

| Método | Rota | Acesso | Descrição |
|--------|------|--------|-----------|
| POST | `/api/aceitar-politica` | 🔑 | Registra o aceite da política na conta. A versão gravada é sempre a **vigente no servidor** — o cliente não escolhe qual aceita. |
| POST | `/api/admin/users/:id/convite` | 👑 `contas` | **Reenvia o convite** de primeiro acesso (token de 7 dias). Útil quando a pessoa perdeu o e-mail ou o token venceu. |
| GET | `/api/admin/users/:id/dados` | 👑 `contas` | **Exporta os dados do titular** (Art. 18, II): cadastro + submissões + retornos + pódios, em JSON para download. Sem hash de senha. |
| POST | `/api/admin/users/:id/anonimizar` | 👑 `contas` | **Anonimiza o titular**: nome vira `[removido]`, `uploadedBy`/`endereco`/`observacao` saem e os **retornos são apagados** — senão sobraria dado pessoal órfão. Os números continuam alimentando os gráficos. `?completo=1` apaga tudo (fotos incluídas) e exige **acesso total**. |
| GET | `/api/admin/auditoria` | 👑 `*` | Trilha de acesso a dado pessoal (Art. 37). Filtros `acao`, `userId`, `limit`, `skip`. **Só acesso total.** |
| GET | `/api/contato` | — | Dados institucionais da LGPD (`razaoSocial`, `cnpj`, `enderecoMatriz`, `encarregadoEmail`, `contatoTelefone`, `politicaVersao`, `avisoTransicaoWhatsapp`). **Público de propósito:** a política precisa ser legível antes do login e o contato do encarregado é de divulgação obrigatória (Art. 41 §1º). |
| PATCH | `/api/admin/institucionais` | 👑 `listas` | Edita os campos acima. Contato/versão exigem `listas`; `razaoSocial`, `cnpj` e `enderecoMatriz` exigem **acesso total** (`*`) — pedir sem ter dá **400**, não silêncio. |
| GET | `/api/reference` | 🔑 | `{ regioes, pontosExtra, preAvaliacoes, cidades, grupos, clientes, promotores, limiteFotos, senhas }`. Servida de um **buffer pré-gzipado compartilhado** (maior payload do app). |
| GET | `/api/check-promotor?nome=` | 🔑 | Checa o nome no banco: `{ existe, sugestoes:[...] }` |
| GET | `/api/upload-signature?tipo=fotos` | 🔑 | Assinatura p/ upload direto no Cloudinary: `{ signature, timestamp, apiKey, cloudName, folder, type }` |

## Envio e consulta de fotos

| Método | Rota | Acesso | Corpo / Query | Descrição |
|--------|------|--------|---------------|-----------|
| POST | `/api/submissions` | 🔑 | `{ cliente, endereco, dataExposicao, regiao, grupo, promotor, fotos:[{publicId,resourceType,originalName}] }` | Registra **1 foto** (= 1 ou **2 imagens**, "antes e depois"), já enviadas ao Cloudinary. Valida campos, prefixo da pasta e os **limites por promotor: 1 foto/semana e 4/mês** (pela data da exposição). Grupo que não está na lista oficial entra na fila de aprovação. |
| GET | `/api/my/submissions` | 🔑 | — | Fotos do próprio promotor logado. |
| GET | `/api/admin/submissions` | 👑 `fotos` | `?q=&regiao=&grupo=&status=` | Lista/busca todas. `status`: `novos\|baixados\|validados\|recusados`. |
| PATCH | `/api/admin/submissions/:id` | 👑 `fotos` | `{ preAvaliacao?, pontosExtra?, validado?, motivoRecusa?, pago?, observacao?, baixado? }` | Avalia/atualiza a foto (só campos da lista branca). `pontosExtra` é validado contra a lista vigente. **`validado: false` exige `motivoRecusa`** (400 sem ele) — o promotor lê esse motivo. |
| DELETE | `/api/admin/submissions/:id` | 👑 `fotos` | — | **Exclui a foto de vez** (Mongo + todas as imagens no Cloudinary). |
| GET | `/api/file/:id/:idx?` | 🔑 | — | **302** → URL assinada da imagem no Cloudinary. `:idx` escolhe a imagem (0 ou 1, p/ "antes e depois"). Promotor só acessa as próprias. |

## Exportação (ZIP no navegador + Excel)

| Método | Rota | Acesso | Descrição |
|--------|------|--------|-----------|
| GET | `/api/admin/download-manifest?onlyNew=1` | 👑 `fotos` | Manifesto do ZIP: `{ items:[{ id, idx, url assinada, path }], count }` com caminhos `Região/REF - Cliente - Promotor/foto.jpg`. **O ZIP é montado no navegador** (JSZip) — recusadas (`validado===false`) ficam de fora. `onlyNew=0` = tudo. |
| POST | `/api/admin/mark-downloaded` | 👑 `fotos` | `{ ids }` — o navegador chama **depois** de concluir o ZIP; marca `baixado=true`. |
| GET | `/api/admin/export.xlsx` | 👑 `fotos` | **Excel gerado do zero no molde oficial** — uma aba por região, bloco-resumo com fórmulas (`COUNTIFS`), colunas do modelo (Seq, REF, COLAR EM PASTAS, Semanas…). Aceita os mesmos filtros de busca. |
| POST | `/api/admin/purge` | 👑 `fotos` | Apaga **definitivamente** as já baixadas (Mongo + Cloudinary): `{ removed }`. |

## Aderência (números de participação da campanha)

| Método | Rota | Acesso | Query | Descrição |
|--------|------|--------|-------|-----------|
| GET | `/api/admin/aderencia` | 👑 `aderencia` | `?de=YYYY-MM-DD&ate=YYYY-MM-DD` | Consolidado do período (padrão: **últimos 3 meses** até hoje), pela **data da exposição**. Conta **promotores distintos** (`promotorNorm`), não fotos: `{ periodo, base:{ banco, contasAtivas }, promotores:{ participantes, comFotoValidada, pagos }, fotos:{ total, validadas, recusadas, pendentes, pagas, semGrupo }, regioes:[…], grupos:[…] }`. `regioes`/`grupos` vêm ordenados por nº de promotores — o 1º é o "mais ativo". Agregação no Mongo (`$group` duplo), sem trafegar as fotos. |

## Pendentes (aprovação de promotor **e grupo**)

| Método | Rota | Acesso | Corpo | Descrição |
|--------|------|--------|-------|-----------|
| POST | `/api/promotor-pendente` | 🔑 | `{ nome }` | Promotor cadastra um nome novo → fila. Retorna `{ ok }` / `{ jaExiste }` / `{ jaPendente }`. Grupos novos entram na fila automaticamente no envio da foto. |
| GET | `/api/admin/pendentes` | 👑 `aprovar` | — | Lista a fila (cada item tem `tipo: promotor\|grupo`). |
| POST | `/api/admin/pendentes/:id/aprovar` | 👑 `aprovar` | — | Aprova → entra no banco de promotores ou na lista de grupos, conforme o `tipo`. |
| DELETE | `/api/admin/pendentes/:id` | 👑 `aprovar` | — | Rejeita/remove da fila. |

## Contas de usuário

| Método | Rota | Acesso | Corpo | Descrição |
|--------|------|--------|-------|-----------|
| GET | `/api/admin/users` | 👑 `contas` | — | Lista todas as contas (admins e promotores), sem hash de senha. |
| POST | `/api/admin/users` | 👑 `contas` | `{ name, email, password, role, telefone?, grupo?, regiao?, setor?, matricula?, mustChangePassword?, permissions? }` | Cria conta. `role`: `promotor` (padrão) ou `admin`. `permissions` só é aceito se quem cria tem acesso total — senão o admin nasce **sem nenhuma permissão**. Senha **"0"** força `mustChangePassword` (primeiro acesso: a pessoa cria a própria senha). |
| GET | `/api/admin/users/import-template.xlsx` | 👑 `contas` | — | **Modelo de planilha** pro import: nasce **protegida** — cabeçalho/estrutura travados, só as células de preenchimento (500 linhas) liberadas — com lista suspensa em Região e Tipo, dica em cada cabeçalho e Telefone/Senha formatadas como texto. |
| POST | `/api/admin/users/import` | 👑 `contas` | `{ file }` (xlsx em **base64**) | **Cria/atualiza contas em massa por planilha.** Detecta as colunas pelo cabeçalho (3 primeiras linhas, qualquer aba): `Nome` + `E-mail` obrigatórias; `Telefone`, `Grupo`, `Região` (sigla ou nome), `Setor`, `Matrícula` (**0 = sem matrícula**), `Tipo`, `Senha` opcionais. E-mail novo → cria com senha provisória `PRIMEIRONOME+ano` e troca obrigatória; e-mail existente → só atualiza o perfil (não mexe na senha). Senha **"0"** = primeiro acesso: a pessoa entra com `0` e **cria a própria senha** numa tela de boas-vindas (`trocar-senha.html?primeiro=1`, sem pedir a provisória). Máx **500 linhas** por importação. Retorna `{ criados:[{name,email,senha,role}], atualizados, erros:[{linha,email,motivo}] }`. |
| PATCH | `/api/admin/users/:id` | 👑 `contas` | `{ name?, email?, telefone?, grupo?, regiao?, setor?, matricula? }` | Edita o perfil da conta. |
| PATCH | `/api/admin/users/:id/permissions` | 🪪 | `{ permissions:[...] }` | Configura as permissões de um admin. Só acesso total. |
| POST | `/api/admin/users/:id/password` | 👑 `contas` | `{ password }` | Redefine a senha (marca troca obrigatória no próximo login). |
| POST | `/api/admin/users/:id/active` | 👑 `contas` | `{ active }` | **Banir** (`false`) / desbanir (`true`). Bloqueado p/ admin. |
| DELETE | `/api/admin/users/:id` | 👑 `contas` | — | Exclui a conta. Bloqueado p/ admin. |

## Crachá de acesso total

| Método | Rota | Acesso | Corpo | Descrição |
|--------|------|--------|-------|-----------|
| POST | `/api/admin/cracha` | 🪪 | — | Gera um crachá novo (`MPDV-…`, 16 bytes aleatórios). Só o **hash sha256** fica no banco; o código aparece **uma única vez** (dá pra baixar como arquivo `.json`). Gerar um novo **invalida o anterior**. |
| POST | `/api/cracha/validar` | 🔑 (admin) | `{ codigo }` | Valida o crachá e dá `permissions: ['*']` à própria conta. Só funciona pra contas admin. |

## Listas e configuração

| Método | Rota | Acesso | Corpo | Descrição |
|--------|------|--------|-------|-----------|
| PATCH | `/api/admin/config` | 👑 `listas` | `{ senhaMensal?, senhaSemanal? }` | Define as senhas atuais (o que o promotor vê). |
| POST | `/api/admin/ref/:type` | 👑 `listas` | `{ value }` | Adiciona item. `type`: `grupos\|clientes\|promotores`. |
| DELETE | `/api/admin/ref/:type` | 👑 `listas` | `{ value }` | Remove item. |

## Códigos de status

| Código | Significado |
|--------|-------------|
| 200 | OK |
| 302 | Redireciona para a URL assinada do arquivo (rota `/api/file/:id`) |
| 400 | Validação (campos faltando, tipo inválido, limite de fotos, planilha inválida) |
| 401 | Não autenticado / sessão expirada / banido |
| 403 | Autenticado mas **sem a permissão** exigida pela rota |
| 404 | Não encontrado |
| 429 | Rate-limit (login / recuperação de senha) |
| 503 | Servidor no teto de concorrência (portão cheio) — tentar de novo em instantes |
| 500 | Erro interno (middleware central, sem stack trace exposta) |
