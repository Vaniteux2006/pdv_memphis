// Contratos centrais do domínio, em JSDoc puro. **Zero runtime**: este arquivo não
// exporta função nenhuma e não é carregado por ninguém — existe só para o editor e para
// o `npx tsc --noEmit` (ver `jsconfig.json`).
//
// Escopo deliberadamente pequeno: só os pontos onde a FORMA é ambígua de verdade e já
// custou bug — `validado` de três estados, `matricula` com o `0` de semântica especial,
// `imagens` com dois formatos convivendo, e o filtro que chega de `req.query` cru.
// Tipo aqui não valida nada em runtime; para isso existe `lib/validar.js`.

// ---------- usuários ----------

/**
 * Id de permissão granular de admin. `'*'` = acesso total (crachá).
 * Espelha `PERMISSOES` em `db.js` — mudou lá, muda aqui.
 * @typedef {'fotos'|'aprovar'|'contas'|'listas'|'aderencia'|'*'} Permissao
 */

/** @typedef {'admin'|'promotor'} Papel */

/**
 * Documento da coleção `users`, como está no banco.
 * @typedef {object} User
 * @property {string} id UUID (a chave de verdade; o `_id` do Mongo não sai daqui)
 * @property {string} email como a pessoa digitou
 * @property {string} emailLower chave única de login
 * @property {string} name
 * @property {Papel} role
 * @property {string} passwordHash bcrypt — **nunca** sai numa resposta
 * @property {boolean} active `false` = banido; o login responde genérico
 * @property {boolean} [pendingApproval] cadastro público à espera de um admin
 * @property {boolean} mustChangePassword troca obrigatória no 1º acesso
 * @property {string} createdAt ISO
 * @property {string} grupo
 * @property {string} regiao sigla de `REGIOES` (`''` = sem região, e o envio é barrado)
 * @property {string} telefone só dígitos (o front é quem formata)
 * @property {string} setor
 * @property {number|null} matricula inteiro > 0, ou `null`. **`0` vira `null`** — promotor não tem matrícula, e `0` não pode colidir como duplicado
 * @property {Permissao[]} [permissions] só em `role: 'admin'`. **Ausente = acesso total** (admin criado antes de o campo existir)
 * @property {string} [aceiteVersao] versão da política aceita; diferente da vigente cai no portão do `requireAuth`
 * @property {string} [aceiteEm] ISO
 * @property {string} [resetTokenHash] sha256 do token de reset/convite (uso único)
 * @property {number} [resetTokenExp] epoch ms
 * @property {string} [conviteEnviadoEm] ISO
 */

/**
 * `User` sem o hash — a forma que as rotas devolvem.
 * @typedef {Omit<User, 'passwordHash'>} UserSeguro
 */

// ---------- fotos ----------

/**
 * Uma imagem dentro de uma foto. O formato ANTIGO guardava `storedFile`/`resourceType`
 * soltos na submissão; `imagensDe()` em `server.js` normaliza os dois.
 * @typedef {object} Imagem
 * @property {string} storedFile `publicId` no Cloudinary (`memphis-pdv/fotos/...`)
 * @property {string} [resourceType] `'image'` por padrão
 * @property {string} [originalName]
 */

/** @typedef {''|'REGULAR'|'BOM'|'EXCELENTE'} PreAvaliacao */

/**
 * Documento da coleção `submissions`. **1 foto = 1 documento**, com 1 ou 2 imagens
 * (2 = "antes e depois") — as cotas de 1/semana e 4/mês contam DOCUMENTOS.
 *
 * Os campos marcados "sai na retenção" desaparecem com o tempo: imagem e identidade aos
 * 2 meses (`anonimizadaEm`), o resto da identidade aos 6. Por isso quase tudo que
 * identifica alguém é opcional aqui — ler um documento antigo assumindo que `promotor`
 * existe é justamente o bug que este typedef torna visível no editor.
 *
 * @typedef {object} Submission
 * @property {string} id UUID
 * @property {Imagem[]} imagens vazio depois da anonimização · sai na retenção
 * @property {string} cliente
 * @property {string} [clienteNorm] sai na retenção
 * @property {string} [endereco] sai na retenção
 * @property {string} regiao vem do cadastro, nunca do corpo
 * @property {string} [promotor] vem da SESSÃO, nunca do corpo (2.1) · sai na retenção
 * @property {string} [promotorNorm] join key da aderência **e** chave de contagem distinta · sai na retenção
 * @property {string} grupo como estava no envio
 * @property {string} [grupoOficial] congelado ANTES de anonimizar; é o que mantém a aderência de pé depois
 * @property {string} dataExposicao `'YYYY-MM-DD'` — o relógio do NEGÓCIO
 * @property {string} semanaKey `'YYYY-Wnn'`, derivado de `dataExposicao`
 * @property {string} mesKey `'YYYY-MM'`, derivado de `dataExposicao`
 * @property {string} [searchBlob] normalizado p/ busca · sai na retenção
 * @property {string} [uploadedBy] `User.id` · sai aos 6 meses. Esquecê-lo transforma "anonimizar" em pseudonimizar
 * @property {string} [uploadedByEmail] sai na retenção
 * @property {string|null} [senhaMensal] senha vigente no momento do envio (prova da campanha)
 * @property {string|null} [senhaSemanal]
 * @property {boolean} baixado já entrou num ZIP fechado
 * @property {PreAvaliacao} preAvaliacao
 * @property {string[]} pontosExtra só valores da lista vigente (aba Listas)
 * @property {boolean|null} validado **três estados**: `null` ou ausente = pendente · `true` = aprovada · `false` = recusada
 * @property {string} motivoRecusa obrigatório quando `validado === false`
 * @property {string} [observacao] texto livre do avaliador · sai aos 6 meses
 * @property {boolean} pago
 * @property {boolean} [promotorNoBanco] o nome existia na lista oficial no momento do envio
 * @property {string} createdAt ISO — o relógio da RETENÇÃO (não `dataExposicao`)
 * @property {string} [anonimizadaEm] ISO; presente = já passou pela retenção
 * @property {string} [anonimizadoTitularEm] ISO; anonimização a pedido do titular (Art. 18)
 * @property {string} [storedFile] formato antigo, 1 imagem só
 * @property {string} [resourceType] formato antigo
 * @property {string} [originalName] formato antigo
 * @property {boolean} [teste] marca de `tools/seed-teste.js`; é por ela que a limpeza acha o que apagar
 */

