# Plano de ação — LGPD, documentação e tipagem

> Documento de trabalho, não documentação permanente. Nasceu da auditoria de
> **05/ago/2026** (organização de dados · LGPD · UML/BPMN) e morre quando os
> blocos forem concluídos e absorvidos pelos docs `01`–`09`.
>
> Estado (30/ago/2026): **Blocos 0, 1, 2, 3, a fase 1 do 4 e o Bloco 5 executados.**
> Falta só o **Bloco 4 fases 2–3** (converter para `.ts`), parado por decisão do próprio
> plano: só depois do piloto estável.
>
> A pergunta de escopo que a seção do Bloco 5 marca com ⚠️ foi **respondida pelo dono em
> 30/ago/2026: "sim, todos"**. A estética de vidro foi estendida às **14 páginas**.

---

## ⚠️ Leia primeiro — instruções para quem for executar

**Este documento é autossuficiente.** Foi escrito para que uma sessão nova, sem
nenhum histórico de conversa, consiga executar tudo. Se você é essa sessão:

1. **Leia o documento inteiro antes de tocar em código.** As decisões têm
   dependências cruzadas — várias seções corrigem premissas de seções anteriores,
   e executar uma sem conhecer a outra quebra coisa em silêncio.
2. **Confirme o estado do código antes de agir.** As citações `arquivo:linha` valem
   para o commit `40fa27b` (ago/2026). Abra o arquivo e confirme antes de editar.
3. **Não pule as caixas ⚠️.** Cada uma marca uma armadilha que já custou uma
   correção de rumo no planejamento. Elas não são enfeite.
4. **Respeite as "Ordens obrigatórias".** Três rotinas precisam gravar dado novo
   *antes* de a primeira exclusão rodar. Invertendo a ordem, o dado se perde sem
   possibilidade de reconstrução.
5. **Leia a seção "❓ Não esqueça de confirmar com o usuário"** antes de começar.
   Nada ali trava o início, mas cada item tem um momento em que deixa de ser
   opcional — e cinco são **checkpoints de parar e mostrar**, não perguntas soltas.

### Contexto que você não tem

- **Projeto:** Memphis PDV — plataforma interna de coleta e avaliação de fotos de
  Ponto de Venda. ~1.400 promotores enviam fotos pelo celular; a equipe avalia,
  baixa em ZIP e exporta Excel. Node + Express + MongoDB Atlas (M0 grátis) +
  Cloudinary. Front HTML/JS puro sem build. Host: Discloud.
- **Situação:** em beta, **pré-lançamento**. O banco de produção só tem foto de
  teste e **será zerado e recriado** antes do go-live. Nenhuma rotina nova corre
  risco de apagar dado real na primeira execução.
- **Origem deste plano:** auditoria de 05/ago/2026 que examinou três perguntas —
  (a) os dados estão bem organizados e são econômicos em espaço? (b) há proteção
  de LGPD? (c) tudo está documentado com UML e BPMN?
- **Os veredictos foram:** organização de dados **boa** (índices corretos,
  paginação, fotos fora do Mongo); LGPD **inexistente** (zero ocorrências de
  "LGPD", "privacidade" ou "consentimento" no código); documentação **boa mas
  defasada** (13 de 53 endpoints sem doc, e o "BPMN" atual é flowchart Mermaid,
  não BPMN 2.0).

### Ambiente de teste — regras que quebram tudo se ignoradas

```bash
node tools/dev-preview.js
```

Sobe o servidor **no banco de teste** na porta 3000 (nunca no de produção).

```bash
node test/smoke.js
```

~56 verificações ponta a ponta. **Exige banco de teste LIMPO e servidor
RECÉM-REINICIADO** — o smoke deixa a senha do `joao@local` trocada no fim, e as
falhas de login propositais estouram o rate-limit em rodadas repetidas.

```bash
node test/pentest.js
```

38 verificações de segurança. **Rodar sempre com banco limpo entre ele e o smoke**
— o pentest depende da senha que o smoke altera.

### Versionamento

Branch **`reformulacao-lgpd`**, commit ao fim de cada bloco. A `main` **não recebe
nada** até o dono do projeto revisar e aprovar tudo. O merge é decisão dele.

---

## Sumário executivo

Cinco blocos, na ordem em que eu executaria:

| # | Bloco | Por quê | Bloqueia go-live? |
|---|-------|---------|-------------------|
| 0 | Segredos e admin padrão | Dívida já conhecida, custa minutos | **Sim** |
| 1 | LGPD | Único risco jurídico real | **Sim** |
| 2 | Minimização técnica de exposição | Fecha as duas brechas concretas de vazamento | **Sim** |
| 3 | Documentação (`.bpmn` + Mermaid) | 13 endpoints e 5 recursos sem doc | Não |
| 4 | Tipagem (JSDoc → TS seletivo) | Manutenibilidade | Não |

Blocos 0–2 são o caminho crítico. 3 e 4 podem rodar depois do piloto sem prejuízo.

**Regra que vale para todos os blocos:** cada bloco só fecha com `test/smoke.js`
verde em banco limpo e servidor recém-reiniciado.

### Execução — versionamento

Branch **`reformulacao-lgpd`**, com commit ao fim de cada bloco. A `main` **não
recebe nada** até você revisar e aprovar tudo — nenhum código meio-pronto encosta
em produção, e existe ponto de retorno a cada etapa.

O merge na `main` é decisão sua, no fim, depois da revisão completa.

---

## Dados recebidos (05/ago/2026)

| Item | Valor |
|------|-------|
| Razão social | **Memphis S.A. Industrial** |
| CNPJ (matriz) | **92.697.010/0001-46** |
| Encarregado (DPO) + suporte | **inteligencia.mecado@gmail.com** — grafia **correta e proposital** (`mercado` já estava tomado no Gmail). Não "corrigir" |
| Endereço da matriz | **Av. João Elustondo Filho, 175** |
| Uso das fotos | **Somente interno.** Nenhuma foto vai para marketing ou redes sociais |
| Fonte da verdade do grupo | **`promotores.grupo`** (não `users.grupo`) |
| Cota semanal | Foto **recusada não consome** — é como se não tivesse enviado |
| ~~Encarregado antigo~~ | **arthurfo@memphisbr.com** — provisório; a ideia é pedir um `pdv@memphisbr.com` depois. É por isso que o campo é configurável (1.0) |
| Telefone de contato | **+55 51 99732-2193** — número novo destinado pela T.I. (ago/2026), substitui tanto o placeholder `(51) 00 00000 0000` quanto o `99893-6997` informado antes |
| **Retenção da imagem** | **2 meses** após o envio (`createdAt` — ver a correção de relógio em 1.5) |
| **Retenção do registro identificado** | **6 meses** *(sugestão a confirmar)* — janela de retorno ao promotor (1.5.2) |
| **Retenção do registro anonimizado** | Indefinida — só o agregável, alimenta os gráficos |
| Retenção do log de auditoria | **12 meses** ✅ |

Racional da retenção, registrado porque a política precisa justificá-la: o site
existe para **substituir o WhatsApp** como canal de envio, não para ser arquivo.
A equipe baixa o lote para o servidor interno — é lá que a foto vive a longo prazo.
Prazo curto é, aqui, uma vantagem de conformidade: menos dado parado, menos
superfície de vazamento.

A distinção entre os dois prazos é deliberada e legítima: **nenhuma lei fixa
prazo** (a LGPD manda eliminar quando a finalidade se esgota — o prazo é escolha do
controlador), então a imagem morre aos 2 meses e o registro sobrevive sem
identidade, alimentando os gráficos. Detalhes e armadilhas em 1.5.

> ⚠️ **Confirmar o telefone (5 segundos).** Foi informado como `9732-2193`, que tem
> **8 dígitos** — celular no DDD 51 tem 9. Assumi o `9` inicial (`99732-2193`),
> exatamente a correção que o número anterior precisou. Como ele vai impresso na
> política de privacidade, vale conferir antes de publicar.

> ℹ️ **O e-mail é `mecado`, sem o `r`, e isso é proposital** — `inteligencia.mercado@
> gmail.com` já estava tomado. Não tratar como erro de digitação nem "corrigir"
> ao escrever a política.

Revisão da política: será apresentada ao **setor de T.I.**, que aciona um
especialista para revisar; se necessário, formalização pelo **RH**. O que eu
entrego é **minuta**, não texto final publicável.

**Base de produção hoje:** só foto de teste. O banco será **zerado e recriado**
antes do lançamento (o projeto está em beta), então nenhuma rotina nova corre risco
de apagar dado real na primeira execução.

### 🔄 Atualização de ago/2026 — o lançamento é gradual

A T.I. definiu que **o WhatsApp e o site vão coexistir por pelo menos 4 meses**
antes da substituição total. Isso muda o plano para melhor em três frentes, e cria
uma armadilha de leitura de dados.

**O que fica mais fácil:**

| Frente | Antes | Agora |
|---|---|---|
| Convite por e-mail (1.7.2) | ~1.400 disparos de uma vez, precisando de fila e serviço transacional | **Onda por onda.** A fila continua sendo boa ideia, mas deixa de ser bloqueio — dá para começar com dezenas |
| Retenção (1.5) | Risco de a 1ª rodada surpreender | A 1ª exclusão real só acontece ~2 meses depois das primeiras fotos reais. Sobra tempo para o modo só-relatório |
| Risco geral | Big bang | Piloto real com volta rápida. Erro afeta poucos, não 1.400 |

**⚠️ A armadilha: a aderência vai parecer péssima, e não é.**

Durante a coexistência, parte dos promotores continua mandando foto pelo WhatsApp —
e essas fotos **não existem no banco**. Os números de aderência (participação por
grupo, % do roster) vão mostrar adesão baixa porque metade do canal está fora do
sistema, não porque as pessoas pararam de participar.

Se ninguém avisar, a equipe lê "grupo X não está participando" quando a verdade é
"grupo X ainda está no WhatsApp". Decisão errada sobre gente que está trabalhando.

**Mitigação:** um aviso fixo na aba Aderência enquanto durar a transição — *"⚠️
Período de transição: promotores que ainda enviam pelo WhatsApp não aparecem nestes
números"* — controlado por um campo no `config` que a equipe desliga quando o
WhatsApp sair de cena. É barato e evita interpretação errada de dado.

### Assumido por default (executar assim; mudar só se o dono disser o contrário)

Estas ficaram em aberto e foram fechadas com o default recomendado, para não travar
a execução. **Todas são reversíveis** — nenhuma exige migração cara para desfazer.

| # | Questão | Default adotado | Por quê |
|---|---|---|---|
| D1 | Campos institucionais no `.env` ou no `config`? | **`config`**, com permissão graduada: contatos exigem `listas`, razão social e CNPJ exigem **acesso total** | No Discloud, mudar `.env` exige painel + restart + acesso do dono. O e-mail do encarregado precisa ser trocável por quem ficar depois. E `.env` é o arquivo dos segredos — CNPJ é registro público |
| D2 | `cliente` vira código na anonimização? | **Mantém o nome** (opção (a)), com o risco residual declarado no `09-lgpd.md` | Nome de estabelecimento é identificador comercial público (está na fachada), e o registro anonimizado já não tem o promotor. Trocar por código depois é migração simples, se o especialista da T.I. pedir |
| D3 | Convite por e-mail é caminho único? | **Não — dois caminhos.** Convite por e-mail como principal; senha provisória **aleatória** (nunca derivada de dado pessoal) como exceção para quem não tem e-mail | O dono **não tem acesso** à base do Valoo para medir a cobertura de e-mail. Suportar os dois casos é mais barato que descobrir na véspera do lançamento que 300 pessoas não têm e-mail |

### Ainda falta — mãos do dono, não do executor

| Item | Onde entra | Observação |
|------|-----------|------------|
| Rotacionar credenciais (Mongo, Cloudinary) | Bloco 0 | Só o dono tem acesso aos painéis |
| Configurar SMTP | Bloco 1.7.2 | **Pré-requisito**, não extra — o convite por e-mail depende dele. Para ~1.400 disparos, usar serviço transacional (Brevo/Resend), não Gmail comum |
| Verificar contrato Valoo ↔ Memphis | Bloco 1.7.1 | Cobre o repasse de dados. Não trava código; é o primeiro item que a revisão da T.I. vai levantar |
| Revisão da política pela T.I. / especialista | Bloco 1.1 | O que este plano produz é **minuta**, não texto final publicável |

---

## ❓ Não esqueça de confirmar com o usuário

Lista para quem for executar. **Nenhuma delas trava o início** — o Bloco 0 e o
primeiro `.bpmn` andam sem resposta nenhuma. Mas cada uma tem um momento em que
deixa de ser opcional, marcado na coluna "Quando".

### A. Fatos que faltam para escrever a política

