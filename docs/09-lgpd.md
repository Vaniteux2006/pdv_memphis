# 09 — LGPD: Registro de Operações de Tratamento (ROPA)

> **O que é este documento.** A LGPD (Art. 37) obriga o controlador a manter registro das
> operações de tratamento de dados pessoais. É o documento que uma auditoria pede primeiro,
> e é o que torna a [política de privacidade](../public/politica-de-privacidade.html)
> **verificável** em vez de decorativa: aqui está, campo a campo, o que o sistema faz.
>
> Público-alvo: T.I., jurídico e quem for auditar. Escrito para ser lido sem abrir o código.

**Controlador:** Memphis S.A. Industrial · CNPJ 92.697.010/0001-46
**Encarregado (DPO) e demais dados institucionais:** ficam no `config` e são servidos por
`GET /api/contato` — **não estão cravados neste documento nem no código**, justamente para
que trocar o encarregado não dependa de um deploy.

---

## 1. Finalidade e base legal

| Item | Valor |
|---|---|
| **Finalidade** | Operar a campanha de Pesquisa de Ponto de Venda: receber e avaliar as fotos, apurar pagamentos, montar rankings e medir participação por grupo e região. |
| **Base legal** | **Execução de contrato** (Art. 7º, V) + **legítimo interesse** na gestão e auditoria da campanha (Art. 7º, IX). |
| **Uso das imagens** | **Exclusivamente interno.** Nenhuma foto vai para marketing, redes sociais ou terceiros. |

> ⚠️ **Não é consentimento, e isso é deliberado.** Consentimento, na lei, precisa ser
> **livre**: o titular teria que poder recusar e seguir participando. Como enviar a foto é a
> própria atividade contratada, um "consentimento" aqui seria **inválido**. Declarar a base
> errada é pior do que não declarar.
>
> A T.I. confirmou (ago/2026) que quem assina o contrato tem ciência de que a Memphis pode
> pedir dados. Isso **reforça** a base escolhida — mas **não substitui** o dever de informar
> do Art. 9º, que é o papel da política de privacidade.

---

## 2. Dados tratados, por campo

Legenda de acesso: **P** = o próprio titular · **E** = equipe conforme permissão · **T** = acesso total (crachá)

### 2.1 Cadastro (`users`)

| Campo | Finalidade | Retenção | Quem acessa |
|---|---|---|---|
| `name` | Identificar quem enviou; atribuir pagamento e ranking | Enquanto a conta existir | P, E (`contas`) |
| `email` | Login, convite de acesso, redefinição de senha | Enquanto a conta existir | P, E (`contas`) |
| `telefone` | Contato operacional da campanha | Enquanto a conta existir | P, E (`contas`) |
| `avatar` (foto de perfil no Cloudinary, **opcional**) | Identificação visual na própria conta e na capa | Enquanto a conta existir — sai junto na exclusão, na exclusão completa do titular e no reset | P (a própria); ninguém mais a vê |
| `grupo`, `regiao`, `setor`, `matricula` | Recortes de gestão da campanha | Enquanto a conta existir | P, E (`contas`) |
| `passwordHash` | Autenticação | Enquanto a conta existir | — (ninguém lê; **bcrypt**, nunca em texto) |
| `resetTokenHash` + `resetTokenExp` | Redefinição de senha / convite | 1h (reset) ou 7 dias (convite), **uso único** | — (só o sha256 é guardado) |
| `aceiteVersao`, `aceiteEm` | Provar o aceite da política e sua versão | Enquanto a conta existir | E (`contas`) |
| `conviteEnviadoEm` | Saber quem já recebeu convite (permite retomar o envio) | Enquanto a conta existir | E (`contas`) |

> **CPF/CNPJ não é coletado.** Não entra na importação, não está no modelo de planilha e
> não existe no banco. Com o convite por e-mail, o sistema não precisa dele para nada.
>
> **Princípio que fica valendo:** ou o campo é **necessário** (e se justifica pela
> finalidade, sob base contratual), ou **não entra**. Campo "opcional, se o titular quiser
> ceder" mudaria a base daquele campo para **consentimento** — que exige prova do aceite,
> revogação a qualquer momento e o sistema funcionando sem o dado depois.

### 2.2 Fotos e envios (`submissions`)

