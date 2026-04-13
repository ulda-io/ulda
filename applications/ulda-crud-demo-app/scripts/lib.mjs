export const expect = (condition, message) => {
  if (!condition) throw new Error(message);
};

export const b64 = value => Buffer.from(value, 'utf8').toString('base64');

export async function postJson(baseUrl, path, body) {
  const res = await fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await res.json();
  return { status: res.status, body: payload };
}
