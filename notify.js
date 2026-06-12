import nodemailer from 'nodemailer';

// Failure alerts are emailed to the CEO inbox. Configure on Render:
//   ALERT_SMTP_USER  — Gmail address used as the SMTP sender
//   ALERT_SMTP_PASS  — Gmail app password for that address
//   ALERT_TO         — recipient (defaults to ceo.aiapprove@gmail.com)
// With no credentials set, alerts degrade to a loud log line.
const SMTP_USER = process.env.ALERT_SMTP_USER;
const SMTP_PASS = process.env.ALERT_SMTP_PASS;
const ALERT_TO = process.env.ALERT_TO || 'ceo.aiapprove@gmail.com';

const transporter = SMTP_USER && SMTP_PASS
  ? nodemailer.createTransport({
      host: 'smtp.gmail.com',
      port: 465,
      secure: true,
      auth: { user: SMTP_USER, pass: SMTP_PASS },
    })
  : null;

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

  if (!transporter) {
    console.error('[scan-fail] alert email NOT sent (ALERT_SMTP_USER/ALERT_SMTP_PASS unset):', JSON.stringify({ targetUrl, reason, detail }));
    return false;
  }

  try {
    await transporter.sendMail({
      from: `"PI Link Check" <${SMTP_USER}>`,
      to: ALERT_TO,
      subject: `⚠️ PI Link Check scan failed — ${targetUrl}`,
      text: body,
    });
    console.log('[scan-fail] alert email sent to', ALERT_TO);
    return true;
  } catch (err) {
    console.error('[scan-fail] alert email FAILED to send:', err.message);
    return false;
  }
}
