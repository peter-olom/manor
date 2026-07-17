export type RuntimeEgressDomain = {
  domain: string;
  source: "built-in" | "operator";
  removable: boolean;
};

export type RuntimeEgressDomainsResponse = {
  domains: RuntimeEgressDomain[];
};

type FetchLike = typeof fetch;

async function readError(response: Response): Promise<string> {
  const payload = await response.json().catch(() => null) as { error?: unknown } | null;
  if (typeof payload?.error === "string" && payload.error.trim()) return payload.error.trim();
  return `Runtime egress request failed with HTTP ${response.status}.`;
}

export class RuntimeEgressClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string | null,
    private readonly fetchImpl: FetchLike = fetch
  ) {}

  async list(): Promise<RuntimeEgressDomainsResponse> {
    return await this.request("/domains", { method: "GET" });
  }

  async add(domain: string): Promise<RuntimeEgressDomainsResponse> {
    return await this.request("/domains", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ domain })
    });
  }

  async remove(domain: string): Promise<RuntimeEgressDomainsResponse> {
    return await this.request(`/domains/${encodeURIComponent(domain)}`, { method: "DELETE" });
  }

  private async request(pathname: string, init: RequestInit): Promise<RuntimeEgressDomainsResponse> {
    if (!this.token) throw new Error("Runtime egress service token is not configured.");
    let response: Response;
    try {
      response = await this.fetchImpl(new URL(pathname, this.baseUrl), {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init.headers).entries()),
          Authorization: `Bearer ${this.token}`
        }
      });
    } catch (error) {
      throw new Error(`Runtime egress service is unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new Error(await readError(response));
    return await response.json() as RuntimeEgressDomainsResponse;
  }
}
