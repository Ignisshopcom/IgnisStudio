const { contextBridge, ipcRenderer, webUtils } = require('electron');
const childProcess = require('child_process');
const dgram = require('dgram');
const fs = require('fs');
const http = require('http');
const md5 = require('md5');
const NodeZip = require('node-zip');
const os = require('os');
const path = require('path');

function cloneStats(stats) {
  return {
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    isFile: () => stats.isFile(),
    isDirectory: () => stats.isDirectory(),
  };
}

function getDriveRoots() {
  if (process.platform === 'win32') {
    const drives = [];

    for (let code = 65; code <= 90; code++) {
      const letter = String.fromCharCode(code);
      const root = `${letter}:\\`;

      try {
        if (fs.existsSync(root)) {
          drives.push({
            description: `Drive ${letter}:`,
            mountpoints: [{ path: root }],
          });
        }
      } catch (error) {
        // Some drives can exist but be temporarily unreadable.
      }
    }

    return drives;
  }

  if (process.platform === 'darwin') {
    const roots = [{ description: 'System', mountpoints: [{ path: '/' }] }];
    try {
      fs.readdirSync('/Volumes').forEach((name) => {
        roots.push({
          description: name,
          mountpoints: [{ path: path.join('/Volumes', name) }],
        });
      });
    } catch (error) {
      // /Volumes may be inaccessible in restricted environments.
    }
    return roots;
  }

  return [{ description: 'System', mountpoints: [{ path: '/' }] }];
}

function normalizeHost(host) {
  return String(host || '')
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/:80$/, '');
}

function isPrivateIPv4(ip) {
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ip || '')) return false;
  const p = ip.split('.').map((v) => parseInt(v, 10));
  if (p.some((v) => Number.isNaN(v) || v < 0 || v > 255)) return false;
  if (p[0] === 10) return true;
  if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
  if (p[0] === 192 && p[1] === 168) return true;
  return false;
}

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, part) => ((acc << 8) + parseInt(part, 10)) >>> 0, 0);
}

function intToIPv4(value) {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ].join('.');
}

function getLocalAuraXSubnets() {
  const subnets = new Map();

  function add(address, netmask) {
    if (!isPrivateIPv4(address)) return;
    const parts = address.split('.');
    const prefix = parts.slice(0, 3).join('.');
    let broadcast = `${prefix}.255`;

    if (netmask && /^\d+\.\d+\.\d+\.\d+$/.test(netmask)) {
      try {
        const addr = ipv4ToInt(address);
        const mask = ipv4ToInt(netmask);
        broadcast = intToIPv4(((addr & mask) | (~mask >>> 0)) >>> 0);
      } catch (error) {
        broadcast = `${prefix}.255`;
      }
    }

    subnets.set(prefix, { prefix, broadcast });
  }

  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const iface of nets[name] || []) {
      const family = iface.family === 4 || iface.family === 'IPv4';
      if (!family || iface.internal) continue;
      add(iface.address, iface.netmask);
    }
  }

  add('192.168.4.2', '255.255.255.0');
  return Array.from(subnets.values());
}

