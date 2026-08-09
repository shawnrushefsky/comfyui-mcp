#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  SetLevelRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { loadConfig, Config } from "./config.js";
import { discoverComfyUI } from "./discovery/index.js";
import { ComfyUIClient, ObjectInfo } from "./client/comfyui.js";
import { ComfyUIWebSocket } from "./client/websocket.js";
import {
  detectCapabilities,
  getCapabilitySummary,
  Capabilities,
} from "./capabilities/index.js";

// Tool imports
import {
  listModelsSchema,
  listModels,
  listNodesSchema,
  listNodes,
  getNodeInfoSchema,
  getNodeInfo,
  findNodesByTypeSchema,
  findNodesByType,
  ListModelsInput,
  ListNodesInput,
  GetNodeInfoInput,
  FindNodesByTypeInput,
} from "./tools/models.js";
import {
  getQueueSchema,
  getQueue,
  cancelJobSchema,
  cancelJob,
  interruptSchema,
  interrupt,
  getHistorySchema,
  getHistory,
  CancelJobInput,
  GetHistoryInput,
} from "./tools/queue.js";
import {
  runWorkflowSchema,
  runWorkflow,
  getImageSchema,
  getImage,
  RunWorkflowInput,
  GetImageInput,
} from "./tools/generate.js";
import { processImageForTransfer } from "./utils/image.js";
import {
  validateWorkflowSchema,
  validateWorkflow,
  ValidateWorkflowInput,
} from "./tools/validation.js";
import {
  buildNodeSchema,
  buildNode,
  BuildNodeInput,
} from "./tools/models.js";
import {
  getInstallGuideSchema,
  getInstallGuide,
  getModelGuideSchema,
  getModelGuide,
  getStatusSchema,
  getStatus,
  detectInstallation,
  GetInstallGuideInput,
  GetModelGuideInput,
} from "./tools/install.js";
import {
  listExamplesSchema,
  listExamples,
  getExampleWorkflowSchema,
  getExampleWorkflow,
  extractWorkflowFromPng,
  recommendWorkflowSchema,
  recommendWorkflow,
  formatWorkflowRecommendation,
  searchTemplatesSchema,
  searchTemplates,
  getTemplateSchema,
  getTemplate,
  saveTemplateSchema,
  saveCustomTemplate,
  deleteTemplateSchema,
  deleteCustomTemplate,
  getDownloadUrlSchema,
  getDownloadUrl,
  ListExamplesInput,
  GetExampleWorkflowInput,
  RecommendWorkflowInput,
  SearchTemplatesInput,
  GetTemplateInput,
  SaveTemplateInput,
  DeleteTemplateInput,
  GetDownloadUrlInput,
} from "./tools/examples/index.js";
import { readFile, stat } from "fs/promises";
import {
  getPromptingGuide,
  getComprehensiveGuide,
  formatPromptingGuide,
  PROMPTING_GUIDES,
} from "./resources/prompting-guide.js";
import { getJobManager, JobManager } from "./jobs/manager.js";
import {
  runWorkflowAsync,
} from "./tools/generate-async.js";
import {
  analyzeUserOutputs,
  getUserPreferencesSummary,
} from "./analysis/outputs.js";
import {
  renderSvgSchema,
  renderSvg,
  RenderSvgInput,
} from "./tools/svg.js";
import {
  downloadFontSchema,
  downloadFont,
  listFontsSchema,
  listFonts,
  DownloadFontInput,
  RECOMMENDED_MAP_FONTS,
} from "./tools/fonts.js";
import { join } from "path";
import * as db from "./db/index.js";
import {
  ServerContext,
  createContext,
  getComfyUIPath,
} from "./context.js";
import {
  getStaticResources,
  getDynamicResources,
  readResource,
} from "./handlers/resources.js";
import { listPrompts, getPrompt } from "./handlers/prompts.js";
import {
  initLogging,
  setLogLevel,
  LoggingLevel,
  debug,
  info,
  warning,
  error as logError,
} from "./utils/logging.js";

// Server context - single source of truth for all state
let ctx: ServerContext;

// extract_workflow's local-file branch reads whatever path it's given with
// no directory sandboxing, since users legitimately point it at PNGs
// anywhere on disk (Downloads, ComfyUI's output folder, etc.). Restricting
// it to a .png extension and this size cap narrows that from "read any
// file the process can access" down to "read a PNG-sized PNG", closing off
// the realistic path to exfiltrating unrelated sensitive files (dotfiles,
// keys, .env) through this tool.
const MAX_LOCAL_IMAGE_BYTES = 50 * 1024 * 1024; // 50MB

const server = new Server(
  {
    name: "comfyui-mcp",
    version: "0.1.0",
  },
  {
    capabilities: {
      tools: {},
      resources: {},
      prompts: {},
      logging: {},
    },
  }
);

/**
 * Initialize connection to ComfyUI
 */
async function initializeComfyUI(): Promise<boolean> {
  debug("Starting ComfyUI initialization...", undefined, "init");
  debug(`Config loaded, url from config: ${ctx.config.comfyui.url}`, undefined, "init");

  // Try to detect ComfyUI installation
  const installation = detectInstallation();
  if (installation.installed && installation.path) {
    ctx.comfyuiPath = installation.path;
    info(`Found ComfyUI installation at: ${ctx.comfyuiPath}`, undefined, "init");
  } else {
    debug("No ComfyUI installation detected", undefined, "init");
  }

  // Try to discover running ComfyUI
  debug("Attempting to discover running ComfyUI...", undefined, "init");
  const discovered = await discoverComfyUI(ctx.config.comfyui.url);

  if (!discovered) {
    info("ComfyUI is not running. Use get_install_guide or get_status for help.", undefined, "init");
    return false;
  }

  ctx.discoveredUrl = discovered.url;
  ctx.discoverySource = discovered.source;
  info(`Found running ComfyUI at ${discovered.url} (${discovered.source})`, undefined, "init");

  // Create client
  ctx.client = new ComfyUIClient(discovered.url, ctx.config.comfyui.apiKey);
  debug("Created ComfyUI client", undefined, "init");

  // Get capabilities
  try {
    debug("Getting object info...", undefined, "init");
    ctx.objectInfo = await ctx.client.getObjectInfo();
    debug(`Got object info with ${Object.keys(ctx.objectInfo).length} nodes`, undefined, "init");
    ctx.capabilities = detectCapabilities(ctx.objectInfo);
    info(`Detected capabilities:\n${getCapabilitySummary(ctx.capabilities)}`, undefined, "init");
  } catch (err) {
    logError(`Failed to get ComfyUI capabilities: ${err}`, undefined, "init");
    return false;
  }

  // Analyze user outputs for preferences (non-blocking)
  if (ctx.comfyuiPath) {
    const outputDir = join(ctx.comfyuiPath, "output");
    debug(`Analyzing user outputs in: ${outputDir}`, undefined, "init");
    try {
      const userPrefs = await analyzeUserOutputs(outputDir);
      if (ctx.capabilities) {
        ctx.capabilities.userPreferences = userPrefs;
      }
      debug(`User preferences:\n${getUserPreferencesSummary(userPrefs)}`, undefined, "init");
    } catch (err) {
      warning(`Failed to analyze user outputs: ${err}`, undefined, "init");
      // Non-fatal - continue without preferences
    }
  }

  // Connect WebSocket
  ctx.ws = new ComfyUIWebSocket(ctx.client.getWebSocketUrl());
  try {
    await ctx.ws.connect();
    debug("WebSocket connected", undefined, "init");
  } catch (err) {
    warning(`Failed to connect WebSocket: ${err}`, undefined, "init");
  }

  debug("Initialization complete, returning true", undefined, "init");
  return true;
}