| # | Pergunta | Quando |
|---|---|---|
| ~~A1~~ | ✅ **Resolvida:** endereço da matriz — **Av. João Elustondo Filho, 175** | — |
| ~~A2~~ | ✅ **Resolvida:** suporte e encarregado usam **o mesmo e-mail** | — |
| ~~A3~~ | ✅ **Resolvida:** `MOTIVOS_RECUSA` passou a ser os **14 motivos do capítulo 10 do Manual de Execução de PDV** (D1–D14), na ordem do manual, mais o escape "Outros". A lista do manual é fechada; "Outros" ficou por decisão da coordenação, pra ninguém travar no meio de um lote | — |
| A4 | **Serviço transacional de e-mail** — em aberto, o dono não decidiu. Tratar via o telefone de contato quando chegar a hora do 1.7.2 | Antes do disparo em massa |
| ~~A5~~ | ✅ **Resolvida:** `inteligencia.mecado@gmail.com` (sem o `r` de propósito) | — |
| ~~A6~~ | ✅ **Resolvida:** foto recusada **NÃO** consome cota — na prática é como se não tivesse enviado nada. Ver 1.5.2 | — |
| ~~A7~~ | ✅ **Resolvida:** **nenhuma foto é usada em marketing.** Finalidade restrita a uso interno da campanha | — |
| ~~A8~~ | ✅ **Resolvida:** não há promotor menor de 18. Nenhum tratamento do Art. 14 é necessário | — |
| A9 | O Bloco 5 para na capa, ou `login.html` e `promotor.html` acompanham? | Antes do Bloco 5 |
| ~~A10~~ | ✅ **Resolvida:** pódio com **nome completo**, visível a todos os logados. Única exceção consciente a "ninguém vê o nome de ninguém" | — |
| ~~A11~~ | ✅ **Resolvida:** ranking **regional E nacional** coexistem — 6 pódios por edição | — |
| ~~A12~~ | ✅ **Resolvida:** o normal é cada um enviar a própria foto; exceções são avisadas à equipe. Não precisa de rota especial — mas o admin precisa poder **corrigir a autoria** (ver 2.5, efeito colateral 3) | — |
| ~~A13~~ | ✅ **Resolvida:** a fonte da verdade do grupo é **`promotores.grupo`** | — |
| ~~A14~~ | ✅ **Resolvida:** o pódio nacional é **marcado à mão** pelo admin, igual aos regionais | — |

### B. Números que eu escolhi sozinho — confirmar em bloco

Todos são palpite calibrado, não exigência técnica. Barato de mudar **antes** de
implementar, chato depois.

| # | Número | Onde | Se mudar, o que muda |
|---|---|---|---|
| B1 | Escalonamento em **30 / 45 / 53 dias** | 1.5.1 | Ritmo do alerta. Precisa casar com a rotina real da equipe (se o lote é semanal ou mensal) |
| B2 | Token de convite: **7 dias** | 1.7.2 | Janela para a pessoa abrir o e-mail e criar a senha |
| B3 | Senha provisória expira em **30 dias** | 1.7.2 | Depois disso, só por link de redefinição |
| B4 | URL do Cloudinary: **1 hora** | 2.2 | Curto demais quebra ZIP de lote grande; longo demais aumenta a janela de um link vazado |
| B5 | Backup guardado **5 meses** | 1.8.2 | Foi você quem pediu 5 — confirmando que continua valendo |
| B6 | Auditoria guardada **12 meses** | 1.4 | Já confirmado, mas revisitar se o volume incomodar |

### C. Decisões assumidas por default — validar, não perguntar do zero

As três estão fechadas e implementáveis (ver "Assumido por default" acima).
Confirme com o usuário **antes de codar cada uma**, porque desfazer depois custa
mais que decidir agora:

| # | Assumido | Reverter custa |
|---|---|---|
| C1 | **D1** — institucionais no `config`, não no `.env` | Barato (mover 5 campos) |
| C2 | **D2** — `cliente` mantém o nome na anonimização | Médio (migração dos registros já anonimizados) |
| C3 | **D3** — convite por e-mail + provisória como exceção | Barato (o caminho 2 já existe) |

### D. Checkpoints — parar e mostrar antes de seguir

| # | Momento | Por quê |
|---|---|---|
| D1 | Depois do **primeiro `.bpmn`**, antes dos outros cinco | Se o layout automático ficar ruim, muda a abordagem — melhor descobrir no arquivo 1 que no 6 |
| D2 | Minuta da política pronta, antes de linkar no site | Vai para revisão da T.I. / especialista. **Não publicar sem isso** |
| D3 | Retenção pronta, antes de ligar a exclusão real | Rodar em **modo só-relatório** por uma semana e o usuário confere a lista |
| D4 | Botão de reset pronto, antes de expor no painel | É a ação mais destrutiva do sistema — o usuário testa em banco de teste primeiro |
| D5 | Fim de tudo, antes do merge na `main` | O merge é decisão dele, não do executor |

### Decidido

- **Aceite LGPD:** o banco será zerado; toda conta nasce depois da política. Mas o
  portão no `requireAuth` **continua necessário** — ver 1.2.
- **Foto nunca baixada expira junto, aos 2 meses** (Regra B, 1.5) — régua por
  idade, não por status.
- **Escalonamento visual a partir de 30 dias** (1.5.1) — foto não avaliada ou não
  baixada fica impossível de ignorar antes de expirar.
- **O relógio da retenção é `createdAt`, não `dataExposicao`** (1.5).
- **Motivo obrigatório ao recusar** (1.5.2).
- **Vencedor de ranking:** a foto **não** fica para sempre; o registro do pódio
  (edição + nomes) fica (1.5.3).
- **Retenção do log de auditoria: 12 meses.**
- **Aviso de foto parada é para a equipe, não para o promotor** — a ideia do lado
  do promotor está descartada.
- **Retorno da recusa: para sempre**, na forma "enquanto a conta existir", numa
  coleção `retorno` separada da submissão (1.5.2).
- **Senha inicial por convite de e-mail**, não derivada de CPF (1.7.2).
- **CPF/CNPJ não é coletado** (1.7.3) — nem do Valoo, nem na planilha. Vale o
  princípio: campo necessário entra sob base contratual; campo "opcional" exigiria
  consentimento revogável e dá mais trabalho, não menos.
- **Página de ranking será consertada** para degradar em quadro de honra (1.5.3).
- **Branch `reformulacao-lgpd`**, com a `main` intocada até a aprovação final.

---

## Bloco 0 — Higiene de segurança

Rápido, e é pré-requisito de tudo. Nada aqui é novidade: já estava no backlog.

1. **Rotacionar os segredos vazados** — senha do Mongo Atlas e `CLOUDINARY_API_SECRET`
   (ambos foram colados em chat). Gerar novos nos painéis, atualizar o `.env` local e
   as variáveis de ambiente do Discloud. *(suas mãos)*
2. **Trocar o admin padrão** — hoje `db.init()` semeia `admin@local` / `admin123`
   com `permissions: ['*']`. Trocar a senha pelo painel e, no código, fazer o seed
   ler `ADMIN_EMAIL` / `ADMIN_PASSWORD` do ambiente em vez de valores fixos.
3. **Abortar o boot em produção se `SESSION_SECRET` for o fallback.** Hoje
   [server.js:20](../server.js:20) cai silenciosamente em `'dev-secret-troque'` —
   se a env var não subir no Discloud, o app roda com segredo público e qualquer
   pessoa forja um cookie de admin. Uma linha: se `isProd` e o segredo for o fallback,
   `throw` no boot.
4. **Whitelist de `pontosExtra`.** `updateSubmission` ([lib/db.js:785](../lib/db.js:785))
   aceita o array como veio do cliente. Validar contra a lista vigente da `refdata`.
   É pequeno e entra bem aqui.

**Fecha com:** `node test/pentest.js` e `node test/smoke.js` verdes.

---

## Bloco 1 — LGPD

### 1.0 Contatos configuráveis (não hardcoded)

Você pediu, e está certo: e-mail do encarregado e telefone de contato **não podem
ficar cravados no HTML**. Dois campos novos no `config` (o singleton que já guarda
as senhas da campanha), editáveis na aba Listas (permissão `listas`):
`encarregadoEmail` e `contatoTelefone` — mais `politicaVersao`, que o Bloco 1.2 usa.

Consumidores: a política de privacidade e o aviso de equívoco do `promotor.html`
(onde hoje mora o placeholder `(51) 00 00000 0000`).

Como a política precisa ser legível **antes do login**, entra um endpoint público
`GET /api/contato` devolvendo só esses três campos — mesmo padrão do
`/api/signup-info`, que já é público. O contato do encarregado é de divulgação
obrigatória (Art. 41 §1º), então ser público é o comportamento correto, não um
vazamento.

> **Recomendação sobre o endereço:** um alias institucional
> (`privacidade@memphisbr.com`) que encaminhe para você é melhor que o pessoal.
> Não pelo cargo — a LGPD não exige senioridade nenhuma do encarregado — mas
> porque esse endereço vai impresso numa política pública e é para onde a ANPD e os
> titulares escrevem. No dia em que o estágio acabar, o alias sobrevive e o
> `arthurfo@` vira caixa morta com pedido de titular dentro. O campo configurável
> resolve o caso de ter que trocar; o alias evita ter que lembrar de trocar.

### 1.1 Política de privacidade

Página estática `public/politica-de-privacidade.html`, servida na raiz (vale para o
hub inteiro, não só o módulo PDV), linkada no rodapé do `index.html`, do `login.html`
e do `cadastro.html`.

Precisa cobrir, minimamente:

- **Controlador:** Memphis S.A. Industrial, CNPJ 92.697.010/0001-46.
- **Dados tratados:** nome, e-mail, telefone, matrícula, região/setor, grupo; e as
  fotos com endereço da loja + data da exposição — que juntos formam **rastro de
  localização**, e por isso merecem menção explícita.
- **Finalidade:** operar a campanha de PDV (coleta, avaliação, pagamento, ranking).
> ✅ **Confirmação da T.I. (ago/2026):** quem assina o contrato tem ciência de que a
> Memphis pode pedir dados, e a empresa se compromete a não expor os promotores.
> Isso **reforça a base legal escolhida** (execução de contrato) — a coleta está
> prevista na relação, não depende de consentimento avulso.
>
> Dois desdobramentos, sem lecionar: (1) ciência da coleta **não substitui** o dever
> de informar do Art. 9º — finalidade, retenção, com quem é compartilhado
> (Atlas/Cloudinary/SMTP, todos fora do Brasil) e direitos do titular continuam
> tendo que estar escritos em algum lugar acessível, que é o papel desta página;
> (2) o compromisso de "não expor" hoje é **só uma promessa** — quem a torna
> verdadeira no código é o **Bloco 2**, que impede um promotor de baixar os 2.050
> nomes numa requisição e faz as URLs de foto expirarem.

- **Base legal: execução de contrato / legítimo interesse — *não* consentimento.**
  Isso é deliberado: o promotor não pode recusar e seguir na campanha, então um
  "consentimento" ali seria inválido por não ser livre. Declarar a base errada é
  pior que não declarar.
- **Compartilhamento e transferência internacional (Art. 33):** MongoDB Atlas,
  Cloudinary e o provedor de SMTP, todos com servidores fora do Brasil.
- **Retenção: 2 meses após o envio** para a imagem; o registro sobrevive
  anonimizado. Exceção: fotos vencedoras de ranking (declarar, senão a política
  mente).
- **Direitos do titular (Art. 18)** e como exercê-los (o canal do 1.6), com o
  contato vindo do `config` (1.0), não escrito na página.
- **Cookies:** só o `mp_token`, `httpOnly`, estritamente necessário para autenticar.
  Cookie essencial **não exige banner de consentimento** — exige aviso. Ou seja:
  não vamos colocar aquele pop-up de cookie, e isso está correto.

### 1.1.1 ❌ Termos de Uso — DESCARTADO

**Decisão da T.I. (ago/2026): não fazer.** Os termos já estão no **contrato dos
promotores**, e a empresa não quer um segundo documento no site que possa
conflitar com ele. Era exatamente o risco apontado quando esta seção foi escrita —
a resposta veio confirmando a preocupação.

Não criar `public/termos-de-uso.html`. As 12 perguntas de matéria-prima que estavam
aqui foram descartadas junto.

> ⚠️ **Não confundir: a política de privacidade CONTINUA necessária.** São
> documentos de natureza diferente. Os termos são contratuais e podem viver no
> contrato; a política de privacidade é **obrigação legal do controlador** de
> informar o titular (Arts. 9º e 41), tem que ser acessível publicamente — inclusive
> a quem ainda não é usuário — e não é substituível por cláusula contratual.
> Se alguém na T.I. disser que "está tudo no contrato", vale confirmar
> explicitamente que essa dispensa **não** inclui a política.

