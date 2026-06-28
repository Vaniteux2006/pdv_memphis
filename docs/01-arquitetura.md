# 01 — Arquitetura

## Visão de componentes

```mermaid
flowchart TB
  subgraph Browser["Navegador (cliente)"]
    direction TB
    LP["index.html<br/>landing"]
    LG["login.html"]
    PR["promotor.html"]
    AD["admin.html"]
    CM["common.js<br/>(api(), cloudinaryUpload(), toast)"]
  end

  subgraph Server["Servidor — Node + Express (server.js)"]
    direction TB
    MW["Middlewares<br/>cookieParser · express.json · requireAuth · requireAdmin · ah()"]
    RT["Rotas REST (/api/*)"]
    EX["Geração de ZIP (archiver)<br/>e Excel (exceljs)"]
  end

  subgraph Lib["Camadas (lib/)"]
    direction TB
    DBL["db.js<br/>regras + acesso a dados"]
    MGL["mongo.js<br/>conexão cacheada"]
    STL["storage.js<br/>Cloudinary"]
  end

  MO[("MongoDB Atlas")]
  CL[("Cloudinary")]

  Browser -->|"HTTPS + cookie JWT"| MW --> RT
  RT --> DBL
  RT --> STL
  RT --> EX
  DBL --> MGL --> MO
  STL --> CL
  Browser -. "upload direto de foto (assinado)" .-> CL
```

## Stack

| Camada | Tecnologia | Arquivo(s) |
|--------|-----------|-----------|
| Frontend | HTML + CSS + JS puro (sem framework, sem build) | `public/` |
| Servidor | Node.js + Express | `server.js` |
| Autenticação | JWT (`jsonwebtoken`) + cookie httpOnly (`cookie-parser`) | `server.js` |
| Banco de dados | MongoDB Atlas (driver `mongodb`) | `lib/db.js`, `lib/mongo.js` |
| Armazenamento de arquivos | Cloudinary (`cloudinary`) | `lib/storage.js` |
| Exportações | `archiver` (ZIP), `exceljs` (XLSX) | `server.js` |
| Config/segredos | `dotenv` (`.env`, fora do Git) | `.env` |

## Estrutura de pastas

```
TRABALHO/
├─ server.js              Aplicação Express: rotas, auth, ZIP, Excel
├─ lib/
│  ├─ db.js               Regras de negócio + acesso ao MongoDB (assíncrono)
│  ├─ mongo.js            Conexão única e cacheada com o Mongo
│  ├─ storage.js          Cloudinary: upload assinado, URL de entrega, remoção
│  └─ cities.js           Lista de cidades (datalist)
├─ public/
│  ├─ index.html          Landing page (marketing interno)
│  ├─ login.html          Identificação
│  ├─ promotor.html       Envio de fotos + acompanhamento
│  ├─ admin.html          Painel da equipe
│  ├─ common.js           Helpers compartilhados (fetch, upload, toast)
│  └─ style.css           Tema Memphis (claro, teal)
├─ data/
│  └─ seed.json           Dados reais (promotores/grupos/clientes) p/ semear o Mongo
├─ test/
│  └─ smoke.js            Teste de regressão end-to-end (25 casos)
├─ tools/
│  └─ importar-planilhas.js  Reimporta dados das planilhas .xlsx/.xlsm
└─ .env                   Segredos (MONGODB_URI, CLOUDINARY_*, SESSION_SECRET)
```

## Princípios de arquitetura

1. **Separação por camadas.** As rotas (`server.js`) não falam com o Mongo nem com o
   Cloudinary diretamente — sempre via `lib/db.js` e `lib/storage.js`. Isso permitiu
   trocar o backend (de arquivo JSON → MongoDB, de disco → Cloudinary) sem reescrever as rotas.

2. **Serverless-ready.** A aplicação não guarda estado em memória:
   - Sessão → **JWT** (o "crachá" viaja no cookie, não na RAM do servidor).
   - Arquivos → **Cloudinary** (não há disco local).
   - Conexão Mongo **cacheada** entre invocações (`global.__mongoClientPromise`).

3. **O servidor não recebe arquivos.** A foto vai do **navegador direto pro Cloudinary**
   (upload assinado). O servidor só emite a assinatura e registra os metadados. Isso
   contorna o limite de corpo das funções serverless e tira o servidor do caminho do upload.

## Ciclo de uma requisição autenticada

```mermaid
sequenceDiagram
  participant B as Navegador
  participant MW as Middlewares
  participant H as Handler da rota
  participant DB as lib/db.js
  B->>MW: GET /api/... (Cookie: mp_token)
  MW->>MW: cookieParser lê o cookie
  MW->>MW: requireAuth verifica o JWT
  MW->>DB: findUserById(uid)
  DB-->>MW: usuário (active?)
  alt token inválido / usuário inativo
    MW-->>B: 401
  else ok
    MW->>H: req.user preenchido
    H->>DB: consulta/altera
    DB-->>H: dados
    H-->>B: 200 JSON
  end
```

Toda rota assíncrona é embrulhada por `ah()`, que captura erros e os encaminha
para um middleware de erro central (responde JSON, sem vazar stack trace).