function httpRequestText(host, route, options) {
  const opts = options || {};
  const body = opts.body || null;
  const timeoutMs = opts.timeoutMs || 800;
  const hostname = normalizeHost(host);

  return new Promise((resolve, reject) => {
    if (!hostname) {
      reject(new Error('Missing host'));
      return;
    }

    let settled = false;
    let uploadCompleted = false;
    let uploadFallbackTimer = null;
    let overallTimer = null;

    function resolveOnce(result) {
      if (settled) return;
      settled = true;
      if (uploadFallbackTimer) clearTimeout(uploadFallbackTimer);
      if (overallTimer) clearTimeout(overallTimer);
      resolve(result);
    }

    function rejectOnce(error) {
      if (settled) return;
      settled = true;
      if (uploadFallbackTimer) clearTimeout(uploadFallbackTimer);
      if (overallTimer) clearTimeout(overallTimer);
      reject(error);
    }

    function resolveUploadedFallback(message) {
      resolveOnce({
        statusCode: 202,
        headers: {},
        body: message || 'Upload complete. Device may be rebooting.',
      });
    }

    const req = http.request({
      hostname,
      port: 80,
      path: route,
      method: opts.method || 'GET',
      headers: opts.headers || {},
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        resolveOnce({
          statusCode: res.statusCode || 0,
          headers: res.headers || {},
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });

    req.on('timeout', () => {
      if (opts.resolveOnUploadComplete && uploadCompleted) {
        resolveUploadedFallback('Upload complete. Device rebooted before HTTP response.');
        try { req.destroy(); } catch (error) {}
        return;
      }
      req.destroy(new Error('timeout'));
    });
    req.on('error', (error) => {
      if (opts.resolveOnUploadComplete && uploadCompleted) {
        resolveUploadedFallback('Upload complete. Device rebooted before HTTP response.');
        return;
      }
      rejectOnce(error);
    });

    const overallTimeoutMs = Math.max(0, Number(opts.overallTimeoutMs) || 0);
    if (overallTimeoutMs > 0) {
      overallTimer = setTimeout(() => {
        if (opts.resolveOnUploadComplete && uploadCompleted) {
          resolveUploadedFallback('Upload complete. Device is rebooting.');
          try { req.destroy(); } catch (error) {}
          return;
        }
        rejectOnce(new Error('Upload timeout.'));
        try { req.destroy(); } catch (error) {}
      }, overallTimeoutMs);
    }

    if (!body) {
      req.end();
      return;
    }

    const uploadProgress = typeof opts.onUploadProgress === 'function' ? opts.onUploadProgress : null;
    if (!uploadProgress) {
      req.write(body);
      req.end();
      return;
    }

    const payload = Buffer.isBuffer(body) ? body : Buffer.from(body);
    const total = payload.length;
    const chunkSize = 64 * 1024;
    let offset = 0;

    function writeChunk() {
      if (offset >= total) {
        uploadCompleted = true;
        try { uploadProgress({ loaded: total, total, complete: true }); } catch (error) {}
        if (opts.resolveOnUploadComplete) {
          const graceMs = Math.max(0, Number(opts.resolveAfterUploadMs) || 1500);
          uploadFallbackTimer = setTimeout(() => {
            resolveUploadedFallback('Upload complete. Device is rebooting.');
            try { req.destroy(); } catch (error) {}
          }, graceMs);
        }
        req.end();
        return;
      }

      const next = Math.min(offset + chunkSize, total);
      const chunk = payload.subarray(offset, next);
      offset = next;
      const keepGoing = req.write(chunk);
      try { uploadProgress({ loaded: offset, total, complete: false }); } catch (error) {}
      if (keepGoing) {
        setImmediate(writeChunk);
      } else {
        req.once('drain', writeChunk);
      }
    }

    writeChunk();
  });
}
async function httpRequestJson(host, route, timeoutMs) {
  const res = await httpRequestText(host, route, { timeoutMs });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    throw new Error(`HTTP ${res.statusCode}`);
  }
  return JSON.parse(res.body);
}

function wifiPctFromRssi(rssi) {
  const value = Number(rssi);
  if (!Number.isFinite(value) || value === 0) return null;
  if (value >= -50) return 100;
  if (value <= -100) return 0;
  return Math.max(0, Math.min(100, Math.round((value + 100) * 2)));
}

function boolish(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

async function probeAuraXDevice(ip, timeoutMs, allowFallback) {
  const host = normalizeHost(ip);
  let info = null;
  let status = null;
  let config = null;
  let programs = null;

  try { status = await httpRequestJson(host, '/status', Math.min(timeoutMs || 900, 1400)); } catch (error) {}
  if (!status && !allowFallback) {
    try { info = await httpRequestJson(host, '/json/info', Math.min(timeoutMs || 900, 1400)); } catch (error) {}
    if (!info) return null;
  }


  const details = await Promise.allSettled([
    info ? Promise.resolve(info) : httpRequestJson(host, '/json/info', timeoutMs || 900),
    status ? Promise.resolve(status) : httpRequestJson(host, '/status', timeoutMs || 900),
    httpRequestJson(host, '/config', timeoutMs || 900),
    httpRequestJson(host, '/programs', timeoutMs || 900),
  ]);

  info = details[0].status === 'fulfilled' ? details[0].value : info;
  status = details[1].status === 'fulfilled' ? details[1].value : status;
  config = details[2].status === 'fulfilled' ? details[2].value : null;
  programs = details[3].status === 'fulfilled' ? details[3].value : null;


  const infoIsAuraX = !!(
    info && (
      info.cn === 'AuraX' ||
      info.brand === 'AuraX' ||
      info.product === 'AuraX' ||
      /AuraX/i.test(String(info.release || ''))
    )
  );
  const statusIsAuraX = !!(
    status && (
      status.sync_mask !== undefined ||
      status.logical_led_count !== undefined ||
      status.led_count !== undefined ||
      status.partition_layout !== undefined ||
      status.fw_build !== undefined
    )
  );
  const configIsAuraX = !!(config && (Number(config.numLeds) || config.renderMirror !== undefined || config.syncMask !== undefined));
  const isAuraX = !!(infoIsAuraX || statusIsAuraX || configIsAuraX);

  if (!isAuraX) return null;

  const numLeds = Number(
    (config && config.numLeds) ||
    (info && info.leds && info.leds.count) ||
    (status && (status.led_count || status.num_leds || status.numLeds)) ||
    0
  );
  const rssi = Number(
    (status && status.rssi) ||
    (info && info.wifi && info.wifi.rssi) ||
    0
  );
  const wifiPct = Number(
    (info && info.wifi && info.wifi.signal) ||
    wifiPctFromRssi(rssi) ||
    0
  );
  const batteryPctRaw = status && status.battery_pct;
  const batteryMvRaw = status && status.battery_mv;
  let syncEnabledRaw = status && status.sync_enabled !== undefined ? status.sync_enabled : undefined;
  if (syncEnabledRaw === undefined && config && config.syncEnabled !== undefined) {
    syncEnabledRaw = config.syncEnabled;
  }
  const syncMaskRaw = Number(
    (status && status.sync_mask) ||
    (config && config.syncMask) ||
    0
  );
  const syncChannelRaw = Number(
    (status && status.sync_channel) ||
    (config && config.syncChannel) ||
    0
  );
  const renderMirrorRaw = (config && config.renderMirror !== undefined)
    ? config.renderMirror
    : (status && status.render_mirror !== undefined ? status.render_mirror : undefined);
  const effectReverseRaw = (config && config.effectReverse !== undefined)
    ? config.effectReverse
    : (status && status.effect_reverse !== undefined ? status.effect_reverse : undefined);
  const logicalLedsRaw = Number(
    (status && (status.logical_led_count || status.logicalLeds)) ||
    (info && info.leds && info.leds.count) ||
    0
  );
  const logicalLeds = Number.isFinite(logicalLedsRaw) && logicalLedsRaw > 0
    ? logicalLedsRaw
    : (boolish(renderMirrorRaw) && numLeds > 1 ? Math.ceil(numLeds / 2) : numLeds);
  const fsTotal = Number(
    (programs && programs.total) ||
    (status && status.fs && (status.fs.t || status.fs.total)) ||
    (status && (status.fs_total || status.fsSize)) ||
    (info && info.fs && info.fs.t) ||
    0
  );
  const fsUsed = Number(
    (programs && programs.used) ||
    (status && status.fs && (status.fs.u || status.fs.used)) ||
    (status && status.fs_used) ||
    (info && info.fs && info.fs.u) ||
    0
  );
  const fsFree = Number(
    (programs && programs.free) ||
    (fsTotal > fsUsed ? fsTotal - fsUsed : 0)
  );
  const deviceName = (
    (config && (config.deviceName || config.hostname)) ||
    (status && (status.device_name || status.hostname)) ||
    (info && (info.name || info.hostname)) ||
    'AuraX'
  );

  return {
    ip: (status && status.ip) || (info && info.ip) || host,
    host,
    deviceName,
    hostname: deviceName,
    fwVersion: (status && (status.fw_version || status.version)) || (info && (info.ver || info.version)) || null,
    chipId: (status && status.chip_id) || (info && info.vid) || null,
    numLeds,
    logicalLeds,
    batteryPct: Number.isFinite(Number(batteryPctRaw)) ? Number(batteryPctRaw) : null,
    batteryMv: Number.isFinite(Number(batteryMvRaw)) ? Number(batteryMvRaw) : null,
    rssi,
    wifiPct,
    syncEnabled: syncEnabledRaw === undefined ? null : boolish(syncEnabledRaw),
    syncMask: Number.isFinite(syncMaskRaw) ? syncMaskRaw : 0,
    syncChannel: Number.isFinite(syncChannelRaw) ? syncChannelRaw : 0,
    renderMirror: renderMirrorRaw === undefined ? false : boolish(renderMirrorRaw),
    effectReverse: effectReverseRaw === undefined ? false : boolish(effectReverseRaw),
    fsFree,
    fsUsed,
    fsTotal,
    programsLoaded: !!(programs && Array.isArray(programs.files)),
    programs: programs && Array.isArray(programs.files) ? programs.files : [],
  };
}
function parseAuraXUdpDevice(text, rinfo) {
  const parts = String(text || '').trim().split(/\s+/);
  if (parts[0] !== 'AURAX') return null;

  const hostname = parts[1] && parts[1] !== '-' ? parts[1] : 'AuraX';
  const ip = normalizeHost(parts[2] || (rinfo && rinfo.address));
  if (!ip || !isPrivateIPv4(ip)) return null;

  const batteryPct = Number(parts[4]);
  const rssi = Number(parts[5]);
  const syncMask = Number(parts[7]);

  return {
    ip,
    host: ip,
    deviceName: hostname,
    hostname,
    chipId: parts[3] || null,
    batteryPct: Number.isFinite(batteryPct) ? batteryPct : null,
    rssi: Number.isFinite(rssi) ? rssi : 0,
    wifiPct: Number.isFinite(rssi) ? wifiPctFromRssi(rssi) : null,
    syncEnabled: parts[6] === undefined ? null : parts[6] === '1' || parts[6] === 'true',
    syncMask: Number.isFinite(syncMask) ? syncMask : 0,
    programs: [],
    source: 'udp',
  };
}

function auraXDeviceKey(device) {
  return normalizeHost((device && (device.host || device.ip)) || '');
}

function mergeAuraXDevice(current, next) {
  if (!current) return Object.assign({}, next || {});
  const merged = Object.assign({}, current);
  for (const key of Object.keys(next || {})) {
    const value = next[key];
    if (value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0 && Array.isArray(merged[key]) && merged[key].length > 0) continue;
    if (key === 'programsLoaded' && merged[key] === true && value === false) continue;
    if ((key === 'numLeds' || key === 'logicalLeds' || key === 'fsFree' || key === 'fsUsed' || key === 'fsTotal') && Number(value) === 0 && Number(merged[key]) > 0) continue;
    merged[key] = value;
  }
  return merged;
}

function sortAuraXDevices(devices) {
  return devices.sort((a, b) => {
    return String(a.deviceName || a.hostname || a.ip || '').localeCompare(String(b.deviceName || b.hostname || b.ip || ''));
  });
}

function discoverAuraXUdp(timeoutMs, onDeviceFound) {
  return new Promise((resolve) => {
    const found = new Map();
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    let finished = false;
    let sendTimer = null;

    function emit(device) {
      const key = auraXDeviceKey(device);
      if (!key) return;
      const merged = mergeAuraXDevice(found.get(key), device);
      found.set(key, merged);
      if (typeof onDeviceFound === 'function') {
        try { onDeviceFound(merged); } catch (error) {}
      }
    }

    function finish() {
      if (finished) return;
      finished = true;
      if (sendTimer) clearInterval(sendTimer);
      try { socket.close(); } catch (error) {}
      resolve(Array.from(found.values()));
    }

    socket.on('message', (msg, rinfo) => {
      const device = parseAuraXUdpDevice(msg.toString('utf8'), rinfo);
      if (device) emit(device);
    });
    socket.on('error', finish);
    socket.bind(4210, () => {
      try { socket.setBroadcast(true); } catch (error) {}
      const packet = Buffer.from('AURAX?');
      const broadcasts = new Set(['255.255.255.255', '192.168.4.255']);
      for (const subnet of getLocalAuraXSubnets()) broadcasts.add(subnet.broadcast);

      let sends = 0;
      function sendDiscovery() {
        sends++;
        for (const broadcast of broadcasts) {
          try { socket.send(packet, 0, packet.length, 4210, broadcast); } catch (error) {}
        }
        if (sends >= 3 && sendTimer) {
          clearInterval(sendTimer);
          sendTimer = null;
        }
      }
      sendDiscovery();
      sendTimer = setInterval(sendDiscovery, 350);
    });

    setTimeout(finish, timeoutMs || 1400);
  });
}

function probeIpList(ips, timeoutMs, concurrency, allowFallback, onDeviceFound) {
  return new Promise((resolve) => {
    const out = [];
    let index = 0;
    let active = 0;

    function runNext() {
      while (active < concurrency && index < ips.length) {
        const ip = ips[index++];
        active++;
        probeAuraXDevice(ip, timeoutMs, allowFallback)
          .then((device) => {
            if (!device) return;
            out.push(device);
            if (typeof onDeviceFound === 'function') {
              try { onDeviceFound(device); } catch (error) {}
            }
          })
          .catch(() => {})
          .finally(() => {
            active--;
            if (index >= ips.length && active === 0) {
              resolve(out);
            } else {
              runNext();
            }
          });
      }

      if (ips.length === 0) resolve(out);
    }

    runNext();
  });
}

async function scanAuraXDevices(timeoutMs, onDeviceFound) {
  const scanTimeout = Math.max(1000, Math.min(Number(timeoutMs) || 3200, 7000));
  const candidates = new Set(['192.168.4.1', 'aurax.local']);
  const devicesByHost = new Map();
  const detailHosts = new Set();
  const detailPromises = [];

  function emit(device) {
    const key = auraXDeviceKey(device);
    if (!key) return null;
    const merged = mergeAuraXDevice(devicesByHost.get(key), device);
    devicesByHost.set(key, merged);
    if (typeof onDeviceFound === 'function') {
      try { onDeviceFound(merged); } catch (error) {}
    }
    return merged;
  }

  function queueDetailProbe(host) {
    const normalized = normalizeHost(host);
    if (!normalized || detailHosts.has(normalized)) return;
    detailHosts.add(normalized);
    detailPromises.push(
      probeAuraXDevice(normalized, 2200, true)
        .then((device) => { if (device) emit(device); })
        .catch(() => {})
    );
  }

  for (const subnet of getLocalAuraXSubnets()) {
    for (let host = 1; host <= 254; host++) {
      candidates.add(`${subnet.prefix}.${host}`);
    }
  }

  const udpPromise = discoverAuraXUdp(Math.min(scanTimeout, 1800), (device) => {
    emit(device);
    queueDetailProbe(device.host || device.ip);
  });

  const scannedPromise = probeIpList(Array.from(candidates), 950, 72, false, (device) => {
    emit(device);
  });

  await scannedPromise;
  const udpDevices = await udpPromise;
  for (const device of udpDevices) {
    emit(device);
    queueDetailProbe(device.host || device.ip);
  }

  await Promise.allSettled(detailPromises);
  return sortAuraXDevices(Array.from(devicesByHost.values()));
}
function buildAuraXMultipartBody(fieldName, filename, data) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const safeField = String(fieldName || 'file').replace(/[^a-z0-9_-]/ig, '') || 'file';
  const safeName = path.basename(String(filename || 'upload.bin')).replace(/"/g, '');
  const boundary = `----IgnisAuraX${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  const head = Buffer.from(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${safeField}"; filename="${safeName}"\r\n` +
    `Content-Type: application/octet-stream\r\n\r\n`,
    'utf8'
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');
  const body = Buffer.concat([head, payload, tail]);

  return { body, boundary, size: payload.length, filename: safeName };
}

function uploadAuraXMultipart(host, route, fieldName, filename, data, timeoutMs, onProgress, requestOptions) {
  const targetHost = normalizeHost(host);
  const multipart = buildAuraXMultipartBody(fieldName, filename, data);
  const extraOptions = requestOptions || {};
  return httpRequestText(targetHost, route, Object.assign({}, extraOptions, {
    method: 'POST',
    timeoutMs: timeoutMs || 30000,
    body: multipart.body,
    onUploadProgress: onProgress,
    headers: {
      'Content-Type': `multipart/form-data; boundary=${multipart.boundary}`,
      'Content-Length': multipart.body.length,
    },
  })).then((res) => ({
    ok: res.statusCode >= 200 && res.statusCode < 300,
    statusCode: res.statusCode,
    body: res.body,
  }));
}

function uploadAuraXProgram(host, filename, data) {
  return uploadAuraXMultipart(host, '/program/upload', 'file', filename || 'program.axp', data, 30000);
}

function uploadAuraXFirmware(host, filename, data, onProgress) {
  return uploadAuraXMultipart(host, '/update', 'firmware', filename || 'firmware.bin', data, 45000, onProgress, {
    resolveOnUploadComplete: true,
    resolveAfterUploadMs: 1500,
    overallTimeoutMs: 90000,
  });
}
function postAuraXJson(host, route, payload, timeoutMs) {
  const body = Buffer.from(JSON.stringify(payload || {}), 'utf8');
  return httpRequestText(normalizeHost(host), route, {
    method: 'POST',
    timeoutMs: timeoutMs || 5000,
    body,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': body.length,
    },
  }).then((res) => ({
    ok: res.statusCode >= 200 && res.statusCode < 300,
    statusCode: res.statusCode,
    body: res.body,
  }));
}

function refreshAuraXDevice(host, timeoutMs) {
  return probeAuraXDevice(normalizeHost(host), timeoutMs || 1000, true);
}

function identifyAuraXDevice(host) {
  return postAuraXJson(host, '/identify', {}, 2500);
}

function reorderAuraXProgram(host, slot, direction) {
  return postAuraXJson(host, '/program/reorder', {
    slot: Number(slot),
    direction: Number(direction),
  }, 5000);
}

function deleteAuraXProgram(host, file) {
  return postAuraXJson(host, '/program/delete', { file: String(file || '') }, 5000);
}

function startAuraXProgram(host, slot, pressedAtMs, relay) {
  const targetHost = normalizeHost(host);
  const programSlot = Number(slot);
  const pressedAt = Number(pressedAtMs);
  const ageMs = Number.isFinite(pressedAt) ? Math.max(0, Math.min(30000, Date.now() - pressedAt)) : 0;
  const payload = { slot: programSlot, ageMs };
  if (relay !== undefined) payload.relay = !!relay;

  return postAuraXJson(targetHost, '/program/start', payload, 8000);
}

function stopAuraXProgram(host, relay) {
  const targetHost = normalizeHost(host);
  const route = relay === false ? '/stop?relay=0' : '/stop';
  return httpRequestText(targetHost, route, { timeoutMs: 5000 }).then((res) => ({
    ok: res.statusCode >= 200 && res.statusCode < 300,
    statusCode: res.statusCode,
    body: res.body,
  }));
}

const api = {
  dialogOpen(params) {
    return ipcRenderer.sendSync('dialog-open', JSON.stringify(params || {}));
  },
  dialogSave(params) {
    return ipcRenderer.sendSync('dialog-save', JSON.stringify(params || {}));
  },
  getAppPath() {
    return ipcRenderer.sendSync('get-app-path');
  },
  help() {
    ipcRenderer.send('help');
  },
  quit() {
    ipcRenderer.send('app-quit');
  },
  minimize() {
    ipcRenderer.send('app-minimize');
  },
  maximize() {
    ipcRenderer.send('app-maximize');
  },
  devtools() {
    ipcRenderer.send('devtools');
  },
  onOpenProject(callback) {
    if (typeof callback !== 'function') return;
    ipcRenderer.on('open-project-file', (event, filePath) => {
      callback(filePath);
    });
  },
  getPendingProjectFile() {
    return ipcRenderer.sendSync('get-pending-project-file');
  },
  setWindowPosition(position) {
    ipcRenderer.send('win-set-position', position);
  },
  platform: process.platform,
  resourcesPath: process.resourcesPath,
  appDataPath: process.env.APPDATA || '',
  homeDir: os.homedir(),
  getPathForFile(file) {
    try {
      if (webUtils && typeof webUtils.getPathForFile === 'function') {
        return webUtils.getPathForFile(file);
      }
    } catch (error) {
      return '';
    }
    return file && file.path ? file.path : '';
  },
  md5(value) {
    return md5(value);
  },
  listDrives() {
    return Promise.resolve(getDriveRoots());
  },
  readProjectZip(zipData) {
    const zip = new NodeZip().load(zipData);
    return {
      projectText: zip.file('project.json').asText(),
      image(hash) {
        return zip.folder('img').file(hash).asBinary();
      },
      audio(hash) {
        return zip.folder('audio').file(hash).asBinary();
      },
    };
  },
  createProjectZip(projectText, imageFiles, audioFile) {
    const zip = new NodeZip();
    zip.file('project.json', projectText);

    for (const hash in (imageFiles || {})) {
      zip.folder('img').file(hash, imageFiles[hash], { binary: true });
    }

    if (audioFile && audioFile.hash && audioFile.data) {
      zip.folder('audio').file(audioFile.hash, audioFile.data, { binary: true });
    }

    return zip.generate({ base64: false, compression: 'DEFLATE' });
  },
  execFile(command, args) {
    return new Promise((resolve) => {
      childProcess.execFile(command, args || [], {
        timeout: 120000,
        windowsHide: true,
      }, (error, stdout, stderr) => {
        resolve({
          error: error ? {
            message: error.message,
            code: error.code,
            signal: error.signal,
          } : null,
          stdout: stdout,
          stderr: stderr,
        });
      });
    });
  },
  scanAuraXDevices(timeoutMs, onDeviceFound) {
    return scanAuraXDevices(timeoutMs, onDeviceFound);
  },
  uploadAuraXProgram(host, filename, data) {
    return uploadAuraXProgram(host, filename, data);
  },
  uploadAuraXFirmware(host, filename, data, onProgress) {
    return uploadAuraXFirmware(host, filename, data, onProgress);
  },
  refreshAuraXDevice(host, timeoutMs) {
    return refreshAuraXDevice(host, timeoutMs);
  },
  identifyAuraXDevice(host) {
    return identifyAuraXDevice(host);
  },
  reorderAuraXProgram(host, slot, direction) {
    return reorderAuraXProgram(host, slot, direction);
  },
  deleteAuraXProgram(host, file) {
    return deleteAuraXProgram(host, file);
  },
  startAuraXProgram(host, slot, pressedAtMs, relay) {
    return startAuraXProgram(host, slot, pressedAtMs, relay);
  },
  stopAuraXProgram(host, relay) {
    return stopAuraXProgram(host, relay);
  },
  fs: {
    existsSync(filePath) {
      return fs.existsSync(filePath);
    },
    mkdirSync(dirPath, options) {
      return fs.mkdirSync(dirPath, options);
    },
    readdirSync(dirPath) {
      return fs.readdirSync(dirPath);
    },
    readFileSync(filePath, encoding) {
      return fs.readFileSync(filePath, encoding);
    },
    writeFileSync(filePath, data, encoding) {
      return fs.writeFileSync(filePath, data, encoding);
    },
    writeFile(filePath, data, callback) {
      fs.writeFile(filePath, data, function (error) {
        if (callback) callback(error || null);
      });
    },
    unlinkSync(filePath) {
      return fs.unlinkSync(filePath);
    },
    renameSync(from, to) {
      return fs.renameSync(from, to);
    },
    copyFileSync(from, to) {
      return fs.copyFileSync(from, to);
    },
    statSync(filePath) {
      return cloneStats(fs.statSync(filePath));
    },
  },
  path: {
    sep: path.sep,
    basename(filePath) {
      return path.basename(filePath);
    },
    extname(filePath) {
      return path.extname(filePath);
    },
  },
};

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('ignisElectron', api);
} else {
  window.ignisElectron = api;
  window.Buffer = Buffer;
}
