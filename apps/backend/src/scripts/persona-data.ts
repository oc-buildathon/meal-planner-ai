/**
 * Seed data for the two reference personas (Arjun Mehra, Priya Nair).
 *
 * These are NOT real Telegram users. They exist in the DB with
 * `is_persona=1` so:
 *   - They show up in the group-meal participant picker
 *   - When invited to a group meal, the orchestrator auto-generates
 *     their reply from the stored profile below (no real DM is sent)
 *   - The social-planner's `fetch_friend_palette` reads these files
 *     directly out of the SqliteStore
 *
 * Each persona's content below maps 1:1 to a file path inside the
 * SqliteStore namespace `["mealprep-agent", "user", "<dbUserId>"]`.
 */

export interface PersonaSeed {
  /** Stable platform + platformUserId pair for idempotent upsert. */
  platform: "telegram";
  platformUserId: string;
  username: string;
  firstName: string;
  lastName: string;
  languageCode: string;
  /** Per-file memory content to write into this user's namespace. */
  memory: Record<string, string>;
}

// -------------------------------------------------------------------
// P1 — Arjun Mehra (legume-allergic, non-veg forward, Chinese-leaning)
// -------------------------------------------------------------------

const ARJUN_AGENT_MD = `# Agent Notes — Arjun Mehra

## Identity
- Product Manager, 31, Bengaluru
- Bachelor household (cooks for 1)
- Cook: Ramu Bhaiya (Mon–Sat, breakfast+lunch 8–10am, dinner 6–8pm)
- Primary language: Hinglish
- Interface: Telegram voice notes

## Critical Rules
- **LEGUME ALLERGY** (severe): ALL dals — rajma, chhole, moong, masoor, urad,
  kidney beans, lentils, PEANUTS. Never serve, never hide in gravies.
- Khichdi is OFF LIMITS (contains moong dal).
- Any packaged / readymade item MUST be checked for hidden legumes before use.
- Even trace amounts trigger a reaction — the allergy is non-negotiable.

## Cooking Partner
- Ramu Bhaiya is capable: mutton dum biryani, rogan josh, honey garlic chicken,
  chilli paneer, manchurian gravy all 4.5+ stars.
- Give clear Hindi instructions. He appreciates specific feedback.

## Communication Style
- Vocal + specific with feedback ("more amchur", "less spicy", "more gravy")
- Shares Instagram reels and YouTube links for recipe inspiration
- Appreciates when dishes turn out well; explicit when they don't
`;

const ARJUN_TASTE_MD = `# Taste Profile — Arjun Mehra

## Cuisine Preferences
- **Chinese**: HIGH — schezwan, hakka, manchurian, kung pao, honey garlic, chilli paneer
- **Indian**: HIGH — mutton preparations, biryanis, South Indian fish curries
- **Continental**: MEDIUM — eggs benedict-style brunches

## Spice Tolerance
- Medium–HIGH. Wants flavour with some heat, not just burn.

## Salt Preference
- Slightly on the LOW side (noted multiple times).

## Oil Preference
- Moderate. Not excessively oily.

## Favourite Flavour Notes
- Tangy (amchur, lemon, tamarind)
- Chatpata / schezwan-style heat
- Umami (soya sauce, fish sauce, fermented)
- Rich gravies over dry preparations

## Texture Preferences
- Tender slow-cooked meat
- Textural contrast in veg dishes (sev on poha, fried garnish)
- Gravy > dry

## Top Dishes (5/5 — proven favourites)
1. Mutton Biryani (Dum style)
2. Honey Garlic Chicken
3. Surmai Curry (tangy-sweet Kerala-esque)
4. Chilli Paneer (restaurant style)
5. Mutton Do Pyaza

## Strong 4–4.5 Stars
- Mutton Rogan Josh (likes extra gravy)
- Schezwan Chicken (extra schezwan sauce)
- Chicken Manchurian (GRAVY version, not dry)
- Kung Pao Chicken (NO peanuts — swap cashew/omit)
- Homemade Chicken Soup (more ginger)
- Baingan Bharta (medium spice, not high)

## Ingredient Likes
- Chicken (4–5x/week), mutton (1–2x weekend), eggs (daily breakfast),
  fish (1–2x/week — Thursday fish day)
- Paneer, mushrooms, soya sauce, schezwan sauce, fresh ginger-garlic

## Ingredient Dislikes / Avoidances
- ALL LEGUMES (allergy — see diet file)
- Over-peppered dishes
- Bland vegetarian food without tangy/chatpata notes
- Dry preparations of dishes that should be gravy-based

## Boredom Pattern
- Tolerates same rotation ~10 days before asking for variety
- Veg needs faster rotation than non-veg — rotate mushroom pepper fry,
  baingan bharta, chilli paneer, paneer fried rice, aloo gobhi (with amchur)
`;

