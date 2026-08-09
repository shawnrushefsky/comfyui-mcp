import { z } from "zod";
import sharp from "sharp";
import { generateFontFaceCSS } from "./fonts.js";

export const renderSvgSchema = z.object({
  svg: z.string().describe("SVG content to render (full SVG markup including <svg> tags)"),
  filename: z.string().optional().describe("Output filename (without extension). Defaults to 'svg_render_<timestamp>'"),
  width: z.number().optional().default(768).describe("Output width in pixels (default: 768)"),
  height: z.number().optional().default(768).describe("Output height in pixels (default: 768)"),
  background: z.string().optional().describe("Background color (default: transparent). Use hex like '#ffffff' or 'transparent'"),
  fonts: z.array(z.object({
    name: z.string().describe("Font name (must be downloaded first with download_font)"),
    family: z.string().optional().describe("CSS font-family name to use in the SVG (defaults to font name)"),
  })).optional().describe("Fonts to embed in the SVG for rendering"),
});

export type RenderSvgInput = z.infer<typeof renderSvgSchema>;

export interface RenderSvgResult {
  success: boolean;
  filename?: string;
  buffer?: Buffer;
  error?: string;
}

// Matches href / xlink:href values that point at an external or local
// resource rather than an in-document fragment (#id) or a self-contained
// data: URI.
const EXTERNAL_HREF_PATTERN = /^\s*(?:https?|file|ftp):/i;

/**
 * Strip constructs that let SVG markup reach outside the document it came
 * in: <image>/<use>/<script>/<foreignObject> href targets pointing at a
 * remote URL or local file get rasterized (or executed) by the renderer,
 * turning caller-supplied SVG into an SSRF or local-file-read primitive -
 * the referenced content ends up embedded in the output PNG, which is
 * uploaded to ComfyUI and can flow back to the caller. This is deliberately
 * conservative: fragment references (#id) and data: URIs are left alone
 * since they're self-contained and cover the legitimate embedding cases.
 */
function sanitizeSvg(svg: string): string {
  let sanitized = svg;

  sanitized = sanitized.replace(/<script[\s\S]*?<\/script\s*>/gi, "");
  sanitized = sanitized.replace(/<foreignObject[\s\S]*?<\/foreignObject\s*>/gi, "");

  sanitized = sanitized.replace(
    /((?:xlink:)?href\s*=\s*)("([^"]*)"|'([^']*)')/gi,
    (match, prefix, _quoted, dq, sq) => {
      const value = dq ?? sq ?? "";
      if (EXTERNAL_HREF_PATTERN.test(value)) {
        return `${prefix}""`;
      }
      return match;
    }
  );

  return sanitized;
}

/**
 * Render SVG to PNG buffer for upload to ComfyUI.
 * Returns the buffer and filename for use with uploadImage API.
 */
export async function renderSvg(
  input: RenderSvgInput
): Promise<RenderSvgResult> {
  try {
    // Generate filename if not provided
    const timestamp = Date.now();
    const filename = input.filename || `svg_render_${timestamp}`;
    const outputFilename = `${filename}.png`;

    // Parse and modify SVG to ensure proper dimensions
    let svgContent = sanitizeSvg(input.svg);

    // Embed fonts if specified
    if (input.fonts && input.fonts.length > 0) {
      const fontFaces: string[] = [];

      for (const font of input.fonts) {
        const css = await generateFontFaceCSS(font.name, font.family);
        if (css) {
          fontFaces.push(css);
        }
      }

      if (fontFaces.length > 0) {
        // Inject font-face declarations into SVG
        const fontStyle = `<defs><style type="text/css">\n${fontFaces.join("\n")}\n</style></defs>`;

        // Insert after opening <svg> tag
        svgContent = svgContent.replace(/<svg([^>]*)>/, `<svg$1>${fontStyle}`);
      }
    }

    // If SVG doesn't have width/height attributes, add them
    if (!svgContent.includes('width=') && !svgContent.includes('height=')) {
      svgContent = svgContent.replace(
        '<svg',
        `<svg width="${input.width}" height="${input.height}"`
      );
    }

    // Add viewBox if not present (helps with scaling)
    if (!svgContent.includes('viewBox=')) {
      svgContent = svgContent.replace(
        '<svg',
        `<svg viewBox="0 0 ${input.width} ${input.height}"`
      );
    }

    // Create a buffer from SVG
    const svgBuffer = Buffer.from(svgContent);

    // Determine background
    const hasBackground = input.background && input.background !== 'transparent';

    let pngBuffer: Buffer;
    if (hasBackground) {
      // Render with solid background
      pngBuffer = await sharp({
        create: {
          width: input.width!,
          height: input.height!,
          channels: 4,
          background: input.background!,
        },
      })
        .composite([
          {
            input: svgBuffer,
            top: 0,
            left: 0,
          },
        ])
        .png()
        .toBuffer();
    } else {
      // Render SVG directly (transparent background)
      pngBuffer = await sharp(svgBuffer)
        .resize(input.width!, input.height!, { fit: 'contain' })
        .png()
        .toBuffer();
    }

    return {
      success: true,
      filename: outputFilename,
      buffer: pngBuffer,
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