**O que sobreviveu ao descarte** (não são questões contratuais, são de produto ou
de privacidade, e continuam abertas):

- **Foto recusada consome a cota da semana** — ver o achado logo abaixo. Continua
  precisando de decisão, independente de contrato.
- **Para quê a Memphis pode usar a foto** (só interno, ou também marketing e redes?)
  — isso descreve a **finalidade** do tratamento e precisa constar na política
  de privacidade, mesmo que a licença de uso esteja no contrato.
- **Existe promotor menor de 18 anos?** — se houver, o Art. 14 exige tratamento
  específico. É questão de LGPD, não de termos.

#### ✅ DECIDIDO: foto recusada não consome cota

Palavras do dono: *"na prática, é como se ele não tivesse mandado foto nenhuma"*.

**Implementação:** filtrar `validado: { $ne: false }` em `contarNaSemana` e
`contarNoMes` ([lib/db.js:692](../lib/db.js:692)). Foto **pendente** continua
contando — senão daria para encher a fila enquanto ninguém avalia.

⚠️ **Efeito colateral bom, mas que a equipe precisa saber:** recusar passa a
**devolver a vaga na hora**. Se a equipe recusa em lote no fim do mês, todo mundo
recupera cota de uma vez e pode reenviar. Combina com o escalonamento do 1.5.1 —
avaliar cedo deixa de ser só organização e vira o que dá ao promotor tempo de
corrigir.

#### 🔎 O achado que originou a decisão

`contarSemana` e `contarMes` ([lib/db.js:692](../lib/db.js:692)) contam **todas** as
submissões do promotor no período — sem filtrar por `validado`:

```js
return c.submissions.countDocuments({ promotorNorm: norm(promotor), semanaKey });
```

Ou seja: **foto recusada consome a cota.** Se a exposição do promotor é recusada na
segunda-feira, ele não pode reenviar corrigida naquela semana — a vaga já foi.

Isso é decisão de produto, não bug, e pode ser exatamente o que a Memphis quer
(evita spam de tentativas). Mas é forte candidato a ser fonte da cobrança que o
usuário relatou, e agora que o motivo da recusa fica visível, a pessoa vai ler
"faltou identificação da marca", saber como consertar, e **não poder**.

**Precisa de decisão explícita**, e ela vai para os termos de qualquer forma:
- **(a)** mantém como está — a cota conta tentativas, e os termos dizem isso com todas as letras;
- **(b)** foto recusada libera a vaga — filtrar `validado: { $ne: false }` na contagem;
- **(c)** libera só se a recusa acontecer dentro da mesma semana.

### 1.2 Aceite registrado

Checkbox no `cadastro.html` com link para a política. O ponto crítico é o servidor:
o aceite se valida em `POST /api/signup`, nunca só no front, e grava no usuário
`aceiteVersao` (ex.: `'2026-08'`) + `aceiteEm` (ISO).

**Zerar o banco resolve a migração, mas não dispensa o portão.** Como o beta será
apagado e recriado, não existe conta legada para "aceitar retroativamente" — o que
é bom, porque aceitar em nome de alguém não valeria mesmo.

Só que as contas novas **também não passam pelo cadastro público**: elas nascem da
importação dos dados do Valoo (1.7). Quem é criado por importação entra direto pelo
login com senha provisória e nunca veria a tela de aceite. O portão continua
necessário — só deixa de precisar de estratégia de migração.

Implementação, reaproveitando mecânica que já existe: o `requireAuth` já sabe barrar
usuário com pendência (`mustChangePassword`, com a lista de rotas livres em
[server.js:114](../server.js:114)). Mesmo padrão para `aceiteVersao` ausente ou
desatualizada → 403 com `precisaAceitar: true`, front leva para a tela de aceite.
Encaixa naturalmente na tela de primeiro acesso, junto com a criação da senha
definitiva. E resolve de graça o dia em que a política mudar de versão.

### 1.3 Aviso de coleta no envio

Texto curto no `promotor.html`, perto do seletor de foto — não um parágrafo jurídico:
quem vai ver a foto, por quanto tempo ela fica, e uma orientação prática de
**não enquadrar pessoas** (clientes e funcionários da loja não são partes desta
campanha; foto de rosto de terceiro é dado pessoal que ninguém consentiu).

### 1.4 Registro de acesso a dado pessoal (Art. 37)

Coleção nova `auditoria`, com índice TTL para se limpar sozinha (mesmo truque da
`presenca`, só que com prazo longo).

Grava **apenas eventos sensíveis** — não toda requisição, senão vira o gargalo do
Atlas M0:

| Evento | Onde |
|---|---|
| Baixou ZIP (ids + quantidade) | `/api/admin/mark-downloaded` |
| Exportou Excel | `/api/admin/export.xlsx` |
| Excluiu foto / purgou lote | `DELETE /submissions/:id`, `/api/admin/purge` |
| Criou / editou / baniu / excluiu conta | rotas `/api/admin/users*` |
| Importou planilha (contas ou listas) | `/users/import`, `/ref/import` |
| Gerou crachá de acesso total | `/api/admin/cracha` |

Campos: `ts`, `userId`, `userNome`, `acao`, `alvo`, `qtd`, `ip`.

Hoje `baixado = true` diz que a foto saiu, mas não diz **quem** a levou — que é
exatamente a pergunta de uma auditoria.

### 1.5 Retenção automática — **2 meses**

Rotina diária (`setInterval` no boot; o Discloud roda processo persistente, então
não precisa de cron externo) que apaga do Mongo **e** do Cloudinary, reusando o
caminho de `purgeDownloaded` + `store.remove`, e registra o resultado na `auditoria`.

**TTL index do Mongo não serve aqui.** Ele apagaria o documento sem avisar ninguém,
deixando a imagem órfã no Cloudinary — pagando armazenamento por foto que ninguém
mais consegue ver. Tem que ser código.

O prazo curto que você escolheu é bom para conformidade, mas ele expõe três coisas
que o prazo de 12 meses esconderia. As três precisam de decisão antes de eu
implementar.

#### Regra A — foto baixada

`baixado = true` e enviada há mais de 2 meses → apaga. Direto, sem polêmica: a
foto já está no servidor interno, que é onde ela deve viver.

**Sem exceção para vencedoras.** Era o desenho anterior; foi substituído — a foto
do vencedor também morre aos 2 meses. Só o registro do pódio sobrevive. Ver 1.5.3.

#### Regra B — foto **nunca** baixada ✅ *decidido: expira junto*

Aqui morava um furo silencioso. Foto **recusada nunca entra no ZIP** (o
`download-manifest` filtra `validado === false`), logo nunca vira `baixado = true`,
logo — sob a Regra A sozinha — **ficaria no banco para sempre**. O mesmo vale para
qualquer foto que a equipe simplesmente não chegou a baixar.

Seria o pior desfecho possível: a política diria "2 meses" enquanto o dado mais
sensível, o das recusadas, seria o único que nunca expira — mentir na política *e*
guardar justamente o que menos deveria ficar.

**Decidido:** a retenção vale por **idade, não por status**. Baixada, não baixada,
aprovada, recusada ou nunca avaliada — 2 meses e acabou. Uma régua só, fácil de
declarar e de auditar.

E como "bizarro se acontecesse" é exatamente o tipo de coisa que acontece, o
1.5.1 existe para que não aconteça em silêncio.

#### ⏱️ Correção de relógio — contar de `createdAt`, não de `dataExposicao`

Eu tinha escrito "2 meses após a **data da exposição**". Está errado, e o
requisito do 1.5.1 é o que revela o porquê: **são dois relógios diferentes.**

O promotor pode enviar hoje a foto de uma exposição de 2,5 meses atrás — o campo
`dataExposicao` é digitado por ele, e as travas de 1/semana e 4/mês usam justamente
esse campo. Com a retenção contada pela exposição, essa foto **nasce vencida**: é
apagada antes de qualquer pessoa ter a chance de olhar para ela. A equipe perderia
trabalho sem nunca ter tido oportunidade de colhê-lo.

**Retenção e alertas passam a contar de `createdAt`** (quando a foto entrou no
sistema). Assim todo mundo tem os mesmos 2 meses completos, o alerta de 1 mês e a
exclusão de 2 meses vivem na mesma linha do tempo, e a política fica mais simples
de escrever: *"2 meses após o envio"* em vez de *"após a exposição"*.

`dataExposicao` continua sendo o eixo dos gráficos e das travas — só não é mais o
gatilho da exclusão.

### 1.5.1 Escalonamento: impossível ignorar foto parada

A contrapartida da Regra B. Se a foto vai morrer aos 2 meses, a equipe precisa
esbarrar nela **muito** antes disso.

**Dois problemas distintos**, que não podem ser tratados como um só:

| Estado | Condição | Significa |
|---|---|---|
| 🔴 **Não avaliada** | `validado === null` | Ninguém olhou. O promotor está esperando |
| 🟠 **Aprovada e não baixada** | `validado === true` **e** `baixado === false` | Trabalho pronto que ninguém colheu |

⚠️ **Recusada não entra na segunda lista.** `validado === false` nunca vai para o
ZIP por design — é estado **terminal**, não pendência. Sem essa exclusão, toda foto
recusada gritaria para sempre e o alerta viraria ruído que a equipe aprende a
ignorar. Que é o oposto do pedido.

**Linha do tempo** (a partir de `createdAt`):

| Dia | O que acontece |
|---|---|
| 0 | Foto entra |
| **30** | 🟡 **Destaque.** Contador no topo do painel + marcação na foto na galeria |
| **45** | 🔴 **Crítico.** Banner fixo, não dispensável |
| **53** | ⚫ **"N fotos serão apagadas em 7 dias"** — última chamada |
| **60** | Imagem apagada, registro anonimizado |

**Como tornar inescapável** — em camadas, porque badge sozinho todo mundo aprende
a não ver:

1. **Banner fixo no topo do painel**, acima das abas, visível em *qualquer* aba —
   não só na de fotos. Não dispensável a partir do dia 45.
2. **Contadores nas sub-abas** que já existem, com as duas contagens separadas
   (a mecânica de contagem já está pronta em `contarSubmissions`).
3. **Marcação na própria foto** na galeria, com a idade em dias.
4. **Filtro rápido "só as paradas"** — o banner leva direto para a lista filtrada,
   já ordenada pelas mais antigas (`ordem: 'antigas'` já existe).

**Implementação:** o painel já faz polling de 10s para o badge de cadastros
(`/api/admin/signup-count`). Em vez de somar mais uma requisição a cada 10s no
Atlas M0 — que é onde o gargalo já mora —, junto as duas num
`GET /api/admin/alertas` que devolve tudo de uma vez: cadastros pendentes,
não avaliadas, não baixadas e a expirar. São `countDocuments` com filtro de data,
e o índice `createdAt` já existe. Visível para quem tem permissão `fotos`.

> **Ideia relacionada, fora deste escopo:** mostrar ao promotor que a foto dele
> está há X dias sem avaliação. Resolve o outro lado da mesma dor, mas é decisão
> de produto — anoto e não faço sem você pedir.

### 1.5.2 Retorno da recusa ao promotor

Dor relatada: o promotor tem a foto recusada e depois vem cobrar o porquê — que é
justamente para o que existem a lista de motivos e a observação.

#### 🔎 Achado: o motivo nunca chega ao promotor

`/api/my/submissions` devolve o documento inteiro (a projeção só tira o `_id`),
então `motivoRecusa` **já está no payload**. Mas o front
([promotor.html:289](../public/pdv/promotor.html:289)) renderiza só a pílula
"Recusada" e a `observacao`. O motivo escolhido no botão **nunca é exibido**.

Ou seja: a equipe seleciona o motivo de uma lista, o dado viaja até o navegador do
promotor, e morre sem ser desenhado. É uma linha de front — e é bem possível que
resolva boa parte da cobrança **sozinha**, sem depender de nada de retenção.
Vale fazer cedo e medir se a reclamação cai.

**Consequência imediata:** se o motivo passa a ser visível, recusar **sem** motivo
vira falha visível — o promotor lê "Recusada" e nenhuma razão, que é exatamente a
queixa original. Então **motivo passa a ser obrigatório ao recusar**. A aderência
já mede isso (`recusadasSemMotivo`, [lib/db.js:1025](../lib/db.js:1025)), o que dá
para acompanhar a adesão depois de ligar a obrigatoriedade.

#### ⚠️ A colisão com a anonimização

Sua proposta — manter a recusa 2 meses e **depois** seguir exibindo *"a foto da
semana X foi recusada pelo motivo Y, obs Z"* — não funciona sob o desenho que
estava no plano, por dois motivos:

1. `/api/my/submissions` filtra por `uploadedBy: req.user.id`
   ([server.js:693](../server.js:693)). A anonimização **limpa o `uploadedBy`** —
   sem ele o promotor perde o histórico inteiro, não só a imagem.
