import { z } from "zod";
import { ExampleWorkflow, ModelDownload } from "./types.js";
import { EXAMPLE_WORKFLOWS } from "./data.js";

// Refuse to even attempt parsing implausibly large "PNG" data. Without
// this, a URL-fetching caller (extract_workflow, fetchExampleWorkflow) that
// hits a malicious/misbehaving server with a huge response body would carry
// that entire body through TextDecoder + JSON.parse below.
const MAX_PNG_SIZE = 50 * 1024 * 1024; // 50MB - generous for a real PNG

// workflow/prompt metadata is normally KB-sized JSON; cap what we'll
// attempt to JSON.parse so a crafted chunk can't force a huge parse/alloc.
const MAX_TEXT_VALUE_SIZE = 20 * 1024 * 1024; // 20MB

/**
 * Extract workflow JSON from PNG metadata
 * ComfyUI embeds workflow data in PNG tEXt chunks with key "workflow" or "prompt"
 */
export async function extractWorkflowFromPng(
  imageData: ArrayBuffer
): Promise<{ workflow?: Record<string, unknown>; prompt?: Record<string, unknown> } | null> {
  if (imageData.byteLength > MAX_PNG_SIZE) {
    return null;
  }

  const data = new Uint8Array(imageData);

  // PNG signature check
  const pngSignature = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (data[i] !== pngSignature[i]) {
      return null; // Not a PNG
    }
  }

  const result: { workflow?: Record<string, unknown>; prompt?: Record<string, unknown> } = {};

  // Parse PNG chunks. Every declared length is untrusted input from the
  // file itself, so it's validated against what's actually left in the
  // buffer before being used to slice - a corrupt or crafted file could
  // otherwise declare a length far past the end of the data.
  let offset = 8;
  while (offset + 8 <= data.length) {
    // Read chunk length (4 bytes, big-endian, unsigned)
    const length =
      ((data[offset] << 24) |
        (data[offset + 1] << 16) |
        (data[offset + 2] << 8) |
        data[offset + 3]) >>>
      0;
    offset += 4;

    // Read chunk type (4 bytes)
    const type = String.fromCharCode(
      data[offset],
      data[offset + 1],
      data[offset + 2],
      data[offset + 3]
    );
    offset += 4;

    // A declared length that runs past the end of the buffer means the
    // file is malformed or hostile - stop parsing rather than trusting it.
    if (length > data.length - offset) {
      break;
    }

    // Read chunk data
    const chunkData = data.slice(offset, offset + length);
    offset += length;

    // Skip CRC (4 bytes)
    offset += 4;

    // Check for tEXt or iTXt chunks
    if (type === "tEXt" || type === "iTXt") {
      // Find null separator between key and value
      let nullIndex = 0;
      for (let i = 0; i < chunkData.length; i++) {
        if (chunkData[i] === 0) {
          nullIndex = i;
          break;
        }
      }

      const key = new TextDecoder().decode(chunkData.slice(0, nullIndex));
      let value: string;

      if (type === "tEXt") {
        // tEXt: key\0value
        value = new TextDecoder().decode(chunkData.slice(nullIndex + 1));
      } else {
        // iTXt: key\0compression\0language\0translated\0text
        // Skip compression flag, method, language tag, translated keyword
        let valueStart = nullIndex + 1;
        let nullCount = 0;
        for (let i = valueStart; i < chunkData.length && nullCount < 3; i++) {
          if (chunkData[i] === 0) {
            nullCount++;
            valueStart = i + 1;
          }
        }
        value = new TextDecoder().decode(chunkData.slice(valueStart));
      }

      // Parse workflow or prompt JSON
      if ((key === "workflow" || key === "prompt") && value.length <= MAX_TEXT_VALUE_SIZE) {
        try {
          const parsed = JSON.parse(value);
          if (key === "workflow") {
            result.workflow = parsed;
          } else {
            result.prompt = parsed;
          }
        } catch {
          // Invalid JSON, skip
        }
      }
    }

    // Stop at IEND chunk
    if (type === "IEND") {
      break;
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Fetch an example workflow image and extract the embedded workflow
 */
export async function fetchExampleWorkflow(
  imageUrl: string
): Promise<{
  success: boolean;
  workflow?: Record<string, unknown>;
  prompt?: Record<string, unknown>;
  error?: string;
}> {
  try {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      return { success: false, error: `Failed to fetch: ${response.statusText}` };
    }

    const imageData = await response.arrayBuffer();
    const extracted = await extractWorkflowFromPng(imageData);

    if (!extracted) {
      return { success: false, error: "No workflow data found in image" };
    }

    return {
      success: true,
      workflow: extracted.workflow,
      prompt: extracted.prompt,
    };
  } catch (error) {
    return {
      success: false,
      error: `Error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Fetch a JSON workflow file directly
 */
export async function fetchJsonWorkflow(
  jsonUrl: string
): Promise<{
  success: boolean;
  workflow?: Record<string, unknown>;
  error?: string;
}> {
  try {
    const response = await fetch(jsonUrl);
    if (!response.ok) {
      return { success: false, error: `Failed to fetch: ${response.statusText}` };
    }

    const workflow = await response.json() as Record<string, unknown>;
    return {
      success: true,
      workflow,
    };
  } catch (error) {
    return {
      success: false,
      error: `Error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export const listExamplesSchema = z.object({
  category: z
    .string()
    .optional()
    .describe(
      "Filter by category (basics, sdxl, flux, video, audio, controlnet, etc.)"
    ),
});

export type ListExamplesInput = z.infer<typeof listExamplesSchema>;

export function listExamples(input: ListExamplesInput): string {
  let examples = EXAMPLE_WORKFLOWS;

  if (input.category) {
    const cat = input.category.toLowerCase();
    examples = examples.filter((e) => e.category.toLowerCase().includes(cat));
  }

  // Group by category
  const grouped: Record<string, ExampleWorkflow[]> = {};
  for (const example of examples) {
    if (!grouped[example.category]) {
      grouped[example.category] = [];
    }
    grouped[example.category].push(example);
  }

  let result = "# ComfyUI Example Workflows\n\n";
  result +=
    "These examples are from the official ComfyUI documentation.\n";
  result += "Use `get_example_workflow` to fetch the actual workflow JSON.\n\n";

  for (const [category, categoryExamples] of Object.entries(grouped)) {
    result += `## ${category.charAt(0).toUpperCase() + category.slice(1)}\n\n`;
    for (const example of categoryExamples) {
      result += `### ${example.name}\n`;
      result += `${example.description}\n`;
      result += `- Documentation: ${example.pageUrl}\n`;
      if (example.imageUrls.length > 0) {
        result += `- Workflow images: ${example.imageUrls.length}\n`;
      }
      if (example.jsonUrls && example.jsonUrls.length > 0) {
        result += `- JSON workflows: ${example.jsonUrls.length}\n`;
      }
      if (example.requiredModels && example.requiredModels.length > 0) {
        result += `- Required models:\n`;
        for (const model of example.requiredModels) {
          result += `  - ${model.type}: ${model.name}\n`;
          result += `    ${model.url}\n`;
        }
      }
      if (example.requiredNodes) {
        result += `- Required nodes: ${example.requiredNodes.join(", ")}\n`;
      }
      if (example.notes) {
        result += `- Notes: ${example.notes}\n`;
      }
      result += "\n";
    }
  }

  return result;
}

export const getExampleWorkflowSchema = z.object({
  name: z.string().describe("Name of the example workflow to fetch"),
  variant: z
    .number()
    .optional()
    .default(0)
    .describe("Which variant to get (0 = first/default)"),
});

export type GetExampleWorkflowInput = z.infer<typeof getExampleWorkflowSchema>;

export async function getExampleWorkflow(
  input: GetExampleWorkflowInput
): Promise<string> {
  const searchName = input.name.toLowerCase();
  const example = EXAMPLE_WORKFLOWS.find(
    (e) =>
      e.name.toLowerCase().includes(searchName) ||
      e.category.toLowerCase() === searchName
  );

  if (!example) {
    return `Example "${input.name}" not found. Use list_examples to see available examples.`;
  }

  // Determine if we have PNG images or JSON files
  const hasPngWorkflows = example.imageUrls.length > 0;
  const hasJsonWorkflows = example.jsonUrls && example.jsonUrls.length > 0;

  if (!hasPngWorkflows && !hasJsonWorkflows) {
    let output = `# ${example.name}\n\n`;
    output += `${example.description}\n\n`;
    output += `This example does not have downloadable workflow files.\n`;
    output += `Visit ${example.pageUrl} for more information.\n\n`;

    if (example.requiredModels && example.requiredModels.length > 0) {
      output += `## Required Models\n\n`;
      for (const model of example.requiredModels) {
        output += `### ${model.name}\n`;
        output += `- Type: ${model.type}\n`;
        output += `- URL: ${model.url}\n`;
        if (model.destination) {
          output += `- Install to: ${model.destination}\n`;
        }
        output += "\n";
      }
    }

    if (example.notes) {
      output += `## Notes\n${example.notes}\n`;
    }

    return output;
  }

  let result: { success: boolean; workflow?: Record<string, unknown>; prompt?: Record<string, unknown>; error?: string };
  let sourceUrl: string;

  // Prefer JSON workflows if available, then PNG
  if (hasJsonWorkflows) {
    const variantIndex = Math.min(input.variant, example.jsonUrls!.length - 1);
    sourceUrl = example.jsonUrls![variantIndex];
    result = await fetchJsonWorkflow(sourceUrl);
  } else {
    const variantIndex = Math.min(input.variant, example.imageUrls.length - 1);
    sourceUrl = example.imageUrls[variantIndex];
    result = await fetchExampleWorkflow(sourceUrl);
  }

  if (!result.success) {
    return `Failed to fetch workflow: ${result.error}\n\nYou can manually visit: ${sourceUrl}`;
  }

  let output = `# ${example.name} Workflow\n\n`;
  output += `${example.description}\n\n`;
  output += `Source: ${sourceUrl}\n\n`;

  // Return the prompt (API format) which is what ComfyUI actually executes
  const workflowData = result.prompt || result.workflow;
  if (workflowData) {
    output += `## Workflow (API Format)\n`;
    output += "This can be used directly with the `run_workflow` tool:\n\n";
    output += "```json\n";
    output += JSON.stringify(workflowData, null, 2);
    output += "\n```\n";
  }

  if (example.requiredModels && example.requiredModels.length > 0) {
    output += `\n## Required Models\n\n`;
    for (const model of example.requiredModels) {
      output += `### ${model.name}\n`;
      output += `- Type: ${model.type}\n`;
      output += `- URL: ${model.url}\n`;
      if (model.destination) {
        output += `- Install to: ${model.destination}\n`;
      }
      output += "\n";
    }
  }

  if (example.notes) {
    output += `## Notes\n${example.notes}\n`;
  }

  return output;
}

/**
 * Get all model downloads for a specific example or category
 */
export function getModelDownloads(categoryOrName?: string): ModelDownload[] {
  let examples = EXAMPLE_WORKFLOWS;

  if (categoryOrName) {
    const search = categoryOrName.toLowerCase();
    examples = examples.filter(
      (e) =>
        e.name.toLowerCase().includes(search) ||
        e.category.toLowerCase().includes(search)
    );
  }

  const models: ModelDownload[] = [];
  const seen = new Set<string>();

  for (const example of examples) {
    if (example.requiredModels) {
      for (const model of example.requiredModels) {
        const key = `${model.type}:${model.url}`;
        if (!seen.has(key)) {
          seen.add(key);
          models.push(model);
        }
      }
    }
  }

  return models;
}

/**
 * Get all unique categories
 */
export function getCategories(): string[] {
  const categories = new Set<string>();
  for (const example of EXAMPLE_WORKFLOWS) {
    categories.add(example.category);
  }
  return Array.from(categories).sort();
}

// Model patterns for workflow recommendation
