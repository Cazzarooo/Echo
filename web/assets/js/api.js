export class ApiError extends Error {
  constructor(status, code, message, field = null) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = field;
  }
}

async function request(method, path, body) {
  let response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network', 'Sem conexão com o servidor. Tente de novo em instantes.');
  }

  let data = null;
  if (response.status !== 204) {
    try {
      data = await response.json();
    } catch {
      data = null;
    }
  }
  if (!response.ok) {
    const error = data?.error ?? {};
    throw new ApiError(response.status, error.code ?? 'error', error.message ?? 'Algo deu errado. Tente de novo.', error.field ?? null);
  }
  return data;
}

export const api = {
  register: (account) => request('POST', '/api/auth/register', account),
  login: (credentials) => request('POST', '/api/auth/login', credentials),
  logout: () => request('POST', '/api/auth/logout', {}),
  bootstrap: () => request('GET', '/api/bootstrap'),

  createSpace: (name) => request('POST', '/api/spaces', { name }),
  joinSpace: (code) => request('POST', '/api/spaces/join', { code }),
  createChannel: (spaceId, name) => request('POST', `/api/spaces/${spaceId}/channels`, { name }),

  listMessages: (channelId, { before } = {}) =>
    request('GET', `/api/channels/${channelId}/messages${before ? `?before=${before}` : ''}`),
  sendMessage: (channelId, content) => request('POST', `/api/channels/${channelId}/messages`, { content }),
  ack: (channelId, messageId) => request('POST', `/api/channels/${channelId}/ack`, { messageId }),
};
