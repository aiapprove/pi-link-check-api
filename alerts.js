import { extractDomain, saveAlert } from './db.js';

/**
 * Process scan results and generate alerts for broken or missing PI links.
 */
export function processAlerts(targetUrl, scanId, scanResult) {
  const domain = extractDomain(targetUrl);
  const alerts = [];

  for (const page of scanResult.results) {
    // Alert for promotional pages missing PI links
    if (page.missing_pi) {
      const alert = {
        severity: 'critical',
        message: `Missing PI link on promotional page: ${page.page}`,
        details: { page: page.page, type: 'missing_pi' },
      };
      saveAlert(domain, scanId, alert.severity, alert.message, alert.details);
      alerts.push(alert);
    }

    // Alert for broken PI links
    for (const link of page.pi_links) {
      if (!link.ok) {
        const severity = link.status === 404 || link.status === 410 ? 'critical' : 'warning';
        const alert = {
          severity,
          message: `Broken PI link on ${page.page}: ${link.url} — ${link.issue || 'unreachable'}`,
          details: { page: page.page, pi_url: link.url, status: link.status, issue: link.issue, type: 'broken_pi' },
        };
        saveAlert(domain, scanId, alert.severity, alert.message, alert.details);
        alerts.push(alert);
      }
    }
  }

  return alerts;
}
