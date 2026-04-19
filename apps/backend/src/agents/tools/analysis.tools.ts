import { tool } from "@langchain/core/tools";
import { z } from "zod";

/**
 * Multimodal analysis tools — stubs for Phase 2.
 * These will integrate with Vision LLMs and Whisper API.
 * For now they return structured placeholders so the agent
 * architecture is wired up correctly.
 */

export const analyzeImage = tool(
  async ({
    imageDescription,
    analysisType,
  }: {
    imageDescription: string;
    analysisType: string;
  }) => {
    // Phase 2: Will use GPT-4o Vision / Gemini via deepagents read_file with multimodal
    return JSON.stringify({
      status: "stub",
      analysisType,
      message: `Image analysis (${analysisType}) is coming in Phase 2. Description provided: "${imageDescription}". For now, ask the user to describe the food in text.`,
    });
  },
  {
    name: "analyze_image",
    description:
      "Analyze a food image to extract recipe details, ingredients, presentation style, or cuisine type. Used by the taste learner to update preferences from shared food photos.",
    schema: z.object({
      imageDescription: z
        .string()
        .describe("Description or context about the image"),
      analysisType: z
        .enum(["recipe_extraction", "food_identification", "presentation_analysis", "ingredient_detection"])
        .describe("What kind of analysis to perform"),
    }),
  },
);

export const transcribeAudio = tool(
  async ({
    audioDescription,
    language,
  }: {
    audioDescription: string;
    language: string;
  }) => {
    // Phase 2: Will use Whisper API for Hindi/English STT
    return JSON.stringify({
      status: "stub",
      language,
      message: `Voice transcription (${language}) is coming in Phase 2. Context: "${audioDescription}". For now, ask the user to type their message.`,
    });
  },
  {
    name: "transcribe_audio",
    description:
      "Transcribe a voice note (Hindi or English) to text using Whisper. Used to process voice messages from WhatsApp/Telegram.",
    schema: z.object({
      audioDescription: z
        .string()
        .describe("Context about the audio (e.g. 'voice note about dinner preferences')"),
      language: z
        .enum(["hindi", "english", "hinglish"])
        .describe("Expected language of the voice note")
        .default("hindi"),
    }),
  },
);

export const checkNutrition = tool(
  async ({
    foodItem,
    quantity,
  }: {
    foodItem: string;
    quantity: string;
  }) => {
    // Phase 5: Will integrate with a nutrition API
    return JSON.stringify({
      status: "stub",
      foodItem,
      quantity,
      message: `Nutritional analysis coming in Phase 5. For "${foodItem}" (${quantity}), provide general nutritional guidance based on your knowledge.`,
    });
  },
  {
    name: "check_nutrition",
    description:
      "Check nutritional information (calories, macros, allergens) for a food item. Used by the diet tracker to validate meals against diet constraints.",
    schema: z.object({
      foodItem: z.string().describe("Name of the food item"),
      quantity: z
        .string()
        .describe("Quantity/serving size (e.g. '1 cup', '200g', '1 plate')"),
    }),
  },
);