| Campo | Finalidade | Retenção | Quem acessa |
|---|---|---|---|
| `imagens[]` (arquivo no Cloudinary) | Avaliar a exposição | **2 meses** após o envio | P (as próprias), E (`fotos`) |
| `promotor`, `promotorNorm` | Atribuir a foto a uma pessoa | **2 meses** (anonimização) | P, E (`fotos`) |
| `uploadedBy`, `uploadedByEmail` | Vincular a foto à conta | `uploadedByEmail` aos 2 meses; **`uploadedBy` aos 6** | E (`fotos`) |
| `endereco` da loja | Localizar a exposição avaliada | **2 meses** | P, E (`fotos`) |
| `dataExposicao` | Eixo temporal; travas de 1/semana e 4/mês | Indefinida (anonimizado) | P, E |
| `cliente` | Identificar o estabelecimento; top-10 de clientes | Indefinida (anonimizado) | P, E |
| `regiao`, `grupo`, `grupoOficial` | Recortes de gestão | Indefinida (anonimizado) | E |
| `validado`, `preAvaliacao`, `pontosExtra`, `pago` | Métricas de qualidade e pagamento | Indefinida (anonimizado) | P, E (`fotos`) |
| `motivoRecusa` | Explicar a recusa ao titular | Indefinida (lista controlada, sem texto livre) | P, E (`fotos`) |
| `observacao` | Detalhe da avaliação | **6 meses** | P, E (`fotos`) |
| `searchBlob` | Busca acento-insensível (concatena nome + endereço) | **2 meses** | E (`fotos`) |

> ⚠️ **Endereço + data formam rastro de localização.** Somados ao longo do tempo, dizem
> onde a pessoa esteve trabalhando. Por isso os dois são tratados com o cuidado de dado
> sensível: acesso restrito à equipe da campanha e eliminação no prazo curto.

> ⚠️ **Risco residual declarado — o campo `cliente` sobrevive à anonimização.** A carteira
> inclui **MEI e CPF**, então um "cliente" pode carregar o nome de uma pessoa física
> ("Mercado do João Silva"). Nesse caso o registro anonimizado fica **quase** anônimo: sem o
> promotor, mas com o nome do lojista.
> **Decisão adotada (D2 do plano):** manter o nome, porque nome de estabelecimento é
> identificador comercial público (está na fachada) e o registro já não tem o promotor.
> **Alternativa, se a T.I. preferir:** trocar por um código de cliente na anonimização,
> usando `refdata.clientes` como tabela de correspondência. É migração simples.

### 2.3 Retorno da recusa (`retorno`)

| Campo | Finalidade | Retenção | Quem acessa |
|---|---|---|---|
| `userId`, `semanaKey`, `cliente`, `motivoRecusa`, `observacao` | Dar ao titular o histórico da **própria** participação e o motivo de cada recusa | **Enquanto a conta existir** | P (só o próprio) |

> **Por que existe uma coleção separada.** Anonimizar a submissão aos 2 meses e "mostrar o
> motivo para sempre" querem coisas **opostas do mesmo documento**. Tirando o retorno de
> dentro da submissão, os dois prazos convivem.
>
> **"Enquanto a conta existir" não é prazo arbitrário:** a finalidade (dar ao titular o
> histórico da própria participação) dura enquanto dura a relação — que é literalmente o
> critério do Art. 15. Quando o titular é excluído ou anonimizado, **o retorno vai junto**.

### 2.4 Pódio (`ranking`)

| Campo | Finalidade | Retenção | Quem acessa |
|---|---|---|---|
| `promotor`, `grupo`, `regiao`, `cliente`, `posicao`, `mesKey` | Quadro de honra da campanha | **Indefinida** | Qualquer usuário logado |

> ⚠️ **O nome do vencedor fica indefinidamente e é dado pessoal**, visível a ~1.400 pessoas.
> É a **única exceção consciente** à diretriz "ninguém vê o nome de ninguém". Continua
> legítimo — premiação divulgada é finalidade própria — mas **está declarado na política**,
> e o titular que pedir exclusão sai do quadro (vira `[removido]`).

### 2.5 Auditoria (`auditoria`)

| Campo | Finalidade | Retenção | Quem acessa |
|---|---|---|---|
| `ts`, `userId`, `userNome`, `userEmail`, `acao`, `alvo`, `qtd`, `ip` | Registro de acesso a dado pessoal (Art. 37) | **12 meses** (índice TTL) | **T** (acesso total) |

