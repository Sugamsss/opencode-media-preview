/** Small, local-only media preview helpers for macOS OpenCode sessions. */
import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)
const MAX_INPUT_BYTES = 512 * 1024 * 1024
const PREVIEW_DIR = path.join(os.homedir(), ".cache", "opencode", "media-previews")
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".avif"])
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".mts", ".m2ts"])

function json(value: unknown) {
  return { content: JSON.stringify(value, null, 2) }
}

async function safeFile(input: string) {
  if (typeof input !== "string" || input.trim().length === 0) throw new Error("filePath is required")
  const requested = path.resolve(input.trim())
  const filePath = await fs.realpath(requested)
  const info = await fs.stat(filePath)
  if (!info.isFile()) throw new Error("filePath must name a regular file")
  if (info.size > MAX_INPUT_BYTES) throw new Error("file exceeds the 512 MiB preview limit")
  return { filePath, info }
}

async function probe(filePath: string) {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-show_entries", "format=filename,format_name,duration,size:stream=index,codec_type,codec_name,width,height,r_frame_rate",
    "-of", "json", filePath,
  ], { maxBuffer: 256 * 1024 })
  return JSON.parse(stdout)
}

async function prunePreviews() {
  await fs.mkdir(PREVIEW_DIR, { recursive: true })
  const entries = await fs.readdir(PREVIEW_DIR, { withFileTypes: true })
  const files = await Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => {
    const file = path.join(PREVIEW_DIR, entry.name)
    return { file, mtime: (await fs.stat(file)).mtimeMs }
  }))
  files.sort((a, b) => b.mtime - a.mtime)
  await Promise.all(files.slice(20).map(({ file }) => fs.rm(file, { force: true })))
}

async function openInMacOS(filePath: string) {
  await execFileAsync("open", [filePath], { timeout: 10_000, maxBuffer: 32 * 1024 })
}

export default {
  id: "opencode.media-preview",
  setup: async (ctx: any) => {
    await ctx.tool.transform((editor: any) => {
      editor.add({
        name: "media_preview",
        description: "Safely inspect an image or create a bounded video contact sheet, then open it with macOS Preview. No raw shell arguments are accepted.",
        input: {
          type: "object",
          properties: { filePath: { type: "string", minLength: 1 } },
          required: ["filePath"],
          additionalProperties: false,
        },
        execute: async (input: { filePath: string }) => {
          const { filePath, info } = await safeFile(input.filePath)
          const ext = path.extname(filePath).toLowerCase()
          if (!IMAGE_EXTENSIONS.has(ext) && !VIDEO_EXTENSIONS.has(ext)) {
            throw new Error(`unsupported preview type: ${ext || "no extension"}`)
          }
          const metadata = await probe(filePath)
          if (IMAGE_EXTENSIONS.has(ext)) {
            await openInMacOS(filePath)
            return json({ kind: "image", filePath, bytes: info.size, openedWith: "macOS open", metadata })
          }

          await prunePreviews()
          const output = path.join(PREVIEW_DIR, `${Date.now()}-${process.pid}.jpg`)
          await execFileAsync("ffmpeg", [
            "-hide_banner", "-loglevel", "error", "-nostdin", "-i", filePath,
            "-vf", "fps=1,scale=640:-2:force_original_aspect_ratio=decrease,tile=3x2:padding=4:margin=4",
            "-frames:v", "1", "-q:v", "4", "-pix_fmt", "yuvj420p", "-y", output,
          ], { timeout: 60_000, maxBuffer: 128 * 1024 })
          await openInMacOS(output)
          return json({ kind: "video", filePath, bytes: info.size, contactSheet: output, openedWith: "macOS open", metadata })
        },
      })
    })
  },
}
