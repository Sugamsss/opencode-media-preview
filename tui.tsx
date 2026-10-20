/** @jsxImportSource @opentui/solid */
/** Native OpenTUI image/contact-sheet viewer for Apple Terminal and other terminals. */
import { execFile } from "node:child_process"
import { promises as fs } from "node:fs"
import os from "node:os"
import path from "node:path"
import { promisify } from "node:util"
import { createSignal, Show } from "solid-js"
import type { PanelInput } from "@opencode/plugin/tui/context"

const execFileAsync = promisify(execFile)
const MAX_INPUT_BYTES = 512 * 1024 * 1024
const DOWNLOADS_DIR = path.join(os.homedir(), "Downloads")
const PREVIEW_DIR = path.join(os.homedir(), ".cache", "opencode", "media-previews")
const TUI_IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"])
const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".tif", ".tiff", ".avif"])
const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi", ".mts", ".m2ts"])

function resolvePath(input: string): string {
  const trimmed = input.trim()
  if (trimmed.startsWith("~/") || trimmed === "~") {
    return path.join(os.homedir(), trimmed.slice(1).replace(/^\//, ""))
  }
  return path.resolve(trimmed)
}

async function validate(input: string) {
  const resolved = resolvePath(input)
  const filePath = await fs.realpath(resolved)
  const info = await fs.stat(filePath)
  if (!info.isFile()) throw new Error("Path must name a regular file")
  if (info.size > MAX_INPUT_BYTES) throw new Error("File exceeds the 512 MiB preview limit")
  const ext = path.extname(filePath).toLowerCase()
  if (!TUI_IMAGE_EXTENSIONS.has(ext) && !VIDEO_EXTENSIONS.has(ext)) {
    if (IMAGE_EXTENSIONS.has(ext)) {
      throw new Error(`${ext} is not supported by the terminal block viewer (supports PNG/JPEG/WebP/GIF). Use the media_preview tool to open it in macOS Preview instead.`)
    }
    throw new Error(`Unsupported media type: ${ext || "no extension"}`)
  }
  return { filePath, ext, bytes: info.size }
}

async function findLatestDownloadImage(): Promise<string | null> {
  try {
    const entries = await fs.readdir(DOWNLOADS_DIR, { withFileTypes: true })
    const candidateFiles: Array<{ filePath: string; mtime: number }> = []
    for (const entry of entries) {
      if (!entry.isFile() && !entry.isSymbolicLink()) continue
      if (entry.name.startsWith(".")) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (!TUI_IMAGE_EXTENSIONS.has(ext)) continue
      const fullPath = path.join(DOWNLOADS_DIR, entry.name)
      try {
        const stat = await fs.stat(fullPath)
        if (stat.isFile() && stat.size <= MAX_INPUT_BYTES && stat.size > 0) {
          candidateFiles.push({ filePath: fullPath, mtime: stat.mtimeMs })
        }
      } catch {
        // ignore unreadable files
      }
    }
    if (candidateFiles.length === 0) return null
    candidateFiles.sort((a, b) => b.mtime - a.mtime)
    return candidateFiles[0].filePath
  } catch {
    return null
  }
}

async function prunePreviews() {
  try {
    await fs.mkdir(PREVIEW_DIR, { recursive: true })
    const entries = await fs.readdir(PREVIEW_DIR, { withFileTypes: true })
    const files = await Promise.all(
      entries
        .filter((entry) => entry.isFile())
        .map(async (entry) => {
          const file = path.join(PREVIEW_DIR, entry.name)
          return { file, mtime: (await fs.stat(file)).mtimeMs }
        })
    )
    files.sort((a, b) => b.mtime - a.mtime)
    await Promise.all(files.slice(20).map(({ file }) => fs.rm(file, { force: true })))
  } catch {
    // best effort prune
  }
}

async function contactSheet(filePath: string) {
  await prunePreviews()
  const output = path.join(PREVIEW_DIR, `terminal-${Date.now()}-${process.pid}.jpg`)
  await execFileAsync("ffmpeg", [
    "-hide_banner", "-loglevel", "error", "-nostdin", "-i", filePath,
    "-vf", "fps=1,scale=640:-2:force_original_aspect_ratio=decrease,tile=3x2:padding=4:margin=4",
    "-frames:v", "1", "-q:v", "4", "-pix_fmt", "yuvj420p", "-y", output,
  ], { timeout: 60_000, maxBuffer: 128 * 1024 })
  return output
}

function MediaPanel(props: { panel: PanelInput; media: () => { path: string; source: string } | null; context: any }) {
  const context = props.context
  context.keymap.layer(() => ({
    target: () => props.panel,
    commands: [{ id: "opencode.media-preview.close", title: "Close media preview", bind: "escape", run: props.panel.close }],
    bindings: ["opencode.media-preview.close"],
  }))
  return (
    <Show when={props.media()} fallback={<text fg={context.theme.text.muted}>No media selected. Press Esc to close.</text>}>
      {(media) => (
        <box flexDirection="column" width="100%" height="100%" padding={1}>
          <text fg={context.theme.text.default}>Terminal Media Viewer · Esc to close</text>
          <text fg={context.theme.text.muted}>{media().source}</text>
          <image source={media().path} protocol="blocks" fit="fit" flexGrow={1} />
          <text fg={context.theme.text.muted}>Terminal block view · Press Esc to return to session</text>
        </box>
      )}
    </Show>
  )
}

export default {
  id: "opencode.media-preview.tui",
  setup(context) {
    const [media, setMedia] = createSignal<{ path: string; source: string } | null>(null)
    context.ui.slot({
      append: "session.panel",
      render: (panel) => <Show when={panel.name === "opencode.media-preview"}><MediaPanel panel={panel} media={media} context={context} /></Show>,
    })
    context.ui.slot({
      append: "app",
      render: () => {
        context.keymap?.layer?.(() => ({
          mode: "global",
          commands: [
            {
              id: "opencode.media-preview.downloads",
              title: "Preview latest download image",
              group: "Media",
              palette: true,
              slash: { name: "media-downloads", aliases: ["media-download"], arguments: false },
              run: async () => {
                try {
                  const latest = await findLatestDownloadImage()
                  if (!latest) {
                    context.ui.toast.show({
                      title: "Media preview",
                      message: "No supported images found in ~/Downloads",
                      variant: "warning",
                    })
                    return
                  }
                  const file = await validate(latest)
                  setMedia({
                    path: file.filePath,
                    source: `${file.filePath} (newest in ~/Downloads)`,
                  })
                  if (context.ui.panel.open("opencode.media-preview", { presentation: "fullscreen" }) === false) {
                    context.ui.toast.show({ title: "Media preview", message: "Open this inside a session.", variant: "warning" })
                  }
                } catch (error) {
                  context.ui.toast.show({
                    title: "Media preview",
                    message: error instanceof Error ? error.message : String(error),
                    variant: "error",
                  })
                }
              },
            },
            {
              id: "opencode.media-preview.open",
              title: "Open media preview",
              group: "Media",
              palette: true,
              slash: { name: "media", aliases: ["media-preview"], arguments: true },
              run: async (input) => {
                let target = input?.trim()
                if (!target) {
                  const latest = await findLatestDownloadImage()
                  const placeholder = latest
                    ? `Path or press Enter for latest download (${path.basename(latest)})`
                    : "/absolute/path/to/image-or-video"
                  const prompted = await context.ui.dialog.prompt({
                    title: "Media preview",
                    placeholder,
                  })
                  if (prompted === undefined) return
                  target = prompted.trim()
                  if (!target) {
                    if (!latest) {
                      context.ui.toast.show({
                        title: "Media preview",
                        message: "No path provided and no images found in ~/Downloads",
                        variant: "warning",
                      })
                      return
                    }
                    target = latest
                  }
                } else if (target.toLowerCase() === "downloads" || target.toLowerCase() === "download" || target.toLowerCase() === "latest") {
                  const latest = await findLatestDownloadImage()
                  if (!latest) {
                    context.ui.toast.show({
                      title: "Media preview",
                      message: "No supported images found in ~/Downloads",
                      variant: "warning",
                    })
                    return
                  }
                  target = latest
                }
                try {
                  const file = await validate(target)
                  const isVideo = VIDEO_EXTENSIONS.has(file.ext)
                  const preview = isVideo ? await contactSheet(file.filePath) : file.filePath
                  setMedia({
                    path: preview,
                    source: isVideo ? `${file.filePath} · contact sheet (not playback)` : file.filePath,
                  })
                  if (context.ui.panel.open("opencode.media-preview", { presentation: "fullscreen" }) === false) {
                    context.ui.toast.show({ title: "Media preview", message: "Open this inside a session.", variant: "warning" })
                  }
                } catch (error) {
                  context.ui.toast.show({
                    title: "Media preview",
                    message: error instanceof Error ? error.message : String(error),
                    variant: "error",
                  })
                }
              },
            },
          ],
        }))
        return null
      },
    })
  },
}
