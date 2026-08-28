import {
  ProviderDriverKind,
  PostHogNotConfiguredError,
  TextGenerationError,
  type PostHogCloudModel,
  type PostHogGatewayModel,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { PostHogCloudClient } from "../../posthog/PostHogCloudClient.ts";
import { makePostHogCloudAdapter } from "../Layers/PostHogCloudAdapter.ts";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "../ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";

const DRIVER_KIND = ProviderDriverKind.make("posthogCloud");
// PostHog runs other vendors' models, so each one is labelled with the
// driver that authors it rather than with PostHog's own mark.
const CODEX_DRIVER_KIND = ProviderDriverKind.make("codex");
const CLAUDE_DRIVER_KIND = ProviderDriverKind.make("claudeAgent");

/**
 * Models the PostHog gateway still serves but PostHog's own pickers no longer
 * offer — superseded versions kept alive for pinned runs. `/tasks/models/`
 * returns them because it is the run-eligibility catalogue, not a curated
 * list, so the curation lives on the client the same way it does in PostHog's
 * desktop app.
 *
 * Mirrors `HIDDEN_PI_MODEL_IDS` in the PostHog monorepo
 * (`products/desktop/packages/harness/src/extensions/posthog-provider/model-catalog.ts`).
 * Re-sync when that list moves. Entries here are folded into the picker's
 * "Legacy models" section rather than dropped, so a thread already pinned to
 * one keeps working and stays selectable.
 */
const SUPERSEDED_MODEL_IDS: ReadonlySet<string> = new Set([
  "claude-sonnet-4-5",
  "claude-sonnet-4-6",
  "claude-sonnet-4-7",
  "claude-sonnet-4-8",
  "claude-opus-4-5",
  "claude-opus-4-6",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "gpt-5.2",
  "gpt-5.3-codex",
  "gpt-5.4",
  "gpt-5.5",
  "gpt-5-mini",
]);
const PostHogCloudSettings = Schema.Struct({});
type PostHogCloudSettings = typeof PostHogCloudSettings.Type;

export type PostHogCloudDriverEnv = Crypto.Crypto | FileSystem.FileSystem;

function reasoningCapabilities(
  model: PostHogCloudModel,
): ServerProvider["models"][number]["capabilities"] {
  if (model.supported_efforts.length === 0) return null;
  return {
    optionDescriptors: [
      {
        id: "reasoningEffort",
        label: "Reasoning",
        type: "select",
        options: model.supported_efforts.map((effort, index) => ({
          id: effort,
          label: effort,
          ...(index === 0 ? { isDefault: true } : {}),
        })),
      },
    ],
  };
}

/**
 * Family order PostHog's own pickers present, newest first within a family.
 * Anything outside these families ranks last and sorts among itself by
 * version. Mirrors `MODEL_FAMILY_ORDER` / `compareModelsForPicker` in the
 * PostHog monorepo (`products/desktop/packages/shared/src/cloud-task-models.ts`).
 */
const MODEL_FAMILY_ORDER = ["fable", "opus", "sonnet", "haiku"] as const;

/**
 * Sort tier: the Anthropic families in their own order, then everything a lab
 * publishes under its own name, then the open-weight models. Open weights sit
 * last as a group because they are the exception a reader scans for, not the
 * default they scan past.
 */
function modelFamilyRank(modelId: string): number {
  if (isOpenWeightModelId(modelId)) return MODEL_FAMILY_ORDER.length + 1;
  const normalized = modelId.toLowerCase();
  const index = MODEL_FAMILY_ORDER.findIndex((family) => normalized.includes(family));
  return index === -1 ? MODEL_FAMILY_ORDER.length : index;
}

/**
 * Version buried in a model id, as a sortable number: `claude-opus-4-8` and
 * `gpt-5.6` both read as major*1000 + minor. A model with no version sorts
 * newest, which is how an unversioned id (`kimi-k3`) reaches the top of its
 * family rather than the bottom.
 */
function modelRecency(modelId: string): number {
  const match = modelId.toLowerCase().match(/-(\d+)(?:[-.](\d+))?/);
  if (!match) return Number.MAX_SAFE_INTEGER;
  return Number(match[1]) * 1000 + (match[2] ? Number(match[2]) : 0);
}

export function comparePostHogCloudModels(a: string, b: string): number {
  const familyDelta = modelFamilyRank(a) - modelFamilyRank(b);
  if (familyDelta !== 0) return familyDelta;
  // Open weights share no versioning scheme, so a recency sort just shuffles
  // them. Read them alphabetically instead, by the name shown in the picker.
  if (isOpenWeightModelId(a)) {
    return formatGatewayModelName(a).localeCompare(formatGatewayModelName(b));
  }
  return modelRecency(b) - modelRecency(a);
}

/**
 * The catalogue as the picker should present it.
 *
 * Ordered the way PostHog's own model pickers order: family first, newest
 * version first within a family. Superseded entries are marked legacy rather
 * than dropped so the picker folds them away while a thread pinned to one
 * keeps working, and the default is the first model still on offer so a
 * catalogue that leads with a superseded entry does not open every new
 * thread on it.
 */
/**
 * The models PostHog serves that no task runtime adapter claims by provider —
 * GLM, Kimi, DeepSeek. Identified the way PostHog's own cloud task composer
 * identifies them (`isCloudflareModel` / `isModalModel` / `isBasetenModel` in
 * `products/desktop/packages/shared/src/cloud-task-models.ts`): by id as well
 * as by owner, because the gateway labels some of them with whatever provider
 * litellm reports rather than the backend actually serving them.
 */
export function isOpenWeightModelId(modelId: string): boolean {
  const id = modelId.toLowerCase();
  // Matched by family rather than by exact id: PostHog's own list pins
  // `moonshotai/kimi-k3`, but a version bump there must not silently hand the
  // model back its harness's vendor mark.
  return (
    id.startsWith("@cf/") ||
    id.startsWith("moonshotai/") ||
    id.includes("glm") ||
    id.includes("deepseek") ||
    id.includes("kimi")
  );
}

function isOpenSourceGatewayModel(model: PostHogGatewayModel): boolean {
  const owner = model.owned_by ?? "";
  return (
    isOpenWeightModelId(model.id) ||
    owner === "cloudflare" ||
    owner === "modal" ||
    owner === "baseten"
  );
}

/** Codex drives OpenAI's own models; everything else runs on the Claude harness. */
function isCodexGatewayModel(model: PostHogGatewayModel): boolean {
  return (
    !isOpenSourceGatewayModel(model) &&
    (model.owned_by === "openai" || model.id.startsWith("gpt-") || model.id.startsWith("openai/"))
  );
}

const VERSIONED_ACRONYMS: ReadonlySet<string> = new Set(["gpt", "glm"]);

/**
 * Display name for a gateway model id, matching how PostHog's own pickers
 * render these. Mirrors `formatGatewayModelName`
 * (`products/desktop/packages/shared/src/cloud-task-models.ts`): drop the
 * vendor path, glue a version onto a leading acronym, title-case the rest —
 * so `@cf/zai-org/glm-5.2` reads "GLM-5.2" and `moonshotai/kimi-k3` reads
 * "Kimi K3".
 */
function formatGatewayModelName(modelId: string): string {
  const words = (modelId.split("/").pop() ?? modelId).replace(/(\d)-(\d)/g, "$1.$2").split(/[-_]/);
  const titled = (word: string) =>
    /^[0-9.]+$/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
  const [head, version, ...rest] = words;
  if (head === undefined || !VERSIONED_ACRONYMS.has(head.toLowerCase())) {
    return words.map(titled).join(" ");
  }
  return [version ? `${head.toUpperCase()}-${version}` : head.toUpperCase(), ...rest.map(titled)]
    .join(" ")
    .trim();
}

/**
 * Gateway models the task catalogue did not report, as catalogue entries.
 *
 * Membership is decided by absence from the task catalogue rather than by a
 * provider allowlist, so a model the gateway labels with an unexpected owner
 * still reaches the picker. They carry no reasoning effort: the gateway
 * serves the open-source models through a completions API with no thinking
 * control. Models the caller's plan disallows are dropped rather than shown
 * disabled, since a run would be rejected anyway.
 */
export function posthogGatewayOnlyModels(
  gatewayModels: ReadonlyArray<PostHogGatewayModel>,
  taskCatalogue: ReadonlyArray<PostHogCloudModel>,
): ReadonlyArray<PostHogCloudModel> {
  const alreadyOffered = new Set(taskCatalogue.map((model) => model.model));
  return gatewayModels
    .filter((model) => !alreadyOffered.has(model.id) && model.allowed !== false)
    .map((model) => ({
      runtime_adapter: isCodexGatewayModel(model) ? ("codex" as const) : ("claude" as const),
      model: model.id,
      display_name: formatGatewayModelName(model.id),
      supported_efforts: [],
    }));
}

export function posthogCloudCatalogueModels(
  models: ReadonlyArray<PostHogCloudModel>,
): ServerProvider["models"] {
  const ordered = models.toSorted((left, right) =>
    comparePostHogCloudModels(left.model, right.model),
  );
  const defaultModelId = (
    ordered.find((model) => !SUPERSEDED_MODEL_IDS.has(model.model)) ?? ordered[0]
  )?.model;
  return ordered.map((model) => ({
    slug: `${model.runtime_adapter}:${model.model}`,
    name: model.display_name,
    shortName: model.display_name,
    subProvider: model.runtime_adapter === "codex" ? "Codex" : "Claude",
    ...(isOpenWeightModelId(model.model)
      ? {}
      : {
          subProviderDriverKind:
            model.runtime_adapter === "codex" ? CODEX_DRIVER_KIND : CLAUDE_DRIVER_KIND,
        }),
    isCustom: false,
    ...(SUPERSEDED_MODEL_IDS.has(model.model) ? { isLegacy: true } : {}),
    ...(isOpenWeightModelId(model.model) ? { isOpenWeight: true } : {}),
    ...(model.model === defaultModelId ? { isDefault: true } : {}),
    capabilities: reasoningCapabilities(model),
  }));
}

function textGenerationUnavailable(operation: string) {
  return Effect.fail(
    new TextGenerationError({
      operation,
      detail: "PostHog Cloud models are only available for Cloud Task threads.",
    }),
  );
}

export const PostHogCloudDriver: ProviderDriver<PostHogCloudSettings, PostHogCloudDriverEnv> = {
  driverKind: DRIVER_KIND,
  metadata: {
    displayName: "PostHog Cloud",
    supportsMultipleInstances: false,
  },
  configSchema: PostHogCloudSettings,
  defaultConfig: () => ({}),
  create: ({ instanceId, displayName, accentColor, enabled }) =>
    Effect.gen(function* () {
      const missing = () =>
        Effect.fail(new PostHogNotConfiguredError({ missing: ["apiKey"] as const }));
      const posthog = Option.getOrElse(yield* Effect.serviceOption(PostHogCloudClient), () =>
        PostHogCloudClient.of({
          listModels: missing,
          listGatewayModels: missing,
          createTask: missing,
          runTask: missing,
          getRun: missing,
          commandRun: missing,
          cancelRun: missing,
          uploadRunArtifacts: missing,
          readRunLogs: missing,
          streamRun: missing,
        }),
      );
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER_KIND,
        instanceId,
      });
      const fileSystem = yield* FileSystem.FileSystem;
      const adapter = yield* makePostHogCloudAdapter({ instanceId, posthog, fileSystem });
      const maintenanceCapabilities = makeManualOnlyProviderMaintenanceCapabilities({
        provider: DRIVER_KIND,
        packageName: null,
      });

      const loadSnapshot = Effect.gen(function* () {
        const checkedAt = DateTime.formatIso(yield* DateTime.now);
        const result = yield* posthog.listModels().pipe(Effect.result);
        const models = result._tag === "Success" ? result.success : [];
        // The gateway only widens the catalogue, so an unreachable gateway
        // costs the open-source models and nothing else. Readiness still
        // follows the task API, which is what a run actually depends on.
        const gateway =
          result._tag === "Success" ? yield* posthog.listGatewayModels().pipe(Effect.result) : null;
        if (gateway?._tag === "Failure") {
          yield* Effect.logWarning("PostHog model gateway unreachable; catalogue narrowed", {
            instanceId,
            cause: gateway.failure,
          });
        }
        const catalogue = [
          ...models,
          ...(gateway?._tag === "Success" ? posthogGatewayOnlyModels(gateway.success, models) : []),
        ];
        return {
          instanceId,
          driver: DRIVER_KIND,
          displayName: displayName ?? "PostHog Cloud",
          ...(accentColor ? { accentColor } : {}),
          badgeLabel: "Cloud",
          execution: "remote",
          continuation: { groupKey: continuationIdentity.continuationKey },
          showInteractionModeToggle: false,
          requiresNewThreadForModelChange: true,
          enabled,
          installed: enabled && result._tag === "Success",
          version: null,
          status: !enabled ? "disabled" : result._tag === "Success" ? "ready" : "warning",
          auth: {
            status: result._tag === "Success" ? "authenticated" : "unknown",
            type: "PostHog personal API key",
          },
          checkedAt,
          ...(result._tag === "Failure"
            ? { message: "Configure PostHog to use Cloud Tasks." }
            : {}),
          availability: "available",
          models: posthogCloudCatalogueModels(catalogue),
          slashCommands: [],
          skills: [],
        } satisfies ServerProvider;
      });

      const snapshot = {
        maintenanceCapabilities,
        getSnapshot: loadSnapshot,
        refresh: loadSnapshot,
        streamChanges: Stream.empty,
      };
      const textGeneration = {
        generateCommitMessage: () => textGenerationUnavailable("generateCommitMessage"),
        generatePrContent: () => textGenerationUnavailable("generatePrContent"),
        generateBranchName: () => textGenerationUnavailable("generateBranchName"),
        generateThreadTitle: () => textGenerationUnavailable("generateThreadTitle"),
      };

      return {
        instanceId,
        driverKind: DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled,
        snapshot,
        adapter,
        textGeneration,
      } satisfies ProviderInstance;
    }),
};
