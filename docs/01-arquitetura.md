# 01 — Arquitetura

## Visão de componentes

```mermaid
flowchart TB
  subgraph Browser["Navegador (cliente)"]
    direction TB
    LP["index.html<br/>landing"]
    LG["login.html<br/>(+ esqueci minha senha)"]
    PR["promotor.html"]
    AD["admin.html"]
    TS["trocar-senha.html<br/>redefinir.html"]
    CM["common.js<br/>(api(), cloudinaryUpload(), toast)<br/>+ vendor/jszip.min.js (ZIP)"]
  end

  subgraph Server["Servidor — Node + Express (server.js)"]
    direction TB
    MW["Middlewares<br/>helmet · portão de concorrência · compression ·<br/>cookieParser · express.json · rate-limit ·<br/>requireAuth · requirePerm · ah()"]
    RT["Rotas REST (/api/*)"]
    EX["Excel (exceljs): export no molde oficial<br/>+ import de contas por planilha"]
  end

  subgraph Lib["Camadas (lib/)"]
    direction TB
    DBL["db.js<br/>regras + acesso a dados"]
    MGL["mongo.js<br/>conexão cacheada"]
    STL["storage.js<br/>Cloudinary"]
    MAL["mailer.js<br/>email (reset de senha)"]
  end

  MO[("MongoDB Atlas")]
  CL[("Cloudinary")]
  SMTP[("SMTP")]

  Browser -->|"HTTPS + cookie JWT"| MW --> RT
  RT --> DBL
  RT --> STL
  RT --> EX
  RT --> MAL --> SMTP
  DBL --> MGL --> MO
  STL --> CL
  Browser -. "upload direto de foto (assinado)" .-> CL
  Browser -. "baixa as fotos e monta o ZIP (JSZip)" .-> CL
```

## Stack

| Camada | Tecnologia | Arquivo(s) |
|--------|-----------|-----------|
| Frontend | HTML + CSS + JS puro (sem framework, sem build) | `public/` |
| Servidor | Node.js + Express | `server.js` |
| Autenticação | JWT (`jsonwebtoken`) + cookie httpOnly (`cookie-parser`) | `server.js` |
| Segurança HTTP | `helmet` (CSP) + `express-rate-limit` (login/reset) | `server.js` |
| Banco de dados | MongoDB Atlas (driver `mongodb`) | `lib/db.js`, `lib/mongo.js` |
| Armazenamento de arquivos | Cloudinary (`cloudinary`) | `lib/storage.js` |
| Email (reset de senha) | `nodemailer` | `lib/mailer.js` |
| Excel (export + import de contas) | `exceljs` | `server.js` |
| ZIP | **JSZip no navegador** (vendorado — o servidor só entrega o manifesto) | `public/vendor/jszip.min.js` |
| Compressão | `compression` (gzip) + buffer pré-gzipado da `/api/reference` | `server.js` |
| Config/segredos | `dotenv` (`.env`, fora do Git) | `.env` |

## Estrutura de pastas

```
TRABALHO/
├─ server.js              Aplicação Express: rotas, auth, permissões, Excel
├─ api/index.js           Entrypoint serverless (Vercel) — importa o app
├─ lib/
│  ├─ db.js               Regras de negócio + acesso ao MongoDB (assíncrono)
│  ├─ mongo.js            Conexão única e cacheada com o Mongo
│  ├─ storage.js          Cloudinary: upload assinado, URL de entrega, remoção
│  ├─ mailer.js           Envio de email (link de redefinição de senha)
│  └─ cities.js           Lista de cidades (datalist)
├─ public/
│  ├─ index.html          Landing page (marketing interno)
│  ├─ login.html          Identificação + "esqueci minha senha"
│  ├─ promotor.html       Envio de fotos + acompanhamento (menu RCA: em breve)
│  ├─ admin.html          Painel da equipe (abas por permissão)
│  ├─ trocar-senha.html   Troca obrigatória de senha provisória (1º login)
│  ├─ redefinir.html      Redefinição via link de email
│  ├─ common.js           Helpers compartilhados (fetch, upload, toast)
│  ├─ vendor/jszip.min.js ZIP no navegador
│  └─ style.css           Tema Memphis (claro, teal)
├─ data/
│  └─ seed.json           Dados reais (promotores/grupos/clientes) p/ semear o Mongo
├─ test/
│  ├─ smoke.js            Regressão end-to-end (~56 verificações)
│  ├─ pentest.js          Pentest do próprio app (38 verificações)
│  └─ carga.js            Teste de carga (até 5.000 usuários simultâneos)
├─ tools/
│  ├─ importar-planilhas.js  Gera o seed.json das planilhas .xlsx/.xlsm
│  ├─ criar-promotores.js    Cria contas em massa via CLI (o painel também importa por planilha)
│  └─ dev-preview.js         Sobe o servidor local sempre no banco de TESTE
├─ vercel.json / .vercelignore   Empacote serverless (Vercel)
├─ discloud.config               Config do host Node persistente (Discloud)
└─ .env                   Segredos (MONGODB_URI, CLOUDINARY_*, SESSION_SECRET, SMTP_*)
```

