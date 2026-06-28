// Envio de email (recuperação de senha) via SMTP.
// Configurável por .env: SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, MAIL_FROM.
// Sem SMTP configurado: não envia — o servidor loga o link (útil em dev/teste).
const nodemailer = require('nodemailer');

const host = process.env.SMTP_HOST;
const port = Number(process.env.SMTP_PORT || 465);
const user = process.env.SMTP_USER;
const pass = process.env.SMTP_PASS;
const from = process.env.MAIL_FROM || user;
const configured = !!(host && user && pass);

let transport;
function getTransport() {
  if (!transport) transport = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
  return transport;
}

async function sendResetEmail(to, link, nome) {
  if (!configured) {
    console.log(`[mailer] SMTP não configurado — link de redefinição p/ ${to}:\n  ${link}`);
    return { sent: false };
  }
  await getTransport().sendMail({
    from: `"Memphis PDV" <${from}>`,
    to,
    subject: 'Memphis PDV — redefinição de senha',
    text: `Olá ${nome || ''},\n\nVocê pediu para redefinir sua senha no Memphis PDV.\nAbra o link abaixo (expira em 1 hora):\n\n${link}\n\nSe não foi você, ignore este email.`,
    html: `<p>Olá ${nome || ''},</p>
      <p>Você pediu para redefinir sua senha no <b>Memphis PDV</b>.</p>
      <p><a href="${link}" style="background:#1c9cc0;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none">Redefinir minha senha</a></p>
      <p style="color:#888;font-size:13px">O link expira em 1 hora. Se não foi você, ignore este email.</p>`,
  });
  return { sent: true };
}

module.exports = { sendResetEmail, configured };
