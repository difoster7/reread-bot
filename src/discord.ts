const API = "https://discord.com/api/v10";
const USER_AGENT = "DiscordBot (reread-bot, 1)";
const TIMEOUT_MS = 10_000;
const MAX_RETRIES = 3;
const ARCHIVE_AFTER_MINUTES = 10080; // 7 days, Discord's maximum

export interface ForumPost {
    name: string;
    content: string;
    tagIds: string[];
    roleId?: string;
}

/** The Discord operations the bot needs; faked in tests. */
export interface DiscordApi {
    /** Creates a forum post; returns the thread ID. */
    createForumPost(channelId: string, post: ForumPost): Promise<string>;
    /** Creates an empty public thread in a text channel; returns its ID. */
    createThread(channelId: string, name: string): Promise<string>;
    /** Posts a message; returns the message ID. */
    sendMessage(channelId: string, content: string, roleId?: string): Promise<string>;
    archiveThread(threadId: string, locked: boolean): Promise<void>;
    deleteChannel(channelId: string): Promise<void>;
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>;
type Sleep = (ms: number) => Promise<void>;

interface ErrorBody {
    code?: number;
    message?: string;
    errors?: unknown;
}

/** Discord answered with an error status: the action definitely did not happen. */
export class DiscordHttpError extends Error {
    readonly method: string;
    readonly path: string;
    readonly status: number;
    readonly code?: number;
    readonly errors?: unknown;

    constructor(method: string, path: string, status: number, body: ErrorBody) {
        super(`Discord ${method} ${path} → ${status}${body.message ? `: ${body.message}` : ""}`);
        this.name = "DiscordHttpError";
        this.method = method;
        this.path = path;
        this.status = status;
        this.code = body.code;
        this.errors = body.errors;
    }
}

/** No answer (network failure or timeout): the action may or may not have happened. */
export class DiscordNetworkError extends Error {
    readonly method: string;
    readonly path: string;

    constructor(method: string, path: string, cause: unknown) {
        super(`Discord ${method} ${path} did not complete: ${String(cause)}`, { cause });
        this.name = "DiscordNetworkError";
        this.method = method;
        this.path = path;
    }
}

function mentions(roleId?: string): { parse: string[]; roles?: string[] } {
    return roleId ? { parse: [], roles: [roleId] } : { parse: [] };
}

async function retryAfterMs(res: Response): Promise<number> {
    const body = (await res.json().catch(() => ({}))) as { retry_after?: unknown };
    const seconds =
        typeof body.retry_after === "number"
            ? body.retry_after
            : Number(res.headers.get("Retry-After"));
    return Math.ceil((Number.isFinite(seconds) && seconds > 0 ? seconds : 1) * 1000);
}

async function errorBody(res: Response): Promise<ErrorBody> {
    const text = await res.text();
    try {
        return JSON.parse(text) as ErrorBody;
    } catch {
        return { message: text.slice(0, 200) };
    }
}

export class DiscordClient implements DiscordApi {
    private readonly token: string;
    private readonly fetchFn: Fetch;
    private readonly sleep: Sleep;

    constructor(
        token: string,
        // Wrapped: Workers throws "Illegal invocation" if fetch is called as a method.
        fetchFn: Fetch = (url, init) => fetch(url, init),
        sleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    ) {
        this.token = token;
        this.fetchFn = fetchFn;
        this.sleep = sleep;
    }

    async createForumPost(channelId: string, post: ForumPost): Promise<string> {
        const thread = await this.request<{ id: string }>("POST", `/channels/${channelId}/threads`, {
            name: post.name,
            auto_archive_duration: ARCHIVE_AFTER_MINUTES,
            message: { content: post.content, allowed_mentions: mentions(post.roleId) },
            ...(post.tagIds.length > 0 ? { applied_tags: post.tagIds } : {}),
        });
        return thread.id;
    }

    async createThread(channelId: string, name: string): Promise<string> {
        const thread = await this.request<{ id: string }>("POST", `/channels/${channelId}/threads`, {
            name,
            type: 11, // PUBLIC_THREAD
            auto_archive_duration: ARCHIVE_AFTER_MINUTES,
        });
        return thread.id;
    }

    async sendMessage(channelId: string, content: string, roleId?: string): Promise<string> {
        const message = await this.request<{ id: string }>("POST", `/channels/${channelId}/messages`, {
            content,
            allowed_mentions: mentions(roleId),
        });
        return message.id;
    }

    async archiveThread(threadId: string, locked: boolean): Promise<void> {
        await this.request("PATCH", `/channels/${threadId}`, { archived: true, locked });
    }

    async deleteChannel(channelId: string): Promise<void> {
        await this.request("DELETE", `/channels/${channelId}`);
    }

    private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
        for (let attempt = 0; ; attempt++) {
            let res: Response;
            try {
                res = await this.fetchFn(`${API}${path}`, {
                    method,
                    headers: {
                        Authorization: `Bot ${this.token}`,
                        "Content-Type": "application/json",
                        "User-Agent": USER_AGENT,
                    },
                    body: body === undefined ? undefined : JSON.stringify(body),
                    signal: AbortSignal.timeout(TIMEOUT_MS),
                });
            } catch (cause) {
                throw new DiscordNetworkError(method, path, cause);
            }
            if (res.status === 429 && attempt < MAX_RETRIES) {
                await this.sleep(await retryAfterMs(res));
                continue;
            }
            if (!res.ok) throw new DiscordHttpError(method, path, res.status, await errorBody(res));
            return (res.status === 204 ? undefined : await res.json()) as T;
        }
    }
}
