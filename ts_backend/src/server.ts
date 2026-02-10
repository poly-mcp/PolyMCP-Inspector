import cors from "cors";
import express, { NextFunction, Request, Response } from "express";
import { createServer } from "node:http";
import { randomUUID, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { URLSearchParams } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { MCPServerConfig, MCPStdioClient } from "./mcp_stdio_client";

type ServerType = "http" | "stdio";
type ServerStatus = "connected" | "disconnected" | "error";
type HttpMode = "jsonrpc" | "legacy";

interface ServerInfo {
  id: string;
  name: string;
  url: string;
  type: ServerType;
  status: ServerStatus;
  tools_count: number;
  connected_at: string;
  last_request?: string;
  error?: string;
}

interface ToolMetrics {
  name: string;
  calls: number;
  total_time: number;
  avg_time: number;
  success_count: number;
  error_count: number;
  last_called?: string;
}

interface ActivityLog {
  timestamp: string;
  server_id: string;
  method: string;
  tool_name: string | null;
  status: number;
  duration: number;
  error?: string;
}

interface TestCase {
  id: string;
  name: string;
  server_id: string;
  tool_name: string;
  parameters: Record<string, any>;
  expected_status?: string;
  created_at?: string;
}

interface TestSuite {
  id: string;
  name: string;
  description: string;
  test_cases: TestCase[];
  created_at: string;
  last_run?: string;
}

interface HttpProfile {
  mode: HttpMode;
  rpc_endpoint?: string;
  base_url: string;
  initialize?: Record<string, any>;
}

interface InspectorOptions {
  host: string;
  port: number;
  secure_mode: boolean;
  api_key?: string;
  allowed_origins?: string[];
  rate_limit_per_minute: number;
  rate_limit_window_seconds: number;
  verbose: boolean;
}

interface AuthenticatedRequest extends Request {
  ip_key?: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function elapsedMs(start: number): number {
  return Date.now() - start;
}

function deepClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

function randomKey(): string {
  return randomUUID().replace(/-/g, "");
}

function secureEq(a: string, b: string): boolean {
  if (!a || !b) {
    return false;
  }
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) {
    return false;
  }
  return timingSafeEqual(ba, bb);
}

async function fetchJson(url: string, init: RequestInit, timeoutMs: number): Promise<any> {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: abort.signal });
    const text = await response.text();
    let data: any = {};
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = text;
      }
    }
    if (!response.ok) {
      const msg = typeof data === "string" ? data : JSON.stringify(data);
      throw new Error(`HTTP ${response.status} ${response.statusText}: ${msg}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

class ServerManager {
  public readonly servers = new Map<string, ServerInfo>();
  private readonly stdioClients = new Map<string, MCPStdioClient>();
  private readonly stdioConfigs = new Map<string, MCPServerConfig>();
  private readonly httpToolsCache = new Map<string, any[]>();
  private readonly httpProfiles = new Map<string, HttpProfile>();
  private readonly httpRequestIds = new Map<string, number>();
  public readonly toolMetrics = new Map<string, Map<string, ToolMetrics>>();
  public readonly activityLogs: ActivityLog[] = [];
  private readonly maxLogs = 1000;
  private readonly activeConnections = new Set<WebSocket>();
  private readonly testSuites = new Map<string, TestSuite>();
  private testSuitesDir: string;
  private readonly verbose: boolean;

  constructor(verbose: boolean) {
    this.verbose = verbose;
    this.testSuitesDir = path.join(os.tmpdir(), "polymcp-inspector", "test-suites");
  }

  async init(): Promise<void> {
    this.testSuitesDir = await this.resolveWritableTestSuitesDir();
    this.log("Using test suites dir:", this.testSuitesDir);
    console.warn(`[polymcp-inspector-ts] state dir: ${this.testSuitesDir}`);
    await this.loadTestSuites();
  }

  private async resolveWritableTestSuitesDir(): Promise<string> {
    const preferredStateDir = String(process.env.POLYMCP_INSPECTOR_STATE_DIR || "").trim();
    const candidatesRaw = [
      preferredStateDir ? path.join(preferredStateDir, "test-suites") : "",
      path.join(os.homedir(), ".polymcp", "inspector", "test-suites"),
      process.env.APPDATA
        ? path.join(process.env.APPDATA, "io.polymcp.inspector", "test-suites")
        : "",
      path.join(os.tmpdir(), "polymcp-inspector", "test-suites"),
    ];
    const candidates: string[] = [];
    for (const candidate of candidatesRaw) {
      if (!candidate) {
        continue;
      }
      const normalized = path.resolve(candidate);
      if (!candidates.includes(normalized)) {
        candidates.push(normalized);
      }
    }

    const errors: string[] = [];
    for (const dir of candidates) {
      try {
        await fs.mkdir(dir, { recursive: true });
        const probe = path.join(dir, ".write-test");
        await fs.writeFile(probe, "ok", "utf8");
        await fs.unlink(probe).catch(() => {});
        return dir;
      } catch (error: any) {
        errors.push(`${dir}: ${error?.message || String(error)}`);
      }
    }

    throw new Error(`Unable to initialize writable state directory: ${errors.join(" | ")}`);
  }

  private log(...args: any[]): void {
    if (this.verbose) {
      console.log("[inspector-ts]", ...args);
    }
  }

  private nextHttpRequestId(serverId: string): number {
    const next = (this.httpRequestIds.get(serverId) || 0) + 1;
    this.httpRequestIds.set(serverId, next);
    return next;
  }

  private getHttpCandidates(rawUrl: string): { rpc: string[]; legacy: string[] } {
    const normalized = (rawUrl || "").trim().replace(/\/+$/, "");
    if (!normalized) {
      throw new Error("Empty server URL");
    }

    const rpc: string[] = [];
    const legacy: string[] = [];
    const pushUnique = (arr: string[], value: string) => {
      if (value && !arr.includes(value)) {
        arr.push(value);
      }
    };

    pushUnique(rpc, normalized);
    pushUnique(legacy, normalized);

    if (normalized.endsWith("/mcp")) {
      pushUnique(legacy, normalized.slice(0, -4).replace(/\/+$/, ""));
    } else {
      pushUnique(rpc, `${normalized}/mcp`);
    }

    if (normalized.endsWith("/list_tools")) {
      const base = normalized.slice(0, -11).replace(/\/+$/, "");
      pushUnique(legacy, base);
      pushUnique(rpc, base);
      pushUnique(rpc, `${base}/mcp`);
    }

    if (normalized.endsWith("/invoke")) {
      const base = normalized.slice(0, -7).replace(/\/+$/, "");
      pushUnique(legacy, base);
      pushUnique(rpc, `${base}/mcp`);
    }

    return { rpc, legacy };
  }

  private async httpJsonrpcCall(
    serverId: string,
    endpoint: string,
    method: string,
    params?: Record<string, any>,
    timeoutMs = 15_000,
  ): Promise<Record<string, any>> {
    const payload: Record<string, any> = {
      jsonrpc: "2.0",
      id: this.nextHttpRequestId(serverId),
      method,
    };
    if (params !== undefined) {
      payload.params = params;
    }

    const data = await fetchJson(
      endpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
      },
      timeoutMs,
    );

    const doc = Array.isArray(data) ? data[0] || {} : data;
    if (!doc || typeof doc !== "object") {
      throw new Error(`Invalid JSON-RPC response for ${method}`);
    }
    if (doc.error) {
      const msg = doc.error?.message || JSON.stringify(doc.error);
      const code = doc.error?.code;
      throw new Error(`${method} failed${code ? ` (${code})` : ""}: ${msg}`);
    }

    const result = doc.result;
    if (!result || typeof result !== "object") {
      return { value: result };
    }
    return result;
  }

  private async discoverHttpServer(serverId: string, url: string): Promise<[HttpProfile, any[]]> {
    const candidates = this.getHttpCandidates(url);
    const discoveryErrors: string[] = [];

    for (const endpoint of candidates.rpc) {
      try {
        const initResult = await this.httpJsonrpcCall(
          serverId,
          endpoint,
          "initialize",
          {
            protocolVersion: "2024-11-05",
            capabilities: {
              tools: {},
              resources: { subscribe: true },
              prompts: {},
            },
            clientInfo: { name: "polymcp-inspector-ts", version: "0.1.0" },
          },
          8_000,
        );

        try {
          await this.httpJsonrpcCall(serverId, endpoint, "notifications/initialized", {}, 5_000);
        } catch {
          // Optional notification.
        }

        const toolsResult = await this.httpJsonrpcCall(serverId, endpoint, "tools/list", {}, 10_000);
        const tools = Array.isArray(toolsResult.tools) ? toolsResult.tools : [];
        const profile: HttpProfile = {
          mode: "jsonrpc",
          rpc_endpoint: endpoint,
          base_url: endpoint.endsWith("/mcp") ? endpoint.slice(0, -4).replace(/\/+$/, "") : endpoint.replace(/\/+$/, ""),
          initialize: initResult,
        };
        return [profile, tools];
      } catch (error: any) {
        discoveryErrors.push(`JSON-RPC ${endpoint}: ${error?.message || String(error)}`);
      }
    }

    for (const baseUrl of candidates.legacy) {
      try {
        const data = await fetchJson(`${baseUrl}/list_tools`, { method: "GET" }, 6_000);
        const tools = Array.isArray(data?.tools) ? data.tools : [];
        const profile: HttpProfile = { mode: "legacy", base_url: baseUrl };
        return [profile, tools];
      } catch (error: any) {
        discoveryErrors.push(`Legacy ${baseUrl}: ${error?.message || String(error)}`);
      }
    }

    throw new Error(discoveryErrors.slice(-5).join("; ") || "Unknown HTTP discovery failure");
  }

  async addHttpServer(serverId: string, name: string, url: string): Promise<Record<string, any>> {
    try {
      const [profile, tools] = await this.discoverHttpServer(serverId, url);

      const server: ServerInfo = {
        id: serverId,
        name,
        url,
        type: "http",
        status: "connected",
        tools_count: tools.length,
        connected_at: nowIso(),
      };
      this.servers.set(serverId, server);
      this.httpProfiles.set(serverId, profile);
      this.httpToolsCache.set(serverId, tools);

      const metrics = new Map<string, ToolMetrics>();
      for (const tool of tools) {
        const toolName = String(tool?.name || "").trim();
        if (!toolName) {
          continue;
        }
        metrics.set(toolName, {
          name: toolName,
          calls: 0,
          total_time: 0,
          avg_time: 0,
          success_count: 0,
          error_count: 0,
        });
      }
      this.toolMetrics.set(serverId, metrics);

      await this.broadcastUpdate("server_added", deepClone(server));
      return { status: "success", server: deepClone(server) };
    } catch (error: any) {
      const errorMsg = `Failed to connect to ${url}: ${error?.message || String(error)}`;
      const server: ServerInfo = {
        id: serverId,
        name,
        url,
        type: "http",
        status: "error",
        tools_count: 0,
        connected_at: nowIso(),
        error: errorMsg,
      };
      this.servers.set(serverId, server);
      await this.broadcastUpdate("server_error", { server_id: serverId, error: errorMsg });
      return { status: "error", error: errorMsg };
    }
  }

  async addStdioServer(
    serverId: string,
    name: string,
    command: string,
    args: string[],
    env?: Record<string, string>,
  ): Promise<Record<string, any>> {
    try {
      const config: MCPServerConfig = { command, args, env };
      const client = new MCPStdioClient(config);
      await client.start();
      const tools = await client.listTools();

      this.stdioClients.set(serverId, client);
      this.stdioConfigs.set(serverId, config);

      const server: ServerInfo = {
        id: serverId,
        name,
        url: `stdio://${command}`,
        type: "stdio",
        status: "connected",
        tools_count: tools.length,
        connected_at: nowIso(),
      };
      this.servers.set(serverId, server);

      const metrics = new Map<string, ToolMetrics>();
      for (const tool of tools) {
        const toolName = String(tool?.name || "").trim();
        if (!toolName) {
          continue;
        }
        metrics.set(toolName, {
          name: toolName,
          calls: 0,
          total_time: 0,
          avg_time: 0,
          success_count: 0,
          error_count: 0,
        });
      }
      this.toolMetrics.set(serverId, metrics);

      await this.broadcastUpdate("server_added", deepClone(server));
      return { status: "success", server: deepClone(server) };
    } catch (error: any) {
      const errorMsg = `Failed to start ${command}: ${error?.message || String(error)}`;
      const server: ServerInfo = {
        id: serverId,
        name,
        url: `stdio://${command}`,
        type: "stdio",
        status: "error",
        tools_count: 0,
        connected_at: nowIso(),
        error: errorMsg,
      };
      this.servers.set(serverId, server);
      await this.broadcastUpdate("server_error", { server_id: serverId, error: errorMsg });
      return { status: "error", error: errorMsg };
    }
  }

  async removeServer(serverId: string): Promise<Record<string, any>> {
    if (!this.servers.has(serverId)) {
      throw new Error(`Server ${serverId} not found`);
    }

    const stdio = this.stdioClients.get(serverId);
    if (stdio) {
      await stdio.stop();
      this.stdioClients.delete(serverId);
      this.stdioConfigs.delete(serverId);
    }

    this.httpToolsCache.delete(serverId);
    this.httpProfiles.delete(serverId);
    this.httpRequestIds.delete(serverId);
    this.toolMetrics.delete(serverId);
    this.servers.delete(serverId);

    await this.broadcastUpdate("server_removed", { server_id: serverId });
    return { status: "success" };
  }

  private setServerLastRequest(serverId: string): void {
    const server = this.servers.get(serverId);
    if (!server) {
      return;
    }
    server.last_request = nowIso();
  }

  private updateMetrics(serverId: string, toolName: string, duration: number, ok: boolean): void {
    if (!this.toolMetrics.has(serverId)) {
      this.toolMetrics.set(serverId, new Map<string, ToolMetrics>());
    }
    const serverMetrics = this.toolMetrics.get(serverId)!;
    const existing = serverMetrics.get(toolName) || {
      name: toolName,
      calls: 0,
      total_time: 0,
      avg_time: 0,
      success_count: 0,
      error_count: 0,
    };
    existing.calls += 1;
    existing.total_time += duration;
    existing.avg_time = existing.calls > 0 ? existing.total_time / existing.calls : 0;
    if (ok) {
      existing.success_count += 1;
    } else {
      existing.error_count += 1;
    }
    existing.last_called = nowIso();
    serverMetrics.set(toolName, existing);
  }

  private logActivity(entry: ActivityLog): void {
    this.activityLogs.push(entry);
    while (this.activityLogs.length > this.maxLogs) {
      this.activityLogs.shift();
    }
  }

  async getTools(serverId: string): Promise<any[]> {
    const server = this.servers.get(serverId);
    if (!server) {
      throw new Error(`Server ${serverId} not found`);
    }

    if (server.type === "http") {
      const profile = this.httpProfiles.get(serverId) || { mode: "legacy", base_url: server.url };
      if (profile.mode === "jsonrpc" && profile.rpc_endpoint) {
        const tools: any[] = [];
        let cursor: string | undefined;
        for (let i = 0; i < 50; i += 1) {
          const params = cursor ? { cursor } : {};
          const result = await this.httpJsonrpcCall(serverId, profile.rpc_endpoint, "tools/list", params, 15_000);
          const pageTools = Array.isArray(result.tools) ? result.tools : [];
          tools.push(...pageTools);
          const nextCursor = result.nextCursor;
          if (!nextCursor) {
            break;
          }
          cursor = String(nextCursor);
        }
        this.httpToolsCache.set(serverId, tools);
        return tools;
      }
      return this.httpToolsCache.get(serverId) || [];
    }

    const stdio = this.stdioClients.get(serverId);
    if (!stdio) {
      return [];
    }
    return stdio.listTools();
  }

  async executeTool(serverId: string, toolName: string, parameters: Record<string, any>): Promise<Record<string, any>> {
    const server = this.servers.get(serverId);
    if (!server) {
      throw new Error(`Server ${serverId} not found`);
    }
    const started = Date.now();

    try {
      let result: any;
      if (server.type === "http") {
        const profile = this.httpProfiles.get(serverId) || { mode: "legacy", base_url: server.url };
        if (profile.mode === "jsonrpc" && profile.rpc_endpoint) {
          result = await this.httpJsonrpcCall(
            serverId,
            profile.rpc_endpoint,
            "tools/call",
            { name: toolName, arguments: parameters || {} },
            45_000,
          );
          if (result && typeof result === "object" && result.isError === true) {
            let msg = "Tool returned isError=true";
            const content = Array.isArray(result.content) ? result.content : [];
            for (const item of content) {
              if (item && typeof item === "object" && item.text) {
                msg = String(item.text);
                break;
              }
            }
            throw new Error(msg);
          }
        } else {
          const base = profile.base_url.replace(/\/+$/, "");
          const candidates: Array<{ url: string; payload: any }> = [
            { url: `${base}/tools/${encodeURIComponent(toolName)}`, payload: parameters || {} },
            { url: `${base}/invoke/${encodeURIComponent(toolName)}`, payload: parameters || {} },
            { url: `${base}/invoke`, payload: { tool: toolName, parameters: parameters || {} } },
          ];
          let lastError = "Legacy call failed";
          let done = false;
          result = {};
          for (const c of candidates) {
            try {
              const response = await fetch(c.url, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Accept: "application/json",
                },
                body: JSON.stringify(c.payload),
              });
              if (!response.ok) {
                throw new Error(`HTTP ${response.status} ${response.statusText}`);
              }
              const ctype = response.headers.get("content-type") || "";
              if (ctype.includes("application/json")) {
                result = await response.json();
              } else {
                result = { status: "success", result: await response.text() };
              }
              done = true;
              break;
            } catch (error: any) {
              lastError = `${c.url}: ${error?.message || String(error)}`;
            }
          }
          if (!done) {
            throw new Error(lastError);
          }
        }
      } else {
        const stdio = this.stdioClients.get(serverId);
        if (!stdio) {
          throw new Error(`Stdio server ${serverId} not running`);
        }
        result = await stdio.invokeTool(toolName, parameters || {});
      }

      const duration = elapsedMs(started);
      this.updateMetrics(serverId, toolName, duration, true);
      this.logActivity({
        timestamp: nowIso(),
        server_id: serverId,
        method: "execute_tool",
        tool_name: toolName,
        status: 200,
        duration,
      });
      this.setServerLastRequest(serverId);
      await this.broadcastUpdate("tool_executed", { server_id: serverId, tool_name: toolName, duration });
      return { status: "success", result, duration };
    } catch (error: any) {
      const duration = elapsedMs(started);
      const errorMsg = error?.message || String(error);
      this.updateMetrics(serverId, toolName, duration, false);
      this.logActivity({
        timestamp: nowIso(),
        server_id: serverId,
        method: "execute_tool",
        tool_name: toolName,
        status: 500,
        duration,
        error: errorMsg,
      });
      await this.broadcastUpdate("tool_error", { server_id: serverId, tool_name: toolName, error: errorMsg });
      return { status: "error", error: errorMsg, duration };
    }
  }

  async listResources(serverId: string): Promise<any[]> {
    const server = this.servers.get(serverId);
    if (!server) {
      throw new Error(`Server ${serverId} not found`);
    }

    try {
      if (server.type === "http") {
        const profile = this.httpProfiles.get(serverId) || { mode: "legacy", base_url: server.url };
        if (profile.mode === "jsonrpc" && profile.rpc_endpoint) {
          const resources: any[] = [];
          let cursor: string | undefined;
          for (let i = 0; i < 50; i += 1) {
            const params = cursor ? { cursor } : {};
            const result = await this.httpJsonrpcCall(serverId, profile.rpc_endpoint, "resources/list", params, 15_000);
            const page = Array.isArray(result.resources) ? result.resources : [];
            resources.push(...page);
            const nextCursor = result.nextCursor;
            if (!nextCursor) {
              break;
            }
            cursor = String(nextCursor);
          }
          return resources;
        }
        const data = await fetchJson(`${profile.base_url.replace(/\/+$/, "")}/list_resources`, { method: "GET" }, 10_000);
        return Array.isArray(data?.resources) ? data.resources : [];
      }

      const stdio = this.stdioClients.get(serverId);
      if (!stdio) {
        return [];
      }
      const response = await stdio.sendRequest("resources/list", {});
      return Array.isArray(response?.result?.resources) ? response.result.resources : [];
    } catch {
      return [];
    }
  }

  async readResource(serverId: string, uri: string): Promise<Record<string, any>> {
    const server = this.servers.get(serverId);
    if (!server) {
      throw new Error(`Server ${serverId} not found`);
    }
    const started = Date.now();

    try {
      let result: any = {};
      if (server.type === "http") {
        const profile = this.httpProfiles.get(serverId) || { mode: "legacy", base_url: server.url };
        if (profile.mode === "jsonrpc" && profile.rpc_endpoint) {
          result = await this.httpJsonrpcCall(serverId, profile.rpc_endpoint, "resources/read", { uri }, 20_000);
        } else {
          const base = profile.base_url.replace(/\/+$/, "");
          const encoded = encodeURIComponent(uri);
          try {
            const response = await fetch(`${base}/resources/${encoded}`);
            if (!response.ok) {
              throw new Error(`HTTP ${response.status}`);
            }
            const ctype = response.headers.get("content-type") || "text/plain";
            if (ctype.includes("application/json")) {
              const payload = await response.json();
              if (payload && typeof payload === "object" && payload.contents) {
                result = payload;
              } else {
                result = {
                  contents: [
                    {
                      uri,
                      mimeType: "application/json",
                      text: JSON.stringify(payload, null, 2),
                    },
                  ],
                };
              }
            } else {
              result = {
                contents: [{ uri, mimeType: ctype, text: await response.text() }],
              };
            }
          } catch {
            const fallback = await fetchJson(
              `${base}/resources/read`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json", Accept: "application/json" },
                body: JSON.stringify({ uri }),
              },
              15_000,
            );
            result = fallback && typeof fallback === "object"
              ? (fallback.contents ? fallback : { contents: [fallback] })
              : { contents: [] };
          }
        }
      } else {
        const stdio = this.stdioClients.get(serverId);
        if (!stdio) {
          throw new Error(`Stdio server ${serverId} not running`);
        }
        const response = await stdio.sendRequest("resources/read", { uri });
        result = response?.result || {};
      }

      const duration = elapsedMs(started);
      this.logActivity({
        timestamp: nowIso(),
        server_id: serverId,
        method: "read_resource",
        tool_name: uri,
        status: 200,
        duration,
      });
      await this.broadcastUpdate("resource_read", { server_id: serverId, uri, duration });
      return { status: "success", contents: Array.isArray(result.contents) ? result.contents : [], duration };
    } catch (error: any) {
      const duration = elapsedMs(started);
      return { status: "error", error: error?.message || String(error), duration };
    }
  }

  async listPrompts(serverId: string): Promise<any[]> {
    const server = this.servers.get(serverId);
    if (!server) {
      throw new Error(`Server ${serverId} not found`);
    }

    try {
      if (server.type === "http") {
        const profile = this.httpProfiles.get(serverId) || { mode: "legacy", base_url: server.url };
        if (profile.mode !== "jsonrpc" || !profile.rpc_endpoint) {
          return [];
        }
        const prompts: any[] = [];
        let cursor: string | undefined;
        for (let i = 0; i < 50; i += 1) {
          const params = cursor ? { cursor } : {};
          const result = await this.httpJsonrpcCall(serverId, profile.rpc_endpoint, "prompts/list", params, 15_000);
          const page = Array.isArray(result.prompts) ? result.prompts : [];
          prompts.push(...page);
          const nextCursor = result.nextCursor;
          if (!nextCursor) {
            break;
          }
          cursor = String(nextCursor);
        }
        return prompts;
      }

      const stdio = this.stdioClients.get(serverId);
      if (!stdio) {
        return [];
      }
      const response = await stdio.sendRequest("prompts/list", {});
      return Array.isArray(response?.result?.prompts) ? response.result.prompts : [];
    } catch {
      return [];
    }
  }

  async getPrompt(serverId: string, promptName: string, arguments_: Record<string, any>): Promise<Record<string, any>> {
    const server = this.servers.get(serverId);
    if (!server) {
      throw new Error(`Server ${serverId} not found`);
    }
    const started = Date.now();
    try {
      let result: any = {};
      if (server.type === "http") {
        const profile = this.httpProfiles.get(serverId) || { mode: "legacy", base_url: server.url };
        if (profile.mode !== "jsonrpc" || !profile.rpc_endpoint) {
          throw new Error("Prompt APIs are available only on JSON-RPC MCP endpoints");
        }
        result = await this.httpJsonrpcCall(
          serverId,
          profile.rpc_endpoint,
          "prompts/get",
          { name: promptName, arguments: arguments_ || {} },
          20_000,
        );
      } else {
        const stdio = this.stdioClients.get(serverId);
        if (!stdio) {
          throw new Error(`Stdio server ${serverId} not running`);
        }
        const response = await stdio.sendRequest("prompts/get", { name: promptName, arguments: arguments_ || {} });
        result = response?.result || {};
      }
      const duration = elapsedMs(started);
      this.logActivity({
        timestamp: nowIso(),
        server_id: serverId,
        method: "get_prompt",
        tool_name: promptName,
        status: 200,
        duration,
      });
      return {
        status: "success",
        messages: Array.isArray(result.messages) ? result.messages : [],
        description: result.description || "",
        duration,
      };
    } catch (error: any) {
      return { status: "error", error: error?.message || String(error), duration: elapsedMs(started) };
    }
  }

  async proxyMcpRequest(serverId: string, method: string, params: Record<string, any> = {}): Promise<Record<string, any>> {
    const server = this.servers.get(serverId);
    if (!server) {
      throw new Error(`Server ${serverId} not found`);
    }
    if (!method) {
      throw new Error("method is required");
    }
    const started = Date.now();

    try {
      let result: any = {};
      if (server.type === "http") {
        const profile = this.httpProfiles.get(serverId) || { mode: "legacy", base_url: server.url };
        if (profile.mode !== "jsonrpc" || !profile.rpc_endpoint) {
          throw new Error("Generic MCP request requires JSON-RPC endpoint");
        }
        result = await this.httpJsonrpcCall(serverId, profile.rpc_endpoint, method, params, 30_000);
      } else {
        const stdio = this.stdioClients.get(serverId);
        if (!stdio) {
          throw new Error(`Stdio server ${serverId} not running`);
        }
        const response = await stdio.sendRequest(method, params || {});
        if (response.error) {
          throw new Error(response.error.message || "MCP request failed");
        }
        result = response.result || {};
      }

      const duration = elapsedMs(started);
      this.logActivity({
        timestamp: nowIso(),
        server_id: serverId,
        method: `mcp:${method}`,
        tool_name: null,
        status: 200,
        duration,
      });
      return { status: "success", result, duration };
    } catch (error: any) {
      const duration = elapsedMs(started);
      this.logActivity({
        timestamp: nowIso(),
        server_id: serverId,
        method: `mcp:${method}`,
        tool_name: null,
        status: 500,
        duration,
        error: error?.message || String(error),
      });
      return { status: "error", error: error?.message || String(error), duration };
    }
  }

  private ollamaBaseUrl(): string {
    return (process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434").replace(/\/+$/, "");
  }

  private openaiBaseUrl(): string {
    return (process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
  }

  private anthropicBaseUrl(): string {
    return (process.env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1").replace(/\/+$/, "");
  }

  async listOllamaModels(): Promise<Record<string, any>> {
    const base = this.ollamaBaseUrl();
    try {
      const payload = await fetchJson(`${base}/api/tags`, { method: "GET" }, 5_000);
      const models = Array.isArray(payload?.models) ? payload.models : [];
      const namesRaw = models
        .map((m: any) => m?.name)
        .filter((x: any) => typeof x === "string")
        .map((x: string) => x.trim())
        .filter((x: string) => x.length > 0);
      const names = Array.from(new Set(namesRaw));
      return {
        status: "success",
        provider: "ollama",
        base_url: base,
        source: "ollama_api_tags",
        fetched_at: nowIso(),
        models: names,
      };
    } catch (error: any) {
      return { status: "error", provider: "ollama", base_url: base, error: error?.message || String(error), models: [] };
    }
  }

  async listOpenAIModels(): Promise<Record<string, any>> {
    const apiKey = (process.env.OPENAI_API_KEY || "").trim();
    if (!apiKey) {
      return { status: "error", provider: "openai", error: "Missing OPENAI_API_KEY", models: [] };
    }
    try {
      const payload = await fetchJson(
        `${this.openaiBaseUrl()}/models`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${apiKey}` },
        },
        10_000,
      );
      const data = Array.isArray(payload?.data) ? payload.data : [];
      const names = data
        .map((m: any) => m?.id)
        .filter((x: any) => typeof x === "string")
        .sort();
      return { status: "success", provider: "openai", models: names };
    } catch (error: any) {
      return { status: "error", provider: "openai", error: error?.message || String(error), models: [] };
    }
  }

  async listAnthropicModels(): Promise<Record<string, any>> {
    const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim();
    if (!apiKey) {
      return { status: "error", provider: "anthropic", error: "Missing ANTHROPIC_API_KEY", models: [] };
    }
    return {
      status: "success",
      provider: "anthropic",
      models: ["claude-3-5-sonnet-latest", "claude-3-7-sonnet-latest", "claude-3-opus-latest"],
      note: "Configured defaults. Override with your own model id if needed.",
    };
  }

  private extractJsonObject(text: string): Record<string, any> | null {
    if (!text) {
      return null;
    }
    const raw = text.trim();

    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, any>;
      }
    } catch {
      // Continue.
    }

    if (raw.includes("```")) {
      const chunks = raw.replace(/```json/g, "```").split("```").map((x) => x.trim()).filter(Boolean);
      for (const chunk of chunks) {
        try {
          const parsed = JSON.parse(chunk);
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as Record<string, any>;
          }
        } catch {
          // Continue.
        }
      }
    }

    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }
    try {
      const parsed = JSON.parse(match[0]);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, any>;
      }
      return null;
    } catch {
      return null;
    }
  }

  private async callOllamaChat(model: string, messages: Array<{ role: string; content: string }>, timeoutMs: number): Promise<string> {
    const payload = await fetchJson(
      `${this.ollamaBaseUrl()}/api/chat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          stream: false,
          options: { temperature: 0.1 },
        }),
      },
      timeoutMs,
    );
    const content = payload?.message?.content;
    return String(content || "");
  }

  private async callOpenAIChat(model: string, messages: Array<{ role: string; content: string }>, timeoutMs: number): Promise<string> {
    const apiKey = (process.env.OPENAI_API_KEY || "").trim();
    if (!apiKey) {
      throw new Error("Missing OPENAI_API_KEY");
    }
    const payload = await fetchJson(
      `${this.openaiBaseUrl()}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.1,
        }),
      },
      timeoutMs,
    );
    return String(payload?.choices?.[0]?.message?.content || "");
  }

  private async callAnthropicChat(model: string, messages: Array<{ role: string; content: string }>, timeoutMs: number): Promise<string> {
    const apiKey = (process.env.ANTHROPIC_API_KEY || "").trim();
    if (!apiKey) {
      throw new Error("Missing ANTHROPIC_API_KEY");
    }
    const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
    const nonSystem = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content }));
    const payload = await fetchJson(
      `${this.anthropicBaseUrl()}/messages`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model,
          max_tokens: 1000,
          temperature: 0.1,
          system,
          messages: nonSystem,
        }),
      },
      timeoutMs,
    );
    const parts = Array.isArray(payload?.content) ? payload.content : [];
    return parts
      .filter((x: any) => x?.type === "text")
      .map((x: any) => x.text || "")
      .join("")
      .trim();
  }

  private async callLlmChat(provider: string, model: string, messages: Array<{ role: string; content: string }>, timeoutMs: number): Promise<string> {
    const p = provider.trim().toLowerCase();
    if (p === "ollama") {
      return this.callOllamaChat(model, messages, timeoutMs);
    }
    if (p === "openai") {
      return this.callOpenAIChat(model, messages, timeoutMs);
    }
    if (p === "anthropic") {
      return this.callAnthropicChat(model, messages, timeoutMs);
    }
    throw new Error(`Unsupported provider: ${provider}`);
  }

  private async shouldUseTools(provider: string, model: string, userPrompt: string, toolCatalogJson: string): Promise<boolean> {
    const routerSystem = "You are a router that decides if tools are needed. Reply ONLY with YES or NO. No other words.";
    const routerUser = `User request:\n${userPrompt}\n\nAvailable tools:\n${toolCatalogJson}\n\nDo you need to call tools to answer?`;
    const raw = await this.callLlmChat(
      provider,
      model,
      [
        { role: "system", content: routerSystem },
        { role: "user", content: routerUser },
      ],
      60_000,
    );
    return String(raw || "").trim().toLowerCase().startsWith("y");
  }

  async llmChatWithTools(
    provider: string,
    serverId: string,
    model: string,
    userPrompt: string,
    maxSteps = 6,
    autoTools = true,
  ): Promise<Record<string, any>> {
    if (!this.servers.has(serverId)) {
      throw new Error(`Server ${serverId} not found`);
    }
    if (!model) {
      throw new Error("model is required");
    }
    if (!userPrompt?.trim()) {
      throw new Error("prompt is required");
    }

    const tools = await this.getTools(serverId);
    const compactTools = tools
      .filter((t: any) => t?.name)
      .map((t: any) => ({
        name: t.name,
        description: t.description || "",
        input_schema: t.input_schema || t.inputSchema || {},
      }));
    const available = new Set(compactTools.map((t: any) => String(t.name)));
    const toolCatalog = JSON.stringify(compactTools, null, 2);

    if (autoTools) {
      let useTools = true;
      try {
        useTools = await this.shouldUseTools(provider, model, userPrompt, toolCatalog);
      } catch {
        useTools = true;
      }
      if (!useTools) {
        const answer = await this.callLlmChat(
          provider,
          model,
          [
            { role: "system", content: "You are a helpful assistant." },
            { role: "user", content: userPrompt },
          ],
          90_000,
        );
        return {
          status: "success",
          provider,
          model,
          final_answer: String(answer).trim(),
          steps: [],
          used_tools: false,
        };
      }
    }

    const plannerSystem = [
      "You are a tool-using assistant for an MCP app.",
      "You MUST reply ONLY with JSON object and nothing else.",
      'Allowed JSON shapes:',
      '1) {"type":"tool_call","tool":"<name>","arguments":{...},"reasoning":"..."}',
      '2) {"type":"final","answer":"..."}',
      "Use one tool call at a time. After receiving tool result, continue or finalize.",
    ].join("\n");

    const messages: Array<{ role: string; content: string }> = [
      { role: "system", content: plannerSystem },
      {
        role: "user",
        content: `User request:\n${userPrompt}\n\nAvailable tools:\n${toolCatalog}\n\nChoose the next action now.`,
      },
    ];
    const steps: any[] = [];

    const limit = Math.max(1, Number(maxSteps) || 1);
    for (let stepIndex = 1; stepIndex <= limit; stepIndex += 1) {
      const started = Date.now();
      let raw = "";
      try {
        raw = await this.callLlmChat(provider, model, messages, 120_000);
      } catch (error: any) {
        return {
          status: "error",
          provider,
          model,
          error: `${provider} call failed: ${error?.message || String(error)}`,
          steps,
        };
      }

      const decision = this.extractJsonObject(raw);
      if (!decision) {
        return {
          status: "error",
          provider,
          model,
          error: "Model did not return valid JSON action",
          raw,
          steps,
        };
      }

      const decisionType = String(decision.type || "").trim().toLowerCase();
      if (decisionType === "final") {
        return {
          status: "success",
          provider,
          model,
          final_answer: String(decision.answer || "").trim() || "Done.",
          steps,
          used_tools: true,
        };
      }

      if (decisionType !== "tool_call") {
        return {
          status: "error",
          provider,
          model,
          error: `Unsupported action type: ${decisionType}`,
          decision,
          steps,
        };
      }

      const toolName = String(decision.tool || "").trim();
      const arguments_ = decision.arguments && typeof decision.arguments === "object" ? decision.arguments : {};
      if (!available.has(toolName)) {
        return {
          status: "error",
          provider,
          model,
          error: `Model requested unknown tool: ${toolName}`,
          decision,
          steps,
        };
      }

      const toolResult = await this.executeTool(serverId, toolName, arguments_);
      steps.push({
        step: stepIndex,
        type: "tool_call",
        tool: toolName,
        arguments: arguments_,
        result: toolResult,
        duration: elapsedMs(started),
      });

      messages.push({ role: "assistant", content: JSON.stringify(decision) });
      messages.push({
        role: "user",
        content: `Tool result for \`${toolName}\`:\n${JSON.stringify(toolResult)}\n\nNow choose next action (tool_call or final).`,
      });
    }

    return {
      status: "success",
      provider,
      model,
      final_answer: "Max steps reached. Partial execution completed.",
      steps,
      used_tools: true,
    };
  }

  private async loadTestSuites(): Promise<void> {
    let files: string[] = [];
    try {
      files = await fs.readdir(this.testSuitesDir);
    } catch {
      files = [];
    }

    for (const file of files) {
      if (!file.endsWith(".json")) {
        continue;
      }
      try {
        const content = await fs.readFile(path.join(this.testSuitesDir, file), "utf8");
        const data = JSON.parse(content) as TestSuite;
        if (!data?.id) {
          continue;
        }
        this.testSuites.set(data.id, data);
      } catch {
        // Ignore malformed files.
      }
    }
  }

  private async saveTestSuite(suite: TestSuite): Promise<void> {
    const file = path.join(this.testSuitesDir, `${suite.id}.json`);
    await fs.writeFile(file, JSON.stringify(suite, null, 2), "utf8");
  }

  listTestSuites(): TestSuite[] {
    return Array.from(this.testSuites.values()).map((s) => deepClone(s));
  }

  async createTestSuite(name: string, description: string, testCases: Array<Partial<TestCase>>): Promise<Record<string, any>> {
    try {
      const suiteId = randomUUID().slice(0, 8);
      const cases: TestCase[] = testCases.map((tc) => ({
        id: tc.id || randomUUID().slice(0, 8),
        name: tc.name || "Unnamed Test",
        server_id: String(tc.server_id || ""),
        tool_name: String(tc.tool_name || ""),
        parameters: (tc.parameters as Record<string, any>) || {},
        expected_status: tc.expected_status,
        created_at: tc.created_at || nowIso(),
      }));

      const suite: TestSuite = {
        id: suiteId,
        name,
        description: description || "",
        test_cases: cases,
        created_at: nowIso(),
      };
      this.testSuites.set(suiteId, suite);
      await this.saveTestSuite(suite);
      return { status: "success", suite: deepClone(suite) };
    } catch (error: any) {
      return { status: "error", error: error?.message || String(error) };
    }
  }

  async runTestSuite(suiteId: string): Promise<Record<string, any>> {
    const suite = this.testSuites.get(suiteId);
    if (!suite) {
      throw new Error(`Test suite ${suiteId} not found`);
    }
    const results: any[] = [];
    for (const tc of suite.test_cases) {
      try {
        const result = await this.executeTool(tc.server_id, tc.tool_name, tc.parameters || {});
        const passed = tc.expected_status ? result.status === tc.expected_status : true;
        results.push({
          test_id: tc.id,
          test_name: tc.name,
          passed,
          result,
          expected_status: tc.expected_status,
        });
      } catch (error: any) {
        results.push({
          test_id: tc.id,
          test_name: tc.name,
          passed: false,
          error: error?.message || String(error),
          expected_status: tc.expected_status,
        });
      }
    }
    suite.last_run = nowIso();
    await this.saveTestSuite(suite);
    return {
      status: "success",
      suite_id: suiteId,
      suite_name: suite.name,
      total: results.length,
      passed: results.filter((r) => r.passed).length,
      failed: results.filter((r) => !r.passed).length,
      results,
    };
  }

  async deleteTestSuite(suiteId: string): Promise<Record<string, any>> {
    if (!this.testSuites.has(suiteId)) {
      throw new Error(`Test suite ${suiteId} not found`);
    }
    this.testSuites.delete(suiteId);
    const file = path.join(this.testSuitesDir, `${suiteId}.json`);
    try {
      await fs.unlink(file);
    } catch {
      // Ignore if file missing.
    }
    return { status: "success" };
  }

  getMetricsSummary(): Record<string, any> {
    let totalCalls = 0;
    let totalTime = 0;
    let successCount = 0;
    let errorCount = 0;
    for (const metricsMap of this.toolMetrics.values()) {
      for (const m of metricsMap.values()) {
        totalCalls += m.calls;
        totalTime += m.total_time;
        successCount += m.success_count;
        errorCount += m.error_count;
      }
    }
    const avgTime = totalCalls > 0 ? totalTime / totalCalls : 0;
    const successRate = totalCalls > 0 ? (successCount / totalCalls) * 100 : 0;
    const activeServers = Array.from(this.servers.values()).filter((s) => s.status === "connected").length;
    const totalTools = Array.from(this.servers.values()).reduce((acc, s) => acc + (s.tools_count || 0), 0);
    return {
      total_calls: totalCalls,
      avg_time: avgTime,
      success_rate: successRate,
      active_servers: activeServers,
      total_servers: this.servers.size,
      total_tools: totalTools,
      error_count: errorCount,
    };
  }

  getServerMetrics(serverId: string): Record<string, any> {
    const map = this.toolMetrics.get(serverId);
    if (!map) {
      throw new Error("Server not found");
    }
    const obj: Record<string, any> = {};
    for (const [name, m] of map.entries()) {
      obj[name] = deepClone(m);
    }
    return obj;
  }

  exportMetrics(format: string): string {
    const metrics = this.getMetricsSummary();
    const servers = Array.from(this.servers.values());
    const toolMetrics: Record<string, any> = {};
    for (const [serverId, map] of this.toolMetrics.entries()) {
      toolMetrics[serverId] = {};
      for (const [tool, m] of map.entries()) {
        toolMetrics[serverId][tool] = m;
      }
    }
    const payload = {
      generated_at: nowIso(),
      metrics,
      servers,
      tool_metrics: toolMetrics,
      logs: this.activityLogs,
    };

    if (format === "json") {
      return JSON.stringify(payload, null, 2);
    }
    if (format === "markdown") {
      return [
        "# PolyMCP Inspector Metrics Report",
        "",
        `Generated: ${payload.generated_at}`,
        "",
        "## Summary",
        `- Total Calls: ${metrics.total_calls}`,
        `- Avg Time (ms): ${metrics.avg_time.toFixed(2)}`,
        `- Success Rate: ${metrics.success_rate.toFixed(2)}%`,
        `- Active Servers: ${metrics.active_servers}/${metrics.total_servers}`,
        `- Total Tools: ${metrics.total_tools}`,
        "",
        "## Servers",
        ...servers.map((s) => `- ${s.name} (${s.id}) - ${s.status} - tools: ${s.tools_count}`),
      ].join("\n");
    }
    if (format === "html") {
      return `<!doctype html>
<html>
<head><meta charset="utf-8"><title>PolyMCP Metrics</title></head>
<body>
<h1>PolyMCP Inspector Metrics Report</h1>
<p><strong>Generated:</strong> ${payload.generated_at}</p>
<ul>
<li>Total Calls: ${metrics.total_calls}</li>
<li>Avg Time (ms): ${metrics.avg_time.toFixed(2)}</li>
<li>Success Rate: ${metrics.success_rate.toFixed(2)}%</li>
<li>Active Servers: ${metrics.active_servers}/${metrics.total_servers}</li>
<li>Total Tools: ${metrics.total_tools}</li>
</ul>
</body>
</html>`;
    }
    throw new Error(`Unsupported format: ${format}`);
  }

  async registerWebsocket(ws: WebSocket): Promise<void> {
    this.activeConnections.add(ws);
  }

  async unregisterWebsocket(ws: WebSocket): Promise<void> {
    this.activeConnections.delete(ws);
  }

  async broadcastUpdate(type: string, data: any): Promise<void> {
    if (this.activeConnections.size === 0) {
      return;
    }
    const payload = JSON.stringify({ type, data });
    const dead: WebSocket[] = [];
    for (const ws of this.activeConnections) {
      if (ws.readyState !== ws.OPEN) {
        dead.push(ws);
        continue;
      }
      try {
        ws.send(payload);
      } catch {
        dead.push(ws);
      }
    }
    for (const ws of dead) {
      this.activeConnections.delete(ws);
    }
  }

  async cleanup(): Promise<void> {
    for (const client of this.stdioClients.values()) {
      try {
        await client.stop();
      } catch {
        // Ignore.
      }
    }
    this.stdioClients.clear();
    this.stdioConfigs.clear();
    this.activeConnections.clear();
  }
}