/**
 * Ensure ComfyUI is connected
 */
async function ensureConnected(): Promise<{
  client: ComfyUIClient;
  ws: ComfyUIWebSocket;
  capabilities: Capabilities;
  objectInfo: ObjectInfo;
}> {
  if (!ctx.client || !ctx.ws || !ctx.capabilities || !ctx.objectInfo) {
    const connected = await initializeComfyUI();
    if (!connected) {
      throw new Error(
        "ComfyUI is not available. Use 'get_status' to check installation, or 'get_install_guide' for setup help."
      );
    }
  }

  if (!ctx.client || !ctx.ws || !ctx.capabilities || !ctx.objectInfo) {
    throw new Error(
      "ComfyUI is not available. Make sure it's running and accessible."
    );
  }

  // Verify connection is still alive
  if (!ctx.ws.isConnected()) {
    try {
      await ctx.ws.connect();
    } catch {
      throw new Error("Lost connection to ComfyUI WebSocket");
    }
  }

  return {
    client: ctx.client,
    ws: ctx.ws,
    capabilities: ctx.capabilities,
    objectInfo: ctx.objectInfo,
  };
}


// Tool annotation type
interface ToolAnnotations {
  title: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

// Tool definition type
interface ToolDefinition {
  schema: z.ZodType;
  description: string;
  requiresConnection?: boolean;
  annotations: ToolAnnotations;
}

// Tool definitions - organized by category
const TOOLS: Record<string, ToolDefinition> = {
  // === Status & Setup (always available) ===
  get_status: {
    schema: getStatusSchema,
    description:
      "Get the current status of ComfyUI connection and installation",
    requiresConnection: false,
    annotations: {
      title: "Get ComfyUI Status",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  get_install_guide: {
    schema: getInstallGuideSchema,
    description:
      "Get installation instructions for ComfyUI (recommends desktop app for most users)",
    requiresConnection: false,
    annotations: {
      title: "Get Installation Guide",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  get_model_guide: {
    schema: getModelGuideSchema,
    description:
      "Get guidance on downloading and installing models for ComfyUI",
    requiresConnection: false,
    annotations: {
      title: "Get Model Setup Guide",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },

  // === Examples (always available) ===
  list_examples: {
    schema: listExamplesSchema,
    description:
      "List official ComfyUI example workflows from the documentation. RECOMMENDED: Always check examples first before building custom workflows - they provide tested, working templates for common use cases like txt2img, img2img, ControlNet, LoRA, regional prompting, and more.",
    requiresConnection: false,
    annotations: {
      title: "List Example Workflows",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  get_example_workflow: {
    schema: getExampleWorkflowSchema,
    description:
      "Fetch an example workflow (extracts embedded JSON from documentation images). Returns ready-to-use workflow JSON that can be passed directly to run_workflow. Use this as a starting point and modify prompts, models, or parameters as needed.",
    requiresConnection: false,
    annotations: {
      title: "Get Example Workflow",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  extract_workflow: {
    schema: z.object({
      source: z.string().describe("Path to a local PNG file or URL of a PNG image with embedded ComfyUI workflow"),
    }),
    description:
      "Extract the workflow JSON from a ComfyUI-generated PNG image. Works with local file paths or URLs. Returns the workflow in API format that can be passed directly to run_workflow.",
    requiresConnection: false,
    annotations: {
      title: "Extract Workflow from Image",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  recommend_workflow: {
    schema: recommendWorkflowSchema,
    description:
      "IMPORTANT: Call this BEFORE generating images to get the correct workflow and settings for a model. Given a model filename, returns the recommended workflow, optimal settings (steps, CFG, resolution), and prompting guide. Essential for matching checkpoint vs UNET models to the right workflow.",
    requiresConnection: false,
    annotations: {
      title: "Recommend Workflow for Model",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },

  // === Prompting Guides (always available) ===
  get_prompting_guide: {
    schema: z.object({
      modelType: z
        .enum(["sd15", "sdxl", "sd3", "flux", "all"])
        .optional()
        .default("all")
        .describe("Model type to get prompting guide for (sd15, sdxl, sd3, flux, or all)"),
    }),
    description:
      "Get prompting best practices for AI image generation models (SD1.5, SDXL, SD3, Flux)",
    requiresConnection: false,
    annotations: {
      title: "Get Prompting Guide",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },

  // === Generation (requires ComfyUI) ===
  get_capabilities: {
    schema: z.object({}),
    description:
      "Get the detected capabilities of the connected ComfyUI instance",
    requiresConnection: true,
    annotations: {
      title: "Get ComfyUI Capabilities",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  run_workflow: {
    schema: runWorkflowSchema,
    description:
      "Run a custom ComfyUI workflow (API format JSON). Returns immediately with a task ID (async by default). Use get_task to check progress, get_task_result to retrieve results when complete. Set sync:true to wait for completion (blocking). IMPORTANT: Use the 'name' parameter with descriptive names like 'sunset_portrait_v2' or 'logo_design_red' to make generations easy to find later. BEST PRACTICE: Always start from example workflows (list_examples/get_example_workflow) or templates (search_templates/get_template) rather than building workflows from scratch.",
    requiresConnection: true,
    annotations: {
      title: "Run Custom Workflow",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    },
  },
  get_image: {
    schema: getImageSchema,
    description:
      "Retrieve a generated image as base64. Use this to fetch images from ComfyUI's output directory.",
    requiresConnection: true,
    annotations: {
      title: "Get Generated Image",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },

  // === Model Discovery (requires ComfyUI) ===
  list_models: {
    schema: listModelsSchema,
    description:
      "List available models (checkpoints, LoRAs, VAEs, etc.) in ComfyUI",
    requiresConnection: true,
    annotations: {
      title: "List Installed Models",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  list_nodes: {
    schema: listNodesSchema,
    description:
      "List available ComfyUI nodes, optionally filtered by category or search term",
    requiresConnection: true,
    annotations: {
      title: "List Available Nodes",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  get_node_info: {
    schema: getNodeInfoSchema,
    description:
      "Get detailed information about a specific ComfyUI node, including its inputs (with types, defaults, and valid options) and outputs. Essential for understanding how to wire nodes together in workflows.",
    requiresConnection: true,
    annotations: {
      title: "Get Node Info",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  find_nodes_by_type: {
    schema: findNodesByTypeSchema,
    description:
      "Find ComfyUI nodes by their input or output types. Use this to discover which nodes can produce a specific type (e.g., MODEL, LATENT, IMAGE) or which nodes can consume a type. Essential for workflow composition.",
    requiresConnection: true,
    annotations: {
      title: "Find Nodes by Type",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  build_node: {
    schema: buildNodeSchema,
    description:
      "Generate valid node JSON with proper inputs/outputs that can be assembled into a workflow. Provide inputs to override defaults, or leave empty to get a node with default values and placeholders for connections.",
    requiresConnection: true,
    annotations: {
      title: "Build Node JSON",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  validate_workflow: {
    schema: validateWorkflowSchema,
    description:
      "Validate a workflow before running it. Checks that all node types exist, connections are valid, required inputs are provided, and types match. Returns errors and warnings.",
    requiresConnection: true,
    annotations: {
      title: "Validate Workflow",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },

  // === Template System ===
  search_templates: {
    schema: searchTemplatesSchema,
    description:
      "Search for workflow templates by model type, task type, category, or text. Returns templates from built-in workflows, ComfyUI examples, and custom saved templates. Use get_template to generate workflow JSON from a template.",
    requiresConnection: false,
    annotations: {
      title: "Search Workflow Templates",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  get_template: {
    schema: getTemplateSchema,
    description:
      "Generate workflow JSON from a template with provided parameters. Returns a complete workflow that can be passed to run_workflow. Works with built-in and custom saved templates.",
    requiresConnection: true,
    annotations: {
      title: "Get Workflow from Template",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  save_template: {
    schema: saveTemplateSchema,
    description:
      "Save a workflow as a reusable template. Use descriptive names that indicate the purpose (e.g., 'portrait_lighting_studio', 'product_photo_white_bg'). Templates are stored persistently and can be searched and retrieved later.",
    requiresConnection: false,
    annotations: {
      title: "Save Custom Template",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  delete_template: {
    schema: deleteTemplateSchema,
    description: "Delete a custom saved template. Built-in templates cannot be deleted.",
    requiresConnection: false,
    annotations: {
      title: "Delete Custom Template",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  get_download_url: {
    schema: getDownloadUrlSchema,
    description:
      "Get the download URL for a model by name. Searches common model names and returns download URLs, destinations, and wget commands. Useful for helping users download missing models.",
    requiresConnection: false,
    annotations: {
      title: "Get Model Download URL",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },

  // === Queue Management (requires ComfyUI) ===
  get_queue: {
    schema: getQueueSchema,
    description: "Get the current ComfyUI queue status",
    requiresConnection: true,
    annotations: {
      title: "Get Queue Status",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  cancel_job: {
    schema: cancelJobSchema,
    description: "Cancel a queued job by prompt ID. NOTE: This only works for jobs that are queued (pending), NOT for jobs that are already running. To stop a running job, use the 'interrupt' tool instead.",
    requiresConnection: true,
    annotations: {
      title: "Cancel Job",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  interrupt: {
    schema: interruptSchema,
    description: "Interrupt the currently running job. Use this to stop a job that is actively generating. For queued jobs that haven't started yet, use 'cancel_job' instead.",
    requiresConnection: true,
    annotations: {
      title: "Interrupt Current Job",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  get_history: {
    schema: getHistorySchema,
    description: "Get generation history",
    requiresConnection: true,
    annotations: {
      title: "Get Generation History",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },

  // === Task Management (for async operations) ===
  get_task: {
    schema: z.object({
      taskId: z.string().describe("The task ID to get status for"),
    }),
    description: "Get the current status of an async generation task. Returns progress info including current step, total steps, average step time, estimated remaining time, and a suggested poll interval based on generation speed.",
    requiresConnection: false, // Jobs are tracked locally
    annotations: {
      title: "Get Task Status",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  get_task_result: {
    schema: z.object({
      taskId: z.string().describe("The task ID to get results for"),
    }),
    description: "Get the result of a completed generation task (images)",
    requiresConnection: false,
    annotations: {
      title: "Get Task Result",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  list_tasks: {
    schema: z.object({
      status: z
        .enum(["working", "completed", "failed", "cancelled"])
        .optional()
        .describe("Filter tasks by status"),
    }),
    description: "List all generation tasks, optionally filtered by status",
    requiresConnection: false,
    annotations: {
      title: "List Tasks",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  cancel_task: {
    schema: z.object({
      taskId: z.string().describe("The task ID to cancel"),
    }),
    description: "Cancel an async generation task. For queued tasks, this cancels the ComfyUI job. For tasks that are already running, this only removes the task from tracking - use 'interrupt' to actually stop the running generation.",
    requiresConnection: true, // Need to cancel in ComfyUI too
    annotations: {
      title: "Cancel Task",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  get_generation_by_name: {
    schema: z.object({
      name: z.string().describe("The name assigned to the generation"),
    }),
    description: "Retrieve a generation by its user-assigned name. Returns the same format as get_task_result.",
    requiresConnection: false,
    annotations: {
      title: "Get Generation by Name",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  name_generation: {
    schema: z.object({
      taskId: z.string().describe("The task ID to name"),
      name: z.string().describe("The name to assign - use descriptive names like 'hero_banner_blue' or 'product_shot_v3' that clearly identify the content"),
    }),
    description: "Assign a descriptive name to an existing generation for easy retrieval. Use clear, searchable names that describe the content (e.g., 'landscape_sunset_warm', 'logo_draft_2', 'character_portrait_final').",
    requiresConnection: false,
    annotations: {
      title: "Name Generation",
      readOnlyHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },

  // === Notes (for agent memory/learning) ===
  save_note: {
    schema: z.object({
      topic: z.string().describe("The topic/category of the note (e.g., 'flux-models', 'prompting-tips', 'workflow-patterns')"),
      content: z.string().describe("The content of the note"),
      tags: z.array(z.string()).optional().describe("Optional tags for categorization"),
    }),
    description: "Save a note about something learned during image generation. Useful for remembering model behaviors, prompting techniques, workflow patterns, etc.",
    requiresConnection: false,
    annotations: {
      title: "Save Note",
      readOnlyHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  get_notes: {
    schema: z.object({
      topic: z.string().optional().describe("Filter notes by topic"),
      limit: z.number().optional().default(50).describe("Maximum number of notes to return"),
    }),
    description: "Retrieve saved notes, optionally filtered by topic.",
    requiresConnection: false,
    annotations: {
      title: "Get Notes",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  search_notes: {
    schema: z.object({
      query: z.string().describe("Search query (searches topic, content, and tags)"),
      limit: z.number().optional().default(50).describe("Maximum number of notes to return"),
    }),
    description: "Search notes using full-text search.",
    requiresConnection: false,
    annotations: {
      title: "Search Notes",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  delete_note: {
    schema: z.object({
      id: z.number().describe("The ID of the note to delete"),
    }),
    description: "Delete a note by its ID.",
    requiresConnection: false,
    annotations: {
      title: "Delete Note",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  list_topics: {
    schema: z.object({}),
    description: "List all unique topics that have notes.",
    requiresConnection: false,
    annotations: {
      title: "List Note Topics",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },

  get_user_preferences: {
    schema: z.object({
      includeWorkflows: z.boolean().optional().default(true).describe("Include workflow templates"),
      includeModels: z.boolean().optional().default(true).describe("Include model usage stats"),
      includeSettings: z.boolean().optional().default(true).describe("Include common settings"),
      workflowLimit: z.number().optional().default(20).describe("Max workflow templates to return"),
      modelLimit: z.number().optional().default(30).describe("Max models to return"),
    }),
    description:
      "Get user preferences extracted from analyzing their ComfyUI output history. Returns commonly used workflows (as reusable templates), frequently used models, and preferred settings.",
    requiresConnection: true, // Need capabilities which contain the preferences
    annotations: {
      title: "Get User Preferences",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },

  // === SVG Tools ===
  render_svg: {
    schema: renderSvgSchema,
    description:
      "Render SVG content to PNG and save to ComfyUI's input folder. Returns filename for use in LoadImage nodes. Useful for creating precise base images for img2img workflows.",
    requiresConnection: true, // Need ComfyUI path for input folder
    annotations: {
      title: "Render SVG to PNG",
      readOnlyHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },

  // === Font Tools ===
  download_font: {
    schema: downloadFontSchema,
    description:
      "Download a font from Google Fonts or a direct URL for use in SVG rendering. Fonts are cached locally and can be embedded in SVGs via render_svg. Popular fantasy/map fonts: Cinzel, Pirata One, MedievalSharp, UnifrakturMaguntia, Almendra.",
    requiresConnection: false,
    annotations: {
      title: "Download Font",
      readOnlyHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  list_fonts: {
    schema: listFontsSchema,
    description:
      "List all downloaded fonts available for use in SVG rendering.",
    requiresConnection: false,
    annotations: {
      title: "List Downloaded Fonts",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
};

// Tool type for list tools response
interface Tool {
  name: string;
  description: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
  annotations?: ToolAnnotations;
}

// List tools handler
server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tools: Tool[] = [];

  for (const [name, { schema, description, annotations }] of Object.entries(TOOLS)) {
    tools.push({
      name,
      description,
      inputSchema: zodToJsonSchema(schema, { target: "jsonSchema7" }) as Tool["inputSchema"],
      annotations,
    });
  }

  return { tools };
});

// Call tool handler
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      // === Status & Setup ===
      case "get_status": {
        // Always try to connect/reconnect when checking status
        debug("Starting status check...", undefined, "get_status");
        const wasConnected = ctx.client !== null;
        debug(`Was previously connected: ${wasConnected}`, undefined, "get_status");

        const initResult = await initializeComfyUI();
        debug(`initializeComfyUI returned: ${initResult}`, undefined, "get_status");
        debug(`client is null: ${ctx.client === null}`, undefined, "get_status");
        debug(`discoveredUrl: ${ctx.discoveredUrl}`, undefined, "get_status");

        // Test actual connectivity
        let isConnected = false;
        if (ctx.client) {
          try {
            debug("Testing connectivity with getSystemStats...", undefined, "get_status");
            const stats = await ctx.client.getSystemStats();
            debug(`Got system stats: ${JSON.stringify(stats).slice(0, 100)}...`, undefined, "get_status");
            isConnected = true;
          } catch (err) {
            debug(`getSystemStats failed: ${err}`, undefined, "get_status");
            isConnected = false;
          }
        } else {
          debug("client is null, cannot test connectivity", undefined, "get_status");
        }

        debug(`Final isConnected: ${isConnected}`, undefined, "get_status");

        const status = await getStatus(
          isConnected,
          ctx.discoveredUrl || undefined,
          ctx.discoverySource || undefined,
          ctx.capabilities ? getCapabilitySummary(ctx.capabilities) : undefined
        );

        // Add prompting guide advice when connected
        if (isConnected && ctx.capabilities) {
          let modelType = "sd15";
          if (ctx.capabilities.hasFlux) modelType = "flux";
          else if (ctx.capabilities.hasSD3) modelType = "sd3";
          else if (ctx.capabilities.hasSDXL) modelType = "sdxl";

          (status as unknown as Record<string, unknown>).promptingAdvice = {
            detectedModelType: modelType,
            recommendation: `Before generating images, call get_prompting_guide('${modelType}') to learn the correct prompting style for best results.`,
          };
        }

        return {
          content: [{ type: "text", text: JSON.stringify(status, null, 2) }],
        };
      }

      case "get_install_guide": {
        const input = getInstallGuideSchema.parse(args) as GetInstallGuideInput;
        const guide = getInstallGuide(input);
        return { content: [{ type: "text", text: guide }] };
      }

      case "get_model_guide": {
        const input = getModelGuideSchema.parse(args) as GetModelGuideInput;
        const guide = getModelGuide(input);
        return { content: [{ type: "text", text: guide }] };
      }

      // === Examples ===
      case "list_examples": {
        const input = listExamplesSchema.parse(args) as ListExamplesInput;
        const result = listExamples(input);
        return { content: [{ type: "text", text: result }] };
      }

      case "get_example_workflow": {
        const input = getExampleWorkflowSchema.parse(args) as GetExampleWorkflowInput;
        const result = await getExampleWorkflow(input);
        return { content: [{ type: "text", text: result }] };
      }

      case "extract_workflow": {
        const input = args as { source: string };
        const source = input.source;

        let imageData: ArrayBuffer;

        // Check if it's a URL or file path
        if (source.startsWith("http://") || source.startsWith("https://")) {
          // Fetch from URL
          try {
            const response = await fetch(source);
            if (!response.ok) {
              return {
                content: [{ type: "text", text: `Failed to fetch image: ${response.status} ${response.statusText}` }],
                isError: true,
              };
            }
            imageData = await response.arrayBuffer();
          } catch (err) {
            return {
              content: [{ type: "text", text: `Failed to fetch image: ${err}` }],
              isError: true,
            };
          }
        } else {
          // Read from local file
          if (!/\.png$/i.test(source)) {
            return {
              content: [{ type: "text", text: "Local file source must be a .png file" }],
              isError: true,
            };
          }
          try {
            const stats = await stat(source);
            if (!stats.isFile()) {
              return {
                content: [{ type: "text", text: `Not a file: ${source}` }],
                isError: true,
              };
            }
            if (stats.size > MAX_LOCAL_IMAGE_BYTES) {
              return {
                content: [{ type: "text", text: `File too large (${stats.size} bytes, max ${MAX_LOCAL_IMAGE_BYTES})` }],
                isError: true,
              };
            }
            const buffer = await readFile(source);
            imageData = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
          } catch (err) {
            return {
              content: [{ type: "text", text: `Failed to read file: ${err}` }],
              isError: true,
            };
          }
        }

        // Extract workflow from PNG
        const metadata = await extractWorkflowFromPng(imageData);

        if (!metadata) {
          return {
            content: [{ type: "text", text: "No workflow metadata found in image. Make sure it's a ComfyUI-generated PNG." }],
            isError: true,
          };
        }

        // Prefer prompt (API format) over workflow (UI format) for execution
        const workflow = metadata.prompt || metadata.workflow;

        // Extract notes/documentation from UI format if available
        const notes: string[] = [];
        if (metadata.workflow) {
          const uiWorkflow = metadata.workflow as { nodes?: Array<{ type?: string; widgets_values?: unknown[]; properties?: { text?: string } }> };
          if (uiWorkflow.nodes && Array.isArray(uiWorkflow.nodes)) {
            for (const node of uiWorkflow.nodes) {
              // Note nodes typically have type "Note" or similar
              if (node.type === "Note" || node.type === "PrimitiveNode") {
                // Notes often store text in widgets_values[0] or properties.text
                const noteText = node.widgets_values?.[0] || node.properties?.text;
                if (typeof noteText === "string" && noteText.trim()) {
                  notes.push(noteText.trim());
                }
              }
            }
          }
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                source,
                hasPrompt: !!metadata.prompt,
                hasWorkflow: !!metadata.workflow,
                workflow,
                notes: notes.length > 0 ? notes : undefined,
                hint: "Pass the 'workflow' field directly to run_workflow to execute this workflow.",
              }, null, 2),
            },
          ],
        };
      }

      case "recommend_workflow": {
        const input = recommendWorkflowSchema.parse(args) as RecommendWorkflowInput;
        const recommendation = await recommendWorkflow(input);
        const formatted = formatWorkflowRecommendation(recommendation);
        return {
          content: [
            { type: "text", text: formatted },
            { type: "text", text: "\n---\n\n**Raw recommendation data:**\n```json\n" + JSON.stringify(recommendation, null, 2) + "\n```" },
          ],
        };
      }

      // === Prompting Guides ===
      case "get_prompting_guide": {
        const input = args as { modelType?: string };
        const modelType = input.modelType || "all";

        if (modelType === "all") {
          const guide = getComprehensiveGuide();
          return { content: [{ type: "text", text: guide }] };
        }

        const guide = getPromptingGuide(modelType);
        if (!guide) {
          return {
            content: [
              {
                type: "text",
                text: `Unknown model type: ${modelType}. Available types: ${Object.keys(PROMPTING_GUIDES).join(", ")}`,
              },
            ],
            isError: true,
          };
        }

        return { content: [{ type: "text", text: formatPromptingGuide(guide) }] };
      }

      // === Generation ===
      case "get_capabilities": {
        const { capabilities } = await ensureConnected();

        // Determine primary model type for prompting guidance
        let promptingAdvice = "";
        if (capabilities.hasFlux) {
          promptingAdvice = "Primary model type: FLUX. Use natural language prompts. No negative prompts or weights supported. Call get_prompting_guide('flux') for detailed guidance.";
        } else if (capabilities.hasSD3) {
          promptingAdvice = "Primary model type: SD3. Use natural language prompts. No prompt weights. Call get_prompting_guide('sd3') for detailed guidance.";
        } else if (capabilities.hasSDXL) {
          promptingAdvice = "Primary model type: SDXL. Supports both natural language and keywords. Weights supported (0.8-1.4). Call get_prompting_guide('sdxl') for detailed guidance.";
        } else {
          promptingAdvice = "Primary model type: SD1.5. Use keyword-style prompts with quality boosters. Negative prompts essential. Call get_prompting_guide('sd15') for detailed guidance.";
        }

        // Build user preferences summary if available
        let userPreferencesSummary = null;
        if (capabilities.userPreferences) {
          const prefs = capabilities.userPreferences;
          userPreferencesSummary = {
            totalImages: prefs.totalImagesAnalyzed,
            imagesWithWorkflows: prefs.imagesWithWorkflows,
            uniqueWorkflows: prefs.uniqueWorkflows,
            topModels: prefs.modelUsage.slice(0, 5).map((m) => ({
              name: m.name,
              type: m.type,
              usageCount: m.usageCount,
            })),
            topWorkflows: prefs.workflowTemplates.slice(0, 5).map((wf) => ({
              description: wf.description,
              usageCount: wf.usageCount,
              models: wf.models,
              samplePrompts: wf.samplePrompts.slice(0, 3),
            })),
            preferredSettings: prefs.commonSettings,
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  summary: getCapabilitySummary(capabilities),
                  promptingAdvice,
                  importantNote: "BEFORE generating images, call get_prompting_guide with your model type to learn the correct prompting style. Using the wrong prompting style significantly degrades output quality.",
                  userPreferences: userPreferencesSummary,
                  details: {
                    ...capabilities,
                    userPreferences: undefined, // Already included above in summary form
                  },
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "run_workflow": {
        const { client, ws } = await ensureConnected();
        const input = runWorkflowSchema.parse(args) as RunWorkflowInput;

        // Check if sync mode is requested
        if (input.sync) {
          // Synchronous mode - wait for completion
          const result = await runWorkflow(
            client,
            ws,
            input,
            ctx.config.outputDir,
            ctx.config.outputSizeThreshold
          );

          // Store the job in the database so named generations work
          if (result.promptId) {
            ctx.jobManager.createJob(result.promptId, {
              type: "run_workflow",
              input,
            }, input.name);

            if (result.success) {
              ctx.jobManager.completeJob(result.promptId, result);
            } else {
              ctx.jobManager.failJob(result.promptId, result.error || "Unknown error");
            }
          }

          if (!result.success) {
            return {
              content: [{ type: "text", text: `Error: ${result.error}` }],
              isError: true,
            };
          }

          const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [
            {
              type: "text",
              text: `Workflow completed (prompt_id: ${result.promptId})`,
            },
          ];

          for (const img of result.images) {
            if (img.data) {
              content.push({
                type: "image",
                data: img.data,
                mimeType: img.mimeType || "image/jpeg",
              });
            } else if (img.path) {
              content.push({
                type: "text",
                text: `Saved: ${img.path}`,
              });
            }
          }

          return { content };
        }

        // Async mode (default) - return immediately with task ID
        const asyncResult = await runWorkflowAsync(
          ctx.server,
          ctx.jobManager,
          client,
          ws,
          input,
          ctx.config.outputDir,
          ctx.config.outputSizeThreshold
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                taskId: asyncResult.taskId,
                promptId: asyncResult.promptId,
                status: asyncResult.status,
                statusMessage: asyncResult.statusMessage,
                pollInterval: asyncResult.pollInterval,
                hint: "Workflow started in background. Use get_task to check status, or get_task_result when complete.",
              }, null, 2),
            },
          ],
        };
      }

      case "get_image": {
        const { client } = await ensureConnected();
        const input = getImageSchema.parse(args) as GetImageInput;
        const result = await getImage(client, input);

        if (!result.success) {
          return {
            content: [{ type: "text", text: `Error: ${result.error}` }],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "image",
              data: result.data,
              mimeType: result.mimeType || "image/png",
            },
          ],
        };
      }

      // === Model Discovery ===
      case "list_models": {
        const { client } = await ensureConnected();
        const input = listModelsSchema.parse(args) as ListModelsInput;
        const result = await listModels(client, input);
        return { content: [{ type: "text", text: result }] };
      }

      case "list_nodes": {
        const { client } = await ensureConnected();
        const input = listNodesSchema.parse(args) as ListNodesInput;
        const result = await listNodes(client, input);
        return { content: [{ type: "text", text: result }] };
      }

      case "get_node_info": {
        const { client } = await ensureConnected();
        const input = getNodeInfoSchema.parse(args) as GetNodeInfoInput;
        const result = await getNodeInfo(client, input);
        return { content: [{ type: "text", text: result }] };
      }

      case "find_nodes_by_type": {
        const { client } = await ensureConnected();
        const input = findNodesByTypeSchema.parse(args) as FindNodesByTypeInput;
        const result = await findNodesByType(client, input);
        return { content: [{ type: "text", text: result }] };
      }

      case "build_node": {
        const { client } = await ensureConnected();
        const input = buildNodeSchema.parse(args) as BuildNodeInput;
        const result = await buildNode(client, input);
        return { content: [{ type: "text", text: result }] };
      }

      case "validate_workflow": {
        const { client } = await ensureConnected();
        const input = validateWorkflowSchema.parse(args) as ValidateWorkflowInput;
        const result = await validateWorkflow(client, input);
        return { content: [{ type: "text", text: result }] };
      }

      // === Template System ===
      case "search_templates": {
        const input = searchTemplatesSchema.parse(args) as SearchTemplatesInput;
        const result = searchTemplates(input);
        return { content: [{ type: "text", text: result }] };
      }

      case "get_template": {
        const { client } = await ensureConnected();
        const input = getTemplateSchema.parse(args) as GetTemplateInput;
        const result = await getTemplate(client, input);
        return { content: [{ type: "text", text: result }] };
      }

      case "save_template": {
        const input = saveTemplateSchema.parse(args) as SaveTemplateInput;
        const result = saveCustomTemplate(input);
        return { content: [{ type: "text", text: result }] };
      }

      case "delete_template": {
        const input = deleteTemplateSchema.parse(args) as DeleteTemplateInput;
        const result = deleteCustomTemplate(input);
        return { content: [{ type: "text", text: result }] };
      }

      case "get_download_url": {
        const input = getDownloadUrlSchema.parse(args) as GetDownloadUrlInput;
        const result = getDownloadUrl(input);
        return { content: [{ type: "text", text: result }] };
      }

      // === Queue Management ===
      case "get_queue": {
        const { client } = await ensureConnected();
        const result = await getQueue(client);
        return { content: [{ type: "text", text: result }] };
      }

      case "cancel_job": {
        const { client } = await ensureConnected();
        const input = cancelJobSchema.parse(args) as CancelJobInput;
        const result = await cancelJob(client, input);
        return { content: [{ type: "text", text: result }] };
      }

      case "interrupt": {
        const { client } = await ensureConnected();
        const result = await interrupt(client);
        return { content: [{ type: "text", text: result }] };
      }

      case "get_history": {
        const { client } = await ensureConnected();
        const input = getHistorySchema.parse(args) as GetHistoryInput;
        const result = await getHistory(client, input);
        return { content: [{ type: "text", text: result }] };
      }

      // === Task Management ===
      case "get_task": {
        const input = args as { taskId: string };
        const job = ctx.jobManager.getJob(input.taskId);
        if (!job) {
          return {
            content: [{ type: "text", text: `Task not found: ${input.taskId}` }],
            isError: true,
          };
        }

        // Build response with optional timing stats
        const response: Record<string, unknown> = {
          taskId: job.taskId,
          promptId: job.promptId,
          status: job.status,
          statusMessage: job.statusMessage,
          createdAt: job.createdAt,
          lastUpdatedAt: job.lastUpdatedAt,
          error: job.error,
          name: job.name,
        };

        // Include timing stats if available
        if (job.progressStats) {
          response.progress = {
            currentStep: job.progressStats.currentStep,
            totalSteps: job.progressStats.totalSteps,
            currentNode: job.progressStats.currentNode,
            avgStepTimeMs: job.progressStats.avgStepTimeMs,
            estimatedRemainingMs: job.progressStats.estimatedRemainingMs,
          };

          // Add suggested poll interval based on timing
          if (job.progressStats.avgStepTimeMs) {
            // Suggest polling at half the average step time, min 500ms, max 10s
            const suggestedPollMs = Math.max(500, Math.min(10000, Math.round(job.progressStats.avgStepTimeMs / 2)));
            response.suggestedPollIntervalMs = suggestedPollMs;
          }
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      }

      case "get_task_result": {
        const input = args as { taskId: string };
        const job = ctx.jobManager.getJob(input.taskId);
        if (!job) {
          return {
            content: [{ type: "text", text: `Task not found: ${input.taskId}` }],
            isError: true,
          };
        }

        if (job.status === "working") {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  taskId: job.taskId,
                  status: job.status,
                  statusMessage: job.statusMessage,
                  hint: "Task is still in progress. Check again later or wait for completion notification.",
                }, null, 2),
              },
            ],
          };
        }

        if (job.status === "failed") {
          return {
            content: [{ type: "text", text: `Task failed: ${job.error}` }],
            isError: true,
          };
        }

        if (job.status === "cancelled") {
          return {
            content: [{ type: "text", text: "Task was cancelled" }],
            isError: true,
          };
        }

        // Task completed - return the result with images
        if (!job.result) {
          return {
            content: [{ type: "text", text: "No result available" }],
            isError: true,
          };
        }

        const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [
          {
            type: "text",
            text: `Task ${job.taskId} completed. Generated ${job.result.images.length} image(s).`,
          },
        ];

        for (const img of job.result.images) {
          if (img.data) {
            content.push({
              type: "image",
              data: img.data,
              mimeType: img.mimeType || "image/jpeg",
            });
          } else if (img.path) {
            content.push({
              type: "text",
              text: `Saved: ${img.path}`,
            });
          }
        }

        return { content };
      }

      case "list_tasks": {
        const input = args as { status?: "working" | "completed" | "failed" | "cancelled" };
        const jobs = ctx.jobManager.listJobs(input.status);
        const counts = ctx.jobManager.getJobCounts();

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                summary: counts,
                tasks: jobs.map((j) => ({
                  taskId: j.taskId,
                  status: j.status,
                  statusMessage: j.statusMessage,
                  createdAt: j.createdAt,
                  lastUpdatedAt: j.lastUpdatedAt,
                  name: j.name,
                })),
              }, null, 2),
            },
          ],
        };
      }

      case "cancel_task": {
        const { client } = await ensureConnected();
        const input = args as { taskId: string };
        const job = ctx.jobManager.getJob(input.taskId);

        if (!job) {
          return {
            content: [{ type: "text", text: `Task not found: ${input.taskId}` }],
            isError: true,
          };
        }

        if (job.status !== "working") {
          return {
            content: [{ type: "text", text: `Task is not running (status: ${job.status})` }],
            isError: true,
          };
        }

        // Cancel in ComfyUI
        try {
          await cancelJob(client, { promptId: job.promptId });
        } catch {
          // Job might already be done in ComfyUI
        }

        // Mark as cancelled in job manager
        ctx.jobManager.cancelJob(input.taskId);

        return {
          content: [
            {
              type: "text",
              text: `Task ${input.taskId} cancelled successfully`,
            },
          ],
        };
      }

      case "get_generation_by_name": {
        const input = args as { name: string };
        const job = ctx.jobManager.getJobByName(input.name);
        if (!job) {
          return {
            content: [{ type: "text", text: `No generation found with name: ${input.name}` }],
            isError: true,
          };
        }

        if (job.status === "working") {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  name: job.name,
                  taskId: job.taskId,
                  status: job.status,
                  statusMessage: job.statusMessage,
                  hint: "Generation is still in progress. Check again later.",
                }, null, 2),
              },
            ],
          };
        }

        if (job.status === "failed") {
          // Check if the job actually completed in ComfyUI (timeout might have occurred but generation finished)
          if (job.error?.includes("timed out") && ctx.client) {
            try {
              const history = await ctx.client.getHistory(job.promptId);
              const historyEntry = history[job.promptId];
              if (historyEntry?.status?.completed && historyEntry.outputs) {
                // Generation actually completed! Recover the result
                const images: Array<{ filename: string; data?: string; mimeType?: string; path?: string }> = [];
                for (const [_nodeId, output] of Object.entries(historyEntry.outputs)) {
                  const nodeOutput = output as { images?: Array<{ filename: string; subfolder: string; type: string }> };
                  if (nodeOutput.images) {
                    for (const img of nodeOutput.images) {
                      const imageData = await ctx.client!.getImage(img.filename, img.subfolder, img.type);
                      const imageBuffer = Buffer.from(imageData);
                      const processed = await processImageForTransfer(imageBuffer, {
                        format: "jpeg",
                        quality: 85,
                      });
                      images.push({
                        filename: img.filename,
                        data: processed.data,
                        mimeType: processed.mimeType,
                      });
                    }
                  }
                }

                // Update job status to completed
                const recoveredResult = {
                  success: true,
                  promptId: job.promptId,
                  outputs: historyEntry.outputs,
                  images,
                };
                ctx.jobManager.completeJob(job.taskId, recoveredResult);

                // Return the recovered result
                const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [
                  {
                    type: "text",
                    text: `Generation "${input.name}" recovered from timeout. ${images.length} image(s).`,
                  },
                ];
                for (const img of images) {
                  if (img.data) {
                    content.push({
                      type: "image",
                      data: img.data,
                      mimeType: img.mimeType || "image/jpeg",
                    });
                  }
                }
                return { content };
              }
            } catch {
              // Failed to recover, fall through to error
            }
          }
          return {
            content: [{ type: "text", text: `Generation "${input.name}" failed: ${job.error}` }],
            isError: true,
          };
        }

        if (job.status === "cancelled") {
          return {
            content: [{ type: "text", text: `Generation "${input.name}" was cancelled` }],
            isError: true,
          };
        }

        if (!job.result) {
          return {
            content: [{ type: "text", text: "No result available" }],
            isError: true,
          };
        }

        const content: Array<{ type: string; text?: string; data?: string; mimeType?: string }> = [
          {
            type: "text",
            text: `Generation "${input.name}" (task ${job.taskId}) completed. ${job.result.images.length} image(s).`,
          },
        ];

        for (const img of job.result.images) {
          if (img.data) {
            content.push({
              type: "image",
              data: img.data,
              mimeType: img.mimeType || "image/jpeg",
            });
          } else if (img.path) {
            content.push({
              type: "text",
              text: `Saved: ${img.path}`,
            });
          }
        }

        return { content };
      }

      case "name_generation": {
        const input = args as { taskId: string; name: string };
        const job = ctx.jobManager.getJob(input.taskId);

        if (!job) {
          return {
            content: [{ type: "text", text: `Task not found: ${input.taskId}` }],
            isError: true,
          };
        }

        const success = ctx.jobManager.setName(input.taskId, input.name);
        if (!success) {
          return {
            content: [{ type: "text", text: `Failed to set name for task: ${input.taskId}` }],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                message: `Generation named "${input.name}"`,
                taskId: input.taskId,
                name: input.name,
                hint: `You can now retrieve this generation using get_generation_by_name with name "${input.name}"`,
              }, null, 2),
            },
          ],
        };
      }

      // === Notes ===
      case "save_note": {
        const input = args as { topic: string; content: string; tags?: string[] };
        const note = db.saveNote(input.topic, input.content, input.tags || []);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                message: "Note saved",
                note: {
                  id: note.id,
                  topic: note.topic,
                  tags: note.tags,
                  createdAt: note.createdAt,
                },
              }, null, 2),
            },
          ],
        };
      }

      case "get_notes": {
        const input = args as { topic?: string; limit?: number };
        const notes = input.topic
          ? db.getNotesByTopic(input.topic)
          : db.getAllNotes(input.limit || 50);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                count: notes.length,
                notes: notes.map(n => ({
                  id: n.id,
                  topic: n.topic,
                  content: n.content,
                  tags: n.tags,
                  createdAt: n.createdAt,
                  updatedAt: n.updatedAt,
                })),
              }, null, 2),
            },
          ],
        };
      }

      case "search_notes": {
        const input = args as { query: string; limit?: number };
        const notes = db.searchNotes(input.query, input.limit || 50);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                query: input.query,
                count: notes.length,
                notes: notes.map(n => ({
                  id: n.id,
                  topic: n.topic,
                  content: n.content,
                  tags: n.tags,
                  createdAt: n.createdAt,
                  updatedAt: n.updatedAt,
                })),
              }, null, 2),
            },
          ],
        };
      }

      case "delete_note": {
        const input = args as { id: number };
        const success = db.deleteNote(input.id);

        if (!success) {
          return {
            content: [{ type: "text", text: `Note not found: ${input.id}` }],
            isError: true,
          };
        }

        return {
          content: [
            {
              type: "text",
              text: `Note ${input.id} deleted successfully`,
            },
          ],
        };
      }

      case "list_topics": {
        const topics = db.getTopics();

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                count: topics.length,
                topics,
              }, null, 2),
            },
          ],
        };
      }

      case "get_user_preferences": {
        const { capabilities } = await ensureConnected();
        const input = args as {
          includeWorkflows?: boolean;
          includeModels?: boolean;
          includeSettings?: boolean;
          workflowLimit?: number;
          modelLimit?: number;
        };

        const prefs = capabilities.userPreferences;
        if (!prefs) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  message: "No user preferences available. Output analysis may not have completed or no images with workflow metadata were found.",
                  hint: "Generate some images first, then restart the server to analyze your output history.",
                }, null, 2),
              },
            ],
          };
        }

        const includeWorkflows = input.includeWorkflows !== false;
        const includeModels = input.includeModels !== false;
        const includeSettings = input.includeSettings !== false;
        const workflowLimit = input.workflowLimit || 20;
        const modelLimit = input.modelLimit || 30;

        const result: Record<string, unknown> = {
          summary: {
            totalImagesAnalyzed: prefs.totalImagesAnalyzed,
            imagesWithWorkflows: prefs.imagesWithWorkflows,
            uniqueWorkflows: prefs.uniqueWorkflows,
            analyzedAt: prefs.analyzedAt,
          },
        };

        if (includeWorkflows) {
          // Return workflow templates that can be passed directly to run_workflow
          result.workflowTemplates = prefs.workflowTemplates.slice(0, workflowLimit).map((wf) => ({
            // Metadata for selection
            hash: wf.hash,
            description: wf.description,
            usageCount: wf.usageCount,
            lastUsed: wf.lastUsed,
            models: wf.models,
            samplePrompts: wf.samplePrompts,
            // The actual workflow - pass this to run_workflow
            workflow: wf.workflow,
          }));
          result.workflowHint = "To use a workflow: call run_workflow with the 'workflow' field from any template. Modify prompt text in CLIPTextEncode nodes as needed.";
        }

        if (includeModels) {
          result.frequentModels = prefs.modelUsage.slice(0, modelLimit);
        }

        if (includeSettings) {
          result.commonSettings = prefs.commonSettings;
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      }

      // === SVG Tools ===
      case "render_svg": {
        const input = renderSvgSchema.parse(args) as RenderSvgInput;

        // Render SVG to PNG buffer
        const result = await renderSvg(input);

        if (!result.success || !result.buffer || !result.filename) {
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  success: false,
                  error: result.error || "Failed to render SVG",
                }, null, 2),
              },
            ],
            isError: true,
          };
        }

        // Upload to ComfyUI via API (works with Docker/remote instances)
        const { client } = await ensureConnected();
        const uploadResult = await client.uploadImage(result.buffer, result.filename, true);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                filename: uploadResult.name,
                subfolder: uploadResult.subfolder,
                type: uploadResult.type,
                hint: `Use "${uploadResult.name}" in a LoadImage node to load this image.`,
              }, null, 2),
            },
          ],
        };
      }

      // === Font Tools ===
      case "download_font": {
        const input = downloadFontSchema.parse(args) as DownloadFontInput;
        const result = await downloadFont(input);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ...result,
                recommendedFonts: result.success ? undefined : RECOMMENDED_MAP_FONTS,
                hint: result.success
                  ? `Font downloaded. Use it in render_svg with fonts: [{ name: "${result.font?.name}" }]`
                  : "Check the font name or try one of the recommended fonts.",
              }, null, 2),
            },
          ],
          isError: !result.success,
        };
      }

      case "list_fonts": {
        const result = await listFonts();

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ...result,
                recommendedFonts: RECOMMENDED_MAP_FONTS,
                hint: "Use download_font to add more fonts. These can be embedded in SVGs via render_svg.",
              }, null, 2),
            },
          ],
        };
      }

      default:
        return {
          content: [{ type: "text", text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text", text: `Error: ${message}` }],
      isError: true,
    };
  }
});

