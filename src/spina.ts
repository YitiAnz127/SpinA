import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { registerDistillationTools } from './distillation/tools.ts';
import { deepSeekConfig } from './distillation/deepseek.ts';
import { SOL_LABEL } from './model-policy.ts';
import { assistantMarkdownCompatibility } from './markdown.ts';

export default function spina(pi: ExtensionAPI) {
  pi.registerMarkdownTransformer(assistantMarkdownCompatibility);
  registerDistillationTools(pi);
  const showStatus = (ctx: ExtensionContext, state: string) => {
    if (ctx.hasUI) ctx.ui.setStatus("spina", `SpinA · ${state}`);
  };

  pi.on("session_start", async (_event, ctx) => {
    showStatus(ctx, "就绪");
    if (ctx.hasUI) {
      ctx.ui.setWidget("spina", [
        "SpinA · 尖晶石制备",
        "输入问题开始对话。/distill SPINA-0100 蒸馏论文，/spina 查看状态。",
      ]);
    }
  });
  pi.on("agent_start", async (_event, ctx) => showStatus(ctx, "处理中"));
  pi.on("agent_settled", async (_event, ctx) => showStatus(ctx, "就绪"));

  pi.registerCommand("spina", {
    description: "查看 SpinA harness 状态",
    handler: async (_args, ctx) => {
      let deepSeekReady = false;
      try { deepSeekReady = Boolean(deepSeekConfig().apiKey); } catch { /* Show configuration state without exposing credentials. */ }
      ctx.ui.notify([
        "SpinA",
        `蒸馏模型：DeepSeek 官方 API / ${process.env.SPINA_DISTILL_MODEL ?? 'deepseek-flash'} (${process.env.SPINA_DISTILL_EFFORT ?? 'high'})`,
        `DeepSeek 密钥：${deepSeekReady ? '已配置' : '未配置'}`,
        `核验模型：${SOL_LABEL}`,
        `问答模型：${ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "未选择"} (${ctx.thinkingLevel ?? pi.getThinkingLevel()})`,
        `项目目录：${ctx.cwd}`,
      ].join("\n"), "info");
    },
  });
}
