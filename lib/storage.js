// Armazenamento de arquivos no Cloudinary (fotos + comprovantes).
// Entrega "authenticated": a URL só funciona assinada — sem assinatura retorna 401,
// então o app continua controlando o acesso (gera a URL assinada só pra quem tem permissão).
const { v2: cloudinary } = require('cloudinary');
const https = require('https');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

// resource_type: 'image' p/ imagens, 'raw' p/ PDF e afins
function resourceTypeFor(mime) {
  return /^image\//.test(mime || '') ? 'image' : 'raw';
}

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
function urlFor(publicId, resourceType = 'image', { attachmentName, otimizada = false } = {}) {
  // 'raw' (comprovante): download canônico de arquivo privado — funciona mesmo com
  // a extensão no public_id (que o upload direto adiciona) e já força o download.
  if (resourceType === 'raw') {
    return cloudinary.utils.private_download_url(publicId, null, { resource_type: 'raw', type: 'authenticated' });
  }
  const opts = { type: 'authenticated', resource_type: resourceType, secure: true, sign_url: true };
  // f_auto + q_auto cortam a maior parte do peso de uma foto de celular (que chega com
  // vários MB) sem diferença visível na avaliação — a equipe abre centenas por lote.
  if (otimizada) { opts.fetch_format = 'auto'; opts.quality = 'auto'; }
  if (attachmentName) opts.flags = 'attachment:' + String(attachmentName).replace(/[^a-zA-Z0-9._-]/g, '_');
  return cloudinary.url(publicId, opts);
}

// assina um upload pra o navegador subir o arquivo DIRETO no Cloudinary
// (o api_secret nunca sai do servidor — só a assinatura vai pro browser)
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

module.exports = { uploadBuffer, urlFor, remove, fetchBuffer, resourceTypeFor, signUpload, ping, cloudinary };