function parseBodyDict(input: any): Record<string, any> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return {};
  }
  return input as Record<string, any>;
}

function isHttpAuthorized(req: Request, secureMode: boolean, apiKey?: string): boolean {
  if (!secureMode) {
    return true;
  }
  if (!apiKey) {
    return false;
  }
  const headerKey = String(req.headers["x-inspector-api-key"] || "").trim();
  const auth = String(req.headers.authorization || "").trim();
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  return secureEq(headerKey, apiKey) || secureEq(bearer, apiKey);
}

function isWebsocketAuthorized(
  headers: Record<string, string | string[] | undefined>,
  query: URLSearchParams,
  secureMode: boolean,
  apiKey?: string,
): boolean {
  if (!secureMode) {
    return true;
  }
  if (!apiKey) {
    return false;
  }
  const queryKey = query.get("api_key")?.trim() || "";
  const headerKey = String(headers["x-inspector-api-key"] || "").trim();
  const auth = String(headers.authorization || "").trim();
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  return secureEq(queryKey, apiKey) || secureEq(headerKey, apiKey) || secureEq(bearer, apiKey);
}

async function startInspector(options: InspectorOptions): Promise<void> {
  const app = express();
  const manager = new ServerManager(options.verbose);
  await manager.init();

  app.disable("x-powered-by");
  app.use(express.json({ limit: "10mb" }));

  const allowedOrigins = options.allowed_origins && options.allowed_origins.length > 0
    ? options.allowed_origins
    : [
        `http://${options.host}:${options.port}`,
        `https://${options.host}:${options.port}`,
        `http://localhost:${options.port}`,
        `http://127.0.0.1:${options.port}`,
      ];

  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin || allowedOrigins.includes(origin)) {
          cb(null, true);
          return;
        }
        cb(null, false);
      },
      credentials: true,
      methods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowedHeaders: ["Content-Type", "Authorization", "X-Inspector-API-Key"],
    }),
  );

  const buckets = new Map<string, number[]>();
  const rateLimitPerMinute = Math.max(10, Number(options.rate_limit_per_minute) || 120);
  const rateWindowSeconds = Math.max(10, Number(options.rate_limit_window_seconds) || 60);

  app.use((req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (req.path.startsWith("/api/")) {
      const ip = req.ip || req.socket.remoteAddress || "unknown";
      const now = Date.now();
      const cutoff = now - rateWindowSeconds * 1000;
      const arr = buckets.get(ip) || [];
      const filtered = arr.filter((ts) => ts >= cutoff);
      if (filtered.length >= rateLimitPerMinute) {
        res.status(429).type("text/plain").send("Rate limit exceeded");
        return;
      }
      filtered.push(now);
      buckets.set(ip, filtered);

      if (!isHttpAuthorized(req, options.secure_mode, options.api_key)) {
        res.status(401).type("text/plain").send("Unauthorized");
        return;
      }
    }

    res.setHeader("X-Content-Type-Options", "nosniff");
    const origin = String(req.headers.origin || "").toLowerCase();
    const referer = String(req.headers.referer || "").toLowerCase();
    const isTauri =
      origin.startsWith("tauri://") ||
      referer.startsWith("tauri://") ||
      origin.startsWith("http://tauri.localhost") ||
      origin.startsWith("https://tauri.localhost") ||
      referer.startsWith("http://tauri.localhost") ||
      referer.startsWith("https://tauri.localhost");
    if (!isTauri) {
      res.setHeader("X-Frame-Options", "SAMEORIGIN");
    }
    res.setHeader("Referrer-Policy", "no-referrer");
    if (options.secure_mode) {
      res.setHeader("Cache-Control", "no-store");
    }
    next();
  });

  const packagedStaticDir = path.join(path.dirname(process.execPath), "static");
  const defaultStaticDir = path.resolve(__dirname, "../../polymcp_inspector/static");
  const staticDir = process.env.POLYMCP_INSPECTOR_STATIC_DIR
    ? path.resolve(process.env.POLYMCP_INSPECTOR_STATIC_DIR)
    : ((process as any).pkg ? packagedStaticDir : defaultStaticDir);

  app.get("/", async (_req, res) => {
    const htmlPath = path.join(staticDir, "index.html");
    try {
      await fs.access(htmlPath);
      res.sendFile(htmlPath);
    } catch {
      res.status(404).type("text/html").send("<h1>PolyMCP Inspector</h1><p>UI file not found</p>");
    }
  });

  app.get("/icon.png", async (_req, res) => {
    const iconPath = path.join(staticDir, "icon.png");
    try {
      await fs.access(iconPath);
      res.sendFile(iconPath);
    } catch {
      res.status(404).json({ detail: "Icon file not found" });
    }
  });

  app.post("/api/servers/add", async (req, res) => {
    try {
      const cfg = parseBodyDict(req.body);
      const serverType = (cfg.type || "http") as ServerType;
      const serverId = String(cfg.id || `server_${manager.servers.size}`);
      const name = String(cfg.name || "Unnamed Server");
      if (serverType === "http") {
        if (!cfg.url) {
          res.status(400).json({ detail: "URL required for HTTP server" });
          return;
        }
        const result = await manager.addHttpServer(serverId, name, String(cfg.url));
        res.json(result);
        return;
      }
      if (!cfg.command) {
        res.status(400).json({ detail: "Command required for stdio server" });
        return;
      }
      const args = Array.isArray(cfg.args) ? cfg.args.map((x: any) => String(x)) : [];
      const env = cfg.env && typeof cfg.env === "object" ? cfg.env : undefined;
      const result = await manager.addStdioServer(serverId, name, String(cfg.command), args, env);
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ detail: error?.message || String(error) });
    }
  });

  app.delete("/api/servers/:server_id", async (req, res) => {
    try {
      const out = await manager.removeServer(String(req.params.server_id));
      res.json(out);
    } catch (error: any) {
      res.status(400).json({ detail: error?.message || String(error) });
    }
  });

  app.get("/api/servers", (_req, res) => {
    res.json({ servers: Array.from(manager.servers.values()).map((s) => deepClone(s)) });
  });

  app.get("/api/servers/:server_id/tools", async (req, res) => {
    try {
      const serverId = String(req.params.server_id);
      const tools = await manager.getTools(serverId);
      const metrics = manager.toolMetrics.get(serverId) || new Map<string, ToolMetrics>();
      const enriched = tools.map((t: any) => {
        const copy = { ...(t || {}) };
        const name = String(copy.name || "");
        if (name && metrics.has(name)) {
          copy.metrics = deepClone(metrics.get(name)!);
        }
        return copy;
      });
      res.json({ tools: enriched });
    } catch (error: any) {
      res.status(400).json({ detail: error?.message || String(error) });
    }
  });

  app.post("/api/servers/:server_id/tools/:tool_name/execute", async (req, res) => {
    try {
      const params = parseBodyDict(req.body);
      const out = await manager.executeTool(String(req.params.server_id), String(req.params.tool_name), params);
      res.json(out);
    } catch (error: any) {
      res.status(400).json({ detail: error?.message || String(error) });
    }
  });

  app.get("/api/servers/:server_id/resources", async (req, res) => {
    try {
      const resources = await manager.listResources(String(req.params.server_id));
      res.json({ resources });
    } catch (error: any) {
      res.status(400).json({ detail: error?.message || String(error) });
    }
  });

  app.post("/api/servers/:server_id/resources/read", async (req, res) => {
    try {
      const uri = String((req.body && req.body.uri) || "");
      const out = await manager.readResource(String(req.params.server_id), uri);
      res.json(out);
    } catch (error: any) {
      res.status(400).json({ detail: error?.message || String(error) });
    }
  });

  app.get("/api/servers/:server_id/prompts", async (req, res) => {
    try {
      const prompts = await manager.listPrompts(String(req.params.server_id));
      res.json({ prompts });
    } catch (error: any) {
      res.status(400).json({ detail: error?.message || String(error) });
    }
  });

  app.post("/api/servers/:server_id/prompts/get", async (req, res) => {
    try {
      const body = parseBodyDict(req.body);
      const promptName = String(body.prompt_name || body.name || "");
      const args = parseBodyDict(body.arguments || body.args || {});
      const out = await manager.getPrompt(String(req.params.server_id), promptName, args);
      res.json(out);
    } catch (error: any) {
      res.status(400).json({ detail: error?.message || String(error) });
    }
  });

  app.post("/api/servers/:server_id/mcp/request", async (req, res) => {
    try {
      const body = parseBodyDict(req.body);
      const method = String(body.method || "");
      const params = parseBodyDict(body.params || {});
      const out = await manager.proxyMcpRequest(String(req.params.server_id), method, params);
      res.json(out);
    } catch (error: any) {
      res.status(400).json({ detail: error?.message || String(error) });
    }
  });

  app.get("/api/llm/providers", async (_req, res) => {
    const ollama = await manager.listOllamaModels();
    const openai = await manager.listOpenAIModels();
    const anthropic = await manager.listAnthropicModels();
    res.json({
      providers: [
        {
          id: "ollama",
          name: "Ollama",
          status: ollama.status,
          base_url: ollama.base_url,
          models_count: Array.isArray(ollama.models) ? ollama.models.length : 0,
          error: ollama.error,
        },
        {
          id: "openai",
          name: "OpenAI",
          status: openai.status,
          models_count: Array.isArray(openai.models) ? openai.models.length : 0,
          error: openai.error,
        },
        {
          id: "anthropic",
          name: "Anthropic",
          status: anthropic.status,
          models_count: Array.isArray(anthropic.models) ? anthropic.models.length : 0,
          error: anthropic.error,
        },
      ],
    });
  });

  app.get("/api/llm/ollama/models", async (_req, res) => {
    res.json(await manager.listOllamaModels());
  });

  app.get("/api/llm/openai/models", async (_req, res) => {
    res.json(await manager.listOpenAIModels());
  });

  app.get("/api/llm/anthropic/models", async (_req, res) => {
    res.json(await manager.listAnthropicModels());
  });

  app.post("/api/servers/:server_id/llm/chat", async (req, res) => {
    try {
      const body = parseBodyDict(req.body);
      const out = await manager.llmChatWithTools(
        String(body.provider || "ollama"),
        String(req.params.server_id),
        String(body.model || ""),
        String(body.prompt || ""),
        Number(body.max_steps || 6),
        body.auto_tools === undefined ? true : Boolean(body.auto_tools),
      );
      res.json(out);
    } catch (error: any) {
      res.status(400).json({ detail: error?.message || String(error) });
    }
  });

  app.get("/api/test-suites", (_req, res) => {
    res.json({ suites: manager.listTestSuites() });
  });

  app.post("/api/test-suites", async (req, res) => {
    try {
      const body = parseBodyDict(req.body);
      const out = await manager.createTestSuite(
        String(body.name || "Untitled Suite"),
        String(body.description || ""),
        Array.isArray(body.test_cases) ? body.test_cases : [],
      );
      res.json(out);
    } catch (error: any) {
      res.status(400).json({ detail: error?.message || String(error) });
    }
  });

  app.post("/api/test-suites/:suite_id/run", async (req, res) => {
    try {
      const out = await manager.runTestSuite(String(req.params.suite_id));
      res.json(out);
    } catch (error: any) {
      res.status(400).json({ detail: error?.message || String(error) });
    }
  });

  app.delete("/api/test-suites/:suite_id", async (req, res) => {
    try {
      const out = await manager.deleteTestSuite(String(req.params.suite_id));
      res.json(out);
    } catch (error: any) {
      res.status(400).json({ detail: error?.message || String(error) });
    }
  });

  app.get("/api/export/metrics", (req, res) => {
    try {
      const format = String(req.query.format || "json");
      const content = manager.exportMetrics(format);
      if (format === "json") {
        res.type("application/json").send(content);
        return;
      }
      if (format === "markdown") {
        res.type("text/markdown").send(content);
        return;
      }
      if (format === "html") {
        res.type("text/html").send(content);
        return;
      }
      res.status(400).send(`Unsupported format: ${format}`);
    } catch (error: any) {
      res.status(400).json({ detail: error?.message || String(error) });
    }
  });

  app.get("/api/metrics", (_req, res) => {
    res.json(manager.getMetricsSummary());
  });

  app.get("/api/metrics/:server_id", (req, res) => {
    try {
      const metrics = manager.getServerMetrics(String(req.params.server_id));
      res.json({ metrics });
    } catch {
      res.status(404).json({ detail: "Server not found" });
    }
  });

  app.get("/api/logs", (req, res) => {
    const limit = Math.max(1, Number(req.query.limit || 100));
    const logs = manager.activityLogs.slice(-limit).map((x) => deepClone(x));
    res.json({ logs });
  });

  app.get("/api/health", (_req, res) => {
    res.json({ status: "healthy", servers: manager.servers.size });
  });

  const httpServer = createServer(app);
  const wss = new WebSocketServer({ noServer: true });

  wss.on("connection", async (ws: WebSocket) => {
    await manager.registerWebsocket(ws);
    ws.send(
      JSON.stringify({
        type: "initial_state",
        data: {
          servers: Array.from(manager.servers.values()).map((s) => deepClone(s)),
          metrics: manager.getMetricsSummary(),
        },
      }),
    );

    ws.on("message", async (msg) => {
      let data: any;
      try {
        data = JSON.parse(String(msg));
      } catch {
        return;
      }
      const type = String(data?.type || "");
      if (type === "ping") {
        ws.send(JSON.stringify({ type: "pong" }));
        return;
      }
      if (type === "get_state") {
        ws.send(
          JSON.stringify({
            type: "state_update",
            data: {
              servers: Array.from(manager.servers.values()).map((s) => deepClone(s)),
              metrics: manager.getMetricsSummary(),
            },
          }),
        );
      }
    });

    ws.on("close", async () => {
      await manager.unregisterWebsocket(ws);
    });
  });

  httpServer.on("upgrade", (req, socket, head) => {
    const url = req.url || "/";
    const parsed = new URL(url, `http://${options.host}:${options.port}`);
    if (parsed.pathname !== "/ws") {
      socket.destroy();
      return;
    }
    if (!isWebsocketAuthorized(req.headers as any, parsed.searchParams, options.secure_mode, options.api_key)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  });

  const shutdown = async () => {
    try {
      await manager.cleanup();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, options.host, () => resolve());
  });
  console.warn(`Inspector TS server running on http://${options.host}:${options.port}`);
}

