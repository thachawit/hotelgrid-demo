// SIMULATED cloud billing export (flattened GCP-billing-export-style CSV) for the AI platform's own infrastructure.
// In production this lands daily in a bucket / BigQuery table; here it is generated for the last 30 days.
// `monitoring_avg_utilization` is NOT part of a billing export — the import job joins it from Cloud Monitoring.
import fs from 'node:fs';
import path from 'node:path';
import { startOfTodayUtc, dayOf } from './seed-history.mjs';

// [service, sku, project, team, component, usdPerDay, avgUtilization]
const LINES = [
  ['Compute Engine', 'N2 Instance Core running in Asia Southeast', 'hg-llmops', 'team-platform', 'langfuse-web', 3.1, 0.41],
  ['Compute Engine', 'N2 Highmem Instance running in Asia Southeast', 'hg-llmops', 'team-platform', 'langfuse-clickhouse', 5.4, 0.36],
  ['Cloud SQL', 'Cloud SQL for PostgreSQL: Zonal - vCPU', 'hg-finops', 'team-finops', 'cost-ledger-db', 1.9, 0.22],
  ['Vertex AI', 'Vector Search index serving', 'hg-finops', 'team-finops', 'advisor-rag-index', 1.2, 0.18],
  ['Compute Engine', 'Nvidia L4 GPU running in Asia Southeast', 'hg-data', 'team-data', 'review-embeddings-gpu', 27.4, 0.06],
  ['Compute Engine', 'E2 Instance Core running in Asia Southeast', 'hg-factory', 'team-platform', 'factory-ci-runners', 4.3, 0.55],
  ['Cloud Storage', 'Standard Storage Asia', 'hg-llmops', 'team-platform', 'trace-archive', 0.6, 0],
];

export function writeCloudExport(file, { days = 30, today = startOfTodayUtc() } = {}) {
  const out = ['usage_start_date,service_description,sku_description,project_id,label_team,label_component,cost,currency,monitoring_avg_utilization'];
  for (let d = days; d >= 1; d--) {
    const day = dayOf(today - d * 86400000);
    for (const [svc, sku, project, team, comp, usd, util] of LINES) {
      const jitter = 0.96 + (((d * 13 + comp.length * 7) % 9) / 100);
      out.push([day, svc, sku, project, team, comp, (usd * jitter).toFixed(4), 'USD', util.toFixed(2)].join(','));
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, out.join('\n') + '\n');
  return out.length - 1;
}
