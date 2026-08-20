# 02 — Modelo de Dados (MongoDB)

Banco: **MongoDB Atlas**, base `memphis_pdv` (configurável via `MONGO_DB`).
Cada documento usa um campo **`id`** (UUID) como chave lógica — não o `_id` do Mongo —
para manter as URLs e o frontend estáveis.

## Diagrama Entidade-Relacionamento

```mermaid
erDiagram
  USERS ||--o{ SUBMISSIONS : "envia (uploadedBy)"
  USERS ||--o{ RETORNO : "recebe justificativa de recusa"
  USERS ||--o| CORRECOES : "pede correção do cadastro"
  USERS ||--o{ AUDITORIA : "gera evento sensível"
  SUBMISSIONS ||--o| RANKING : "vira registro de pódio"

  USERS {
    string id PK "UUID"
    string emailLower "indexado, único"
    string name
    string role "admin | promotor"
    string passwordHash "bcrypt"
    bool   active "false = banido"
    bool   pendingApproval "veio do cadastro público"
    bool   mustChangePassword
    array  permissions "só admin: fotos|aprovar|contas|listas|aderencia ou *"
    string telefone
    string grupo
    string regiao "NE|CN|SP|SE|SUL"
    string setor
    int    matricula "único quando presente"
    string aceiteVersao "versão da política aceita (ex: 2026-08)"
    string aceiteEm "ISO"
    string resetTokenHash "sha256 — reset (1h) ou convite (7 dias), uso único"
    string conviteEnviadoEm "permite retomar o envio em massa"
    string createdAt "ISO"
  }

  SUBMISSIONS {
    string id PK "UUID"
    array  imagens "1 ou 2 — esvaziado na anonimização"
    string uploadedBy FK "USERS.id — REMOVIDO aos 6 meses"
    string uploadedByEmail "removido aos 2 meses"
    string promotor "removido aos 2 meses"
    string promotorNorm "chave de join E de contagem distinta"
    string cliente
    string endereco "removido aos 2 meses (rastro de localização)"
    string searchBlob "nome + endereço — removido aos 2 meses"
    string regiao
    string grupo "digitado no envio (histórico)"
    string grupoOficial "CONGELADO antes de anonimizar"
    string dataExposicao "YYYY-MM-DD"
    string semanaKey "trava 1/semana"
    string mesKey "trava 4/mês"
    string senhaMensal "carimbada pelo servidor"
    string senhaSemanal "carimbada pelo servidor"
    string preAvaliacao "REGULAR|BOM|EXCELENTE"
    array  pontosExtra "validado contra a lista vigente"
    bool   validado "true|false|null"
    string motivoRecusa "obrigatório ao recusar"
    string observacao "removido aos 6 meses"
    bool   pago
    bool   baixado
    int    rankingPos "1|2|3 da edição"
    string anonimizadaEm "ISO — carimbo da retenção"
    string createdAt "ISO — RELÓGIO da retenção"
  }

  RETORNO {
    string submissionId
    string userId FK "USERS.id — indexado pelo USUÁRIO"
    string semanaKey
    string cliente
    string motivoRecusa
    string observacao
    string criadoEm "ISO"
  }

  RANKING {
    string mesKey "edição"
    string escopo "NACIONAL ou sigla da região"
    int    posicao "1|2|3 — único com mesKey+escopo"
    string submissionId
    string promotor "sobrevive à foto (quadro de honra)"
    string grupo
    string regiao
    string cliente
    string marcadoEm "ISO"
  }

  AUDITORIA {
    date   ts "índice TTL: 12 meses"
    string userId
    string userNome
    string userEmail
    string acao
    string alvo
    int    qtd
    string ip
    string detalhe
  }

  CORRECOES {
    string userId "1 pedido em aberto por pessoa"
    string userNome
    string grupoAtual
    string regiaoAtual
    string descricao "texto livre: só DESCREVE o erro"
    bool   resolvido
    string criadoEm "ISO"
  }

  PROMOTORES {
    string id PK "UUID"
    string nome
    string nomeNorm "indexado, único"
    string grupo "denominador do % de participação"
  }

  PENDENTES {
    string id PK "UUID"
    string tipo "promotor | grupo"
    string nome
    string nomeNorm "índice único composto com tipo"
    string criadoPor
    string criadoEm "ISO"
  }

  PRESENCA {
    string _id "id do admin"
    string nome
    string subId "foto aberta agora"
    date   ts "índice TTL: 2 minutos"
  }

  REFDATA {
    string _id "singleton | participantes | backups"
    array  grupos
    array  clientes
    array  pontosExtra
    array  motivosRecusa
  }

  CONFIG {
    string _id "singleton"
    string senhaMensal
    string senhaSemanal
    array  senhasProgMensal "tabela programada por data"
    array  senhasProgSemanal
    string crachaHash "sha256 do crachá de acesso total"
    string encarregadoEmail "LGPD — editável na aba Listas"
    string contatoTelefone
    string politicaVersao "muda = todo mundo aceita de novo"
    string razaoSocial "exige acesso total"
    string cnpj
    string enderecoMatriz
  }
```

