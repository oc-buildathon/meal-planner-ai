import { tool } from "@langchain/core/tools";
import { z } from "zod";
import type { MessagingService } from "../../messaging/messaging.service";

/**
 * Creates tools for sending messages via WhatsApp and Telegram.
 * These close over the MessagingService so the agent can communicate
 * with users and chefs on their preferred platform.
 */
export function createMessagingTools(messagingService: MessagingService) {
  const sendWhatsAppMessage = tool(
    async ({ jid, text }: { jid: string; text: string }) => {
      await messagingService.sendMessage(
        { chatId: jid, type: "text", text },
        "whatsapp",
      );
      return `WhatsApp message sent to ${jid}: "${text.slice(0, 80)}..."`;
    },
    {
      name: "send_whatsapp_message",
      description:
        "Send a text message to a WhatsApp user or group. Use this to communicate with the chef or send notifications. Requires the recipient's JID (e.g. 919876543210@s.whatsapp.net).",
      schema: z.object({
        jid: z
          .string()
          .describe(
            "WhatsApp JID of the recipient (e.g. 919876543210@s.whatsapp.net)",
          ),
        text: z.string().describe("The message text to send"),
      }),
    },
  );

  const sendTelegramMessage = tool(
    async ({ chatId, text }: { chatId: string; text: string }) => {
      await messagingService.sendMessage(
        { chatId, type: "text", text },
        "telegram",
      );
      return `Telegram message sent to ${chatId}: "${text.slice(0, 80)}..."`;
    },
    {
      name: "send_telegram_message",
      description:
        "Send a text message via Telegram. Use as fallback when WhatsApp is unavailable for chef communication or user notifications.",
      schema: z.object({
        chatId: z.string().describe("Telegram chat ID of the recipient"),
        text: z.string().describe("The message text to send"),
      }),
    },
  );

  const formatRecipeInstructions = tool(
    async ({
      recipeName,
      servings,
      ingredients,
      steps,
    }: {
      recipeName: string;
      servings: number;
      ingredients: string[];
      steps: string[];
    }) => {
      const ingredientList = ingredients
        .map((i, idx) => `${idx + 1}. ${i}`)
        .join("\n");
      const stepList = steps.map((s, idx) => `${idx + 1}. ${s}`).join("\n");
      return `*${recipeName}* (${servings} servings)\n\n*Ingredients:*\n${ingredientList}\n\n*Steps:*\n${stepList}`;
    },
    {
      name: "format_recipe_instructions",
      description:
        "Format a recipe into a clean message with ingredients and steps, suitable for sending to the chef via WhatsApp or Telegram.",
      schema: z.object({
        recipeName: z.string().describe("Name of the recipe"),
        servings: z.number().describe("Number of servings"),
        ingredients: z
          .array(z.string())
          .describe("List of ingredients with quantities"),
        steps: z.array(z.string()).describe("Ordered cooking steps"),
      }),
    },
  );

  return { sendWhatsAppMessage, sendTelegramMessage, formatRecipeInstructions };
}