> Registra **só evento sensível** — baixar, exportar, apagar, mexer em conta, gerar/usar
> crachá, rodar retenção. Auditar toda requisição viraria o gargalo do Atlas M0 e afogaria o
> que importa em ruído.
>
> A leitura exige **acesso total**, não a permissão `contas`: é a trilha de quem acessou o
> quê, e abri-la a qualquer admin daria a cada um o rastro de todos os outros.

### 2.6 Correções de cadastro (`correcoes`) e presença (`presenca`)

| Coleção | Finalidade | Retenção | Quem acessa |
|---|---|---|---|
| `correcoes` | Pedido do titular para corrigir o próprio cadastro (Art. 18, III) | Até ser resolvido | E (`contas`) |
| `presenca` | Avisar qual avaliador está em qual foto (evita trabalho duplicado) | **2 minutos** (índice TTL) | E (`fotos`) |

### 2.7 Backups

| Item | Finalidade | Retenção | Quem acessa |
|---|---|---|---|
| Dump de `users`, `promotores`, `refdata`, `config` | Recuperação após falha ou reset acidental | **5 meses**, com expiração automática | **T** (acesso total) |

> ⚠️ **O backup é dado pessoal** — não é arquivo neutro, é a base inteira de pessoas.
> Entregue sempre por **URL que expira**, e apagado sozinho na rotina diária.
>
> **Conflito com o direito de eliminação, declarado:** se um titular pedir exclusão e
> existir backup com os dados dele, não dá para "apagar do backup" sem corromper o arquivo.
> Prática adotada e informada na política: backups **não são usados para reprocessar
> dados** e expiram sozinhos no prazo declarado.

---

## 3. Retenção — a régua, e por que ela é assim

Nenhuma lei fixa prazo. Os Arts. 15 e 16 mandam eliminar quando a finalidade se esgota —
**quem escolhe o prazo é o controlador**, e a obrigação é declarar e cumprir.

O site existe para **substituir o WhatsApp** como canal de envio, não para ser arquivo: a
equipe baixa o lote para o servidor interno, e é lá que a foto vive a longo prazo. Prazo
curto é, aqui, **vantagem de conformidade** — menos dado parado, menos superfície.

| Artefato | Prazo | Contado de |
|---|---|---|
| Imagem no Cloudinary | **2 meses** | `createdAt` (envio) |
| Vínculo com a pessoa (`promotor`, `endereco`, `searchBlob`) | **2 meses** | `createdAt` |
| Identidade residual (`uploadedBy`, `observacao`) | **6 meses** | `createdAt` |
| Registro anonimizado | Indefinido | — |
| Retorno da recusa | Enquanto a conta existir | — |
| Auditoria | 12 meses | evento |
| Backup | 5 meses | geração |

> ⏱️ **O relógio é `createdAt`, não `dataExposicao`** — e a diferença importa. O titular pode
> enviar hoje a foto de uma exposição de 2,5 meses atrás (o campo é digitado por ele).
> Contada pela exposição, essa foto **nasceria vencida**: apagada antes de qualquer pessoa
> ter a chance de olhar. Contada pela entrada, todo mundo tem os mesmos 2 meses.

> **A régua vale por IDADE, não por status.** Baixada, não baixada, aprovada, recusada ou
> nunca avaliada — 2 meses e acabou. Sem exceção nem para foto vencedora de ranking (o que
> sobrevive é o registro do pódio, em texto). Uma régua só é mais fácil de declarar e de
> auditar — e evita o pior desfecho possível, que seria a política dizer "2 meses" enquanto
> o dado mais sensível, o das recusadas, fosse o único a nunca expirar.

---

## 4. O que é anonimização aqui (e o que **não** é)

Aos 2 meses o sistema **apaga a imagem** e **anonimiza o documento**, em vez de apagá-lo:
`aderencia()` e `serie()` continuam agregando exatamente como antes — zero mudança no código
dos gráficos — e a granularidade fica preservada.

> 🔴 **O campo mais fácil de esquecer é o `uploadedBy`.** Sem removê-lo, "anonimizar" vira
> **pseudo**nimizar: um `$lookup` devolve o nome num passo, o dado continua sendo pessoal e a
> isenção do Art. 12 **não se aplica**. Há caso de teste explícito para isso
> (`test/retencao.js`): depois da anonimização, um `$lookup` **não** devolve o nome.