// List resources handler
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const staticResources = getStaticResources();
  const dynamicResources = getDynamicResources(ctx);

  return {
    resources: [...staticResources, ...dynamicResources],
  };
});

// Read resource handler
server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;
  return await readResource(ctx, uri);
});

// List prompts handler
server.setRequestHandler(ListPromptsRequestSchema, async () => {
  return {
    prompts: listPrompts(),
  };
});

// Get prompt handler
server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return await getPrompt(ctx, name, args || {});
});

// Set logging level handler
server.setRequestHandler(SetLevelRequestSchema, async (request) => {
  const { level } = request.params;
  setLogLevel(level as LoggingLevel);
  info(`Logging level set to: ${level}`);
  return {};
});

// Main entry point
async function main() {
  // Load config first
  const config = await loadConfig();

  // Create server context
  ctx = createContext(server, config, getJobManager());

  // Initialize logging with the server
  initLogging(server, "info");

  // Try to initialize ComfyUI connection (non-fatal if not available)
  await initializeComfyUI();

  // Start MCP server regardless of ComfyUI status
  const transport = new StdioServerTransport();
  await server.connect(transport);

  info("ComfyUI MCP server started");
  if (!ctx.client) {
    info("ComfyUI is not connected. Setup and example tools are still available.");
  }
}

main().catch((err) => {
  logError(`Fatal error: ${err}`);
  process.exit(1);
});
