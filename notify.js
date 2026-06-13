// Failure alerts are emailed to the CEO inbox via Resend's HTTPS API.
// Render's free tier blocks outbound SMTP (ports 25/465/587 time out), so
// raw SMTP is not an option here — Resend goes over HTTPS (443).
//
// Configure on Render:
//   RESEND_API_KEY  — Resend API key (https://resend.com/api-keys)
//   ALERT_FROM      — sender. Defaults to Resend's onboarding@resend.dev,
//                     which delivers to the account owner's email with no
//                     domain verification. Once aiapprove.ai is verified in
//                     Resend, set this to e.g. alerts@aiapprove.ai.
//   ALERT_TO        — recipient (default: ceo.aiapprove@gmail.com)
// With no key set, alerts degrade to a loud log line.
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const ALERT_FROM = process.env.ALERT_FROM || 'AI Approve Alerts <onboarding@resend.dev>';
const ALERT_TO = process.env.ALERT_TO || 'ceo.aiapprove@gmail.com';

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

  if (!RESEND_API_KEY) {
    console.error('[scan-fail] alert email NOT sent (RESEND_API_KEY unset):', JSON.stringify({ targetUrl, reason, detail }));
    return false;
  }

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: ALERT_FROM,
        to: [ALERT_TO],
        subject: `PI Link Check scan failed — ${targetUrl}`,
        text: body,
      }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      console.error('[scan-fail] alert email FAILED to send:', res.status, errText);
      return false;
    }

    console.log('[scan-fail] alert email sent to', ALERT_TO, 'via Resend');
    return true;
  } catch (err) {
    console.error('[scan-fail] alert email FAILED to send:', err.message);
    return false;
  }
}
