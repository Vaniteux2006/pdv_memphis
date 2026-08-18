# 04 — Fluxos de Negócio (BPMN)

> **Artefatos normativos:** os processos existem em BPMN 2.0 de verdade em
> [`docs/bpmn/`](bpmn/) (Camunda Modeler / bpmn.io). Em divergência com o Mermaid
> desta página, **vale o `.bpmn`**.
>
> | Arquivo | Processo |
> |---|---|
> | [01-envio-e-avaliacao](bpmn/01-envio-e-avaliacao.bpmn) | Ponta a ponta: pool Promotor, pool Equipe, Cloudinary/Mongo como black-box |
> | [02-cadastro-e-aprovacao](bpmn/02-cadastro-e-aprovacao.bpmn) | Sign up → fila de pendentes → aprovação de conta, promotor e grupo |
> | [03-onboarding-de-contas](bpmn/03-onboarding-de-contas.bpmn) | Importação → convite por e-mail / provisória → 1º acesso → aceite. Subprocesso: reset + backup |
> | [04-fechamento-do-lote](bpmn/04-fechamento-do-lote.bpmn) | ZIP → Excel → marcar baixado → purge |
> | [05-retencao-e-anonimizacao](bpmn/05-retencao-e-anonimizacao.bpmn) | Os três relógios: escalonamento 30/45/53 → imagem aos 2 meses → identidade aos 6 |
> | [06-direitos-do-titular](bpmn/06-direitos-do-titular.bpmn) | Solicitação → identificação → exportar ou anonimizar → resposta |
>
> Os `.bpmn` de **03**, **05** e **06** desenham o processo-**alvo** do plano LGPD
> (`docs/PLANO.md`), que ainda está sendo implementado — os demais espelham o que já roda.

## Processo ponta-a-ponta

Da foto no campo ao relatório, com as raias dos dois papéis e dos sistemas externos.

```mermaid
flowchart TD
  subgraph Promotor
    A1([Início]) --> A2["Loga no app"]
    A2 --> A2b{"Senha<br/>provisória?"}
    A2b -- Sim --> A2c["Troca obrigatória<br/>(trocar-senha.html)"]
    A2b -- Não --> A3
    A2c --> A3["Confere senha mensal/semanal e data de hoje"]
    A3 --> A4["Preenche cliente, endereço, região, grupo, nome"]
    A4 --> A5{"Nome existe<br/>no banco?"}
    A5 -- Não --> A6["Cadastra novo nome<br/>(vai p/ aprovação)"]
    A5 -- Sim --> A7
    A6 --> A7["Seleciona a foto<br/>(1 ou 2 imagens = antes e depois)"]
    A7 --> A8["Imagens sobem direto pro Cloudinary"]
    A8 --> A9["Registra metadados no servidor<br/>(trava: 1/semana, 4/mês)"]
  end

  subgraph Equipe["Equipe (Admin)"]
    B1["Busca/filtra fotos"] --> B2["Avalia: pré-avaliação<br/>+ pontos extra"]
    B2 --> B3{"Validar?"}
    B3 -- Sim --> B4["Marca Validada"]
    B3 -- Não --> B5["Marca Recusada<br/>+ observação"]
    B4 --> B6{"Pago pelo<br/>financeiro?"}
    B5 --> B7
    B6 -- Sim --> B8["Marca Pago"]
    B6 -- Não --> B7
    B8 --> B7["Baixa ZIP por região<br/>(montado no navegador)"]
    B7 --> B9["Exporta Excel<br/>(molde oficial)"]
    B9 --> B10["Limpa (purge) os já baixados"]
    B10 --> B11([Fim do lote])
  end

  A9 --> B1
```

## Subprocesso: aprovação de promotor e grupo novos

A fila de pendentes tem **dois tipos**: nomes de promotor (cadastrados pelo promotor
na hora do envio) e **grupos** (um grupo digitado que não está na lista oficial entra
na fila automaticamente junto com o envio).

```mermaid
flowchart LR
  P1["Promotor cadastra nome novo<br/>ou envia com grupo desconhecido"] --> Q[("Fila: pendentes<br/>(tipo: promotor | grupo)")]
  Q --> AD{"Admin revisa<br/>(permissão 'aprovar')"}
  AD -- Aprova --> BANCO[("promotores (banco oficial)<br/>ou refdata.grupos")]
  AD -- Rejeita --> X["Remove da fila"]
  BANCO --> OK["Próximos envios<br/>aparecem 'no banco'"]
```

