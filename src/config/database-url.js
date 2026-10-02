export function encodeDatabaseUrl(value) {
  const match = value.match(/^(postgres(?:ql)?:\/\/)([^:]+):([\s\S]*)@([^@]+)$/);
  if (!match) throw new Error('Invalid database connection URL');
  let password = match[3];
  try { password = decodeURIComponent(password); } catch { /* A literal percent is encoded below. */ }
  const encoded = encodeURIComponent(password).replace(/[!'()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  const result = `${match[1]}${match[2]}:${encoded}@${match[4]}`;
  const url = new URL(result);
  if (!url.hostname || !url.pathname) throw new Error('Invalid database connection URL');
  return result;
}
