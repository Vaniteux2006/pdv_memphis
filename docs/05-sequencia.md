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
    S-->>U: 401 { error }
  else ok
    S->>S: jwt.sign({ uid, role })
    S-->>U: 200 { role, name } + Set-Cookie: mp_token (httpOnly)
  end
  Note over U,S: Requisições seguintes mandam o cookie.<br/>requireAuth verifica o JWT e revalida 'active' no Mongo.
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

  loop cada foto (comprimida no navegador)
    Pr->>Cl: POST /image/upload (file + assinatura)
    Cl-->>Pr: { public_id, resource_type }
  end

  Pr->>S: POST /api/submissions { metadados, fotos:[public_id...] }
  S->>S: valida campos + limite 2/cliente + prefixo da pasta
  S->>DB: getConfig() (senhas atuais)
  S->>DB: promotorExiste(nome)
  S->>DB: addSubmission(...)  (uma por foto)
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

## Aprovação de promotor

```mermaid
sequenceDiagram
  actor Pr as Promotor
  actor Ad as Admin
  participant S as Servidor
  participant DB as MongoDB
  Pr->>S: POST /api/promotor-pendente { nome }
  S->>DB: addPendente(nome)
  S-->>Pr: { ok } (aguardando aprovação)
  Ad->>S: GET /api/admin/pendentes
  S-->>Ad: lista
  Ad->>S: POST /api/admin/pendentes/:id/aprovar
  S->>DB: addRefItem('promotores', nome) + remove pendente
  S-->>Ad: { nome }
```