const ARJUN_DIET_MD = `# Active Diet Plan — Arjun Mehra

## Current Plan
- Type: No-legume, high-protein, slightly reduced carbs (per doctor)
- Pattern: 5–6 non-veg days, 1–2 veg rotation days
- Cheat day: Saturday (mutton biryani / do pyaza / rogan josh)

## Restrictions
- **Allergies — CRITICAL**:
  - ALL legumes: dal (any), rajma, chhole, moong, masoor, urad, kidney beans,
    lentils, peanuts, hummus, any dal-based gravy
  - Any packaged / readymade soup — must verify ingredients first
- **Medical**: none reported
- **Religious**: none

## Safe Protein Options
- Chicken (breast, thigh, whole)
- Mutton (curry cut, keema)
- Eggs (whole + whites)
- Fish (pomfret, surmai)
- Paneer, tofu, mushrooms

## NEVER serve
- Khichdi (moong dal base)
- Pesarattu (moong dal crepe)
- Kung Pao with peanuts
- Pad Thai with peanuts
- Poha with peanut garnish (use sev instead)

## Weekly Template (flexible)
- Mon: Grilled chicken + greens
- Tue: Egg whites / Fish curry
- Wed: Chicken tikka / Mushroom stir fry
- Thu: Fish day (Surmai OR Pomfret, alternating)
- Fri: Scrambled eggs + Mutton keema
- Sat: Cheat day — Mutton biryani / do pyaza
- Sun: Light — chicken soup or eggs benedict
`;

const ARJUN_FEEDBACK_MD = `# Meal Feedback Log — Arjun Mehra

## 5/5 FAVOURITES (proven)
- Mutton Biryani Dum — "best biryani ever"
- Honey Garlic Chicken — "10/10 regular dish"
- Surmai Curry — "tangy-sweet perfect"
- Chilli Paneer — "restaurant jaisa"
- Mutton Do Pyaza — "INSANE, chef's kiss"

## 4 – 4.5 / 5 (strong)
- Mutton Rogan Josh (increase gravy)
- Schezwan Chicken (more schezwan sauce)
- Chicken Manchurian (gravy version, not dry)
- Kung Pao Chicken (without peanuts)
- Homemade Chicken Soup (more ginger)
- Baingan Bharta (medium spice only)

## 3 – 3.5 (needs work)
- Aloo Gobhi — needs more masala + amchur
- Plain Poha — boring, add sev + lemon, NO peanuts

## Incidents
- Week 8 Day 52: allergic reaction from pre-packaged soup.
  Rule added: ALL readymade items must be verified.
`;

// -------------------------------------------------------------------
// P2 — Priya Nair (lactose-intolerant, veg-forward, Indian/South Indian)
// -------------------------------------------------------------------

const PRIYA_AGENT_MD = `# Agent Notes — Priya Nair

## Identity
- UX Designer, 28, Mumbai
- Shares flat with flatmate (separate preferences, not tracked here)
- Cook: Sunita Didi (Mon–Sat, breakfast+lunch 8–9:30am, dinner 6:30–8pm)
- Primary language: Hinglish
- Interface: Telegram voice notes + occasional text

## Critical Rules
- **DAIRY allergy / lactose intolerance** (moderate–severe): NO milk, paneer,
  cream, butter, ghee, dahi, cheese. Causes stomach upset. Strict.
- **No non-veg on Monday AND Saturday** — religious/personal, strict.
- No readymade items without ingredient verification (hidden dairy risk).

## Dairy Substitution Map (essential knowledge)
- butter / ghee → coconut oil
- cream → coconut milk OR coconut cream + cashew paste
- dahi / yogurt → coconut yogurt
- milk (drinks) → oat milk
- milk (cooking) → coconut milk
- paneer → tofu

## Cooking Partner
- Sunita Didi is learning — strong on Indian basics, getting good at
  Thai/South Indian, learned dum biryani technique.
- Occasional dairy slip-ups in the past (butter in rajma, dahi in chutney).
  Re-verify dairy-free when any new recipe is tried.

## Communication Style
- Warm, expressive feedback with specific flavour notes
- Shares Instagram reels + YouTube links, usually asks for dairy-free versions
`;

