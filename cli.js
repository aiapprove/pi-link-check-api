#!/usr/bin/env node
import { writeFileSync } from 'fs';
import { scanUrl } from './scanner.js';

// ── Colors ──────────────────────────────────────────────────────────────────
function green(s) { return `\x1b[32m${s}\x1b[0m`; }
function yellow(s) { return `\x1b[33m${s}\x1b[0m`; }
function red(s) { return `\x1b[1;31m${s}\x1b[0m`; }
function dim(s) { return `\x1b[2m${s}\x1b[0m`; }
function bold(s) { return `\x1b[1m${s}\x1b[0m`; }
function cyan(s) { return `\x1b[36m${s}\x1b[0m`; }

// ── CLI args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
let target = null;
let skipGate = false;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--no-gate') skipGate = true;
  else if (!args[i].startsWith('--')) target = args[i];
}

if (!target) {
  console.error(`
${bold('PI Link Check')} — Pharma PI/SmPC compliance checker

${bold('Usage:')}
  node cli.js <url>
  node cli.js <url> --no-gate

${bold('Examples:')}
  node cli.js https://www.pfizer.co.uk/products
  node cli.js https://www.pfizermedicalinformation.co.uk/
`);
  process.exit(1);
}

try { new URL(target); } catch { console.error(`\nInvalid URL: ${target}\n`); process.exit(1); }

const maxDepth = parseInt(process.env.PI_MAX_DEPTH || '2', 10);
const maxPages = parseInt(process.env.PI_MAX_PAGES || '50', 10);

process.stdout.write(`\n${bold('PI Link Check')} — ${cyan(target)}\n`);
process.stdout.write(`${dim(`Max depth: ${maxDepth} | Max pages: ${maxPages}`)}\n\n`);

const result = await scanUrl(target, {
  maxDepth,
  maxPages,
  skipGate,
  onProgress(event) {
    if (event.type === 'gateway') {
      process.stdout.write(`  ${yellow('!')} ${event.message}\n`);
    } else if (event.type === 'page') {
      if (event.piLinks > 0 || event.promo) {
        process.stdout.write(`${bold(event.page)}${event.excluded ? dim(' [excluded]') : ''}\n`);
      } else {
        process.stdout.write(`${dim(`  · ${event.page}`)}\n`);
      }
    } else if (event.type === 'error') {
      process.stdout.write(`  ${red('✗')} ${event.message}\n`);
    }
  },
});

// ── Print results ───────────────────────────────────────────────────────────
for (const page of result.results) {
  if (page.pi_links.length > 0) {
    for (const link of page.pi_links) {
      const icon = link.ok ? green('✓') : red('✗');
      const statusStr = link.ok ? green(link.status) : red(link.status);
      const issue = link.issue ? ` ${yellow(`[${link.issue}]`)}` : '';
      const lt = link.text ? ` ${dim(`"${link.text.slice(0, 50)}"`)}\n` : '\n';
      process.stdout.write(`  ${icon} ${statusStr} ${link.url}${issue}${lt}`);
    }
  }
  if (page.missing_pi) {
    process.stdout.write(`  ${red('⚠ Promotional content but NO PI link found')}\n`);
  }
}

// ── Summary ─────────────────────────────────────────────────────────────────
const { summary } = result;
process.stdout.write(`\n${'─'.repeat(60)}\n`);
process.stdout.write(`${bold('Summary')}\n\n`);
process.stdout.write(`  Pages scanned:        ${bold(result.pages_scanned)}\n`);
process.stdout.write(`  PI links found:       ${bold(summary.total)}\n`);
process.stdout.write(`  ${green('✓ Pass:')}               ${summary.pass}\n`);
process.stdout.write(`  ${red('✗ Broken/missing:')}    ${summary.fail}\n`);
if (summary.missing_pi_pages > 0) {
  process.stdout.write(`  ${red('⚠ Missing PI pages:')}  ${summary.missing_pi_pages} promotional page(s) with no PI link\n`);
}
process.stdout.write(`  Time:                 ${result.scan_time_seconds}s\n`);

const domain = new URL(target).hostname.replace(/^www\./, '');
const date = new Date().toISOString().slice(0, 10);
const filename = `pi-report-${domain}-${date}.json`;
writeFileSync(filename, JSON.stringify(result, null, 2));
process.stdout.write(`\n  Report saved: ${cyan(filename)}\n\n`);
