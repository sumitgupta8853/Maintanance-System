/**
 * Minimal HTTP client wrapper around native `fetch`.
 * Matches the interface used by the SMS provider code:
 *   client.get(url, { timeout, headers, validateStatus }) -> { data, status }
 *   client.post(url, body, { headers, timeout, validateStatus }) -> { data, status }
 */
const request = async (url, opts = {}) => {
  const {
    method = 'GET',
    body,
    headers = {},
    timeout = 10000,
    validateStatus = () => true,
  } = opts;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const fetchOpts = {
      method,
      headers: { 'Accept': 'application/json', ...headers },
      signal: controller.signal,
    };

    if (body && method !== 'GET') {
      fetchOpts.headers['Content-Type'] = 'application/json';
      fetchOpts.body = typeof body === 'string' ? body : JSON.stringify(body);
    }

    const res = await fetch(url, fetchOpts);
    clearTimeout(timeoutId);

    let data;
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      data = await res.json();
    } else {
      data = await res.text();
    }

    return { data, status: res.status, ok: validateStatus(res.status, data) };
  } catch (err) {
    clearTimeout(timeoutId);
    throw err;
  }
};

export const httpClient = {
  get: (url, opts) => request(url, { method: 'GET', ...opts }),
  post: (url, body, opts) => request(url, { method: 'POST', body, ...opts }),
};
