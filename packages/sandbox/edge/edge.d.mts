// edge.mjs는 컨테이너에서 의존성 없이 그대로 실행하는 스크립트라 타입을 따로 적는다
import type net from 'node:net';

export interface Forward {
  listen: number;
  host: string;
  port: number;
}

export interface EdgePolicyRule {
  callers: string[];
  methods: string[];
  paths?: string[];
}

export type MaskPatternName = 'phone' | 'email' | 'residentNumber' | 'card';

export interface EdgePolicy {
  allow?: EdgePolicyRule[];
  /** 소문자로 맞춘 필드 이름 */
  mask: string[];
  /** 값의 형태로 가릴 패턴 이름 */
  maskPatterns: MaskPatternName[];
  auth?: { header: string; secret: string; prefix?: string };
}

export interface EdgeExternal {
  name: string;
  baseUrl: URL;
  policy: EdgePolicy;
}

export type EdgeEgressRule =
  | string
  | {
      host: string;
      methods?: string[];
      paths?: string[];
    };

export interface NormalizedEgressRule {
  host: string;
  hostOnly?: boolean;
  methods?: string[];
  paths?: string[];
}

export interface UpstreamRequest {
  method: string;
  pathname: string;
  search?: string;
  headers?: Record<string, string | string[] | undefined>;
  body?: Buffer;
}

export interface UpstreamResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  masked: number;
}

export interface ApiAuditEntry {
  caller: string;
  via: string;
  target: string;
  method: string;
  path: string;
  decision: 'allow' | 'deny';
  status?: number;
  masked?: number;
  reason?: string;
}

export declare const PROXY_PORT: number;
export declare const API_PORT: number;
export declare const STUDIO_CALLER: 'studio';

export declare class ApiPolicyError extends Error {
  constructor(status: number, message: string);
  readonly status: number;
}

export declare function parseForwards(text?: string): Forward[];
export declare function parseAllow(text?: string): string[];
export declare function normalizeEgressRule(rule: EdgeEgressRule): NormalizedEgressRule;
export declare function parseEgressRules(text?: string): NormalizedEgressRule[];
export declare function hasEgressRuleFor(host: string, port: number, rules: EdgeEgressRule[]): boolean;
export declare function isAllowedEgress(host: string, port: number, method: string, pathname: string, rules: EdgeEgressRule[]): boolean;
export declare function hasEncodedSeparator(pathname: string): boolean;
export declare function isPrivateAddress(address: string): boolean;
export declare function splitHostPort(target: string): { host: string; port: number } | undefined;
export declare function parseExternals(text?: string): EdgeExternal[];
export declare function normalizeExternal(external: { name: string; baseUrl: string; policy?: Partial<EdgePolicy> }): EdgeExternal;
export declare const MASK_PATTERNS: Record<MaskPatternName, RegExp>;
export declare function maskValues(text: string, patterns?: MaskPatternName[]): { text: string; masked: number };
export declare function maskJson(value: unknown, fields: string[], patterns?: MaskPatternName[]): { value: unknown; masked: number };
export declare function matchPath(pattern: string, pathname: string): boolean;
export declare function isAllowedCall(policy: EdgePolicy, caller: string, method: string, pathname: string): boolean;
export declare function upstreamUrl(baseUrl: URL | string, pathname: string, search?: string): URL;
export declare function callerResolver(
  names: string[],
  lookup?: (name: string) => Promise<Array<{ address: string }>>,
): (address: string | undefined) => Promise<string | undefined>;
export declare function callUpstream(external: EdgeExternal, secrets: Record<string, string | undefined>, request: UpstreamRequest): Promise<UpstreamResult>;
export declare function auditApi(entry: ApiAuditEntry): void;
export declare function startEdge(options: { forwards: Forward[]; rules: EdgeEgressRule[]; proxyPort?: number }): net.Server[];
export declare function startApiProxy(options: {
  externals: EdgeExternal[];
  secrets?: Record<string, string | undefined>;
  resolveCaller: (address: string | undefined) => Promise<string | undefined>;
  port?: number;
  host?: string;
  log?: (entry: ApiAuditEntry) => void;
}): net.Server;
