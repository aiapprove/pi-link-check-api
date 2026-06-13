import nodemailer from 'nodemailer';
import dns from 'node:dns/promises';

// Failure alerts are emailed to the CEO inbox. Configure on Render:
//   ALERT_SMTP_USER  — Gmail address used as the SMTP sender
//   ALERT_SMTP_PASS  — Gmail app password for that address
//   ALERT_TO         — recipient (defaults to ceo.aiapprove@gmail.com)
// With no credentials set, alerts degrade to a loud log line.
const SMTP_USER = process.env.ALERT_SMTP_USER;
const SMTP_PASS = process.env.ALERT_SMTP_PASS;
const ALERT_TO = process.env.ALERT_TO || 'ceo.aiapprove@gmail.com';
const SMTP_HOST = 'smtp.gmail.com';

const credsPresent = Boolean(SMTP_USER && SMTP_PASS);

// Render's free tier has no outbound IPv6. nodemailer does its own hostname
// resolution and ignores both the transport `family` option and Node's
// dns.setDefaultResultOrder, so it kept picking smtp.gmail.com's IPv6 record
// and failing with ENETUNREACH. We resolve an IPv4 address ourselves at send
// time and connect to that literal, keeping tls.servername so the Gmail
// certificate still validates against the hostname.
export async function sendFailureAlert({ targetUrl, reason, detail }) {
  const body = [
    `PI Link Check scan failed.`,
    ``,
    `Target:  ${targetUrl}`,
    `Reason:  ${reason}`,
    detail ? `Detail:  ${detail}` : null,
    `Time:    ${new Date().toISOString()}`,
    ``,
    `Service: pi-link-check-api on Render`,
  ].filter(Boolean).join('\n');

  if (!credsPresent) {
    console.error('[scan-fail] alert email NOT sent (ALERT_SMTP_USER/ALERT_SMTP_PASS unset):', JSON.stringify({ targetUrl, reason, detail }));
    return false;
  }

  try {
    const [ipv4] = await dns.resolve4(SMTP_HOST);

    const transporter = nodemailer.createTransport({
      host: ipv4,
      port: 465,
      secure: true,
      tls: { servername: SMTP_HOST },
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    });

    await transporter.sendMail({
      from: `"PI Link Check" <${SMTP_USER}>`,
      to: ALERT_TO,
      subject: `PI Link Check scan failed — ${targetUrl}`,
      text: body,
    });
    console.log('[scan-fail] alert email sent to', ALERT_TO, 'via', ipv4);
    return true;
  } catch (err) {
    console.error('[scan-fail] alert email FAILED to send:', err.message);
    return false;
  }
}
