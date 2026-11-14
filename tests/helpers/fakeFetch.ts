export interface Call {
  method: string;
  url: string;
  body: any;
  headers: Record<string, string>;
}

type Responder = (call: Call) => Response | Promise<Response>;

/** A fetch stand-in that records calls and answers from route handlers matched by "METHOD url-substring". */
export function fakeFetch(routes: Array<[string, Responder]>) {
  const calls: Call[] = [];
  const fn = async (input: any, init: any = {}) => {
    const url = String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    let body: any = init.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        /* leave as string */
      }
    }
    const headers: Record<string, string> = {};
    new Headers(init.headers ?? {}).forEach((v, k) => (headers[k] = v));
    const call = { method, url, body, headers };
    calls.push(call);
    const route = routes.find(([key]) => {
      const [m, frag] = key.split(' ');
      return m === method && url.includes(frag);
    });
    if (!route) return new Response(`no route for ${method} ${url}`, { status: 599 });
    return route[1](call);
  };
  return { fetch: fn as unknown as typeof fetch, calls };
}

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(data === undefined ? null : JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

export const tokenResponse = () => json({ access_token: 'tok', expires_in: 7200, token_type: 'User Access Token' });
