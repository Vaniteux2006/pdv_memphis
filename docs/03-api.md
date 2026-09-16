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
| POST | `/api/login` | 🔓 | `{ email, password }` | `{ role, name, mustChangePassword, precisaAceitar }` + `Set-Cookie: mp_token` · 401 se inválido · **rate-limit** 10 falhas/15min (sucesso não conta) |
| POST | `/api/logout` | 🔓 | — | `{ ok: true }` + limpa o cookie |
| GET | `/api/me` | 🔑 | — | `{ id, email, name, role, mustChangePassword, grupo, regiao, telefone, setor, matricula, permissions, avatarUrl, aceiteVersao, precisaAceitar, politicaVersao }` — `avatarUrl` é URL assinada da foto de perfil, ou `null` |
| PATCH | `/api/me` | 🔑 | `{ telefone?, name?, avatar? }` | A **própria** conta (`/user/`). `name` e `telefone` pra todo mundo (grupo/região não — vão pela fila de correção; fotos já enviadas guardam o nome da época); `avatar` = `{ publicId }` recém-subido em `memphis-pdv/avatars/` (validado por regex) ou `null` pra tirar — a foto anterior é apagada do Cloudinary. |
| POST | `/api/me/email` | 🔑 | `{ email, password }` | Troca o e-mail de login — exige a senha atual e domínio completo. Duplicado → 400. |
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
| GET | `/api/reference` | 🔑 | Maior payload do app, servido de **buffer pré-gzipado — um por perfil**. Admin recebe tudo; **promotor NÃO recebe `promotores[]` nem `grupos[]`** (Bloco 2: ninguém vê o nome de ninguém). |
| GET | `/api/check-promotor?nome=` | 👑 `listas` | Checa o nome no banco: `{ existe, sugestoes:[...] }`. **Passou a exigir admin** — era o vazamento mais direto de nomes de colegas. |
| GET | `/api/upload-signature?tipo=fotos\|avatars` | 🔑 | Assinatura p/ upload direto no Cloudinary: `{ signature, timestamp, apiKey, cloudName, folder, type }` |

## Cadastro público (sign up)

| Método | Rota | Acesso | Corpo | Descrição |
|--------|------|--------|-------|-----------|
| GET | `/api/signup-info` | 🔓 | — | Constantes que a tela de cadastro precisa antes do login: `{ regioes }`. |
| POST | `/api/signup` | 🔓 | `{ name, email, password, telefone?, grupo?, regiao?, aceitePolitica }` | Cria conta de **promotor aguardando aprovação**. **`aceitePolitica` é validado no servidor** — marcar a caixa no front não prova nada. Rate-limit 20/h por IP. |
| GET | `/api/admin/signup-count` | 👑 `contas` | — | Só a contagem de cadastros pendentes, para o badge do painel. |

## Envio e consulta de fotos

| Método | Rota | Acesso | Corpo / Query | Descrição |
|--------|------|--------|---------------|-----------|
| POST | `/api/submissions` | 🔑 | `{ cliente, endereco, dataExposicao, fotos:[{publicId,resourceType,originalName}] }` | Registra **1 foto** (= 1 ou **2 imagens**, "antes e depois"), já enviadas ao Cloudinary. ⚠️ **`promotor`, `regiao` e `grupo` vêm da SESSÃO** — o que vier no corpo é ignorado (Bloco 2). Valida campos, prefixo da pasta e os **limites: 1 foto/semana e 4/mês** por pessoa (pela data da exposição). Conta sem região é recusada, com instrução de falar com a equipe. |
| GET | `/api/my/submissions` | 🔑 | — | Fotos do próprio promotor logado. |
| GET | `/api/admin/submissions` | 👑 `fotos` | `?q=&regiao=&grupo=&status=` | Lista/busca todas. `status`: `novos\|baixados\|validados\|recusados`. |
| PATCH | `/api/admin/submissions/:id` | 👑 `fotos` | `{ preAvaliacao?, pontosExtra?, validado?, motivoRecusa?, pago?, observacao?, baixado? }` | Avalia/atualiza a foto (só campos da lista branca). `pontosExtra` é validado contra a lista vigente. **`validado: false` exige `motivoRecusa`** (400 sem ele) — o promotor lê esse motivo. |
| DELETE | `/api/admin/submissions/:id` | 👑 `fotos` | — | **Exclui a foto de vez** (Mongo + todas as imagens no Cloudinary). |
| GET | `/api/file/:id/:idx?` | 🔑 | — | **302** → URL assinada da imagem, com `f_auto,q_auto` (versão leve para a tela). `:idx` escolhe a imagem (0 ou 1, p/ "antes e depois"). Promotor só acessa as próprias; foto de pódio é visível a qualquer logado. |

### Do próprio promotor

