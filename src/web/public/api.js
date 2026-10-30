// fetch wrapper for the kb web API.

export class ApiError extends Error {
  constructor(status, code, message, body) {
    super(message);
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

async function request(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: method === "GET" ? {} : { "content-type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify(body ?? {}),
      cache: "no-store",
    });
  } catch (e) {
    throw new ApiError(0, "network", "Cannot reach the server");
  }
  let data = null;
  try {
    data = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    throw new ApiError(res.status, data?.code ?? "http", data?.error ?? `HTTP ${res.status}`, data);
  }
  return data;
}

const enc = encodeURIComponent;

export const api = {
  config: () => request("GET", "/api/config"),
  putConfig: (body) => request("PUT", "/api/config", body),
  board: (query) => request("GET", "/api/board" + (query ? "?" + query : "")),
  get: (id) => request("GET", `/api/tickets/${enc(id)}`),
  create: (body) => request("POST", "/api/tickets", body),
  patch: (id, body) => request("PATCH", `/api/tickets/${enc(id)}`, body),
  comment: (id, text, mtime) => request("POST", `/api/tickets/${enc(id)}/comments`, { text, mtime }),
  validate: () => request("GET", "/api/validate"),
  testAutomation: (body) => request("POST", "/api/automation/test", body),
  automationLog: () => request("GET", "/api/automation/log"),
  automationRuns: () => request("GET", "/api/automation/runs"),
  killRun: (id) => request("POST", `/api/automation/runs/${enc(id)}/kill`, {}),
  events: (params) => request("GET", "/api/events" + (params ? "?" + params : "")),
  fix: (dryRun) => request("POST", "/api/fix", { dryRun }),
};
