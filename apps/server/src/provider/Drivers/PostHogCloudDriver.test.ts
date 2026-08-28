import { assert, describe, it } from "@effect/vitest";

import type { PostHogCloudModel } from "@t3tools/contracts";

import { posthogCloudCatalogueModels, posthogGatewayOnlyModels } from "./PostHogCloudDriver.ts";

const model = (
  overrides: Partial<PostHogCloudModel> & Pick<PostHogCloudModel, "model" | "runtime_adapter">,
): PostHogCloudModel => ({
  display_name: overrides.model,
  supported_efforts: [],
  ...overrides,
});

describe("posthogCloudCatalogueModels", () => {
  it("orders Anthropic families fable, opus, sonnet, haiku", () => {
    const catalogue = posthogCloudCatalogueModels([
      model({ model: "claude-haiku-4-5", runtime_adapter: "claude" }),
      model({ model: "claude-sonnet-5", runtime_adapter: "claude" }),
      model({ model: "claude-fable-5", runtime_adapter: "claude" }),
      model({ model: "claude-opus-5", runtime_adapter: "claude" }),
    ]);
    assert.deepStrictEqual(
      catalogue.map((entry) => entry.slug),
      [
        "claude:claude-fable-5",
        "claude:claude-opus-5",
        "claude:claude-sonnet-5",
        "claude:claude-haiku-4-5",
      ],
    );
  });

  it("puts the newest version first inside a family", () => {
    const catalogue = posthogCloudCatalogueModels([
      model({ model: "claude-opus-4-6", runtime_adapter: "claude" }),
      model({ model: "claude-opus-5", runtime_adapter: "claude" }),
      model({ model: "claude-opus-4-8", runtime_adapter: "claude" }),
    ]);
    assert.deepStrictEqual(
      catalogue.map((entry) => entry.slug),
      ["claude:claude-opus-5", "claude:claude-opus-4-8", "claude:claude-opus-4-6"],
    );
  });

  it("ranks models outside the Anthropic families last, newest first", () => {
    const catalogue = posthogCloudCatalogueModels([
      model({ model: "gpt-5.5", runtime_adapter: "codex" }),
      model({ model: "claude-haiku-4-5", runtime_adapter: "claude" }),
      model({ model: "gpt-5.6-sol", runtime_adapter: "codex" }),
    ]);
    assert.deepStrictEqual(
      catalogue.map((entry) => entry.slug),
      ["claude:claude-haiku-4-5", "codex:gpt-5.6-sol", "codex:gpt-5.5"],
    );
  });

  it("folds superseded models away without dropping them", () => {
    const catalogue = posthogCloudCatalogueModels([
      model({ model: "claude-opus-5", runtime_adapter: "claude" }),
      model({ model: "claude-opus-4-8", runtime_adapter: "claude" }),
      model({ model: "gpt-5.4", runtime_adapter: "codex" }),
    ]);
    assert.deepStrictEqual(
      catalogue.map((entry) => [entry.slug, entry.isLegacy ?? false]),
      [
        ["claude:claude-opus-5", false],
        ["claude:claude-opus-4-8", true],
        ["codex:gpt-5.4", true],
      ],
    );
  });

  it("defaults to the first model still on offer, not a superseded one above it", () => {
    const catalogue = posthogCloudCatalogueModels([
      model({ model: "claude-opus-4-8", runtime_adapter: "claude" }),
      model({ model: "claude-sonnet-5", runtime_adapter: "claude" }),
    ]);
    assert.strictEqual(catalogue[0]?.slug, "claude:claude-opus-4-8");
    assert.strictEqual(catalogue.find((entry) => entry.isDefault)?.slug, "claude:claude-sonnet-5");
  });

  it("still names a default when every model on offer is superseded", () => {
    const catalogue = posthogCloudCatalogueModels([
      model({ model: "gpt-5.4", runtime_adapter: "codex" }),
      model({ model: "gpt-5.5", runtime_adapter: "codex" }),
    ]);
    assert.strictEqual(catalogue.find((entry) => entry.isDefault)?.slug, "codex:gpt-5.5");
  });

  it("labels each model with the driver that authors it", () => {
    const catalogue = posthogCloudCatalogueModels([
      model({ model: "gpt-5.6-sol", runtime_adapter: "codex", display_name: "GPT-5.6 Sol" }),
      model({ model: "claude-opus-5", runtime_adapter: "claude", display_name: "Claude Opus 5" }),
    ]);
    const byName = (name: string) => {
      const entry = catalogue.find((candidate) => candidate.name === name);
      return [entry?.subProvider, entry?.subProviderDriverKind];
    };
    assert.deepStrictEqual(byName("GPT-5.6 Sol"), ["Codex", "codex"]);
    assert.deepStrictEqual(byName("Claude Opus 5"), ["Claude", "claudeAgent"]);
  });

  it("carries the efforts a model accepts, and none when it has no effort control", () => {
    const catalogue = posthogCloudCatalogueModels([
      model({
        model: "gpt-5.6-sol",
        runtime_adapter: "codex",
        supported_efforts: ["low", "medium", "high"],
      }),
      model({ model: "claude-haiku-4-5", runtime_adapter: "claude" }),
    ]);
    const withEfforts = catalogue.find((entry) => entry.slug === "codex:gpt-5.6-sol");
    const without = catalogue.find((entry) => entry.slug === "claude:claude-haiku-4-5");
    const descriptor = withEfforts?.capabilities?.optionDescriptors?.[0];
    assert.strictEqual(descriptor?.id, "reasoningEffort");
    assert.deepStrictEqual(
      descriptor?.type === "select"
        ? descriptor.options.map((option) => [option.id, option.isDefault ?? false])
        : null,
      [
        ["low", true],
        ["medium", false],
        ["high", false],
      ],
    );
    assert.strictEqual(without?.capabilities, null);
  });

  it("has nothing to offer when the catalogue is empty", () => {
    assert.deepStrictEqual(posthogCloudCatalogueModels([]), []);
  });
});