## Coleções

### `users`
Contas de acesso (admins e promotores).
- `role`: `admin` (acessa o painel) ou `promotor` (só envia).
- `active`: `false` = **banido** (login e requisições bloqueados).
- `mustChangePassword`: senha **provisória** — o front força a troca no primeiro login
  (`trocar-senha.html`). Setada ao criar conta em massa, ao importar por planilha e
  quando o admin redefine a senha de alguém.
- `permissions` (só admin): lista granular — `fotos`, `aprovar`, `contas`, `listas`, `aderencia` —
  ou `['*']` (**acesso total**, obtido validando o crachá). Admin novo nasce **sem
  nenhuma** permissão, a menos que quem criou tenha acesso total.
- Perfil: `telefone` (só dígitos), `grupo`, `regiao`, `setor`, `matricula`
  (inteiro **único** entre as contas, ou `null`; **`0` também vale como "sem matrícula"** —
  promotor não tem — e vira `null`, sem travar duplicado).
- `aceiteVersao` / `aceiteEm`: **aceite da política de privacidade** — a versão aceita
  (ex.: `'2026-08'`) e quando. Guardar a *versão*, e não um booleano, é o que faz uma
  política nova pedir aceite de novo. Conta do cadastro público já nasce com o aceite;
  conta criada por importação nasce **sem**, e cai no portão do `requireAuth`.
- Senha guardada como **hash bcrypt** — nunca em texto. Tokens de redefinição também
  só como hash (`resetTokenHash`, expira em 1h, uso único).

### `submissions`
Cada **foto** enviada é um documento — e uma foto pode ter **1 ou 2 imagens**
(`imagens[]`; 2 = "antes e depois"), mas conta como **1** para os limites.
- `imagens[].storedFile` + `resourceType`: referência ao arquivo no Cloudinary
  (a foto não fica no Mongo). Registros antigos com `storedFile` único ainda são lidos
  (fallback em `server.js`). A retenção **esvazia** este array ao apagar as imagens.
- `promotor`, `regiao` e `grupo` são gravados **a partir da sessão** de quem envia, nunca do
  corpo da requisição — ver [07 — Segurança](07-seguranca.md), Bloco 2.
- `grupoOficial` e `anonimizadaEm`: campos da retenção — ver [09 — LGPD](09-lgpd.md).
- `semanaKey` / `mesKey`: chaves da **data de exposição**, usadas nas travas de
  **1 foto/semana** e **4 fotos/mês** por promotor. ⚠️ Foto **recusada não consome cota**
  (a contagem filtra `validado ≠ false`); **pendente conta**, senão daria para encher a fila
  enquanto ninguém avalia. Não confundir com o relógio da **retenção**, que é `createdAt`.
- Campos `*Norm` e `searchBlob`: versões normalizadas (minúsculo, sem acento) para
  busca e checagem rápidas.
