# 04 — Fluxos de Negócio (BPMN)

## Processo ponta-a-ponta

Da foto no campo ao relatório, com as raias dos dois papéis e dos sistemas externos.

```mermaid
flowchart TD
  subgraph Promotor
    A1([Início]) --> A2["Loga no app"]
    A2 --> A3["Confere senha mensal/semanal e data de hoje"]
    A3 --> A4["Preenche cliente, endereço, região, grupo, nome"]
    A4 --> A5{"Nome existe<br/>no banco?"}
    A5 -- Não --> A6["Cadastra novo nome<br/>(vai p/ aprovação)"]
    A5 -- Sim --> A7
    A6 --> A7["Seleciona até 2 fotos"]
    A7 --> A8["Fotos sobem direto pro Cloudinary"]
    A8 --> A9["Registra metadados no servidor"]
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
    B8 --> B7["Baixa ZIP por região"]
    B7 --> B9["Exporta Excel"]
    B9 --> B10["Limpa (purge) os já baixados"]
    B10 --> B11([Fim do lote])
  end

  A9 --> B1
```

## Subprocesso: aprovação de promotor novo

```mermaid
flowchart LR
  P1["Promotor cadastra<br/>nome novo"] --> Q[("Fila: pendentes")]
  Q --> AD{"Admin revisa"}
  AD -- Aprova --> BANCO[("promotores<br/>(banco oficial)")]
  AD -- Rejeita --> X["Remove da fila"]
  BANCO --> OK["Próximos envios desse nome<br/>aparecem 'no banco'"]
```

## Subprocesso: moderação de promotor (banir)

```mermaid
flowchart LR
  S1["Promotor abusando"] --> S2{"Admin decide"}
  S2 -- Banir --> S3["active = false"]
  S3 --> S4["Login bloqueado<br/>+ requisições caem em 401"]
  S2 -- Reativar --> S5["active = true"]
```

## Ciclo de vida da submissão (foto)

O **armazenamento** segue um caminho sequencial (Nova → Baixada → Removida).
As **avaliações** são atributos independentes aplicados enquanto a foto está ativa.

```mermaid
stateDiagram-v2
  [*] --> Nova : promotor envia (foto no Cloudinary + metadados no Mongo)
  Nova --> Baixada : incluída em um ZIP (markDownloaded)
  Baixada --> Removida : purge (apaga Mongo + Cloudinary)
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
| Máximo **2 fotos por cliente** | `/api/submissions` | Conta o que o promotor já enviou pra aquele cliente (`countByPromotorCliente`). |
| Senhas **carimbadas pelo servidor** | `/api/submissions` | Vêm de `config` no momento do envio — o promotor não digita. |
| Checagem de promotor | `/api/check-promotor` | Compara nome normalizado (sem acento/maiúsculas) com o banco oficial. |
| Grupo é do **promotor** | envio | A equipe não edita grupo (decisão de negócio). |
| Baixar **não apaga** | `/api/admin/download` | Só marca `baixado=true`. A remoção é uma ação separada e explícita (`purge`). |
| Foto **recusada não é baixada** | `/api/admin/download-manifest` | `validado === false` fica de fora do ZIP. Ao validar, volta a ser baixável. |
| Pasta do ZIP = "COLAR EM PASTAS" | `/api/admin/download` | `Região / "REF - Cliente - Promotor"`, espelhando o servidor interno. |
| Admin é protegido | `setUserActive` / `deleteUser` | Não pode ser banido nem excluído. |