2. Eu tinha listado `observacao` para apagar (texto livre pode citar nomes). Mas é
   exatamente o texto que você quer mostrar.

Ou seja: aos 2 meses não sobraria nem o vínculo nem o texto. **A anonimização e o
retorno ao promotor querem coisas opostas do mesmo documento.**

#### A saída: três camadas, três relógios

Decisão sua: o retorno fica **para sempre**, "é só texto".

Concordo com a intenção, e ela tem uma forma precisa — porque "para sempre" solto
não é declarável numa política, e manter o `uploadedBy` na submissão para sempre
desmontaria toda a anonimização do 1.5.

**A forma: separar o retorno da submissão.**

| Artefato | Prazo | Contém |
|---|---|---|
| **Imagem** (Cloudinary) | **2 meses** | O arquivo. O que pesa e o que mais expõe |
| **Submissão** | Anonimizada aos **2 meses** | Só o agregável. Alimenta os gráficos, sem nome |
| **Retorno** (coleção nova) | **Enquanto a conta existir** | `userId`, semana, cliente, `motivoRecusa`, `observacao` |

O `retorno` é gravado no momento da recusa, indexado pelo **usuário** — não pela
submissão. Assim a submissão pode ser anonimizada no prazo normal, e a tela "Minhas
fotos" passa a ler os dois: submissões recentes (com imagem) + retornos antigos
(só texto). É exatamente o que você descreveu, e ainda deixa `endereco` e
`searchBlob` morrerem aos 2 meses — que é o que eu menos gostaria de guardar
indefinidamente.

**"Enquanto a conta existir" é a formulação que a política aceita.** Não é prazo
arbitrário: a finalidade (dar ao promotor o histórico da própria participação)
dura enquanto durar a relação, que é literalmente o critério do Art. 15. Quando a
conta é excluída ou anonimizada a pedido do titular, o retorno vai junto — e isso
precisa estar no fluxo do 1.6, senão sobra dado pessoal órfão.

**Peso:** só recusas geram retorno. Estimando ~15/ano por promotor × 1.400 ≈ 21 mil
documentos de ~100 bytes = **~2 MB/ano**. Irrelevante num M0 de 512 MB.

Efeito colateral, para constar: o top-10 "quem mais leva recusa" continua limitado
a 2 meses (ele lê `submissions`, não `retorno`) — e continua sendo o comportamento
certo, já que é ranking de desempenho individual.

> ✅ **Resolvido.** O promotor vê para sempre — na prática, *enquanto a conta dele
> existir*, que é a mesma coisa do ponto de vista dele e é declarável na política.

> **Ponto de atenção no botão "Excluir foto":** hoje o
> `DELETE /api/admin/submissions/:id` apaga o registro inteiro — usando ele, o
> promotor perde a justificativa junto. Faz sentido para lixo e envio errado
> (e por isso fica), mas a equipe precisa saber que "excluir" ≠ "apagar a imagem".

### 1.5.3 Ranking: o pódio vira registro, não foto

Decisão sua: a foto vencedora **não** fica para sempre — o que fica é o dado
*"Vencedores da edição Abóbora — 07/2026: Germano, Ciclano, Beltrano"*.

Isso é melhor do que o desenho anterior por um motivo prático: **elimina a exceção**
da retenção. Sem carve-out de `rankingPos`, a régua fica uma só ("2 meses, sempre"),
que é mais fácil de declarar na política e de auditar.

⚠️ **Mas quebra a página de ranking como ela existe hoje.** O
[ranking.html:45](../public/pdv/ranking.html:45) monta o pódio com
`<img src="/api/file/{id}/{k}">` — a página **é** uma galeria de fotos. Apagar as
imagens aos 2 meses deixaria as edições passadas cheias de imagem quebrada.

**Redesenho:**

- Coleção `ranking` (ou documento por edição) com `{ edicao, mesKey, posicao,
  promotor, grupo, regiao, cliente }` — gravada **no momento em que o admin marca**
  o vencedor, não na hora de apagar.
- A submissão volta a seguir a regra geral e perde `rankingPos` como exceção.
- `ranking.html` passa a ter dois modos: **edição vigente** (foto ainda existe →
  pódio com imagem) e **edições passadas** (só o quadro de honra em texto).
  Degrada com elegância em vez de mostrar imagem quebrada.

⚠️ **O nome do vencedor fica indefinidamente, e isso é dado pessoal.** É um quadro
de honra visível a todos os usuários logados (`/api/ranking` só exige `requireAuth`,
~1.4k pessoas). Continua legítimo — premiação divulgada é finalidade própria — mas
**tem que estar declarado na política**, e não pode ser varrido junto com a
anonimização por engano.

> **Ordem obrigatória:** gravar o registro do pódio tem que estar funcionando
> **antes** da primeira exclusão. Se inverter, os vencedores passados somem e não
> há como reconstruir.

### 1.5.4 Anonimização: o que apagar, o que manter

> **Correção de premissa, registrada porque a política vai depender disso:**
> nenhuma lei fixa prazo de retenção. Os Arts. 15 e 16 da LGPD mandam eliminar o
> dado quando a finalidade se esgota — **quem escolhe o prazo é o controlador**, e
> a obrigação é declarar e cumprir. Os 2 meses são decisão de negócio da Memphis,
> e por isso é perfeitamente válido dar prazos diferentes para a **imagem** e para
> o **registro anonimizado**.

Decisão adotada: aos 2 meses a rotina **apaga a imagem no Cloudinary** e
**anonimiza o documento no Mongo**, em vez de apagar o documento.

A alternativa descartada era gravar um **snapshot agregado** e apagar o documento.
Anonimizar ganha por dois motivos: `aderencia()` e
`serie()` continuam agregando `submissions` exatamente como hoje — **zero mudança
no código dos gráficos** — e a granularidade fica preservada, então um gráfico novo
inventado no ano que vem ainda encontra os dados dos anos anteriores. Um snapshot
congela as dimensões que você pensou na hora de gravar; o registro anonimizado não.

O peso também fecha: sem imagem, cada documento tem ~700 bytes. 5.600 fotos/mês
≈ **50 MB/ano** com índices, num M0 de 512 MB — anos de folga. O que pesa de
verdade (a imagem) continua morrendo aos 2 meses no Cloudinary.

##### O que apagar, o que manter

| Apagar | Por quê |
|---|---|
| `promotor`, `promotorNorm` | Nome real |
| `uploadedByEmail` | E-mail |
| **`uploadedBy`** | ⚠️ **A FK para `users`.** Sem isso, "anonimizar" vira **pseudo**nimizar: um `$lookup` devolve o nome em um passo, o dado continua sendo pessoal e a isenção do Art. 12 **não se aplica**. É o campo mais fácil de esquecer e o que invalida o resto. **Sai só aos 6 meses** — ver 1.5.2 |
| `endereco` | Endereço da loja + data = rastro de localização. Reidentifica |
| `searchBlob` | Concatena nome + endereço. Anonimizar sem limpar aqui não anonimiza nada |
| `observacao` | Texto livre da equipe. **Sai aos 6 meses, junto com o `uploadedBy`** — até lá é o retorno que o promotor lê (1.5.2) |

| Manter | Por quê |
|---|---|
| `dataExposicao`, `semanaKey`, `mesKey` | Eixo temporal de todo gráfico |
| `regiao`, `grupo` | Recortes principais |
| `cliente` | Alimenta o top-10 de clientes. ⚠️ **Ressalva:** você confirmou que o cadastro aceita CPF e MEI, então "cliente" nem sempre é pessoa jurídica — um MEI costuma carregar o nome da pessoa. Ver a nota abaixo |
| `validado`, `preAvaliacao`, `pontosExtra`, `pago` | Todas as métricas de qualidade |
| `motivoRecusa` | Vem de lista controlada (`MOTIVOS_RECUSA`), sem texto livre |
| `rankingPos` | Deixa de ser exceção de retenção — ver 1.5.3 |

> ⚠️ **Sobre `cliente` sobreviver à anonimização.** Se a lista aceita MEI e CPF, um
> "cliente" pode ser o nome de uma pessoa física ("Mercado do João Silva"). Nesse
> caso o registro anonimizado fica **quase** anônimo: sem o promotor, mas com o
> nome do lojista.
>
> Duas saídas, e a escolha é sua:
> **(a)** manter `cliente` como está — os gráficos por cliente continuam completos,
> e o risco residual entra declarado no registro de tratamento (`09-lgpd.md`);
> **(b)** trocar o nome por um **código de cliente** na anonimização, usando a lista
> `refdata.clientes` como tabela de correspondência — os gráficos continuam
> funcionando por código, e o nome só existe na lista de referência, num lugar só.
>
> Recomendo **(b)** se a proporção de MEI/CPF for relevante; **(a)** se for
> exceção rara. Você conhece a carteira melhor que eu.

##### Os dois pontos onde não é só "limpar campo" ⚠️

Olhando o código, `promotorNorm` faz **três** trabalhos ao mesmo tempo, e limpá-lo
quebra dois deles em silêncio:

**1. É chave de join.** `comGrupoDoBanco` ([lib/db.js:961](../lib/db.js:961)) faz
`$lookup` de `promotorNorm` → `promotores.nomeNorm` para descobrir o **grupo
oficial** — que é o denominador do "% do grupo". Sem a chave, `grupoBanco` vem
vazio e a participação por grupo oficial zera.

→ **Solução:** na anonimização, **congelar `grupoOficial` no documento**. Resolve o
lookup uma vez e guarda o resultado. Nome de grupo não é dado pessoal. As
agregações passam a usar o valor congelado quando existir.

**2. É chave de contagem distinta.** `porPromotor` ([lib/db.js:966](../lib/db.js:966))
conta *promotores distintos*, não fotos — "quantos participaram". Sem identidade
não dá para contar gente distinta, e nenhum campo residual substitui isso.

→ **Solução:** gravar, na anonimização, **um contador por mês × grupo** com
`participantesDistintos`. É um número por combinação — não o snapshot completo que
eu tinha proposto, apenas a única métrica que exige identidade.

→ **O que não tem solução, e está certo assim:** o top-10 "quem mais leva recusa"
agrupa por `$promotor` ([lib/db.js:1060](../lib/db.js:1060)) e passa a mostrar
**só os últimos 2 meses**. Isso é um ranking de desempenho individual — mantê-lo
sobre dados antigos seria exatamente o tipo de perfilamento prolongado que a
retenção curta existe para impedir. Aqui a limitação é a funcionalidade correta,
não um efeito colateral. Vale avisar a equipe para não parecer bug.

> **Ordem obrigatória:** `grupoOficial` e o contador de participantes têm que estar
> sendo gravados **antes** da primeira rodada de anonimização. Se inverter, o
> vínculo com o grupo se perde e não há como reconstruir — o nome já foi.

### 1.6 Direitos do titular

Hoje `deleteUser` ([lib/db.js:308](../lib/db.js:308)) apaga **só o documento do
usuário**. As submissões continuam lá com `uploadedByEmail` e `promotor` — ou seja,
"excluir a conta" não exclui o dado pessoal. Isso é o Art. 18 na veia, e também
explica dado órfão.

O que fazer, no painel (permissão `contas`):

- **Exportar dados do titular** — JSON com o cadastro e as submissões dele.
- **Excluir/anonimizar** — a decisão certa aqui é **anonimizar, não apagar**: as
  fotos alimentam aderência, ranking e histórico da campanha. Substituir nome/e-mail
  por um marcador (`[removido]`) e limpar `uploadedBy`, mantendo os números.
  Se a campanha já foi paga e encerrada, aí sim exclusão completa.

Ambas as ações vão para a `auditoria`.

### 1.7 Origem dos dados (Valoo) e a senha do primeiro acesso

As contas nascerão dos dados cedidos pelo **Valoo** (parceiro que processa os
pagamentos). A proposta inicial era **senha = 4 últimos dígitos do celular + 4
últimos do CPF/CNPJ**; ela foi **substituída** pelo convite por e-mail (1.7.2), e
o CPF saiu da coleta por completo (1.7.3). Esta seção guarda o porquê das duas
decisões e o que sobra a resolver.

#### 1.7.1 A política precisa dizer de onde veio o dado

O titular tem direito de saber a **origem** dos seus dados quando não foi ele quem
os forneceu (Art. 9º). Se o promotor recebe um login que ele nunca pediu, com dados
que ele nunca digitou aqui, a política tem que explicar: *"seus dados de cadastro
foram fornecidos pelo Valoo, no contexto da campanha X"*.

E o repasse Valoo → Memphis precisa de **base legal própria** — normalmente uma
cláusula no contrato entre as duas empresas. **Pergunta em aberto:** esse contrato
existe e cobre o compartilhamento? Não é bloqueio técnico, mas é o primeiro item
que um especialista de T.I. ou o RH vai levantar na revisão.

