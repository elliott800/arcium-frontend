// Outgoing site email (verification, password reset, approval notices).
//
// Transport, by what is configured:
//   RESEND_API_KEY            Resend's HTTPS API
//   SMTP_USER + SMTP_PASS     SMTP over TLS (default smtp.gmail.com:465 — for
//                             Gmail, SMTP_PASS is an app password, not the
//                             account password)
//   neither                   development: the message is printed to the server
//                             log; production: sending fails with MailNotConfigured
// MAIL_FROM is the From header, e.g. "Arcium Signals <you@gmail.com>".

import { connect, type TLSSocket } from 'node:tls';
import { randomUUID } from 'node:crypto';

export class MailNotConfigured extends Error {}

export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

const FROM = process.env.MAIL_FROM ?? '';

/** Whether this deployment can actually send email. */
export function mailConfigured(): boolean {
  return !!(process.env.RESEND_API_KEY || (process.env.SMTP_USER && process.env.SMTP_PASS));
}

export async function sendMail(mail: Mail): Promise<void> {
  if (process.env.RESEND_API_KEY) return sendResend(mail);
  if (process.env.SMTP_USER && process.env.SMTP_PASS) return sendSmtp(mail);
  if (process.env.NODE_ENV !== 'production') {
    console.info(`[mail:dev] to=${mail.to} subject=${JSON.stringify(mail.subject)}\n${mail.text}`);
    return;
  }
  throw new MailNotConfigured('Site email is not configured (RESEND_API_KEY or SMTP_USER/SMTP_PASS).');
}

function fromAddress(): string {
  if (!FROM) throw new MailNotConfigured('MAIL_FROM is not set.');
  return FROM;
}

async function sendResend(mail: Mail): Promise<void> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: fromAddress(), to: [mail.to], subject: mail.subject, text: mail.text, html: mail.html }),
  });
  if (!res.ok) throw new Error(`Resend rejected the message: ${res.status} ${await res.text()}`);
}

// ── SMTP (implicit TLS) ──────────────────────────────────────────────────────

const b64 = (s: string) => Buffer.from(s, 'utf8').toString('base64');
const wrap76 = (s: string) => s.replace(/.{1,76}/g, '$&\r\n');
const addr = (s: string) => (s.match(/<([^>]+)>/)?.[1] ?? s).trim();

function buildMessage(mail: Mail, from: string): string {
  const boundary = `b_${randomUUID()}`;
  const domain = addr(from).split('@')[1] ?? 'localhost';
  return [
    `From: ${from}`,
    `To: ${mail.to}`,
    `Subject: =?UTF-8?B?${b64(mail.subject)}?=`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64(mail.text)),
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(b64(mail.html)),
    `--${boundary}--`,
    '',
  ].join('\r\n');
}

/** Reads one (possibly multi-line) SMTP reply and checks its code. */
function replyReader(sock: TLSSocket) {
  let buf = '';
  const waiting: ((line: string) => void)[] = [];
  const lines: string[] = [];
  sock.setEncoding('utf8');
  sock.on('data', (chunk: string) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\r\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const w = waiting.shift();
      if (w) w(line); else lines.push(line);
    }
  });
  const nextLine = () => new Promise<string>((resolve, reject) => {
    const l = lines.shift();
    if (l !== undefined) return resolve(l);
    waiting.push(resolve);
    sock.once('error', reject);
  });
  return async (expect: number): Promise<string> => {
    let line: string;
    const all: string[] = [];
    do { line = await nextLine(); all.push(line); } while (line[3] === '-');
    if (Number(line.slice(0, 3)) !== expect) throw new Error(`SMTP: expected ${expect}, got: ${all.join(' | ')}`);
    return line;
  };
}

async function sendSmtp(mail: Mail): Promise<void> {
  const from = fromAddress();
  const host = process.env.SMTP_HOST ?? 'smtp.gmail.com';
  const port = Number(process.env.SMTP_PORT ?? 465);
  const sock = connect({ host, port, servername: host });
  sock.setTimeout(20_000, () => sock.destroy(new Error('SMTP: timed out')));
  await new Promise<void>((resolve, reject) => { sock.once('secureConnect', resolve); sock.once('error', reject); });
  const reply = replyReader(sock);
  const send = (line: string) => sock.write(line + '\r\n');
  try {
    await reply(220);
    send('EHLO arciumsignals');                            await reply(250);
    send('AUTH LOGIN');                                    await reply(334);
    send(b64(process.env.SMTP_USER!));                     await reply(334);
    send(b64(process.env.SMTP_PASS!));                     await reply(235);
    send(`MAIL FROM:<${addr(from)}>`);                     await reply(250);
    send(`RCPT TO:<${addr(mail.to)}>`);                    await reply(250);
    send('DATA');                                          await reply(354);
    // Dot-stuff any line that starts with '.', then end with <CRLF>.<CRLF>.
    sock.write(buildMessage(mail, from).replace(/^\./gm, '..') + '\r\n.\r\n');
    await reply(250);
    send('QUIT');
  } finally {
    sock.end();
  }
}
