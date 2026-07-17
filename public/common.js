// cor de cada tipo de ponto extra (visual)
const PONTO_COR = {
  'Ilha de produtos': '#1c9cc0',          // teal
  'Display Exclusivo': '#7b3fbf',         // roxo
  'Gôndola de caixa': '#2f9e54',          // verde
  'Cross-merchandising': '#e07a2a',       // laranja
  'Antes e depois': '#d6457f',            // rosa
  'Grande volume de produtos': '#3f6fd1', // azul
};
// ponto criado pelo admin (aba Listas) ganha cor da paleta pelo nome —
// determinístico: o mesmo nome tem a mesma cor em qualquer página
const PONTO_PALETA = ['#0e7a99', '#9c5bd1', '#1f7a3f', '#b85c1e', '#b23a68', '#2f55a4', '#8a6d3b', '#457a8b'];
const corPonto = (p) => PONTO_COR[p] ||
  PONTO_PALETA[[...String(p)].reduce((a, ch) => (a * 31 + ch.charCodeAt(0)) >>> 0, 7) % PONTO_PALETA.length];

// helpers compartilhados
async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  if (res.status === 401) {
    location.href = '/pdv/login.html'; // login é do módulo PDV (por ora o único com conta)
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
    el.setAttribute('role', 'status');   // leitor de tela anuncia sem roubar o foco
    el.setAttribute('aria-live', 'polite');
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = 'toast show ' + type;
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.className = 'toast'), 2600);
}

// telefone: no banco só dígitos; aqui vira "(00) 00000 0000" (celular) ou "(00) 0000 0000" (fixo)
function fmtTel(v) {
  const d = String(v || '').replace(/\D/g, '').slice(0, 11);
  if (!d) return '';
  if (d.length <= 2) return '(' + d;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)} ${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)} ${d.slice(7)}`;
}
// máscara ao digitar (mantém o cursor no fim — suficiente pro nosso uso)
function maskTel(input) {
  if (!input || input._masked) return;
  input._masked = true;
  input.addEventListener('input', () => { input.value = fmtTel(input.value); });
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

async function logout() {
  await api('/api/logout', { method: 'POST' });
  location.href = '/pdv/';
}

// Esc fecha o modal de foto ampliada (acessibilidade por teclado)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') document.querySelectorAll('.modal.show').forEach((m) => m.classList.remove('show'));
});

// todo campo de senha ganha um botão mostrar/ocultar (menos erro de digitação no celular)
document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('input[type="password"]').forEach((inp) => {
    const wrap = document.createElement('div');
    wrap.className = 'pw-wrap';
    inp.parentNode.insertBefore(wrap, inp);
    wrap.appendChild(inp);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'pw-toggle';
    btn.textContent = '👁';
    btn.setAttribute('aria-label', 'Mostrar senha');
    btn.setAttribute('aria-pressed', 'false');
    btn.addEventListener('click', () => {
      const mostrar = inp.type === 'password';
      inp.type = mostrar ? 'text' : 'password';
      btn.textContent = mostrar ? '🙈' : '👁';
      btn.setAttribute('aria-label', mostrar ? 'Ocultar senha' : 'Mostrar senha');
      btn.setAttribute('aria-pressed', String(mostrar));
      inp.focus();
    });
    wrap.appendChild(btn);
  });
});

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
