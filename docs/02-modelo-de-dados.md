# 02 — Modelo de Dados (MongoDB)

Banco: **MongoDB Atlas**, base `memphis_pdv` (configurável via `MONGO_DB`).
Cada documento usa um campo **`id`** (UUID) como chave lógica — não o `_id` do Mongo —
para manter as URLs e o frontend estáveis.

## Diagrama Entidade-Relacionamento

```mermaid
erDiagram
  USERS ||--o{ SUBMISSIONS : "envia (uploadedBy)"

  USERS {
    string id PK "UUID"
    string email
    string emailLower "indexado, único"
    string name
    string role "admin | promotor"
    string passwordHash "bcrypt"
    bool   active "false = banido"
    string createdAt "ISO"
  }

  SUBMISSIONS {
    string id PK "UUID"
    string storedFile "public_id no Cloudinary"
    string resourceType "image | raw"
    string uploadedBy FK "USERS.id"
    string uploadedByEmail
    string cliente
    string endereco
    string regiao "NE|CN|SP|SE|SUL"
    string promotor
    string promotorNorm "normalizado"
    string clienteNorm "normalizado"
    string searchBlob "busca acento-insensível"
    bool   promotorNoBanco
    string grupo
    string dataExposicao "YYYY-MM-DD"
    string senhaMensal "carimbada no envio"
    string senhaSemanal "carimbada no envio"
    string preAvaliacao "REGULAR|BOM|EXCELENTE"
    array  pontosExtra "lista"
    bool   validado "true|false|null"
    bool   pago
    string observacao
    bool   baixado
    string createdAt "ISO"
  }

  PROMOTORES {
    string id PK "UUID"
    string nome
    string nomeNorm "indexado, único"
  }

  PENDENTES {
    string id PK "UUID"
    string nome
    string nomeNorm "indexado, único"
    string criadoPor "email do promotor"
    string criadoEm "ISO"
  }

  REFDATA {
    string _id "singleton"
    array  grupos
    array  clientes
  }

  CONFIG {
    string _id "singleton"
    string senhaMensal
    string senhaSemanal
  }
```

## Coleções

### `users`
Contas de acesso (admins e promotores).
- `role`: `admin` (acessa o painel) ou `promotor` (só envia).
- `active`: `false` = **banido** (login e requisições bloqueados).
- Senha guardada como **hash bcrypt** — nunca em texto.

### `submissions`
Cada **foto** enviada é um documento.
- `storedFile` + `resourceType`: referência ao arquivo no Cloudinary (a foto não fica no Mongo).
- Campos `*Norm` e `searchBlob`: versões normalizadas (minúsculo, sem acento) para
  busca e checagem rápidas.
- `senhaMensal` / `senhaSemanal`: **carimbadas pelo servidor** no momento do envio
  (vêm de `config`, não são digitadas pelo promotor — anti-fraude).
- Flags de avaliação (`preAvaliacao`, `pontosExtra`, `validado`, `pago`) são **independentes**
  entre si — ver ciclo de vida em [04 — Fluxos](04-fluxos-bpmn.md).

### `promotores`
Banco oficial de nomes de promotores da empresa (~2.050). Usado para **checar** se quem
envia existe no cadastro. Índice único em `nomeNorm` para lookup e autocomplete rápidos.

### `pendentes`
Nomes que promotores cadastraram por não estarem no banco — aguardam **aprovação** da equipe.
Ao aprovar, o nome migra para `promotores` e o pendente é removido.

### `refdata` (documento único `singleton`)
Listas editáveis: `grupos` e `clientes` (usadas em autocomplete e filtros).

### `config` (documento único `singleton`)
`senhaMensal` e `senhaSemanal` **atuais**, definidas pela equipe. São o "codinome" da
campanha que o promotor vê na hora de enviar.

## Índices (criados em `db.init()`)

| Coleção | Índice | Tipo |
|---------|--------|------|
| `users` | `emailLower` | único |
| `promotores` | `nomeNorm` | único |
| `pendentes` | `nomeNorm` | único |
| `submissions` | `id` | único |
| `submissions` | `regiao` | simples |
| `submissions` | `baixado` | simples |
| `submissions` | `searchBlob` | simples |
| `submissions` | `createdAt` | descendente |

## Seed inicial

No primeiro boot (`db.init()`), se as coleções estiverem vazias:
- cria o admin `admin@local` / `admin123` (trocar após o primeiro acesso);
- semeia `promotores`, `refdata.grupos` e `refdata.clientes` a partir de `data/seed.json`;
- cria `config` com senhas padrão.

`data/seed.json` é gerado por `tools/importar-planilhas.js` a partir das planilhas
internas (`Registro de clientes…`, `Cadastro Promotores…`).
