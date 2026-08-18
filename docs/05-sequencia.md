# 05 — Diagramas de Sequência (UML)

## Login (JWT)

```mermaid
sequenceDiagram
  actor U as Usuário
  participant S as Servidor (Express)
  participant DB as MongoDB
  U->>S: POST /api/login { email, senha }
  S->>DB: findUserByEmail(email)
  DB-->>S: usuário { passwordHash, active, role }
  alt inativo ou senha errada
    S-->>U: 401 { error }  (rate-limit: 10 falhas/15min)
  else ok
    S->>S: jwt.sign({ uid, role })
    S-->>U: 200 { role, name, mustChangePassword } + Set-Cookie: mp_token (httpOnly)
  end
  Note over U,S: Se mustChangePassword=true, o front leva pra trocar-senha.html<br/>antes de liberar o app (senha provisória).
  Note over U,S: Requisições seguintes mandam o cookie.<br/>requireAuth verifica o JWT e revalida 'active' no Mongo;<br/>rotas /api/admin/* ainda passam pelo requirePerm (permissão granular).
```

## Envio de foto (upload direto, assinado)

```mermaid
sequenceDiagram
  actor Pr as Promotor (navegador)
  participant S as Servidor
  participant Cl as Cloudinary
  participant DB as MongoDB

  Pr->>S: GET /api/upload-signature?tipo=fotos
  S->>S: assina { folder, timestamp, type } com o api_secret
  S-->>Pr: { signature, timestamp, apiKey, cloudName, folder, type }

  loop cada imagem (1 ou 2 = "antes e depois", comprimida no navegador)
    Pr->>Cl: POST /image/upload (file + assinatura)
    Cl-->>Pr: { public_id, resource_type }
  end

  Pr->>S: POST /api/submissions { metadados, fotos:[public_id...] }
  S->>S: valida campos + prefixo da pasta
  S->>DB: trava por data de exposição: 1 foto/semana, 4/mês
  S->>DB: getConfig() (senhas atuais)
  S->>DB: promotorExiste(nome)
  S->>DB: addSubmission(...)  (1 submissão com o array de imagens)
  S->>DB: grupo novo? addPendente(grupo) (fila de aprovação)
  S-->>Pr: 200 { ok, count }
  Note over S,Cl: Se a validação falhar, o servidor apaga<br/>as fotos órfãs do Cloudinary.
```

> O arquivo **nunca passa pelo servidor** — vai do navegador direto pro Cloudinary.
> Isso elimina o limite de corpo das funções serverless e descarrega o upload.

## Servir uma foto (entrega autenticada)

```mermaid
sequenceDiagram
  actor V as Visualizador
  participant S as Servidor
  participant Cl as Cloudinary
  V->>S: GET /api/file/:id (cookie)
  S->>S: checa permissão (admin ou dono)
  S->>S: gera URL assinada (type=authenticated)
  S-->>V: 302 Location: URL assinada
  V->>Cl: GET URL assinada
  Cl-->>V: bytes da imagem
  Note over V,Cl: URL sem assinatura → 401 (a foto não é pública)
```

## Download em ZIP (montado no navegador)

```mermaid
sequenceDiagram
  actor Ad as Admin (navegador)
  participant S as Servidor
  participant DB as MongoDB
  participant Cl as Cloudinary
  Ad->>S: GET /api/admin/download-manifest?onlyNew=1
  S->>DB: listSubmissions(status=novos)
  S-->>Ad: { items:[{ id, url assinada, path }] }
  loop cada foto
    Ad->>Cl: GET url assinada (CORS *)
    Cl-->>Ad: bytes
    Ad->>Ad: JSZip.file("Região/REF-Cliente-Promotor/foto.jpg", bytes)
  end
  Ad->>Ad: zip.generateAsync() + salva o .zip
  Ad->>S: POST /api/admin/mark-downloaded { ids }
  S->>DB: markDownloaded(ids)
  S-->>Ad: { ok }
  Note over Ad: O servidor não monta o ZIP — sem timeout serverless.<br/>Marca como baixado só após o ZIP pronto.
```

## Aprovação de promotor / grupo

```mermaid
sequenceDiagram
  actor Pr as Promotor
  actor Ad as Admin (permissão 'aprovar')
  participant S as Servidor
  participant DB as MongoDB
  Pr->>S: POST /api/promotor-pendente { nome }  (ou grupo novo no envio da foto)
  S->>DB: addPendente(nome, tipo: promotor|grupo)
  S-->>Pr: { ok } (aguardando aprovação)
  Ad->>S: GET /api/admin/pendentes
  S-->>Ad: lista (com tipo)
  Ad->>S: POST /api/admin/pendentes/:id/aprovar
  S->>DB: addRefItem('promotores' ou 'grupos', nome) + remove pendente
  S-->>Ad: { nome }
```

## Criar contas em massa por planilha

```mermaid
sequenceDiagram
  actor Ad as Admin (navegador)
  participant S as Servidor
  participant DB as MongoDB
  Ad->>S: GET /api/admin/users/import-template.xlsx (opcional)
  S-->>Ad: modelo protegido (cabeçalho travado, células liberadas, dropdowns)
  Ad->>Ad: preenche e seleciona o .xlsx (botão "Criar por planilha")
  Ad->>S: POST /api/admin/users/import { file: base64 }
  S->>S: ExcelJS lê a planilha e acha as colunas pelo cabeçalho
  loop cada linha (máx 500, deduplicada por e-mail)
    S->>DB: findUserByEmail(email)
    alt e-mail novo
      S->>DB: createUser(senha aleatória,<br/>mustChangePassword=true) + token de convite
    else já existe
      S->>DB: updateUser(só os campos preenchidos — senha intocada)
    end
  end
  S-->>Ad: { criados:[{name,email,senha}], atualizados, erros:[{linha,motivo}] }
  Ad->>Ad: mostra o resumo + baixa CSV com as senhas provisórias
```
