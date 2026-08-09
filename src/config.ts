import { homedir } from "os";
import { join } from "path";
import { readFile, writeFile, mkdir, chmod } from "fs/promises";
import { existsSync } from "fs";

export interface ComfyUIConfig {
  url: string;
  apiKey?: string;
}

export interface Config {
  comfyui: ComfyUIConfig;
  outputDir: string;
  workflowsDir: string;
  outputSizeThreshold: number; // bytes, for auto mode
}

const DEFAULT_CONFIG: Config = {
  comfyui: {
    // Use 127.0.0.1 instead of localhost due to Node 18 fetch IPv6/IPv4 issues
    url: "http://127.0.0.1:8188",
  },
  outputDir: "./outputs",
  workflowsDir: "./workflows",
  outputSizeThreshold: 1024 * 1024, // 1MB
};

function getConfigDir(): string {
  const platform = process.platform;
  if (platform === "darwin") {
    return join(homedir(), "Library", "Application Support", "comfyui-mcp");
  } else if (platform === "win32") {
    return join(process.env.APPDATA || homedir(), "comfyui-mcp");
  } else {
    return join(homedir(), ".config", "comfyui-mcp");
  }
}

function getConfigPath(): string {
  return join(getConfigDir(), "config.json");
}

export async function loadConfig(): Promise<Config> {
  const configPath = getConfigPath();

  // Check environment variable first
  const envUrl = process.env.COMFYUI_URL;

  let fileConfig: Partial<Config> = {};

  if (existsSync(configPath)) {
    try {
      const content = await readFile(configPath, "utf-8");
      fileConfig = JSON.parse(content);
    } catch {
      // Ignore parse errors, use defaults
    }
  }

  const config: Config = {
    ...DEFAULT_CONFIG,
    ...fileConfig,
    comfyui: {
      ...DEFAULT_CONFIG.comfyui,
      ...fileConfig.comfyui,
    },
  };

  // Environment variable overrides config file
  if (envUrl) {
    config.comfyui.url = envUrl;
  }

  return config;
}

export async function saveConfig(config: Config): Promise<void> {
  const configDir = getConfigDir();
  const configPath = getConfigPath();

  if (!existsSync(configDir)) {
    await mkdir(configDir, { recursive: true, mode: 0o700 });
  }

  await writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");

  // config.json can hold comfyui.apiKey, sent as a bearer token - restrict
  // it to the owner. writeFile's own `mode` option only applies when the
  // file is newly created, so chmod explicitly here to also cover the
  // update-an-existing-file case. Best-effort: chmod's mode bits are
  // largely a no-op on Windows, so this mainly hardens macOS/Linux.
  try {
    await chmod(configPath, 0o600);
  } catch {
    // Non-fatal - config was still written successfully.
  }
}

export function getConfigDir_(): string {
  return getConfigDir();
}