#### 1.7.2 ✅ Convite por e-mail — e você já tem 90% disso pronto

Você disse que o ideal seria senha provisória automática por e-mail, mas não sabia
como fazer. **A máquina já existe no projeto** e está testada: o fluxo de "esqueci
minha senha" (`lib/mailer.js` + `/api/forgot-password` + `/api/reset-password` +
`redefinir.html`), com token de 32 bytes aleatórios do qual o banco guarda só o
`sha256`, com expiração e uso único.

Convite de primeiro acesso é **uma variação pequena** disso: em vez de mandar
"redefina sua senha", manda "bem-vindo, **crie** sua senha".

**O desenho, que resolve o problema pela raiz:**

Na importação, a conta nasce **sem senha utilizável** — nada de derivar de CPF,
nada de `PRIMEIRONOME+ano`. Gera um token de convite, manda o e-mail, e a pessoa
define a própria senha no link. Ninguém nunca conhece a senha de ninguém, não
existe CSV de senhas para circular, e a senha nunca é derivada de dado pessoal.

Isso **elimina a vulnerabilidade do 1.7.1 inteira**, em vez de mitigá-la. E, de
quebra, **derruba a pergunta sobre armazenar CPF**: se ele não vira senha, o
sistema não precisa dele para nada.

**O que muda em relação ao reset que já existe:**

| Item | Reset (hoje) | Convite (novo) |
|---|---|---|
| Validade do token | 1 hora | **7 dias** — ninguém abre e-mail de onboarding em 1h |
| Gatilho | A pessoa pede | A importação dispara |
| Texto | "Redefinir senha" | "Bem-vindo — crie sua senha" |
| Reenvio | — | Botão "reenviar convite" na aba Contas |

#### ✅ Decidido (D3): dois caminhos, não um

O dono **não tem acesso** à base do Valoo, então não dá para medir quantos
promotores têm e-mail válido. Suportar os dois casos é mais barato que descobrir
na véspera do lançamento que centenas de pessoas ficaram trancadas do lado de fora.

| Caminho | Quando | Como |
|---|---|---|
| **Principal — convite por e-mail** | A linha tem e-mail | Conta nasce sem senha utilizável; token de 7 dias; a pessoa cria a senha no link |
| **Exceção — senha provisória** | A linha **não** tem e-mail | Senha **aleatória** (nunca derivada de dado pessoal), no CSV que a importação já gera, entregue pelo responsável da equipe |

Nos dois casos o servidor força a troca no primeiro acesso
([server.js:126](../server.js:126)), e a provisória **expira em 30 dias** — depois
disso, só por link de redefinição.

A tela de resultado da importação precisa mostrar a separação com clareza:
*"N contas criadas — X convites enviados, Y sem e-mail (baixe o CSV de senhas)"*.
Sem isso, ninguém percebe que sobrou gente para trás.

⚠️ **Duas armadilhas operacionais do envio em massa:**

1. **~1.400 e-mails de uma vez derrubam Gmail comum.** App Password estrangula e
   pode bloquear a conta por spam. Use serviço transacional (Brevo, Resend — faixa
   grátis suficiente); é troca de variável de ambiente, não de código.
2. **Envio em lote precisa de fila com retomada.** 1.400 envios não cabem numa
   requisição HTTP: processar em blocos, registrar quem já recebeu, permitir
   retomar de onde parou.

#### 1.7.3 ✅ CPF/CNPJ: não coletar

**Decidido: o campo não entra.** Com o convite por e-mail, o CPF não serve para
nada no sistema — some junto com a senha derivada que o justificava.

Consequências práticas:

- A importação dos dados do Valoo traz **nome, e-mail, telefone, grupo, região** —
  e ignora a coluna de documento, se vier.
- O modelo de planilha (`/api/admin/users/import-template.xlsx`) não ganha coluna
  de CPF.
- O registro de tratamento (`09-lgpd.md`) fica mais curto, e as medidas do Art. 46
  ficam proporcionais ao que o projeto já tem (bcrypt, JWT, helmet, rate-limit,
  URL assinada) — sem precisar de criptografia em nível de campo.

> **Não confundir com o campo `cliente`.** Esta decisão é sobre o documento do
> **promotor**. O sistema nunca guardou documento de cliente — `refdata.clientes`
> e `submissions.cliente` são só o **nome** do estabelecimento. Como você confirmou
> que a carteira inclui MEI e CPF, esse nome ainda pode ser o de uma pessoa física,
> e a questão de anonimizá-lo em código **continua aberta** (ver 1.5).

> **Princípio que fica valendo para campos futuros:** ou o campo é **necessário**
> (e se justifica pela finalidade, sob base contratual), ou **não entra**.
> "Opcional, se o usuário quiser ceder" muda a base legal daquele campo para
> **consentimento** — que exige prova do aceite, revogação a qualquer momento e o
> sistema funcionando sem o dado depois. Campo opcional dá mais trabalho que campo
> obrigatório, não menos.

### 1.8 Botões destrutivos e backup

Você pediu três botões. Dois já existem; o terceiro é o mais perigoso do sistema.

| Botão | Estado | Escopo |
|---|---|---|
| Apagar uma foto específica | ✅ Existe (`DELETE /api/admin/submissions/:id`) | Mongo + Cloudinary |
| Limpar as fotos já baixadas | ✅ Existe (`/api/admin/purge`) | Só `baixado = true` |
| **Resetar cadastros** (promotores, grupos, contas) | 🆕 Novo | Destrói a base inteira de pessoas |

#### 1.8.1 O botão de reset

É a ação mais destrutiva que o sistema pode ter — apaga o cadastro de ~1.400
pessoas. Precisa de mais cerimônia que os outros:

- **Só com acesso total** (`requirePerm('*')`, ou seja, crachá) — não basta a
  permissão `contas`.
- **Confirmação por digitação** ("digite RESETAR"), não um `confirm()` de uma
  tecla. Um clique errado aqui não tem desfazer.
- **Backup automático ANTES, obrigatório.** Se o backup falhar, a operação
  **aborta** — não segue "porque o usuário mandou".
- **Registro na auditoria**, com quem, quando e quantos registros.
- **Nunca apaga a própria conta de quem executou** — senão o sistema fica sem
  administrador e ninguém entra. (A proteção do admin já existe em `deleteUser`.)

Nota: já existe precedente parcial em `DELETE /api/admin/ref/promotores/tudo`, que
zera o banco de nomes. O botão novo é mais amplo e por isso mais perigoso.

#### 1.8.2 O backup de 5 meses

Dump JSON de `users`, `promotores`, `refdata` e `config`, guardado como arquivo
`raw` autenticado no Cloudinary (o `lib/storage.js` já sabe fazer isso). O tamanho
é trivial: ~1.400 contas + ~2.050 nomes + listas dá poucos MB, e comprimido, menos
que um megabyte. Espaço não é problema.

Quatro pontos que precisam entrar junto, senão o backup vira passivo em vez de rede
de segurança:

1. ⚠️ **O backup é dado pessoal.** Não é um arquivo neutro — é a base inteira de
   pessoas. Entra no registro de tratamento com retenção declarada de 5 meses,
   acesso restrito a acesso total, e entrega sempre por URL assinada com expiração
   (o mesmo tratamento do 2.2).
2. ⚠️ **Conflito com o direito de eliminação.** Se um titular pedir exclusão e
   existir backup com os dados dele, não dá para "apagar do backup" sem quebrar o
   arquivo. Prática aceita e que vou documentar na política: backups não são usados
   para reprocessar dados, e expiram sozinhos no prazo declarado.
3. ⚠️ **Backup sem restauração testada é teatro.** Precisa de caminho de volta —
   no mínimo uma rota de download e o procedimento escrito no `08-deploy.md`;
   melhor ainda, uma rota de restauração com a mesma cerimônia do reset.
4. **Expiração automática** dos backups aos 5 meses, na mesma rotina diária da
   retenção. Senão eles se acumulam para sempre — exatamente o problema que a
   retenção existe para resolver.

**Fecha o bloco com:** casos novos no `smoke.js` — aceite bloqueando o acesso,
aceite liberando, auditoria gravando no download, retenção respeitando `rankingPos`,
anonimização preservando a contagem de aderência.

---

## Bloco 2 — Minimização de exposição

As duas brechas concretas que a auditoria encontrou. Pequenas em código, grandes em
consequência.

> ### 🔴 Diretriz do dono (ago/2026), reescreveu este bloco
>
> **"Ninguém vê o nome de ninguém."** O promotor tem direito de enviar a foto, a
> data, o cliente — e nada mais. A lista dos 2.050 nomes, a edição de pontos
> extras, grupos, regiões e rankings são **exclusivas do admin**.
>
> O que estava escrito aqui antes era menos ambicioso: mantinha o autocomplete de
> nomes para o promotor. Isso não passa mais.

### 2.1 🔴 A raiz do problema: o promotor digita o nome à mão

A investigação de ago/2026 achou algo maior que um vazamento de lista. Em
[promotor.html:36](../public/pdv/promotor.html:36), o nome do promotor é um **campo
de texto livre** com `<datalist>` alimentado por `/api/check-promotor` — e em
[server.js:645](../server.js:645) o servidor lê `promotor` **do corpo da
requisição**, não da sessão:

```js
const { cliente, endereco, regiao, promotor, grupo, dataExposicao } = req.body;
```

Isso é herança da era do WhatsApp, quando não havia contas. Hoje há — e o próprio
front já sabe disso: [promotor.html:112](../public/pdv/promotor.html:112) preenche
o campo com `me.name` quando está vazio. **O dado correto já está na sessão; o
sistema simplesmente não o usa.**

#### Três problemas de uma vez, não um

| # | Problema | Gravidade |
|---|---|---|
| 1 | **Privacidade** — o autocomplete expõe nomes de colegas. Digitar "MA" devolve 8 pessoas reais | Alta |
| 2 | **Integridade** — dá para enviar foto **em nome de outra pessoa**. Afeta cota, ranking, aderência e a quem o pagamento é atribuído | Alta |
| 3 | **Limites burláveis** — `contarNaSemana` conta por `norm(promotor)` ([lib/db.js:692](../lib/db.js:692)). Digitando outro nome, a cota de 1/semana e 4/mês zera. **As travas antifraude não travam nada** | 🔴 Crítica |

#### O conserto: nome vem da sessão, ponto

```js
// em vez de req.body.promotor
const promotor = req.user.name;
```

Uma linha no servidor, e o campo some do formulário. Resolve os três de uma vez e
ainda **simplifica**:

- ✅ `/api/check-promotor` deixa de ser necessário para o promotor — some o
  autocomplete de nomes e o vazamento junto
- ✅ `promotores[]` sai da referência do promotor sem quebrar nada (não havia mais
  o que autocompletar)
- ✅ `POST /api/promotor-pendente` sai do fluxo do promotor: o nome passa a ser
  validado contra o roster **na importação**, não a cada envio
- ✅ Um campo a menos numa tela que 1.400 pessoas preenchem pelo celular

⚠️ **Decisão embutida, confirmar:** hoje quem envia pode se identificar como
qualquer pessoa. Depois disso, **só se identifica como si mesmo**. Se existe caso
real de alguém enviar pela equipe (um supervisor lançando a foto de um promotor
sem celular), esse caso precisa de rota própria e explícita no painel admin — não
de um campo de texto aberto para todos.

### 2.2 Varredura: onde mais o promotor vê nome alheio

Corrigir só o formulário deixaria portas abertas. Verificar **todas**:

| Ponto | Situação | Ação |
|---|---|---|
| `/api/reference` → `promotores[]` | 2.050 nomes para qualquer logado | Sai da variante do promotor |
| `/api/check-promotor` → `sugestoes` | 8 nomes reais por consulta | Passa a exigir permissão de admin |
| `/api/ranking` | Nomes dos vencedores para todos | ⚠️ **Exceção deliberada — ver abaixo** |
| `refdata.clientes` | 754 clientes; podem ser MEI/CPF | **Mantém** — o promotor precisa identificar a loja. É dado comercial, não de colega |
| `refdata.grupos` | Lista de todos os grupos | ✅ **Sai também** — decisão do dono: o promotor não vê outros grupos. O grupo dele vem da conta |
| `/api/my/submissions` | Só as próprias (`uploadedBy`) | OK, já filtrado |

✅ **Ranking: exceção confirmada.** O pódio mostra **nome completo** a todos os
logados. É escolha consciente do dono — premiação divulgada é finalidade própria, e
ranking que ninguém vê não motiva ninguém. Fica declarado na política.

### 2.3 Ranking por região 🆕

Pedido novo de ago/2026: ranking **por região** (NE, CN, SP, SE, SUL), não só geral.

✅ **Decidido: regional E nacional coexistem.** Seis pódios por edição — um por
região (NE, CN, SP, SE, SUL) mais o nacional.

