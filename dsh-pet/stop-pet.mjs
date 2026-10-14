#!/usr/bin/env node
/**
 * stop-pet.mjs —— 独立模式停机（POST /shutdown）。
 * 端口扫描 3080-3104（服务占用首选端口时向后顺延的范围）。
 * 用法：node stop-pet.mjs
 */
const PORTS = Array.from({ length: 25 }, (_, i) => 3080 + i);

let stoppedAt = 0;
for (const port of PORTS) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/shutdown`, { method: 'POST' });
    if (res.ok) {
      stoppedAt = port;
      break;
    }
  } catch {
    /* 端口没在听：继续下一个 */
  }
}

if (stoppedAt > 0) {
  console.log(`[dsh-pet] shutdown request sent to port ${stoppedAt}`);
  process.exit(0);
}
console.log('[dsh-pet] no running dsh-pet-standalone found on ports 3080-3104');
process.exit(1);