- `senhaMensal` / `senhaSemanal`: **carimbadas pelo servidor** no momento do envio
  (vêm de `config`, não são digitadas pelo promotor — anti-fraude).
- Flags de avaliação (`preAvaliacao`, `pontosExtra`, `validado`, `pago`) são **independentes**
  entre si — ver ciclo de vida em [04 — Fluxos](04-fluxos-bpmn.md).

### `promotores`
Banco oficial de nomes da empresa (~2.050), cada um com o **grupo** a que pertence — é esse
grupo que serve de **denominador do "% de participação"** na aderência.
Índice único em `nomeNorm`. Desde o Bloco 2 a lista **não é mais servida ao promotor**: ele
não digita o próprio nome, então não precisa (nem deve) ver os dos colegas.

### `pendentes`
Nomes que aguardam **aprovação** da equipe, de dois tipos: `promotor` e `grupo`.
Ao aprovar, o nome migra para `promotores` ou `refdata.grupos` conforme o tipo.
> Desde o Bloco 2 essa fila **não nasce mais do envio do promotor** — o nome dele vem da
> sessão e o grupo, da conta. Continua como ferramenta da equipe (`POST /api/promotor-pendente`
> exige permissão `listas`).

### `refdata` (documento único `singleton`)
Listas editáveis: `grupos` e `clientes` (usadas em autocomplete e filtros).

### `config` (documento único `singleton`)
- `senhaMensal` / `senhaSemanal` **atuais**, definidas pela equipe — o "codinome" da
  campanha que o promotor vê na hora de enviar.
- `crachaHash`: sha256 do **crachá de acesso total** vigente. O código em si aparece
  uma única vez pra quem gerou; gerar um novo substitui o hash (invalida o anterior).
- **Dados institucionais da LGPD**, editáveis na aba Listas e servidos publicamente por
  `GET /api/contato` (a política precisa ser legível antes do login):
  `encarregadoEmail`, `contatoTelefone`, `politicaVersao` e `avisoTransicaoWhatsapp`
  (permissão `listas`); `razaoSocial`, `cnpj` e `enderecoMatriz` (**acesso total**).
  Ficam aqui, e não no `.env`, porque no Discloud mexer no `.env` exige painel + restart +
  acesso do dono — e o encarregado precisa ser trocável por quem assumir depois.
  Campo ausente cai num padrão embutido, então o sistema nunca fica sem contato.

### `auditoria`
Registro de **acesso a dado pessoal** (LGPD, Art. 37). Guarda **só evento sensível** —
auditar toda requisição viraria o gargalo do Atlas M0 e afogaria o que importa em ruído.
- Campos: `ts` (Date), `userId`, `userNome`, `userEmail`, `acao`, `alvo`, `qtd`, `ip`, `detalhe`.
- Ações registradas: baixou ZIP, exportou Excel, excluiu foto, purgou lote, criou/editou/
  baniu/reativou/excluiu conta, trocou senha de terceiro, importou contas, importou listas,
  gerou crachá, usou crachá.
- **Índice TTL de 12 meses** — some sozinha. Aqui o TTL *serve*, ao contrário da retenção de
  fotos: apagar um registro de auditoria não deixa arquivo órfão no Cloudinary, é só texto.
- Leitura em `GET /api/admin/auditoria`, restrita a **acesso total** — é a trilha de quem
  acessou o quê; abri-la a qualquer admin daria a cada um o rastro de todos os outros.
- Gravar **nunca derruba a operação**: se o Mongo falhar no registro, a foto ainda é baixada.
  O motivo de existir: `baixado = true` diz que a foto saiu, mas não diz **quem** a levou —
  que é exatamente a pergunta de uma auditoria.

### `retorno`
Justificativa da recusa, **separada da submissão** e indexada pelo **usuário**.
- Campos: `submissionId`, `userId`, `semanaKey`, `mesKey`, `dataExposicao`, `cliente`,
  `motivoRecusa`, `observacao`, `criadoEm`.