Hoje `setRanking` ([lib/db.js:837](../lib/db.js:837)) garante posição única por
`mesKey` — uma edição, um 1º lugar.

**Modelagem sugerida:** um campo `escopo` (`'NACIONAL'` ou o código da região) e
unicidade em **`mesKey` + `escopo` + `posicao`**. Uma chave só cobre os dois tipos
de pódio, em vez de dois caminhos separados no código.

✅ **O nacional é marcado à mão**, igual aos regionais. Dá liberdade (o melhor
nacional pode não ser 1º na região dele, se a região for forte) e reusa a mecânica
de marcação que já existe — é premiação, não cálculo.

Muda em: exclusividade no `setRanking`, agrupamento do `listRanking` (hoje só por
`mesKey`), o registro de pódio do 1.5.3 (ganha `escopo`), e a página de ranking
(seletor Nacional / região).

### 2.5 🆕 Etapa de confirmação de cadastro

Consequência direta de "o promotor não vê outros nomes nem outros grupos": ele
também **não digita** os seus. Mas precisa poder conferir se estão certos.

**A tela:** antes do primeiro envio, mostra o que veio da conta —

> **Confirme seus dados**
> Nome: *Germano da Silva* · Grupo: *PDV SUL 3* · Região: *SUL*
> `[ Está correto ]`  `[ Está errado ]`

- **"Está correto"** → carimba `cadastroConfirmadoEm` e não pergunta mais.
- **"Está errado"** → ⚠️ **não abre campo de texto** (seria reabrir o buraco do
  2.1). Abre uma **solicitação de correção** que cai numa fila do admin, com um
  campo livre só para descrever o que está errado. Quem corrige é o admin.

**Onde encaixa:** no fluxo de primeiro acesso, junto com criar senha (1.7.2) e
aceitar a política (1.2). Três passos numa sequência só, e o portão do
`requireAuth` já existe para segurar os três.

**Reperguntar quando:** o admin alterar nome, grupo ou região da pessoa — limpa o
carimbo e ela confirma de novo. Barato e evita cadastro errado envelhecendo.

#### O formulário de envio encolhe bastante

| Campo | Antes | Depois |
|---|---|---|
| Nome do promotor | Texto livre + autocomplete de 2.050 | ❌ Some — vem da sessão |
| Grupo | Texto livre + lista de todos os grupos | ❌ Some — vem da conta |
| Região | Select | ❌ Some — vem da conta |
| Cliente, endereço, data, fotos | — | ✅ Continuam |

Quatro campos em vez de sete, numa tela que 1.400 pessoas preenchem no celular.

#### ⚠️ Três efeitos colaterais que precisam de atenção

**1. Muda uma regra de negócio documentada.** O `docs/04` diz *"Grupo é do promotor
— a equipe não edita grupo; grupo novo vai pra fila de aprovação"*. Isso **se
inverte**: o grupo passa a vir do cadastro, e quem edita é a equipe. A fila de
grupos pendentes some do fluxo do promotor. A equipe precisa ser avisada.

**2. Duas fontes de grupo podem divergir.** A aderência usa `promotores.grupo` via
`$lookup` ([lib/db.js:961](../lib/db.js:961)), mas o formulário passaria a usar
`users.grupo`. Se as duas não baterem, **o denominador da aderência quebra em
silêncio**. Decidir qual é a fonte da verdade e garantir que a importação preencha
as duas de forma consistente.

**3. O admin não consegue corrigir a autoria de uma foto.** Você disse que as
exceções (alguém enviando pelo outro) são avisadas à equipe — mas hoje o
`updateSubmission` ([lib/db.js:785](../lib/db.js:785)) **não aceita** `promotor` na
whitelist. Ou seja, avisaram, e a equipe não tem como consertar. Adicionar
`promotor` (e `promotorNorm`) à whitelist, **só admin**, com registro na auditoria.

### 2.6 URLs do Cloudinary com expiração

### 2.4 URLs do Cloudinary com expiração

`urlFor` usa `sign_url: true` sem `expires_at` ([lib/storage.js:36](../lib/storage.js:36)),
o que gera link assinado **permanente**. Link vazado de um manifesto = acesso
vitalício àquela foto.

Trocar por URL com expiração.

⚠️ **Cuidado:** o ZIP é montado no navegador e baixa cada imagem pela URL do
manifesto. Um TTL curto quebra o download de lotes grandes no meio. Sugestão:
**1 hora**, e testar com um lote realista de centenas de fotos antes de considerar
fechado — não com 3 fotos de teste.

---

## Bloco 3 — Documentação

### 3.1 A decisão de formato: os dois, com papéis distintos

Você pediu `.bpmn` **e** `.mermaid`, e isso está certo — mas só funciona se cada um
tiver um dono e um papel, senão eles divergem em duas semanas e ninguém sabe qual
vale.

| Formato | Onde | Público | Papel |
|---|---|---|---|
| **Mermaid** | dentro dos `.md` de `docs/` | dev | Explicativo. Renderiza no GitHub/VS Code sem ferramenta |
| **BPMN 2.0** | `docs/bpmn/*.bpmn` | processos / auditoria | **Artefato oficial.** Abre no Camunda Modeler, bpmn.io, Bizagi |

Regra escrita no `docs/README.md`: **em divergência, o `.bpmn` é normativo.** O `.md`
correspondente linka o arquivo e diz isso na cara.

### 3.2 Os arquivos `.bpmn`

Com pools e lanes de verdade, gateways tipados, sistemas externos como black-box —
o que o `04-fluxos-bpmn.md` atual não tem (ele é flowchart Mermaid com `subgraph`,
que *parece* BPMN mas não é).

| Arquivo | Processo |
|---|---|
| `01-envio-e-avaliacao.bpmn` | Ponta a ponta: pool Promotor, pool Equipe, Cloudinary/Mongo como black-box |
| `02-cadastro-e-aprovacao.bpmn` | Sign up → fila de pendentes → aprovação de promotor e de grupo |
| `03-onboarding-de-contas.bpmn` | Importação por planilha → senha provisória → primeiro acesso → aceite LGPD |
| `04-fechamento-do-lote.bpmn` | ZIP → Excel → marcar baixado → purge |
| `05-retencao-e-anonimizacao.bpmn` | Os três relógios: escalonamento 30/45/53 → imagem aos 2 meses → identidade aos 6 → anonimizado para sempre |
| `06-direitos-do-titular.bpmn` | Solicitação → identificação → exportar ou anonimizar → resposta (o processo que uma auditoria vai pedir) |

O `05` virou arquivo próprio em vez de caber no `04`: com três relógios, dois
gatilhos automáticos e um escalonamento em quatro degraus, ele é o processo mais
difícil de acertar de cabeça — e o que mais se beneficia de estar desenhado antes
de virar código.

O reset de cadastros (1.8) entra como subprocesso do `03`, junto com o backup
obrigatório e a confirmação por digitação.

⚠️ **Nota honesta sobre o `.bpmn`:** a parte semântica do XML eu escrevo sem
problema. O que dá trabalho é o `BPMNDiagram`/`BPMNShape` (o *diagram interchange*,
as coordenadas de cada caixa) — sem ele o arquivo abre com tudo empilhado no canto.
Duas saídas, e eu iria pela primeira: gerar o layout com `bpmn-auto-layout` (npm,
só devDependency, não entra em produção) e ajustar o que ficar torto no Camunda
Modeler. A alternativa é eu escrever as coordenadas à mão, o que funciona mas fica
visualmente pobre em diagramas grandes. Vale você olhar o primeiro arquivo pronto
antes de eu gerar os outros quatro.

### 3.3 Corrigir a defasagem dos `.md`

A auditoria mediu: docs pararam em 24/jul, código andou até 28/jul.

- **`03-api.md`** — **13 endpoints ausentes**, e o `README` ainda diz "36 endpoints"
  quando são **53**. Faltam: `/api/signup`, `/api/signup-info`,
  `/api/admin/signup-count`, `/api/ranking`, `/api/admin/ranking`,
  `/api/admin/presenca`, `/api/admin/series`, `/api/admin/senhas` (+`/import`),
  `/api/admin/ref/promotores` (+`/tudo`), `/api/admin/ref/import` (+ template).
- **`02-modelo-de-dados.md`** — coleção `presenca` fora do ER; campos `motivoRecusa`,
  `rankingPos`, `pendingApproval` ausentes (+ os novos `aceiteVersao`/`aceiteEm` e a
  coleção `auditoria`); tabela de índices sem `promotores.grupo`,
  `submissions.dataExposicao` e o TTL da `presenca`.
- **`01-arquitetura.md`** — hub (`public/index.html`) e módulos `pdp`/`rca` não existem
  no diagrama; a pasta `public/pdv/` também não.
- **`04-fluxos-bpmn.md`** — sem sign up, ranking por edição, presença de avaliadores,
  senhas programadas. Passa a linkar os `.bpmn`.
- **`05-sequencia.md`** — sequência do sign up + aprovação; atualizar a do ZIP para a
  URL com expiração.
- **`07-seguranca.md`** — seção LGPD, e atualizar o status do endurecimento.
- **`09-lgpd.md` (novo)** — o **registro de operações de tratamento**: tabela de
  campo × finalidade × base legal × retenção × quem acessa. É o documento que uma
  auditoria pede primeiro, e o que torna a política de privacidade verificável em
  vez de decorativa.

---

## Bloco 4 — Tipagem

Executar **na ordem**, e cada fase é útil sozinha — se você parar na 1, já valeu.

### Fase 1 — JSDoc + `checkJs` (sem build, sem risco) ✅ **FEITA (28/ago/2026)**

`jsconfig.json` com `checkJs: true` + `@typedef` num `lib/tipos.js` (JSDoc puro,
zero runtime) para os contratos centrais: `User`, `Submission`, `FiltroSubmissions`,
`Permissao`, `Referencia`.

