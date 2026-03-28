import express from 'express';
import cors from 'cors';
import { scanUrl } from './scanner.js';
import { saveScan, getScanHistory, getLatestScan, getAlerts, extractDomain } from './db.js';
import { processAlerts } from './alerts.js';
import { generateReport } from './pdf-report.js';

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(cors({
  origin: [
    'https://aiapprove.io',
    /\.aiapprove\.io$/,
    'http://localhost:3000',
    'http://localhost:5173',
    'http://localhost:8080',
  ],
}));

// ── Health check ────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// ── Scan endpoint ───────────────────────────────────────────────────────────
const activeScanCount = { value: 0 };
const MAX_CONCURRENT_SCANS = 3;

app.post('/api/scan', async (req, res) => {
  const { url, maxDepth, maxPages, skipGate } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'url is required' });
  }

  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL' });
  }

  if (activeScanCount.value >= MAX_CONCURRENT_SCANS) {
    return res.status(429).json({ error: 'Too many concurrent scans. Try again later.' });
  }

  activeScanCount.value++;

  const timeout = setTimeout(() => {
    if (!res.headersSent) {
      res.status(504).json({ error: 'Scan timed out after 60 seconds' });
    }
  }, 60000);

  try {
    const result = await scanUrl(url, {
      maxDepth: Math.min(maxDepth ?? 2, 5),
      maxPages: Math.min(maxPages ?? 50, 200),
      skipGate: skipGate ?? false,
    });
    clearTimeout(timeout);

    if (!res.headersSent) {
      // Save to database
      const scanId = saveScan(url, result);

      // Process alerts
      const alerts = processAlerts(url, scanId, result);
      result.alerts = alerts;
      result.scan_id = Number(scanId);

      res.json(result);
    }
  } catch (err) {
    clearTimeout(timeout);
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    }
  } finally {
    activeScanCount.value--;
  }
});

// ── Reports: scan history for a domain ──────────────────────────────────────
app.get('/api/reports/:domain', (req, res) => {
  const history = getScanHistory(req.params.domain);
  res.json({ domain: req.params.domain, scans: history });
});

// ── Reports: latest scan for a domain ───────────────────────────────────────
app.get('/api/reports/:domain/latest', (req, res) => {
  const scan = getLatestScan(req.params.domain);
  if (!scan) return res.status(404).json({ error: 'No scans found for this domain' });
  res.json(scan);
});

// ── Reports: PDF compliance report ──────────────────────────────────────────
app.get('/api/reports/:domain/pdf', (req, res) => {
  const scan = getLatestScan(req.params.domain);
  if (!scan) return res.status(404).json({ error: 'No scans found for this domain' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="pi-compliance-${req.params.domain}.pdf"`);

  generateReport(scan, res);
});

// ── Alerts: alert history for a domain ──────────────────────────────────────
app.get('/api/alerts/:domain', (req, res) => {
  const alerts = getAlerts(req.params.domain);
  res.json({ domain: req.params.domain, alerts });
});

app.listen(PORT, () => {
  console.log(`PI Link Check API listening on port ${PORT}`);
});
