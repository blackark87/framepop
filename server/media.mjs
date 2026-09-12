import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { AppError, need } from "./http.mjs";
export function command(binary, args, { signal, input, onLine } = {}) {
  return new Promise((ok, no) => {
    const child = spawn(binary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      signal,
    });
    let output = "",
      error = "";
    child.stdout.on("data", (b) => {
      output += b;
      if (output.length > 10e6) child.kill();
    });
    child.stderr.on("data", (b) => {
      error = (error + b).slice(-5000);
      for (const line of b.toString().split("\n")) onLine?.(line);
    });
    child.on("error", no);
    child.on("close", (code) =>
      code === 0
        ? ok(output)
        : no(
            new AppError(
              "EXECUTION_FAILED",
              binary + " 처리 실패: " + error.slice(-500),
              502,
            ),
          ),
    );
    child.stdin.end(input || "");
  });
}
export async function trimVideo(source, destination, seconds, signal) {
  await command(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-i",
      source,
      "-t",
      String(seconds),
      "-an",
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      destination,
    ],
    { signal },
  );
  const probe = JSON.parse(
    await command(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "json",
        destination,
      ],
      { signal },
    ),
  );
  need(
    Math.abs(Number(probe.format.duration) - seconds) <= 0.15,
    "생성된 구간의 실제 길이가 요청 길이와 다릅니다.",
    "OUTPUT_INVALID",
  );
}
export async function lastFrame(video, file, signal) {
  await command(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-sseof",
      "-0.1",
      "-i",
      video,
      "-frames:v",
      "1",
      file,
    ],
    { signal },
  );
}
export async function qc(video, settings, context, { signal, event }) {
  const data = await command(
    process.env.FRAMEPOP_PYTHON || "python3",
    [resolve("scripts/face_qc.py")],
    {
      signal,
      input: JSON.stringify({
        models: resolve("data/qc-models"),
        ...settings,
        ...context,
        video,
      }),
      onLine: (line) => {
        try {
          event({ phase: "face_qc", ...JSON.parse(line) });
        } catch {}
      },
    },
  );
  try {
    return JSON.parse(data);
  } catch {
    throw new AppError("QC_UNAVAILABLE", "얼굴 검사 결과를 읽지 못했습니다.");
  }
}