| Método | Rota | Acesso | Descrição |
|--------|------|--------|-----------|
| GET | `/api/my/retornos` | 🔑 | Histórico de **recusas** da pessoa. Vive em coleção própria: a submissão é anonimizada aos 2 meses, mas a justificativa continua acessível **enquanto a conta existir** (Art. 15). |
| POST | `/api/my/correcao-cadastro` | 🔑 | `{ descricao }` — abre pedido de **correção de cadastro**. O promotor não digita mais nome/grupo/região, então precisa de um caminho para avisar quando estiverem errados. Um pedido em aberto por pessoa. |

## Exportação (ZIP no navegador + Excel)

| Método | Rota | Acesso | Descrição |
|--------|------|--------|-----------|
| GET | `/api/admin/download-manifest?onlyNew=1` | 👑 `fotos` | Manifesto do ZIP: `{ items:[{ id, idx, url que **expira em 1h**, path }], count }` com caminhos `Região/REF - Cliente - Promotor/foto.jpg`. **O ZIP é montado no navegador** (JSZip) — recusadas (`validado===false`) ficam de fora. `onlyNew=0` = tudo. |
| POST | `/api/admin/mark-downloaded` | 👑 `fotos` | `{ ids }` — o navegador chama **depois** de concluir o ZIP; marca `baixado=true`. |
| GET | `/api/admin/export.xlsx` | 👑 `fotos` | **Excel gerado do zero no molde oficial** — uma aba por região, bloco-resumo com fórmulas (`COUNTIFS`), colunas do modelo (Seq, REF, COLAR EM PASTAS, Semanas…). Aceita os mesmos filtros de busca. |
| POST | `/api/admin/purge` | 👑 `fotos` | Apaga **definitivamente** as já baixadas (Mongo + Cloudinary): `{ removed }`. |
| POST | `/api/admin/submissions/excluir-tudo` | 🪪 `*` | `{ confirmacao: "EXCLUIR" }` — apaga **todas** as fotos (todas as sub-abas, vencedoras de ranking inclusive) + imagens no Cloudinary em lotes de 100 (`delete_resources`) + o quadro de honra. Sem backup (foto não é cadastro — quem quer guardar baixa o ZIP antes). Palavra errada → 400. Auditoria `excluiu_todas_fotos` com `N/M imagens no storage`. `{ fotos, imagens, imagensTotal, ranking }`. |

## Ranking e presença

| Método | Rota | Acesso | Corpo | Descrição |
|--------|------|--------|-------|-----------|
| GET | `/api/ranking` | 🔑 | — | Pódios por edição. ⚠️ **Exceção deliberada** ao "ninguém vê o nome de ninguém": mostra o **nome completo** dos vencedores a todos os logados — premiação divulgada é finalidade própria, e está declarado na política. Cada item traz `temFoto`: `false` = edição passada cuja imagem já expirou, e a página cai no **quadro de honra em texto** em vez de mostrar imagem quebrada. |
| POST | `/api/admin/ranking` | 👑 `fotos` | `{ id, pos }` | Marca 1º/2º/3º da edição (só foto aprovada com nota EXCELENTE). **Grava o registro do pódio na hora da marcação** — é o que sobrevive à retenção da foto. `pos` vazio desmarca. |
| POST | `/api/admin/presenca` | 👑 `fotos` | `{ subId }` | "Estou nesta foto agora" → devolve em quais fotos os **outros** admins estão. Só avisa, não reserva. |

## Aderência (números de participação da campanha)

| Método | Rota | Acesso | Query | Descrição |
|--------|------|--------|-------|-----------|
| GET | `/api/admin/aderencia` | 👑 `aderencia` | `?de=YYYY-MM-DD&ate=YYYY-MM-DD` | Consolidado do período (padrão: **últimos 3 meses** até hoje), pela **data da exposição**. Conta **promotores distintos** (`promotorNorm`), não fotos: `{ periodo, base:{ banco, contasAtivas }, promotores:{ participantes, comFotoValidada, pagos }, fotos:{ total, validadas, recusadas, pendentes, pagas, semGrupo }, regioes:[…], grupos:[…] }`. `regioes`/`grupos` vêm ordenados por nº de promotores — o 1º é o "mais ativo". Agregação no Mongo (`$group` duplo), sem trafegar as fotos. |

### Gráficos e alertas

