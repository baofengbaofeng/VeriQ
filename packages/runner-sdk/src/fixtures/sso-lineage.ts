/**
 * 在认证窗口内关联同一主框架的两类浏览器事件。只保留有限协议标识、来源分类和授权结果，原始请求不进入等待队列。
 */
export type Owner = "APP" | "API" | "IDP" | "OTHER";
export type Admission = "initial" | "initialIdpRead" | "chain" | "landing" | "handoff" | "identity" | "resource";

interface Hop {
    method: string;
    type: string;
    target: Owner;
    redirected: boolean;
}

interface NetworkHop extends Hop {
    time?: number;
    loader: string;
    owner: Owner;
}

interface PausedHop extends Hop {
    id: string;
    parent?: string;
    admission: Admission;
    responseTag?: string;
}

interface Pair {
    network?: NetworkHop;
    source?: { valid: boolean; fulfilled: boolean };
    terminalAt?: number;
    paused?: PausedHop;
    timer: ReturnType<typeof setTimeout>;
}

interface Document {
    kind: "landing" | "identity";
    loader: string;
    owner: Owner;
    grant: { valid: boolean; fulfilled: boolean };
    committed: boolean;
}

const waitMs = 15000;
const validId = (id: unknown): id is string => typeof id === "string" && id.length > 0 && id.length <= 256;

/**
 * 逐项计算待配对请求、已使用的导航父跳以及可加载资源的文档标识，另为主框架、当前父跳与响应票据预留十个位置。
 * 普通资源在浏览器确认继续命令后释放，导航历史保留到认证结束。
 * 每次转发前验证父跳与单次使用约束，防止陈旧事件覆盖同一网络请求的下一跳。
 */
export class SsoLineage {
    private pairs = new Map<string, Pair>();
    private documents = new Map<string, Document>();
    private completed = new Map<
        string,
        { last: string; previous: string[]; cancellable: boolean; started: number | undefined }
    >();
    private continuing = new Map<string, object>();
    private active = true;
    private commitListener?: { kind: "landing" | "identity"; finish: (ok: boolean) => void };

    constructor(
        private readonly decide: (
            id: string,
            allowed: boolean,
            document: boolean,
            admission?: Admission,
            responseTag?: string,
            acknowledged?: () => void,
        ) => void,
        private readonly violation: () => void,
    ) {}

    private withinBudget(additional: number): boolean {
        let count = 10 + this.documents.size * 2 + this.continuing.size;
        for (const pair of this.pairs.values()) {
            count++;
            if (pair.network?.loader) count++;
            if (pair.paused) count += pair.paused.parent === undefined ? 1 : 2;
        }
        for (const hop of this.completed.values()) count += 2 + hop.previous.length;
        if (count + additional <= 128) return true;
        this.violation();
        return false;
    }

    private entry(key: string): Pair | undefined {
        if (!this.active) return;
        const existing = this.pairs.get(key);
        if (existing) return existing;
        if (!validId(key)) {
            this.violation();
            return;
        }
        if (!this.withinBudget(1)) return;
        const pair = { timer: setTimeout(this.violation, waitMs) };
        this.pairs.set(key, pair);
        return pair;
    }

    network(key: string, hop: NetworkHop) {
        const pair = this.entry(key);
        if (!pair) return;
        if (!validId(hop.loader) || pair.network) return this.violation();
        if (pair.terminalAt !== undefined && (hop.time === undefined || pair.terminalAt >= hop.time))
            return this.violation();
        if (hop.type === "Document") {
            if (!this.withinBudget(1)) return;
            pair.network = hop;
        } else {
            const source = [...this.documents.values()].find(
                (doc) => doc.loader === hop.loader && doc.owner === hop.owner,
            );
            if (source) pair.source = source.grant;
            pair.network = { ...hop, loader: "" };
        }
        this.match(key, pair);
    }

    private usedDocumentId(id: string) {
        return [...this.completed.values()].some((hop) => hop.last === id || hop.previous.includes(id));
    }

    private continueResource(id: string, admission: Admission) {
        if (this.continuing.has(id)) return this.violation();
        if (!this.withinBudget(1)) return this.decide(id, false, false);
        const turn = {};
        this.continuing.set(id, turn);
        const acknowledge = () => {
            if (this.continuing.get(id) === turn) this.continuing.delete(id);
        };
        this.decide(id, true, false, admission, undefined, acknowledge);
    }

    paused(key: string, hop: PausedHop) {
        if (this.continuing.has(hop.id)) return this.violation();
        if (hop.admission === "initialIdpRead") {
            if (
                !this.active ||
                !validId(key) ||
                !validId(hop.id) ||
                (hop.parent !== undefined && !validId(hop.parent)) ||
                this.usedDocumentId(hop.id) ||
                this.pairs.has(key) ||
                [...this.pairs.values()].some((pair) => pair.paused?.id === hop.id)
            )
                return this.decide(hop.id, false, false);
            return this.continueResource(hop.id, "initial");
        }
        const pair = this.entry(key);
        if (pair?.paused?.id === hop.id) {
            clearTimeout(pair.timer);
            this.pairs.delete(key);
            return this.decide(hop.id, false, hop.type === "Document");
        }
        if (!pair || !validId(hop.id) || (hop.parent !== undefined && !validId(hop.parent)) || pair.paused) {
            this.decide(hop.id, false, hop.type === "Document");
            return;
        }
        if (!this.withinBudget(hop.parent === undefined ? 1 : 2))
            return this.decide(hop.id, false, hop.type === "Document");
        pair.paused = hop;
        this.match(key, pair);
    }