const PRIYA_TASTE_MD = `# Taste Profile — Priya Nair

## Cuisine Preferences
- **South Indian**: VERY HIGH — dosa, idli, sambar, rasam, meen curry, bisi bele bath, pongal
- **North Indian (modified)**: HIGH — dal tadka, dairy-free butter chicken, vegetable biryani
- **Thai**: HIGH — green curry, pad kra pao, fish dishes
- **Continental (healthy)**: MEDIUM — grain bowls, avocado toast, smoothie bowls

## Spice Tolerance
- Medium. Subtle layered flavour preferred over raw heat.

## Salt Preference
- Normal.

## Oil Preference
- LOW–medium. Health-conscious.

## Favourite Flavour Notes
- Tangy (tamarind, lemon, kokum)
- Coconut-forward (milk, cream, oil)
- Subtle and layered, not one-note
- Light and clean

## Texture Preferences
- Soft + comforting (khichdi, pongal, idli, rasam)
- Crispy base with soft topping (dosa, uttapam)
- Rich creamy gravies (coconut-based, not dairy)

## Top Dishes (5/5)
1. Kerala Chicken Curry
2. Thai Green Curry
3. Dairy-free Butter Chicken (coconut milk + cashew version)
4. Rasam
5. Pongal (coconut oil version, not ghee)
6. Kerala Meen Curry
7. Dairy-free Dal Makhani (coconut cream version)
8. Uttapam with aloo topping (fusion)
9. Coconut Mango Lassi

## Non-Veg Pattern
- Chicken: 1–2x per week — ONLY Tuesday, Wednesday, Thursday, Friday
- Fish: 1–2x per month (Kerala-style preferred)
- Eggs: occasional, not preferred
- NEVER on: Monday, Saturday

## Ingredient Likes
- Coconut milk / cream / oil (universal dairy substitute)
- Curry leaves, tamarind, drumstick (sahjan — essential in sambar)
- Tofu, chickpeas (ok — not dairy), mushrooms, avocado
- Oat milk for chai

## Ingredient Dislikes / Avoidances
- ALL dairy (see diet file)
- Heavy cream-based gravies (butter chicken, shahi korma — unless dairy-free version)
- Anything with hidden ghee/butter finish

## Boredom Pattern
- Loves depth within a cuisine rather than wide variety
- Happy with weekly sambar/rasam rotation
`;

const PRIYA_DIET_MD = `# Active Diet Plan — Priya Nair

## Current Plan
- Type: Dairy-free, veg-forward with occasional chicken/fish
- Weight-watching (week 6 onward): low-medium oil, more roasted/stir-fry veggies
- Weekly pattern: 2 non-veg days max (Tue–Fri), rest veg

## Restrictions
- **Allergies — CRITICAL**:
  - ALL dairy: milk, cream, butter, ghee, paneer, dahi, cheese, malai
  - Any readymade item without ingredient verification
- **Strict rule — no non-veg on**:
  - Monday (religious / personal)
  - Saturday (religious / personal)
- **Medical**: none reported

## Universal Dairy Substitutions
- butter / ghee → coconut oil
- cream → coconut milk + cashew paste (for rich gravies) OR coconut cream
- dahi / yogurt → coconut yogurt (marinades + drinks)
- milk (tea) → oat milk
- milk (cooking) → coconut milk
- paneer → tofu

## Weekly Template (flexible)
- Mon: VEG. South Indian breakfast + dal tadka (oil, NO butter) + roti
- Tue: Non-veg OK. Kerala chicken curry / grilled chicken
- Wed: Veg or non-veg. Dosa / sambar / chilli paneer-style with tofu
- Thu: Fish day if wanted (Kerala meen curry). Otherwise Thai green curry
- Fri: Chicken OK. Coconut yogurt marinade chicken is a hit
- Sat: VEG. Special weekend — biryani, dal makhani (dairy-free), pongal
- Sun: Light — khichdi (moong dal — safe for this user), smoothie bowls
`;

const PRIYA_FEEDBACK_MD = `# Meal Feedback Log — Priya Nair

## 5/5 FAVOURITES
- Kerala Chicken Curry (coconut milk)
- Thai Green Curry
- Dairy-free Butter Chicken (coconut milk + cashew)
- Rasam
- Pongal (coconut oil version)
- Kerala Meen Curry
- Dairy-free Dal Makhani (coconut cream)
- Uttapam with aloo topping (fusion)
- Coconut Yogurt Marinade Chicken
- Coconut Mango Lassi

## Incidents
- Week 1 Day 6: Sunita added butter to rajma — stomach issue. Rule reinforced.
- Week 3 Day 17: dahi in coconut chutney — flagged. All chutneys must be dairy-free.
- Week 8 Day 54: cook offered to buy paneer — caught and redirected to tofu.

## Journey
- Sambar improvement curve: 3/5 → 3.5/5 → 5/5 over 6 weeks (tamarind + drumstick)
- Bisi Bele Bath first try: 5/5 with ghee→coconut oil swap
`;

// -------------------------------------------------------------------
// Export — the full seed registry.
// -------------------------------------------------------------------

export const PERSONA_SEEDS: PersonaSeed[] = [
  {
    platform: "telegram",
    platformUserId: "persona_arjun_mehra",
    username: "arjun_mehra",
    firstName: "Arjun",
    lastName: "Mehra",
    languageCode: "hi",
    memory: {
      "/memories/AGENT.md": ARJUN_AGENT_MD,
      "/taste/profile.md": ARJUN_TASTE_MD,
      "/diet/active-plan.md": ARJUN_DIET_MD,
      "/taste/feedback-log.md": ARJUN_FEEDBACK_MD,
    },
  },
  {
    platform: "telegram",
    platformUserId: "persona_priya_nair",
    username: "priya_nair",
    firstName: "Priya",
    lastName: "Nair",
    languageCode: "hi",
    memory: {
      "/memories/AGENT.md": PRIYA_AGENT_MD,
      "/taste/profile.md": PRIYA_TASTE_MD,
      "/diet/active-plan.md": PRIYA_DIET_MD,
      "/taste/feedback-log.md": PRIYA_FEEDBACK_MD,
    },
  },
];