**Duas coisas são congeladas ANTES de limpar** — invertendo a ordem, o dado se perde sem
reconstrução possível:

| O quê | Por quê |
|---|---|
| `grupoOficial` | A aderência descobre o grupo por `$lookup` de `promotorNorm`. Sem congelar, a participação por grupo **zera em silêncio**, com números que parecem reais. |
| `participantesDistintos` (mês × grupo) | Contar "quantas **pessoas** participaram" exige identidade, e nenhum campo residual substitui isso. |

**Limitação aceita e documentada:** o top-10 "quem mais leva recusa" agrupa por promotor e
passa a enxergar **só os últimos 2 meses**. Isso é um ranking de desempenho individual —
mantê-lo sobre dados antigos seria exatamente o perfilamento prolongado que a retenção curta
existe para impedir. Aqui a limitação **é** a funcionalidade correta; vale avisar a equipe
para não parecer bug.

---

## 5. Compartilhamento e transferência internacional (Art. 33)

| Fornecedor | O que armazena | País |
|---|---|---|
| **MongoDB Atlas** | Cadastro e metadados das fotos | Fora do Brasil |
| **Cloudinary** | As imagens e os backups | Fora do Brasil |
| **Provedor de SMTP** | Envio de convites e redefinição de senha | Fora do Brasil |
| **Discloud** | Hospedagem da aplicação | Fora do Brasil |
| **Valoo** | Processamento dos pagamentos da campanha | Brasil |

> **Origem dos dados (Art. 9º).** Parte das contas nasce de dados cedidos pelo **Valoo**, e
> não do próprio titular — que por isso tem direito de saber de onde vieram. Está na
> política.
>
> ⚠️ **Pendência para a revisão da T.I.:** o repasse Valoo → Memphis precisa de **base legal
> própria**, normalmente uma cláusula no contrato entre as duas empresas. Não é bloqueio
> técnico, mas é o primeiro item que um especialista vai levantar.

---

## 6. Direitos do titular (Art. 18) — como o sistema atende

| Direito | Como | Rota |
|---|---|---|
| Confirmação e **acesso** | Exportação em JSON: cadastro, submissões, retornos e pódios | `GET /api/admin/users/:id/dados` |
| **Correção** | Fila de pedidos; quem corrige o cadastro é a equipe | `POST /api/my/correcao-cadastro` |
| **Anonimização / eliminação** | Anonimizar é o padrão (preserva os números); exclusão completa exige acesso total | `POST /api/admin/users/:id/anonimizar` |
| **Portabilidade** | O mesmo JSON da exportação | idem |
| **Informação sobre compartilhamento** | Seção 5 deste documento + política | — |
| Revisão de decisão automatizada | **Não se aplica:** toda avaliação é humana | — |

Toda ação sobre dados do titular vai para a **auditoria**. O processo completo está desenhado
em [`bpmn/06-direitos-do-titular.bpmn`](bpmn/06-direitos-do-titular.bpmn).

---

## 7. Medidas de segurança (Art. 46)

Detalhe em [07 — Segurança](07-seguranca.md). Em resumo: senhas em **bcrypt**; sessão por
**JWT `httpOnly`**; imagens **não públicas** (URL assinada, e a do manifesto **expira**);
**permissões granulares** por função com acesso total só via crachá; **checagem de origem**
contra CSRF; rate-limit; e o promotor **não enxerga dados de colegas** (Bloco 2).

Como **não há CPF nem documento** no banco, as medidas ficam proporcionais ao dado tratado —
sem necessidade de criptografia em nível de campo.

---

## 8. Pendências desta versão

| Item | Responsável |
|---|---|
| **Revisão da política pela T.I. / especialista** — o que existe hoje é **minuta**, e por isso ainda não está linkada no site | T.I. |
| Verificar a cláusula do contrato **Valoo ↔ Memphis** que cobre o repasse | T.I. / jurídico |
| Rodar a retenção em **modo só-relatório** por uma semana antes de ligar a exclusão (`RETENCAO_APAGA=1`) | Equipe |
| Decidir sobre o **risco residual do campo `cliente`** (seção 2.2) | T.I. |
