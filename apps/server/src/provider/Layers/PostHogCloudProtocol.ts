import {
  RuntimeItemId,
  RuntimeRequestId,
  RuntimeTaskId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  PostHogCloudRunSession,
  type PostHogCloudPermissionOption,
} from "./PostHogCloudRunSession.ts";

const CLOUD_SETUP_TASK_ID = RuntimeTaskId.make("posthog-cloud-setup");
const CLOUD_PULL_REQUEST_TASK_ID = RuntimeTaskId.make("posthog-cloud-pull-request");
const CLOUD_CI_TASK_ID = RuntimeTaskId.make("posthog-cloud-ci");
const CLOUD_SETUP_TASK_TYPE = "provider_setup";

const TextContent = Schema.Union([Schema.String, Schema.Struct({ text: Schema.String })]);
const PlanEntry = Schema.Struct({
  content: TextContent,
  status: Schema.optional(Schema.String),
});
const ToolContentEntry = Schema.Struct({
  type: Schema.String,
  content: Schema.optional(
    Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) }),
  ),
});
const ToolUpdate = Schema.Struct({
  sessionUpdate: Schema.Literals(["tool_call", "tool_call_update"]),
  toolCallId: Schema.String,
  status: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
  content: Schema.optional(Schema.Array(ToolContentEntry)),
});
const SessionUpdate = Schema.Union([
  Schema.Struct({
    sessionUpdate: Schema.Literal("user_message_chunk"),
    content: TextContent,
    _meta: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
  Schema.Struct({
    sessionUpdate: Schema.Literals(["agent_message", "agent_message_chunk"]),
    content: TextContent,
  }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("agent_thought_chunk"),
    content: TextContent,
  }),
  Schema.Struct({
    sessionUpdate: Schema.Literal("plan"),
    entries: Schema.optional(Schema.Array(PlanEntry)),
  }),
  ToolUpdate,
  Schema.Struct({
    sessionUpdate: Schema.Literal("usage_update"),
    used: Schema.Number,
    size: Schema.optional(Schema.Number),
  }),
]);
const SessionUpdateParams = Schema.Struct({ update: SessionUpdate });
const SessionUpdateRecordParams = Schema.Struct({
  update: Schema.Record(Schema.String, Schema.Unknown),
});
const ProgressParams = Schema.Struct({
  step: Schema.optional(Schema.String),
  group: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
});
const PermissionOption = Schema.Struct({
  optionId: Schema.String,
  kind: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
});
const QuestionOption = Schema.Struct({
  label: Schema.String,
  description: Schema.optional(Schema.String),
});
const Question = Schema.Struct({
  question: Schema.String,
  header: Schema.optional(Schema.String),
  options: Schema.optional(Schema.Array(QuestionOption)),
  multiSelect: Schema.optional(Schema.Boolean),
});
const QuestionMetadata = Schema.Struct({
  codeToolKind: Schema.optional(Schema.String),
  questions: Schema.optional(Schema.Array(Question)),
  question: Schema.optional(Schema.String),
  header: Schema.optional(Schema.String),
  options: Schema.optional(Schema.Array(QuestionOption)),
  multiSelect: Schema.optional(Schema.Boolean),
});
const PermissionRequestParams = Schema.Struct({
  requestId: Schema.String,
  options: Schema.optional(Schema.Array(PermissionOption)),
  toolCall: Schema.optional(
    Schema.Struct({
      title: Schema.optional(Schema.String),
      _meta: Schema.optional(QuestionMetadata),
    }),
  ),
});
const PermissionResolvedParams = Schema.Struct({ requestId: Schema.String });
const BranchParams = Schema.Struct({
  branch: Schema.optional(Schema.String),
  branchName: Schema.optional(Schema.String),
});
const ErrorParams = Schema.Struct({
  message: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
});
const TurnCompleteParams = Schema.Struct({
  stopReason: Schema.optional(Schema.String),
  usage: Schema.optional(Schema.Unknown),
});
const Notification = Schema.Struct({
  method: Schema.String,
  id: Schema.optional(Schema.Union([Schema.String, Schema.Number])),
  params: Schema.optional(Schema.Unknown),
});
const NotificationEnvelope = Schema.Union([
  Schema.Struct({ notification: Notification, timestamp: Schema.optional(Schema.String) }),
  Schema.Struct({ message: Notification, timestamp: Schema.optional(Schema.String) }),
]);
const LivePermissionEnvelope = Schema.Struct({
  type: Schema.Literal("permission_request"),
  requestId: Schema.String,
  options: Schema.optional(Schema.Array(PermissionOption)),
  toolCall: Schema.optional(
    Schema.Struct({
      title: Schema.optional(Schema.String),
      _meta: Schema.optional(QuestionMetadata),
    }),
  ),
  timestamp: Schema.optional(Schema.String),
});

type DecodedProtocolEntry =
  | {
      readonly type: "session-update";
      readonly params: typeof SessionUpdateParams.Type;
      readonly rawUpdate: Readonly<Record<string, unknown>>;
    }
  | { readonly type: "run-started" }
  | {
      readonly type: "prompt";
      readonly id: string;
      readonly content: string;
      readonly steer: boolean;
    }
  | { readonly type: "background-turn-started" }
  | { readonly type: "background-turn-complete"; readonly params: typeof TurnCompleteParams.Type }
  | { readonly type: "task-complete"; readonly params: typeof TurnCompleteParams.Type }
  | {
      readonly type: "initialization-failed";
      readonly params: typeof ErrorParams.Type;
      readonly rawParams: unknown;
    }
  | { readonly type: "progress"; readonly params: typeof ProgressParams.Type }
  | {
      readonly type: "permission-request";
      readonly params: typeof PermissionRequestParams.Type;
      readonly rawParams: unknown;
    }
  | {
      readonly type: "permission-resolved";
      readonly params: typeof PermissionResolvedParams.Type;
      readonly rawParams: unknown;
    }
  | { readonly type: "branch"; readonly params: typeof BranchParams.Type }
  | {
      readonly type: "error";
      readonly params: typeof ErrorParams.Type;
      readonly rawParams: unknown;
    }
  | { readonly type: "turn-complete"; readonly params: typeof TurnCompleteParams.Type };

interface DecodedEnvelope {
  readonly entry: DecodedProtocolEntry;
  readonly timestamp?: string;
  readonly raw: unknown;
}

type EventBase = Pick<
  ProviderRuntimeEvent,
  "eventId" | "provider" | "providerInstanceId" | "threadId" | "createdAt" | "turnId" | "raw"
>;

type MakeEventBase = (source: unknown, timestamp?: string) => Effect.Effect<EventBase, never>;

const decodeNotificationEnvelope = Schema.decodeUnknownOption(NotificationEnvelope);
const decodeLivePermissionEnvelope = Schema.decodeUnknownOption(LivePermissionEnvelope);
const decodeSessionUpdateParams = Schema.decodeUnknownOption(SessionUpdateParams);
const decodeSessionUpdateRecordParams = Schema.decodeUnknownOption(SessionUpdateRecordParams);
const decodeProgressParams = Schema.decodeUnknownOption(ProgressParams);
const decodePermissionRequestParams = Schema.decodeUnknownOption(PermissionRequestParams);
const decodePermissionResolvedParams = Schema.decodeUnknownOption(PermissionResolvedParams);
const decodeBranchParams = Schema.decodeUnknownOption(BranchParams);
const decodeErrorParams = Schema.decodeUnknownOption(ErrorParams);
const decodeTurnCompleteParams = Schema.decodeUnknownOption(TurnCompleteParams);
const decodeToolContent = Schema.decodeUnknownOption(Schema.Array(ToolContentEntry));

export function decodePostHogCloudProtocolEntry(input: unknown): DecodedEnvelope | undefined {
  const livePermission = Option.getOrUndefined(decodeLivePermissionEnvelope(input));
  if (livePermission) {
    return {
      entry: { type: "permission-request", params: livePermission, rawParams: input },
      ...(livePermission.timestamp ? { timestamp: livePermission.timestamp } : {}),
      raw: input,
    };
  }
  const envelope = Option.getOrUndefined(decodeNotificationEnvelope(input));
  if (!envelope) return undefined;
  const notification = "notification" in envelope ? envelope.notification : envelope.message;
  const decoded = decodeNotification(notification.method, notification.params, notification.id);
  if (!decoded) return undefined;
  return {
    entry: decoded,
    ...(envelope.timestamp ? { timestamp: envelope.timestamp } : {}),
    raw: input,
  };
}

function decodeNotification(
  method: string,
  params: unknown,
  id?: string | number,
): DecodedProtocolEntry | undefined {
  switch (method) {
    case "session/update": {
      const decoded = Option.getOrUndefined(decodeSessionUpdateParams(params));
      const raw = Option.getOrUndefined(decodeSessionUpdateRecordParams(params));
      return decoded && raw
        ? { type: "session-update", params: decoded, rawUpdate: raw.update }
        : undefined;
    }
    case "_posthog/run_started":
      return { type: "run-started" };
    case "session/prompt": {
      const prompt = record(params)?.prompt;
      const content = Array.isArray(prompt)
        ? prompt
            .flatMap((block) => {
              const candidate = record(block);
              const ui = record(record(candidate?._meta)?.ui);
              if (ui?.hidden === true) return [];
              return candidate?.type === "text" && typeof candidate.text === "string"
                ? [candidate.text]
                : [];
            })
            .join("\n")
        : "";
      if (!content.trim()) return undefined;
      return {
        type: "prompt",
        id: String(id ?? "unknown"),
        content,
        steer: record(record(params)?._meta)?.steer === true,
      };
    }
    case "_posthog/background_turn_started":
      return { type: "background-turn-started" };
    case "_posthog/background_turn_complete": {
      const decoded = Option.getOrUndefined(decodeTurnCompleteParams(params));
      return decoded ? { type: "background-turn-complete", params: decoded } : undefined;
    }
    case "_posthog/task_complete": {
      const decoded = Option.getOrUndefined(decodeTurnCompleteParams(params));
      return decoded ? { type: "task-complete", params: decoded } : undefined;
    }
    case "_posthog/initialization_failed": {
      const decoded = Option.getOrUndefined(decodeErrorParams(params));
      return decoded
        ? { type: "initialization-failed", params: decoded, rawParams: params }
        : { type: "initialization-failed", params: {}, rawParams: params };
    }
    case "_posthog/progress": {
      const decoded = Option.getOrUndefined(decodeProgressParams(params));
      return decoded ? { type: "progress", params: decoded } : undefined;
    }
    case "_posthog/permission_request": {
      const decoded = Option.getOrUndefined(decodePermissionRequestParams(params));
      return decoded
        ? { type: "permission-request", params: decoded, rawParams: params }
        : undefined;
    }
    case "_posthog/permission_resolved": {
      const decoded = Option.getOrUndefined(decodePermissionResolvedParams(params));
      return decoded
        ? { type: "permission-resolved", params: decoded, rawParams: params }
        : undefined;
    }
    case "_posthog/branch_created":
    case "_posthog/git_checkpoint": {
      const decoded = Option.getOrUndefined(decodeBranchParams(params));
      return decoded ? { type: "branch", params: decoded } : undefined;
    }
    case "_posthog/error": {
      const decoded = Option.getOrUndefined(decodeErrorParams(params));
      return decoded ? { type: "error", params: decoded, rawParams: params } : undefined;
    }
    case "_posthog/turn_complete": {
      const decoded = Option.getOrUndefined(decodeTurnCompleteParams(params));
      return decoded ? { type: "turn-complete", params: decoded } : undefined;
    }
    default:
      return undefined;
  }
}

export const mapPostHogCloudProtocolEntry = Effect.fn("mapPostHogCloudProtocolEntry")(function* (
  session: PostHogCloudRunSession,
  input: unknown,
  makeEventBase: MakeEventBase,
): Effect.fn.Return<ReadonlyArray<ProviderRuntimeEvent>, never> {
  const decoded = decodePostHogCloudProtocolEntry(input);
  if (!decoded) return [];
  const base = yield* makeEventBase(decoded.raw, decoded.timestamp);
  const ownedBase = (): EventBase =>
    session.activeTurnId ? { ...base, turnId: session.activeTurnId } : base;
  const ensureImplicitTurn = (background = false): ReadonlyArray<ProviderRuntimeEvent> => {
    if (session.activeTurnId) return [];
    const turnId = TurnId.make(`posthog-cloud:${session.runId ?? "pending"}:${base.eventId}`);
    session.beginTurn(turnId, base.createdAt);
    if (background) session.backgroundTurnId = turnId;
    return [
      {
        ...base,
        type: "turn.started",
        turnId,
        payload: {},
      },
    ];
  };
  const completeAssistant = (): ProviderRuntimeEvent[] => {
    if (!session.assistantItemId) return [];
    const itemId = session.assistantItemId;
    session.assistantItemId = undefined;
    session.assistantText = "";
    return [
      {
        ...ownedBase(),
        type: "item.completed",
        itemId,
        payload: { itemType: "assistant_message", status: "completed" },
      },
    ];
  };
  const completeReasoning = (): ProviderRuntimeEvent[] => {
    if (!session.reasoningItemId) return [];
    const itemId = session.reasoningItemId;
    session.reasoningItemId = undefined;
    return [
      {
        ...ownedBase(),
        type: "item.completed",
        itemId,
        payload: { itemType: "reasoning", status: "completed" },
      },
    ];
  };

  switch (decoded.entry.type) {
    case "session-update": {
      const update = decoded.entry.params.update;
      if (update.sessionUpdate === "user_message_chunk") {
        if (update._meta?.importedUserPrompt !== true) return [];
        const text = textFromContent(update.content).trim();
        if (!text || session.consumeLocalUserEcho(text)) return [];
        const started = ensureImplicitTurn();
        return [
          ...started,
          {
            ...ownedBase(),
            type: "item.completed",
            itemId: RuntimeItemId.make(`user:${session.runId}:${base.eventId}`),
            payload: { itemType: "user_message", status: "completed", detail: text },
          },
        ];
      }
      if (
        update.sessionUpdate === "agent_message" ||
        update.sessionUpdate === "agent_message_chunk"
      ) {
        const text = textFromContent(update.content);
        const emitted: ProviderRuntimeEvent[] = [...ensureImplicitTurn()];
        let delta = text;
        if (update.sessionUpdate === "agent_message" && session.assistantText.length > 0) {
          if (text.startsWith(session.assistantText))
            delta = text.slice(session.assistantText.length);
          else emitted.push(...completeAssistant());
        }
        session.assistantText =
          update.sessionUpdate === "agent_message" ? text : session.assistantText + text;
        if (!delta) return emitted;
        if (!session.assistantItemId) {
          session.assistantItemId = RuntimeItemId.make(
            `posthog-cloud:${session.runId}:${session.currentSequence()}`,
          );
          emitted.push({
            ...ownedBase(),
            type: "item.started",
            itemId: session.assistantItemId,
            payload: { itemType: "assistant_message", status: "inProgress" },
          });
        }
        emitted.push({
          ...ownedBase(),
          type: "content.delta",
          itemId: session.assistantItemId,
          payload: { streamKind: "assistant_text", delta },
        });
        return emitted;
      }
      if (update.sessionUpdate === "agent_thought_chunk") {
        const delta = textFromContent(update.content);
        const emitted: ProviderRuntimeEvent[] = [...ensureImplicitTurn()];
        if (!session.reasoningItemId) {
          session.reasoningItemId = RuntimeItemId.make(
            `posthog-cloud:${session.runId}:${session.currentSequence()}`,
          );
          emitted.push({
            ...ownedBase(),
            type: "item.started",
            itemId: session.reasoningItemId,
            payload: { itemType: "reasoning", status: "inProgress" },
          });
        }
        emitted.push({
          ...ownedBase(),
          type: "content.delta",
          itemId: session.reasoningItemId,
          payload: { streamKind: "reasoning_text", delta },
        });
        return emitted;
      }
      if (update.sessionUpdate === "plan") {
        return [
          ...ensureImplicitTurn(),
          {
            ...ownedBase(),
            type: "turn.plan.updated",
            payload: {
              plan: (update.entries ?? []).map((entry) => ({
                step: textFromContent(entry.content),
                status: planStatus(entry.status),
              })),
            },
          },
        ];
      }
      if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
        const turnStarted = ensureImplicitTurn();
        const existing = session.toolItems.get(update.toolCallId);
        const itemId = existing?.itemId ?? RuntimeItemId.make(update.toolCallId);
        const mergedUpdate = { ...existing?.update, ...decoded.entry.rawUpdate, ...update };
        session.toolItems.set(update.toolCallId, { itemId, update: mergedUpdate });
        const status = itemStatus(mergedUpdate.status) ?? "inProgress";
        const title = trimmedString(mergedUpdate.title);
        const detail = toolContentText(mergedUpdate.content);
        const kind = mergedUpdate.kind;
        const payload = {
          itemType: itemType(kind),
          status,
          ...(title ? { title } : {}),
          ...(detail ? { detail } : {}),
          data: { ...mergedUpdate, ...(kind === "execute" && title ? { command: title } : {}) },
        } as const;
        const emitted: ProviderRuntimeEvent[] = [
          ...turnStarted,
          ...(update.sessionUpdate === "tool_call"
            ? [...completeAssistant(), ...completeReasoning()]
            : []),
        ];
        emitted.push({
          ...ownedBase(),
          type:
            !existing || update.sessionUpdate === "tool_call"
              ? "item.started"
              : status === "completed" || status === "failed"
                ? "item.completed"
                : "item.updated",
          itemId,
          payload,
        });
        return emitted;
      }
      if (update.sessionUpdate !== "usage_update" || update.used < 0) return [];
      return [
        {
          ...base,
          type: "thread.token-usage.updated",
          payload: {
            usage: {
              usedTokens: Math.floor(update.used),
              ...(update.size !== undefined && update.size > 0
                ? { maxTokens: Math.floor(update.size) }
                : {}),
            },
          },
        },
      ];
    }
    case "prompt": {
      const text = decoded.entry.content.trim();
      if (session.consumeLocalUserEcho(text)) return [];
      const started = ensureImplicitTurn();
      return [
        ...started,
        {
          ...ownedBase(),
          type: "item.completed",
          itemId: RuntimeItemId.make(
            `user:${session.runId ?? "pending"}:${decoded.entry.id}:${base.eventId}`,
          ),
          payload: {
            itemType: "user_message",
            status: "completed",
            detail: text,
            data: { steer: decoded.entry.steer },
          },
        },
      ];
    }
    case "run-started":
      return [];
    case "background-turn-started":
      return ensureImplicitTurn(true);
    case "background-turn-complete":
    case "task-complete": {
      const emitted = [...completeAssistant(), ...completeReasoning()];
      if (session.activeTurnId) {
        emitted.push({
          ...ownedBase(),
          type: "turn.completed",
          payload: {
            state: "completed",
            stopReason: decoded.entry.params.stopReason ?? null,
            ...(decoded.entry.params.usage !== undefined
              ? { usage: decoded.entry.params.usage }
              : {}),
          },
        });
        session.finishTurn(base.createdAt);
      }
      if (decoded.entry.type === "task-complete") {
        emitted.push({
          ...base,
          type: "session.state.changed",
          payload: { state: "ready" },
        });
      }
      return emitted;
    }
    case "initialization-failed": {
      const message =
        decoded.entry.params.message ??
        decoded.entry.params.error ??
        "The Cloud Task agent failed to initialize.";
      const emitted: ProviderRuntimeEvent[] = [
        ...completeAssistant(),
        ...completeReasoning(),
        {
          ...ownedBase(),
          type: "runtime.error",
          payload: {
            message,
            class: "provider_error",
            detail: decoded.entry.rawParams,
          },
        },
      ];
      if (session.activeTurnId) {
        emitted.push({
          ...ownedBase(),
          type: "turn.completed",
          payload: {
            state: "failed",
            stopReason: "initialization_failed",
            errorMessage: message,
          },
        });
        session.finishTurn(base.createdAt);
      }
      emitted.push({
        ...base,
        type: "session.state.changed",
        payload: {
          state: "error",
          reason: message,
          detail: decoded.entry.rawParams,
        },
      });
      return emitted;
    }
    case "progress": {
      const params = decoded.entry.params;
      const label = params.label ?? params.title ?? params.detail;
      if (!label) return [];
      const taskId =
        params.step === "pr"
          ? CLOUD_PULL_REQUEST_TASK_ID
          : params.step === "ci"
            ? CLOUD_CI_TASK_ID
            : CLOUD_SETUP_TASK_ID;
      const pullRequest =
        params.step === "pr" && params.status === "completed"
          ? githubPullRequestReference(params.detail, session.repository)
          : undefined;
      return [
        {
          ...base,
          type: "task.progress",
          payload: {
            taskId,
            taskType: CLOUD_SETUP_TASK_TYPE,
            description: label,
            ...(params.detail ? { summary: params.detail } : {}),
            status: params.status === "completed" ? "completed" : "running",
          },
        },
        ...(pullRequest
          ? [
              {
                ...base,
                type: "thread.metadata.updated" as const,
                payload: { pullRequest },
              },
            ]
          : []),
      ];
    }
    case "permission-request": {
      const started = ensureImplicitTurn();
      const params = decoded.entry.params;
      const options: ReadonlyArray<PostHogCloudPermissionOption> = (params.options ?? []).map(
        (option) => ({
          optionId: option.optionId,
          ...(option.kind !== undefined ? { kind: option.kind } : {}),
          ...(option.name !== undefined ? { name: option.name } : {}),
        }),
      );
      session.permissions.set(params.requestId, options);
      const questions =
        params.toolCall?._meta?.codeToolKind === "question"
          ? userInputQuestions(params.toolCall._meta)
          : [];
      if (questions.length > 0) {
        session.userInputRequests.add(params.requestId);
        return [
          ...started,
          {
            ...ownedBase(),
            type: "user-input.requested",
            requestId: RuntimeRequestId.make(params.requestId),
            payload: { questions },
          },
        ];
      }
      return [
        ...started,
        {
          ...ownedBase(),
          type: "request.opened",
          requestId: RuntimeRequestId.make(params.requestId),
          payload: {
            requestType: "dynamic_tool_call",
            ...(params.toolCall?.title ? { detail: params.toolCall.title } : {}),
            options: options.map((option) => ({
              decision:
                option.kind === "allow_always"
                  ? "acceptForSession"
                  : option.kind === "allow_once"
                    ? "accept"
                    : "decline",
              label: option.name ?? option.kind ?? option.optionId,
            })),
            args: decoded.entry.rawParams,
          },
        },
      ];
    }
    case "permission-resolved": {
      const { requestId } = decoded.entry.params;
      session.permissions.delete(requestId);
      if (session.locallyResolvedUserInputs.delete(requestId)) return [];
      if (session.userInputRequests.delete(requestId)) {
        return [
          {
            ...base,
            type: "user-input.resolved",
            requestId: RuntimeRequestId.make(requestId),
            payload: { answers: {} },
          },
        ];
      }
      return [
        {
          ...base,
          type: "request.resolved",
          requestId: RuntimeRequestId.make(requestId),
          payload: { requestType: "dynamic_tool_call", resolution: decoded.entry.rawParams },
        },
      ];
    }
    case "branch": {
      const branch = decoded.entry.params.branch ?? decoded.entry.params.branchName;
      return branch ? [{ ...base, type: "thread.metadata.updated", payload: { branch } }] : [];
    }
    case "error":
      return [
        {
          ...base,
          type: "runtime.error",
          payload: {
            message:
              decoded.entry.params.message ??
              decoded.entry.params.error ??
              "The Cloud Task agent failed.",
            class: "provider_error",
            detail: decoded.entry.rawParams,
          },
        },
      ];
    case "turn-complete": {
      const emitted = [...completeAssistant(), ...completeReasoning()];
      if (!session.activeTurnId) return emitted;
      emitted.push({
        ...base,
        type: "turn.completed",
        payload: {
          state: "completed",
          stopReason: decoded.entry.params.stopReason ?? null,
          ...(decoded.entry.params.usage !== undefined
            ? { usage: decoded.entry.params.usage }
            : {}),
        },
      });
      session.finishTurn(base.createdAt);
      return emitted;
    }
  }
});

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function githubPullRequestReference(
  url: string | undefined,
  repository: string | undefined,
): { readonly repository: string; readonly number: number; readonly url: string } | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split("/").filter(Boolean);
    const number = Number(parts[3]);
    if (
      parsed.hostname !== "github.com" ||
      parts.length < 4 ||
      parts[2] !== "pull" ||
      !Number.isSafeInteger(number) ||
      number <= 0
    ) {
      return undefined;
    }
    return { repository: repository ?? `${parts[0]}/${parts[1]}`, number, url };
  } catch {
    return undefined;
  }
}

