/**
 * Stress-test image generation with long prompts, multiple prompt patterns,
 * character boundaries, deduplication, and error validation (Linear HYD-51).
 *
 * Run with:
 *   npm run test:image-prompts
 */

import dotenv from "dotenv";
dotenv.config();

import {
  MAX_IMAGE_PROMPT_LENGTH,
  MIN_IMAGE_PROMPT_LENGTH,
  validateImagePrompt,
} from "../src/services/imageProviders/config.js";
import {
  combineWithSuffix,
  HYDRILLA_3D_ASSET_MODE_SUFFIX,
} from "../src/services/imageProviders/rewriter.js";
import {
  runDeduplicatedImageJob,
  clearInFlightImageJobsForTesting,
} from "../src/services/imageProviders/inFlight.js";
import {
  generateImage,
} from "../src/services/imageProviders/index.js";
import {
  buildOpenAIGenerateBody,
} from "../src/services/imageProviders/openai.js";
import {
  buildGeminiBody,
  buildVertexGeminiBody,
} from "../src/services/imageProviders/gemini.js";

const state = {
  passed: 0,
  failed: 0,
  failures: [] as string[],
};

function assert(description: string, condition: boolean): void {
  if (condition) {
    state.passed++;
    console.log(`  [PASS] ${description}`);
  } else {
    state.failed++;
    state.failures.push(description);
    console.error(`  [FAIL] ${description}`);
  }
}

