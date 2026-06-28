# 03 — Referência da API

Base: `/api`. Respostas em JSON. Autenticação por **cookie JWT** (`mp_token`, httpOnly) —
enviado automaticamente pelo navegador. Erros retornam `{ "error": "mensagem" }`.

**Níveis de acesso:**
- 🔓 público
- 🔑 autenticado (qualquer logado)
- 👑 admin

## Autenticação

| Método | Rota | Acesso | Corpo | Resposta |
|--------|------|--------|-------|----------|
| POST | `/api/login` | 🔓 | `{ email, password }` | `{ role, name }` + `Set-Cookie: mp_token` · 401 se inválido · **rate-limit** 10 falhas/15min |
| POST | `/api/logout` | 🔓 | — | `{ ok: true }` + limpa o cookie |
| GET | `/api/me` | 🔑 | — | `{ id, email, name, role }` |
| POST | `/api/forgot-password` | 🔓 | `{ email }` | Sempre `{ ok: true }` (anti-enumeração). Gera token (hash + 1h) e **envia link** por email. Rate-limit 20/15min. |
| POST | `/api/reset-password` | 🔓 | `{ token, password }` | Redefine a senha se o token for válido/não expirado/uso único. 400 se inválido. |

## Dados de referência

| Método | Rota | Acesso | Descrição |
|--------|------|--------|-----------|
| GET | `/api/reference` | 🔑 | `{ regioes, pontosExtra, preAvaliacoes, cidades, grupos, clientes, promotores, limiteFotos, senhas }` |
| GET | `/api/check-promotor?nome=` | 🔑 | Checa o nome no banco: `{ existe, sugestoes:[...] }` |
| GET | `/api/upload-signature?tipo=fotos` | 🔑 | Assinatura p/ upload direto no Cloudinary: `{ signature, timestamp, apiKey, cloudName, folder, type }` |

## Envio e consulta de fotos

| Método | Rota | Acesso | Corpo / Query | Descrição |
|--------|------|--------|---------------|-----------|
| POST | `/api/submissions` | 🔑 | `{ cliente, endereco, dataExposicao, regiao, grupo, promotor, fotos:[{publicId,resourceType,bytes,originalName}] }` | Registra as fotos (já enviadas ao Cloudinary). Valida campos, **limite de 2 por cliente** e prefixo da pasta. |
| GET | `/api/my/submissions` | 🔑 | — | Fotos do próprio promotor logado. |
| GET | `/api/admin/submissions` | 👑 | `?q=&regiao=&grupo=&status=` | Lista/busca todas. `status`: `novos\|baixados\|validados\|recusados`. |
| PATCH | `/api/admin/submissions/:id` | 👑 | `{ preAvaliacao?, pontosExtra?, validado?, pago?, observacao?, baixado? }` | Avalia/atualiza a foto (campos permitidos apenas). |
| GET | `/api/file/:id` | 🔑 | — | **302** → URL assinada da foto no Cloudinary. Promotor só acessa as próprias. |

## Exportação

| Método | Rota | Acesso | Descrição |
|--------|------|--------|-----------|
| GET | `/api/admin/download?onlyNew=1` | 👑 | **ZIP** (`Região/REF - Cliente - Promotor/foto.jpg`). Marca as incluídas como baixadas. `onlyNew=0` = tudo. |
| GET | `/api/admin/export.xlsx` | 👑 | **Excel** no modelo das planilhas, uma aba por região. Aceita os mesmos filtros de busca. |
| POST | `/api/admin/purge` | 👑 | Apaga **definitivamente** as já baixadas (Mongo + Cloudinary): `{ removed }`. |

## Promotores pendentes (aprovação)

| Método | Rota | Acesso | Corpo | Descrição |
|--------|------|--------|-------|-----------|
| POST | `/api/promotor-pendente` | 🔑 | `{ nome }` | Promotor cadastra um nome novo → fila. Retorna `{ ok }` / `{ jaExiste }` / `{ jaPendente }`. |
| GET | `/api/admin/pendentes` | 👑 | — | Lista a fila de aprovação. |
| POST | `/api/admin/pendentes/:id/aprovar` | 👑 | — | Aprova → entra no banco de promotores. |
| DELETE | `/api/admin/pendentes/:id` | 👑 | — | Rejeita/remove da fila. |

## Contas de usuário

| Método | Rota | Acesso | Corpo | Descrição |
|--------|------|--------|-------|-----------|
| GET | `/api/admin/users` | 👑 | — | Lista todas as contas (admins e promotores). |
| POST | `/api/admin/users` | 👑 | `{ name, email, password, role }` | Cria conta. `role`: `promotor` (padrão) ou `admin`. |
| POST | `/api/admin/users/:id/password` | 👑 | `{ password }` | Redefine a senha. |
| POST | `/api/admin/users/:id/active` | 👑 | `{ active }` | **Banir** (`false`) / desbanir (`true`). Bloqueado p/ admin. |
| DELETE | `/api/admin/users/:id` | 👑 | — | Exclui a conta. Bloqueado p/ admin. |

## Listas e configuração

| Método | Rota | Acesso | Corpo | Descrição |
|--------|------|--------|-------|-----------|
| PATCH | `/api/admin/config` | 👑 | `{ senhaMensal?, senhaSemanal? }` | Define as senhas atuais (o que o promotor vê). |
| POST | `/api/admin/ref/:type` | 👑 | `{ value }` | Adiciona item. `type`: `grupos\|clientes\|promotores`. |
| DELETE | `/api/admin/ref/:type` | 👑 | `{ value }` | Remove item. |

## Códigos de status

| Código | Significado |
|--------|-------------|
| 200 | OK |
| 302 | Redireciona para a URL assinada do arquivo (rota `/api/file/:id`) |
| 400 | Validação (campos faltando, tipo inválido, limite de fotos, foto inválida) |
| 401 | Não autenticado / sessão expirada / banido |
| 403 | Autenticado mas sem permissão (ex: promotor em rota de admin) |
| 404 | Não encontrado |
| 500 | Erro interno (middleware central, sem stack trace exposta) |