## Subprocesso: moderação de promotor (banir)

```mermaid
flowchart LR
  S1["Promotor abusando"] --> S2{"Admin decide"}
  S2 -- Banir --> S3["active = false"]
  S3 --> S4["Login bloqueado<br/>+ requisições caem em 401"]
  S2 -- Reativar --> S5["active = true"]
```

## Subprocesso: contas em massa por planilha

```mermaid
flowchart LR
  E1["Admin envia .xlsx<br/>(Nome, E-mail, ...)"] --> E2{"E-mail já<br/>cadastrado?"}
  E2 -- Não --> E3["Cria conta SEM senha utilizável<br/>+ convite por e-mail (7 dias)<br/>ou senha aleatória se não houver e-mail"]
  E2 -- Sim --> E4["Atualiza só o perfil<br/>(não mexe na senha)"]
  E3 --> E5["Resumo na tela + CSV<br/>com as senhas provisórias"]
  E4 --> E5
```

## Ciclo de vida da submissão (foto)

O **armazenamento** segue um caminho sequencial (Nova → Baixada → Removida).
As **avaliações** são atributos independentes aplicados enquanto a foto está ativa.

```mermaid
stateDiagram-v2
  [*] --> Nova : promotor envia (imagens no Cloudinary + metadados no Mongo)
  Nova --> Baixada : incluída em um ZIP (markDownloaded)
  Baixada --> Removida : purge (apaga Mongo + Cloudinary)
  Nova --> Removida : exclusão individual pelo admin
  Removida --> [*]

  state "Atributos de avaliação (independentes, enquanto ativa)" as Aval {
    direction LR
    [*] --> preAvaliacao : REGULAR/BOM/EXCELENTE
    [*] --> pontosExtra : Ilha/Display/Gôndola/Cross/Antes e depois/Grande volume
    [*] --> validado : Validada / Recusada
    [*] --> pago : pago pelo financeiro
  }
```

> **Importante:** `validado`, `pago`, `preAvaliacao` e `pontosExtra` são flags
> **independentes** — uma foto pode estar "validada" sem estar "paga", "paga" sem
> "baixada", etc. O único estado sequencial real é `baixado` → `purge`.

## Regras de negócio principais

| Regra | Onde | Detalhe |
|-------|------|---------|
| **1 foto/semana e 4 fotos/mês** por promotor | `/api/submissions` | Contadas pela **data da exposição** (`semanaKey`/`mesKey`), não pela data do envio. |
| 1 foto = até **2 imagens** ("antes e depois") | `/api/submissions` | As 2 imagens contam como **1 foto** nos limites. |
| Senhas **carimbadas pelo servidor** | `/api/submissions` | Vêm de `config` no momento do envio — o promotor não digita. |
| Checagem de promotor | `/api/check-promotor` | Compara nome normalizado (sem acento/maiúsculas) com o banco oficial. |
| Grupo é do **promotor** | envio | A equipe não edita grupo; grupo novo vai pra fila de aprovação. |
| Baixar **não apaga** | `mark-downloaded` | Só marca `baixado=true`. A remoção é uma ação separada e explícita (`purge` ou exclusão individual). |
| Foto **recusada não é baixada** | `/api/admin/download-manifest` | `validado === false` fica de fora do ZIP. Ao validar, volta a ser baixável. |
| **Motivo obrigatório ao recusar** | `updateSubmission` | O promotor **vê** o motivo na tela dele; recusar sem um deixaria só "Recusada" sem explicação — que é a queixa que originou a mudança. A lista tem **"Outros"** como escape, então ninguém fica preso no meio de um lote. |
| Pasta do ZIP = "COLAR EM PASTAS" | `/api/admin/download-manifest` | `Região / "REF - Cliente - Promotor"`, espelhando o servidor interno. |
| Senha provisória exige troca | login → `trocar-senha.html` | Contas criadas em massa/por planilha e senhas redefinidas pelo admin nascem com `mustChangePassword`. |
| Senha **"0"** = primeiro acesso | login → `trocar-senha.html?primeiro=1` | A pessoa entra com `0` e cai numa tela de **boas-vindas** pra criar a própria senha (sem digitar a provisória). Vale na planilha e na criação manual. |
| Admin é protegido | `setUserActive` / `deleteUser` | Não pode ser banido nem excluído. |
| Permissões granulares no painel | `requirePerm` | Cada aba/ação exige `fotos`/`aprovar`/`contas`/`listas`/`aderencia`; acesso total (`*`) só via crachá. |
