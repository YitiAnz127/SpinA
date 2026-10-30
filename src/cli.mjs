import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SOL_POLICY } from './model-policy.ts';

export const projectRoot = fileURLToPath(new URL("../", import.meta.url));

export function buildLaunchOptions(args = [], env = process.env) {
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"))), "..");
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const sessionDir = join(projectRoot, ".runtime", "sessions");
  const pdfSkill = join(projectRoot, 'src', 'skills', 'pdf-extraction', 'SKILL.md');
  const systemPrompt = readFileSync(join(projectRoot, "src", "system-prompt.md"), "utf8") + '\n\n' + readFileSync(pdfSkill, 'utf8').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');

  return {
    executable: process.execPath,
    args: [
      join(packageRoot, manifest.bin.pi),
      "--no-extensions",
      "--extension", join(projectRoot, "src", "spina.ts"),
      "--no-skills",
      "--skill", pdfSkill,
      "--no-prompt-templates",
      "--no-context-files",
      "--no-mcp",
      "--no-builtin-tools",
      "--session-dir", sessionDir,
      "--system-prompt", systemPrompt,
      "--model", `${SOL_POLICY.provider}/${SOL_POLICY.model}`,
      "--thinking", SOL_POLICY.reasoning,
      ...args,
    ],
    cwd: projectRoot,
    sessionDir,
    env: { ...env },
  };
}

export function main(args = process.argv.slice(2)) {
  try {
    const options = buildLaunchOptions(args);
    mkdirSync(options.sessionDir, { recursive: true });
    const child = spawn(options.executable, options.args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit",
      windowsHide: true,
    });
    // Pi receives Ctrl+C directly from the terminal and handles cancellation.
    const onInterrupt = () => {};
    process.on("SIGINT", onInterrupt);
    child.once("error", (error) => {
      process.off("SIGINT", onInterrupt);
      console.error(`SpinA 启动失败：${error.message}`);
      process.exitCode = 1;
    });
    child.once("exit", (code, signal) => {
      process.off("SIGINT", onInterrupt);
      process.exitCode = code ?? (signal === "SIGINT" ? 130 : 1);
    });
    return child;
  } catch (error) {
    const hint = ['ERR_MODULE_NOT_FOUND', 'MODULE_NOT_FOUND'].includes(error.code) ? '\n请先在项目目录运行 npm install。' : '';
    console.error(`SpinA 启动失败：${error.message}${hint}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