- Existe porque **anonimizar e "mostrar o motivo para sempre" querem coisas opostas do
  mesmo documento**: a submissão precisa perder o vínculo aos 2 meses, e o promotor precisa
  seguir vendo por que a foto dele foi recusada. Tirando o retorno de dentro da submissão,
  os dois prazos convivem.
- Prazo: **enquanto a conta existir** — não é arbitrário, é o critério do Art. 15 (a
  finalidade dura enquanto dura a relação). Some junto com o titular no fluxo do 1.6.
- Peso: ~15 recusas/ano × 1.400 promotores ≈ 21 mil documentos de ~100 bytes = **~2 MB/ano**.

### `ranking`
Registro do pódio — **gravado no momento em que o admin marca o vencedor**, não na hora de
apagar a foto.
- Campos: `mesKey`, `escopo` (`NACIONAL` ou a região), `posicao`, `submissionId`,
  `promotor`, `grupo`, `regiao`, `cliente`, `marcadoEm`. Único por `mesKey+escopo+posicao`.
- **Ordem obrigatória:** tem que estar gravando **antes** da primeira exclusão. Invertido,
  os vencedores passados somem e não há como reconstruir.
- Com ele, a foto do vencedor deixa de ser exceção da retenção — a régua fica **uma só**
  ("2 meses, sempre"), mais fácil de declarar na política e de auditar. `listRanking` marca
  `temFoto` para a página escolher entre pódio com imagem e quadro de honra em texto.
- ⚠️ O **nome do vencedor fica indefinidamente** e é dado pessoal, visível a todos os
  logados. É legítimo (premiação divulgada é finalidade própria) e **está declarado na
  política** — mas não pode ser varrido junto com a anonimização por engano.

### Campos de retenção em `submissions`
- `anonimizadaEm`: carimbo de quando o documento foi anonimizado (e `imagens` esvaziado).
- `grupoOficial`: grupo do banco de promotores **congelado antes** de limpar `promotorNorm`.
  Sem ele, o `$lookup` da aderência morre junto com a chave e a participação por grupo
  **zera em silêncio** — com números que parecem reais.
- `refdata._id: 'participantes'`: contador de **participantes distintos por mês × grupo**,
  gravado na anonimização. Contar "quantas pessoas participaram" exige identidade, e nenhum
  campo residual substitui isso.

## Índices (criados em `db.init()`)

| Coleção | Índice | Tipo |
|---------|--------|------|
| `users` | `emailLower` | único |
| `promotores` | `nomeNorm` | único |
| `pendentes` | `tipo + nomeNorm` | único composto |
| `submissions` | `id` | único |
| `submissions` | `regiao` | simples |
| `submissions` | `baixado` | simples |
| `submissions` | `searchBlob` | simples |
| `submissions` | `createdAt` | descendente |
| `auditoria` | `ts` | **TTL 12 meses** |
| `auditoria` | `ts` desc / `userId` | consulta da tela |
| `retorno` | `userId + criadoEm` desc | histórico do promotor |
| `retorno` | `submissionId` | upsert na reavaliação |
| `ranking` | `mesKey + escopo + posicao` | **único** |

## Seed inicial

No primeiro boot (`db.init()`), se as coleções estiverem vazias:
- cria o primeiro admin com `permissions: ['*']`: e-mail de `ADMIN_EMAIL` (padrão
  `admin@local`) e senha de `ADMIN_SENHA` — sem a env, a senha é **sorteada**, aparece
  uma única vez no log e a troca é obrigatória no 1º login (nada de senha fixa no código);
- semeia `promotores`, `refdata.grupos` e `refdata.clientes` a partir de `data/seed.json`;
- cria `config` com senhas padrão;
- migra dados antigos (pendentes sem `tipo` viram `promotor`).

`data/seed.json` é gerado por `tools/importar-planilhas.js` a partir das planilhas
internas (`Registro de clientes…`, `Cadastro Promotores…`). Contas de promotor em massa
podem ser criadas pelo painel (**Criar por planilha**) ou por `tools/criar-promotores.js`.
