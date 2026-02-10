import { ChildProcess, spawn } from "node:child_process";

type JsonRpcId = string | number;

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  result?: any;
  error?: {
    code?: number;
    message?: string;
    data?: any;
  };
}

interface Pending {
  resolve: (value: JsonRpcResponse) => void;
  reject: (error: Error) => void;
  timeout: NodeJS.Timeout;
}

export interface MCPServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export class MCPStdioClient {
  private readonly config: MCPServerConfig;
  private process: ChildProcess | null = null;
  private requestId = 0;
  private running = false;
  private buffer = "";
  private readonly pending = new Map<JsonRpcId, Pending>();

  constructor(config: MCPServerConfig) {
    this.config = config;
  }

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    const env = { ...process.env, ...(this.config.env || {}) };
    this.process = spawn(this.config.command, this.config.args, {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    if (!this.process.stdin || !this.process.stdout) {
      throw new Error("Failed to create stdio pipes for MCP process");
    }

    this.process.stdout.on("data", (chunk: Buffer) => this.handleStdout(chunk));
    this.process.stderr?.on("data", () => {
      // Ignore by default, backend caller captures logs if needed.
    });
    this.process.on("exit", (code, signal) => {
      this.running = false;
      const reason = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
      this.rejectAllPending(new Error(`MCP process exited (${reason})`));
      this.process = null;
      this.buffer = "";
    });
    this.process.on("error", (error) => {
      this.running = false;
      this.rejectAllPending(error);
      this.process = null;
      this.buffer = "";
    });

    this.running = true;
    await new Promise((resolve) => setTimeout(resolve, 400));
    await this.initialize();
  }

  async stop(): Promise<void> {
    if (!this.running || !this.process) {
      return;
    }
    this.running = false;
    this.rejectAllPending(new Error("MCP client stopping"));
    const proc = this.process;
    this.process = null;
    this.buffer = "";

    try {
      proc.kill("SIGTERM");
    } catch {
      // Ignore
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Ignore
        }
        resolve();
      }, 3000);

      proc.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  async listTools(): Promise<any[]> {
    const response = await this.sendRequest("tools/list", {});
    if (response.error) {
      throw new Error(response.error.message || "tools/list failed");
    }
    const tools = response.result?.tools;
    return Array.isArray(tools) ? tools : [];
  }

  async invokeTool(name: string, arguments_: Record<string, any>): Promise<any> {
    const response = await this.sendRequest("tools/call", { name, arguments: arguments_ }, 120_000);
    if (response.error) {
      throw new Error(response.error.message || "tools/call failed");
    }
    return response.result ?? {};
  }

  async sendRequest(method: string, params: Record<string, any> = {}, timeoutMs = 60_000): Promise<JsonRpcResponse> {
    if (!this.running || !this.process?.stdin) {
      throw new Error("MCP process is not running");
    }

    this.requestId += 1;
    const id = this.requestId;
    const request = {
      jsonrpc: "2.0",
      id,
      method,
      params,
    };

    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timeout for ${method}`));
      }, timeoutMs);

      this.pending.set(id, { resolve, reject, timeout });
      this.process!.stdin!.write(`${JSON.stringify(request)}\n`, (err) => {
        if (err) {
          clearTimeout(timeout);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  private async initialize(): Promise<void> {
    const response = await this.sendRequest(
      "initialize",
      {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {}, resources: { subscribe: true }, prompts: {} },
        clientInfo: { name: "polymcp-inspector-ts", version: "0.1.0" },
      },
      60_000,
    );

    if (response.error) {
      throw new Error(response.error.message || "initialize failed");
    }
  }

  private handleStdout(chunk: Buffer): void {
    this.buffer += chunk.toString("utf8");
    const lines = this.buffer.split("\n");
    this.buffer = lines.pop() ?? "";

    for (const raw of lines) {
      const line = raw.trim();
      if (!line) {
        continue;
      }
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue;
      }
      if (message.id === undefined || message.id === null) {
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) {
        continue;
      }
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      pending.resolve(message);
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pending.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
