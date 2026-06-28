// cor de cada tipo de ponto extra (visual)
const PONTO_COR = {
  'Ilha de produtos': '#1c9cc0',          // teal
  'Display Exclusivo': '#7b3fbf',         // roxo
  'Gôndola de caixa': '#2f9e54',          // verde
  'Cross-merchandising': '#e07a2a',       // laranja
  'Antes e depois': '#d6457f',            // rosa
  'Grande volume de produtos': '#3f6fd1', // azul
};
const corPonto = (p) => PONTO_COR[p] || 'var(--teal)';

// helpers compartilhados
async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (res.status === 401) {
    location.href = '/login.html';
    throw new Error('não autenticado');
  }
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : null;
  if (!res.ok) throw new Error((data && data.error) || 'Erro ' + res.status);
  return data;
}

function toast(msg, type = 'ok') {
  let el = document.querySelector('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = 'toast show ' + type;
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.className = 'toast'), 2600);
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function logout() {
  await api('/api/logout', { method: 'POST' });
  location.href = '/';
}

// sobe um arquivo DIRETO no Cloudinary (com assinatura do nosso servidor) e
// devolve { publicId, resourceType, bytes, originalName } pra registrar depois.
async function cloudinaryUpload(file, tipo) {
  const sig = await api('/api/upload-signature?tipo=' + tipo);
  // comprovante vai como 'raw' (arquivo bruto p/ download — vale pra PDF e imagem,
  // sem validação de PDF nem a restrição de entrega de PDF do Cloudinary)
  const endpoint = tipo === 'comprovantes' ? 'raw' : 'image';
  const fd = new FormData();
  fd.append('file', file);
  fd.append('api_key', sig.apiKey);
  fd.append('timestamp', sig.timestamp);
  fd.append('signature', sig.signature);
  fd.append('folder', sig.folder);
  fd.append('type', sig.type);
  const res = await fetch(`https://api.cloudinary.com/v1_1/${sig.cloudName}/${endpoint}/upload`, { method: 'POST', body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) throw new Error((data.error && data.error.message) || 'Falha no upload da imagem');
  return { publicId: data.public_id, resourceType: data.resource_type, bytes: data.bytes, originalName: file.name };
}
