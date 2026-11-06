// Build-time port only: browser/request input cannot redirect stored tokens.
export function controlServerPort(value) {
  if (value == null || value === '') return 4100;
  if (!/^\d{1,5}$/.test(String(value))) throw new Error('PB_WEB_API_PORT must be a numeric TCP port');
  const port = Number(value);
  if (port < 1024 || port > 65535) throw new Error('PB_WEB_API_PORT must be 1024-65535');
  return port;
}