describe("posthogGatewayOnlyModels", () => {
  const taskCatalogue = [model({ model: "claude-opus-5", runtime_adapter: "claude" })];

  it("adds the open-source models the task API cannot report, on the Claude harness", () => {
    assert.deepStrictEqual(
      posthogGatewayOnlyModels(
        [
          { id: "@cf/zai-org/glm-5.2", owned_by: "cloudflare" },
          { id: "moonshotai/kimi-k3", owned_by: "modal" },
          { id: "deepseek-ai/deepseek-v4-flash", owned_by: "baseten" },
        ],
        taskCatalogue,
      ),
      [
        {
          runtime_adapter: "claude",
          model: "@cf/zai-org/glm-5.2",
          display_name: "GLM-5.2",
          supported_efforts: [],
        },
        {
          runtime_adapter: "claude",
          model: "moonshotai/kimi-k3",
          display_name: "Kimi K3",
          supported_efforts: [],
        },
        {
          runtime_adapter: "claude",
          model: "deepseek-ai/deepseek-v4-flash",
          display_name: "Deepseek V4 Flash",
          supported_efforts: [],
        },
      ],
    );
  });

  it("skips whatever the task catalogue already offered", () => {
    assert.deepStrictEqual(
      posthogGatewayOnlyModels([{ id: "claude-opus-5", owned_by: "anthropic" }], taskCatalogue),
      [],
    );
  });

  it("keeps an open-source model on the Claude harness even when labelled openai", () => {
    assert.deepStrictEqual(
      posthogGatewayOnlyModels(
        [{ id: "moonshotai/kimi-k3", owned_by: "openai" }],
        taskCatalogue,
      ).map((entry) => [entry.model, entry.runtime_adapter]),
      [["moonshotai/kimi-k3", "claude"]],
    );
  });

  it("files a genuinely new OpenAI model under codex", () => {
    assert.deepStrictEqual(
      posthogGatewayOnlyModels([{ id: "gpt-6", owned_by: "openai" }], taskCatalogue).map(
        (entry) => [entry.model, entry.runtime_adapter],
      ),
      [["gpt-6", "codex"]],
    );
  });

  it("drops a model the caller's plan disallows", () => {
    assert.deepStrictEqual(
      posthogGatewayOnlyModels(
        [{ id: "@cf/zai-org/glm-5.2", owned_by: "cloudflare", allowed: false }],
        taskCatalogue,
      ),
      [],
    );
  });

  it("never duplicates a model the task catalogue already offers", () => {
    assert.deepStrictEqual(
      posthogGatewayOnlyModels([{ id: "claude-opus-5", owned_by: "cloudflare" }], taskCatalogue),
      [],
    );
  });

  it("sorts every open-weight model below the lab models, alphabetically", () => {
    const gatewayOnly = posthogGatewayOnlyModels(
      [
        { id: "moonshotai/kimi-k3", owned_by: "modal" },
        { id: "@cf/zai-org/glm-5.2", owned_by: "cloudflare" },
        { id: "deepseek-ai/deepseek-v4-flash", owned_by: "baseten" },
      ],
      taskCatalogue,
    );
    const catalogue = posthogCloudCatalogueModels([
      ...taskCatalogue,
      model({ model: "claude-haiku-4-5", runtime_adapter: "claude" }),
      model({ model: "gpt-5.6-sol", runtime_adapter: "codex" }),
      ...gatewayOnly,
    ]);
    assert.deepStrictEqual(
      catalogue.map((entry) => entry.name),
      [
        "claude-opus-5",
        "claude-haiku-4-5",
        "gpt-5.6-sol",
        "Deepseek V4 Flash",
        "GLM-5.2",
        "Kimi K3",
      ],
    );
  });

  it("marks open weights so the picker can give them a neutral mark", () => {
    const gatewayOnly = posthogGatewayOnlyModels(
      [{ id: "@cf/zai-org/glm-5.2", owned_by: "cloudflare" }],
      taskCatalogue,
    );
    const catalogue = posthogCloudCatalogueModels([...taskCatalogue, ...gatewayOnly]);
    const glm = catalogue.find((entry) => entry.name === "GLM-5.2");
    const opus = catalogue.find((entry) => entry.name === "claude-opus-5");
    assert.strictEqual(glm?.isOpenWeight, true);
    assert.strictEqual(glm?.subProviderDriverKind, undefined);
    assert.strictEqual(opus?.isOpenWeight, undefined);
    assert.strictEqual(opus?.subProviderDriverKind, "claudeAgent");
  });
});