/**
 * Filtro das telas de fotos. **Chega de `req.query` cru**, então todo valor é
 * `string|undefined` na prática — nunca o tipo que o nome sugere. `queryDeSubmissions()`
 * coage tudo com `String()` de propósito: o parser do Express transforma `?regiao[$ne]=X`
 * num OBJETO, que iria direto pro Mongo como operador.
 *
 * @typedef {object} FiltroSubmissions
 * @property {string} [uploadedBy]
 * @property {string} [regiao]
 * @property {string} [grupo]
 * @property {'novos'|'baixados'|'validados'|'recusados'|'pendentes'} [status]
 * @property {'sim'|'nao'} [baixado] pergunta INDEPENDENTE de `status` (a tela usa as duas juntas)
 * @property {string} [preAvaliacao] `'sem'` = sem pré-avaliação; senão, o valor exato
 * @property {string} [promotor] busca por trecho do nome
 * @property {string} [dataDe] `'YYYY-MM-DD'`
 * @property {string} [dataAte] `'YYYY-MM-DD'`
 * @property {string} [q] busca livre (`searchBlob`)
 * @property {string} [ordem] `'antigas'` = fila de atendimento; qualquer outra coisa = mais novas primeiro
 * @property {number|string} [skip]
 * @property {number|string} [limit] teto de 500 no `db`
 */

/**
 * Payload do `GET /api/reference`. Servido de **dois** buffers gzip distintos: o de
 * promotor NÃO traz `promotores[]` (Bloco 2). Trocar um buffer pelo outro é a falha mais
 * perigosa do projeto — daí o caso dedicado no `smoke.js`.
 *
 * @typedef {object} Referencia
 * @property {{sigla: string, nome: string}[]} regioes
 * @property {string[]} pontosExtra
 * @property {string[]} motivosRecusa
 * @property {string[]} preAvaliacoes
 * @property {Record<string, string[]>} cidades
 * @property {{id: string, nome: string}[]} permissoes
 * @property {string[]} grupos
 * @property {string[]} clientes
 * @property {string[]} [promotores] **só para admin** — ausente na resposta do promotor
 * @property {number} limiteSemanal
 * @property {number} limiteMensal
 * @property {number} imagensPorFoto
 * @property {{senhaMensal: string|null, senhaSemanal: string|null}} senhas
 */

// ---------- LGPD ----------

/**
 * Retorno de uma recusa, na coleção `retorno`. Vive FORA da submissão de propósito:
 * anonimizar aos 2 meses e "o promotor vê o motivo enquanto a conta existir" querem
 * coisas opostas do mesmo documento.
 * @typedef {object} Retorno
 * @property {string} submissionId chave do upsert — reavaliar a mesma foto ATUALIZA, não duplica
 * @property {string} userId omitido na resposta de `listRetornos` (a projeção tira)
 * @property {string} semanaKey
 * @property {string} mesKey
 * @property {string} dataExposicao
 * @property {string} cliente
 * @property {string} motivoRecusa
 * @property {string} observacao
 * @property {string} criadoEm ISO
 */

/**
 * Dados institucionais do controlador (divulgação obrigatória — Art. 41 §1º).
 * A rota `GET /api/contato` é pública de propósito. Permissão graduada na escrita:
 * os três primeiros exigem acesso total, o resto basta `'listas'`.
 * @typedef {object} Institucionais
 * @property {string} razaoSocial acesso total
 * @property {string} cnpj acesso total
 * @property {string} enderecoMatriz acesso total
 * @property {string} encarregadoEmail
 * @property {string} contatoTelefone
 * @property {string} politicaVersao comparada com `User.aceiteVersao` no portão
 * @property {boolean} avisoTransicaoWhatsapp some quando o WhatsApp sair de cena
 */

module.exports = {}; // sem runtime: só os @typedef acima
