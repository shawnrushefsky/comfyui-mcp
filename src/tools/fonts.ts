import { z } from "zod";
import { mkdir, readFile, writeFile, readdir } from "fs/promises";
import { existsSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import { safeFetch } from "../utils/safe-fetch.js";

// Font cache directory
const FONTS_DIR = join(homedir(), ".comfyui-mcp", "fonts");

export const downloadFontSchema = z.object({
  source: z.union([
    z.object({
      type: z.literal("google"),
      family: z.string().describe("Google Font family name (e.g., 'Cinzel', 'Pirata One', 'MedievalSharp')"),
      weight: z.number().optional().default(400).describe("Font weight (100-900, default: 400)"),
    }),
    z.object({
      type: z.literal("url"),
      url: z.string().url().describe("Direct URL to a .ttf, .otf, or .woff2 font file"),
      name: z.string().describe("Name to save the font as (without extension)"),
    }),
  ]).describe("Font source - either Google Fonts or a direct URL"),
});

export const listFontsSchema = z.object({});

export type DownloadFontInput = z.infer<typeof downloadFontSchema>;

export interface FontInfo {
  name: string;
  filename: string;
  path: string;
  format: string;
  size: number;
}

export interface DownloadFontResult {
  success: boolean;
  font?: FontInfo;
  error?: string;
}

export interface ListFontsResult {
  fonts: FontInfo[];
  fontsDir: string;
}

/**
 * Ensure the fonts directory exists
 */
async function ensureFontsDir(): Promise<void> {
  if (!existsSync(FONTS_DIR)) {
    await mkdir(FONTS_DIR, { recursive: true });
  }
}

/**
 * Get font format from filename/URL
 */
function getFontFormat(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  switch (ext) {
    case "ttf":
      return "truetype";
    case "otf":
      return "opentype";
    case "woff":
      return "woff";
    case "woff2":
      return "woff2";
    default:
      return "truetype";
  }
}

/**
 * Download a font from Google Fonts
 */
async function downloadFromGoogle(
  family: string,
  weight: number = 400
): Promise<DownloadFontResult> {
  try {
    // Google Fonts CSS API URL
    // Using woff2 user agent to get woff2 format
    const cssUrl = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@${weight}&display=swap`;

    // Fetch CSS with Chrome user agent to get woff2
    const cssResponse = await safeFetch(cssUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
    });

    if (!cssResponse.ok) {
      return {
        success: false,
        error: `Failed to fetch Google Font CSS: ${cssResponse.status} - Font family "${family}" may not exist`,
      };
    }

    const css = await cssResponse.text();

    // Extract font URL from CSS
    // Look for: src: url(https://fonts.gstatic.com/...) format('woff2');
    const urlMatch = css.match(/src:\s*url\(([^)]+)\)\s*format\(['"]?woff2['"]?\)/);
    if (!urlMatch) {
      // Try truetype/opentype fallback
      const ttfMatch = css.match(/src:\s*url\(([^)]+)\)\s*format\(['"]?(truetype|opentype)['"]?\)/);
      if (!ttfMatch) {
        return {
          success: false,
          error: `Could not extract font URL from Google Fonts CSS for "${family}"`,
        };
      }
    }

    const fontUrl = urlMatch?.[1] || css.match(/src:\s*url\(([^)]+)\)/)?.[1];
    if (!fontUrl) {
      return {
        success: false,
        error: `Could not extract font URL from CSS`,
      };
    }

    // Download the font file
    const fontResponse = await safeFetch(fontUrl);
    if (!fontResponse.ok) {
      return {
        success: false,
        error: `Failed to download font file: ${fontResponse.status}`,
      };
    }

    const fontData = await fontResponse.arrayBuffer();

    // Determine format from URL
    const format = fontUrl.includes(".woff2")
      ? "woff2"
      : fontUrl.includes(".woff")
      ? "woff"
      : fontUrl.includes(".ttf")
      ? "ttf"
      : "woff2";

    // Save to fonts directory
    await ensureFontsDir();
    const safeName = family.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
    const filename = `${safeName}_${weight}.${format}`;
    const filepath = join(FONTS_DIR, filename);

    await writeFile(filepath, Buffer.from(fontData));

    return {
      success: true,
      font: {
        name: family,
        filename,
        path: filepath,
        format: getFontFormat(filename),
        size: fontData.byteLength,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Download a font from a direct URL
 */
async function downloadFromUrl(
  url: string,
  name: string
): Promise<DownloadFontResult> {
  try {
    const response = await safeFetch(url);
    if (!response.ok) {
      return {
        success: false,
        error: `Failed to download font: ${response.status} ${response.statusText}`,
      };
    }

    const fontData = await response.arrayBuffer();

    // Get extension from URL or default to ttf
    const urlPath = new URL(url).pathname;
    const ext = urlPath.split(".").pop()?.toLowerCase() || "ttf";
    const validExt = ["ttf", "otf", "woff", "woff2"].includes(ext) ? ext : "ttf";

    // Save to fonts directory
    await ensureFontsDir();
    const safeName = name.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
    const filename = `${safeName}.${validExt}`;
    const filepath = join(FONTS_DIR, filename);

    await writeFile(filepath, Buffer.from(fontData));

    return {
      success: true,
      font: {
        name,
        filename,
        path: filepath,
        format: getFontFormat(filename),
        size: fontData.byteLength,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Download a font from Google Fonts or a URL
 */
export async function downloadFont(
  input: DownloadFontInput
): Promise<DownloadFontResult> {
  if (input.source.type === "google") {
    return downloadFromGoogle(input.source.family, input.source.weight);
  } else {
    return downloadFromUrl(input.source.url, input.source.name);
  }
}

/**
 * List all cached fonts
 */
export async function listFonts(): Promise<ListFontsResult> {
  await ensureFontsDir();

  const fonts: FontInfo[] = [];

  try {
    const files = await readdir(FONTS_DIR);

    for (const file of files) {
      const ext = file.split(".").pop()?.toLowerCase();
      if (["ttf", "otf", "woff", "woff2"].includes(ext || "")) {
        const filepath = join(FONTS_DIR, file);
        const data = await readFile(filepath);

        // Extract name from filename (remove extension and weight suffix)
        const nameWithoutExt = file.replace(/\.[^.]+$/, "");
        const name = nameWithoutExt.replace(/_\d+$/, "").replace(/_/g, " ");

        fonts.push({
          name,
          filename: file,
          path: filepath,
          format: getFontFormat(file),
          size: data.length,
        });
      }
    }
  } catch {
    // Directory might be empty or not exist
  }

  return {
    fonts,
    fontsDir: FONTS_DIR,
  };
}

/**
 * Get font data as base64 for embedding in SVG
 */
export async function getFontBase64(fontName: string): Promise<{
  base64: string;
  format: string;
  mimeType: string;
} | null> {
  await ensureFontsDir();

  try {
    const files = await readdir(FONTS_DIR);
    const safeName = fontName.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();

    // Find matching font file
    const fontFile = files.find((f) => f.toLowerCase().startsWith(safeName));
    if (!fontFile) {
      return null;
    }

    const filepath = join(FONTS_DIR, fontFile);
    const data = await readFile(filepath);
    const base64 = data.toString("base64");

    const ext = fontFile.split(".").pop()?.toLowerCase();
    const format = getFontFormat(fontFile);

    let mimeType = "font/ttf";
    if (ext === "woff2") mimeType = "font/woff2";
    else if (ext === "woff") mimeType = "font/woff";
    else if (ext === "otf") mimeType = "font/otf";

    return { base64, format, mimeType };
  } catch {
    return null;
  }
}

/**
 * Generate @font-face CSS for embedding in SVG
 */
export async function generateFontFaceCSS(
  fontName: string,
  familyName?: string
): Promise<string | null> {
  const fontData = await getFontBase64(fontName);
  if (!fontData) {
    return null;
  }

  const family = familyName || fontName;

  return `@font-face {
  font-family: '${family}';
  src: url(data:${fontData.mimeType};base64,${fontData.base64}) format('${fontData.format}');
  font-weight: normal;
  font-style: normal;
}`;
}

/**
 * List of popular fantasy/map fonts available on Google Fonts
 */
export const RECOMMENDED_MAP_FONTS = [
  { family: "Cinzel", description: "Elegant fantasy serif, great for region names" },
  { family: "Pirata One", description: "Pirate/nautical style, good for sea maps" },
  { family: "MedievalSharp", description: "Medieval calligraphy style" },
  { family: "UnifrakturMaguntia", description: "Blackletter/gothic style" },
  { family: "Almendra", description: "Fantasy serif with medieval feel" },
  { family: "IM Fell English", description: "Classic old English printing style" },
  { family: "Metamorphous", description: "Fantasy display font" },
  { family: "Eagle Lake", description: "Celtic-inspired decorative" },
  { family: "Grenze Gotisch", description: "Gothic blackletter" },
  { family: "New Rocker", description: "Bold fantasy display" },
];