## Princípios de arquitetura

1. **Separação por camadas.** As rotas (`server.js`) não falam com o Mongo nem com o
   Cloudinary diretamente — sempre via `lib/db.js` e `lib/storage.js`. Isso permitiu
   trocar o backend (de arquivo JSON → MongoDB, de disco → Cloudinary) sem reescrever as rotas.

2. **Serverless-ready.** A aplicação não guarda estado obrigatório em memória:
   - Sessão → **JWT** (o token viaja no cookie, não na RAM do servidor).
   - Arquivos → **Cloudinary** (não há disco local).
   - Conexão Mongo **cacheada** entre invocações (`global.__mongoClientPromise`).
   - Os caches em memória (usuário, referência, config) são só **aceleradores efêmeros** —
     podem sumir a qualquer momento sem quebrar nada.

3. **O trabalho pesado fica fora do servidor.**
   - A foto vai do **navegador direto pro Cloudinary** (upload assinado) — o servidor só
     emite a assinatura e registra os metadados.
   - O **ZIP é montado no navegador** (JSZip): o servidor entrega um manifesto com URLs
     assinadas e recebe a confirmação depois. Sem timeout de função, sem RAM estourada.

4. **Aguenta rajada (~1.4k promotores).** Medido com `test/carga.js` (5.000 simultâneos):
   - **Portão de concorrência**: no máximo 300 requisições de API ao mesmo tempo;
     as demais esperam numa fila leve (até 8.000) e acima disso recebem **503** educado —
     degradar com aviso é melhor que derrubar o servidor pra todo mundo.
   - `/api/reference` (maior payload — o banco de promotores inteiro) é servida de um
     **buffer único pré-gzipado**, compartilhado por todas as respostas.
   - Cache de usuário no `requireAuth` (20s), cache + *single-flight* da referência/config,
     pool do Mongo em 100 conexões, `bcrypt` **assíncrono** no login (não trava o event loop).
   - Teto prático: o Atlas **M0 grátis** (~60 req/s sustentado) — ver [08 — Deploy](08-deploy.md).

## Ciclo de uma requisição autenticada

```mermaid
sequenceDiagram
  participant B as Navegador
  participant MW as Middlewares
  participant H as Handler da rota
  participant DB as lib/db.js
  B->>MW: GET /api/... (Cookie: mp_token)
  MW->>MW: portão de concorrência (vaga ou fila)
  MW->>MW: cookieParser lê o cookie
  MW->>MW: requireAuth verifica o JWT
  MW->>DB: findUserById(uid) (cache 20s)
  DB-->>MW: usuário (active?)
  alt token inválido / usuário inativo
    MW-->>B: 401
  else rota admin sem a permissão exigida
    MW-->>B: 403 (requirePerm)
  else ok
    MW->>H: req.user preenchido
    H->>DB: consulta/altera
    DB-->>H: dados
    H-->>B: 200 JSON
  end
```

Toda rota assíncrona é embrulhada por `ah()`, que captura erros e os encaminha
para um middleware de erro central (responde JSON, sem vazar stack trace).