function textFromContent(value: typeof TextContent.Type): string {
  return typeof value === "string" ? value : value.text;
}

function trimmedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function itemType(
  kind: unknown,
): "command_execution" | "file_change" | "web_search" | "dynamic_tool_call" {
  if (kind === "execute") return "command_execution";
  if (kind === "edit" || kind === "delete" || kind === "move") return "file_change";
  if (kind === "search" || kind === "fetch") return "web_search";
  return "dynamic_tool_call";
}

function itemStatus(status: unknown): "inProgress" | "completed" | "failed" | undefined {
  if (status === "pending" || status === "in_progress") return "inProgress";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return undefined;
}

function toolContentText(value: unknown): string | undefined {
  const decoded = Option.getOrUndefined(decodeToolContent(value));
  const text = (decoded ?? [])
    .flatMap((entry) =>
      entry.type === "content" && entry.content?.type === "text" && entry.content.text
        ? [entry.content.text]
        : [],
    )
    .join("\n");
  return text.trim() ? text : undefined;
}

function planStatus(status: string | undefined): "pending" | "inProgress" | "completed" {
  if (status === "completed") return "completed";
  if (status === "in_progress") return "inProgress";
  return "pending";
}

function userInputQuestions(metadata: typeof QuestionMetadata.Type): ReadonlyArray<{
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>;
  readonly multiSelect: boolean;
}> {
  const candidates = metadata.questions ?? (metadata.question ? [metadata] : []);
  return candidates.flatMap((question) => {
    const text = question.question?.trim();
    if (!text) return [];
    return [
      {
        id: text,
        header: question.header?.trim() || "Question",
        question: text,
        options: (question.options ?? []).flatMap((option) => {
          const label = option.label.trim();
          return label ? [{ label, description: option.description?.trim() ?? "" }] : [];
        }),
        multiSelect: question.multiSelect === true,
      },
    ];
  });
}