async function runTests(): Promise<void> {
  console.log("\n=======================================================");
  console.log("  HYD-51: Long Prompts & Multiple Prompt Stress Tests  ");
  console.log("=======================================================\n");

  // ──────────────────────────────────────────────────────────
  // 1. EMPTY AND NEAR-EMPTY PROMPT VALIDATION
  // ──────────────────────────────────────────────────────────
  console.log("Section 1: Empty & Near-Empty Prompt Validation");

  const emptyResult = validateImagePrompt("");
  assert("Empty string rejected", !emptyResult.ok && emptyResult.code === "PROMPT_REQUIRED");

  const whitespaceResult = validateImagePrompt("   \n\t  \r  ");
  assert("Whitespace only rejected", !whitespaceResult.ok && whitespaceResult.code === "PROMPT_REQUIRED");

  const singleCharResult = validateImagePrompt("a");
  assert("Single character 'a' rejected", !singleCharResult.ok && singleCharResult.code === "PROMPT_TOO_SHORT");

  const dotResult = validateImagePrompt(".");
  assert("Single period '.' rejected", !dotResult.ok && dotResult.code === "PROMPT_TOO_SHORT");

  const spacesWithDot = validateImagePrompt("   .   ");
  assert("Padded period '   .   ' rejected as too short", !spacesWithDot.ok && spacesWithDot.code === "PROMPT_TOO_SHORT");

  const minValid = validateImagePrompt("ox");
  assert("2-character prompt 'ox' accepted", minValid.ok && minValid.prompt === "ox");

  const nullResult = validateImagePrompt(null);
  assert("null rejected as required", !nullResult.ok && nullResult.code === "PROMPT_REQUIRED");

  const undefinedResult = validateImagePrompt(undefined);
  assert("undefined rejected as required", !undefinedResult.ok && undefinedResult.code === "PROMPT_REQUIRED");

  // ──────────────────────────────────────────────────────────
  // 2. SHORT PROMPTS
  // ──────────────────────────────────────────────────────────
  console.log("\nSection 2: Short Prompts");

  const shortPrompts = [
    "red vintage sports car",
    "wooden dining chair",
    "medieval knight helmet",
    "porcelain tea cup",
  ];

  for (const p of shortPrompts) {
    const res = validateImagePrompt(p);
    assert(`Short prompt '${p}' accepted`, res.ok && res.prompt === p);
    const combined = combineWithSuffix(p);
    assert(
      `Short prompt '${p}' combines suffix and stays under max limit`,
      combined.includes(p) && combined.length <= MAX_IMAGE_PROMPT_LENGTH
    );
  }

  // ──────────────────────────────────────────────────────────
  // 3. LONG DESCRIPTIVE PROMPTS
  // ──────────────────────────────────────────────────────────
  console.log("\nSection 3: Long Descriptive Prompts (400 - 800 chars)");

  const longDescriptivePrompt =
    "A highly detailed sci-fi robotic reconnaissance rover with four heavy-duty treaded wheels, " +
    "titanium alloy chassis, matte olive-drab and dark slate armor plating with subtle edge wear, " +
    "an articulated sensor mast equipped with dual optical lenses and an infrared emitter, " +
    "side-mounted modular battery packs with warning hazard stripes, exposed cabling in flexible industrial conduit, " +
    "a compact solar panel array folded across the upper deck, weathered metallic finishes, clean diffuse studio lighting, " +
    "isolated on a neutral background, three-quarter perspective angle revealing form.";

  const longRes = validateImagePrompt(longDescriptivePrompt);
  assert(
    `Long descriptive prompt (~${longDescriptivePrompt.length} chars) accepted`,
    longRes.ok && longRes.prompt === longDescriptivePrompt
  );

  const longCombined = combineWithSuffix(longDescriptivePrompt);
  assert(
    "Long descriptive prompt combined with 3D engine suffix under limit",
    longCombined.length <= MAX_IMAGE_PROMPT_LENGTH && longCombined.includes(HYDRILLA_3D_ASSET_MODE_SUFFIX)
  );

  // ──────────────────────────────────────────────────────────
  // 4. VERY LONG PROMPTS NEAR SUPPORTED LIMITS & OVER-LIMIT
  // ──────────────────────────────────────────────────────────
  console.log("\nSection 4: Very Long Prompts Near Supported Limits & Over-Limit");

  // Exactly at boundary
  const exactMaxPrompt = "A".repeat(MAX_IMAGE_PROMPT_LENGTH);
  const exactMaxRes = validateImagePrompt(exactMaxPrompt);
  assert(`Prompt of exactly ${MAX_IMAGE_PROMPT_LENGTH} chars accepted`, exactMaxRes.ok);

  const exactCombined = combineWithSuffix(exactMaxPrompt);
  assert(
    `Prompt of exactly ${MAX_IMAGE_PROMPT_LENGTH} chars does NOT exceed limit after combineWithSuffix`,
    exactCombined.length <= MAX_IMAGE_PROMPT_LENGTH
  );

  // Near limit (3,800 chars)
  const nearLimitPrompt = "Detailed cyberpunk drone ".repeat(152).slice(0, 3800);
  const nearLimitRes = validateImagePrompt(nearLimitPrompt);
  assert("Prompt of 3,800 chars accepted", nearLimitRes.ok);

  const nearLimitCombined = combineWithSuffix(nearLimitPrompt);
  assert(
    "Prompt of 3,800 chars combined with suffix clamped to <= 4000 chars without crash",
    nearLimitCombined.length <= MAX_IMAGE_PROMPT_LENGTH && nearLimitCombined.startsWith(nearLimitPrompt)
  );

  // Over limit (4,001 chars)
  const overLimitPrompt = "B".repeat(MAX_IMAGE_PROMPT_LENGTH + 1);
  const overLimitRes = validateImagePrompt(overLimitPrompt);
  assert(
    `Prompt of ${MAX_IMAGE_PROMPT_LENGTH + 1} chars rejected with PROMPT_TOO_LONG`,
    !overLimitRes.ok && overLimitRes.code === "PROMPT_TOO_LONG"
  );
  assert(
    "Over-limit error message mentions supported limit",
    !overLimitRes.ok && overLimitRes.error.includes(String(MAX_IMAGE_PROMPT_LENGTH))
  );

  // Far over limit (10,000 chars)
  const farOverLimitPrompt = "C".repeat(10_000);
  const farOverRes = validateImagePrompt(farOverLimitPrompt);
  assert("Prompt of 10,000 chars rejected gracefully", !farOverRes.ok && farOverRes.code === "PROMPT_TOO_LONG");

  // ──────────────────────────────────────────────────────────
  // 5. SPECIAL CHARACTERS & MULTILINE PROMPTS
  // ──────────────────────────────────────────────────────────
  console.log("\nSection 5: Special Characters & Multiline Prompts");

  const complexMultilinePrompt = [
    "Subject: Cyberpunk Mech Warrior 🤖",
    "Materials: Titanium, brushed carbon-fiber & obsidian glass [Ref #42]",
    "Lighting: Studio diffuse lighting @ 5600K; subtle rim-light (cyan/magenta)",
    "Punctuation & symbols: <ultra-realistic>, \"high-poly\", 'clean edges', 100% scratch-resistant!",
    "International text: 侍 (Samurai) · Héros blindé · Рыцарь будущего",
    "Math & slashes: A/B ratio 1:1, angle = 45°, scale ~ 1.8m ± 0.05m",
  ].join("\n");

  const multilineRes = validateImagePrompt(complexMultilinePrompt);
  assert("Complex multiline prompt with unicode, quotes, and symbols accepted", multilineRes.ok);

  const openAIBody = buildOpenAIGenerateBody(complexMultilinePrompt, "low", "1:1");
  const openAIJson = JSON.stringify(openAIBody);
  const openAIParsed = JSON.parse(openAIJson);
  assert(
    "Multiline prompt serializes into valid JSON for OpenAI without truncation or corruption",
    openAIParsed.prompt === complexMultilinePrompt
  );

  const geminiBody = buildGeminiBody(complexMultilinePrompt, "low", "1:1");
  const geminiJson = JSON.stringify(geminiBody);
  const geminiParsed = JSON.parse(geminiJson);
  assert(
    "Multiline prompt serializes into valid JSON for Gemini without truncation or corruption",
    geminiParsed.input[0].text === complexMultilinePrompt
  );

  const vertexBody = buildVertexGeminiBody(complexMultilinePrompt, "low", "1:1");
  const vertexJson = JSON.stringify(vertexBody);
  const vertexParsed = JSON.parse(vertexJson);
  assert(
    "Multiline prompt serializes into valid JSON for Vertex Gemini without corruption",
    vertexParsed.contents[0].parts.some((p: any) => p.text === complexMultilinePrompt)
  );

  // ──────────────────────────────────────────────────────────
  // 6. RAPID REPEATED SUBMISSIONS (DEDUPLICATION & IN-FLIGHT)
  // ──────────────────────────────────────────────────────────
  console.log("\nSection 6: Rapid Repeated Submissions (Deduplication)");

  clearInFlightImageJobsForTesting();

  const mockExecutionState = {
    runsCount: 0,
  };

  const concurrentPrompt = "futuristic stealth fighter jet with angled wings";

  // Simulate 5 rapid simultaneous submissions from the same user with identical prompt
  const rapidRequests = Array.from({ length: 5 }, (_, index) =>
    runDeduplicatedImageJob(
      "user_stress_test_1",
      "text-to-image",
      concurrentPrompt,
      "openai",
      "low",
      "1:1",
      async () => {
        mockExecutionState.runsCount++;
        // Simulate network / provider latency
        await new Promise((r) => setTimeout(r, 60));
        return {
          job_id: "job_single_dedup_123",
          image_url: "https://hydrilla-outputs.s3.amazonaws.com/test.png",
          credits_used: 2,
        };
      }
    )
  );

  const results = await Promise.all(rapidRequests);

  assert("Executor executed exactly ONCE for 5 rapid identical requests", mockExecutionState.runsCount === 1);

  const allHaveSameJobId = results.every((r) => r.result.job_id === "job_single_dedup_123");
  assert("All 5 callers received identical completed payload", allHaveSameJobId);

  const reusedCount = results.filter((r) => r.reusedInFlight).length;
  const originalCount = results.filter((r) => !r.reusedInFlight).length;
  assert("Exactly 1 request was original and 4 were deduplicated in-flight", originalCount === 1 && reusedCount === 4);

  // ──────────────────────────────────────────────────────────
  // 7. MULTIPLE PROMPTS SUBMITTED SEQUENTIALLY
  // ──────────────────────────────────────────────────────────
  console.log("\nSection 7: Multiple Prompts Submitted Sequentially");

  clearInFlightImageJobsForTesting();

  const seqState = {
    runs: [] as string[],
  };

  const seqPrompts = [
    "ancient obsidian obelisk with glowing glyphs",
    "steampunk pocket watch with brass gears",
    "crystal potion bottle with glowing elixir",
  ];

  for (const prompt of seqPrompts) {
    const outcome = await runDeduplicatedImageJob(
      "user_stress_test_1",
      "text-to-image",
      prompt,
      "openai",
      "low",
      "1:1",
      async () => {
        seqState.runs.push(prompt);
        await new Promise((r) => setTimeout(r, 10));
        return { prompt, job_id: `job_${Math.random()}` };
      }
    );
    assert(`Sequential prompt '${prompt.slice(0, 30)}...' completed independently`, !outcome.reusedInFlight);
  }

  assert("All 3 sequential prompts executed independently", seqState.runs.length === 3);

  // ──────────────────────────────────────────────────────────
  // 8. REPEATED GENERATION WITH SIMILAR PROMPTS
  // ──────────────────────────────────────────────────────────
  console.log("\nSection 8: Repeated Generation with Similar Prompts");

  clearInFlightImageJobsForTesting();

  const similarPrompts = [
    "mythical dragon in ruby dragonscale armor",
    "mythical dragon in sapphire dragonscale armor",
    "mythical dragon in emerald dragonscale armor",
  ];

  const similarRunState = {
    ranPrompts: [] as string[],
  };

  const similarOutcomes = await Promise.all(
    similarPrompts.map((p) =>
      runDeduplicatedImageJob(
        "user_stress_test_1",
        "text-to-image",
        p,
        "openai",
        "low",
        "1:1",
        async () => {
          similarRunState.ranPrompts.push(p);
          await new Promise((r) => setTimeout(r, 20));
          return { prompt: p, id: `job_${p.slice(0, 10)}` };
        }
      )
    )
  );

  assert(
    "Similar prompts each executed independently with distinct keys",
    similarOutcomes.every((o) => !o.reusedInFlight) && similarRunState.ranPrompts.length === 3
  );

  // ──────────────────────────────────────────────────────────
  // 9. CONCURRENT SUBMISSIONS FROM DIFFERENT USERS
  // ──────────────────────────────────────────────────────────
  console.log("\nSection 9: Concurrent Identical Prompts from Different Users");

  clearInFlightImageJobsForTesting();

  const multiUserRuns = { count: 0 };
  const sharedPrompt = "golden chalice with inlaid pearls";

  const user1Promise = runDeduplicatedImageJob(
    "user_alpha",
    "text-to-image",
    sharedPrompt,
    "openai",
    "low",
    "1:1",
    async () => {
      multiUserRuns.count++;
      await new Promise((r) => setTimeout(r, 20));
      return { user: "alpha" };
    }
  );

  const user2Promise = runDeduplicatedImageJob(
    "user_beta",
    "text-to-image",
    sharedPrompt,
    "openai",
    "low",
    "1:1",
    async () => {
      multiUserRuns.count++;
      await new Promise((r) => setTimeout(r, 20));
      return { user: "beta" };
    }
  );

  const multiUserResults = await Promise.all([user1Promise, user2Promise]);
  assert(
    "Different users submitting identical prompts execute independently (no cross-user leak)",
    multiUserRuns.count === 2 &&
      !multiUserResults[0].reusedInFlight &&
      !multiUserResults[1].reusedInFlight
  );

  // ──────────────────────────────────────────────────────────
  // 10. OPTIONAL LIVE PROVIDER STRESS TEST (--live flag)
  // ──────────────────────────────────────────────────────────
  if (process.argv.includes("--live")) {
    console.log("\nSection 10: Live Provider Generation (--live)");

    try {
      console.log("  Testing live OpenAI with short prompt...");
      const liveShortStart = Date.now();
      const liveShort = await generateImage({
        provider: "openai",
        quality: "low",
        aspect: "1:1",
        prompt: "ancient bronze coin with dragon emblem",
      });
      assert(
        `Live OpenAI generation returned image (${liveShort.bytes.length} bytes, ${Date.now() - liveShortStart}ms)`,
        liveShort.bytes.length > 1000 && liveShort.mime.startsWith("image/")
      );

      console.log("  Testing live OpenAI with multiline & special character prompt...");
      const liveMultiStart = Date.now();
      const liveMulti = await generateImage({
        provider: "openai",
        quality: "low",
        aspect: "1:1",
        prompt: "sci-fi crate [Ref #88]\nMaterial: matte titanium & yellow warning stripes ⚠️\nLighting: studio neutral",
      });
      assert(
        `Live OpenAI multiline/special-char generation returned image (${liveMulti.bytes.length} bytes, ${Date.now() - liveMultiStart}ms)`,
        liveMulti.bytes.length > 1000 && liveMulti.mime.startsWith("image/")
      );
    } catch (liveErr: any) {
      assert(`Live test completed without unexpected error: ${liveErr?.message}`, false);
    }
  }

  // ──────────────────────────────────────────────────────────
  // SUMMARY
  // ──────────────────────────────────────────────────────────
  console.log("\n=======================================================");
  console.log(`  Results: ${state.passed} Passed, ${state.failed} Failed`);
  console.log("=======================================================\n");

  if (state.failed > 0) {
    console.error("Failures:", state.failures);
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test runner crashed:", err);
  process.exit(1);
});