| Método | Rota | Acesso | Query | Descrição |
|--------|------|--------|-------|-----------|
| GET | `/api/admin/series` | 👑 `aderencia` | `?de=&ate=` | Séries temporais dos gráficos (envios por período, por região/grupo). |
| GET | `/api/admin/alertas` | 👑 `fotos` | — | **Escalonamento de fotos paradas** + cadastros pendentes **numa requisição só**: `{ naoAvaliadas, naoBaixadas, destaque, critico, ultima, aExpirar, dias:{30,45,53}, cadastrosPendentes, retencaoDias, apagando }`. Funde o antigo `signup-count` de propósito — somar outro polling de 10s bateria onde o gargalo já mora (Atlas M0). |

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
| POST | `/api/admin/users/import` | 👑 `contas` | `{ file }` (xlsx em **base64**) | **Cria/atualiza contas em massa por planilha.** Detecta as colunas pelo cabeçalho (3 primeiras linhas, qualquer aba): `Nome` + `E-mail` obrigatórias; `Telefone`, `Grupo`, `Região` (sigla ou nome), `Setor`, `Matrícula` (**0 = sem matrícula**), `Tipo`, `Senha` opcionais. E-mail novo → cria a conta **sem senha utilizável** e dispara um **convite** para a pessoa criar a própria senha (token de 7 dias); linha **sem e-mail** ganha login interno (`@sem-email.memphis.local`) + **senha aleatória**, devolvida em `semEmail[]` para entrega em mãos. E-mail existente → só atualiza o perfil (não mexe na senha). Senha **"0"** = primeiro acesso: a pessoa entra com `0` e **cria a própria senha** numa tela de boas-vindas (`trocar-senha.html?primeiro=1`, sem pedir a provisória). Máx **500 linhas** por importação. Retorna `{ criados:[{name,email,role,via}], convites, semEmail:[{name,login,senha}], atualizados, erros:[{linha,email,motivo}] }` — `via` é `convite` ou `provisoria`. |
| PATCH | `/api/admin/users/:id` | 👑 `contas` | `{ name?, email?, telefone?, grupo?, regiao?, setor?, matricula? }` | Edita o perfil da conta. |
| PATCH | `/api/admin/users/:id/permissions` | 🪪 | `{ permissions:[...] }` | Configura as permissões de um admin. Só acesso total. |
| POST | `/api/admin/users/:id/password` | 👑 `contas` | `{ password }` | Redefine a senha (marca troca obrigatória no próximo login). |
| POST | `/api/admin/users/:id/active` | 👑 `contas` | `{ active }` | **Banir** (`false`) / desbanir (`true`). Bloqueado p/ admin. |
| DELETE | `/api/admin/users/:id` | 👑 `contas` | — | Exclui a conta. Bloqueado p/ admin. |

### Correções de cadastro

| Método | Rota | Acesso | Descrição |
|--------|------|--------|-----------|
| GET | `/api/admin/correcoes` | 👑 `contas` | Fila de pedidos em aberto, com o cadastro atual da pessoa ao lado do que ela relatou. |
| POST | `/api/admin/correcoes/:id/resolver` | 👑 `contas` | Marca como resolvido (`:id` = id do usuário). |

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
| GET | `/api/admin/ref/promotores` | 👑 `listas` | `?q=&limit=` | Banco de promotores **paginado**, com o grupo de cada um: `{ promotores, total, semGrupo }`. |
| DELETE | `/api/admin/ref/promotores/tudo` | 👑 `listas` | — | Zera o banco de nomes (a tela baixa um `.csv` de backup antes). |
| POST | `/api/admin/ref/import` | 👑 `listas` | `{ file }` (xlsx base64) | Importa **grupos e promotores** em massa. Só adiciona; a única coisa que atualiza é o **grupo do promotor**. |
| GET | `/api/admin/ref/import-template.xlsx` | 👑 `listas` | — | Modelo protegido para o import acima. |
| GET | `/api/admin/senhas` | 👑 `listas` | — | Senhas **programadas por data**: `{ hoje, mensal[], semanal[], vigentes }`. O servidor escolhe a vigente sozinho (fuso de Brasília). |
| POST | `/api/admin/senhas` | 👑 `listas` | `{ tipo, inicio, senha }` | Programa uma senha a partir de uma data. Repetir a data substitui. |
| DELETE | `/api/admin/senhas` | 👑 `listas` | `{ tipo, inicio }` | Remove uma entrada programada. |
| POST | `/api/admin/senhas/import` | 👑 `listas` | `{ file }` (xlsx base64) | Lê a planilha "LISTA DE SENHAS SEMANAIS" da equipe e programa tudo de uma vez. |

## LGPD: retenção, backup e reset

| Método | Rota | Acesso | Corpo | Descrição |
|--------|------|--------|-------|-----------|
| POST | `/api/admin/retencao/rodar` | 🪪 | — | Roda a retenção **sob demanda** para conferir a lista (checkpoint D3): `{ modo, candidatas, amostra, ... }`. Em **modo só-relatório** (padrão) não apaga nada — ligar exige `RETENCAO_APAGA=1`. Também roda sozinha 1×/dia. |
| POST | `/api/admin/backup` | 🪪 | — | Dump de `users`, `promotores`, `refdata` e `config` como arquivo `raw` autenticado. ⚠️ **É dado pessoal** — retenção declarada de 5 meses. |
| GET | `/api/admin/backup` | 🪪 | — | `{ itens, retencaoDias }`. |
| GET | `/api/admin/backup/baixar?arquivo=` | 🪪 | — | **302** → URL que **expira**. Sem caminho de volta, "ter backup" seria teatro. |
| POST | `/api/admin/reset-cadastros` | 🪪 | `{ confirmacao: "RESETAR" }` | **A ação mais destrutiva do sistema.** Exige crachá + a palavra digitada + **backup obrigatório antes**; se o backup falhar, **aborta** (500) sem apagar nada. Nunca apaga quem executou nem outros admins. Tudo na auditoria. |

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
