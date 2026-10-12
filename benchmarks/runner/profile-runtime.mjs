import { writeFileSync } from 'node:fs';
const path = process.env.CHIRP_RUNTIME_METRICS;
if (path) {
  const samples = [];
  const capture = () => {
    const resources = {};
    for (const kind of process.getActiveResourcesInfo())
      resources[kind] = (resources[kind] || 0) + 1;
    samples.push({
      timestamp_utc: new Date().toISOString(),
      pid: process.pid,
      ...process.memoryUsage(),
      resources,
    });
    writeFileSync(path, JSON.stringify(samples, null, 2));
  };
  capture();
  setInterval(capture, 2000).unref();
  process.once('beforeExit', capture);
}
