(() => {
  const LOG = '[Dify Batch Export]';
  const encoder = new TextEncoder();


  const log = (...args) => console.log(LOG, ...args);
  const err = (...args) => console.error(LOG, ...args);


  const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');


  const getCookie = (name) => {
    const match = document.cookie.match(
      new RegExp(`(?:^|; )${escapeRegExp(name)}=([^;]*)`)
    );
    return match ? decodeURIComponent(match[1]) : null;
  };


  const getApiBase = () => {
    const entries = performance.getEntries().map(e => e.name).filter(Boolean);


    for (const name of entries) {
      try {
        const url = new URL(name, location.origin);
        if (url.pathname.includes('/console/api')) {
          return `${url.origin}/console/api`;
        }
      } catch {}
    }


    for (const name of entries) {
      try {
        const url = new URL(name, location.origin);
        if (url.pathname.includes('/api')) {
          return `${url.origin}/api`;
        }
      } catch {}
    }


    return `${location.origin}/console/api`;
  };


  const getAuthHeaders = () => {
    const headers = {};
    const csrfNames = [
      '__Host-csrf_token',
      'csrf_token',
      'csrf-token',
      'x-csrf-token'
    ];


    const csrfHit = csrfNames
      .map(name => [name, getCookie(name)])
      .find(([, value]) => Boolean(value));


    if (csrfHit) {
      const token = csrfHit[1];
      headers['X-CSRF-Token'] = token;
      headers['X-CSRFToken'] = token;
      return headers;
    }


    const consoleToken =
      localStorage.console_token ||
      sessionStorage.console_token ||
      window.console_token;


    if (consoleToken) {
      headers.Authorization = `Bearer ${consoleToken}`;
    }


    return headers;
  };


  const sanitizeFileName = (name) => {
    const cleaned = (name || 'unnamed-app')
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
      .replace(/\s+/g, ' ')
      .trim();
    return cleaned || 'unnamed-app';
  };


  const getDateTag = () => {
    const d = new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}${mm}${dd}`;
  };


  const getPrefix = () => `[dify.ai-${getDateTag()}]`;


  // ===== ZIP: Pure frontend STORE mode, no third-party library =====
  const buildCrcTable = () => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c >>> 0;
    }
    return table;
  };


  const CRC_TABLE = buildCrcTable();


  const crc32 = (bytes) => {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) {
      c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  };


  const u16 = (n) => new Uint8Array([n & 0xFF, (n >>> 8) & 0xFF]);


  const u32 = (n) =>
    new Uint8Array([
      n & 0xFF,
      (n >>> 8) & 0xFF,
      (n >>> 16) & 0xFF,
      (n >>> 24) & 0xFF
    ]);


  const concat = (parts) => {
    const total = parts.reduce((sum, part) => sum + part.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.length;
    }
    return out;
  };


  const toDosTimeDate = (date = new Date()) => {
    const year = Math.max(1980, date.getFullYear());
    const dosTime =
      (date.getHours() << 11) |
      (date.getMinutes() << 5) |
      Math.floor(date.getSeconds() / 2);
    const dosDate =
      ((year - 1980) << 9) |
      ((date.getMonth() + 1) << 5) |
      date.getDate();
    return { dosTime, dosDate };
  };


  const buildZip = (files) => {
    const localParts = [];
    const centralParts = [];
    let localOffset = 0;


    for (const file of files) {
      const nameBytes = encoder.encode(file.name);
      const dataBytes =
        typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
      const crc = crc32(dataBytes);
      const { dosTime, dosDate } = toDosTimeDate(file.date || new Date());
      const flags = 0x0800;
      const compression = 0;


      const localHeader = concat([
        u32(0x04034b50),
        u16(20),
        u16(flags),
        u16(compression),
        u16(dosTime),
        u16(dosDate),
        u32(crc),
        u32(dataBytes.length),
        u32(dataBytes.length),
        u16(nameBytes.length),
        u16(0),
        nameBytes,
        dataBytes
      ]);


      localParts.push(localHeader);


      const centralHeader = concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(flags),
        u16(compression),
        u16(dosTime),
        u16(dosDate),
        u32(crc),
        u32(dataBytes.length),
        u32(dataBytes.length),
        u16(nameBytes.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(0),
        u32(localOffset),
        nameBytes
      ]);


      centralParts.push(centralHeader);
      localOffset += localHeader.length;
    }


    const localData = concat(localParts);
    const centralDirectory = concat(centralParts);


    const endRecord = concat([
      u32(0x06054b50),
      u16(0),
      u16(0),
      u16(files.length),
      u16(files.length),
      u32(centralDirectory.length),
      u32(localData.length),
      u16(0)
    ]);


    return new Blob([localData, centralDirectory, endRecord], {
      type: 'application/zip'
    });
  };


  const uniqueFileName = (used, base, suffix = '.yaml') => {
    let name = `${base}${suffix}`;
    if (!used.has(name)) {
      used.add(name);
      return name;
    }


    let i = 2;
    while (used.has(`${base} (${i})${suffix}`)) i += 1;
    name = `${base} (${i})${suffix}`;
    used.add(name);
    return name;
  };


  const downloadBlob = (blob, fileName) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  };


  const run = async () => {
    const apiBase = getApiBase();
    const authHeaders = getAuthHeaders();
    const limit = 100;
    const prefix = getPrefix();


    const fetchJson = async (url) => {
      const response = await fetch(url, {
        method: 'GET',
        credentials: 'include',
        cache: 'no-store',
        headers: authHeaders
      });


      if (!response.ok) {
        let body = '';
        try {
          body = await response.text();
        } catch {}
        throw new Error(
          `${response.status} ${response.statusText}${
            body ? ` | ${body.slice(0, 300)}` : ''
          }`
        );
      }


      return response.json();
    };


    log('API_BASE =', apiBase);


    // Read all apps (auto pagination)
    const apps = [];
    let page = 1;


    while (true) {
      const payload = await fetchJson(
        `${apiBase}/apps?page=${page}&limit=${limit}&name=&is_created_by_me=false`
      );
      const items = payload.data || payload.items || [];
      apps.push(...items);


      log(`Read page ${page}, ${items.length} apps, total ${apps.length}`);


      const hasMore = Boolean(payload.has_more ?? payload.has_next);
      if (!hasMore || items.length === 0) break;
      page += 1;
    }


    if (!apps.length) {
      throw new Error('No apps retrieved');
    }


    const files = [];
    const failed = [];
    const usedNames = new Set();


    for (let i = 0; i < apps.length; i++) {
      const app = apps[i];
      try {
        const payload = await fetchJson(
          `${apiBase}/apps/${app.id}/export?include_secret=false`
        );


        const yaml = payload.data;


        if (typeof yaml !== 'string' || !yaml.trim()) {
          throw new Error('Export result empty');
        }


        const base = sanitizeFileName(app.name || `app-${app.id}`);
        const fileName = uniqueFileName(usedNames, `${prefix}${base}`);


        files.push({
          name: fileName,
          data: yaml,
          date: new Date()
        });


        log(`Export success ${i + 1}/${apps.length}: ${fileName}`);
      } catch (e) {
        failed.push({
          app: app.name || app.id,
          error: e.message
        });
        err(`Export failed ${i + 1}/${apps.length}`, e);
      }
    }


    if (!files.length) {
      throw new Error('All exports failed');
    }


    const zipBlob = buildZip(files);
    const zipName = `${prefix}dify_apps_yaml.zip`;


    downloadBlob(zipBlob, zipName);


    console.group(`${LOG} Completed`);
    console.log('Success:', files.length);
    console.log('Failed:', failed.length);
    if (failed.length) console.table(failed);
    console.groupEnd();


    alert(
      `Export completed: ${files.length} success, ${failed.length} failed.\nDownload started: ${zipName}`
    );
  };


  run().catch((e) => {
    err('Overall failure:', e);
    alert(`Export failed: ${e.message}`);
  });
})();
