// Armazenamento de arquivos no Cloudinary (fotos + comprovantes).
// Entrega "authenticated": a URL só funciona assinada — sem assinatura retorna 401,
// então o app continua controlando o acesso (gera a URL assinada só pra quem tem permissão).
const { v2: cloudinary } = require('cloudinary');

const URL_VALIDA_SEGUNDOS = Number(process.env.URL_FOTO_SEGUNDOS || 3600);
const https = require('https');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

// resource_type: 'image' p/ imagens, 'raw' p/ PDF e afins
/**
 * @param {string} [mime]
 * @returns {'image'|'raw'}
 */
function resourceTypeFor(mime) {
  return /^image\//.test(mime || '') ? 'image' : 'raw';
}

/**
 * @param {Buffer} buffer
 * @param {{ folder: string, resourceType?: 'image'|'raw'|'video'|'auto' }} opcoes
 * @returns {Promise<{ id: string, resourceType: string, bytes: number }>}
 */
function uploadBuffer(buffer, { folder, resourceType = 'image' }) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(
      { folder, resource_type: resourceType, type: 'authenticated' },
      (err, res) => (err ? reject(err) : resolve({ id: res.public_id, resourceType: res.resource_type, bytes: res.bytes }))
    );
    stream.end(buffer);
  });
}

// URL assinada pra entregar/baixar o arquivo
// otimizada=true: Cloudinary escolhe formato (AVIF/WebP) e qualidade sozinho. Use SÓ para
// exibir na tela — o ZIP do lote precisa do arquivo ORIGINAL, porque é ele que vai para o
// servidor interno e vive a longo prazo. Recomprimir o arquivo do acervo seria perda
// silenciosa de qualidade, sem volta.
/**
 * @param {string} publicId
 * @param {string} [resourceType]
 * @param {{ attachmentName?: string, otimizada?: boolean }} [opcoes] `otimizada` SÓ para
 *   exibir na tela — o ZIP do lote precisa do arquivo original
 * @returns {string} URL assinada, **sem expiração** (ver `urlTemporaria`)
 */
function urlFor(publicId, resourceType = 'image', { attachmentName, otimizada = false } = {}) {
  // 'raw' (comprovante): download canônico de arquivo privado — funciona mesmo com
  // a extensão no public_id (que o upload direto adiciona) e já força o download.
  if (resourceType === 'raw') {
    return cloudinary.utils.private_download_url(publicId, null, { resource_type: 'raw', type: 'authenticated' });
  }
  // ⚠️ Medido, não suposto: o Cloudinary IGNORA `expires_at` em URL de entrega
  // (res.cloudinary.com) — a URL sai byte a byte idêntica com e sem o campo. Expiração de
  // verdade em URL de entrega exige token-based auth, que é recurso de plano pago.
  // Por isso quem precisa expirar usa `urlTemporaria()` abaixo, e esta função continua
  // sendo a de EXIBIÇÃO: gerada a cada requisição, atrás de login, e usada na hora.
  /** @type {Record<string, any>} */
  const opts = { type: 'authenticated', resource_type: resourceType, secure: true, sign_url: true };
  // f_auto + q_auto cortam a maior parte do peso de uma foto de celular (que chega com
  // vários MB) sem diferença visível na avaliação — a equipe abre centenas por lote.
  if (otimizada) { opts.fetch_format = 'auto'; opts.quality = 'auto'; }
  if (attachmentName) opts.flags = 'attachment:' + String(attachmentName).replace(/[^a-zA-Z0-9._-]/g, '_');
  return cloudinary.url(publicId, opts);
}

// URL que EXPIRA de verdade (testado: 200 dentro do prazo, 401 depois).
// Usa o endpoint de download, o único que honra `expires_at`. Entrega o arquivo ORIGINAL,
// sem transformação — o que é exatamente o que o ZIP do lote precisa.
// É aqui que mora o risco que o plano aponta: o manifesto entrega centenas de URLs de uma
// vez, e um manifesto vazado daria acesso vitalício se o link não vencesse.
/**
 * @param {string} publicId
 * @param {string} [resourceType]
 * @param {{ segundos?: number, formato?: string }} [opcoes]
 * @returns {string} URL que expira de verdade (401 depois do prazo)
 */
function urlTemporaria(publicId, resourceType = 'image', { segundos = URL_VALIDA_SEGUNDOS, formato } = {}) {
  return cloudinary.utils.private_download_url(publicId, formato || null, {
    resource_type: resourceType,
    type: 'authenticated',
    expires_at: Math.floor(Date.now() / 1000) + segundos,
  });
}

// assina um upload pra o navegador subir o arquivo DIRETO no Cloudinary
// (o api_secret nunca sai do servidor — só a assinatura vai pro browser)
/**
 * @param {{ folder: string, type?: string }} opcoes
 */
function signUpload({ folder, type = 'authenticated' }) {
  const timestamp = Math.round(Date.now() / 1000);
  const signature = cloudinary.utils.api_sign_request(
    { folder, timestamp, type },
    process.env.CLOUDINARY_API_SECRET
  );
  return {
    timestamp, signature, folder, type,
    apiKey: process.env.CLOUDINARY_API_KEY,
    cloudName: process.env.CLOUDINARY_CLOUD_NAME,
  };
}

async function remove(publicId, resourceType = 'image') {
  try {
    await cloudinary.uploader.destroy(publicId, { type: 'authenticated', resource_type: resourceType, invalidate: true });
  } catch (e) {
    console.error('Cloudinary destroy falhou:', e.message);
  }
}

// Remoção em lote: a Admin API aceita até 100 ids por chamada. Apagar 5 mil imagens
// uma a uma (~200ms cada) passaria de 15 min e estouraria a requisição; em lotes são
// ~100 chamadas. Falha num lote não derruba os outros — sobra órfã, e `tools/limpar-orfas.js`
// existe pra isso.
async function removeMany(itens) {
  const porTipo = {};
  for (const { publicId, resourceType = 'image' } of itens) (porTipo[resourceType] ||= []).push(publicId);
  let ok = 0;
  for (const [resourceType, ids] of Object.entries(porTipo)) {
    for (let i = 0; i < ids.length; i += 100) {
      const lote = ids.slice(i, i + 100);
      try {
        await cloudinary.api.delete_resources(lote, { type: 'authenticated', resource_type: resourceType, invalidate: true });
        ok += lote.length;
      } catch (e) {
        console.error(`Cloudinary delete_resources falhou (${lote.length} ${resourceType}):`, e.message);
      }
    }
  }
  return ok;
}

// baixa o conteúdo de uma URL assinada (usado pra montar o ZIP)
function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode !== 200) { res.resume(); return reject(new Error('HTTP ' + res.statusCode)); }
      const chunks = [];
      res.on('data', (d) => chunks.push(d));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

// teste rápido de credenciais
async function ping() {
  return cloudinary.api.ping();
}

module.exports = { uploadBuffer, urlFor, urlTemporaria, remove, removeMany, fetchBuffer, resourceTypeFor, signUpload, ping, cloudinary, URL_VALIDA_SEGUNDOS };