    private match(key: string, pair: Pair) {
        const { network, paused } = pair;
        if (!network || !paused) return;
        let allowed =
            network.method === paused.method &&
            network.type === paused.type &&
            network.target === paused.target &&
            network.redirected === paused.redirected &&
            (paused.type !== "Document" || this.completed.get(key)?.last === paused.parent) &&
            !this.usedDocumentId(paused.id);
        if (allowed && paused.admission === "resource") {
            const owner = pair.source;
            allowed = !!owner?.valid;
            if (allowed && !owner?.fulfilled) return;
        }
        clearTimeout(pair.timer);
        this.pairs.delete(key);
        if (paused.type !== "Document") {
            if (!allowed) return this.decide(paused.id, false, false);
            return this.continueResource(paused.id, paused.admission);
        }
        const documentKind =
            paused.admission === "handoff"
                ? "landing"
                : paused.admission === "landing" || paused.admission === "identity"
                  ? paused.admission
                  : undefined;
        if (documentKind && (network.owner !== paused.target || this.documents.has(paused.id))) allowed = false;
        const earlier = this.completed.get(key);
        if (allowed) allowed = this.withinBudget((earlier ? 1 : 2) + (documentKind ? 2 : 0));
        if (allowed) {
            if (documentKind)
                this.documents.set(paused.id, {
                    kind: documentKind,
                    loader: network.loader,
                    owner: network.owner,
                    grant: { valid: true, fulfilled: false },
                    committed: false,
                });
            if (earlier) {
                earlier.previous.push(earlier.last);
                earlier.last = paused.id;
                earlier.cancellable = paused.admission === "handoff";
                earlier.started = network.time;
            } else
                this.completed.set(key, {
                    last: paused.id,
                    previous: [],
                    cancellable: paused.admission === "handoff",
                    started: network.time,
                });
        }
        this.decide(paused.id, allowed, paused.type === "Document", paused.admission, paused.responseTag);
    }

    terminal(key: string, time?: number) {
        const pair = this.pairs.get(key);
        if (!pair) return;
        if (time !== undefined && Number.isFinite(time)) {
            if (!pair.network) {
                pair.terminalAt = time;
                return;
            }
            if (pair.network.time !== undefined && time < pair.network.time) return;
        }
        this.violation();
    }

    canceledHandoff(key: string, time: number): string | undefined {
        const hop = this.completed.get(key);
        if (
            this.pairs.has(key) ||
            !hop?.cancellable ||
            hop.started === undefined ||
            !Number.isFinite(time) ||
            time < hop.started
        )
            return;
        const doc = this.documents.get(hop.last);
        if (doc?.committed || doc?.grant.fulfilled || !doc) return;
        return hop.last;
    }

    response(id: string, successfulDocument: boolean) {
        const doc = this.documents.get(id);
        if (!doc) return;
        if (successfulDocument) doc.grant.fulfilled = true;
        else {
            doc.grant.valid = false;
            this.documents.delete(id);
            if (doc.kind === "identity" && this.commitListener?.kind === doc.kind) this.commitListener.finish(false);
        }
        this.notifyCommit();
        for (const [key, pair] of this.pairs) this.match(key, pair);
    }

    confirmed(kind: "landing" | "identity"): boolean {
        return [...this.documents.values()].some((doc) => doc.kind === kind && doc.committed && doc.grant.fulfilled);
    }

    frame(loader: string, owner: Owner) {
        for (const doc of this.documents.values()) {
            if (doc.loader === loader && doc.owner === owner) doc.committed = true;
        }
        this.notifyCommit();
    }

    private notifyCommit() {
        const listener = this.commitListener;
        if (listener && this.confirmed(listener.kind)) listener.finish(true);
    }

    async committed(kind: "landing" | "identity" = "landing"): Promise<boolean> {
        if (!this.active || this.commitListener) return false;
        if (this.confirmed(kind)) return true;
        return new Promise((resolve) => {
            const timer = setTimeout(() => this.commitListener?.finish(false), kind === "landing" ? waitMs : 10000);
            this.commitListener = {
                kind,
                finish: (ok) => {
                    clearTimeout(timer);
                    delete this.commitListener;
                    resolve(ok);
                },
            };
        });
    }

    isContinuing(id: string): boolean {
        return this.continuing.has(id);
    }

    close(preserveInFlight = false): boolean {
        this.active = false;
        this.commitListener?.finish(false);
        const empty = this.pairs.size === 0;
        const abandoned = [...this.pairs.values()];
        this.pairs.clear();
        this.documents.clear();
        this.completed.clear();
        if (!preserveInFlight || !empty) this.continuing.clear();
        for (const pair of abandoned) {
            clearTimeout(pair.timer);
            if (pair.paused) this.decide(pair.paused.id, false, pair.paused.type === "Document");
        }
        return empty;
    }
}