function parseArgv(argv: string[]): InspectorOptions {
  const opts: InspectorOptions = {
    host: "127.0.0.1",
    port: 6274,
    secure_mode: false,
    api_key: undefined,
    allowed_origins: [],
    rate_limit_per_minute: 120,
    rate_limit_window_seconds: 60,
    verbose: false,
  };

  const read = (i: number): string | undefined => (i + 1 < argv.length ? argv[i + 1] : undefined);
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--host" && read(i)) {
      opts.host = String(read(i));
      i += 1;
      continue;
    }
    if (arg === "--port" && read(i)) {
      opts.port = Number(read(i)) || 6274;
      i += 1;
      continue;
    }
    if (arg === "--secure") {
      opts.secure_mode = true;
      continue;
    }
    if (arg === "--api-key" && read(i)) {
      opts.api_key = String(read(i));
      i += 1;
      continue;
    }
    if (arg === "--allow-origin" && read(i)) {
      opts.allowed_origins!.push(String(read(i)));
      i += 1;
      continue;
    }
    if (arg === "--rate-limit" && read(i)) {
      opts.rate_limit_per_minute = Number(read(i)) || 120;
      i += 1;
      continue;
    }
    if (arg === "--rate-window" && read(i)) {
      opts.rate_limit_window_seconds = Number(read(i)) || 60;
      i += 1;
      continue;
    }
    if (arg === "--verbose") {
      opts.verbose = true;
      continue;
    }
  }

  if (opts.secure_mode && !opts.api_key) {
    opts.api_key = randomKey();
    console.warn(`[polymcp-inspector-ts] Generated API key: ${opts.api_key}`);
  }

  return opts;
}

async function main(): Promise<void> {
  const opts = parseArgv(process.argv.slice(2));
  await startInspector(opts);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
