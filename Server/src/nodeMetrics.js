import os from "node:os";

// 节点运行指标只保存在进程内，不写入业务库；管理后台读取受注册密钥保护的健康接口。
let httpServer = null;
let activeRequestCount = 0;
let totalRequestCount = 0;
let previousCpuSnapshot = readCpuSnapshot();
let cpuPercent = null;

// 每秒采样一次主机 CPU，避免健康检查请求为了计算 CPU 而额外等待。
const cpuSampler = setInterval(() => {
  const currentSnapshot = readCpuSnapshot();
  if (previousCpuSnapshot && currentSnapshot) {
    const totalDelta = currentSnapshot.total - previousCpuSnapshot.total;
    const idleDelta = currentSnapshot.idle - previousCpuSnapshot.idle;
    if (totalDelta > 0) {
      cpuPercent = roundPercent((1 - idleDelta / totalDelta) * 100);
    }
  }
  previousCpuSnapshot = currentSnapshot;
}, 1000);
cpuSampler.unref?.();

// 在Express应用中记录当前请求数，作为Node自身连接压力的补充指标。
export function attachRequestMetrics(app) {
  app.use((req, res, next) => {
    activeRequestCount += 1;
    totalRequestCount += 1;
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      activeRequestCount = Math.max(0, activeRequestCount - 1);
    };
    res.once("finish", release);
    res.once("close", release);
    next();
  });
}

// server.js监听成功后注入HTTP Server，用于读取当前TCP连接数。
export function setHttpServer(server) {
  httpServer = server;
}

export async function getNodeRuntimeMetrics() {
  const totalMemoryBytes = os.totalmem();
  const freeMemoryBytes = os.freemem();
  const usedMemoryBytes = Math.max(0, totalMemoryBytes - freeMemoryBytes);
  const processMemory = process.memoryUsage();

  return {
    cpuPercent,
    cpuCoreCount: os.cpus().length,
    memoryPercent: totalMemoryBytes > 0
      ? roundPercent((usedMemoryBytes / totalMemoryBytes) * 100)
      : null,
    memoryUsedBytes: usedMemoryBytes,
    memoryTotalBytes: totalMemoryBytes,
    processMemoryBytes: processMemory.rss,
    httpConnectionCount: await readHttpConnectionCount(),
    activeRequestCount,
    totalRequestCount,
  };
}

function readCpuSnapshot() {
  const cpus = os.cpus();
  if (!cpus.length) return null;

  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    idle += Number(cpu.times.idle) || 0;
    total += Object.values(cpu.times).reduce((sum, value) => sum + (Number(value) || 0), 0);
  }
  return { idle, total };
}

function readHttpConnectionCount() {
  if (!httpServer || typeof httpServer.getConnections !== "function") {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    httpServer.getConnections((error, count) => {
      resolve(error ? null : Number(count));
    });
  });
}

function roundPercent(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(Math.max(0, Math.min(100, value)) * 10) / 10;
}
