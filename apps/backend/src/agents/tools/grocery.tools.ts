import { tool } from "@langchain/core/tools";
import { z } from "zod";

/**
 * Grocery ordering tools — stubs for Phase 4.
 * Will integrate with Zepto and Blinkit APIs.
 */

export const searchZepto = tool(
  async ({ query, category }: { query: string; category?: string }) => {
    // Phase 4: Will use Zepto REST API / headless browser
    return JSON.stringify({
      status: "stub",
      provider: "zepto",
      query,
      category,
      message: `Zepto search coming in Phase 4. Query: "${query}". For now, provide a general ingredient list that can be ordered manually.`,
      results: [],
    });
  },
  {
    name: "search_zepto",
    description:
      "Search for grocery items on Zepto. Returns product name, price, availability, and quantity options.",
    schema: z.object({
      query: z.string().describe("Search query (e.g. 'paneer 200g')"),
      category: z
        .string()
        .optional()
        .describe("Product category filter (e.g. 'dairy', 'vegetables')"),
    }),
  },
);

export const searchBlinkit = tool(
  async ({ query, category }: { query: string; category?: string }) => {
    // Phase 4: Will use Blinkit REST API / headless browser
    return JSON.stringify({
      status: "stub",
      provider: "blinkit",
      query,
      category,
      message: `Blinkit search coming in Phase 4. Query: "${query}". Fallback provider when Zepto items are unavailable.`,
      results: [],
    });
  },
  {
    name: "search_blinkit",
    description:
      "Search for grocery items on Blinkit (fallback provider). Use when items are unavailable on Zepto.",
    schema: z.object({
      query: z.string().describe("Search query (e.g. 'basmati rice 1kg')"),
      category: z
        .string()
        .optional()
        .describe("Product category filter"),
    }),
  },
);

export const placeOrder = tool(
  async ({
    provider,
    items,
    deliveryNotes,
  }: {
    provider: string;
    items: Array<{ name: string; quantity: string; estimatedPrice?: number }>;
    deliveryNotes?: string;
  }) => {
    const totalEstimate = items.reduce(
      (sum, item) => sum + (item.estimatedPrice ?? 0),
      0,
    );
    return JSON.stringify({
      status: "stub",
      provider,
      itemCount: items.length,
      estimatedTotal: totalEstimate,
      message: `Order placement coming in Phase 4. ${items.length} items on ${provider}, estimated total: Rs.${totalEstimate}. This action requires human approval before execution.`,
    });
  },
  {
    name: "place_order",
    description:
      "Place a grocery order on Zepto or Blinkit. THIS REQUIRES HUMAN APPROVAL. Always show the full item list and estimated total before placing.",
    schema: z.object({
      provider: z
        .enum(["zepto", "blinkit"])
        .describe("Which grocery provider to order from"),
      items: z
        .array(
          z.object({
            name: z.string().describe("Product name"),
            quantity: z.string().describe("Quantity to order"),
            estimatedPrice: z
              .number()
              .optional()
              .describe("Estimated price in INR"),
          }),
        )
        .describe("Items to order"),
      deliveryNotes: z
        .string()
        .optional()
        .describe("Special delivery instructions"),
    }),
  },
);

export const trackOrder = tool(
  async ({ orderId, provider }: { orderId: string; provider: string }) => {
    return JSON.stringify({
      status: "stub",
      orderId,
      provider,
      message: `Order tracking coming in Phase 4. Order ${orderId} on ${provider}.`,
    });
  },
  {
    name: "track_order",
    description:
      "Track the status of an existing grocery order (estimated delivery time, current status).",
    schema: z.object({
      orderId: z.string().describe("The order ID to track"),
      provider: z
        .enum(["zepto", "blinkit"])
        .describe("Which provider the order was placed on"),
    }),
  },
);
