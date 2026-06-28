# Memphis PDV

Coleta de fotos de pesquisa de preço em ponto de venda. Promotores enviam fotos
com os dados do registro; a equipe revisa, avalia (ponto extra / validação),
baixa em ZIP organizado por região e exporta pra Excel no modelo das planilhas.

> 📚 **Documentação técnica completa** (arquitetura, modelo de dados, API, BPMN, UML,
> segurança, deploy) em [`docs/`](docs/README.md).

## Rodar

Precisa de um `.env` (não vai pro Git) com a conexão do MongoDB:

```
MONGODB_URI=mongodb+srv://usuario:senha@cluster.mongodb.net/?appName=...
MONGO_DB=memphis_pdv
SESSION_SECRET=algum-valor-aleatorio
```

```
npm install
npm start        ->  http://localhost:3000
```

No 1º boot ele conecta no Mongo, cria os índices e **semeia** admin +
promotores/grupos/clientes (de `data/seed.json`).

**Admin:** `admin@local` / `admin123`
**Promotor de teste:** `joao@local` / `joao123`

## O que o promotor envia (campos obrigatórios)

- Senha Mensal e Senha Semanal (texto)
- Nome Completo do Promotor — **checado contra o banco de 2.089 promotores**
  (avisa se não existe e sugere nomes parecidos)
- Nome do Cliente (texto, com autocomplete dos clientes conhecidos)
- Localização da Loja (cidade)
- Região (NE / CN / SP / SE / SUL)
- **Máximo 2 fotos por cliente** (comprimidas no navegador antes de subir)
- Data/hora: gravada automaticamente no envio

## O que a equipe (admin) faz

- **Busca** por nome/cliente/cidade, filtro por região, grupo e status
- **Avalia cada foto:** grupo, pré-avaliação (RUIM/REGULAR/BOM/EXCELENTE),
  pontos extra (Ilha de produtos, Display Exclusivo, Gôndola de caixa,
  Cross-merchandising, Antes e depois), **validar/recusar** e observação
- **ZIP** com pastas `Região / "REF - Cliente - Promotor"` (= COLAR EM PASTAS)
- **Exportar Excel** no modelo das planilhas (uma aba por região)
- Baixar marca como "baixada" (não apaga). "Limpar baixados" apaga de vez.

## Dados reais

`data/seed.json` tem promotores, grupos e clientes extraídos das suas planilhas.
Pra reimportar quando mudar o mês:

```
node tools/importar-planilhas.js   (ajuste os caminhos dos .xlsx/.xlsm no topo)
```

## Caminho pra produção (Vercel)

- **Banco → MongoDB** ✅ FEITO (`lib/db.js` + `lib/mongo.js`).
- **Fotos → Cloudinary** ✅ FEITO (`lib/storage.js`; entrega autenticada/assinada,
  ZIP puxa de lá). Precisa de `CLOUDINARY_*` no `.env`.
- **Empacotar pra Vercel** (Next.js) + **sessão → JWT** + upload direto browser→Cloudinary
  + ZIP no navegador (JSZip). ⬜ Passo C.
- **Segurança + deploy + piloto.** ⬜ Passo D.

## Estrutura

```
server.js               API + servidor (Express)
lib/db.js               dados + regras — MongoDB (async)
lib/mongo.js            conexão cacheada com o Mongo
lib/cities.js           lista de cidades
public/                 front (landing, login, promotor, admin) — HTML+JS puro
tools/importar-planilhas.js   extrai promotores/grupos/clientes das planilhas
data/seed.json          dados reais (seed do Mongo no 1º boot)
uploads/                fotos (local por enquanto → R2)
.env                    segredos (fora do Git)
```