> **Como ficou.** `npx tsc -p jsconfig.json` fecha em **0 erros** (eram 57 na primeira
> passada). Nenhuma dependência entrou no `package.json` — o `typeAcquisition` do
> `jsconfig` resolve no editor, e a checagem por fora usa `npm i -D --no-save`. Registrado
> em [08-deploy.md](08-deploy.md#checagem-de-tipos-opcional-não-afeta-o-deploy).
>
> Dos 57, o que era achado de verdade e virou correção no código:
> - `app.listen(PORT)` e `dev-preview` recebiam `PORT` como **string** (`process.env` sempre
>   devolve string; o `listen` coagia por baixo dos panos);
> - `isNaN(umDate)` e `dataA - dataB` em cinco pontos — funcionavam só por coerção implícita;
> - em `test/carga.js`, `Object.entries(status).filter(([c]) => c < 500)` comparava a
>   **chave string** com número;
> - `addSubmission` prometia devolver uma `Submission` completa, mas os campos vinham de um
>   spread parcial: nada garantia `cliente`/`regiao`/`dataExposicao`. O contrato foi apertado
>   para exigi-los (os três callers já os mandavam).
>
> O resto era ruído de tipagem de dependência — `helmet` e `express-rate-limit` declaram
> `export { x as default }` num `.d.cts`, e o `exceljs` declara um `Buffer` próprio que não é
> o do Node. Resolvidos com cast anotado no ponto de uso, com o porquê escrito ao lado.

Hoje o projeto tem **zero** anotações JSDoc. Isso liga autocomplete e erro no editor
sem tocar em `package.json` de produção, sem build, sem mexer no deploy. `npx tsc
--noEmit` roda na CI se você quiser trancar.

Anotar primeiro os pontos onde a forma é ambígua de verdade:
`queryDeSubmissions` (recebe `req.query` cru), `imagensDe` (formato antigo × novo),
`validado: true|false|null`, `matricula: number|null` com o `0` de semântica especial.

### Fase 2 — Avaliar `.ts` onde ele brilha ⏸️ **parada por decisão do plano: só depois do piloto**

Alvos em ordem de valor por unidade de risco:

| Arquivo | Linhas | Veredito |
|---|---|---|
| `lib/storage.js` | 81 | **Primeiro alvo.** Fronteira externa, poucas dependências, tipos do SDK do Cloudinary já existem |
| `lib/mongo.js`, `lib/mailer.js` | 27 + 37 | Triviais, entram junto |
| `lib/db.js` | 1.164 | **O alvo de valor real**, e o mais arriscado. Só depois do piloto estável |
| `server.js` | 926 | Deixar por último, ou não converter — Express + tipos rende mais atrito que ganho |

⚠️ **O custo escondido:** converter de verdade exige build step, e o
`discloud.config` aponta `MAIN=server.js`. Vira `dist/server.js`, com `npm run build`
antes de cada upload. Isso é uma mudança de deploy num app prestes a entrar em
produção — motivo pelo qual a Fase 2 vem **depois** do piloto, não antes.
(Existe a saída de *type stripping* nativo do Node, que dispensaria o build, mas
depende da versão de Node que o Discloud roda — teria que confirmar antes de contar
com isso.)

### Fase 3 — `pdp` e `rca` nascem em TS ⏸️ **idem — os módulos ainda estão vazios**

Estão vazios. É a forma barata de entrar em TypeScript sem migrar nada que já roda.

### Em paralelo: validação em runtime ✅ **FEITA (28/ago/2026)**

Mais valioso que tipagem estática para este app, e vale independente de qualquer
fase acima. Tipo some em runtime; `req.body` é hostil por definição — e nenhum dos
bugs que este projeto teve de fato teria sido pego pelo compilador.

Um `lib/validar.js` de ~80 linhas cobre os 6–8 endpoints que aceitam corpo do
cliente. Sem dependência nova (`zod` faria o mesmo, mas nesta escala não paga o
peso). O `pontosExtra` do Bloco 0 é o primeiro cliente.

> **Como ficou.** Nove rotas cobertas: `POST /api/signup`, `POST /api/submissions`,
> `PATCH /api/admin/submissions/:id`, `PATCH /api/admin/users/:id`,
> `POST /api/admin/ranking`, `POST /api/cracha/validar`, `POST` e
> `DELETE /api/admin/senhas`, `POST /api/my/correcao-cadastro`. Detalhe em
> [07-seguranca.md](07-seguranca.md#validação-de-entrada).
>
> ⚠️ **Duas armadilhas que apareceram só na execução**, e que quem mexer nisso depois
> precisa conhecer:
>
> 1. **PATCH precisa de `objetoParcial`, não de `objeto`.** Campo ausente tem que
>    continuar ausente. Com `objeto`, salvar só a pré-avaliação mandaria `motivoRecusa: ''`
>    junto e apagaria o motivo da recusa — sem erro na tela, sem ninguém ter pedido.
> 2. **O e-mail tem duas réguas.** A primeira versão usava a régua do cadastro público
>    (domínio com ponto) também no painel — e o smoke pegou na hora: isso recusa
>    `admin@local` e `mat…@sem-email.memphis.local`, que é justamente o caminho de quem
>    **não tem e-mail** criado no 1.7.2. Apertar a régua do painel tranca a operação do
>    lado de fora do próprio sistema.
>
> `POST /api/submissions` é a única rota com `try/catch` próprio, e por um motivo que não
> é estilo: um 400 ali ainda tem que apagar do Cloudinary as imagens que já subiram. Sem
> isso, cada envio malformado deixa arquivo pago para trás sem nada no banco apontando
> para ele.
>
> Onze casos novos no `smoke.js` (seção "validação de fronteira"), cobrindo operador do
> Mongo no corpo, 31 de fevereiro, texto acima do teto, mass assignment ignorado em
> silêncio, PATCH parcial que não apaga o que não foi mandado, listas fechadas e as duas
> réguas de e-mail.

---

## Bloco 5 — Capa (estética Apple / vidro)

Pedido de ago/2026: deixar a **capa** mais bonita, com detalhes de vidro e estética
próxima à da Apple.

**Alvo mínimo:** `public/index.html` (o hub com os três módulos) + `public/style.css`.
~~⚠️ **Confirmar com o usuário** se para nas outras telas ou se `login.html` e
`promotor.html` acompanham~~ — ✅ **respondido em 30/ago/2026: "sim, todos".** O escopo
final são as **14 páginas**.

> ✅ **FEITO (30/ago/2026).** Primeiro o alvo mínimo (a capa); depois, com o "sim, todos"
> do dono, as **14 páginas**.
>
> **Arquitetura da extensão.** Não foi override por tela — teria virado dívida na hora. O
> caminho foi fazer os **tokens** serem a fonte única:
> 1. Trocar as superfícies com `#fff` cravado por `var(--panel)` etc. Isso é neutro: no
>    tema claro `--panel` **é** `#ffffff`, então nada mudou de aparência ao fazer a troca.
> 2. Dar valores de escuro aos tokens que faltavam (`--footer`, `--line-forte`) e
>    recalcular os semânticos: `--green`, `--amber`, `--red`, `--purple`, `--yellow` foram
>    escolhidos para ler sobre BRANCO e afundavam sobre painel escuro (o `--amber #9c690d`
>    dava 1,9:1).
> 3. `.theme-dark` no `<body>` das 14 páginas, e o vidro escopado nele.
>
> O tema claro **continua definido** no `:root` e fica dormente. É o que permite voltar
> atrás mudando uma classe, em vez de reescrever a folha.
>
> ⚠️ **A capa e as telas de trabalho pedem coisas opostas do fundo.** A capa precisa de
> bastante variação atrás dos cartões (é o que faz o vidro parecer vidro); uma tela com
> tabela, filtro e foto precisa do contrário — gradiente forte briga com o dado. Por isso
> a capa carrega uma segunda classe (`.capa`) com brilhos mais fortes, e `.theme-dark`
> sozinho fica com a versão discreta. Sem essa separação, o gradiente da capa vazava para
> as 13 telas restantes — foi o que aconteceu na primeira tentativa.
>
> **As duas restrições ⚠️ da seção, e o que aconteceu com cada uma:**
>
> 1. **`backdrop-filter` caro no Android de entrada.** O blur ficou **só nos três
>    cartões** — área contida, e eles não se movem. O header é grudento e translúcido,
>    mas **sem blur**: blur que repinta a cada quadro do scroll é exatamente o que trava
>    o aparelho fraco. A variação de fundo que faz o vidro parecer vidro vem de três
>    gradientes radiais no `background` do body, que o navegador pinta uma vez.
>    No mobile o raio do blur cai de 22px para 14px. `@supports not (backdrop-filter…)`
>    entrega cartão sólido — testado simulando a ausência de suporte.
>
> 2. **Vidro é armadilha de contraste — e era mesmo.** Os tons foram calculados, não
>    estimados: pior caso = os três gradientes somados no mesmo ponto + o vidro em hover.
>    Nessa conta, o `--muted` de então (`#9aa0a6`) dava **3,66:1**, abaixo do mínimo de
>    4,5:1. Correção em dois lados: brilhos um pouco menores e `--muted` → `#b0b7bf`.
>    O selo "em breve" também reprovou (4,27:1) e passou a usar **tinta escura** — sobre
>    vidro, empilhar mais branco derruba o contraste em vez de ajudar.
>    **Pior razão da capa hoje: 4,78:1.** Mexeu nos brilhos ou na opacidade do vidro,
>    refaça a conta.
>
> **Três coisas que só apareceram fazendo:**
>
> - **A regra do mobile foi quase desfeita sem querer.** `.theme-dark .lp-hero` tem
>   especificidade maior que o `.lp-hero` dentro do `@media (max-width: 640px)` — o hero
>   novo ANULAVA o enxugamento que existia para o primeiro cartão caber acima da dobra
>   num Android de 640px. A capa carrega overrides próprios dentro do `@media` por causa
>   disso. Conferido a 360×640: o "Entrar no módulo" aparece sem rolar.
> - **O logo é preto.** Era por isso que o header deste tema nascia **branco**. Com o
>   header escuro, o wordmark "memphis" e a assinatura sumiam. Resolvido com
>   `filter: invert(1) hue-rotate(180deg)`, que clareia o texto e devolve a matiz do
>   símbolo. Se um dia existir uma versão clara do arquivo, troque a imagem e apague o filtro.
> - **Faltava o link da política** no rodapé do hub e do login. O manifesto do 1.1 previa
>   os dois e nenhum tinha entrado. Ambos foram incluídos.
>
> **🔴 O achado que apareceu ao auditar as 14 telas — e que não era do tema escuro.**
> A auditoria de contraste (rodada dentro da página, compondo a pilha real de fundos)
> encontrou 9 reprovações. **Sete eram pré-existentes** e valiam igual no tema claro:
> `#fff` sobre `--teal` dá **3,20:1**, e isso era o **botão de ação principal de toda
> tela**, mais a aba ativa, o crachá e quatro das seis cores de ponto extra.
>
> A causa é sempre a mesma: **a mesma variável servia de cor de marca** (borda, ícone,
> série de gráfico, onde não há texto por cima) **e de superfície que carrega texto
> branco** — dois papéis com exigências opostas. No tema claro isso passava despercebido;
> no escuro explodiu, porque `--purple` e `--green` foram clareados para servir de TEXTO
> e continuavam sendo usados como PREENCHIMENTO com branco por cima (2,6:1).
>
> Resolvido separando os papéis: `--teal-fill`, `--purple-fill`, `--green-fill`,
> `--red-fill`, `--yellow-fill`. Todos ≥4,76:1 com branco e **iguais nos dois temas**, de
> propósito — a exigência vem do texto branco, não do fundo da página.
> ⚠️ Ao acrescentar cor nova, pergunte primeiro **qual papel ela tem**. Se for
> preenchimento com texto por cima, a régua é o contraste com o texto, não com a página.
>
> **Estado final:** 0 reprovações em login, cadastro, painel (abas Fotos, Aderência e
> Gráficos), promotor, política, ranking, 404, o hub e as três landings de módulo.
>
> **O que NÃO foi feito, e por quê.** A seção sugere trocar Montserrat pelo stack de
> sistema para remover o `fonts.googleapis.com` e apertar a CSP. Não dá para fazer isso
> "só na capa": **13 páginas** carregam Google Fonts, e a assinatura em Sacramento
> ("a essência do ponto de venda") aparece em 4 landings. Tirar a liberação da CSP com as
> outras 12 ainda dependendo dela quebraria as fontes delas. Fica como decisão à parte —
> não é um bônus de graça deste bloco. **A CSP não foi tocada.**

**Estado atual:** tema escuro (`theme-dark`), teal `#1C9CC0`, Montserrat, `hub-grid`
com três cartões (PDV ativo, PDP e RCA "em breve"), hero com kicker e rodapé.

### O que caracteriza a estética pedida

Não é "colocar blur em tudo". O que dá a leitura Apple:

- **Tipografia grande e com pouco peso**, muito espaço em volta. Hierarquia por
  tamanho e espaçamento, não por cor e borda.
- **Profundidade suave** — sombras largas e difusas, não escuras e curtas.
- **Cor contida.** Um acento (o teal já serve) sobre neutros. Nada de gradiente
  colorido competindo com o conteúdo.
- **Vidro com moderação:** uma ou duas superfícies translúcidas sobre um fundo com
  variação, e não vidro sobre vidro sobre vidro. `backdrop-filter: blur()` + fundo
  semitransparente + borda de 1px levemente clara.
- **Movimento discreto** — transições de 200–300ms, nada saltitante.

### ⚠️ Duas restrições que costumam derrubar esse visual aqui

**1. `backdrop-filter` é caro no celular que o público usa.** O promotor de campo
não está num iPhone recente — e blur em tempo real sobre área grande derruba o
scroll em Android de entrada. Regras práticas: usar em **poucos elementos** e de
área contida (os cartões, não o fundo inteiro); testar num aparelho fraco de
verdade; e ter fallback via `@supports not (backdrop-filter: blur(1px))` com fundo
sólido, porque sem isso o cartão fica transparente e ilegível onde não há suporte.

**2. Vidro é armadilha de contraste.** Texto sobre superfície translúcida muda de
legibilidade conforme o que passa por trás. Manter contraste mínimo de 4.5:1 no
pior caso do fundo — na prática, garantir opacidade suficiente na camada de vidro
em vez de confiar só no blur.

### Detalhe que ajuda e é de graça

A fonte da Apple (SF Pro) não é licenciada para web, mas o **stack de sistema**
entrega a coisa autêntica em Apple e algo coerente no resto, sem baixar nada:

```css
font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
```

Como bônus, isso **remove uma dependência externa** (o `fonts.googleapis.com` que
hoje o `index.html` carrega) e deixa a página mais rápida. Se a identidade Memphis
exigir Montserrat, vale mantê-la nos títulos e usar o stack de sistema no corpo.

⚠️ **Se mexer em fontes, conferir a CSP** em [server.js:30](../server.js:30):
`styleSrc` e `fontSrc` liberam Google Fonts hoje. Trocando pelo stack de sistema,
as duas liberações podem sair — o que é ganho de segurança. Mas **testar no
navegador antes de fechar**, porque CSP quebrada só aparece em runtime.

### Independência

Este bloco não toca em lógica de negócio, banco nem rotas. Pode rodar em qualquer
momento, em paralelo aos outros, e é o único que não exige o `smoke.js` verde —
exige olho no resultado e teste em celular real.

## Riscos e mitigações

| Risco | Impacto | Mitigação |
|---|---|---|
| **Aceite bloqueante trava 1.4k promotores no dia do piloto** | Alto | Ligar por env var (`LGPD_BLOQUEIA=1`). Sobe desligado, valida com um grupo pequeno, liga depois |
| **TTL da URL quebra ZIP grande no meio** | Médio | TTL de 1h + teste com lote realista de centenas de fotos, não com 3 |
| **Restringir `/api/reference` quebra o autocomplete** | Médio | Front e back na mesma leva; caso de smoke para cada perfil |
| **Buffer gzip trocado serve dado de admin p/ promotor** | **Alto** | Teste dedicado: logar como promotor e conferir que `promotores[]` não vem |
| **Anonimização quebra a aderência em silêncio** | 🔴 **Alto** | `promotorNorm` é join key *e* chave de contagem distinta. Congelar `grupoOficial` + gravar `participantesDistintos` **antes** da 1ª rodada. Falha sem erro na tela: números caem a zero e parecem reais |
| **"Anonimizar" que esquece o `uploadedBy`** | 🔴 **Alto** | Vira pseudonimização: um `$lookup` devolve o nome, o dado segue pessoal e a isenção do Art. 12 não vale. Caso de teste explícito |
| **Foto recusada nunca vira `baixado`, logo nunca expira** | Alto | Retenção por **idade**, não por status (Regra B) |
| **Equipe perde foto que ainda não baixou** | Médio | Escalonamento do 1.5.1 (30/45/53 dias) + rodar a exclusão em modo só-relatório na 1ª semana |
| **Alerta vira ruído e a equipe aprende a ignorar** | Médio | Recusada **fora** da lista de "não baixadas" (é estado terminal). Só duas listas, ambas acionáveis |
| **Foto de exposição antiga nasce vencida** | Médio | Relógio da retenção é `createdAt`, não `dataExposicao` (ver 1.5) |
| **Anonimização apaga o retorno que o promotor tem direito de ver** | Alto | `uploadedBy` e `observacao` só saem aos 6 meses, não aos 2 (1.5.2). Caso de teste: promotor enxerga a recusa com a imagem já apagada |
| **Motivo obrigatório trava a equipe no meio de um lote** | Baixo | Lista revisada + opção "Outro" com observação livre, para ninguém ficar preso |
| **Apagar foto de vencedor quebra a página de ranking** | Alto | Registro do pódio gravado na marcação, `ranking.html` com modo texto para edições passadas (1.5.3) |
| **Senha `celular+CPF` vira permanente** | ✅ Eliminado | Convite por e-mail substitui a senha derivada (1.7.2) |
| **Promotor sem e-mail fica trancado do lado de fora** | 🔴 **Alto** | Medir a cobertura de e-mail na base do Valoo **antes** de adotar o convite como caminho único |
| **1.400 e-mails de convite derrubam o SMTP** | Médio | Serviço transacional (Brevo/Resend) + envio em fila com retomada |
| **CPF armazenado sem necessidade** | Médio | Com o convite, não é mais necessário. Só importar se a operação justificar |
| **`retorno` sobra órfão ao excluir o titular** | Médio | O fluxo do 1.6 tem que apagar os retornos junto com a conta |
| **Reset acionado por engano apaga 1.400 contas** | 🔴 **Alto** | Só com crachá, confirmação por digitação, backup obrigatório antes, auditoria |
| **Backup vira passivo em vez de rede de segurança** | Médio | Expiração em 5 meses, URL assinada, restauração documentada e testada (1.8.2) |
| **Sem commits: nenhum ponto de retorno em 5 blocos** | Médio | Branch `reformulacao` com commit por bloco; `main` intocada até a aprovação final |
| **Conversão TS quebra o deploy do Discloud** | Médio | Só depois do piloto; atualizar `MAIN` e testar upload em app de staging |
| **`.bpmn` e Mermaid divergem** | Baixo | `.bpmn` declarado normativo; checklist na rotina de atualização |

---

## Ordem de execução sugerida

```
[1º] BPMN nº 1 ──▶ você revisa o layout ──▶ os outros 4 .bpmn
                                                  │
Bloco 0 ──▶ Bloco 1 ──▶ Bloco 2 ──▶ [ GO-LIVE / piloto ]
   │                                        │
   └── resto do Bloco 3 (docs .md) ◀───────┤ em paralelo
                                            │
       Bloco 4 fase 1 (JSDoc) ◀────────────┤ em paralelo
       Bloco 4 fases 2–3 ◀─────────────────┘ só depois do piloto estável
```

**Começa pelo BPMN**, por decisão sua — e é uma boa escolha por um motivo além do
seu: modelar os cinco processos obriga a desenhar o fluxo de retenção, de aceite e
de reset antes de escrever o código deles. Se algum estiver furado, o furo aparece
no diagrama, que é o lugar mais barato de consertar.

Você revisa o **primeiro** arquivo antes de eu gerar os outros quatro.

Blocos 3 e 4-fase-1 não tocam em comportamento de runtime — dá para tocá-los em
paralelo aos críticos sem risco de atrapalhar o go-live.

---

## Manifesto de arquivos

Consolidado de tudo que o plano toca. A coluna "Bloco" aponta para a seção que
explica o **porquê** e as armadilhas — este manifesto é índice, não substituto.

### Arquivos novos

| Arquivo | Bloco | Conteúdo |
|---|---|---|
| `docs/bpmn/01-envio-e-avaliacao.bpmn` | 3.2 | Pool Promotor + pool Equipe + externos como black-box |
| `docs/bpmn/02-cadastro-e-aprovacao.bpmn` | 3.2 | Sign up → fila → aprovação de promotor e grupo |
| `docs/bpmn/03-onboarding-de-contas.bpmn` | 3.2 | Importação → convite/provisória → primeiro acesso → aceite. Subprocesso: reset + backup (1.8) |
| `docs/bpmn/04-fechamento-do-lote.bpmn` | 3.2 | ZIP → Excel → marcar baixado → purge |
| `docs/bpmn/05-retencao-e-anonimizacao.bpmn` | 3.2 | Escalonamento 30/45/53 → imagem aos 2 meses → anonimização |
| `docs/bpmn/06-direitos-do-titular.bpmn` | 3.2 | Solicitação → identificação → exportar/anonimizar → resposta |
| `docs/09-lgpd.md` | 3.3 | **ROPA:** campo × finalidade × base legal × retenção × quem acessa |
| `public/politica-de-privacidade.html` | 1.1 | Servida na raiz (vale para o hub inteiro) |
| ~~`public/termos-de-uso.html`~~ | ~~1.1.1~~ | ❌ **Descartado** — já está no contrato dos promotores |
| ✅ `lib/tipos.js` | 4-f1 | `@typedef` JSDoc: `User`, `Submission`, `FiltroSubmissions`, `Permissao`, `Referencia` (+ `Imagem`, `Retorno`, `Institucionais`) |
| ✅ `lib/validar.js` | 4 | Validação de fronteira (sem dependência nova) |
| ✅ `jsconfig.json` | 4-f1 | `checkJs: true` + `typeAcquisition` (nenhuma dependência no `package.json`) |

### Arquivos editados

| Arquivo | Blocos | O que muda |
|---|---|---|
| `server.js` | 0, 1, 2 | Abortar boot se `SESSION_SECRET` for fallback · `GET /api/contato` (público) · portão de aceite no `requireAuth` · `GET /api/admin/alertas` (funde o `signup-count`) · `/api/reference` em **dois** buffers gzip · agendador diário de retenção · rotas de backup/reset/convite · ganchos de auditoria |
| `lib/db.js` | 0, 1 | Whitelist de `pontosExtra` · seed do admin via env · campos do `config` (D1) · `aceiteVersao`/`aceiteEm` · coleções `auditoria`, `retorno`, `ranking` · anonimização · retenção · `grupoOficial` congelado · `participantesDistintos` · retornos apagados junto com o titular |
| `lib/storage.js` | 1.8, 2.2 | URL com expiração (1h) · upload/download do backup |
| `lib/mailer.js` | 1.7.2 | Template de convite (token de 7 dias) |
| `public/pdv/cadastro.html` | 1.2 | Checkbox de aceite + link para a política |
| `public/pdv/promotor.html` | 1.3, 1.5.2 | Aviso de coleta · exibir `motivoRecusa` (**hoje só mostra a observação**) · histórico de retornos |
| `public/pdv/admin.html` | 1.0, 1.5.1, 1.5.2, 1.8 | Campos institucionais na aba Listas · banner de escalonamento · motivo obrigatório ao recusar · três botões destrutivos |
| `public/pdv/ranking.html` | 1.5.3 | Modo quadro de honra para edições passadas |
| ✅ `public/index.html`, `public/pdv/login.html` | 1.1, 5 | Link da política no rodapé — **tinha ficado de fora do Bloco 1**; entrou junto com a capa |
| ✅ `public/index.html` + `public/style.css` | 5 | Capa com estética de vidro (`.theme-dark.capa`) |
| ✅ as 14 páginas de `public/` + `common.js` | 5 | Estética estendida a todas as telas: `.theme-dark` no `<body>`, tokens `-fill` separados dos de marca |
| `test/smoke.js` | todos | Casos novos — ver "Definição de pronto" |
| `test/pentest.js` | 0, 2 | Whitelist de `pontosExtra` · promotor **não** recebe `promotores[]` |
| `docs/01`…`08` + `docs/README.md` | 3.3 | Defasagem: 13 endpoints, coleções, índices, módulos `pdp`/`rca` |

### Casos de teste obrigatórios (adicionar ao `smoke.js`)

Estes cobrem exatamente as armadilhas ⚠️ do plano. **Nenhum bloco fecha sem eles.**

1. Aceite pendente bloqueia a API; aceite dado libera.
2. Promotor loga e `/api/reference` **não** traz `promotores[]`; admin traz.
   *(pega a troca de buffer gzip — a falha mais perigosa do Bloco 2)*
2b. Promotor tenta enviar com `promotor: "Outra Pessoa"` no corpo → a submissão é
   gravada com o nome **da sessão**, não com o do corpo. *(fecha o furo de
   integridade e o bypass de cota do 2.1)*
2c. Promotor chama `/api/check-promotor` → 403.
3. Anonimização limpa `uploadedBy`; um `$lookup` não devolve o nome.
4. Após anonimizar, a aderência por grupo **continua** batendo (`grupoOficial`).
5. Promotor enxerga a recusa com a imagem já apagada (`retorno`).
6. Excluir titular apaga os `retorno` dele junto.
7. Ranking de edição passada renderiza sem imagem quebrada.
8. Auditoria grava no download de ZIP e no reset.
9. Reset **aborta** se o backup falhar.
10. Importação sem e-mail cai na senha provisória e aparece separada no resultado.
11. **(Bloco 4)** Operador do Mongo no corpo do envio é recusado na borda com 400.
12. **(Bloco 4)** Data que passa no formato mas não existe (`2026-02-31`) é recusada.
13. **(Bloco 4)** Campo fora do esquema é **ignorado em silêncio**, não aceito nem erro —
    `baixado`/`validado`/`pago`/`createdAt` continuam vindo do servidor.
14. **(Bloco 4)** PATCH parcial não apaga o que não foi mandado (a pré-avaliação não leva
    o `motivoRecusa` junto).
15. **(Bloco 4)** O painel aceita login interno sem ponto no domínio; o cadastro público não.

## Definição de pronto

Um bloco só está fechado quando:

1. `node test/smoke.js` verde — **banco de teste limpo e servidor recém-reiniciado**
   (o smoke troca a senha do `joao@local` e as falhas de login propositais estouram
   o rate-limit em rodadas repetidas).
2. `node test/pentest.js` verde.
3. Casos novos do bloco adicionados ao smoke — não só os antigos passando.
4. Docs de `docs/` atualizados junto, no mesmo commit. Foi assim que a defasagem
   atual nasceu: código numa velocidade, doc noutra.
5. Commit no branch `reformulacao-lgpd` (o merge na `main` é decisão do dono, no
   fim de tudo).

---

## Encerramento — o que fazer ao terminar

Quando os cinco blocos estiverem fechados:

1. **Absorver este documento nos docs permanentes.** O `PLANO.md` é temporal — as
   decisões vão para `02` (modelo de dados), `04` (fluxos), `07` (segurança) e
   `09` (LGPD). Depois disso ele pode ser apagado.
2. **Avisar a equipe das mudanças de comportamento**, que não são óbvias olhando a
   tela: o motivo da recusa agora é visível ao promotor; recusar sem motivo deixou
   de ser possível; o top-10 de recusas só enxerga 2 meses; edições passadas do
   ranking não têm mais foto; "Excluir foto" tira a justificativa do promotor,
   ao contrário da expiração automática.
3. **Rodar a retenção em modo só-relatório na primeira semana** e conferir a lista
   antes de ligar a exclusão de verdade.
4. **Confirmar que a política foi revisada** pela T.I. / especialista antes de
   publicar. O que este plano produz é minuta.
